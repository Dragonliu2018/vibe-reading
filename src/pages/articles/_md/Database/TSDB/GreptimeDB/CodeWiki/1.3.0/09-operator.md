---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "operator 算子层"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "operator", "DDL", "DML", "分区路由"]
description: "operator——Frontend 与 region engine 之间的算子桥：语句→region 请求翻译、分区路由、按 peer 并行下发与按需建表。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`operator`（`src/operator/`，~2.3 万行）把高层语句（DDL/DML：CREATE/INSERT/DELETE/ALTER/SELECT table 操作）翻译为对 region engine 的 region 请求，是 Frontend 与 Datanode region engine 之间的桥接。它解耦 Frontend 与 Datanode：Frontend 只调 `StatementExecutor::execute_sql`，不感知 region 拆分、节点路由、并行发送；operator 统一多入口格式（SQL/Prometheus remote write/OTLP）为 region 请求，并实现写入时自动建表/加列。`statement/ddl.rs` 是最大文件（~2300 行），覆盖全部 DDL 执行逻辑。

## 模块架构

`StatementExecutor`（`statement.rs:135`）是语句执行器，聚合 `CatalogManagerRef`/`QueryEngineRef`/`ProcedureExecutorRef`/`PartitionRuleManagerRef`/`InserterRef`/`CacheInvalidatorRef` 等。`Inserter`（`insert.rs:85`）是 INSERT 算子，持 `PartitionRuleManagerRef`/`NodeManagerRef`/`TableFlownodeSetCacheRef`。`Deleter`（`delete.rs:41`）。`RegionRequestFactory`（`region_req_factory.rs:21`）构造 region 请求。`req_convert/` 三种 Converter（`StatementToRegion`/`RowToRegion`/`TableToRegion`）+ `ColumnToRow`。`Requester`（`request.rs:49`，flush/compact/build_index）、`ProcedureServiceOperator`（`procedure.rs:39`，purge/migrate/reconcile）、`FlowServiceOperator`。

## 调用链路

**INSERT（SQL 快路径）**：

```
StatementExecutor::execute_sql → Insert 分支                    statement.rs:244, dml.rs:31
  → insert.can_extract_values() 判断
     快路径（字面量）→ inserter.handle_statement_insert        insert.rs:372
        → StatementToRegion::convert(insert, ctx)               stmt_to_region.rs:62
           → catalog 查表 + sql_value_to_value + Partitioner::partition_insert_requests
              → partition_manager.split_rows（按分区规则拆分到不同 region）  partitioner.rs:33
        → do_request(inserts, table_infos, ctx)                 insert.rs:389
           → RegionRequestFactory::new(header)                 insert.rs:404
           → FlowMirrorTask::new（异步镜像 flownode）          insert.rs:416
           → group_requests_by_peer                            insert.rs:459
              → 按 RegionId 分组 → find_region_leader（partition_manager）  insert.rs:478
           → request_factory.build_insert → RegionRequest      insert.rs:433
           → spawn_global 并行: node_manager.datanode(&peer).handle(request)  insert.rs:434
              → try_join_all 等全部完成，累加 affected_rows     insert.rs:443
     慢路径（子查询）→ plan_exec(QueryStatement::Sql(Insert))   dml.rs:41
```

**INSERT（RowInsertRequests / Prom remote write 路径）**：`Inserter::handle_row_inserts`（`insert.rs:178`）→ `preprocess_row_insert_requests`（JSON 编码）→ `create_or_alter_tables_on_demand`（按需建表/加列）→ `RowToRegion::convert` → `do_request`。

**CREATE TABLE**：`execute_sql` → `create_table`（`ddl.rs:274`）→ `expr_helper::create_to_expr` → 继承 schema 级 TTL → `create_table_inner`（`:393`，判断 metric engine+logical table 分流）→ `create_non_logic_table`（`:433`，检查 schema/表存在 → `parse_partitions` → `create_table_info`）→ `create_table_procedure`（`:2003`）构造 `DdlTask::new_create_table` → `procedure_executor.submit_ddl_task`（提交到 meta-srv procedure 框架）→ 响应取 table_id → 返回 `DistTable`。

## 核心实现

### operator 抽象层的价值

没有 operator，Frontend 要直接处理分区路由、region 请求构造、节点管理，职责混乱。operator 把这些收敛：`do_request`（`insert.rs:389`）做格式转换 + 分区 + 分组 + 并行发送，Frontend 只调 `execute_sql`。同时统一多入口格式——INSERT 来自 SQL/Prometheus remote write/OTLP/Splunk HEC 等，`req_convert` 层各自归一为 `Rows` 后统一调 `Partitioner`，避免每种入口重复实现分区逻辑。

### 多 region DDL 用 procedure 协调

