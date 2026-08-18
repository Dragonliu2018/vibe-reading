---
source:
  type: "源码解读"
  project: "Helmsman"
  url: "https://github.com/Red-EAD/helmsman"
title: "运行时层"
date: "2026-08-18T21:08:07+08:00"
category: ["AI", "Infra", "Retrieval", "Helmsman", "CodeWiki", "1.0"]
tags: ["Helmsman", "MiniHyperVec", "Runtime", "WorkerPool", "ResourcePool", "ClusterMap"]
description: "Helmsman 运行时层：MiniHyperVecEnv 生命周期、ServingWorkerPool/OfflineWorker、per-worker 无锁资源池、ClusterMap 聚簇映射。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/00-overview)

---

## 模块定位

运行时层是 Helmsman 的"调度操作系统"——它不关心检索算法（索引层的事）也不关心 NVMe 协议（NVMe 层的事），只关心：系统怎么启动/关闭、搜索/部署线程怎么并发、每个线程的 I/O 与计算 buffer 怎么分配、cluster_id 到 NVMe 物理位置的映射怎么维护。它把"并发与资源管理"从算法中剥离，让 `HyperConstImp` 能专注七步流水线而无需操心锁与内存分配。

核心组件：`MiniHyperVecEnv`（生命周期单例）、`IndexHolder`（索引持有）、`ServingWorkerPool`/`OfflineWorker`（搜索/部署线程）、`SearchResourcePoolLockFree`（per-worker buffer 池）、`ClusterMap`（cluster→NVMe 条带）、`ClusterExtra`（cluster IDs+norms）。

> **重要**：`ClusterMap` 与 `ClusterExtra` 虽在 `source/runtime/cluster/` 目录下，但它们是 `HyperConstImp` 的**值成员**（非单例、非 `getInstance()`）——逻辑上服务于索引检索。本模块讲它们的内部实现，索引层讲它们的消费方式。

---

## 模块架构

```text
MiniHyperVecEnv (单例, source/runtime/env/minihypervec_env.cpp)
 ├─ g_env_param: MiniHyperVecEnvParam        // worker 数/CPU/buffer 大小
 ├─ initForSearch / initForDeploy / shutdown* // 生命周期
 │     ├─ PathConfig::getInstance()           //   (基础设施层)
 │     ├─ NVMeManager::getInstance()          //   (NVMe 层)
 │     ├─ IndexHolder::getInstance()          //   持有 shared_ptr<IndexAbs>
 │     ├─ SearchResourcePoolLockFree::getInstance()
 │     └─ ServingWorkerPool::getInstance() / OfflineWorker::getInstance()
 │
ServingWorkerPool (单例)                      OfflineWorker (单例)
 ├─ workers_: vector<unique_ptr<ServingWorker>>  ├─ write_buffer (SPDK DMA)
 ├─ free_idx_ + mutex + cv_   (对象池)           ├─ parallel_degree 个 NVMe queue
 └─ WorkerHandle (RAII, acquire/release)         └─ deployIndex → HyperConstImp::deployIndex
      └─ ServingWorker.searchKnn
           ├─ IndexHolder::getIndex
           └─ SearchResourcePoolLockFree::getSearchResource

ClusterMap (HyperConstImp 值成员)              ClusterExtra<int32_t> (HyperConstImp 值成员)
 ├─ m_map_impl: vector<ClusterStripe>           ├─ m_cluster_ids: vector<uint64_t>
 ├─ m_free_by_dev_: dev→LBA 列表                ├─ m_cluster_norms: vector<int32_t>
 ├─ m_rr_devices_ + m_rr_index_ (round-robin)   └─ m_present: vector<uint8_t>
 └─ tbb::spin_rw_mutex                          └─ std::atomic<uint64_t> m_cluster_cnt
```

---

## 调用链路

两条核心链路——搜索初始化与搜索执行——展示运行时层如何装配与运转：

