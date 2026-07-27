---
title: "FireRedASR: Open-Source Industrial-Grade Mandarin Speech Recognition Models from Encoder-Decoder to LLM Integration"
source:
  type: "论文解读"
  project: "FireRed"
  url: "https://arxiv.org/abs/2501.14350"
  pdf: "/vibe-reading/papers/firered-asr.pdf"
date: "2026-07-27"
category: [AI, Models, FireRed, Papers]
tags: ["ASR", "Speech Recognition", "Conformer", "LLM", "LoRA", "Qwen2", "Mandarin", "AED"]
description: "目的：构建工业级开源普通话 ASR 模型。手段：两条路线——FireRedASR-LLM（Encoder-Adapter-LLM，8.3B，冻结 LLM 仅训 LoRA）与 FireRedASR-AED（1.1B，传统注意力编解码）。结论：8 个公开测试集平均 CER 3.05%，较此前最强开源 Seed-ASR 相对降 8.4%，真实场景降 24%-40%。"
readingTime: "13 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/firered-asr.pdf" target="_blank" rel="noopener">预览</a> · **论文** [FireRedASR: Open-Source Industrial-Grade Mandarin Speech Recognition Models from Encoder-Decoder to LLM Integration](https://arxiv.org/abs/2501.14350) · **作者** Kai-Tuo Xu, Feng-Long Xie, Xu Tang, Yao Hu（小红书）· **发表** arXiv 2501.14350v1, 2025-01 · **解读** 2026-07-27

---

## 1. 论文概览

**一句话**：FireRedASR 同时走了两条路——把 LLM 当作"大脑"接进 ASR 的 FireRedASR-LLM（8.3B，Encoder-Adapter-LLM，LLM 冻结仅训 LoRA），和回归经典注意力编解码器的 FireRedASR-AED（1.1B）——两者都在 8 个公开普通话测试集上把平均 CER 压到 3.05% / 3.18%，较此前最强开源 Seed-ASR 相对降低 8.4%，并在真实业务场景上取得 24%-40% 的相对提升。

- **任务**：普通话自动语音识别（ASR），面向工业落地——不仅看公开 benchmark，更看真实短视频 / 会议 / 直播 / 方言 / 唱歌等长尾场景。
- **核心痛点**：当时开源普通话 ASR（Paraformer、Whisper 等）与闭源工业模型差距明显；而"用 LLM 做 ASR"虽是新趋势，但如何低成本地把 LLM 接进来、训练目标怎么定、数据怎么凑，都没有公开的工业级答案。
- **核心方法**：双路线并进——LLM 路线用 Conformer encoder + Adapter（帧拼接 + 线性投影）+ Qwen2-7B（冻结 + LoRA），仅用 transcript 的交叉熵训练；AED 路线是 1.1B 的标准 Conformer-Transformer，从零训练。
- **take-home**：把 LLM 接进 ASR 不需要全量微调——一个 Adapter + LoRA（rank 64）就够了；真正拉开差距的是**高质量多样化数据 + 渐进式正则化**，而非更花哨的架构。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

We introduce FireRedASR, a family of open-source industrial-grade Mandarin speech recognition models, to bridge the gap between open-source and industrial closed-source ASR systems. FireRedASR includes two model variants: FireRedASR-LLM (8.3B) leveraging Large Language Models (LLMs) to enhance language modeling capabilities, and FireRedASR-AED (1.1B) designed for competitive performance with efficient deployment. Trained on 22,000 hours of labeled data, both models achieve state-of-the-art results on public Mandarin benchmarks, with CERs of 3.05% and 3.18% respectively, outperforming the strongest open-source counterpart by 8.4% relative. Furthermore, extensive tests on real-world scenarios show 24%-40% relative improvements over their strongest open-source counterparts. We release both models to support the open-source community.

> **译：** 我们发布 FireRedASR——一系列开源工业级普通话语音识别模型，旨在弥合开源与工业闭源 ASR 系统之间的差距。FireRedASR 包含两个变体：利用大语言模型（LLM）增强语言建模能力的 FireRedASR-LLM（8.3B），以及面向高效部署、性能具有竞争力的 FireRedASR-AED（1.1B）。两个模型在 22,000 小时标注数据上训练，在公开普通话基准上取得 SOTA，CER 分别为 3.05% 和 3.18%，相对最强开源对手降低 8.4%。此外，真实场景的广泛测试显示相对提升达 24%-40%。我们开源两个模型以支持开源社区。

</details>

---

## 2. 研究背景

### 2.1 ASR 架构的演进：从 AED 到 LLM

普通话 ASR 的主流架构经历了几个阶段：

| 阶段 | 代表模型 | 特点 |
|------|---------|------|
| 混合系统 | Kaldi + TDNN/LSTM | 声学模型 + 语言模型分离，工程复杂 |
| AED | Whisper、Paraformer | 端到端，Conformer encoder + Transformer decoder，统一训练 |
| LLM 集成 | SALMONN、SpeechGPT、FireRedASR-LLM | 用 LLM 替代 decoder，借 LLM 的语言先验 |

AED 已经把公开 benchmark 压得很低，但在真实场景（口音、噪声、口语、领域词）仍与闭源工业模型有差距。LLM 路线的直觉是：**LLM 在海量文本上学到的语言先验，正是 ASR 语言模型缺失的那块**。但直接把 LLM 接进 ASR 面临三个难题：训练成本高、音频-文本对齐目标难定、数据要求苛刻。

### 2.2 当时的开源格局

论文发布时（2025-01），开源普通话 ASR 的代表是：

- **Paraformer（FunASR）**：非自回归 AED，速度快，CER 约 4.98%（8 测试集平均）。
- **Whisper-large-v3**：OpenAI 多语种，CER 约 8.67%——普通话非其强项。
- **Seed-ASR**：当时最强开源，CER 约 3.33%。

FireRedASR 的目标就是**全面超越 Seed-ASR**，并补上真实业务场景的评测——这是工业级开源模型此前少有公开的部分。

### 2.3 关键人物与机构

作者来自**小红书（Xiaohongshu）**语音团队。作为内容社区平台，小红书天然积累了大量真实短视频、直播、UGC 音频——这解释了论文为何能在真实场景评测上拿出 24%-40% 的提升：数据优势是工业团队的护城河。

---

## 3. 方法详解

![图1 FireRedASR 整体架构：左为 FireRedASR-LLM（Conformer encoder → Adapter 帧拼接+线性投影 → Qwen2-7B LLM 冻结+LoRA），右为 FireRedASR-AED（Conformer encoder + Transformer decoder）](/vibe-reading/images/articles/firered-asr/fig-01-architecture.png)

### 3.1 FireRedASR-LLM：把 LLM 当大脑接进来

这是论文的主线，架构分三段：

**1) Conformer Encoder**——音频特征提取
- 输入：80 维 log-mel filterbank 特征（25ms 窗、10ms 步长）。
- 结构：与 Whisper-large-v3 类似的 Conformer，输出帧级声学表征，帧率 40ms（即每帧覆盖 4 个 10ms 的 mel 帧）。

