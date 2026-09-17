---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Server 与 Swarm"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "AI Coding", jcode, CodeWiki, "0.84.0"]
contentType: "CodeWiki"
tags: ["jcode", "Rust", "Daemon", "Swarm", "Plan DAG", "热重载", "文件冲突检测"]
description: "jcode Server 与 Swarm——单 server 多客户端 daemon、文件冲突双向通知、mode-gated 递归 spawn、Plan DAG 任务图（seed/expand/complete + 心跳/回收）、exec 热重载"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

Server 是 jcode 的 daemon：单进程管理所有会话、swarm 协调状态、MCP 共享池与 ambient runner，TUI 客户端经 Unix socket 连接并可透明重连。Swarm 是其上的多 agent 协作层——文件冲突自动检测、任务 DAG、spawn 树治理。v0.84.0 的 swarm 正从 **agent-first**（你 spawn agents、跟它们说话）转向 **task DAG-first**（`docs/SWARM_TASK_GRAPH.md`：DAG 成为主对象，agents 成为可替换的 worker）：DAG 引擎、deep/light 模式、gates 已上线，channel/shared-context 弃用迁移进行中。

---

## 模块架构

`crates/jcode-app-core/src/server.rs`（~2400 行）+ `server/` 目录（~70 个文件）组成 Server。`Server` struct（`server.rs:686`）字段分四组：

- **会话管理**：`sessions: Arc<RwLock<HashMap<String, Arc<Mutex<Agent>>>>>`（live agent 注册表）、`client_connections`、`shutdown_signals` + `soft_interrupt_queues`（**刻意放在 agent mutex 之外**——swarm/debug 通知能在 agent 正在处理时入队）、`await_members_runtime` / `swarm_mutation_runtime`（持久化 dedupe/wait 注册表）
- **swarm**：`swarm_state: SwarmState`（`state.rs:108`）= members + swarms_by_id + plans（swarm_id→VersionedPlan）+ coordinators 四个独立 `Arc<RwLock<HashMap>>`、`shared_context`、`channel_subscriptions`（正反双索引）、`event_history`（5000 条环形缓冲 `MAX_EVENT_HISTORY`）+ `swarm_event_tx` broadcast
- **文件追踪**：`file_touch: FileTouchService`——前向 `path → Vec<FileAccess>` + 反向 `session_id → HashSet<PathBuf>` 双索引
- **基础设施**：`provider`、双 socket（主 + debug）、`identity: ServerIdentity`（形容词 server 名 + 动物 session 名，如 "🔥 blazing 🦊 fox"）、`mcp_pool: Arc<OnceCell<Arc<SharedMcpPool>>>`（懒初始化）、`ambient_runner`

`server/` 目录按职责拆为 ~70 个文件：`client_lifecycle.rs`（连接主循环）→ `client_session.rs`（subscribe/resume）→ `comm_*.rs`（swarm 请求处理，~10 个）→ `swarm.rs`（状态机）→ `state.rs`（SwarmState/SwarmMember）→ `reload.rs`（热重载）→ `debug_*.rs`（debug socket 命令面）→ `runtime.rs`（accept loop + `RuntimeTaskScope` JoinSet+CancellationToken 树）。

---

## 调用链路

