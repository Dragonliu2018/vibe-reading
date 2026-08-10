---
title: "Recursive Synthesis for Long-Horizon Terminal Tasks"
source:
  type: "论文解读"
  project: "Tencent"
  url: "https://arxiv.org/abs/2608.05466"
  pdf: "/vibe-reading/papers/recursive-synthesis-terminal-tasks.pdf"
date: "2026-08-10T18:00:00+08:00"
category: [AI, Agent, Papers]
tags: ["Synthetic Data", "Terminal Agents", "Recursive Synthesis", "RL", "SFT"]
description: "RST 递归扩展已验证种子任务的参考解决方案并重新对齐验证器与指令，从 639 个种子生成 37,484 个终端 agent 任务（约 $0.05/任务），SFT 和 PPO 训练后 Qwen3.5 在三个基准上显著提升。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/recursive-synthesis-terminal-tasks.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Recursive Synthesis for Long-Horizon Terminal Tasks](https://arxiv.org/abs/2608.05466) · **作者** Zhongzhi Li, Yucheng Shi, Zongxia Li 等 · **发表** arXiv, 2026-08 · **项目** [Hugging Face: Recursive Synthetic Terminal Tasks](https://huggingface.co/) · **解读** 2026-08-10

---

## 1. 论文概览

终端 agent 需要在命令行环境中执行多步骤工作流，但高质量的 long-horizon 训练数据极其昂贵——人工编写每个任务需数百到数千美元，而直接用 LLM 生成容易破坏指令、环境、参考解决方案和验证器之间的一致性。RST（Recursive Synthetic Terminal Tasks）通过递归扩展已验证种子任务来大规模构建可验证的终端 agent 任务。

**TL;DR**：RST 从 639 个种子任务出发，经过 15 轮递归合成，生成 37,484 个已验证终端任务（约 $0.05/任务），中位解决方案长度增长 5.6 倍（67→374 行），DeepSeek-V4-Pro pass@4 从 90% 降至 2.5%。用合成任务的拒绝采样轨迹做 SFT，Qwen3.5-27B 和 Qwen3.5-122B-A10B 在 Terminal-Bench 2、Terminal-Bench Hard 和 Long-Horizon Terminal Bench 上最多提升 10 个百分点；进一步用 PPO 训练，Qwen3.5-27B 在三个基准上分别达到 49.44%、32.00% 和 22.07%，相对提升 20.0%、41.2% 和 21.9%。

**核心贡献**：
1. **可扩展、低成本的 long-horizon 任务合成**：递归的 solution-first 合成框架，每个接受的任务都携带可执行的可解性证明，全程无人工介入
2. **标准训练下一致的下游改进**：Qwen3.5 自采轨迹做 SFT，两个模型尺度在三个基准上均获得最多 10 分提升
3. **无观察到的天花板**：15 轮后合成产率和验证率保持稳定，领域/操作符多样性保持，合成可继续扩展

| 元信息 | 值 |
| --- | --- |
| 作者 | Zhongzhi Li\* (Tencent HY LLM Frontier / U. Georgia), Yucheng Shi\*† (Tencent HY LLM Frontier, Project Lead), Zongxia Li\* (Tencent HY LLM Frontier / U. Maryland) 等 11 人 |
| 主要机构 | Tencent HY LLM Frontier |
| 论文类型 | arXiv 预印本 (cs.AI, cs.LG) |
| 发表时间 | 2026 年 8 月 |
| 代码/数据 | Hugging Face: Recursive Synthetic Terminal Tasks |
| 基座模型 | DeepSeek-V4-Pro（合成）, Qwen3.5-27B / Qwen3.5-122B-A10B（训练） |

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

