---
source:
  type: "源码解读"
  project: "Helmsman"
  url: "https://github.com/Red-EAD/helmsman"
title: "Overview"
date: "2026-08-18T21:08:07+08:00"
category: ["AI", "Infra", "Retrieval", "Helmsman", "CodeWiki", "1.0"]
tags: ["Helmsman", "MiniHyperVec", "ANNS", "C++", "SPDK", "NVMe", "HNSW"]
description: "OSDI 2026 论文 Helmsman 的开源 PoC（MiniHyperVec）——基于 SPDK NVMe 的聚簇式近似最近邻搜索服务系统源码解读。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.0 · **协议** BSL 1.1（Licensor: Rednote）· **语言** C++20 · **代码量** ~7,700 行（项目代码，不含 vendored json/hnswlib）· **仓库** [GitHub](https://github.com/Red-EAD/helmsman)

---

## 总览

### 项目简介

**Helmsman** 是 OSDI 2026 论文《The Clustering Strikes Back: Building Cost-Effective and High-Performance ANNS at Scale with Helmsman》提出的近似最近邻搜索（ANNS）服务系统；本仓库 **MiniHyperVec** 是其开源概念验证（proof-of-concept）实现。它解决的核心问题是：当向量规模大到无法全部驻留内存时，如何在**低成本硬件**（消费级 NVMe SSD）上同时实现**高召回**与**低尾延迟**的向量检索服务。

Helmsman 的核心思路是"聚簇反击"——把向量按 centroid 划分成定长 cluster（posting list），centroid 索引常驻内存，cluster 数据下沉到 NVMe；查询时先在内存 HNSW 上找到最近的 nprobe 个 centroid，再用 **SPDK 用户态 NVMe** 批量异步读取对应 cluster，最后在 CPU 上做 SIMD 内积与 Top-K 排序。定长 cluster（HV_CONST 格式）让 NVMe 读取可以用固定大小的批量 I/O，配合 SPDK 绕过内核文件系统，把随机读的尾延迟压到很低。

核心使用场景是大规模向量检索服务（推荐/搜索/去重的召回层），尤其适合内存装不下全量向量、又对 P99 延迟敏感的场景。

**项目当前边界**：这个 PoC 包含完整的 CPU 侧 serving 路径（索引抽象、运行时、SPDK I/O、离线构建、剪枝）；**不包含**论文 Section 5.3 的 GPU 加速构建流水线和 Section 5.5 的 LLSP（延迟感知负载调度）模块——这两项是 roadmap。剪枝（Section 5.4）代码存在但可选（`PRUNE_ON`），且 PoC 中只实现了 `PruningToolNaive`，真正的 LightGBM+ONNX 剪枝需自行接入。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| HV_CONST 聚簇搜索 | `source/index/hyperconst_imp.cpp` | 两层检索：内存 HNSW 找 centroid + NVMe 读定长 cluster |
| HNSW 纯内存搜索 | `source/index/hnsw_imp.cpp` | hnswlib HNSW，小数据集或对比基线 |
| SPDK 用户态 NVMe I/O | `source/nvme/nvme_controller.cpp` | 绕过内核，异步批量读写 |
| 多线程服务 | `source/runtime/worker/serving_worker.cpp` | `ServingWorkerPool` + CPU 绑核 + RAII handle |
| 离线索引构建 | `third_party/spann_aug/src/spann_index_builder.cpp` | SPTAG SPANN → HV_CONST，含 Filling 算法 |
| 剪枝（可选） | `source/prune/prune_tool.cpp` | `PruningToolNaive`，减少 nprobe |
| SIMD int8 内积 | `include/compute/distance_cal.hpp` | AVX2 / AVX-512 批量内积 |
| NVMe 空间分配 | `source/nvme/nvme_allocator.cpp` | 64MB chunk 粒度 round-robin |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| C++20 | 核心 | 语言标准（模板全特化、`std::span`、`std::atomic` 等） |
| SPDK v22.09 | 核心 | 用户态 NVMe 驱动，绕过内核 syscall 与 page cache |
| oneTBB v2021.12.0 | 核心 | `tbb::spin_rw_mutex`（ClusterMap 无锁读路径）等并行原语 |
| hnswlib（vendored） | 核心 | HNSW 算法（centroid 头索引 + bruteforce 基线），位于 `include/util/hnswlib/` |
| nlohmann/json（vendored） | 核心 | 元数据 JSON 序列化，位于 `include/util/jsonlib/json.hpp` |
| LightGBM | 可选 | 剪枝模型（`PRUNE_ON=ON` 时链接） |
| ONNX Runtime | 可选 | 剪枝推理（`PRUNE_ON=ON` 时链接） |
| SPTAG（外部） | 构建 | 生成输入 SPANN 索引（`SPTAGHeadVectors.bin` 等） |