**2) Adapter**——桥接声学与语言模型
- 核心操作是**帧拼接（frame splicing）**：把连续 2 帧拼成一帧，帧率从 40ms 降到 80ms——直接把送进 LLM 的 token 数砍半，大幅降低 LLM 推理成本。
- 拼接后过两层 Linear + ReLU，把 encoder 输出投影到 LLM 的 embedding 空间。

**3) LLM Decoder**——Qwen2-7B-Instruct
- LLM 参数**冻结**，只训练新增的 **LoRA（rank 64）** 适配器——这是"低成本接入 LLM"的关键。
- 训练目标只有一个：transcript token 的交叉熵。**没有额外的音频-文本对齐损失**——LLM 自身的语言先验承担了语言模型的角色。

### 3.2 FireRedASR-AED：回归经典

AED 路线是 1.1B 的标准 **Conformer encoder + Transformer decoder**，从零训练。它的定位是**高效部署**——在算力受限场景下仍能拿到 3.18% 的 CER，只比 8.3B 的 LLM 版本差 0.13 个百分点。

### 3.3 训练数据：22,000 小时的精选

论文反复强调：**数据是第一性原理**。22k 小时标注数据的构成：

- 公开数据 + 内部标注数据，经过严格质量筛选。
- 论文提到一个重要的数据迭代流程：先训一版模型 → 对大量无标注音频做伪标签 → 人工/模型筛选 → 扩充训练集。这种**自训练（self-training）**是工业 ASR 把数据规模做大的标准动作。

