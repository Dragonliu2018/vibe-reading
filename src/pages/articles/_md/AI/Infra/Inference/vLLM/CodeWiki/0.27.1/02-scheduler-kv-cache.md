---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "调度器与 KV Cache"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "PagedAttention", "调度器", "KV Cache", "Prefix Caching", "Chunked Prefill"]
description: "解读 vLLM 调度器与 KV Cache 管理模块：PagedAttention 分页 KV、连续批处理、链式 hash prefix cache、chunked prefill 混批与分层 cache manager。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

调度器与 KV Cache 模块（`vllm/v1/core/`）是 vLLM 性能的心脏。它回答两个问题：**每一步该跑哪些请求、各分多少 token**（`Scheduler`），以及 **KV cache 这块有限显存该怎么分页、怎么复用**（`KVCacheManager` 分层体系）。PagedAttention 把 KV cache 从"每请求连续预留"变成"按固定大小 block 按需分配"，用 `block_table` 记录逻辑顺序——类比操作系统的虚拟内存分页。连续批处理则取消 prefill/decode 阶段划分，让每步 GPU 都打满。

## 模块架构

![调度器与 KV Cache 分层管理](/vibe-reading/images/articles/vllm/02-scheduler-kv-cache.svg)

模块自顶向下分四层：`Scheduler` 持有 `KVCacheManager`；`KVCacheManager` 持有 `KVCacheCoordinator`（抽象基类，有 `NoPrefixCache`/`Unitary`/`Hybrid` 三子类）；`Coordinator` 持有一组 `SingleTypeKVCacheManager`（每种 attention 类型一个：`FullAttentionManager`、`SlidingWindowManager`、`MambaManager` 等）；所有 manager **共享同一个 `BlockPool`**（物理 block 分配/LRU 淘汰/hash 缓存）。分层是为了让不同 attention 类型的不同 hit 语义（全注意力线性扫描、滑动窗口从右向左、Mamba 只需末状态）能在统一接口下各司其职，而物理 block 只有一份。

## 调用链路

从 `Scheduler.schedule()` 出发的一次调度：

```
Scheduler.schedule()                                # scheduler.py:439
├─ kv_cache_manager.new_step_starts()              # 各 manager 清状态
├─ [Phase 1] 调度 RUNNING 请求
│  └─ kv_cache_manager.allocate_slots(request, num_new_tokens)
│     ├─ coordinator.remove_skipped_blocks()        # 释放滑动窗口已滑出 block
│     ├─ coordinator.get_num_blocks_to_allocate()   # 算需要多少 block
│     ├─ coordinator.allocate_new_computed_blocks() # prefix cache 命中 touch
│     │   ├─ Phase 1: add_local_computed_blocks() → touch 命中 block
│     │   └─ Phase 2: allocate_external_computed_blocks()
│     ├─ coordinator.allocate_new_blocks()          # 分配新 block
│     └─ coordinator.cache_blocks()                 # full block 写入 hash cache
├─ [Phase 2] 调度 WAITING 请求
│  ├─ kv_cache_manager.get_computed_blocks(request) # prefix cache 查找
│  │   └─ coordinator.find_longest_cache_hit()     # 最长命中
│  └─ kv_cache_manager.allocate_slots(...)          # 同上
├─ take_new_block_ids() / take_kv_cache_block_copies() / take_partial_tail_offloads()
└─ return SchedulerOutput
```

