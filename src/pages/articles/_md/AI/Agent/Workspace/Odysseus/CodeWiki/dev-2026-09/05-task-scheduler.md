---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "任务调度与后台作业"
date: "2026-09-18T17:25:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "调度器", "Cron", "后台任务"]
description: "Odysseus 任务调度：自研单 asyncio 循环轮询调度器，信号量=1 的硬并发约束，missed schedule 推后不补跑，事件触发折叠进 next_run 通道，前台优先抢占后台。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

调度器让 Odysseus 从"被动应答工具"变成"主动 agent"：定时跑 agent 任务（"每天早上汇总邮件"）、事件触发（"收到某发件人邮件时研究一下"）、webhook 触发、`#!bg` 长命令后台作业，全在这一个域。它解决的核心矛盾是**本地单机资源有限**：单 GPU 上前台聊天和后台任务必须互斥，调度器把"前台优先、后台让路"做进了调度语义本身。

代码分布：`src/task_scheduler.py`（2675 行，`TaskScheduler` 是全库连接数第五的 god node，40 edges）、`routes/task/`（1186 行）与壳 `routes/task_routes.py`、`src/bg_jobs.py`（297 行）、`src/agent_runs.py`（271 行）、`src/interactive_gate.py`（219 行）、`src/builtin_actions.py`（3436 行，动作实现）、`src/user_time.py`（时区上下文）。任务与执行记录是 ORM 模型：`ScheduledTask`（`core/database.py:730`）与 `TaskRun`（`:810`）。

## 模块架构

`TaskScheduler`（`src/task_scheduler.py:345`）由 `app.py:785` 实例化注入，核心属性：`_executing`（in-memory 正在跑/排队 task ID 集合）、`_executing_lock`（`asyncio.Lock`——防调度 tick、手动触发、event 总线三方并发 double-dispatch）、`_run_semaphore = asyncio.Semaphore(1)`（**硬编码并发 1**，注释明示"This is a hard guarantee, not configurable"）、`_pending_notifications`（通知队列 cap 50）、`_task_handles`（task_id → `asyncio.Task`，供 `stop_task()` cancel）。

`ScheduledTask` 的字段就是调度域的全部维度：`task_type`（llm/action/research）、`schedule`（once/daily/weekly/monthly/cron，cron 用 `croniter` 预解析）、`trigger_type`（schedule/event/webhook）、`trigger_event` + `trigger_count/trigger_counter`（事件计数触发）、`next_run`（**naive UTC** 存储，带 `ix_scheduled_tasks_due` 索引）、`then_task_id`（任务链）、`webhook_token`、`crew_member_id`（关联 persona/endpoint/时区）、`output_target`（session/email/mcp__*）。

## 调用链路

**注册**：`create_task()`（`routes/task/task_routes.py:452`）校验后调 `compute_next_run()`（`src/task_scheduler.py:113`，纯函数：cron 用 `croniter`，monthly 对短月 clamp 到月末）。**调度**：`_loop()`（`:673`）每次 tick 后查询最小的 `next_run` 把睡眠 clamp 到 [1s, 60s]——保证 `* * * * *` 的 cron 不晚到一分钟；`_check_due_tasks()`（`:701`）在 `_executing_lock` 下快照 due 任务并 `asyncio.create_task(self._execute_task(id))`。**执行**：`_execute_task()`（`:737`）先写 `status="queued"` 的 TaskRun 行**再**等 semaphore（:738 注释：崩溃时 run 留在 queued/running 供僵尸清理识别）；`_execute_task_locked()`（`:816`）按 `task_type` 分派——`_execute_action()`（`:1242`，查 `BUILTIN_ACTIONS`）、`_execute_research_task()`（`:2014`）、`_execute_llm_task()`（`:1510`）→ `_run_agent_loop()`（`:1858`）消费 `stream_agent_loop()` 的 SSE 事件流（agent 循环失败回退 `task_llm_call_async` 单次调用；跑满 `max_steps` 无最终文本做一次 grace summarization 兜底）。**投递**：`_deliver_task_result()`（`:1678`）按 `output_target` 分流——写 ChatMessage / `_deliver_via_email()`（`:1811`，复用 `routes/email_helpers` 的 `_send_smtp_message`）/ `add_notification()` 入通知队列由前端轮询 `GET /notifications` 弹出 / `_log_to_assistant()` 写助手会话（`_SILENT_ACTIONS` 集合内的 housekeeping 除外）。**任务链**：成功且 `then_task_id` 存在则经 `_has_chain_cycle()`（`:2159`，深度 10 环检测）后 `asyncio.create_task(self._run_chained())`。