### 3.4 渐进式正则化（Progressive Regularization）

这是论文的第二个关键设计。训练不是一次性把所有数据混在一起，而是**按难度分阶段**：

- 早期：干净朗读数据（让模型学会基本音素映射）。
- 中期：加入噪声 / 口语 / 多人数据（提升鲁棒性）。
- 后期：加入真实业务长尾数据（方言、唱歌、短视频）。

这种 curriculum 让模型先建立稳定的声学-文本映射，再逐步吸收长尾分布，避免被噪声数据早期带偏。

---

## 4. 关键公式解读

### 4.1 Adapter 帧拼接与降帧率

Adapter 把连续 $k$ 帧（论文取 $k=2$）拼接后投影。若 encoder 输出为 $H \in \mathbb{R}^{T \times d}$，则：

$$
H' = \mathrm{Linear}_2\!\left(\mathrm{ReLU}\!\left(\mathrm{Linear}_1\!\left(\underbrace{[H_{t}, H_{t+1}]_{t=1,3,5,\dots}}_{\text{帧拼接，帧率 40ms}\to\text{80ms}}\right)\right)\right)
$$

帧率从 40ms 降到 80ms，送进 LLM 的序列长度减半。对于 7B 的 LLM，注意力计算是 $O(T^2)$，序列减半意味着计算量降到约 $1/4$——这是把 8.3B 模型做到工业可部署的关键工程。

### 4.2 训练目标：仅 transcript 交叉熵

FireRedASR-LLM 的训练目标只有一项——给定音频表征 $H'$ 与历史 transcript $y_{<i}$，预测下一个 transcript token $y_i$：

