---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "IVF 倒排骨架"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "C++", "倒排索引", "OpenMP"]
description: "Faiss IndexIVF 解读——粗量化选 list、InvertedLists 四种存储变体（Array/OnDisk/Block/Panorama）、InvertedListScanner 编码多态、parallel_mode 四档并行与 DirectMap 反向定位"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`faiss/IndexIVF.cpp`（1,577 行）+ `faiss/invlists/` 是 Faiss 大多数索引的骨架。IVF（倒排文件）模式：**粗量化器把向量分进 nlist 个 list → 倒排表存编码 → 查询时只扫 nprobe 个最近 list**。这带来四个结构性收益：搜索复杂度与 ntotal 解耦（非穷举）；可超 RAM（`OnDiskInvertedLists` mmap 按需换页）；list 相互独立天然并行；跨索引可合并（支撑分布式分片训练）。子类（IVFFlat/IVFPQ/IVFPQR/IVFAdditiveQuantizer/IVFSpectralHash/IVFFastScan 系）只换"编码格式"这一层——`IndexIVFPQ` 存 PQ 码、`IndexIVFFlat` 直接存残差浮点，骨架完全复用。

## 模块架构

![IndexIVF 三层结构](/vibe-reading/images/articles/faiss-internals/ivf-structure.svg)

三层解耦：quantizer（也是 Index，可换 IndexFlat/IndexHNSW/IndexLSH）负责"向量 → list_no"映射；invlists 负责存储（四种变体）；编码由子类的 `encode_vectors` 纯虚决定。`SearchParametersIVF`（IndexIVF.h:68）承载查询期旋钮：nprobe、max_codes（预算早停）、`ensure_topk_full`、`quantizer_params`（透传粗量化器）等。

## 核心实现

### add：线程认领 list 的取模分组

```
add_with_ids(n, x, ids)                     faiss/IndexIVF.cpp:205
├─ quantizer->assign(n, x, coarse_idx)      每向量最近质心 = list_no
├─ add_core（IndexIVF.cpp:227-302）：
│   ├─ encode_vectors（子类纯虚，IndexIVF.h:268）批量编码
│   └─ OpenMP：每线程认领 list_no % nthreads == rank 的子集
│        invlists->add_entry(list_no, id, code) + dm_adder.add(i, list_no, ofs)
└─ list_no == -1 的向量被丢弃（质心不够 multiprobe）
```

并发安全依赖 InvertedLists 的线程契约（InvertedLists.h:52-56）："不同 list 的并发写是安全的"——只锁同 list。`IndexIVFPQ::add_core_o`（IndexIVFPQ.cpp:236-356）先 `compute_residuals`（逐条 `quantizer->compute_residual`）再 PQ 编码，可输出二级残差供 IVFPQR。`IndexIVFFlat::add_core`（IndexIVFFlat.cpp:60）跳过编码直接把原始 float 指针当 code——构造时 `by_residual = false`。

### search：search_preassigned 扫描引擎

`IndexIVF::search`（IndexIVF.cpp:320）薄层：quantizer 找 nprobe 个最近 list → `invlists->prefetch_lists`（OnDisk 场景多线程预读）→ `search_preassigned`（IndexIVF.cpp:416-783）。后者是真正的引擎，源码自嘲注释（IndexIVF.cpp:316-319）："概念上简单的函数一旦叠加多种并行方式 + 中断/异常处理 + 统计就变得非常复杂；95% 的时间走 parallel_mode=0 路径"。

每线程：`get_InvertedListScanner(store_pairs, sel, params)` 取 scanner → lambda `scan_one_list`（IndexIVF.cpp:551-634）：`scanner->set_list(key, coarse_dis)` → RAII 的 `ScopedCodes/ScopedIds` 拿裸指针 → `scanner->scan_codes(list_size, codes, ids, HeapResultHandler)`。`IDSelectorRange` 且 assume_sorted 时用 `find_sorted_ids_bounds` 直接收缩 list 范围（IndexIVF.cpp:601-612）。

**parallel_mode 四档**（IndexIVF.h:205-212）：

| 模式 | 粒度 | 适用 | 代价 |
|------|------|------|------|
| 0（默认） | 按查询切 | 批查询 | 无锁无归并，支持 max_codes 早停（`FAISS_THROW_IF_NOT_FMT(cur_max_codes == 0 \|\| pmode == 0 \|\| pmode == 3)`——预算仅 pmode 0/3 支持；`ensure_topk_full` 时预算抬到 `max(cur_max_codes, k)`） |
| 1 | 按 list 切（schedule(dynamic)） | 单查询低延迟 | 局部堆 + `omp critical` 归并，不支持 max_codes |
| 2 | (query, probe) 笛卡尔积 | 大 nprobe | 双维并行 |
| 3 | 更细粒度查询切 | 不均查询 | — |

+ `PARALLEL_MODE_NO_HEAP_INIT`（=1024，位掩码）：init/reorder no-op，供调用方接管堆生命周期（IndexRefine 场景）。异常不能穿越 OpenMP region（会 `std::terminate`），用 `omp_capture_exception` + `std::atomic<bool>` interrupt 协作取消（IndexIVF.cpp:496-501）。

