---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "Agentic 工作流"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "agentic RL", "trajectory", "sandbox"]
description: "slime 的 agentic 工作流层：多轮消息树、token drift 分类、沙箱与 harness 接入。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime/agent/` 是 agentic RL 的工作流层——把多轮、带工具调用、带环境交互、带子 agent 的复杂 rollout 转成训练样本。它的核心难题是：一次 rollout 执行里，模型的生成 token、工具/环境的反馈 token、子 agent 的输出 token 交织在一起，哪些该训（trainable，loss_mask=1）、哪些不该训（loss_mask=0）、跨轮的 prompt 前缀怎么对齐、一次 rollout 拆出的多个训练样本怎么共享 `rollout_id`——这些都在这里解决。它作为"返回 `Sample` 列表的函数"经 `rollout_function_path` 接入（见 [Rollout 模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/02-rollout)），不分叉训练内核。

## 模块架构

![agentic 轨迹树](/vibe-reading/images/articles/slime-internals/trajectory-tree.svg)

`trajectory.py` 是核心。`MessageNode` 是多轮会话树的节点（有 `add_child` / `path_from_root` / `leaves`），`TurnRecord` 记录单轮交互。`TrajectoryManager` 按 session 管理多轮会话树：`record_turn` 把一轮的 messages 挂到树上（`_find_mount_point` 找挂载点、`_try_merge_assistant_rewrite` 处理 assistant 重写合并），`get_trajectory` 取出从根到叶的链。`_SampleBuilder` 是链→样本的转换器：`classify_token_drift` 判断 token 是模型新生成还是上轮复用（`DriftKind`），`append_turn` 按轮追加 token 并设 loss_mask，`to_sample` 产出最终 `Sample`。`_chain_to_samples` 把一条链拆成多个训练样本。`sandbox.py` 的 `Sandbox` Protocol + `E2BSandbox` 提供代码执行沙箱；`harness/`（claude_code/codex）与 `adapters/`（anthropic/openai）是外部 agent harness 与 LLM 客户端的适配。

## 调用链路

