---
source:
  type: "源码解读"
  project: "timescaledb"
  url: "https://github.com/timescale/timescaledb"
title: "DDL 拦截器"
date: "2026-08-21T15:27:49+08:00"
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]

alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
tags: ["TimescaleDB", "C", "PostgreSQL", "ProcessUtility", "DDL"]
description: "TimescaleDB ProcessUtility_hook 拦截约 20 种 DDL、双阶段处理与子命令递归的 hypertable 语义适配机制解读"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)

---

## 模块定位

`process_utility.c` 是全库第二大源文件（6554 行），也是 TimescaleDB 侵入 PG 最深的地方。PostgreSQL 本身不理解 hypertable 语义——对 PG 而言 hypertable 就是一张普通表，DDL 只会作用在父表上。这个模块通过 `ProcessUtility_hook` 拦截约 20 种 DDL 命令，把它们适配成"对逻辑表的操作 = 对所有物理 chunk 的操作 + 元数据同步"。没有它，`ALTER TABLE hypertable ADD COLUMN` 根本不会传到 chunk，`DROP TABLE` 会留下孤儿元数据。

## 模块架构

模块内核心是"双阶段分发"：

```
PG ProcessUtility_hook → timescaledb_ddl_command_start (process_utility.c:6350)
  ├─ 预处理（process_ddl_command_start）—— switch(nodeTag) 找 handler
  │    修改 parsetree / 验证约束 / 提前删 chunk
  │    返回 DDL_CONTINUE 或 DDL_DONE
  ├─ 若 DDL_CONTINUE → prev_ProcessUtility（让 PG 执行 DDL）
  └─ 后处理（event trigger 回调）
       ├─ process_ddl_command_end —— 基于 CollectedCommand 同步元数据
       └─ process_ddl_sql_drop —— 清理 chunk/hypertable 元数据
```

关键结构：`ProcessUtilityArgs`（process_utility.h:16）封装 hcache/pstmt/parsetree/context；`DDLResult` 枚举 `DDL_CONTINUE`（交给 PG）/ `DDL_DONE`（TS 完全接管）；`ts_process_utility_handler_t` 是处理器函数指针类型。

## 调用链路

以 CreateStmt（建表→可选转 hypertable）为例：

```
timescaledb_ddl_command_start (process_utility.c:6350)
  └─ process_ddl_command_start → case T_CreateStmt → process_create_stmt (行 5849)
       ├─ 遍历 inhRelations，禁止从 hypertable 继承
       ├─ ts_with_clause_filter 分离 PG 选项与 timescaledb 选项（如 tsdb.hypertable）
       └─ 返回 DDL_CONTINUE（让 PG 先建表）
  └─ prev_ProcessUtility（PG 执行 CREATE TABLE，拿到 relid）
  └─ event trigger → process_ddl_command_end → case T_CreateStmt → process_create_table_end (行 4226)
       └─ 若 create_table_info.hypertable==true：
            ├─ ts_dimension_info_create_open
            └─ ts_hypertable_create_from_info（建元数据）
            └─ ts_cm_functions->columnstore_setup（设压缩选项）
```

以 AlterTableStmt 为例（改表传播到 chunk）：

