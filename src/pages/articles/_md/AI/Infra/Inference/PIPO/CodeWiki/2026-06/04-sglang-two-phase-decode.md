---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "两阶段 Decode 机制"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "CUDA Graph", "两阶段 decode", "偶数长度不变量"]
description: "PIPO 推理两阶段 decode 的 CUDA graph capture/replay、偶数长度不变量、radix cache 强制 disable 与 PAD 多重角色"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回 SGLang 推理后端](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/04-sglang-inference)

---

## 主题定位

两阶段 decode 是 PIPO 推理加速的执行核心——每步产出 2 个 token 而非 1 个。本附件深入讲清四个机制：为何分两阶段、CUDA Graph 怎么 capture/replay、所有序列长度为何必须偶数、radix cache 为何强制 disable。这些是 PIPO 在 SGLang 上"跑得通又跑得快"的工程地基。

## 核心原理

### 为何两阶段：CUDA Graph 的边界

理想情况下 PIPO 一步 forward 想同时出 token1（backbone）和 token2（MTP）。但 token2 的 MTP 头输入依赖 token1 的采样结果（`embed(token1)` 与 `backbone_hidden`）——而 token1 采样需要 GPU→CPU sync（`sample()` 把 GPU logits 降到 CPU tensor 做 Python 分支判断）。CUDA Graph capture 要求输入是静态的，无法在 capture 时固定一个"采样的动态值"。

于是 PIPO 把一步拆两阶段：

- **Phase 1（backbone，CUDA Graph）**：`input_ids_pair → embed → compress → backbone → 存 pipo_backbone_hidden → lm_head → 采 token1`。backbone 的 forward 形状静态（每步都是 `[batch, 2]→[batch, H]`），可 capture 进 graph，replay 极快。采 token1 是 GPU→CPU sync 点。
- **Phase 2（MTP+conf，eager）**：`embed(token1) + norm(backbone_hidden) → cat → mtp_fc → mtp_block → confidence_head → lm_head → 采 token2 + gate`。输入含动态采样的 token1，无法 capture，走 eager forward。`cuda_graph_runner.can_run`（`L672-676`）见 `pipo_phase==2` 直接返回 False 跳过 graph。

代价是 Phase2 不能复用 Phase1 的 CUDA Graph，但有优化：Phase2 的 `attn_backend.init_forward_metadata`（`model_runner.forward_decode`）与 Phase1 是同一 batch 的同一 attention metadata，属冗余 CPU 工作（已知 issue，可优化但非正确性问题）。

### CUDA Graph capture/replay 的 pipo 专属处理

`cuda_graph_runner.py` 为 PIPO 加了三处：

- **capture 时强制走压缩路径**（`capture_one_batch_size` `L988-993`）：提供 dummy `input_ids_pair` 给 ForwardBatch，确保 capture 时 `forward` 走 Phase1 压缩分支而非普通单 token 分支。
- **capture 后存 hidden 引用**（`L1054-1062`）：把 capture 产出的 `pipo_backbone_hidden` tensor 引用存进 `self.pipo_backbone_hidden_buffers[graph_key]`。
- **replay 后挂回**（`replay` `L1189-1197`）：graph replay 后从 buffer dict 取 `pipo_backbone_hidden`，切片到 `raw_num_token`，挂到 `forward_batch.pipo_backbone_hidden` 供 Phase2 读。

这样 Phase2 拿到的 `pipo_backbone_hidden` 是 Phase1 graph replay 产出的真实 backbone 输出，数值正确。

### 偶数长度不变量

PIPO 的 compressor 把相邻两 token 折成 1 latent，所以**所有序列长度全程必须偶数**，否则 pair 边界错乱。不变量由多环节共同保证：

1. **Tokenization**（`tokenizer_manager._tokenize_one_request` `L768-770`）：奇数长度补 PAD 成偶数。
2. **Chunked prefill**（`schedule_policy.py` `L612-616, L725-731, L840-846`）：`trunc_len`/`fill_ids` 调成偶数（`enable_pipo` 时 ×2 处理）。
3. **因此**：`extend_len = total_len - prefix_len = even - even = even`，`prepare_for_extend` 无需再 padding。

`prepare_for_extend`（`schedule_batch.py:L1475-1717`）保存完整 `pipo_padded_input_ids` tensor + `pipo_padded_extend_lens`，并把 `seq_lens`/`extend_lens`/`orig_seq_lens` 减半到压缩粒度——后续 ForwardBatch metadata 全程在压缩粒度上（`compute_position` 产出 `[0,1,...,L//2-1]`）。

### radix cache 强制 disable

PIPO 的 compressor 把 2 token embedding 压成 1 latent，KV cache 以压缩（L/2）粒度分配。SGLang 的 radix cache 用 prefix hash 做 KV cache 共享——compressed pair-latent 的 cache key 与 SGLang 的 prefix hash 不兼容（cache-key mismatch），会导致错误命中。

强制 disable 由三处共同保证：`sglang_eval.py:L297`（推理入口）、`args_mixin.py:L229-233`（训练 rollout 自动推导 `sglang_enable_pipo`→`sglang_disable_radix_cache`）、`swift_gkd_trainer.py:L1931`（trainer 强制覆盖，无视 CLI）。`args_mixin.get_rollout_sglang_engine_kwargs`（`L255-257`）最终把 `extra['enable_pipo']=True`/`extra['disable_radix_cache']=True` 传入 `engine_kwargs`。

替代方案：`chunk_cache.py` 对 PIPO 做了部分特殊处理——`cache_unfinished_req` 用 `kv_committed_len`（压缩长度）而非 `len(fill_ids)`（非压缩长度），`cache_finished_req` 过滤 -1 sentinel（PIPO compaction 标记的 freed positions）。但 radix 的 prefix matching 仍 disabled（见 Known Issue #1）。

`overlap scheduling` 也被强制 disable（`scheduler.py:L316-325`：`enable_pipo and enable_overlap → enable_overlap=False`），因 PIPO 每步产 2 token，overlap 的 FutureMap 无法处理 multi-token 结果。

## 实现细节

### PAD token 的三重身份

PAD 在 PIPO 中不只是 padding：

1. **偶数 padding**：`tokenizer_manager` 给奇数长度序列补 PAD。
2. **token2 gating**：`tp_worker`（`L540/L557`）把低置信度 token2 替换为 PAD，表示"不提交此 token"。
3. **非 EOS**：`schedule_batch._check_token_based_finish`（`L1030-1036`）特判 PAD 不触发 stop——`if enable_pipo and token_id == pad_token_id: continue`。

### Phase2 fast path

`tp_worker`（`L537-541`）有两种 fast path：

- `PIPO_CONF_THRESHOLD >= 1.0`：总是 PAD（模型从不可信），短路输出 `[token1, PAD]` 并**跳过整个 Phase2 forward**，省一半 latency。
- `PIPO_CONF_THRESHOLD < 0`（默认）：不 gate，总是 commit token2。

## 性能与权衡

- **两阶段的 latency 账**：每步 forward 两次，但 Phase1 走 graph replay 极快，Phase2 只有 1 层 decoder + 轻量 conf head（远小于 32 层 backbone）。净效果是每步多产一个 token，吞吐近翻倍——这就是 2.07× per-token-latency 加速的来源。
- **首 token 延迟（FTL）**：prefill 在压缩序列上跑（L/2 长度），FTL 近翻倍——2.64× 加速的来源。
- **Phase2 不能用 graph 是已知开销**：可优化（把 Phase2 也静态化，或把 token1 采样延迟到 Phase2 后），但需重新设计采样流程，超出当前范围。
