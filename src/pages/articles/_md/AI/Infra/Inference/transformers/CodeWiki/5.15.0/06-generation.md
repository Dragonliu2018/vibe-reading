---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "生成框架"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, Inference, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "GenerationMixin", "LogitsProcessor", "speculative decoding", "采样"]
description: "GenerationMixin.generate 是自回归生成入口，用策略模式选解码方法、责任链组合 logits processor、工厂创建 candidate generator 实现 speculative decoding。本文解读生成框架的扩展性设计。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

生成框架是推理的核心——`GenerationMixin.generate` 把 `input_ids` 自回归地扩展成完整序列。它独立成模块，是因为解码策略（greedy/sampling/beam/speculative）+ logits 处理（temperature/top_p/repetition）+ 候选生成（speculative decoding 的多种 draft 来源）组合出一个独立且复杂的子系统。v5 后 `GenerationMixin` 不再由 `PreTrainedModel` 直接继承，而由具体模型类（如 `LlamaForCausalLM`）显式继承。

边界：生成只管"解码循环与 token 选择"，不管 attention/前向计算（建模核心+原语），也通过 `Cache` 对象与缓存协作（KV 缓存模块）。

## 模块架构

`generation/` 目录（18806 行）按职责分四块：

- **生成 mixin**：`utils.py`（4089 行），`GenerationMixin(ContinuousMixin)` in L359，方法 `generate`（L2261）、`_sample`（L2783，greedy+sampling 共用）、`_beam_search`（L3208）、`_assisted_decoding`（L3562，speculative）、`_prefill`（L3904）。`GENERATION_MODES_MAPPING`（L137）把 `GenerationMode` 映射到方法名。
- **logits 处理**：`logits_process.py`（3222 行），`LogitsProcessor` 抽象基类（L49）+ `LogitsProcessorList` 责任链容器（L63）+ 约 30 个 processor/warper（temperature/top_p/top_k/min_p/repetition/no_repeat_ngram 等）。
- **生成配置**：`configuration_utils.py`（1872 行），`GenerationConfig` 关键字段（do_sample/temperature/top_p/top_k/max_new_tokens/cache_implementation 等），`GenerationMode` 枚举，`get_generation_mode` 判定。
- **候选生成**：`candidate_generator.py`，`CandidateGenerator` 抽象基类（L39）+ 子类 `AssistedCandidateGenerator`/`PromptLookupCandidateGenerator`/`MTPCandidateGenerator`/`EarlyExitCandidateGenerator`/`UniversalSpeculativeDecodingGenerator` 等。

## 调用链路

`generate` 的分发与 `_sample` 循环：

```
generate(input_ids, generation_config, **kwargs)        utils.py:2261
├── _prepare_generation_config → 合并优先级 kwargs > model.generation_config > 全局默认
├── get_generation_mode(assistant_model) → GenerationMode
├── GENERATION_MODES_MAPPING[mode] → "_sample"/"_beam_search"/"_assisted_decoding"
├── _prepare_model_inputs / _prepare_cache_for_generation → past_key_values: Cache
├── _get_logits_processor → LogitsProcessorList（约束类→warper→watermarking→normalization）
└── _sample(input_ids, logits_processor, stopping_criteria, generation_config, ...)
    ├── _prefill → prepare_inputs_for_generation → self(**inputs)  # 首次前向处理整个 prompt
    └── while _has_unfinished_sequences():
        ├── prepare_inputs_for_generation(input_ids, next_sequence_length=1)
        ├── outputs = model_forward(**inputs)              # 增量前向（用 KV cache）
        ├── next_token_logits = outputs.logits[:, -1]
        ├── next_token_scores = logits_processor(input_ids, next_token_logits)  # 责任链
        ├── if do_sample: multinomial(softmax(scores)) else: argmax(scores)
        ├── next_tokens = next_tokens * unfinished + pad * (1 - unfinished)  # EOS 处理
        └── input_ids = cat([input_ids, next_tokens[:, None]])
```

数据流：`input_ids → model forward → next_token_logits → LogitsProcessor 链 → next_token → 拼接 → 循环`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `generate` in `utils.py:2261` | 生成入口 | 模板方法编排 8 步，据 mode 分发 |
| `_sample` in `utils.py:2783` | greedy/sampling 循环 | GREEDY 与 SAMPLE 都映射到它，靠 do_sample 区分 |
| `_assisted_decoding` in `utils.py:3562` | speculative decoding | 候选生成+主模型验证+接受/拒绝 |
| `_get_logits_processor` in `utils.py:1123` | 构建 processor 链 | 固定顺序：约束→warper→normalization |
| `_get_candidate_generator` in `utils.py:996` | 选 draft 来源 | 工厂分支：assistant_model/prompt_lookup/mtp |
| `get_generation_mode` in `configuration_utils.py:534` | 判定模式 | 据 do_sample/num_beams/assistant_model |

</details>

## 核心实现

### 策略模式选解码方法

