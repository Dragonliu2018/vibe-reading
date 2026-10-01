---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "向量检索"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 向量检索解读：HNSW 的 60-alternative variant 类型擦除与三编码、IVF 聚类倒排与量化、EMVB/PLAID/SMVE 的 ColBERT 式 late interaction、heap/reservoir 双结果策略与三层归并"
readingTime: "26 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/storage/knn_index/`（1.05 万行）是稠密/稀疏/多向量索引的实现族，按索引类型分目录：`knn_hnsw/`（图索引）、`knn_ivf/`（聚类倒排）、`knn_diskann/`（磁盘图）、`knn_flat/`（暴力兜底）、`sparse/`（BMP 稀疏索引）、`emvb/`、`plaid/`、`smve/`（多向量 late interaction）、`multivector/`。索引定义在 `src/storage/definition/`（`index_hnsw/ivf/diskann/emvb/plaid/smve.cppm`）。

一个与直觉不符的事实：本模块并非严格".cppm 接口 + `_impl.cpp 实现"——`hnsw_alg.cppm`、`result_handler.cppm`、`merge_knn.cppm` 是**头文件式全量模板实现**；`knn_diskann/` 完全没有 `_impl.cpp`（`vamana_alg.cppm`、`pq_flash_index.cppm` 直接内联）。这符合模板代码必须在编译单元可见的常态。

另一个重要边界事实：**DiskANN 在 v0.7.3 尚未接入执行器**——顶层查询接口 `KnnDiskAnn::CreateIndex/Search` 都是 TODO 空壳（`knn_diskann.cppm:52/56`），executor 的 `physical_knn_scan_impl.cpp` switch 只处理 kIVF/kHnsw，其余 `NotSupport`。构建件齐全、集成未完成，选型时需注意。

---

## 模块架构

```text
src/storage/knn_index/
├── knn_hnsw/
│   ├── hnsw_alg.cppm               KnnHnswBase/KnnHnsw 模板（图搜索算法层）
│   ├── hnsw_handler.cppm           AbstractHnsw（60-alternative variant）+ HnswIndexInMem
│   ├── data_store/                 graph_store + 4 种向量编码（plain/lvq/rabitq/sparse）
│   └── dist_func_*.cppm            L2/IP/Cosine/LSG/SparseIP 距离（SIMD 函数指针）
├── knn_ivf/
│   ├── ivf_index_storage.cppm       IVF_Index_Storage：质心 + Parts_Storage 策略
│   ├── ivf_index_data_in_mem.cppm  IVFIndexInMem（未 seal 形态）
│   └── kmeans_partition.cppm       质心训练
├── knn_diskann/                    vamana_alg + pq_flash_index（未接线）
├── knn_flat/                       暴力扫描 11 种 algo 组合
├── sparse/                         BMP 稀疏索引（独立倒排结构）
├── emvb/ plaid/ smve/               多向量 late interaction 三实现
├── result_handler.cppm             Heap/Reservoir/SingleBest 三结果策略
├── merge_knn.cppm                  跨 chunk/跨 task 归并
└── mlas_matrix_multiply.cppm       ONNX Runtime MLAS 的 GEMM 封装
```

### 索引族场景矩阵

| 索引 | 类型 | 适用场景 | 桶内/编码 |
|---|---|---|---|
| HNSW | 图 | 低延迟召回首选 | Plain/LVQ/Rabitq 三编码，建图后可降级压缩 |
| IVF | 聚类倒排 | 大数据量 + 可容忍召回损失 | Plain/标量量化(SQ)/乘积量化(PQ)，质心恒 f32 |
| DiskANN | 磁盘图 | 超大数据集 | Vamana + PQ + beam search（**v0.7.3 未接线**） |
| EMVB/PLAID/SMVE | 多向量 | tensor 列（ColBERT 式 late interaction） | 见下文 |
| knn_flat | 暴力 | 无索引兜底 | {L2, IP, Cos} × {naive, BLAS, reservoir, top1} |
| BMP（sparse/） | 稀疏倒排 | sparse 向量 | block max pruning，与全文倒排**平行独立** |

---

## 调用链路

### HNSW 搜索路径（ExecuteHnswSearch god node）