```text
initForSearch(collection_name)                     // minihypervec_env.cpp:298-332
  ├─ initPathConfig()       → PathConfig 加载 path_config.json
  ├─ loadEnvParam()         → g_env_param (worker 数/CPU IDs/buffer 大小)
  ├─ initNVMe()             → NVMeManager 全套初始化
  ├─ initIndexHolder()      → HyperConstImp::loadIndex (5 个 *DuringLoad)
  ├─ initSearchResourcePool() → 每 worker 分配 IO/distance buffer + NVMe queue
  └─ initServingWorkers()   → ServingWorkerPool::init(N, cpu_ids)

ServingWorker::searchKnn(collection, query, param, res)   // serving_worker.cpp:84-107
  ├─ IndexHolder::getIndex(collection, index_ptr)          // 取 HyperConstImp
  ├─ getSearchResourceInfo(index_ptr, param, &resource)    // 算 buffer 需求 + 借 buffer
  │    └─ SearchResourcePoolLockFree::getSearchResource(worker_id, config, resource)
  └─ index_ptr->searchKnn(param, query, res, resource)     // → 索引层七步流水线
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MiniHyperVecEnv::initForSearch` | 搜索路径初始化 | 与 deploy 分离，资源画像不同 |
| `MiniHyperVecEnv::initForDeploy` | 部署路径初始化 | 初始化 OfflineWorker 而非 ServingWorker |
| `ServingWorkerPool::acquire` | 借一个空闲 worker | mutex + cv 阻塞等待 |
| `ServingWorkerPool::acquireHandle` | RAII 借 worker | `WorkerHandle` 析构自动 release |
| `ServingWorker::bindToCPU` | 绑核 | `pthread_setaffinity_np` |
| `SearchResourcePoolLockFree::getSearchResource` | 借 per-worker buffer | 无锁，worker_id 索引 |
| `ClusterMap::getClusterStripeBatch` | cluster_id→物理位置 | `spin_rw_mutex` 读锁 |
| `ClusterMap::allocateChunks` | deploy 时登记条带 | round-robin 跨设备 |
| `OfflineWorker::deployIndex` | 部署入口 | → `HyperConstImp::deployIndex` |

</details>

---

## 核心实现

### MiniHyperVecEnv：生命周期与对象装配

`MiniHyperVecEnv` 是 Meyer 单例，用 `initForSearch`/`initForDeploy` 分离两条路径：

```cpp title="include/runtime/env/minihypervec_env.hpp"
class MiniHyperVecEnv
{
public:
    MiniHyperVecEnvParam g_env_param;
    static MiniHyperVecEnv *getInstance();
    int32_t initForDeploy();
    int32_t initForSearch(const std::string &collection_name);
    int32_t shutdownForDeploy();
    int32_t shutdownForSearch();
    // ...
};
```

**为什么 deploy/search 分离**：两阶段共享前置（`initPathConfig`→`loadEnvParam`→`initNVMe`），但后续资源截然不同——deploy 需 `OfflineWorker`（大块连续写 buffer + parallel_degree 个 queue），search 需 `ServingWorkerPool`（per-worker 小块随机读 buffer + 绑核长服务）。分离避免资源互相干扰（deploy 的大块写 vs search 的小块读）。`shutdown` 严格逆序释放（先关 worker 再关资源池再关 NVMe）。

`MiniHyperVecEnvParam`（`hpp:20-31`）从 `hardware_meta.json` 加载：`serving_worker_cnt`、`serving_worker_core_ids`（绑核列表）、`io_buf_bytes_per_worker`、`dis_buf_bytes_per_worker`——这些是 per-worker buffer 大小的配置源。

### ServingWorkerPool：对象池 + RAII Handle

搜索线程通过对象池复用，`WorkerHandle` 保证 RAII 释放：

```cpp title="include/runtime/worker/serving_worker.hpp"
class ServingWorkerPool
{
public:
    static ServingWorkerPool *getInstance();
    int32_t init(uint32_t worker_cnt, const std::vector<int32_t> &cpu_ids);
    ServingWorker *acquire();
    void release(ServingWorker *worker);
    // RAII handle —— 析构自动 release
    class WorkerHandle
    {
    public:
        WorkerHandle(ServingWorkerPool &pool, ServingWorker *w);
        ~WorkerHandle() { reset(); }            // 析构 → pool_->release(w_)
        ServingWorker *operator->() const { return w_; }
        // move-only，不可拷贝
    };
    WorkerHandle acquireHandle() { return WorkerHandle(*this, acquire()); }
private:
    std::vector<std::unique_ptr<ServingWorker>> workers_;
    std::queue<size_t> free_idx_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
};
```

**为什么用 RAII Handle 而非裸指针**：`multi_thread_search` 的每个 `std::thread` 在 `worker_fn` 里 `acquireHandle()`（`test/multi_thread_search.cpp:343-345`），`WorkerHandle` 是 move-only 局部变量——线程函数返回时析构自动 `release`，即使中途异常也不会泄漏 worker。`acquire` 用 `mutex + cv_.wait` 阻塞等空闲 worker（`serving_worker.cpp:162-172`），池满时自动背压。

`ServingWorker::bindToCPU`（`serving_worker.cpp:16-29`）用 `pthread_setaffinity_np` 绑定到 `m_running_core_id`——绑核让 per-worker 的 NVMe queue 与 buffer 都在本地 cache，减少跨核迁移。