High-quality long-horizon training data for terminal agents is expensive to produce, often costing hundreds to thousands of dollars per task, because each task must keep the instruction, environment, reference solution, and verifier mutually consistent. Human authoring does not scale, and direct generation with large language models (LLMs) often breaks these dependencies. We present Recursive Synthetic Terminal Tasks (RST), a recursive verified synthesis framework for constructing long-horizon terminal-agent tasks at scale. Starting from verified seed tasks, RST extends the reference solution, realigns the verifier and instruction to the new workflow, validates the result in a fresh sandbox, and reuses accepted tasks as seeds for subsequent rounds. Across fifteen recursive rounds, RST produces 37,484 synthesized terminal-agent tasks at roughly $0.05 per task. Task difficulty increases substantially over rounds: the median reference solution grows from 67 to 374 lines, the median number of executed commands grows from 40 to 244, and DeepSeek-V4-Pro pass@4 drops from 90% at R1 to 2.5% at R15. To demonstrate training utility, we collect rejection-sampled Qwen3.5 trajectories on the synthesized tasks and use them for supervised fine-tuning. Fine-tuning on these trajectories improves Qwen3.5-27B and Qwen3.5-122B-A10B by up to 10 points on Terminal-Bench 2, Terminal-Bench Hard, and Long-Horizon Terminal Bench, while agentic PPO lifts Qwen3.5-27B to 49.44%, 32.00%, and 22.07% on the three benchmarks, corresponding to relative gains of 20.0%, 41.2%, and 21.9% over the base model. Moreover, after 15 rounds, the recursion shows no ceiling: synthesis yield and validation rates remain stable as difficulty keeps climbing, indicating that the process can continue well beyond the scale reported here.

> **译：** 高质量的终端 agent long-horizon 训练数据生产成本高昂，每个任务通常需要数百到数千美元，因为每个任务必须保持指令、环境、参考解决方案和验证器之间的一致性。人工编写无法规模化，而直接用 LLM 生成经常破坏这些依赖关系。我们提出了 Recursive Synthetic Terminal Tasks (RST)，一个递归验证合成框架，用于大规模构建 long-horizon 终端 agent 任务。从已验证的种子任务出发，RST 扩展参考解决方案，重新对齐验证器和指令到新工作流，在全新沙箱中验证结果，并将接受的任务复用为后续轮次的种子。在 15 轮递归中，RST 以约 $0.05/任务的成本生成了 37,484 个合成的终端 agent 任务。任务难度逐轮显著增加：中位参考解决方案从 67 行增长到 374 行，中位执行命令数从 40 增长到 244，DeepSeek-V4-Pro pass@4 从 R1 的 90% 降至 R15 的 2.5%。为展示训练效用，我们在合成任务上收集 Qwen3.5 的拒绝采样轨迹并用于监督微调。微调使 Qwen3.5-27B 和 Qwen3.5-122B-A10B 在 Terminal-Bench 2、Terminal-Bench Hard 和 Long-Horizon Terminal Bench 上最多提升 10 个百分点，而 agentic PPO 使 Qwen3.5-27B 在三个基准上分别达到 49.44%、32.00% 和 22.07%，对应相对基线模型提升 20.0%、41.2% 和 21.9%。此外，15 轮后递归未显示天花板：合成产率和验证率在难度持续攀升时保持稳定，表明该过程可以远超本文报告的规模继续扩展。

</details>

---

## 2. 研究背景

**问题定义**：终端 agent 任务是一个自包含的可执行问题，包含五个组件——`instruction.md`（公开任务描述）、`task.toml`（运行时元数据与配置）、`environment/Dockerfile`（初始环境与工作区）、`solution/solve.sh`（参考解决方案）、`tests/test.sh` 和 `tests/test_state.py`（私有验证器）。agent 通过 Harbor 框架与 Terminus-2 harness 在隔离沙箱中交互，只能看到公开指令和初始化工作区，不能访问参考解决方案或私有验证器。

**现有方法的不足**：

