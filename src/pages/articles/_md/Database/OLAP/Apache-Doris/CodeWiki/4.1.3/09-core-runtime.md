---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "列存类型与运行时"
date: "2026-08-23T18:38:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "4.1.3"]
tags: ["Apache Doris", "Block", "Column", "COW", "MemTracker", "ExecEnv"]
description: "Doris 列存数据载体 Block/Column(COW) + 运行时 RuntimeState + ExecEnv 服务定位器 + MemTracker 内存分级。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/4.1.3/00-overview)

---

## 模块定位

列存类型与运行时模块（`be/src/core/` + `runtime/` + `common/`，~9 万行）是 BE 的基础设施层。`core/` 提供列存数据载体 `Block`/`Column`/`DataType`/`Field`，`runtime/` 提供 `RuntimeState`/`ExecEnv`/`MemTracker`/`Descriptor`，`common/` 提供 `Status`/`Config`/`Logging`。它独立成文是因为这些是全 BE 共享的基础设施——所有执行/表达式/存储/IO 模块都依赖它，它回答"数据以什么形式在算子间流转、内存怎么追踪限制、错误怎么传播"。

## 模块架构

模块分三块：**列存类型系统**（`core/block/` 的 `Block`、`core/column/` 的 `IColumn`/`ColumnVector`/`ColumnString`、`core/data_type/` 的 `IDataType`、`core/field.h` 的 `Field` 联合体、`core/cow.h` 的 COW 基类）、**运行时状态**（`runtime/exec_env.h` 服务定位器、`runtime/runtime_state.h` 查询级状态、`runtime/mem_tracker_limiter.h` 内存追踪）、**公共基础**（`common/status.h` 返回值、`common/config.h` 配置、`common/logging.h` 日志）。

```
ExecEnv (BE 服务定位器, 装配所有子系统)
  ├─ FragmentMgr / TaskScheduler / ScannerScheduler
  ├─ StorageEngine / BrpcService / BackendService
  └─ orphan tracker (未绑定任务线程消费)

Block (ColumnWithTypeAndName 数组, 列式批)
  ├─ ColumnPtr (IColumn shared_ptr, COW)
  │    ├─ ColumnVector<T> / ColumnString / ColumnNullable / ColumnArray ...
  │    └─ shallow_mutate (use_count>1 clone, ==1 零拷贝)
  └─ DataTypePtr (IDataType, 类型/序列化)

RuntimeState (查询级状态)
  ├─ query_mem_tracker / batch_size / preferred_block_size_bytes
  └─ is_cancelled / exec_status

MemTrackerLimiter (内存追踪, GLOBAL/QUERY/LOAD/COMPACTION...)
  └─ add_untracked_mem (累积超阈值才原子 fetch_add)
```

## 调用链路

数据以 Block 在算子间流转 + RuntimeState 贯穿 fragment 执行：

