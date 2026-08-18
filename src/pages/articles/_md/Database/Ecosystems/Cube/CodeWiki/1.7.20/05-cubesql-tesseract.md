---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "CubeSQL 与 Tesseract"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "Rust", "SQL", "pg-wire", "DataFusion", "e-graph"]
description: "Rust pg-wire SQL 接口与原生 SQL 规划器"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

## 模块定位

CubeSQL 与 Tesseract 是 Cube.js 在 Rust 侧的两条 SQL 处理链路，合计约 20 万行 Rust 代码，承载了语义层的"对外 SQL 接口"与"对内 SQL 生成"两大职责：

| 子模块 | 路径 | 规模 | 职责 |
|--------|------|------|------|
| **CubeSQL** | `rust/cubesql/cubesql/` | 286 文件 / 130k 行 | Postgres-wire 协议 SQL 代理 + legacy 规划器 + egg e-graph 重写器 |
| **cubeclient** | `rust/cubesql/cubeclient/` | — | OpenAPI 生成的 Cube.js REST 客户端（`meta_v1`/`load_v1`） |
| **pg-srv** | `rust/cubesql/pg-srv/` | — | 底层 pg-wire 协议帧编解码 |
| **Tesseract** | `rust/cube/cubesqlplanner/cubesqlplanner/` | 486 文件 / 78k 行 | 新版原生 SQL 规划器，从 CubeQuery 直接生成下推 SQL |
| **nativebridge** | `rust/cube/cubesqlplanner/nativebridge/` | — | proc-macro，把 Rust trait 自动转 napi 接口 |

需要首先澄清一个常见误解：**legacy 规划器（`SqlQueryEngine`）与 Tesseract（`BaseQuery`）并不是直接互相替换的关系**。两者处理的数据流方向相反：

- **legacy** 处理"SQL 文本 → CubeQuery/下推 SQL"——BI 工具（Tableau、Metabase、psql）通过 pg-wire 发来原始 SQL，legacy 把它解析、重写、映射到语义层再执行。
- **Tesseract** 处理"CubeQuery → 下推 SQL"——TS orchestrator 已经构造好结构化的语义查询（measures/dimensions/filters），Tesseract 负责把它编译成最优下推 SQL，替代 TS 侧 `BaseQuery.js` 的 JS 版 SQL 生成。

环境变量 `CUBEJS_TESSERACT_SQL_PLANNER`（`config/mod.rs:207`，默认 `true`）切换的并非整个 SQL 主链路，而是 TS 侧 `BaseQuery.useNativeSqlPlanner`（替换 JS 版 SQL 生成）以及 legacy rewrite 中多 fact join 的策略子集。SQL 文本路径始终走 `SqlQueryEngine`。

---

## 模块架构

```
                    ┌─────────────────────────────────────────────┐
                    │           外部客户端                          │
                    │  psql / Tableau / Metabase / PowerBI          │
                    └────────────────────┬────────────────────────┘
                                         │ TCP pg-wire
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │  pg-srv  (rust/cubesql/pg-srv)               │
                    │  buffer.rs · protocol.rs · encoding.rs       │
                    │  协议帧编解码 + MessageTagParser 分发          │
                    └────────────────────┬────────────────────────┘
                                         │ FrontendMessage
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │  AsyncPostgresShim  (shim.rs:43)             │
                    │  连接状态机 · Session · Portal/Cursor         │
                    │  authenticate · Parse/Bind/Execute/Sync      │
                    └────────────────────┬────────────────────────┘
                                         │ ast::Statement
                                         ▼
          ┌──────────────────────────────┴──────────────────────────────┐
          │  convert_statement_to_cube_query  (router.rs:756)            │
          │  rewrite_statement 链式 Visitor 归一化                         │
          └──────────────────────────────┬──────────────────────────────┘
                                         ▼
          ┌────────────────────────────────────────────────────────────┐
          │  SqlQueryEngine (legacy)  query_engine.rs:369               │
          │  ├─ create_session_ctx → 注册 100+ UDF/UDAF/UDTF            │
          │  ├─ DataFusion SqlToRel.statement_to_plan → LogicalPlan     │
          │  ├─ 8 个 OptimizerRule 顺序优化                              │
          │  ├─ LogicalPlanToLanguageConverter → egg RecExpr             │
          │  └─ Rewriter.find_best_plan → 最优 LogicalPlan               │
          └──────────────────────────────┬──────────────────────────────┘
                                         │ QueryPlan::DataFusionSelect
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │  CubeScanNode (DataFusion Extension)        │
                    │  TransportService.load() / load_stream()    │
                    └────────────────────┬────────────────────────┘
                                         │ napi 回调
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │  NodeBridgeTransport (transport.rs:118)      │
                    │  on_sql_api_load → JS ApiGateway.sqlApiLoad  │
                    └─────────────────────────────────────────────┘

  ============ Tesseract 独立链路（CubeQuery → SQL） ============

  TS query-orchestrator (CubeQuery)
                    │
                    │  BaseQuery.js:932 buildSqlAndParamsRust
                    ▼
  native.buildSqlAndParams  (node_export.rs:820)
                    │  napi 反序列化 → NativeBaseQueryOptions
                    ▼
  BaseQuery::try_new  (planner/base_query.rs:41)
                    │  QueryPropertiesCompiler.build(options)
                    │  通过 CubeEvaluator trait 回调 JS 解析数据模型
                    ▼
  TopLevelPlanner::plan  (top_level_planner.rs:33)
                    │
                    ├─ QueryPlanner.plan → Query (logical)
                    ├─ RootQuery.builder().ctes().query().build()
                    ├─ PreAggregationOptimizer.try_optimize
                    │    替换 Cube 节点 → PreAggregation 节点
                    ├─ OriginalSqlCollector.collect
                    ├─ PhysicalPlanBuilder.build → Select
                    └─ physical_plan.to_sql(&templates) → SQL 字符串
                    │
                    ▼
  返回 [sql, params, preAggregationInfo] 给 JS orchestrator
```