| 方法 | 任务数 | 特点 | 局限 |
| --- | --- | --- | --- |
| SWE-Gym [25] | 2,438 | SWE 领域，可执行环境 | 无自适应，无 RL 验证 |
| TermiGen [52] | 3,500+ | 终端环境合成 | 无递归播种 |
| Endless Terminals [9] | 3,255 | RL 环境扩展 | 无重播种 |
| SETA [30] | 4,567 | 自适应难度 | 单轮，无递归复用 |
| Terminal-Corpus [27] | 254,000+ 轨迹 | 大规模 | 无 RL 验证 |
| **RST（本文）** | **37,484** | **递归验证合成 + RL + 重播种** | — |

核心缺口在于：现有方法要么不递归复用已验证任务作为种子，要么不将任务直接用于 verifier-based RL，导致合成规模和难度增长受限。RST 是唯一一个在多个合成代次中反复将已验证任务包作为种子的方法。

**相关工作与关键人物**：终端 agent 评估沿 SWE-Bench [17]、Terminal-Bench [23]、Long-Horizon Terminal Bench [21] 发展；合成环境方面有 Endless Terminals [9]、CLI-Universe [14]、SETA [30]；递归自我改进方面有 STAR [46]、V-star [13]、BenchEvolver [38]、TRACE [10]。RST 区别于 BenchEvolver 和 TRACE 的关键在于：递归演化完整终端任务（工作区 + 解决方案 + 验证器 + 公开指令），每次改写后重新对齐并验证，且接受的任务直接构成 verifier-based RL 的任务池。

---

## 3. 方法详解

RST 在多个合成轮次中构建终端 agent 训练任务。每一轮，前一轮接受的任务被选为种子，对每个种子扩展参考解决方案、更新验证器和公开指令以匹配新工作流，并在全新沙箱中验证。接受的任务既进入下一轮合成种子池，也构成 RL 任务池，而成功的 rollout 提供 SFT 轨迹。

### 3.1 整体架构

![Figure 2 RST 递归任务合成与 agent 训练架构：接受的任务播种后续合成轮次并构成 RL 任务池，成功 rollout 提供 SFT 轨迹](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-02-rst-architecture.png)

RST 的核心循环是：从已验证种子出发 → 扩展参考解决方案路径 → 对齐验证器与指令 → 构建更难的候选任务 → 在沙箱中验证 → 不可解的丢弃、可解的进入已验证任务池 → 该池同时供应后续合成种子和 RL 任务，成功 rollout 提供 SFT 轨迹。

### 3.2 每轮合成的四阶段流程

![Figure 3 单轮递归合成详细流程：种子任务经历目标选择、分阶段改写、本地与沙箱验证、多样性控制重播种](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-03-synthesis-pipeline.png)

**阶段 1 — 目标选择与任务合约**：流水线检查种子任务（文件、工具、依赖、现有工作流），从 40 个操作符（Figure 5）中选择一个合适的改写操作符。操作符分为五个家族：Configuration & Control State、Data/Manifest & Schema State、Filesystem & Resource Binding、Build/Cache & Artifact State、Runtime/Tooling & Diagnostics。选择结合局部兼容性评分、家族平衡项和逆频率惩罚，防止少数广泛适用的操作符主导生成池。选定操作符后，生成器记录改写计划，定义新的必需行为、解决方案变更、验证器检查的中间/最终结果，以及 agent 可通过指令或工作区获取的信息。

![Figure 5 终端 agent 原语的概念分类法，用于刻画能力覆盖。环标签为缩写，实现级改写家族和 40 个操作符定义在 Appendix C](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-05-operator-taxonomy.png)

**阶段 2 — 改写：先扩展解决方案，再对齐**：改写从可执行行为和运行时条件推进到公开任务规范。首先扩展 `solve.sh`，添加文件检查、值推导、工具调用、状态管理等操作。然后修改环境以支持这些操作（安装新依赖、提供额外文件/配置、初始化服务、调整权限等）。解决方案和环境定义完整执行路径后，更新验证器检查产出物和状态转换，拒绝占位符、硬编码输出和省略的中间工作。最后修订公开指令，说明新目标并标识无法从环境发现的需求信息。