`GenerationConfig` 是策略上下文，`get_generation_mode()` 据 `do_sample`/`num_beams`/`assistant_model` 选 `GenerationMode`（GREEDY_SEARCH/SAMPLE/BEAM_SEARCH/BEAM_SAMPLE/ASSISTED_GENERATION 等）。`GENERATION_MODES_MAPPING`（L137）把 mode 映射到方法名——GREEDY_SEARCH 与 SAMPLE 都映射到 `_sample`，区分在 `_sample` 内部用 `do_sample` 标志（True 用 `multinomial`，False 用 `argmax`），这样 greedy 与 sampling 共享同一循环骨架。部分已废弃模式（CONTRASTIVE_SEARCH/DOLA/CONSTRAINED_BEAM）映射到 `"transformers-community/<repo>"`，通过 `custom_generate` 从 Hub 加载社区维护实现——核心代码不再背负这些低频策略。

### LogitsProcessor 责任链

`LogitsProcessorList(list)`（L63）的 `__call__` 依次调每个 processor：`scores = processor(input_ids, scores, **kwargs)`。在 `_get_logits_processor`（L1123）按固定顺序构建：① 约束类（guidance_scale→sequence_bias→repetition_penalty→no_repeat_ngram→bad_words→min_length→forced_bos/eos→suppress_tokens）② 用户自定义 ③ 采样 warper（仅 do_sample=True：temperature→top_h→top_k→top_p→min_p→typical_p→epsilon/eta_cutoff）④ watermarking ⑤ `LogitNormalization`（始终最后）。用责任链而非分支的原因：可组合性（用户自由组合任意 processor，分支需 O(2ⁿ) 路径）、开闭原则（新增 processor 不改解码循环）、顺序可控（`LogitNormalization` 必须最后）、统一接口（解码循环只一行 `logits_processor(...)`）。

### candidate_generator 工厂

`_assisted_decoding`（L3562）的 speculative decoding 解耦 draft 与 verify：`_get_candidate_generator`（L996）据配置选 draft 来源——`assistant_early_exit` → `EarlyExitCandidateGenerator`、`prompt_lookup_num_tokens` → `PromptLookupCandidateGenerator`（无需额外模型，用 prompt n-gram 匹配）、`use_mtp` → `MTPCandidateGenerator`、`assistant_model` → `AssistedCandidateGenerator`（小模型生成）、不同 tokenizer → `UniversalSpeculativeDecodingGenerator`。主循环只负责"获取候选→主模型一次 forward 验证多候选→`_speculative_sampling` 接受/拒绝"，不关心候选如何产生。`update_candidate_strategy`（candidate_generator.py:224）每轮据匹配数动态调整候选数量（全匹配+2，否则-1）。`_speculative_sampling`（L3992）忠实实现论文（2211.17192）Algorithm 1，candidate_logits 可用时走概率拒绝路径。

### GenerationConfig 与 model config 分离

关注点分离：model config 描述架构（层数/维度），generation config 描述推理行为（temperature/max_new_tokens）。`GenerationConfig` 可独立序列化为 `generation_config.json`，与权重分开存 Hub。`_prepare_generation_config`（L1771）三层合并：`self.generation_config`（模型默认）→ 全局默认 → kwargs（用户覆盖）。运行时可变——每次 `generate` 调用可经 kwargs 覆盖而无需改权重。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略 | `GENERATION_MODES_MAPPING` + 各 `_sample`/`_beam_search` | 解码策略可插拔，废弃模式移到 Hub |
| 责任链 | `LogitsProcessorList`（L63） | logits 处理可自由组合，O(2ⁿ) 分支不可行 |
| 模板方法 | `generate` 编排（L2261） | 8 步骨架固定，`prepare_inputs_for_generation` 是模型钩子 |
| 工厂 | `_get_candidate_generator`（L996） | 统一 draft 来源创建，解耦 draft 与 verify |
| 注册表 | `GENERATION_MODES_MAPPING`（L137） | mode→方法名，部分映射到 Hub repo |

## 模块间交互

`GenerationMixin` 被具体 model 类显式继承（如 `LlamaForCausalLM(LlamaPreTrainedModel, GenerationMixin)`），`PreTrainedModel.can_generate()`（modeling_utils.py:1573）检测 `"GenerationMixin" in str(cls.__bases__)`。与 `cache_utils` 紧协作：`_prepare_cache_for_generation`（L1929）据 `cache_implementation` 创建 `DynamicCache`/`StaticCache`/`QuantizedCache`；assisted decoding 强制 `use_cache=True` 且不能用 `StaticCache`（L3620），用 `cache.crop()` 裁剪不匹配候选的 cache 位置。与 `logits_process` 在两层面使用：全局链 + assisted decoding 内逐位置应用。`cache_implementation=="paged"` 时切到 `generate_batch`（continuous batching 路径）。

## 扩展方式

新增 LogitsProcessor：在 `logits_process.py` 继承 `LogitsProcessor` 实现 `__call__` 设 `supports_continuous_batching`，在 `_get_logits_processor`（L1123）按顺序 append，在 `GenerationConfig` 加配置字段，在 `__init__.py` 的 `_import_structure` 导出。新增解码策略：在 `GenerationMode` 枚举加值，在 `get_generation_mode` 加判定，在 `GENERATION_MODES_MAPPING` 加映射（指向新方法或 `"transformers-community/<repo>"` 走 Hub），在 `GenerationMixin` 实现 `_<strategy>` 方法（签名与 `_sample` 一致）。新增 candidate generator：继承 `CandidateGenerator` 实现 `get_candidates`/`update_candidate_strategy`，在 `_get_candidate_generator`（L996）加分支，在 `GenerationConfig` 加触发字段。
