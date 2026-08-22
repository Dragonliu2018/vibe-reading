---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "缓存层"
date: "2026-08-22T22:29:54+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.18"]
tags: ["SGLang", "mem_cache", "RadixAttention", "radix tree", "KV cache", "HiRadixCache"]
description: "SGLang 缓存层：RadixCache radix tree 前缀共享、MemoryPool 三层架构、HiRadixCache 三层分层缓存与 7 种 evict 策略。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/00-overview)

---

## 模块定位

mem_cache 是 RadixAttention 的实现所在，SGLang 的招牌特性。它解决一个核心问题：多请求共享 system prompt / few-shot / 多轮前缀时，如何让 KV 不重复计算、不重复存储。答案是用 radix tree 自动发现任意长度公共前缀并共享一份 KV。这里同时管 KV 的物理显存（连续 per-layer 张量）与逻辑前缀树（slot 索引），二者分离是关键设计。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-v0518/mem-cache-architecture.svg)

模块分四块。**三层 MemoryPool**（`memory_pool.py`）：① `ReqToTokenPool`（`:256`）把 request 映射到其 token 位置（`req_to_token` 张量，slot 0 保留给 cuda-graph 哑写入）；② `TokenToKVPoolAllocator`（`allocator/`）管理 KV slot 索引空间，无数据拷贝；③ `KVCache`（`:1624` ABC）持有物理 KV 张量，`MHATokenToKVPool`（`:1755`，NHD/HND 布局）、`MLATokenToKVPool`（`:3932`，DeepSeek 压缩）、以及 FP4/MXFP8/PageMajor/DSA/MiniMaxSparse 变体。

**RadixCache**（`radix_cache.py:303`）是逻辑前缀树。`TreeNode`（`:238`）有 `children`(dict)/`parent`/`key`(`RadixKey`)/`value`(GPU slot 索引张量)/`lock_ref`(引用计数)/`last_access_time`/`hit_count`/`host_value`(L2 索引)/`hash_value`(SHA256)。`RadixKey.match`（`:181`）分两阶段避免逐 token Python 循环：先**指数搜索**（gallop）以倍增窗口做切片比较定位首个分歧窗口，再窗口内**二分** `while hi-lo>1: mid=(lo+hi)//2` 缩小分歧位置；结果按 `(matched_tokens // page_size) * page_size` 向下取整对齐。`RadixCache` 提供 `match_prefix`/`insert`/`evict`/`inc_lock_ref`/`dec_lock_ref`。

**HiRadixCache**（`hiradix_cache.py:48`）继承 `RadixCache` 扩展三层：L1(GPU)、L2(Host pinned CPU tensor)、L3(Remote via `KVCacheEventMixin` 发出 `BlockStored`/`BlockRemoved` 事件)。**EvictPolicy**（`evict_policy.py:10`）ABC 有 7 种策略：LRU/LFU/FIFO/MRU/FILO/Priority/SLRU。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-v0518/mem-cache-call-chain.svg)

**match_prefix 链**：`Scheduler.match_prefix` → `RadixCache.match_prefix(MatchPrefixParams)`（`radix_cache.py:376`）→ `key.maybe_to_bigram_view`/`key.page_aligned` → `_match_prefix_helper`（`:678`，遍历 TreeNode，用 `child_key` 做 dict 查找，调 `RadixKey.match` 做指数搜索+二分）→ `torch.cat(value)` 拼接所有匹配段 KV 索引 → 返回 `MatchResult(device_indices, last_device_node)`。必要时 `_split_node`（`:704`）精确分裂部分匹配的节点。

**insert 链**：`cache_finished_req`（`:458`）/`cache_unfinished_req`（`:515`）→ `_insert_helper`（`:737`）→ 沿树向下走（`child_key` 查找），找到子节点后 `node.key.match` 计算 `prefix_len`，部分匹配则 `_split_node` 分裂，完全匹配则更新 priority/hit_count，有剩余 key 则创建新 `TreeNode`。`value.clone()` 只克隆索引不克隆 KV 数据。

**evict 链**：`RadixCache.evict`（`:592`）→ 收集 `evictable_leaves`（lock_ref==0 且子节点均 evicted 的叶子）→ `eviction_strategy.get_priority(node)` 构建最小堆 → 循环弹出堆顶 `free_segment(value)` 释放物理 slot → `_delete_leaf` 从树删除。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `match_prefix` (`:376`) | 前缀匹配 | 返回 MatchResult(device_indices, last_node) |
| `_match_prefix_helper` (`:678`) | 遍历 TreeNode 匹配 | child_key dict 查找 + RadixKey.match |
| `match` (RadixKey) (`:181`) | 比较 token 序列 | 指数搜索+二分，O((log m)²) |
| `insert` (`:436`) | 插入 KV 索引到树 | `_insert_helper` + `_split_node` |
| `_insert_helper` (`:737`) | 递归插入 | 部分匹配→split；完全匹配→更新；剩余→new TreeNode |
| `_split_node` (`:704`) | 分裂节点 | new_node 继承前半段，child 保留后半 |
| `evict` (`:592`) | 淘汰 KV | eviction_strategy 堆排序 + free_segment |
| `inc_lock_ref` (`:622`) | 增引用计数 | 从 node 向上遍历到 root |
| `dec_lock_ref` (`:637`) | 减引用计数 | lock_ref 1→0 时移回 evictable |
| `cache_finished_req` (`:458`) | 完成请求插树 | 释放非共享 KV + 解锁 last_node |
| `cache_unfinished_req` (`:515`) | 分块请求插树 | chunked 模式 |
| `set_kv_buffer` (KVCache) (`:2327`) | 写 KV 到物理张量 | attention 层调 |
| `get_key_buffer` (KVCache) (`:2288`) | 读 K buffer | attention kernel 索引 |
| `move_kv_cache` (KVCache) (`:2797`) | 物理槽位重定位 | mamba ping-pong |

