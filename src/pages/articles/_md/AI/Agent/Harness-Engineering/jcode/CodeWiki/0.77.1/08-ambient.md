---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Ambient 后台模式"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Ambient", "后台整合", "自适应调度", "Memory Gardening"]
description: "jcode Ambient 后台模式——像睡眠时整理记忆的自主 agent，自适应调度、memory gardening、proactive work、directive 持久化、单实例锁"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Ambient 模式是 jcode 的"睡眠整理"机制——一个后台自主 agent，像大脑在睡眠时整理记忆一样，tend 记忆图、发现有用工作、代表用户行动。模块位于 `crates/jcode-app-core/src/ambient/`（8 文件）+ `ambient_runner.rs` + `ambient_scheduler.rs`。默认禁用（`[ambient] enabled = true` 开启），v0.77.1 已标记 Implemented（2026-08-16）。

---

## 模块架构

- **runner.rs** — `AmbientRunnerHandle`，ambient 执行主循环
- **scheduler.rs** — `AdaptiveScheduler`，自适应间隔计算
- **manager.rs** — `AmbientManager`，状态 + ScheduledQueue
- **directives.rs** — `UserDirective`，用户指令持久化
- **persistence.rs** — `AmbientLock` 单实例锁 + ScheduledQueue 持久化
- **prompt.rs** — ambient system prompt 构建 + graph health 收集
- **paths.rs** — 路径管理

`AmbientStatus` 枚举：`Idle`/`Running{detail}`/`Scheduled{next_wake}`/`Paused{reason}`/`Disabled`。`ScheduleTarget`：`Ambient`/`Session`/`Spawn`。

---

## 调用链路

