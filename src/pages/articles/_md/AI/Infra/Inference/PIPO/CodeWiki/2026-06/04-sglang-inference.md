---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "SGLang 推理后端"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "SGLang", "两阶段 decode", "CUDA Graph"]
description: "PIPO 在 SGLang 上的推理路径：Qwen3_5ForCausalPIPO 模型、两阶段 decode、CUDA graph 与 schedule_batch 的 pipo_* 字段"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

这是 PIPO 在 SGLang 上的 fork 扩展部分，把训练好的 compressor + MTP + confidence head 落产成**两阶段 decode 的推理加速路径**。SGLang 原模型只支持"一次 forward 一个 token"，PIPO 把每步改成产出两个 token：Phase1 backbone 走 CUDA Graph 采 token1，Phase2 MTP + 置信度门控走 eager forward 采 token2。所有 PIPO 专属逻辑散见 `qwen3_5_pipo.py`（模型）、`tp_worker.py`（采样+gating）、`schedule_batch.py`（调度字段）、`forward_batch_info.py`（pipo 字段）、`cuda_graph_runner.py`（graph）、`schedule_policy.py`/`tokenizer_manager.py`（偶数长度保证）。这些文件本身是 SGLang 原仓库的子集，本模块只讲 PIPO 修改/新增的分歧点。

## 模块架构

SGLang 侧的 `Qwen3_5ForCausalPIPO`（`qwen3_5_pipo.py`）是独立 `nn.Module`，不复用训练侧的 HF 模型，但**复用 `pipo/qwen3_5/compressor.py` 的 `PIPOCompressor`/`ConfidenceHead` 类定义**（结构对齐、权重名直接匹配）：

```
Qwen3_5ForCausalPIPO (SGLang)
├── compressor          PIPOCompressor (from COMPRESSOR_REGISTRY[config.compressor_type])
├── backbone            Qwen3_5ForCausalLMLatent (32 层，from qwen3_5_latent.py)
├── mtp_fc              Linear(2H→H, bias=False)
├── mtp_pre_fc_norm_embedding / mtp_pre_fc_norm_hidden   GemmaRMSNorm(H)
├── mtp_block           Qwen3_5ForCausalLMLatent (1 层, layer_id=32)
├── lm_head             tied to backbone.embed_tokens
├── logits_processor    LogitsProcessor
└── confidence_head     ConfidenceHead（always present）
```

`forward` 分三个分支：extend（prefill）、decode Phase1（backbone）、decode Phase2（MTP+conf）。`load_weights`（`L301-484`）把训练侧 checkpoint key 映射到 SGLang 参数（见下表）。调度侧 `ForwardBatch`/`ModelWorkerBatch`/`ScheduleBatch` 增加 `input_ids_pair`、`pipo_padded_input_ids`、`pipo_padded_extend_lens`、`pipo_phase`、`pipo_backbone_hidden`、`pipo_sampled_token_from_phase1`、`pipo_token2_conf` 等字段，全部 `pipo_*` 前缀。

之所以 SGLang 不直接 import 训练侧 `modeling_qwen3_5_mtp.py`：SGLang 的模型用自己高性能的 `Qwen3_5ForCausalLMLatent` backbone（融合 qkv_proj、paged KV cache、radix tree 调度），与 HF 的 `Qwen3_5TextModel` 实现不同；只有 compressor/ConfidenceHead 是纯计算无框架依赖，才跨边共享。

## 调用链路

![两阶段 Decode 数据流](/vibe-reading/images/articles/pipo-internals/decode-flow.svg)

### Prefill（extend）

```
tokenizer_manager._tokenize_one_request (L768-770)  奇数长度补 PAD 成偶数
  → schedule_policy (L612,725,840)  确保 trunc_len/fill_ids 偶数
  → schedule_batch.prepare_for_extend (L1475-1717)
      保存 pipo_padded_input_ids；seq_lens/extend_lens 减半到压缩粒度
  → qwen3_5_pipo.forward extend 分支 (L236-260)
      embed 全量 token → compressor 折半 → backbone → logits1
  → tp_worker.forward_batch_generation (L533)  采 token1，配 [token1, PAD]
```

