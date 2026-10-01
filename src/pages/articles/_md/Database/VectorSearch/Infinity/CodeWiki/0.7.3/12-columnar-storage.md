---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "列存与存储管理"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 列存解读：8192 定容 DataBlock 与 RowID 位绑定、ColumnVector 三态与变长 outline 分离、BufferManager 分片 GC 与 ephemeral 降级链、PersistenceManager 128MB 对象合并解 S3 小文件、PGM 二级索引"
readingTime: "26 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/storage/` 的非事务部分（column_vector/buffer/io/bg_task/persistence/secondary_index/fast_rough_filter + 顶层文件）是列式数据引擎：**内存列向量 → 缓冲池 → 文件抽象 → 对象持久化**四层，加 4 条后台任务线程。这是被 import 最多的层（`column_vector` 298 个文件、`data_block` 282 个）——向量化执行的地基。

---

## 模块架构

```text
src/storage/
├── data_block.cppm/_impl           算子间传递的行批容器（纯内存中间结构）
├── data_table.cppm/_impl           结果表
├── column_vector/
│   ├── column_vector.cppm (46KB)   ColumnVector：列向量基本单元
│   ├── value.cppm/_impl            Value：执行期单值容器
│   ├── vector_buffer / var_buffer  定长数据区 + 变长 outline 区
│   ├── null_value / selection      null 语义与行选择
│   └── operator/                   unary/binary/ternary 最内层循环
├── buffer/
│   ├── buffer_manager.cppm/_impl   缓冲池（7 分片 + 内存预算）
│   ├── buffer_obj.cppm/_impl       BufferObj：双引用计数 + 状态机
│   └── file_worker/                12 种文件格式策略（.col/索引/版本...）
├── io/virtual_store.cppm/_impl     文件门面（local + S3/minio/...）
├── persistence/persistence_manager  小文件合并成 128MB 对象
├── bg_task/                        4 条后台线程
├── secondary_index/                PGM learned index 二级索引
├── fast_rough_filter/              min/max zone map + bloom/binary fuse
└── result_cache_manager.cppm       查询结果缓存
```

分层依赖：ColumnVector/DataBlock（内存形态）→ BufferManager（池 + 换入换出）→ VirtualStore（本地/S3）→ PersistenceManager（对象合并）。

---

## 调用链路

### 写入路径（DataBlock → 列缓冲 → .col 落盘 → 对象合并）

```text
NewTxn::Append (new_txn_data_impl.cpp:457)
  commit 时 AppendInBlock：拿 BlockLock + 更新 min/max_ts
  └─ 逐列 AppendInColumn (new_txn_data_impl.cpp:964)
      ├─ NewCatalog::GetColumnVector(column_meta, col_def, offset, kReadWrite, dest_vec)
      │    ├─ ColumnMeta::GetColumnBuffer(buffer_obj, outline_buffer_obj)
      │    └─ column_vector.Initialize(buffer_obj, outline_buffer_obj, ...)  ← 挂到 BufferManager
      ├─ dest_vec.AppendWith(column_vector, source_offset, rows)   column_vector_impl.cpp:2267
      │    └─ 模板 CopyFrom<PhysicalT> 特化拷贝（memcpy / compact bit / CopyVarchar 深拷 outline）
      └─ null bitmap 写回缓冲尾部 data_cap_size 偏移处
落盘（checkpoint 或 IMPORT 时机）：
BufferObj::Save (buffer_obj_impl.cpp:223)
  └─ file_worker_->WriteToFile(false)
      ├─ PersistenceManager::Persist(write_path, tmp_path)    persistence_manager_impl.cpp:112
      │    ├─ src_size >= 128MB 或 !try_compose → 独立对象（rename + ObjAddr{key,0,size}）
      │    └─ 否则追加进 current_object（8 字节对齐）；放不下则封口 + 新 UUID
      └─ KVStore.Put(PMObjectKey(local_path) → ObjAddr JSON)   RocksDB 记映射
```

### 读取路径（scan → BufferManager 加载列 chunk）

