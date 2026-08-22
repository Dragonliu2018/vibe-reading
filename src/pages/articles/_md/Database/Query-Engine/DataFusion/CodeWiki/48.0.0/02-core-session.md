---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "核心 API 与会话编排"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "SessionContext/SessionState 分离、SessionStateBuilder 装配与 DefaultPhysicalPlanner 三段式编排。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/core`（85k 行）+ `session` 是 DataFusion 的**编排中枢与对外公共 API 面**。它本身不实现算子或优化规则，而是把 `sql`/`expr`/`optimizer`/`physical-plan`/`physical-optimizer`/`catalog`/`datasource`/`functions` 串成一条完整流水线，并通过 `SessionContext`/`DataFrame` 暴露给用户。`core` re-export 所有子 crate 的公共 API（`lib.rs`），是用户 `use datafusion::prelude::*` 的实际入口。

## 模块架构

core 内部三个核心角色分工明确：

- **`SessionContext`**（`execution/context/mod.rs:275`）：Facade，字段极简（`session_id`、起始时间、`Arc<RwLock<SessionState>>`），只暴露 `sql`/`read_csv`/`read_parquet`/`register_table` 等高层 API，委托给 `SessionState`。
- **`SessionState`**（`execution/session_state.rs:127`）：状态中枢，一个 struct 汇集 analyzer、optimizer、physical_optimizers、query_planner、catalog_list、三类 UDF 注册表、file_formats、table_factories、runtime_env、config 等全部分发组件，实现 `Session` trait。
- **`DefaultPhysicalPlanner`**（`physical_planner.rs:169`）：把 LogicalPlan 物理化成 ExecutionPlan 的 Strategy，持 `Vec<Arc<dyn ExtensionPlanner>>` 扩展链。

`DataFrame`（`dataframe/mod.rs:213`）是 `Box<SessionState> + LogicalPlan` 的薄包装，所有方法惰性追加计划节点。

## 调用链路

SQL 查询的端到端编排路径（每步标注方法与文件）：

```text
SessionContext::sql(sql)                         # context/mod.rs:588
  → state().create_logical_plan(sql)             # session_state.rs:514
      → sql_to_statement(sql, dialect)           # session_state.rs:372  DFParser→Statement AST
      → statement_to_plan(stmt)                   # session_state.rs:461  SqlToRel→LogicalPlan（含 binding）
  → execute_logical_plan(plan)                    # 处理 DDL/DML/普通查询
      → DataFrame::new(state, plan)               # 普通查询包成 DataFrame

DataFrame::collect(self)                          # dataframe/mod.rs:1373
  → state.create_physical_plan(&self.plan)        # session_state.rs:652
      → self.optimize(logical_plan)               # :566
          ├─ analyzer.execute_and_check(plan,…)   # Analyzer 规则（TypeCoercion 等）
          └─ optimizer.optimize(analyzed,…)       # Optimizer 规则（多轮 fixpoint）
      → self.query_planner.create_physical_plan(&plan, self)   # DefaultQueryPlanner
          → DefaultPhysicalPlanner::create_physical_plan       # physical_planner.rs:176
              ├─ handle_explain_or_analyze()        # EXPLAIN/ANALYZE 前置拦截
              ├─ create_initial_plan()             # :279 DFS 自底向上→ExecutionPlan
              └─ optimize_physical_plan()          # :1910 PhysicalOptimizerRule 链
  → collect(plan, task_ctx)                       # execution_plan.rs:944 执行→Vec<RecordBatch>
```

数据结构变化：`String → Statement(AST) → LogicalPlan → LogicalPlan(优化) → ExecutionPlan → ExecutionPlan(优化) → Vec<RecordBatch>`。`optimize()` 先 Analyzer 后 Optimizer 的顺序不可逆——Analyzer 先把计划规整到合法（含类型 coercion），Optimizer 的不变量校验（schema 兼容）依赖于此。

## 核心实现

### SessionContext 与 SessionState 的三层分离

`SessionContext` 持 `Arc<RwLock<SessionState>>`：同一 session 下多查询共享配置/函数表（读锁），而 `state()`（`context/mod.rs:1641`）返回 clone 给每条查询独立的 `SessionState` 副本，互不干扰地改 `execution_props`。注释明确："The returned state is not shared with the current session state"。三层递进 `SessionContext → SessionState → TaskContext`，每层是上层子集，允许嵌入式场景用最小权限（已有 ExecutionPlan 时只需 `TaskContext` 执行）。`SessionState` 故意不实现 `Default`（`session_state.rs:120`），强制走 Builder。

