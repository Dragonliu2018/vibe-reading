---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Ambient 后台"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "AI Coding", jcode, CodeWiki, "0.84.0"]
contentType: "CodeWiki"
tags: ["jcode", "Rust", "Ambient", "Memory Gardening", "自适应调度", "ScheduledItem"]
description: "jcode Ambient 后台模式——单 pass 交织的 gardening/scouting/working、自适应调度器与未接线的 headroom 算法、ScheduledItem 跨重启调度、与 overnight 的关系、安全权限审批"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Ambient mode 是 jcode 的后台自主运行模式：一个 server 内常驻的后台循环，周期性唤醒单个 LLM agent，像大脑睡眠时整理记忆一样做 memory gardening、机会侦察和主动干活。默认关闭（`[ambient] enabled = true` 开启），但**即使关闭，runner 循环也常驻**——session 级定时任务（`schedule` 工具投递）依赖这个 delivery loop（`server.rs` 注释 + `runner_tests.rs:106` 的测试锁住该行为）。模块在 `crates/jcode-app-core/src/ambient/`（8 个文件），顶层 `ambient_runner.rs`/`ambient_scheduler.rs` 是 re-export shim。

---

## 模块架构

```
AmbientRunnerHandle::run_loop(provider) [runner.rs:544]   ← Server::run() spawn
  每个 iteration：
    1. scheduler.should_pause() 检查
    2. safety.expire_dead_session_requests()     GC 死 session 权限请求
    3. take_ready_direct_items() → Session/Spawn 目标立即投递
    4. should_run() 或 has_pending_directives() → AmbientLock::try_acquire()
         → run_cycle() → 一次 agent.run_once_capture(initial_message)
```

**单 pass 交织不是代码分支而是通过 prompt 实现**：`build_cycle_context()`（`runner.rs:849`）组装动态 system prompt（`prompt.rs:276` 的 `build_ambient_system_prompt`），注入 Scheduled Queue、Recent Sessions、Memory Graph Health、User Feedback History、Resource Budget，Instructions 给出优先级："1. Execute any scheduled queue items first. 2. Garden the memory graph... 3. Scout for proactive work... (simultaneous)"。initial message 固定一句："Begin your ambient cycle. Check the scheduled queue, assess memory graph health, and plan your work using the todo tool."——与 `docs/AMBIENT_MODE.md` 一致："These aren't separate phases. The agent does all three in a single pass."

---

## 调用链路

```
run_cycle_with_visible_launcher() [runner.rs:911]
  ├─ 默认 visible 模式：prompt 存 VisibleCycleContext (~/.jcode/ambient/visible_cycle.json)
  │    → spawn kitty 终端跑 jcode ambient run-visible → 读 cycle_result.json
  │    → kitty 失败 fallback headless
  ├─ headless: agent.run_once_capture(initial_message)
  │    agent 必调 end_ambient_cycle 工具收尾
  │    没调 → continuation 消息再跑一轮 → 仍没调 → forced end (Incomplete)
  └─ 收尾: record_cycle_result(next_schedule 入队) + 保存 AmbientTranscript
       + dispatch_cycle_summary 通知 + backfill_embeddings (spawn)
       + 失败 → scheduler.on_rate_limit_hit() 指数退避
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `run_loop()` in `runner.rs:544` | 常驻主循环 | enabled=false 也活着服务定时任务 |
| `run_cycle_with_visible_launcher()` in `runner.rs:911` | 单次 cycle | 异常停止两轮 continuation 兜底 |
| `calculate_interval()` in `scheduler.rs:188` | 自适应间隔 | clamp [5m, 120m]；⚠️ rate_limit_info 恒传 None |
| `should_run()` in `manager.rs:36` | 状态机判定 | Idle→true / Scheduled 到点→true |
| `take_ready_direct_items()` | 到期直接投递 | Session 目标通知活会话，Spawn 目标建 child |
| `inject_message()` in `runner.rs:102` | Telegram/Discord 回复 | cycle 运行中走 soft interrupt 即时送达 |
| `try_acquire()` in `persistence.rs:169` | PID 文件锁 | 锁粒度是单个 cycle 不是整个 loop |
| `gather_memory_graph_health()` in `prompt.rs:43` | 健康度量 | duplicate_candidates 是 placeholder=0 |

</details>

---

## 核心实现

### 调度器：设计 vs 实现的落差（重要发现）

`AdaptiveScheduler::calculate_interval()`（`scheduler.rs:188`）的算法与设计文档一致：`interval = window_remaining / (ambient_budget / tokens_per_cycle)`，其中 `ambient_budget = (tokens_remaining - user_projected) * (1 - user_budget_reserve)`（默认 reserve 0.8，即剩余额度的 20% 给 ambient）、`tokens_per_cycle` 取最近 5 次 cycle 均值（无历史时保守默认 10_000）、结果 clamp 到 `[min_interval_minutes=5, max_interval_minutes=120]`——把剩余预算均摊到剩余窗口，用户用量上升时 ambient 自动让路、富余时自动加密。但 v0.84.0 代码中**这个算法未接线**：

- `UsageLog::record()` 生产代码零调用点（仅测试）；`calculate_interval` 在 runner 两处（:678、:811）都传 `rate_limit_info = None`，恒走 `apply_backoff(max)` = **120 分钟**
- `active_user_sessions`（`runner.rs:53`）初始化 0 后无写入者，`scheduler.set_user_active()` 永远收到 false——设计决策 3 "User priority" 的运行时暂停从不触发
- cycle 结束后 loop 无条件 `sleep(calculate_interval(None))` = 120 分钟，agent 通过 `end_ambient_cycle.next_schedule` 请求的更早唤醒（如 15 分钟后）写入队列但 loop 在睡——只有 nudge（live session 调 `schedule` 工具、Telegram 注入、debug 命令）能提前打断

实际生效的是"agent 自定 next_schedule + 队列到期时间 + 120 分钟兜底 + 指数退避（`on_rate_limit_hit` 翻倍至上限 64，`on_successful_cycle` 归 1）"。自适应 headroom 计算已实现但等待接线——这本身是解读源码比读设计文档有价值的一个例证。

### 单实例与崩溃安全

`AmbientLock`（`persistence.rs:169`）：PID 文件锁 `~/.jcode/ambient/ambient.lock`——锁存在且 PID 活着返回 None（等 60s 重试）；PID 已死删陈旧锁后写入自己；`release()` 删锁文件后 `std::mem::forget(self)` 防 Drop 重复删除。锁粒度是**单个 cycle**（acquire→run_cycle→release），同进程的 visible 模式 TUI 子进程与 headless fallback 不会并发。`end_ambient_cycle` 工具被调时**立即持久化** `AmbientState`（防 crash 丢失）。`UsageLog`（`scheduler.rs`）持久化到 `~/.jcode/ambient/usage.json`：每累积 10 条未保存记录触发一次 save，save 时 prune 掉 24 小时前的记录——注意这是为 headroom 算法准备的数据层，当前生产路径未接线（见下节）。

### ScheduledItem：跨重启的调度持久化

`ScheduledItem`（`ambient.rs:114`）：`target` 三种（`ScheduleTarget::Ambient` / `Session{session_id}` / `Spawn`），落盘 `~/.jcode/ambient/queue.json`，每次 push/remove/pop 即时 save。**过期不丢弃**（崩溃恢复原则："System can delay items if over budget, but won't drop them"）；排序 priority 降序、时间升序。三路消费：Ambient 进 prompt 的 `## Scheduled Queue` 段；Session 到期时 `notify_live_session()`（失败降级 `resume_dead_session_with_reminder()`）；Spawn 建 child session 单次执行。

