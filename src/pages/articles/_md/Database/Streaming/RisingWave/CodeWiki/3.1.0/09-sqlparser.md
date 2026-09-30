---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "SQLParser 解析器"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "SQL 解析", "winnow", "fork"]
description: "SQLParser 模块解读：sqlparser-rs fork 的彻底分叉、流 SQL 语法扩展、解析期语义校验前移与 parser_v2 winnow 迁移"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

SQLParser 是依赖图上的纯叶节点（外部依赖仅 itertools/thiserror/tracing/winnow），把 SQL 文本变成 AST。它 fork 自 sqlparser-rs，但 v3.1.0 的状态已经不是"打补丁"而是**彻底接管**：方言抽象（dialect/ 目录与 RisingWaveDialect）已被整体删除——RisingWave 只需 PostgreSQL 兼容语法，不需要多方言；解析器还正在重写为 winnow 组合子风格（parser_v2/）。

## 模块架构

```text
src/sqlparser/src/（18,739 行，5 个编译单元）
├── tokenizer.rs    1,693 行  # 词法（TokenWithLocation 带行列位置）
├── parser.rs       6,474 行  # 语法（v1 主解析器，Copy 的 &tok 切片游标）
├── ast/            ~8,800 行 # Statement/Query/Expression 定义（7 个子文件）
├── parser_v2/      ~950 行   # winnow 组合子（增量迁移层）
├── keywords.rs     777 行    # 关键字 + 三个保留字表
└── legacy_source.rs  432 行  # v1 source 语法的隔离舱（文件头：新特性禁入）
```

## 核心实现

### Statement 枚举的流处理变体

```rust
// src/sqlparser/src/ast/mod.rs:1323 —— 没有独立的 CreateMaterializedView 变体，
// MV 复用 CreateView + materialized 布尔字段
CreateView {
    materialized: bool,
    emit_mode: Option< EmitMode >,   // 流特有：EMIT IMMEDIATELY / ON WINDOW CLOSE
    query: Box<Query>, ...
},
// ast/mod.rs:1336 —— CREATE TABLE 吞并了 source 能力
CreateTable {
    format_encode: Option<CompatibleFormatEncode>,  // 带 connector 的表
    source_watermarks: Vec<SourceWatermark>,        // WATERMARK FOR ... AS <expr>
    cdc_table_info: Option<CdcTableInfo>,          // FROM cdc_source TABLE db.tbl
    webhook_info: Option<WebhookSourceInfo>,       // VALIDATE SECRET ... AS secure_compare()
    engine: Engine,                                 // hummock | iceberg
    ...
},
// 新流对象全部用独立 Statement 结构体包装（ast/mod.rs:1382-1400）
CreateSource { stmt: CreateSourceStatement },
CreateSink { stmt: CreateSinkStatement },
CreateSubscription { stmt: CreateSubscriptionStatement },
CreateConnection { stmt: CreateConnectionStatement },
CreateSecret { stmt: CreateSecretStatement },
```

`Format`/`Encode` 枚举（ast/statement.rs:99/157）定义了 NATIVE/DEBEZIUM/MAXWELL/CANAL/UPSERT/PLAIN × AVRO/CSV/PROTOBUF/JSON/BYTES/TEXT/PARQUET 的流格式矩阵。

### 关键调用路径

```text
CREATE MATERIALIZED VIEW：
Parser::parse_sql()                                  parser.rs:201
 └ Tokenizer::tokenize_with_location()               （产出带行列位置的 token）
 └ parse_statements → parse_statement → parse_create  parser.rs:296/1956
    └ parse_create_view(true, or_replace)            parser.rs:2088
       ├ parse_query / parse_emit_mode               parser.rs:4843/3159
       └ Statement::CreateView { materialized: true, emit_mode, .. }
CREATE SOURCE：
parse_create → parse_create_source                  parser.rs:2127
 └ parse_columns_with_watermark / parse_include_options / parse_with_properties
 └ parse_format_encode_with_connector               ast/statement.rs:234（解析期校验）
    └ Statement::CreateSource { stmt }
错误路径：parse_sql 手工拼 "LINE n: ... ^" 光标定位       parser.rs:208-228
```

