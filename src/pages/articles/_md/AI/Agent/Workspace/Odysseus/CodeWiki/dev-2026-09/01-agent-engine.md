---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "Agent 执行引擎"
date: "2026-09-18T17:21:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "Agent Loop", "SSE", "上下文压缩"]
description: "stream_agent_loop() 是 Odysseus 全库连接数第一的 god node：请求分级、三级瀑布工具选择、85% 阈值上下文压缩、50 轮工具循环、四类循环出口与失控检测。本文拆解这个 6400 行生成器状态机。"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

这个模块是 Odysseus 的"大脑皮层"：`src/agent_loop.py`（6453 行）的 `stream_agent_loop()` 是 graphify 依赖图里连接数第一的 god node（69 edges）——每条智能链路（前台聊天、后台定时任务、研究任务）最终都汇进这一个 async generator。它解决的问题是：**把"模型输出一段话"变成"模型完成一件事"**——多轮工具调用、上下文膨胀治理、审批中断与恢复、流式回传，全在这一个函数的骨架里编排。

职责边界：模型怎么调（provider 适配、fallback）属于 [LLM 接入层](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/03-llm-access)；工具怎么解析、审批、执行属于[工具系统](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/02-tool-system)；本模块只负责**循环编排**——什么时候调模型、调几次、上下文怎么准备、何时停。协同文件：`src/builtin_actions.py`（3436 行，内置动作注册表）、`src/context_compactor.py`（压缩）、`src/chat_processor.py` / `src/chat_handler.py`（请求预处理）、`src/ai_interaction.py`（`_resolve_model()` 与服务定位器 setter）。

## 模块架构

模块整体是**函数式风格**——几乎没有类层级，靠 async generator 和注册表组织。核心组件五块：**入口分级**（`_classify_agent_request()` 判断这条消息值不值得跑完整 agent 循环）、**工具选择**（三级瀑布，避免全量 schema 压垮小模型）、**上下文整备**（压缩 + system prompt + KV-cache 友好约束）、**主循环**（带 `else` 子句的有界轮次状态机）、**收尾**（metrics + teacher 升级 + `[DONE]`）。跨模块数据契约只有两个类型：入口的 `ChatContext` 和循环内的 `ToolBlock`。这种"一个巨型 generator + 多个策略函数"的设计让循环控制流能在一个函数里从头读到尾——代价是 6400 行单文件，ROADMAP 也自认这是"suspiciously murky corner"。

仅有的几个类扮演配角：

- `ChatHandler` in `src/chat_handler.py:60` —— 组合 session_manager / memory_manager / chat_processor / research_handler / preset_manager / upload_handler 六个依赖（构造器注入），承载 `/api/chat` 与 `/api/chat_stream` 共享的预处理。
- `ChatProcessor` in `src/chat_processor.py:83` —— 负责 RAG/memory 上下文前奏构建，核心方法 `build_context_preface()` 与 `_hybrid_retrieve()`（BM25 + 向量混合检索）。
- `TaskNoop(BaseException)` / `TaskDeferred(BaseException)` in `src/builtin_actions.py:412/424` —— 继承 `BaseException` 以**穿透动作内部统一的 `except Exception` 错误包装**，让 task_scheduler 显式捕获——控制流信号而非错误，这是全模块最巧的一个小设计。

## 调用链路

![stream_agent_loop 轮次循环](/vibe-reading/images/articles/odysseus-codewiki-dev-2026-09/agent-loop-rounds.svg)