```
Server::run() [server.rs:2283]
  ├─ load_persisted_swarm_runtime_state()      崩溃恢复 swarm plans/members
  ├─ spawn monitor_bus() [server.rs:1957]      Bus → 文件冲突检测 → 双向通知
  ├─ spawn ambient runner / prune 定时任务（terminal 24h / idle worker 30min）
  └─ accept loop [runtime.rs:156] → handle_client() [client_lifecycle.rs:435]
       ├─ 首请求循环（Ping 等轻量控制请求直接应答关闭）
       ├─ fork provider + Registry::new + provisional Agent + 控制句柄注册
       ├─ per-client mpsc + 事件转发 task（独占 socket 写）
       └─ biased select! 主循环：请求 > turn 完成回调 > disconnect > bus > debug
            Request::Message → start_processing_message → spawn
              process_message_streaming_mpsc → agent.lock() 整 turn 持有
              → run_once_streaming_mpsc → 完成后 Done/Error 走 fanout tx
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `handle_client()` in `client_lifecycle.rs:435` | 连接生命周期 | 31 参数——server 状态近乎全量传入 |
| `monitor_bus()` in `server.rs:1957` | Bus 事件消费 → 冲突检测 | 只处理 `is_modification()` |
| `latest_peer_touches()` in `state.rs:79` | 同 swarm 他人修改过滤 | 每 session 取最新一条 |
| `spawn_swarm_agent()` in `comm_session.rs:574` | 实际 spawn worker | Inline 模式默认（进程内） |
| `ensure_spawn_coordinator_swarm()` in `comm_session.rs:1251` | spawn 门控 | deep 判定锚定 root——worker 无法自行升级 |
| `remove_session_from_swarm()` in `swarm.rs:995` | 成员离场 | 先抢救 plan 分配，再 reparent 子节点 |
| `update_member_status()` in `swarm.rs:1291` | 状态转换 | 通知 report-back owner 优先于 coordinator |
| `touch_swarm_task_progress()` in `swarm.rs:495` | 任务心跳（10s） | 无心跳 45s 标 `running_stale` |

</details>

---

## 核心实现

### 文件冲突检测：乐观无锁的双向通知

完整链路：工具执行时 `Bus::global().publish(BusEvent::FileTouch(...))`（发布点在 `tool/read.rs:227`、`edit.rs`、`write.rs`、`apply_patch.rs`）→ `Server::monitor_bus` 消费 → `file_touch.record_touch()` 更新双索引（每 5 分钟 `expire_older_than(30min)`）→ 仅 `touch.op.is_modification()` 时调 `latest_peer_touches(&accesses, &self, &swarm_ids)` 取"同 swarm、非自己、是 modification"的各 session 最新访问 → **双向通知**：向当前修改者发 `ServerEvent::Notification { FileConflict }`，向先前 peer 发 "just modified this file you previously worked with"。通知经 `queue_soft_interrupt_for_session()`（`state.rs:709`）三级 fallback 注入：注册表 queue → `agent.try_lock` → 磁盘持久化延迟投递。设计哲学（`docs/SWARM_ARCHITECTURE.md` "Conflict Handling (No Locks)"）：不锁文件，让双方在分歧扩大前主动协调，冲突靠 DM 沟通解决。

### mode-gated 递归 spawn

`ensure_spawn_coordinator_swarm()`（`comm_session.rs:1251`）的门控：非 root 请求 spawn 时查 **root session** 的 effort（`prompt::is_deep_swarm_effort`，`prompt.rs:129`）——非 deep 直接拒绝 "Recursive swarm spawning is disabled for light and ad hoc swarms"。关键设计：**deep 判定锚定 root 而非请求者**（`comm_session.rs:1347` 注释），worker 无法自行升级权限。swarm-deep 模式后代可任意深度 spawn，受两层上限：`MAX_SWARM_MEMBERS = 1000`（`jcode-swarm-core/src/lib.rs:60` 硬顶，统计所有消耗容量的成员）和 `swarm_max_concurrent_agents`（默认 32 live 预算，只统计 `report_back_to_session_id` 非空的 spawned agents）——深度上限已取消（`swarm_spawn_depth` 已 `#[cfg(test)]`）。准入本身经 `spawn_admission_lock`（按 swarm_id 的 `Arc<Mutex<()>>`）串行化——防止并发 spawn 都观察到同一空闲槽位冲破限制；用 `Weak<Mutex<()>>` + strong_count 清理避免为不活跃 swarm 保留锁。coordinator slot 只服务共享 plan 操作（propose/approve/assign/task-control），仅 root 可 claim 且仅当 slot 为空或 stale。

**reparenting**（`remove_session_from_swarm`，`swarm.rs:995`）：成员离场（stop/crash/disconnect）时先 `salvage_assignments_of_dead_member` 抢救 plan 分配，然后离场者的直接子节点 reparent 到活着的 grandparent → 否则 coordinator → 否则变 root——dangling 的 report-back 边会破坏 stop 权限、子树广播与完成报告。

### Plan DAG：依赖边即数据通道

`VersionedPlan`（`jcode-plan/src/lib.rs:150`）持有 `items: Vec<PlanItem>`（`blocked_by: Vec<String>` 即依赖边）、`task_progress`、`mode`（light/deep）、`node_meta`（kind/parent/expanded/is_gate/artifact_json）。`MAX_PLAN_ITEMS = 1024`（`lib.rs:9`）在 `comm_graph.rs:36`、`comm_plan.rs:399`、`debug_swarm_write.rs:397` 三处 enforce。

DAG 引擎（`jcode-plan/src/dag/ops.rs`）：`seed`（L19）→ `expand_node`（L227，把节点分解为子 DAG）→ `complete_node`（L377，解锁 dependents）→ `inject_from_gate`（L444，gate 检出缺口注入 fix 节点）→ `requeue_failed`（L547）。**数据流即控制流**：节点完成时存储 structured handoff artifact（默认 by-reference——"我建了 `crates/foo/api.rs`，commit abc123"，下游 agent 自己去读 repo）；下游 runnable 时 `hydrate_assignment` 把全部上游 artifact 注入 worker 起始上下文，fan-out/fan-in 自然成立。节点类型按终态动作分：`explore`（findings 过 critique gate）/ `implement`（diff 过 verify gate）/ `verify`（失败 spawn fix 节点——更多图）/ `fix`（re-verify 通过）。