### SessionStateBuilder 的装配与 with_default_features

`SessionStateBuilder`（`session_state.rs:892`）所有字段 `Option` 包裹，`build()`（`:1328`）用默认值填 None（`session_id=Uuid::new_v4()`、`query_planner=DefaultQueryPlanner`、`catalog_list=MemoryCatalogProviderList`），注册 file_formats/scalar_functions/aggregate_functions/window_functions 到 state，按 `config.create_default_catalog_and_schema` 建默认 catalog。`with_default_features()`（`:1012`）委托 `SessionStateDefaults`（`session_state_defaults.rs`）注册 table_factories/file_formats/expr_planners/UDF——这是"开箱即用"的实现点。

### DefaultPhysicalPlanner：自底向上并发规划

`create_initial_plan`（`physical_planner.rs:279`）用 DFS 展平 LogicalPlan 树，从叶子开始向上构建物理计划——因为物理算子构造需知道子节点 `ExecutionPlan`（物理计划自底向上，逻辑计划自顶向下）。叶子可并发规划（`buffer_unordered(planning_concurrency)`，`:332`），多子节点的父节点用 `Mutex<Vec<ExecutionPlanChild>>` 同步——最后到达的 task 继续向上建（树形 barrier 同步）。`map_logical_node_to_physical` 把每个 `LogicalPlan` 变体映到对应算子。物理优化独立于逻辑优化（`:1910`）：EnforceDistribution/EnforceSorting 只有看到完整物理拓扑才能做。`optimize_physical_plan` 在规则前后跑 `InvariantChecker(Always/Executable)` 与每规则后 `OptimizationInvariantChecker`，确保不破坏正确性。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Facade | `SessionContext`（`context/mod.rs:275`） | 屏蔽 `SessionState` 装配细节，对外只暴露高层 API |
| Builder | `SessionStateBuilder`（`:892`）、`DataFrameWriteOptions` | 链式注入，`build()` 填默认值，强制显式选择配置 |
| Strategy | `QueryPlanner` trait（`context/mod.rs:1743`） | 物理规划策略可替换，默认 `DefaultQueryPlanner` |
| Chain of Responsibility | `ExtensionPlanner` 链（`physical_planner.rs:129`） | 自定义节点按序尝试规划，首个返回 `Some` 胜出 |
| Template Method | `SessionState::create_physical_plan`（`:652`） | 定义"先 optimize 再 planner"骨架，子步骤靠替换 trait 改变 |
| Lazy Evaluation | `DataFrame` 方法（`dataframe/mod.rs`） | 方法只建计划，`collect()` 才触发流水线 |

## 模块间交互

core 依赖几乎所有子 crate（`Cargo.toml:103`）：`sql`（解析）、`expr`（IR）、`optimizer`（逻辑优化）、`physical-plan`/`physical-expr`/`physical-optimizer`（执行）、`catalog`/`datasource`（数据源）、`functions*`（注册 UDF）、`execution`（runtime/TaskContext）。`SessionState` 通过内部 `SessionContextProvider` 适配器（`session_state.rs:467`）实现 `ContextProvider` trait，使 `SqlToRel` 能拿表 schema/UDF——典型适配器模式，状态容器同时扮演规划器上下文角色。

## 扩展方式

- **自定义 QueryPlanner**：impl `QueryPlanner`（`context/mod.rs:1743`）重写 `create_physical_plan`，`SessionStateBuilder::with_query_planner` 注入；更细粒度用 `ExtensionPlanner`（`physical_planner.rs:129`）经 `DefaultPhysicalPlanner::with_extension_planners` 注册。
- **注册 UDF/UDTF**：`SessionContext::register_udf/udaf/udwf`（委托 `SessionState::register_*`），表函数 `register_table_function`。无需改核心代码。
- **替换/追加规则**：`SessionStateBuilder::with_analyzer_rule/with_optimizer_rule/with_physical_optimizer_rule`（`:1071`），或运行时 `add_analyzer_rule`/`append_optimizer_rule`（`:328`/`:339`）。
