---
source:
  type: "源码解读"
  project: "Helmsman"
  url: "https://github.com/Red-EAD/helmsman"
title: "索引层"
date: "2026-08-18T21:08:07+08:00"
category: ["AI", "Infra", "Retrieval", "Helmsman", "CodeWiki", "1.0"]
tags: ["Helmsman", "MiniHyperVec", "ANNS", "IndexAbs", "HyperConstImp", "SIMD"]
description: "Helmsman 索引层：IndexAbs 抽象、HnswImp 内存头索引、HyperConstImp 七步搜索流水线、AVX2/512 int8 内积内核与 Top-K 排序。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/00-overview)

---

## 模块定位

索引层是 Helmsman 的算法心脏，回答"给定一个 query 向量，如何找出最近的 K 个"。它定义了统一的 `IndexAbs<int32_t>` 抽象，提供两条实现：纯内存 `HnswImp`（小数据集/基线）与 `HyperConstImp`（HV_CONST 聚簇，系统核心）。`HyperConstImp` 把一次查询拆成"内存找 centroid → NVMe 读 cluster → SIMD 内积 → Top-K 排序"七步流水线，是论文"聚簇反击"思想的直接代码体现。本层还包含 `compute`（AVX2/AVX-512 int8 内积 + Top-K 排序内核）与 `prune`（剪枝，可选）。

边界：索引层只管"算法与数据布局"，不管"并发调度"（那是运行时层）和"I/O 怎么提交"（那是 NVMe 层）——但 `HyperConstImp` 通过持有 `ClusterMap`/`ClusterExtra`（运行时层目录下的值成员）和调用 `NVMeManager::readSubmit`，成为三层的编排中枢。

---

## 模块架构

```text
                    IndexAbs<int32_t>  (include/index/index_abs.hpp)
                    虚接口: searchKnn / deployIndex / getIndexType
                         ▲                ▲
                         │ 继承           │ 继承
              ┌──────────┘                └──────────┐
        HnswImp<int32_t>                     HyperConstImp<int32_t>
        (include/index/hnsw_imp.hpp)         (include/index/hyperconst_imp.hpp)
        持有 hnswlib::HierarchicalNSW        持有四个值成员:
        纯内存 HNSW 搜索                      ├─ centroid_index  : unique_ptr<IndexAbs>  (= HnswImp)
                                             ├─ prune_tool      : unique_ptr<PruningTool>
                                             ├─ m_cluster_map   : ClusterMap          (cluster_id→NVMe 条带)
                                             └─ m_cluster_extra : ClusterExtra<int32_t>(cluster IDs+norms)

   compute/                                  prune/
   ├─ distance_cal.hpp  (AVX2/AVX512 int8 IP)   └─ PruningToolNaive (默认)
   └─ rank_cal.hpp      (RankPair + Top-K L2)
```

`HyperConstImp` 不是单一索引，而是**组合体**——它把"头索引（内存 HNSW）+ 剪枝器 + 聚簇映射 + 聚簇数据"四个组件桥接在一起，自身只编排七步流水线。这种桥接设计让各组件可独立替换（如头索引换 IVF、剪枝换 LightGBM）。

---

## 调用链路

`HyperConstImp::searchKnn` 的七步流水线是本模块的核心调用链（全局数据流图见概览）：

