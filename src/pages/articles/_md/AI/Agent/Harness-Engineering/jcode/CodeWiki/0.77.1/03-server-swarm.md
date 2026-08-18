---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Server 与 Swarm"
date: "2026-08-18T14:33:22+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.77.1"]
tags: ["jcode", "Rust", "Daemon", "Swarm", "热重载", "文件冲突"]
description: "jcode Server daemon——单 server 多客户端架构、Swarm 多 agent 协作、文件冲突双向通知、exec 热重载、durable_state 持久化"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.77.1/00-overview)

---

## 模块定位

Server 模块是 jcode 的 daemon 核心——一个长驻进程服务所有会话，管理多客户端连接、swarm 多 agent 协作、文件冲突检测、exec 热重载。模块位于 `crates/jcode-app-core/src/server/`（80+ 文件），是 graphify 检出 god nodes 最密集的区域（`SwarmMember` 186 边、`handle_client` 112 边、`Server` 62 边）。

---

## 模块架构

server 模块内部按职责分组：

- **server.rs** — `Server` struct 主入口 + bus monitor 循环
- **runtime.rs** — `ServerRuntime` accept loop + `run_client_stream`
- **client_lifecycle.rs** — `handle_client()` 客户端连接主循环
- **state.rs** — `SwarmState`/`SwarmMember`/`SwarmEvent`/`FileAccess` 定义 + fanout
- **swarm.rs** — swarm 业务逻辑（broadcast/status/salvage/reap）
- **swarm_persistence.rs** — swarm 状态序列化/反序列化
- **file_touch_service.rs** — 双索引文件追踪
- **file_activity.rs** — 文件冲突 scope 判定
- **reload.rs** — exec-based 热重载
- **durable_state.rs** — 通用 JSON 持久化框架
- **client_comm_*.rs** — comm 协议处理（list/context/sync/plan）

`Server` struct（`server.rs:651`）持有 `sessions: Arc<RwLock<HashMap<String, Arc<Mutex<Agent>>>>>`、`swarm_state: SwarmState`、`file_touch: FileTouchService`、`event_tx: broadcast::Sender<ServerEvent>`、`swarm_event_tx: broadcast::Sender<SwarmEvent>`、`mcp_pool`、`soft_interrupt_queues` 等。

---

## 调用链路

### Server 启动与客户端连接

```
Server::run()                              server.rs:2242
  ├─ acquire_daemon_lock()                 防多实例
  ├─ socket_has_live_listener()            检查已有 daemon
  ├─ Listener::bind(main + debug socket)
  ├─ spawn_background_tasks()              embedding 预热 / orphaned 对账 / await_reload_signal
  ├─ finish_startup_after_bind()
  │   ├─ spawn_main_accept_loop()          runtime.rs:156
  │   │   └─ Listener::accept → run_client_stream → handle_client()
  │   ├─ spawn_debug_accept_loop()
  │   └─ recover_headless_sessions_on_startup()
  └─ tokio::select! { main_handle | debug_handle }
```

**`handle_client()`**（`client_lifecycle.rs:363`）：read_line → `decode_request()` → 轻量控制请求走 `handle_lightweight_control_request()`（不创建 Agent）→ 正常请求创建/复用 `Agent` → 注册 `SwarmMember` + `register_session_event_sender` → 进入请求循环（read_line → dispatch → turn 执行 → 响应回写）→ 断开时 `client_disconnect_cleanup` → `file_touch.clear_session()`。

### Swarm 文件冲突双向通知