## 核心实现

### missed schedule：推后补一次，不逐次补

`start()`（`:483`）把重启时已过期的 `next_run` 统一推到 `now+60s`。为什么不是"每个错过的都补"：重启后 `_executing` 为空，同一 overdue 任务若按原始 next_run 判 due，会每 tick 重复触发直到完成——风暴。"推后补一次"是简单性与正确性的折中。配套僵尸清理：启动时把遗留 running/queued 的 TaskRun 标 `aborted`（非 error，`:463` 注释）——避免 Activity 统计把基础设施事件算成任务失败。

### 前台优先

三处联动：`_check_due_tasks()` 检测 `has_foreground_activity()`（`src/interactive_gate.py`）直接把 due 任务推后 15 分钟；执行中 `_cancel_if_foreground_active()`（`:905`）每 0.25s 检查并 cancel；Web 层 `_InteractiveActivityMiddleware`（`app.py:208`）在前台请求时调 `stop_background_tasks_for_foreground`。"background means background"——本地模型资源被前台 chat 独占时，后台任务必须让路（与 [LLM 接入层](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/03-llm-access)的 `_local_model_slot()` 闸门一脉相承）。

`has_foreground_activity()` 的输入由 `src/interactive_gate.py` 汇聚：`_has_active_chat_stream()`（读 `agent_runs._RUNS` 是否有活跃 SSE 流）、最近的浏览器活动（`BACKGROUND_TASK_BROWSER_ACTIVE_SECONDS`，默认 45s 内算活跃）、前台请求静默窗（`BACKGROUND_TASK_QUIET_MS`，默认 1500ms——窗内无前台请求才算"静默"）。`_PASSIVE_EXACT_PATHS`（`:62`）把 `/notifications` 等轮询端点排除在跟踪之外——**否则前端轮询通知这个动作本身会被当成"前台活动"，后台任务永远等不到静默**。等待上限 `BACKGROUND_TASK_MAX_WAIT_SECONDS` 默认 0（无限等待）。注意 `run_task_now(force=True)`（`src/task_scheduler.py:2264`）是串行化的旁门：直接 `asyncio.create_task(self._execute_task(task_id, bypass_model_slot=True, release_executing=False))`——手动触发可以抢占模型槽位（但它仍受 `_executing` 去重保护之外，语义是"用户点的，立即跑"）。

### 事件触发折叠进 next_run

`fire_event()` in `src/event_bus.py:33` → `_handle_event()` 累加 `trigger_counter`，达阈值时写 `next_run = utcnow()` **先提交**再调 `run_task_now()`——把事件统一折叠进 next_run 调度通道，且持久化保证重启不丢（计数重置与 next_run 落库在交给调度器之前提交：进程在"计数达标"与"调度器开跑"之间崩溃也不会丢触发或重复计数）。无 owner 事件由 `_resolve_event_owner()` 解析：localhost/内部代码路径的事件没有中间件可以带用户名，若按"全部 owner"处理会让内置任务每个账号跑一遍——改为路由到首个 admin 账户（与 legacy-owner 迁移一致）。事件源如 `email_received`（`_record_email_received_events()` in `routes/email_routes.py:366`，`email_event_seen` 表去重）。

### 时区与 prompt cache 一致性

DB 统一 naive UTC（`_utcnow()` :22）；用户时区经 `CrewMember.timezone` 由 `_resolve_task_timezone()`（`:233`）解析，`compute_next_run(tz_name=...)` 在本地墙钟域计算再转 UTC——`tz_name=None` 保留 legacy naive-UTC 语义防存量任务漂移。时间上下文以 **user-role 消息**注入（`current_datetime_context_message_for_tz()` in `src/user_time.py`）而非 system——保持 system prompt 字节级一致，不破 prompt cache（issue #2927）。