```text
HyperConstImp::searchKnn(search_param, query, res, search_resource)   // source/index/hyperconst_imp.cpp:811-858
  │
  ├─ findNearestClustersDuringSearch           // :629-652
  │    ├─ centroid_index->searchKnn(...)        //   HnswImp → hnswlib HNSW 图搜索 → centroid_dists
  │    └─ prune_tool->pruneScan(...)            //   可选，减小 nprobe → probe_ids
  │
  ├─ launchLoadClustersFromNVMeDuringSearch    // :654-700
  │    ├─ m_cluster_map.getClusterStripeBatch   //   probe_ids → ClusterStripe{nvme_id, lba_id}[]
  │    └─ NVMeManager::readSubmit (per device)  //   异步提交 SPDK 读 → io_read_buf
  │
  ├─ prepareExtrasAndRankPairsDuringSearch     // :702-729  ← 与 NVMe I/O 重叠（纯内存）
  │    ├─ m_cluster_extra.getClusterIDsNormsBatch  // → cluster_ids + cluster_norms
  │    └─ SearchCPUFuncL2::prepareRankPairs        // → RankPair[]
  │
  ├─ pollNVMeCompletionsDuringSearch           // :731-748  ← 阻塞等待 I/O 完成
  │    └─ NVMeManager::pollCompletions
  │
  ├─ calculateInnerProductDuringSearch         // :750-766
  │    └─ compute::InnerProductInt8InBatch (AVX2/512)  // query × cluster_vecs → int32 IP[]
  │
  └─ rankFinalTopKDuringSearch                 // :768-809
       └─ SearchCPUFuncL2::rankTopK             //   L2 = -2·IP + q_norm + h_norm → partial_sort → res
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `searchKnn` | 七步流水线编排 | I/O 提交(②)与计算(③)重叠，(④)才阻塞 |
| `findNearestClustersDuringSearch` | 内存 HNSW 找 nprobe 个 centroid | 剪枝在此介入，决定后续 I/O 量 |
| `launchLoadClustersFromNVMeDuringSearch` | 提交 SPDK 异步读 | 按 nvme_id 分 queue，批量提交 |
| `prepareExtrasAndRankPairsDuringSearch` | 取 cluster IDs/norms + 构造 RankPair | 纯内存，与 NVMe DMA 并行 |
| `pollNVMeCompletionsDuringSearch` | 轮询完成队列 | 每设备独立 poll |
| `calculateInnerProductDuringSearch` | SIMD int8 批量内积 | AVX-512BW 优先，8 向量×64 dim 一块 |
| `rankFinalTopKDuringSearch` | L2 排序取 topk | norms 离线预算，分块 partial_sort + 去重 |
| `deployIndex` | 五步部署（写路径） | 见概览运行时行为 |
| `loadIndex` | 加载已部署索引 | 5 个 `*DuringLoad` 子方法 |

</details>

---

## 核心实现

### IndexAbs 抽象与模板全特化

`IndexAbs` 是整个索引层的契约，用模板全特化锁定到 `int32_t`（int8 向量 + int32 距离）：

```cpp title="include/index/index_abs.hpp"
template <typename T>
class IndexAbs;

template <>
class IndexAbs<int32_t>
{
public:
    virtual int32_t searchKnn(
        const SearchParam &search_param, const std::vector<int8_t> &query,
        std::vector<std::pair<uint64_t, int32_t>> &res,
        resource::SearchTempResource *search_resource = nullptr);
    virtual int32_t deployIndex(
        const std::string &collection_name,
        const resource::DeployTempResource &deploy_resource);
    virtual collection::IndexType getIndexType() const;
    collection::VecType getVecType() const { return collection::VecType::INT8; }
};
```

**为什么用全特化而非通用模板**：当前系统只支持 int8 量化向量（`VecType::INT8`），距离用 `int32_t` 容纳 int8 内积累加。全特化把类型锁死，避免通用模板的代码膨胀，同时保留"加 `IndexAbs<float16_t>` 特化即支持新类型"的扩展点。`SearchParam`/`BuildParam` 也是同样的模板特化族（`include/index/params.hpp`），`MiniHyperVecConstSearchParam` 嵌套 `centroid_search_param`——HV_CONST 的搜索参数里包了一个头索引的搜索参数，对应两层检索结构。

### HyperConstImp 七步搜索流水线

`HyperConstImp` 是系统心脏，991 行（`source/index/hyperconst_imp.cpp`）。它的核心设计是把 `searchKnn` 拆成七个 `*DuringSearch` 方法，让 **NVMe I/O 提交与 CPU 计算重叠**：

```cpp title="source/index/hyperconst_imp.cpp (searchKnn 编排，:811-858 节选)"
// Step 1: 内存 HNSW 找 centroid + 剪枝
findNearestClustersDuringSearch(search_param, query, probe_ids);
// Step 2: 提交 NVMe 异步读（立即返回，不等待）
launchLoadClustersFromNVMeDuringSearch(probe_ids, cluster_stripe,
                                       search_resource, nvme_que_submits);
