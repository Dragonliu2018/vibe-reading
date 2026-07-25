---
title: "在请求准入处拦截 fast-prefill × prompt_logprobs：补齐同步 LLMEngine 的校验缺口"
source:
  project: "vLLM"
  type: "PR"
  id: "49622"
  url: "https://github.com/vllm-project/vllm/pull/49622"
  prType: "fix"
date: "2026-07-25"
category: [AI, 推理, vLLM, Contributions]
tags: ["vLLM", "V1 Engine", "kv_sharing_fast_prefill", "prompt_logprobs", "YOCO", "Gemma3n", "Request Admission"]
description: "解读 PR #49622：为 vLLM V1 同步 LLMEngine 补齐 kv_sharing_fast_prefill 与 prompt_logprobs 的请求准入校验，让 LLM.generate() 用户在请求提交时即收到清晰 ValueError，而非在 GPU 执行深处撞上带笔误的 AssertionError；同时统一三处错误信息。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#49622](https://github.com/vllm-project/vllm/pull/49622) · **Issue** - · **commit** [da8016c9](https://github.com/vllm-project/vllm/commit/da8016c94ec14cbf138116052d67f33e3f6416a0) · **首发版本** - · **变更行数** +37 / -3 行（3 文件）· **合并时间** -（截至写作时仍处 Open 状态）

---

## 背景

vLLM 的 V1 引擎有两条请求入口，分别服务两种用法：

- **异步路径**（`AsyncLLM`，`vllm/v1/engine/async_llm.py`）：在线 `serve` 走这条路，请求由 `AsyncLLM.add_request()` 受理。
- **同步路径**（`LLMEngine`，`vllm/v1/engine/llm_engine.py`）：离线 / 批量 `LLM.generate()` 走这条路，请求由 `LLMEngine.add_request()` 受理。

`--kv-sharing-fast-prefill` 是为 YOCO、Gemma3n 等 **KV 共享模型** 加速 prefill 的特性（首发于 PR #22628）。它通过改写部分 attention 层的元数据，让符合条件的层在 prefill 阶段跳过若干 token 的计算。代价是：**它产出的 prompt token logprobs 是错的**，因此绝不能与 `prompt_logprobs` 同时使用。

问题出在两条路径的校验不对称：

- 异步路径早在 `AsyncLLM.add_request()` 的**请求准入**阶段就抛 `ValueError`，干净利落。
- 同步路径的 `LLMEngine.add_request()` **没有这层守卫**。

于是 `LLM.generate(..., SamplingParams(prompt_logprobs=5))` 的用户，请求会被正常受理、调度、下发到 worker，直到在 `GPUModelRunner` 执行深处撞上一条防御性 `assert`——而且那条断言的信息还带着笔误（`"prompt tokens, tokens,"`）。错误既晦涩，又发生在 GPU 执行脚手架已经搭好之后。

本 PR 做三件事：把异步路径已有的早 `ValueError` 搬到同步路径、修复断言笔误、让三处信息字节对齐，并补一条覆盖同步路径的回归测试。

---

## 前置知识

### kv_sharing_fast_prefill 改了什么

配置字段的 docstring 说得很清楚：

```python title="vllm/config/cache.py"
kv_sharing_fast_prefill: bool = False
"""In some KV sharing setups, e.g. YOCO (https://arxiv.org/abs/2405.05254),
some layers can skip tokens corresponding to prefill. This flag enables
attention metadata for eligible layers to be overridden with metadata
necessary for implementing this optimization in some models (e.g. Gemma3n)
NOTE: KV cache sharing is not supported for MRv2 (v2 model runner).
"""
```

关键词是 **override**：开启后，`GPUModelRunner` 在构造 attention 元数据时会调用 `_prepare_kv_sharing_fast_prefill()` 改写 `logits_indices`，并由 `make_kv_sharing_fast_prefill_common_attn_metadata()` 重建一份公共元数据。

### 为什么 prompt_logprobs 会错

看一眼这份被改写的公共元数据就明白了。`make_kv_sharing_fast_prefill_common_attn_metadata` 里的示例注释：

```python title="vllm/v1/attention/backends/utils.py"
# Example inputs
# num_reqs: 3
# generation_indices:  [14, 18, 19, 27]
# query_start_loc: [0, 15, 20, 28]
# seq_lens:        [41, 31, 40]
```

