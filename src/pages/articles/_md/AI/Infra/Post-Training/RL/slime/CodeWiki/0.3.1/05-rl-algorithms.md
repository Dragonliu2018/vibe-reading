---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "RL 算法"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "PPO", "GRPO", "GSPO", "CISPO", "advantage"]
description: "slime 的 RL 算法层：优势估计 dispatch、策略损失、CP 感知归一化与 off-policy 修正。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

RL 算法层由 `slime/utils/ppo_utils.py`（优势/return 计算）与 `slime/backends/megatron_utils/loss.py`（log-prob/entropy/策略损失）构成。它是 slime"算法可配置切换、不绑死训练内核"的体现——所有算法（GRPO / GSPO / CISPO / PPO / REINFORCE++）通过 `args.advantage_estimator` 一行配置切换，共用同一套数据管道与训练步，差异集中在优势计算与损失函数两处 dispatch。本模块还处理 off-policy 修正（TIS/OIS）、MoE 路由重放、OPD 蒸馏 KL、以及 CP（context parallel）感知的 advantage 归一化——后者是 RL 静默 bug 的高发区，slime 在此下了专门防护。

## 模块架构

![RL 算法 dispatch](/vibe-reading/images/articles/slime-internals/rl-dispatch.svg)

文字上，`compute_advantages_and_returns`（`loss.py:704`）是优势计算的 dispatch 中心：先 `compute_approx_kl` 算当前策略与 ref 的 KL，再按 `advantage_estimator` 分发到 5 个分支（GRPO/GSPO/CISPO 共用 `get_grpo_returns`、PPO 走 GAE、REINFORCE++ 两个变体、可插拔 custom），OPD 的 KL 罚款正交叠加，最后 `normalize_advantages` 做 CP 感知 whitening。产出的 `advantages` / `returns` 进入 `policy_loss_function`（`loss.py:934`），它算当前 log-prob、按估计器算 PPO clip / GSPO 序级 KL / CISPO 损失，可选叠 TIS/OIS off-policy 修正与 OPSM 掩码。

## 调用链路

```text
compute_advantages_and_returns(args, rollout_data)        # loss.py
  ├─ compute_approx_kl(log_probs, ref_log_probs, kl_loss_type)   # ppo_utils.py
  ├─ dispatch by args.advantage_estimator:
  │    ├─ grpo/gspo/cispo → get_grpo_returns(rewards, kl)
  │    ├─ ppo → rewards += -kl_coef*kl; get_advantages_and_returns_batch (GAE)
  │    ├─ reinforce_plus_plus → get_reinforce_plus_plus_returns
  │    └─ reinforce_plus_plus_baseline → get_reinforce_plus_plus_baseline_advantages
  ├─ apply_opd_kl_to_advantages (if use_opd)              # 正交 KL 罚款
  ├─ normalize_advantages → distributed_masked_whiten (DP+CP group)
  └─ 写回 rollout_data["advantages"] / ["returns"]

policy_loss_function(args, batch, logits, sum_of_sample_mean)   # loss.py
  ├─ get_log_probs_and_entropy(logits)                    # vocab-parallel autograd
  ├─ compute_approx_kl / compute_gspo_kl / compute_opsm_mask
  ├─ compute_policy_loss / compute_cispo_loss (PPO clip)
  ├─ TIS/OIS off-policy 修正 (if use_tis)
  └─ sum_of_sample_mean 归约（rollout_mask_sums 作分母）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `compute_advantages_and_returns` in `loss.py` | 优势 dispatch | 5 估计器 + 可插拔 custom + OPD 正交叠加 |
| `compute_approx_kl` in `ppo_utils.py` | 当前 vs ref 的 KL | 支持 `kl_loss_type` |
| `get_grpo_returns` in `ppo_utils.py` | GRPO/GSPO/CISPO returns | returns = rewards - KL |
| `get_advantages_and_returns_batch` in `ppo_utils.py` | PPO GAE | `vanilla_gae` / `chunked_gae` 支持分块 |
| `distributed_masked_whiten` | advantage 归一化 | 在 DP**含**CP 组上 whiten，避免序列两半不同 affine |
| `policy_loss_function` in `loss.py` | 策略损失 | PPO clip / GSPO 序级 KL / CISPO / TIS / OPSM |
| `get_log_probs_and_entropy` in `loss.py` | vocab-parallel log-prob | `_VocabParallelLogProbEntropy` 自定义 autograd 省显存 |
| `compute_policy_loss` / `compute_cispo_loss` in `ppo_utils.py` | PPO clip / CISPO 损失 | `eps_clip` / `eps_clip_high` / `eps_clip_c` 双 clip |

</details>

## 核心实现

### 优势估计 dispatch

`compute_advantages_and_returns` 先算 KL：`kl_coef==0` 时跳过 ref_log_prob 计算（直接置零 KL），否则对每个 sample 的 `compute_approx_kl(log_probs[i], ref_log_probs[i], kl_loss_type)`。然后按估计器分发：

- **GRPO / GSPO / CISPO**：`returns = get_grpo_returns(rewards, kl)`（rewards - kl），`advantages = returns`。组归一化在 rollout 侧 `_post_process_rewards` 已做，这里 advantage 即 return。GSPO/CISPO 的差异在策略损失侧（序级 KL / 序级 importance），不在 advantage 侧。
- **PPO**：把 KL 作为负 reward 加到每步（`rewards[i] = -kl_coef * kl[i]`，cp_rank0 在末位加 reward），再 `get_advantages_and_returns_batch` 走 GAE（`args.gamma` / `args.lambd`）。
- **REINFORCE++**：`get_reinforce_plus_plus_returns`（discounted returns with KL），`advantages = returns`。
- **REINFORCE++_baseline**：`get_reinforce_plus_plus_baseline_advantages`（带 baseline）。

`ppo_utils.py` 的 GAE 实现支持分块：`chunked_discounted_returns` / `chunked_gae` 处理超长序列的分块 GAE（避免一次性算整序列的显存/数值问题）。`vanilla_gae` 是标准实现。

### CP 感知的 advantage 归一化

`normalize_advantages` 是 RL 静默 bug 的高发区，slime 在此下了专门防护。核心问题：context parallel（CP）把一条序列的 token 按 zigzag 切到两个 CP rank，每个 rank 只看到自己那半。如果用**不含 CP 的 DP 组**做 whitening，每个 CP rank 用自己的 mean/var 做仿射变换，一条序列的两半会得到不同的 affine 变换——破坏了同序列内 advantage 的相对关系。

```python title="backends/megatron_utils/loss.py"
# all_advs/all_masks 只覆盖本 CP rank 拥有的 token，
# 统计必须在 DP 含 CP 的组上归约
dp_cp_group = mpu.get_data_parallel_group(with_context_parallel=True)
whitened_advs_flat = distributed_masked_whiten(
    all_advs, all_masks, process_group=dp_cp_group, shift_mean=True)
