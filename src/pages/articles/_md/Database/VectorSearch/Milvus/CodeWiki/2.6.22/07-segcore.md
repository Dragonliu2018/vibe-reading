---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "Segcore 段引擎"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "C++", "查询执行", "mmap"]
description: "Milvus Segcore 解读——growing/sealed 段数据结构（ConcurrentVector vs ChunkedColumn）、Driver 推拉混合执行模型、九种物理算子、DeletedRecord 删除位图、Reduce k 路归并与 mmap 列组"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

C++ `internal/core/src/`（~334K 行）中的 `segcore/` + `query/` + `exec/` + `plan/`（注意：exec 的逻辑 PlanNode 在 `src/plan/` 不在 query/；mmap 在 `src/mmap/`）是段引擎——growing/sealed 段的数据结构与查询执行。Go 层经 cgo 进入的唯一入口是 `SegmentInternalInterface::Search`（`segcore/SegmentInterface.cpp:95`，构造 `ExecPlanNodeVisitor` 对单段执行整个 plan）。

## 模块架构

![Segcore 查询执行](/vibe-reading/images/articles/milvus-internals/exec-operators.svg)

### Growing vs Sealed 的数据结构分野

```
SegmentInterface → SegmentInternalInterface
├─ SegmentGrowing → SegmentGrowingImpl（追加写）
│   insert_record_（InsertRecordGrowing：每字段一个 ConcurrentVector + timestamps + pk2offset）
│   indexing_record_（growing 临时索引）
│   deleted_record_（删除 delta）
└─ SegmentSealed → ChunkedSegmentSealedImpl（静态列）
    fields_（folly::Synchronized<map<FieldId, ChunkedColumnInterface>>）
    scalar_indexings_ / vector_indexings_（CacheSlot 包装）
    insert_record_（InsertRecordSealed：只存 timestamps + TimestampIndex + pk2offset——行数据不复制，查列走 fields_）
```

**为什么 chunk 化**（`mmap/ChunkedColumn.h`）：① chunk 是 cachinglayer 的 **pin/逐出单位**——查询只 pin 涉及的 chunk，冷数据整体落盘；② chunk 边界与存储层（binlog/列组）天然对齐，sealed 段免重排；③ 表达式按 8192 行批量求值、暴力搜索按 chunk 分批消费同一粒度。Growing 的 ConcurrentVector 则是固定 32K 行 chunk（`SegcoreConfig.h:187`）。

**PK→offset 索引双实现**（`segcore/InsertRecord.h`）：growing 用 `OffsetOrderedMap`（std::map + 读写锁支持并发插入；倒序遍历同 PK 取最新 offset）；sealed 用 `OffsetOrderedArray`（排序数组 seal 后二分）。**DeletedRecord**（`DeletedRecord.h`）：`folly::ConcurrentSkipList<pair<Timestamp,Offset>>` + 去重 bitmap——`Query()` 三档：最新快照原子 OR（query_ts ≥ max_ts 免遍历）→ 历史批量 dump 的物化 bitmap → 慢路径逐条遍历。注意语义：**bitset 的 1 = 该行被排除**。

**TimestampIndex**（`TimestampIndex.h`）：`lengths_`/`start_locs_`/`timestamp_barriers_` 三数组——`get_active_range` 二分定位 undecided 片，`[0,beg)` 一定可见、`[end,size)` 一定不可见，**只有中间片逐行比较**。**growing 不构建 TimestampIndex**：时间戳由 querynode 保证有序插入（`Insert` step 2 注释），可见性一次二分即可；sealed 的行序来自 binlog 回放不保证时间序，需要切片索引。

## 核心实现

### Plan 三层结构与三种搜索管线

`ProtoParser::PlanNodeFromProto`（`query/PlanProto.cpp:46`）把 proto 编译成：(1) `query::Plan` 顶壳（schema + placeholder）；(2) `plan::PlanNode` 逻辑树（`src/plan/PlanNode.h`：FilterBitsNode/MvccNode/VectorSearchNode/…每个只有 id + sources + 参数）；(3) `expr::TypedExpr` 表达式树挂在 Filter 节点。

**三种搜索管线**（`PlanProto.cpp:142-204`）：

