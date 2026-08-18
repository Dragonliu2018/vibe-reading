---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "LSP 语言服务"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "LSP", "Language Server", "JSON-RPC"]
description: "SideX LSP 客户端——tokio 子进程、能力协商、通知推送、单服务器请求串行化设计"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

`sidex-lsp` 实现 Language Server Protocol 客户端——启动/管理语言服务器进程、用 JSON-RPC over stdio 通信、协商能力、为编辑器提供补全/定义/引用/诊断/hover/rename/inlay hints 等语义智能。对应 VSCode 里跑在前端 Node.js 的 `vscode-languageclient`，SideX 移到后端 Rust（Tauri webview 无 Node，天然需要后端代理）。Crate 共 25 文件 ~8066 行，采用 LSP 3.17 规范（`lsp-types = "0.97"`）。

## 模块架构

```
命令层  commands/lsp.rs   LspState（registry + clients HashMap + next_id），6 个 #[tauri::command]
        ↓
sidex-lsp crate
  ├─ client.rs          LspClient（spawn + initialize + send_request + on_notification）
  ├─ transport.rs       LspTransport（ChildStdin/Stdout，Content-Length 分帧）
  ├─ capabilities.rs    ServerCaps（20+ supports_* 查询）
  ├─ registry.rs        ServerRegistry（language ID → ServerConfig，内置 7 种语言）
  ├─ diagnostics.rs     DiagnosticManager（按 URI 存储 + 版本追踪 + F8 导航 + quick-fix cache）
  ├─ progress.rs        ProgressTracker（$/progress → 状态栏）
  ├─ document_sync.rs   compute_incremental_changes + ChangeThrottle 节流
  └─ completion_engine/hover_engine/go_to/rename_engine/inlay_hints/...  feature engine 模块
```

`LspState`（`lsp.rs:10`）：`registry: ServerRegistry`（无锁只读）、`clients: Mutex<HashMap<u32, Arc<LspClient>>>`（按**数字 ID** 管理，不按 language/workspace）、`next_id`。多服务器策略是 per-server-startup——调用方决定何时启动几个，同语言两 workspace 可各自启动或共用。

## 调用链路

启动语言服务器：

```
前端 SideXLspService.startServer({languageId, rootUri})  in sidexLspService.ts
  → invoke('lsp_start_server')
  → lsp_start_server (lsp.rs:96)
      → state.registry.get("rust") → ServerConfig{command:"rust-analyzer", args:[]}
      → LspClient::start("rust-analyzer", &[], root_uri)  in client.rs
         ① tokio::process::Command::new(...).stdin(piped).stdout(piped).stderr(null)
            .kill_on_drop(true).spawn()               Windows: creation_flags(0x0800_0000)
         ② LspTransport::new(stdin, stdout)            Content-Length 分帧 JSON-RPC
         ③ self.initialize(root_uri)                  send_request("initialize", params)
            → encode_message → write "Content-Length: N\r\n\r\n" + JSON body
            → loop { transport.recv() } 等待 response id=1
            → 解析 InitializeResult → ServerCapabilities
         ④ server_capabilities = Some(ServerCaps::new(caps))
         ⑤ send_notification("initialized", {})
      → client.on_notification(closure)               注册通知 handler → app.emit("lsp-notification")
      → state.clients.insert(id, Arc::new(client))
      → return LspStartResult{server_id, capabilities}
```

请求转发：

```
前端 SideXLspService.sendRequest(serverId, "textDocument/completion", params)  → invoke('lsp_send_request')
  → lsp.rs:151  state.clients.lock().get(&server_id).cloned() → Arc<LspClient>
  → client.raw_request("textDocument/completion", params)  in client.rs:458
      → next_request_id() → AtomicI64 fetch_add
      → transport.lock().send(JsonRpcMessage::request(...))
      → loop { transport.recv() }
          Response matching id → return result
          Notification → notification_handler → app.emit("lsp-notification")
  → return Value → 前端
```

诊断推送：server stdout → `LspTransport::recv()` → `Notification` → `notification_handler(method, params)` → `app.emit("lsp-notification", {server_id, method, params})` → 前端 `tauriListen` 按 method 路由（`publishDiagnostics`→DiagnosticManager、`$/progress`→ProgressTracker、`window/logMessage`→输出面板）。注意 `DiagnosticManager` 在 crate 定义但**命令层未使用**——诊断路由由前端处理。

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `LspClient::start` in `client.rs:35` | spawn + initialize | `kill_on_drop(true)` 防僵尸进程 |
| `send_request` in `client.rs:458` | 发请求等响应 | 持 transport Mutex 直到匹配 response（串行） |
| `supports_*` in `capabilities.rs` | 能力查询 | 每个 feature 前查，未声明不发对应 LSP 方法 |
| `compute_incremental_changes` in `document_sync.rs` | 增量同步 | 用 range 计算 didChange 的 contentChanges |
| `ChangeThrottle::flush` in `document_sync.rs:109` | 节流 didChange | 防快速击键淹没 server |

## 核心实现

### 能力协商 + Engine 模式

`initialize` 发 `InitializeParams`（`client_info.name = "sidex"`，`capabilities` 用 `ClientCapabilities::default()`——未声明细粒度能力，待核实是否影响某些 server 行为），响应存 `ServerCaps`。每个 feature 有独立 engine 模块（`completion_engine.rs`/`hover_engine.rs`/`inlay_hints.rs`...），把 `LspClient` 原始方法包装为 UI 友好高层 API，用 `sidex_text::Position` 而非 `lsp_types::Position`。`ServerCaps` 有 20+ `supports_*()`（completion/hover/definition/references/rename/formatting/code_action/signature_help/inlay_hints/call_hierarchy/type_hierarchy...），特殊：`supports_type_hierarchy` 查 `experimental.typeHierarchyProvider`（非标准），`supports_prepare_rename` 查 `RenameOptions.prepare_provider == Some(true)`。

