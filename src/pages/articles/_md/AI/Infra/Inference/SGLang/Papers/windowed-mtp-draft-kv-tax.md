---
title: "Windowed-MTP: Removing the Full-Context Draft-KV Tax at Million-Token Context"
source:
  type: "论文解读"
  project: "NVIDIA"
  url: "https://arxiv.org/abs/2607.21535"
  pdf: "/vibe-reading/papers/windowed-mtp-draft-kv-tax.pdf"
date: "2026-08-07T10:30:00+08:00"
category: [AI, Infra, Inference, SGLang, Papers]
tags: ["Speculative Decoding", "Long Context", "MTP", "SGLang"]
description: "百万 token 下内置 MTP 草稿头在全 KV 上跑注意力使草稿成本随长度线性增长；Windowed-MTP 仅对草稿注意力加窗+sink，训练-free、无损地削减每解码步成本 28–44%。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/windowed-mtp-draft-kv-tax.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Windowed-MTP: Removing the Full-Context Draft-KV Tax at Million-Token Context](https://arxiv.org/abs/2607.21535) · **作者** Alagappan Valliappan (NVIDIA) · **发表** arXiv, 2026-07 · **项目** [avalliappan-nvidia/windowed-mtp-b200](https://github.com/avalliappan-nvidia/windowed-mtp-b200) · **解读** 2026-08-07

---

## 1. 论文概览

**TL;DR**：前沿模型普遍内置一个轻量 MTP（Multi-Token-Prediction / NEXTN）草稿头来做投机解码，默认假设"草稿很便宜"。但在百万级（1M）长上下文里这个假设崩了——草稿头每步都在**全量 KV cache** 上跑 full attention，草稿成本随上下文线性增长，恰恰在最该受益的长上下文场景反而成了瓶颈，甚至让深层草稿比不投机还慢。本文提出 **Windowed-MTP**：只对**草稿的注意力**套一个 StreamingLLM 式的滑动窗口 + attention sink，验证器照旧全注意力。它**训练-free、即插即用、构造上无损**（最终接受的 token 仍由全注意力的 target 决定），把草稿的 KV 工作集压成常数，在 1M 丢弃约 99% 的 KV 条目；三种架构（Qwen GDN-MoE 35B/122B、Mamba2-hybrid NoPE 120B）在单卡 B200 + SGLang 上，相比出厂原生 MTP 草稿把每解码步成本降 **+28% 到 +44%**，且这个增益随上下文长度变长而变大。

**一句话 take-home**：草稿只需要当个"够好的猜测者"，好的局部猜测不需要完整百万 token 历史；把草稿注意力窗口化，长上下文投机解码的成本税就消失了，而输出分布一个 token 都不变。

**元信息**：作者 Alagappan Valliappan，来自 NVIDIA；25 页、2 图、11 表；在 SGLang 生产框架（连续批处理、paged/radix KV、CUDA-graph capture）内实现并评测，而非单请求延迟玩具。复现包（SGLang patch + run/config 脚本 + seeded 输入）已开源于 GitHub。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Speculative decoding accelerates autoregressive generation by having a cheap draft propose tokens that a target verifies in parallel. Frontier models increasingly ship a built-in Multi-Token-Prediction (MTP / NEXTN) draft head, under the prevailing assumption that the draft is negligibly cheap. At million-token context this assumption breaks. Typically, an MTP draft head runs full attention over the entire KV cache at every draft step, so its read grows linearly with context and comes to dominate the draft cost—precisely in the long-context regime where speculation is most valuable. The effect compounds with draft length—on hard, low-acceptance workloads a deep native MTP draft can turn net-negative, slower than no speculation at all—and the shift to hybrid/linear-attention targets sharpens it: cheaper verification leaves the draft's full-attention read exposed, so at long context it becomes a significant, no-longer-negligible share of each decode step. We apply a StreamingLLM-style sliding window plus attention sink to the draft's attention only (Windowed-MTP), leaving full-attention verification intact. It is training-free, drop-in, and lossless by construction: the full-attention target still decides every accepted token, so windowing changes only which tokens are proposed, never which are accepted. It bounds the draft's KV working set to a constant, dropping ~99% of KV entries from the draft's read path at 1M. Across three architecture families (Qwen GDN-MoE 35B/122B and a Mamba2-hybrid NoPE 120B) at 1M context on a single GPU in SGLang, windowing the MTP draft cuts the per-decode-step cost over the shipping native MTP draft by +28% to +44%—an input-invariant margin that widens with context length.

> **译：** 投机解码通过让一个便宜的草稿提出 token、由 target 并行验证来加速自回归生成。前沿模型越来越多地内置一个 Multi-Token-Prediction（MTP / NEXTN）草稿头，基于"草稿可忽略不计"的主流假设。但在百万 token 上下文下这个假设失效了。典型地，MTP 草稿头每步对整个 KV cache 跑 full attention，其读取随上下文线性增长并主导草稿成本——恰恰在最该受益的长上下文场景。该效应随草稿深度累积——在难、低接受率负载上一个深层原生 MTP 草稿可能净负、比不投机还慢——而向 hybrid/线性注意力 target 的迁移加剧了它：更便宜的验证暴露了草稿的全注意力读取，于是在长上下文它成为每个解码步中一个显著的、不可再忽略的份额。我们对草稿的注意力施加一个 StreamingLLM 式的滑动窗口 + attention sink（Windowed-MTP），保持全注意力的验证不变。它训练-free、即插即用、构造上无损：全注意力的 target 仍决定每个接受的 token，所以加窗只改变提出哪些 token，绝不改变接受哪些。它把草稿的 KV 工作集限定为常数，在 1M 从草稿的读取路径丢弃约 99% 的 KV 条目。在三种架构族（Qwen GDN-MoE 35B/122B 和 Mamba2-hybrid NoPE 120B）上、1M 上下文、单 GPU 的 SGLang 中，加窗 MTP 草稿相对出厂原生 MTP 草稿把每解码步成本降低 +28% 到 +44%——一个随上下文长度扩大的、输入无关的增益。

