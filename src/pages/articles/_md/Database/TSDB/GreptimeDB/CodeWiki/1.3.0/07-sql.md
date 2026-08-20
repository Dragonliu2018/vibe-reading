---
source:
  type: "源码解读"
  project: "GreptimeDB"
  url: "https://github.com/GreptimeTeam/greptimedb"
title: "sql SQL 解析"
date: "2026-08-20T13:29:34+08:00"
category: [Database, TSDB, GreptimeDB, CodeWiki, "1.3.0"]
tags: ["GreptimeDB", "Rust", "sqlparser", "SQL解析", "TIME INDEX"]
description: "sql——基于 sqlparser-rs 扩展的 SQL 解析：GreptimeDB 专有语法（TIME INDEX/PARTITION/TTL）、方言兼容与 transform 规则。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/GreptimeDB/CodeWiki/1.3.0/00-overview)

---

## 模块定位

`sql`（`src/sql/`，~2.6 万行）是 GreptimeDB 的 SQL 解析层，基于 `sqlparser-rs` 把 SQL 解析为 AST 并扩展 GreptimeDB 特有语句（CREATE TABLE with OPTIONS/PARTITION/TTL、ALTER、SHOW、CREATE FLOW 等），转成 DataFusion 逻辑计划的输入。它**组合而非 fork** sqlparser——`ParserContext` 封装 sqlparser 的 `Parser`，调用其方法解析标准语法，自己只写扩展逻辑，升级成本低。

## 模块架构

`ParserContext`（`parser.rs:43`）是核心，封装 sqlparser `Parser` + sql + `scheduled_time`。主入口 `create_with_dialect(sql, dialect, opts)`（`parser.rs:71`）解析多语句 SQL 并 `transform_statements` 后处理。`parse_statement`（`:142`）按 token 关键字分发到 `parsers/` 下 16 个子解析器（create/alter/dml/show/flow/tql…）。

`Statement` enum（`statements/statement.rs:52`）~50 个变体（Query/Insert/CreateTable/AlterTable/CreateFlow/Tql/Admin…），实现 `is_readonly`（`:167`）与 `TryFrom<&Statement> for DfStatement`（`:318`，仅 Query/Insert/Delete 可转 DataFusion）。`CreateTable`（`statements/create.rs:100`）含 `ColumnExtensions`（vector/fulltext/skipping/inverted/vector index/json2 options）、`TableConstraint::TimeIndex`（Greptime 独有）、`Partitions`（column_list + exprs）。`OptionMap`（`option_map.rs:29`）用 BTreeMap（有序、Display 可重现）+ secrets 脱敏。`GreptimeDbDialect`（`dialect.rs:19`）同时支持 MySQL 反引号 + PG 双引号。

## 调用链路

**CREATE TABLE with TTL/PARTITION**（`CREATE TABLE demo(host string, ts timestamp, cpu double, TIME INDEX(ts), PRIMARY KEY(host)) PARTITION ON COLUMNS(host)(host<='a', host>'a') ENGINE=mito WITH(ttl='7d')`）：

```
ParserContext::create_with_dialect(sql, &GreptimeDbDialect, opts)   parser.rs:71
  → 循环 parse_statement()                                          parser.rs:142
     → peek CREATE → parse_create()                                  parsers/create_parser.rs:84
        → peek TABLE → parse_create_table()                          create_parser.rs:248
           1. parse_if_not_exist / intern_parse_table_name           (canonicalize)
           2. parse_columns()                                        create_parser.rs:567
              → parse_column_def → parse_column_name / parse_data_type
              → parse_optional_column_option：TIME INDEX 编码为
                 ColumnOption::DialectSpecific(vec![TIME, INDEX])   create_parser.rs:793
              → parse_column_extensions（VECTOR/SKIPPING/FULLTEXT/INVERTED index）
              → parse_column 后处理：提取 TimeIndex + 自动 NOT NULL    create_parser.rs:600,633
              → parse_optional_table_constraint（PRIMARY KEY / TIME INDEX）
           3. validate_time_index（校验存在且唯一、类型 Timestamp）
           4. parse_partitions → parse_partition_on_columns → parse_partition_entry  create_parser.rs:501
           5. validate_partitions（列已定义、表达式为二值）
           6. parse_table_engine（ENGINE=，默认 mito / FILE_ENGINE）
           7. parse_create_table_options → parse_with_options          parsers/utils.rs:415
              → validate_table_option 白名单 + validate_semantic_option
              → OptionMap（key 全小写）
  → 组装 Statement::CreateTable
  → transform_statements(stmts)                                     parser.rs:100
     → ExpandIntervalTransformRule（'1h' → '1 hours'，支持 ISO 8601）  transform/expand_interval.rs
     → TypeAliasTransformRule（INT8/FLOAT64/TimestampSecond → 标准 DataType）  transform/type_alias.rs
  → 返回 Vec<Statement>
```