两条链路共享 `TransportService` trait 与 napi 桥接层，但逻辑上独立：legacy 从 SQL 文本进来，Tesseract 从结构化 CubeQuery 进来。`nativebridge` proc-macro 为 Tesseract 生成 napi 绑定，让 Rust 调用 JS 实现的 `CubeEvaluator` trait。

---

## 调用链路

### 链路 (a)：legacy SQL 路径（BI/psql → 语义层）

```
psql / BI 工具
   │  TCP pg-wire
   ▼
pg-srv::buffer::read_message                    [pg-srv/src/buffer.rs:76]
   │  解帧 → InitialMessage
   ▼
AsyncPostgresShim::run_on                       [shim.rs:133]
   │  process_initial_message → authenticate → ready
   │  主消息循环 (Query/Parse/Bind/Execute/Describe/Close/Sync)
   ▼
handle_simple_query / parse+bind+execute        [shim.rs:1184 / 999 / 864]
   ▼
convert_statement_to_cube_query                 [router.rs:756]
   │  1. rewrite_statement(stmt) — 链式 Visitor 归一化
   │     SqlParser062Normalizer → CastReplacer → ToTimestampReplacer →
   │     UdfWildcardArgReplacer → RedshiftDatePartReplacer →
   │     ApproximateCountDistinctVisitor
   │  2. QueryRouter::new(state, meta, session_manager).plan(stmt, ...)
   ▼
QueryRouter::plan                               [router.rs:70]
   │  按 stmt 类型分发：
   │    Query → select_to_plan → create_df_logical_plan
   │    Explain → explain_to_plan
   │    Set/SetRole/SetTimeZone/ShowVariable/StartTransaction/Commit/...
   │    → MetaOk / MetaTabular (不进 DF)
   ▼
SqlQueryEngine::plan (QueryEngine::plan)        [query_engine.rs:92]
   │  1. get_cache_entry (CompilerCache 按 auth+protocol 缓存 rewrite 图)
   │  2. create_session_ctx — 注册 CubeQueryPlanner + 100+ UDF/UDAF/UDTF
   │  3. create_logical_plan — DataFusion SqlToRel.statement_to_plan
   │     → LogicalPlan (DF)  (CubeScanNode 是 Extension 节点)
   │  4. 8 个 OptimizerRule 顺序优化:
   │     PlanNormalize → ProjectionDropOut → FilterPushDown → SortPushDown →
   │     LimitPushDown → UnionSortLimitPushDown → SortPushDown →
   │     LimitPushDown → FilterSplitMeta
   │  5. LogicalPlanToLanguageConverter.add_logical_plan_replace_params
   │     → 把 DF LogicalPlan 转成 egg 的 RecExpr<LogicalPlanLanguage>
   │  6. CompilerCache.rewrite(egraph) — equality saturation
   │  7. Rewriter::find_best_plan(root, ...) — 从 e-graph 提取最优 LogicalPlan
   │  8. evaluate_wrapped_sql — 对 CubeScanWrapperNode 生成下推 SQL
   ▼
QueryPlan::DataFusionSelect(LogicalPlan, DFSessionContext)   [plan.rs:44]
   ▼
write_portal → DataFusion 执行                  [shim.rs:1731]
   │  CubeScanNode 的 ExecutionPlan 调 TransportService.load()
   ▼
TransportService.load() → Cube.js sqlApiLoad     [transport/service.rs:182]
   │  HttpTransport: cube_api::load_v1 (HTTP, standalone 模式)
   │  NodeBridgeTransport: 回调 JS sqlApiLoad (嵌入 Node 模式)
   ▼
RecordBatch → pg-wire RowData → psql
```

