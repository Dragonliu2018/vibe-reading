---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "图索引"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "HNSW", "NSG", "图算法"]
description: "Faiss 图索引解读——HNSW 三数组紧凑布局、v1.15 确定性无锁构建（ParlayANN 式两阶段）、MinimaxHeap 的 SIMD 线性 pop_min、NSG 单调图与 NNDescent 自举、图存储分离架构"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`faiss/impl/HNSW.cpp`（2,020 行）+ `faiss/IndexHNSW.cpp`（1,453 行）+ `impl/NNDescent.cpp` + `impl/NSG.cpp` 实现三种图结构：**HNSW**（分层可导航小世界，主实现，头注释自述 "heavily influenced by the NMSlib implementation by Yury Malkov"）、**NSG**（单调相对邻域图，引 Fu et al. VLDB 2019）、**NNDescent**（近邻图自举构建，引 Dong et al. WWW 2011，渊源 efanna/KGraph）。这层的架构特点是**图与向量存储彻底分离**：图只存 int32 id 与邻居，向量住在独立的 `storage`（完整 Index 对象）里，距离经 `storage->get_distance_computer()` 虚接口。

## 模块架构

![HNSW 布局与确定性构建](/vibe-reading/images/articles/faiss-internals/hnsw-deterministic.svg)

HNSW 的图数据是**三个数组的紧凑扁平布局**（HNSW.h:114-129）：`cum_nneighbor_per_level`（层容量前缀和，L0 = 2M、上层 = M）、`offsets`（每节点邻居起点）、`neighbors`（单一扁平 `MaybeOwnedVector<int32_t>`，-1 哨兵）——节点 i 的所有层的邻居连续存放，`neighbor_range`（HNSW.cpp:52）按层切区间。**容量在 `prepare_level_tab`（HNSW.cpp:214）插入时一次定死**——这是与 USearch 变长 tape 的根本差异。

## 核心实现

### v1.15 的关键变化：确定性无锁构建已是唯一路径

CHANGELOG 记 v1.15 "opt-in deterministic lock-free graph build"（#5486），但**本快照中 opt-in 开关已删除**：`IndexHNSW::add`（IndexHNSW.cpp:546-570）无条件调用 `hnsw_add_vertices_deterministic`——HNSW.h:281-285 注释明说 "This is the only graph build that add() uses"。老加锁路径（`add_links_starting_from` + `LockVector` 即 omp_lock_t 数组）仍保留但只剩休眠入口。

**确定性构建算法**（`hnsw_add_vertices_deterministic` in IndexHNSW.cpp:71-371，头注释注明受 ParlayANN arXiv:2305.04359 启发）：

1. 按层桶排序 + **固定种子置换**（`RandomGenerator rng2(789)`，IndexHNSW.cpp:145）消数据序偏置；前缀倍增批 1,1,2,4,8… 上限 2%·ntotal；
2. **Phase A（并发无锁）**：批内每点 `compute_forward_links_impl`（HNSW.cpp:801）从 entry 贪心下降 + efConstruction beam 找邻居 + 多样性剪枝，**只写 pt_id 自己的邻居槽**——注释点明机制："pt_id is not reachable yet, so the snapshot stays immutable"（批次内其他点不可能把它当邻居）；反向边不立即应用，只记进 `pt_reverse_edges`；
3. **Phase B（并发）**：反向边按目的地点分 256 桶做原地圈排序分区（IndexHNSW.cpp:263-302，O(total) 无辅助缓冲），`merge_reverse_links_impl`（HNSW.cpp:859）合并去重后**以 (距离, id 平局破序) 全序排序再剪枝**——结果与收集顺序无关；
4. entry_point 延迟提升到批次结束，避免指向未链接的点。

确定性来源三支柱：固定种子 + Phase A 快照不变式 + Phase B 每节点恰被一个线程全序合并（IndexHNSW.cpp:259 注释 "lock-free and thread-count-independent"）。Phase B 特意不用 `schedule(dynamic)`——libomp 动态分发器在某些构建下段错误（IndexHNSW.cpp:308 注释）。

**多样性剪枝**（`shrink_neighbor_list`，HNSW.cpp:245-290）：候选按距 query 由近到远逐个考虑，若存在已保留邻居 v2 使 `d(v1,v2) < d(v1,q)` 则淘汰——与 NSG 的单调剪枝同族判据。`prune_headroom = 0.2`（HNSW.h:148）剪枝留 20% 空余防热点节点反复 O(n²) 剪枝与锁竞争。`keep_max_size_level0=true` 时被淘汰者进 `outsiders` 向量回收填满 L0（为 GpuIndexCagra 互转服务，HNSW.cpp:251-254）。

