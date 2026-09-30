---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Frontend 前端"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "SQL 优化器", "查询调度"]
description: "Frontend 模块解读：pgwire 会话、五阶段 typestate 优化器、handler 巨型 match 分发、批/流双执行模式裁决与 fragment 切分"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Frontend 是集群的**无状态 SQL 代理**：接受 pgwire 连接、解析绑定优化每条语句、决定批查询在哪儿执行、把流作业的 fragment 图提交给 meta。它不持有任何用户数据——catalog 是 meta 推送的本地缓存，执行靠 compute 节点。正因为无状态，frontend 可以随意水平扩缩，这让"高并发点查"在架构上成立。

它的职责边界也清晰：**frontend 产计划、不做执行**。批查询的 root stage 虽在 frontend 进程内跑（Local 模式复用 `risingwave_batch` 执行引擎），但那是借调；流作业的 actor 调度完全由 meta 完成，frontend 只提交 `StreamFragmentGraph`。

## 模块架构

Frontend 内部按 SQL 的生命周期纵向切分：session 层（连接/事务/变量）→ handler 层（~90 个语句文件的巨型 match 分发）→ binder/planner/optimizer（语义与计划）→ scheduler + stream_fragmenter（执行编排）。横向还有一个 observer 层接收 meta 的 catalog/worker 推送。

核心装配是 `FrontendEnv`（`session.rs:145`）——一个服务定位器：`meta_client`、`catalog_writer/reader`、`worker_node_manager`、`query_manager`、`hummock_snapshot_manager`、`sessions_map` 等全部 trait object 化注入，`FrontendEnv::mock`（session.rs:217）可换 MockCatalogWriter 做全链路测试。

`SessionImpl`（session.rs:747）实现 pgwire 的 `Session` trait，是每条连接的状态核心：

```rust
// src/frontend/src/session.rs:747
pub struct SessionImpl {
    env: FrontendEnv,
    auth_context: Arc<RwLock<AuthContext>>,      // database/user
    config_map: Arc<RwLock<SessionConfig>>,      // SET/SHOW 变量
    txn: Arc<Mutex<transaction::State>>,         // 事务状态机
    current_query_cancel_flag: Mutex<Option<ShutdownSender>>,  // 本地查询取消
    cursor_manager: Arc<CursorManager>,
    temporary_source_manager: Arc<Mutex<TemporarySourceManager>>,
    staging_catalog_manager: Arc<Mutex<StagingCatalogManager>>,
}
```

查询取消是三层配合：Local 模式执行前 `set_cancel_query_flag`（session.rs:1388）存入 `ShutdownSender`，执行中经 `reset_cancel_query_flag`（:1381）取 `ShutdownToken` 传给执行树，`cancel_current_query`（:1393）被 pgwire 的 cancel 消息触发后发送 shutdown。

## 调用链路

一条 SELECT 从 pgwire 到执行下发的路径：

```text
pgwire process_query_msg                       utils/pgwire/pg_protocol.rs:838
 └ SessionImpl::run_one_query                  frontend/session.rs:1793
    └ handler::handle                          handler/mod.rs:305（巨型 match）
       └ handle_query                          handler/query.rs:74
          ├ Binder::new_for_batch().bind()     binder/mod.rs:316 → BoundStatement
          ├ Planner::plan_query                planner/query.rs:31 → LogicalPlanRoot
          ├ gen_batch_query_plan               query.rs:312
          │   ├ gen_optimized_logical_plan_for_batch   optimizer/logical_optimization.rs:843
          │   │   （~30 个 OptimizationStage 顺序流水线）
          │   ├ gen_batch_plan                 optimizer/mod.rs:430（物理化）
          │   └ determine_query_mode           query.rs:437（ExecutionModeDecider）
          ├ BatchPlanFragmenter::new           scheduler/plan_fragmenter.rs:199（按 BatchExchange 切 stage）
          └ execute_risingwave_plan            query.rs:548
             ├ local_execute → LocalQueryExecution::stream_rows   scheduler/local.rs（进程内执行）
             └ distribute_execute → QueryManager::schedule       distributed/query_manager.rs:189
                └ QueryExecution::start → QueryStageRunner        distributed/stage.rs:720
                   └ compute_client.create_task（gRPC，叶子 stage 先下发）
```