| 管线 | 条件 | 节点链 |
|------|------|--------|
| pre-filter（默认） | — | `FilterBits → Mvcc → VectorSearch` |
| iterative filter | hint 且非 range/groupby | `Mvcc → VectorSearch → FilterNode(迭代)`——先搜后滤，只在候选 offset 上求值 |
| 无谓词 | — | `Mvcc → VectorSearch` |

之上可叠 GroupByNode、RescoresNode。

### Driver：推拉混合执行（Presto 血统）

命名 Task/Driver/Operator/PlanFragment/BlockingReason/ContinueFuture 完全对应 Presto（Velox）词汇表。`ExecPlanNodeVisitor::ExecuteTask`（`ExecPlanNodeVisitor.cpp:41`）是**同步批式入口**：`Task::Create` 后 `for(;;) task->Next()`，把每个返回的 RowVector 累积进 bitset_holder——批式路径通常每算子一批（算子内部自己 while 到整段处理完）；流式路径（`segcore/StreamReduce.cpp`）才真正逐批产出。**不是协程**：`IsBlocked(&future)` 返回 `StopReason::kBlock` + `BlockingState/SetResume` 模拟挂起（等 cachinglayer 加载 chunk），`Driver::Enqueue` 重投 executor 恢复。

`Driver::RunInternal`（`Driver.cpp:214`）：从 sink 往 source 倒序扫描：查 IsBlocked → NeedInput → 上游 GetOutput → 有结果就 `next_op->AddInput(result)`——**push-with-demand**：数据由上游 GetOutput 拉出后 push 进下游 AddInput，循环驱动而非递归 Volcano。`MaxDrivers` 恒返回 1——多 driver 并行是预留基础设施未启用（`MustStartNewPipeline` 仅 `source_id != 0` 且注释 TODO）。`DriverFactory::CreateDriver`（:49）的 dynamic_cast 链把 plan 节点映射成 Phy 算子——**新增算子必须在这里注册**。

### 九种物理算子

| 算子 | 职责 |
|------|------|
| `PhyMvccNode`（source） | 时间戳可见性 + 删除 mask。sealed 快路径：无 TTL 且 query_ts ≥ max_ts 跳过时间戳 mask 只做 `mask_with_delete`；全可见时置 `set_all_rows_visible(true)` 供下游免构造 BitsetView |
| `PhyFilterBitsNode` | 求值谓词整段；**UNKNOWN/NULL 与 FALSE 一并排除**（SQL 三值逻辑）；`is_always_true_` 快路径 |
| `PhyVectorSearchNode` | 位图 → BitsetView（all_rows_visible 时留空 = knowhere IDSelectorAll）→ `segment->vector_search`；结果传 query_context，**bitset 原样传给下游**（GroupBy/IterativeFilter 继续消费） |
| `PhyIterativeFilterNode` | 拉 `vector_iterators_`（CachedSearchIterator 逐批吐 offset/dist），`is_native_supported_` 时 `set_offset_input` **只对候选行求值**；命中结果二分插入维护 topk 序 |
| `PhyGroupByNode` | vector iterator 之上 group-by（group_size/strict） |
| `PhyRandomSampleNode` | factor ≤0.02 用 hash-set 采样否则 `std::sample`；>0.5 反向采样 1-factor |
| `PhyRescoresNode` | 对 top-k offset 重打分/加权（头注释精确区分 FilterBits："FilterBits 走整段返回 bitset；Rescores 接 offset 数组只在这些 offset 上执行"） |
| `PhyCountNode` | `view.size() - view.count()` |
| `CallbackSink` | 结果汇聚出口 |

表达式编译（`exec/expression/`）：`TypedExpr`（~18 种）→ `CompileExpressions` 编译为 `exec::expression::Expr`（UnaryExpr 83KB、TermExpr 44KB 按类型模板 + SIMD + 常量折叠），`ExprSet::Eval` 内部游标按 8192 行推进；数据读取统一走 `SegmentChunkReader`。

### Growing 段查询与临时索引

