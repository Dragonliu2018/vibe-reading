---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "执行器与调度器"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 执行器解读：push 模型物理算子与 OperatorState、FragmentBuilder 的计划切片、FragmentContext/FragmentTask 的 morsel 并行调度、PhysicalFusion 的 RRF/加权融合与 BM25 串行设计"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/executor/`（3 万行）+ `src/scheduler/`（2 千行但 `fragment_context_impl.cpp` 高达 72KB）构成 Infinity 的执行引擎：90+ 个物理算子、物理规划器（LogicalNode → PhysicalOperator）、FragmentBuilder（物理树切分成可并行片段）、TaskScheduler（固定 worker 池的 morsel 驱动调度）。

执行模型是 **push 而非经典火山拉模型**——`PhysicalOperator::Execute(QueryContext*, OperatorState*)` 的注释明说 "for push based execution"，返回 bool 表示"本次调用是否干了实事"，为 false 则 FragmentTask 停止推进下游算子。数据以 `DataBlock`（8192 行的列批）为单位在算子间推送。

一个重要的能力边界：**v0.7.3 的 fragment 化执行不支持 join**——`FragmentBuilder::BuildFragments` 中 Join/UnionAll/Intersect/Except/CrossProduct 直接 `UnrecoverableError("Not support")`（算子文件存在但未接入流水线）。join 查询走的是单 fragment 串行路径。

---

## 模块架构

```text
src/executor/
├── physical_planner.cppm/_impl       LogicalNodeType 大 switch → 50+ 个 BuildXxx（并行 merge 结构在此植入）
├── fragment_builder.cppm/_impl       物理树 → PlanFragment DAG（切片规则）
├── physical_operator.cppm/_impl      PhysicalOperator 基类
├── operator_state.cppm/_impl         OperatorState + ~40 个子类 + SourceState/SinkState 两族
├── operator/                          90+ 个物理算子
│   ├── physical_scan/                 表扫描 + KNN/Tensor/Sparse/MergeKnn 扫描
│   ├── physical_match_impl.cpp       全文检索算子（25KB）
│   ├── physical_fusion_impl.cpp      混合搜索融合算子（25KB）
│   ├── physical_top / merge_top ...  TopN 及其 merge 变体
│   └── physical_sink_impl.cpp        Sink：结果落地/跨 fragment 入队
└── fragment/plan_fragment.cppm       PlanFragment：sink + operators + source
src/scheduler/
├── task_scheduler.cppm/_impl         TaskScheduler：每 worker 专用队列 + pinned 线程
├── fragment_context.cppm/_impl       FragmentContext：调度单位（72KB 接线枢纽）
├── fragment_task.cppm/_impl         FragmentTask：worker 上的最小执行单元
└── task_result.cppm                  任务结果
```

三种 FragmentContext 对应三类片段：`SerialMaterializedFragmentCtx`（含 KnnScanSharedData）、`ParallelMaterializedFragmentCtx`、`ParallelStreamFragmentCtx`。`Notifier`（`fragment_context.cppm:57`）是全查询级 countdown latch。

---

## 调用链路

![Fragment 切分与并行执行](/vibe-reading/images/articles/infinity-internals/fragment-execution.svg)

完整执行模型（驱动入口在 `QueryContext::QueryStatementInternal`）：