### 单服务器请求串行化

`send_request` 在 `loop` 中持 transport 的 Mutex 直到收到匹配 response——**单服务器内请求串行**，不能并发发 `completion` 和 `hover` 给同一 server，长时间请求（`workspace/symbol`）会阻塞同 server 其他请求。真正的 LSP client（VSCode vscode-languageserver-node）用 request-response correlation map（ID→oneshot sender）支持并发，SideX 是简化版。多服务器之间可真正并发（各自 transport Mutex 不互斥）。对比 [调试器](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/10-dap) 的 `DapClient`——它用了 `PendingRequests = HashMap<i64, oneshot::Sender>` 实现并发关联，LSP 反而没做。

### 崩溃恢复：无

`kill_on_drop(true)` 防僵尸进程，`shutdown()` 正常关闭时 `child.wait()` 等退出，但**无自动恢复**——没有 `try_wait()` 轮询、无 exit 监听、无自动重启。server 崩溃时 `LspTransport::recv()` 返回 EOF error（`"unexpected EOF while reading headers"`），前端需自行检测并重新 `lsp_start_server`。生产级 LSP client 通常有 crash detection + auto-restart + re-sync open documents，这是设计缺口。LSP over WebSocket（远程场景）也不支持——`LspTransport` 硬编码 `ChildStdin`/`ChildStdout`，`ServerConfig` 只有 `command`+`args`，无 transport 选项。

### 文档同步节流

`document_sync.rs` 的 `compute_incremental_changes` 用 range 计算增量 `contentChanges`（而非全量重发）。`ChangeThrottle`（`document_sync.rs:109`）`record()` 判断 `min_interval`，未到间隔 buffer，`flush()` 定时器触发时发送，避免快速击键淹没 server。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Client-Server | `client.rs` `LspClient` | 管理 server 进程生命周期，JSON-RPC 通信 |
| Capability Negotiation | `capabilities.rs` `ServerCaps` | 每个 feature 前查能力，未声明不发 |
| Observer | `client.rs:32` `NotificationHandler` + `lsp.rs:126` `app.emit` | server→handler→Tauri event→前端，三级传递 |
| Adapter | `conversion.rs` | `sidex_text::Position` ↔ `lsp_types::Position` 零成本转换 |
| Engine | `inlay_hints.rs`/`completion_engine.rs`/... | `LspClient` 原始方法 + engine 提供 UI 友好高层 API |
| Throttle | `document_sync.rs:109` `ChangeThrottle` | 防快速击键淹没 server |
| Registry | `registry.rs` `ServerRegistry` | language ID → config，内置 7 种 + `register()` 覆盖 |

## 模块间交互

`sidex-lsp` 只依赖 `sidex-text`（Position/Range 类型转换）+ `tokio`/`serde_json`/`lsp-types`——**不依赖** sidex-workspace/syntax/terminal。被 `src-tauri/lib.rs:383` `.manage(Arc::new(LspState::new()))` 注册，6 命令在 `lib.rs:814` 注册。前端 `sidexLspService.ts` 经 `invoke()` 调命令、`tauriListen` 收通知，`registerSingleton` 注册为 VSCode DI 服务。LSP 与 tree-sitter 独立模块无直接依赖——tree-sitter 在 `sidex-syntax` 做高亮/折叠，LSP 做语义智能（补全/定义/诊断），两者不共享解析树，间接联系是都把 `sidex-text` 当基础（LSP 用 Position/Range，syntax 用 Rope + `to_input_edit`）。hover engine 注释提到 syntax-highlighted code blocks，但那是前端 markdown renderer 的事。

## 扩展方式

**新增一种语言服务器配置（如 Zig/ZLS）**：改 `registry.rs::ServerRegistry::new()` 的 `configs.insert("zig", ServerConfig::new("zls", vec![]))`，或运行时动态注册（需把 `ServerRegistry` 改 `Mutex` 支持 `&mut`，当前 `LspState` 用 `Arc` 无法 `&mut`，运行时 register 需加锁）。

**修改诊断推送策略（Rust 侧直接用 DiagnosticManager）**：`LspState` 加 `diagnostics: Mutex<DiagnosticManager>`，`lsp_start_server` 的 notification handler 分流 `publishDiagnostics` → 直接存 DiagnosticManager + `app.emit("lsp-diagnostics-updated", uri)`，其余走 `lsp-notification`。好处是诊断查询（F8 导航）在 Rust 侧完成不必过前端。

**新增 LSP 特性（如 document highlight）**：`client.rs` 加原始方法 `document_highlight` → `capabilities.rs` 加 `supports_document_highlight` → 新建 `document_highlight.rs` engine 模块定义 `DocumentHighlightInfo`（用 `sidex_text::Range`）→ `lib.rs` 加 `pub mod` + re-export → 前端 `sendRequest(serverId, "textDocument/documentHighlight", params)`。

> 待核实项：`initialization_options` 在 `ServerConfig` 有定义但 `initialize()` 设为 None 未传入；`DiagnosticManager` 定义但未使用的消费方；串行 Mutex 在高并发是否成瓶颈。
