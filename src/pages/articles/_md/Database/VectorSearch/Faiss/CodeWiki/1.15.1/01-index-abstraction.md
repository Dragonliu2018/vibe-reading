---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "Index 抽象与组合索引"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "C++", "设计模式", "BLAS"]
description: "Faiss Index 基类契约解读——虚方法三档设计、IndexFlat 家族的 BLAS/SIMD 双路径、IndexFlatCodes 模板方法、PreTransform/IDMap/Refine/Shards 组合乐高与 SearchParameters 免锁并发"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`faiss/Index.h`（435 行）+ 顶层的 Flat 家族与组合索引构成 Faiss 的**类型系统**。这层回答的问题是：100+ 种索引形态如何共享一个 ABI？答案是一个极简的虚基类加三档虚方法设计——这让 SWIG 能为一个 C++ 类树生成全量 Python 绑定、让 `index_read` 能按 fourcc 反序列化任意索引、让组合索引能任意嵌套。对比 USearch 的模板 duck-typing 路线（度量/谓词全是模板参数），Faiss 选择了运行时多态——代价是热路径的分支，对策是"接口用运行时多态、内核用编译期单态"的分层。

## 模块架构

```
Index（虚基类，Index.h:101）
├─ IndexFlatCodes（固定 code_size 编码容器，IndexFlatCodes.h:22）
│   ├─ IndexFlat → IndexFlatIP/L2 → IndexFlat1D（排序置换优化）
│   ├─ IndexPQ / IndexScalarQuantizer / IndexLSH / IndexRaBitQ / IndexEDEN…（10 个编码索引）
├─ IndexIVF（倒排骨架，见专门模块）
├─ IndexHNSW / IndexNSG / IndexNNDescent（图索引，见专门模块）
└─ 组合层：
    IndexPreTransform（VectorTransform 链装饰）
    IndexIDMap/IDMap2（id 代理）
    IndexRefine（量化 + 精确重排）
    IndexShards/Replicas/ShardsIVF（分片/副本，ThreadedIndex 线程亲和）
```

## 核心实现

### Index 基类：三档虚方法

`faiss/Index.h:101` 的成员只有 `d`/`ntotal`/`is_trained`/`metric_type`/`metric_arg` 五个，虚方法分三档：

- **纯虚（4 个）**：`add`（Index.h:164）、`search`（207）、`reset`（272）——最小索引只需实现这三个（加构造）；
- **默认空实现**：`train`（Index.cpp:23，"does nothing by default"）、`train_with_queries`（v1.15 新增，为 RaBitQ 用查询分布训练）；
- **默认抛异常**：`add_with_ids`/`remove_ids`/`reconstruct`/`range_search`/`sa_encode` 等——"能力可选，未实现即显式报错"；
- **有真实默认实现**：`assign`（内部临时 buffer 调 search，Index.cpp:44）、`reconstruct_batch`（OpenMP 并行 + mutex 捕异常重抛，Index.cpp:65）、`get_distance_computer`（返回 `GenericDistanceComputer`——对每个 i 先 `reconstruct(i)` 再算 L2，即"任何支持 reconstruct 的 L2 索引自动得到暴力距离计算器"，Index.cpp:197）。

`SearchParameters`（Index.h:88）只有 `IDSelector* sel` 一个字段 + 虚析构；各索引派生子类（`SearchParametersHNSW` 的 efSearch、`SearchParametersIVF` 的 nprobe/max_codes）。

### IndexFlat::search：三行派发到距离核

```cpp title="faiss/IndexFlat.cpp:29"
void IndexFlat::search(...) const {
    IDSelector* sel = params ? params->sel : nullptr;
    if (metric_type == METRIC_INNER_PRODUCT) {
        float_minheap_array_t res = {size_t(n), size_t(k), labels, distances};
        knn_inner_product(x, get_xb(), d, n, ntotal, &res, sel);
    } else if (metric_type == METRIC_L2) {
        float_maxheap_array_t res = {size_t(n), size_t(k), labels, distances};
        knn_L2sqr(x, get_xb(), d, n, ntotal, &res, nullptr, sel);
    } else {
        knn_extra_metrics(...);   // 罕见度量走 utils/extra_distances
    }
}
```