// Step 3: 纯内存操作——与 NVMe DMA 传输并行
prepareExtrasAndRankPairsDuringSearch(probe_ids, search_resource);
// Step 4: 此时才阻塞等待 NVMe 读完成
pollNVMeCompletionsDuringSearch(nvme_que_submits);
// Step 5: SIMD 内积
calculateInnerProductDuringSearch(query, total_clusters, search_resource);
// Step 6: Top-K 排序
rankFinalTopKDuringSearch(query, total_clusters, search_param,
                          search_resource, res);
```

**为什么拆七步**：如果用同步 `read()`，CPU 在每次 NVMe 读时都空等微秒级延迟。拆开后，Step 2 只提交异步读请求（SPDK `spdk_nvme_ns_cmd_read` 提交即返回），Step 3 立即做纯内存的 `ClusterExtra` 查表与 `RankPair` 构造——这段时间 NVMe DMA 在后台传输数据，Step 4 才阻塞轮询完成。这样 CPU 计算与 I/O 传输重叠，把 nprobe 个 cluster 的读延迟摊薄。这是整个系统低尾延迟的关键。

**剪枝介入点**：`findNearestClustersDuringSearch` 在 `centroid_index->searchKnn` 返回 centroid 距离后、提取 probe_ids 前，调用 `prune_tool->pruneScan`（`:643-645`）：

```cpp title="source/index/hyperconst_imp.cpp (:643-645)"
uint32_t out_probe_prune = 0;
prune_tool->pruneScan(search_param, query, centroid_dists, out_probe_prune);
probe_count = std::min(probe_count, out_probe_prune);
```

剪枝直接决定 `probe_count`，进而决定后续 NVMe I/O 量与计算量——在 I/O 提交前砍掉不必要的 cluster 是最高性价比的优化。

### HnswImp 内存头索引

`HnswImp` 封装 vendored hnswlib 的 `HierarchicalNSW`，作 `HyperConstImp` 的 `centroid_index`（头索引），也独立支持纯内存 HNSW 搜索（`IndexType::HNSW`）：

```cpp title="include/index/hnsw_imp.hpp"
template <>
class HnswImp<int32_t> : public IndexAbs<int32_t>
{
public:
    std::unique_ptr<hnswlib::SpaceInterface<int32_t>> m_space;
    std::unique_ptr<hnswlib::HierarchicalNSW<int32_t>> m_hnsw;
    uint32_t m_dim; uint32_t m_inner_M; uint32_t m_build_ef; uint32_t m_search_ef;
    // ...
    int32_t searchKnn(const SearchParam &search_param, const std::vector<int8_t> &query,
                      std::vector<std::pair<uint64_t, int32_t>> &res,
                      resource::SearchTempResource *search_resource = nullptr) override;
};
```

**为什么头索引用 HNSW 且常驻内存**：centroid 数量（`num_heads_`）远小于全量向量数，HNSW 图可常驻内存；search 时先在内存 HNSW 上找 nprobe 个最近 centroid（O(log N)），再去 NVMe 读对应 cluster。如果头索引也在 NVMe 上，每次查询多一次随机读，尾延迟不可控。`HnswImp::searchKnn`（`source/index/hnsw_imp.cpp:184-208`）支持 `HnswSearchParam::max_visits` 限制访问节点数，控制头索引搜索的延迟上界。

### SIMD int8 内积内核

`compute/distance_cal.hpp` 是性能关键路径——批量计算 query 与 nprobe×cluster_size 个 int8 向量的内积。它提供 AVX-512BW 与 AVX2 两套实现，运行时按 CPU 能力分发：

```cpp title="include/compute/distance_cal.hpp (AVX2 内核节选，:76-186)"
__attribute__((target("avx2"))) static inline void InnerProductInt8InBatch_AVX2(
    const int8_t *x, const int8_t *y, int32_t *out, uint32_t dim, uint64_t batch)
{
    // 每次 4 个向量，32 dim 一块
    for (; j + 3 < batch; j += 4) {
        __m256i acc0 = _mm256_setzero_si256(); // ... acc1/acc2/acc3
        for (; i + 32 <= dim; i += 32) {
            __m128i x_lo8 = _mm_loadu_si128(...);          // 取 16 个 int8
            __m256i x_lo16 = _mm256_cvtepi8_epi16(x_lo8);   // int8 → int16 ( widening )
            // ... 对 y0..y3 各做：
            acc0 = _mm256_add_epi32(acc0,
                _mm256_madd_epi16(x_lo16, y_lo16));         // int16×int16 → int32 累加
        }
        out[j+0] = (int32_t)hsum_epi32_avx2(acc0); // ... 
    }
}
```

**为什么用 int8 而非 float**：int8 量化让向量内存缩 4 倍（NVMe 读量同步减 4），且 `_mm256_madd_epi16` 一条指令完成 16 个 int16 乘加再聚合成 int32，吞吐远高于 float FMA。代价是精度损失（量化误差），但 ANNS 场景容忍近似。

**int8→int16→int32 累加链**：int8 直接相乘会溢出（int8×int8 最大 16384，超 int16 范围需 int32），所以先 `_mm256_cvtepi8_epi16` 把 int8 宽化为 int16，再用 `_mm256_madd_epi16`（packed 乘加：int16×int16→int32 并累加相邻对），最后 `hsum_epi32_avx2` 水平求和。每次循环 32 维，4 个向量并行累加——AVX-512 版本（`:188-280`）扩到 8 向量×64 维。还带 `_mm_prefetch`（`HV_PFD_I8_AVX2=256`）预取下一块，隐藏内存延迟。

### Top-K 排序：从内积推 L2

`rank_cal` 把内积结果转成 L2 距离并取 Top-K。关键公式 `L2 = q_norm + h_norm - 2·IP`：

```cpp title="include/compute/rank_cal.hpp"
struct cpu_cmp_noaxpy
{
    const int32_t *distances; int32_t q_norm; const int32_t *h_norms;
    bool operator()(const RankPair &lhs, const RankPair &rhs) const
    {
        return -2 * distances[lhs.pos] + q_norm + h_norms[lhs.pos]
             < -2 * distances[rhs.pos] + q_norm + h_norms[rhs.pos];
    }
};
```

`distances[pos]` 是在线算的内积（IP），`q_norm` 是 query 的 L2 norm²（在线算一次），`h_norms[pos]` 是 candidate 的 L2 norm²——**离线预算**（`SpannIndex::performNorms`，见 [04-index-builder](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/04-index-builder)）。展开 `||q−h||² = ||q||² + ||h||² − 2·q·h`，避免在线对每个 candidate 做 dim 次乘加算完整 L2。

`rankTopK`（`source/compute/rank_cal.cpp:26-79`）用分块 `partial_sort`（block = `min(remain, 2*k)`）+ `unordered_set` 去重（同一向量 ID 可能出现在多个 cluster 的填充区）取最终 topk。

### 剪枝：PruningTool

```cpp title="include/prune/prune_tool.hpp"
template <>
class PruningTool<int32_t>
{
public:
    virtual int32_t pruneScan(const index::SearchParam &search_param,
                              const std::vector<int8_t> &query,
                              const std::vector<std::pair<uint64_t, int32_t>> &centroid_res,
                              uint32_t &out_probe);
};