```
PipelineTask::execute (pipeline_task.cpp:451)
  ├─ RuntimeState 贯穿 (query_mem_tracker 统计, is_cancelled 检查, batch_size 控制)
  ├─ _root->get_block_after_projects(state, block, &eos) (line 648)
  │    → get_block → get_block_impl → 子算子递归
  │    // Block 在算子间流转: Source 产出 → 中间算子变换 → Sink 消费
  └─ _sink->sink(state, block, eos) (line 720)
       // block 是 unique_ptr<Block>, 每次 clear_column_data 复用
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `ExecEnv::GetInstance` | 获取 BE 单例 | 装配所有子系统 |
| `Block.mem_reuse` | Block 内存复用 | !data.empty() 时复用 |
| `Block.serialize/deserialize` | 序列化传输 | 压缩，BE 间 RPC |
| `IColumn.shallow_mutate` | 写时复制 | use_count>1 clone |
| `RuntimeState.batch_size` | 批大小 | 最大 65535 |
| `RuntimeState.preferred_block_size_bytes` | 批字节 | 默认 8MB |
| `MemTrackerLimiter.try_consume` | 尝试消费 | CAS 超限返回 false |
| `MemTrackerLimiter.add_untracked_mem` | 批量消费 | 累积超阈值才原子操作 |

</details>

## 核心实现

### COW（写时复制）Column

`IColumn`（`core/column/column.h`）继承 `COW<IColumn>`（`core/cow.h:92`）。COW 核心是 `shallow_mutate`（`cow.h:309`）：

```cpp title="core/cow.h (shallow_mutate)"
MutablePtr shallow_mutate() const {
    if (this->use_count() > 1) {
        return derived()->clone();    // 共享 → 克隆（写时复制）
    } else {
        return assert_mutable();      // 独占 → 零拷贝直接用
    }
}
```

**use_count == 1（独占）**：直接返回可变引用，零拷贝；**use_count > 1（共享）**：clone 新对象，其他引用者不受影响。递归 `mutate`（`column.h:575`）处理嵌套列（如 `ColumnNullable` 的 null map 和 data column），共享子列 detach、独占子列直接复用。

**为什么用 COW**：向量化执行中一个 Block 可能被多个消费者引用（如 broadcast join 的 build 侧被多个 probe 算子共享）。普通 `shared_ptr` 无法区分独占与共享，每次修改都须 clone 浪费严重；COW 通过原子引用计数精确判断，单列数千行数 MB 数据时省大量拷贝。

### Block 向量化基本单位

`Block`（`core/block/block.h:69`）是 `ColumnWithTypeAndName` 数组（列容器）。一次处理 `batch_size()` 行（最大 65535），`IColumn` 虚函数（`insert_range_from`/`filter`/`compare_at`）按批调用分摊开销。`ColumnVector<T>::insert_many_raw_data` 直接 `memcpy`（`column_vector.h:174`），CPU cache 友好、SIMD 友好。

**自适应批大小**（`runtime_state.h:145`）：`batch_size`（1-65535）和 `preferred_block_size_bytes`（默认 8MB，最大 512MB）双限制，适应不同列宽。**内存复用**（`block.h:301`）：`mem_reuse() = !data.empty()`，算子执行完 `clear_column_data()` 清空数据但保留列结构（类型/名称），下一批直接复用已分配内存。**序列化传输**：`serialize()`/`deserialize()` 支持压缩，用于 BE 间 RPC 数据流。

### ExecEnv 服务定位器

`ExecEnv::GetInstance()` 是 BE 获取全局服务的唯一入口，`init()`（`exec_env_init.cpp`）装配 `StorageEngine`/`FragmentMgr`/`TaskScheduler`/`ScannerScheduler`/`BrpcService` 等。或phan tracker（`exec_env.h:457` 注释）："consumption of all limiter trackers + orphan tracker consumption = process tracker consumption"——未绑定任务的线程（如 StorageEngine 后台线程）消费计入 orphan tracker，确保进程总内存统计不遗漏。

### MemTracker 树形分级限制

`MemTrackerLimiter`（`runtime/memory/mem_tracker_limiter.h:71`）分级树：`GLOBAL`/`QUERY`/`LOAD`/`COMPACTION`/`SCHEMA_CHANGE`/`METADATA`/`CACHE`/`OTHER`。一个 BE 进程同时运行多 Query/Load/Compaction，需隔离（一个 Query OOM 不影响其他）、分级（Query > Fragment > Operator 精确定位泄漏）、全局可见（进程级总内存用于 cgroup/OOM killer）。

**延迟批量消费**（`mem_tracker_limiter.h:283`）：`add_untracked_mem` 累积到 `config::mem_tracker_consume_min_size_bytes` 才执行原子 `fetch_add`，避免高频小分配场景的原子开销。`try_consume`（`:157`）用 `MemCounter::try_add` CAS 循环，超限返回 false，调用方检查后 `RuntimeState::is_cancelled` → cancel(MemoryLimitExceeded) 或触发 `operator->revoke_memory(state)` spill。`MemoryReclamation`/`GlobalMemoryArbitrator` 处理多任务竞争时的回收与 kill 优先级。

### RuntimeState 查询级状态

`RuntimeState`（`runtime/runtime_state.h`）贯穿一个 fragment 执行，持 `query_mem_tracker`、`batch_size`/`preferred_block_size_bytes`、`exec_status`/`is_cancelled`、`_query_options`（从 FE `TQueryOptions` 来）、`descriptor_tbl`。每个 `PipelineTask` 独立 `RuntimeState`，算子通过 `state` 取内存追踪、取消状态、批大小配置。

### common 公共基础

`Status`（`common/status.h`）是所有函数返回值类型（`[[nodiscard]] Status`），含错误码+消息，`AtomicStatus`（`status.h:599`）用 `std::atomic_int16_t` CAS 保证 only first-error-wins。`Config`（`common/config.h`）全局配置参数源，从 `be.conf` 加载。`Logging` 提供日志基础设施。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务定位器 | `ExecEnv` | 无 DI 框架，全局单例获取子系统 |
| COW | `core/cow.h` + `IColumn` | 共享只读零拷贝、独占改写才克隆 |
| 类型系统多态 | `IDataType` + `DataTypeFactory` | 类型行为可扩展 |
| RAII 内存追踪 | `MemTrackerLimiter` 树 | 分级隔离 + 全局统计 |

## 模块间交互

`core` 被 `exec`/`exprs`/`storage`/`io` 所有数据载体依赖（Block/Column 是流转单位）；`runtime` 被 `exec`（pipeline）驱动，`ExecEnv` 装配所有 BE 子系统；`common` 被所有模块依赖（Status 是返回值类型，Config 是配置源，Logging 是日志）。交叉引用：`runtime_state.h` include `exec_env.h`；`exec_env.h` 间接 include `core/cow.h`（经 mem_tracker）；`core/block/block.h` include `common/status.h`。编译依赖经前向声明和 `#include` 精心控制。

## 扩展方式

新增一种数据类型（如 JSON 类型）：`core/data_type/define_primitive_type.h` 加 `TYPE_MYJSON` 枚举；`primitive_type.h` 注册枚举和 `is_complex_type` 判断；新建 `data_type_myjson.h` 继承 `IDataType`（实现 `create_column`/`get_name`/`get_primitive_type`/`get_serde`/`serialize`/`deserialize`）；`data_type_factory.cpp` 注册映射；新建 `column_myjson.h` 继承 `COWHelper<IColumn, ColumnMyJSON>`（实现 `insert`/`insert_range_from`/`filter`/`compare_at`/`byte_size`）；`core/types.h` 特化 `PrimitiveTypeTraits<T>`；`field.h`/`field.cpp` 支持 `Field` 联合体存储；新建 `data_type_myjson_serde.h` 实现 `DataTypeSerDe`；`call_on_type_index.h` 注册类型分派。

修改内存限制策略：`mem_tracker_limiter.h:299` 的 `check_limit`（如加软限制 80% warning）；`mem_tracker_limiter.h:157` 的 `try_consume` 判定；`config.h`/`config.cpp` 加配置项；`memory_reclamation.h`/`global_memory_arbitrator.h` 调整回收与 kill 优先级。