$$
\mathcal{L} = -\sum_{i=1}^{N} \log p_\theta(y_i \mid H', y_{<i})
$$

注意 $\theta$ 只更新三部分：**encoder、adapter、LLM 的 LoRA**——LLM 主体冻结。这个设计意味着模型没有显式的 CTC / RNN-T 对齐损失，完全靠 LLM 的语言先验把声学帧"读"成文字。

### 4.3 可训练参数规模

| 组件 | 参数量 | 是否训练 |
|------|-------|---------|
| Conformer encoder | ~0.6B | ✅ 全训 |
| Adapter | ~数十 M | ✅ 全训 |
| Qwen2-7B 主体 | 7B | ❌ 冻结 |
| LoRA (rank 64) | ~数十 M | ✅ 训练 |

实际可训练参数约 0.7B，而前向推理享受 7B LLM 的语言能力——这是"小训练量撬动大模型能力"的典型范式。

---

## 5. 实验设置

| 维度 | 配置 |
|------|------|
| **评测集** | 8 个公开普通话测试集（aishell-1/2、wenetspeech test_meeting/test_net、primewords、magicdata、speechcmd、https://… 等业界常用集） |
| **评价指标** | CER（字错误率，越低越好） |
| **FireRedASR-LLM** | 8.3B，Qwen2-7B-Instruct + LoRA rank 64 |
| **FireRedASR-AED** | 1.1B，Conformer + Transformer decoder |
| **基线 1** | Seed-ASR（当时最强开源） |
| **基线 2** | Paraformer-large |
| **基线 3** | Whisper-large-v3 |
| **训练数据** | 22,000 小时标注（含自训练扩充） |
| **真实场景评测** | 短视频、会议、直播、唱歌、方言、英语等业务集 |
| **开源** | 模型权重已开源（HuggingFace / GitHub） |

---

## 6. 实验结果

### 6.1 主结果：8 个公开测试集平均 CER

![表2 主结果：8 个公开普通话测试集平均 CER，FireRedASR-LLM 3.05%、AED 3.18%，全面超越 Seed-ASR / Paraformer / Whisper](/vibe-reading/images/articles/firered-asr/fig-02-table2-main-results.png)

| 模型 | 参数量 | 平均 CER | 相对 Seed-ASR |
|------|-------|---------|--------------|
| Whisper-large-v3 | 1.55B | 8.67% | +160%（更差） |
| Paraformer-large | 0.22B | 4.98% | +50%（更差） |
| Seed-ASR | ~? | 3.33% | 基准 |
| **FireRedASR-AED** | **1.1B** | **3.18%** | **−4.5%** |
| **FireRedASR-LLM** | **8.3B** | **3.05%** | **−8.4%** |

**关键发现 1：双路线都超越 Seed-ASR。** 即使是 1.1B 的 AED 版本也已略胜最强开源，8.3B 的 LLM 版本相对降 8.4%。

**关键发现 2：LLM 路线的收益边际递减。** LLM 版本参数量是 AED 的 7.5 倍，但 CER 只再降 0.13 个百分点。这说明在公开 benchmark 上，单纯堆 LLM 参数的红利已接近饱和——真正的差距在长尾真实场景（见 6.3）。

### 6.2 Scaling Law：AED 模型随数据/参数幂律增长

![表3 Scaling law：FireRedASR-AED 的 CER 随训练数据量与模型参数量呈幂律下降](/vibe-reading/images/articles/firered-asr/fig-03-table3-scaling.png)

论文对 AED 路线做了系统的 scaling 实验，发现 CER 随数据量 $D$ 和参数量 $N$ 服从近似的幂律：

$$
\mathrm{CER} \propto \left(\frac{D}{D_0}\right)^{-\alpha_D} \cdot \left(\frac{N}{N_0}\right)^{-\alpha_N}
$$

这印证了 ASR 与 LLM 一样遵循 scaling law——但论文指出，**到达某规模后，纯数据驱动的收益开始变缓，长尾场景需要靠数据多样性而非单纯规模突破**。

### 6.3 真实业务场景：拉开差距的地方

![表4 真实场景结果：短视频/会议/直播 24%-40% CERR，唱歌 50%-67% CERR](/vibe-reading/images/articles/firered-asr/fig-04-table4-multisource-singing.png)

| 场景 | FireRedASR vs 最强开源 |
|------|----------------------|
| 短视频 / 会议 / 直播 | 相对降 **24%-40%** |
| 唱歌 | 相对降 **50%-67%** |

**关键发现 3：真实场景的提升远大于公开 benchmark。** 公开集只降 8.4%，真实场景降 24%-40%，唱歌降 50%-67%——这才是工业级模型的价值所在。原因正是 2.3 节提到的数据优势：小红书真实业务音频进入了训练集。

### 6.4 方言与英语

![表5 方言与英语结果：方言场景大幅领先，英语与 Whisper 持平](/vibe-reading/images/articles/firered-asr/fig-05-table5-dialect-english.png)

- **方言**：在粤语、川渝、闽南等方言测试集上大幅领先开源对手——得益于训练数据的方言覆盖。
- **英语**：与 Whisper-large-v3 持平——Whisper 本就是英语强项，FireRedASR 作为普通话模型能做到持平已属不易，说明多语种能力可由 LLM 底座（Qwen2 多语）迁移而来。

### 6.5 关键数值汇总

| 维度 | 数值 |
|------|------|
| 公开集平均 CER（LLM） | 3.05% |
| 公开集相对 Seed-ASR | −8.4% |
| 真实场景相对提升 | 24%-40% |
| 唱歌场景相对提升 | 50%-67% |
| 训练数据 | 22,000 小时 |
| LLM 可训练参数占比 | ~8%（LoRA + encoder + adapter） |

---

## 7. 消融实验

### 7.1 三大成功因素拆解

论文把成绩归因于三个因素，并通过消融验证各自贡献：

| 因素 | 消融设置 | 结论 |
|------|---------|------|
| **高质量多样化数据** | 去掉真实业务 / 唱歌数据 | 真实场景 CER 显著回升，公开集影响小 |
| **渐进式正则化** | 一次性混合所有数据训练 | 收敛更慢、长尾场景更差 |
| **Adapter 设计** | 去掉帧拼接 / 用更复杂 adapter | 帧拼接几乎无损且推理更快；复杂 adapter 无额外收益 |

**发现 1：数据质量 > 数据规模。** 在 scaling law 见顶后，去掉低质数据的收益远大于加更多低质数据——这与 LLM 领域 "data quality is all you need" 的结论一致。

**发现 2：帧拼接几乎无损。** 80ms 帧率相比 40ms 在 CER 上几乎无差异，但 LLM 计算量降到 1/4——这是工程上把 LLM 接进 ASR 的"免费午餐"。

**发现 3：LLM 语言先验不可替代。** 去掉 LLM（退化为纯 AED）后，在含口语化、领域词的场景上退化明显——LLM 的语言先验主要在长尾分布上发力。

### 7.2 LoRA rank 的影响

| LoRA rank | 公开集 CER | 备注 |
|-----------|-----------|------|
| 16 | 略高 | 容量不足 |
| **64** | **最优** | 论文采用 |
| 128 | 几乎无增益 | 收益饱和 |

rank 64 已足够，继续增大无收益——说明 LLM 接进 ASR 所需的适配容量有限，LoRA 是恰当的性价比选择。

---

## 8. 总结与展望

### 8.1 贡献总结

1. **双路线开源 SOTA**：FireRedASR-LLM（8.3B）和 AED（1.1B）分别面向"最高质量"和"高效部署"，公开集 CER 3.05% / 3.18%，全面超越当时最强开源 Seed-ASR。
2. **LLM 接进 ASR 的工业级配方**：Adapter 帧拼接 + 冻结 LLM + LoRA rank 64 + 仅 transcript 交叉熵——一套可复现的低成本方案，可训练参数不到总量的 10%。
3. **真实场景评测的范式**：公开集之外补充短视频/会议/直播/唱歌/方言/英语六类真实场景，揭示工业级模型真正的差距所在（24%-40% vs 公开集 8.4%）。
4. **三大成功因素的实证**：高质量多样化数据、渐进式正则化、Adapter 设计——消融证明数据与训练策略比架构花样更重要。

更深层的贡献是一种**务实取向**：FireRedASR 没有发明新架构，而是把已有组件（Conformer、Qwen2、LoRA）用最克制的方式组合，把精力压在数据和训练策略上——这正是工业团队区别于学术追新的方法论。

### 8.2 局限性（批判性）

- **公开集提升幅度有限**。相对 Seed-ASR 仅 8.4%，且 LLM 路线参数量是 AED 的 7.5 倍却只多降 0.13 个百分点——公开 benchmark 上 LLM 接入的边际收益已接近饱和，论文对这点揭示得不够直接。
- **真实场景评测缺细节**。论文给出了 24%-40% 的相对提升区间，但未公开真实场景测试集的具体构成和规模，难以独立复现——这是工业论文的通病，也是数据优势的"护城河"体现。
- **仅普通话为主**。英语仅做到与 Whisper 持平，其他语种未评测，多语种能力未充分验证。
- **流式能力未讨论**。80ms 帧拼接降低了计算量，但论文未讨论流式 / 端上部署的延迟与内存，对"工业级"的承诺还不够完整。
- **自训练数据未量化**。提到伪标签扩充流程，但未给出无标注音频的规模与筛选比例，影响数据方法论的可复现性。

### 8.3 未来方向（idea 三法）

**弥补缺陷**：

- 公开真实场景评测集的构成，或与社区共建普通话真实场景 benchmark——补上"工业级"承诺的可验证性。
- 量化自训练流程：披露无标注音频规模、伪标签筛选阈值、人工校验比例，让"数据是第一性原理"可被复现。

**新型方案**：

- 把 Adapter 的帧拼接替换为**可学习的下采样模块**（如 pooling attention），让模型自己学习最优帧率，而非固定 $k=2$——可能在长音频上获得额外收益。
- 探索**多模态 LLM 统一架构**：FireRedASR-LLM 已用 Qwen2 作底座，可进一步与视觉/文档 LLM 统一，做音视频联合理解（如会议纪要 = ASR + 表情 + 屏幕共享）。

**减少约束**：

- 推动**流式 / 端上部署**：结合帧拼接 + 量化 + 蒸馏，把 8.3B 的 LLM 版本压到端上可运行——这是"工业级"承诺的下一站。
- 把渐进式正则化扩展为**在线课程学习**：让模型在部署后继续按真实流量分布自适应，而非训练时一次性固化课程。

---

> **一句话收尾**：FireRedASR 的胜利不是架构的胜利，而是"务实组合 + 数据制胜"的胜利——用最克制的 Adapter + LoRA 把 LLM 接进 ASR，把火力压在高质量数据和渐进式训练上，并在真实场景评测上揭示了工业级模型真正的差距所在。
