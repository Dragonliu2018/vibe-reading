---
source:
  type: "源码解读"
  project: "USearch"
  url: "https://github.com/unum-cloud/USearch"
title: "核心图引擎"
date: "2026-09-21T15:26:32+08:00"
category: [Database, Misc, USearch, CodeWiki, "2.26.2"]
contentType: "CodeWiki"
tags: ["USearch", "C++", "HNSW", "图算法"]
description: "USearch 核心图引擎 index_gt 解读——HNSW 单 tape 节点布局、add/search/update 的完整算法流程、refine_ 启发式选边、per-thread context 与稳定婚姻 join 的实现内幕"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/00-overview)

---

## 模块定位

`include/usearch/index.hpp`（5,066 行，单头文件）实现泛型 HNSW 图引擎 `index_gt`。它是整个项目的算法心脏，也是"单头文件向量搜索引擎"卖点的本体——但一个反直觉的事实是：**这个文件里没有任何向量**。`index_gt` 只管理"节点"（外部 key + 邻居列表）和"距离"（注入的 metric 回调），对被索引的值是什么一无所知。稠密向量、变长集合、文本、地理坐标都是把各自的度量函数注入进来后平等对待的值（文档注释 `index.hpp:2192-2194` 明确列了这些非向量用例）。

它的依赖只有 STL 与 OS 原语（mman/fcntl/stat）——`index_plugins.hpp` 反而 include 它（取 `expected_gt` 与宏）。这个自足性是全部多语言绑定能"只 include 两个头就编译"的前提。

模板参数即扩展契约：

```cpp title="include/usearch/index.hpp:2266"
template <typename distance_at = default_distance_t,              //
          typename key_at = default_key_t,                        //
          typename compressed_slot_at = default_slot_t,           //
          typename dynamic_allocator_at = std::allocator<byte_t>, //
          typename tape_allocator_at = dynamic_allocator_at>      //
class index_gt {
```

- `distance_at` 必须有符号（static_assert at `index.hpp:2280`）——引擎用一元负号把 max-heap 当 min-heap 用；
- `compressed_slot_at` 是寻址节点的最小无符号整数，可选 uint32/uint64/自定义 **uint40_t**（`index.hpp:1177`，注释算账：40 bit 寻址 1 万亿条目，5 字节 × 20 邻居 + 100 字节/条 ≈ 200 TB，正好单机 NVMe 阵列容量，比 8 字节省 37.5% 邻居表内存）；
- `tape_allocator_at` 的契约是"**永不单独 deallocate，只整块释放**"（文档 `index.hpp:2213-2215`）——这是 tape 设计的根。

## 模块架构

![HNSW 多层图与节点 tape 布局](/vibe-reading/images/articles/usearch-internals/core-hnws-levels.svg)

引擎内部由四组构件组成。**图结构**：`nodes_` 是 C 风台的 `node_t` 数组（按 `compressed_slot_t` 下标），`entry_slot_`/`max_level_` 记录顶层入口，`choose_random_level_` 用指数分布随机选层——每个节点以递减概率出现在更高层，上层天然稀疏。**节点布局**：`node_t` 仅是一个 `byte_t*` 的"智能指针"（2424-2425 两条 static_assert 强制 trivially copyable/destructible，"Nodes must be light!"——8 字节一个，一条 cache line 装 8 个），其 tape 打包 `key + level + 所有层邻接表`，一次分配。**每线程上下文** `context_t`：双优先队列 + visits 哈希集 + 每线程随机引擎 + 统计计数（`computed_distances` 及 `computed_distances_in_refines`/`computed_distances_in_reverse_refines` 两个 refine 专项计数），"相当于把这些做成 `thread_local`"（文档 `index.hpp:2486`）。**分片锁** `striped_locks_gt`：与图大小无关、按 threads×connectivity 配比的 cache-line 对齐自旋锁（详见[并发与锁设计](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/01-core-concurrency)）。

