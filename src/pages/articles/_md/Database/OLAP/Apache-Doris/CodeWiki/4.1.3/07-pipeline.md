---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Pipeline 执行引擎"
date: "2026-08-23T18:34:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Pipeline", "Pull模型", "向量化", "MLFQ调度"]
description: "Doris Pipeline 执行引擎：物理计划编译为 Operator DAG、Pull 模型流水线、MLFQ 多核 Work Stealing 调度。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

Pipeline 执行引擎（`be/src/exec/` + `be/src/pipeline/`，~10.6 万行）把物理计划编译成向量化 Operator DAG，用 Pull 模型流水线执行。它替代了旧的 Volcano push 模型，将阻塞算子显式化为独立 Pipeline + Dependency，支持时间片调度与异步等待。独立成文是因为执行调度模型独立于算子实现——它回答"计划怎么切成可并行流水线、怎么调度、怎么阻塞唤醒"。

## 模块架构

模块核心是 `Pipeline`（算子链容器）、`OperatorX`（Source/Sink 抽象）、`PipelineFragmentContext`（编译物理计划为 DAG）、`PipelineTask`（调度执行最小单元）、`Dependency`（阻塞唤醒同步原语）。

```
PipelineFragmentContext (管理一个 Fragment 生命周期)
  ├─ _build_pipelines → _create_operator (switch TPlanNodeType 构造算子)
  │    遇到阻塞算子(Agg/Sort/HashJoin) → add_pipeline 新建独立 Pipeline + 记录 _dag
  ├─ _build_pipeline_tasks → 创建 PipelineTask + RuntimeState + inject_shared_state
  └─ submit → HybridTaskScheduler

Pipeline (算子链 [Source → ... → Sink], 共享 OperatorX)
  └─ PipelineTask (每个并行实例, 状态机 INITED→RUNNABLE→BLOCKED→FINISHED→FINALIZED)
       ├─ _root → get_block_after_projects (Pull 拉 Block)
       └─ _sink → sink (Push Block)

OperatorXBase → OperatorX<LocalState> / DataSinkOperatorX<LocalState>
  ├─ StreamingOperatorX (一进一出: child.get_block → pull)
  └─ StatefulOperatorX (一对多: push → pull, need_more_input_data 控制)
```

## 调用链路

Fragment → Pipeline DAG → 执行：

