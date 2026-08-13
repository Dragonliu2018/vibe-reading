---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "LSP Server"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "LSP", "编辑器集成", "Snapshot"]
description: "ruff 的 LSP server——基于 lsp_server 自建同步线程模型，Snapshot COW，与 CLI 共享 lint/format 核心。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_server/` 是 ruff 的 Language Server Protocol 实现，提供编辑器集成（诊断、format on save、code action/fix）。这个模块独立存在的核心价值：**实时编辑场景与 CLI 共享同一套 lint/format 核心 API**，差异仅在 I/O 层（LSP 用内存文档、CLI 读文件）和结果序列化（LSP 转 `lsp_types::Diagnostic`、CLI 打印 stdout）。它让 ruff 在编辑器中获得与命令行一致的行为。

> **重要**：ruff_server **并非使用 tower-lsp**，而是直接基于 `lsp_server`（rust-analyzer 维护的低层 crate）+ `lsp_types` 自建框架。整个架构是手写同步线程模型 + trait dispatch，没有 async runtime。

## 模块架构

server 由几个核心组件构成：`Session`（全局可变状态，持有 `Index` 文档注册表）、`Scheduler`（双线程池调度器：fmt_pool 1 线程 + background_pool N 线程）、`Server`（LSP 连接 + 主循环）、`DocumentSnapshot`（后台任务的只读视图）。架构的关键是 **Snapshot COW 模式**——后台任务不能持有 `&Session`（主线程还在处理其他消息），主线程通过 `take_snapshot()` 克隆只读视图，后台线程在无锁环境工作；主线程需修改文档时 `Arc::make_mut` 做 copy-on-write，后台快照不受影响。

## 调用链路

```
LSP 启动:
  lib.rs::run() → ConnectionInitializer::stdio() → Server::new()
    ├─ connection.initialize_start() → find_best_position_encoding() (UTF-8>UTF-32>UTF-16)
    ├─ server_capabilities() → connection.initialize_finish()
    └─ Session::new() → Server::run() [server.rs:129]
         └─ spawn_main_loop() → main_loop() [main_loop.rs:19]
              crossbeam::select! { recv(connection.receiver) | recv(main_loop_receiver) }

文档打开/didChange → 诊断发布:
  Client → textDocument/didOpen
    → DidOpen handler (SyncNotificationHandler, 主线程, &mut Session)
       ├─ session.open_text_document(uri, doc)
       └─ publish_diagnostics_for_document()
            └─ generate_diagnostics() → crate::lint::check() [lint.rs:72]
                 → ruff_linter::linter::check_path()  (与 CLI 共享!)
            → client.send_notification(PublishDiagnostics)

  Client → textDocument/didChange (Incremental)
    → DidChange handler
       ├─ session.update_text_document(key, changes, ver)
       │    → TextDocument::apply_changes() (快路径: WholeDocument 直接替换; 慢路径: Partial range 替换)
       │    → 重建 LineIndex 缓存
       └─ publish_diagnostics_for_document() (仅客户端不支持 pull diagnostics 时)

Code Action / Fix:
  Client → textDocument/codeAction (BackgroundRequestHandler, 后台线程)
    → take_snapshot(uri) → DocumentSnapshot
    → CodeActions::run_with_snapshot() [code_action.rs:27]
       ├─ fixes_for_diagnostics()  从 diagnostic.data 反序列化修复
       ├─ quick_fix() / noqa_comments() / fix_all() / organize_imports()
       └─ 若 code_action_deferred_edit_resolution: 不携带 edit, 只 data
  Client → codeAction/resolve (延迟解析)
    → resolve_edit_for_fix_all() → fix::fix_all() → ruff_linter::linter::lint_fix()
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Server::run()` in `server.rs:129` | LSP 主循环 | spawn_main_loop + panic hook |
| `Session::take_snapshot()` in `session.rs:97` | 克隆只读视图给后台 | Arc 共享，COW 修改 |
| `TextDocument::apply_changes()` in `text_document.rs:84` | 增量同步 | 快路径 WholeDocument / 慢路径 Partial |
| `generate_diagnostics()` in `diagnostics.rs:8` | lint 文档 | 调 `check_path()`，与 CLI 共享 |
| `fix_all()` in `fix.rs:26` | 全量修复 code action | 调 `lint_fix()` 收敛循环，diff 返回 |