### SearchResourcePoolLockFree：per-worker 无锁 buffer

每个 worker 预分配固定的 I/O 读 buffer 与距离计算 buffer，搜索时无锁借出：

```cpp title="include/runtime/resource/search_rsrcpool.hpp"
class SearchResourcePoolLockFree
{
public:
    uint64_t io_buf_bytes_per_worker = 0;
    std::vector<char *> worker_io_bufs;       // 每 worker 一个 SPDK DMA 读 buffer
    std::vector<char *> worker_dis_bufs;      // 每 worker 一个距离计算 buffer
    nvme::NVMeManager *g_nvme_manager{nullptr};
    std::vector<std::vector<std::vector<uint64_t>>> worker_dev_que_ids;  // worker→dev→queue
    int32_t getSearchResource(uint32_t worker_id, const SearchResourceConfig &config,
                              SearchTempResource *search_resource);
};
```

**为什么 per-worker 而非全局分配**：① 无锁——`worker_id` 直接索引自己的 buffer，无需争抢全局锁；② cache 局部性——buffer 与 worker 绑同一核；③ 避免搜索时动态分配——热路径无 `malloc`。`getSearchResource`（`search_rsrcpool.cpp:74-121`）把 worker 的 `io_read_buf`/`dis_addr`/`dev_que_id` 绑定到 `SearchTempResource`，并校验 buffer 够大（`io_buf_bytes_per_worker >= config.io_buf_bytes_required`，即 `cluster_nprobe * cluster_size * dim`）。

`worker_dev_que_ids[worker_id][nvme_id]` 给每个 worker 在每个 NVMe 设备上分了独立 queue（`search_rsrcpool.cpp:42-49`）——多 worker 并发读同一设备时不争抢 qpair。

### ClusterMap：cluster_id → NVMe 条带

`ClusterMap` 维护 cluster 到 NVMe 物理位置（`ClusterStripe{nvme_id, lba_id}`）的映射：

```cpp title="include/runtime/cluster/cluster_map.hpp"
#pragma pack(4)
struct ClusterStripe
{
    uint32_t nvme_id_;      // 哪块 NVMe
    uint64_t lba_id_;       // 起始逻辑块
};
#pragma pack()

class ClusterMap
{
public:
    tbb::spin_rw_mutex m_inside_rw_mutex;     // 读写锁
    std::vector<ClusterStripe> m_map_impl;    // cluster_id → stripe
    std::unordered_map<uint32_t, std::vector<uint64_t>> m_free_by_dev_;  // 每设备空闲 LBA 栈
    std::vector<uint32_t> m_rr_devices_;      // round-robin 设备列表
    uint64_t m_rr_index_dev_ = 0;
    // 批量读（search）/批量写（deploy）
    int32_t getClusterStripeBatch(const std::vector<uint64_t> &cluster_id,
                                  std::vector<ClusterStripe> &pos, bool lock_inside = false);
    int32_t putClusterStripeBatch(...);
};
```

**为什么用 `tbb::spin_rw_mutex` 且支持 `lock_inside=false`**：search 读路径（`getClusterStripeBatch`）高频调用，读读不互斥的 rw 锁比普通 mutex 并发度高；`lock_inside=false` 允许调用方在已持锁时免重入。deploy 写路径（`putClusterStripeBatch`，`cluster_map.cpp:337-398`）才加写锁。`ClusterStripe` 用 `#pragma pack(4)` 紧凑布局（8 字节），对齐 cache line，批量读时减少内存带宽浪费。

**条带分配策略**：deploy 时 `allocateChunks`（`cluster_map.cpp:148-174`）把 `NVMeAllocator` 产出的 `Chunk` 切成 `ClusterStripe` 填入 `m_free_by_dev_`，`pop_one_stripe_rr`（`:102-130`）按 `m_rr_index_dev_` 游标 round-robin 跨设备分配——均衡磨损与负载。`saveClusterMap`/`loadClusterMap` 持久化到 `_cluster_map.bin`（magic `'CMAP'` + header + 条带表 + 空闲区 + 设备列表）。

### ClusterExtra：cluster IDs + norms

```cpp title="include/runtime/cluster/cluster_extra.hpp"
template <>
class ClusterExtra<int32_t>
{
public:
    std::vector<uint64_t> m_cluster_ids;      // 定长存储：cluster_id*cluster_size + offset
    std::vector<int32_t> m_cluster_norms;     // 对应向量的 L2 norm²（离线预算）
    uint64_t m_cluster_size;                  // 定长簇大小
    std::atomic<uint64_t> m_cluster_cnt;
    int32_t getClusterIDsNormsBatch(const std::vector<uint64_t> &cluster_ids,
                                    std::vector<uint64_t> &list_ids,
                                    std::vector<int32_t> &list_norms);
};
```