```

代码注释明确指出：即使某 CP rank 合法地拥有零个 response token（prompt-heavy 序列把两个 chunk 都落进 prompt），也不能跳过 collective——跳了会让 `all_reduce` 失步。`distributed_masked_whiten` 处理空局部张量（贡献 0 到归约和）。CP size=1 时直接 `torch.cat(loss_masks)`，CP>1 时按 `get_logits_and_tokens_offset_with_cp` 的 token_offsets 把全局 offset 转成 response-space offset 切出每 rank 的 mask chunk。这种对 CP 边界条件的细致处理，是"correctness-first infrastructure"的典型体现。

### 策略损失：PPO clip / GSPO / CISPO / off-policy

`policy_loss_function` 先用 `get_log_probs_and_entropy` 从 logits 算当前 log-prob 与 entropy。这个函数用 `_VocabParallelLogProbEntropy`（`ppo_utils.py`，`torch.autograd.Function` 子类）做 vocab-parallel 的 log-prob 计算——在词表并行（VP）下避免每个 rank gather 全词表 logits 的显存爆炸，自定义 forward/backward 只归约必要梯度。

KL 计算分两种：GSPO 用**序级 KL**（`compute_gspo_kl`，需先 `all_gather_with_cp` 拼全序列 log-prob），其他用 per-token KL（`old_log_probs - log_probs`）。损失 dispatch：CISPO 走 `compute_cispo_loss`，其他走 `compute_policy_loss`（PPO clip，支持 `eps_clip` / `eps_clip_high` 双 clip 与 `eps_clip_c`）。OPSM（off-policy sequence masking）启用时 `compute_opsm_mask` 生成掩码乘到 pg_loss。

off-policy 修正：`use_tis` 开启时算 OIS（`(-ppo_kl).exp()`）与 TIS（truncated importance sampling），`tis_func` 可能做 rejection-sampling 风格的 masking 重建 `sum_of_sample_mean` 的分母。这里有个细节注释：mismatch/TIS/RS 的 metric 定义在 pre-RS 的有效 token 上，所以 metric 聚合保留原始 reducer，避免被 RS 掩码的 token 把 metric 人为推向 0。`sum_of_sample_mean` 是归约函数，用 `rollout_mask_sums` 作分母（见 [Rollout 模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/02-rollout) 的正确性防护）。top-p 路由重放通过 `get_rollout_top_p_logprob_kwargs` 把 rollout 时记录的 nucleus token ids 传入，让训练侧 log-prob 在受限候选集上算。

### 可插拔 advantage 估计器

`custom_advantage_function_path` 在 dispatch 之前优先调用（`loss.py:758`）：`load_function(args.custom_advantage_function_path)` 加载自定义函数，签名 `(args, rollout_data) -> None`，必须在 `rollout_data` 里填 `advantages` 与 `returns`。这允许研究者在不动训练内核的前提下试验新优势算法（如新的 GAE 变体、新的 baseline），是 slime"算法可配置"的扩展点。

## 扩展方式

新增优势算法：实现 `(args, rollout_data) -> None` 函数（填 `advantages`/`returns`），用 `--custom-advantage-function-path` 传入，`compute_advantages_and_returns` 优先调用它。内置算法切换：`--advantage-estimator grpo|gspo|cispo|ppo|reinforce_plus_plus|reinforce_plus_plus_baseline`。CP 感知 whitening 的开关：`--normalize-advantages`。OPD 蒸馏：`--use-opd` + teacher 配置。off-policy 修正：`--use-tis`。理解某算法优先读 `tests/utils/` 下对应单测（`ppo_utils` 的 advantage/return 正确性测试）。