### 链路 (b)：Tesseract 路径（CubeQuery → 下推 SQL）

```
TS query-orchestrator 构造 CubeQuery (measures/dimensions/filters/timeDimensions/order/...)
   │  schema-compiler BaseQuery.js:877 buildSqlAndParams
   │  if (useNativeSqlPlanner && canUseNativeSqlPlannerPreAggregation)
   │     → buildSqlAndParamsRust            [BaseQuery.js:932]
   ▼
native.buildSqlAndParams(options)               [node_export.rs:820]
   │  napi 反序列化 options → NativeBaseQueryOptions
   │  (含 cubeEvaluator/baseTools 等 JS 回调)
   ▼
BaseQuery::try_new                              [planner/base_query.rs:41]
   │  State::try_new — 构造 QueryTools + Compiler + JoinTreeCache
   │  QueryPropertiesCompiler.build(options) — 解析 measures/dimensions/filters/order
   │    → QueryProperties (通过 CubeEvaluator trait 回调 JS 解析数据模型)
   ▼
BaseQuery::build_sql_and_params                 [base_query.rs:74]
   ▼
TopLevelPlanner::plan                           [top_level_planner.rs:33]
   │  1. QueryPlanner::new(request, state).plan(&mut scope) → Query (logical)
   │  2. RootQuery::builder().ctes(scope.into_members()).query(query).build()
   │  3. try_pre_aggregations:
   │     PreAggregationOptimizer.try_optimize(plan)
   │       → 匹配 pre-aggregation (external/in-memory)
   │       → 替换 Cube 节点为 PreAggregation 节点
   │       → 收集 PreAggregationUsage (含 date_range、external 标志)
   │  4. OriginalSqlCollector::collect
   │     — 把 cube 的 base SQL 替换为 originalSql pre-agg 表
   │  5. PhysicalPlanBuilder.build(optimized_plan, original_sql_pre_aggregations, total_query)
   │     → process_node(RootQuery) 递归 (LogicalNodeProcessor trait)
   │     → collapse_trivial_subqueries
   │     → Rc<Select>
   │  6. physical_plan.to_sql(&templates) → SQL 字符串
   │  7. query_tools.build_sql_and_params(&sql, &templates) → (sql, params)
   │     (用 minijinja 模板渲染 + ParamAllocator 分配占位符)
   ▼
返回 [sql, params, preAggregationInfo] 给 JS
   │  单个 usage: 返回 NativePreAggregationObj (向后兼容)
   │  多 usage: 返回 GroupedPreAggregationInfo 数组 (按 cubeName+name 分组)
   ▼
TS orchestrator 把 SQL 发给 CubeStore / 数据源执行
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `AsyncPostgresShim::run_on` | `shim.rs:133` | pg-wire 连接主循环，fast/semifast 两级关停 |
| `convert_statement_to_cube_query` | `router.rs:756` | SQL AST 归一化 + QueryRouter 分发 |
| `SqlQueryEngine::plan` | `query_engine.rs:92` | legacy 规划主入口：DF 逻辑计划 + egg rewrite |
| `create_session_ctx` | `query_engine.rs:427` | 注册 100+ UDF/UDAF/UDTF |
| `Rewriter::find_best_plan` | `compile/rewrite/rewriter.rs` | 从 egg e-graph 提取最低成本 plan |
| `TransportService::load` | `transport/service.rs:182` | 回调 JS 执行查询返回 RecordBatch |
| `BaseQuery::try_new` | `planner/base_query.rs:41` | Tesseract 入口，构造 QueryProperties |
| `TopLevelPlanner::plan` | `top_level_planner.rs:33` | Tesseract 主规划：logical→pre-agg→physical→sql |
| `PreAggregationOptimizer::try_optimize` | `logical_plan/` | 匹配 pre-agg 替换 Cube 节点 |
| `PhysicalPlanBuilder::build` | `physical_plan_builder/builder.rs:23` | 逻辑计划→物理 Select→SQL |
| `native.buildSqlAndParams` | `node_export.rs:820` | napi 入口，反序列化 JS options |

</details>

---

## 核心实现

### pg-wire 协议兼容

CubeSQL 让任意支持 PostgreSQL 协议的 BI 工具无缝接入语义层，核心在于 `AsyncPostgresShim`（`shim.rs:43`）对 pg-wire 协议的完整实现：

```rust title="rust/cubesql/cubesql/src/sql/postgres/shim.rs:43"
pub struct AsyncPostgresShim {
    socket: TcpStream,
    partial_write_buf: bytes::BytesMut,
    semifast_shutdown_interruptor: CancellationToken,
    cursors: HashMap<String, Cursor>,    // DECLARE CURSOR
    portals: HashMap<String, Portal>,    // Extended Query 协议的 portal
    session: Arc<Session>,
    logger: Arc<dyn ContextLogger>,
}
```

`AsyncPostgresShim` 持有 `Session`（封装 `SessionState` + `SessionManager`），每个 TCP 连接一个实例。`run_on` 接 `CancellationToken` 实现 fast/semifast 两级关停——fast 立即中断，semifast 等待当前查询完成。

协议层的关键能力：

- **Extended Query 协议**：`shim.rs` 完整支持 Parse/Bind/Execute/Close/Sync，`PreparedStatement`/`Portal`/`Cursor` 都在 session 中管理（`shim.rs:49`）。这是 PowerBI、JDBC 驱动等使用 prepared statement 的客户端的前提。
- **UDF 兼容**：`create_session_ctx`（`query_engine.rs:427`）注册 100+ UDF（`version`/`current_database`/`current_user`/`pg_get_userbyid`/`has_table_privilege`/`to_char`/`regexp_substr`/`datediff`/...）、4 个 UDAF（`measure`/`xirr`/`string_agg`）、4 个 UDTF（`generate_series`/`unnest`/`generate_subscripts`/`pg_expandarray`）。BI 工具在连接后会发大量 introspection 查询（查 `pg_catalog`、`information_schema`、版本函数），这些 UDF 让它们能通过。
- **变量系统**：`router.rs:333` `set_variable_to_plan` 支持 `SET role/timezone/cube_cache/user`，`SessionState` 维护 `DatabaseVariable` 列表，`SHOW` 重写成 `pg_catalog.pg_settings` 查询。
- **Cancel 与 SSL**：`shim.rs:596` `process_cancel` + `CancellationToken` 支持查询取消；`process_initial_message` 处理 SSLRequest（`StartupState::SslRequested`）。

**设计决策 why**：BI 工具生态以 PostgreSQL 协议为事实标准（Tableau、Metabase、Superset、PowerBI 都支持），完整兼容 pg-wire 让 Cube 无需为每个 BI 工具写适配器——工具以为自己连的是 Postgres，实际查的是语义层。UDF 数量是兼容性的硬指标：工具的 introspection 查询往往很挑剔，少一个函数就连不上。

### legacy egg e-graph equality saturation

legacy 规划器的核心创新是用 egg 库做 equality saturation——把 LogicalPlan 转成 e-graph，应用所有等价重写规则直到饱和，再提取最低成本 plan。

```rust title="rust/cubesql/cubesql/src/compile/rewrite/converter.rs:188"
pub struct LogicalPlanToLanguageConverter { /* ... */ }
impl LogicalPlanToLanguageConverter {
    pub fn add_logical_plan_replace_params(&mut self, plan, query_params, ctx) -> Result<Id, CubeError>;
    pub fn take_egraph(self) -> CubeEGraph;   // :844
}
```

流程分三步：

1. **DF 逻辑计划**：`create_logical_plan`（`query_engine.rs`）用 DataFusion `SqlToRel::statement_to_plan` 把 SQL AST 转成 DataFusion `LogicalPlan`，其中 `SELECT ... FROM cube_name` 被识别为 `CubeScanNode`（Extension 节点）。然后 8 个 `OptimizerRule` 顺序优化（ProjectionDropOut/FilterPushDown/SortPushDown/LimitPushDown 等）。
2. **转 e-graph**：`LogicalPlanToLanguageConverter.add_logical_plan_replace_params` 把 DF `LogicalPlan` 转成 egg 的 `RecExpr<LogicalPlanLanguage>`——一种等价表达式表示。e-graph 中每个节点可以有多个等价表示，重写规则不删除旧表示而是添加新等价类。
3. **饱和与提取**：`CompilerCache.rewrite(egraph)` 应用 `rules/` 目录下的所有重写规则直到 equality saturation（不再产生新等价类），`Rewriter::find_best_plan(root, ...)` 用成本模型从 e-graph 提取最低成本 `LogicalPlan`。

`CompilerCache`（`sql/compiler_cache.rs`）按 `(auth_context, protocol)` 缓存 egg e-graph，避免每次查询重建 rewrite 规则集——这是 legacy 规划器性能的关键。

**OLAP 查询特殊处理**：`is_olap_query`（`query_engine.rs:586`）通过 `FindCubeScanNodeVisitor` 检测 plan 中是否有 `CubeScanNode`/`CubeScanWrapperNode`/`CubeScanWrappedSqlNode`。若是 OLAP 查询，清空 DF optimizer.rules——因为 DF 的某些优化规则对 OLAP 查询不安全（可能破坏 pre-agg 匹配语义）。

**设计决策 why**：传统优化器用启发式规则按固定顺序应用，一旦应用就不可逆——若规则顺序不对会错过更优 plan。equality saturation 同时保留所有等价形式，最后统一选最优，避免了规则顺序依赖。代价是 e-graph 可能膨胀，但 `CompilerCache` 按 context 缓存饱和后的图，摊薄了成本。

### Tesseract logical/physical plan 分层

Tesseract 用严格的逻辑/物理计划分层，`logical_plan/mod.rs:1` 注释明确："No SQL is produced here"。

```rust title="rust/cube/cubesqlplanner/cubesqlplanner/src/logical_plan/logical_node.rs:8"
pub trait LogicalNode {
    fn inputs(&self) -> Vec<PlanNode>;
    fn with_inputs(self: Rc<Self>, inputs: Vec<PlanNode>) -> Result<Rc<Self>, CubeError>;
    fn try_from_plan_node(plan_node: PlanNode) -> Result<Rc<Self>, CubeError>;
    fn as_plan_node(self: &Rc<Self>) -> PlanNode;
    fn node_name(&self) -> &'static str;
    fn referenced_cte_names(&self) -> Vec<String> { vec![] }   // CTE 可达性分析
}
```

`PlanNode` 是类型擦除的节点枚举（`:32`），包含 17 种节点：`RootQuery`/`Query`/`LogicalJoin`/`FullKeyAggregate`/`PreAggregation`/`AggregateMultipliedSubquery`/`Cube`/`MeasureSubquery`/`DimensionSubQuery`/`KeysSubQuery`，以及 `MultiStage*` 系列（`MultiStageGetDateRange`/`MultiStageLeafMeasure`/`MultiStageMeasureCalculation`/`MultiStageDimensionCalculation`/`MultiStageTimeSeries`/`MultiStageRollingWindow`/`LogicalMultiStageMember`）。

物理层（`physical_plan/query_plan.rs:7`）：

```rust title="rust/cube/cubesqlplanner/cubesqlplanner/src/physical_plan/query_plan.rs:7"
pub enum QueryPlan { Select(Rc<Select>), Union(Rc<Union>), TimeSeries(Rc<TimeSeries>) }
impl QueryPlan {
    pub fn to_sql(&self, templates: &PlanSqlTemplates) -> Result<String, CubeError>;
}
```

`PhysicalPlanBuilder`（`physical_plan_builder/builder.rs:23`）通过 `LogicalNodeProcessor` trait 把逻辑节点递归转成物理 `Select`，再 `to_sql` 生成 SQL 字符串。

分层的好处：

- `PreAggregationOptimizer` 可在逻辑层替换 `Cube` 节点为 `PreAggregation` 节点，完全不影响 SQL 生成——物理层只消费替换后的树。
- `LogicalNodeVisitor`/`LogicalNodeRewriter`（`logical_plan/visitor/`）写通用 pass 不用懂 SQL 方言，因为逻辑层不含 SQL。
- `OriginalSqlCollector` 在逻辑层收集哪些 cube 需要替换 base SQL 为 pre-agg 表，物理层消费这个集合。
- `collapse_trivial_subqueries`（`physical_plan/optimizers/`）是物理层清理，逻辑层不管——SQL 生成的琐碎优化隔离在物理层。

**设计决策 why**：把语义重写（join 树、pre-agg 匹配、multi-stage 展开）和 SQL 生成（方言差异、模板渲染）分离，让两层的测试和演化独立。Tesseract 用 `insta` snapshot 测试逻辑层（`Cargo.toml` dev-deps），用 `testcontainers` 集成测试物理层对真实数据源——逻辑层测试不需要数据库。`check_inputs_len`（`logical_node.rs:116`）让树结构在编译期可检查，类型安全比 JS 版 `BaseQuery.js` 的字符串拼接强得多。

### TS↔Rust napi 桥接

Tesseract 与 TS 的通信不是 HTTP 或 IPC，而是 **napi FFI 同进程直接调用**，通过 `nativebridge` proc-macro 自动生成绑定。

```rust title="rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/evaluator.rs:37"
#[nativebridge::native_bridge(CubeEvaluatorStatic, with_static_meta)]
pub trait CubeEvaluator {
    fn parse_path(&self, path_type: String, path: String) -> Result<Vec<String>, CubeError>;
    fn measure_by_path(&self, measure_path: String) -> Result<Rc<dyn MeasureDefinition>, CubeError>;
    fn dimension_by_path(&self, ...) -> ...;
    fn cube_by_path(&self, ...) -> ...;
    fn segment_by_path(&self, ...) -> ...;
    // ... 共 ~20 个方法，全部回调 JS 侧 schema-compiler 的 CubeEvaluator
}
```

`#[nativebridge::native_bridge(...)]` 标注 trait 后（`nativebridge/src/lib.rs:14`），宏自动生成 napi 反序列化/调用代码——JS 实现的 trait 对象可跨 FFI 传入 Rust。`BaseQueryOptions`（`cube_bridge/base_query_options.rs:229`）同样用宏标注，TS 传入的 measures/dimensions/filters 等查询参数通过它桥接。

