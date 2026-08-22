---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "Overview"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "Apache DataFusion 是 Rust 编写的可扩展查询引擎，以 Apache Arrow 为内存格式，提供 SQL 与 DataFrame API、向量化流式执行与全链路可扩展点。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 48.0.0 · **协议** Apache-2.0 · **语言** Rust ≥ 1.82.0 (MSRV) · **代码量** ~507,000 行（datafusion/）+ ~4,800 行（datafusion-cli）· **仓库** [GitHub](https://github.com/apache/datafusion)

---

## 总览

### 项目简介

**Apache DataFusion** 是一个用 Rust 编写的、可扩展的查询引擎（query engine），以 [Apache Arrow] 作为内存数据格式。它的目标用户是希望构建快速、功能丰富的数据库与分析系统的开发者——从"开箱即用"的高性能引擎起步，再针对自身负载逐步特化。DataFusion 本身不是一款数据库产品，而是一个**查询引擎内核**：它负责把 SQL 或 DataFrame 调用翻译成可执行的物理计划并完成向量化、流式、多线程执行，但不负责存储、事务、元数据持久化等数据库系统级职责。这些"外围"能力由下游项目（如 InfluxDB IOx、GreptimeDB、DataFusion Comet 等）在 DataFusion 之上叠加。

DataFusion 解决的核心技术问题是：**如何用一套可扩展的 Rust 查询引擎，同时获得工业级性能与"处处可定制"的灵活性**。它的答案是一条经典的查询流水线（SQL → 逻辑计划 → 优化 → 物理计划 → 物理优化 → 执行），加上一组贯穿各阶段的 trait 扩展点（`TableProvider`、`ExecutionPlan`、`OptimizerRule`、`ScalarUDF` 等）。