为什么所有层邻接表拼进单条 tape：一，节点访问一次 cache miss 拿到全部元数据与邻接表（头注释 `index.hpp:2394-2396`："minimize memory usage and maximize the number of entries per cache-line"）；二，序列化退化为逐节点 memcpy（`save_to_stream` in `index.hpp:3692` 直接 `output(node_bytes.data(), node_bytes.size())`），view 模式 `node_t` 直接指向 mmap 区域（`index.hpp:4012-4013`），**零反序列化**。代价是 packed 布局无对齐保证，全库字段访问走 `misaligned_load/store`（避免解引用不对齐指针的 UB，`index.hpp:305-308` 注释原文）。

## 调用链路

add 与 search 两棵调用树覆盖了引擎的全部主路径（update 与 add 同构，差异见图右下注记）：

![add/search 调用树](/vibe-reading/images/articles/usearch-internals/core-call-tree.svg)

两条链路共享同一骨架——best-first 搜索，双堆结构：`next_candidates_t`（`max_heap_gt`）存 `{-dist, slot}` 当 min-heap 弹"最近待扩展"，`top_candidates_t`（`sorted_buffer_gt`）维护已见最优集、`top()` O(1) 提供剪枝半径。终止条件统一是"最近待扩展点已比 top 里最差者远且 top 已满"。add 与 search 的本质差异只有两处：insert 版要锁候选节点（其他线程可能正在改它的邻接表），find 版完全无锁（假设只读并发）；insert 结束后还要双向连边。

方法速查：

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `add()` `index.hpp:3181` | 插入节点并双向连边 | global_mutex_ 早释放；惰性回调 on_success |
| `update()` `index.hpp:3330` | 原 slot 重连边 | try-lock 跳过抢不到的节点防死锁 |
| `search()` `index.hpp:3428` | 近似 top-k | exact 分支绕图全量扫 |
| `cluster()` `index.hpp:3504` | 降到指定层的最近节点 | 聚类复用上层图节点 |
| `save/load/view()` `index.hpp:3692-4019` | 三段序列化 | view 零拷贝 mmap |
| `compact()` `index.hpp:4042` | 物理重排图 | 按层+簇排序提升局部性 |
| `isolate()` `index.hpp:4149` | 剪指向被删节点的入边 | 出边保留防破坏连通骨架 |
| `join()` `index.hpp:4877` | 两索引一对一匹配 | Gale-Shapley 稳定婚姻 |
| `search_for_one_` `index.hpp:4440` | 逐层贪心找单点 | 0 锁（immutable 时连 hop 锁都省） |
| `search_to_insert_` `index.hpp:4488` | 插入前 beam search | 锁候选节点 |
| `search_to_update_` `index.hpp:4568` | update 版 beam | 排除自身 slot |
| `search_to_find_in_base_` `index.hpp:4662` | 0 层 beam search | 无锁读 + 谓词过滤 |
| `refine_` `index.hpp:4793` | HNSW 论文 Algorithm 4 | 替身淘汰启发式 |
| `choose_random_level_` `index.hpp:4369` | 指数分布选层 | −ln(u)/ln(M) |

</details>

## 核心实现

### add()：从选层到双向连边

```cpp title="include/usearch/index.hpp:3181（节选）"
add_result_t add(vector_key_t key, value_at&& value, metric_at&& metric, ...) {
    // 0. 必须先 reserve：add 借用 per-thread context 的堆与队列
    context_t* context_ptr = context_or_null_(config.thread);   // index.hpp:3194
    if (!context_ptr)
        return result.failed("Reserve capacity ahead of insertions!");
    // 1. 顶层准备：top 容量比 connectivity 多留一格，供启发式"往饱和列表里再挤一个"
    std::size_t top_limit = (std::max)(connectivity_max + 1, config.expansion);
    // 2. 全局锁下选层、占坑
    std::unique_lock<std::mutex> new_level_lock(global_mutex_);
    level_t new_target_level = choose_random_level_(context.level_generator);
    std::size_t old_size = nodes_count_.fetch_add(1);        // 原子占坑
    node_t new_node = node_make_(key, new_target_level);    // tape 分配 + memset
    if (new_target_level <= max_level_copy)
        new_level_lock.unlock();                             // 关键：多数情况提前解锁
    nodes_[old_size] = new_node;                             // 无锁发布
    // 3. 贪心下降 + 逐层连边
    compressed_slot_t closest_slot = search_for_one_(value, metric, ...);
    for (level_t level = (std::min)(new_target_level, max_level_copy); level >= 0; --level) {
        search_to_insert_(value, metric, ..., closest_slot, level, config.expansion, context);
        {
            node_lock_t new_lock = node_lock_(new_slot);      // 只锁新节点
            closest_view = form_links_to_closest_(metric, new_slot, level, context);
        }
        form_reverse_links_(metric, new_slot, closest_view, value, level, context);
    }
    if (new_target_level > max_level_copy) { entry_slot_ = new_slot; max_level_ = new_target_level; }
}
```