### singleflight 与日历提醒建模

`_cached()`（`:65`）做 singleflight 共享缓存：同一分钟触发的多个任务共享 MCP 快照/Miniflux 抓取，用 pending Future + `asyncio.shield` 处理取消语义。日历事件提醒**被建模为 Note**：`start()` 只启动 `_note_pings_loop()`（60s tick 调 `action_ping_notes()` in `src/builtin_actions.py:2103`），单一投递路径 `dispatch_reminder()`（`routes/note/note_routes.py:140`）走 browser/email/ntfy/webhook 四通道。

### `#!bg` 后台作业：独立子系统

`src/bg_jobs.py` 管 agent bash 工具的长命令 detach 启动（`launch()`，默认 `DEFAULT_MAX_RUNTIME_S = 3600` 一小时封顶），状态从磁盘 exit-code 文件推导（重启安全），`refresh()` 重读磁盘状态；每个 job 带 `followed_up` 标志——只有 `{done, followed_up: False}` 的作业才触发 `pending_followups()` 唤起（被 kill 的作业不唤起，防误续）；作业输出反馈给模型前经 `_MAX_OUTPUT_CHARS = 16000` 截断（头 + 尾保留）。与 TaskScheduler 是并行体系：bg_jobs 属于某次 agent 会话的延续，TaskScheduler 属于用户定义的持久任务。`src/agent_runs.py` 则是 detached 流式 run 的注册表（`start()/subscribe()/stop()`），被 `interactive_gate._has_active_chat_stream()` 用来感知前台是否在流式输出；`_Run` 的 replay buffer 有淘汰宽限 `_EVICT_GRACE_S = 180`（`:46`，跑完后保留 3 分钟供重连回放再逐出），`stop()` fail-closed——run_id 不匹配（stale 浏览器拿着旧 id）直接拒绝而非误停新 run，订阅者等待期收到 10 秒一次的心跳 SSE 注释行。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 自研轮询调度器（非 APScheduler） | `_loop()` + `compute_next_run()` in `src/task_scheduler.py` | 单 asyncio 循环 + DB 轮询，重启即恢复，无额外依赖 |
| singleflight 共享缓存 | `_cached()` :65 | 同 tick 多任务共享昂贵快照 |
| 事件→调度折叠 | `_handle_event()` → `next_run = utcnow()` | 事件与 cron 统一进一条通道，持久化不丢 |
| 幂等播种 | `ensure_defaults()` :2313 + `HOUSEKEEPING_DEFAULTS` :251 | 内置 housekeeping 任务幂等去重，按 legacy_names 归一化旧名 |

## 模块间交互

调度器自身不持 DB 连接——每次操作开新 `SessionLocal()`（函数局部 import 减少启动耦合）。消费 `stream_agent_loop()`（经 `resolve_task_candidates()` in `src/task_endpoint.py` 提供 fallback 端点链、`workload="background"` 标记、`compose_task_relevant_tools()` :41 保证 shell/python 默认可用但受 `blocked_tools_for_owner` owner 级门控）；消费 `BUILTIN_ACTIONS`（`_MODEL_BACKED_ACTIONS` :1197 排队进 model slot）；投递复用 email helpers 与通知队列。`teacher_escalation` 与调度弱相关（agent 质量旁路，非调度链路）。

## 扩展方式

- **新增内置动作类任务**：`src/builtin_actions.py` 写 `async def action_xxx(owner, **kwargs)` 注册进 `BUILTIN_ACTIONS`；需要开机播种就在 `HOUSEKEEPING_DEFAULTS`（`task_scheduler.py:251`）加条目，`ensure_defaults()` 幂等播种。
- **新增执行形态**（新 task_type）：`_execute_task_locked()` 的分派处加分支，并考虑 `_task_needs_model_slot()`（`:1210`）是否占模型队列。
- **新增 check-in 数据源**：往 `CHECKIN_MCP_PATTERNS`（`:1278`）加 pattern——注释明示"no code changes needed elsewhere"。对应测试：`tests/test_agent_rounds_exhausted.py`、`tests/` 下 `area_services` 类。
