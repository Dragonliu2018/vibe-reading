---
source:
  type: "源码解读"
  project: "Helmsman"
  url: "https://github.com/Red-EAD/helmsman"
title: "离线构建"
date: "2026-08-18T21:08:07+08:00"
category: ["AI", "Infra", "Retrieval", "Helmsman", "CodeWiki", "1.0"]
tags: ["Helmsman", "MiniHyperVec", "SpannIndex", "Filling", "SPTAG", "HNSW"]
description: "Helmsman 离线索引构建：SpannIndex 把 SPTAG SPANN 索引转换为 HV_CONST 格式，含 Filling 算法补齐定长 cluster 与 norm 预算。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/00-overview)

---

## 模块定位

离线构建模块（`third_party/spann_aug/`）是 Helmsman serving 的前置工序——它把 SPTAG 生成的 SPANN 索引转换成 MiniHyperVec 的 HV_CONST 格式。SPANN 原始 cluster 大小不均，而 HV_CONST 要求**定长 cluster_size**（让 NVMe 能批量定长读），所以核心是 **Filling 算法**：从 centroid 最近的邻居簇借向量，把每个 cluster 补齐到定长。它还预算 per-vector L2 norm²（供在线 `rank_cal` 用），并序列化四件产物喂给在线 deploy。

边界：本模块是独立静态库 `spann_core`，只被 `app/spann_build_index` 链接，**不链接** `MiniHyperVec` 共享库。它是离线数据准备，不参与在线 serving。

---

## 模块架构

```text
app/spann_build_index.cpp (40 行 main)
  │  ParseArgs → ParseBuildIndexConfig → MakeArtifacts
  ├─ OpenSpannIndex(config) ──→ SpannIndex 构造
  │                              ├─ LoadHeads()    读 SPTAGHeadVectors.bin
  │                              ├─ LoadHeadIds()  读 SPTAGHeadVectorIDs.bin
  │                              └─ LoadMeta()     读 SPTAGFullList.bin (header + MetaRecord[])
  ├─ PrepareFilledIndex(*index, config)
  │    ├─ LoadAllClusters()      逐簇 pread posting list 到内存 (含 head 追加)
  │    ├─ BuildHeadHNSW(M, ef_construction, ef_search)   对 centroid 建 HNSW
  │    └─ PerformFilling(target_size, neighbor_topk, count_head, num_threads)
  ├─ performNorms()              多线程算 per-vector L2 norm²
  └─ SaveArtifacts + SaveIndexMeta
       ├─ saveHeadIndex → {prefix}_centroids_index.bin   (hnswlib saveIndex)
       ├─ saveClusterIds → {prefix}_cluster_ids.bin
       ├─ saveNorms      → {prefix}_cluster_norms.bin
       └─ {prefix}_index_meta.json

SpannIndex (third_party/spann_aug/include/spann_index.h, god node 62 edges)
  ├─ head_vecs_/head_ids_/meta_         (SPANN 原始输入)
  ├─ cluster_ids_/cluster_vecs_         (加载后 cluster 数据, Filling 写入此处)
  ├─ snapshot_cluster_ids_/vecs_        (Filling 只读快照, 隔离原数据)
  ├─ head_hnsw_ (hnswlib::HierarchicalNSW<int>)  (centroid 头索引)
  └─ norms_    (per-vector L2 norm²)
```

---

## 调用链路