三个值得咀嚼的决策。**为什么必须先 reserve**：add/search 的全部暂存（双堆、visits）住在 `context_t` 里，而 `contexts_` 数组由 `try_reserve`（`index.hpp:2914`）按线程数预分配——没有 reserve 就没有 context，`context_or_null_()`（`index.hpp:2575`）返回空指针直接报 "Reserve capacity ahead of insertions!"。**锁的时效性**：`global_mutex_` 只保护 `entry_slot_`/`max_level_` 两个入口元数据，且新节点层不超当前最高层时立刻解锁——绝大多数 add 全程只持 per-node 锁。**无锁发布**：`nodes_count_.fetch_add` 先占坑，slot 专属本线程，`nodes_[old_size] = new_node` 无锁写入是安全的。**容量纪律**：`top_limit = max(connectivity_max+1, expansion)`，`index.hpp:3205-3206` 注释解释多留的一格是给 refine 启发式"往饱和列表里再挤一个"用的。选层公式的 `inverse_log_connectivity` 是 `pre_` 预计算常量（1/ln(connectivity)，`index.hpp` 的 `precomputed_constants_t`），让 `choose_random_level_` 只做一次乘法。

`form_reverse_links_`（`index.hpp:4318`）处理反向边：锁住每个新邻居，未满直接 `push_back(new_slot)`；**已满则重建**——把新节点与邻居现有边全部塞进 `top_for_refine`，用 `refine_(..., override_slot=new_slot, override_value=value)` 重选出胜者写回。`override_*` 参数存在的原因：update/add 场景中新向量可能尚未对邻居可见，`inter_neighbor_distance_` 的这个重载（`index.hpp:4760`）在任一端是 override_slot 时改用新向量算距离；无 override 时走 `std::nullptr_t` 重载（`index.hpp:4773`），让编译器根本不实例化该分支——C++11 兼容的零开销技巧。

### refine_()：HNSW 的灵魂

`index.hpp:4793` 实现论文 Algorithm 4（启发式选边），逻辑值得逐行看：

```cpp title="include/usearch/index.hpp:4793（节选）"
candidates_view_t refine_(metric_at&& metric, std::size_t needed,
                          top_candidates_t& top, ..., compressed_slot_t override_slot, ...) {
    top.sort_ascending();                 // 按到 query 的距离升序
    std::size_t submitted_count = 1;      // top_data[0] 必入选
    std::size_t consumed_count = 1;
    while (submitted_count < needed && consumed_count < top_count) {
        candidate_t candidate = top_data[consumed_count];   // 按距离序消费
        bool good = true;
        for (std::size_t idx = 0; idx < submitted_count; idx++) {
            candidate_t submitted = top_data[idx];
            distance_t inter_result_dist = inter_neighbor_distance_(candidate, submitted, ...);
            if (inter_result_dist < candidate.distance) { good = false; break; }
            // 若某已入选者到 candidate 比candidate 到 query 还近 → 已入选者是"替身" → 淘汰
        }
        if (good) top_data[submitted_count] = top_data[consumed_count], submitted_count++;
        consumed_count++;
    }
    top.shrink(submitted_count);
}
```

保留边当且仅当"不存在更近的已提交邻居"。效果是入选节点互相远离、方向多样化——这是 HNSW 区别于朴素 KNN 图（每点连 k 近邻）的核心：多样性保证图在长距离跳转时可导航，而朴素 KNN 图会困在簇内。注意两处使用不同的容量：新节点正向边用上层 `connectivity`（`form_links_to_closest_` in `index.hpp:4302`），反向重建邻居表用 `level ? connectivity : connectivity_base`（`index.hpp:4323`）——0 层允许更多边。

