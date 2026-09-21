---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "量化器家族"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "C++", "量化", "k-means"]
description: "Faiss 量化器家族解读——PQ 子空间查表数学、SQ 标量量化、RQ/LSQ 加性量化、RaBitQ 1 比特缩放因子与理论误差界、EDEN 熵分组、Clustering/SuperKMeans 训练底座"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

量化器解决"向量 → 短码"：把 512 字节的 f32 向量压成几字节的码，同时保持距离可计算。统一基类 `Quantizer`（`impl/Quantizer.h:15`）只有三个纯虚：`train`/`compute_codes`/`decode`——**接口极薄**，Faiss 真正的性能来自每个量化器配套的 DistanceComputer/Scanner/LUT 路径。这是"新增量化器要实现什么"的答案，也是它与 [Index 抽象](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction) 的分工：Quantizer 管编解码正确性，索引层管搜索性能。

## 模块架构

![量化器家族四种策略](/vibe-reading/images/articles/faiss-internals/quantizer-family.svg)

四条技术路线：**乘积**（PQ，子空间独立）、**标量**（SQ，逐维）、**加性**（RQ/LSQ，残差/联合优化）、**新锐**（RaBitQ/EDEN，1-bit + 数据相关缩放）。共同底座是 Clustering（k-means）。

## 核心实现

### ProductQuantizer：招牌与查表数学

`impl/ProductQuantizer.h:29`：`M` 个子量化器、`nbits` 位/子码（`set_derived_values` 对 `nbits > 24` 抛 "not practical"，ProductQuantizer.cpp:68），派生 `dsub = d/M`、`ksub = 1 << nbits`；质心表布局 **(M, ksub, dsub)**（h:54），另有转置表 (dsub, M, ksub) 供编码时避免 strided 访问（`sync_transposed_centroids` in cpp:906）。

`train`（cpp:130-207）对每个子空间独立跑一个 `Clustering(dsub, ksub, cp)` + IndexFlatL2。初始化枚举：`Train_hypercube` 把质心放 nbits 维超立方体顶点（`mean ± maxm`，防空聚类）；`Train_shared` 全段共享一个字典。头注释明言：**PQ 训练最小化 L2，即使支持 IP 检索，量化误差也偏向 L2**。

**ADC 查表数学**（招牌，h:113-125 注释）：子空间独立 ⇒ 距离可分解：

$$\text{dis}(x, y) = \sum_{m=0}^{M-1} \|x_m - c_{(m, y_m)}\|^2 = \sum_{m} \text{LUT}[m][y_m]$$

查询侧一次算全 M×ksub 的 LUT（`compute_distance_table` in cpp:443；dsub≥16 时用 sgemm 批量，cpp:540），库侧每码退化为 **M 次内存 gather + 加法**——无浮点乘法、无维数依赖，搜索成本 O(M) 而非 O(d)。批量编码同样走表：`compute_distance_tables`（pairwise_L2sqr）+ 逐行 `compute_code_from_distance_table` 查表取 argmin（cpp:411-441，分块 256KB）。nbits=8 时走 SIMD 内核 `pq_code_distance::pq_scan_8bit`（cpp:723，PQDecoder8 有 AVX2/AVX512/SVE 特化）。对称版 SDC：预计算 ksub×ksub 质心间距离表 `sdc_table`（cpp:823）。

### ScalarQuantizer：逐维与无训练两路

`impl/ScalarQuantizer.h:27` 的 Qtype 枚举：`QT_8bit/4bit/6bit`（每维独立范围）、`*_uniform`（全维共享）、`QT_fp16/bf16`、`QT_8bit_direct`（字节即值，**无需训练**）、TurboQuant 系（`QT_*bit_tqmse` = Lloyd-Max MSE 优化码表；`QT_*bit_tq` = + QJL 随机投影）、EDEN 系（`QT_*bit_eden`）。