**阶段 3 — 验证：本地过滤与沙箱 oracle**：验证分两阶段。首先静态检查拒绝近似重复、缺失文件、无效元数据、公开指令暴露私有验证器细节等。通过静态检查的候选在全新沙箱中评估——构建初始环境、执行参考解决方案、运行私有验证器。失败可修复时，使用验证日志进行有限次数修复（最多 2 轮），修复后重新验证；持续失败则丢弃。

**阶段 4 — 选择与多样性控制**：接受的任务在父系谱系、类别、改写家族和生成 cohort 上施加 caps，防少数父系或改写模式主导后续轮次。选出的任务进入下一轮合成，接受的子任务形成 R_r。

---

## 4. 关键公式解读

### 任务接受准则

一个合成任务被接受需同时满足两个条件：

$$
\text{Accepted}(t) = \underbrace{\text{OracleValid}(t)}_{\text{参考解决方案在全新沙箱中通过私有验证器}} \wedge \underbrace{\text{ContractValid}(t)}_{\text{验证器检查的每个需求都在公开指令或工作区中声明}}
$$

- **Oracle Validity**（oracle 有效性）：验证任务可执行——参考解决方案必须通过验证器且无执行异常
- **Contract Validity**（合约有效性）：防止私有测试引入 agent 无法得知的隐藏需求——验证器检查的每个要求必须在公开指令中声明或可从工作区推断

### 合成产率指标

产率按每 1,000 次种子尝试归一化，支持跨轮次比较：

$$
\text{Yield}_r = \frac{|\text{Accepted}_r|}{|\text{Attempts}_r|} \times 1000
$$

15 轮中产率维持在 498.2–572.2 之间（R15 为 530.0 vs R1 为 551.6），候选通过率在 74.5%–81.5% 之间。

### 难度评估指标

- **Pass@4**：4 次尝试内的完整任务完成率
- **Partial Credit**：rollout 后通过的验证器检查比例

$$
\text{PartialCredit} = \frac{|\text{checks passed}|}{|\text{total verifier checks}|}
$$

DeepSeek-V4-Pro 的 pass@4 从 R1 的 90% 单调下降到 R15 的 2.5%（36 倍降低），平均 partial credit 从 0.970 降至 0.170。

---

## 5. 实验设置

### 数据集

- **Bootstrap 种子**：639 个已验证任务，来自 TerminalWorld [3]（从真实交互记录构建的已验证终端任务数据集）。将原始细粒度类别标签合并为 19 个领域（Build & Compile、Scripting & Automation、System Admin 等）
- **合成任务池**：R1–R15 共 37,484 个任务，R1 从 639 个 bootstrap 种子合成 2,820 个接受任务（bootstrap 不计为合成轮次）
- **RL 训练池**：synth-all 集，包含 R1 合成池 + R2–R15 的 oracle-passed 任务，共 37,484 个，在 Daytona 沙箱中执行

### 评估基准

| 基准 | 描述 | 任务数 |
| --- | --- | --- |
| Terminal-Bench 2 (TB2) | 广泛终端执行，标准化沙箱环境，可执行评分 [23] | 89 |
| Terminal-Bench Hard | TMax-15K [16] 中抽取的独立构造任务分布 | 100 |
| Long-Horizon Terminal Bench (LHTB) | 持久化多阶段终端工作流，密集 partial-credit 评分 [21] | 46 |

### 基线模型

| 模型 | 用途 |
| --- | --- |
| DeepSeek-V4-Pro | 合成生成器 + 难度评估 solver |
| GPT-5.6-sol | 难度评估 solver（对照） |
| Qwen3.5-27B | SFT + PPO 训练对象 |
| Qwen3.5-122B-A10B | SFT 训练对象 |

### 训练配置