数据流：`Request`（含 `num_computed_tokens`、`block_hashes`）→ `SchedulerOutput`（含 `scheduled_new_reqs`、`num_scheduled_tokens`、`new_block_ids_to_zero`、`kv_cache_block_copies`）→ 交给 Worker 的 `BlockTable` 落实到 GPU。`SchedulerOutput` 是调度器与执行层的唯一数据契约。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Scheduler.schedule` | 产出一步的 SchedulerOutput | RUNNING 优先，token 预算共享 |
| `Scheduler.update_from_output` | 消费 ModelRunnerOutput，更新请求状态 | 产出 EngineCoreOutputs |
| `Scheduler._preempt_request` | 释放 RUNNING 请求的 block 降回 WAITING | recompute 模式 |
| `KVCacheManager.get_computed_blocks` | prefix cache 命中查找 | 返回命中的 block 与命中长度 |
| `KVCacheManager.allocate_slots` | 为请求分配 KV slot | 两阶段：先 touch 再分配外部 |
| `KVCacheCoordinator.find_longest_cache_hit` | 抽象：最长命中查找 | Hybrid 用不动点迭代 |
| `BlockPool.get_new_blocks` | 从 LRU 队列头弹 block | ref_cnt +1 |
| `BlockPool.cache_full_blocks` | full block 写 hash 缓存 | 链式 hash |

</details>

## 核心实现

### PagedAttention 的 block 分页

传统做法给每个请求预留连续 KV cache，长度不一导致碎片化与浪费。vLLM 把 KV cache 分成固定大小 block（如 16 token/block），请求按需分配，`block_table` 记录逻辑顺序。`block_size` 的选择有讲究：`resolve_kv_cache_block_sizes`（`kv_cache_utils.py:626`）取所有 group block size 的 LCM 作调度对齐粒度，GCD 作 hash 计算粒度。`null_block`（`block_pool.py:190`，block_id=0）是永不释放的占位 block，用于滑动窗口已滑出的位置——block_table 对应位置填 null_block，attention kernel 跳过。

### Prefix Caching 的链式 BlockHash

命中率的核心是**链式哈希**：每个 block 的 hash = `hash(parent_block_hash, curr_block_token_ids, extra_keys)`（`hash_block_tokens` in `kv_cache_utils.py:596`）。因为父 hash 包含了前序所有 block 的信息，相同前缀的请求会产生相同的 block hash，从而命中缓存。首个 block 的父 hash 是随机 `NONE_HASH`（`kv_cache_utils.py:95`）避免碰撞。extra_keys 含多模态 feature、LoRA name、cache_salt 等。

命中查找因 attention 类型而异：`FullAttentionManager` 从左到右线性扫描最长连续命中；`SlidingWindowManager` 从右到左搜（窗口外的不需要）；`MambaManager` 找最后一个命中即可（SSM 只需末状态）。当 `hash_block_size < block_size` 时支持**部分命中**（fine-grained hash lookup），避免只能命中整 block。

### Chunked Prefill 与 Decode 的混批

调度器的核心理念（`scheduler.py:439` 注释）："没有所谓的 decoding phase 或 prefill phase"。每个请求只有 `num_computed_tokens` 与 `num_tokens_with_spec`，调度器每步给请求分配 token 预算使其前者追上后者。策略：先调度 RUNNING（decode 优先，避免延迟）再调度 WAITING，两者共享 `max_num_scheduled_tokens` 预算；当 `num_new_tokens > token_budget` 时切分 prefill；`max_num_running_reqs` 限并发；Mamba 的 SSM 状态只在 block 边界可缓存，故 chunk end 必须对齐 block 边界（`_mamba_block_aligned_split` in `scheduler.py:362`）。

### KV Cache Manager 的分层与两阶段分配

分层理由：`Coordinator` 统管多 group 协调（hybrid 模型用不动点迭代调和各 group 的 hit length，`kv_cache_coordinator.py:686`），`SingleTypeManager` 各管一种 attention 的 block 逻辑，`BlockPool` 独占物理 block。两阶段分配（`allocate_new_computed_blocks` in `kv_cache_coordinator.py:219`）先 touch 所有 group 的本地命中 block，再分配外部 block——这避免"A group 的 get_new_blocks 淘汰了 B group 尚未 touch 的命中 block"（issue #33775）。部分命中时用 **Copy-on-Write**（`_partial_hit_reqs` in `single_type_kv_cache_manager.py:116`）：共享的 tail block 要被多请求写入，就分配新 block 并排队 `_pending_cow_copies`，Worker 在 forward 前执行 memcpy。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 对象池 | `BlockPool` in `block_pool.py:143` | 预分配 block，运行时零分配 |
| 策略 | `SingleTypeKVCacheManager` 子类 | 各 attention 类型独立 hit 查找策略 |
| 模板方法 | `cache_blocks`/`get_num_blocks_to_allocate` in `SingleTypeKVCacheManager` | 通用流程 + 钩子定制 |
| 工厂 | `get_kv_cache_coordinator` in `kv_cache_coordinator.py:851` | 按 group 数与 caching 选 Coordinator 子类 |
| 注册表 | `KVCacheSpecRegistry` (`register_all_kvcache_specs` L1881) | spec → manager 映射，支持扩展 |
| 责任链/迭代收敛 | `HybridKVCacheCoordinator.find_longest_cache_hit` L686 | 各 group 依次缩减 hit_length 至收敛 |
| Copy-on-Write | `_apply_cow` in `single_type_kv_cache_manager.py:405` | 共享 tail block 的安全写入 |

## 模块间交互

被 `v1/engine` 的 `EngineCore.step` 调用（`schedule()` + `update_from_output()`）。产出 `SchedulerOutput` 交给 `v1/worker` 的 `BlockTable`（`vllm/v1/worker/gpu/block_table.py:48`）：worker 把 `block_id` 经 `map_to_kernel_blocks()`（L222）映射为 kernel-level block ID，写入 GPU 的 `block_table` buffer 供 attention kernel 查找。`KVCacheManager` 管逻辑 block（`KVCacheBlock` 对象），worker 的 `BlockTable` 管物理映射，两者通过 `SchedulerOutput` 的 `block_ids` 衔接。`Scheduler` 还持有 `KVConnectorBase_V1`（P/D transfer 的跨节点 KV 传输），用 `delay_cache_blocks=True` 延迟缓存。

## 扩展方式

新增调度策略：在 `vllm/v1/core/sched/request_queue.py` 的 `SchedulingPolicy` 枚举加成员，继承 `RequestQueue` 实现，在 `create_request_queue()` 加分支。新增 KV cache 类型：定义 `KVCacheSpec` 子类，继承 `SingleTypeKVCacheManager` 实现 `find_longest_cache_hit`/`get_num_skipped_tokens`，通过 `KVCacheSpecRegistry.register()` 注册（`single_type_kv_cache_manager.py:1881`），并在 `kv_cache_utils.py` 的 `get_kv_cache_groups()` 加分组逻辑。修改 prefix cache hash 算法：改 `hash_block_tokens`（`kv_cache_utils.py:596`）。