```
FragmentMgr::exec_plan_fragment (runtime/fragment_mgr.cpp:628)
  → PipelineFragmentContext::prepare (pipeline_fragment_context.cpp:331)
    → _build_and_prepare_full_pipeline (pipeline_fragment_context.cpp:283)
      ├─ add_pipeline (root)
      ├─ _build_pipelines (line 673) → _create_tree_helper → _create_operator (line 1284)
      │    OLAP_SCAN_NODE → OlapScanOperatorX (line 1308)
      │    AGGREGATION_NODE → AggSourceOperatorX + 新建 pipeline set AggSinkOperatorX (line 1364)
      │    HASH_JOIN_NODE → HashJoinProbeOperatorX + 新建 build_side_pipe set HashJoinBuildSinkOperatorX (line 1480)
      │    SORT_NODE → SortSourceOperatorX + SortSinkOperatorX (line 1600)
      ├─ _create_data_sink (ResultSink/ExchangeSink)
      ├─ _plan_local_exchange
      ├─ pipeline->prepare
      └─ _build_pipeline_tasks (line 555) → 创建 PipelineTask + RuntimeState + inject_shared_state
  → PipelineFragmentContext::submit (line 1805)
    → HybridTaskScheduler.submit → TaskScheduler::_do_work (task_scheduler.cpp:98)
      → MultiCoreTaskQueue.take → task->execute (pipeline_task.cpp:451)
        → _root->get_block_after_projects(state, block, &eos) (line 648)
        → _sink->sink(state, block, eos) (line 720)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `PipelineFragmentContext.prepare` | 编译+构建 task | _build_pipelines + _create_operator |
| `_create_operator` | switch TPlanNodeType | 阻塞算子触发 add_pipeline |
| `PipelineTask.execute` | Pull 模型循环 | 时间片 yield + 三阶段阻塞检查 |
| `OperatorXBase.get_block_after_projects` | 拉数据+投影 | get_block→get_block_impl→pull |
| `StreamingOperatorX.get_block_impl` | 一进一出 | child.get_block → pull |
| `StatefulOperatorX.get_block_impl` | 一对多 | push→pull, need_more_input_data |
| `Dependency.is_blocked_by` | 检查阻塞 | 加入 _blocked_task 列表 |
| `Dependency.set_ready` | 唤醒 | 唤醒所有等待 task |

</details>

## 核心实现

### Pull 模型拉取

Pipeline 采用 **Pull 模型**：从 root 算子开始通过 `get_block_impl` 递归向 source 端拉数据。`StreamingOperatorX`（`exec/operator/operator.cpp:698`）一进一出——`child->get_block_after_projects` 向下拉后 `pull` 处理输出；`StatefulOperatorX`（`operator.cpp:705`）一对多（如 HashJoin probe）——`need_more_input_data` 时 `push` 子 Block 进内部状态，不需要时 `pull` 产出。旧 Volcano push 模型缺乏 pipeline 切分、无法表达阻塞算子、不支持细粒度时间片，Pipeline pull 模型把阻塞点显式化为独立 Pipeline + Dependency 使异步等待成为一等公民。

```cpp title="exec/pipeline/pipeline_task.cpp (执行循环简化)"
while (!fragment_context->is_canceled()) {
    if (_is_blocked() || _wake_up_early) return OK;  // 阻塞退出
    if (time_spent > _exec_time_slice) break;        // 时间片用完 yield
    if (!_eos && _block->empty())
        _root->get_block_after_projects(_state, block, &eos);  // PULL
    if (!_block->empty() || _eos)
        _sink->sink(_state, block, _eos);                      // PUSH
}
```

### Operator DAG 切分

Pipeline 间通过 `_dag`（`PipelineId → [PipelineId]`）记录依赖。`_create_operator` 遇到需阻塞的算子就 `add_pipeline` 创建新 pipeline 并记到 `_dag`。如 HashJoin（`pipeline_fragment_context.cpp:1480`）：probe 算子留在当前 pipeline，新建 `build_side_pipe` set `HashJoinBuildSinkOperatorX`；Agg 新建上游 pipeline set `AggSinkOperatorX`。`_build_pipeline_tasks_for_instance`（`:513`）遍历 `_dag` 注入 `SharedState`（`AggSharedState`/`HashJoinSharedState`），下游 task 通过 `inject_shared_state` 拿到上游 sink 产出的共享状态。

### PipelineTask 状态机与三阶段阻塞

`PipelineTask` 状态机（`pipeline_task.h:294`）：`INITED → RUNNABLE → BLOCKED → FINISHED → FINALIZED`。三阶段阻塞检查：`_wait_to_start`（执行前检查 `_execution_dependencies`，含 FE 2PC + RuntimeFilter + tablet 加载）、`_is_blocked`（执行中检查 `_read_dependencies` 上游数据就绪 + `_write_dependencies` sink 写入就绪 + `_memory_sufficient_dependency` 内存预留）、`_is_pending_finish`（执行后检查 `_finish_dependencies` 异步写入完成）。task 被阻塞时 `Dependency::is_blocked_by`（`dependency.h:123`）把 task 加入 `_blocked_task`，上游 `set_ready` 唤醒。

### MLFQ 多核 Work Stealing 调度

`PriorityTaskQueue`（`task_queue.h:71`）6 级子队列，时间阈值 `1s/3s/10s/60s/300s`，task 按累计运行时间放对应级别，用 vruntime 调度实现公平性——长任务自动降级。`MultiCoreTaskQueue`（`task_queue.h:108`）每核一个 `PriorityTaskQueue`，空闲时 `_steal_take`（`task_queue.cpp:198`）从其他核偷 task。`HybridTaskScheduler`（`task_scheduler.h:81`）分 `_blocking_scheduler` 和 `_simple_scheduler`——blockable task（含 scan/异步 IO）提交 blocking，避免 IO 阻塞型 task 占满计算线程。

### RuntimeFilter 下推

RuntimeFilter 在 build 侧（HashJoin build）产生，下推到 scan 侧作过滤条件。`RuntimeFilterConsumer` 状态机（`runtime_filter_consumer.h:37`）`NOT_READY (→TIMEOUT) → READY → APPLIED`。`RuntimeFilterTimer` 绑定 `Dependency`，scan 算子 `_wait_to_start` 检查 `_execution_dependencies`，超时后自动放行。`ScanLocalStateBase`（`scan_operator.h:90`）的 `update_late_arrival_runtime_filter` 处理迟到的 runtime filter。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pull 模型 | `pipeline_task.cpp` | 阻塞算子显式化，支持时间片与异步 |
| Operator DAG | `_dag` + `add_pipeline` | 阻塞点切分独立 Pipeline |
| 状态机 | `PipelineTask._exec_state` | 三阶段阻塞检查驱动流转 |
| MLFQ + Work Stealing | `PriorityTaskQueue`/`MultiCoreTaskQueue` | 公平调度 + 多核负载均衡 |
| 策略 | `StreamingOperatorX`/`StatefulOperatorX` | 区分一进一出与一对多算子 |

## 模块间交互

被 `runtime` 驱动（`FragmentMgr`（`runtime/fragment_mgr.cpp:628`）接收 `TPipelineFragmentParams` 创建 `PipelineFragmentContext`，`ExecEnv` 提供 `FragmentMgr`/`TaskScheduler`/`WorkloadGroupManager`，`QueryContext` 持 `query_mem_tracker`/`exec_status`）；调 `storage`（`OlapScanOperatorX`→`ScannerContext`→`OlapScanner`→`Tablet::capture_rs_readers`，`ScanLocalStateBase` 持 `_scan_dependency`，scanner 异步产出 Block 后 dependency 唤醒 task，`ScannerScheduler` 独立线程池运行）；调 `exprs`（`PipelineXLocalStateBase` 持 `_conjuncts`/`_projections`，`get_block_after_projects` 先 `get_block` 再 `do_projections`，`filter_block` 用 `VExprContext`）；调 `core`（`Block` 列式容器，`PipelineTask` 持 `_block` 每次循环 `clear_column_data` 复用）。

## 扩展方式

新增一个物理算子：新建 `be/src/exec/operator/xxx_operator.h` 定义 `XxxLocalState`（继承 `PipelineXLocalState<SharedState>`）和 `XxxOperatorX`（继承 `OperatorX`/`StreamingOperatorX`/`StatefulOperatorX`，实现 `get_block_impl`/`pull`/`push`）；blocking 算子还需 `XxxSinkOperatorX`（继承 `DataSinkOperatorX`，实现 `sink_impl`/`create_shared_state`）+ `SharedState`（继承 `BasicSharedState` in `dependency.h`）；`pipeline_fragment_context.cpp` 的 `_create_operator` switch 加 `TPlanNodeType::XXX_NODE` 分支（参考 `:1364` Agg 或 `:1480` HashJoin 模式：构造 operator + 新建 pipeline + 设 DAG 依赖）；`CMakeLists.txt` 加文件。

新增 Scan 源：新建 `be/src/exec/scan/xxx_scanner.h/.cpp` 继承 `Scanner`（实现 `prepare`/`_open_impl`/`get_block`/`close`）；新建 `be/src/exec/operator/xxx_scan_operator.h` 继承 `ScanOperatorX<Derived>`；`_create_operator` 加 `XXX_SCAN_NODE` 分支（参考 `:1308` OlapScan）。

修改并行调度：`task_queue.h` 调整 `SUB_QUEUE_LEVEL`/`_queue_level_limit`（MLFQ 级别阈值）或 `_steal_take`（work stealing 策略）；`task_scheduler.h` 调 `HybridTaskScheduler` 线程数比例；`pipeline_task.cpp` 的 `_exec_time_slice`（`config::pipeline_task_exec_time_slice`）调时间片。
