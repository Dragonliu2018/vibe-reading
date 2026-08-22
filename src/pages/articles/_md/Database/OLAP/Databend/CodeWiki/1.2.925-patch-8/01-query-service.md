---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "服务层"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "OLAP", "Interpreter", "分布式调度"]
description: "Databend 服务层——协议接入、会话管理、Interpreter 工厂分发、查询管道构建与分布式 Fragment 调度。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

服务层（`src/query/service/`，crate 名 `databend-query`，~201k 行）是 Databend 的**编排中枢**——它不实现任何具体的查询计算逻辑，而是负责将外部协议请求接入、创建会话上下文、分发到正确的 Interpreter、构建执行管道、调度分布式执行。它是唯一一个同时持有 servers（协议）、sessions（会话）、interpreters（分发）、schedulers（调度）、pipelines（管道构建）五个子系统的模块。

它的核心价值在于**协议无关的统一执行路径**：MySQL、HTTP、Flight SQL 三种协议各自解码请求，但都汇聚到 `interpreter_plan_sql` → `InterpreterFactory::get` → `interpreter.execute` 这同一条执行链，避免了三份重复的查询处理实现。

## 模块架构

服务层内部由五个核心子系统协作：`servers` 接入协议请求，`sessions` 管理连接级与查询级上下文，`interpreters` 按 Plan 类型分发执行，`pipelines` 将物理计划转为 Processor DAG，`schedulers` 处理分布式 Fragment 切分与节点分发。

```
servers (协议) ─→ sessions (会话) ─→ interpreters (分发)
                                          │
                              ┌───────────┴───────────┐
                              ↓                       ↓
                         pipelines (构建)         schedulers (分布式)
                              │                       │
                              ↓                       ↓
                         Pipeline DAG           Fragment + Exchange
```

`InterpreterFactory::get`（`interpreter_factory.rs:148`）是整个服务层的分发枢纽——178 个 Interpreter 文件各自实现一种 SQL 语句的执行逻辑，工厂按 `Plan` variant 统一分发，并在入口集中做权限检查（`Accessor`）和审计日志（`AccessLogger`）。

## 调用链路

以 MySQL 协议的 SELECT 查询为例，完整调用链如下（每步标注文件路径）：

```
do_query(query_id, query)                    [mysql_interactive_worker.rs:396]
├── session.create_query_context(version)    [session.rs:152]
├── interpreter_plan_sql(ctx, sql, ...)      [interpreter.rs:260]
│   └── plan_sql()                          [interpreter.rs:303]
│       ├── Planner::parse_sql(sql)         [planner.rs] → Statement AST
│       └── planner.plan_stmt(stmt)         [planner.rs] → Plan (bind+optimize)
├── InterpreterFactory::get(ctx, &plan)     [interpreter_factory.rs:148]
│   └── get_inner → SelectInterpreter      [interpreter_factory.rs:259]
└── interpreter.execute(ctx)                [interpreter.rs:89]
    └── execute_with_hooks → build_pipeline_before_execute
        └── SelectInterpreter::execute2()   [interpreter_select.rs:296]
            ├── build_physical_plan()       → PhysicalPlanBuilder::build
            └── build_query_pipeline()      → PipelineBuilder::finalize
```

数据类型变化：`&str`（SQL）→ `Statement`（AST）→ `Plan::Query{SExpr}` → 优化后 `SExpr` → `PhysicalPlan` → `PipelineBuildResult{Pipeline}` → `SendableDataBlockStream`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `do_query` | MySQL 查询入口 | 联邦查询预检（`MySQLFederated`） |
| `interpreter_plan_sql` | SQL→Plan + 查询日志 | 出错时仍记录 query start/finished |
| `plan_sql` | 创建 Planner + parse + plan | 独立函数，非 Planner 方法 |
| `InterpreterFactory::get` | Plan→Interpreter 分发 | 统一权限检查与审计 |
| `Interpreter::execute` | 模板方法执行 | execute→execute_with_hooks→execute2 |
| `SelectInterpreter::execute2` | 构建 PhysicalPlan+Pipeline | 结果缓存检查 |
| `build_query_pipeline` | 本地/分布式构建 | `is_distributed_plan` 分流 |