- **SFT**：在合成任务上收集 Qwen3.5 的拒绝采样（rejection-sampled）成功轨迹，按递归轮次分阶段训练（1R/2R/3R）
- **PPO**：从 Qwen3.5-27B 基线权重冷启动（cold actor start），PPO value head 从已有终端 agent critic checkpoint 暖加载，PPO clipping $\epsilon = 0.2$，KL penalty 和 entropy bonus 禁用，advantages 做零均值单位方差白化。Reward 来自每个任务内置验证器的定制 reward shaping

### 污染检查

对 R1/R5/R10/R15 采样与全部基准任务做任务描述距离分析：在归一化 13-token 滑窗准则下，无基准任务匹配任何采样合成轮次；最大成对 5-gram Jaccard 相似度低于 0.009；unigram Jensen-Shannon 散度从 R1 到 R15 对所有三个基准均增加，表明递归合成产生的任务分布与基准分布日益不同。

---

## 6. 实验结果

### 6.1 递归合成稳定性

![Figure 6 跨合成轮次的通过产率（每 1,000 次种子尝试）和候选通过率。两者在 R15 保持稳定，无系统性下降](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-06-synthesis-yield.png)

15 轮递归复用后，合成保持稳定而非崩溃。通过产率在 498.2–572.2 之间，候选通过率在 74.5%–81.5% 之间，R1 和 R15 值相近（77.5% vs 78.0%）。

### 6.2 结构增长

![Figure 7 R1 到 R15 八个任务结构指标的分布趋势。中位和上分位值在解决方案长度、命令使用、CLI 工具、控制流、断言和文件操作方面增长最强，而指令长度增长较慢](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-07-task-structure-metrics.png)

从 R1 到 R15，中位解决方案长度从 67 行增长到 374 行（5.6 倍），命令数从 40 增长到 244（6.1 倍），唯一 CLI 工具从 17 增长到 71（4.2 倍），控制流操作从 6 增长到 45（7.5 倍），文件操作从 2 增长到 14（7.0 倍），验证器断言从 17 增长到 57（3.4 倍），而指令长度仅从 85 词增长到 122 词（1.4 倍）。

![Figure 8 R1 到 R15 各任务结构指标的中位扩展因子。可执行工作相关指标增长远快于指令长度](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-08-expansion-factors.png)

关键发现：递归合成增加的是**可执行工作负载**而非提示长度——后期任务的复杂度来自新的可执行需求，而不是更长的指令。

### 6.3 任务难度

![Figure 12 DeepSeek-V4-Pro 在各合成轮次子集上的 pass@4。成功率从 R1 的 90% 单调下降到 R15 的 2.5%](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-12-pass4-decline.png)

![Figure 1 跨合成轮次的 pass rate 和轨迹长度。DeepSeek-V4-Pro 和 GPT-5.6-sol 在 70%/80%/90% partial credit 阈值下的 pass rate 及通过任务的轨迹长度](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-01-pass-rate-trajectory.png)

DeepSeek-V4-Pro pass@4 从 R1 的 90% 单调下降到 R15 的 2.5%（36 倍降低）。mean partial credit 从 0.970 降至 0.170。由于 solver 和推理配置在轮次间不变，该下降反映任务分布变化而非模型能力变化。失败也从"接近通过"变为"严重失败"：failed attempts 中满足 ≥75% 验证器检查的比例从 86.4% 降至 1.2%，低于 50% 检查的任务比例从 0% 升至 97.5%。

### 6.4 监督微调结果

![Figure 23 Qwen3.5-27B 和 Qwen3.5-122B-A10B 在逐步增加合成轮次轨迹的 SFT 后的基准表现](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-23-sft-benchmark.png)

性能随训练阶段单调提升。三轮训练后：