## 核心实现

### 自建 LSP 框架（非 tower-lsp）

```rust title="server/api/traits.rs"
// 四组 trait，按执行位置和访问权限分类：
trait SyncRequestHandler         { fn run(&self, session: &mut Session) }      // 主线程
trait BackgroundRequestHandler   { type Snapshot; fn run_with_snapshot(...) }  // 后台线程
trait BackgroundDocumentRequestHandler { /* DocumentSnapshot */ }
trait SyncNotificationHandler    { fn run(&self, session: &mut Session) }      // 主线程
```

`api.rs:47` 的 `request()` 是 match 分发器，按 LSP method 名路由到具体 handler 返回 `Task`。新增 handler = 实现 trait + match 加一行。**为什么不用 tower-lsp？** tower-lsp 基于 async（tokio），ruff_server 选**同步线程模型**（crossbeam channel + 线程池）——同步模型对 lint/format 这类 CPU 密集任务更直接，无 async overhead，无需 `spawn_blocking`。`lsp_server` 提供更底层控制，可精确控制线程优先级。Panic 隔离：`background_request_task`（`api.rs:195`）用 `catch_unwind` 包裹后台任务，单请求 panic 不崩溃 server。

### Snapshot 模式（Copy-on-Write）

```rust title="session.rs"
pub(crate) struct Session {
    index: index::Index,           // FxHashMap<Uri, DocumentController>
    // ...
}
// DocumentController 用 Arc<TextDocument> / Arc<NotebookDocument> 包裹
// 主线程修改文档时 Arc::make_mut 做 COW 克隆，后台快照不受影响

pub(crate) struct DocumentSnapshot {
    resolved_client_capabilities: Arc<ResolvedClientCapabilities>,
    client_settings: Arc<settings::ClientSettings>,
    document_ref: index::DocumentQuery,   // 只读查询
    position_encoding: PositionEncoding,
}
```

后台任务拿到的是 `DocumentSnapshot` 而非 `&Session`——避免数据竞争的关键。主线程 `take_snapshot()` 克隆只读视图，内部文档通过 `Arc<TextDocument>` 共享。主线程修改文档时 `Arc::make_mut`（`index.rs:538`）做 COW 克隆。

### 增量同步 + LineIndex 缓存

```rust title="edit/text_document.rs"
pub struct TextDocument {
    contents: String,
    index: LineIndex,       // 预计算行索引，避免重复解析
    version: DocumentVersion,
    // ...
}
// apply_changes():
//   快路径: 单个 WholeDocument change → 直接 clone_from
//   慢路径: 逐个 Partial change → range.to_text_range() 转 byte range → replace_range
//   每次 change 后重建 LineIndex
```

`LineIndex` 在每次 `apply_changes` 时重新计算并缓存（`text_document.rs:124`），后续 lint/format 的 range 转换直接用缓存，避免反复扫描源码。实现 `TextDocumentSyncKind::Incremental`。

### Scheduler 双线程池

```rust title="server/schedule.rs"
pub(crate) struct Scheduler {
    fmt_pool: thread::Pool,       // 1 线程，高优先级，专用于格式化
    background_pool: thread::Pool, // N 线程（默认 min(cpu, 4)），用于 lint/code action
}
// 通知 (didOpen/didChange) 是 Sync Task: 主线程快速更新 + 发布诊断
// 请求 (codeAction/hover) 是 Background Task: 分发到 background_pool
// 格式化专用 fmt_pool: 避免与 lint 争抢资源，保证格式化延迟可控
// RequestQueue + cancellation_token: 允许取消已过时请求
```

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 自建 LSP（非 tower-lsp） | `lsp_server::Connection` in `server.rs:3` | 同步线程模型，CPU 密集任务无 async overhead |
| Trait 请求/通知分发 | `api.rs:47` match 分发 | 新增 handler = 实现 trait + match 加一行 |
| Snapshot COW | `Session::take_snapshot()` in `session.rs:97` | 后台无锁工作，主线程 COW 修改 |
| 增量同步 | `TextDocument::apply_changes()` in `text_document.rs:84` | LSP Incremental sync |
| 双线程池调度 | `Scheduler` in `schedule.rs:33` | 格式化专用池保证延迟，请求可取消 |