### 搜索：两层结构与反直觉的 MinimaxHeap

`search_impl`（HNSW.cpp:1718-1828）：上层（level≥1）`greedy_update_nearest_impl`（HNSW.cpp:702）贪心——4 邻居一批 `distances_batch_4`，有更近就跳；底层 `search_from_candidates_fixVT`（HNSW.cpp:1117-1239）efSearch beam——候选堆 pop_min 展开邻居、全部新邻居 push（hnswlib 经典 beam 语义）。`check_relative_distance` 剪枝（HNSW.cpp:1158-1167）：候选堆里已有 ≥ efSearch 个更近的点被处理过则提前 break。

**MinimaxHeap 的反直觉设计**（impl/hnsw/MinimaxHeap.h:32）：push 是堆操作 O(log n)（NaN 距离按 `HC::neutral()` 处理保持堆序；堆满且 `!HC::cmp(dis[0], v)` 直接丢弃），pop_min 却是对整个数组 **SIMD 线性扫描** O(n/8)（`MINIMAX_HEAP_SIMD_LEVELS` 覆盖 NONE/AVX2/AVX512 三档，MinimaxHeap.cpp:14-24）——因为搜索循环每轮一次 pop_min、多次 push，且堆大小 = efSearch（几十），线性扫描配 SIMD 比维护真双端堆更快更简单。`impl/hnsw/avx2.cpp:27`（8 路找最优+下标，blendv 掩码过滤 -1 无效槽、平局取右保确定性）与 `avx512.cpp:24`（16 路）就是 hnsw 加速层的全部内容。`VisitedTable`（impl/VisitedTable.h:39）双实现：版本号数组（advance O(1) 清零）与哈希集（大索引省内存），热循环经 dynamic_cast 分发消除虚调用（HNSW.cpp:1244 注释 "so that vt.set/advance are inlined"）。

**C_distance/C_similarity 双比较器**（HNSW.h:70-75）：所有核心算法写一份 `template <class C>`，CMax（距离小优）/CMin（相似度大优）双实例化——内积类度量直接用大优堆不再取负（NSG/NNDescent 仍是老的 `NegativeDistanceComputer` 取负法，NSG.cpp:32-38）。

### IndexHNSW：图与存储分离的宿主

`IndexHNSW`（IndexHNSW.h:30）持 `HNSW hnsw` + `Index* storage`——storage 是**完整独立的 Index 对象**（不限于 FlatCodes：`IndexHNSW2Layer` 塞的是 Index2Layer/IndexIVFPQ），可单独 train/reconstruct。变体全部只是"换 storage 构造"：IndexHNSWFlat/SQ/PQ/RaBitQ（nb_bits≥2 时设 `SM_RABITQ` 两段式搜索：每邻居先 1-bit 估计，误差界打不过阈值才解全码，HNSW.cpp:1081）、`IndexHNSW2Layer`（"mixed"搜索：IVFPQ 粗量+精排做种再图搜索）、`IndexHNSWCagra`（GPU CAGRA 图互转桥：level-0 不重算直接平铺 CAGRA 图，`copyTo` in GpuIndexCagra.cu:667-858；`base_level_only = false` 与 `num_base_level_search_entrypoints = 256`——后者为 true 时随机抽 256 个入口只搜 L0，IndexHNSW.h）。`IndexHNSWFlatPanorama`（论文 arXiv:2510.00566）：搜索用累积和表的 Cauchy-Schwarz 下界剪枝——高维（d>512）且能量集中前若干维时有效，recall 不保证与 vanilla HNSW 相同。

### NNDescent：自举 kNN 图

`impl/NNDescent.cpp:337` 的 `nndescent` 迭代 join + update 各 10 次。**local join**（NNDescent.cpp:100-215）：两个点只有至少一方是"新"邻居才互相算距离互插候选池——"邻居的邻居大概率也是近邻"使收敛呈指数级，每轮 O(N·S·M) 而非 O(N²)。`update`（NNDescent.cpp:219-335）：池排序截 L、挑 S 个新邻居、为邻居登记反向链，老邻居对不再 join。质量评估：随机抽 `NUM_EVAL_POINTS = 100` 点暴力算精确 kNN 打 recall。默认参数 S=10、R=100、iter=10、`random_seed = 2021`（NNDescent.h:146）；构造 `L = K + 50`（NNDescent.cpp:194），build 断言 L ≥ K 且 n > 100。**定位澄清**：NNDescent 产出单层 kNN 图，**是 NSG 的输入**（IndexNSG.cpp:150 build_type==1 时内嵌）而非 HNSW 的替代构建器；限制 n > 100（NNDescent.cpp:436）。