```text
physical_planner_->BuildPhysicalOperator(logical_plan)     physical_planner_impl.cpp:151
  巨型 switch + 递归；并行 merge 结构在此植入（见下）
fragment_builder_->BuildFragment(physical_plan_ptrs)       fragment_builder_impl.cpp:39
  每个 Merge 算子处切 fragment、插 kLocalQueue sink/source
FragmentContext::BuildTask(this, nullptr, fragment, notifier)   fragment_context_impl.cpp:459
  ├─ CreateTasks(parallel_size, ...)                        :1210
  │    parallel_count = min(cpu_number_limit, source 算子 TaskletCount)
  │    kTableScan → PlanBlockEntries(parallel_count) 把 GlobalBlockID 均分给各 task
  │    kKnnScan   → InitKnnScanFragmentContext 构造 KnnScanSharedData（block job + 索引 chunk 双队列）
  ├─ MakeTaskState（190 行 switch，:237）为每 task 每算子构造 OperatorState 子类
  └─ 连线（:504-539）：算子间 ConnectToPrevOutputOpState；
       子 fragment 的 QueueSinkState 对接父 fragment 每个 task 的 QueueSourceState
scheduler_->Schedule(plan_fragment, stmt)                   task_scheduler_impl.cpp:121
  ├─ GetStartFragments 取叶子 fragment → task->TryIntoWorkerLoop()（CAS 防重复入队）
  ├─ FindLeastWorkloadWorker → ScheduleTask 入该 worker 专用队列
  └─ 非 SELECT 单任务语句（DDL/INSERT）直接调用线程 RunTask 内联执行（:150-161）
[worker 线程] FragmentTask::OnExecute                      fragment_task_impl.cpp:47
  source_op->Execute(source_state)                          源推进（如从队列拉数据）
  for op_idx 从 source 侧向 sink 侧：
      op->InputLoad(...); done = op->Execute(query_context, state)
      if (!done) break          // 本轮没有实际产出，停止推进
  if (done) sink_op->Execute(sink_state)
[完成传播] CompleteTask → TryFinishFragment                fragment_context_impl.cpp:585
  所有 task 完成 → 父 fragment 的 unfinished_child_n_ 减到 0 → 调度父
  kParallelStream 特例：子 fragment 每发过数据就提前调度父（流水线重叠）
```

**算子间数据通道**：任务内，算子 A 的输出写 `A->state->data_block_array_`，下游算子 B 通过 `B->state->prev_op_state_` 直接读（零拷贝共享）。跨 fragment，`PhysicalSink::FillSinkStateFromLastOperatorState` 把末算子 state 的 DataBlock 包装成 `FragmentData` 入队父 fragment 各 task 的 `BlockingQueue`。

**背压/提前终止**：`if (!next_fragment_queue->Enqueue(fragment_data)) task_operator_state->SetComplete();`——BlockingQueue 满即认为下游已收够数据，直接置完成（LIMIT 语义下沉的通道）。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `PhysicalPlanner::BuildPhysicalOperator` | `physical_planner_impl.cpp:151` | 逻辑→物理，50+ case |
| `PhysicalPlanner::BuildTop` | `physical_planner_impl.cpp:813` | TaskletCount>1 时套 MergeTop |
| `FragmentBuilder::BuildFragments` | `fragment_builder_impl.cpp:100` | 切片规则大 switch |
| `FragmentContext::BuildTask` | `fragment_context_impl.cpp:459` | 建 context/task/state 并连线 |
| `FragmentContext::CreateTasks` | `fragment_context_impl.cpp:1210` | 并行度决定 + morsel 分发 |
| `FragmentContext::TryFinishFragment` | `fragment_context_impl.cpp:585` | 完成传播 + 父调度 |
| `FragmentTask::OnExecute` | `fragment_task_impl.cpp:47` | 单次流水线推进 |
| `TaskScheduler::Schedule` | `task_scheduler_impl.cpp:121` | 入队调度 + 内联优化 |
| `TaskScheduler::WorkerLoop` | `task_scheduler_impl.cpp:223` | worker 主循环 |
| `FragmentTask::TryIntoWorkerLoop` | `fragment_task_impl.cpp:127` | kPending→kRunning CAS |

</details>

---

## 核心实现

### 为什么切 Fragment 而非整树执行

三个理由，每个都有代码支撑：

1. **流水线并行**——TableScan fragment 标 `kParallelStream`，数据一到就唤醒父 fragment（`TryFinishFragment` 的 sent_data 分支，`fragment_context_impl.cpp:591-614`），扫描与下游算子重叠执行。
2. **数据缩减先于交换**——每个并行 task 先局部收敛（Top/KNN 的局部 top-N、Aggregate 的局部哈希聚合），只把**局部结果**经 kLocalQueue 送入单 task 的 Merge fragment，避免整表 shuffle。
3. **调度粒度独立**——每 fragment 自主决定并行度，Scan fragment 可以 N 并行而 Merge fragment 固定 1 task。