```
触发源（3 种）
  ├─ Session 关闭 → runner.nudge()              runtime.rs:384
  ├─ 定时器到期（AdaptiveScheduler）             runner.rs:830
  └─ Pending directives 唤醒                     runner.rs:659
       ↓
  run_loop (runner.rs:544)
    ├─ should_pause()?  scheduler.rs:250  (用户活跃 session 时暂停)
    ├─ should_run()?    manager.rs:36
    ├─ AmbientLock.try_acquire()  persistence.rs:177  (单实例保护)
    ├─ build_cycle_context()  runner.rs:849
    │    ├─ gather_memory_graph_health()  prompt.rs:43
    │    ├─ gather_recent_sessions()      prompt.rs:173
    │    ├─ gather_feedback_memories()    prompt.rs:112
    │    ├─ take_pending_directives()     directives.rs:58
    │    └─ build_ambient_system_prompt() prompt.rs:276
    ├─ run_cycle()  runner.rs:889
    │    ├─ Agent::new + register_ambient_tools()  tool/mod.rs:1173
    │    └─ agent.run_once_capture()
    │         ↓ (agent 自主调用)
    │         todo → memory gardening → end_ambient_cycle tool
    ├─ record_cycle_result()  manager.rs:49
    │    ├─ AmbientState.save() / save transcript
    │    ├─ NotificationDispatcher
    │    └─ spawn backfill_embeddings()
    └─ scheduler.calculate_interval()  → Scheduled{next_wake}
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `run_loop()` | ambient 主循环 | should_pause + should_run 双检查 |
| `calculate_interval()` | 自适应间隔 | rate limit headroom + 用户预算 |
| `should_pause()` | 暂停判定 | 用户活跃 session 时暂停 |
| `build_cycle_context()` | 构建上下文 | graph health + sessions + directives |
| `run_cycle()` | 执行 ambient cycle | 独立 Agent 实例 + 专用工具 |

---

## 核心实现

### 三合一：Garden + Scout + Work

Ambient 不是分阶段执行，而是在一次 pass 中同时做三件事（`docs/AMBIENT_MODE.md`）：
1. **Garden** — 整合、修剪、强化记忆图（duplicates > contradictions > prune > verify）
2. **Scout** — 分析近期 session、git history、记忆，理解用户关心什么
3. **Work** — 主动完成用户会感激的任务

system prompt（`prompt.rs:482`）明确优先级：先执行 scheduled queue → 再 garden memory graph → 最后 proactive work。高价值维护先做，proactive work 风险最高放最后。

### 自适应调度器

`AdaptiveScheduler`（`scheduler.rs`）的 `calculate_interval`（line 188）综合考虑 `tokens_remaining`、`window_remaining`、`user_projected_usage` 和 `avg_tokens_per_ambient_cycle`，确保 ambient 不抢占用户 token 预算。`user_budget_reserve=0.8` 表示 ambient 最多获得 20% headroom。

**指数退避**（`scheduler.rs:260`）：rate limit 错误时 `backoff_multiplier` 翻倍（上限 64），成功后重置为 1。

### 单实例锁与用户优先

`AmbientLock`（`persistence.rs:169`）PID 文件锁防止多实例并发运行——只允许一个 ambient agent（`docs/AMBIENT_MODE.md` Key Design Decision 1）。

`should_pause`（`scheduler.rs:250`）：用户有活跃 session 时 ambient 暂停——避免后台 agent 的文件操作/代码变更与用户当前工作冲突（Key Design Decision 3: user priority）。

### Directive 持久化

用户通过 email/Telegram 回复发送指令，持久化到 `directives.json`（`directives.rs:40`）。cycle 开始时 `take_pending_directives()`（line 58）消费并注入 system prompt。`consumed` 标记消费状态——跨进程/重启不丢失用户指令。

`ScheduledQueue`（`persistence.rs:94`）的 `pop_ready` 按 priority 降序 + scheduled_for 升序排列——高优先级先执行，同优先级先到先做。

### 独立 Agent 实例

`run_cycle`（`runner.rs:889`）创建独立 `Agent` 实例，注册专用工具集（`end_ambient_cycle`、`schedule_ambient`、`request_permission`、`send_message`），与用户交互 session 隔离。Agent 未调用 `end_ambient_cycle` 时自动发送 continuation 消息重试一次（`runner.rs:948`）。`SafetySystem` 共享给 ambient tools。

### Subscription-first

ambient 默认用 OAuth（OpenAI/Anthropic），不用 API key（`docs/AMBIENT_MODE.md` Key Design Decision 2: subscription-first）。使用 strongest available model 让 agent 能推理什么真正有用（Decision 4）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 自适应调度器 | `scheduler.rs:188 calculate_interval` | 不抢占用户 token 预算 |
| 指数退避 | `scheduler.rs:260` | rate limit 时退避 |
| Directive 持久化 | `directives.rs:40` | 跨重启不丢指令 |
| 单实例锁 | `AmbientLock` PID 文件 | 防多实例并发 |
| 后台 sideagent | `runner.rs:910` 独立 Agent | 与用户 session 隔离 |
| Soft Interrupt 注入 | `runner.rs:102 inject_message` | 外部消息中途打断 |

---

## 模块间交互

- **与 Memory**：`build_cycle_context` 调 `MemoryManager::load_project_graph()`/`load_global_graph()` 收集 graph health（contradictions/low_confidence/missing_embeddings）。Post-cycle 异步 `backfill_embeddings()`。Memory 工具作为标准工具注册给 ambient agent。
- **与 Agent**：`Agent::new(provider, registry)` 创建临时 agent，`run_once_capture` 驱动单次执行。
- **与 Server**：`runtime.rs:384` 在 client stream 结束时调 `runner.nudge()`——session end 触发核心路径。
- **与 Safety**：`SafetySystem` 共享，`request_permission` 工具走安全审批；runner 定期 GC 死 session 的 stale permission requests。

---

## 扩展方式

**新增 ambient directive 来源**（如 Slack 回复）：在 `runner.rs:556` 的 `run_loop` 添加 Slack reply poller（仿 IMAP poller 模式），调用 `ambient::add_directive(text, source_id)` 即可——directive 系统无需改动。

**修改触发条件**：在 `server/runtime.rs` 的 `handle_client` 追踪 turn 计数，达阈值时调 `runner.nudge()` 并设 `AmbientStatus::Idle`；同步修改 `manager.rs:36 should_run` 判断。

**调整 memory gardening 策略**：修改 `prompt.rs:43 gather_memory_graph_health` 的 contradiction 统计逻辑（当前仅统计 `EdgeKind::Contradicts` 边数量），可扩展为基于 embedding 相似度的自动检测。system prompt 中的 gardening 指令在 `prompt.rs:482` 调整。

> **注**：README 提到 "semantic drift, K turns since last extraction" 作为记忆提取触发——这是 memory 模块（[Memory 记忆](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/05-memory)）的提取触发，不是 ambient 触发。Ambient 的实际触发源是 AdaptiveScheduler 定时器 + session end nudge + pending directives。