**assignment 治理**：`SwarmTaskProgress` 的 `last_heartbeat_unix_ms`（默认 10s 心跳，同时 `session_metrics::record_activity`）、`checkpoint_summary`、`stale_since_unix_ms`（45s 无心跳标 stale）、`dead_assignee_reclaims`（`MAX_DEAD_ASSIGNEE_RECLAIMS = 3`，`jcode-plan/src/lib.rs:633`——死亡 worker 重派上限，防无限循环：达上限的任务标 `failed` 并清空 assigned_to，未达上限的经 `reclaim_stranded_assignment` 解除绑定保留 heartbeat/checkpoint 历史、status 置回 queued、plan version +1）。server 每 5s `refresh_swarm_task_staleness` 扫描。`MAX_PLAN_ITEMS = 1024` 的理由是活成员上限（1000）的 4 倍——plan 是协调状态不是活动日志，无上限会让 seed/expand/inject/approve 无限保留陈旧节点。

### 热重载：exec 替换进程镜像

客户端 `Request::Reload` → `handle_reload`（非 force 时 `server_has_newer_binary()` 防降级和 reload-loop）→ 先 fanout `ServerEvent::Reloading` 给所有 live 客户端 → `await_reload_signal`（`reload.rs:57`）：写 ReloadPhase 状态文件 → `persist_reload_recovery_intents`（候选为 status=="running" 的成员，按 `ReloadRecoveryRole` 分类：触发会话=Initiator、headless=Headless、其他运行中 peer=InterruptedPeer）→ `graceful_shutdown_sessions`（2s 超时，`RELOAD_GRACEFUL_SHUTDOWN_TIMEOUT`；以会话的 StatusChange 事件或成员 left 为完成信号，无 shutdown_signal 的 running 会话不阻塞）→ **`abort_live_tasks_for_reload()`**（exec 不跑析构，否则 kill_on_drop 子进程泄漏）→ `prepare_server_exec`：unlink 双 socket（防 exec 继承 stale endpoint）+ stdio 全部 detach 为 null（防 SIGPIPE）→ `platform::replace_process` exec 新二进制 → 失败 `exit(42)`。客户端收 `Reloading` 后进入重连循环直到新 daemon 绑定 socket；新 daemon 启动时 `recover_headless_sessions_on_startup` + `resume_background_awaits` 恢复中断现场。

另注意 server 自身的生命周期：全部客户端断开后 `IDLE_TIMEOUT_SECS = 300`（5 分钟）空闲超时，进程以 `EXIT_IDLE_TIMEOUT = 44` 退出码结束（`server.rs:651/683`，与 `docs/SERVER_ARCHITECTURE.md` 的 "All clients close → Server idle-timeout after 5 min" 一致）。启动时 `socket.rs` 的 `socket_has_live_listener()`（L72）先探测已有 daemon 再决定 bind，防多实例。

**冲突 scope 判定**：`file_activity_scope_label()`（`file_activity.rs:39`）把冲突细分为 "overlapping lines" / "same file, non-overlapping lines" / "same file"——通知文本里带 scope，让被通知的 agent 判断要不要认真处理。**持久化基础设施**：`durable_state.rs` 提供通用 JSON 持久化框架（`load_json_state` / `save_json_state` + session_id 消毒）；swarm 状态经 `swarm_persistence.rs` 落到 `runtime_dir/swarm_state/`，恢复时 `from_persisted_member` 做 ghost 检测（把已死的 persisted `ready` 成员恢复为 live 会产生幽灵）；`swarm_mutation_state.rs` 给 coordinator 变更操作提供持久化去重（`begin_or_replay` / `finish_request`），防重载后重复执行。

---

## 模块间交互

向下持有 `Agent`（`Arc<Mutex>` map）与 `Arc<dyn Provider>`；MCP 经懒初始化的 `SharedMcpPool`；ambient runner 独立 task。向上服务 TUI 客户端（`Request`/`ServerEvent` JSON over socket）与 harness-api bridge（translate 翻译）。swarm worker 间通信三种方式（`handle_comm_message` in `client_comm_message.rs:103`）：**DM**（`to_session`，支持 swarm 内唯一 friendly name）、**子树广播**（无目标时只触达自己的 spawn 子树，coordinator 保留全 swarm 触达逃生口）、**channel**（`to_channel`，无订阅者回退子树）——channel/shared_context 处于弃用中（DAG artifact dataflow 取代 DM 的信息传递职能）。

---

## 扩展方式

**新增 swarm 事件**：`server/state.rs` 的 `SwarmEventType`（L315）加变体 → 生产处调 `record_swarm_event`（自动进环形缓冲 + broadcast）→ 更新 `debug_events.rs` 的 `events:types` 列表 → 补 `swarm_persistence_tests.rs`。**新增 server 端 debug 命令**：只读加 `debug_swarm_read.rs`（如 `swarm:list`），写命令加 `debug_swarm_write.rs`（注意 `MAX_PLAN_ITEMS` 检查模式），帮助文本在 `debug_help.rs`；写命令受 `debug_control_allowed()`（`JCODE_DEBUG_CONTROL=1`）门控。**新增 Comm\* 请求**：`jcode-protocol` 的 `Request` 加变体 + `client_lifecycle.rs` 分发 arm + 对应 `comm_*.rs` handler。
