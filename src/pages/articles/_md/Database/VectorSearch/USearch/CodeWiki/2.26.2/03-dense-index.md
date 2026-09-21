---
source:
  type: "源码解读"
  project: "USearch"
  url: "https://github.com/unum-cloud/USearch"
title: "稠密索引"
date: "2026-09-21T15:26:32+08:00"
category: [Database, VectorSearch, USearch, CodeWiki, "2.26.2"]
contentType: "CodeWiki"
tags: ["USearch", "C++", "序列化", "聚类"]
description: "USearch 稠密索引层解读——key→slot 查找表与向量 tape、.usearch 三段式序列化字节布局、mmap 零拷贝 view、惰性删除与 compact、HNSW 上层图当聚类中心"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/00-overview)

---

## 模块定位

`include/usearch/index_dense.hpp`（2,454 行）在无值感知的图引擎之上包装"稠密等维向量"语义——这是 99% 用户实际使用的形态。它承担图引擎不管的一切：key→slot 反向查找、向量数据的拷贝与精度转换、序列化格式、删除回收、聚类与 join 的编排。一句话概括分工：**图只信 slot 与距离，稠密层负责把"用户的 key 与向量"翻译成图听得懂的语言，并把向量字节管起来**。

之所以把向量放这层而不是图引擎：HNSW 图只要求"节点可度量"——把向量数据外置后，引擎可以服务任意自定义值（外部对象、远程数据），同时删除/重命名这些"key 语义"的操作只在有查找表的这层才成立。

## 模块架构

单模板类 `index_dense_gt<key_at, compressed_slot_at>` 承载全部逻辑，私有成员即架构图（`index_dense.hpp:458-531`）：

| 成员 | 职责 |
|------|------|
| `typed_`（堆上 64 对齐） | 核心图引擎 `index_gt` 实例 |
| `slot_lookup_` | key→slot 多重哈希（`flat_hash_multi_set_gt<key_and_slot_t, lookup_key_hash_t, lookup_key_same_t>`，透明哈希/相等，shared_mutex 保护） |
| `vectors_lookup_` | slot → 向量字节指针的扁平表（**稠密层的核心反向结构**） |
| `vectors_tape_allocator_` | 向量拷贝的 arena（8 字节对齐兼容 f64） |
| `free_keys_` + `free_key_` | 已删 slot 回收环 + 哨兵标记值 |
| `cast_buffer_` + `casts_` | 每线程标量转换暂存 + 11 格函数指针表 |
| `available_threads_` | 空闲线程 id 环（`thread_lock_t` RAII 租借） |
| `metric_` | `metric_punned_t`，`try_change_metric`（`index_dense.hpp:733`）可运行期替换 |

两个代理类是解耦的支点：`metric_proxy_t`（`index_dense.hpp:437`）实现 5 个 `operator()` 满足图引擎的 metric duck-typing 契约——图引擎回调 `metric(a, member)` 时，proxy 用 `v(member) = vectors_lookup_[get_slot(m)]` 把成员解引用成向量指针再调 punned metric；`values_proxy_t`（`index_dense.hpp:1889`）把 `byte_t*` 查表伪装成 `values[slot]` 下标语义，供 `typed_->compact`/`join` 泛型消费。

查找表的两端设计：条目是 `key_and_slot_t{key, slot}`，查找键用 `key_and_slot_t::any_slot(key)`——slot 填 `default_free_value<compressed_slot_t>()` 的"任意槽"哨兵（`index_dense.hpp:497-503`），配合透明哈希让"只按 key 查"和"按 key+slot 精确删"共用一张表。配置开关 `enable_key_lookups`（`index_dense_config_t`，`index_dense.hpp:127-131`）关掉后不建 `slot_lookup_` 省 RAM，代价是 `get`/`rename`/`remove` 不可用（调用处 `usearch_assert_m(config().enable_key_lookups, ...)` 拦截），add/search 照常。`size()` 是 `typed_->size() - free_keys_.size()`（`index_dense.hpp:709`）——图上的节点数减去回收环里的已删 slot。

## 调用链路

add 重载表（`index_dense.hpp:872-942`）是这层的典型 API 形态——11 种输入标量各一个内联重载，仅差传入 `casts_.from.xxx` 转换指针，全部汇入私有 `add_`：

```
add(f32_t const* vector, ...) → add_(key, vector, thread, copy, casts_.from.f32)   index_dense.hpp:2168
  ├─ !multi() && enable_key_lookups && contains(key) → "Duplicate keys not allowed"
  ├─ thread_lock_()：从 available_threads_ 环弹出线程 id
  ├─ cast：cast_buffer_.data() + bytes_per_vector × thread_id（每线程独占切片，零锁）
  │        cast 成功 → copy_vector = true（暂存区会被下次调用覆盖，必须拷走）
  ├─ free_keys_.try_pop(free_slot)：复用已删 slot 则 reuse_node = true
  └─ reuse_node ? typed_->update(iterator_at(free_slot), ...)      ← 原 slot 重连边
              : typed_->add(key, vector_data, metric, ...)         ← 新 slot 插图
       on_success 回调（index_dense.hpp:2204-2215）：
         slot_lookup_.try_emplace({key, slot})
         vectors_lookup_[slot] = memcpy 拷入 或 直接别名用户指针（copy_vector=false 零拷贝模式）
```

