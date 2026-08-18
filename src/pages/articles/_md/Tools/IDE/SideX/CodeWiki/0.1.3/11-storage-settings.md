---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "存储与配置"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "rusqlite", "SQLite", "settings", "JSONC", "auto-update"]
description: "SideX 存储与配置——三个 SQLite 库分工、分层设置、自研更新器、keyring 密钥"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

这一层是 SideX 的持久化与配置基础设施，对应 VSCode 的 `@vscode/sqlite3`、configuration 服务、`safeStorage` 和 `autoUpdater`。它维护**三个独立的 SQLite 数据库**分工明确、一套三层（default/user/workspace）override 链设置、一个自研（非 tauri-plugin-updater）的 Ed25519 签名更新器、以及 keyring 优先的密钥存储。`sidex-text` 是共享类型基础，`sidex-db` 是共享存储基础——高扇入基础设施。

## 模块架构

```
命令层
  commands/storage.rs     StorageDb → sidex_storage.db（扁平 KV，189 行）
  commands/db_state.rs    SidexDbState → sidex_db::Database（结构化状态，91 行）
  commands/settings.rs    SettingsStore（分层设置缓存，141 行）
  commands/updater.rs     UpdateManagerState → sidex_update（7 命令，186 行）
  commands/secrets.rs     → sidex_auth::SecretStorage（65 行）
  commands/profiles.rs    → sidex_profiles（81 行）
        ↓
crates/sidex-db/         sidex_state.db（4 版 migration，17+ 表，2056 行）
crates/sidex-settings/   Settings + JSONC + defaults + schema + migration + profiles + sync（3717 行）
crates/sidex-update/     UpdateManager + state + manifest + download + signature + install（1368 行）
crates/sidex-auth/       SecretStorage（keyring + fallback，155 行）
crates/sidex-profiles/   ProfileStorage（JSON 文件，113 行）
```

## 调用链路

三个 SQLite 库分工：

```
sidex_storage.db  ← StorageDb（commands/storage.rs:31）
   单表 kv_store(key TEXT PK, value TEXT)   前端直接读写
   窗口几何（sidex.windowState）/ workbench 布局 / 任意前端 KV
   key≤256B, value≤1MB（CWE-400 防护），storage_list 用 LIKE ? ESCAPE

sidex_state.db  ← SidexDbState → sidex_db::Database（crates/sidex-db/src/db.rs:12）
   17+ 类型化表 + 4 版 migration + WAL + foreign_keys
   recent_files / workspace_state / global_state / extension_state / search_history / clipboard / breakpoints / bookmarks / snippets / tasks_history
   PRAGMA journal_mode=WAL; CURRENT_SCHEMA_VERSION=4

secrets-index.db  ← SecretStorage（crates/sidex-auth/src/storage.rs:38）
   单表 secret_index(key PK, fallback BLOB, updated_at)   keyring 索引 + fallback
```

设置分层合并（`settings_get` `settings.rs:42`）：无 scope → `Settings::get_raw` 按 workspace→user→default 查找；`scope="user"`/`"workspace"` 返回该层完整 JSON；`scope="merged"` 以 `builtin_defaults()` key 集为基准逐 key 合并。`settings_update`：`scope="user"`→`Settings::set`，`scope="workspace"`→`set_workspace`，不允许写 default。

自动更新状态流转（`manager.rs` 驱动）：

```
update_check → CheckingForUpdates → fetch_manifest(endpoints 按序) → semver 比较 → AvailableForDownload
update_download → Downloading → download() 流式写盘 + SHA-256 实时校验 → verify_signature(Ed25519) → Ready
update_apply → Updating → install::install(平台特定) → Ready
update_quit_and_install → install::relaunch(current_exe) → app.exit(0)
```

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `storage_get/set` in `storage.rs:110` | 扁平 KV | key≤256B value≤1MB 防护 |
| `settings_get` in `settings.rs:42` | 分层合并 | workspace→user→default override 链 |
| `settings_parse_jsonc` in `settings.rs:126` | 解析 JSONC | strip 注释 + 去 trailing comma |
| `settings_modify_jsonc` in `settings.rs:134` | 改 JSONC 保注释 | 文本拼接定位 key/value 字节范围 |
| `db_get_recent_files` in `db_state.rs:31` | 最近文件 | `ORDER BY last_opened DESC`，ON CONFLICT upsert |
| `secret_set` in `secrets.rs:44` | 存密钥 | keyring 优先，失败存 SQLite fallback |
| `update_check/download/apply` | 更新状态机 | 11 态与 VSCode TS State 对齐 |

## 核心实现

### 为什么两个 SQLite 库

本质是**访问模式和生命周期不同**：`sidex_storage.db` 是"dumb pipe"——前端 TS `TauriStorageDatabase` 实现了 VSCode `IStorageService` 接口同步写 workbench 布局状态（`workbench.sideBar.size`、`editorpart.state`），key 完全由 TS 管理，Rust 不理解结构，无 migration 无 schema 版本。`sidex_state.db` 是"smart store"——Rust 管 schema/migration/类型安全，17+ 类型化表，`sidex_db::Database` 封装提供 `prepare_cached`/`backup_to`/`vacuum`。`window.rs:97` 注释明确：OS 窗口几何在 storage.db 的 kv_store，workbench 布局由 VSCode storage 经 `TauriStorageDatabase` 写 storage.db 的 kv_store（不同代码路径）。

### JSONC 解析与保留注释