两种部署模式对应两种 `TransportService` 实现（`transport/service.rs:161`）：

- **嵌入 Node 模式（生产默认）**：`@cubejs-backend/native` 编译为 `index.node`，通过 `#[neon::main]` 注册（`packages/cubejs-backend-native/src/lib.rs:53`）。TS 侧 `registerInterface`（`js/index.ts:382`）传入 JS 回调（`sqlApiLoad`/`sql`/`meta`/`checkAuth`/...），Rust 用 `NodeBridgeTransport`（`transport.rs:118`）包装。Rust 调 TS 是 napi 函数调用，同进程、零序列化开销。
- **standalone 模式（cubesqld 独立进程）**：`rust/cubesql/cubesql/src/bin/cubesqld.rs` 启动 `Config::default()`，用 `HttpTransport`（`service.rs:244`）通过 HTTP 调 Cube.js API（`cubeclient::apis::default_api::meta_v1`/`load_v1`）。用于开发/测试。

数据序列化：Rust 结构体通过 `serde_json::to_string()` 序列化为 JSON 字符串 → neon 传递到 JS → JS `JSON.parse` → 返回时 JS 对象序列化为 JSON → Rust `serde_json::from_str()` 反序列化。例如 `LoadRequest`（`transport.rs:83-99`）序列化后传给 `on_sql_api_load` 回调。流式结果通过 `WritableStream`（neon）传递。`requestId` 格式为 `{uuid}-span-{n}`（`transport.rs:371-375`），用于跨边界追踪。