```text
NewCatalog::GetColumnVector(..., kReadOnly, out_vec)
  └─ ColumnVector::Initialize(buffer_obj, outline, row_count, kReadOnly)
      └─ VectorBuffer::Make → buffer_obj->Load()
          ├─ kLoaded：命中，rc++ 返回
          ├─ kUnloaded：从 GC 队列出队，rc++ 返回（内存还在）
          └─ kFreed(仅 kPersistent)：cache miss
              file_worker_->ReadFromFile(from_spill)
              ├─ PersistenceManager::GetObjCache(local_path)
              │    本地无缓存 → VirtualStore::DownloadObject 整对象 + ref++
              └─ file_handle->Seek(obj_addr_.part_offset_); 读 part_size_ 字节
      → BufferHandle（RAII）析构时 rc-- → 0 时入 GC 队列尾
```

向量化算子拿到 `col->data()` 裸指针后零拷贝直读（`ColumnVectorPtrAndIdx<T>` 适配器）。

### 后台任务循环（4 条线程）

| 线程 | 文件 | 任务 | 触发 |
|---|---|---|---|
| BGTaskProcessor | `background_process_impl.cpp:60` | checkpoint / cleanup / stop | CheckpointPeriodicTrigger（`cur_ckp_ts > last_ckp_ts`）；CleanupPeriodicTrigger（oldest alive TS 推进） |
| CompactionProcessor | `compaction_process_impl.cpp:258` | manual/notify compact | compact 命令 / 周期触发 |
| OptimizationProcessor | `optimization_process_impl.cpp:147` | manual/notify optimize | optimize 命令 / OptimizeIndexPeriodicTrigger |
| DumpIndexProcessor | `dump_index_process_impl.cpp:151` | dump mem index | **写入时自动**：mem index 行数 ≥ MemIndexCapacity |

**内存压力触发 checkpoint 的闭环**（设计亮点，`buffer_obj_impl.cpp:133-160`）：`LoadNoLock` 遇到 kNew 对象需分配内存时，若已有 spill，会构造 `spill_checkpoint` lambda 提交 `NewCheckpointTask`——把 ephemeral 数据赶紧真正持久化，避免反复 spill。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `DataBlock::Init/Finalize` | `data_block_impl.cpp:189` | 行批初始化（kConstant 行数推导） |
| `ColumnVector::AppendWith` | `column_vector_impl.cpp:2267` | 模板特化拷贝 |
| `ColumnVector::Initialize` | `column_vector_impl.cpp:242` | 双形态：自管内存 / 挂 BufferObj |
| `BufferManager::RequestSpace` | `buffer_manager_impl.cpp:51` | 内存不足时驱动 GC |
| `BufferObj::Load/Free/Save` | `buffer_obj_impl.cpp:77/198/223` | 换入/换出/落盘 |
| `VirtualStore::UploadObject` | `virtual_store_impl.cpp:599` | S3 上传分叉 |
| `PersistenceManager::Persist` | `persistence_manager_impl.cpp:112` | 小文件合并 |
| `PersistenceManager::CurrentObjFinalize` | 同文件 | 封口（128MB 满/IMPORT/COMPACT 显式） |
| `BGTaskProcessor::Process` | `background_process_impl.cpp:60` | 任务分发（default 抛错） |
| `FastRoughFilter::Evaluate` | `fast_rough_filter.cppm:129` | 粗滤 + 时间戳安全阀 |

</details>

---

## 核心实现

### ColumnVector：定容列式 + 稀疏 null 位图，无容量增长