### 并行 merge 树：TopN 的例子

`BuildTop`（`physical_planner_impl.cpp:813-860`）检查 `input_physical_operator->TaskletCount() <= 1`：单线程只建 `PhysicalTop`；否则建局部 `PhysicalTop(offset=0)`（作为并行子树的末算子）套一层 `PhysicalMergeTop(应用真实 offset)`（串行父 fragment 首算子）。同一模式用于 Limit→MergeLimit、KNN→MergeKnn、MatchTensorScan→MergeMatchTensor、Sort/Aggregate。

Aggregate 变体按哈希区间切：并行侧 `AggregateSourceState{hash_start_, hash_end_}`（`GetHashRanges(parallel_count)`，`fragment_context_impl.cpp:741-767`）；DISTINCT 场景用 HashAggregate（局部去重）+ MergeHashAggregate（全局去重）两级——`fragment_builder_impl.cpp:149-155` 注释完整描述了该结构。

### PhysicalFusion：混合检索的汇合点

`PhysicalFusion`（`physical_fusion_impl.cpp`）是 n 叉算子：`left_ + right_ + other_children_`，每个孩子在 FragmentBuilder 各切一个子 fragment，结果按 `fragment_id` 汇入 `FusionOperatorState::input_data_blocks_`（map），等 `input_complete_`（所有孩子 task 数耗尽）才一次性计算：

- **RRF**（`physical_fusion_impl.cpp:229-237`，注释引 Elasticsearch 文档）：`score = Σ_i 1/(rank_constant + rank_i)`，`rank_constant` 默认 60 可由 option 覆盖；
- **WeightedSum**（`:339-340`）：`score = Σ_i w_i · normalize(child_score_i)`，归一化支持 none/atan/min_max/l2_norm 四种（默认 min_max）；并处理**方向翻转**——KNN 的 top-N 可能是 min-heap（距离越小越好），非 min-heap 的路用 `score *= -1` 或 `1 - score` 翻转（`:326-332`），heap 方向由孩子算子类型静态推断（`IsKnnMinHeap()`，`:249-277`）；
- **MatchTensor 融合** = 二阶段 rerank：一路结果去重后按 RowID 排序（保证 buffer_manager 顺序访问局部性），用 tensor 列重算分数再全局排序；
- 输出统一追加两个隐藏列 `score`（float）+ `row_id`（`:372-380`）。

### PhysicalMatch 为什么串行

`PhysicalMatch::TaskletCount()` 返回 1（`physical_match.cppm:64`），fragment 固定 `kSerialMaterialize` + EmptySourceState。原因：BM25 打分需要全局 doc 频统计，并行化被推迟到**倒排索引迭代器内部**（`CreateQueryIterators` 支持 `early_term_algo_`、`begin_threshold_`、BMW vs batch/naive 双跑校验路径，`:170-230`）而非算子层。流程：`QueryBuilder` 构建查询树 → 迭代器打分入 `FullTextScoreResultHeap(topn)` → `OutputToDataBlockHelper` 批量组织行重构作业。

### KNN 扫描的任务切分

`InitKnnScanFragmentContext` 构造 `KnnScanSharedData`：把 block 扫描 job 和索引 chunk job 都登记为原子计数器（`current_block_idx_/current_index_idx_`），各 task 抢占式消费——无索引列走 brute force 块扫描，有索引列走 chunk 搜索，两者在同一个 task 内混跑。搜索结果三层归并：chunk/mem_index 内 heap → task 内 merge_heap → task 间 PhysicalMergeKnn。

### 调度细节：worker 亲和与内联执行

worker 数 = `min(hardware_concurrency, config.CPULimit)`，线程按 CPU pin（偶数 CPU 优先排布，`task_scheduler_impl.cpp:67-83`）；初次入队用最小负载 worker，**重调度保持 worker 亲和**（`ScheduleFragment` 优先 `task_ptr->LastWorkerID()`，`:208-215`）；非 SELECT 单任务语句内联执行省一次线程切换。`WorkerLoop` 批量取任务到本地列表轮转（天然时间片），流式 fragment 队列空时 `QuitFromWorkerLoop()` 把 task 退回 kPending 让出 worker。