</details>

---

## 2. 研究背景

### 问题：长上下文里的"草稿税"

投机解码（Speculative Decoding, SD）的标准成本模型把草稿当作免费的——短上下文时确实如此，草稿一次前向只是 target 验证的一小部分。但长上下文下这个模型失效。更糟的是，模型设计的两个趋势在**放大**这个失败：

1. **target 越来越便宜**：前沿模型正把 target 迁到 hybrid / 线性注意力（GDN、Mamba2）以压低长上下文 KV 成本，verify 步在缩小；但内置的 MTP/NEXTN 草稿头却仍出厂带**全（softmax/GQA）注意力**。草稿每次前向读 $O(S)$ 的 KV cache，verify 越便宜，草稿的 $O(S)$ 读取在每解码步里的占比就越暴露。
2. **草稿成本随深度累积**：一次投机解码步跑 $\gamma$ 次草稿前向；在难、低接受率负载上，原生深层草稿（如 $d=7$）在 1M 上已经跌破 dense 基线——**比不投机还慢**（Qwen-122B code QA 0.80×、Nemotron fwe 0.97×），且更深的 $d=9$ 也救不回来。

一个被论文点出的关键反直觉点：这个税是**本质上长上下文**的、对短上下文工作几乎不可见。因为单层草稿的 KV 每 token 只有约 1–2 KB（Qwen 草稿 2 KB、Nemotron 1 KB），在 8–32K 上下文时 $\gamma$ 次重复全 KV 读取的工作集只有约 8–64 MB——常驻在约 50 MB 级的 L2 里，重读几乎免费；而到了 1M，约 1–2 GB 的草稿 KV 在任何层级都缓存不下，每步暴露 $\gamma \times$ HBM 读取。

### 相关工作与定位

- **投机解码 & MTP 头**：从独立小模型 [Leviathan et al. 2023]、自多预测头 [Cai et al. 2024]、特征级自回归 EAGLE [Li et al. 2024a,b]，到 DeepSeek-V3 / Qwen3 出厂内置的 MTP/NEXTN 头（本文目标）。接受长度 AL 决定加速比，先前工作优化 AL 的草稿对齐 / 树草稿；本文**正交**——不动验证器、只降草稿在长上下文的成本。
- **长上下文 SD**：MagicDec [Chen et al. 2024] 观察到长上下文大 batch 下 SD 瓶颈转到 KV 加载，用定长 KV 草稿打破延迟-吞吐权衡。本文共享该诊断，但聚焦**出厂内置的 MTP 头**，加了无损性论证（target 验证每个接受 token）+ 输出等价性经验核验 + 接受率何时保持/被交易的机制分析。最接近的 LongSpec [Yang et al. 2026]（训练一个专用定长 KV 草稿 + hybrid 树注意力，dense target、≤64K）和 SpecExtend [Cha et al. 2026]（训练-free、即插即用但靠独立草稿模型 + 跨模型检索 KV 策略，评测在更短的长上下文）与本文在三条轴上不同：(i) 本文加窗的是**已出厂的 MTP/NEXTN 头**而非独立/训练的草稿；(ii) 本文目标是 **1M token 的 hybrid-attention 模型**，便宜验证器暴露草稿的 $O(S)$ 读取；(iii) 本文把成本刻画放在一个**生产 serving 框架**内（连续批处理、paged/radix KV、CUDA-graph capture）而非单请求延迟 harness。
- **流式注意力 & 上下文扩展**：StreamingLLM [Xiao et al. 2024] 证明保留少量初始 "sink" token + 最近窗口即可在有限注意力下保持流畅。本文把它**改造为仅草稿的近似**——草稿只提候选、每个候选都被 target 验证，所以漏掉的远 token 至多换来一次拒绝（降 AL），绝不会换来错误答案。SGLang 里既有的 `–speculative-draft-window-size` 只接两条草稿路径（DFLASH、Llama-family EAGLE-3），对本文目标的内置 MTP/NEXTN 头是 no-op，且缺 attention sink 与 KV 回收，无法复用。

---

## 3. 方法详解：Windowed-MTP

### 机制

在每次草稿解码步，给草稿注意力一个**缩减的 key 集**：前 $n_{\text{sink}}$ 个 token（attention sink）加上最近的 $W$ 个 token。在 paged-KV serving 系统里，这通过把草稿的 per-request block table 缩减为 `[sink blocks] ∥ [recent W blocks]`（连同对应 sequence length）实现，并禁用任何额外的因果窗口掩码（缩减后的表本身就是 key 集）。因为 **RoPE 已烤进缓存的 key 里**，一个 block 在缩减表里的绝对位置不会改变得分。target 的验证**原封不动**，仍在全上下文上做注意力。无需新 kernel、新参数或训练；改动只是草稿 KV-index 构造里的几行，且是 graph-safe 的。