## 核心实现

### 组合而非 fork sqlparser

`ast.rs:15` re-export sqlparser 几乎所有 AST 类型；`parser.rs:53` 直接 `Parser::new(dialect).with_options(...).try_with_sql(sql)`。GreptimeDB 只在标准 SQL 上叠加少量专有语法，自己写扩展逻辑，升级 sqlparser 时只需跟随——无需维护 fork。

### DialectSpecific 蹦床：TIME INDEX

sqlparser 不认识 `TIME INDEX` 关键字组合。GreptimeDB 用 sqlparser 的 `ColumnOption::DialectSpecific(Vec<Token>)` 逃生舱（`create_parser.rs:793`）：让 sqlparser 保留原始 token 序列，再由 GreptimeDB 后处理提取为 `TableConstraint::TimeIndex`（`:633`/`:1070`）。避免 fork 增加 enum variant。表级 `TIME INDEX(ts)` 在 `parse_optional_table_constraint` 直接匹配 `Keyword::TIME` + `Keyword::INDEX`（`:1070`）。

### PARTITION ON COLUMNS

`parse_partition_on_columns`（`create_parser.rs:510`）消费 `ON COLUMNS` 解析列名列表 + 表达式列表，组装 `Partitions{column_list, exprs}`（`create.rs:523`）。表达式复用 sqlparser `Expr`，`validate_partitions`（`:1188`）确保分区列已定义、表达式为二值运算。

### TTL / 表选项 OptionMap

`WITH(ttl='7d', storage='File')` 经 sqlparser `parse_options(Keyword::WITH)` 解析为 `Vec<SqlOption>`，`parse_with_options`（`parsers/utils.rs:415`）验证 key 白名单（`validate_table_option`，在 `src/table/src/requests.rs`）+ semantic 域值，存入 `OptionMap`（BTreeMap，key 全小写、有序、secrets 分离脱敏）。

### 方言兼容 MySQL/PG

`GreptimeDbDialect`（`dialect.rs:19`）`is_delimited_identifier_start` 同时接受 `` ` `` 和 `"`；非引号标识符自动转小写（`canonicalize_identifier`，`parser.rs:323`，兼容 PG）；`with_trailing_commas(true)` 兼容 MySQL；re-export `MySqlDialect`/`PostgreSqlDialect`（`:15`）让上层按连接协议选。`TypeAliasTransformRule` 把 `INT8`/`FLOAT64`/`TimestampSecond` 等别名映射到标准 DataType。

### Statement → DataFusion 桥接

`TryFrom<&Statement> for DfStatement`（`statement.rs:318`）仅 Query/Insert/Delete 可转 DataFusion；DDL（CreateTable/AlterTable）不转，由 frontend 层直接处理——DataFusion 只负责查询计划，DDL 是 GreptimeDB 自有逻辑。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 解析器组合子/手写递归下降 | `ParserContext` + `parsers/*_parser.rs`（16 个） | 按关键字分发，每语句一文件 |
| 方言适配 | `GreptimeDbDialect`（`dialect.rs:19`） | 同时兼容 MySQL/PG |
| AST 访问者 | `sqlparser_derive::{Visit, VisitMut}`（`create.rs:100` 等） | 扩展 AST 节点参与 sqlparser 遍历 |
| 规则链 | `RULES` + `TransformRule` trait（`transform.rs:29`） | 解析后归一化方言差异 |

## 模块间交互

依赖 `sqlparser`/`sqlparser_derive`、`datafusion`（`SqlToRel`/`ExprSimplifier`）、`common_query`/`common_sql`、`common_catalog`（`default_engine`/`FILE_ENGINE`）、`datatypes`、`api`、`store_api`/`table`（`validate_table_option`/`validate_database_option`）、`promql_parser`（TQL）。被 `frontend`（`instance.rs:227` 主解析入口）、`query`（`SqlToRel`）、`catalog`（Flow SQL 持久化）、`auth`（权限检查）、`pipeline`、`partition` 调用。

## 扩展方式

- **新增 SQL 语句**（如 `CREATE TRIGGER`）：`statements/statement.rs` `Statement` enum 加变体，`statements/create/trigger.rs` 定义 struct（derive `Visit`/`VisitMut`），`parsers/create_parser.rs:119` `parse_create` match 加分支 + 实现 `parse_create_trigger`。
- **新增表选项**：`src/table/src/requests.rs` `validate_table_option` 白名单加 key（`parse_with_options` 自动生效）；semantic 验证加 `validate_semantic_option` 条目。
- **新增 ALTER TABLE 操作**：`statements/alter.rs` `AlterTableOperation` enum 加变体，`parsers/alter_parser.rs` match 加分支，frontend 处理执行逻辑。