训练分派（cpp:548-643）：nonuniform 量化训练每维范围 `RangeStat`（minmax/meanstd/quantiles/**RS_optim**——对均匀格点 (a·n+b) 的重构误差做交替最小二乘，闭式更新，training.cpp:263-326）；`fp16/bf16/direct` 免训练（cpp:590）；eden/tqmse 填 **N(0,1) 的 Lloyd-Max 最优标量码表**（硬编码 1-8bit 常量，cpp:33-427）。距离计算机 `DCTemplate`（Quantizer × L2/IP × SIMDLevel 三轴模板，distance_computers.h:25）；direct 模式走整数域 `DistanceComputerByte`（`int(code1[i])*code2[i]` 纯整数 IP，distance_computers.h:86）。所有入口经 `with_simd_level_fallback` 逐级回退。

### 加性量化族：AdditiveQuantizer 统一层

**PQ 与 AQ 的本质区别**（AdditiveQuantizer.h:20-25 头注释）：PQ 解码是 M 个子向量**拼接**，AQ 解码是 M 个子向量**求和**——解码 `fvec_add` 逐级累加（cpp:317）。`AdditiveQuantizer`（h:26）统一了 RQ/LSQ/PLSQ/PRQ：共享码书布局（codebook_offsets）、norm 量化机制（`ST_norm_lsq2x4/rq2x4`——**范数本身用 2×4-bit 的 LSQ/RQ 量化**塞进码尾，两级码本拍平成 256 项加法表，cpp:127-154，为 4-bit FastScan 服务）、LUT/解压两套搜索路径。差异只在 `train` 与 `compute_codes_add_centroids` 两个纯虚（h:102-117）。

**ResidualQuantizer**（cpp:131-294，默认 `train_type = Train_progressive_dim`（渐进维聚类）与 `max_beam_size = 5`，ResidualQuantizer.h:34/57）：逐级残差链。每级对当前残差聚类后用 `beam_search_encode_step`（residual_quantizer_encode_steps.cpp:46，宽度 ≤5 的 beam 重编码）；`Train_refine_codebook` 把 one-hot 指示矩阵拼成稀疏矩阵解最小二乘（LAPACK sgelsd，注释明言码矩阵常秩亏，cpp:340）。

**LocalSearchQuantizer**（LSQ，h:29-44 引 Martinez et al. ECCV'16/'18）：**联合优化**而非逐级贪心——随机初始化后 25 轮循环：`update_codebooks`（ridge 回归解码书）→ `perturb_codebooks`（模拟退火逃局部最优，温度 `(1−(i+1)/n)^0.5`）→ `icm_encode`（迭代条件模式：目标拆成 unary/binary 两个 LUT，逐维固定其余子码取最优，`_mm_prefetch` + SIMD 堆加速）。**RQ vs LSQ 的取舍**：RQ 贪心逐级训练快但误差被后面继承；LSQ 联合优化精度更高但训练贵一个量级（M²K² 叉积表）。

**ProductAdditiveQuantizer**：先切正交子空间再每段放独立 AQ（PLSQ/PRQ 子类）。注意 **OPQ 不属于此家族**——它是 `OPQMatrix`（VectorTransform.h:258），学一个正交旋转使子空间近似独立，以 PreTransform+OPQMatrix+IndexPQ 形态使用。

### RaBitQ：1 比特 + 理论误差界

`impl/RaBitQuantizer.h:55`（引 Gao & Long, arXiv:2405.12497）：每向量只存 **每维 1 个符号位 + 2 个 fp32 因子**，`code_size = (d+7)/8 + 8`（RaBitQuantizer.cpp:50-74）。**train 是空操作**（cpp:76）——无需训练是对 PQ 的根本优势；头注释要求外部做 Random Matrix Rotation。

距离公式（`distance_to_code_1bit_impl`，RaBitQuantizer.cpp:296-334）：归一化 `dp_oO = Σ|r_i| / (‖r‖·√d)`，缩放 `dp_multiplier = ‖r‖ / normalized_dp`，则 `dist ≈ ‖or−c‖² + ‖qr−c‖² − 2·dp_multiplier·(c1·dot_qo + c2·sum_q − c34)`。**理论误差界是卖点**：`SignBitFactorsWithError.f_error`（RaBitQUtils.cpp:101-118）给出下界 `lower_bound = est − f_error·g_error`——两阶段搜索：1-bit 估计 + 下界都过不了堆阈值就免精化（`should_refine_candidate`，RaBitQUtils.h:300），**可证不漏召回**。多比特版（`FAISS_THROW_IF_NOT(nb_bits >= 1 && nb_bits <= 9)`，RaBitQuantizer.cpp:44；`SignBitFactors` = 2 个 fp32 共 8 字节，多比特的 `SignBitFactorsWithError` 含 or_minus_c_l2sqr/dp_multiplier/f_error 共 12 字节 + `ExtraBitsFactors` 8 字节，RaBitQUtils.h）追加幅度位。FastScan 适配：1-bit 码按 4 维一组塞进 4-bit 单元复用 PQ4 块布局（`extract_bit_fastscan`，RaBitQUtils.cpp:275）。

### EDEN：标量码 + 每向量缩放

`impl/EDENQuantizer.h`（ICML 2022 Vargaftik et al.）：单位向量的 Lloyd-Max 标量量化 + 每向量一个 scale。无偏模式 `scale = ‖r‖²/⟨q,r⟩`（距离无偏估计）；有偏模式遵循 DRIVE（NeurIPS 2021）的 MSE 最优。与 RaBitQ 同属"固定标量码 + 数据相关缩放因子"流派：RaBitQ 用符号位，EDEN 用 Lloyd-Max 码。

### Clustering：训练底座

`faiss/Clustering.cpp:60-403`：经典 Lloyd + k-means++ 初始化（`impl/ClusteringInitialization.cpp:207`，按 cumsum 轮盘赌 D² 采样，v1.15 的 seeding 更新已并行化）+ 空簇分裂 + `early_stop_threshold`。关键参数：`niter=25`、`seed=1234`（nredo 轮用 `actual_seed + 1 + redo*15486557L` 派生防重复）、`nredo`（多跑取优）、`spherical`（归一化质心）、`min_points_per_centroid=39 / max_points_per_centroid=256`（**超采样集自动下采样**，cpp:104-112——训练代码"重"的原因之一）、`frozen_centroids`（IVF 增量训练冻结已有质心）。

**SuperKMeans**（SuperKMeans.h:72，v1.15 新增，Kuffo/Hepkema/Boncz arXiv:2603.20009）：迭代 0 全维 GEMM；迭代 1+ 只对前 d_prime 维（默认 d/8）做部分 GEMM，卡氏不等式界剪枝，幸存者走 ADSampling 渐进扫尾部维（`adapt_d_prime` 带域控制器按剪枝率 0.95-0.97 自适应（pruning_target_low/high，SuperKMeans.h））。适用 k≥1024、d≥128。**kmeans1d**（impl/kmeans1d.h）：一维精确 k-means 的 SMAWK 完全单调矩阵算法，排序后近 O(n log n)——AQ 的 norm 量化靠它精确训练。**lattice_Zn**：Zn 格球面量化，无需训练——"结构化码书替代 k-means"的路线。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 薄接口 + 厚配套 | `Quantizer` 三纯虚（Quantizer.h:15） | 正确性与性能分离，各量化器自配距离路径 |
| 模板方法 | `AdditiveQuantizer` 共享 norm/pack/LUT（h:26） | RQ/LSQ/PLSQ/PRQ 只实现 train + 编码两虚 |
| 三轴模板 | `DCTemplate<Quantizer, Similarity, SIMDLevel>`（distance_computers.h:25） | 运行时组合编译期化 |
| 双模 scale | EDEN 无偏/有偏（EDENQuantizer.h:20-26） | 召回保真 vs MSE 的选择 |

## 模块间交互

被 [Index 抽象](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction) 的 10 个 FlatCodes 索引与 [IVF](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/02-ivf-inverted-lists) 的编码层消费；4-bit 量化器接入 [FastScan](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/04-fastscan)（AQ 用 `ST_norm_lsq2x4` 提供范数表，RaBitQ 伪装 4-bit）；训练全部落到本模块的 Clustering。

## 扩展方式

**新增一种量化器**：继承 `Quantizer` 实现 train/compute_codes/decode（或 AQ 家族只需两个纯虚入口）；决定 code_size 布局（参照 RaBitQuantizer 的分段 + 因子内嵌）；提供距离路径（FlatCodesDistanceComputer + IVF scanner）；FastScan 加速需 4-bit 块布局 + CodePacker；最后注册 clone/序列化（`clone_Quantizer` 模式，ProductAdditiveQuantizer.cpp:73）。