![图1 草稿注意力加窗前后对比：原生 MTP 草稿注意全量增长键集（成本与 KV 占 footprint 随上下文 t 增长），Windowed-MTP 限制为 sink + 最近 W 的固定足迹 nsink+W+d，中间键被草稿永不读取并回收为紧凑环形缓冲](/vibe-reading/images/articles/windowed-mtp-draft-kv-tax/fig-01-mechanism.png)

### 无损性

令 target 在全上下文上诱导 next-token 分布 $p(\cdot \mid x_{<t})$。SD 在 $p$ 下按标准拒绝/贪婪规则接受提议 token $\tilde{x}_t$；被拒绝的位置从 $p$ 重采样。草稿分布 $q$ 只影响**提出哪些 token**与接受概率，但每个被接受或重采样的 token 都取自 target 的 $p$。把 $q$（全注意力草稿）换成 $q_{\text{win}}$（加窗草稿）因此**输出分布仍是精确的 $p$**，只改变 AL（因而改变速度）。在贪婪解码 + 精确算术下这是一个 bit-exact 的陈述。

实践中 bf16 SD 对 dense 并非 bit-exact：一次批处理 forward 验证 $d+1$ 个 token 会重排浮点归约，偶尔 argmax 近平局翻转并累积。但关键是这个扰动是**验证批的属性**，不是加窗的——它对原生草稿和加窗草稿**同等**作用，正如它把两个原生草稿深度分开一样。正确的经验测试因此是 **windowed-vs-native**，且它通过了：在每个 (model × input) 格、$d \in \{3,5,7\}$ 上，加窗草稿与原生草稿都落在同一个 verify-noise 包络里——它们贪婪输出不同时，是批处理 verify 归约序噪声同样把 native 与 dense 分开（以及一个原生深度与另一个分开），而非加窗效应。加窗不引入超出该验证器噪声的任何发散。

### 内存：草稿 KV 环形缓冲

草稿的 KV 池可被 capped 成一个 $W + n_{\text{sink}}$ 的环形缓冲，释放原本会是全长草稿 cache 的剩余部分。跨三个模型，这个草稿池是架构上固定的**总 KV 的 7.7–11.1%**（Qwen-122B 7.7%、Qwen-35B 9.1%、Nemotron 11.1%），匹配架构的 $1/(F+1)$ 份额（$F$=full-attention 层数：12/10/8）。两个池都按 `max_total_num_tokens` 预留（SGLang 启动时从 mem-fraction 饱和 HBM 预留的总 batch×context 预算），故该比例是模型架构与饱和 KV 预算的属性，与具体请求无关；它对 GPU 大小和 KV 精度不变，只是绝对 GB 线性随预算缩放。加窗每草稿步只读 $\min(\text{seq}, W+n_{\text{sink}})$ 个 base token（由 draft-KV index builder 结构性保证），所以在 1M（$W+n_{\text{sink}}=4096$，≤池的 0.35%）**>99% 的草稿池是死的、可回收的**。Capping 成环形缓冲因此以零质量或速度代价回收 batch/context headroom。这个环形缓冲是**已实现而非推断**的（本文每个结果都跑它，草稿 KV 池物理分配到 $n_{\text{sink}}+W+d$ 槽/请求），其兑现的回报是 Fig. 4 的 batch headroom——紧凑草稿池正是让加窗能多塞一个并发 1M 请求的原因，而原生 MTP 的全长草稿池挤占 target KV 并更早触 OOM。

---

## 4. 关键公式解读

论文用一套**每解码步延迟模型**把"何时该加窗、加窗省多少"变成可量化、可拟合的量。下面逐行拆解三个最核心的表达。

### ① 每解码步延迟分解（Eq.1）

一次投机解码步跑 $\gamma$ 次草稿前向、提 $\gamma$ 个候选 token，target 再一次 forward 验证整条链并追加一个 bonus token，故一步最多出 $\gamma+1$ 个 token。记 $d \equiv \gamma+1$（即 SGLang 的 `num_draft_tokens`），论文扫 $d \in \{3,5,7\}$（$\gamma \in \{2,4,6\}$）：

$$
\underbrace{t_{\text{step}}}_{\text{每步}} = \underbrace{t_{\text{verify}}}_{\text{target 验证+投机开销}} + \underbrace{t_{\text{draft}}}_{\text{草稿相}}, \quad
t_{\text{draft}} = \underbrace{t^{\text{ctx}}_{\text{draft}}}_{\text{每步一次 }O(S)\text{ KV-index/ctx 构建}} + \gamma \underbrace{t^{\text{fwd}}_{\text{draft}}}_{\text{每 token 一次前向}}, \quad
\text{TPOT} = \frac{t_{\text{step}}}{\text{AL}}, \quad \gamma = d-1
$$

