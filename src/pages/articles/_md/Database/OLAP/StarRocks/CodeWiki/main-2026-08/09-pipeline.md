---
source:
  type: "源码解读"
  project: "StarRocks"
  url: "https://github.com/StarRocks/starrocks"
title: "Pipeline 执行引擎"
date: "2026-09-26T22:04:32+08:00"
category: [Database, OLAP, StarRocks, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["StarRocks", "Pipeline", "向量化执行", "pull 模型", "Driver 调度", "spill", "exchange"]
description: "StarRocks BE Pipeline 执行引擎：Operator 非阻塞状态机、8 级反馈队列 Driver 调度、PipelineBuilder 构建链与 spill 落盘。"
readingTime: "17 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`be/src/exec/`（8.8 万行）+ `exec_primitive/` + `orchestration/` 构成的向量化 pull 模型执行引擎。它独立成篇因为执行模型自成体系：算子接口、调度器、构建链、数据传输（exchange）、落盘（spill）环环相扣，且当前 HEAD 正处于一次进行时重构——四层拆分（`exec_primitive` 核心抽象 / `exec` 具体算子 / `exec/runtime` 运行时 / `orchestration` 入口）是模块边界清单的直接产物。

## 模块架构

四层：

| 层 | 内容 |
| --- | --- |
| `exec_primitive/` | 核心抽象：`Operator`/`OperatorFactory`/`ExecNode`/`MorselQueue`（无具体算子依赖） |
| `exec/` | 具体算子（join/aggregate/sort/scan/exchange）与 pipeline 组装 |
| `exec/runtime/` | `Pipeline`/`PipelineDriver`/`FragmentContext` 运行时对象 |
| `orchestration/` | `FragmentExecutor`/`FragmentMgr` 入口（thrift 计划 → 执行） |

数据以 **Chunk（列式批）** 在算子间移动（见 [10 向量化](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/10-vectorization)）。

## 调用链路

### 计划到 Driver 的构建链

```text
internal_service exec_plan_fragment
  → orchestration/fragment_executor.cpp _prepare_pipeline_driver (:758 起)
      TExecPlanFragmentParams → ExecNode 树（ExecNode::create_tree）
      → plan->decompose_to_pipeline(&context)     # 虚方法（exec_primitive/exec_node.h:160），
                                                   #   每个物理节点递归返回 OpFactories
      → DataSink::decompose_data_sink_to_pipeline  # 最终 sink
      → PipelineBuilder(context).build()           # 产出 PipelineGroup + Pipeline 列表
  → pipeline_driver_instantiator.cpp instantiate_pipeline_drivers
      按 DOP 循环 pipeline->create_operators(dop, i) 克隆 dop 个 PipelineDriver
      （factory 模式实现 per-driver 实例），挂 MorselQueue
  → driver_limiter()->try_acquire(total_dop())   # driver token 准入，防查询过载
```

`FragmentExecutor.prepare()` 的完整序列是 `_prepare_query_ctx → _prepare_fragment_ctx → _prepare_workgroup → _prepare_runtime_state → _prepare_global_dict → _prepare_exec_plan → _prepare_pipeline_driver → _prepare_stream_load_pipe`——`_prepare_pipeline_driver` 之前还有一串环境准备步骤。

`Pipeline`（`exec/runtime/pipeline.h:33`）= OpFactories 链。builder 侧有大量插值算子（`pipeline_builder_operators.cpp` 的 `maybe_interpolate_local_shuffle_exchange`、`interpolate_grouped_exchange` 等）用于 pipeline 间对齐 DOP；跨 pipeline 共享状态（如聚合 hash 表）经 `ContextWithDependency`（`exec/pipeline/context_with_dependency.h`）+ `ConjugateOperator`（sink/source 配对算子）传递。

### Operator 非阻塞接口

```cpp title="exec_primitive/pipeline/operator.h（生命周期注释 :58-102）"
prepare → finishing → finished → [cancelled] → closed
// 四个纯虚谓词 + 两个数据方法：
bool has_output();                       // 能否拉（非阻塞探测，永不等待）
bool need_input();                       // 能否推
ChunkPtr pull_chunk(RuntimeState*);
Status  push_chunk(RuntimeState*, ChunkPtr);
// EOS/关流协议（幂等）：
set_finishing / set_finished / set_cancelled / is_finished / pending_finish
// 停车：block_reason() / covered_wakeups()（阻塞原因位图，配合 EventScheduler 唤醒）
```

**与 Volcano 的差异及动机**：Volcano 的 `open()/get_next()` 是同步阻塞调用，调度者无法抢占；StarRocks 把"取一批数据"拆成 `has_output→pull_chunk`（生产侧）和 `need_input→push_chunk`（消费侧）两个非阻塞步骤，由调度器在 driver 循环里撮合。单机高并发（数千 driver 共享线程池）下任何阻塞调用都会钉死线程——谓词接口让调度器把不 ready 的 driver 挂到 poller 而非阻塞线程。

### Driver 调度

`exec/pipeline/pipeline_driver_executor.cpp`（434 行）：

- **线程模型**：单线程池（`driver_executor_factory.cpp` 用 `ThreadPoolBuilder("pip_exec_"+name)`）；无独立 compute/io 双池，IO 卸载到算子内部线程（如 OlapScanOperator，operator.h:319-321 注释）。
- **就绪队列**：`QuerySharedDriverQueue`——**8 级多级反馈队列**（`QUEUE_SIZE = 8`），第 i 级时间片按累加式 `time_slice += LEVEL_TIME_SLICE_BASE_NS * (i+1)` 计算（`pipeline_driver_queue_level_time_slice_base_ns` 默认 200ms，各级约 0.2/0.6/1.2/…/7.2s），`update_statistics` 按累计耗时降级，防长查询饿死短查询；workgroup 模式换 `WorkGroupDriverQueue`（资源组隔离）。
- **阻塞处理**：`process()` 返回 DriverState；`INPUT_EMPTY/OUTPUT_FULL/PENDING_FINISH/PRECONDITION_BLOCK` 进 `PipelineDriverPoller`（独立线程轮询重唤醒）；`LOCAL_WAITING` 进 worker 的 `local_driver_queue`（本地重查，超 `LOCAL_MAX_WAIT_TIME_SPENT_NS` 再降级到 poller——降低唤醒延迟的关键优化）；新实验路径 `EventScheduler`（`exec/runtime/schedule/event_scheduler.h`）用事件边替代轮询。
- driver 内核循环：`exec/runtime/pipeline_driver.cpp::PipelineDriver::process()`（:351 起）逐对算子 `curr_op->pull_chunk → next_op->push_chunk`，chunk 超 `runtime_state->chunk_size()` 直接报错。

## 核心实现

### Exchange（跨 BE 数据流）

`exec/pipeline/exchange/exchange_sink_operator.cpp`：**brpc**（非 gRPC）`PInternalService_RecoverableStub::transmit_chunk`，chunk 序列化为 protobuf `PTransmitChunkParams` + `butil::IOBuf` 零拷贝 attachment（`construct_brpc_attachment`），经 `SinkBuffer` 异步批量发送（攒批阈值 `config::max_transmit_batched_bytes`，超限才真正发 RPC）；本机对端走本地短路（pass through，不经网络）；EOS 包以 `DEFAULT_DRIVER_SEQUENCE` 发出。HASH_PARTITIONED 场景按 `_exchange_hash_function_version` 在 xxh3 与 fnv 间选择哈希函数。接收端 `ExchangeSourceOperator` 从 brpc server 填充的 RawChunkQueue 拉 chunk。另有 LocalExchange 家族（shuffle/broadcast/passthrough，DOP 重组）与 `mem_limited_chunk_queue.cpp` 背压。

### Spill（以聚合为例）

`exec/pipeline/aggregate/spillable_aggregate_blocking_sink_operator.h`：装饰器模式继承 `AggregateBlockingSinkOperator`，`spillable()=true`；触发在 `_try_to_spill_by_auto`（`spill::OperatorMemoryResourceManager` 水位策略，`SpillStrategy::SPILL_ALL`）与 `_try_to_spill_by_force`。落盘不直接写，而是把 `_build_spill_task()` 产生的 `SpillProcessTask` 塞进 `SpillProcessChannel`（阻塞队列），由独立的 **SpillProcessOperator**（SourceOperator 子类）组成专用 spill pipeline 经 `spill::Spiller` 写 FileSystem。恢复：`SpillableAggregateBlockingSourceOperator` 读回分片数据做 merge/再聚合（多轮 spill-replay，轮数控制细节待核实）。`operator.h:224` 的 `spillable()/releaseable()/set_execute_mode` 是统一内存回收接口。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | Operator 生命周期（operator.h 注释块）+ DriverState 流转（pipeline_driver_executor.cpp:232-259） | 非阻塞调度的正确性基础 |
| Factory Method | `OperatorFactory`（按 driver_sequence 克隆算子）；`driver_queue_factory.cpp` | per-driver 实例与跨 driver 共享 context 的分离 |
| 模板方法 | `Operator::prepare()` 调虚 `prepare_local_state()`（:62-65）；`PipelineDriver::process()` 固化 pull/push 撮合骨架 | 骨架稳定，行为下沉 |
| 装饰器 | `SpillableAggregateBlockingSinkOperator : AggregateBlockingSinkOperator`；`MultilaneOperator` | spill/多 lane 是正交增强 |
| Observer | `Pipeline : DriverObserver::on_driver_finished`（runtime/pipeline.h:50） | driver 完成事件的解耦通知 |

## 模块间交互

- 入口是 [12 BE 服务](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/12-be-service) 的 `internal_service.cpp`（`exec_plan_fragment`）；计划由 [04 QE](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/04-qe) 的 Coordinator 部署。非 pipeline 孪生 `orchestration/PlanFragmentExecutor` 并未退役——stream load 默认路径与 `SCHEMA_TABLE_SINK` 兜底仍走它（分工边界见 [12 BE 服务](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/12-be-service) 末节核实补记）。
- 消费 [10 向量化](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/10-vectorization) 的 Chunk/Column；scan 算子从 [05 Connector](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/05-connector) 的 DataSource 与 [11 存储](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/11-storage) 的 SegmentIterator 取数；导入 sink（`OlapTableSink`）见 [08 Load](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/08-load)。

## 扩展方式

**新增一个物理算子**：① 实现 `XxxOperator : Operator`（或 SourceOperator），实现 `prepare/has_output/need_input/pull_chunk/push_chunk/is_finished/set_finishing`；② 实现 `XxxOperatorFactory : OperatorFactory`（`create(dop, driver_seq)` 与跨 driver 共享 context 传递）；③ 在对应 ExecNode 的 `decompose_to_pipeline` 把 factory 追加到 `prev_operators` 返回；④ sink/source 配对算子用 `ConjugateOperator` 包裹并注册 `ContextWithDependency` 到 PipelineBuilderContext；⑤ 无集中注册表——注册即"在该 plan node 的 decompose 路径里 new factory"，但需同步 FE 侧 plan node 生成（[03 优化器](/vibe-reading/articles/Database/OLAP/StarRocks/CodeWiki/main-2026-08/03-optimizer) 的 implementation rule）。

**待核实**：spill 多轮恢复的调度细节。