| 模型 | 训练阶段 | TB2 | TB Hard | LHTB |
| --- | --- | --- | --- | --- |
| Qwen3.5-27B | Base | 41.20 ± 1.72 | 22.67 ± 2.52 | 18.10 ± 0.89 |
| Qwen3.5-27B | Round 1 | 42.32 ± 4.68 | 23.00 ± 1.73 | 21.32 ± 0.86 |
| Qwen3.5-27B | Round 2 | 44.57 ± 4.25 | 27.33 ± 1.53 | 21.99 ± 1.39 |
| Qwen3.5-27B | Round 3 | **47.94 ± 2.34** | **28.33 ± 0.58** | **22.44 ± 0.40** |
| Qwen3.5-122B-A10B | Base | 43.82 ± 2.97 | 20.00 ± 1.00 | 18.85 ± 1.16 |
| Qwen3.5-122B-A10B | Round 1 | 44.19 ± 1.30 | 21.33 ± 3.21 | 20.06 ± 0.32 |
| Qwen3.5-122B-A10B | Round 2 | 47.94 ± 1.72 | 29.33 ± 2.08 | 20.24 ± 0.60 |
| Qwen3.5-122B-A10B | Round 3 | **49.44 ± 1.12** | **30.00 ± 1.73** | **23.63 ± 2.76** |

### 6.5 终端 Agentic 强化学习结果

![Figure 24 合成终端任务上的 RL 动态：(a) mean verifier reward 从约 0.11 升至 0.14 以上；(b) mean 每轨迹交互轮次从 19-20 升至 30 以上](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-24-rl-dynamics.png)

PPO 训练中，mean verifier reward 的 5 步移动平均从约 0.11 升至 0.14 以上（峰值在 step 55-60 附近），mean 轨迹长度从 19-20 轮升至 30+ 轮。这表明策略学会在满足更多验证器检查的同时维持更长的终端交互。

| 模型 | TB2 | TB Hard | LHTB |
| --- | --- | --- | --- |
| DeepSeek-V4-Pro | 51.68 | 36.00 | 30.00 |
| Qwen3.5-27B Base | 41.20 | 22.67 | 18.10 |
| Qwen3.5-122B-A10B Base | 43.82 | 20.00 | 18.85 |
| **Qwen3.5-27B-RL** | **49.44** | **32.00** | **22.07** |
| 相对提升 | **+20.00%** | **+41.16%** | **+21.93%** |

最大相对提升出现在 Terminal-Bench Hard（+41.16%），说明 verifier-based RL 迁移到了独立于训练池构造的任务上。DeepSeek-V4-Pro 在三个基准上仍然更强，表明仍有实质性性能提升空间。

### 6.6 案例：JSON-Diff 回归任务的递归增长

论文跟踪了一条从 bootstrap 种子到 R15 的精确谱系。原始任务要求 agent 对固定 JSON fixture 对运行 `gendiff` 命令行工具并保存报告。后续轮次保留核心目标但逐步添加配置文件、回归用例、故障诊断、release-note 更新和可执行测试。

| Checkpoint | 公开任务 | 新增上下文 | 行数 |
| --- | --- | --- | --- |
| Seed | 生成 6 个 JSON-diff 报告 | 固定输入文件的手动 CLI 示例 | 10 |
| R1 | 按 tasks.json 生成所有 diff 输出 | 比较矩阵移入配置 | 66 |
| R5 | 修复 tasks.json 后重新生成 diff | 配置可能无效，需诊断 | 219 |
| R10 | 用 CHANGELOG.md 添加新嵌套 fixture 回归 | release note 引入新 fixture | 264 |
| R15 | 修复不一致的配置和 fixture 数据，协调预期 diff 计数 | 配置、fixture、预期计数和测试须一致 | 347 |

参考解决方案从 10 行增长到 347 行，但任务领域始终不变——递归合成增加的是可执行工作而非领域切换。

---

## 7. 消融实验

### 7.1 领域多样性保持

![Figure 4 从 639 个 bootstrap 种子到递归合成的领域组成与稳定性。(a) 各领域比例；(b) 归一化 Shannon 熵；(c) 领域覆盖（represented 和 effective 数量）；(d) 领域集中度（Top-1 和 Top-3）](/vibe-reading/images/articles/recursive-synthesis-terminal-tasks/fig-04-domain-composition.png)