三个请求的序列长度是 41 / 31 / 40，但 fast-prefill 路径只为 **generation indices**（`[14, 18, 19, 27]`，即每个 prefill 请求里驱动下一步采样的那个位置）收集 logits——它根本不会为所有 prompt 位置算 logits。

而 `prompt_logprobs` 的语义恰恰是：**为每一个 prompt 位置给出 top-k 的对数概率**。`GPUModelRunner` 里收集 prompt logprobs 的逻辑也证实了这一点——它按 `num_prompt_tokens` 切片、对每个位置取 `num_prompt_logprobs + 1` 个分数。两边的索引范围根本对不上，prompt 位置拿不到有效 logits，结果自然是错的。

这就是“不兼容”的根因，也是为什么必须在算之前、而非算到一半时拦住它。

### 两条路径与两层校验

理解本 PR 的关键是区分“在哪一层校验”：

- **请求准入层**（`add_request`）：请求刚提交，还没进调度器、没碰 GPU。在这里抛错，用户看到的是一条清晰 `ValueError`，且没有任何资源被预占用。
- **执行层**（`GPUModelRunner`）：请求已被调度、下发到 worker，模型已加载、批已组装，正要进 kernel。在这里抛 `AssertionError`，用户要回溯整个调度链才能定位。

异步路径在准入层有守卫，同步路径只在执行层有一道防御性 `assert`——缺口就在这。

---

## 实现

### 1. 同步路径补上准入层 ValueError（核心改动）

在 `LLMEngine.add_request()` 里，紧接 `params = request.params` 解析完请求参数之后、`engine_core.add_request()` 把请求下发之前，插入校验：

```python title="vllm/v1/engine/llm_engine.py"
# Use cloned params that may have been updated in process_inputs()
params = request.params

# Validate incompatible feature combinations at request-admission time
# so the user gets a clear error before any GPU work begins.
if (
    self.vllm_config.cache_config.kv_sharing_fast_prefill
    and isinstance(params, SamplingParams)
    and params.prompt_logprobs
):
    raise ValueError(
        "--kv-sharing-fast-prefill produces incorrect logprobs for "
        "prompt tokens, please disable it when the requests need "
        "prompt logprobs"
    )

n = params.n if isinstance(params, SamplingParams) else 1
```

位置是刻意选的：

- **在 `process_inputs()` 之后**：`params` 已是克隆并可能被改写过的最终值，校验基于“真正要下发的参数”。
- **在 `engine_core.add_request()` 之前**：请求还没进 `EngineCore`，更没进调度器和 worker，没有任何 GPU 工作发生。失败是干净的早失败。

条件里的 `isinstance(params, SamplingParams)` 与异步路径的 `not is_pooling` 等价——`prompt_logprobs` 只在 `SamplingParams` 上有定义，`PoolingParams`（embedding / 池化任务）根本没有这个字段。`params.prompt_logprobs` 为 `0` / `None` 时判假，正好覆盖“用户没要 prompt logprobs”的常见情形。

### 2. 修复执行层断言的笔误并对齐信息

异步路径早就写对了信息，但执行层那道防御性 `assert` 留了个笔误——`"prompt tokens, tokens,"` 多打了一遍 `tokens,`：

```python title="vllm/v1/worker/gpu_model_runner.py"
if self.cache_config.kv_sharing_fast_prefill:
    assert not self.num_prompt_logprobs, (
        "--kv-sharing-fast-prefill produces incorrect logprobs for "
        "prompt tokens, please disable it when the requests need "
        "prompt logprobs"
    )
```

修复后，三处文本字节一致：

```text title="统一后的错误信息"
--kv-sharing-fast-prefill produces incorrect logprobs for prompt tokens, please disable it when the requests need prompt logprobs
```

执行层这道 `assert` 是**防御性兜底**，不是主要拦截点：现在准入层已经拦住，正常流程到不了这里；但留着它，万一将来有新路径绕过准入层，执行层还能再挡一次。

### 三处守卫对照