```
case T_AlterTableStmt → process_altertable_start (行 5137)
  └─ process_altertable_start_table (行 4720)
       ├─ ts_hypertable_cache_get_cache_and_entry 判断是否 hypertable
       ├─ 权限检查 + 压缩/cagg 限制检查
       └─ 遍历 stmt->cmds 子命令 switch(cmd->subtype):
            AT_AddColumn / AT_DropColumn / AT_AlterColumnType / AT_SetRelOptions ...
       └─ 返回 DDL_CONTINUE
  └─ prev_ProcessUtility（PG 执行 ALTER，记 CollectedCommand）
  └─ process_ddl_command_end → process_altertable_end (行 5428)
       └─ process_altertable_end_subcmd —— 递归处理每个子命令
            └─ ts_cm_functions->process_altertable_cmd(ht, cmd)（委托 TSL）
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `timescaledb_ddl_command_start` (process_utility.c:6350) | 主入口 | 检查扩展加载/升级状态，未加载则透传 |
| `process_ddl_command_start` (行 6036) | 预处理分发 | switch on nodeTag，约 20 种命令 |
| `process_altertable_end_subcmd` | 子命令后处理 | 递归，每个子操作拿独立 ObjectAddress |
| `process_ddl_sql_drop` (行 6320) | 删表清理元数据 | sql_drop event trigger，删 chunk/hypertable 记录 |

## 核心实现

### 双阶段处理：preprocess vs postprocess

这是模块最关键的设计。DDL 处理分两阶段：

- **预处理（PG 执行前）**：`process_ddl_command_start`。可修改 parsetree（如剥离 timescaledb 选项避免 PG 报未知 reloption）、验证约束、提前删 chunk（避免 CASCADE）。
- **后处理（PG 执行后）**：event trigger `ts_timescaledb_process_ddl_event` 回调。此时 PG 已完成实际操作，TS 基于 `CollectedCommand`（含实际结果如新约束 OID）同步元数据、传播到 chunk。

何时用何阶段取决于是否依赖 PG 执行结果：CREATE TABLE 必须等 PG 建完拿 relid 才能建 hypertable 元数据（后处理）；ALTER 需要新约束 OID 在 chunk 上建对应索引（后处理）；DROP 先删 chunk 使 CASCADE 正确（预处理）；COPY 完全接管（`timescaledb_DoCopy` 返回 `DDL_DONE`）。

### 子命令递归

`ALTER TABLE foo ADD col1, ADD CONSTRAINT, DROP col2` 是一个 `AlterTableStmt` 含多个 `AlterTableCmd`。PG 执行后 `CollectedCommand` 区分 `SCT_Simple`（单子操作，结果在 secondaryObject）与 `SCT_AlterTable`（多子操作，结果在 subcmds 列表）。`process_altertable_end_subcmds` 遍历子命令列表，对每个调 `process_altertable_end_subcmd` 再 `switch(cmd->subtype)` 做具体后处理。这种递归使每个子操作获得独立的 `ObjectAddress`（如新约束 OID），也使 TSL 能以子命令为粒度做压缩相关处理（`ts_cm_functions->process_altertable_cmd`）。

### DDL_CONTINUE vs DDL_DONE

`DDL_CONTINUE`：TS 做了预处理，需要 PG 继续执行，执行后 event trigger 后处理——绝大多数命令。`DDL_DONE`：TS 已完全接管，不需要 PG 执行——`process_copy`（COPY INTO hypertable 由 `timescaledb_DoCopy` 自定义实现，不走 PG 原生 COPY）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 钩子链 | `prev_ProcessUtility_hook` (process_utility.c:108) | 与其他扩展共存 |
| 命令分发（switch on node tag） | `process_ddl_command_start` (行 6036) | 每种 DDL 独立处理器函数 |
| 前/后处理分离 | preprocess + event trigger postprocess | 隔离"改命令"与"用结果" |
| 子命令递归 | `process_altertable_end_subcmds` | 处理 ALTER 多子操作，各拿 OID |

## 模块间交互

调用 hypertable（创建/删除元数据）、chunk（遍历传播）、ts_catalog（ID 分配/安全上下文切换 `ts_catalog_database_info_become_owner`）；被 `init.c` 的 `_process_utility_init` 注册；通过 `ts_cm_functions` 委托 TSL 处理压缩/连续聚合相关 DDL（`process_compress_table`/`process_cagg_viewstmt`/`process_altertable_cmd`）。升级期间（`ALTER EXTENSION UPDATE`）所有 DDL 直接透传 prev hook 避免干扰。

## 扩展方式

新增拦截一种 DDL：在 `process_ddl_command_start` 的 switch（行 6042）加 `case T_NewStmt: handler = process_new;`，实现 `process_new` 返回 `DDL_CONTINUE`/`DDL_DONE`，需后处理则在 `process_ddl_command_end` 的 switch 加 case。新增 AlterTable 子命令：在 `process_altertable_start_table` 的 `switch(cmd->subtype)`（行 4768）加预处理 case，在 `process_altertable_end_subcmd` 的 switch（行 5160）加后处理 case——TSL 侧因 `process_altertable_end_subcmd` 末尾无条件调 `ts_cm_functions->process_altertable_cmd`，只需在 TSL 实现里加对应 case。
