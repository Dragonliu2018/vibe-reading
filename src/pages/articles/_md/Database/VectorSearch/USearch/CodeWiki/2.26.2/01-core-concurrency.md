---
source:
  type: "源码解读"
  project: "USearch"
  url: "https://github.com/unum-cloud/USearch"
title: "并发与锁设计"
date: "2026-09-21T15:26:32+08:00"
category: [Database, VectorSearch, USearch, CodeWiki, "2.26.2"]
contentType: "CodeWiki"
tags: ["USearch", "C++", "并发", "无锁数据结构"]
description: "USearch 并发设计深度解读——striped locks 分片锁的 Fibonacci 散列、无锁读的两个不变量、unfair_shared_mutex 锁升级、每线程 context 复用与 Python GIL 协作"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回核心图引擎](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/01-core-graph-engine)

---

## 主题定位

USearch 宣称"Thread-safe for concurrent construction, search, and updates"（`index.hpp:2240`），而它的锁开销在常见路径上**接近零**：search 是 `const` 方法、一锁不加；add 只在可能刷新入口点时短暂持全局锁。这份深读拆解它如何用"写序不变量 + 分片锁 + 每线程上下文"三件套换到无锁读，以及稠密索引层和 Python 绑定层各自补的并发拼图。内容横跨 [核心图引擎](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/01-core-graph-engine) 与 [基础设施](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/02-plugins-infra) 两个模块，是它们共用的正确性论证。

## 核心原理

### 锁层级：三级锁只在小范围内组合

| 锁 | 保护对象 | 持有时长 | 位置 |
|----|---------|---------|------|
| `global_mutex_`（std::mutex） | `entry_slot_`/`max_level_` 两个入口元数据 | 多数 add 只在选层阶段持（早释放） | `index.hpp:2558` |
| `nodes_mutexes_`（striped locks） | 节点邻接表 | 一次一个节点，**从不嵌套持两个** | `index.hpp:2571` |
| `slot_lookup_mutex_`（shared_mutex） | key→slot 查找表 | remove/rename 的整段临界区 | `index_dense.hpp:519` |

关键纪律是 add 的锁序（`index.hpp:3215-3286`）：`global_mutex_` 下做 `choose_random_level_` 与原子占坑，**若新节点层不超当前 max_level_ 立即解锁**——只有可能刷新入口的少数路径全程持有；随后逐层用 `node_lock_` 只锁正在读写邻接表的节点。从不嵌套两个 node lock 这条规则让死锁在图引擎内不可能发生。

### striped_locks_gt：与图规模无关的分片锁

`index.hpp:668` 的分片锁是并发层的核心构件。数量 = `ceil2(max(threads × connectivity × 4, 256))`（`index.hpp:716-724`）——**与图大小无关、与线程数×connectivity 成正比**，注释 `index.hpp:661-665` 明说用意：锁数组因此常驻 L2/L3 cache，加锁解锁不产生内存流量。

```cpp title="include/usearch/index.hpp:693（Fibonacci 散列）"
inline std::size_t stripe_for_(std::size_t slot) const noexcept {
    return static_cast<std::size_t>((static_cast<std::uint64_t>(slot) * fibonacci_k) >> shift_);
}
```

slot 到锁的映射用黄金分割常数 `0x9E3779B97F4A7C15` 乘法散列再右移取均匀分片——连续 slot 均匀散到不同 stripe，避免热点。每个 `padded_lock_t` `alignas(128)`（`index.hpp:676-680`）消除 false sharing；由于普通 allocator 只保证 16B 对齐，构造时超分配一块再手动对齐到 128B 边界（`index.hpp:733-753`）。锁本体是单 `std::atomic<uint8_t>` 的自旋锁，内存序配对标准：`atomic_set` 用 `exchange(1, std::memory_order_acquire)`（`index.hpp:785-786`），`atomic_reset` 用 `store(0, std::memory_order_release)`（`index.hpp:790`）；抢锁失败 `std::this_thread::yield()` 让出 CPU 后重试（`index.hpp:786-789`）。

### 无锁读的两个不变量

`search_to_find_in_base_` 完全不加节点锁（`index.hpp:4658-4659` 注释："Doesn't lock any nodes, assuming read-only simultaneous access"），正确性依赖两条：

1. **写序不变量**：`neighbors_ref_t::push_back`（`index.hpp:2461-2465`）**先写 slot 数据、再递增 count**。读者按 count 读条目：要么看到旧 count（读不到新条目），要么看到新 count（新条目已完整写入）——不会读到半写条目。这是经典的 publication-by-counter 技巧。
2. **算法容忍性**：近似搜索读到瞬时不一致的图只影响本次召回，不破坏结构——HNSW 的贪心下降本来就允许错过。

配套设计：`visits` 用 `growing_hash_set_gt`（`index.hpp:1320`）而非 bitset——注释 `index.hpp:1310-1311` 解释这是 bitset 的**稀疏替代**：一次遍历只访问几十到几百节点，而 bitset 尺寸 ∝ 索引容量（4B 条目 = 每线程 512MB）；hash-set 容量只需 2 的幂 × 实际访问数，clear 是小 memset。配套的 `hash_gt<uint64_t>` 特化（`index.hpp:1290`）是 **SplitMix64 finalizer**——注释 `index.hpp:1281-1289` 记录了教训：标准库整数 hash 是恒等映射，连续 key 在线性探测下聚成一条 run，插入吞吐塌三个数量级，加 mixing 只花 ~20ns。

### per-thread context_t：复用换零分配