| 站点 | 文件:行 | 触发时机 | 失败类型 |
| --- | --- | --- | --- |
| 异步准入（已有） | `vllm/v1/engine/async_llm.py:305` | `AsyncLLM.add_request()` 请求准入 | 早 `ValueError` |
| 同步准入（新增） | `vllm/v1/engine/llm_engine.py:270` | `LLMEngine.add_request()` 请求准入 | 早 `ValueError` |
| 执行层兜底（修笔误） | `vllm/v1/worker/gpu_model_runner.py:4180` | `GPUModelRunner` 执行深处 | `AssertionError` |

前后对比：同步路径的用户从“请求被受理 → 调度 → 下发 → 执行深处撞带笔误的 `AssertionError`”，变成“`add_request()` 当场收到清晰 `ValueError`”。

---

## 测试

新增回归测试，专门覆盖同步 `LLMEngine` 路径（异步路径此前无对应测试）：

```python title="tests/v1/engine/test_llm_engine.py"
def test_kv_sharing_fast_prefill_rejects_prompt_logprobs():
    """prompt_logprobs is incompatible with --kv-sharing-fast-prefill.

    The check must fire at request-admission time (before any GPU work)
    in the sync LLMEngine path so users get a clear error immediately.
    """
    llm = LLM(
        model=MODEL,
        kv_sharing_fast_prefill=True,
        enforce_eager=True,
        dtype=DTYPE,
        max_model_len=128,
        gpu_memory_utilization=0.5,
    )
    with pytest.raises(ValueError, match="kv-sharing-fast-prefill"):
        llm.generate(
            "Hello, my name is",
            SamplingParams(prompt_logprobs=5, max_tokens=5),
        )
```

用最小可复现配置：`facebook/opt-125m` + `enforce_eager=True` + `gpu_memory_utilization=0.5`，只为触发校验，不在意输出。`pytest.raises(ValueError, match="kv-sharing-fast-prefill")` 同时验证了“抛 `ValueError`”与“信息含 `kv-sharing-fast-prefill`”两件事——后者正是三处对齐后的统一文本。

测试结果：

```text title="pytest 输出"
tests/v1/engine/test_llm_engine.py::test_kv_sharing_fast_prefill_rejects_prompt_logprobs PASSED [100%]
1 passed, 18 warnings in 33.00s
```

---

## 问题

**为什么不把校验集中到一处，而是三处分散？**

这本质上是 vLLM 两条引擎路径各自的请求受理逻辑独立演进的遗留：异步路径首发时（PR #22628）只在 `async_llm.py` 加了早 `ValueError`，同步路径被漏掉，只留了执行层兜底。集中到 `InputProcessor` 或一个 `validate_request_features()` 公共函数确实能避免将来再漂移，但本 PR 选择最小侵入：在三处直接对齐信息，把同步路径补齐到与异步路径同一行为。

代价是“同一字符串三份副本”，但 PR 用字节一致的信息降低了漂移风险，且执行层那道 `assert` 作为兜底本就该独立存在。集中化更适合留给后续重构——见 TODO。

---

## 意义与影响

- **用户体感**：`LLM.generate()` 用户从“深处 `AssertionError` + 笔误信息”变成“准入即清晰 `ValueError`”，定位成本从“回溯调度链”降到“看一眼堆栈”。
- **路径对齐**：同步 / 异步两条入口在 `kv_sharing_fast_prefill × prompt_logprobs` 这一不兼容组合上行为一致，不再有“异步拦得住、同步拦不住”的盲区。
- **正确性护栏**：在错误的 prompt logprobs 静默流出之前拦住，避免用户拿着不可信的 prompt 对数概率下游。
- **影响范围**：所有用 `LLM.generate()` 离线推理且开启 `--kv-sharing-fast-prefill` 的场景；在线 `serve` 路径不受影响（本就有守卫）。改动 `+37 / -3`，纯校验逻辑、无行为变更，风险极低。

---

## TODO

- [ ] 考虑把“特性不兼容”类校验集中到一个公共入口（如 `InputProcessor` 或 `validate_request_features()`），让同步 / 异步路径共享同一份守卫，根治“三处副本漂移”。当前三处信息对齐已是可接受状态。

---

## 参考

- YOCO 论文：[You Only Cache Once (YOCO)](https://arxiv.org/abs/2405.05254)——`kv_sharing_fast_prefill` 所优化的 KV 共享机制的源头。
