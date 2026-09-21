---
source:
  type: "源码解读"
  project: "ParadeDB"
  url: "https://github.com/paradedb/paradedb"
title: "Overview"
date: "2026-09-21T23:37:43+08:00"
category: [Database, VectorSearch, ParadeDB, CodeWiki, "0.25.3"]
contentType: "CodeWiki"
tags: ["ParadeDB", "Rust", "PostgreSQL", "BM25"]
description: "ParadeDB v0.25.3 源码架构解读——Postgres BM25 全文检索扩展 pg_search：Tantivy 存进数据库内部、CustomScan 劫持整条查询进 DataFusion、segmented top-k 与 late materialization 的 PDQ 管线内幕"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 0.25.3 · **协议** AGPL-3.0 · **语言** Rust（pgrx，~114K 行非测试）· **仓库** [GitHub](https://github.com/paradedb/paradedb)
>
> **解读基线** commit [`77b36e95e`](https://github.com/paradedb/paradedb/commit/77b36e95e18e91a568933c198f9022a41ac27f60)（v0.25.3 release commit）

---

## 总览

### 项目简介

ParadeDB 是 **Postgres 全文检索/聚合扩展**，口号 "Search without a second system"——把 Elasticsearch 级的 BM25 搜索、向量检索与聚合分析塞进一个 Postgres，应用数据与搜索引擎同库，**免部署第二个系统、免数据同步管道**。核心交付是 `pg_search` 扩展（Rust 编写，基于 pgrx 框架 + paradedb fork 的 Tantivy）：用户 `CREATE INDEX ... USING bm25` 建全文索引，然后用 `field @@@ paradedb.term('keyboard')` 这样的操作符 DSL 查询（`@@@`/`&&&`/`===`/`###` 操作符族；v0.25.x 无 `paradedb.search()` 函数）。

核心价值三层：**引擎级质量**——BM25 评分、Block-WAND top-k 剪枝、fast field 列存（Tantivy 是 Lucene 级成熟度的 Rust 实现）；**管线级性能**——不是"索引帮你过滤然后回表"，而是 CustomScan 把 ORDER BY score + LIMIT + JOIN + 聚合整条管线劫持进 DataFusion 执行（late materialization：只有最终 top-k 的行才回 heap）；**数据库级一致性**——索引数据存 Postgres 内部（经 WAL 流复制/物理备份自动带上索引），事务可见性天然对齐（对比外部 ES 的双写管道）。

**项目当前边界**：向量检索目前委托 pgvector 扩展（control 文件 `requires = 'vector'`，native 向量支持 README 标注 coming soon）；不含分布式（单 Postgres 实例）；pg_search 是唯一下载单元（ParadeDB 公司的商业化在托管与 pg_analytics/pg_lakehouse 等其它扩展，不在本仓库）。

### 版本历史

- **2023** ParadeDB 创立，最初基于 zhparser/PGroonga 路线
- **2024** 转向 Rust + Tantivy + pgrx 的 pg_search 重写（0.4+）
- **2024-2025** 0.9-0.15：CustomScan 体系、fast field 列式执行、聚合下推
- **2025-2026** 0.16-0.25：join 下推、MPP 跨进程并行、late materialization 规则化、DataFusion 深度集成——**v0.25.3（本篇基线）** 是该演进的成熟形态

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| BM25 索引 | `postgres/build.rs`+`insert.rs`（AM 回调）+ `index/writer/index.rs`（67K，SerialIndexWriter） | Postgres Access Method + Tantivy 桥 |
| 索引存储 | `index/directory/mvcc.rs`（42K）+ `postgres/storage/` | Tantivy Directory 存 Postgres 内部 |
| 查询 DSL | `api/operator.rs` + `api/builder_fns/` | `@@@` 操作符族（SUPPORT 计划期改写）+ builder 函数 |
| 查询表示 | `query/mod.rs`（SearchQueryInput）+ `query/pdb_query.rs`（83K，pdb::Query） | serde JSON 可序列化的查询 IR |
| 查询劫持 | `postgres/customscan/hook.rs`（四层 hook） | planner 拦截 + CustomPath 注入 |
| TopK 下推 | `scan/segmented_topk_exec.rs`（97K） | ORDER BY score LIMIT N 的分段堆合并 |
| Late Materialization | `scan/late_materialization.rs`（33K） | 只有 top-k 的 ctid 回 heap |
| 聚合下推 | `postgres/customscan/aggregatescan/` | GROUP BY/聚合在 fast field 上直算 |
| Join 下推 | `postgres/customscan/joinscan/` | 两索引表 join 整树下推 |
| MPP | `postgres/customscan/mpp/` | 跨进程并行（shm_mq mesh） |
| 并行扫描 | `postgres/customscan/parallel.rs` + `dsm.rs` | PG parallel query + segment 认领 |
| 分词器 | `api/tokenizers/` + `tokenizers/`（顶层） | 自定义 tokenizer 注册体系 |
| 向量 | `postgres/vector/` + pgvector 依赖 | `<->` 距离排序的 SortExpressionType |
| 索引管理 | `api/admin.rs` | merge/vacuum/统计/amcheck 式验证 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| pgrx | 核心 | Rust 的 Postgres 扩展框架（pg15/16/17） |
| tantivy（fork） | 核心 | BM25 引擎——paradedb fork pin 固定 rev |
| DataFusion | 核心 | 查询劫持后的中间执行层（Arrow 列式算子） |
| datafusion-distributed | 可选 | MPP 跨进程执行 |
| tantivy-jieba / tantivy-tokenizer-api | 分词 | 中文与自定义分词 |
| pgvector | 依赖扩展 | 向量检索（`requires = 'vector'`） |
| proc macros（`macros/`） | 构建 | pgrx 相关代码生成 |

## 快速上手

Docker 一键起（自带 pg_search）：

```bash
curl -fsSL paradedb.com/install.sh | sh
```

端到端验证：

```sql
CREATE TABLE items (id SERIAL, description TEXT);
CREATE INDEX items_idx ON items USING bm25 (id, description);
INSERT INTO items (description) VALUES ('mechanical keyboard'), ('wireless mouse');

SELECT * FROM items
WHERE items.description @@@ paradedb.term('keyboard')
ORDER BY paradedb.score(items.description) DESC
LIMIT 10;   -- 命中 customscan + TopK 下推（注意：v0.25.x 无 paradedb.search() 函数，
           -- 操作符是 @@@；score 是投影占位符）
```

验证走了 custom scan：`EXPLAIN` 输出 `Custom Scan (ParadeDB Scan)` 并标注 TopK/Columnar 执行方式。

## 架构设计解析

### 系统架构

ParadeDB 的设计哲学一句话：**用 Postgres 的扩展点把"引擎"和"执行器"整体外包，只把存储和事务留在家里**。索引引擎外包给 Tantivy（fork pin），查询执行外包给 DataFusion——pg_search 自己写的是"胶水"：Postgres AM/CustomScan 的协议层、Tantivy Directory 的 Postgres 存储层、Postgres 计划 ↔ DataFusion 计划的翻译层。

![ParadeDB 分层架构](/vibe-reading/images/articles/paradedb-internals/architecture.svg)

四层职责：**SQL 层**（operator DSL 用户 API）、**Postgres 层**（AM 回调 + planner hook + CustomScan 体系，~69K 行最大的 Rust 模块）、**DataFusion 层**（计划翻译 + 优化规则 + 物理算子）、**Tantivy 层**（BM25 引擎 + Postgres 内部存储）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| API 层 | `src/api/`（12K 行） | SQL operator/UDF/tokenizer 的用户接口 |
| Postgres 层 | `src/postgres/`（69K 行） | AM 回调、planner hook、CustomScan 三形态、heap/ctid 管理 |
| 执行层 | `src/scan/`（11.6K 行） | DataFusion 物理算子与查询构造（topk/LM/prefilter） |
| 查询 IR 层 | `src/query/`（7.4K 行） | SearchQueryInput → pdb::Query 的可序列化查询表示 |
| 索引层 | `src/index/`（6.3K 行） | Tantivy 的 directory/writer/reader/merge 桥 |
| 公共层 | `src/schema|bootstrap|aggregate|vector|parallel_worker/` | schema 映射、启动、聚合 UDF、向量、并行 worker |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `SearchIndexSchema` | 索引 schema（字段→tantivy field 映射） | CREATE INDEX 时解析 | text→text field · numeric→fast field · ctid→key field |
| `SearchQueryInput` | 查询 IR（serde JSON） | operator 求值时构造 | → pdb::Query → tantivy Query |
| `Qual` | Postgres 表达式抽取的中间表示 | planner 期 | 三级分类：our_operator/tantivy/heap |
| `CustomPath` + `CustomScanState` | 自定义扫描路径/执行状态 | planner/executor 两期 | ExecMethodType: TopK/Columnar/Normal |
| `JoinCSClause` | join 下推的可序列化 IR | 存 custom_private | RelNode 树 + 谓词树 + ORDER BY + LIMIT |
| `SearchIndexReader` | 打开的索引读取器 | BeginCustomScan | segment 认领/replicated 双形态 |
| fast field | Tantivy 列存（数值/doc address） | 构建期物化 | Columnar 执行与聚合的基础 |

#### 核心抽象

| 抽象 | 定义位置 | 实现 | 扩展点 |
|------|---------|------|--------|
| Postgres AM 回调 | `postgres/mod.rs:101` 的 bm25_handler | aminsert/ambuild/vacuum… | 索引行为 |
| Directory trait（tantivy） | `index/directory/mvcc.rs` | Postgres 内部存储 | 存储后端 |
| `CustomScan` trait | `customscan/mod.rs:105` | base/aggregate/join 三形态 | 新扫描形态 |
| Qual 三级分类 | `customscan/qual_inspect.rs` | our_operator/tantivy/heap_expr | 下推边界 |
| DataFusion `TableProvider` | `scan/table_provider.rs` | BM25 索引暴露为 DF 表 | 新算子生态 |
| ExecutionPlan 规则 | `segmented_topk_rule.rs` 等 4 条 | 物理计划改写 | 新优化规则 |

## 代码目录

```shell
paradedb/
├── pg_search/                  # 唯一的 Postgres 扩展（Rust）
│   ├── src/
│   │   ├── postgres/（125 文件 69K 行）  # AM + hook + customscan + storage（最大模块）
│   │   │   ├── customscan/              #   性能核心：base/aggregate/join scan + datafusion 桥 + mpp
│   │   │   └── storage/                 #   自建页管理（block/fsm/avl）
│   │   ├── scan/（11.6K 行）            # DF 物理算子：segmented_topk/LM/prefilter/table_provider
│   │   ├── query/（7.4K 行）            # SearchQueryInput + pdb_query（查询 IR → tantivy Query）
│   │   ├── api/（12K 行）               # SQL operator/UDF/tokenizer/admin
│   │   ├── index/（6.3K 行）            # Tantivy directory/writer/reader/merge 桥
│   │   └── schema|bootstrap|aggregate|vector|parallel_worker/
│   └── sql/                    # 升级迁移 SQL（0.15.0 → 0.25.x 共 60+ 步）
├── tokenizers/                 # 独立分词器 crate
├── macros/                     # proc macro
└── benchmarks/ stressgres/ dst/ tests/   # 基准/压力/确定性仿真测试
```

## 模块地图

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 索引存储与 Tantivy 桥 | AM 回调 + Directory + merge | `postgres/index.rs` 的 ambuild | 索引数据的事务一致性归这层 | [索引存储](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/01-index-storage) |
| CustomScan 查询劫持 | 四层 hook + qual 下推判定 | `customscan/hook.rs:550` | 性能核心：整条管线换引擎的协议层 | [CustomScan](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/02-customscan) |
| scan 执行与 LM | DF 物理算子 | `segmented_topk_exec.rs` | top-k/晚物化的算法实现层 | [scan 执行](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/03-scan-exec) |
| API 与 schema | SQL DSL + 字段映射 | `api/operator.rs` | 用户可见接口与 schema 契约 | [API 与 schema](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/04-api-schema) |
| 查询数据流 | 端到端链路 | `search() @@ term()` | 串起四层的完整路径 | [查询数据流](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/05-query-dataflow) |

## 运行时行为

### 核心运行流程

#### 读路径：BM25 查询全链路

![查询数据流](/vibe-reading/images/articles/paradedb-internals/query-dataflow.svg)

文字描述见[查询数据流](/vibe-reading/articles/Database/VectorSearch/ParadeDB/CodeWiki/0.25.3/05-query-dataflow)——operator 求值构造 SearchQueryInput → planner hook 拦截 → qual_inspect 抽取与下推判定 → DataFusion 计划翻译与规则改写（top-k 分段 + LM 注入）→ tantivy 逐 segment 评分 → 只有 top-k 的 ctid 回 heap。

#### 写路径：索引生命周期

![索引生命周期](/vibe-reading/images/articles/paradedb-internals/index-am-lifecycle.svg)

CREATE INDEX 走 aminsert 的全表构建（build_parallel 多 segment 并行）；DML 期 aminsert 写 doc（ctid 记 key field）、ambulkdelete 标记删除（MVCC 安全窗口后物理清）；merge_policy 的阈值触发 segment 合并。

## 典型修改场景

#### 场景 1：新增一种可下推的表达式

`opexpr.rs` 的运算符表加类型对（或专用分支仿 ltree `<@`）→ `qual_inspect.rs` 的 Qual 加变体 + `From<&Qual> for SearchQueryInput` 降级 → pdb::Query 加对应查询类型。planner hook 与三类 scan 的框架不动。

#### 场景 2：新增一种 tokenizer

`tokenizers/` crate 实现 tantivy-tokenizer-api 的 Tokenizer trait → `api/tokenizers/` 的注册面（SQL 可创建/引用）→ index option 指定。

#### 场景 3：新增一种 DataFusion 优化规则

实现 `PhysicalOptimizerRule`（仿 `SegmentedTopKRule` 的四条规则模式）→ 注册到 scan_state 构建优化器的地方 → 处理好与 LM/RangePartitioning 规则的次序。

## 测试体系

```
pg_search/tests/         # SQL 级回归（pgrx 测试框架 + pg_regress）
pg_search/src/**/tests.rs  # Rust 单测（scan/tests.rs 35K 行的算子测试）
proptest-regressions/    # 逻辑等价的属性测试（qual 下推否定语义等）
dst/ stressgres/         # 确定性仿真测试 / 压力测试
benchmarks/               # 基准
```

特色：**逻辑等价的 proptest**（qual_inspect.rs 尾部的 `arb_qual` + `is_logical_equivalent`——下推前后必须语义等价，否定/NULL 三值逻辑的守卫）；`dst/`（deterministic simulation testing）与 Milvus 的确定性模拟测试同思路。

## 阅读源码推荐路线

- 第一遍：理解一次查询
  `api/operator.rs` 的 `@@` 求值 → `customscan/hook.rs:550` 的 planner hook → `basescan/mod.rs:670` 的 create_custom_path → `segmented_topk_exec.rs` 的核心循环
- 第二遍：理解下推判定
  `qual_inspect.rs:834` 的 extract_quals → `pushdown.rs:249` 的 try_build_pushdown_qual → `solve_expr.rs:202` 的运行时求值
- 第三遍：理解索引存储
  `index/directory/mvcc.rs` 的 Directory 实现 → `postgres/storage/` 的页管理 → `merge_policy.rs`
- 第四遍：选深入
  joinscan/README.md（权威设计文档）→ mpp/ 的跨进程并行 → DataFusion 桥的 translator.rs

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| pg_search | ParadeDB 的 Postgres 扩展名（schema 为 paradedb） |
| BM25 | Okapi BM25 全文相关性评分（k1/b 参数经 GUC 调） |
| fast field | Tantivy 的列存字段（数值/doc address，Columnar 执行的基础） |
| key field | 存 ctid 的 fast field——回表与 MVCC 的锚 |
| CustomScan | Postgres 的自定义扫描机制（扩展劫持执行器的入口） |
| qual | Postgres planner 的查询限定条件（restriction） |
| late materialization | 晚物化：排序/join 在索引列上做完才回 heap 取行 |
| segmented top-k | 每 segment 取 top-k 后归并（并行 + 内存 O(k)） |
| Block-WAND | Tantivy 的 top-k 剪枝算法（score 上界跳过整块） |
| pdb::Query | ParadeDB 的查询 IR（serde JSON 可序列化） |
| pushdown / pullup | 谓词下推进索引 / 值从索引拉上来（fast field 直取） |
| MPP | 跨进程并行（shm_mq mesh 的 worker 洗牌） |
| amcheck | Postgres 的索引完整性验证（admin.rs 的同款） |

### 参考资料

- [ParadeDB 官方文档](https://docs.paradedb.com)
- [Tantivy](https://github.com/quickwit-oss/tantivy)（paradedb fork：[paradedb/tantivy](https://github.com/paradedb/tantivy)）
- [pgrx](https://github.com/pgcentralfoundation/pgrx)（Rust 的 Postgres 扩展框架）
- [Apache DataFusion](https://github.com/apache/datafusion)
- 本系列同组：[Milvus](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)、[Faiss](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)、[USearch](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/00-overview)
- joinscan/README.md（仓库内权威设计文档：join 下推的物理形态与 LM 收益链）
