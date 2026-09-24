---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "数据库与云同步"
date: "2026-09-23T21:55:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "SQLite", "WebDAV", "S3", "数据同步", "备份"]
description: "CC Switch 持久化与云同步解读——SQLite 16 表 SSOT + PRAGMA user_version 迁移、SCHEMA_VERSION 与 DB_COMPAT_VERSION 双轨版本、整库快照同步协议（无设备 ID 无冲突解决）、authorizer 拦截的不可信 SQL 导入管线全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`src-tauri/src/database/`（13.3k 行）+ `services/sync_protocol.rs`（24.7k）+ webdav*/s3* 传输层。README 明确的双层存储设计：**SQLite 为可同步数据的 SSOT**（`~/.cc-switch/cc-switch.db`），**JSON（settings.json）为设备级设置**（同步凭据、备份策略——刻意不随库同步，避免同步状态自我循环）。

## 模块架构

```
database/mod.rs        Database 结构体 + init（Mutex<Connection>，rusqlite 非 Sync）
database/schema.rs     DDL（幂等建表）+ user_version 迁移
database/backup.rs    SQL 导入导出 + 二进制快照备份
database/migration.rs 旧 config.json → SQLite 一次性数据迁移（非 schema 迁移）
database/dao/         13 个 DAO（providers/mcp/prompts/skills/proxy/...）
services/sync_protocol.rs  传输无关的同步协议（WebDAV/S3 共用）
services/webdav*.rs / s3*.rs 传输层 + 自动同步 worker
```

### Schema 全貌（16 表）

| 表 | 用途 |
|---|---|
| `providers` | 供应商配置，**PK (id, app_type)**——同 id 可在多个 app 下存在 |
| `provider_endpoints` / `provider_health` | 端点候选（FK 级联）/ 健康记录 |
| `mcp_servers` / `prompts` / `skills` / `skill_repos` | 三大统一面板 + skills 仓库源 |
| `settings` | 通用 KV（一次性 flag、profile 指针） |
| `proxy_config` | 代理配置，**三行结构**（每 app_type 一行，20+ 列） |
| `proxy_request_logs` | 请求明细（**TEXT 存金额避免浮点误差**），5 索引 |
| `model_pricing` / `usage_daily_rollups` / `session_log_sync` / `session_usage_dedup` | 用量统计族 |
| `proxy_live_backup` / `stream_check_logs` / `profiles` | 接管备份 / 测速日志（7 天）/ 项目 profile 快照 |

## 核心实现

### 迁移：PRAGMA user_version 手写 match 循环

**不是版本号数组**——`apply_schema_migrations_on_conn`（schema.rs:445-578）的 `while version < SCHEMA_VERSION` match 每个版本号调用 `migrate_vN_to_vN+1`，整个迁移包在 SAVEPOINT 中失败回滚。`SCHEMA_VERSION = 19`（mod.rs:56）每次改表递增。版本**过新**（应用过旧）返回中文错误提示升级——前端 `DatabaseUpgrade.tsx` 渲染恢复界面（先 `check_app_update_available` 区分可升级/不兼容）。**迁移前自动备份**：`Database::init` 在 `0 < version < SCHEMA_VERSION` 时先 `backup_database_file()`。防御性细节：v17→v18 迁移注释（schema.rs:1605）解释了为什么"给已执行过的迁移追加内容"是禁忌——必须独立成新版本。

### 备份：二进制快照 + 原子发布

三个触发点：启动迁移前 / 周期性（默认 24h，可配关闭）/ **每次危险操作前**（SQL 导入、云同步 download、备份恢复都先留回滚点）。rusqlite Backup API 一致性拷贝 → `PRAGMA quick_check` 校验 → 先写 `.tmp` 再 `persist_noclobber` **原子发布**——备份清理逻辑只见完整镜像。保留默认 10 份；**刚创建的备份和恢复源文件加入 protected_paths 永不当牺牲品**（retention 不够宁可暂时超额）。

### 云同步协议：整库快照，无设备 ID，无冲突解决

核心设计判断值得记住：**同步单元是"全库快照"，冲突模型是显式的 manual download（整库覆盖）+ 变更时自动 upload**。测试甚至断言 manifest **不含** deviceId 字段——`device_name`（hostname）只用于 UI 展示"这是哪台机器传的"。