</details>

## 核心实现

### Interpreter trait 与模板方法

`Interpreter` trait（`interpreter.rs:71`）定义了执行框架，采用**模板方法模式**——`execute()` 是模板方法，定义了"日志→构建管道→执行"的固定框架，具体计划构建由子类实现的 `execute2()` 完成：

```rust title="interpreter.rs"
#[async_trait::async_trait]
pub trait Interpreter: Sync + Send {
    fn name(&self) -> &str;
    fn is_ddl(&self) -> bool;
    // 用户面入口（HTTP/MySQL 调用），含日志与 hooks
    async fn execute(&self, ctx: Arc<QueryContext>) -> Result<SendableDataBlockStream>;
    // 核心方法：各 Interpreter 实现，构建并返回 Pipeline
    async fn execute2(&self) -> Result<PipelineBuildResult>;
}
```

`execute()` 的默认实现依次调用 `execute_with_hooks` → `build_pipeline_before_execute`（调 `execute2()` 拿到 `PipelineBuildResult`）→ `execute_built_pipeline`（根据 pipeline 类型选择 `PipelineCompleteExecutor` 或 `PipelinePullingExecutor` 执行）。这样所有 Interpreter 共享统一的错误处理、pipeline 构建和 executor 选择逻辑，子类只需实现自己的 `execute2()`。

### InterpreterFactory 工厂分发

`InterpreterFactory::get`（`interpreter_factory.rs:148`）是分发枢纽，采用**两层分发**设计：`get()` → `get_warehouses_interpreter()`（Warehouse 管理 Plan 的特殊处理，节点未分配时报错）→ `get_inner()`（其余所有 Plan 的 `match` 分发）：

```rust title="interpreter_factory.rs"
pub async fn get(ctx: Arc<QueryContext>, plan: &Plan) -> Result<InterpreterPtr> {
    // 入口统一做权限检查和审计
    Accessor::create(ctx.clone()).check(plan).await?;
    AccessLogger::create(ctx.clone()).log(plan).await?;
    get_warehouses_interpreter(ctx, plan, get_inner).await
}

fn get_inner(ctx, plan) -> Result<InterpreterPtr> {
    match plan {
        Plan::Query { s_expr, bind_context, metadata, .. } =>
            Ok(Arc::new(SelectInterpreter::try_create(ctx, bind_context, s_expr, metadata, ...)?)),
        Plan::Insert(v) => Ok(Arc::new(InsertInterpreter::try_create(...)?)),
        // ... 178 个 variant
    }
}
```

**为什么按 Plan variant 分发**：Planner 只负责"SQL→Plan"（语法+语义+CBO），Interpreter 只负责"Plan→执行"。每种 Plan variant 的执行逻辑差异巨大（SELECT 要构建物理计划+pipeline，CREATE TABLE 要修改元数据，INSERT 要写数据），按 variant 分发让每个 Interpreter 只关心一种执行路径。入口统一做权限检查和审计，避免 178 个 Interpreter 重复实现。

### Session / QueryContext 上下文

`Session`（`session.rs:57`）是**连接级**对象（跨查询复用），`QueryContext`（`query_ctx.rs:186`）是**查询级**对象（每条查询创建一个）。`Session::create_query_context`（`session.rs:152`）为每条查询创建 `QueryContext`，绑定 Cluster 发现结果和内存限制。

```rust title="query_ctx.rs"
pub struct QueryContext {
    shared: Arc<QueryContextShared>,    // 跨查询共享的 Session 级状态
    query_settings: Arc<Settings>,
    fragment_id: FragmentId,          // 分布式 fragment ID 生成
    partition_queue: Arc<RwLock<VecDeque<PartInfoPtr>>>,  // 存储分区队列
    // ...
}
```