### InvertedLists：存储抽象与四变体

纯虚接口（InvertedLists.h:58-151）：读侧 `list_size/get_codes/get_ids`（get 后 `release_*`，给需要拼装/释放的实现留口）；写侧 `add_entries/update_entries/resize`。四变体对比：

| 变体 | 布局 | 要点 |
|------|------|------|
| **ArrayInvertedLists**（InvertedLists.cpp:264） | `vector<MaybeOwnedVector<uint8_t>> codes` + ids 平行数组 | 默认；add 就是 resize+memcpy；`permute_invlists` 支持质心重排 |
| **OnDiskInvertedLists**（23.6K 行） | 单 mmap 区，每 list 一段 `codes[capacity×code_size]+ids[capacity]`；capacity 取整 2 的幂；`std::list<Slot>` 空闲区表 | `resize_locked`（OnDiskInvertedLists.cpp:445-485）：new_size 在 **[capacity/2, capacity] 区间就地改 size**；否则 `new_l.capacity` 从 1 起翻倍 while 循环到 ≥ new_size，free 旧区 + allocate 新区（best-fit 扫描 slots，不够则文件翻倍扩容）+ memcpy 迁移；`prefetch_nthread` 默认 32 线程预读。头文件明言"追加慢，先攒 Array 再 merge_from"（OnDiskInvertedLists.h:50-54） |
| **BlockInvertedLists** | FastScan 的 32 向量交织块，`code_size = (size_t)-1` 哨兵 | 布局由 CodePacker 解释（见 [FastScan](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/04-fastscan)） |
| **ArrayInvertedListsPanorama**（InvertedLists.cpp:300） | level-oriented：每 list 的 code 按 n_levels 层转置 + 每向量累积和表 | 论文 arXiv:2510.00566；`get_iterator` 直接抛异常（层布局无法廉价重组顺序码） |

另有**元倒排表**（头文件术语："倒排表视为稀疏矩阵，可横竖拼接与切片"，InvertedLists.h:346-351）：HStack（横拼）/VStack（竖拼二分定位）/Slice（list 区间）/Masked/StopWords（跳过大 list）/Capped（v1.15 新增：每 list 截断但保留写能力）。

### InvertedListScanner：编码格式多态核心

`faiss/IndexIVF.h:498` 的虚接口：`set_query`（纯虚）/`set_list(list_no, coarse_dis)`/`distance_to_code`（纯虚）/`scan_codes(..., ResultHandler&)`。两个关键语义：

- **store_pairs**：结果存 `lo_build(list_no, offset)`（高 32 位 list + 低 32 位偏移，DirectMap.h:23）而非 label——`search_and_reconstruct` 用它**绕开 DirectMap** 直接定位（IndexIVF.cpp:1167）；IVFPQR 用它做 shortlist；merge/rerank 同理。
- **sel（IDSelector）内联跳过，不算距离**（expanded_scanners.h:44-50）。

**为什么虚函数而不是模板**：搜索主循环只写一份，任何编码给出 scanner 工厂即可接入。但虚调用挡内联——所以内层是**模板+虚的混合**：`run_scan_codes`（expanded_scanners.h:75-163）把 `keep_max/store_pairs/use_sel` 从运行期 if 钉死成模板参数，`scanner->distance_to_code` 声明为 `final`（如 IVFFlatScanner，IndexIVFFlat.h:88）使模板实例化后可内联 SIMD 距离函数（头部注释直言为 SQ/Flat 这类极小距离计算服务，expanded_scanners.h:16-21）。

scanner 实现三例：**IVFFlatScanner**（`with_VectorDistance` 对 11 种度量 × 每 SIMD level 实例化，IVFFlatScanner-inl.h:21）；**IVFPQScanner**（`pq_code_distance/IVFPQScanner_impl.h:444`，三级 `precompute_mode`：2=预计算距离表 4 路展开、1=表指针、0=on-the-fly 解码）；**IVFFlatScannerPanorama**（IndexIVFFlatPanorama.cpp:56，用累积和表做 Cauchy-Schwarz 下界剪枝批量过滤）。**重要边界**：`IndexIVFFastScan` 不走 scanner 抽象——自带 `search_implem_1/2/10/12/14` 直接消费 BlockInvertedLists 的打包块（IndexIVFFastScan.cpp:857-1321），scanner 抽象的边界在"连续 code_size 定长码"。

### DirectMap：id 反向定位

三种 Type（DirectMap.h:38）：**NoMap**（默认，省内存）/ **Array**（顺序 id——`check_can_add` 遇显式 ids 直接抛异常，DirectMap.cpp:109-113）/ **Hashtable**（`std::unordered_map<idx_t,idx_t>`，任意 id）。`lo_build(list_id, offset) = list_id << 32 | offset`（DirectMap.h:23）。为什么需要：IVF 组织是 (list, offset)，而 `reconstruct(id)`/`remove_ids`/`update_vectors` 要按 id 反查——`IndexIVF::reconstruct` 就是 `direct_map.get(key)` 解出 lo 再 `reconstruct_from_offset`（IndexIVF.cpp:1071）。并发细节：Hashtable 无法并行插入——`DirectMapAdd`（DirectMap.cpp:117-150）并行阶段各线程只写临时数组，析构时单线程灌入。删除：Hashtable 路径把 list 尾元素搬进空洞并同步更新其哈希项（DirectMap.cpp:210-222）。