### Decode 两阶段（详见 [两阶段 decode 机制](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/04-sglang-two-phase-decode)）

```
prepare_for_decode (L2048-2109)  建 input_ids_pair[B,2]，input_ids=pair[:,0]
  → cuda_graph_runner.replay (L1166)  Phase1 走 graph；replay 后挂回 pipo_backbone_hidden
  → qwen3_5_pipo.forward Phase1 (L267-291)  embed pair→compress→backbone→存 hidden→logits1→采 token1
  → tp_worker (L543-544)  set pipo_phase=2, pipo_sampled_token_from_phase1=token1
  → cuda_graph_runner.can_run (L672-676)  pipo_phase==2 → False，走 eager
  → qwen3_5_pipo.forward Phase2 (L196-223)  embed(token1)+norm(hidden)→cat→mtp_fc→mtp_block→conf_head→logits2
  → tp_worker (L544-559)  采 token2；conf<PIPO_CONF_THRESHOLD 处 token2:=PAD；stack[token1,token2]
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件 | 一行职责 | 关键设计决策 |
| --- | --- | --- | --- |
| `forward` (qwen3_5_pipo.py) | 三分支 | extend/Phase1/Phase2 | Phase1 存 `pipo_backbone_hidden` 供 Phase2 |
| `load_weights` (L301) | 权重映射 | checkpoint→SGLang param | compressor/conf head direct match 无 remap |
| `prepare_for_decode` (schedule_batch.py:L2048) | 建 input_ids_pair | O(1) 尾部访问取最近 2 token | token_per_req=1（压缩 KV） |
| `forward_batch_generation` (tp_worker.py:L533-559) | 两阶段采样+gating | Phase1 sync→切 Phase2→conf gate | conf<阈值→PAD；=1.0 短路跳 Phase2 |
| `can_run` (cuda_graph_runner.py:L672) | Phase2 跳 graph | pipo_phase==2→False | Phase2 依赖 Phase1 采样结果，无法 capture |
| `replay` (cuda_graph_runner.py:L1166) | graph replay+挂 hidden | 从 buffer dict 取 pipo_backbone_hidden | per-graph-key 缓存 |

</details>

## 核心实现

### forward 三分支

`qwen3_5_pipo.py:forward` 据 `forward_batch.pipo_phase` 与是否 extend 分流：

```python title="qwen3_5_pipo.py:forward（节选）"
# extend (prefill): embed pipo_padded_input_ids → compressor → backbone → logits1
# Phase 1 decode (L267-291):
input_ids_pair = forward_batch.input_ids_pair            # [batch, 2]
ids_flat = input_ids_pair.view(-1)                       # [batch*2]
embeds = embed_tokens(ids_flat)                          # [batch*2, H]
compressed = compressor(embeds)                           # [batch, H]
hidden = backbone(input_ids, positions, forward_batch, input_embeds=compressed)  # [batch, H]
forward_batch.pipo_backbone_hidden = hidden_states       # 供 Phase2
return logits_processor(input_ids, hidden, lm_head, forward_batch)  # logits1
# Phase 2 decode (L196-223):
backbone_hidden = forward_batch.pipo_backbone_hidden
token1 = forward_batch.pipo_sampled_token_from_phase1
embed1 = mtp_pre_fc_norm_embedding(embed_tokens(token1))
hidden_mtp = mtp_pre_fc_norm_hidden(backbone_hidden)
fused = mtp_fc(cat([embed1, hidden_mtp], dim=-1))        # [batch, H]
hidden_states = mtp_block(token1, positions, forward_batch, input_embeds=fused)
conf_logit = confidence_head(backbone_hidden, hidden_states)
forward_batch.pipo_token2_conf = sigmoid(conf_logit)
return logits_processor(token1, hidden_states, lm_head, forward_batch)  # logits2
```

### 权重名映射

`load_weights`（`L301-484`）把训练侧 checkpoint key 映射到 SGLang 参数：

| Checkpoint key | Model parameter | Notes |
| --- | --- | --- |
| `model.language_model.*` / `model.*` | `backbone.*` | strip prefix |
| `mtp.fc.*` / `mtp.pre_fc_norm_*.*` | `mtp_fc.*` / `mtp_pre_fc_norm_*.*` | flatten |
| `mtp.layers.*` / `mtp.norm.*` | `mtp_block.layers.*` / `mtp_block.norm.*` | remap to block |
| `*.self_attn.*` | `*.*` (remove `.self_attn.`) | SGLang 扁平化，q/k/v→qkv 经 stacked_params_mapping |
| `compressor.*` | `compressor.*` | **direct match，无 remap** |
| `confidence_head.*` | `confidence_head.*` | **direct match，无 remap** |

compressor 与 confidence_head 因训练/推理共享类定义，权重名两边一致，直接匹配——这是结构对齐的红利。

### MTP layer_id = num_hidden_layers

`_mtp_layer_id_offset = config.num_hidden_layers`（如 32）。作用有二：避免 MTP 层的 KV cache slot 与任何 backbone 层碰撞；`HybridLinearAttnBackend` 据此把它路由到 full-attention 路径（`full_attention_layer_ids`）。`model_runner.py` 在 init 时把 `layer_id=32` 加入 `full_attention_layer_ids`（只对 `Qwen3_5ForCausalPIPO`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段解码 | `tp_worker` Phase1(graph)+Phase2(eager) | MTP 依赖 Phase1 hidden，无法跨 CUDA graph capture |
| 权重名映射 | `load_weights` (L301) | 适配训练侧 checkpoint 命名到 SGLang 扁平结构 |
| buffer 缓存 | `pipo_backbone_hidden_buffers` dict (cuda_graph_runner L1054) | per-graph-key 缓存 hidden，replay 后挂回 |
| 字段贯通 | `ForwardBatch.pipo_*` 字段 | scheduler↔model 间用 batch 字段传 PIPO 状态 |

## 模块间交互

![模块依赖关系](/vibe-reading/images/articles/pipo-internals/module-dependencies.svg)

SGLang 模型从 `pipo/qwen3_5/compressor.py` import `PIPOCompressor`/`LinearCompressor`/`MLPCompressor`/`ConfidenceHead`/`COMPRESSOR_REGISTRY`（`qwen3_5_pipo.py:L57`），权重 key 直接匹配。`tp_worker` 消费 `forward_batch.pipo_token2_conf` 做 gating。`sglang_eval.py` 通过 `sgl.Engine(enable_pipo=True, disable_radix_cache=True)` + `os.environ["PIPO_CONF_THRESHOLD"]` 驱动本模块；OPD 训练器 `_prepare_sglang_engine` 同样强制这两 flag。`schedule_batch._check_token_based_finish`（`L1030-1036`）特判 PAD 非 EOS（PIPO 中 PAD 是合法输入 token，不能触发 stop）。

## 扩展方式

- **改 gating 阈值**：`--pipo_conf_threshold`（`sglang_eval.py`）或 `PIPO_CONF_THRESHOLD` env，被 `tp_worker._pipo_conf_threshold`（`L63-71`）读。
- **新增 compressor 到推理**：无需改 SGLang 侧代码——`qwen3_5_pipo.py:L97-104` 经 `COMPRESSOR_REGISTRY.get(compressor_type)` 自动找类；只需新 compressor 参数名与 checkpoint `compressor.*` 一致。
- **加 backbone 层的 PIPO 路径适配**：改 `qwen3_5_pipo.py` 的 forward 三分支 + `model_runner.py` 的 `full_attention_layer_ids` 注册。