两个要点：其一，$t_{\text{verify}}$ 在 native 与 windowed 间完全相同（加窗不动验证路径），所以**全部节省都落在 $t_{\text{draft}}$**；其二，草稿的 $O(S)$ 上下文成本同时进入两个子项——一次性的 index/extend 构建 $t^{\text{ctx}}_{\text{draft}}$，以及每次前向里 softmax next-n head 重读 cache 的 $t^{\text{fwd}}_{\text{draft}}$，故 $t^{\text{fwd}}_{\text{draft}}$ 也随 $S$ 缩放。加窗把草稿的 KV 工作集从 $O(S)$ 压到 $O(W)$，同时缩小 $t^{\text{ctx}}_{\text{draft}}$ 和 $\gamma$ 个前向里的 $O(S)$ 部分。注意 $t_{\text{verify}}, t^{\text{ctx}}_{\text{draft}}, t^{\text{fwd}}_{\text{draft}}$ 在固定上下文下都与接受率无关（前向计算是 content-free 的）。

### ② 加窗节省与原生/加窗比（Eq.2 / Eq.3）

把加窗的节省 $\Delta$ 显式拆成两个子项——一次性的 $t^{\text{ctx}}_{\text{draft}}$ 与随 $\gamma$ 缩放的 $t^{\text{fwd}}_{\text{draft}}$：

$$
t^{\text{win}}_{\text{step}} = t^{\text{native}}_{\text{step}} - \Delta, \quad
\Delta = \Delta t_{\text{draft}} = \underbrace{\Delta t^{\text{ctx}}_{\text{draft}}}_{\text{每步一次的 }O(S)\text{ index 构建}} + \gamma \underbrace{\Delta t^{\text{fwd}}_{\text{draft}}}_{\text{硬件级、随 }\gamma\text{ 的前向读取}}
$$

而匹配 $d$ 下的纯 window-vs-native 比为：

$$
\frac{\text{win}}{\text{native}} = \underbrace{\frac{t^{\text{native}}_{\text{step}}}{t^{\text{win}}_{\text{step}}}}_{\text{输入无关的成本因子}(>1\text{，恒有利})} \cdot \underbrace{\frac{\text{AL}_{\text{win}}}{\text{AL}_{\text{native}}}}_{\text{负载相关的接受率因子}}
$$

第一个因子输入无关（前向计算 content-free），第二个因子是接受率变化。论文的延迟拟合把 $\Delta t^{\text{ctx}}_{\text{draft}}$ 归到一个实现相关的 index 构建项（Qwen-35B 上约 3.5 ms，远高于 B200 上等价 1M 读的约 0.3 ms 带宽地板，加窗把它压到 >99%），不把技术效果押在它上面；真正持久的杠杆是 $\gamma$ 个前向的草稿注意力——加窗把它从 $O(S)$ 降到 $O(W)$，一个随 $\gamma$ 与上下文缩放、任何 runtime 都吃得下的硬件级削减（这里延迟拟合的 per-forward 斜率在三个模型上降 22–40%，Qwen-35B 1.19→0.71 ms/forward）。

### ③ 逐位置条件接受率（Eq.4）

论文从 SGLang 的 per-request 接受直方图 $H[n]$（恰好接受 $n$ 个草稿 token 的验证步数）推出草稿位置 $j$ 的条件接受率，以及 AL 与它的关系：

$$
\alpha_j = \Pr[\text{accept } j \mid \text{reached } j] = \frac{\sum_{n \ge j} H[n]}{\sum_{n \ge j-1} H[n]}, \quad
\text{AL} = 1 + \sum_{j \ge 1} \prod_{k \le j} \alpha_k
$$

这套分解是 §5 "为什么加窗保住接受率"的量化基础：把"加窗丢了多少接受率"从模糊的整体 AL 差，下放到**逐位置**的 $\alpha_j$——能直接看出损失（若有）集中在深层、浅层 $\alpha_1$（局部预测）几乎不动。

---

## 5. 实验设置

**硬件与框架**：除特别说明外，单张 NVIDIA B200 GPU（TP1）、bf16 KV、SGLang 内置 MTP/NEXTN 投机解码引擎 + CUDA graphs；批并发研究（Fig. 5）用两张 B200（TP2）。NVFP4 权重；checkpoint 见附录 A（RedHatAI/Qwen3.6-35B-A3B-NVFP4、nvidia/Qwen3.5-122B-A10B-NVFP4，YaRN `rope_scaling=4` 到 1M；nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4，原生 NoPE）。Windowed-MTP 用 $W=4032,\ n_{\text{sink}}=64$。

**三个模型族**：Qwen3.6-35B-A3B（GDN-MoE，MoE-FFN MTP）、Qwen3.5-122B-A10B（GDN-MoE，MoE-FFN MTP）、Nemotron-3-Super-120B-A12B（Mamba2-hybrid，8 层 GQA full-attn，MoE-FFN MTP，NoPE）。三者都跑 MoE-FFN MTP 头、2 个 GQA KV head；Nemotron 的注意力更窄（head_dim=128 vs 256，每 token KV 读减半）且 MTP 更重（top-22/512 vs top-8/256），故可加窗的 $O(S)$ 注意力扫描占其每步成本比例更小——这正好解释了它 +28% 对比 Qwen 草稿 +30–44% 的差距。

**基准**：固定 1.04M-token 输入，覆盖 RULER（single/multi-value/multi-query needle 检索、variable tracking、common-/frequent-word 聚合，作为 easy→hard 难度轴）、LongBench-v2（真实长上下文代码推理 QA）、BABILong（多事实推理 QA）三套。所有输入由 seeded 仓内生成器产生、字节级可复现，不做 tile/重复凑长度；1M 位置有效性在模型层处理（Qwen 用 YaRN、Nemotron 用原生 NoPE），对 dense 基线与所有投机变体同等施加。