`SearchOnGrowing`（`query/SearchOnGrowing.cpp:75`）双路径：**临时索引优先**——`indexing_record_.SyncDataWithIndex(field_id)` 为真走 `FloatSegmentIndexSearch`（对 `get_segment_indexing()` 的整段 knowhere 索引搜索；`VectorFieldIndexing::AppendSegmentIndexDense` 在 Insert 时增量追加，`index_cur_` 水位之前的数据进了索引，之后由暴力兜底）；否则持 `chunk_mutex_` 共享锁 double-check 后退**按 chunk 暴力**（每 chunk 构造 RawDataset 调 BruteForceSearch，SubSearchResult::merge 归并）。`UseVectorIterator` 时打包 chunk iterator 供迭代过滤逐批消费。构建门槛 `get_build_threshold()`（interim_index_nlist 等，内存膨胀率 1.15）。**sealed 段还有第三种临时索引**：从原始列生成 binlog interim index（`generate_interim_index`，`binlog_index_bitset_` 位）——vector_search 优先级：binlog interim > 正式 index > 暴力。

### Reduce：多段归并

`ReduceSearchResultsAndFillData`（`segcore/reduce_c.cpp:85`）→ `ReduceHelper::Reduce()`（`reduce/Reduce.cpp:59`）四步：`FillPrimaryKey`（`FilterInvalidSearchResult` + bulk_subscript 取 PK）→ **`SortEqualScoresByPks`——等分结果按 PK 排序保证多副本/多段间确定性**（tie-break，group_by 值同步置换否则 "pk↔group-by-value binding is broken"）→ 每 nq 调 `ReduceSearchResultForOneNQ`（各段队首进优先队列，比较器距离优先等距 PK 小者胜，**`pk_set_` 跨段去重 PK**，堆式 k 路归并）→ `FillEntryData` 批取 output_fields + Marshal 序列化。流式变体 `StreamReducerHelper` 分批 marshal 省峰值内存。

### Mmap 与 cachinglayer

**sealed 静态列**：`ChunkedColumnBase` = `CacheSlot<Chunk>` + `ChunkTranslator`（`storagev1translator/`）——`use_mmap_` 时 StorageType::DISK、chunk 文件写 mmap 目录后映射（支持 `mmap_populate`），支持 remote load 与取消。**列组**：`ChunkedColumnGroup` 持多字段共享 GroupChunk **一起加载/逐出**（冷数据整组落盘），对字段暴露 `ProxyChunkColumn` 单字段视图。cachinglayer 结算贯穿 PK 索引、时间戳、DeletedRecord（64KB 增量阈值）、growing 段整体（refund-then-charge）。索引同样可 mmap（`SealedIndexTranslator` 族）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 推拉混合 Driver | `Driver.cpp:214` | 异步阻塞不占线程 + 流式分批 |
| CacheSlot 统一缓存 | mmap/ 全目录 | 列与索引同一套 pin/逐出/结算 |
| 双 scope 数据结构 | ConcurrentVector vs ChunkedColumn | 追加写 vs 静态列的本质差异 |
| 访问者 | ExecPlanNodeVisitor | plan 树到算子树的映射 |
| tie-break 确定性 | SortEqualScoresByPks | 多副本结果可重放 |

## 模块间交互

上游 [QueryNode](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/05-querynode) 经 cgo（`C.AsyncSearch` 提交到 folly search 线程池，`Executor.cpp:22`，硬件并发线程 + 3 级优先级）；向量搜索委托 [索引层](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/08-index-storage) 的 knowhere；存储消费 mmap 的 translator（binlog v1 / storagev2 Parquet）。

## 扩展方式

**新增一种算子**（RandomSampleNode 范本，七步）：proto 加字段 → `plan/PlanNode.h` 加逻辑节点 → `PlanProto.cpp` 的 `PlanNodeFromProto` 接进 sources 链 → `exec/operator/XxxNode` 继承 Operator 实现 `NeedInput/AddInput/GetOutput/IsFinished/IsBlocked` → **`DriverFactory::CreateDriver` 加 dynamic_cast 分支**（漏注册则编译不过或运行无算子）→ CMake → 测试。**新增表达式**路径改为：proto Expr oneof → `expr::TypedExpr` 子类 → `ParseExprs` 加 case → `exec/expression/XxxExpr.cpp` 实现 typed Eval（参与迭代过滤还需实现 `SupportOffsetInput()`）。

**值得注意的源码瑕疵**：`PhyMvccNode` 构造函数把 operator_type 误传成 `"PhyIterativeFilterNode"`（`MvccNode.cpp:34`）——日志/监控会归错类（不影响功能）。