```text
SpannIndex::PerformFilling(target_size, neighbor_topk, count_head, num_threads)  // builder.cpp:251
  ├─ BuildSnapshotForFilling()           // 深拷贝 cluster_*_ → snapshot_cluster_*_
  ├─ 启动 progress_thread (500ms 打印 %)
  ├─ 启动 num_threads 个 FillingWorker(tid, num_threads)   // :232
  │    └─ for cid = tid; cid < num_heads_; cid += num_threads:   // stride 分配
  │         if cluster_ids_[cid].size() < fill_target_size_:
  │           ├─ FillContext(cid, needed, neighbor_topk, radius=5)
  │           ├─ SearchNeighborCandidates(ctx)        // :108
  │           │    ├─ for retry = 0..10:
  │           │    │    ├─ QueryNeighborClustersByHead(cid, current_k)  // head_hnsw_->searchKnn
  │           │    │    ├─ 遍历邻居簇 snapshot_cluster_vecs_ 的每个向量
  │           │    │    │    算到 head 的 L2 距离, best_by_id[vid] = min(dist)
  │           │    │    └─ if 候选 ≥ needed: break; else current_k += radius
  │           │    ├─ nth_element + sort 取最近 needed 个
  │           │    └─ 写入 ctx.selected_ids/vecs
  │           ├─ cluster_ids_[cid].insert(selected_ids)   // 写原数据(非 snapshot)
  │           └─ cluster_vecs_[cid].insert(selected_vecs)
  └─ join workers + stop progress_thread
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `SpannIndex` 构造 | 加载 SPANN 三件输入 | `LoadHeads/LoadHeadIds/LoadMeta` |
| `LoadAllClusters` | 逐簇 pread posting list | `FetchCluster` 按 `MetaRecord` 算偏移，末尾追加 head |
| `BuildHeadHNSW` | 对 centroid 建 HNSW | 用 vendored `L2SpaceI_int8` + `HierarchicalNSW<int>` |
| `PerformFilling` | 补齐定长 cluster | 快照隔离 + 多线程 stride |
| `QueryNeighborClustersByHead` | 搜邻居 centroid | `head_hnsw_->searchKnn` 近似而非暴力 |
| `SearchNeighborCandidates` | 从邻居簇借向量 | retry 扩大 topk（`radius=5` 递增） |
| `performNorms` | 算 per-vector L2 norm² | 多线程，供在线 `rank_cal` |
| `saveHeadIndex`/`saveClusterIds`/`saveNorms` | 序列化产物 | `GetFixedClusterSizeOrThrow` 强校验定长 |

</details>

---

## 核心实现

### MetaRecord：SPANN 磁盘布局编码

SPANN 的 posting list 按 4KB page 对齐存储，`MetaRecord` 编码每个 cluster 的物理位置：

```cpp title="third_party/spann_aug/include/spann_index.h"
#pragma pack(push, 1)
struct MetaRecord
{
    int32_t  pg;    // page number — posting list 所在页号
    uint16_t off;   // page offset — 页内字节偏移
    int32_t  cnt;   // count — 该 cluster 的向量数
    uint16_t pc;    // page count
};
#pragma pack(pop)
static constexpr int64_t PAGE_SIZE = 4096;
```

`#pragma pack(push, 1)` 让 `MetaRecord` 紧凑成 12 字节（`static_assert(sizeof(MetaRecord) == 12)` 在 `spann_index_reader.cpp:6`）。`FetchCluster`（`spann_index_reader.cpp:152`）按 `abs_off = base_offset_ + meta_[cid].pg * PAGE_SIZE + meta_[cid].off` 用 `pread` 一次读整个 cluster——`PAGE_SIZE = 4096` 对齐 NVMe page，一次 I/O 拿一个 cluster，无需多次读。

### Filling 算法：补齐定长 cluster

SPANN 原始 cluster 大小不均（`meta_[cid].cnt` 各异），HV_CONST 要求定长 `cluster_size`。Filling 从邻居簇借向量补齐：

```cpp title="third_party/spann_aug/src/spann_index_builder.cpp (PerformFilling 节选)"
void SpannIndex::PerformFilling(int target_size, int neighbor_topk, bool count_head, int num_threads)
{
    // 校验 AllClustersLoaded() && head_hnsw_ != nullptr
    fill_target_size_ = target_size;
    BuildSnapshotForFilling();   // 深拷贝 snapshot_cluster_*_ = cluster_*_
    // 启动 num_threads 个 FillingWorker (stride: cid = tid; cid += num_threads)
}
```

**为什么需要 Filling**：HV_CONST 的定长 cluster 让 NVMe 读可以用固定大小的批量 I/O（`HyperConstImp::launchLoadClustersFromNVMe` 按 `per_cluster_size = cluster_size * dim` 算 `lba_cnt`）。如果 cluster 不定长，要么按最大值预留空间（浪费 NVMe），要么 per-cluster 查长度（破坏批量读）。Filling 不丢任何原始向量，只增加填充——借来的向量是真实数据的冗余副本，recall 不降反升。

