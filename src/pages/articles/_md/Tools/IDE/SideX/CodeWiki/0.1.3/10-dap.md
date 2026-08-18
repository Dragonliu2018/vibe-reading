---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "调试器"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "DAP", "Debug Adapter", "debugger"]
description: "SideX 调试器——DAP 客户端双层架构，oneshot 请求关联，DebugSession 未接线"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

`sidex-dap` 实现 Debug Adapter Protocol 客户端——启动调试适配器进程（lldb-dap、debugpy、delve 等）、用 DAP JSON-RPC 通信，提供断点/单步/变量查看/调用栈。README 标注 debugger "in progress"。这个模块最显著的架构特征是**两层并行**——低层做管道转发（前端做 DAP 分帧，兼容 VSCode 原生 debug 基础设施），高层做完整 DAP 协议（后端做 DAP）。crate 内部设计完整（43 命令/16 事件/完整协议类型），但命令层只暴露约 11 个，且 `DebugSession` 等状态追踪未接线。

## 模块架构

```
命令层  commands/debug.rs（~543 行）
  ├─ DebugAdapterStore   低层：adapters Mutex<HashMap<u32, DebugAdapterHandle>>  同步 std::process
  └─ DapClientStore       高层：clients AsyncMutex<HashMap<u32, Arc<DebugClient>>>  异步 tokio::process
        ↓
crates/sidex-dap/（~2905 行，独立无 sidex 依赖）
  ├─ client.rs       DebugClient（spawn + initialize + send_request + on_event + recv_loop）
  ├─ session.rs      DebugSession（状态机 + 断点/线程/调用栈/变量缓存）  ← 定义但命令层未用
  ├─ transport.rs    DapTransport（Content-Length 分帧，注释 "same as LSP"）
  ├─ adapter.rs      DebugAdapterRegistry（with_builtins 5 种适配器）
  ├─ protocol.rs     DAP 协议类型（1041 行，消息/请求/响应/事件/数据结构）
  └─ launch_config.rs  launch.json 解析（JSONC，545 行）
```

两层分工：`DebugAdapterStore` 管裸适配器子进程，只 stdin/stdout 管道转发，不解析 DAP（前端 `TauriExecutableDebugAdapter` 自己 Content-Length 分帧）；`DapClientStore` 管完整 `DebugClient`，DAP 协议在 Rust 处理（`send_request`/`recv` 循环），前端只收高层事件。两 Store 独立编号，互不感知。

## 调用链路

高层启动调试器：

```
前端 SideXDapService → invoke('dap_start_adapter', {type_name, launchConfig})
  → debug.rs:351  dap_start_adapter
      → DebugAdapterRegistry::with_builtins().command_line(&type_name)  如 "lldb-dap"
      → DebugClient::launch(&command_line, &config)  in client.rs:35
         ① tokio::process::Command::new(cmd).spawn()  split_whitespace 拆命令行
         ② DapTransport::new(stdin, stdout)  Content-Length 分帧
         ③ start_recv_loop()  tokio::spawn 后台接收任务
         ④ initialize()  发 Initialize 请求，存 Capabilities
         ⑤ Launch 请求（program/args/cwd/env）
         ⑥ ConfigurationDone 请求
      → client.on_event(closure → app.emit("dap-event", DapEventPayload))  in debug.rs:374
      → 存入 DapClientStore，返回 {adapter_id, capabilities}
```

低层 `debug_spawn_adapter`（`debug.rs:51`）用同步 `std::process` + `std::thread`（OS 线程）reader，emit `debug-output`/`debug-error`/`debug-exit` 裸 wire 数据，前端自己做 DAP 分帧。

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `DebugClient::launch` in `client.rs:35` | spawn+init+launch+configDone | tokio process，一步到位 |
| `send_request` in `client.rs:165` | 发请求等响应 | oneshot channel 关联，支持并发（vs LSP 串行） |
| `start_recv_loop` in `client.rs:126` | 后台收消息 | Response→oneshot 唤醒，Event→handler |
| `set_breakpoints` in `client.rs:209` | 设断点 | 返回适配器确认的 Vec<Breakpoint> |
| `debug_kill` in `debug.rs:230` | 终止（低层） | drop stdin → child.kill → wait |
| `dap_stop_adapter` in `debug.rs:531` | 终止（高层） | disconnect(terminateDebuggee:true) + abort recv_task |

## 核心实现

### 请求-响应关联（oneshot channel）

`DebugClient` 的 `pending: Arc<Mutex<PendingRequests>>`，`PendingRequests = HashMap<i64, oneshot::Sender<DapResponse>>`（`client.rs:20`）。发请求时 `next_id`（AtomicI64）取 seq → 注册 seq→oneshot sender → `transport.send` → `recv_loop` 收到匹配 `request_seq` 的 response 时经 channel 唤醒等待者。这是**支持并发**的关联设计——多个请求可同时 in-flight，各自等自己的 oneshot。对比 [LSP](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/07-lsp) 的 `send_request` 持 transport Mutex 直到收 response（串行），DAP 这个设计更接近生产级。收 Event 调 `event_handler` 回调 → `app.emit("dap-event")`。reverse request 不支持（`log::warn`）。

