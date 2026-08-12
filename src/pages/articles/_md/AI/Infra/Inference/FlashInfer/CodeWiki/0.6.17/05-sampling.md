---
source:
  type: "源码解读"
  project: "FlashInfer"
  url: "https://github.com/flashinfer-ai/flashinfer"
title: "采样算子"
date: "2026-08-12T15:50:29+08:00"
category: [AI, Infra, Inference, FlashInfer, CodeWiki, "0.6.17"]
tags: ["FlashInfer", "Sampling", "TopK", "TopP", "SpeculativeDecoding", "SortingFree"]
description: "FlashInfer 采样算子解读：sorting-free 设计（radix select + CDF scan 替代排序）、AIR Top-P、chain speculative sampling、变长 top-k。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/00-overview)

---

## 模块定位

采样算子模块负责 LLM 推理的最后一步——从 logits 采样 token。核心卖点是 **sorting-free**：用 radix select + CDF scan（前缀和扫描）替代全局排序，把 Top-K/Top-P 采样的复杂度从 O(d log d) 降到 O(d × NUM_ROUNDS) 或 O(d)。支持 Top-K、Top-P、Min-P、Top-K+Top-P 联合采样，以及 speculative decoding 的 chain sampling（draft-target 接受/拒绝）。算法实现主要在 C++ 头文件 `include/flashinfer/sampling.cuh`、`topk.cuh`、`air_top_p.cuh`，Python wrapper 在 `flashinfer/sampling.py`。

模块边界：采样管"从概率分布选 token"，不管 logits 怎么来（模型前向产出）、不管 KV-cache 管理。`softmax`（logits→probs）也在本模块，因它是采样的前置步骤。

## 模块架构

采样模块分三层：**Python wrapper 层**（`sampling.py`，通过 `@register_custom_op` 注册为 torch custom op，支持 `torch.compile`）；**C++ binding 层**（`csrc/sampling.cu`、`csrc/renorm.cu`、`csrc/flashinfer_sampling_binding.cu`，经 JIT 编译）；**CUDA Kernel 层**（`include/flashinfer/sampling.cuh` 等头文件，模板化 kernel）。两个独立 JIT module：`sampling`（采样 + renorm kernel）和 `topk`（radix top-k + fast cluster top-k）。

核心设计思想统一：**不排序，直接在原始 logits 顺序上操作**。三种替代排序的技术：(1) **Radix Select**（Top-K）——把 float 转 "ordered" 整数表示，逐字节（每轮 8 bits）做 histogram + suffix sum 定位第 k 大；(2) **迭代二分搜索**（Top-P/Top-K Sampling）——不显式找 top-k 集合，而是二分搜索 threshold，每轮 BlockReduce 计数；(3) **CDF Scan**（`DeviceSamplingFromProb`）——直接做 inclusive 前缀和，找第一个 CDF 超过随机数 u 的位置。

## 调用链路