- **快照 = `db.sql` + `skills.zip`**：SQL 导出跳过 `SYNC_SKIP_TABLES` 7 张设备本地表；manifest 含每 artifact 的 SHA-256 + size，`snapshot_id` = 对所有 name:sha256 拼接再取 SHA-256
- **双层版本门禁**（`validate_manifest_compat`）：`PROTOCOL_VERSION = 2`（manifest 格式精确相等）+ `DB_COMPAT_VERSION = 6`（快照 SQL 的"代"号，与 SCHEMA_VERSION=19 **独立手工维护**）。远端布局按代分桶 `{root}/v2/db-v6/{profile}/`——旧代快照原地保留，新旧客户端互不污染。**bump 判据**：本地 schema 迁移可高频可逆；只有破坏"快照可移植性"的变更才 bump 兼容代
- **apply_snapshot**：先备份当前 skills → 恢复 skills.zip → 再 `import_sql_string_for_sync` 替换数据库；DB 失败回滚 skills，双失败才报复合错误

### auto_sync：update_hook 白名单 + debounce

`Database::init` 注册 rusqlite `update_hook`（mod.rs:84）→ `should_trigger_auto_sync_for_table` 白名单 9 张配置表（**日志/健康/定价表不触发**——避免用量统计风暴把快照推上云）→ 容量 1 的 mpsc channel + **debounce 1s、最多等 10s** 的合并循环——连续编辑只触发一次上传。**方向性**：自动同步只 upload；download 永远是用户手动按钮（这就是它的冲突答案——设备间分歧由用户选择拉哪份整库快照覆盖本地，覆盖前自动留本地备份）。

### 导入管线：不可信 SQL 的安全处理

WebDAV/S3 下载的 SQL 是不可信输入。`import_sql_string_inner`（backup.rs:173-249）的处理：SQL 跑在 `NamedTempFile` 暂存库上 → 挂 rusqlite **authorizer** 拒绝一切能"离开临时文件"的动作（ATTACH/VACUUM INTO/vtable 模块/未识别动作码**未知即拒**/非白名单 PRAGMA）→ `validate_imported_schema` + 补迁移 → 持主库锁期间 safety backup + 回填本地表 → Backup API 原地替换主库（保证替换期间读一致性）。**authorizer 按解析结果拦截而非关键字扫描**（注释明确：字符串扫描会被 `/*x*/ATTACH` 绕过）。

### WebDAV vs S3

| | WebDAV | S3 |
|---|---|---|
| 传输 | reqwest + Basic Auth | **自实现 AWS SigV4 签名**（支持 MinIO 自定义 endpoint） |
| 远端 | Current + **Legacy 回退**（先查新布局再查旧） | 仅 Current 布局 |
| 一致性 | artifact 先传、manifest 最后（尽力而为） | 同策略 |

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| SSOT 分界 | SQLite（可同步）vs settings.json（设备级） | 避免同步状态自我循环 |
| 双轨版本 | SCHEMA_VERSION vs DB_COMPAT_VERSION | 本地迁移高频 vs 云快照按代隔离 |
| 暂存 + authorizer | NamedTempFile + rusqlite authorizer | 不可信 SQL 按解析结果拦截 |
| 全局互斥 | `sync_mutex()`（OnceLock）统一 WebDAV/S3/导入/恢复 | 曾因两通道各持一把锁并发还原库 |
| observer | update_hook + 白名单 + debounce | DB 是变更通知源，配置变更才上云 |

## 模块间交互

- **向上**：所有服务层经 `lock_conn!` 宏取锁用 DAO（见[Tauri 命令与服务层](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/02-services)）
- **与 Skills**：skills.zip 是文件系统 SSOT 的确定性打包，恢复时与 DB 一起原子应用（见[MCP/Prompts/Skills](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/06-mcp-prompt-skill)）
- **与用量**：`SYNC_PRESERVE_TABLES` 6 张设备本地表在 download 时从活库回填保留（见[用量统计](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/07-usage)）
- `migration.rs` 是**旧 JSON → SQLite 一次性数据导入**（带 dry-run 验证）——与 schema 迁移是两回事；Skills 安装状态刻意不迁移（避免"库显示已安装但文件缺失"）

## 扩展方式

**新增一张表**（以 v16→v17 的 `session_usage_dedup` 为实证）：

1. `create_tables_on_conn` 追加幂等 DDL + 索引
2. `SCHEMA_VERSION` 19→20 + match 加迁移分支（新表逻辑可以就是 `CREATE TABLE IF NOT EXISTS`，但版本必须推进——存量库靠迁移分支，全新库靠 DDL）
3. **决策同步语义**：设备本地 → 加入 `SYNC_SKIP_TABLES` + `SYNC_PRESERVE_TABLES`；可同步 → 都不加；破坏旧版导入兼容 → bump `DB_COMPAT_VERSION`（旧代远端目录自动隔离）
4. 新建 `dao/<domain>.rs`（模式：`lock_conn!` + `params![]`）+ `dao/mod.rs` 注册
5. 测试：`database/tests.rs`（1330 行）覆盖"旧版本库升级"路径