流作业（CREATE MV）的差异在末端：`handle_create_mv`（create_mv.rs:186）→ `gen_materialize_plan`（optimizer/mod.rs:1172）→ `StreamFragmenter::build_graph_with_strategy`（stream_fragmenter/mod.rs:175）→ `catalog_writer.create_materialized_view` 提交 fragment graph 后挂起等 `wait_version`——catalog 版本与 hummock 快照都就绪才向客户端返回成功。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `SessionImpl::run_one_query` in session.rs:1793 | 简单协议入口 | 隐式事务守卫 |
| `handle` in handler/mod.rs:305 | 语句分发唯一入口 | 编译器强制穷尽 match |
| `gen_batch_query_plan` in query.rs:312 | 批计划生成 | Local/Distributed 裁决 |
| `gen_optimized_stream_plan` in optimizer/mod.rs:641 | 流计划生成 | EOWC/backfill 约束 |
| `generate_fragment_graph` in stream_fragmenter/mod.rs:371 | 切 fragment | dispatcher/parallelism 推导 |
| `QueryManager::schedule` in query_manager.rs:189 | 分布式调度 | fill_batch_query_epoch pin 快照 |
| `run_one_query`（扩展协议为 `parse/bind/execute` in query.rs:130/151） | PREPARE 支持 | ResultCache 分页 |

</details>

## 核心实现

### PlanRoot 五阶段 typestate

优化器最容易犯的错是"在错误的阶段调用错误的 API"。RisingWave 把整个计划生命周期编码进类型系统（optimizer/mod.rs:116）：

```rust
// src/frontend/src/optimizer/mod.rs:116
pub struct PlanRoot<P: PlanPhase> {
    pub plan: PlanRef<P::Convention>,
    _phase: PhantomData<P>,
}
// 两条不交叉的相位链（for_all_phase! 宏，mod.rs:137）：
// Logical → BatchOptimizedLogical → Batch
// Logical → StreamOptimizedLogical → Stream
```

`into_phase` 是唯一的相位跃迁口：`gen_batch_plan` 只能从 `BatchOptimizedLogicalPlanRoot` 调，拿未优化的 `LogicalPlanRoot` 直接调会编译失败。批/流两条链的不相交也由类型保证——批计划永远变不成流计划。

### 启发式流水线优化器（而非 Cascades）

`LogicalOptimizer` 是**固定顺序的 ~30 个 `OptimizationStage`**（logical_optimization.rs），每个 stage 是命名静态常量 + 规则列表，`optimize_by_rules` / `optimize_by_rules_until_fix_point` 两种应用策略。为什么不用 Calcite/Cascades：

1. **全 Rust 技术栈**——Calcite 是 Java，跨语言调用失去类型安全；
2. **流语义规则是 Calcite 没有的**：`FILTER_WITH_NOW_TO_JOIN`（含 now() 谓词转 left-semi join 以便增量计算）、`CONVERT_DISTINCT_AGG_FOR_STREAM`（distinct agg 拆分适配流式）；
3. **可预测性优先**：join ordering 只做 left-deep/bushy 树重排（`LeftDeepTreeJoinOrderingRule`），不搜索全空间；`optimizer_trace` 逐阶段留痕可调试。

批/流两条管线还各有专属步骤。**流管线**受 `enable_share_plan` 开关分叉（logical_optimization.rs:725-743）：开启时走 `common_subplan_sharing` + `prune_share`（MV 间共享公共子计划）；关闭时走 `DAG_TO_TREE` 规则转树 + `ShareSourceRewriter::share_source`——**source 仍强制共享**（注释明说为保证 self source join 的结果正确）。去嵌套后有 `check_apply_elimination`（:654，实现在 plan_visitor/apply_visitor.rs:85）兜底断言所有 Apply 节点已消除。**批管线**独有：`enable_mv_selection()` 开启时 `register_batch_mview_candidates`（:965，筛选依赖为查询子集且不依赖 source 的 MV 候选）+ `BATCH_MV_SELECTION` 规则（用已有 MV 改写查询）；`inline_now_proc_time`（:685，仅批管线——批查询一次性执行可把 now() 内联为常量，流查询必须保持表达式以增量计算）；以及 `DAG_TO_TREE`（batch 不支持 DAG 计划）。