自身不含循环，堆数组直接复用调用方的 `distances/labels` 缓冲（零拷贝）。**BLAS 切换条件**在 `utils/distances.cpp:581`（Run_search_L2sqr）：`res.sel` 非空或 `nx * d < 128000`（`distance_compute_blas_threshold`，distances.cpp:607）走顺序 SIMD；否则 `exhaustive_L2sqr_blas`——先 `fvec_norms_L2sqr` 预计算两侧范数（distances.cpp:446-453），按 4096×1024 分块调 `sgemm_` 算内积块，再用 `dis = x_norms[i] + y_norms[j] − 2·ip` 回填（distances.cpp:486-505，负值截 0 防浮点舍入）。阈值单位是**元素数** nx×d——小批量下 GEMM 的打包开销反而更贵。另有 `should_use_db_parallel`（distances.cpp:760）：查询数 < 线程数且库 > max(10000, nt×1024) 时改按**数据库**分段并行——"查询太少喂不饱线程"的补丁。

`IndexFlat1D`（IndexFlat.cpp:423）是 d=1 特例：维护排序置换 `perm`，搜索二分定位后向两侧线性扩展——返回的是 L1 距离。`IndexFlatL2` 的 `cached_l2norms`（IndexFlat.cpp:391）预计算全库范数，把 L2 化为 `‖x‖²+‖y‖²−2⟨x,y⟩` 的点积形式——为 GPU/HNSW 对称化场景服务。

### IndexFlatCodes：模板方法 + MaybeOwnedVector

`IndexFlatCodes`（IndexFlatCodes.h:22）把"固定 code_size 编码数据集"从索引里抽出：唯一数据成员 `MaybeOwnedVector<uint8_t> codes`。`add` 的默认实现（IndexFlatCodes.cpp:28）是三行：resize → `sa_encode(n, x, codes.data()+ntotal*code_size)` → ntotal += n——**存储骨架固定，sa_encode 是变化点**，10 个编码索引共享这一套。`MaybeOwnedVector`（impl/maybe_owned_vector.h:26）是双模容器：拥有模式走 std::vector，视图模式持 `shared_ptr` 的映射 owner——**从 mmap/ZeroCopyIOReader 加载索引时 codes 直接成为磁盘页的只读视图，零拷贝零加载**（index_read.cpp:197 的消费点）；视图模式下所有写操作 assert 拒绝。

### IndexPreTransform：装饰器贯穿到 DistanceComputer

`IndexPreTransform`（IndexPreTransform.h:25）持 `vector<VectorTransform*> chain` + `Index* index`。`train` 从最靠后未训练的组件顺序训练（T2 必须在 T1 的输出上训练，IndexPreTransform.cpp:62-120）；`add/search` 走 `apply_chain` 后转发；`reconstruct` 走 `reverse_chain` 逆序还原（PCA/Remap/Centering 可逆，Normalization 不可逆）。`VectorTransform` 家族（VectorTransform.cpp，1,642 行）：`LinearTransform` 的 `apply_noalloc` 用 sgemm（n==1 时改 sgemv 避免 GEMM packing 开销，VectorTransform.cpp:208-224）；`PCAMatrix` 训练 n≥d 走协方差 + Jacobi 特征分解、n<d 走 Gram 小样本路径；`OPQMatrix` 50 轮"投影→PQ 训练→SVD 回解旋转"交替优化；`RandomRotation/HadamardRotation`（O(d log d) 伪随机旋转）。`PreTransformDistanceComputer`（IndexPreTransform.cpp:324）让装饰器贯穿到距离计算层。

### IndexIDMap：代理与结果重编址

`IndexIDMapTemplate`（IndexIDMap.h:20，模板同时服务 Index/IndexBinary）持 `id_map` 向量。`search_ex` 在子索引搜索后 OMP 并行做 `li[i] = id_map[li[i]]`（IndexIDMap.cpp:171-205）；selector 下传用 `IDSelectorTranslated`（IDMap.h:132——把用户空间 id 翻译回顺序下标）+ `ScopedSelChange` RAII 临时替换。`IndexIDMap2` 加 `rev_map` 哈希支持 `reconstruct(key)`——代价是 remove 后必须全量重建反向映射（IndexIDMap.cpp:380，代码自注 "quite inefficient"）。

### IndexRefine：两阶段精排

`IndexRefine`（IndexRefine.cpp:61）的 search：base_index 取 `k_base = k × k_factor` 候选 → 每查询线程持 `refine_index->get_distance_computer()` 只对候选 id 重算精确距离 → `reorder_2_heaps` 从 k_base 收缩到 k。`IndexRefineFlat` 的变体（IndexRefine.cpp:278）改调 `compute_distance_subset`（向量化比重排逐点快）。range_search 的细节：半径先按 k_factor 放大做召回、重算精确距离后**再做精确半径过滤**（IndexRefine.cpp:192-208——base 的近似距离可能越界）。