```
Agent 工具调用 (edit/write/read/apply_patch)
  └─ Bus::global().publish(BusEvent::FileTouch(FileTouch{ session_id, path, op }))

Server bus monitor                         server.rs:1942
  Ok(BusEvent::FileTouch(touch)) =>
  ├─ file_touch.record_touch(path, FileAccess)     file_touch_service.rs:45
  ├─ record_swarm_event(SwarmEventType::FileTouch)
  ├─ 查 session 所属 swarm 的全部成员 session_ids
  ├─ 仅当 is_modification(Write|Edit) 时:
  │   ├─ file_touch.accesses_for_path(path)
  │   ├─ latest_peer_touches()       state.rs:79  过滤同 swarm 其他 session 的修改
  │   └─ 若有 prior peer touches:
  │       ├─ 对当前 agent: 发 NotificationType::FileConflict + queue_soft_interrupt
  │       └─ 对每个 prior agent: 同样发 FileConflict + soft_interrupt
  └─ file_activity_scope_label()     file_activity.rs:39  "overlapping lines" / "same file"
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `Server::run()` | daemon 启动 + accept loop | daemon lock 防多实例 |
| `handle_client()` | 客户端连接主循环 | 轻量控制请求不创建 Agent |
| `FileTouchService.record_touch()` | 双索引文件追踪 | forward + reverse 索引 |
| `latest_peer_touches()` | 查同 swarm 其他 session 的文件操作 | 仅 is_modification 触发通知 |
| `await_reload_signal()` | 监听热重载信号 | exec 新二进制 + socket fd 跨 exec |

---

## 核心实现

### Shared-Server Daemon 架构

所有会话由同一个长驻 daemon 进程服务（`AGENTS.md`），避免每次 `jcode run` 启动新进程。`Server::run()` 通过 `acquire_daemon_lock` + `socket_has_live_listener` 双重检查防多实例。多个客户端连接共享同一 `Agent`（按 session_id），TUI 客户端可断开后透明重连。Unix socket 路径 `/run/user/$UID/jcode.sock`，debug socket 独立。

### Swarm 状态与 Spawn 树

`SwarmState`（`state.rs:108`）四个 `Arc<RwLock>` 字段：`members`（session_id → SwarmMember）、`swarms_by_id`（swarm_id → 成员集合）、`plans`（swarm_id → VersionedPlan）、`coordinators`（swarm_id → coordinator session_id）。

`SwarmMember`（`state.rs:188`）的 `report_back_to_session_id` 隐式编码 spawn 树——`swarm.rs:41 swarm_ancestors` 沿 report-back 链向上遍历重建 spawn 树，无需独立 parent 字段。agent 拥有其整个 spawn 子树（`swarm_is_self_or_ancestor` 用于权限判定）。

swarm 有两种 spawning 模式（`docs/SWARM_ARCHITECTURE.md`）：普通 ad hoc swarm 是 one-level fan-out（只有 root 可 spawn，workers 报告给 root）；`swarm-deep` 模式允许递归 spawning（受 live-worker budget 和 `MAX_SWARM_MEMBERS` cap 约束）。

### 文件冲突双向通知

这是 swarm 的核心价值——多 agent 同仓库协作时自动检测冲突，不需主动轮询。通知是**双向**的：修改者得知之前谁动过该文件（`latest_peer_touches`），之前的修改者得知有人刚动了该文件。通过 `soft_interrupt_queues` 注入软中断，agent 在当前 turn 结束后看到通知。仅在 `is_modification`（Write/Edit）时触发，避免 read 产生噪声。`file_activity_scope_label`（`file_activity.rs:39`）判断冲突 scope——"overlapping lines" / "same file, non-overlapping" / "same file"。

### 多连接事件分发

`SwarmMember.event_txs: HashMap<connection_id, mpsc::Sender>` 支持同一 session 多个客户端连接（TUI + headless + debug）。`fanout_session_event()`（`state.rs:396`）清理已关闭的 sender 后向所有存活连接广播。

### Exec-based 热重载

`await_reload_signal()`（`reload.rs:57`）监听 `watch` channel，收到信号后：

1. `persist_reload_recovery_intents` — 保存 swarm 成员状态
2. `graceful_shutdown_sessions` — 优雅停止（2s 超时）
3. `abort_live_tasks_for_reload` — 终止后台任务并持久化 Failed 状态
4. `exec` 新二进制 — `mark_close_on_exec` 确保 socket fd 跨 exec 关闭让新进程 rebind

新进程 `load_persisted_swarm_runtime_state()` 恢复 swarm 状态，`recover_headless_sessions_on_startup` 重启 headless session。这是 self-dev 模式的基础——agent 修改 jcode 自身源码后可热重载继续工作。

### Durable State 持久化

`durable_state.rs` 提供通用 JSON 序列化框架（`load_json_state` / `save_json_state`）。swarm 状态通过 `swarm_persistence.rs` 持久化到 `runtime_dir/swarm_state/`。`PersistedSwarmMember` 映射 `SwarmLifecycleStatus` 枚举——`from_persisted_member` 时做 ghost 检测（restoring a persisted `ready` member as live creates a ghost）。`swarm_mutation_state.rs` 提供 coordinator 操作去重（持久化 `begin_or_replay` / `finish_request`），防止重载后重复执行。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Shared-server daemon | `Server::run()` daemon lock | 避免每命令启新进程，多会话共享 |
| 事件总线 | `Bus::global()` + bus monitor | 工具 publish FileTouch，server 消费分发 |
| 多连接 fanout | `SwarmMember.event_txs` | 同 session 多客户端（TUI+headless+debug） |
| Spawn 树（隐式） | `report_back_to_session_id` | 无独立 parent 字段，沿链重建 |
| Exec 热重载 | `reload.rs` | socket fd 跨 exec，不丢会话 |
| Durable state | `durable_state.rs` + `swarm_persistence.rs` | 状态跨重启/崩溃恢复 |
| Terminal member GC | `prune_expired_terminal_swarm_members` 24h | 防过期成员堆积 |

---

## 模块间交互

server 依赖 `crate::agent::Agent`（LLM 运行时）、`crate::bus::{Bus, BusEvent}`（事件总线）、`crate::protocol::{ServerEvent, NotificationType}`（客户端协议）、`crate::transport::Listener`（跨平台 socket）、`crate::provider::Provider`、`jcode_swarm_core`（`MAX_SWARM_MEMBERS` 等）、`jcode_agent_runtime`（`InterruptSignal`/`SoftInterruptSource`）。

`FileTouchService`（`file_touch_service.rs:26`）维护双索引：forward（`path → Vec<FileAccess>`）+ reverse（`session_id → HashSet<PathBuf>`），O(1) 查"谁动过这个文件"和"这个 session 动过哪些文件"。

---

## 扩展方式

**新增 swarm 消息类型**：(1) `state.rs:315` 的 `SwarmEventType` 枚举新增 variant；(2) `server.rs:1942` 的 bus monitor match 新增分支；(3) 若需 bus 层传递，`bus.rs` 的 `BusEvent` 新增 variant；(4) `swarm.rs` 新增 broadcast 函数复用 `fanout_session_event`；(5) `protocol.rs` 的 `ServerEvent`/`NotificationType` 新增对应类型。

**修改客户端生命周期状态**：`swarm.rs:227 member_status_is_terminal` 和 `member_status_is_dead` 定义 terminal 状态；新增状态需同步这两个判定 + `SwarmLifecycleStatus` 序列化枚举 + `update_member_status`（`swarm.rs:1291`）+ GC 过滤条件。

**新增文件冲突检测维度**（如目录级）：扩展 `file_activity.rs:39 file_activity_scope_label` 的 scope 判定，可能需在 `file_touch_service.rs` 新增目录级索引。