> **BSL 1.1 协议**：本项目采用 Business Source License 1.1，非 MIT/Apache。生产商用需关注 Licensor（Rednote）的附加条款，个人/研究使用通常无限制。

---

## 快速上手

> 这里只给"最快看到搜索跑起来"的路径，完整安装手册见仓库 [README](https://github.com/Red-EAD/helmsman)。

**前置**：Linux + SPDK v22.09 + oneTBB 已安装到 `/mnt/service/3rd_party/`，NVMe 已 bind 到 VFIO（`sudo ./scripts/setup.sh`）。

```bash title="构建（关闭剪枝，最简）"
source ./setup/.envrc
mkdir build && cd build
cmake .. -DCMAKE_CXX_STANDARD=20 -DPRUNE_ON=OFF
make -j minihypervec_deploy multi_thread_search
```

**端到端验证**（三步：生成 NVMe 元数据 → 部署索引 → 多线程搜索）：

```bash title="一次完整 serving 验证"
# 1. NVMe 设备探测 → 生成 nvme_meta.json
sudo ./build/app/config_nvme_meta

# 2. 把 SPTAG 产出的索引转换为 HV_CONST 并部署到 NVMe
./build/app/spann_build_index --spann-dir /path/to/sptag_out --output-dir /path/to/release/collection
cp /path/to/rawdata.bin /path/to/release/collection/collection_rawdata.bin
./build/test/minihypervec_deploy collection

# 3. 多线程搜索 + recall 评估
./build/test/multi_thread_search \
  --collection_name collection --query_path query.i8bin \
  --groundtruth_path gt.bin --index_type HV_CONST --vec_type INT8 \
  --nprobe 36 --topk 10 --T 10 \
  --memory_index_type HNSW --memory_search_max_visits 1800
```

预期输出包含 `Recall@10 = ...`、`P99 = ... ms`、`throughput = ... QPS`，即证明 serving 路径跑通。

---

## 架构设计解析

### 系统架构

Helmsman 的设计思想是**"内存索引定位 + NVMe 批量取数 + CPU SIMD 计算"三段流水线**，用定长聚簇（HV_CONST）把不规则的 SPANN posting list 规整成 NVMe 友好的定长块，从而把随机读变成可批量提交的异步 I/O，让 I/O 与 CPU 计算重叠。这样做的代价是离线需要 Filling 算法补齐定长 cluster，换来的是在线 serving 的低尾延迟。

整个在线 serving 栈分为五层，请求自上而下穿过：入口层驱动 → 运行时层编排资源与并发 → 索引层执行检索算法 → NVMe 层做用户态 I/O → 基础设施层提供元数据与文件 I/O。离线构建（`spann_aug`）是独立支线，产出的索引文件喂入在线 deploy 流程。

![Helmsman 分层架构](/vibe-reading/images/articles/helmsman-internals/architecture.svg)

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 入口层 | `test/`、`app/` | 4 个可执行入口，分别驱动搜索、部署、NVMe 元数据、离线构建；隔离 CLI 与核心库 |
| 运行时层 | `source/runtime/` | 系统生命周期、线程池、资源池、cluster→NVMe 条带映射；把并发/资源管理与算法解耦 |
| 索引层 | `source/index/`、`source/compute/`、`source/prune/` | 索引抽象与两种实现 + SIMD 距离计算 + 剪枝；承载核心检索逻辑，不关心 I/O 细节 |
| NVMe I/O 层 | `source/nvme/` | SPDK 用户态 NVMe 读写、IO queue 管理、chunk 粒度空间分配；性能根基 |
| 基础设施层 | `source/collection/`、`source/util/`、`include/util/` | 类型枚举、路径配置、二进制文件 I/O、vendored hnswlib/json；全局底座 |

> **耦合点**：`HyperConstImp`（索引层）持有 `ClusterMap` 与 `ClusterExtra`（运行时层目录下）作为值成员——这是索引层向运行时层的回向依赖，因为聚簇映射逻辑上服务于索引检索。详见 [02-runtime](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/02-runtime)。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板全特化 | `IndexAbs<T>` / `HyperConstImp<T>` / `ClusterExtra<T>`（`include/index/index_abs.hpp`） | 当前只支持 `int32_t`（int8 向量 + int32 距离），特化锁定类型、暴露未来加 float16 的扩展点 |
| 策略模式 | `IndexAbs<int32_t>` 多态，`HnswImp` / `HyperConstImp` 二选一（`source/index/param.cpp`） | 同一 `searchKnn` 接口屏蔽 HNSW 与 HV_CONST 两条路径差异 |
| 桥接/组合 | `HyperConstImp` 持有 `centroid_index` + `prune_tool` + `m_cluster_map` + `m_cluster_extra`（`include/index/hyperconst_imp.hpp`） | HV_CONST 索引不是单一类，而是"头索引 + 剪枝 + 聚簇映射 + 聚簇数据"的组合体 |
| 单例（Meyer's） | `MiniHyperVecEnv`、`IndexHolder`、`ServingWorkerPool`、`OfflineWorker`、`NVMeManager`、`NVMeAllocator`、`NVMeMetaHandler`、`PathConfig` | 全局唯一资源管理器，`getInstance()` 简化跨模块访问 |
| 对象池 + RAII | `ServingWorkerPool::WorkerHandle`（`include/runtime/worker/serving_worker.hpp`） | worker 复用 + 析构自动 release，避免裸指针泄漏 |
| 门面 | `NVMeManager` 屏蔽多 `NVMeCtrl`（`include/nvme/nvme_manager.hpp`） | 对外只暴露 `nvme_id` 路由，上层不感知多设备与 qpair 细节 |
| 快照隔离 | `SpannIndex::BuildSnapshotForFilling`（`third_party/spann_aug/src/spann_index_builder.cpp`） | Filling 时只读 snapshot、写原数据，避免簇间借向量的连锁污染 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `HyperConstImp<int32_t>` | HV_CONST 聚簇索引，系统核心 | deploy/load 时构造，常驻 `IndexHolder` | 持有 `centroid_index`、`prune_tool`、`m_cluster_map`、`m_cluster_extra` |
| `ClusterStripe` | cluster 在 NVMe 上的位置（`nvme_id` + `lba_id`） | deploy 时写入 `ClusterMap`，search 时读出 | `ClusterMap` 的值类型，`#pragma pack(4)` 紧凑 |
| `ClusterMap` | cluster_id → `ClusterStripe` 映射表 | deploy 时 `allocateChunks` 填充，search 时 `getClusterStripeBatch` 读 | `HyperConstImp` 的值成员，`tbb::spin_rw_mutex` 保护 |
| `ClusterExtra<int32_t>` | 每簇的 vector IDs + L2 norms | deploy 时从 `cluster_ids.bin` / `cluster_norms.bin` 加载 | `HyperConstImp` 的值成员 |
| `SearchTempResource` | 单次搜索的临时 buffer（IO 读 / 距离 / rank） | 每查询从 `SearchResourcePool` 借出，查询结束归还 | per-worker 复用，无锁 |
| `ServingWorker` | 服务线程，绑核执行 `searchKnn` | `ServingWorkerPool` 创建，进程内复用 | 持有 `index_holder` + `g_search_rsrc_pool` 指针 |
| `SpannIndex` | 离线索引构建器 | 构建工具进程内存在，退出即销毁 | 持有 `head_hnsw_`、`cluster_ids_/vecs_`、`snapshot_*_` |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IndexAbs<int32_t>` | `include/index/index_abs.hpp` | `HnswImp<int32_t>`、`HyperConstImp<int32_t>` | `HyperConstImp::loadInmemIndexDuringLoad` 中按 `IndexType` switch 创建（`source/index/hyperconst_imp.cpp`） |
| `PruningTool<int32_t>` | `include/prune/prune_tool.hpp` | `PruningToolNaive<int32_t>` | `HyperConstImp::loadPruneToolDuringLoad` 创建（默认 Naive） |
| `hnswlib::SpaceInterface<int32_t>` | `include/util/hnswlib/space_ip.hpp` | `L2SpaceI_int8`、`InnerProductSpace` | `HnswImp::initIndex` 按 `DisType` 选择 |

---

## 代码目录

```text
helmsman/
├── app/                          # 独立可执行工具
│   ├── config_nvme_meta.cpp      #   NVMe 设备探测 → nvme_meta.json
│   └── spann_build_index.cpp     #   SPTAG SPANN → HV_CONST 离线构建入口
├── test/                         # 入口可执行（CMake 归为 test，实为 serving 驱动）
│   ├── minihypervec_deploy.cpp   #   部署 collection 到 NVMe
│   ├── multi_thread_search.cpp   #   多线程搜索 + recall/延迟评估
│   └── minihypervec_search.cpp   #   单线程搜索
├── include/                      # 头文件（与 source/ 镜像）
│   ├── root.hpp                  #   "god header"：汇总 SPDK/TBB/hnswlib/json/STL
│   ├── meta_path.hpp             #   PathConfig + release::constants 文件名约定
│   ├── collection/               #   VecType/DisType/IndexType + CollectionMeta
│   ├── index/                    #   IndexAbs / HnswImp / HyperConstImp / params
│   ├── compute/                  #   distance_cal (SIMD) / rank_cal (Top-K)
│   ├── runtime/                  #   env / worker / resource / cluster
│   ├── nvme/                     #   NVMeManager / NVMeCtrl / NVMeAllocator / NVMeMeta
│   ├── prune/                    #   PruningTool
│   └── util/                     #   file/ (Dataset,GtReader) + hnswlib/ + jsonlib/
├── source/                       # 实现文件（与 include/ 镜像）
├── third_party/spann_aug/        # 离线索引构建库（spann_core 静态库）
├── setup/                        # .envrc (SPDK/TBB 环境变量) + path_config.json
├── datasets/                     # 示例数据集（SimSrch / SimRec，Git LFS）
└── CMakeLists.txt                # 顶层构建（PRUNE_ON / SPANN_AUG_BUILD / CUDA_ON 选项）
```

> `include/util/jsonlib/json.hpp`（25,629 行）和 `include/util/hnswlib/`（~2,500 行）是 vendored 第三方库，不计入项目代码量。`third_party/spann_aug/` 是独立静态库 `spann_core`，只被 `spann_build_index` 链接，不链接 `MiniHyperVec` 共享库。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/helmsman-internals/module-dependencies.svg)

依赖方向总体自上而下：入口 → 运行时 → 索引 → NVMe → 基础设施。两个跨层耦合值得注意：① 索引层的 `HyperConstImp` 反向持有运行时层的 `ClusterMap`/`ClusterExtra`（聚簇映射逻辑上服务于索引）；② 运行时层的 `SearchResourcePool`/`OfflineWorker` 直接调用 NVMe 层的 `NVMeManager`。离线构建（绿色）是独立支线，产出的索引文件（虚线）喂入在线 deploy。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 索引层 | ANNS 索引抽象 + HV_CONST/HNSW 实现 + SIMD 计算 + 剪枝 | `HyperConstImp::searchKnn` | 承载核心检索算法与七步搜索流水线，与 I/O/并发解耦 | [01-index](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/01-index) |
| 运行时层 | 环境生命周期 + 服务/部署 worker + 资源池 + 聚簇映射 | `MiniHyperVecEnv::initForSearch` | 编排并发与 per-worker 资源，隔离算法与 I/O 调度 | [02-runtime](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/02-runtime) |
| NVMe I/O 层 | SPDK 用户态 NVMe 批量读写 + chunk 分配 + 设备元数据 | `NVMeManager::readSubmit` | 绕过内核的低延迟 I/O 是整个系统性能根基 | [03-nvme](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/03-nvme) |
| 离线构建 | SPTAG SPANN → HV_CONST 转换 + Filling 算法 + norm 预算 | `SpannIndex::PerformFilling` | 独立的离线数据准备，产出在线消费的索引文件契约 | [04-index-builder](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/04-index-builder) |
| 基础设施 | 类型枚举 + 路径配置 + 文件 I/O + 数据集加载 | `PathConfig::getInstance` | 全局高扇入底座（`root.hpp` 被 11 个头文件 include），被所有上层依赖 | [05-infra](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/05-infra) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」——搜索主链路串联了运行时 → 索引 → NVMe 三层的实际调用。

---

## 运行时行为

### 启动流程

以 `multi_thread_search` 的 `initForSearch` 为例，展示进程启动时的对象装配顺序（deploy 路径走 `initForDeploy`，结构相似但初始化 OfflineWorker 而非 ServingWorker）：

```
multi_thread_search.cpp main()
  → MiniHyperVecEnv::getInstance()                 // source/runtime/env/minihypervec_env.cpp
  → initForSearch(collection_name)
      ├─ initPathConfig()                          //   PathConfig 加载 path_config.json
      ├─ loadEnvParam(hardware_meta.json)          //   解析 worker 数/CPU IDs/buffer 大小
      ├─ initNVMe()                                //   NVMeManager: initNVMeMeta + initNVMeEnv + initNVMeDev
      ├─ initIndexHolder(collection_name)          //   加载 CollectionMeta → 构造 HyperConstImp
      │     → HyperConstImp::loadIndex
      │         ├─ loadMetaDuringLoad              //     读 _index_meta.json
      │         ├─ loadInmemIndexDuringLoad        //     centroid HnswImp::loadIndex (hnswlib saveIndex 格式)
      │         ├─ loadClusterExtraDuringLoad      //     ClusterExtra: _cluster_ids.bin + _cluster_norms.bin
      │         ├─ loadClusterMapDuringLoad        //     ClusterMap: _cluster_map.bin
      │         └─ loadPruneToolDuringLoad         //     PruningToolNaive
      ├─ initSearchResourcePool()                  //   per-worker IO/distance buffer + NVMe queue 分配
      └─ initServingWorkers()                      //   ServingWorkerPool: N 个 worker 绑定 CPU core
  → ServingWorkerPool::acquireHandle() → bindToCPU()
  → 每 query: worker_handle->searchKnn(...)
```

配置来自三层，覆盖优先级为：命令行参数 > `hardware_meta.json`（EnvParam）> `path_config.json`（路径）> 代码默认值。单例在 `initForSearch` 中按依赖顺序创建：`PathConfig` → `NVMeManager` → `IndexHolder`（含 `HyperConstImp` 及其值成员 `ClusterMap`/`ClusterExtra`）→ `SearchResourcePool` → `ServingWorkerPool`。`shutdownForSearch` 严格逆序释放。

### 核心运行流程

下面三条链路覆盖了系统的主要运行模式：**HV_CONST 搜索**（在线读路径，核心）、**HV_CONST 部署**（在线写路径）、**NVMe 元数据生成**（前置一次性）。搜索与部署共享同一个 `HyperConstImp` 类，但分别走 `searchKnn` 的 7 步与 `deployIndex` 的 5 步。

![HV_CONST 搜索与部署数据流](/vibe-reading/images/articles/helmsman-internals/data-flow.svg)

#### 搜索：HV_CONST 七步搜索流水线

业务流程：query → 内存 HNSW 找 nprobe 个 centroid → SPDK 异步批量读 cluster → SIMD 内积 → Top-K 排序 → 返回。

`ServingWorker::searchKnn`（`source/runtime/worker/serving_worker.cpp`）从 `IndexHolder` 取 `HyperConstImp`，从 `SearchResourcePool` 借 per-worker buffer，然后调 `HyperConstImp::searchKnn`（`source/index/hyperconst_imp.cpp`），它把一次查询拆成七步，核心设计是**把 NVMe I/O 提交（②）与完成轮询（④）分开**，让 I/O 与 CPU 计算重叠：

1. **`findNearestClustersDuringSearch`** — 在内存 `centroid_index`（`HnswImp`）上跑 HNSW 找 nprobe 个最近 cluster_id；可选 `prune_tool->pruneScan` 减小 nprobe（在 NVMe 读之前介入，直接决定后续 I/O 量）。
2. **`launchLoadClustersFromNVMeDuringSearch`** — `ClusterMap::getClusterStripeBatch` 取 `ClusterStripe{nvme_id, lba_id}`，`NVMeManager::readSubmit` 按 NVMe 设备分 queue 批量提交 SPDK 异步读。
3. **`prepareExtrasAndRankPairsDuringSearch`** — `ClusterExtra` 取每簇 vector IDs + norms，`prepareRankPairs` 构造 `RankPair`。
4. **`pollNVMeCompletionsDuringSearch`** — `NVMeManager::pollCompletions` 轮询 qpair 完成队列，cluster 向量数据就绪。
5. **`calculateInnerProductDuringSearch`** — `compute::InnerProductInt8InBatch`（AVX2/AVX-512）对加载的 cluster 向量批量算 int8 内积。
6. **`rankFinalTopKDuringSearch`** — `SearchCPUFuncL2::rankTopK` 用 `L2 = -2·IP + q_norm + h_norm` 推 L2 距离（norms 离线预算），`partial_sort` 取 topk。
7. **返回** `vector<pair<uint64_t id, int32_t dist>>`，`multi_thread_search` 统计 recall 与延迟分位（P50/P99/P999）。

数据类型变化链：`int8 query` → `uint64 cluster_id[]` → `ClusterStripe{nvme_id, lba_id}` → SPDK 读 → `int8 cluster vecs` → `int32 IP[]` → `RankPair[]` → `pair<id, dist>[]`。

#### 部署：HV_CONST 五步部署流水线

业务流程：读 collection 元数据 → 初始化 cluster 数据 → 在 NVMe 上分配空间 → 批量刷盘 → 落盘映射表。

`minihypervec_deploy` → `OfflineWorker::deployIndex` → `HyperConstImp::deployIndex`（`source/index/hyperconst_imp.cpp`）：

1. **`loadCollectionMetaDuringDeploy`** — 读 `collection_meta.json`。
2. **`initClusterExtraDuringDeploy`** — 初始化 `ClusterExtra`（从 `_cluster_ids.bin` / `_cluster_norms.bin` 加载）。
3. **`allocateNVMeSpaceDuringDeploy`** — `NVMeAllocator::allocate` 把所有 cluster 总字节切成 64MB `Chunk` 列表，`ClusterMap::allocateChunks` 登记每个 cluster 的 `ClusterStripe`。
4. **`flushClustersToNVMeDuringDeploy`**（`flush_clusters_per_batch=256`）— `OfflineWorker` 用 write buffer 攒批，`NVMeManager::writeSubmit` 批量写 NVMe，`pollCompletions` 轮询完成。
5. **`syncIndexDuringDeploy`** — `saveClusterMap` 落盘 `_cluster_map.bin`，供后续 search 加载。

#### 一次性：NVMe 元数据生成

`config_nvme_meta`（`app/config_nvme_meta.cpp`）是 deploy 前的一次性步骤：`spdk_env_init` → `spdk_nvme_probe`（`ConfigProbeCb`/`ConfigAttachCb`/`ConfigRegisterNs` 登记 `CtrlrEntry`/`NsEntry`，记 `nvme_id`/`page_size`/`lba_num`）→ 组装 `NVMeSystemMeta` → `NVMeMetaHandler::saveNVMeSystemMetaToFile`。每当 NVMe 设备重新 bind 到 SPDK 都需重跑。

> search 与 deploy 路径分离的原因：deploy 是大块连续写（`OfflineWorker` + `DeployFlushWorkerPool`），search 是小块随机读（`ServingWorkerPool` + per-worker read buffer）；两条路径的资源画像完全不同，分离避免互相干扰。详见 [02-runtime](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/02-runtime)。

---

## 典型修改场景

#### 场景 1：新增一种 vec_type（如 float16）

需修改：`include/collection/types.hpp`（`VecType` 加 `FLOAT16`）→ `include/index/index_abs.hpp`（新增 `IndexAbs<float16_t>` 特化）→ `include/compute/distance_cal.hpp`（新增 FP16 SIMD kernel，`_mm256_cvtph_ps` + FMA）→ `include/index/hyperconst_imp.hpp`（`HyperConstImp<float16_t>` 特化）→ `include/runtime/resource/resource.hpp`（`SearchResource` 的 `io_read_buf`/`dis_addr` 类型）→ `include/compute/rank_cal.hpp`（norms 改 float）。模式清晰但改动面广，最大变化在 `distance_cal`——FP16 SIMD 语义与 int8 完全不同。对应测试：`test/multi_thread_search.cpp` 的 `vec_type_str` 解析。

#### 场景 2：新增一种 centroid 索引类型（如 IVF）

需修改：`include/collection/types.hpp`（`IndexType` 加 `IVF`）→ 新建 `include/index/ivf_imp.hpp` + `source/index/ivf_imp.cpp`（`IvfImp<int32_t> : public IndexAbs<int32_t>`）→ `source/index/hyperconst_imp.cpp` 的 `loadInmemIndexDuringLoad`（switch 加 `case IVF`）→ `source/index/param.cpp` 的 `MiniHyperVecConstBuildParam::from_json`（switch 加 `IVF` 创建 `IvfBuildParam`）。改动面小——`IndexAbs` 多态 + `centroid_index_type`/`centroid_build_param` 已预留扩展点，新索引类型只需实现接口并在两个 switch 注册。

#### 场景 3：实现真正的 LightGBM+ONNX 剪枝替换 PruningToolNaive

需修改：新建 `include/prune/prune_tool_lgbm.hpp` + `source/prune/prune_tool_lgbm.cpp`（`PruningToolLGBM<int32_t> : public PruningTool<int32_t>`，override `pruneScan`，用 LightGBM/ONNX 预测 nprobe）→ `source/index/hyperconst_imp.cpp` 的 `loadPruneToolDuringLoad`（改 `make_unique<PruningToolLGBM>` 而非 `PruningToolNaive`）。关键约束：剪枝在 `findNearestClustersDuringSearch` 中同步调用，处于查询延迟关键路径，模型推理必须微秒级（模型预加载 + ONNX CPU EP）。对应测试：`PRUNE_ON=ON` 构建后跑 `multi_thread_search` 对比 recall/延迟。

---

## 阅读源码推荐路线

- **第一遍：理解主搜索流程**
  `test/multi_thread_search.cpp` 的 `main` → `source/runtime/env/minihypervec_env.cpp` 的 `initForSearch` → `source/runtime/worker/serving_worker.cpp` 的 `searchKnn` → `source/index/hyperconst_imp.cpp` 的 `searchKnn`（七步 `*DuringSearch` 方法）。读这一遍就能回答"一次查询怎么跑完的"。
- **第二遍：理解核心数据结构**
  `include/index/hyperconst_imp.hpp` 的 `HyperConstImp`（看它持有哪四个值成员）→ `include/runtime/cluster/cluster_map.hpp` 的 `ClusterStripe`/`ClusterMap` → `include/runtime/resource/resource.hpp` 的 `MiniHyperVecConstSearchResource`（搜索时的临时 buffer 布局）→ `include/index/params.hpp` 的 `MiniHyperVecConstSearchParam`（nprobe + centroid_search_param 嵌套）。
- **第三遍：理解 NVMe I/O 路径**
  `source/nvme/nvme_controller.cpp` 的 `readSubmit`/`pollCompletions`（异步模型）→ `source/nvme/nvme_manager.cpp` 的 `readSubmit`（多设备路由）→ `source/nvme/nvme_allocator.cpp` 的 `allocate`（chunk 切分）→ `app/config_nvme_meta.cpp`（设备如何被发现并登记）。
- **第四遍：理解离线构建**
  `app/spann_build_index.cpp` 的 `main`（40 行，全流程骨架）→ `third_party/spann_aug/src/spann_index_builder.cpp` 的 `PerformFilling`/`FillingWorker`/`SearchNeighborCandidates`（Filling 算法 + 快照隔离）→ `third_party/spann_aug/src/spann_index_serializer.cpp`（输出文件格式契约）。

> 每遍聚焦一个层面，避免一次读完 30 个文件。重点文件：`hyperconst_imp.cpp`（991 行，系统心脏）、`cluster_map.cpp`（431 行）、`nvme_controller.cpp`（314 行）、`spann_index_builder.cpp`（Filling 算法）。

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| ANNS | Approximate Nearest Neighbor Search，近似最近邻搜索 |
| HV_CONST | HyperVec Const，Helmsman 的定长聚簇索引格式 |
| SPANN | SPTAG 的磁盘型聚簇索引，Helmsman 的输入格式 |
| SPDK | Storage Performance Development Kit，用户态 NVMe 驱动 |
| HNSW | Hierarchical Navigable Small World，分层可导航小世界图索引 |
| Filling | 离线算法，从邻居簇借向量补齐定长 cluster_size |
| nprobe | 搜索时探测的 cluster 数量（类似 IVF 的 nprobe） |
| cluster_size | HV_CONST 的定长簇大小（如 64），决定 NVMe 单次读大小 |
| centroid / head | 聚簇中心向量，构成内存 HNSW 头索引 |
| posting list | 一个 cluster 内的向量 ID + 向量数据 |
| LBA | Logical Block Address，NVMe 逻辑块地址 |
| qpair | SPDK NVMe I/O queue pair（提交队列 + 完成队列） |
| chunk | NVMeAllocator 的分配单元，默认 64MB / 131072 pages |

### 参考资料

- 论文：Huang et al., *The Clustering Strikes Back: Building Cost-Effective and High-Performance ANNS at Scale with Helmsman*, OSDI 2026
- [SPTAG](https://github.com/microsoft/SPTAG)（输入 SPANN 索引生成工具）
- [SPDK v22.09](https://github.com/spdk/spdk)
- [hnswlib](https://github.com/nmslib/hnswlib)（vendored）
- [oneTBB v2021.12.0](https://github.com/oneapi-src/oneTBB)