**评测指标**：接受长度 AL、per-token 延迟（TPOT）、对 native MTP 草稿与 dense（不投机）基线的加速比，并筛查所有生成是否退化重复。"1M 上下文"是固定 1,040,000-token prompt；每个任务跑 QA 模式（生成到 EOS 截止，计时模型实际答案、上限 512 新 token）。这是真实"长 prompt / 短补全"serving 场景，恰是草稿上下文成本、因而加窗收益暴露之处；短生成（≤512）让该长度在解码中保持固定。机制只依赖草稿注意的 KV 长度 $S$，与它如何产生无关——对称的"短 prompt / 长生成"靠累积解码达到同一 $S$，加窗在那里同样 cap 每步成本。

**可复现性**：自包含 B200 复现包（SGLang 投机解码 patch = Windowed-MTP + 草稿-KV 环形缓冲、run/config 脚本、seeded RULER 输入生成器、端到端安装说明）已发布。原生跑 FlashInfer 草稿后端；Windowed-MTP 跑 Triton 草稿后端（ring-buffer index remap 所需）。

---

## 6. 实验结果

### 主结果：每解码步成本（Table 1）

$d=7$（$\gamma=6$）、1M、B=1 下的每步解码成本。因 $t_{\text{verify}}$ 跨 native/windowed 相同，整个节省 $\Delta = \text{step}_{\text{nat}} - \text{step}_{\text{win}} = \Delta t_{\text{draft}}$ 就是草稿相的坍缩，为 7.3–8.1 ms——natively 这个草稿相（含固定投机开销）在 bare 全注意力 verify 之上加 **+92% 到 +138%**，近乎把解码步翻倍，Windowed-MTP 把它砍到 **+45% 到 +72%**。匹配接受率比 $\text{step}_{\text{nat}}/\text{step}_{\text{win}}$ 为 +28%（Nemotron）到 +44%（Qwen-35B），MoE-FFN Qwen 草稿最大。

| 模型 | step_nat (ms) | step_win (ms) | Δ (ms) | win/nat |
| --- | --- | --- | --- | --- |
| Qwen3.6-35B (GDN-MoE) | 26.4 | 18.3 | 8.1 | +44.3% |
| Qwen3.5-122B (GDN-MoE) | 34.5 | 26.5 | 8.0 | +30.2% |
| Nemotron-3-120B (Mamba2) | 33.1 | 25.8 | 7.3 | +28.3% |

> Table 1：$d=7$、1M、B=1（bf16 KV、单 B200）on `niah_multiquery_enum`；匹配上下文下输入无关（content spread ≤7%）；win/nat 为匹配接受率比。

### 端到端加速（Table 2）

同一 1M 多针检索输入、$d=7$：Windowed-MTP 比 native MTP 快 **+11% 到 +53%**，比 dense（不投机）快 **1.58–2.55×**。win-vs-native 因子是输入无关的成本侧（Table 1，+28–44%）被 per-input 接受率比 $\text{AL}_{\text{win}}/\text{AL}_{\text{native}}$ 调制：这里接受率保在 ≈±10%，故端到端跟成本侧——Qwen-35B 超过它（加窗还把 AL 抬了一点 4.49→4.74），Qwen-122B 落到它之下（其原生草稿恰好在 $d=7$ 接受更多 5.57→4.74，缩小端到端差距）。但即便那个不利格，TPOT 仍降（6.09→5.46 ms）：每步成本节省盖过接受率损失，结果是净加速而非回归。

| 模型 | win vs native | win vs dense | AL (nat→win) | TPOT ms (nat→win) |
| --- | --- | --- | --- | --- |
| Qwen3.6-35B | +53% | 2.55× | 4.49→4.74 | 5.94→3.89 |
| Qwen3.5-122B | +11% | 1.75× | 5.57→4.74 | 6.09→5.46 |
| Nemotron-3-120B | +23% | 1.58× | 3.75→3.61 | 8.77→7.15 |

> Table 2：1M、$d=7$、B=1、单 B200，RULER `niah_multiquery_enum`。win vs native 含接受率；win vs dense 对不投机。

### 加窗优势随上下文增长（Fig. 3）

加窗的"楔子"随上下文变长而加宽：加窗删掉草稿的 $O(S)$ 上下文成本、却留着 target 的全注意力 verify（它本身 $O(S)$）不动。$S$ 增大时原生草稿的扫描撑大每步成本，加窗草稿的则近乎固定（4K 是 261K 的 1.6%、却是 1M 的 0.4%）。扫 261K→1M（$d=7$、匹配接受率），三个模型的成本侧比 $\text{step}_{\text{nat}}/\text{step}_{\text{win}}$ 都升（Qwen-35B +27%→+43%、Qwen-122B +24%→+30%、Nemotron +17%→+26%），每步节省 $\Delta$ 各自约翻倍（3.4→7.9、3.5→7.8、3.2→6.8 ms）。

![图3 加窗优势随上下文增长：成本侧比值 stepnat/stepwin−1（Titer=AL·TPOT，接受率相消）随上下文长度 S 上升，d=7、B=1、bf16、niah_multiquery_enum；三个模型的增益都向 1M 增长，1M 端点在 run-to-run 噪声内复现 Table 1](/vibe-reading/images/articles/windowed-mtp-draft-kv-tax/fig-03-context-scaling.png)