**设计决策 why**：用 proc-macro 自动生成 napi 绑定，避免手写 20+ trait 方法的序列化/反序列化/分发代码。JS 实现 trait 对象跨 FFI 传入 Rust，让 Tesseract 能复用 TS 侧已验证的 `CubeEvaluator` 语义模型，不必在 Rust 重写一遍数据模型解析——语义单一来源，执行换引擎。

### 多 fact join 策略与 Tesseract/legacy 共存

Tesseract 与 legacy 共存而非直接替换，根本原因是两者职责不同（方向相反），且迁移是渐进的。

**多 fact join 的策略差异**是共存的核心分歧点：

- **Tesseract** 用 FULL OUTER JOIN over shared key 拼接 fact groups（`physical_plan_builder/builder.rs:298` `dimension_coalesce_refs` 检测 Full join 并 COALESCE）。多个事实表的 measure 分别聚合后，按共享维度键 FULL OUTER JOIN，用 COALESCE 处理缺失维度。
- **legacy** 用 e-graph rewrite 规则（`compile/rewrite/rules/members.rs:3249`）实现等价语义。

开关 `enable_tesseract_sql_planner`（`config/mod.rs:207`，默认 `true`）决定启用哪套：`members.rs:3251` `if !enable_tesseract_sql_planner { return }` 控制规则是否应用。该开关同时控制 TS 侧 `BaseQuery.useNativeSqlPlanner`（`BaseQuery.js:877`），但后者可按查询降级——若 `isRelatedToPreAggregation && !canUseNativeSqlPlannerPreAggregation` 则回退 `newQueryWithoutNative()` 用 JS 路径。

