---
title: "C++ 性能优化实践"
source:
  project: "xLLM"
  type: "PR"
  id: "1041-1103"
  url: "https://github.com/jd-opensource/xllm/pull/1041"
  prType: "perf"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["C++ 性能优化", "容器", "unordered_map", "vector", "emplace_back", "move semantics"]
description: "系统梳理 xLLM 六次容器性能优化：有序容器换无序、循环外复用 vector、提前 reserve、emplace_back 原位构造、移动迭代器——从原理到代码，附 quick-bench 实测数据。"
readingTime: "16 min"
aiModel: "Claude Opus 4.8"
---

> **系列 PR** [#1041](https://github.com/jd-opensource/xllm/pull/1041) · [#1048](https://github.com/jd-opensource/xllm/pull/1048) · [#1088](https://github.com/jd-opensource/xllm/pull/1088) · [#1089](https://github.com/jd-opensource/xllm/pull/1089) · [#1097](https://github.com/jd-opensource/xllm/pull/1097) · [#1103](https://github.com/jd-opensource/xllm/pull/1103) · **首发版本** v0.9.0 / v0.10.0 · **变更行数** +170 行 · **时间跨度** 2026-03-12 ~ 2026-03-31

---

## 背景

LLM 推理服务的内层循环对延迟极度敏感。xLLM 在 2026 年 3 月连续合并了六个 `perf:` 前缀的 PR，每一个都只改动容器相关的一个习惯——但每一个都有 [quick-bench.com](https://quick-bench.com) 的实测数据支撑，不是"应该更快"而是"测出来更快"。

六个 PR 涵盖了 C++ 容器性能优化的主要方向：

| PR | 核心改动 | 首发 |
|---|---|---|
| #1041 | `std::map` → `std::unordered_map` | v0.9.0 |
| #1048 | `std::set` → `std::unordered_set` | v0.9.0 |
| #1088 | 循环外复用 vector，`.clear()` 替代重建 | v0.9.0 |
| #1089 | `push_back` 前调用 `reserve` | v0.10.0 |
| #1097 | `push_back({...})` → `emplace_back(...)` | v0.10.0 |
| #1103 | `insert(begin, end)` → 移动迭代器 | v0.9.0 |

下文每个 PR 一节，给出原理、代码、quick-bench benchmark 链接与实测对比图。

---

## 实现

### PR #1041：`std::map` → `std::unordered_map`

**原理**：`std::map` 基于红黑树，插入/查找/删除均为 O(log n)，每次操作伴随指针追逐带来的 cache miss。`std::unordered_map` 基于哈希表，平均 O(1)。前提是代码不依赖有序遍历。

**Benchmark**：作者用 quick-bench 对比 `map` 与 `unordered_map` 的插入和迭代性能——

- 测试链接：<https://quick-bench.com/q/dzdKy7W0Vs05kwr3ICLLzXQIziw>

插入性能对比（`unordered_map` 显著快于 `map`）：

![map vs unordered_map 插入性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1041-insert.png)

迭代性能对比：

![map vs unordered_map 迭代性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1041-iteration.png)

图中蓝条为 `std::map`，绿条为 `std::unordered_map`，纵轴为单次操作耗时（ns，越低越好）。整数 key 场景下 `unordered_map` 的插入和迭代都有数倍提升。

**代码改动**（`xllm/core/framework/batch/batch.cpp`）：

`cal_seq_exchange_index` 在 NPU 上计算序列重排索引：给定 KV cache token 数量，返回"原序列 → 重排后位置"的映射。映射 key 是 `uint32_t` 序列索引，调用方只用 `operator[]` 随机访问，不需要有序遍历。

```cpp title="xllm/core/framework/batch/batch.cpp（PR #1041 前后对比）"
// 改前
std::map<uint32_t, uint32_t> Batch::cal_seq_exchange_index(
    const std::vector<uint32_t>& kv_cache_tokens_num) {
  std::map<uint32_t, uint32_t> index_shift;
  // ...
  index_shift[idx] = i + j * num_npu_cores;
  return index_shift;
}

// 改后
std::unordered_map<uint32_t, uint32_t> Batch::cal_seq_exchange_index(
    const std::vector<uint32_t>& kv_cache_tokens_num) {
  std::unordered_map<uint32_t, uint32_t> index_shift;
  // ...
  index_shift[idx] = i + j * num_npu_cores;
  return index_shift;
}
```

key 是连续整数，hash 计算极廉价（通常直接取模），换成 `unordered_map` 是收益最大、风险最小的改法。`batch.h` 中两个相关声明同步更新。

---

### PR #1048：`std::set` → `std::unordered_set`

**原理**：同 #1041，`std::set` 红黑树 O(log n) → `std::unordered_set` 哈希表 O(1)。适用前提是只做成员查询（`count` / `find`），从不需要有序迭代。

**Benchmark**：

- 测试链接：<https://quick-bench.com/q/95CoBluJBvYVw0xLkqEuqtDshsQ>

![set vs unordered_set 性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1048-set.png)

图中对比了 `set` 与 `unordered_set` 的操作耗时，`unordered_set` 在查找/插入上明显占优。

**代码改动**（12 处替换，覆盖 8 个文件）。代表性案例：

`qwen2_attention.cpp` 静态模型类型集合——每次 `count` 调用从 O(log n) 树查找变为 O(1) 哈希查找：

```cpp title="xllm/core/layers/common/qwen2_attention.cpp"
// 改前：每次 count 调用都是 O(log n) 树查找
static const std::set<std::string> qwen3_type_set = {
    "qwen3", "qwen3_moe", "qwen3_vl", ...};

// 改后：O(1) 哈希查找
static const std::unordered_set<std::string> qwen3_type_set = {
    "qwen3", "qwen3_moe", "qwen3_vl", ...};
```

`page_allocator.h` 已分配虚拟页面集合：

```cpp title="xllm/core/framework/xtensor/page_allocator.h"
// 改前：O(log n) 插入/查找
std::set<int64_t> allocated_virt_page_list;

// 改后：O(1) 平均
std::unordered_set<int64_t> allocated_virt_page_list;
```

`siglip_encoder_loader.cpp` 权重名查重、`rec_vocab_dict` 的 token 集合、`disagg_pd_scheduler` 的请求集合等——所有替换点的共同特征是只做成员查询，从不需要有序迭代。

---

### PR #1088：循环外复用 vector

**原理**：在热循环里声明 `std::vector<T>`，每次迭代都触发堆分配（构造）和释放（析构）。把 vector 提到循环外，每次迭代只调用 `.clear()`——`.clear()` 把 `size` 归零但保留已分配的 `capacity`，下次 `push_back` 不需要重新分配。

```
迭代 1：分配 N 个元素的内存
迭代 2：.clear() → 重用，无分配
迭代 3：.clear() → 重用，无分配
...
```

**Benchmark**：

- 测试链接：<https://quick-bench.com/q/htAFq9zePzxUXXlWMZUwfx6axEI>

![循环内 vs 循环外 vector 性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1088-reuse.png)

对比"循环内每次重建 vector"与"循环外复用 + `.clear()`"，后者耗时大幅下降——堆分配/释放的开销被消除。

**代码改动**（5 个文件，统一模式）。`batch.cpp` beam search 中的临时 vector：

```cpp title="xllm/core/framework/batch/batch.cpp"
// 改前：每次 beam search 步骤都重建
for (int step = 0; step < num_steps; ++step) {
  std::vector<std::vector<int32_t>> group_flat2d;
  group_flat2d.reserve(static_cast<size_t>(beam_width));
  std::vector<float> last_logprobs;
  last_logprobs.reserve(static_cast<size_t>(beam_width));
  // ... 使用 group_flat2d, last_logprobs
}

// 改后：提到循环外，复用堆内存
std::vector<std::vector<int32_t>> group_flat2d;
std::vector<float> last_logprobs;
group_flat2d.reserve(static_cast<size_t>(beam_width));
last_logprobs.reserve(static_cast<size_t>(beam_width));
for (int step = 0; step < num_steps; ++step) {
  group_flat2d.clear();
  last_logprobs.clear();
  // ... 使用 group_flat2d, last_logprobs
}
```

注意 `reserve` 也提到了循环外——`capacity` 一旦分配好，后续 `.clear()` 不改变它，无需每次重复 `reserve`。

`continuous_scheduler.cpp` 和 `pd_ooc_scheduler.cpp` 的调度主循环：

```cpp title="xllm/core/scheduler/continuous_scheduler.cpp"
// 改后：调度器主循环——每个 decode step 都执行一次，这里优化与吞吐量直接相关
std::vector<Sequence*> candidate_sequences;
std::vector<size_t> candidate_token_budgets;
while (has_pending()) {
  candidate_sequences.clear();
  candidate_token_budgets.clear();
  // 填充并使用
}
```

`eplb_manager.cpp` 的 EPLB 层负载向量、`rec_worker_impl.cpp` 的 position_buffer 同样应用此模式。对 `torch::Tensor` 类型的 vector，`.clear()` 调用 Tensor 析构（减引用计数），但不释放 vector 本身的 `capacity`。

---

### PR #1089：提前 `reserve`

**原理**：`std::vector` 在 `push_back` 时若 `size == capacity` 触发扩容——分配 `2 × capacity` 新内存、移动所有元素、释放旧内存。均摊 O(1) 但每次扩容有实际 `malloc`/`free` 开销，还破坏内存局部性。若已知最终大小（或合理上界），提前 `reserve` 可消除所有中间扩容。

**Benchmark**：

- 测试链接：<https://quick-bench.com/q/TSJZHhqHSA2IV9o95Hhc1ydA3gA>

![push_back 有无 reserve 性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1089-reserve.png)

对比 `push_back` 有无 `reserve` 的耗时，预先 `reserve` 消除了多次扩容的 `malloc`/`free` 和元素搬移开销。

**代码改动**（6 个文件，+41 行，纯增量无逻辑变更）。`dit_batch.cpp` 为 9 个向量提前预分配 `batch_size` 容量：

```cpp title="xllm/core/framework/batch/dit_batch.cpp"
// 9 个向量提前预分配 batch_size 容量
prompt_embeds.reserve(batch_size);
pooled_prompt_embeds.reserve(batch_size);
negative_prompt_embeds.reserve(batch_size);
negative_pooled_prompt_embeds.reserve(batch_size);
images.reserve(batch_size);
mask_images.reserve(batch_size);
control_images.reserve(batch_size);
latents.reserve(batch_size);
masked_image_latents.reserve(batch_size);
```

`mooncake_transfer_engine.cpp` 的 upper bound 是精确的——循环体每次追加固定数量条目：

```cpp title="xllm/core/framework/kv_cache/mooncake_transfer_engine.cpp"
entries.reserve(addr_ids.size() * merged_src_blocks.size() * 2);
```

`sampling_params.cpp` 的采样参数组装、`model_input_params.h` 的 KV cache 参数、`params_utils.cpp` 的 block_tables 等 8 个向量、`profile_manager.cpp` 的序列列表均按已知上界 `reserve`。

> **注意**：`reserve` 只对 `push_back` / `emplace_back` 有用；若后续用 `resize` 或直接下标访问，`reserve` 无益。

---

### PR #1097：`emplace_back` 原位构造

**原理**：

```cpp
// push_back 路径
v.push_back({a, b});
//          ↑ 先构造临时 T{a, b}，再调用 T 的移动/拷贝构造放进 vector

// emplace_back 路径
v.emplace_back(a, b);
//             ↑ 直接在 vector 内部内存位置 in-place 构造 T(a, b)
//               省去临时对象 + 一次移动/拷贝构造
```

对于 trivially-movable 类型（如 `std::pair<int, int>`），现代编译器通常已优化掉临时对象，两者无差别。但对于持有堆资源的类型（`std::string`、`torch::Tensor`、自定义类），`emplace_back` 可节省一次深拷贝或引用计数操作。

**Benchmark**：

- 测试链接：<https://quick-bench.com/q/L8c2ixlqLXT3TwZTQWK_026dSY4>

![push_back vs emplace_back 性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1097-emplace.png)

对比 `push_back` 与 `emplace_back` 在构造非 trivial 类型时的耗时差异。

**代码改动**（8 个文件，13 处替换）。最典型——`minicpmv.h` 消除 `make_tuple` 临时对象：

```cpp title="xllm/models/vlm/npu/minicpmv.h"
// 改前：make_tuple 构造临时对象
mlps_.push_back(std::make_tuple(lni, cpl, act, rpl));

// 改后：直接原位构造
mlps_.emplace_back(lni, cpl, act, rpl);
```

`api_service.cpp` 和 `worker_service.cpp` 的 `WeightSegment`：

```cpp title="xllm/api_service/api_service.cpp"
// 改前：brace-init 临时对象
segments.push_back({proto_seg.offset(), proto_seg.size()});

// 改后：原位构造
segments.emplace_back(proto_seg.offset(), proto_seg.size());
```

`page_allocator.cpp` 的 `std::pair` + `std::move`、`xtensor_allocator.cpp` 的 `WeightSegment`、`pipeline_longcat_image.h` 和 `pipeline_longcat_image_edit.h` 的 `std::pair<T, bool>` 均作同样替换。

---

### PR #1103：移动迭代器

**原理**：把一个 vector 的内容追加到另一个 vector：

```cpp
// 拷贝插入：O(n) 次拷贝构造
dst.insert(dst.end(), src.begin(), src.end());

// 移动插入：O(n) 次移动构造
dst.insert(dst.end(),
           std::make_move_iterator(src.begin()),
           std::make_move_iterator(src.end()));
```

`std::make_move_iterator` 将普通迭代器包装成移动迭代器——每次解引用返回右值引用，触发移动构造而非拷贝构造。对持有堆资源的对象（`std::string`、`torch::Tensor`），拷贝是 O(data_size) 深拷贝，移动是 O(1) 指针转移。

**Benchmark**：

- 测试链接：<https://quick-bench.com/q/XJQNDSqc2_vKxDcvy4nbWvZy8TQ>

![insert 拷贝 vs 移动迭代器性能对比](/vibe-reading/images/articles/xllm-pr-1041-1103-vector-optimization/pr1103-move.png)

对比 `insert` 使用普通迭代器（拷贝）与移动迭代器的耗时，移动路径显著更快。

**代码改动**（4 个文件，5 处替换）。`deepseekv32_detector.cpp` function call 解析结果合并——`parsed_calls` 是函数体内的临时局部向量，合并到 `calls` 后不再访问，完全符合移动前提：

```cpp title="xllm/function_call/deepseekv32_detector.cpp"
// 改前：拷贝插入 parsed_calls 到 calls
calls.insert(calls.end(), parsed_calls.begin(), parsed_calls.end());

// 改后：移动插入，parsed_calls 后续不再使用
calls.insert(calls.end(),
             std::make_move_iterator(parsed_calls.begin()),
             std::make_move_iterator(parsed_calls.end()));
```

同样的改法在 `glm45_detector.cpp`、`glm47_detector.cpp` 各 1 处。

`pipeline_longcat_image.h` 的 token 批次合并——只有一个元素，用 `push_back(std::move(...))` 而非移动迭代器：

```cpp title="xllm/models/dit/pipelines/pipeline_longcat_image.h"
// 改前
batch_all_tokens.push_back(all_tokens);

// 改后：all_tokens 是本轮循环的临时局部变量
batch_all_tokens.push_back(std::move(all_tokens));
```

`std::move` 把 `all_tokens` 的内部缓冲区直接转给 `batch_all_tokens` 的新元素，避免拷贝整个 token 序列。

---

## 意义与影响

### 为什么这些改动值得做

推理服务的每个 decode step 都会执行调度器、KV cache 管理、采样参数组装等逻辑——这些代码在 10K QPS 下每秒执行 10K 次。微小的单步开销会被放大到影响吞吐量的量级。

### 六种优化的适用场景总结

| 优化 | 什么时候有效 | 什么时候无效 |
|---|---|---|
| `unordered_map/set` | key 不需要有序、hash 计算廉价 | 需要范围查询、key 是浮点数 |
| 循环外复用 vector | 循环体内的局部 vector 不跨迭代 | vector 元素持有循环外资源 |
| `reserve` | 已知或可估算最终大小 | 用 `resize` 或下标赋值 |
| `emplace_back` | 元素有构造函数参数（非 trivial）| trivially-copyable 类型（编译器已优化）|
| 移动迭代器 | 源 vector 后续不再使用 | 源数据还需要访问 |
| `push_back(std::move(...))` | 单元素、局部变量 | 元素不可移动或仍需使用 |

### 代码模式的可复制性

这六种优化都是**机械可识别**的：

- `std::map<K, V>` 且只做 `operator[]` / `count` → 候选 `unordered_map`
- 循环体内 `std::vector<T> v; v.reserve(N); for (...) v.push_back(...)` → 候选提到循环外
- `push_back` 前有确定数量的元素 → 候选 `reserve`
- `v.push_back({a, b})` → 候选 `v.emplace_back(a, b)`
- `dst.insert(dst.end(), src.begin(), src.end())` 且 `src` 后续无用 → 候选移动迭代器

这套识别 → 验证 → benchmark → 提交的流程，本身就是一份可以在任意 C++ 服务端代码库复用的性能审计清单。