### fragment_context_impl.cpp 为何 72KB

它是全模块的"接线枢纽"：`MakeTaskState`（190 行 switch）、`MakeSourceState`（235 行）、`MakeSinkState`（253 行）、KNN/Compact 的 fragment 级共享数据初始化、三种 fragment 的结果组装。**每种新算子都要在这里加 3 个 case**——集中式注册的代价（也是单点，改并行度逻辑先看这里）。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Push 算子模型（火山变体） | `PhysicalOperator::Execute`（`physical_operator.cppm:64`） | DataBlock 批推送，缓存友好 |
| Exchange/Pipeline（类 MPP） | Merge 算子处切 fragment、插 kLocalQueue（`fragment_builder_impl.cpp:219-265`） | 本地 exchange 通道 |
| Morsel-driven 并行 | `TaskletCount() = block 数`；`PlanBlockEntries` 均分 | 数据驱动并行，天然负载均衡 |
| 任务/算子双层状态机 | `FragmentTaskStatus{kPending→kRunning→kFinished/kError}` + 算子 `complete_` 标志 | 两级推进控制 |
| 生产者-消费者 | `QueueSourceState::source_queue_` ↔ `QueueSinkState` | BlockingQueue 背压 |
| Countdown Latch | `Notifier` + `unfinished_task_n_/unfinished_child_n_` 原子倒计时 | 全查询完成同步 |
| 策略模式（融合算法） | `FusionMethod{kRRF, kWeightedSum, kMax, kMatchTensor}` 字符串选择 | 融合方法可配置 |

---

## 模块间交互

- **QueryContext**：提供 `cpu_number_limit()`（决定并行度）、`scheduler()`（FragmentContext 回调调度父 fragment）、`FlushProfiler`；执行完 `CommitTxn()`。
- **storage**：算子经 `base_table_ref_` 携带 `block_index_`（BlockIndex：segment→block 物理映射）与 `column_ids_`；TableScan 用 `TableScanFunctionData{block_index_, global_block_ids_}` 直读存储；`PhysicalMatch` 持 `index_reader_`（ColumnIndexReader）；KnnScan 在 planner 阶段调 `PlanWithIndex` 从 catalog 解析索引提示；`common_query_filter_`（来自 txn 可见性/谓词）被包装为 `FilterQueryNode` 注入全文检索迭代器。
- **function/expression**：`ExpressionState`/`ExpressionEvaluator` 驱动 Project/Filter/Top 的表达式求值；聚合并行按哈希区间切。
- **结果缓存**：`PhysicalMatch`/KNN 类算子 `cache_result_=true`，配合 `ResultCacheManager`/`CachedMatch`。

---

## 扩展方式

**新增一个物理算子**需改 7 处（全部已核实）：`physical_operator_type.cppm` 加枚举 → `operator_state.cppm` 定义 XxxOperatorState → `operator/physical_xxx.cppm/_impl.cpp` 实现类 → `physical_planner.cppm` 声明 BuildXxx + switch 加 case（含 TaskletCount>1 时是否套 Merge 层的判断）→ `fragment_builder_impl.cpp` 的 BuildFragments switch 加 case（决定 FragmentType/source 类型/是否切子 fragment）→ `fragment_context_impl.cpp` 的 MakeTaskState/MakeSourceState/MakeSinkState **三处各加 case** → 视情况改 `physical_sink_impl.cpp` 与 `explain_fragment_impl.cpp`。漏掉任何一处 switch，运行期直接 `UnrecoverableError`（这些 switch 的 default 都抛错，可尽早发现）。

**修改并行度调度**：全局上限在 `FragmentContext::BuildTask` 的 `parallel_size = query_context->cpu_number_limit()`（`fragment_context_impl.cpp:486`）；单算子并行度改该算子 `TaskletCount()`；morsel 切分策略改 `PlanBlockEntries`；worker 亲和/负载均衡改 `TaskScheduler` 的三个方法。