`sql4sql`（`packages/cubejs-backend-native/src/sql4sql.rs:160`）和 `rest4sql`（`rest4sql.rs:92`）都调用 `convert_sql_to_cube_query`（legacy 路径），把 SQL 转成下推 SQL 字符串或 REST 请求体——这是 TS 侧 SQL API（`api-gateway` 的 `sql-server.ts`）调用的辅助路径，区分 `regular`/`pushdown`/`post_processing` 三种 query_type。

**设计决策 why**：直接替换 legacy 风险太大——e-graph rewrite 经过大量 BI 工具兼容性测试，贸然切换可能破坏边缘场景。渐进迁移让 Tesseract 先在多 fact join 子集证明正确性，再逐步扩大覆盖。按查询降级机制（`canUseNativeSqlPlannerPreAggregation`）让复杂 pre-agg 场景回退 JS 路径，保证稳定性优先。两者共享 `TransportService` 和 napi 层，基础设施不重复。

---

## 设计模式

| 模式 | 代码位置 | 为什么用 |
|------|----------|----------|
| 访问者遍历 AST | `sql/postgres/shim.rs:587` `FindCubeScanNodeVisitor`；`sql/statement.rs` 一组 `*Replacer`；`compile/engine/df/optimizers/*` | DataFusion `PlanVisitor` 检测 OLAP 查询；sqlparser AST 重写用自实现 Visitor 链，每个 Replacer 只关心自己的节点类型 |
| 逻辑/物理计划分层 | Tesseract: `logical_plan/` vs `physical_plan/`；Legacy: DataFusion `LogicalPlan` vs `ExecutionPlan` | 逻辑层做语义重写（join 树、pre-agg 匹配），物理层做 SQL 生成；`PhysicalPlanBuilder.process_node` 通过 `LogicalNodeProcessor` trait 分派 |
| 类型擦除树 | `logical_plan/logical_node.rs:32` `PlanNode` enum + `LogicalNode` trait | 17 种节点统一为 enum，`inputs()`/`with_inputs()` 让通用 pass 不知具体类型即可遍历/重写 |
| 策略切换 legacy/tesseract | `config/mod.rs:207` `tesseract_sql_planner`；`compile/rewrite/rules/members.rs:3249` | 默认 true；切换 rewrite 规则行为 + TS 侧 `useNativeSqlPlanner`，渐进迁移而非硬切换 |
| Adapter（transport） | `transport/service.rs:161` `TransportService` trait；`HttpTransport` vs `NodeBridgeTransport` | 同一 trait 适配两种部署：standalone（HTTP）vs 嵌入 Node（napi 回调） |
| egraph equality saturation | `compile/rewrite/`（egg 库） | legacy 规划器把 LogicalPlan 转 `RecExpr<LogicalPlanLanguage>`，用 egg 规则做等价饱和，再提取最低成本 plan，避免规则顺序依赖 |
| proc-macro napi 绑定 | `rust/cube/cubesqlplanner/nativebridge/src/lib.rs:14` `native_bridge` 宏 | `#[nativebridge::native_bridge]` 标注 trait 自动生成 napi 反序列化/调用代码，JS 实现的 trait 对象可跨 FFI 传入 Rust |
| 模板化 SQL 生成 | `transport/service.rs:410` `SqlTemplates`（minijinja）；Tesseract: `planner/sql_templates/PlanSqlTemplates` | 所有 SQL 片段走 jinja 模板，支持多方言（Postgres/Snowflake/BigQuery/...），方言差异隔离在模板 |
| Rc + Weak 断环 | `planner/compiler.rs:39` `query_tools: Weak<QueryTools>`；`planner/state.rs:32` 注释 | `State` 强持有 `QueryTools`，`Compiler` 用 `Weak` 反指避免循环引用泄漏 |