任务池在合成轮次间保持广泛的领域覆盖。最大领域始终低于池的四分之一，归一化熵仅从 0.821 变到 0.817，有效领域数几乎不变（11.22 vs 11.09）。无领域坍缩迹象。

### 7.2 改写家族与操作符覆盖

改写家族熵在 2.26–2.31 bits 之间（接近 $\log_2 5 = 2.32$ 的最大值），最大家族在任意轮次不超过 29%。R15 中 36/40 个操作符仍被使用，最频繁操作符仅占 8.0%，前 12 之外的操作符仍占 31.0%。递归复用保持 ancestry 和 transformation 机制的多样性。

### 7.3 谱系与新颖性

Bootstrap 种子覆盖从 R2 的 98.3% 逐渐降至 R15 的 60.1%，但无单个种子在任何轮次贡献超过 0.77% 的任务。R15 中 parent-child 新颖性：指令 0.36、解决方案 0.18、验证器 0.33——后期子任务仍修改全部三个组件。轮内最近邻相似度中位从 R1 的 0.223 升至 R15 的 0.464，但仍低于 0.5，p95 为 0.703——高相似度集中在有限上尾而非整个任务池。

### 7.4 公开指令审计

后期任务不仅更复杂，也与公开指令更对齐。Hidden-check 保护从 38.2% 增至 63.5%，short-instruction 风险从 41.6% 降至 7.5%，私有测试引用和字面泄露在 R15 分别仅为 0.1% 和 0%。中位需求覆盖率从 0.42 升至 0.57，强 grounded 任务占比从 14.3% 升至 38.0%。

---

## 8. 总结与展望

### 贡献总结

RST 首次实现了递归验证合成终端 agent 任务的完整框架：每一轮扩展参考解决方案引入额外可执行工作、更新验证器和公开指令描述同一任务、在全新沙箱中验证完整候选。任务仅在参考解决方案通过私有验证器且每个被测需求在指令或工作区中声明时被接受。15 轮合成生成 37,484 个任务（约 $50/1,000 个接受任务），中位解决方案增长 5.6 倍，命令使用增长 6.1 倍。SFT 和 PPO 训练均带来一致的下游基准改进。

### 局限性

1. **高相似度尾部**：R15 的 p95 最近邻相似度为 0.703，虽集中在有限上尾，但在进一步扩展时需要针对性去重
2. **DeepSeek-V4-Pro 仍有优势**：Qwen3.5-27B-RL 在三个基准上均未超过 DeepSeek-V4-Pro，性能提升空间仍大
3. **单一生成模型依赖**：合成主要使用 DeepSeek-V4-Pro 作为生成器，虽论文声称不依赖特定种子领域或生成模型，但未充分验证多生成器场景
4. **成本仍非零**：虽 $0.05/任务远低于人工编写，但 37,484 个任务仍需约 $1,874 的生成成本
5. **R15 后的 pass rate 极低**（2.5%），意味着后期任务可能过于困难，对训练的实际贡献需要进一步分析

### 未来方向

**弥补缺陷**：
- 在进一步扩展时实施针对性去重策略，管理高相似度上尾
- 探索多生成模型组合，验证框架的生成器无关性

**新型方案**：
- 将 RST 框架从终端 agent 扩展到 web agent、桌面 agent 等其他 long-horizon agent 领域
- 结合 self-play 或 self-rewarding 机制，让 agent 自行发现和构造种子任务

**减少约束**：
- 论文观察到 15 轮后无天花板——可继续扩展到 30+ 轮，探索合成在更大规模下的行为
- 研究在 pass rate 极低（<5%）的后期任务上训练的实际收益与过难任务的权衡
- 探索动态难度选择：根据训练进度自动选择合适轮次的任务，而非使用 synth-all 全集