- **不做增长**：`AppendByPtr` 超容量直接 `UnrecoverableError("Exceed the column vector capacity")`——容量在 `Initialize` 一次定死（`DEFAULT_VECTOR_SIZE = DEFAULT_BLOCK_CAPACITY = 8192`）。为什么：8192 与 `BLOCK_OFFSET_SHIFT = 13` 配套，**RowID 的 block 内偏移可直接位运算提取**，DataBlock ↔ 物理行号一一对应，避免动态扩容的指针失效与重分配。
- **.col 单文件单列定容**：布局为 `[data_region (capacity×type_size)][null_bitmap ((capacity+7)/8)]`。null 用 `Bitmask`（初始全 true，`SetFalse` 标 null）——**非 NULL 行零成本**；读取兼容老格式（无 null 区视为全非 null）。
- **三种物理形态**：kFlat（裸数组）、kConstant（1 值广播，常量折叠）、kCompactBit（Boolean 压缩位）。`tail_index_` 是 `std::atomic`，支持多线程并发 append。
- **变长分离**：Varchar/Json/Sparse/Tensor/MultiVector 行内存短结构（句柄+长度），真实字节在 `VarBufferManager` outline 区 → 独立 `col_N_out` 文件——定长扫描不被变长拖累。

### BufferManager：分片 GC + ephemeral 降级链

- 7 个 `LRUCache` 分片按 `obj->id() % 7`——**名为 LRU 实为 GC 顺序双链表 + 哈希索引**（无访问序更新，`PushGCQueue` 仅在 rc 归零时调用，实为"最近卸载序"的近似 LRU），分片为降低锁竞争。
- 内存不足时 `RequestSpace` round-robin 轮询分片、从队头 `Free()`（`try_lock` 失败即跳过避免死锁）；腾不出直接 `UnrecoverableError("Out of memory")`。
- **kEphemeral 对象不丢弃而是降级**：`Free()` 中 kEphemeral → kTemp，spill 到 TempDir 并登记；下次 `Load` 的 kNew 分支发现 TempSet 非空即触发 checkpoint 闭环。为什么：append 中的 block 列不能丢数据，只能"先挪到本地盘、再择机持久化"。
- `kMmap/kToMmap`：大只读索引（如 HNSW chunk、倒排 .pos）走 mmap，不占 memory_limit 配额。
- **双引用计数**：`rc_`（RAII BufferHandle，内存生命周期）与 `obj_rc_`（catalog entry 持有，文件生命周期）解耦——目录删除后数据文件延迟到引用归零才物理删。

### PersistenceManager：解 S3 小对象问题

每个 .col 文件仅 `8192×type_size + 1KB` 量级（几 KB～几 MB），直传 S3 会导致海量小对象：PUT 请求数爆炸、元数据膨胀、读放大。`Persist` 把小文件追加进 `current_object`（8 字节对齐，上限 128MB），RocksDB 记 `ObjAddr{obj_key, part_offset, part_size}`。封口时机：128MB 满 / `try_compose=false` / IMPORT、COMPACT、OPTIMIZE、DUMP_MEM_INDEX 显式 `CurrentObjFinalize()`。多 part 对象封口时 append 4 字节 footer 标识。读取 `GetObjCache`：本地 miss → **整对象 Download** + ref++——本地盘也是一层缓存，返回 drop_keys_（本地盘超限要删的）与 drop_from_remote_keys_（所有 part 已删可删远端的）。

### VirtualStore：local path 为逻辑键的统一边界

存储核心只面向本地路径编程；远端仅在 `UploadObject/DownloadObject` 的 `storage_type_ == kLocal` 分叉出现。`StorageType` 枚举已预埋 minio/AWS/Azure/GCS/OSS/COS/OBS/HDFS/NFS，全部收敛到单个 `S3Client`（S3 兼容协议是事实标准；HDFS/NFS 是否有真实实现待核实）。收益：BufferManager 的 `buffer_map_`、PersistenceManager 的 KV 映射与后端完全解耦；新增 S3 兼容后端零改动核心层。

### fast_rough_filter：宁可漏剪不可误剪

`FastRoughFilter` 挂 block/segment，双通道：`MinMaxDataFilter::MayInRange`（zone map 区间剪枝）+ `ProbabilisticDataFilter::MayContain`（bloom/binary fuse）。**关键安全阀**（`fast_rough_filter.cppm:129-140`）：`Evaluate` 先检查 filter 已建完且 `query_ts >= build_time_`——filter 未覆盖刚写入的数据一律放行返回 true。粗滤是启发式，误剪比漏剪代价大得多；`build_time_` 用 `UNCOMMIT_TS` 哨兵 + `atomic_flag` 无锁发布构建完成状态。