### 内置适配器 + launch.json

`DebugAdapterRegistry::with_builtins()`（`adapter.rs:33`）预注册 5 种：node（js-debug-adapter，runtime node）、python（debugpy-adapter，runtime python3）、cppdbg（OpenDebugAD7）、lldb（lldb-dap）、go（dlv，args `["dap"]`）。`command_line()` 拼接 runtime+command+args。`launch_config.rs` 解析 `.vscode/launch.json`（JSONC 兼容，JSONC 解析见[存储与配置](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/11-storage-settings)），含 `pre_launch_task`/`post_debug_task` 字段——但**Rust 后端未接线**（无 `task_spawn`/`sidex_tasks` 引用），这是 "in progress" 的具体缺口。

### 未接线的 DebugSession

`DebugSession`（`session.rs:50`）定义了完整状态机——`state: SessionState`（Initializing/Running/Stopped/Terminated）、`threads`、`breakpoints: HashMap<path, Vec<Breakpoint>>`、`call_stack`、`variables: HashMap<vars_ref, Vec<Variable>>`，还有 `BreakpointPersistence`（`session.rs:20`，序列化断点到 JSON 跨会话恢复）。但 `DapClientStore` 只存 `DebugClient`，不存 `DebugSession`——状态追踪集成是 TODO。`DebugClient` 实现了 43 个 DAP 命令方法（含 `step_back`/`reverse_continue`/`goto`/`set_function_breakpoints`/`read_memory`/`write_memory`/`completions`/`exception_info`...），但命令层只暴露约 11 个 match 分支（continue/next/stepIn/stepOut/pause/stackTrace/scopes/variables/threads/evaluate/setBreakpoints）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Registry | `adapter.rs` `DebugAdapterRegistry` | type_name → 适配器，`with_builtins` 工厂 |
| 请求-响应关联 | `client.rs:20` `PendingRequests` oneshot | 支持并发 in-flight 请求 |
| Observer | `client.rs:29` `event_handler` + `app.emit("dap-event")` | server 事件推前端 |
| State Machine | `session.rs:11` `SessionState` | 调试会话状态流转（未接线） |
| Memento | `session.rs:20` `BreakpointPersistence` | 断点跨会话恢复（未接线） |
| Two-layer/Bridge | `DebugAdapterStore` vs `DapClientStore` | 低层管道转发兼容 VSCode，高层完整 DAP |

## 模块间交互

`sidex-dap` crate **完全独立**——`Cargo.toml` 只依赖 tokio/serde/serde_json/anyhow/thiserror/log，不依赖任何 sidex crate。与 sidex-terminal 无直接依赖（调试器自己 spawn 适配器，`std::process`/`tokio::process`，不经终端）。与 sidex-lsp 并行类比（都用 Content-Length 分帧 stdin/stdout，`transport.rs:1` 注释 "same as LSP"，但各自独立实现未共享传输层代码）。与 sidex-tasks 的 `pre_launch_task` 字段未接线。两个前端入口：`TauriExecutableDebugAdapter`（继承 VSCode `AbstractDebugAdapter`，用低层命令）和 `SideXDapService`（独立 singleton，用高层命令）。远程调试走前端 `TauriSocketDebugAdapter`（WebSocket，不经 Rust 后端）。

## 扩展方式

**新增一种调试适配器**：`adapter.rs::with_builtins()` 加 `register(type_name, ...)` → `launch_config.rs::builtin_templates()` 加 `LaunchConfigTemplate` → 如需新 DAP 命令分发在 `debug.rs::dap_send_request` match 加分支。

**修改断点同步（支持持久化）**：`BreakpointPersistence` 已实现 save/load（`session.rs:20`），在 `dap_send_request` 的 `setBreakpoints` 分支成功后调 `load`/`set_breakpoints`/`save`，需把 workspace 路径传入或新增 `dap_load_breakpoints` 命令。

**新增变量求值（watch 自动刷新）**：`DebugClient::evaluate` 已实现且已暴露（`debug.rs:494`），前端 `sendRequest("evaluate", {expression, frameId})` 即可用；自动刷新监听 `Stopped`/`Invalidated` 事件重新发 evaluate；`setVariable`/`setExpression` 在 match 加分支调 `client.set_variable()`（已实现）。

> 待核实：`DebugSession` 何时接入命令层；`pre_launch_task` 何时接 sidex-tasks；两层 Store 编号空间重叠是否产生问题（前端用不同事件名区分）。