```text
PhysicalKnnScan::ExecuteInnerScan (physical_knn_scan_impl.cpp:643)
  case IndexType::kHnsw → ExecuteHnswSearch<t, ColumnDataType, C, DistanceDataType>(...)  :845
   ├─ get_chunks()：segment_index_meta->GetChunkIDs1() + GetMemIndex()
   ├─ for each chunk: ChunkIndexMeta::GetIndexBuffer → index_buffer->ToMmap() → Load()
   │    → reinterpret_cast<HnswHandlerPtr*> → hnsw_search(handler, with_lock=false)
   ├─ if (mem_index)：GetHnswIndex() → hnsw_search(handler, with_lock=true)   // 未 seal 数据带锁搜
   │    hnsw_search lambda (:876)：
   │      ├─ 解析 opt_params_ 的 "ef" → KnnSearchOption{ef_}
   │      ├─ 选 filter：use_bitmask ? BitmaskFilter : AppendFilter(max_segment_offset)
   │      └─ handler->SearchIndex<DistT, SegmentOffset, Filter, WithLock>(query, topk, filter, opt)
   │           └─ HnswHandler::SearchIndex → std::visit → KnnHnsw::KnnSearch
   │                └─ KnnSearchInner (hnsw_alg.cppm:314)：
   │                     GetEnterPoint → for layer>0: SearchLayerNearest（贪心下降）
   │                     → SearchLayerHelper(ep, query, 0, ef, filter)（第 0 层 ef 宽搜索）
   ├─ 符号翻转：kCosine/kInnerProduct 时 d_ptr[i] = -d_ptr[i]（:939-946，标注 FIXME）
   └─ 全部任务完成时 (:698-756)：
        merge_heap_hnsw->EndWithoutSort() → GetUniqueIDs()
        → 若 query_n>1 或 is_rabitq：逐 RowID 取原始列向量精算（近似距离 → 精确距离）
        → merge_heap->End() → SetOutput
```

`SearchLayer`（`hnsw_alg.cppm:124-201`）是标准 best-first：候选堆（距离取负做 min-heap）+ visited 位图 + **软件预取**（`PrefetchVec`，`prefetch_step_` 按 L1 cache 行数算）+ result_handler 收集 ef 个结果，堆顶距离劣于当前第 ef 名时剪枝。

### IVF 检索路径

```text
for each chunk: IVFIndexInChunk → IVF_Index_Storage::SearchIndex (ivf_index_storage.cpp:291)
  1. nprobe = min(nprobe, centroids_num)
  2. 查询→质心距离：kL2 用 TopK SIMD；kCosine/IP 用 MLAS 矩阵乘（质心矩阵×查询）
     + std::nth_element 取 top-nprobe part_ids
  3. ivf_parts_storage_->SearchIndex(part_ids, ..., satisfy_filter_func, add_result_func)
     → 逐桶扫描，dist + filter 经回调 AddResult(d, segment_offset)
mem_index: IVFIndexInMem::SearchIndex → EndWithoutSort() → RowID{segment_id, offset}
```

nlist 在建侧确定：`IndexIVFCentroidOption` 的 `centroid_num = ratio * sqrt(embedding_num)`，训练用 `GetKMeansCentroids`（`kmeans_partition.cppm:66`）。

### 多 segment / 多 task 三层归并

1. **task 内（跨 chunk + mem_index）**：每个并行 task 的 `KnnScanFunctionData` 自带 `merge_knn_base_`，所有 chunk 与 mem index 的候选 `AddResult` 进同一个 `HeapResultHandler`；
2. **task 间**：各 task `SetOutput` 输出 `(distance, RowID)` 列，下游 `PhysicalMergeKnn::ExecuteInner` 汇合再灌入最终 MergeKnn；
3. HNSW 场景还有第三层：`merge_heap_hnsw`（候选堆）→ 精算 → `merge_heap`（结果堆）。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `ExecuteHnswSearch` | `physical_knn_scan_impl.cpp:845` | HNSW 全链路（god node，~135 行） |
| `KnnHnsw::Build` | `hnsw_alg.cppm:390` | 逐点插入建图 |
| `KnnHnsw::KnnSearchInner` | `hnsw_alg.cppm:314` | 贪心下降 + ef 宽搜索 |
| `SelectNeighborsHeuristic` | `hnsw_alg.cppm:231` | hnswlib 式边多样性剪枝 |
| `IVF_Index_Storage::SearchIndex` | `ivf_index_storage.cpp:291` | nprobe 桶扫描 |
| `IVFIndexInMem::SearchIndex` | `ivf_index_data_in_mem_impl.cpp:402` | 未 seal 搜索 |
| `MergeKnnBase::Make` | `merge_knn_impl.cpp:62` | 按类型 × 距离的工厂 |
| `HnswIndexInMem::Dump` | `hnsw_handler.cppm` | MemIndex → chunk 落盘 |

