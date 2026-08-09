---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Memory Cache"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "mem_cache", "RadixAttention", "radix tree", "KV cache", "HiRadixCache"]
description: "SGLang 缓存层：RadixCache radix tree 前缀共享、MemoryPool 三层架构、HiRadixCache 三层分层缓存与 7 种 evict 策略。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.17/00-overview)

---

## 模块定位

mem_cache 是 RadixAttention 的实现所在，SGLang 的招牌特性。它解决一个核心问题：多请求共享 system prompt / few-shot / 多轮前缀时，如何让 KV 不重复计算、不重复存储。答案是用 radix tree 自动发现任意长度公共前缀并共享一份 KV。这里同时管 KV 的物理显存（连续 per-layer 张量）与逻辑前缀树（slot 索引），二者分离是关键设计。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-internals/mem-cache-architecture.svg)

模块分四块。**三层 MemoryPool**（`memory_pool.py` 文件头注释定义）：① `ReqToTokenPool`（`:256`）把 request 映射到其 token 位置（`req_to_token` 张量，slot 0 保留给 cuda-graph 哑写入）；② `TokenToKVPoolAllocator`（`allocator/`）管理 KV slot 索引空间，无数据拷贝；③ `KVCache`（`:1609` ABC）持有物理 KV 张量，`MHATokenToKVPool`（`:1740`，NHD/HND 布局）、`MLATokenToKVPool`（`:3910`，DeepSeek 压缩）、以及 FP4/MXFP8/PageMajor/DSA/MiniMaxSparse 变体。

**RadixCache**（`radix_cache.py:279`）是逻辑前缀树。`TreeNode`（`:216`）有 `children`(dict)/`parent`/`key`(`RadixKey`)/`value`(GPU slot 索引张量)/`lock_ref`(引用计数)/`last_access_time`/`hit_count`/`host_value`(L2 索引)/`hash_value`(SHA256)。`RadixKey.match`（`:59`）用指数搜索+二分查找前缀匹配长度，避免逐 token Python 循环。`RadixCache` 提供 `match_prefix`/`insert`/`evict`/`inc_lock_ref`/`dec_lock_ref`，`_split_node` 在匹配边界分裂节点使共享前缀成可复用单元。evict 只从 `evictable_leaves`（`lock_ref==0` 且子节点已 evict 的叶）中进行，确保正在用的节点不被驱逐。

**变体**：`HiRadixCache`（`hiradix_cache.py`）继承 RadixCache 加三层 L1(GPU)→L2(Host pinned)→L3(Storage)，被 evict 不丢数据而是 backup 到 host，`write_through_selective`（默认）只备份 hit_count≥2 热点；`UnifiedRadixCache`（`unified_radix_cache.py`）组件化，按 `ComponentType`(FULL/SWA/MAMBA) 组合多个 TreeComponent，`TreeCore` 统一管 evictable leaves/LRU/sizes，适合混合模型。**`registry.py`** 工厂注册，`default_radix_cache_factory` 选择链（ChunkCache→RadixCacheCpp→Unified→HiRadix→…→RadixCache），第三方可 `register_radix_cache_backend` 扩展。`KVCacheConfigurator`（`kv_cache_configurator.py`）探测显存、算池大小、初始化。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-internals/mem-cache-call-chain.svg)

追踪一次 prefill 请求的缓存命中/插入链路。① **前缀匹配**：`req.init_next_round_input(tree_cache)` → `tree_cache.match_prefix(MatchPrefixParams(key=RadixKey(token_ids, extra_key)))`（`radix_cache.py`）→ `_match_prefix_helper` 遍历 children 按 `child_key` 查、`child.key.match` 算匹配长度、`_split_node` 分裂，返回 `MatchResult`（命中 prefix 的 KV slot 索引 + last_node），存入 `req.prefix_indices`。`extra_key` 用于 LoRA ID / cache salt 命名空间隔离。