---

## 模块间交互

### 与 TS 侧

两种通信机制，按部署模式分：

1. **嵌入 Node 模式（生产默认）**——`@cubejs-backend/native` 编译为 `index.node`，通过 `#[neon::main]` 注册（`packages/cubejs-backend-native/src/lib.rs:53`）。TS 侧 `registerInterface`（`js/index.ts:382`）传入 JS 回调函数（`sqlApiLoad`/`sql`/`meta`/`checkAuth`/...），Rust 用 `NodeBridgeTransport`/`NodeBridgeAuthService` 包装这些回调。Rust 调 TS 是 napi 函数调用（同进程、零序列化开销）。

2. **standalone 模式（cubesqld 独立进程）**——`rust/cubesql/cubesql/src/bin/cubesqld.rs` 启动 `Config::default()`，用 `HttpTransport` 通过 HTTP 调 Cube.js API。用于开发/测试。

Tesseract 的 JS 回调通过 `nativebridge` 生成的 trait：`CubeEvaluator`（解析数据模型 path、返回 measure/dimension/segment 定义）、`BaseTools`（pre-aggregation 查询、join graph）、`SecurityContext`（安全上下文）。这些 trait 的实现在 TS 侧 `cubejs-schema-compiler`，每次 Rust 调用都跨 FFI 回 JS。