一条 agent 消息的完整路径：`routes/chat_routes.py:2336` 发起 `async for chunk in stream_agent_loop(...)`。函数内部先做**请求分级**——`_classify_agent_request()`（`agent_loop.py:1388`）判低信号/续答/域分类；满足 `_direct_low_signal`（`agent_loop.py:3542`：低信号轮 + 无既有对话 + 非续答 + 非 plan 模式 + 无审批计划 + 无 active document/email/workspace + 无强制工具）的低信号消息（寒暄、确认词）直接走 `stream_llm_with_fallback()` **一次 LLM 调用**返回——不执行工具、`agent_rounds=0`、metrics 事件带 `"direct_low_signal": True`（`:3846`），省一整轮循环；缺 workspace 直接 yield 错误 + metrics + `[DONE]`。然后**工具选择三级瀑布**：`tool_index.get_tools_for_query()`（ChromaDB embedding 检索 top-8 工具，`asyncio.to_thread` + 超时降级）→ `ToolIndex._KEYWORD_HINTS` 关键词兜底 → `_intent["domains"]` 查 `_DOMAIN_TOOL_MAP` 确定性域种子——每级超时都有降级注释（embedding 冷启动慢时不能丢掉 keyword hints）。进入主循环前还有**上下文整备**：`maybe_compact()`（`src/context_compactor.py:323`，仅 `defer_context_shaping` 或有 fallback 时）+ `_trim_route_request_messages()` → `trim_for_context()` + `_build_system_prompt()`（`agent_loop.py:2224`）。

主循环 `for round_num in range(1, max_rounds+1)`（`agent_loop.py:4771`，`MAX_AGENT_ROUNDS = 50`）：每轮 `stream_llm_with_fallback()` 逐 chunk 转发 delta/thinking/usage → `_resolve_tool_blocks()`（`agent_loop.py:2942`）把输出归一化为 ToolBlock 列表 → 每个 block `execute_tool_block()`（以 `asyncio.create_task` + progress Queue 推 `tool_progress` 事件）→ `_append_tool_results()`（`agent_loop.py:2993`）回写 messages 进下一轮。工具进度队列用 sentinel `None` 排空（`agent_loop.py:5799-5860`），`finally` 中 cancel 孤儿 task——注释明确防 SSE 客户端断连后 subprocess 泄漏。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `stream_agent_loop()` :3418 | agent 主循环 async generator | yield SSE 帧；finally 兜底 cancel 工具 task |
| `_classify_agent_request()` :1388 | 消息分级（低信号/续答/域） | 低信号短路省整轮循环 |
| `_resolve_tool_blocks()` :2942 | 输出归一化为 ToolBlock | native 无 tool_calls 时 fence 是示例代码不执行，但 DSML 泄漏仍执行（issue #3222） |
| `_append_tool_results()` :2993 | 工具结果回写 messages | 只保留最近一轮 `reasoning_content`（Nemotron 模板重复注入会堆积） |
| `_build_system_prompt()` :2224 | 组装系统提示 | 逐轮变化内容不进 system（KV-cache） |
| `_compute_final_metrics()` | 收尾 metrics 事件 | 前端成本统计 |
| `run_teacher_inline()` (src/teacher_escalation.py) | 失败轮升级 teacher 模型 | 失败 turn 抽 skill |
| `maybe_compact()` (src/context_compactor.py:323) | 85% 阈值触发摘要压缩 | 失败保留原文交给 trim |
| `trim_for_context()` (src/context_compactor.py:224) | 裁剪优先级树 | protected > preset > research > system > 旧轮 > 当前消息 |
| `dispatch_ai_tool()` (src/ai_interaction.py:1462) | AI 工具 if/elif 分派 | 兼容老路径 |
| `_run_verifier_subagent()` :3285 | completion verifier 子代理 | 默认关，`agent_verifier_subagent` setting 开 |

</details>

## 核心实现

### 循环出口：带 else 的有界状态机