</details>

---

## 核心实现

### AbstractHnsw：60-alternative variant 类型擦除

`hnsw_handler.cppm:39` 的 `AbstractHnsw` 是 60 个 alternative 的 `std::variant`——**3 种度量（Cos/IP/L2）× 3 种数据类型（f32/u8/i8）× 3 种编码（Plain/LVQ/Rabitq）× OwnMem true/false**。`HnswHandler` 用 `std::visit` 分发。为什么：搜索热路径避免逐距离计算的虚函数开销，全部 inline。代价是新增度量/编码要手工扩展 variant 全排列——性能优先于可扩展性的取舍。

`KnnHnswBase`（`hnsw_alg.cppm:51`）本身只有 `M_`（每层最大出度，第 0 层 2M）、`ef_construction_`、`mult_ = 1/log(M)`（指数选层）、`DataStore data_store_`（图 + 向量 + label 三合一）、`Distance distance_`（SIMD 函数指针）、`prefetch_step_`。`LabelType` 在 executor 路径中是 `SegmentOffset`。

### HNSW 建图：可降级压缩的三编码

`Build(vertex_i)`（`hnsw_alg.cppm:390-415`）逐点插入：`-log(uniform) * mult_` 指数选层 → 维护 entry point → 从 max_layer 贪心下降 → 每层 `SearchLayer` 取 ef_construction_ 个近邻 → `SelectNeighborsHeuristic`（hnswlib 启发式：候选 c 仅当它与 query 的距离小于它到已选集每个 r 的距离才保留，控制边的方向多样性）→ `ConnectNeighbors` 双向连边（超 Mmax 时对邻居表整体重跑启发式剪枝）。

建图并行度由 `InfinityContext::GetHnswBuildThreadPool()` 控制，每个点独立 Build。**建完图后可降级压缩**：`CompressToLVQ()`/`CompressToRabitq()`（`hnsw_alg.cppm:547/561`）在 optimize 事务里调用（SQL `OPTIMIZE ... WITH (compress_to_lvq)`），省内存但 rabitq 距离是近似的——因此搜索后有精算回捞阶段。

### 距离度量：模板 + 函数指针双层分发

静态三层：(a) HNSW 内部 `Distance` 类型直接进模板，堆/图操作全 inline；(b) `dist_func_*.cppm` 构造期按维度对齐选 SIMD 内核指针（`GetSIMD_FUNCTIONS().HNSW_F32L2_16_ptr_` 等，`dist_func_l2.cppm:61-79`）——**类型模板定算法框架，构造期函数指针定 SIMD 内核**；(c) executor/IVF 边界用运行时 `KnnDistanceType` 分发到模板实例。内部统一"小者优先"，Cosine/IP 在边界取负号适配（`physical_knn_scan_impl.cpp:939-947` 有 FIXME；IVF 侧 `NEED_FLIP`）。注意存在**双枚举**：`MetricType`（索引定义用）与 `KnnDistanceType`（查询用），`index_base.cppm:31` 有 TODO 承认重复。

### ResultHandler：heap/reservoir 双策略

- `HeapResultHandler`（`result_handler.cppm:85`）：**1-indexed 手写二叉堆**，满了替换堆顶后 HeapifyDown，`End()` 堆排序逆序输出。索引搜索路径用（候选数有界）。
- `ReservoirResultHandler`（`:312`）：`capacity = 2*top_k` 水塘，满了用 median-of-3 阈值 + 原地压缩截断（`partition_median3`，`:396`）。**暴力扫描用**——批量距离算完后一次性筛，把 O(n log k) 的堆操作摊成近似 O(n)。
- `SingleBestResultHandler`：top-1 特化。

### EMVB / PLAID / SMVE：三条 late interaction 路线

三者都是 ColBERT 式多向量检索（文档 = 多 token embedding，MaxSim 打分），但路线不同：

- **EMVB**（`emvb_search.cppm:40`，SIGIR'24 论文实现）：查询 token 数编译期定死（`static_assert(FIXED_QUERY_TOKEN_NUM % 32 == 0)` 便于 AVX）；质心 + 残差 PQ + `centroids_to_docid_` 倒排；两阶段：token×质心得分矩阵（SIMD）→ 命中频次过滤 → 精排。残差 SVD 用 Eigen。
- **PLAID**（`plaid/README.md` 明言）：微软 next-plaid 的移植，2/4-bit 残差量化 + mmap + 磁盘合并；含 ColBERTSaR 模式（residual-free）。
- **SMVE**（`smve_index.cppm`）：**不自己建索引**——用 MLAS 矩阵乘把多向量经 `projection_matrix_` 投影后塞进 BMP 稀疏索引，收集 BMP 搜索结果。更像"多向量 → 稀疏化 → BMP 复用"的捷径实现。