普通 session 的 `schedule` 工具（`tool/ambient.rs:714`，注册在基础 registry）：create 时自动捕获 `working_dir` 和 `git_branch`，组装 `background_context`/`success_criteria`，随后 `nudge_schedule_runner()` 经全局 OnceLock 立即唤醒后台 loop。

### memory gardening：prompt 驱动的 agent 行为

代码侧只有 `gather_memory_graph_health()`（统计 active/inactive、低置信、缺 embedding、`Contradicts` 边数）+ 自动 `backfill_embeddings()`（runner 侧唯一直接执行的 gardening 动作）。其余 gardening 由 ambient agent 用普通 `memory` 工具（remember/recall/search/forget）加 bash/read 验证后执行：合并去重靠 remember 新写 + forget 删旧；矛盾消解靠代码库事实判定真伪后 forget 一条；过期事实核查靠 bash 验证。**反馈学习**：`gather_feedback_memories()`（`prompt.rs:112`）把最近 5 份 ambient transcript 摘要 + 用户批准/拒绝历史注入 prompt——proactive work 的历史决策成为下次的上下文。

### overnight：平行体系

`jcode-overnight-core` 是 `/overnight <hours> [mission]` 的数据 + 渲染 crate，执行在 `overnight.rs`（1275 行）。与 ambient **平行不共享** runner/scheduler/lock：overnight 用户显式启动（1 分钟–72 小时），从当前 session fork coordinator，`spawn_supervisor` 持续驱动到 `target_wake_at`；产物是 `~/.jcode/overnight/<run_id>/` 下的 Manifest/events.jsonl/review.html/结构化任务卡。交集是共享 Safety System 与 rate limit 感知思想。

### ambient 专属工具面

`register_ambient_tools()`（`tool/mod.rs:1304`，仅 headless cycle 注册）：`end_ambient_cycle`（必调收尾，结果经进程级 OnceLock 传回 runner）、`schedule_ambient`、`request_permission`（经 `ensure_ambient_session()` 白名单校验，`build_permission_review_context()` 把 LLM 字段归一化为 reviewer-ready 结构——summary/why/risks/rollback_plan）、`send_message`（Telegram/Discord channel）。

---

## 模块间交互

被 `Server::run()` spawn（独立 task）；`SafetySystem` 共享实例做权限审批（`safety.rs` 的 `PermissionNotifier` 反转注册让 notifications 层投递）；memory 侧是 `MemoryManager`/`MemoryGraph` 的普通消费者；与 TUI 的通道是 `schedule` 工具的 nudge 与 debug 命令（`jcode ambient status/log/trigger/stop`）。Telegram/Discord 回复在 cycle 运行中经 `active_cycle_queue`（agent 的 SoftInterruptQueue）即时送达，否则存 directive 下轮注入并标记 top priority。

---

## 扩展方式

**新增 ambient 周期任务**：agent 可决策的零代码——session 里调 `schedule` 工具（`target: "ambient"`）；需要新数据源进 prompt 则在 `prompt.rs` 加 `gather_xxx()`（参考 `gather_recent_sessions` 的 mtime 预过滤——sessions 目录上万文件时避免全量 parse）并在 `runner.rs::build_cycle_context` 调用；改调度行为则改 `calculate_interval()` / `AmbientConfig`（字段全部暴露为 TOML）——**把 runner 两处 `calculate_interval(None)` 接上真实 `RateLimitInfo` 本身就是当前最大的待办缺口**。