`for round_num in range(...)` 配循环末尾 `else: _exhausted_rounds = True`（`agent_loop.py:6301`）——`break` 表示"完成/预算/错误"，`else` 表示"轮数耗尽"，客户端据此显示 **Continue 按钮**让用户续跑。终止条件全集：正常完成、`_awaiting_user`（ask_user 审批卡片即轮次边界，用户批准后以 `exact_approval` 重入）、`budget_hit`、`_doc_stream_create_completed`，以及两道防死循环闸门。**runaway**：`_detect_runaway_call()`（`agent_loop.py:3406`，`threshold=15`）——同一 `{tool_type}:{content[:120]}` 调用签名重复 ≥15 次即判死循环（刻意数"相同签名"而非"同工具总次数"——对同一工具的不同调用是合法批量工作）。**loop-breaker**：`_stuck_rounds`（`:4438`）数"重复调用且无新文本"的连续无进展轮，达 4 触发 `loop_breaker_triggered` 事件并置 `_force_answer = True`（`:443`/`:5320`）——下一轮**不带任何工具**强制模型作答；任何进展（新调用或实际文本）把计数清零。**工具预算**：调用方传 `max_tool_calls`（`:3427`，0=不限）时，`total_tool_calls >= max_tool_calls`（`:5631`，在自增后检查）发 `{"type": "budget_exceeded", "limit": ..., "used": ...}` 事件并置 `budget_hit`，内层 `break` + 外层 `break`（`:6254`）——最后一个工具的结果不再回喂模型，直接收尾。设计动机：50 轮上限是安全帽，真正的停止语义（"模型认为做完了"）无法静态判定，只能靠出口分类让前端理解"为什么停"。

round 0 分支处理 `exact_approval` 回放：用户精确批准的动作在进入循环前直接 `execute_tool_block` 并 `_append_tool_results`（`agent_loop.py:4491` 起），避免把已批准动作再走一遍门控。

### 上下文压缩：宁可多花 token 不丢上下文

`maybe_compact()`（`src/context_compactor.py:323`）只在上下文占用达 `COMPACT_THRESHOLD = 0.85`（`:40`）时触发：`split_point = len(convo_msgs) // 2` 对半切分，对旧半段对话用 `resolve_endpoint("utility")` 解析出的 utility 模型生成 summary，经 `_update_session_history()` 回写会话历史（带 `system_msg_count` 偏移量——压缩后消息数组变短，历史指针须同步平移）；**失败时优雅降级保留原文**（`return messages, context_length, False`，交给 `trim_for_context()`）——本地小模型摘要失败是常态，丢上下文比多花 token 代价大得多。`trim_for_context()`（`:224`）的裁剪是一棵优先级树：protected 消息（active document）> 首条 system（preset）> research primer > 其余 system（memory/RAG 注入）> 旧对话轮（保留最近 `PROTECT_RECENT = 10` 条），最后才截断当前用户消息并留可见标记。压不掉的顺序反映"哪些上下文丢了最伤"。

配套的 KV-cache 纪律写在 `ChatProcessor.build_context_preface()` 的 docstring：**逐轮变化的内容（时间戳、检索片段）不得进 system 消息**——llama.cpp / LM Studio 的 KV cache 按 byte-identical 前缀命中，system 一变整个前缀缓存作废（同 issue #2927：任务侧时间上下文也改用 user-role 注入）。这条纪律贯穿全库，是"本地优先"架构对缓存友好的典型例证。pinned 记忆也不是无脑全注入：`_select_pinned_memories()`（`src/chat_processor.py:112`）把旧行为改为"核心记忆（`_is_core_memory()` 判定的身份类）始终保留，其余 pinned 经 `_hybrid_retrieve()` 与查询相关性筛选"，上限 `MEMORY_CONTEXT_LIMIT = 5`（`PINNED_MEMORY_LIMIT` 同值，`:92-93`）。

### 微调模式与工具通道路由

Odysseus 对自家微调模型（ody_qwen / doc / notes / general）与不同工具通道做了显式路由：`_route_finetune_modes()`（`agent_loop.py:4080` 附近）按候选模型选择微调模式；`_agent_route_tool_mode()`（`agent_loop.py:989`）决定 API / Ollama-native / compat 三种工具通道；本地 Ody 微调模型干脆 `schemas = []` 走纯文本协议（不function calling）。`_tool_schemas_for_route()`（`agent_loop.py:4484`）按端点能力裁剪 `FUNCTION_TOOL_SCHEMAS`——能力协商的执行侧。公共用户则直接隐藏全部 MCP schema（安全默认）。

### 工具进度与流式协议