MaxSim 语义在 `MultiVectorSearchOneLine`（`physical_knn_scan_impl.cpp:813`）：对每个 query embedding 取 doc 内最佳距离再求和。

### MLAS 复用

`mlas_matrix_multiply.cppm` 封 4 个 GEMM 变体 + transpose，直接链 ONNX Runtime 的 MLAS 数学库——IVF 质心打分、SMVE 投影、EMVB 都用它，矩阵乘不自己写 SIMD 而借成熟内核。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略（template-template param） | `MergeKnnResultHandlerT<ResultHandler, C, DistType, use_threshold>` | 比较策略编译期编织，零虚调用 |
| variant 类型擦除 | `AbstractHnsw`（60 alternative）+ `std::visit` | 热路径性能；代价是扩展税 |
| 工厂方法 | `MergeKnnBase::Make`、`IndexBase::Deserialize` | 类型 × 距离两级 switch |
| 回调注入 | IVF 的 `satisfy_filter_func/add_result_func` | 过滤与收集从扫描循环解耦 |
| C++20 concept 约束 | `DataIteratorConcept/FilterConcept`（`hnsw_common.cppm:36/123`） | 迭代器/过滤器按 concept 分派（与 FilterBase 继承两条路并存） |
| 装饰/包装器 | `SMVEIndexInMem` 内嵌 `bmp_handler_` | 多向量投影复用 BMP |
| Scratch 池 | DiskANN `ScratchStoreManager` | 查询 scratch 复用 |

---

## 模块间交互

- **catalog（MemIndex）**：`MemIndex` 是 9 种 in-mem 索引的手写 variant 包装；`SegmentIndexMeta::GetMemIndex()` 是 executor 的统一入口。搜索时同时遍历**已 seal 的 chunk（BufferObj mmap，无锁搜）与 mem_index（内存图，WithLock=true 共享锁搜）**——"一边 dump 一边查"的 MVCC 式设计。
- **bg_task**：`DumpIndexProcessor::DoDump`（`dump_index_process_impl.cpp:77`）不走后台线程直接写，而是**开一个 `kDumpMemIndex` 事务**调 `NewTxn::DumpMemIndex`，把 `HnswIndexInMem::Dump(BufferObj*)` 的产物登记为新 chunk——**MemIndex → chunk 的转换是事务化的**，与 WAL/commit_ts 联动。
- **executor**：`physical_knn_scan_impl.cpp` 是唯一搜索入口，任务原子切分为 brute force 部分（`current_block_idx_++` 抢占）与 index 部分（`current_index_idx_++`）。
- **buffer**：chunk 索引 `index_buffer->ToMmap(); Load()` 常驻 mmap，不占 memory_limit 配额。

---

## 扩展方式

**新增一种向量索引类型**（完整链路，以 kHnsw 的落点为 map）：parser 的 `IndexType` 加枚举 + `StringToIndexType` → `definition/index_xxx.cppm/_impl.cpp`（Make 解析 InitParameter、ValidateColumnDataType、Serialize）+ `IndexBase::Deserialize` 工厂注册 → planner 的建索引 case → `storage/knn_index/<name>/` 新目录（`XxxIndexInMem : BaseMemIndex` 含 Dump/GetBeginRowID/GetChunkIndexMetaInfo）→ **`mem_index.cppm` 加 GetXxx/SetXxx** → txn 写路径 `new_txn_index_impl.cpp`——**至少 7 处 `case IndexType::kHnsw` 散布**（create/append/dump/optimize），这是本模块最明显的维护成本（switch 散布，无注册表集中化）→ `chunk_index_meta_impl.cpp` 4 处 switch → `physical_knn_scan_impl.cpp:643` 搜索 switch 加分支。

**新增一种距离度量**（如 Hamming 支持 HNSW）：`MetricType` 加枚举 → `dist_func_xxx.cppm` 新建距离类 + `data_store/vec_store_type.cppm` 新 VecStoreType → **`AbstractHnsw` variant 手工加全排列**（variant 方案的税）→ flat 兜底加 algo 文件 + `InitMergeKnn` 加 case → IVF 质心打分加分支 → executor 边界符号翻转 switch 加 case。