### 二级索引用 PGM（learned index）而非 B+Tree

`PGMIndex<T, 64, 4, float>`（`secondary_index_pgm.cppm:32-48`）：sorted key → 近似定位 + 窗口内二分。为什么：索引数据是不可变列（append-only + compaction 重写），一次性构建的 learned 结构空间占用远小于 B+Tree，正适合 immutable 列存。

### 关键常量速查

`DEFAULT_BLOCK_CAPACITY=8192`、`BLOCK_OFFSET_SHIFT=13`、`DEFAULT_SEGMENT_CAPACITY=8M 行`（`SEGMENT_OFFSET_IN_DOCID=23`）、`DEFAULT_BLOCK_PER_SEGMENT=1024`、`DEFAULT_BUFFER_MANAGER_LRU_COUNT=7`、`DEFAULT_PERSISTENCE_OBJECT_SIZE_LIMIT=128MB`、`DEFAULT_MEMINDEX_CAPACITY=65536 行`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 引用计数缓冲（双计数器） | `BufferObj::rc_/obj_rc_` | 内存寿命与文件寿命解耦 |
| 策略（FileWorker） | 12 个子类各管一种文件格式 | BufferObj 对内容完全不透明 |
| 模板方法 | `FileWorker::WriteToFile/ReadFromFile` 公共流程 | 子类只填序列化差异 |
| 门面（全静态） | `VirtualStore` | 12 种对象存储收敛成一个接口 |
| 模板特化向量化 | `ColumnVector::CopyFrom<T>` 10+ 组特化 | Boolean/Varchar/Embedding 各走最优路径 |
| 生产者-消费者 | `BlockingQueue<BGTask>` × 4 | 后台任务解耦 |
| 降级链 | ephemeral → temp → persistent | 内存压力下的渐进持久化 |

---

## 模块间交互

- **txn 写入**：`AppendInColumn` 经 `GetColumnVector(kReadWrite)` 写列缓冲；block 级 `BlockLock` 串行化并发 append；`BlockVersion` 记录 create/delete 时间戳供 MVCC 过滤。
- **executor scan**：`GetColumnVector(kReadOnly)` 后算子经 `ColumnValueReader<T>` 零检查直读 `data()`。
- **索引也走 BufferManager**：HNSW/IVF/BMP/EMVB/Plaid/SMVE/二级索引文件全部经各自 FileWorker 包成 BufferObj，享受同一套 load/GC/spill；内存期索引由 `AppendMemIndexTask` 异步喂增量（任务直接携带 `shared_ptr<ColumnVector>` 保证 outline 数据生命周期）。
- **WAL/checkpoint**：`NewCheckpointTask` → catalog 落盘 → dirty BufferObj `Save()`。
- **compaction**：`NewCompactionAlg` 选段（tiered，按 DBT=8192）→ txn 生成新 segment → 旧文件引用计数归零后物理删。

---

## 扩展方式

**新增一种后台任务**：`bg_task_type.cppm` 枚举加值 → `bg_task.cppm` 定义任务 struct 继承 `BGTask` → 挑一个 processor 的 `Process()` switch 加 case——**必须加**：4 个 processor 的 default 分支都是 `UnrecoverableError`，漏加直接崩进程 → 触发侧二选一：PeriodicTrigger 子类（注册进轮询线程，参考 CleanupPeriodicTrigger 的"时间戳推进才触发"防抖）或业务代码直接 `Submit(task)`。

**新增一种文件存储后端**：兼容 S3 协议只需 endpoint/凭证配置（复用 `s3_client_`，零代码）；不兼容则新建 client 类（仿 `s3_client_minio.cppm` 约 1.9KB 接口）+ `UploadObject/DownloadObject` 分叉接入。核心存储层零改动——门面抽象的收益。

**新增列数据类型**（顺带）：`GetVectorBufferType` switch 定缓冲形态 + `CopyFrom/Append` 模板特化 + `value.cppm` 的 Value 装载 + `.col` 大小计算。