### by_residual：残差编码为什么降误差

`by_residual=true` 存 `x − centroid` 而非 x。收益：同一 list 内向量围绕质心分布，残差的动态范围远小于原向量，同样码预算下量化误差更小（尤其 PQ 的固定码本）。证据链：train 时专门用残差训练编码器（IndexIVF.cpp:1331-1338）；IVFPQ 的 L2 分解依赖残差结构。反例：IVFFlat 存原始向量故 `by_residual = false`（IndexIVFFlat.cpp:53）；IndexIVFFastScan 同样 false（"prefer no residuals for performance"，IndexIVFFastScan.cpp:49——残差会破坏 LUT 预计算）。IndexIVFPQ 构造时 `by_residual = true`、`use_precomputed_table = 0`、`scan_table_threshold = 0`（IndexIVFPQ.cpp 构造函数）；add 批大小 `index_ivfpq_add_core_o_bs = 32768`。

### train_q1：量化器训练策略

`Level1Quantizer::train_q1`（IndexIVF.cpp:56-136）三档：`quantizer_trains_alone == 1` 直接 `quantizer->train`（HNSW 等自带训练）；== 0（默认）`quantizer->reset()` 后跑 Clustering（niter=10，因粗聚类大）；== 2 在**临时 IndexFlatL2** 上做 kmeans 再把质心灌进真量化器——HNSW 等复杂量化器不必参与 kmeans 内循环。v1.15 新增 SuperKMeans 路径（IndexIVF.cpp:88-94）。

### merge：跨索引合并

`IndexIVF::merge_from`（IndexIVF.cpp:1388）→ `InvertedLists::merge_from`（InvertedLists.cpp:71）：逐 list `add_entries` 后源 resize 为 0，`omp parallel for`。前置 `check_compatible_for_merge`（同 typeid/d/nlist/code_size + 双方 direct_map 为空；全局 `check_compatible_for_merge_expensive_check` 还逐质心 reconstruct 比对浮点相等）。`ivflib::merge_into` 用 `extract_index_ivf` 剥开 PreTransform/IDMap 包装器再委托；`SlidingIndexWindow::step`（IVFlib.cpp:237）是 FIFO 滑窗——直接对 ArrayInvertedLists 的向量 `memmove` 移除最旧 slice。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 虚工厂 | `get_InvertedListScanner`（IndexIVF.cpp:1064 基类默认抛） | 一份搜索循环 × 任意编码 |
| 模板+虚混合 | `run_scan_codes`（expanded_scanners.h:75） | 外层虚保 ABI，内层模板钉死分支 + final 内联 |
| RAII | `ScopedCodes/ScopedIds`（InvertedLists.h:219） | 裸指针访问的释放安全 |
| 策略 | parallel_mode 四档（IndexIVF.h:205） | 批查询/单查询延迟的不同取舍 |
| 位掩码 | `PARALLEL_MODE_NO_HEAP_INIT = 1024` | 正交开关不占独立模式值 |

## 模块间交互

向上被 12+ 个 IVF 子类继承（换 encode_vectors 与 scanner）；向下消费 quantizer（任意 Index）、invlists（四变体）、DirectMap。与 [组合索引](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction) 的关系：`IndexShardsIVF` 感知 IVF 结构只分数据不分 list；`IndexIVFIndependentQuantizer`（IndexIVFIndependentQuantizer.cpp:44）外包一层独立粗量化器。与 [量化器](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/03-quantizers) 的关系：IVFPQ 的预计算表数学（IndexIVFPQ.cpp:377-405 注释）`d = ‖x−y_C‖² + term2(离线预计算，nlist×M×ksub) + term3(经典 ADC 表)`——`use_precomputed_table` 的内存上限默认 2 GiB。

## 扩展方式

**新增一种 IVF 编码格式**：继承 `IndexIVF` 实现 `encode_vectors`（唯一纯虚，IndexIVF.h:268）+ `train_encoder`（by_residual 时收到残差）+ `reconstruct_from_offset` + `get_InvertedListScanner`（参照 `AQInvertedListScanner`，IndexIVFAdditiveQuantizer.cpp:169；或复用 `run_scan_codes` 模板加速内层）。merge/copy_subset 白得。

**换粗量化器**：构造时传新 Index（如 IndexHNSW）并设 `quantizer_trains_alone=1`；运行期替换需 `quantizer->ntotal == nlist`；已有索引换量化器等于重定义 list 语义，必须重建。

**换存储后端**：`replace_invlists(il, own)`（IndexIVF.cpp:1401）——只要求 nlist 一致且 code_size 相等或为哨兵值；OnDisk 推荐路径是 Array 攒数据再 `merge_from` 成紧凑盘上格式。