VSCode `settings.json` 是 JSONC（`//` 行注释、`/* */` 块注释、trailing comma），标准 `serde_json` 不支持。`parse_jsonc`（`jsonc.rs:36`）：`strip_comments` 逐字节扫描识别字符串内/外注释，替换为空格保持行号；`remove_trailing_commas` 删 `]`/`}` 前的逗号；交 serde_json。`modify_jsonc`（`jsonc.rs:98`）更复杂——不能 strip+re-serialize（丢注释），而是 `parse_jsonc` 解析定位 → `find_key_in_src`（跳过注释/字符串内假 key）→ `value_span`（处理 string/object/array/scalar）→ 原始文本拼接 `前缀+序列化新值+后缀` 保留周围注释格式，key 不存在才 fallback `format_jsonc` 全量格式化。

### 自研 sidex-update（非 tauri-plugin-updater）

`signature.rs:1` 文档说明保持 byte-for-byte 兼容，"every release we've ever shipped continues to verify after swapping the plugin for this crate"。原因：① **VSCode 状态机对齐**——`state.rs` 的 `State` 11 变体 + `#[serde(tag="type", rename_all="kebab-case")]` 完全匹配 VSCode TS `State`，前端原样转发 Rust 事件到现有 `onStateChange` emitter；② **配置兼容**——`read_config`（`updater.rs:68`）从 `tauri.conf.json` 的 `plugins.updater` 读 endpoints/pubkey，现有发布基建不改；③ **签名格式兼容**——Minisign/Ed25519，与 tauri-plugin-updater 同格式，历史签名都验证；④ **平台原生安装**——macOS 用 `ditto`（保留 code-signing + xattr）+ `xattr -rd com.apple.quarantine`（清 Gatekeeper 隔离），每平台独立 `install/` 子模块；⑤ 多端点 fallback。

### 密钥存储（keyring + fallback）

`SecretStorage`（`storage.rs:38`）分层降级：`set` 先试 `keyring::Entry::new("sidex", key).set_password`，成功则 SQLite `fallback` 列存 NULL，失败存 value 字节。`get` 先查 keyring，无则查 fallback 列。`keys()` 只能从 SQLite 查（keyring API 不支持按 service 列举）。`keyring` crate features `["apple-native","windows-native","sync-secret-service"]` 每平台最佳后端（macOS Keychain/Windows Credential Manager/Linux Secret Service）。⚠️ 待核实：fallback 列存的是 `value.as_bytes().to_vec()` 明文，注释说 "encrypted-on-disk storage" 但实际未加密——与文档不符，需核实是否更高层加密。

### rusqlite bundled

workspace `Cargo.toml`：`rusqlite = { version = "0.31", features = ["bundled", "backup"] }`。`bundled` 经 `libsqlite3-sys` 从源码编译 SQLite 静态链接，不依赖系统 SQLite，跨平台版本一致，代价二进制 +1-2MB。`backup` 启用 `Database::backup_to` 在线备份。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 分层配置（override 链） | `settings.rs:86` `get_raw` | workspace.or_else(user).or_else(default) |
| 键值存储（多模式） | `StorageKv` 扁平 / `StateStore` scoped / 专用表 | 访问模式不同 |
| 安全存储（keyring + fallback） | `sidex-auth/src/storage.rs` | 分层降级，解决 keyring 无 list + 无环境 |
| 策略（更新源） | `manager.rs:22` `endpoints: Vec<String>` | 多端点按序尝试 |
| Observer（更新广播） | `UpdateObserver` trait + `EventEmitter` | 状态经 `app.emit("sidex://update/state-change")` 转发 |

## 模块间交互

`sidex-db` 被 `commands/db_state.rs` 依赖，提供 4 个 Tauri command，`Database` 是所有状态表单点入口。`sidex-settings` 被 `commands/settings.rs` 依赖，`SettingsStore` 包 `Settings` 在 `RwLock`。WASM 扩展 runtime 经 `wasm_on_configuration_changed` 间接消费设置变更。`sidex-update` 被 `commands/updater.rs` 依赖（7 命令）。`sidex-auth` 被 `commands/secrets.rs` 依赖。`sidex-profiles` 被 `commands/profiles.rs` 依赖。setup 初始化顺序见概览「启动流程」——updater/profiles/secrets 失败只 warn 不阻断。

## 扩展方式

**新增一种设置作用域（如 "machine-overrides"）**：`Settings` 加 `machine_layer: Value` → `get_raw` override 链插入新层 → `settings_get`/`settings_update` scope match 加 `"machine"` → `Settings::set_machine` + `fire_handlers` → 如需持久化在 setup 加 `load_machine`。

**修改 sidex_state.db schema（新增表）**：`db.rs` 升 `CURRENT_SCHEMA_VERSION` 4→5 → 加 `migration_v5` 方法 `execute_batch` 建表 → `migrate` 加 `if current<5 { migration_v5 }` → `lib.rs` 加操作函数 → `db_state.rs` 加 Tauri command → `lib.rs` 注册。

**更换更新源**：改 `tauri.conf.json` 的 `plugins.updater.endpoints`（运行时读不需改代码）；新源 manifest 格式不同则改 `manifest.rs` 的 `ReleaseManifest` + `fetch_one` 解析；新签名方案改 `signature.rs::verify`；新平台打包在 `install/` 加子模块。

> 对应测试：`crates/sidex-db/src/` 各表 `#[cfg(test)]`、`crates/sidex-settings/src/jsonc.rs` 含 JSONC 解析测试、`crates/sidex-update/src/` 含签名验证测试。