template <>
class PruningToolNaive<int32_t> : public PruningTool<int32_t>
{
public:
    uint32_t max_probe = 1024;
    int32_t pruneScan(...) override;  // out_probe = min(max_probe, centroid_res.size())
};
```

PoC 中只实现了 `PruningToolNaive`（`source/prune/prune_tool.cpp:18-25`），逻辑极简：`out_probe = min(max_probe, centroid_res.size())`。论文 Section 5.4 的真正剪枝用 LightGBM + ONNX 预测 nprobe——接口已留好（`pruneScan` 传入 centroid 距离），只需新建 `PruningToolLGBM` 子类并在 `loadPruneToolDuringLoad` 替换。关键约束：剪枝在查询关键路径同步调用，模型推理必须微秒级。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板全特化 | `IndexAbs<int32_t>` / `HyperConstImp<int32_t>`（`index_abs.hpp`） | 锁定 int8/int32 类型，避免代码膨胀，保留加新类型的扩展点 |
| 策略 | `IndexAbs` 多态，`HnswImp`/`HyperConstImp` 二选一 | `searchKnn` 统一接口屏蔽两条搜索路径 |
| 桥接/组合 | `HyperConstImp` 持有 `centroid_index`+`prune_tool`+`m_cluster_map`+`m_cluster_extra`（`hyperconst_imp.hpp`） | HV_CONST 是组合体，各组件可独立替换 |
| 模板方法 | `searchKnn` 编排七步 `*DuringSearch`（`hyperconst_imp.cpp:811-858`） | 固定流水线骨架，每步可独立调优 |
| 运行时分发 | `InnerProductInt8InBatch` 按 `cpu_has_avx512bw()` 选 kernel（`distance_cal.hpp:282-297`） | 一份代码适配 AVX2/AVX-512，运行时选最优 |

---

## 模块间交互

索引层是三层编排中枢，向下依赖 NVMe 层与运行时层，向上被运行时层持有：

- **被谁持有**：`runtime::IndexHolder`（单例）持有 `shared_ptr<IndexAbs<int32_t>>`，`ServingWorker::searchKnn` 通过 `IndexHolder::getIndex` 取出调用；`runtime::OfflineWorker::deployIndex` 构造 `HyperConstImp` 调 `deployIndex`。
- **依赖 NVMe 层**：`HyperConstImp` 调 `NVMeManager::readSubmit`/`writeSubmit`/`pollCompletions`（search 读、deploy 写）与 `NVMeAllocator::allocate`（deploy 分配空间）。
- **依赖运行时层（回向）**：`HyperConstImp` 持有 `ClusterMap`/`ClusterExtra` 作为**值成员**（非单例）——这两个类在 `source/runtime/cluster/` 目录下，逻辑上服务于索引检索，所以由索引层持有。这是索引层向运行时层目录的回向耦合，但语义自洽。
- **依赖基础设施层**：`CollectionMeta`（元数据加载）、`Dataset<T>`（deploy 时读 cluster_ids/rawdata）、`params`（搜索/构建参数族）。

> 无循环依赖（graphify `Import Cycles: None detected`）。`HyperConstImp → ClusterMap` 是单向持有。

---

## 扩展方式

- **新增 vec_type（如 float16）**：加 `IndexAbs<float16_t>` 特化 + `distance_cal` 的 FP16 SIMD kernel + `HyperConstImp<float16_t>` 特化 + `SearchResource` 的 buffer 类型。改动面广，模式见概览「典型修改场景 1」。
- **新增 centroid 索引类型（如 IVF）**：实现 `IvfImp<int32_t> : IndexAbs<int32_t>`，在 `loadInmemIndexDuringLoad`（`hyperconst_imp.cpp:882-914`）的 switch 加 `case IVF`，在 `param.cpp` 的 `from_json` switch 加 `IvfBuildParam`。扩展点已预留。
- **替换剪枝实现**：新建 `PruningToolLGBM` 子类 override `pruneScan`，在 `loadPruneToolDuringLoad`（`:947-952`）改 `make_unique`。接口无需改动。