</details>

## 核心实现

### RadixKey.match 的指数搜索+二分

`match`（`radix_cache.py:181`）分两阶段。阶段 1（指数搜索/galloping）：以倍增窗口 `step=1,2,4,8...` 做 C 级 slice 比较 `t0[lo:hi] != t1[lo:hi]`，在共享段上 O(log n) 次比较到达分歧窗口。阶段 2（二分）：在分歧窗口 `[lo, hi)` 内 `while hi-lo>1: mid=(lo+hi)//2` 缩小分歧位置。总计 O((log m)²)，远优于 O(m) 逐 token Python 循环。注释（`:189-190`）明确："no per-token Python loop on long shared prefixes"。匹配后按 `page_size` 向下取整，bigram 模式下 `matched = max(0, min(matched_tokens-1, len(self), len(other)))`。

### 三层 MemoryPool 与物理/逻辑分离

三层架构：`ReqToTokenPool`（请求→token 位置映射）→ `TokenToKVPoolAllocator`（KV slot 索引分配回收）→ `KVCache`（物理 KV 张量）。`PagedTokenToKVPoolAllocator`（`allocator/paged.py:105`）以 page 为分配单位：`alloc_extend` 用 Triton kernel `alloc_extend_kernel` 在 GPU 上并行计算分配方案；`free` 先 `torch.unique(free_index // page_size)` 去重再回收；`free_segment` 用 stride slice 避免 data-dependent output shape 导致的 device sync。

物理池与逻辑树分离的原因：① 关注点分离（树管前缀共享关系，池管显存布局）；② 避免数据复制（`TreeNode.value` 只存索引，`insert` 的 `value.clone()` 只克隆索引不克隆 KV 数据）；③ evict 高效（`free_segment` 释放索引，`TreeNode.value=None` 标记 evicted，物理数据延迟覆盖）；④ 多后端复用（同一 RadixCache 配 MHA/MLA/FP4/MXFP8）。

### HiRadixCache 三层缓存

`HiRadixCache`（`hiradix_cache.py:48`）扩展为 L1(GPU)、L2(Host pinned CPU tensor via `HostKVCache`)、L3(Remote via `KVCacheEventMixin` 发出事件)。`init_load_back` 在 `match_prefix` 发现 L2 命中后异步将 host KV 传回 GPU。`HiCacheController` 管理 L2↔L3 的 prefetch/load_back 线程。host pool 类型由 GPU 端 KV cache 类型决定：MHA → `get_mha_host_pool_cls`，MLA → `MLATokenToKVPoolHost`。

### 注册表与工厂选择链

`register_radix_cache_backend`（`registry.py:55`）注册 `RadixCacheFactory` 到 `_RADIX_CACHE_REGISTRY`。`create_tree_cache`（`:223`）入口：`--radix-cache-backend` 指定 → 查注册表；否则 `default_radix_cache_factory`（`:80`）内置选择链：`disable_radix_cache` + chunked → ChunkCache；C++ radix tree → RadixCacheCpp；unified → UnifiedRadixCache；`enable_hierarchical_cache` → HiRadixCache；LMCache → LMCRadixCache；默认 → RadixCache。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|----------|
| ABC 工厂链 | `BasePrefixCache` `base_prefix_cache.py:234` → RadixCache/HiRadixCache/UnifiedRadixCache | 统一接口 + dataclass 参数封装（MatchPrefixParams/InsertParams 等） |
| 策略模式 | `EvictionStrategy` `evict_policy.py:10` + 7 种策略 | `get_eviction_strategy()` 工厂注入，不改 cache 本体 |
| 注册表 | `register_radix_cache_backend` `registry.py:55` | cache 变体可不改源码扩展 |
| 事件 mixin | `KVCacheEventMixin` `events.py:37` | HiRadixCache L3 事件发射 |

## 模块间交互

RadixCache↔Scheduler：请求到达时 `match_prefix` 获取已缓存前缀 KV 索引；prefill 中间 `cache_unfinished_req` 插入 chunk KV 索引并 `inc_lock_ref`；请求完成 `cache_finished_req` 插入完整序列并 `dec_lock_ref`；内存不足 `evict` 淘汰。KVCache↔Attention 层：`set_kv_buffer(layer, loc, cache_k, cache_v)` 写入、`get_key_buffer(layer_id)`/`get_value_buffer(layer_id)` 读取、`move_kv_cache(tgt, src)` 重定位。通过 `ForwardContext`：`get_token_to_kv_pool()` = `get_attn_backend().token_to_kv_pool`。

## 扩展方式

#### 新增 evict 策略

1. 在 `evict_policy.py` 新增 `class MyStrategy(EvictionStrategy)`，实现 `get_priority(node)`
2. 在 `utils.py:56` 的 `_EVICTION_POLICY_FACTORIES` 注册
3. 启动时 `--eviction-policy my_strategy`

无需改 RadixCache——策略通过 `get_eviction_strategy()` 注入。

#### 新增 KV cache 后端

1. 在 `memory_pool.py` 新增 `class MyTokenToKVPool(KVCache)`，实现 `get_key_buffer`/`set_kv_buffer` 等
2. （可选）在 `allocator/` 新增 Allocator
3. 在 `registry.py` 用 `register_radix_cache_backend` 注册工厂，或修改 `default_radix_cache_factory` 选择链
4. 通过 `--radix-cache-backend my_backend` 选择