### search()：无锁 beam search

`search()` 本体（`index.hpp:3428`）很薄，真正的工作在 `search_to_find_in_base_`（`index.hpp:4662`）：

```cpp title="include/usearch/index.hpp:4662（核心循环节选）"
while (!next.empty()) {
    candidate_t candidate = next.top();
    if ((-candidate.distance) > radius && top.size() == top_limit)
        break;                                  // 剪枝：最近待扩展点已劣于 top 最差者
    next.pop();
    for (compressed_slot_t successor_slot : neighbors_base_(node_at_(candidate.slot))) {
        if (visits.set(successor_slot)) continue;          // 哈希集去重
        distance_t successor_dist = context.measure(query, citerator_at(successor_slot), metric);
        if (top.size() < top_limit || successor_dist < radius) {
            next.insert({-successor_dist, successor_slot}); // 负距离 → max-heap 当 min-heap
            if (is_dummy<predicate_at>() || predicate(member_cref_t{...})) {
                top.insert({successor_dist, successor_slot}, top_limit);
                radius = top.top().distance;
            }
        }
    }
}
```

两个决策。**读不加锁**（`index.hpp:4658-4659` 注释："Doesn't lock any nodes, assuming read-only simultaneous access"）依赖两个不变量：`neighbors_ref_t::push_back`（`index.hpp:2461-2465`）**先写 slot 再增 count**，读者要么看到旧 count、要么看到完整新条目，不会读到半写数据；近似搜索本身容忍瞬时状态。**谓词不挡遍历**：不满足 predicate 的 successor 仍进 `next` 被扩展，只是不进 `top`——过滤后图的可导航性不受影响，这是 filtered search 召回率的关键保障（对比"只遍历满足谓词的节点"的方案，那种做法会在谓词稀疏时把图割裂）。

### update() 与悬边取舍

`update()`（`index.hpp:3330`）复用原 slot 重连边，与 add 的差异集中在 `search_to_update_`（`index.hpp:4568`）：候选与 successor 都排除 `updated_slot` 自身；遍历中抢不到节点锁时**直接跳过**（`node_try_conditional_lock_` at `index.hpp:4284`）——`index.hpp:4612-4615` 注释坦承这是"good enough"方案：赌对方线程稍后会在 `form_reverse_links_` 里把这条边补回来。

一个诚实的已知取舍：`update()` 清空旧邻接表前有一段被注释掉的 TODO（`index.hpp:3391-3393`，`// for (compressed_slot_t slot : neighbors_(updated_node, level)) remove_link_(slot, updated_slot, level);`）——本应遍历旧邻居用 `remove_link_` 删反向边，**当前实现不删**。被更新节点的旧邻居仍指向它，形成悬边；HNSW 里悬边无害于正确性（搜索时按 key 谓词过滤）只影响效率。源码里的真实 TODO 是"工程现实 vs 论文理想"的注脚。`member_iterator_t`（`index.hpp:2291`）是 update 的入参——指向待更新 slot 的轻量迭代器，避开"先查 key 再改"的两步竞态。

### join()：稳定婚姻做索引匹配

`index.hpp:4877` 的 `join()` 把两个索引的一对一匹配建模为 Gale-Shapley：若女方少则递归交换（`index.hpp:4891`，保证少数侧先求婚、每个求婚代价更小）；`max_proposals = min(men.size(), log(men.size()) + executor.size())` 控制近似度。数据结构分工：`ring_gt<compressed_slot_t>` 的 `free_men` 队列装待求婚男性、`bitset_t` 的 `men_locks`/`women_locks` 做双方行锁（`index.hpp:4928-4949`）、`join_result_t`（`index.hpp:4839`）聚合 intersection_size/engagements/统计。最巧的一处复用：求婚时用 `women.search(value, 已求婚次数, ...)` 搜索，`candidates.back()` 取第 N 近者——**wanted=已求婚次数让"下一个求婚对象"恰好是还没求过的最优者**（`index.hpp:4990+4998`），无需记录已求列表。husband 更远则休夫（回 free_men 队），否则求婚者回队。