### 加窗救回难任务格

跨 RULER 输入（Qwen-35B、1M、$d=7$）按原生草稿接受率排序，端到端加窗优势随任务难度单调增大：易的 `niah_multivalue`（AL_nat 5.9）+4%、中 `vt`（4.2）+17%、难 `cwe`（2.8）+38%——后者一个更深原生 $d=9$ 草稿也救不回原生臂（它跌破 dense 基线）。加窗让深层草稿投机**明确净正**。

### best-depth 基线

实务者按 (model, task) 调草稿深度、留最快那个，所以公平比是 native 在自己最优深度 vs windowed 在自己最优深度（$d \in \{3,5,7,9\}$ 各取 min-TPOT）。每个方法自己最优深度下，Windowed-MTP 在**每个 (model, task) 格都比 native 严格更快**（1.22–1.58×）；地板是 Qwen-122B 的 Code-QA（1.22×），所以即便最差格也无吞吐回归，含代码推理。两个效应：(i) native 的 TPOT 对 $d$ 非单调——全上下文草稿税封住可用深度（且 $d=9$ 在 1M 对 Qwen-122B/Nemotron 不可行——全长草稿池 OOM），加窗移掉该税让加窗草稿更深处还变好；(ii) 加窗草稿便宜，其最优可坐在更浅深度（Qwen-122B 在 cwe/Code-QA 取 $d=3$、Nemotron NIAH-mq 取 $d=3$）仍胜 native——所以即便浅窗最优接受略少，更便宜的每步草稿也绰绰有余。

| 模型 | 任务 | native (d) | windowed (d) | win/nat |
| --- | --- | --- | --- | --- |
| q35 | CWE | 8.28 (5) | 5.42 (5) | 1.53× |
| q35 | Code-QA | 7.95 (5) | 5.03 (5) | 1.58× |
| q35 | BABILong | 8.41 (5) | 6.26 (7) | 1.34× |
| q122 | CWE | 9.01 (5) | 6.08 (3) | 1.48× |
| q122 | Code-QA | 9.50 (5) | 7.77 (3) | 1.22× |
| q122 | BABILong | 8.93 (7) | 6.92 (7) | 1.29× |
| nem | NIAH-mq | 8.71 (7) | 5.98 (3) | 1.46× |
| nem | FWE | 11.24 (5) | 8.78 (5) | 1.28× |

> Table 3：best-depth 基线（1M、B=1、单 B200），native（全上下文、FlashInfer）vs windowed（环形缓冲、Triton），各取 $d \in \{3,5,7,9\}$ 的 min-TPOT。无格最优 $d=9$。单 run/格。

### 吞吐-延迟 Pareto（Fig. 4）

1M 下扫 batch $B$（$d \in \{3,5,7\}$、单 B200、TP1）、两负载（`niah_multiquery_enum`、`fwe`）。Windowed-MTP 在**每个 batch** Pareto 支配 dense 与 native MTP 两轴：B=1 给 dense 2.2× 的每用户解码速度（218 vs 100 tok/s/user），峰值系统吞吐（B=5 的 473 tok/s/GPU）是 dense 2.1×、native MTP 1.5×。6 个面板中 5 个维持前沿；例外是 Nemotron+FWE——本集最低接受率负载——前沿分裂：加窗仍赢延迟端，但 dense 赢高 batch 峰值吞吐，那是低接受率让投机在 batch 算力受限时变不赚的预期边界。环形缓冲还塞下更多常驻 1M 请求（native MTP 在 35B 上早一个 batch 触 OOM）。

![图4 1M 吞吐-延迟 Pareto 前沿：B 扫 d∈{3,5,7}（单 B200、TP1），行为 Qwen3.6-35B / Qwen3.5-122B / Nemotron-3-120B，列为 niah_multiquery_enum / fwe（右上更优）；Windowed-MTP+ring（蓝）在 6 面板之 5 维持前沿（native MTP 红、Dense 灰），例外 Nemotron+FWE 见正文](/vibe-reading/images/articles/windowed-mtp-draft-kv-tax/fig-04-throughput-latency-pareto.png)

### 跨硬件与 TP2

收益非 Blackwell 带宽专属——在一张 H100-80GB 上用公开 FP8 checkpoint（RedHatAI/Qwen3.6-35B-A3B-FP8）复现单 GPU 结果（1M、B=1、$d=7$、bf16 KV、同多查检索输入）：Windowed-MTP 再次 Pareto 改进于 dense（2.43×）与 native MTP（1.48×），还抬接受率（4.34→4.53）——成本侧加窗机制直接移植到非 Blackwell 硬件。TP2 主要为容量（两张 B200 并发更多 1M 请求，也降低 batch 单请求延迟）；扫 batch 到最大可塞每请求全长 1M KV 的并发（Qwen-35B B=13、其余 B=7），Windowed-MTP 在每个 batch、三个模型都 Pareto 支配 dense 与 native，紧凑草稿池塞下额外并发把吞吐天花板拉到 native 约 1.15–1.25×、dense 约 1.7–2.3×。

---

## 7. 消融实验：为什么加窗保住接受率