### handler 的巨型 match 与 90 个 DDL 文件

`handle`（handler/mod.rs:305）是唯一的语句分发点，match 到 ~90 个 handler 文件（create_table.rs 111KB、create_source.rs 74KB、create_sink.rs 53KB……）。拆分动机是单文件体量；集中 match 的价值是**AST 变体增删时编译器强制更新此处的穷尽性检查**。配套地 `Binder` 用 `BindFor::{Batch,Stream,Ddl,System}` 区分绑定上下文——同名表在批/流上下文可绑定出不同计划。

### Local/Distributed 双模式 + 双引擎裁决

`gen_batch_query_plan`（query.rs:312）先走硬规则：`must_dist`（UPDATE/DELETE/INSERT..SELECT 强制分布式，因为要写分布式表）与 `must_local`（经 `SysTableVisitor` 检测系统表强制本地）——**两者同时为 true 直接 InternalError**（query.rs:371，"forced to both local and distributed mode"）。都不强制时才由 `ExecutionModeDecider`（query.rs:437）启发式裁决小查询走 frontend 进程内执行省 RPC 往返。另一维度是 `BatchPlanChoice::Rw/Df`：Iceberg 等场景可把逻辑计划转交 DataFusion 执行，失败自动回退（query.rs:353）。

批 fragmenter 侧，`Query` 用 `leaf_stages`/`root_stage_id` 组织 stage 图（plan_fragmenter.rs），`SourceScanInfo::complete(batch_parallelism)`（:385）在 `generate_complete_query` 异步阶段补全 source split 信息。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Typestate | `PlanRoot<P: PlanPhase>` in optimizer/mod.rs:116 | 相位跃迁编译期约束 |
| 服务定位器 | `FrontendEnv` in session.rs:145 | trait object 注入 + mock 测试 |
| 管道+规则 | `OptimizationStage` 常量 in logical_optimization.rs | 顺序可预测、可 trace |
| Visitor | `ExecutionModeDecider` 等 in optimizer/plan_visitor/ | 模式裁决不侵入 plan 节点 |
| RAII Guard | `StreamingJobGuard` in scheduler/streaming_manager.rs:67 | 会话断开自动注销创建中的作业 |
| 观察者 | `FrontendObserverNode` + watch channel | catalog 版本推进唤醒 wait_version |

## 模块间交互

下行全部 gRPC：`MetaClient`（DDL/流作业/心跳/快照，meta_client.rs）、`ComputeClientPool`（批任务 create_task）。上行是 meta 的 NotificationService 推送 → observer 更新本地 catalog 缓存。frontend 也依赖 `risingwave_batch`（root stage 与 Local 执行复用执行引擎）、`risingwave_sqlparser`（AST）、`risingwave_connector`（source WITH 校验与 split 补全）。frontend 自身暴露 `FrontendService` gRPC 供 meta 反向调用（如 cancel）。

## 扩展方式

**新增一种 DDL**：sqlparser 加 `Statement` 变体 → `binder/statement.rs` 加分支 + 新 `BoundCreateX` → `CatalogWriter` trait 加方法 → 新建 `handler/create_x.rs` → `handler/mod.rs:305` 的 match 加分发臂（编译器强制）→ `show.rs`/`drop_*.rs` 配套。

**新增一条优化规则**：`optimizer/rule/` 实现 `Rule` trait（`matches` + `apply`）→ 挂进 `logical_optimization.rs` 对应 stage 的规则列表；流/批语义不同时参考 `CONVERT_DISTINCT_AGG_FOR_STREAM/_FOR_BATCH` 的双实例写法。