### 与 CubeStore

CubeSQL/Tesseract **不直接连 CubeStore**。它们生成的是 SQL 字符串 + 参数，返回给 TS orchestrator，由 TS 的 driver（`cubejs-cubestore-driver` 等）发给 CubeStore。`SpanId`（`transport/service.rs:83`）跟踪 `is_data_query`/`last_refresh_time`/`external` 跨多个 load 请求的聚合状态。`TransportService.load()` 的 `cache_mode`（`StaleIfSlow`/`StaleWhileRevalidate`/`MustRevalidate`/`NoCache`）映射到 Cube.js 的缓存策略，由 TS orchestrator 决定。

---

## 扩展方式

### 新增一个 SQL 函数支持（legacy pg-wire 路径）

需改文件：

- `rust/cubesql/cubesql/src/compile/engine/udf/`——新增 `create_my_fn_udf()`，参考 `create_date_add_udf`（`query_engine.rs:464`）
- `rust/cubesql/cubesql/src/compile/query_engine.rs:427`——在 `create_session_ctx` 中 `ctx.register_udf(create_my_fn_udf(...))`
- 若需要在 rewrite 阶段特殊处理：`rust/cubesql/cubesql/src/compile/rewrite/rules/` 新增规则
- 若是 Redshift 方言：`rust/cubesql/cubesql/src/sql/postgres/` 可能需调整
- 测试：`rust/cubesql/cubesql/src/compile/test/mod.rs` 加 snapshot 测试

### 修改 Tesseract 规划规则（logical plan 重写）

需改文件：

- `rust/cube/cubesqlplanner/cubesqlplanner/src/logical_plan/optimizers/`——新增 optimizer pass，实现 `LogicalNodeVisitor` 或 `LogicalNodeRewriter`
- `rust/cube/cubesqlplanner/cubesqlplanner/src/planner/top_level_planner.rs:33` `plan()` 中插入 pass 调用（参考 `try_pre_aggregations`）
- 若涉及 pre-aggregation 匹配：`logical_plan/pre_aggregation.rs` + `PreAggregationOptimizer`
- 若涉及 join 树：`planner/join_tree.rs` + `planner/join_tree_cache.rs`
- 测试：`src/test_fixtures/` 加 fixture，用 `insta` snapshot

### 新增一个 pg-wire 消息类型

需改文件：

- `rust/cubesql/pg-srv/src/protocol.rs`——新增 `pub struct YourMessage` + `impl Serialize`（参考 `CommandComplete`/`ParameterDescription`）
- `rust/cubesql/pg-srv/src/buffer.rs:23` `MessageTagParser`——若是新 tag 字节，扩展 `MessageTagParserDefaultImpl::parse`
- `rust/cubesql/cubesql/src/sql/postgres/shim.rs`——在 `run()` 的消息循环中加 `match` 分支，参考现有 `parse`/`bind`/`execute`/`describe`/`close`
- 若涉及协议状态：`rust/cubesql/cubesql/src/sql/extended.rs`（`PreparedStatement`/`Portal`）

### 新增 Tesseract 与 TS 的桥接 trait 方法

需改文件：

- `rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/evaluator.rs`（或其他 `cube_bridge/*.rs` trait）——加 `fn new_method(&self, ...) -> Result<...>`，用 `#[nativebridge::native_bridge(...)]` 标注的 trait 会自动生成 napi binding
- 若需要新 trait：`cube_bridge/` 新建文件，用 `#[nativebridge::native_bridge]` 标注，在 `cube_bridge/mod.rs` 注册
- TS 侧：`packages/cubejs-schema-compiler/src/` 实现该 trait 的 JS 类（`CubeEvaluator` 的实现类）
- 若涉及数据结构：`cube_bridge/*_definition.rs` 新增 `Native*Definition`（带 `NativeDeserialize`/`NativeSerialize`）