Eq.3 的加速有两个因子：成本因子 $\text{step}_{\text{native}}/\text{step}_{\text{win}} > 1$（恒有利）与接受率因子 $\text{AL}_{\text{win}}/\text{AL}_{\text{native}}$。朴素预期是加窗只能丢接受率（草稿看更少）。但实测不然：接受率保住，某些输入深处还升。

### 剂量-响应（window sweep）

固定 $d=7$、扫草稿窗口 $W+\text{sink}$ 在 1M 多查检索（Qwen3.6-35B、同一 build），接受率在约 4K 操作窗**峰值**——高于全上下文草稿——per-token 延迟最小处也在那，往全上下文放大反而更贵：

| window | 1K | 2K | 4K | 8K | native (1M) |
| --- | --- | --- | --- | --- | --- |
| AL | 3.79 | 4.74 | 4.74 | 4.16 | 4.49 |
| TPOT (ms) | 4.89 | 3.85 | 3.85 | 4.50 | 6.04 |

约 4K 的 hero 窗坐在联合最优：它把接受率抬过全上下文草稿（4.49→4.74）同时把 per-token 延迟降 1.57×（6.04→3.85 ms）。往两边都更差——缩到 1K 太紧丢接受率，放大回全上下文白付草稿 $O(S)$ 上下文税还没精度收益（native 更慢且这里略不准；8K 非单调在加窗草稿的 run-to-run 接受率方差内、非趋势）。$n_{\text{sink}}=64$ 固定。$W$ 因此按草稿池内存/成本预算选、而非调接受率；全文统一 $W=4032$。

### 逐位置条件接受率（Fig. 2）

Fig.2 画了 $\alpha_j$（$d=7$、$\gamma=6$、1M）native vs windowed 跨三模型在检索 hero 输入上的对比。加窗曲线**逐位置**跟踪 native，在几乎每个 $j$ 上都落在 95% Wilson 区间内：$\alpha_1$（局部预测）不变，深层、复合位置一起衰减而非窗口早崩。净接受率相应接近——Qwen-35B 略升（AL 4.50→4.76，加窗 $\alpha_j$ 六位中四位 ≥ native），Nemotron 持平（3.73→3.54，全程在 CI），Qwen-122B（最强草稿，全上下文读确对多针检索有助）让一点（5.58→4.73）。这是远上下文**有信息而非稀释**的负载；即便如此窗口仍保接受率形状而非截断，小接受率代价被每步加速成倍偿付。

![图2 逐位置条件接受率 αj（d=7, γ=6, 1M）在检索 hero 输入（niah_multiquery_enum）上原生（full-1M）vs 加窗（4032+64），三模型（列）；加窗曲线逐位置跟踪 native、基本落在 95% Wilson 区间；α1 不变、深层一起衰减故加窗保形状而非早崩](/vibe-reading/images/articles/windowed-mtp-draft-kv-tax/fig-02-acceptance-profile.png)

### 接受效应是深度特异的

不论符号，加窗与 native 的接受率差**只在深层草稿位置**：$\alpha_1$（浅、局部预测）被加窗不变，两条曲线若有分离只在深层复合位置。浅草稿（$d=3$、$\gamma=2$）只走早位置故对加窗基本不变；差距小、符号随 input/model 变，只在 $d$ 增大、草稿够到深处才显现——那里 native 草稿的远读要么稀释（稀释上下文）要么真有助（信息检索）。成本因子在每个深度都有利；接受率因子是深度、输入相关的二阶项。

### 直接决策不变性探针

论文还直接在 native 草稿上做 in-run A/B：每个长上下文解码步跑完草稿头后立刻在**同一 hidden state、位置、RNG** 上把草稿 KV 切到 sink+window 重跑，比两个 top-1 提议——唯一差就是加窗读。275–512 步上（Table 11）加窗让草稿 top-1 token **86–94% 不变**。分歧是诊断性的：Qwen-35B/Nemotron 的翻转在低置信近乎平局处（flip-margin ≈0.5 远小于全程均值 3–5）；Nemotron 草稿在加窗下重选约半数 MoE 专家（router Jaccard ≈0.5——大内部扰动）但 top-1 仍 86% 不变。Qwen-122B 是例外，翻转落在自信位置（flip-margin 6.8 ≈均值 7.2）——最强草稿真用远上下文消歧多针。这是单一接受率 trade（Qwen-122B NIAH-mq，AL 5.57→4.74）背后的机制；但每个接受 token 仍被 target 验证，所以 trade 代价是延迟、非正确性。

### 后端不是混淆项

native MTP 跑 FlashInfer、紧凑环加窗要 Triton（index remap），所以增益可能是 FlashInfer→Triton 假象而非加窗。并非——若说 Triton 是 handicap：匹配点上移 native 到 Triton 让全读草稿 extend 明显更慢，但 Windowed-MTP on Triton 仍胜 native on FlashInfer（Table 5），所以增益是**缩减 KV 读**、不是后端。唯一 caveat 是 Triton 的 ragged draft-extend 成本随接受长增长（FlashInfer padded BatchPrefill 不会），故高接受率时可能吃掉部分加窗增益。FlashInfer 一般比 Triton 快，所以一个 native FlashInfer 环形缓冲 kernel 很可能进一步扩宽增益；该实现比 Triton index remap 更费，留作未来工作，故把 Triton 数当保守下界。

### 为何决策保得住