### fork 为什么彻底分叉

1. **流 SQL 语义是私有的**：CREATE SOURCE/SINK/SUBSCRIPTION/SECRET/CONNECTION、`FORMAT..ENCODE`、`WATERMARK FOR`、`EMIT ON WINDOW CLOSE`、`WITH (connector=...)` 都是 RisingWave 专属——sqlparser-rs 定位"通用 ANSI SQL + 多方言"，接收单厂商私有语法会污染其 API 面；
2. **解析期语义校验没有挂点**：`parse_format_encode_with_connector`（ast/statement.rs:234）按 connector 字符串硬编码校验——cdc 必须 debezium json、nexmark 必须 native、webhook 直接拒绝 CREATE SOURCE 引导用 CREATE TABLE。这些"语法对但组合非法"的错误前移到 parse 期可给精确报错；
3. **保留下游演进自由度优于跟进上游 bugfix**：删 dialect、换 winnow 都证明团队已放弃 merge 上游的成本。`Precedence` 枚举注释里保留的 `// 5 in upstream` 数值（parser.rs:174-193）是 fork 起源的化石。

### ParseTo trait：新对象的语法知识集中一处

`CreateSinkStatement` 等新对象自带 `parse_to` + Display（`impl_parse_to!`/`impl_fmt_display!` 宏配对），parser.rs 只剩三行薄包装——**一个新对象的全部语法知识集中在 ast/statement.rs 一个位置**（数据 + 解析 + 回写），新增对象类型不触碰庞大 parser.rs 主体。

### parser_v2：winnow 组合子迁移

`Token`/`Keyword` 直接实现 winnow `Parser` trait（parser_v2/mod.rs:75-102）；`compact.rs` 的 `ParseV1` trait 是桥——v1 的 `parse_expr` 已把 CASE/CAST/EXTRACT/SUBSTRING 委托给 `parser_v2::expr_*`（parser.rs:1036-1072）。新增表达式级语法走 parser_v2 路线。

### 错误体验对齐 PostgreSQL

`parse_sql` 失败时手工构造 `LINE n: <sql> ^` 光标（parser.rs:208-228），依赖 tokenizer 的行列信息——pgwire 协议对接 psql/JDBC，错误格式必须与 PG 习惯一致。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| fork 维护模式 | 全 crate（Copy 切片游标 Parser） | 分叉自由度 |
| 声明式语法宏 | `impl_parse_to!`/`impl_fmt_display!` in ast/statement.rs | 解析+回写对称 |
| v1/v2 双轨 | parser_v2/ + compact.rs 桥 | 增量迁移不停服 |
| deprecated 隔离舱 | legacy_source.rs（"New features shall NOT touch this file"） | 旧语法可控退场 |
| 静态保留字表 | `RESERVED_FOR_TABLE_ALIAS` 等三个表 in keywords.rs:630+ | 替代被删的 dialect 机制 |

## 模块间交互

被 frontend（主消费者：`session.rs:1417` 的 `Parser::parse_sql`）、meta、common、expr/impl、pgwire、sqlsmith、simulation 消费。frontend 的 `handler/mod.rs:342` 起 match Statement 分派到各 handler，`binder` 把 AST 转 BoundStatement。自身零内部依赖——这是它能被最底层共享的原因。

## 扩展方式

**新增一种流对象（如 CREATE STREAM JOB）**，四处必改：`keywords.rs` 加关键字到 `Keyword` 枚举 → `parser.rs` 的 `parse_create()` 加路由分支 → `ast/mod.rs` 的 `Statement` 加 `CreateStreamJob { stmt }` 变体（含 Display 分支）→ `ast/statement.rs` 定义 struct + `impl ParseTo` + `impl Display`。若关键字可能撞别名/表名，评估三个 `RESERVED_FOR_*` 列表。

**新增 connector 的 FORMAT/ENCODE 约束**：只改 `ast/statement.rs:234` 的 connector 字符串分支（FIXME 已承认应改为枚举）。