② **预算检查与 evict**：`PrefillAdder` 检 `token_to_kv_pool_allocator.available_size()`，不足调 `evict_from_tree_cache` → `tree_cache.evict`（`:562`）从 `evictable_leaves` 建 min-heap（按 `eviction_strategy.get_priority(node)` 排序）逐叶驱逐 `allocator.free_segment` + `_delete_leaf`。③ **分配新 slot**：`alloc_for_extend`（`allocation.py:303`）`alloc_req_slots` + `alloc_token_slots`（page=1）或 `alloc_extend`（page>1 用 Triton kernel `alloc_extend_kernel` 批量分），`write_cache_indices` 写 `req_to_token_pool` 映射。

④ **前向写 KV**：`ForwardBatch.out_cache_loc` 借用这些 slot 索引，attention backend `set_kv_buffer(layer, out_cache_loc, k, v)` 写入物理池。⑤ **完成时缓存**：`release_kv_cache`（`common.py:132`）→ `tree_cache.cache_finished_req` → `insert`：从 `req_to_token_pool` 读 token_ids+kv_indices，`_insert_helper` 遍历 children 匹配前缀累积、部分匹配 `_split_node`、剩余 key 建新 TreeNode（`evictable_size_ += len(key)`），最后 `dec_lock_ref` 释放引用锁——此后续请求可命中此前缀复用 KV。chunked prefill 中间用 `maybe_cache_unfinished_req` → `cache_unfinished_req(chunked=True)` 边算边插。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|--------------|
| `RadixCache.match_prefix` | 查前缀命中 | 指数搜索+二分，不逐 token 循环 |
| `RadixCache.insert` | 插入完成请求的 KV | _split_node 分裂共享前缀 |
| `RadixCache.evict` | 驱逐叶节点 | min-heap 按 eviction_strategy |
| `_split_node` | 分裂节点 | 匹配边界精确，前缀成可复用单元 |
| `inc_lock_ref` / `dec_lock_ref` | 引用计数 | 向上遍历到 root，>0 不可 evict |
| `KVCache.set_kv_buffer` | 写 KV 物理张量 | per-layer k_buffer/v_buffer |
| `KVCache.get_key_buffer` | 读 K | attention 层用 |
| `alloc_for_extend` | 分配多 token slot | Triton kernel（page>1） |
| `alloc_for_decode` | 分配 1 token slot | 每 req 1 个 |
| `KVCacheConfigurator.configure` | 探测显存+建池 | _profile_available_bytes |
| `default_radix_cache_factory` | 选 cache 实现 | registry 选择链 |

</details>

## 核心实现

### Radix Tree 前缀共享

两个请求 `[1,2,3,4,5,6]` 和 `[1,2,3,7,8]` 在 LRU list 是两条独立条目，在 radix tree 自动共享 `[1,2,3]` 子树——只存一份该前缀的 KV。`child_key()` 取首 `page_size` 个 token 作 dict key 实现 O(1) 子节点查找；`_split_node` 确保匹配边界精确，后续请求可在任意位置命中。对 LLM serving（system prompt 共享、few-shot 模板、多轮前缀）显著降内存与重复计算。

### 物理池与逻辑 slot 分离

物理池 `KVCache.k_buffer/v_buffer` 是连续 per-layer torch 张量（`size + page_size` padding 供 cuda-graph 哑写入），GPU kernel 高效访问；逻辑分配器只管索引空间（哪些 slot 空闲），无数据拷贝；`TreeNode.value` 存 slot 索引张量，evict/insert 只动索引。这支持 page 式分配（page>1 时物理按页对齐、allocator 用 page ID 管），也让 HiCache 的 load_back/evict 只需交换索引、物理数据由 CUDA stream 异步 DMA。

### HiRadixCache 三层分层

GPU 80GB 存不下长上下文/高并发的 KV。三层：L1(GPU) 低延迟高带宽但容量有限，evict 不丢数据而 backup 到 L2；L2(Host pinned) 容量大，CUDA DMA 异步加载，`write_through_selective` 只备热点（hit≥2）防冷数据浪费 host；L3(Storage) 跨实例共享（文件/网络，SHA256 hash 做 key），支持 PD disaggregation。被 evict 的前缀可从 host `load_back` 恢复而非重算，大幅降 TTFT。TP/PP rank 间 `_all_reduce` 同步 ack（lockstep）。

