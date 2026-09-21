---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "Overview"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "C++", "向量检索", "量化"]
description: "Faiss v1.15.1 源码架构解读——Meta 开源向量相似度检索库：Index 抽象与组合索引哲学、IVF 倒排骨架、量化器家族（PQ/SQ/RQ/RaBitQ）、FastScan SIMD 批扫、GPU 后端与 SWIG Python 绑定的完整内幕"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 1.15.1 · **协议** MIT · **语言** C++（~146K 行）+ CUDA（~48K 行）+ Python/SWIG · **仓库** [GitHub](https://github.com/facebookresearch/faiss)
>
> **解读基线** commit [`75c755c5a`](https://github.com/facebookresearch/faiss/commit/75c755c5a)（v1.15.1 release commit）

---

## 总览

### 项目简介

Faiss（Facebook AI Similarity Search）是 Meta FAIR 团队开源的**稠密向量相似度检索与聚类库**，也是这个领域事实上的奠基者（2017 年开源，比 HNSWlib 早、比 Milvus/Qdrant 早四年以上）。它解决的问题是：给定一组向量（可能大到放不进 RAM），如何高效地按 L2 或内积距离找最近邻。Faiss 的回答是一整座**索引算法的军火库**——从精确暴力的 `IndexFlat`，到倒排骨架 `IndexIVF`、图遍历 `IndexHNSW`、量化压缩的 PQ/SQ/RQ 家族、SIMD 批扫的 FastScan 系列，再到 GPU 实现（README 自述"as of March 2017 最快的精确与近似检索实现"）。

核心价值三层：**算法全**——README 用六个维度（搜索时间/质量/内存/训练时间/插入时间/是否需要训练数据）定义权衡空间，几乎每种组合点都有对应索引；**组合性强**——索引像乐高：`IndexPreTransform`（PCA/OPQ 预处理）套 `IndexIVF`（倒排）套 `IndexPQ`（编码）套 `IndexRefine`（精确重排），一行工厂字符串 `"OPQ16,IVF4096(HNSW32),PQ32x4fs,Refine(Flat)"` 即可表达；**工程深**——十年积累的 SIMD 动态分派（一个 wheel 通吃所有 x86 CPU）、BLAS/SIMD 双路径距离计算、近十年向后兼容的手写序列化。

**项目当前边界**：Faiss 是**库**不是服务——没有分布式、副本、多租户、SQL 层（那是 Milvus/Qdrant 在 Faiss 之上或之外做的事）；训练需要外部数据（PQ/IVF 的 k-means 阶段）；CPU 侧只支持 L2/内积/少量额外度量（任意自定义度量是 USearch 的卖点，Faiss 的度量核是硬编码的）。

### 版本历史

- **2013-2016**（FAIR 内部）：Hervé Jégou 发起并写第一版实现
- **2017.03** 开源，同时发表 GPU 论文（Johnson et al.，Billion-scale similarity search with GPUs）
- **2019-2021**：NSG/NNDescent/加性量化器（Chengqi Deng）、二进制索引（Lucas Hosseini）陆续并入
- **2021 前后**：v1.7 大重构——SearchParameters 传参化（并发搜索免锁）、SIMD 动态分派铺开
- **2024**：发表 The Faiss Library 综述论文（douze2024faiss，arXiv:2401.08281）
- **v1.15.1（2025 下半年）**：确定性无锁 HNSW 构建、AVX512 VPOPCNT 级别、SuperKMeans、RaBitQ/Panorama/EDEN 等新锐量化器成熟——本篇解读基线

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| 精确暴力检索 | `faiss/IndexFlat.cpp` | BLAS/SIMD 双路径，k=1 融合核 |
| 倒排索引骨架 | `faiss/IndexIVF.cpp` | 粗量化器 + 倒排表 + 任意编码 |
| 图索引 | `faiss/impl/HNSW.cpp`、`impl/NSG.cpp`、`impl/NNDescent.cpp` | HNSW/NSG/NNDescent 三种图结构 |
| 乘积量化 | `faiss/impl/ProductQuantizer.cpp` | 招牌：子空间独立 + 距离查表 |
| 标量/加性量化 | `impl/ScalarQuantizer.cpp`、`impl/AdditiveQuantizer.cpp` | SQ/RQ/LSQ/OPQ/TurboQuant |
| 新锐量化器 | `impl/RaBitQuantizer.cpp`、`impl/EDENQuantizer.h` | 1-bit + 缩放因子、熵驱动分组 |
| SIMD 批扫 | `faiss/IndexIVFFastScan.cpp`、`impl/fast_scan/` | 4-bit 码 32 路交织块布局 |
| 二进制索引 | `faiss/IndexBinary*.cpp`、`impl/binary_hamming/` | Hamming/Jaccard 距离 |
| 谓词过滤 | `faiss/impl/IDSelector.h` + 各索引 SearchParameters | sel 参数扫描时内联跳过 |
| 组合索引 | `IndexPreTransform/Refine/Shards/Replicas/IDMap` | 装饰器/代理/组合模式 |
| GPU 后端 | `faiss/gpu/`（CUDA）、`faiss/gpu_metal/`（Metal） | 自研 kernel + cuVS 双轨 |
| 外部引擎集成 | `faiss/svs/` | Intel SVS（Vamana/LVQ）经 IOHook |
| 序列化 | `impl/index_read.cpp`/`index_write.cpp` | 手写 fourcc 格式，兼容近十年 |
| 工厂 DSL | `faiss/index_factory.cpp` | 字符串描述组合索引 |
| 自动调参 | `faiss/AutoTune.cpp` | 超参网格 + Pareto 前沿 |
| Python/SWIG | `faiss/python/` | 100+ 类自动绑定 + numpy 薄层 |
| C API | `c_api/` | 手写最小集，嵌入式 FFI |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C++17 | 核心 | 索引族 + impl + utils（~146K 行） |
| OpenMP | 核心 | 并行构建/搜索/训练（`omp_capture_exception` 异常聚合是贯穿性模式） |
| BLAS/LAPACK | 核心 | sgemm 批量距离、PCA/OPQ 训练（可选 MKL/OpenBLAS） |
| CUDA / ROCm | 可选 | GPU 索引（~48K 行 .cu/.cuh） |
| NVIDIA cuVS | 可选 | GPU 委托后端（v1.15 起显式 opt-in） |
| Metal | 可选 | Apple Silicon 后端 |
| Intel SVS | 可选 | 外部 Vamana/LVQ 引擎集成 |
| SWIG ≥ 4.2 | Python 绑定 | 90+ 类自动生成 |
| CMake / scikit-build-core | 构建 | 多 ISA 多版本产物 |

### 顶层上下文图

Faiss 作为库被三类消费者使用：**学术研究**（复现论文基准，benchs/ 目录保留四篇论文的复现脚本）、**工程系统**（Milvus 早期、各家 RAG 框架的检索层，以及 LangChain/LlamaIndex 生态的底层选项之一）、**Meta 内部**（十亿级生产检索）。上游输入是各类 embedding（SIFT、深度模型输出）；Faiss 自己不产生 embedding。

## 快速上手

```bash
pip install faiss-cpu    # wheel 自带 SIMD 多版本，自动按 CPU 选最优
```

端到端验证（README/wiki 风格）：

```python
import numpy as np
import faiss

d = 64
xb = np.random.rand(10000, d).astype('float32')
xq = np.random.rand(5, d).astype('float32')

index = faiss.index_factory(d, "IVF1024,PQ16", faiss.METRIC_L2)
index.train(xb)          # k-means 训练质心 + PQ 字典
index.add(xb)
index.nprobe = 64        # 召回/延迟主旋钮
D, I = index.search(xq, 10)

assert I.shape == (5, 10)
```

换一种组合只需换字符串：`"HNSW32"`、`"OPQ16,IVF4096(HNSW32),PQ32x4fs,Refine(Flat)"`——这是工厂 DSL 的价值（见[序列化与工厂](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/07-io-factory-autotune)）。

## 架构设计解析

### 系统架构

Faiss 的设计哲学一句话：**运行时多态的索引骨架 + 编译期单态的计算内核**。顶层是一个统一的 `struct Index` 虚基类（train/add/search/reset 四个核心虚方法），让任意索引可以被组合索引嵌套、被 C API/SWIG 绑定、被序列化按 fourcc 分派；而所有热路径（距离核、扫描循环、堆操作）都用模板把运行时分支（SIMD 等级、度量方向、有无 selector）钉死成编译期常量，分派发生在循环外。

![Faiss 分层架构](/vibe-reading/images/articles/faiss-internals/architecture.svg)

五层职责：**绑定与接口层**（SWIG/C API/工厂/教程）对外；**组合与序列化层**是乐高的粘合剂；**索引族层**是可见的产品形态；**核心抽象层**（impl/ + invlists/）是被共享的骨架机制；**CPU 基础设施与 GPU 后端**在最底。GPU 侧独立实现同名索引族——`GpuIndexIVF` 刻意不继承 `IndexIVF`（头注释自述原因），只共享 `IndexIVFInterface` 的参数语义。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 绑定与接口层 | `faiss/python/`、`c_api/`、`index_factory.cpp`、`AutoTune.cpp` | 隔离宿主语言/DSL/调参的复杂度，保护核心 |
| 组合与序列化层 | `IndexPreTransform/Refine/Shards/IDMap`、`impl/index_read/write` | 组合性与持久化——乐高哲学的粘合剂 |
| 索引族层 | `faiss/*.cpp` 顶层 ~120 文件 | 用户可见的产品形态（Flat/IVF/HNSW/FastScan/…） |
| 核心抽象层 | `faiss/impl/`（81 文件）、`faiss/invlists/` | 共享骨架：倒排表/量化器/图结构/scanner/堆 |
| 基础设施层 | `faiss/utils/`、`impl/simd*`、`faiss/gpu/` | 距离核、SIMD 抽象、GPU kernel |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `IndexFlatCodes::add` in `faiss/IndexFlatCodes.cpp:28` | 存储骨架固定，sa_encode 为变化点——10 个索引共享存储逻辑 |
| 装饰器 | `IndexPreTransform`/`IndexRefine` | 前置变换/精确重排可套任意索引 |
| 代理 | `IndexIDMap` in `faiss/IndexIDMap.cpp:171` | id 平移：search 结果 OMP 并行重编址 |
| 组合 | `IndexShards/Replicas/ShardsIVF` + `ThreadedIndex::runOnIndex` | 分片/副本 + 线程亲和执行 |
| 虚工厂 | `get_InvertedListScanner` per `IndexIVF` 子类 | 一份搜索循环服务任意编码格式 |
| 运行时多态 + 编译期单态 | `with_simd_level` in `impl/simd_dispatch.h:237` | 接口要 ABI 稳定、内核要零分支——分派在循环外 |
| 手写 Pareto 前沿 | `OperatingPoints::add` in `AutoTune.cpp:112` | 自动调参的最优解集管理 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `Index` | 索引虚基类（d/ntotal/metric_type） | 工厂或直接构造 | 所有索引的根 |
| `InvertedLists` | 倒排表存储抽象 | 随 IndexIVF 构造 | Array/OnDisk/Block/Panorama 四变体 |
| `InvertedListScanner` | 编码格式多态扫描器 | 每线程一个 | IVF 搜索的核心扩展点 |
| `DistanceComputer` | 单查询距离接口（`operator()(id)`） | 每线程一个 | HNSW/NSG 图遍历的桥 |
| `ResultHandler` | 结果收集回调（threshold + add_result） | 每查询一个 | 堆/reservoir/top1 三档模板 |
| `Quantizer` | 量化器虚基类（train/compute_codes/decode） | 随索引训练 | PQ/SQ/AQ/RaBitQ 的根 |
| `Clustering` | Lloyd k-means + k-means++ | 训练期 | IVF 质心与 PQ 字典的训练底座 |
| `SearchParameters` | 查询期参数（sel + 各索引子类） | 调用方栈上 | v1.7 免锁并发搜索的关键 |
| `CMin/CMax` | 比较器模板（cmp2 平局破序保证确定性） | 编译期 | 贯穿全库的一等抽象 |

#### 核心抽象

| 抽象 | 定义位置 | 实现 | 扩展点 |
|------|---------|------|--------|
| `Index::add/search` 纯虚 | `faiss/Index.h:164/207` | 40+ 索引类 | 新索引类型 |
| `InvertedLists::add_entries/resize` 纯虚 | `invlists/InvertedLists.h:132` | Array/OnDisk/Block/Panorama + 元倒排表（拼装/切片/掩码） | 新存储后端 |
| `InvertedListScanner::scan_codes` | `faiss/IndexIVF.h:498` | IVFFlat/IVFPQ/AQ/Panorama 各 scanner | 新编码格式接入 IVF |
| `Quantizer::train/compute_codes` | `impl/Quantizer.h:15` | PQ/SQ/AQ 族/RaBitQ/EDEN | 新量化器 |
| `VectorTransform::apply_noalloc` | `faiss/VectorTransform.h` | PCA/OPQ/RR/HR/ITQ/Remap/… | 新预处理 |
| `InvertedListsIOHook` | `invlists/InvertedListsIOHook.h` | OnDisk/Block 内置 + 第三方注册 | 新磁盘格式 |
| `CodePacker` | `impl/CodePacker.h:19` | PQ4/RaBitQ | FastScan 块布局 |

## 代码目录

```shell
faiss/
├── faiss/                    # 核心库（C++ ~146K 行）
│   ├── *.cpp/h（顶层 ~120 文件）  # 索引族：IndexFlat/IVF/HNSW/PQ/.../工厂/组合索引
│   ├── impl/（81 文件）        #   骨架：HNSW/NSG/NNDescent 图、量化器、scanner、
│   │                          #   fast_scan/、pq_code_distance/、simdlib/、index_read/write
│   ├── invlists/              #   倒排表存储：Array/OnDisk/Block/DirectMap/Panorama
│   ├── utils/（38 文件）       #   距离核、Heap、partitioning、hamming
│   ├── gpu/（33+ 文件）        #   CUDA 实现（~48K 行）
│   ├── gpu_metal/             #   Apple Metal 后端
│   ├── svs/                   #   Intel SVS 引擎集成（Vamana/LVQ）
│   └── python/                #   SWIG 绑定 + 纯 Python 薄层
├── c_api/                     # C API（手写最小集）
├── tests/ benchs/ demos/ tutorial/ contrib/   # 测试/基准/教程/社区扩展
└── cmake/ conda/              # 构建与发行
```

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/faiss-internals/architecture.svg)

Faiss 的依赖主线是纵向的：索引族向下消费核心抽象（倒排表/量化器/图结构），核心抽象向下消费距离核与 SIMD 层。横向则由组合索引粘合——`IndexPreTransform` 能套在任何 `Index` 上，`IndexIVF` 能嵌任何 FlatCodes 索引当编码器。这种"纵向分层 + 横向可组合"是它区别于单一算法库（如 hnswlib 只有图、USearch 主打 HNSW）的结构性优势。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| Index 抽象与组合索引 | 基类契约、Flat 家族、装饰/代理/组合 | `Index::search` in `faiss/Index.h:207` | 运行时多态是全库 ABI 稳定的根 | [Index 抽象与组合](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction) |
| IVF 倒排骨架 | 粗量化、倒排表存储、scanner 多态 | `IndexIVF::search_preassigned` in `faiss/IndexIVF.cpp:416` | 大多数索引的骨架，超 RAM 的通路 | [IVF 倒排骨架](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/02-ivf-inverted-lists) |
| 量化器家族 | PQ/SQ/RQ/LSQ/RaBitQ/EDEN + 训练 | `ProductQuantizer` in `impl/ProductQuantizer.h:29` | 向量→短码的全部技术与训练底座 | [量化器家族](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/03-quantizers) |
| FastScan SIMD 批扫 | 4-bit 交织块布局与查表内核 | `pq4_pack_codes` in `impl/fast_scan/fast_scan.cpp:48` | 性能王牌，布局即算法 | [FastScan](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/04-fastscan) |
| 图索引 | HNSW/NSG/NNDescent 与确定性构建 | `hnsw_add_vertices_deterministic` in `faiss/IndexHNSW.cpp:71` | 图与存储分离的架构 + v1.15 确定性构建 | [图索引](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/05-graph-indexes) |
| 距离核与 SIMD 分派 | simdlib 类型体系、运行时分派、BLAS | `with_simd_level` in `impl/simd_dispatch.h:237` | 一套 API 覆盖 5 ISA 的基础设施 | [距离核与 SIMD](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/06-simd-distances) |
| 序列化与工厂 | fourcc 格式、工厂 DSL、AutoTune | `index_factory` in `faiss/index_factory.cpp:1234` | 组合性的出口：字符串即索引 | [序列化与工厂](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/07-io-factory-autotune) |
| GPU 后端 | GpuIndex 族、interleaved scan、CAGRA | `ivfInterleavedScan` in `gpu/impl/IVFInterleaved.cuh:39` | 存储格式级的并行重设计 | [GPU 后端](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/08-gpu-backend) |
| Python 绑定与 C API | SWIG 生成 + numpy 薄层 + 多版本加载 | `swigfaiss.swig` in `faiss/python/` | 90+ 类的对外脸面 | [Python 绑定](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/09-bindings) |

## 运行时行为

### 启动流程

Faiss 是库没有进程启动，对应概念是**索引构建流程**（train → add → search 三段）。以 `index_factory(d, "IVF1024,PQ16")` 为例：

```
index_factory 解析字符串（faiss/index_factory.cpp:965 index_factory_sub）
├─ parse_coarse_quantizer("IVF1024") → new IndexFlatL2(d, 1024) 作 quantizer
├─ parse_IndexIVF("PQ16") → new IndexIVFPQ(quantizer, d, 1024, 16, 8)
└─ fix_ivf_fields：quantizer_trains_alone=0（量词器在 train 时由 Clustering 训练）
     │
train(xb)：IndexIVF::train（faiss/IndexIVF.cpp:1311）
├─ train_q1：Clustering k-means 训 1024 个质心 → quantizer->add(centroids)
│    （IndexIVF.cpp:56-136；超采样集自动下采样到 max_points_per_centroid=256）
└─ train_encoder：残差（x − 质心）喂给 PQ → 每子空间独立 k-means 训字典
     │
add(xb)：assign → 残差 → pq.compute_codes → invlists->add_entries
     │
search：见下方核心运行流程
```

配置优先级：构造参数 > `Index.params`（SearchParametersIVF 的 nprobe 等）> 全局默认（`Level1Quantizer` 默认 nprobe=1）。

### 核心运行流程

#### 写路径：IndexIVF::add（倒排插入）

```
add_with_ids(n, x, ids)                          faiss/IndexIVF.cpp:205
├─ quantizer->assign(n, x, coarse_idx)           每向量找最近质心 = list_no
├─ add_core：encode_vectors（子类纯虚，IndexIVFPQ 版本先算残差再 PQ 编码）
└─ OpenMP 并行：每线程认领 list_no % nthreads == rank 的子集
     └─ invlists->add_entry(list_no, id, code)   不同 list 并发写安全（InvertedLists.h:52 契约）
```

#### 读路径：IndexIVF::search（IVFPQ 查询）

业务流程：Python `search(queries, k)` → 粗量化选 list → scanner 工厂 → LUT 预计算 → OpenMP 按 query 切分 → 逐 list 扫码 → ResultHandler 收 top-k。

![IVFPQ 查询数据流](/vibe-reading/images/articles/faiss-internals/data-flow-ivf-pq.svg)

文字描述：Python 层 `replace_method` 包装的 numpy 接口经 `swig_ptr` 裸指针零拷贝进 C++；SWIG 的 `%exception` 释放 GIL。`IndexIVF::search` 先让 quantizer 找 nprobe 个最近 list（IndexFlat 量化器在批量大时走 sgemm BLAS 路径），再由 `get_InvertedListScanner` 返回按 (SIMD level × 度量 × nbits × selector) 四维分发的 scanner。IVFPQ 的 scanner 在 `set_query` 预计算 **M×ksub 的距离查表（LUT）**——ADC 的核心：查询侧一次算全，库侧每向量退化为 M 次查表累加，无浮点乘法。`parallel_mode=0` 按 query OpenMP 切分，`max_codes` 在每个 list 后检查预算早停；异常经 `omp_capture_exception` 聚合回主线程。

#### 训练路径：Clustering（k-means）

训练即索引构建：`Clustering::train`（`faiss/Clustering.cpp:60`）是 Lloyd 迭代 + k-means++ 初始化（`impl/ClusteringInitialization.cpp:207`，v1.15 的 D² seeding 已并行化）+ 空簇分裂 + early stop。它同时服务 IVF 质心、PQ 字典、RQ 渐进维聚类——质量直接决定召回，这是 Faiss 训练代码"重"的原因。v1.15 新增 SuperKMeans（卡氏不等式剪枝的快速 k-means，k≥1024 场景）。

### 状态流

Faiss 索引大多无运行时状态机（构造→训练→加数据→查），唯一的"状态"概念是训练标记 `is_trained`（未训练调 add 直接抛异常）与 `ntotal` 计数；`IndexIVF` 的 DirectMap 有 NoMap/Array/Hashtable 三态（决定 reconstruct/remove 可用性）。无独立状态流图。

## 典型修改场景

#### 场景 1：新增一种 IVF 编码格式

继承 `IndexIVF` 实现 `encode_vectors`（唯一纯虚，`faiss/IndexIVF.h:268`）+ `train_encoder` + `reconstruct_from_offset` + `get_InvertedListScanner`——参照 `IndexIVFAdditiveQuantizer.cpp:169` 的 AQ scanner；merge/copy_subset 白得（typeid 相同即可合并）。

#### 场景 2：新增一种量化器

继承 `Quantizer`（`impl/Quantizer.h:15`，三个纯虚）或 `AdditiveQuantizer`（只需 `train` + `compute_codes_add_centroids` 两个纯虚，即刻获得 norm 量化/pack_codes/LUT 全套）；再补 `FlatCodesDistanceComputer` 与 IVF scanner；FastScan 加速需 4-bit 块布局 + `CodePacker`。

#### 场景 3：新增一个完整索引类型（5 处注册）

`index_write.cpp` 的 if-链加一支（fourcc）→ `index_read.cpp` 加对应读分支 → `AutoTune.cpp` 的 ParameterSpace 加参数域 → `index_factory.cpp` 加 regex → `clone_index.cpp` 加 TRYCLONE + 指针回接。

## 测试体系

```
tests/            # Python 测试为主（common_faiss_tests.py 共享基类）
├── test_index_*.py    # 按索引族
├── test_factory.py / test_binary_factory.py   # 工厂 DSL 回归
└── index_io_backward_compatibility/    # 历史格式文件回归（近十年 fourcc）
benchs/           # 论文复现与基准（bench_gpu_1bn.py 21K 等 ~40 脚本）
perf_tests/        # C++ 性能测试
tutorial/          # 11+11 篇 C++/Python 对照教程（编号即难度递进）
```

测试的独特点：**组合爆炸式覆盖**——`test_factory.py` 遍历工厂字符串 × 度量 × 数据分布跑一致性；`index_io_backward_compatibility` 用真实历史索引文件（仓库里存着十年前的产物）锁格式兼容；SIMD 相关测试在 CI 里对每个编译等级各跑一遍（v1.15 CHANGELOG："Run the eight SIMD kernel tests that no build executed"——修的就是此前漏跑）。

## 阅读源码推荐路线

- 第一遍：理解主流程
  `faiss/Index.h`（基类契约，435 行）→ `faiss/IndexFlat.cpp:29`（最简 search 派发）→ `faiss/IndexIVF.cpp:320-783`（search_preassigned 扫描引擎）
- 第二遍：理解核心数据结构
  `invlists/InvertedLists.h`（存储抽象）→ `faiss/IndexIVF.h:498`（scanner 契约）→ `impl/HNSW.h:65-148`（图的三数组布局）→ `impl/ProductQuantizer.h:29`（M/nbits/centroids 布局）
- 第三遍：理解性能机制
  `impl/simd_dispatch.h:237`（with_simd_level）→ `impl/fast_scan/fast_scan.cpp:48`（pq4_pack_codes 交织布局）→ `utils/distances.cpp:581`（BLAS/SIMD 阈值切换）→ `utils/Heap.h`（CMin/CMax 堆）
- 第四遍：选择重点深入
  各模块文档（见模块地图"深入阅读"列）；对 USearch 感兴趣的读者可对照阅读两库的 HNSW 实现差异（[图索引](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/05-graph-indexes) 末节有专门对比）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| IVF | Inverted File，倒排文件：粗量化器把向量分进 list，查询只扫 nprobe 个 |
| coarse quantizer | 粗量化器（一级量化），通常是 IndexFlat 或 HNSW，产出 list_no |
| nprobe | 查询时探测的 list 数，召回/延迟主旋钮；=nlist 时退化为全扫 |
| PQ | Product Quantization，子空间独立量化，距离查表（ADC/SDC） |
| ADC/SDC | Asymmetric/Symmetric Distance Computation——查询不量化/双方都量化 |
| RQ/LSQ/OPQ | 残差量化/局部搜索量化/正交旋转优化（residual 的三种增强） |
| RaBitQ | 随机比特量化：1 比特/维 + 数据相关缩放因子 + 理论误差界 |
| by_residual | 残差编码：存 x−质心 而非 x，同码长下量化误差更小 |
| FastScan | 4-bit 码的 32 向量交织块布局 + SIMD 查表批扫路径 |
| fourcc | 4 字符类型码，序列化格式的"版本号" |
| efSearch/efConstruction | HNSW 查询/构建的 beam 宽度 |
| DD | Dynamic Dispatch，SIMD 运行时分派构建模式（FAISS_OPT_LEVEL=dd） |
| interleaved | GPU IVF 布局：32 向量逐维交织，为 warp shuffle 设计 |
| polysemous | 多义码：PQ 码兼作二进制签名，Hamming 预筛 |

### 参考资料

- [Douze et al., The Faiss Library](https://arxiv.org/abs/2401.08281)（2024 综述，引用格式 douze2024faiss）
- [Johnson et al., Billion-scale similarity search with GPUs](https://arxiv.org/abs/1702.08734)（IEEE TBD 2019，GPU 实现）
- [Jégou et al., Product Quantization for Nearest Neighbor Search](https://ieeexplore.ieee.org/document/5432202)（PQ 原始论文，TPAMI 2011）
- [Malkov & Yashunin, HNSW](https://arxiv.org/abs/1603.04720)；[Fu et al., NSG](https://arxiv.org/abs/1707.00143)；[Dong et al., NN-Descent](https://arxiv.org/abs/1609.07428)（三个图结构）
- [Gao & Long, RaBitQ](https://arxiv.org/abs/2405.12497)；Panorama（arXiv:2510.00566）；[Vargaftik et al., EDEN](https://proceedings.mlr.press/v162/vargaftik22a)（三个新锐量化器）
- [Faiss 官方 wiki](https://github.com/facebookresearch/faiss/wiki)（教程/FAQ）与 [faiss.ai](https://faiss.ai/)（Doxygen）