`copy_vector=false` 的别名模式值得注意：调用方保证向量生命周期时，稠密层不拷贝——外部值管理（"index 只管相似性"）的延伸。

## 核心实现

### 序列化：三段式与字节布局

`.usearch` 文件由 `save_to_stream`（`index_dense.hpp:1144-1211`）按序输出三段，布局见下图：

![.usearch 三段式布局](/vibe-reading/images/articles/usearch-internals/dense-serialization.svg)

设计细节：

- **矩阵段自带 rows×cols 头**（u32 或 u64 双宽度，`use_64_bit_dimensions`），且 cols 是**每向量字节数**而非维度——意味着它可以独立于索引用 `exclude_vectors` 拆出去、或被 `Indexes` 分片直接 mmap；
- **head 实际用 42 字节**（7B magic "usearch" + 3×u16 版本 + 4 个 kind 枚举 + 3×u64 计数 + 1B multi），尾部 22 字节保留——源码注释里的"graph/vectors 尺寸 + checksum 字段"是旧版残留，以字段实际宽度为准；
- **kind 枚举就是磁盘格式**：`fix_pre_2_10_metadata`（`index_dense.hpp:214-247`）修 v2.10 前 scalar kind 枚举编号错位的旧文件（issue #423）——内部经 `convert_pre_2_10_scalar_kind` 把旧枚举码（0..14）映射到新 `scalar_kind_t` 并把 minor 版本改写为 10.0；枚举值只增不改是兼容策略；
- 加载校验：`version_major` 必须相等（次版本宽容），key/slot kind 不匹配直接"consider rebuilding"。

配套的免加载探测：`index_dense_metadata_from_path`/`_from_buffer`（`index_dense.hpp:253-387`）只 `fread` 一块 `index_dense_head_buffer_t`（`byte_t[64]`，static_assert 恰为 64 字节），依次尝试三种文件开头——直接以 "usearch" magic 开头（`exclude_vectors` 的纯图文件）、u32 维度对（head 偏移 = 8 + rows×cols）、u64 维度对（16 + rows×cols）——到候选偏移再验 magic，全程不 mmap、不建图，Go/Swift 在 load 前就能拿到维度与精度。

### view()：零反序列化的只读服务

`view_from_stream`（`index_dense.hpp:1349-1475`）与 load 的分叉在最关键的一步：**load 逐 slot 从 tape allocate + read 拷贝向量，view 只记 span**——`vectors_lookup_[slot] = vectors_buffer.data() + matrix_cols × slot`（`index_dense.hpp:1460-1462`），纯指针算术，不拷任何向量字节；图段同样交给 `typed_->view` 让 `node_t` 直接指向 mmap。OS 按需缺页，数十 GB 索引可以不进 RAM 直接服务。代价是 `is_immutable()`：add/remove 被拒绝、搜索路径连 hop 锁都省掉（`index.hpp:4451`）。

### 惰性删除与 slot 复用

`remove()`（`index_dense.hpp:1641`）三重操作一气呵成（代码注释原文）：

```cpp title="include/usearch/index_dense.hpp:1659（节选）"
// A removed entry would be:
// - present in `free_keys_`
// - missing in the `slot_lookup_`
// - marked in the `typed_` index with a `free_key_`
free_keys_.push(slot);
typed_->at(slot).key = free_key_;
```

为什么惰性：物理摘除 HNSW 节点要修复 O(度×层数) 的全局连通性；打标记是 O(1) 单字段写。搜索侧由谓词兜底——`search_`（`index_dense.hpp:2227`）统一包装 `allow = member.key != free_key_ && predicate(member)`。**复用的意外收益**：`add_` 弹出 free slot 走 `typed_->update()` 在原节点重连边，老节点已有成熟邻居关系，位置局部性反而更好。全生命周期见下图：

![slot 生命周期](/vibe-reading/images/articles/usearch-internals/dense-slot-lifecycle.svg)

`compact()`（`index_dense.hpp:1907`）是真正的物理回收：`track_slot_change` 回调对每次 (old_slot→new_slot) 在新 tape 分配并 memcpy 向量、填 `new_vectors_lookup`；图引擎侧（`index.hpp:4042`）先为每个节点找父簇、按 `(level 降序, cluster 升序)` 排序后重写全部邻居 slot——高层节点相邻、同簇相邻，重排后缓存局部性更好。`isolate()`（`index_dense.hpp:1876`）是轻量版：只剪指向被删节点的**入边**，被隔离节点自己的出边保留（它可能仍是图的结构枢纽），内存不回收。