### 7 种 evict 策略

`get_eviction_strategy(policy)`（`utils.py:55`）工厂创建：LRU(默认，近期访问更可能再访问)/LFU(按 hit_count)/FIFO/MRU/FILO/Priority(`req.priority` 设优先级)/SLRU(probationary/protected 双段防单次长前缀挤占热点)。每种实现 `get_priority(node)` 返回可比较值，`RadixCache.evict` 建 min-heap 按之驱逐。`evictable_leaves` 维护（`_update_leaf_status`）保证 lock 的节点不被动。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Radix tree 前缀共享 | `radix_cache.py` TreeNode/RadixCache | 自动发现共享任意长度前缀 |
| 策略（evict 工厂） | `evict_policy.py` + `utils.py:55` | 7 策略可配置，evict 只调 get_priority |
| 三层分层缓存 | `hiradix_cache.py` | GPU 显存有限，evict→backup→load_back 不重算 |
| Registry | `registry.py` | cache 变体插件式扩展，选择链 + 注册 |
| 复合 Allocator | `allocator/swa.py`/`hisparse.py` | full+SWA/稀疏双池，索引映射张量 |
| Paged 分配（Triton） | `allocator/paged.py` | GPU 上批量分配，alloc_extend_kernel |
| 事件驱动 | `events.py` KVCacheEventMixin | KV-aware 路由器消费 BlockStored/Removed |

## 模块间交互

与 `managers.Scheduler`：Scheduler 经 `kv_cache_builder.build_kv_cache` 持有 `tree_cache`/`token_to_kv_pool_allocator`/`req_to_token_pool`；调度时 `req.init_next_round_input`→`match_prefix`，预算时 `available_size`，完成时 `release_kv_cache`→`cache_finished_req`，HiCache 每轮 `check_hicache_events`/`prefetch_from_storage`。与 `model_executor.ForwardBatch`：batch 借用 `out_cache_loc`（KV slot 索引，`:427`），attention metadata 由 backend 从 ForwardBatch 字段构建。与 `layers/attention`：每个 backend 初始化取 `self.token_to_kv_pool = model_runner.token_to_kv_pool`，前向 `set_kv_buffer` 写、`get_key_buffer` 读，`RadixAttention`（`radix_attention.py:91`）是 attention 层的 nn.Module 包装作 `layer` 参数传入。与 `speculative`：spec worker 的 draft model 有独立 KV pool（`EagleDraftWorker.alloc_memory_pool`），NGRAM 无 draft KV，FrozenKVMTP 复用 target KV，verify 后 `move_accept_tokens_to_target_kvcache` 同步。

## 扩展方式

换 evict 策略：`evict_policy.py` 加 `EvictionStrategy` 子类实现 `get_priority` + `utils.py:55` 注册到 `_EVICTION_POLICY_FACTORIES`，用户 `--radix-eviction-policy` 启用，无需改 RadixCache。加新 cache 变体：新建 `my_cache.py` 继承 `BasePrefixCache` 实现抽象方法（`reset`/`match_prefix`/`insert`/`evict`/`inc/dec_lock_ref`/`cache_finished_req`/`cache_unfinished_req`），`registry.py` 在选择链加判断或 `register_radix_cache_backend` 注册，用户 `--radix-cache-backend` 选；需特殊 KV pool/allocator 则在 `kv_cache_configurator._build_token_to_kv_pool[_allocator]` 加分支。调 KV pool 内存配比：`kv_cache_configurator.py` 的 `_resolve_memory_pool_config`（`:1794`）/`config_from_budget`（`:1812`）/`_derive_pool_sizes`（`:287`），用户侧 `--mem-fraction-static`/`--max-running-requests`，hybrid SWA 模型调 `full_tokens_per_layer` vs `swa_tokens_per_layer` 比例。扩展点契约见概览「核心概念」。
