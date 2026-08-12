---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "投机解码"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "投机解码", "Eagle3", "MTP", "Ngram", "speculative"]
description: "投机解码模块——15+ 算法可切换的 SpecWorkerBase 策略体系，draft→verify→accept 循环，dynamic tree 与 one-model KV 隔离。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

投机解码（speculative decoding）是一个**横切特性**模块——它不参与垂直分层，而是 hook 进 `PyExecutor` 的执行循环。通过 draft model 预测若干 token + target model 批量验证，用一次 forward 产出多个 token，提升推理吞吐。模块独立存在是因为它有完整的策略体系：15+ 种算法（Eagle3 / MTP / Ngram / PARD / DFlash / DSpark / SA 等）可切换，每种算法的 draft 生成方式、KV cache 处理、acceptance 策略都不同。

## 模块架构

```
speculative/
├── interface.py          ← SpeculativeDecodingMode 枚举 + SpecMetadata + SpecWorkerBase
├── utils.py              ← get_spec_worker() / get_spec_metadata() 工厂
├── eagle3.py             ← Eagle3OneModelWorker（+ DynamicTree 变体）
├── draft_target.py       ← DraftTargetOneModelWorker
├── mtp.py / ngram.py     ← MTP / Ngram worker
├── pard.py / dflash.py / dspark.py  ← 并行 draft 变体
└── spec_tree_manager.py  ← dynamic tree 拓扑管理
```

## 调用链路

draft → verify → accept 循环（以 `DraftTargetOneModelWorker._forward_impl()` in `draft_target.py:143` 为例）：

```
1. [Target forward] model.forward() → target logits
2. [Sample & Accept] sample_and_accept_draft_tokens()      [interface.py:1631]
   → _accept_draft_tokens()                                [interface.py:1459]
   → strict: _sample_and_accept_draft_tokens_base()        [interface.py:1388]
       └─ torch.cumprod((draft==target).int(), dim=-1).sum(1)  ← 连续匹配数
   或 rejection: _sample_and_accept_draft_tokens_rejection()
       └─ flashinfer.sampling.chain_speculative_sampling
3. [Prepare draft] _prepare_attn_metadata_for_draft_target()
   → 保存 attn_metadata（prepare_for_spec_dec）
4. [Draft loop] for i in range(runtime_draft_len):
   a. draft_model.forward() → hidden_states → draft logits
   b. sample_draft_tokens() → advanced_sample_draft()
   c. 更新 attn_metadata（kv_lens, seq_lens）
5. [Restore] _restore_attn_metadata_from_spec_dec()
6. [Return] {logits, accepted_tokens, next_draft_tokens}
```

关键：`_update_kv_after_first_draft_step()` 回退 KV lens——draft 前向预填了全部 draft token 的 KV，但只有 accepted 的才保留：`kv_lens -= (runtime_draft_len - num_accepted_tokens)`。

| 组件 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `SpeculativeDecodingMode` | 枚举所有算法 + 能力谓词 | `is_*()` 让下游无需 if-else |
| `SpecWorkerBase` | 投机解码 worker 抽象 | `forward()` @final 保证 cleanup |
| `SpecMetadata` | 运行时状态容器 | 携带 draft_tokens、draft_probs、tree 拓扑 |

## 核心实现

### 策略模式与能力谓词

`SpeculativeDecodingMode` in `interface.py:326` 枚举 15+ 算法（`EAGLE3`/`MTP`/`NGRAM`/`PARD`/`DFLASH`/`DSPARK`/`SA`/`USER_PROVIDED`/`AUTO` 等），提供大量 `is_*()` 谓词（`use_one_engine()`、`needs_kv_cache_rewind()`、`has_spec_drafter()`、`support_dynamic_draft_len()`）。这些谓词控制调度器和注意力后端的行为分支。

`get_spec_worker()` in `utils.py:482` 是工厂，按 `spec_dec_mode` 创建对应 worker。`SpecWorkerBase` in `interface.py:1063` 是抽象基类，`forward()` 是 final 方法（`__init_subclass__` 强制，`interface.py:1106`），在 try/finally 中保证 spec-dec metadata 恢复，子类只实现 `_forward_impl()`。**Why**：不同场景最优算法不同（Eagle3 通用高接受率但需训练 draft；Ngram 无需训练适合 FAQ；MTP 轻量适合 DeepSeek），能力谓词让下游无需硬编码 if-else，这是支持 15+ 算法的关键。

### strict acceptance vs rejection sampling

`_accept_draft_tokens()` in `interface.py:1459` 路由到两条路径：strict acceptance（`_sample_and_accept_draft_tokens_base`，用 `torch.cumprod` 算连续匹配数）和 rejection sampling（`_sample_and_accept_draft_tokens_rejection`，用 `flashinfer.sampling.chain_speculative_sampling`）。`draft_probs` 是 slot-indexed 的概率缓冲区 `[num_seq_slots, max_draft_len, vocab_size]`，`batch_slot_ids` 是 per-request 的 stable slot id，用于跨迭代 scatter/gather。

### Dynamic Tree

Static tree 用固定 `eagle_choices` 拓扑展开 draft tokens，对不同 prompt 适应性差。Dynamic tree（`eagle3_dynamic_tree.py`、`spec_tree_manager.py`）在每步根据 draft model 置信度动态调整树结构——`SpecTreeManager` 管理 topology，`dynamic_tree_max_topK` 控制展开。**Why**：简单 prompt 浪费 draft slot，复杂 prompt 不够；动态裁剪/扩展提高有效 draft token 利用率。

### One-model 架构的 KV cache 隔离

one-model 模式下 draft 和 target 共享同一 engine，但需不同 KV cache 布局。`prepare_attn_metadata_for_draft_replay()` in `interface.py:127` 在 draft forward 前交换 KV cache manager 和 block offsets，draft 后 `restore_attn_metadata_after_draft_replay()` 恢复。**Why**：避免维护两套 attention metadata 的开销，同时保证 CUDA graph 兼容性。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `SpeculativeDecodingMode` + `get_spec_worker()` in `utils.py:482` | 15+ 算法可切换 |
| 模板方法 | `SpecWorkerBase.forward` @final in `interface.py:1106` | 统一流程骨架，保证 cleanup |

## 模块间交互

投机解码与 `pyexecutor/model_engine` 集成：`model_engine._set_up_spec_metadata()` in `model_engine.py:3120` 调 `get_spec_metadata()` 创建 `SpecMetadata`；worker 通过 `get_spec_worker()` 工厂创建，挂载到 `self.model.spec_worker`。`spec_metadata.prepare()` 在 forward 前分配 rejection sampling 缓冲区；`model_forward()` 中 `spec_worker._forward_impl()` 执行 draft-verify 循环。`SpecMetadata` 是 CUDA graph key 的一部分（`is_all_greedy_sample` 决定 graph variant）；`_sync_group_all_greedy_sample()` 在 TP 组内 all-greedy 标志取 AND。

## 扩展方式

**新增投机解码算法**：

1. `SpeculativeDecodingMode`（`interface.py:326`）添加枚举值 + `is_*()` 谓词，更新 `use_one_engine()` 等聚合谓词
2. 新建 worker 类继承 `SpecWorkerBase`，实现 `_forward_impl()` 和 `max_draft_len`
3. `get_spec_worker()`（`utils.py:482`）添加分支
4. `get_spec_metadata()`（`utils.py:83`）添加 metadata 创建逻辑
5. 若需特殊 attention 行为，更新 `attention_need_spec_dec_mode()`（`interface.py:471`）