### 序列化与 view

图段布局（`save_to_stream` in `index.hpp:3692`）：`[5×uint64 头][level_t × N 层数组][变长 node tape × N]`。**两遍式**设计（注释 `index.hpp:3715-3717`）：先导出层数数组，load/view 时据此算出每个节点的文件偏移。`view()`（`index.hpp:3930`）手工 exclusive_scan 算 offset（注释 `index.hpp:3956`：本可用 `std::exclusive_scan`，但那是 C++17），然后 `nodes_[i] = node_t{file.data() + offsets[i]}`——节点直接指向 mmap，`viewed_file_` 持有映射，`is_immutable()` 为 true 后 add/update 直接拒绝。`index_serialized_header_t`（`index.hpp:2148`）刻意只有 5 个字段：`size`、`connectivity`、`connectivity_base`、`max_level`、`entry_slot`——不含 metric/key 类型（这些归上层 `index_dense_head_t` 管），也不含容量（注释 `index.hpp:2142-2146`：所以加载后必须重新 `reserve`）。`serialized_length()`（`index.hpp:3738` 一带）用 `node_bytes_(level)` 逐层累加出精确总长，`load_from_stream`/`view` 则反向消费同一段流。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Tape allocator | `node_make_` in `index.hpp:4205` + 文档 2212-2215 | 节点永不单独释放，`clear()` 整块丢弃 |
| Per-thread context | `context_t` in `index.hpp:2487` | 搜索热路径零堆分配；结果直接引用 context 缓冲（文档 3420："Valid until next search()/add()/cluster()"） |
| Duck-typing 策略 | `dummy_*_t` + `is_dummy<>` `index.hpp:1761-1864` | 空策略编译期消除（如 4448 的 prefetch 分支） |
| RAII 轻量句柄 | `node_t`/`node_lock_t`/`output_file_t` | 无异常哲学：析构即释放，错误走返回值 |
| 溢出安全算术 | `checked_mul` 等 `index.hpp:195-256` | 容量乘法全部带溢出检测 |
| expected 错误处理 | `expected_gt` in `index.hpp:529` | Release 下全 noexcept，错误值语义传递 |

## 模块间交互

被 `index_dense.hpp` 通过 `typed_` 指针独占持有，装配点是 `index_dense.hpp:428-430`：`index_gt<distance_punned_t, vector_key_t, compressed_slot_t, aligned_allocator_gt<byte_t,64>, memory_mapping_allocator_gt<64>>`。`index_dense.hpp` 的 `metric_proxy_t` 实现 5 个 `operator()` 重载满足 metric duck-typing 契约，把 `member_cref_t` 经 `vectors_lookup_` 翻译成 `byte_t*` 再调 punned metric——引擎因此对向量精度一无所知。反向：`index_plugins.hpp:11` include 本文件（取 `expected_gt`/宏），但引擎不消费 plugins 的任何东西。

## 扩展方式

- **新增一种距离/值类型**：引擎零改动。punned 路径在 index_plugins 加 scalar 与 metric 分发；非 punned 用户直接传自定义 callable 给 `add/search`——引擎对"值"毫无概念，这是文档注释 `index.hpp:2192-2194` 明示的用法。
- **新增图遍历操作**：照 `cluster()` 的模式（`search_for_one_` 下降 + `context.measure` 收尾）；只读遍历用公开的 `neighbors_view_t`（`index.hpp:2726`），注意其别名节点邻接表、仅在无并发 mutation 时有效。
- **调节超参**：`index_config_t`（`index.hpp:1607`）的 connectivity/connectivity_base 与 `index_update_config_t::expansion`——影响链：`pre_.neighbors_bytes`（每节点 tape 尺寸）→ 内存；`top_limit`（`index.hpp:3207`）→ 构建质量/时间；search 的 expansion → 召回/延迟。connectivity < 2 被 `validate()`（`index.hpp:1634`）拒绝（"index degenerates into ropes"）。

并发与锁的正确性论证（striped locks 的 Fibonacci 散列、写序不变量、锁层级）单独展开在[并发与锁设计](/vibe-reading/articles/Database/Misc/USearch/CodeWiki/2.26.2/01-core-concurrency)。