### NSG：单调图 + 中心入口点

`impl/NSG.cpp:140-204` 的构建（构造 `L = R + 32`、`C = R + 100`，rng 种子 0x0903，NSG.cpp:115-116；搜索 pool_size = max(search_L, k)）：`init_graph` 算全数据集**质心**，从随机点搜出离质心最近的点做 enterpoint（导航点≈数据中心，保证贪心路径不穿不过去）→ `link`：每点在 kNN 图上搜路径访问集 + 直接邻居进 `sync_prune`（NSG.cpp:385-453）——候选按距离排序，存在已保留的 r 使 `d(r,p) < d(q,p)` 则遮挡淘汰，保证任意两点间**单调路径**（每步都更近），贪心搜索必达，故度可以比 HNSW 更低（R 边）→ `add_reverse_links` 带锁重剪保证无向可达 → `tree_grow` 连通分量检测 + `attach_unlinked`（注释 NSG.cpp:601：与原论文不同，连到 pool 中度数 <R 的最近点而非生成树，保住度上限）。限制：**不支持增量 add**（IndexNSG.cpp:144 硬断言）。

### 与 USearch 实现的架构对比

| 维度 | Faiss HNSW | USearch index_gt |
|------|-----------|------------------|
| 布局 | 容量前缀定死（三数组，-1 哨兵） | 变长 tape（节点所有数据一次分配） |
| 扩容 | 不能（M 定死不能改，HNSW.h:116 注释） | 可（节点边满整体拷到 tape 末尾） |
| 图/存储 | 彻底分离（storage 是完整 Index） | 引擎无值感知（vector 数据在 dense 层） |
| 边存储 | int32（storage_idx_t，头注释自嘲 "expensive"） | compressed_slot（uint32/40/64 可选） |
| 构建 | v1.15 确定性无锁（ParlayANN 式） | 加锁增量（per-node striped locks） |
| 比较器 | CMin/CMax 模板双实例 | 距离统一取负转 min-heap |
| 度量注入 | storage->get_distance_computer() 虚接口 | metric duck-typing 模板参数 |

两条路线各有哲学：Faiss 把"图的形状"静态化换确定性布局与整图重排能力（`permute_entries`）；USearch 用动态 tape 换插入灵活性。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板双实例 | `template <class C>` 全核心算法（HNSW.cpp:591 起） | 距离/相似度一份代码 |
| 两阶段无锁 | Phase A 写己槽 + Phase B 按目的分组（IndexHNSW.cpp:71） | 确定性 + 线程数无关 |
| 全序平局破序 | (距离, id) 排序（HNSW.cpp:911 注释） | 结果与收集顺序无关的第二个支柱 |
| 存储策略 | storage 指针注入任意 Index | 一套图算法服务所有编码 |
| dynamic_cast 消虚 | fixVT 分发器（HNSW.cpp:1244） | 热路径内联 VisitedTable |

## 模块间交互

向下消费 [DistanceComputer](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction)（storage 提供）与 [simdlib](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/06-simd-distances)（MinimaxHeap 加速）；向上被 IndexHNSWFlat/SQ/PQ/RaBitQ 变体包装；GPU 侧经 `IndexHNSWCagra` 与 [CAGRA](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/08-gpu-backend) 互转；`IndexIVF(HNSW32)` 让 HNSW 当 IVF 的粗量化器（大数据集 nlist > 26 万时的选择）。

## 扩展方式

- **调超参**：`efConstruction`（默认 40，构建 beam 宽）/ `efSearch`（默认 16，查询 beam 宽，ef = max(efSearch, k)）；查询期用 `SearchParametersHNSW` 免改索引临时调。
- **换图存储编码**：`new IndexHNSW(any_index, M)` 直接注入；**注意 M 在首个 add 前定死**（cum_nneighbor_per_level 不可后改）。
- **从外部图构建**：`init_level_0_from_knngraph`（休眠路径）或 NSG 的显式 `build(n, x, knn_graph, GK)` 接口。
- **内存微调**：`use_visited_hashset`（大索引省 O(ntotal) 数组）、`prune_headroom`（0~0.5）。