`getClusterIDsNormsBatch`（`cluster_extra.cpp:274-322`）按 `cluster_id * cluster_size` 偏移从定长数组拷贝——定长布局让批量取 IDs+norms 退化成连续内存拷贝，无 per-cluster 长度查找。norms 是 `SpannIndex::performNorms` 离线预算的，供 `rank_cal` 的 `L2 = q_norm + h_norm - 2·IP` 使用。

### OfflineWorker：部署写路径

`OfflineWorker` 是单例，封装部署所需资源（写 buffer + 并行 queue）：

```cpp title="include/runtime/worker/offline_worker.hpp"
class OfflineWorker
{
public:
    static OfflineWorker *getInstance();
    char *write_buffer{nullptr};
    uint64_t max_write_bytes_once{0};
    nvme::NVMeManager *nvme_manager{nullptr};
    uint32_t parallel_degree{1};
    std::vector<std::vector<uint64_t>> dev_que_id;
    int32_t init(uint64_t max_buf_size, uint32_t parallel_degree_ = 1);
    int32_t deployIndex(const std::string &collection_name);
};
```

`init`（`offline_worker.cpp:13-45`）用 `NVMeManager::mallocNVMeHostBuf` 分配 SPDK DMA 写 buffer（2MB 对齐），每设备分 `parallel_degree` 个 queue。`deployIndex` 构造 `HyperConstImp` 并调其 `deployIndex`——实际的五步部署（含 `DeployFlushWorkerPool` 多线程刷盘）在 `hyperconst_imp.cpp:245-458` 实现。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例（Meyer's） | `MiniHyperVecEnv`/`IndexHolder`/`ServingWorkerPool`/`OfflineWorker`/`SearchResourcePoolLockFree` | 全局唯一资源管理器，`getInstance()` 简化跨模块访问 |
| 对象池 + RAII | `ServingWorkerPool` + `WorkerHandle`（`serving_worker.hpp`） | worker 复用 + 析构自动 release，避免泄漏 |
| 无锁资源池 | `SearchResourcePoolLockFree` per-worker buffer（`search_rsrcpool.hpp`） | `worker_id` 索引免锁，热路径无 malloc |
| 读写锁 | `ClusterMap::tbb::spin_rw_mutex`（`cluster_map.hpp`） | 读读不互斥，适配 search 高频读 / deploy 低频写 |
| 生命周期分离 | `initForSearch`/`initForDeploy`（`minihypervec_env.cpp`） | 两条路径资源画像不同，分离避免干扰 |

---

## 模块间交互

- **向上（被入口调用）**：`test/multi_thread_search` 与 `test/minihypervec_deploy` 的 `main` 直接调 `MiniHyperVecEnv::getInstance()->initForSearch/initForDeploy`。
- **向下（依赖索引层）**：`IndexHolder` 持有 `shared_ptr<IndexAbs<int32_t>>`（即 `HyperConstImp`）；`ServingWorker::searchKnn` 取出后转调索引层七步流水线；`OfflineWorker::deployIndex` 转调 `HyperConstImp::deployIndex`。
- **向下（依赖 NVMe 层）**：`SearchResourcePoolLockFree` 持 `g_nvme_manager` 指针，`initHostRsrc` 用 `spdk_zmalloc` 分配 DMA buffer，每 worker 分 NVMe queue；`OfflineWorker` 同理。
- **被索引层回向持有**：`ClusterMap`/`ClusterExtra` 是 `HyperConstImp` 的值成员——运行时层定义它们，索引层拥有并消费它们。

> 无循环依赖。`Env → IndexHolder → HyperConstImp → (持有) ClusterMap` 是单向链。

---

## 扩展方式

- **调 serving worker 数/CPU 绑核**：改 `hardware_meta.json` 的 `serving_worker_cnt` + `serving_worker_core_ids`（`minihypervec_env.cpp:216-226`）。注意 `worker_cnt` 必须等于 `core_ids.size()`，否则 `ServingWorkerPool::init` 返回 -1。
- **调 per-worker buffer 大小**：改 `io_buf_bytes_per_worker`/`dis_buf_bytes_per_worker`。调大 `cluster_nprobe` 或 `cluster_size` 时必须同步调大 `io_buf_bytes_per_worker`（`search_rsrcpool.cpp:84` 校验）。
- **改 ClusterMap 条带策略**：替换 `pop_one_stripe_rr`（`cluster_map.cpp:102-130`）的 round-robin 为按容量/负载加权，需同步改 `saveClusterMap`/`loadClusterMap` 的文件格式。