> ⚠️ **本版的一个缺口（标注待核实上游意图）**：`compact()` 重建了 `vectors_lookup_` 却**没有重建 `slot_lookup_** 也不清 `free_keys_`，而 slot 在 compact 中确实被重排——compact 之后 `get()/contains()` 持旧 slot 理论上会错位。`cpp/test.cpp` 的 compact 用例只验证返回成功（`cpp/test.cpp` 的 `expect(compaction_result)`），未验证 compact 后 key 查找。依赖 key lookup 的使用方在 compact 后需自行规避或核实上游后续修复。

### 聚类：HNSW 上层图当免费聚类中心

`cluster()` 批量版（`index_dense.hpp:1981-2148`）的核心思想：**HNSW 的分层结构本身就是一棵现成的聚类树**——上层节点是被贪心搜索反复命中的"枢纽"向量，天然是粗粒度质心；对一组 key 聚类只需在某层做一次贪心下降（`cluster(key, level, thread)` at `index_dense.hpp:1011`，内部委托 `typed_->cluster` in `index.hpp:3504`），把 K-Means 的迭代成本降为一次图查询。

完整流程带两个 `goto` 回环：

```
选层：从 max_level 自顶向下找第一个 stats(level).nodes > min_clusters 的层
map_to_clusters: executor.dynamic 并发贪心下降 → 每 key 得质心 + 距离
  ↓ run-length 去重（按质心排序压缩，同质心合并 popularity）
unique_clusters < min_clusters 且 level > 1 ？ → level-- 后 goto map_to_clusters（上层太粗就下钻）
  ↓ 按 popularity 降序
merge_nearby_clusters: 簇数 > max_clusters ？ → 最不受欢迎的簇并给最近邻 → goto 循环
  ↓ 并发追 merged_into 链到根簇 + 重算距离
输出 cluster_keys[] / cluster_distances[]
```

注意两点（以本版源码为准）：`index_dense_clustering_config_t::mode`（merge_smallest_k/merge_closest_k，`index_dense.hpp:164-167`）**声明了但未被读取**——实现恒为"合并最不受欢迎者到其最近邻"；早期版本接入的 `kmeans_clustering_gt` 细化在 v2.26.2 的聚类路径中不存在（该类现仅被 `cpp/test.cpp` 使用）。Python 层的 `Clustering.subcluster()`（`python/usearch/index.py:461`）在这个机制上递归下钻。

### rename 与 reindex_keys

`rename(from, to)`（`index_dense.hpp:1729`）：`slot_lookup_.pop_first` 逐个弹出 `{from, slot}`、`try_emplace({to, slot})`、同步改图上 `key`——非 multi 模式目标 key 已存在则拒绝。`reindex_keys_()`（`index_dense.hpp:2339`）是 load/view 后的"真相重建"：扫描全部 slot，key==free_key_ 的进 `free_keys_` 环，否则进 `slot_lookup_`——**删除状态完全从图上的标记反推**，序列化文件不需要额外的删除清单。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 门面 | `index_dense_gt` 全类 | 用户语义挡在稠密层，图引擎只见 punned slot |
| 代理 | `metric_proxy_t`/`values_proxy_t`（437/1889） | "向量数据放外层"的实现支点 |
| RAII 线程租借 | `thread_lock_t`（534） | 线程槽自动归还 available_threads_ 环 |
| 结果持锁 | `search_result_t` 存 `thread_lock_t`（571-581） | 迭代结果期间线程槽不被覆写 |
| 回调注入 | `on_success`/`track_slot_change`/`allow` | 生命周期钩子全模板回调，无虚函数 |

## 模块间交互

向下：`typed_` 独占 `index_gt`（装配点 `index_dense.hpp:428-430` 注入 plugins 分配器）；`casts_`/`metric_`/`slot_lookup_` 底座均来自 index_plugins.hpp。向上：C ABI（`c/lib.cpp`）与全部 C++ 直连绑定的直接对象就是 `index_dense_t = index_dense_gt<>`（`index_dense.hpp:2410`），大容量变体 `index_dense_big_t = index_dense_gt<uuid_t, uint40_t>`（2411）。

## 扩展方式

- **新增输入标量**：`index_dense.hpp:872-942` 的 clang-format off 块里照抄一行重载（add/search/filtered_search/get/cluster/distance_between 六张表各一行）——完全机械，配合 [基础设施层](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/02-plugins-infra) 的 cast 矩阵。
- **改序列化格式**：head 尾部 22 字节余量只允许**向后追加**，动前 42 字节旧文件偏移全毁；需同步 `load_from_stream`/`view` 与 `index_dense_metadata_from_*` 的偏移推算（依赖 `8/16 + rows×cols` 的矩阵段大小公式）。
- **改 free-key 回收策略**：影响面集中在 remove（入环）、`add_`（try_pop + reuse_node 分支）、`reindex_keys_`（重建环）、compact/copy（导出环）——例如换成 LRU 只需改 ring 出入队语义；要改物理删除则必须给 `typed_` 加节点摘除能力（现版 `index_gt` 无此能力）。
