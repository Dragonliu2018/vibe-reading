---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "RLCD 训练与温度校准"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "RLCD", "GRPO", "校准", "微调"]
description: "Laya 微调流水线深度解读：GRPO 式策略梯度 + proper_reward 严格正当评分奖励、DDP 双卡训练与 LBFGS 温度校准。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回决策模型](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model)

---

## 主题定位

本文深度解读 Laya 的微调流水线——`notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb` 中的 `train_ddp.py`（约 230 行，Kaggle 2×T4 DDP 环境）。它解决的问题是：base 检查点在 typed-decisions 基准上零样本接近随机（0.362 vs 0.318 随机基线），**全部业务可用性都来自这条微调流水线**——微调后在同一 2,000 决策基准上达到 0.766，超过 TypeSafe Jev 公布的 0.727，甚至超过教师模型自一致性上限 0.735。

它在体系中的角色：推理端 `laya/` 包不含任何训练代码，训练脚本只从 `common.py` import `build_model` / `proper_reward` / `QTYPES` 三个原语——**训练与推理共享的只有模型定义和评分规则**，这正是结果可信的关键：`proper_reward` 打分的分布就是推理端 `system_one` 输出的分布。

## 核心原理

RLCD 的循环骨架是 GRPO 式的组相对策略梯度，但"奖励模型"被严格正当评分规则**解析地替代**了——没有可被 reward hacking 的学习型 reward model，奖励直接由数学性质保证"只有说真话（报告真实分布）才得分最高"：

![RLCD 微调循环](/vibe-reading/images/articles/laya-internals/rlcd-training.svg)

每个 batch 的五步（`train_ddp.py` 主循环）：

1. **前向**：`ddp_model(...)` 在 fp16 autocast 下产出 `logits`（`train_ddp.py` 与推理端同一 `DecisionModel.forward`）；
2. **组采样**：对每条样本以当前策略分布为均值，加 `σ` 噪声采样 `GROUP_SIZE=4` 个"候选报告分布"——噪声做了**零均值投影**（`eps − eps.sum(-1)/k`），保证扰动不整体偏向任何一个选项；
3. **打分**：`proper_reward(q, target, ...)` 对每个候选分布按严格正当规则打分（w_sph 调到 0.75 强化软标签匹配），组内减均值除标准差得归一化优势；
4. **策略梯度**：`loss_rl = −(adv · logp).mean()`，其中 `logp` 是高斯噪声下的对数概率——教策略把概率质量移向组内得分更高的扰动方向；
5. **CE 引导**：`loss = loss_rl + 1.0 · loss_ce`，软标签交叉熵以固定权重全程混入。纯 RL 在 30k 样本量上方差太大，CE 项是稳定器；纯 CE 又只会过拟合教师分布的 argmax，RL 项负责分布形状。

探索噪声从 `SIGMA_START=0.4` 线性退火到 `SIGMA_END=0.1`（随 epoch 进度插值）：前期大扰动找方向，后期小扰动精修。

## 实现细节

### 训练配置的关键取舍

```python title="notebooks/train_ddp.py"
EPOCHS = 4
MICRO_BATCH = 8      # 8 sequences per forward pass per GPU
GRAD_ACCUM = 4       # Effective batch across 2 GPUs = 64 sequences
GROUP_SIZE = 4       # GRPO baseline samples
LR_ENCODER = 2.5e-5  # Encoder adaptation rate
LR_HEAD = 1.0e-4     # Head adaptation rate
```

- **双学习率**（`encoder.` 前缀 vs 其余）：421M 参数的编码器只做轻量适配（2.5e-5），360 行的决策头是真正要学的部分（1e-4）——预训练知识在新任务上"微调头部、轻碰底座"。
- **梯度累积 ×4 + DDP ×2**：有效批 64 序列，`CosineAnnealingLR` 到 eta_min=1e-6，`GradScaler` 管 fp16 的 loss scaling，梯度裁剪 1.0。
- **`find_unused_parameters=True`**：`DecisionModel` 的 act 头在训练 loss 里被 `0.0 * act.sum()` 显式排除（保持 DDP 图完整但零梯度），训练只针对选项分布。
- **梯度检查点**：`gradient_checkpointing_enable(use_reentrant=False)` + `model.head_checkpointing = True`，把 `max_len` 抬到 1024 / `head_max_len` 256 塞进 16GB T4。
- **数据分片**：`my_items = all_items[rank::world_size]` 按秩取模切分，每卡各 shuffle 各自分片（`random.seed(42 + epoch + rank)`）。

### 温度校准：训练的最后一公里

训练结束后 rank 0 上单独跑校准（`fit_one_temp`，LBFGS 优化单个 `log_t` 参数）：

```python title="notebooks/train_ddp.py"
def fit_one_temp(sel):
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)
    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss
    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())
```

每种 qtype 拟合一个温度（choice/score/noul 三元组，校准集取 `all_items[::15][:400]`），最小化 NLL——等价于在 logit 缩放族里找校准误差最小点。拟合结果写进 `cfg["temperature"]` 随 `rl_agent_config.json` 保存，推理端 `temp_bucket()` 直接消费（更细的 `temperature_by_options` 分桶版本由官方检查点携带，base 流水线是三温度版）。校准用微批 16 条防 OOM，拟合失败时回退 `[1.2, 1.2, 1.2]` 而不是让整个训练作废。

### 保存格式

权重 `half()` 后存 `model.safetensors`，encoder 配置与 tokenizer 各存子目录——正好是 `Agent.__init__` 期望的目录结构（`rl_agent_config.json` + `model.safetensors` + `encoder/` + `tokenizer/`），微调产物即插即用，不需要格式转换。

## 性能与权衡

| 指标 | base（laya） | 微调后 | 参照 |
| --- | --- | --- | --- |
| typed-decisions 准确率 | 0.362 | **0.766** | Jev 公布 0.727；教师自一致性上限 0.735；多数类基线 0.461 |
| Brier | 0.316 | **0.062** | Jev 0.148 |
| score MAE | 0.694 | **0.242** | Jev 0.391 |
| ECE（温度拟合后） | — | 0.213→**0.081** | 官方检查点口径 |

三个诚实的权衡（README "Where Jev leads" 明示）：

- **软分布匹配弱于 Jev**（soft acc 0.471 vs 0.580）：argmax 更准但整体分布形状与教师分布贴合度差——proper_reward 的 spherical 分量（w_sph=0.75）就是在补这个，仍未完全补平；
- **温度拟合是事后补丁**：base 检查点原始 ECE 0.213 劣于 Jev 的 0.144，优势全靠校准阶段挣回来；`laya-multilingual` 发布时甚至没带拟合温度（README 提醒"fit them before relying on its probabilities"）；
- **成本与适用边界**：2×T4 约 4-5 小时跑完 4 epoch ~30k 问题。这套流水线的隐含定位是"每个业务域微调一个专用检查点"，而不是一个通用零样本引擎——与 Router 的三检查点架构互为印证：typed-decisions 检查点从不被自动路由选中（除非显式 opt-in），因为它只在四个 workflow 上微调过。