## 模块间交互

**与 ruff 核心的复用路径**——LSP 和 CLI 共享同一套核心 API：

```
ruff_server                          ruff CLI
  lint::check_python()  ──→  ruff_linter::linter::check_path()    (CLI ruff check 也调此)
  fix::fix_all()        ──→  ruff_linter::linter::lint_fix()      (CLI ruff check --fix 也调此)
  format::format_internal() ──→ ruff_python_formatter::format_module_source()  (CLI ruff format 也调此)
  session::index::RuffSettings ──→ ruff_workspace::Settings       (CLI 解析 pyproject 也用此)
```

差异仅在 I/O 层（LSP 内存文档、CLI 读文件）和结果序列化（LSP 转 `lsp_types::Diagnostic`、CLI 打印）。配置消费：`session/index.rs:416` 的 `WorkspaceSettingsIndex::register_workspace()` 扫描 workspace 目录下的 `pyproject.toml`/`ruff.toml`，配置变化时 `did_change_watched_files` 触发 `Index::reload_settings()`。设置层级：`Index::make_document_ref()`（`index.rs:204`）按文件路径在 `BTreeMap<PathBuf, WorkspaceSettings>` 中 `range(..path).rfind()` 找最近 workspace root，实现 per-directory 配置覆盖。

## 重要设计决策

**文档缓存避免重复解析**：`TextDocument` 内部缓存 `LineIndex`，每次 `apply_changes` 后重建。lint/format 操作直接传入缓存 `LineIndex`，避免每次重新扫描源码。

**后台 lint 如何避免阻塞编辑**：通知是 Sync Task（主线程快速更新+发布诊断，但 `lint::check` 同步会短暂阻塞主循环）；请求是 Background Task（分发到 `background_pool`，主线程可继续处理 didChange）；格式化专用 `fmt_pool`（1 线程）避免与 lint 争抢；`RequestQueue` + `cancellation_token` 允许取消已过时请求。

**format-on-save 与 fix 交互**：`fix_all()`（`code_action.rs:81`）生成 `source.fixAll.ruff` code action。`fix.rs:66` 关键注释解释策略——调用 `lint_fix()`（迭代修复直到收敛）而非逐条应用 fix，因为逐条可能重叠或引入新问题，与 `ruff check --fix` 行为不一致。最终用 `Replacement::between()` 做源码 diff，只返回变化 range 减少传输。

**延迟 edit 解析**：若客户端支持 `code_action_deferred_edit_resolution`（`code_action.rs:195`），`fix_all`/`organize_imports` 的 code action 不携带 `edit` 只携带 `data`（URI），客户端在用户实际选中时才发 `codeAction/resolve` 获取 edit——避免列出 code action 时就执行 fix 计算。

## 扩展方式

**新增一个 Code Action**（如 "Fix all unsafe fixes"）：
1. `server.rs:268`——`SupportedCodeAction` enum 加变体（映射到 `"source.fixAll.unsafe.ruff"`）+ `to_kind()`/`all()` 注册
2. `server/api/requests/code_action.rs`——添加生成逻辑
3. `fix.rs`——添加 `fix_all_unsafe()` 调 `lint_fix` 传 `unsafe_fixes`
4. `code_action_resolve.rs`——添加 `resolve_edit_for_fix_all_unsafe()` 供延迟解析
5. `session/settings.rs`——添加客户端配置开关
6. （若需 execute command）`server.rs:322` 的 `SupportedCommand` 注册 + `requests/execute_command.rs` 处理
