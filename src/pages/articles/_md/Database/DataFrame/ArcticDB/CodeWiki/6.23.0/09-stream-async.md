---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "流式与异步"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "TaskScheduler", "Aggregator", "异步", "线程池"]
description: "ArcticDB 流式与异步：Aggregator 流式写入与 TaskScheduler 双线程池"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

`stream/`（~5.3k 行）与 `async/`（~2.9k 行）合起来是 ArcticDB 的**性能基础设施**。`stream/` 负责流式攒段（`Aggregator` 把逐行数据攒满一个段就吐出落盘，支持 staged writes 与 incomplete 链）；`async/` 负责并行调度（`TaskScheduler` 的 CPU + I/O 双池把压缩/解压/存储读写并行化）。这层独立存在是因为——ArcticDB 无服务器、客户端直连对象存储，**隐藏存储延迟的唯一手段就是并行 I/O**，而流式攒段是控制内存占用（不必一次物化整个 symbol）的关键。

## 模块架构

![TaskScheduler 双线程池模型](/vibe-reading/images/articles/arcticdb-internals/task-scheduler.svg)

`async/` 的核心是 `TaskScheduler`（`task_scheduler.hpp:220`）——`std::once_flag` 守护的单例，持两个 Folly `FutureExecutor`：CPU 池（`CPUThreadPoolExecutor`，压缩/解压/表达式/聚合）与 I/O 池（`IOThreadPoolExecutor`，存储读写/版本图 reload）。线程数默认：CPU = `hardware_concurrency()`（cgroup v1/v2 感知，容器限核），I/O = CPU × 1.5（超配隐藏延迟）。任务须派生 `BaseTask`，经 `submit_cpu_task`/`submit_io_task` 提交（模板 + `static_assert` 校验派生关系）。`stream/` 的 `Aggregator`（`aggregator.hpp`）是模板类（参数化 Index/Schema/SegmentingPolicy/DensityPolicy）——逐行 `start_row`/`end_row` 攒数据，攒满 `SegmentingPolicy` 阈值（默认 10 万行）自动 `commit()` 吐出段经回调落盘，`finalize()` 吐剩余。`index.hpp` 定义索引类型，`incompletes.hpp` 处理未提交的 staged 段链。

## 调用链路

```text
流式写：  RowBuilder.set_scalar/set_string → Aggregator.start_row/end_row
            └─ 攒满 → commit() → 回调写存储（StreamSink）
            └─ finalize() → 吐剩余段
异步调度：  async::submit_io_task(ReadTask) → io_exec_.addFuture → I/O 池执行
            async::submit_cpu_task(WriteToSegmentTask) → cpu_exec_.addFuture → CPU 池编码
            AsyncStore::write → submit_io_task → Storage::do_write
```

| 类型/方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `TaskScheduler` `task_scheduler.hpp:220` | 单例双池调度器 | `once_flag` 惰性初始化 |
| `submit_cpu_task`/`submit_io_task` `:368`/`:372` | 提交任务到对应池 | `static_assert` 派生 BaseTask |
| `cpu_executor()`/`io_executor()` `:363`/`:365` | 取池引用 | 全局便捷函数 |
| `get_default_num_cpus` `:184` | 算默认 CPU 数 | cgroup v1/v2 感知 |
| `Aggregator` `aggregator.hpp` | 流式攒段模板 | 攒满自动吐出 |
| `TimeseriesIndex`/`RowCountIndex` `index.hpp` | 索引类型 | 时序用 NANOSECONDS_UTC64 |
| `incompletes` `incompletes.hpp` | staged 未提交段链 | APPEND_REF 指向链头 |

## 核心实现

### TaskScheduler 双池与 cgroup 感知

`TaskScheduler` 构造（`:225`）默认 CPU 数走 `get_default_cpu_count()`（`:205`）→ `ConfigsMap::get_int("VersionStore.NumCPUThreads", get_default_num_cpus("/sys/fs/cgroup"))`。`get_default_num_cpus`（`:184`）先取 `hardware_concurrency()`，再读 cgroup v1（`cpu.cfs_quota_us`/`cpu.cfs_period_us`，`:150`）或 v2（`cpu.max` 文件 `max $PERIOD` 格式，`:159`）的 CPU 配额，取 `min(硬件数, 配额数)`——这让容器化部署（K8s 限核）正确感知可用 CPU。I/O 数默认 `ConfigsMap::get_int("VersionStore.NumIOThreads", CPU*1.5)`。池用 `InstrumentedNamedFactory`（`:49`）给线程命名（CPUPool/IOPool）+ `ARCTICDB_SAMPLE_THREAD` 性能采样。`TaskStatsLoggingObserver`（`:84`）在 `TaskScheduler.LogTaskStats` 开启时记录每任务的 enqueue/wait/run 时长。fork 处理关键：`pthread_atfork`（在 `python_module.cpp` 注册）调 `reinit_scheduler()`→`TaskScheduler::reattach_instance()`——fork 后子进程继承的线程池失效（只有调用线程存活），必须重建。`re_init()`（`:331`）重置线程数与工厂。