```
用户调用 flashinfer.top_k_sampling_from_probs(probs, ...)    [sampling.py:1096]
  └── get_sampling_module().top_k_sampling_from_probs(...)    [sampling.py:280]
       └── module.top_k_sampling_from_probs(...)              [JIT 编译的 C++ op]
            └── TopKSamplingFromProbKernel<<<>>>               [sampling.cuh:849]
                 ├── 循环: DeviceSamplingFromProb()            [sampling.cuh:579]
                 │    (predicate = x > low, 过滤阈值以下 prob)
                 ├── 二分搜索 pivot_0, pivot_1                  [sampling.cuh:915-970]
                 │    (BlockReduce 计数 > pivot 的 prob 之和)
                 └── 收敛后输出 sampled_id

flashinfer.top_p_renorm_probs(probs, top_p)                   [sampling.py:1742]
  └── module.top_p_renorm_probs(...)                          [csrc/renorm.cu:26]
       ├── if vocab_size < 2048 (NUM_BUCKETS):
       │    └── TopPRenormProbKernel (ternary search)          [sampling.cuh:1672]
       └── else:
            └── AirTopPRenormProb()                            [air_top_p.cuh:493]
                 ├── AirTopPRenormInitKernel                    [air_top_p.cuh:407]
                 ├── for pass in 0..NUM_PASSES:
                 │    └── AirTopPRenormRadixKernel              [air_top_p.cuh:284]
                 └── AirTopPRenormApplyKernel                   [air_top_p.cuh:434]
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `softmax` (`sampling.py:71`) | logits → probs | 两趟 online softmax |
| `sampling_from_logits` (`sampling.py:105`) | 直接从 logits 采样 | Gumbel-max trick，免排序 |
| `top_k_sampling_from_probs` (`sampling.py:280`) | Top-K 采样 | 迭代二分 + CDF scan |
| `top_p_sampling_from_probs` (`sampling.py:214`) | Top-P 采样 | 同上，threshold 用 top_p |
| `min_p_sampling_from_probs` (`sampling.py:344`) | Min-P 采样 | max × min_p 阈值 |
| `top_p_renorm_probs` (`sampling.py:482`) | Top-P 归一化 | 双路径：ternary vs AIR |
| `chain_speculative_sampling` (`sampling.py:594`) | speculative 接受/拒绝 | relu(q-p) 残差采样 |
| `DeviceSamplingFromProb` (`sampling.cuh:579`) | CDF scan 采样原语 | atomicMin 找最小满足 index |

</details>

## 核心实现

### Sorting-Free 三技术

**Radix Select（Top-K）**（`topk.cuh:651` `RadixSelectFromSharedMemory`）：把 float/half 转 "ordered" 整数表示（`topk_common.cuh:35` `ToOrdered`），逐字节（每轮 8 bits）做 histogram + suffix sum 定位第 k 大元素的 pivot。`NUM_ROUNDS = sizeof(OrderedType)*8/8`（float 需 4 轮，half 需 2 轮）。替代了 O(n log n) 排序，只需 O(n × NUM_ROUNDS) 的多轮 histogram。Multi-CTA 协作（`topk.cuh:139` `RadixRowState`）用三缓冲 histogram + 软件 barrier（`arrival_counter`）跨 CTA 同步，`ld_acquire`/`st_release` PTX asm 保证内存序，最后退出的 CTA 负责重置状态（`topk.cuh:204`，避免 issue #3610 死锁）。

**迭代二分搜索（Top-P/Top-K Sampling）**（`sampling.cuh:849` `TopKSamplingFromProbKernel`、`:982` `TopPSamplingFromProbKernel`）：不显式找 top-k 集合，而是二分搜索 threshold。每轮用 `BlockReduce` 计算大于两个 pivot 的 prob 之和，根据 sum 与 top_p（或 count 与 top_k）的关系缩窄区间，通常 2-5 轮收敛。收敛后用 `DeviceSamplingFromProb` 做 CDF scan 采样。

**CDF Scan（DeviceSamplingFromProb）**（`sampling.cuh:579`）：直接在原始 logits 顺序上做 `BlockScan` inclusive CDF，`atomicMin(&temp_storage->sampled_id, ...)` 找第一个 CDF 超过随机数 u 的 index。O(d) 完成采样，无需排序。

### AIR Top-P

AIR（Adaptive Iteration Reduction，源自 TensorRT-LLM，`air_top_p.cuh:17`）用于大 vocab 的 Top-P renorm。核心算法（`air_top_p.cuh:284` `AirTopPRenormRadixKernel`）：多 pass radix select，每 pass 11 bits（`NUM_BUCKETS=2048`），逐 pass 缩小搜索范围。`CalcAirTopPBlockNum`（`air_top_p.cuh:461`）根据 vocab_size 和 SM 数量自适应选 block 数，优化 wave 利用率（tail wave penalty < 0.15）。最后一个 block（`atomicInc(&counter->finishedBlockCnt)` 检测）做 prefix sum 和 threshold 定位。`Counter` 结构（`air_top_p.cuh:53`）维护 `sum`（剩余概率质量）、`len`（剩余元素数）、`kthValueBits`，跨 pass 传递。**为什么比 ternary search 快**：AIR 用 radix histogram 一次性分到 2048 桶，每 pass 淘汰大量元素；ternary search（`sampling.cuh:1672`）每轮只缩窄 1/3，需更多轮全量扫描。双路径选择（`csrc/renorm.cu:44`）：`vocab_size < 2048` 时 radix 桶数过多反而浪费，回退 ternary search。

### Speculative Decoding Chain Sampling

`ChainSpeculativeSampling`（`sampling.cuh:1869`）用 modified rejection sampling：(1) **接受阶段**（行 1892-1904）逐个检查 draft token，`u * p < q` 判接受（p=draft prob, q=target prob），接受则输出 draft token，首个拒绝时 break；(2) **统计阶段**（行 1908-1916）继续检查剩余 draft token 统计 accepted_num；(3) **残差采样**（行 1924-2004）从 `relu(target_probs - draft_probs)` 分布采样 bonus token——第一趟 BlockReduce 算 `sum(relu(q-p))`，第二趟 `DeviceSamplingFromProb` 做 CDF scan 采样。**为什么用 relu(q-p)**：standard speculative sampling 的残差分布，保证从 `max(0, q-p)` 采样的 token 分布等价于直接从 target distribution 采样。

### Deterministic 模式

`RadixCollectIndicesDeterministic`（`topk.cuh:1017`）用 `DeterministicThreadStridedCollect` 替代 `atomicAdd` 收集 top-k 索引，每个 CTA 按固定顺序输出，保证可重复性。`DeterministicInclusiveSum`（`sampling.cuh:195`）用 Belloch scan 替代 `cub::BlockScan` 实现确定性前缀和。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Sorting-free（radix + scan） | `DeviceSamplingFromProb` in `sampling.cuh:579` | 降复杂度，单 pass/少 pass 流式访问 |
| Multi-CTA 协作 | `RadixRowState` + 软件 barrier in `topk.cuh:139` | 跨 CTA 同步做 radix select |
| 双路径选择 | `csrc/renorm.cu:44` | 小 vocab 用 ternary，大 vocab 用 AIR |
| 策略（Deterministic vs 快速） | `RadixCollectIndicesDeterministic` in `topk.cuh:1017` | 可重复性 vs 速度权衡 |
| Custom Op 注册 | `@register_custom_op` in `sampling.py` | 支持 torch.compile |

## 模块间交互

JIT 编译：`get_sampling_module()`（`sampling.py:67`）调 `gen_sampling_module()`（`jit/sampling.py:21`）→ `gen_jit_spec("sampling", ["csrc/sampling.cu", "csrc/renorm.cu", "csrc/flashinfer_sampling_binding.cu"])`。`get_topk_module()`（`topk.py:65`）独立编译。两个 module 都 `@functools.cache`。

被推理引擎调用：通过 `flashinfer/__init__.py` 导出为顶层 API（`__init__.py:206`）。典型用法：模型前向 → `flashinfer.softmax()` → `flashinfer.top_k_mask_logits()` → `flashinfer.top_p_sampling_from_probs()` → token。speculative 场景：`flashinfer.chain_speculative_sampling()` 做 draft-target 接受/拒绝。

## 扩展方式

新增采样策略（如 Top-A，保留 prob ≥ a × max_prob 的 token）：参考 `MinPSamplingFromProbKernel`（`sampling.cuh:1108`）——先 `GetMaxValue` 找 max，算 `pivot = max_val × a`，用 `DeviceSamplingFromProb` 做 CDF scan 采样。修改：`include/flashinfer/sampling.cuh` 加 kernel + host launcher；`csrc/sampling.cu` 加 binding；`flashinfer/sampling.py` 加 `@register_custom_op` + 公共 API + `SimpleNamespace` 导出；`flashinfer/__init__.py` 导出；`flashinfer/trace/templates/sampling.py` 加 trace template。若需 renorm 变体，`csrc/renorm.cu` 加 `top_a_renorm_probs` + `sampling.cuh` 加 `TopARenormProbKernel`（参考 `TopPRenormProbKernel` ternary search）。

> **注**：用户提到的 `flashinfer/topk_varlen/` 目录在 v0.6.17 不存在。变长 top-k 已整合到 `flashinfer/topk.py` 的 `radix_topk_ragged_transform`（`topk.py:303`）和 `radix_topk_page_table_transform`（`topk.py:250`），通过 `RadixTopKMode::RaggedTransform` / `PageTableTransform` 模板参数支持变长输入。