多 region 表的 CREATE TABLE 需在多个 datanode 建 region、注册路由、更新元数据，步骤可能部分失败。operator 不直接操作 region engine，而是构造 `DdlTask` 经 `ProcedureExecutor::submit_ddl_task`（`ddl.rs:2027`）提交到 meta-srv 的 procedure 框架——状态机式多步执行、失败重试、回滚。operator 层只构造 DdlTask + 处理响应，保持轻量。`TriggerReason`（Manual/AutoCreate/AutoAlter）传审计信息（`:2018`）。

### req_convert 格式转换

三种输入（SQL AST `StatementToRegion`、`RowInsertRequests` `RowToRegion`、`TableInsertRequest` 列式 `TableToRegion`）各有预处理（SQL 需值转换、Row 需 JSONB 编码、Table 需列转行），但最终都做分区拆分。设计上把**格式归一化**与**分区拆分**分离：每个 Converter 转输入为 `Rows`，统一调 `Partitioner::partition_insert_requests`（`partitioner.rs:33`）。`InstantAndNormalInsertRequests`（`insert.rs:141`）把 TTL=instant 请求与普通请求分离——instant 请求不写 memtable 仅转发 flownode，使短期 TTL 数据绕过 region engine 存储路径。

### auto-create-table-on-write

Prometheus remote write、OTLP 等摄入协议不含表定义，写入时自动建表是时序 DB 常见需求。`create_or_alter_tables_on_demand`（`insert.rs:562`）+ `get_create_table_expr_on_demand`（`:940`）+ `get_alter_table_expr_on_demand`（`:987`）。`AutoCreateTableType` enum（`:99`，Physical/Logical/Log/LastNonNull/Trace）各有不同 engine 与 table_options（Log 设 `append_mode=true`，Logical 用 metric engine）。`auto_create_disabled_reason`（`:496`）双层控制（全局配置 + 每请求 hint）防表膨胀。

### Flow Mirror 异步

数据写 datanode 后，若表配了 flow，需镜像相同数据到 flownode 做流处理。`FlowMirrorTask`（`insert.rs:1384`）异步 `detach` 不阻塞写主路径（`:424`）。先查 `table_flownode_set_cache` 确定哪些表有 flownode 避免无 flow 表无用镜像（`:1394`）。单 peer 走 zero-copy fast path，多 peer 需 clone（`:1440`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Command | `execute_sql` 大型 match（`statement.rs:244`） | Statement 作 command，各 handler 作 receiver |
| Factory | `RegionRequestFactory`（`region_req_factory.rs:21`） | 包装 header 避免重复构造 |
| Strategy（格式转换） | `StatementToRegion`/`RowToRegion`/`TableToRegion`（`req_convert/`） | 多入口格式统一 convert() 接口 |
| Procedure 协调 | `create_table_procedure`（`ddl.rs:2003`） | 跨 region DDL 委托 meta-srv 状态机 |
| Decorator/Configurator | `StatementExecutorConfigurator`（`statement.rs:101`） | enterprise feature 注入 trigger_querier 等 |

## 模块间交互

依赖 `catalog`（CatalogManagerRef）、`common-meta`（ProcedureExecutorRef/NodeManagerRef/TableMetadataManagerRef/PartitionRuleManagerRef）、`partition`（PartitionRuleManagerRef，分区规则/行拆分/region leader）、`query`（DELETE/SELECT 走 plan_exec）、`store-api`/`table`/`api`/`sql`。**不直接调用** mito2/metric-engine——通过 `NodeManager` trait 间接：`find_region_leader` 查 Peer（`insert.rs:478`）→ `node_manager.datanode(&peer)` 拿 `Datanode` trait（`node_manager.rs:31`）→ `Datanode::handle(RegionRequest)`。`Datanode` trait 实现在 frontend（gRPC client）或 datanode（直接调 region engine），operator 不感知底层引擎——引擎类型仅 DDL 时经 `CreateTableExpr.engine` 传递，procedure 框架建 region 时路由到对应 engine。DDL 经 `ProcedureExecutor` 提交到 meta-srv，DML 经 `PartitionRuleManager` 实时分区路由。

## 扩展方式

- **新增 DML（如 UPDATE）**：`statement.rs:244` match 加 `Statement::Update` 分支，`statement/dml.rs` 加 `update` 方法，`req_convert/` 加 `update/` converter + `partitioner.rs` 加 `partition_update_requests`，`region_req_factory.rs` 加 `build_update`，新建 `update.rs` 参照 `insert.rs:389`/`delete.rs:121`。
- **改 region 请求构造（加 header 字段）**：`region_req_factory.rs` `new` + 所有 `build_*`（clone header）+ 所有调用点（`insert.rs:404`/`delete.rs:126`/`request.rs:329`/`bulk_insert.rs:101`）；header 新字段还要改 `api` proto `RegionRequestHeader`。
- **新增自动建表类型**：`insert.rs:99` `AutoCreateTableType` 加变体 + `as_str`/`alter_existing`（`:113`）+ `create_or_alter_tables_on_demand` match 加分支（`:673`）+ `fill_table_options_for_create`（`:1237`）。