`context_t`（`index.hpp:2487`）打包搜索全部暂存——双堆（`top_candidates`/`top_for_refine`/`next_candidates`）、`visits` 哈希集、`level_generator` 随机引擎、以及 `computed_distances` 系统计数（含 `computed_distances_in_refines`/`computed_distances_in_reverse_refines` 两个 refine 专项）。`measure`/`measure_batch`（`index.hpp:2500-2535`）在调 metric 算距离的**同时递增 `computed_distances`**——统计随线程上下文天然无竞争地累计，add/search 进出函数取差值归一（`index.hpp:3255-3258`）。整个结构 `usearch_align_m` 对齐，避免相邻线程上下文伪共享。`try_reserve`（`index.hpp:2914`）按 `limits.threads()` 预分配 `contexts_`，每次 search/add 只 `clear()` 不释放。收益链：热路径零堆分配 → `search_result_t`（`index.hpp:2993`）直接**引用** context 里的 top 数组（`top_` 裸指针 2995），结果不拷贝——代价写在文档里（`index.hpp:3420`）："Valid until next search()/add()/cluster()"，同一上下一次查询的结果被下一次覆写。稠密层为此把 `thread_lock_t` 存进 `search_result_t`（`index_dense.hpp:571-581`）——用户还在迭代结果时，线程槽不会被其他线程的 search 抢走覆写。

## 实现细节

### update 的 try-lock-skip：防死锁的"够用"方案

更新风暴下被连接节点互相等待是 HNSW 实现的经典死锁源。`search_to_update_`（`index.hpp:4568`）用 `node_try_conditional_lock_`（`index.hpp:4284`）try-lock，抢不到就跳过该节点继续。`index.hpp:4612-4615` 注释直白："The trickiest part of update-heavy workloads is mitigating dead-locks... A 'good enough' solution would be to skip concurrent access"——跳过的边赌对方稍后在 `form_reverse_links_` 补回来。

### unfair_shared_mutex_t：读偏置 + 锁升级

`index_plugins.hpp:1802` 的单 int32 原子读写锁服务稠密层的 `slot_lookup_`（C++17 缺席时的替代，`index_dense.hpp:489-495` 条件选用）。状态编码：`idle_k=0`、正数=读者数、`writing_k=-1`。`lock_shared`（`index_plugins.hpp:1823`）遇写者 yield 自旋，否则 CAS +1——**读偏置**：写者要等 state 归零，理论上可能饥饿（注释自陈 "not fair"）。独特点是 **try_escalate**（`index_plugins.hpp:1844`）：唯一读者时 CAS 1→-1 原子升级为写锁，失败则自旋 `escalate()` 或降级重锁的 `unsafe_escalate()`，配套 `de_escalate()` 回读锁——为"读着读着发现要写"的查找表操作量身定做。

### 稠密层的锁拼图

稠密索引加了自己的一层并发结构：`slot_lookup_` 用 shared_mutex（读多写少）；`free_keys_` 与 `available_threads_` 各配普通 mutex；**cast 完全无锁**——`cast_buffer_` 按 `threads × bytes_per_vector` 切片，每线程独占自己的槽（`index_dense.hpp:2178-2182`），并发 add/search 互不干扰。删除临界区（`remove()` in `index_dense.hpp:1641`）持 `slot_lookup_mutex_` 与 `free_keys_mutex_`，但**不动图**——图上的 free_key 标记是单字段写。

### Python 绑定层：GIL 与 per-index mutex 的锁序

pybind11 层为每次重操作补一把 per-index mutex（`python/lib.cpp:89`），原因在 `python/lib.cpp:79-84` 的原注释：原生 `index_dense_t` 假定单一拥有线程——`cast_buffer_` 槽位由 executor-local `thread_idx` 定位，多个 Python 线程对同一索引做重操作会撞槽。锁序纪律：**先释放 GIL、再拿 mutex**——`merge_paths` 的注释（`python/lib.cpp:109-112`）解释了反例的死锁：等锁线程若攥着 GIL，持锁方的 worker 线程在 progress 回调里 `gil_scoped_acquire` 时会永久阻塞。用 `unique_ptr` 持有 mutex 是因为 `std::mutex` 不可移动，而 pybind11 按值返回的工厂要求 wrapper 可移动构造。

线程分工：`executor_stl_t::dynamic`（`index_plugins.hpp:1416`）静态切分任务区间，**spawn 的 worker 数是 threads_count − 1**（`buffer_gt<jthread_t> threads_pool(threads_count_ - 1)`，`index_plugins.hpp:1418`——主线程亲自跑第 0 段，省一次 spawn）；共享 `atomic_bool stop` 支持提前终止（"dynamic" 指任务可中止而非 work-stealing）；构造参数为 0 时默认 `std::thread::hardware_concurrency()`。只有 `thread_idx == 0`（调用线程）会 acquire GIL 做 `PyErr_CheckSignals` 与进度回调（`python/lib.cpp:227-235`，注释："We don't want to check signals from multiple threads"）；错误经 `atomic<char const*>` 跨线程汇集、主线程单点抛 Python 异常。

## 性能与权衡

- **读路径零锁**的代价是 update 悬边与删除只能惰性标记——写弱化为"可容忍的近似"换取读的完全并发。
- **自旋锁**（striped locks）在临界区极短（邻接表读写）时优于系统锁，但过度订阅（线程数远超核数）时自旋浪费 CPU——这也是 Python 层默认 `hardware_concurrency()` 线程的原因。
- **per-thread context** 用内存换延迟：`contexts_` 尺寸 ∝ 线程数 ×（双堆 + visits 表），4 线程时 ~几十 KB，但换来热路径零 malloc。
- **与 FAISS 的对比立场**：FAISS 靠 OpenMP 粗粒度并行，USearch 把并行做到"每线程独享搜索状态"的细粒度，同一索引可同时被 add 和 search（文档 `index.hpp:2553`："If any thread is updating those values, no other threads can `add()` or `search()`"——仅指入口元数据更新瞬间）。