两草稿族都坐落 recurrent-hybrid 基座（Qwen: Gated-DeltaNet、Nemotron: Mamba2，各带几层全上下文 GQA），所以预测所需的长程依赖由 recurrent 路径承载，草稿的 softmax 注意力**重读远上下文很大程度上冗余**（与并发 attention-drift 发现一致 [Eldenk et al. 2026]）。两族差只在注意力 reach 的位置编码：Qwen 头用 length-extended RoPE，softmax mass 局部集中（≈75–80% in-window）故加窗几乎不动 read-out（≈15%）；Nemotron 头用 NoPE，注意力全局散开（仅 ≈16% in-window）故加窗扰动 read-out >100%——但 Mamba2 state 已编码那段远上下文，故重读是 confirmatory（残差 share $\|W_{oo}\|/\|h_t\| \approx 0.5$）。无论如何加窗移的是冗余、不是信号，而直接验证的是决策、不是幅度。

---

## 8. 总结与展望

### 贡献总结

1. **识别并量化长上下文草稿注意力税**：在 1M（$\gamma=6$）草稿相单在 bare verify 上加 +92% 到 +138%，近乎翻倍解码步；给出一套每步延迟模型预测深层原生草稿加速何时坍到 parity、甚至跌破 dense 的反转。
2. **训练-free、即插即用、构造上无损的窗口化**：只给草稿注意力套 sink+window，无损因为全注意力 target 仍验每个接受 token，由全格 windowed-vs-native 贪婪输出 diff 在验证器噪声包络内确认。
3. **跨三架构族的 +28%–44% 每步成本降、随上下文增长**：一个输入无关、随上下文变宽的增益；幅度跟草稿成本里可加窗的份额。
4. **接受率机制解释**：窗口剂量-响应、逐位置条件接受率分解、in-run 决策不变性探针共同表明加窗保住接受率——草稿 top-1 提议 86–94% 不变，跨扫维持在全注意力置信区间内；残余差小、二阶、输入与深度相关、符号可正可负，总被每步加速盖过，故端到端不回归。
5. **草稿 KV 池回收**：测得 7.7–11% 的总 KV 份额，加窗让除 $W+\text{sink}$ 外全死、以紧凑环形缓冲零代价回收 HBM 换并发。

### 局限性（批判性）

- **增益与草稿成本可加窗份额成正比**：$O(S)$ 注意力扫描占每步成本更小的草稿（Nemotron 更窄注意力 + 更重 MoE-FFN MTP）拿更小但仍可观的增益（+28% vs Qwen MoE 的 +30–44%）。
- **头条是 B=1/TP1/单 GPU**，但单 GPU batch 扫到 B=6、TP2 扫到 B=13 都显示加窗持前沿并涨系统吞吐；只是精确百分比配置依赖——TP degree 与 KV/compute 平衡会移——故不主张逐字迁移到所有 regime。幅度也 framework-relative（在 SGLang 内测，百分比是框架特定草稿上下文成本对框架特定每步时间的比），更（不）优化的 stack 会显示更小（大）增益——$O(S)$ 机制与方向通用，精确百分比不是。
- **无损只在精确算术下 exact**：bf16 批处理验证对 dense 非 bit-exact，但它对 native/windowed 同等扰动；采样下保证是分布级、非 bit-identical 样本。
- **接受率改进机制** 在 $d=7$ 的自然文本/QA 上最强；$W \times d \times \text{model}$ 扫 + 直接 $Z_{\text{far}}/Z$ 注意力质量测量佐证——加窗丢的是在测输入上**弥漫的**、即局部预测不需要的预算。

### 未来方向（创造性，idea 三法）

**① 弥补缺陷**：一个原生 FlashInfer 环形缓冲 kernel 会进一步扩宽增益（当前 Triton 的 ragged draft-extend 在高接受率时吃掉部分加窗增益）；把加窗 + 环形缓冲的 prefill sparsification（prompt 草稿 KV 只需 sink + 末窗，故中间 chunk 草稿 pass 可剪到 $O(W+n_{\text{sink}})$，进一步降 TTFT）落到 kernel 级；给在 far mass **峰在少数远信息 key** 的任务设计一个带注意 sink 的轻量"远 token 检索"补丁以挽救那类负载的接受率。

**② 新型方案**：加窗让每步便宜后，最优深度基本只由接受率决定、随 (model, task) 变，给一个**在线 adaptive-$d$ 控制器**很自然也便宜——在边际接受长超过（小的、加窗的）边际草稿成本时升 $d$、在输入没接受 headroom 时退；把 Windowed-MTP 嫁接到训练的 EAGLE-3 草稿（它本身是 attend 全 KV 的 transformer 层，同样付 $O(S)$ 税）与 block-diffusion 草稿（DFlash 的注入上下文 $O(d \cdot S)$ 税更大）。

**③ 减少约束**：把"加窗只动草稿、不动验证"的不损性论证推广到加窗 + 量化 KV（fp8 下相对增益对 Qwen 草稿缩小但保留，Nemotron 近平不变）+ tree/multi-candidate 投机（chain 预留 $n_{\text{sink}}+W+d$、树宽 $k$ 预留 $n_{\text{sink}}+W+d \cdot k$）；一个把"真稀释 vs 位置延展退化"分开的受控 far-context 内容交换实验，把当前把 causal 当解读的设计再收紧一层。