```text
TrajectoryManager.record_turn(sid, turn, kind, trained)   # trajectory.py
  └─ _find_mount_point(root, messages)                    # 在树上找挂载点
  └─ _mount_prompt_messages / _attach_assistant_leaf      # 挂载新节点
  └─ _try_merge_assistant_rewrite                         # assistant 重写合并
TrajectoryManager.get_trajectory(sid) → list[MessageNode] # 取根到叶链
  └─ _split_chain_into_builders(chain)                    # 链拆成 _SampleBuilder 段
      └─ _SampleBuilder.append_turn(turn, kind, trained)  # 逐轮追加 token
          └─ classify_token_drift(turn) → DriftKind        # 区分新生成 vs 复用
          └─ _align_to_prompt / _append_tokens            # 对齐前缀 + 设 loss_mask
      └─ _SampleBuilder.to_sample() → Sample              # 产出训练样本（共享 rollout_id）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `TrajectoryManager.record_turn` in `trajectory.py` | 挂载一轮到会话树 | `_find_mount_point` 找挂载点；`fork_threshold` 控制何时分叉 |
| `_find_mount_point` in `trajectory.py` | 在树中定位 messages 的挂载点 | 用 `_common_prefix_len` 匹配前缀 |
| `_try_merge_assistant_rewrite` in `trajectory.py` | 合并 assistant 重写 | 避免重复存储重写前的前缀 |
| `_SampleBuilder.classify_token_drift` in `trajectory.py` | 判断 token 是新生成还是上轮复用 | `DriftKind` 区分，决定 loss_mask |
| `_SampleBuilder.append_turn` in `trajectory.py` | 逐轮追加 token + 设 loss_mask | 模型生成 trainable=True，工具/环境 trainable=False |
| `_SampleBuilder.to_sample` in `trajectory.py` | 产出 `Sample` | 设 rollout_id 让 sibling 共享 |
| `E2BSandbox` in `sandbox.py` | 代码执行沙箱 | 环境变量配置 image/lifetime/rpc retries；瞬时错误重试 |

</details>

## 核心实现

### 多轮消息树与挂载点

agentic rollout 的多轮交互不是线性的——一个 session 可能有 fork（一个 prompt 分支出多个 assistant 响应尝试）、assistant 重写（同一轮重新生成）。`MessageNode` 树结构承载这种非线性：`path_from_root` 取根到当前节点的链，`leaves` 取所有叶。`_find_mount_point` 用 `_common_prefix_len`（分 chunk 比较避免一次性比超长序列）找到新 messages 与现有树的最大公共前缀，确定挂载点。`_try_merge_assistant_rewrite` 处理 assistant 重写时不重复存储前缀。`fork_threshold_tokens` 控制何时把后续轮次作为分叉而非续接——影响 `_split_chain_into_builders` 把一条链拆成几个 `_SampleBuilder`（即几个训练样本）。

### token drift 分类：决定哪些 token 该训

`_SampleBuilder.classify_token_drift` 是 agentic 训练正确性的关键。多轮 rollout 里，每一轮的 prompt 前缀往往复用上一轮已生成的 token，但只有"这一轮模型新生成的 token"才该进 loss。`DriftKind` 枚举区分 drift 类型：若这一轮的 token 与上一轮记录的完全一致（复用），则 loss_mask=0（已在更早的轮被训过）；若是模型新生成的，loss_mask=1。`_align_to_prompt` 把新轮的 prompt 前缀对齐到已有 token 流（不重复存 prompt），`_append_tokens` 按 `loss_mask` 参数追加。最终 `to_sample` 产出的 `Sample` 里，`tokens` 是完整序列、`loss_mask` 精确标出哪些 token 参与训练、`rollout_log_probs` 对齐 loss_mask（非 trainable 的补 0.0）。这与 `slime/utils/types.py` 的 `Sample.append_response_tokens(trainable=...)` 契约一致——模块 02 已讲，agent 模块是这个契约的重度使用者。

### rollout_id 共享与多样本拆分

一次 agentic rollout 可能产出多个训练样本（如 fork 出多个尝试，或子 agent 各自一段）。`_chain_to_samples` 把一条链拆成多个 `Sample`，关键约束是它们必须共享同一个 `rollout_id`——否则训练侧的损失归约（用 `rollout_mask_sums` 作分母，见模块 02）会把一个 rollout 算成 N 次。`to_sample` 设 rollout_id 时保证 sibling 一致。这与 `RolloutManager._get_rollout_data` 的 `_validate_rollout_id_annotated` 契约对接——后者在 flatten 前强制校验每个嵌套 `list[Sample]` 元素都有 rollout_id。

### 沙箱、harness 与适配器

`Sandbox` 是个 `Protocol`，`E2BSandbox`（`sandbox.py`）是 E2B 云沙箱的实现——环境变量配置 image metadata、lifetime、rpc retries、size，`_is_transient_rpc_error` 区分瞬时错误重试。`harness/`（`claude_code.py` / `codex.py`）是把外部 agent harness（Claude Code、Codex CLI）作为 rollout执行器的适配——这些 harness 自己跑 agent 循环，slime 只收集其轨迹转训练样本。`adapters/`（`anthropic.py` / `openai.py`）是 LLM API 客户端适配，`aiohttp_threaded.py` 提供线程化的 aiohttp（避免 asyncio 与某些同步代码冲突）。`parsing.py` 解析生成输出（工具调用、结构化输出）。

## 扩展方式

接入新 agentic workflow：实现一个返回 `list[list[Sample]]` 的生成函数（用 `--rollout-function-path`），内部用 `TrajectoryManager` 管理多轮树、`_SampleBuilder.append_turn` 设 loss_mask、`to_sample` 设共享 rollout_id。可参考 `examples/coding_agent_rl`（带代码沙箱的 agentic RL）、`examples/multi_agent`（多 agent）、`examples/tau-bench`（工具调用 benchmark）。新增沙箱：实现 `Sandbox` Protocol，用 `--sandbox-cls-path` 注入。接入新 harness：在 `harness/` 加适配器，实现轨迹收集接口。