SSE 协议是文本化的 `data: {json}\n\n` 帧，事件类型：`delta / tool_start / tool_output / tool_progress / agent_step / metrics / web_sources / doc_update / rounds_exhausted / ui_control / model_actual / [DONE]`，错误用 `event: error` 帧，另有 `: heartbeat N` 注释行保活。选 SSE 而非 WebSocket 的证据在结构里：生成器被 `GeneratorExit` 关闭时 `finally` 能 cancel 工具 task——单向流 + 断连语义天然匹配 async generator，WebSocket 双向通道反而要自己管生命周期。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生成器流水线 | `stream_agent_loop()` in `src/agent_loop.py:3418` | SSE 单向流；断连即 GeneratorExit，finally 兜底清理 |
| 带子句的有界循环状态机 | 主循环 + `else: _exhausted_rounds`（:6301） | 区分"完成"与"轮数耗尽"两种停止语义 |
| 注册表 + 分派 | `BUILTIN_ACTIONS` in `src/builtin_actions.py:3394`；`dispatch_ai_tool()` in `src/ai_interaction.py:1462` | 动作按名注册，调度器与 UI 只查表 |
| 服务定位器 | `set_session_manager()` / `set_memory_manager()` in `src/ai_interaction.py:45-64` | 延迟注入全局依赖，避免启动期循环 import |
| 多层降级 | 低信号直答 → 完整循环；压缩失败 → trim 兜底 | 本地模型不可靠是常态 |

## 模块间交互

依赖（出）：`src/llm_core.py`（`stream_llm_with_fallback` / `llm_call_async`——标题摘要等辅助调用走后者）、`src/context_compactor.py`、`src/model_context.py`（`estimate_tokens`）、`src/tool_security.py` / `src/tool_policy.py` / `src/tool_capabilities.py` / `src/tool_approvals.py`、`src/agent_tools/*`（`ToolBlock`、`execute_tool_block`、`MAX_AGENT_ROUNDS`、`parse_tool_blocks`）、`src/tool_index.py`（RAG 工具选择）、`src/teacher_escalation.py`。被依赖（入）：`routes/chat_routes.py`（前台主入口）、`src/task_scheduler.py`（`_run_agent_loop` 后台消费）、`src/bg_monitor.py`（`#!bg` 完成唤起）、`src/deep_research.py`、`routes/cookbook_routes.py`、`routes/skills_routes.py` 及 40+ 测试文件。`BUILTIN_ACTIONS` 被 `task_scheduler.py:1244` 与 `routes/task/task_routes.py`（`BUILTIN_ACTION_INFO` 供 UI）消费。交互方式全部是函数调用与 generator 消费，无事件——事件（`fire_event`）只用于跨域通知。

## 扩展方式

- **新增一种内置动作**：在 `src/builtin_actions.py` 写 `async def action_xxx(owner, **kwargs) -> Tuple[str, bool]`，注册进 `BUILTIN_ACTIONS`（:3394）与 `BUILTIN_ACTION_INFO`（:3419）；调度执行路径在 `task_scheduler.py` 的 `_MODEL_BACKED_ACTIONS` / `_execute_action()`（按名 `BUILTIN_ACTIONS.get(task.action)` 查表）。注意 `ping_events` / `ping_notes` 已从用户可见注册表移除（保留为调度器内部 housekeeping 动作）——新动若属内部维护类，照此模式处理。
- **修改压缩策略**：`context_compactor.py` 顶部 `COMPACT_THRESHOLD = 0.85` / `SUMMARY_MAX_TOKENS = 1024`，或 `maybe_compact()` 的对半切分逻辑（split_point 取对话中点）。
- **新增循环终止/校验机制**：参照 `_run_verifier_subagent()`（:3285）与 intent-without-action supervisor（:5540 附近，"model announces action but emits no tool_call" 的 nudge 注入）——在 `not tool_blocks` 分支内加拦截后 `continue`。verifier 默认关闭（`agent_verifier_subagent` setting），开启后每轮结束校验模型产出是否完成，`_VERIFIER_MAX_ROUNDS = 2`（`:3264`，注释明示"cap re-verify cycles per turn — never loop forever"）封顶重验轮数；已用有效工具的轮（`_VERIFIER_EFFECTFUL_TOOLS`，`:3260`）跳过校验，反馈以注入消息方式回给模型重试。