核心使用场景：领域专用查询引擎、新数据库平台、数据管道、自定义查询语言后端。DataFusion 的[架构目标](https://docs.rs/datafusion/latest/datafusion/index.html#architecture)有三条——开箱即用、一切可定制、架构上"无聊"（遵循工业最佳实践而非追逐未经验证的前沿技术）。

**项目边界**：DataFusion 负责"读什么、怎么算、怎么并行"，**不负责**存储引擎、WAL、事务、分布式调度（分布式执行由 DataFusion Ray/Ballista 等下游项目承担）。

[Apache Arrow]: https://arrow.apache.org

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| SQL 查询 | `datafusion/sql`（`DFParser` + `SqlToRel`） | 基于 sqlparser，含 CREATE EXTERNAL TABLE/COPY/EXPLAIN 扩展 |
| DataFrame API | `datafusion/core/src/dataframe/mod.rs` | 链式构建 LogicalPlan，`filter`/`aggregate`/`limit`/`select` |
| 向量化流式执行 | `datafusion/physical-plan` + `execution` | 列式 `RecordBatch`，pull 模型 `SendableRecordBatchStream` |
| 多分区并行 | `physical-plan::Partitioning` + `RepartitionExec` | 分区是一等公民，按 join key hash 重分布 |
| 逻辑优化 | `datafusion/optimizer` | Analyzer（语义合法）+ Optimizer（等价变换），多轮 fixpoint |
| 物理优化 | `datafusion/physical-optimizer` | JoinSelection、EnforceDistribution、EnforceSorting 等 |
| 内置数据源 | `datafusion/datasource-*` | CSV/Parquet/JSON/Avro/Arrow，`ListingTable` 支持分区裁剪 |
| UDF 框架 | `datafusion/expr`（trait）+ `functions*`（实现） | `ScalarUDF`/`AggregateUDF`/`WindowUDF`，struct 包裹 trait object |
| Catalog 三级目录 | `datafusion/catalog` | `CatalogProvider` → `SchemaProvider` → `TableProvider` |
| Substrait 互操作 | `datafusion/substrait` | LogicalPlan/PhysicalPlan 与 Substrait 协议双向转换 |
| FFI 嵌入 | `datafusion/ffi` | C ABI，供其他语言嵌入 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Apache Arrow | 核心 | 内存列式格式（`RecordBatch`/`Array`/`Schema`），零拷贝跨算子传递 |
| sqlparser-rs | 核心 | SQL 词法/语法解析，产出 AST |
| tokio | 核心 | 异步运行时，执行流的 poll 与多分区并行 task |
| object_store | 核心 | 远程对象存储（S3/GCS/Azure）统一抽象 |
| ahash / hashbrown | 核心 | 高性能哈希表与哈希函数（hash join、group 聚合） |
| arrow-flight | 可选 | Arrow Flight RPC 协议（`flight-sql-experimental`） |
| apache-avro | 可选 | Avro 文件格式支持 |
| substrait | 可选 | Substrait 跨引擎计划协议互操作 |

---

## 快速上手

DataFusion 既是库也是 CLI。最简方式是用 `datafusion-cli` 直接跑 SQL：

```bash title="用 cargo 安装并运行 CLI"
cargo install datafusion-cli
datafusion-cli -f path/to/people.csv
# 进入交互后：
# > SELECT name, COUNT(*) FROM people GROUP BY name ORDER BY name;
```

作为库，最小调用示例验证引擎跑通（`SessionContext` 是统一入口）：

```rust title="最小调用示例（datafusion/core/src/lib.rs 文档）"
use datafusion::prelude::*;
use datafusion::functions_aggregate::expr_fn::min;

#[tokio::main]
async fn main() -> datafusion::error::Result<()> {
    let ctx = SessionContext::new();
    let df = ctx.read_csv("tests/data/example.csv", CsvReadOptions::new()).await?;
    let df = df.filter(col("a").lt_eq(col("b")))?
               .aggregate(vec![col("a")], vec![min(col("b"))])?
               .limit(0, Some(100))?;
    let results: Vec<RecordBatch> = df.collect().await?;
    Ok(())
}
```

预期产出：满足 `a<=b` 的行按 `a` 分组取 `min(b)`，至多 100 行。`read_csv`/`filter`/`aggregate`/`limit` 都是惰性构建计划，`collect()` 才触发解析→优化→执行全流水线。更多可运行示例在 `datafusion-examples/examples/`（如 `advanced_udf.rs`、`custom_datasource.rs`）。

---

## 架构设计解析

### 系统架构

DataFusion 的架构思想是**分层 + trait 扩展点**：把查询的全过程切成职责清晰的若干层，每层之间用 trait（而非具体类型）解耦，使任意一层都能被替换或扩展。这样做解决的是"开箱即用与处处可定制的矛盾"——默认实现给出一条工业级流水线，而每个 trait 边界都是用户的特化入口。整个仓库被组织成 37 个 workspace crate，按职责分层如下：

![DataFusion 五层架构](/vibe-reading/images/articles/datafusion-internals/architecture.svg)

自上而下五层，**上层依赖下层**（箭头指向依赖方向）。API 层编排一切；查询规划层把 SQL 翻成逻辑计划 IR 并做逻辑优化；物理执行层把逻辑计划物化为可执行算子并做物理优化；数据源与函数层提供可扩展的存储接入与函数库；公共基础层是所有 crate 的根依赖。这样分层让逻辑表示（`LogicalPlan`）与物理执行（`ExecutionPlan`）彻底分离——逻辑优化可复用于不同执行引擎，物理优化紧绑执行模型。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| API & 编排层 | `core`、`session` | 对外公共入口与流水线编排，把解析→优化→物理化→执行串成一体 |
| 查询规划层 | `sql`、`expr`、`optimizer` | SQL→LogicalPlan，逻辑 IR 与语义/性能两阶段重写 |
| 物理执行层 | `physical-plan`、`physical-expr`、`physical-optimizer`、`execution` | 物理算子、表达式求值、物理重写、运行时资源与流 |
| 数据源与函数层 | `catalog`、`datasource`、`functions*` | 目录/数据源抽象（扩展点）与内置函数库 |
| 公共基础层 | `common`、`common-runtime`、`expr-common`、`physical-expr-common` | 类型系统、错误、TreeNode 遍历、配置，全仓地基 |

> 注：`proto`/`proto-common`（protobuf 序列化，大量生成代码）、`substrait`（协议互操作）、`ffi`（C ABI 嵌入）、`spark`（Spark 函数兼容）、`sqllogictest`/`wasmtest`（测试）属辅助 crate，按需引入，不参与核心流水线分层。

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| **Facade** | `SessionContext` in `core/src/execution/context/mod.rs:275` | 封装 `SessionState`，对外只暴露 `sql`/`read_csv` 等高层 API，屏蔽内部装配 |
| **Strategy（trait object）** | `ExecutionPlan`/`TableProvider`/`OptimizerRule`/`ScalarUDF` 等 | 每个扩展点用 `Arc<dyn Trait>`，第三方可注册新实现而不改 DataFusion 源码 |
| **Builder** | `LogicalPlanBuilder`（`expr/logical_plan/builder.rs`）、`SessionStateBuilder`、`FileScanConfigBuilder` | 链式构建不可变 DAG/复杂配置，每次消费 self 返回新实例 |
| **Visitor / Transformer** | `TreeNode` trait in `common/src/tree_node.rs:95` | 统一的递归遍历/重写抽象，`LogicalPlan`/`Expr`/`ExecutionPlan`/`PhysicalExpr` 全部实现 |
| **Template Method** | `SessionState::create_physical_plan` in `core/src/execution/session_state.rs:652` | 定义"先 optimize 再 query_planner"骨架，子步骤靠替换 `QueryPlanner` 改变 |
| **Registry + Singleton** | `FunctionRegistry` + `make_udf_function!` 宏（`functions/src/macros.rs`） | UDF 用 `LazyLock` 单例注册到 SessionContext，按需启用控制二进制体积 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `LogicalPlan` | 逻辑计划 DAG 节点（26 变体 enum），schema-aware，与物理执行无关 | 查询规划期 | 子计划用 `Arc<LogicalPlan>` 共享，可被 optimizer 重写 |
| `Expr` | 逻辑表达式树（30+ 变体 enum），不可变值语义 | 规划期 | 持有于 LogicalPlan 节点字段，参与 `ScalarUDF`/`AggregateUDF` 调用 |
| `ExecutionPlan` | 物理执行计划 DAG 节点（trait），可并行/流式 | 执行期 | `Arc<dyn ExecutionPlan>` 组成 DAG，`execute()` 返回流 |
| `SendableRecordBatchStream` | 列式批数据异步流（`Pin<Box<dyn RecordBatchStream+Send>>`） | 单次执行 | 算子 `execute()` 产出，消费端 poll 拉取 |
| `SessionState` | 会话状态中枢（analyzer/optimizer/catalog/UDF 注册表/runtime） | 会话级 | `SessionContext` 持有 `Arc<RwLock<SessionState>>` |
| `TaskContext` | 单次执行上下文（配置 + UDF + `RuntimeEnv`） | 任务级 | 算子 `execute(partition, ctx)` 接收 |

#### 核心抽象

| 接口/trait | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `TableProvider` | `catalog/src/table.rs:51` | `ListingTable`、`StreamingTable`、用户自定义 | `SessionContext::register_table` |
| `ExecutionPlan` | `physical-plan/src/execution_plan.rs:78` | `HashJoinExec`/`AggregateExec`/`SortExec`/`DataSourceExec` 等所有算子 | `PhysicalPlanner::create_initial_plan` 构造 |
| `OptimizerRule` | `optimizer/src/optimizer.rs:72` | `PushDownFilter`/`EliminateJoin`/`CommonSubexprEliminate` 等约 20 条 | `Optimizer::new()` 默认集 + `append_optimizer_rule` |
| `PhysicalOptimizerRule` | `physical-optimizer/src/optimizer.rs:49` | `JoinSelection`/`EnforceDistribution`/`EnforceSorting` 等 16 条 | `PhysicalOptimizer::new()` 默认集 |
| `ScalarUDF`/`ScalarUDFImpl` | `expr/src/udf.rs:56` | `functions` crate 内 `SHA256Func`/`VersionFunc` 等数百个 | `register_udf` / `register_all` |
| `QueryPlanner` | `core/src/execution/context/mod.rs:1743` | `DefaultQueryPlanner`（→`DefaultPhysicalPlanner`） | `SessionStateBuilder::with_query_planner` |
| `UserDefinedLogicalNode` | `expr/src/logical_plan/extension.rs:32` | 用户自定义逻辑节点 | `LogicalPlan::Extension` 嵌入 |

---

## 代码目录

仓库根的组织以 workspace crate 为粒度，每个 crate 对应一个职责边界：

```text
datafusion/
├── common/              # 公共基础：DFSchema/DataFusionError/TreeNode/ConfigOptions
├── common-runtime/      # SpawnedTask 等 tokio 包装
├── expr/                # LogicalPlan/Expr/UDF trait（逻辑 IR + 扩展契约）
├── expr-common/         # 逻辑/物理表达式共享类型（Accumulator/Signature）
├── sql/                 # DFParser + SqlToRel（SQL→LogicalPlan，含 binding）
├── optimizer/           # AnalyzerRule + OptimizerRule（逻辑两阶段重写）
├── physical-expr-common/# PhysicalExpr trait 定义（共享）
├── physical-expr/      # PhysicalExpr 实现 + 等价类 + 分区/分布
├── physical-plan/       # ExecutionPlan trait + 所有物理算子 + 流
├── physical-optimizer/  # PhysicalOptimizerRule（join 选择/分布/排序强制）
├── execution/           # TaskContext/RuntimeEnv/内存池/SendableRecordBatchStream
├── catalog/             # CatalogProvider/SchemaProvider/TableProvider 三级目录
├── catalog-listing/     # ListingTable 装配 + 分区裁剪辅助
├── datasource/          # DataSource/FileScanConfig/文件扫描统一抽象
├── datasource-{parquet,csv,json,avro,arrow}/  # 各格式 FileSource 实现
├── functions/           # 内置标量函数（math/string/datetime/crypto/...）
├── functions-{aggregate,window,nested,table,aggregate-common,window-common}/
├── core/                # 公共 API：SessionContext/DataFrame/DefaultPhysicalPlanner（编排中枢，85k 行）
├── session/             # Session trait（对象安全接口）
├── proto/ , proto-common/  # protobuf 序列化（生成代码为主）
├── substrait/           # Substrait 协议互操作
├── ffi/                 # C ABI 嵌入接口
├── spark/               # Spark 函数兼容
├── macros/ , doc/      # 过程宏 / 文档生成
datafusion-cli/          # 交互式 SQL CLI（mimalloc 分配器）
datafusion-examples/     # 可运行示例（UDF/数据源/catalog 教程）
benchmarks/ , test-utils/, testing/, parquet-testing/  # 基准与测试夹具
```

`core` 虽然代码量最大（85k 行），但定位是**编排层**——它 re-export 所有子 crate 的公共 API，并实现 `SessionContext`/`DataFrame`/`DefaultPhysicalPlanner` 把流水线串起来，本身不包含算子或优化规则的实现。

---

## 模块地图

DataFusion 按查询流水线自然分化为 10 个有效模块（每个均满足"含 god node 或 ≥500 行业务逻辑"的分量门槛）。模块间的依赖方向见下图：

![模块依赖关系](/vibe-reading/images/articles/datafusion-internals/module-dependencies.svg)

横向骨架是查询流水线（`sql → expr → optimizer → physical-plan → physical-expr → physical-optimizer`），`core` 在上方编排整条流水线，`catalog`/`datasource`/`functions` 在下方提供数据与函数扩展点，所有 crate 共同依赖底层的 `common`。`datasource` 的 `scan()` 产出 `DataSourceExec` 回流到 `physical-plan`，`functions` 实现 `expr` 定义的 UDF trait——这两个是流水线与扩展层的关键交汇点。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 公共基础 | 类型系统/错误/递归遍历/配置 | `common/src/lib.rs` | 全仓地基，被 30 个 crate 依赖，DFSchema/TreeNode 是不可压缩的底层抽象 | [公共基础](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/01-common) |
| 核心 API 与会话编排 | 公共入口与流水线编排 | `core/src/execution/context/mod.rs` `SessionContext` | 把解析→优化→物理化→执行串成一体，是用户面向的唯一 API 面 | [核心 API 与会话编排](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/02-core-session) |
| 逻辑计划与表达式 | LogicalPlan/Expr IR 与 UDF trait | `expr/src/logical_plan/plan.rs` | 逻辑表示独立于执行，是 SQL/optimizer/物理化三方共用的契约层 | [逻辑计划与表达式](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/03-logical-plan-expr) |
| SQL 解析与规划 | SQL 字符串→AST→LogicalPlan | `sql/src/statement.rs` `SqlToRel` | 解析与 binding 紧耦合且依赖外部 catalog 查询，与逻辑 IR 定义分离 | [SQL 解析与规划](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/04-sql-parser-planner) |
| 逻辑优化器 | LogicalPlan 两阶段重写 | `optimizer/src/optimizer.rs` `Optimizer` | 语义合法（Analyzer）与性能等价（Optimizer）是不同关注点，规则注册表式可扩展 | [逻辑优化器](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/05-logical-optimizer) |
| 物理计划与执行 | ExecutionPlan 算子与流式执行 | `physical-plan/src/execution_plan.rs` | 物理算子是可并行/流式的执行 IR，与逻辑表示职责正交 | [物理计划与执行](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/06-physical-plan-execution) |
| 物理表达式 | PhysicalExpr 求值与等价类/分区 | `physical-expr/src/physical_expr.rs` | 物理求值（列索引/Arrow kernel）与逻辑表达式分离，等价类推理是物理优化独有 | [物理表达式](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/07-physical-expr) |
| 物理优化器 | ExecutionPlan 重写优化 | `physical-optimizer/src/optimizer.rs` | 依赖运行时物理属性（分区/排序/boundedness），逻辑层无法做 | [物理优化器](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/08-physical-optimizer) |
| 函数体系 | UDF 框架与内置函数库 | `expr/src/udf.rs` + `functions*/src/lib.rs` | trait 契约在 expr，实现在 functions*，按类别分 crate 控制体积 | [函数体系](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/09-functions) |
| 目录与数据源 | 三级目录与文件表抽象 | `catalog/src/table.rs` `TableProvider` | 数据源是可扩展的存储接入点，计划期供 schema、执行期产 ExecutionPlan | [目录与数据源](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/10-catalog-datasource) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

`SessionContext::new()` 触发一次性的会话装配，把默认 catalog、UDF、文件格式、优化规则全部注册到 `SessionState`：

```text
SessionContext::new()                                          # context/mod.rs:292
  → new_with_config_rt(SessionConfig::new(), RuntimeEnv::default())
    → SessionStateBuilder::new()
        .with_config(config)                                   # 装入 ConfigOptions + extensions
        .with_runtime_env(runtime)                             # 内存池/磁盘/对象存储注册表
        .with_default_features()                               # session_state_defaults.rs:1012
            ├─ default_table_factories()     # CSV/JSON/PARQUET/AVRO TableProviderFactory
            ├─ default_file_formats()       # 对应 FileFormatFactory
            ├─ default_expr_planners()       # Core/Aggregate/Window FunctionPlanner
            ├─ default_scalar_functions()   # 内置 ScalarUDF（数百个）
            ├─ register AggregateUDF/WindowUDF/TableFunction
        .build()                                               # session_state.rs:1328
            ├─ 填充 None 字段：session_id=Uuid、query_planner=DefaultQueryPlanner
            ├─ register_udf/udaf/udwf → state 函数表
            └─ 创建 MemoryCatalogProvider（默认 catalog/schema）
    → SessionContext::new_with_state(state)                    # 持 Arc<RwLock<SessionState>>
```

对象装配顺序：`SessionConfig` → `RuntimeEnv` → `SessionStateBuilder`（+ 默认 features）→ `SessionState` → `SessionContext`。依赖注入方式是**手动 Builder**（非 DI 容器）：`SessionStateBuilder` 的 `with_*` 链式注入各组件，`build()` 用默认值填充剩余 None 字段。`SessionState` 故意不实现 `Default`（`session_state.rs:120`），强制用户显式走 Builder 选择配置与 runtime，避免空状态。`SessionContext` 与 `SessionState` 分离的目的是并发粒度——`state()` 返回 clone（`context/mod.rs:1641`），每条查询获得独立副本互不干扰，而配置/函数注册表在会话内共享（读锁）。

### 核心运行流程

下面覆盖三条最重要的运行模式：**SQL 查询主链路**、**DataFrame 构建链路**、**数据源 scan 介入链路**。它们共享同一条优化→物理化→执行的下游。

#### SQL 查询主链路：从 SQL 字符串到结果集

业务流程：用户提交 SQL → 解析成 AST → binding 成 LogicalPlan → 逻辑优化 → 物理化成 ExecutionPlan → 物理优化 → 流式执行 → 收集 RecordBatch。

![查询数据流](/vibe-reading/images/articles/datafusion-internals/data-flow.svg)

数据结构在每步的形态变化：SQL `String` → `Statement`（AST）→ `LogicalPlan`（DAG）→ `LogicalPlan`（优化后）→ `ExecutionPlan`（DAG）→ `ExecutionPlan`（优化后）→ `SendableRecordBatchStream` → `Vec<RecordBatch>`。文字解读关键步骤：`SessionContext::sql()`（`context/mod.rs:588`）调 `SessionState::create_logical_plan`，先用 `DFParser` 解析得到 `sqlparser` AST，再用 `SqlToRel::statement_to_plan`（`sql/src/statement.rs:180`）做名字解析与 AST→LogicalPlan 翻译（这步含 binding，但不做类型 coercion，留给 Analyzer）。随后 `DataFrame::collect()`（`dataframe/mod.rs:1373`）触发 `SessionState::create_physical_plan`（`session_state.rs:652`）：先 `optimize()` 跑 Analyzer（`TypeCoercion` 等让计划合法）再跑 Optimizer（`PushDownFilter` 等做等价变换，多轮 fixpoint）；再由 `DefaultPhysicalPlanner::create_initial_plan`（`physical_planner.rs:279`）DFS 自底向上把每个 LogicalPlan 节点映射成 `Arc<dyn ExecutionPlan>`，最后 `optimize_physical_plan` 跑物理规则。`collect(plan, task_ctx)`（`execution_plan.rs:944`）执行物理计划——按分区数并发 `execute`，用 `CoalescePartitionsExec` 合并后拉取流。

#### DataFrame 构建链路：惰性计划组装

DataFrame API 与 SQL 的唯一区别在前端：`DataFrame` 的 `filter`/`aggregate`/`limit`/`select` 方法**不执行计算**，只通过 `LogicalPlanBuilder`（`expr/logical_plan/builder.rs:126`）向 plan 树追加节点并返回新 `DataFrame`。每个方法消费 `self`、把当前 `Arc<LogicalPlan>` 移入新节点（`input` 字段），靠 `Arc` 共享子计划而不深拷贝——这是 DAG 而非树的关键。直到 `collect()` 才走与 SQL 完全相同的下游（优化→物理化→执行）。自定义查询语言的系统通常也走这条路：直接用 `LogicalPlanBuilder` 构建 LogicalPlan，绕过 SQL 解析。

#### 数据源 scan 介入链路：TableProvider 的双职责

`TableProvider`（`catalog/src/table.rs:51`）横跨计划期与执行期：计划期 `schema()` 给优化器列信息、`supports_filters_pushdown()` 逐条告知哪些 filter 可下推（返回 `Exact`/`Inexact`/`Unsupported`）、`statistics()` 供 cost-based 优化；执行期 `scan(projection, filters, limit)` 返回 `Arc<dyn ExecutionPlan>`。三参数分别承载投影下推、谓词下推、limit 下推——列存格式（如 Parquet）用 `projection` 跳过无关列大幅减 I/O，用 `filters` 在读取层做谓词裁剪。`ListingTable::scan`（`core/src/datasource/listing/table.rs:884`）先把 filters 拆成 partition filter（仅依赖分区列，做分区裁剪跳过不匹配目录）与普通 filter，再列出文件、按统计分组到目标分区数，最后委托给 `FileFormat::create_physical_plan` 构造 `DataSourceExec`。`scan` 返回的是 `ExecutionPlan` 而非 `RecordBatch`——这让数据源只管"怎么读"，并行/流式/下推交给物理计划层。

---

## 典型修改场景

#### 场景 1：新增自定义标量 UDF

实现 `ScalarUDFImpl` trait（定义在 `expr/src/udf.rs:406`，需实现 `name`/`signature`/`return_type`/`invoke_with_args`），通过 `ScalarUDF::from(MyFunc::new())` 包装，再 `SessionContext::register_udf()` 注册。无需修改 DataFusion 源码——`functions` crate 的 `make_udf_function!` 宏（`functions/src/macros.rs:74`）只是为内置函数省样板。对应测试：`datafusion-examples/examples/advanced_udf.rs`。

#### 场景 2：自定义 TableProvider 读取新存储

实现 `TableProvider` trait（`catalog/src/table.rs:51`）：`schema()` 返回表结构、`scan()` 返回 `DataSourceExec`（可用 `RecordBatchStreamAdapter` 包装自定义流）、`supports_filters_pushdown()` 声明下推能力。通过 `SessionContext::register_table()` 注册。参考实现 `StreamingTable`（`catalog/src/streaming.rs:36`，最简）与 `ListingTable`。对应示例：`datafusion-examples/examples/custom_datasource.rs`。

#### 场景 3：新增优化规则

逻辑优化：实现 `OptimizerRule`（`optimizer/src/optimizer.rs:72`，实现 `name`/`apply_order`/`rewrite` 返回 `Transformed<LogicalPlan>`），在 `Optimizer::new()`（`optimizer.rs:222`）按依赖顺序插入，或运行时 `SessionState::append_optimizer_rule`（`session_state.rs:339`）。物理优化同理实现 `PhysicalOptimizerRule`（`physical-optimizer/src/optimizer.rs:49`），插入 `PhysicalOptimizer::new()`（`optimizer.rs:82`）。规则顺序很关键——源码注释标了大量依赖约束（如 `PushDownFilter` 必须在 `PushDownLimit` 之后）。对应示例：`datafusion-examples/examples/analyzer_rule.rs`。

---

## 测试体系

```text
datafusion/
├── {crate}/src/test/              # 各 crate 的单元测试辅助
├── sqllogictest/                 # sqllogictest 框架，SQL 端到端正确性黄金集
├── wasmtest/                     # WASM 环境运行测试
└── testing/ , test-utils/, parquet-testing/  # 集成测试夹具与数据
datafusion-examples/             # 可执行示例（兼作回归测试）
```

| 代码层 | 测试类型 | 关注点 |
|--------|---------|--------|
| `common`/`expr`/`physical-expr` | 单元测试 | 类型、schema 推导、表达式求值 |
| `optimizer`/`physical-optimizer` | 单元测试 + 快照 | 规则重写正确性（`optimizer/src/test/`） |
| `sql` | sqllogictest + 单元 | 解析/binding 正确性 |
| `physical-plan` 算子 | 集成测试 | 算子语义（如 hash join 正确性） |
| 全链路 | `sqllogictest` | SQL→结果端到端黄金集，覆盖大量边界 |

DataFusion 的 sqllogictest 套件是极佳的"可执行文档"——理解某 SQL 行为时，先在 `datafusion/sqllogictest` 找对应用例。修改算子或优化规则时，参照上表找对应测试类型优先阅读。

## 阅读源码推荐路线

- 第一遍：理解主流程与编排
  `datafusion/core/src/execution/context/mod.rs` 的 `SessionContext` 与 `sql()`（`:588`） → `session_state.rs` 的 `create_logical_plan`/`optimize`/`create_physical_plan`（`:514`/`:566`/`:652`） → `dataframe/mod.rs` 的 `DataFrame::collect`（`:1373`） → `physical_planner.rs` 的 `DefaultPhysicalPlanner::create_initial_plan`（`:279`）
- 第二遍：理解核心数据结构（IR）
  `expr/src/logical_plan/plan.rs` 的 `LogicalPlan` enum（`:203`） → `expr/src/expr.rs` 的 `Expr` enum（`:278`） → `physical-plan/src/execution_plan.rs` 的 `ExecutionPlan` trait（`:78`）与 `stream.rs` 的 `SendableRecordBatchStream`
- 第三遍：理解扩展点契约
  `catalog/src/table.rs` 的 `TableProvider`（`:51`） → `expr/src/udf.rs` 的 `ScalarUDF`/`ScalarUDFImpl`（`:56`/`:406`） → `optimizer/src/optimizer.rs` 的 `OptimizerRule`（`:72`） → `physical-plan/src/execution_plan.rs` 的 `required_input_distribution`/`required_input_ordering`
- 第四遍：选择重点子模块深入阅读（见上方模块地图的"深入阅读"链接，按流水线顺序：Common → 核心 → 逻辑计划 → SQL → 逻辑优化 → 物理计划 → 物理表达式 → 物理优化 → 函数 → 目录数据源）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| LogicalPlan | 逻辑计划 DAG，schema-aware，与执行无关 |
| ExecutionPlan | 物理执行计划 DAG（trait），可并行/流式 |
| RecordBatch | Arrow 列式批数据，执行的基本数据单元 |
| Partitioning / Distribution | 实际分区方式 / 算子要求的输入分布 |
| EquivalenceProperties | 等价类（值等价 + 排序等价 + 常量 + 约束），物理优化推理依据 |
| AnalyzerRule vs OptimizerRule | 前者可改语义（让计划合法），后者保持语义（让计划更快） |
| TreeNode | 统一的递归遍历/重写抽象，`LogicalPlan`/`Expr`/`ExecutionPlan` 均实现 |
| UDF（ScalarUDF/AggregateUDF/WindowUDF） | struct 包裹 `Arc<dyn XxxUDFImpl>` trait object |

### 参考资料

- [DataFusion 官方架构文档](https://docs.rs/datafusion/latest/datafusion/index.html#architecture)
- [DataFusion SIGMOD 2024 论文](https://dl.acm.org/doi/10.1145/3626246.3653368)
- [DataFusion Architecture Talks (Apr 2023)](https://youtu.be/NVKujPxwSBA)
- [sqlparser-rs](https://docs.rs/sqlparser/latest/sqlparser/)
- [Apache Arrow 内存格式](https://arrow.apache.org/docs/format/Columnar.html)
