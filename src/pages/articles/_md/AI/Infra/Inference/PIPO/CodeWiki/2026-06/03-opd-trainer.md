---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "OPD 训练器"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "OPD", "蒸馏", "SGLang rollout"]
description: "PIPOGKDTrainer 的三阶段蒸馏流水线：SGLang rollout、压缩 student forward、PAD-compacted teacher forward、chunked sampled-KL 与 confidence head EAGLE 目标"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

OPD（On-Policy Distillation）训练器是 PIPO 最大的模块（`swift_gkd_trainer.py` 2171 行，graphify degree=28，全图第二高 god node）。它做的事是：让学生模型（4B + PIPO 组件）在 SGLang 上**自己 rollout** 生成 response，再对齐到独立冻结的 9B teacher 分布，同时用蒸馏过程顺带训练 `ConfidenceHead`。PIPO 的核心论点之一就是 **OPD 天然匹配 speculative decoding 的拒绝采样准则**——因此置信度头可以与 OPD 一起以近乎零额外成本训练，免去推理时的 verifier。本模块是这个论点的代码落地。

## 模块架构

`PIPOGKDTrainer`（继承 ms-swift `GKDTrainer`）内部是一条三阶段流水线：

- **Stage 1 SGLang rollout**：`_prepare_sglang_engine`（`L1917`）强制 `enable_pipo=True`/`disable_radix_cache=True` 并 colocate SGLang 引擎采 `response_token_ids`——学生走的就是推理路径，保证 on-policy。
- **Stage 2 batch 编码**：`_encode_with_rollout_response`（`L451`）先 prompt-only 编码（自动追加 qwen3.5 的 `response_prefix` `⊖\n`），再手动拼 rollout token，奇数 prompt 补 parity PAD——修复 `GKDTrainer._prepare_batch_inputs` 的 `replace_assistant_response_with_ids` 造成的 2-token shift。
- **Stage 3 loss 计算**：`_student_compressed_logits`（`L590`）走压缩模式 forward；`_teacher_hidden_pad_compacted`（`L702`）做 PAD 压缩的教师 forward；`_compute_loss_single`（`L1568`）编排骨架并调 `_compute_chunked_sampled_kl`（`L1349`）算 sampled reverse-KL + conf BCE；`_compute_loss_micro_chunks`（`L1782`）按 sample 拆 B=1 逐个 backward。

之所以学生必须走**压缩模式**而非普通 forward：一是参数覆盖（每个可训练参数——compressor + MTP norms/fc + LoRA——都有梯度，非压缩模式只训 backbone LoRA）；二是分布对齐（训练时 backbone 见过的 compressed-pair latent 与推理一致）；三是 PAD-skip 语义（pair `(t_p, PAD)` 压成 1 latent → backbone 预测下一个非 PAD token，镜像运行时行为）。

## 调用链路

![OPD 训练数据流](/vibe-reading/images/articles/pipo-internals/opd-flow.svg)