**为什么用 snapshot 隔离**：多线程 Filling 时，簇 A 从簇 B 借向量并写入 B 的 `cluster_ids_`；若簇 B 随后也作为待填充簇向别人借，它会看到被 A 污染的候选集（含 A 的填充向量），更糟的是可能反向借回形成循环。`BuildSnapshotForFilling`（`builder.cpp:97`）深拷贝 `snapshot_cluster_*_`，`SearchNeighborCandidates` **只读 snapshot**、写入 `cluster_*_`（原数据）——所有 worker 看到一致的只读原始状态，写入只发生在自己的 `cluster_ids_[cid]`。

**借向量策略**：`SearchNeighborCandidates`（`builder.cpp:108`）对每个待填充簇，用 `QueryNeighborClustersByHead`（`:67`）在 `head_hnsw_` 上搜 topk 个邻居 centroid，遍历邻居簇的 snapshot 向量算到本簇 head 的 L2 距离，取最近的 `needed` 个。若候选不足，retry 时 `current_k += radius`（`radius=5`）扩大搜索范围，最多 10 次。

**为什么用 HNSW 搜邻居而非暴力**：centroid 数量 `num_heads_` 通常数万到数十万，每个待填充簇都要搜 topk 邻居，暴力是 O(num_heads²·dim)。HNSW 把单次查询降到 O(log(num_heads)·ef_search·dim)，且只需找"大致最近"的邻居簇借向量，近似足够。

### BuildHeadHNSW：centroid 头索引

```cpp title="third_party/spann_aug/src/spann_index_builder.cpp (:5-54)"
void SpannIndex::BuildHeadHNSW(int M, int ef_construction, int ef_search)
{
    head_space_ = std::make_unique<hnswlib::L2SpaceI_int8>(dim_);
    head_hnsw_ = std::make_unique<hnswlib::HierarchicalNSW<int>>(head_space_.get(), num_heads_, M, ef_construction, 100);
    // 多线程批量 addPoint
}
```

用 vendored hnswlib（`include/util/hnswlib/`，通过 `spann_core` 的 `SYSTEM PUBLIC ${CMAKE_SOURCE_DIR}/include/util` include path 暴露）。`L2SpaceI_int8`（`space_l2.hpp:400`）定义 int8 L2 距离，`HierarchicalNSW<int>`（`hnswalg.hpp:18`）是 `dist_t=int` 的 HNSW 图。构建参数（M=16, ef_construction=200, ef_search=128）记入 `_index_meta.json` 的 `centroid_build_param`，供在线 search 用相同参数。**为什么 head 单独建 HNSW**：两层架构——search 时先在内存 HNSW 找 nprobe 个最近 centroid，再去 NVMe 读对应 cluster。head 数量远小于全量向量，HNSW 可常驻内存。

### performNorms：离线预算 L2 norm²

```cpp title="third_party/spann_aug/src/spann_index_builder.cpp (:344)"
int32_t SpannIndex::performNorms()
{
    // 多线程: 对每个 cluster 的每个向量算 Σ vec[d]² (int32_t)
    // 存入 norms_[cid], 与 cluster_ids_ 一一对应, 按 cluster_size 定长
}
```

在线 search 时 `rank_cal.cpp:64` 用 `l2 = q_norm + h_norm - 2*IP` 推 L2 距离——`h_norm`（candidate norm²）若在线算需对每个 candidate 做 dim 次乘加，nprobe×cluster_size 个 candidate 是巨大开销。离线预算成 `int32_t`（int8 各维平方和），在线直接查表，把 dim 次乘加降到一次加法。

### 输出文件契约

`SaveArtifacts`（`test_tool_utils.h`）序列化四件产物，被 `HyperConstImp::deployIndex` 消费：

