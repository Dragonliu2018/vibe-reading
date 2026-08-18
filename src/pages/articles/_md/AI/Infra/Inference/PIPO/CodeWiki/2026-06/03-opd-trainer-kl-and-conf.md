---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "OPD KL 模式与置信度目标"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "KL 散度", "置信度头", "EAGLE"]
description: "PIPO OPD 的三档 KL 模式、ConfidenceHead 的 EAGLE 接受率目标推导与 chunked 实现细节"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回 OPD 训练器](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/03-opd-trainer)

---

## 主题定位

OPD 训练器里有两处设计最精妙、也最值得单独展开：一是 KL 散度为何有 `sampled`/`topk`/`full` 三档而非单一模式，二是 `ConfidenceHead` 的训练目标为何能从 EAGLE 接受率推导、又为何在 SFT 与 OPD 两阶段保持一致。这两点共同支撑了 PIPO "免去 verifier pass" 的核心论点，本附件把它们从模块文件里抽出来讲透。

## 核心原理

### 三档 KL 模式

`PIPOGKDTrainer` 的 KL 模式由 `OPD_KL_MODE`（trainer 默认 `sampled`，`swift_opd.sh` 默认 `topk`）与 `beta`（默认 1.0）控制，分派在 `_compute_loss_single`（`swift_gkd_trainer.py:L1617-1620`）：

- **`sampled`（`beta==1.0`）**：Monte-Carlo reverse-KL，只在与策略采样 token 上算 `l^sample = log p_s(y) − log p_t(y)`。这是 `D_KL(p_s ‖ p_t)` 的 per-token 无偏估计——无需遍历全词表，只在学生实际 rollout 的 token 上比较两端概率，计算量与 `O(1)` per position 成正比。
- **`topk`（`beta==1.0` + `OPD_KL_MODE=topk`）**：把比较限制在 per-position 的 **student top-k ∪ teacher top-k ∪ sampled label** 的并集上，`log_softmax` 在该并集上重归一化。用 `GKD_LOGITS_TOPK`（默认 32）控制 K。注意 `OPD_TOPK_SOURCE` 虽被接受但**已忽略**——topk 始终用三者并集，label 被追加进并集保证 lookup 总有效；若 label 也出现在 s_top/t_top（常见情况），`argmax` 在相等 mask 上取首个（非重复）出现，gather 到的是活跃 log-prob 而非被 mask 成 `-inf` 的重复位。
- **`full`（`beta==1.0` + `OPD_KL_MODE=full`）**：全词表 reverse-KL，via chunked JSD（Jensen-Shannon divergence）。
- **JSD（`beta!=1.0`）**：对称 beta-JSD，`Σ min(p_s, p_t)` 形式。

三档取舍：`sampled` 最省、无偏但方差较大；`topk` 在有限候选集上更稳定、聚焦高概率区；`full` 最准但最贵（需物化全词表，靠 chunked JSD 控制）。当前研究配置固定 `sampled`。

### ConfidenceHead 的 EAGLE 接受率目标

`ConfidenceHead` 要预测的是"MTP 输出的 token2 在 verify model 下会被接受的概率"。PIPO 的洞见是：speculative decoding 的拒绝采样准则——接受当且仅当 `u ≤ p_t(y)/p_s(y)`（`u~U[0,1]`）——意味着 per-pair accept rate 恰是 `min(1, p_t(y)/p_s(y))`。于是 conf head 的 BCE 目标取：

$$\alpha(y) = \min\!\left(1,\; \frac{p_t(y)}{p_s(y)}\right) = \exp\!\left(-\,\text{per\_pos\_loss.clamp(min=0)}\right)$$

其中 `per_pos_loss = log p_s(y) − log p_t(y)`（sampled 路径的全词表 `log_softmax`）。代码见 `_compute_chunked_sampled_kl`（`L1471`）：`conf_target = exp(-per_pos_loss.clamp(min=0)).detach()`。

**为何 `.detach()`**：conf head 是 post-hoc 评估器，目标里含 `p_s`（学生自己的概率），若不 detach，BCE 梯度会经目标回流学生 logits，让学生去"骗" conf head（牺牲 token2 质量 game 指标）。`OPD_CONF_DETACH_INPUTS=1`（默认）进一步 detach conf head 的输入 `(backbone_hidden, mtp_hidden)`，双重保险。