```
PIPOGKDTrainer step:
├─ (1) _prepare_sglang_engine (L1917) force enable_pipo/disable_radix_cache
│        └─ colocate SGLang 采 response_token_ids（走完整 PIPO 推理路径）
├─ (2) _encode_with_rollout_response (L451-532)
│        ├─ super()._prepare_batch_inputs(prompt, encode_prompt_only=True) 自动追加 response_prefix
│        ├─ prompt_ids 剥左 padding；奇数补 parity PAD (L499-500)
│        ├─ full_ids = prompt + resp_ids + eos；labels = [-100]*prompt + resp + eos
│        └─ right-pad 到 batch max → input_ids[B,T], labels[B,T]
├─ (3) _compute_loss_single (L1568)
│        ├─ _teacher_hidden_pad_compacted (L766)  → teacher_hidden [B,T,H]
│        ├─ _student_compressed_logits (L590)     → backbone_hidden[B,L-1,H], mtp_hidden[B,L-1,H]
│        ├─ 切片：teacher_back = teacher[:,1:T-1:2]; teacher_mtp = teacher[:,2:T:2]
│        └─ _compute_chunked_sampled_kl ×2 (backbone + mtp) (L1669)
├─ (4) _compute_chunked_sampled_kl (L1349)  每个 chunk:
│        ├─ s_lp = log p_s(y); t_lp = log p_t(y)
│        ├─ per_pos_loss = s_lp - t_lp                  sampled reverse-KL
│        ├─ conf_target = exp(-per_pos_loss.clamp(min=0)).detach() = min(1, p_t/p_s)
│        └─ _accumulate_conf_chunk → BCE(conf_logit[mask], conf_target[mask])
├─ (5) _finalise_conf (L1004)  ghost forward 防 ZeRO-2 桶失准
└─ (6) _compute_loss_micro_chunks (L1782)  B=1 逐个 accelerator.backward(sub_loss/N)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `_prepare_sglang_engine` (L1917) | 强制 PIPO + colocate SGLang | assert rollout_backend=='sglang'，无视 CLI 覆盖 |
| `_encode_with_rollout_response` (L451) | batch 编码 + response_prefix 对齐 | 修复 2-token shift，parity PAD 镜像 SGLang |
| `_student_compressed_logits` (L590) | 压缩模式 student forward | teacher-force token1，与推理路径一致 |
| `_teacher_hidden_pad_compacted` (L702) | PAD 压缩 teacher forward | strip PAD→run→cumsum remap，避 O(T×V) |
| `_compute_chunked_sampled_kl` (L1349) | 分块 sampled-KL + conf BCE | piggy-back，lm_head 每 chunk 只前向一次 |
| `_accumulate_conf_chunk` (L941) | conf head BCE | detach 输入防梯度泄漏 |
| `_finalise_conf` (L1004) | ghost forward | n==0 时保持 conf 桶对齐 |
| `_compute_loss_micro_chunks` (L1782) | 按 sample 拆 B=1 backward | 不在循环内 flush，ZeRO-2 累积 |

</details>

## 核心实现

### response-prefix 修复与 parity PAD

对 thinking template（qwen3.5），SGLang 推理自动在 prompt 后追加 `response_prefix='⊖\n'`，所以 rollout 的 `response_token_ids` **不含**这些前缀——生成从它们之后继续。但 `GKDTrainer._prepare_batch_inputs` 调 `replace_assistant_response_with_ids` 会丢弃原消息内容（含 `⊖\n`）并在 `<|im_start|>assistant\n` 后直接注入 bare `response_token_ids`，跳过 `response_prefix` 分支，造成 **rollout 时与训练时 prefix 的 2-token shift**。

`_encode_with_rollout_response`（`L451-554`）的修复：先 prompt-only 编码（`encode_prompt_only=True`，自动追加 `response_prefix`），再手动 `concat` rollout `response_token_ids`；若 prompt 长度奇数则补 parity PAD，精确镜像 SGLang `tokenizer_manager._tokenize_one_request` 行为。

### 教师 PAD 压缩：cumsum 重映射

SGLang 的 PIPO serving（`pipo_conf_threshold` gating）或 SFT 随机 PAD 增强会在被拒绝位置插 PAD，而 vanilla Qwen3.5 teacher 从未见过 mid-sequence PAD。`_teacher_hidden_pad_compacted`/`_teacher_logits_pad_compacted`（`L702-856`）三步处理：

1. **strip PAD**：稳定 argsort + gather 把 PAD token 剥掉，得到 compacted 干净序列。
2. **run teacher**：在 compacted 序列上跑 vanilla Qwen3.5 backbone。
3. **re-map**：用 `gather_idx = (non_pad_mask.cumsum(dim=1) - 1).clamp(min=0)` 把教师输出映回原位——non-PAD 位 p 映到同 token 的 compacted index；PAD 位 p 映到前一个 non-PAD 的 compacted index（等价 teacher 基于 prefix-without-PAD 条件）。

chunked hidden 路径（`_teacher_hidden_pad_compacted`）避免物化 `[B,T,V]` 教师 logits，长上下文必需。

### KL 三档模式与 conf EAGLE 目标

KL 模式由 `OPD_KL_MODE`（默认脚本 `topk`，trainer 默认 `sampled`）与 `beta`（默认 1.0）控制（详见深度附件 [OPD KL 与置信度目标](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/03-opd-trainer-kl-and-conf)）：

| 模式 | 条件 | 描述 |
| --- | --- | --- |
| `sampled` | `beta==1.0` | Monte-Carlo reverse-KL，只算采样 token：`l=log p_s(y)−log p_t(y)` |
| `topk` | `beta==1.0`+`mode=topk` | 限制在 student top-k ∪ teacher top-k ∪ sampled label 的并集上 |
| `full` | `beta==1.0`+`mode=full` | 全词表 reverse-KL via chunked JSD |
| JSD | `beta!=1.0` | 对称 beta-JSD |

当前研究配置固定 `MTP_LOSS_WEIGHT=1`、`OPD_CONF_LOSS_WEIGHT=1`、`OPD_KL_MODE=sampled`、`beta=1.0`：`total_loss = loss_backbone + loss_mtp + loss_conf`。`loss_backbone` 是偶数位 `[2,4,...,T-2]` 的学生/教师 reverse-KL；`loss_mtp` 是奇数位 `[3,5,...,T-1]`；`loss_conf` 是 conf head 的 BCE。conf target 在 sampled 路径取 `α(y)=min(1, p_t(y)/p_s(y))=exp(-per_pos_loss.clamp(min=0))`，即 EAGLE per-pair accept rate，且 `.detach()` 防梯度经目标回流学生 logits。

### micro-chunks 与 ZeRO-2 backward

`_compute_loss_micro_chunks`（`L1782`）当 batch 含多个 sample 时，每个 sample 隔离成 B=1 chunk 编码（保证零跨样本 padding），子 loss 求和除以 N（sample 均值）。**关键**：循环内**不**调完整 `backward()`——DeepSpeed ZeRO-2 会 desync。而是每 chunk `accelerator.backward(sub_loss / float(N))` 立即 backward 释放该 chunk 的 autograd graph（32 层 backbone + MTP + lm-head 中间态数十 GB），靠 `set_gradient_accumulation_boundary(False)` 让 reduce-scatter 累积到 `all_grad_tensors` 而不 flush。循环外由 HF Trainer 的标准 boundary 检查触发 flush。net 效果：N 个 in-loop backward 各贡献 `sub_loss_b / N` 梯度，等价 `per_device_train_batch_size=1` + `gradient_accumulation_steps` 缩放 B 倍。

### ghost forward 防止 ZeRO-2 conf 桶失准

当某 rank 的 batch 全是 PAD（高 `PIPO_CONF_THRESHOLD` 下常见），chunk 循环从不调 `confidence_head`，致 `confidence_head.{norm,fc1,fc2}` 不在 autograd 图中、梯度为 None；而其他 rank 有有效位置有梯度。ZeRO-2 的 all-reduce 桶需所有 rank 同时参与——缺失 rank 会导致 NCCL 挂起。`_finalise_conf`（`L1004-1071`）检测 `n==0`，跑一个 detached ghost forward `confidence_head(dummy_back*0.0, dummy_m*0.0).sum()*0.0`（`L1050-1053`，取 1 token `[:, :1]` 保持 shape 但只花 1 token 计算量），loss 值为 0 但每个参数都在图中有零梯度，保持桶对齐。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 热补丁 | `swift_plugin.py:_patch_gkd_trainer_for_pipo` (L268) | 覆写 `TRAINER_MAPPING['gkd']`，加载 plugin 即切 |
| 模板方法 | 继承 `GKDTrainer` + 覆写 `_prepare_sglang_engine` 等 | 复用 ms-swift rollout 基建，只加 PIPO 逻辑 |
| 分块处理 | `_compute_chunked_sampled_kl`/`_compute_chunked_jsd_loss` | 峰值 `O(T×V)`→`O(chunk×V)` |
| 策略 | `OPD_KL_MODE` 选 KL 模式 | 同接口多实现运行时切换 |

## 模块间交互

依赖三处：SGLang（rollout engine，`_prepare_sglang_engine` force PIPO）、`pipo/qwen3_5` 模型（student forward 调 `base._embed_pad_and_compress`/`base.model`/`base.mtp`/`base.lm_head`，teacher forward 调 `teacher_unwrapped.model`）、`swift_plugin`（注册 + 热路由 `gkd`→`PIPOGKDTrainer`）。还依赖 9B teacher（独立冻结模型，`assert not self._is_self_distillation`）。交互方式是直接 Python 方法调用 + `ForwardBatch` 字段传递（rollout 经 SGLang in-process engine）。

## 扩展方式

- **切 KL 模式**：`export OPD_KL_MODE=topk`（`swift_opd.sh:67`），`GKD_LOGITS_TOPK=32` 控制 K。切换在 `_compute_loss_single` (L1617-1620)。注意 `OPD_TOPK_SOURCE` 已忽略，topk 始终用 union。
- **调 conf detach**：`export OPD_CONF_DETACH_INPUTS=0`（`swift_opd.sh:89`），关闭后 conf loss 梯度回流 student backbone/mtp（`_accumulate_conf_chunk` L979-984）。
- **禁用 conf 监督**：`export OPD_CONF_LOSS_WEIGHT=0`（`swift_opd.sh:88`），head 仍实例化但不训练，仅 ghost forward；推理 gating 由 `PIPO_CONF_THRESHOLD`（默认 0.95）控制。