### Aggregator 流式攒段与索引

`Aggregator<Index, Schema, SegmentingPolicy, DensityPolicy>`（`aggregator.hpp`）模板——`start_row(idx)` 返回 `RowBuilder` 引用写列值，`end_row()` 结束行，攒满 `SegmentingPolicy` 阈值自动 `commit()` 触发回调（写存储），`finalize()` 吐剩余段。`SegmentAggregator`（`segment_aggregator.hpp`）管理段生命周期（`start_segment`/`add_segment`/`finalize`）。索引类型（`index.hpp`）：`TimeseriesIndex`（默认，`NANOSECONDS_UTC64` 时间戳索引，列名 "time"，提供 `min_index_value`/`max_index_value` 段时间范围）、`RowCountIndex`（行号索引，不存索引列 `field_count()==0`）、`TableIndex`（字符串键）、`EmptyIndex`。索引元数据存 `TABLE_INDEX` 供读时段裁剪——读 `date_range` 时只拉时间区间重叠的段。

### Incomplete 与 staged writes

`incompletes.hpp` 处理未提交的 staged 段——`APPEND_REF`（REF 键）指向 incomplete 段链。生命周期：start append → 创建 `APPEND_REF` 指向首个 incomplete 段 → 追加数据链更多段 → `finalize_staged_data` 合并成新 VERSION 并删 `APPEND_REF`。崩溃恢复：`APPEND_REF` 指向的段是可恢复的——可丢弃或完成追加。这支撑了 `lib.write(symbol, df, staged=True)` + `lib.finalize_staged_data(symbol)` 的流式写入模式（见[Python API](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/01-python-api)）。`protobuf_mappings.hpp` 提供 `to_proto(SegmentInMemory)`/`from_proto` 互转。`stream_sink.hpp`/`stream_source.hpp` 是 `Store` 的父接口（见[存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)）。

### 死锁防护

CLAUDE.md 明确警告："Do not submit tasks to the threadpools from within a task that is already executing within the same threadpool, as this can deadlock."——池任务内向同池提交任务会死锁（池满时等待自己完成）。这意味着池内任务需用同步 API（如 `read_sync`）。这是理解 ArcticDB 异步代码的关键约束——`rollback_on_quota_exceeded`（[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)）显式 `.via(&async::cpu_executor())` 切换到 CPU 池执行回滚，正是为了在 I/O 任务上下文里安全调度 CPU 工作。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例 | `TaskScheduler::instance_` + `once_flag` | 全局唯一调度器，惰性初始化 |
| 策略模板 | `Aggregator<Index,Schema,SegmentingPolicy,DensityPolicy>` | 攒段行为按索引/切片/密度组合 |
| 命令 | `BaseTask` 派生任务 | 编码/读取封装成可调度单元 |
| 回调 | `Aggregator::commit` 触发写回调 | 攒满即吐，流式低内存 |
| Future 流水线 | `submit_*_task` 返回 Future | 段级并行，隐藏 I/O 延迟 |

## 模块间交互

`async/` 被[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)（`WriteToSegmentTask`/`fetch_data`）、[版本引擎](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/02-version-engine)（`CheckReloadTask`）、[存储](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)（`AsyncStore`）调度任务。`stream/` 被[管道](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/03-pipeline)写路径与 `stream_sink.hpp`/`stream_source.hpp`（`Store` 父接口）使用，`Aggregator` 产出的段经编解码落盘。`StreamSink`/`StreamSource` 是 stream 与 storage 的桥接接口。

## 扩展方式

调并行度：`set_config_int("VersionStore.NumCPUThreads", N)`/`"NumIOThreads"`（重启或 `re_init` 生效）；开任务统计 `TaskScheduler.LogTaskStats=1`。新增索引类型：`index.hpp` 加 Index 实现 `field_count`/`min/max_index_value` 等；`Aggregator` 模板实例化新组合。新增流式段策略：`SegmentingPolicy` 加类型 + `Aggregator` 实例化。改段大小：`segment_row_size`（默认 10 万）——大段压缩好但读内存高，小段随机访问快但开销多。staged writes 用 `write(staged=True)` + `finalize_staged_data`。