| 输出文件 | 格式 | 在线消费 |
| --- | --- | --- |
| `{prefix}_centroids_index.bin` | hnswlib `saveIndex` 二进制 | `HnswImp::loadIndex`（同款 hnswlib `loadIndex`） |
| `{prefix}_cluster_ids.bin` | `[num_clusters][cluster_size][uint64 ids]` | `HyperConstImp::initClusterExtraDuringDeploy` 用 `Dataset<uint64_t>` 读 |
| `{prefix}_cluster_norms.bin` | `[num_clusters][cluster_size][int32 norms]` | 同上，`Dataset<int32_t>` |
| `{prefix}_index_meta.json` | `index_type/vec_type/cluster_size/centroid_num/centroid_build_param` | `CollectionMeta::loadCollectionMeta` |

`saveClusterIds` 中的 `GetFixedClusterSizeOrThrow`（`spann_index_serializer.cpp`）强校验所有 cluster 等长——Filling 的产物必须定长，否则 deploy 时 NVMe 定长读会错位。`_rawdata.bin` 不由 spanns_build_index 产出，由用户手动 `cp` 原始数据集到输出目录（`meta_path.hpp:33` 定义文件名常量），deploy 时 `HyperConstImp::flushClustersToNVMeDuringDeploy` 用 `Dataset<int8_t>` 读取向量内容刷盘。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 快照隔离 | `BuildSnapshotForFilling`（`builder.cpp:97`） | Filling 读 snapshot、写原数据，避免簇间借向量连锁污染 |
| 并行 worker + 原子进度 | `FillingWorker` stride + `atomic fill_processed_clusters_`（`builder.cpp:232`） | 各 worker 写不同 cluster 无冲突，进度独立统计 |
| 模板特化 | `hnswlib::L2SpaceI_int8` + `HierarchicalNSW<int>`（`builder.cpp:5`） | int8 向量 L2 距离空间 |
| 紧凑布局 | `MetaRecord` `#pragma pack(push,1)` 12 字节（`spann_index.h`） | 减少元数据内存，对齐 NVMe page |
| 定长校验 | `GetFixedClusterSizeOrThrow`（`serializer.cpp`） | 保证 HV_CONST 定长契约 |

---

## 模块间交互

- **上游输入**：SPTAG（外部工具）产出 `SPTAGHeadVectors.bin`/`SPTAGHeadVectorIDs.bin`/`SPTAGFullList.bin`。
- **下游输出**：四件 HV_CONST 产物 + `_rawdata.bin`，被 `HyperConstImp::deployIndex` 消费——这是 offline→online 的数据契约。
- **vendored hnswlib**：`SpannIndex` 与 `HnswImp` 共用 `include/util/hnswlib/`（同一份 vendored 代码），保证 build 时 `saveIndex` 与 online `loadIndex` 二进制兼容。
- **CMake 隔离**：`spann_core` 是 STATIC 库（`third_party/spann_aug/CMakeLists.txt:21`），`spann_build_index` 链接它而非 `MiniHyperVec`；其他可执行文件链接 `MiniHyperVec` 而非 `spann_core`。两条链接线不交叉。

---

## 扩展方式

- **调 Filling 参数**：命令行 `--fill-target-size=128 --fill-neighbor-topk=32`（`test_tool_utils.h:126` 的 `ParseBuildIndexConfig`）。增大 `fill_target_size` 提 recall 但增 NVMe 读量；增大 `neighbor_topk` 提填充质量但减慢 Filling。注意 `fill_target_size` 必须与在线 `cluster_size` 一致（记入 `_index_meta.json`）。
- **改借向量策略**：替换 `SearchNeighborCandidates`（`builder.cpp:108`）的 `nth_element + sort` 为按距离加权采样或优先从最近簇借（当前跨簇全局排序）。需保持 `selected_ids`/`selected_vecs` 对应。
- **支持其他输入格式（如 FAISS IVF）**：新增 `SpannIndex` 构造重载或 factory 方法，实现对应的 `LoadHeads`/`LoadMeta`/`FetchCluster` 变体适配 FAISS inverted list 布局。下游 Filling/序列化不需改（操作内存 `cluster_ids_`/`cluster_vecs_`，与输入格式解耦）。