`QueryContext` 通过组合多个 trait（`TableContext`、`TableContextSettings`、`TableContextCluster` 等）暴露 catalog/cluster/settings/progress 等能力，是整个执行链的上下文核心。

### PipelineBuilder 与物理计划构建

`PipelineBuilder`（`pipeline_builder.rs:45`）将 `PhysicalPlan` 树递归转为 `Pipeline`（Processor DAG）。`finalize()` 调用 `plan.build_pipeline(self)`，这是 **Visitor 模式的变体**——PhysicalPlan 的各节点自己实现 `build_pipeline2()` 知道如何构建对应的 pipeline processor：

```rust title="pipeline_builder.rs"
impl PipelineBuilder {
    pub fn finalize(mut self, plan: &PhysicalPlan) -> Result<PipelineBuildResult> {
        self.build_pipeline(plan)?;
        // build_pipeline → plan.build_pipeline(self) 递归
        Ok(PipelineBuildResult { main_pipeline: self.main_pipeline, .. })
    }
}
```

`PipelineBuildResult`（`pipeline_build_res.rs:36`）包含 `main_pipeline` 和 `sources_pipelines`（子查询管道）。

### 分布式 Fragment 调度

当 `plan.is_distributed_plan()` 为真时，`build_distributed_pipeline`（`scheduler.rs:101`）执行分布式调度：

1. **Fragment 切分**（`Fragmenter::build_fragment`，`fragmenter.rs:92`）：遍历 PhysicalPlan，在 `Exchange` 节点处切分为 `PlanFragment`，每个 fragment 有唯一 ID 和 `DataExchange` 描述数据流向。
2. **Action 生成**（`PlanFragment::get_actions`）：根据 fragment 类型决定执行节点——`Root` 发到 coordinator，`Intermediate` 分发到所有 executor 节点。
3. **Exchange 类型**（`fragmenter.rs:223`）：`Normal`（点对点 shuffle）、`GlobalShuffle`（全局 shuffle）、`Merge`（汇聚到 coordinator）、`Expansive`（广播）。
4. **提交执行**（`ExchangeManager::commit_actions`，`scheduler.rs:120`）：通过 Flight RPC 将 fragments 发送到各节点。

**为什么分 fragment**：分布式查询中不同计划片段需在不同节点执行（如 scan 在数据所在节点，聚合在 coordinator）。Fragment 切分使每个节点只需执行自己的 fragment，通过 Exchange 节点交换数据。

## 模块间交互

服务层是依赖最多的模块——它编排了从协议到存储的完整链路：

- **service → sql**：调用 `Planner::plan_stmt` 生成 `Plan`（`lib.rs:81` 重导出为 `crate::sql`）
- **service → pipeline**：`PipelineBuildResult` 依赖 `databend_common_pipeline::core::Pipeline`
- **service → storages**：`lib.rs:82` 重导出 `databend_common_storages_factory`，FuseTable 通过 `PhysicalPlan::build_pipeline` 注入 pipeline
- **service → catalog**：`QueryContext` 持有 `Catalog`，Interpreter 通过 `ctx.get_catalog()` 访问元数据
- **service → meta-client**：`QueryContext` 通过 `UserApiProvider` 访问 MetaStore（gRPC）管理用户/角色/权限

## 扩展方式

**新增一种 SQL 语句的 Interpreter**：在 `Plan` 枚举添加 variant → 实现 `Interpreter` trait（尤其 `execute2`）→ 在 `interpreter_factory.rs` 的 `get_inner` match 添加 arm → 在 `mod.rs` 注册模块。执行路径（pipeline/scheduler）完全复用，无需修改。

**新增一种协议接入**：实现 `Server` trait（`start`/`shutdown`）→ 在 `servers/mod.rs` 注册 → 在启动流程 `ShutdownHandle.add_service`。查询处理只需复用统一的四步流程（create_query_context → interpreter_plan_sql → InterpreterFactory::get → execute）。