### SFT 与 OPD 目标的坍缩一致性

SFT 阶段（`Qwen3_5ForCausalPIPO.forward`，确定性 teacher 假设 `p_t=δ_{y_t}`）下，EAGLE accept rate `AR=Σ_y min(p_s(y),p_t(y))` 退化为 `min(p_s(y_t),1)=p_s(y_t)`，于是 SFT 的 conf 目标是 `p_s_mtp(label_token2)`（`modeling_qwen3_5_mtp.py:L763-765`）。

在确定性 teacher 极限下，这个值与 OPD 的 `min(1,p_t/p_s)` 和 `1−TV(p_s,p_t)` 三者**坍缩到同一值**（`L226-229` 注释）。因此 SFT 训出的 conf head 能无缝迁移到 OPD 而无需参数 reset——这就是 warm-start 一致性。OPD 阶段只是把目标从"SFT 的 `p_s(y_t)`"换成"on-policy rollout 的 `min(1,p_t/p_s)`"，分布从离线 ground-truth 切到在线 on-policy。

## 实现细节

### chunked lm-head：piggy-back 节省一次前向

`_compute_chunked_sampled_kl`（`L1349-1507`）沿 token 维按 `PIPO_OPD_CHUNK_SIZE`（默认 1024，脚本 4096）分块，每 chunk：

```python title="swift_gkd_trainer.py:_compute_chunked_sampled_kl（节选 L1420-1482）"
s_logits = student_lm_head(s_h)                 # [B, chunk, V]
s_scaled = s_logits / temperature
s_lp = gather(s_scaled, y) - logsumexp(s_scaled)  # log p_s(y)
t_lp = gather(t_scaled, y) - logsumexp(t_scaled)  # log p_t(y)
per_pos_loss = s_lp - t_lp                        # sampled reverse-KL
chunk_loss = per_pos_loss[mask].sum(); total_loss += chunk_loss
conf_target = exp(-per_pos_loss.clamp(min=0)).detach()  # min(1, p_t/p_s)
_accumulate_conf_chunk(confidence_head, backbone_hidden, mtp_hidden, conf_target, mask)
```

lm_head 在每个 chunk **只前向一次**——同时产出 student logits（算 KL）和 `per_pos_loss`（派生 conf target），而非"先算 KL 再为 conf 单独前向一次"。在 V≈248K 时 lm_head 是 chunk 循环的主导开销，piggy-back 节省约 2×。教师的 `log p_t(y)` 从已算好的 `teacher_hidden` 经同一 lm_head 投影得到（teacher 与 student 共享词表与 lm_head 结构）。

### conf head 的两种目标公式对应

- **sampled 路径**（默认）：`α(y)=min(1, p_t/p_s)`，见上。
- **topk（union）路径**：同一 sampled-token ratio 公式，但 log-prob 从**并集重归一化**的 `log_softmax` 在 label 的并集 slot 上读取。label 总被追加进 `union_idx = cat(s_top, t_top, label)` 保证 lookup 有效。
- **full-vocab JSD 消融路径**：`AR_pos = Σ_y min(p_s, p_t) = 1 − TV`。

三种形式都 `.detach()` 后才喂 BCE。

## 性能与权衡

- **`sampled` vs `topk`**：sampled 计算量最小（只 gather 采样 label 的 log-prob）但只用一个 token 的信号估计 KL，方差大；topk 用 32-64 候选集，更稳但每 position 要算并集上 logsumexp。当前选 sampled 是因 OPD 已是 on-policy，每 step 都重新 rollout，方差被多 step 平均。
- **chunk size**：`PIPO_OPD_CHUNK_SIZE` 越大峰值显存越高（`O(chunk×V)`），越小循环开销越大。默认 1024/4096 在 4B + 长上下文下平衡峰值与吞吐。
- **detach 输入**：开（默认）则 conf head 完全 post-hoc、不影响学生表示；关则让 conf 信号间接驱动学生，可能提升两者一致性但可能干扰主损失。