### IndexShards / Replicas：ThreadedIndex 线程亲和

共同基类 `ThreadedIndex`（impl/ThreadedIndex.h:21）的核心 API 是 `runOnIndex(f)`——**函数被投递到管理该子索引的线程上执行**，返回 future 统一等待（ThreadedIndex.h:42）。这是"线程亲和"模型：`threaded=true` 时每个子索引独占一个 WorkerThread，子索引一旦 addIndex 后不可从外部线程触碰（ThreadedIndex.h:30-31 WARNING）。分工：**IndexShards 切数据**——add 按 `no*n/nshard` 均分投递（IndexShards.cpp:173-174）；`successive_ids`（IndexShards.h:36 默认 true）要求整体单遍 add 且与显式 xids 互斥（"It makes no sense to pass in ids and request them to be shifted"），分片返回顺序 label 由累计 ntotal 平移；search 每分片搜全量查询、`merge_knn_results` 归并（IndexShards.cpp:196-265）。**IndexReplicas 切查询**——每副本持全量数据，查询按 `queriesPerIndex = ceil(n/count)` 分发无需归并（IndexReplicas.cpp:141-170）；**不支持任何 SearchParameters**（FAISS_THROW，IndexReplicas.cpp:130），reconstruct 固定从第一个副本取（`at(0)->reconstruct`）。`IndexShardsIVF`（IndexShardsIVF.cpp:90-161）是 IVF 感知变体：**只做一次粗量化**，把 assign 结果随数据分片传给各分片的 `add_core(..., Iq.data()+i0)`，避免每分片重复跑 coarse quantizer。

`IndexFlatCodes` 的容量操作语义：`remove_ids` 用 memmove 把未删 code 前移压实（剩余 id 前移——顺序 id 语义）；`merge_from` 要求 `typeid(*this) == typeid(*other)` 同型且**不支持 add_id 偏移**（"cannot set ids in FlatCodes index"，IndexFlatCodes.cpp:99-109）。IndexFlat 的 `code_size = sizeof(float) * d`（IndexFlat.cpp:26）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `IndexFlatCodes::add`（IndexFlatCodes.cpp:28） | 10 个编码索引共享存储骨架 |
| 装饰器 | PreTransform（前向 add/search、反向 reconstruct）；Refine（距离精度） | 任意索引可叠加 |
| 代理 | IDMap 同构转发 + 结果重编址（IndexIDMap.cpp:171） | id 语义外挂 |
| 组合 + 线程亲和 | Shards/Replicas 的 `runOnIndex`（ThreadedIndex.h:42） | 子索引独占线程防数据竞争 |
| 适配器 | `SearchParametersPreTransform` 把子索引参数包进父参数（IndexPreTransform.cpp:171） | 参数链的拆包转发 |
| 工厂单态泛型 | `with_VectorDistance`（distances_dispatch.h:233） | 运行时度量 → 编译期模板 |

## 模块间交互

向下依赖 `utils/distances`（BLAS/SIMD 核）、`impl/DistanceComputer`（GenericDistanceComputer）、`impl/ResultHandler`（BlockResultHandler 三档模板：k==1 → Top1、k<100 → Heap、否则 Reservoir，ResultHandler.h:715）。向上被 index_factory/序列化/绑定全量消费。`SearchParameters` 传参化是 v1.7 的大重构：旧版 nprobe/efSearch 是索引成员，并发搜索要么锁要么复制索引；改传参后 search 是 const 方法，**多线程可用不同 nprobe 免锁并发查同一索引**——代价是父索引需要拆包转发参数与 dynamic_cast 校验。v1.15 的 `add_ex/search_ex`（Index.h:148-233，NumericType 枚举）是同一哲学的延续：不动既有签名保 ABI，用新虚函数增量添加 fp16/i8 输入支持。

## 扩展方式

- **新增 Flat 变体**：继承 IndexFlatCodes 实现 sa_encode/sa_decode + `get_FlatCodesDistanceComputer`；add/reset/merge/暴力 search 全部免费继承（参照 IndexPQ）。
- **新增 PreTransform**：继承 VectorTransform 实现 `apply_noalloc`（纯虚）与 train；线性型可复用 LinearTransform 的 sgemm 应用与 LAPACK 训练底座。之后 `new IndexPreTransform(new MyTransform(), index)` 即可，外层 Shards/Refine 可继续叠加。
- **新增组合索引**：参照 IndexReplicas 最小集——继承 ThreadedIndex，写 train/add/search + `syncWithSubIndexes` + `onAfterAddIndex` 钩子。
