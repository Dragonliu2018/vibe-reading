---
source:
  type: "源码解读"
  project: "USearch"
  url: "https://github.com/unum-cloud/USearch"
title: "Overview"
date: "2026-09-21T15:26:32+08:00"
category: [Database, Misc, USearch, CodeWiki, "2.26.2"]
contentType: "CodeWiki"
tags: ["USearch", "C++", "向量检索", "HNSW"]
description: "USearch v2.26.2 源码架构解读——单头文件 HNSW 向量搜索引擎：核心图引擎 index_gt、metric_punned 类型擦除、稠密索引序列化、C ABI 与 10 语言绑定的完整内幕"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2.26.2 · **协议** Apache-2.0 · **语言** C++11 单头库（核心 ~11,800 行）+ 10 语言绑定 · **仓库** [GitHub](https://github.com/unum-cloud/USearch)
>
> **解读基线** commit [`f91fe5bc00`](https://github.com/unum-cloud/USearch/commit/f91fe5bc000222aa1af6e91daf78c2bb20b0c90e)（2026-08-31，v2.26.2 release commit）

---

## 总览

### 项目简介

USearch 是 Unum 开源的**单头文件向量相似度搜索与聚类引擎**：用一份 C++11 头文件（`include/usearch/` 下三个 .hpp 共 ~11,800 行）实现完整的 HNSW（分层可导航小世界图）近似最近邻索引，不依赖 BLAS 等外部库，通过 C ABI 和原生绑定铺到 10 种语言。它解决的问题是：现代数据库和应用需要"给一个向量，找最相似的 k 个"，而暴力扫描是 O(n·d)、FAISS 又重（84K SLOC、强制 OpenMP/BLAS）——USearch 用约 1/28 的代码量实现了同级甚至更快的 HNSW（README 基准：1 亿 96d 向量建索引比 FAISS 快 ~10x），并把"度量函数"做成用户可注入的模板参数，从文本、地理坐标到分子指纹都能索引。

核心价值三层：**性能**——`metric_punned_t` 在构造期把 NumKong SIMD 内核（AVX-512/NEON/SVE）烘焙成函数指针，查询路径零分支，支持 f16/bf16/FP8/i8/b1x8 全谱系低精度存储；**泛型**——核心图引擎 `index_gt` 对"值"毫无概念（duck-typing metric），稠密向量、变长集合、自定义对象都能进同一张图；**可移植**——一个 `.so`/单头文件覆盖 C/Go/Swift/C#/WASM，CXX/N-API/JNI 直连覆盖 Rust/JS/Java，同一份 `.usearch` 索引文件跨语言共享。

**项目当前边界**：USearch 负责索引结构与相似度计算，**不是**数据库——没有磁盘持久化事务、分片复制、SQL 层（这些由集成方 ClickHouse/DuckDB/ScyllaDB/TiDB 自己提供）；也没有训练量化模型（PQ/OPQ）和降维，只做精度降cast。图引擎与稠密向量的组合（`index_dense_t`）是默认形态，但引擎本身可以脱离向量单独使用。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| HNSW 图索引 | `include/usearch/index.hpp` | `index_gt` 模板：add/search/update/compact/isolate |
| 任意用户度量 | `include/usearch/index_plugins.hpp` | `metric_punned_t` 类型擦除 + Numba/Rust 回调注入 |
| 低精度存储 | `index_plugins.hpp` | f64/f32/f16/bf16/e5m2/e4m3/e3m2/e2m3/i8/u8/b1x8，自动上下转换 |
| SIMD 加速 | `numkong/` 子模块 | 双轨：NumKong 内核优先，失败退编译器自动向量化 |
| 精确搜索 | `search_exact_` in `index.hpp`、`exact_search_t` in `index_plugins.hpp` | 小数据集 brute-force，绕过索引 |
| 谓词过滤搜索 | `search(query, wanted, predicate)` | 谓词在图遍历中生效，不挡遍历只挡结果 |
| 删除/重命名 | `index_dense.hpp` `remove()`/`rename()` | 惰性删除：free_key 标记 + slot 环复用 |
| 压缩/隔离 | `compact()`/`isolate()` in `index_dense.hpp` | compact 物理重排回收空间，isolate 只剪入边 |
| 聚类 | `cluster()` in `index_dense.hpp` | 复用 HNSW 上层图节点当免费聚类中心 |
| Join | `join()` in `index.hpp` | Gale-Shapley 稳定婚姻做两索引一对一匹配 |
| 序列化 | `index_dense.hpp` | 三段式 `.usearch`；view 模式 mmap 零拷贝 |
| 4B+ 容量 | `uint40_t` in `index.hpp` | 5 字节寻址，1 万亿条目内省 37.5% 邻居表内存 |
| 多语言绑定 | `python/` `rust/` `javascript/` `golang/` `swift/` `java/` `objc/` `csharp/` `sqlite/` `wasm/` `wolfram/` | 双轨桥接：C ABI 与 C++ 直连 |
| 分片检索 | `dense_indexes_py_t`（Python） | 多个 mmap 只读分片当一个索引搜索 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C++11 | 核心 | 三个单头文件，零强制依赖（仅 STL + OS 原语） |
| NumKong v7.8.1 | 可选（git 子模块） | SIMD 距离内核库（AVX2/AVX-512/NEON/SVE/RVV），动态分发 |
| StringZilla v3.10.10 | 可选（git 子模块） | SQLite 扩展的字符串距离（Levenshtein 等） |
| OpenMP | 可选 | `executor_openmp_t` 线程池（CMake `USEARCH_USE_OPENMP`，默认关） |
| pybind11 ≥ 3.0 | Python 绑定 | `usearch.compiled` 原生扩展 |
| rust/cxx | Rust 绑定 | 静态桥 `NativeIndex` |
| node-addon-api | JS 绑定 | N-API 对象包装 |
| CMake ≥ 3.14 / pyproject / Cargo / SwiftPM | 构建 | 多产物：静态库、C 库、wheel、crate、Swift package |

### 顶层上下文图

USearch 作为库被两大类外部系统消费：

- **数据库集成**（把 USearch 当 ANN 索引引擎嵌入）：ClickHouse（`usearch` 索引类型）、DuckDB（VSS 扩展）、ScyllaDB（Rust vector-store）、TiDB/TiFlash、YugaByte、MemGraph、MatrixOne（Go）；
- **应用框架**（把 USearch 当向量检索原语）：LangChain、Microsoft Semantic Kernel、GPTCache、Sentence-Transformers（量化检索后端）、Google UniSim/RetSim、Pathway、Vald。

上游输入是各类 embedding 模型产生的向量（UForm 多模态、RDKit 分子指纹、地理坐标），USearch 自己不做 embedding。

## 快速上手

最简路径是 Python wheel：

```bash
pip install usearch
```

端到端验证（README 示例，3 维向量）：

```python
import numpy as np
from usearch.index import Index

index = Index(ndim=3)                # 默认 cos 度量
vector = np.array([0.2, 0.6, 0.4])
index.add(42, vector)               # 插入
matches = index.search(vector, 10)  # 查 10 近邻

assert matches[0].key == 42
```

验证硬件加速是否生效：

```bash
$ python -c 'from usearch.index import Index; print(Index(ndim=768, metric="cos", dtype="f16").hardware_acceleration)'
> sapphire    # Sapphire Rapids 级 AVX-512 内核已启用
```

C++ 侧同样单命令级——整个引擎就是 `#include <usearch/index_dense.hpp>`，无链接依赖。

## 架构设计解析

### 系统架构

USearch 的设计思想一句话：**核心极简、外延全靠注入**。中间的 `index_gt` 图引擎只有 ~5,000 行且仅依赖 STL 与 OS 原语——度量、分配器、执行器、谓词、回调全部是 duck-typing 模板参数，编译期用 `is_dummy<>` 把空策略分支彻底消除。这带来两个直接后果：一是任何"值"都能进图（稠密向量只是最常见的一种），二是所有语言绑定共享同一个没有 ABI 复杂度的 C++ 核心。

层间职责与依赖方向见下图：

![USearch 分层架构](/vibe-reading/images/articles/usearch-internals/architecture.svg)

注意两个反直觉的依赖事实：其一，`index.hpp` **不依赖** `index_plugins.hpp`——是 plugins 反向 include 核心头（取 `expected_gt` 与宏），核心完全自足可单独使用；其二，`index_dense.hpp` 是"装配点"，它把 plugins 的分配器（`aligned_allocator_gt`/`memory_mapping_allocator_gt`）和 punned metric 注入 `index_gt` 模板参数，同时自己管理向量数据的生命周期——图引擎里不存向量，只存 key 与邻居 slot。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 语言绑定层 | `python/` `rust/` `js/` `go/` 等 | 把 C++/C 接口翻译成宿主语言习惯（GC、异常、数组），隔离 FFI 复杂度 |
| 接口层 | `c/usearch.h` + 各绑定入口 | 双轨：C ABI 给"FFI 只认 C 符号"的语言兜底；C++ 直连给有原生 C++ 扩展机制的语言完整类型 |
| 稠密索引层 | `include/usearch/index_dense.hpp` | 承载"向量"语义：key 管理、精度转换、序列化、删除回收——让图引擎保持无值感知 |
| 核心图引擎层 | `include/usearch/index.hpp` | 纯图算法与并发：HNSW 增删查、选边启发式、锁策略——不含任何向量概念 |
| 基础设施层 | `include/usearch/index_plugins.hpp` + 子模块 | 标量类型、度量内核、执行器、分配器——可整体替换的"标准库" |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 类型擦除 + 函数指针路由 | `metric_punned_t` in `index_plugins.hpp:2856` | C ABI 不能携带模板参数；编译期全实例化 + 运行期一次查表，热路径零分支 |
| Tape 分配器 | `node_t` in `index.hpp:2401`、`memory_mapping_allocator_gt` | 节点所有层邻接表一次分配、永不单独释放——缓存局部性 + 序列化即 memcpy |
| 策略注入（duck-typing） | `dummy_predicate_t` 等 in `index.hpp:1761-1864` | 度量/谓词/回调/prefetch 全是模板参数，空策略编译期消除 |
| 门面 | `index_dense_gt` in `index_dense.hpp:405` | 用户语义（key、删除、序列化）挡在稠密层，图引擎只见 punned 的 slot |
| 代理 | `metric_proxy_t`/`values_proxy_t` in `index_dense.hpp:437/1889` | 把 `vectors_lookup_` 查表包装成图引擎需要的 value 语义 |
| Opaque handle | `usearch_index_t` = `void*` in `c/usearch.h:20` | 一个 `.so` 服务所有 FFI 语言 |
| 分片 facade | `dense_indexes_py_t` in `python/lib.cpp:94` | 多个 mmap 分片当一个索引，搜索期归并 top-k |
| 稳定婚姻 | `join()` in `index.hpp:4877` | 近似 join 的一对一约束天然是 Gale-Shapley 问题结构 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `index_gt` | HNSW 图引擎（模板） | 随 `index_dense_gt` 构造/析构 | 被 `typed_` 指针持有 |
| `node_t` | 节点"智能指针"（仅一个 `byte_t* tape_`） | add 时分配 tape，compact/view 时指向新址 | 打包 key+level+全层邻接表 |
| `context_t` | 每线程搜索上下文（双堆+visits） | `try_reserve` 时按线程数分配，全程复用 | search 结果直接引用其缓冲 |
| `metric_punned_t` | 类型擦除后的度量对象 | 构造期烘焙内核指针，可落盘恢复 | 被 dense 层与绑定共享 |
| `index_dense_gt` | 稠密索引门面 | `make()` 工厂创建 | 组合 `index_gt` + 查找表 + 向量 tape |
| `slot_lookup_` | key→slot 多重哈希表 | 随 reserve 扩容 | remove/rename/contains 的真相源 |
| `free_keys_` | 已删 slot 回收环 | remove 时入环，add 时弹出 | 惰性删除的枢纽 |
| `member_cref_t` | 图成员引用（key 引用 + slot） | 遍历时临时 | 图引擎对外统一成员视图 |

#### 核心抽象

| 抽象 | 定义位置 | 实现/注入方式 | 扩展点 |
|------|---------|-------------|--------|
| `metric_at`（度量契约） | `index_gt::add/search` 模板参数 | 任意满足 `operator()(value, entry)` 的可调用对象 | 用户度量（Numba/Rust/C 函数） |
| `predicate_at`（谓词契约） | `search()` 模板参数 | 任意 `bool(member_cref_t)` | filtered search |
| `executor_at`（执行器契约） | 批量操作模板参数 | `executor_stl_t` / `executor_openmp_t` / 自定义 | 并行策略 |
| `allocator_at`（分配器契约） | `index_gt` 模板参数 | STL / `aligned_allocator_gt` / `memory_mapping_allocator_gt` | 内存策略 |
| `tape_allocator_at` | `index_gt` 模板参数 | 要求"只整块释放"的 arena 语义 | 构建期批量分配 |

对象关系（核心路径）：

```
index_dense_gt ──typed_──▶ index_gt ──nodes_[]──▶ node_t ──tape──▶ [key|level|邻接表×层]
      │                       │                                       ▲
      ├──slot_lookup_ (key→slot 多重哈希)     contexts_[thread] ──────┘ 搜索时读
      ├──vectors_lookup_[slot] ──▶ 向量字节 (tape 分配或 mmap 直指)
      ├──free_keys_ (slot 回收环)
      └──metric_ (metric_punned_t) ──▶ NumKong 内核 / autovec / 用户函数
```

## 代码目录

```shell
USearch/
├── include/usearch/          # 核心单头库（~11,800 行）
│   ├── index.hpp             #   HNSW 图引擎 index_gt（5,066 行）
│   ├── index_plugins.hpp    #   标量/度量/执行器/分配器（4,293 行）
│   └── index_dense.hpp      #   稠密索引 index_dense_gt（2,454 行）
├── numkong/                 # git 子模块：SIMD 内核库 v7.8.1
├── stringzilla/             # git 子模块：字符串距离 v3.10.10
├── cpp/                     # C++ 测试与基准（test.cpp 1,590 行 / bench.cpp 693 行）
├── c/                       # C99 ABI（usearch.h + lib.cpp）
├── python/                  # pybind11 绑定 + 纯 Python 包（index/numba/server/io/eval）
├── rust/                    # CXX 桥（lib.hpp + lib.cpp + lib.rs）
├── javascript/              # N-API + TypeScript 门面
├── golang/                  # cgo 封装
├── swift/ objc/             # Swift（modulemap 走 C ABI）+ Objective-C++
├── java/                    # 手写 JNI
├── csharp/                  # P/Invoke
├── sqlite/                  # SQLite3 扩展（标量距离函数）
├── wasm/ wolfram/           # Emscripten（5 行复用 C ABI）/ Wolfram LibraryLink
└── docs/                    # Doxygen 文档站配置
```

`tests` 分散在各语言目录（`cpp/test.cpp`、`c/test.c`、`python/`、`javascript/usearch.test.js`、`golang/lib_test.go`），没有统一 `tests/` 顶层目录。

## 模块地图

模块间依赖方向与两条桥接路线：

![模块依赖关系](/vibe-reading/images/articles/usearch-internals/module-dependencies.svg)

依赖主线是 `index_dense.hpp` 向下装配：把 plugins 的分配器与 punned metric 注入 `index_gt`，向上同时服务 C ABI 转译与 C++ 直连绑定。虚线是容易误读的一处：`index_plugins.hpp` 反向 include `index.hpp`（复用 `expected_gt` 错误类型与编译宏），但核心图引擎对 plugins 的存在一无所知。NumKong 提供全部 SIMD 距离内核；StringZilla 只被 SQLite 绑定和 Python wheel 打包使用（文本距离）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 核心图引擎 | HNSW 图算法、并发增删查、refine 启发式、join | `index_gt::add()` in `index.hpp:3181` | 图引擎必须无值感知才能泛型化（文本/集合/自定义对象） | [核心图引擎](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/01-core-graph-engine) |
| 并发与锁设计 | striped locks、读写并发不变量、锁层级 | `striped_locks_gt` in `index.hpp:668` | 并发正确性横跨 add/search/update，值得单独深读 | [并发与锁设计](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/01-core-concurrency) |
| 基础设施与度量 | 标量类型系统、metric 路由、执行器、分配器 | `metric_punned_t::builtin()` in `index_plugins.hpp:2916` | "标准库"层可整体替换（换 SIMD 后端不动图引擎） | [基础设施与度量](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/02-plugins-infra) |
| 稠密索引 | key 管理、惰性删除、序列化、聚类 | `index_dense_gt::make()` in `index_dense.hpp:663` | 向量语义与图算法解耦——删除/序列化都只在这层有意义 | [稠密索引](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/03-dense-index) |
| C ABI 接口层 | C99 导出面、错误传递、枚举映射 | `usearch_init` in `c/usearch.h:143` | 一个 `.so` 服务所有弱 FFI 语言的最低公分母层 | [C ABI 接口层](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/04-c-abi) |
| 多语言绑定 | Rust/JS/Go/Swift/Java/SQLite/WASM 的桥接选型 | `rust/lib.hpp`、`javascript/lib.cpp` 等 | 每语言的句柄/错误/数组转换模式差异大且互相独立 | [多语言绑定](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/05-language-bindings) |
| Python 生态 | pybind11 原生层 + Pythonic 封装 + Numba JIT + RPC | `Index.__init__` in `python/usearch/index.py:541` | 引用量最大的绑定，双层结构与 GIL 模型自成体系 | [Python 生态](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/06-python-ecosystem) |

模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」的三条链路。

## 运行时行为

### 启动流程

以最常用的 Python `Index(ndim=..., metric=..., dtype=...)` 为例，对象装配链是：

```
Index.__init__ (python/usearch/index.py:541)
├─ _normalize_metric：'cos' 字符串 → MetricKind 枚举        index.py:171
├─ _normalize_dtype：None → 按硬件探测 BF16/F16/F32          index.py:100
├─ _CompiledIndex(metric_pointer, dims, ...)                pybind11 make_index (python/lib.cpp:137)
│   ├─ metric_uintptr 非零 → metric_t::stateless（Numba 回调）
│   └─ 否则 metric_t::builtin(dims, kind, scalar)            index_plugins.hpp:2916
│       ├─ configure_with_numkong()：nk_find_kernel_punned 按 CPU 能力选内核
│       └─ 失败 → configure_with_autovec()：双重 switch 到 equidimensional_ 模板
└─ make() 工厂 (index_dense.hpp:663)
    ├─ index_allocator_t（64 对齐）分配 index_gt 原始内存
    ├─ placement new index_t(config_)
    └─ try_reserve(limits)：分配 contexts_（每线程）、cast_buffer_、
       slot_lookup_、available_threads_ 环、striped locks       index.hpp:2914
```

配置优先级：构造参数（connectivity/expansion/dtype/metric）> 编译期默认（`default_expansion_add()=128`、`expansion_search()=64`、connectivity=16/base=32，见 `index.hpp:1585-1614` 的文档注释——刻意低于 FAISS 默认以省内存）。依赖注入全部是手动 new + placement new，无 DI 容器；`search_result_t` 把 `thread_lock_t` 存进结果对象（`index_dense.hpp:571`），保证用户迭代结果期间线程槽不被覆写——"结果对象持有资源"的少见设计。

### 核心运行流程

以下三条链路覆盖 USearch 最主要的运行模式：批量插入（建索引）、近似查询（服务）、序列化与零拷贝服务。每条都是跨全部四层的纵向切面。

#### 写路径：批量向量插入（add）

业务流程：用户提交 (keys, vectors) → 归一化 → 多线程并行插入 → 每个向量走"cast → 占槽 → 图搜索插入点 → 启发式连边"。

![add 数据流](/vibe-reading/images/articles/usearch-internals/data-flow-add.svg)

文字描述：pybind11 层用 buffer 协议零拷贝拿到 numpy 裸指针后**释放 GIL**、拿 per-index mutex（防多个 Python 线程撞 `cast_buffer_` 每线程槽，见 `python/lib.cpp:79-88` 的原注释），`executor.dynamic` 把向量静态切给各线程。稠密层先把输入精度 cast 到索引精度（cast 后强制拷贝向量，因为暂存区会被下一次调用覆盖），再决定 slot：新 key 进 `slot_lookup_`，复用已删 slot 则走 `update()` 重连边。图引擎层的 add 有两个关键设计：`global_mutex_` 只在新节点可能刷新入口点时全程持有（否则提前解锁）；连边用 `refine_` 启发式（HNSW 论文 Algorithm 4）——候选按距离升序逐个与已入选者比较互相距离，存在更近的"替身"则丢弃，保证邻居方向多样化而非局部最优。

#### 读路径：近似查询（search）

业务流程：查询向量 → cast → 贪心下降到 0 层 → beam search → top-k 截断 → numpy 数组返回。

![search 数据流](/vibe-reading/images/articles/usearch-internals/data-flow-search.svg)

文字描述：与 add 共享同一套每线程 context（双堆 + visits 哈希集全程复用，只在函数入口 clear）。图引擎 `search_for_one_` 从 `entry_slot_` 逐层贪心下降，0 层 `search_to_find_in_base_` 做 beam search——**完全不加节点锁**（`index.hpp:4658` 注释明示假设只读并发），靠"先写 slot 再增 count"的写序保证读者不读到半写条目。谓词过滤有个容易忽略的细节：不满足谓词的点不进 top 但**仍会被扩展**（只挡结果不挡遍历），这是 filtered search 召回率的关键。`exact=True` 时绕过图直接 `search_exact_` 全量扫（NumKong SIMD 的 brute-force 可比 FAISS `IndexFlatL2` 快 20x）。结果 `dump_to` 写回预分配的 numpy 数组，`BatchMatches` 是惰性视图——`to_list()` 才物化 Python 对象。

#### 服务路径：序列化与零拷贝 view

业务流程：save 三段式落盘 → load 拷贝进 RAM / view 只 mmap。

![序列化布局](/vibe-reading/images/articles/usearch-internals/dense-serialization.svg)

文字描述：`.usearch` 文件三段：向量矩阵（自带 rows×cols 头，可独立存在）、64 字节 head（magic "usearch" + 版本 + 4 个 kind 枚举 + 计数，实际用 42 字节、尾部 22 字节保留扩展）、图段（5×u64 头 + 层数数组 + 变长 node tape）。view 模式的精妙在于**零反序列化**：`vectors_lookup_[slot]` 只存 `mmap 基址 + matrix_cols × slot` 的指针算术（`index_dense.hpp:1460`），`node_t` 直接指向 mmap 的图段（`index.hpp:4012`），OS 按需缺页——数十 GB 索引可以不进 RAM 直接服务，官方称在云上可省 20x 成本。代价是 `is_immutable()`，add/remove 直接拒绝。

### 状态流

slot 的生命周期是稠密索引层最重要的运行时状态机：

![slot 生命周期](/vibe-reading/images/articles/usearch-internals/dense-slot-lifecycle.svg)

状态定义在三个结构的组合上：`slot_lookup_` 有映射 = 活跃；`typed_->at(slot).key == free_key_` = 已删（`remove()` in `index_dense.hpp:1641` 三重操作：入 `free_keys_` 环、erase 查找表、图上打标记）。删除是 O(1) 的惰性标记——物理摘除 HNSW 节点要修全局连通性，代价是 O(度×层数)。已删 slot 被 add 复用时走 `update()` 在原节点重连边（老节点已有成熟邻居关系，位置局部性反而更好）；`compact()` 才物理重排回收空间。`load` 之后全部状态由 `reindex_keys_()` 从图上的 free_key 标记反推重建（`index_dense.hpp:2339`）。

## 典型修改场景

#### 场景 1：新增一种输入标量类型（如未来的 f4）

- `include/usearch/index_plugins.hpp`：`scalar_kind_t` 加枚举 + bits 类（LUT 或位运算上下转换，参照 `e5m2_bits_t` in `index_plugins.hpp:935`）+ `cast_gt` 特化块 + `casts_punned_t` 函数表加格
- `include/usearch/index_dense.hpp:872-942`：add/search/filtered_search/get/cluster 六张重载表各加一行（clang-format off 的机械块）
- 绑定层：`python/lib.cpp` 的 `add_many_to_index` 等 switch、`c/lib.cpp:91-137` 的 `add_`/`get_`/`search_` 分发各加 case
- 对应测试：`c/test.c` 的 `kinds[]` 数组加一行即入量化回归

#### 场景 2：调索引质量/速度权衡

- 只改构造参数，不动结构：`connectivity`（每节点邻居数，默认 16）、`expansion_add`（建索引 beam 宽，默认 128）、`expansion_search`（查询 beam 宽，默认 64）——影响链是 `index_config_t` in `index.hpp:1607` → 每节点 tape 尺寸（`pre_.neighbors_bytes`）→ 内存与召回
- 运行期可再调：`change_expansion_add/search`（`index_dense.hpp:763`）只是改 config，热参数零结构影响

#### 场景 3：新增一个查询类图遍历操作（如导出邻接子图）

- 照 `cluster()`（`index.hpp:3504`）的模式：`search_for_one_` 降到目标层 + `context.measure` 收尾
- 只读遍历直接用公开的 `neighbors_view_t`（`index.hpp:2726`，解引用出 `member_cref_t`，不触碰内部 slot）；注意其别名节点邻接表，仅限无并发 mutation 时有效
- 绑定层若要导出：Rust 的 `NeighborsCursor`（`rust/lib.hpp:15`）是现成的流式迭代器范式，其他语言需自行桥接

## 测试体系

```
cpp/test.cpp        # C++ 全量测试（1,590 行）：组合爆炸 ~500,000 用例
c/test.c            # C ABI 自验证（514 行，零依赖纯 C，带崩溃处理器）
javascript/usearch.test.js / golang/lib_test.go / swift/Test.swift
python/            # 随 wheel 发布的回归（eval.py 提供基准 CLI）
cpp/bench.cpp      # 基准（693 行）
```

测试没有 unit/integration/e2e 分层——`cpp/test.cpp` 是"类型矩阵 × 极端参数"的组合测试：`test_absurd`（`cpp/test.cpp:894`）遍历 connectivity∈{2,3} × dims∈{1,3} × expansion∈{0,1,3} × 向量数∈{0,1,2,17} × 取数∈{0,1,3,19}，注释自陈产出接近 50 万个用例；`test_cosine` 覆盖 f32/bf16/f16/e5m2/e4m3 × slot32/uint40 组合。`c/test.c` 自带 SIGSEGV/SIGABRT 崩溃处理器打印 backtrace（`c/test.c:43-87`）——C ABI 一旦传错指针就是段错误，CI 日志需要能定位帧。想理解某个 C++ 类，优先读 `cpp/test.cpp` 里对应用例（如 `test_slot_lookup_churn` in `cpp/test.cpp:1123` 是删除/复用路径的"可执行文档"）。

## 阅读源码推荐路线

- 第一遍：理解主流程
  `python/usearch/index.py` 的 `Index.add()`/`search()` → `python/lib.cpp` 的 `add_typed_to_index`（GIL/mutex/executor 三件套）→ `index_dense.hpp` 的 `add_`（`index_dense.hpp:2168`）→ `index.hpp` 的 `index_gt::add()`（`index.hpp:3181`）
- 第二遍：理解核心数据结构
  `index.hpp` 的 `node_t` + `neighbors_ref_t`（`index.hpp:2401-2480`，tape 布局）→ `context_t`（`index.hpp:2487`，双堆与 visits）→ `index_dense.hpp` 的 `slot_lookup_`/`free_keys_` 声明（`index_dense.hpp:458-531`）
- 第三遍：理解度量与精度机制
  `index_plugins.hpp` 的 `metric_punned_t`（`index_plugins.hpp:2856`，重点 `configure_with_numkong` at 3045 与 `configure_with_autovec` at 3108）→ `f16_bits_t`/`e5m2_bits_t` 的 LUT 转换（569/935）→ `index_dense.hpp` 的 `add_` 里 cast 注入
- 第四遍：选择重点深入
  并发正确性 → [并发与锁设计](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/01-core-concurrency)；序列化格式 → [稠密索引](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/03-dense-index)；跨语言桥接 → [多语言绑定](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/05-language-bindings)；Python GIL 模型 → [Python 生态](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/06-python-ecosystem)

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| HNSW | Hierarchical Navigable Small World，分层可导航小世界图，近似最近邻的主流索引结构 |
| connectivity（M） | 每节点每层邻居数上限；0 层用 `connectivity_base`（默认 2×=32），上层 16 |
| expansion（ef / efConstruction） | beam search 的候选宽度；add 与 search 各一个 |
| slot | 图引擎的内部节点编号（`compressed_slot_t`，默认 uint32，可选 uint40） |
| key | 用户可见的外部主键（默认 uint64），一个 key 可映射多个向量（multi 模式） |
| punning / punned | 类型擦除——用统一函数签名 + 运行期查表替代模板静态分发 |
| tape | 连续字节条带；节点的全部数据打包在一条 tape 里，一次分配 |
| free_key | 删除标记哨兵值，图上打此标记的 slot 逻辑上已删 |
| view | mmap 只读挂载序列化文件，不拷贝数据、不支持写操作 |
| b1x8 | 8 个 bit-packed 布尔的标量类型，配合 Hamming/Tanimoto/Jaccard |
| e5m2 / e4m3 / e3m2 / e2m3 | IEEE 与 MX 格式的 FP8/FP6 变体（指数-尾数位数） |

### 参考资料

- [Malkov & Yashunin, Efficient and robust approximate nearest neighbor search using HNSW graphs](https://arxiv.org/abs/1603.04720)（TPAMI 2018）——`refine_` 即论文 Algorithm 4
- [USearch 官方文档站](https://unum-cloud.github.io/USearch/)（Doxygen，`docs/conf.dox`）
- [Scaling Vector Search with Intel](https://www.unum.cloud/blog/2023-11-07-scaling-vector-search-with-intel)——README 基准数据的出处
- [Combinatorial Stable Marriages for Semantic Search](https://ashvardanian.com/posts/searching-stable-marriages)——`join()` 的设计文
- [Abusing Vector Search](https://ashvardanian.com/posts/abusing-vector-search)——非向量值（文本/地理/集合）进 HNSW 的思路
- [NumKong](https://github.com/ashvardanian/numkong)、[StringZilla](https://github.com/ashvardanian/stringzilla)——两个子模块
