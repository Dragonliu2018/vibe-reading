---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "文件系统与工作区"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "notify", "search", "inverted index"]
description: "SideX 文件 I/O、notify 文件监听、dashmap+rayon 并行搜索索引与全文搜索"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

这一层替代 VSCode 里 Node.js 的 `fs`、`@parcel/watcher` 和 ripgrep 搜索。职责是文件读写/目录操作、基于 `notify` crate 的文件监听、基于 `dashmap` + `rayon` + `regex` 的并行全文搜索与倒排索引、以及工作区元数据（最近文件/工作区、工作区状态）。它是最贴近 OS 文件系统的一层，被编辑器、资源管理器、搜索面板共同消费。

## 模块架构

```
crates/sidex-workspace/         领域 crate（~8995 行）
  ├─ index.rs      InvertedIndex（trigram 倒排）
  ├─ search.rs     SearchEngine / SearchQuery / SearchOptions（已 crate 化）
  ├─ file_watcher_events.rs   EventThrottler（own_writes echo 过滤）
  └─ ...
src-tauri/src/commands/
  ├─ fs.rs         read_file/write_file/read_dir/stat/mkdir/remove/rename/exists
  ├─ watch.rs      WatchStore → notify watcher → emit("watch-batch")
  ├─ index.rs      IndexStore（Tauri State 版 InvertedIndex，~807 行）
  ├─ search.rs     search_files/search_text/search_workspace（委托 crate SearchEngine）
  ├─ path.rs       parse_path/join_paths/relative_path/glob_match/ext_category
  └─ db_state.rs   SidexDbState → recent_files / workspace_state
```

一个值得注意的架构现状：`search.rs` 已完全复用 crate（`use sidex_workspace::search::{SearchEngine, ...}`），但 `index.rs` 和 `watch.rs` 的 crate 化尚未完成——`commands/index.rs` 里有一份独立 `InvertedIndex` 定义，与 `crates/sidex-workspace/src/index.rs` 几乎逐字段相同（crate 版注释明说 "Ported from src-tauri/src/commands/index.rs, stripped of Tauri state wrappers"），移植后 commands 层仍保留自己的定义，存在同步风险。`EventThrottler`（`record_own_write` 防编辑器自身写入触发 echo 事件）也已在 crate 提供但未被 `commands/watch.rs` 集成。

## 调用链路

**文件监听**（持续事件流）：

```
前端 invoke("watch_start", {path, patterns})
  → WatchStore (Mutex<HashMap<u32, WatchSession>>) in watch.rs:118
  → notify::recommended_watcher() + FseventWatcher (macos_fsevent feature)
  → 回调攒批 → app.emit("watch-batch", {session_id, events})
前端 _listen("watch-batch") → 资源管理器/编辑器刷新
```

**全文搜索**（请求-响应，并行）：

```
前端 invoke("search_workspace", {root, query, options})
  → commands/search.rs → crate SearchEngine
  → rayon 并行遍历（walkdir + ignore 过滤 .gitignore）
  → dashmap 并发收集命中
  → 返回 Vec<SearchMatch>
```

**搜索索引**（建索引加速）：`IndexStore::new(true)` 构建 trigram 倒排索引，`index_build` 把工作区文件拆 trigram 存入 `InvertedIndex`，`search_text` 先用索引过滤候选文件再用 regex 精确匹配。`search_files` 是文件名 glob 匹配（`globset`）。

## 核心实现

### InvertedIndex 倒排索引

`IndexStore`（`commands/index.rs:672`）内含 `InvertedIndex`，用 trigram（3 字符组）做倒排——把每个文件内容拆成 trigram 集合，建立 trigram→文件列表 的映射。搜索时把查询词拆 trigram，对每个 trigram 取候选文件集求交集，大幅缩小 regex 精确匹配的范围。这是 ripgrep 之外的 Rust 原生搜索路径，用 `dashmap` 并发写、`rayon` 并行扫。`IndexStore::new(true)` 的 `true` 参数控制是否启用索引（待核实具体含义）。

### EventThrottler own_writes

`crates/sidex-workspace/src/file_watcher_events.rs:151` 的 `record_own_write(path)` 是编辑器避免 echo 事件的关键：编辑器调 `write_file` 前先 `record_own_write(path)`，后续 2 秒内该路径的 FS 事件被 `EventThrottler::ingest` 过滤（`own_writes.contains(&event.path)`）。这对应 VSCode `FileService` 的 FileWatcher 句柄标记机制。但当前 `commands/watch.rs` 没有集成 `EventThrottler`——前端收到 `watch-batch` 后自行处理 echo 过滤，crate 层工具尚未被命令层消费。

### 最近文件/工作区持久化

`db_state.rs` 的 `db_get_recent_files` 走 **sidex_state.db**（不是 sidex_storage.db），调 `sidex_db::recent_files(&db, limit)` 执行 `SELECT path, last_opened FROM recent_files ORDER BY last_opened DESC LIMIT ?`。`add_recent_file` 用 `ON CONFLICT(path) DO UPDATE SET last_opened = datetime('now')` 做 upsert。工作区状态（`db_save_workspace_state` / `db_get_workspace_state`）走 scoped KV（`state_kv(scope, key, value)`）。两个库的分工见[存储与配置](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/11-storage-settings)。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Observer | `watch.rs` notify 回调 → `app.emit("watch-batch")` | 文件变更持续推送前端 |
| 并行计算 | `search.rs` rayon + dashmap | 全文搜索 CPU 密集，并行扫描 |
| 倒排索引 | `index.rs` trigram + InvertedIndex | 缩小 regex 精确匹配候选集 |
| 门面 | `search.rs` 委托 crate `SearchEngine` | 命令层只做结构体转换 |

## 模块间交互

`sidex-workspace` 依赖 `sidex-db`（持久化最近文件/工作区状态），被 `src-tauri` 命令层调用。搜索模块已 crate 化（commands 复用 crate），但 index/watch 的 crate 化未完成——commands 层保留独立 `InvertedIndex` 与 crate 版重复。`notify` 的 `macos_fsevent` feature 启用 FSEvents 流式监听（macOS 原生，低延迟）。`globset` 做文件名模式匹配，`ignore` crate 尊重 `.gitignore`。

## 扩展方式

**新增一种搜索过滤规则**：改 `commands/search.rs` 构造 `SearchOptions` 时加排除/包含模式，或改 crate `SearchEngine` 的过滤逻辑。

**新增监听的文件类型排除**：改 `watch.rs` 的 `WatchSession` patterns，或集成 crate 的 `EventThrottler`（当前未接线）做更精细的 echo 过滤。

**新增工作区元数据字段**：在 `sidex_state.db` 加表（改 `crates/sidex-db/src/db.rs` 的 migration，升 `CURRENT_SCHEMA_VERSION`），在 `db_state.rs` 加对应 Tauri 命令。
