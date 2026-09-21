---
title: "One Token Is Enough: Fingerprinting and Verifying Large Language Models from Single-Token Output Distributions"
source:
  type: "论文解读"
  project: "LLM Security"
  url: "https://arxiv.org/abs/2607.10252"
  pdf: "/vibe-reading/papers/one-token-is-enough-llm-fingerprinting.pdf"
date: "2026-09-21T14:36:00+08:00"
category: [AI, Security, Papers]
contentType: "Papers"
tags: ["Model Fingerprinting", "API Auditing", "Jensen–Shannon Divergence", "Biometric Verification", "Model Substitution", "LLM Security", "OpenRouter"]
description: "目的：黑盒验证 LLM API 背后是不是宣称的模型。手段：用 10 个平凡单 token 问题 × 4 种语言采集答案经验分布作行为指纹，JSD 距离做谱系聚类与类生物特征验证。结论：165 个商用模型上 EER 7.3%，约 100 次单 token 查询完成一次审计，总成本仅 $34.44。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/one-token-is-enough-llm-fingerprinting.pdf" target="_blank" rel="noopener">预览</a> · **论文** [One Token Is Enough](https://arxiv.org/abs/2607.10252) · **作者** Tomáš Bruckner（Prague University of Economics and Business）· **发表** arXiv 2607.10252, 2026-07 · **项目** [Zenodo 数据集](https://doi.org/10.5281/zenodo.21278557) · **解读** 2026-09-21

---

## 1. 论文概览

**TL;DR**：当你问一个 LLM「从 1 到 100 之间随机说个数」时，它的答案分布一点也不随机——而这个"缺陷"恰好是模型的身份证。本文证明：**仅用单 token 输出的经验分布就能给 LLM 做行为指纹**——不需要 logits、不需要长文本、不需要模型所有方配合，每个查询只花一个输出 token。作者在 OpenRouter 聚合器上对 **165 个模型**做了 ~326,000 次探测（总成本 $34.44），验证了指纹的存在性与稳定性（同模型分裂样本 JSD 中位 0.075，异模型 0.489）、谱系恢复能力（LOO 1-NN 家族分类 59.5% vs 随机 18.4%），并给出类生物特征验证协议：完整 40 探测单元下 **EER 7.3%**，8 个单元下 10.6%——**每次审计约 100~240 次单 token 查询，几美分以内**。审计还顺带抓到了生态异常：某专有品牌旗舰端点与开源 Qwen 模型在分布上不可区分。

**元信息**：作者 Tomáš Bruckner，布拉格经济大学信息与统计学院，单人作者（致谢中说明 Claude Code 辅助了研究设计、数据收集与初稿，所有输出经作者人工核校）。发表于 arXiv（cs.CR 主分类，交叉 cs.CL / cs.LG），属于测量研究 + 安全协议混合体裁。四个研究问题：**RQ1** 指纹是否存在且稳定（跨服务商、跨温度、跨时间）；**RQ2** 指纹距离能否恢复模型谱系；**RQ3** 类生物特征验证的可靠性-成本曲线；**RQ4** 部署到生产聚合器生态能发现什么异常。

一句话 take-home：**模型身份会从最廉价的信道泄漏出来——被问一个琐碎问题时说出的那一个 token。**

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large language models (LLMs) are increasingly consumed through opaque serving chains – API aggregators, resellers, and inference providers – in which the client has no technical means to confirm that the model answering is the model advertised, and recent audits show that a substantial fraction of commercial endpoints deviate from the vendor's reference weights. Existing identification techniques require long generated texts, token-level log-probabilities, adversarially crafted prompts, or the model owner's cooperation. We show that far weaker evidence suffices. We define a behavioral fingerprint of an LLM as the empirical distribution of its answers to trivial one-word prompts – "name a random number between 1 and 100" – collected across four languages at a cost of one output token per query. Measuring 165 models served via a large commercial aggregator (OpenRouter), we find that (i) these distributions are highly non-uniform (median cell entropy 1.0 bit) and model-specific: split halves of the same model's samples lie an order of magnitude closer than samples of different models; (ii) Jensen–Shannon divergence between fingerprints recovers model lineage, assigning a model to its documented family with 59.5% leave-one-out accuracy against an 18.4% chance rate; and (iii) a biometric-style verification protocol achieves a 7.3% equal error rate with the full 40-cell battery, and below 11% with eight probe cells – roughly a hundred single-token queries per audit. We further report ecosystem anomalies, including a proprietary-branded flagship endpoint distributionally indistinguishable from an open-weight Qwen model. The protocol, prompts, raw data, and analysis code are released for reproduction and operational use.

> **译：** 大语言模型正越来越多地通过不透明的服务链——API 聚合器、转售商和推理提供商——被消费，客户端没有任何技术手段确认应答的模型就是广告宣称的模型，且近期审计显示相当一部分商用端点偏离了厂商的参考权重。现有识别技术需要长生成文本、token 级对数概率、对抗性构造的提示，或模型所有方的配合。我们证明远弱于此的证据就足够了。我们将 LLM 的行为指纹定义为其对平凡一词提示（"name a random number between 1 and 100"）的回答经验分布，跨四种语言采集，每次查询一个输出 token 的成本。对经大型商用聚合器（OpenRouter）服务的 165 个模型的测量表明：(i) 这些分布高度非均匀（中位单元格熵 1.0 bit）且具模型特异性：同模型样本的分裂两半之间的距离比不同模型样本低一个数量级；(ii) 指纹间的 Jensen–Shannon 散度可恢复模型谱系，留一法将模型归入其有档可查家族的准确率为 59.5%，对照 18.4% 的随机基准；(iii) 类生物特征验证协议在完整 40 单元测试组下达到 7.3% 等错误率，8 个探测单元下低于 11%——每次审计约一百次单 token 查询。我们进一步报告生态异常，包括一个专有品牌旗舰端点在分布上与开源 Qwen 模型不可区分。协议、提示、原始数据与分析代码均已公开以便复现和实际应用。

</details>

---

## 2. 研究背景

**问题定义**：LLM 推理市场已经分层——模型创建者与最终应用之间坐着推理提供商、转售商、聚合器，请求在数十个上游部署间路由。客户端用一个字符串（模型名）寻址，收到文本，**这中间没有任何东西能证明应答来自宣称的模型**。提供商可以偷偷替换成更便宜的模型、激进量化的变体、或旧版本，然后赚走差价。

**这不是杞人忧天**。论文开篇引用三组实证：

| 研究 | 发现 |
| --- | --- |
| Gao et al.（ICLR 2025, Model Equality Testing） | 31 个商用 Llama 端点中 **11 个**的输出分布与厂商参考权重统计不兼容 |
| Cai et al.（2025, 模型替换审计） | 形式化了替换威胁（量化 / 小模型 / 版本回滚），并证明朴素输出检查在生产非确定性下脆弱 |
| Zhu et al.（2025, rank-based uniformity test） | 检测量化替代品，但**假设能拿到 log 概率** |

经济激励是结构性的：推理成本随量化与模型规模骤降，而**被发现的风险至今很低**。

**验证为什么难**——这是一取证归因问题，且约束极紧：(i) 客户端拿不到权重或 logits（多数生产 API 只回文本）；(ii) 无法微调或给模型打水印（排除所有协作式方案）；(iii) 预算有限——持续审计许多端点必须花几分钱而不是几美元。现有非协作方法各有短板：

- **生成文本的作者归因**（Sun et al. 用分类器以 97% 五分类准确率归属完整 chat 回复）——但需要长输出；
- **LLMmap**（8 条精心工程化的查询识别 42 个模型版本）与 **TRAP**（对抗后缀做身份蜜罐）——查询效率极高，但其提示的"可辨识性"恰恰成了软肋：**一个能识别并特判这些提示的自适应提供商会让它们失效**；
- **统计等式检验**（Gao et al.）——最接近本场景，但要消费完整采样字符串，且需要一个同模型的参考部署做校准。

**本文的切入观察**来自 LLM 行为文献：被要求"随机"时，模型是可靠地、**各自特异地**非随机——偏爱数字、偏爱正面朝上的硬币、偏好因模型和语言而异（Renda、Van Koevering & Kleinberg、Harrison、Coronado-Blázquez 等一系列工作）。这篇论文做的视角倒转是全文最妙的一步：**这些偏差里凡是系统性的、模型特异的东西，就是身份；而只花一个 token 就能采样的身份，在取证上极有价值。** 因为信号是"对日常问题的答案分布"而非魔法字符串，它采集便宜、对提示改写鲁棒、且不诚实的提供商想特判它就得整体仿真被宣称的模型。

---

## 3. 方法详解

### 3.1 威胁模型

设定：客户端通过不受信提供商（可能经聚合器路由）付费购买宣称模型 X 的推理。提供商**端到端掌控服务栈**：可能忠实服务 X、服务量化/降级变体 X′、替换成更便宜模型 Y、或在这些之间动态路由。验证者只能发普通 chat 请求、观察返回文本与标准元数据、并可查询一个可信的 X 参考部署以登记参考指纹——没有 logits、没有权重、每次审计预算至多几百个输出 token。

对手按能力分三档，这个分级直接决定了协议的设计目标：

| 层级 | 对手行为 | 协议对策 |
| --- | --- | --- |
| **T1 无感** | 静默替换，不检查流量 | 完全覆盖 |
| **T2 过滤** | 识别已知审计提示（如逐字发表的）并路由到真 X | 按设计覆盖：探测空间是无界的日常问题**改写族**，审计时采样、可与普通流量交织，过滤在检测理论上代价高昂 |
| **T3 仿真** | 试图在任意低熵提示上复现 X 的答案分布 | 覆盖即忠实——在任意提示上匹配 X 的条件输出分布等于运行 X，替代的利润空间被侵蚀 |

### 3.2 指纹定义

模型 $M$ 的指纹 = 对一组探测单元 $\mathcal{B} = \{(t, \ell)\}$（任务 $t$ × 语言 $\ell$）中每个单元，在 temperature 1.0 下重复查询得到的**答案经验分布** $\hat{p}^{M}_{t,\ell}$ 组成的元组，外加 temperature 0 下采集的确定性变体。固定系统提示强制一词作答、16 个 completion token 的硬上限、禁用提供商侧推理模式——保证 completion 是模型条件分布的一次**直接单遍采样**。

**探测组（probe battery）**：10 个任务 × 4 种语言（英语、俄语、汉语、阿拉伯语）= 40 个单元。任务选择的四条标准本身就是一个好的实验设计范本：

| 任务 | 答案空间 | 条件 |
| --- | --- | --- |
| random number 1–100 | 封闭（100） | random |
| random number 1–10 | 封闭（10） | random |
| favorite number | 开放（数字） | favorite |
| random letter | 封闭（字母表） | random |
| random word | 开放 | random |
| random color | 开放（规范化后） | random |
| favorite color | 开放（规范化后） | favorite |
| random animal | 开放 | random |
| random city | 开放 | random |
| coin flip | 封闭（2） | random |

(i) 都能一词作答；(ii) 跨越封闭（数字、硬币）与开放（词、城市）答案空间，两类分布携带互补信号；(iii) 包含 random/favorite 对比——本身就具区分度；(iv) 文化语言中性，可用四种语言表述。**语言零设计成本地倍增探测维度**，且探到训练先验的不同切片。

**一个重要的概念澄清**：聚合器目录标识符多对一映射到模型 checkpoint——同一份权重常以滚动别名（-latest）、日期快照、免费层、推理模式变体等多种形式暴露。全文的分析对象是 **checkpoint**（指纹按 checkpoint 估计）；**端点**是通往某个宣称 checkpoint 的一条服务路径；**家族**是共享祖先的 checkpoint 谱系。验证（RQ3）比较端点 vs 其宣称 checkpoint 的参考部署；谱系分析（RQ2）在家族层面操作。

### 3.3 数据处理

原始 completion 确定性地规范化：Unicode NFC、去标点引号、大小写折叠、阿拉伯-印度数字与汉字数字映射到拉丁数字、首 token 提取、逐语言颜色词典把颜色词映射到规范码（用于跨语言分析）。每个回答分为**有效 / 无效**（出答案空间或多词）、**拒绝**、**空**——从不静默丢弃，逐模型报告有效率（总体 97.6%，逐模型中位 99.6%，最低 60.6%——一个经常用整句话作答的模型）。拒绝率与有效率本身是弱身份信号，但被排除在指纹外以保持对安全层变更的鲁棒性。

### 3.4 原始信号长什么样

![Fig. 1 原始指纹信号：四个模型对「1 到 100 之间说个随机数」（英语，T=1.0，30 次采样）的答案分布。同一提示，四个模型，四张截然不同——且各自稳定——的分布：GPT-4o 散布在 42/37/57，Claude Sonnet 5 集中在 47，Llama 3.3 在 53，Qwen3-Max 每次都答 42。](/vibe-reading/images/articles/one-token-is-enough-llm-fingerprinting/fig-1-raw-fingerprint-signal.png)

这是全文的直觉锚点：**同一个平凡问题，不同模型给出的分布像不同人的笔迹**。GPT-4o 的答案散布在几个数上；Claude Sonnet 5 高度集中于 47；Llama 3.3 偏好 53；Qwen3-Max 30 次采样**每一次都答 42**（一个几乎退化的分布）。这种差异反映了 tokenizer 结构、训练数据先验与后训练选择的叠加——被替换的模型无法精确复现它。

### 3.5 验证协议（类生物特征）

验证问题：「端点 $E$ 是否在服务宣称的模型 $X$？」协议两段式，与指纹门禁同构：

1. **登记（enrollment）**：验证者从可信部署采集 $X$ 的参考指纹；
2. **审计（audit）**：从探测组（或其改写族）抽 $k$ 个单元，每单元从 $E$ 采 $n$ 个答案，计算得分 $s$（参考与被测分布的平均 JSD），$s \leq \tau$ 则接受宣称。

评估按生物特征验证的方式进行：**真试验**（genuine）比较同一模型样本的两个不相交对半（按重复奇偶分半，时间交织）；**假试验**（impostor）比较模型 $X$ 的对半与 $Y \neq X$ 的对半。扫阈值 $\tau$ 得 ROC、AUC、EER；对探测单元做随机 $k$-子集重采样得**查询预算曲线**——给定保证水平的运营成本。把真试验换成"同一模型由不同提供商服务"（OpenRouter 路由提供的自然实验），就检验了指纹对服务栈的鲁棒性（RQ1）。

---

## 4. 关键公式解读

**距离度量——Jensen–Shannon 散度**。指纹间距离用 base-2 的 JSD 在共享单元上取平均：

$$
D(M_a, M_b) \;=\; \frac{1}{|\mathcal{B}'|} \sum_{(t,\ell)\in\mathcal{B}'} \operatorname{JSD}\!\left(\hat{p}^{M_a}_{t,\ell} \,\Big\|\, \hat{p}^{M_b}_{t,\ell}\right),
\qquad
\mathcal{B}' = \{(t,\ell) : \text{双方各有} \geq 10 \text{ 个有效样本}\}
$$

其中 JSD 定义为：

$$
\operatorname{JSD}(p \| q) \;=\; \underbrace{\tfrac{1}{2}\,D_{\mathrm{KL}}(p \| m)}_{p \text{ 偏离混合}} \;+\; \underbrace{\tfrac{1}{2}\,D_{\mathrm{KL}}(q \| m)}_{q \text{ 偏离混合}},
\qquad m = \tfrac{1}{2}(p + q)
$$

选 JSD 的三个理由：**对称**（无方向性，适合"距离"语义）、**有界于 [0, 1]**（base-2 下上限恰为 1，跨任务可比）、**在不相交支撑上良定义**（KL 在 $q(a)=0, p(a)>0$ 时爆炸，而稀疏类别分布——比如 Qwen3-Max 那个退化在 42 上的分布——经常不相交）。

**验证得分**——$k$ 个探测单元上参考与被测分布的平均 JSD，阈值化判决：

$$
s \;=\; \frac{1}{k}\sum_{i=1}^{k} \operatorname{JSD}\!\left(\hat{p}^{\mathrm{ref}}_{i} \,\Big\|\, \hat{p}^{E}_{i}\right),
\qquad
\text{接受「} E \text{ 服务 } X \text{」} \iff s \leq \tau
$$

直觉：真模型对同一问题的分布两半之间只有采样噪声（中位 0.075），被替换模型的分布则落在异模型区间（中位 0.489）——$\tau$ 落在这两个簇之间即可分辨。

**非均匀性度量——单元格熵**（RQ1 的量化语言）：

$$
H(\hat{p}_{t,\ell}) \;=\; -\sum_{a} \hat{p}_{t,\ell}(a)\,\log_2 \hat{p}_{t,\ell}(a),
\qquad
H \in [0, \log_2 |\text{答案空间}|]
$$

均匀分布的熵对「1–100 随机数」任务是 $\log_2 100 \approx 6.64$ bit；实测中位仅 **1.00 bit**——模型回答的确定性比均匀采样高出数倍，这正是"缺陷即信号"的量化表述。

---

## 5. 实验设置

**模型池**：从聚合器目录快照（2026-07-06，342 个模型）经机器可查的排除规则筛到 **165 个模型、19 个家族标签、53 个服务提供商**。排除规则本身就是论文严谨性的体现，五类：(i) 非纯文本 chat 模型（多模态输出 / embedding / 审核 / 非 instruct 基座 / 上下文 < 2048 token）；(ii) 窄专化模型（代码、数学、医疗、角色扮演）；(iii) 非单一稳定 checkpoint（-latest 别名、可变 preview 与弃用端点、meta-router、多 agent 或搜索接地管线、免费层或推理模式重复项）；(iv) 强制隐藏推理阶段的端点（指纹定义所依赖的直接单遍 completion 不可观测——OpenAI o 系列拒绝 reasoning effort "none" 的模型在此被排除）；(v) 仅免费层的端点（账户级日请求上限使完整采集不可行）。外加一条人工记录的排除（一个定价 $150/$600 每 1M token 的模型）。每个被排除的标识符都带机器或人工分配的排除理由，随 artifact 发布。

**采样**：每模型 × 10 任务 × 4 语言，T=1.0 下 30 次、T=0 下 3 次；前沿定价模型（输入 ≥ $5/1M token）在 T=1.0 下 15 次。

**试点与预注册**：14 个模型（7 个同家族大小对）的 pilot 固定了全部设计与分析选择，验收四条预设标准：逐模型有效率 ≥ 80%、提供商内贪心确定性 ≥ 90% 单元格、家族间 vs 家族内散度差距显著（置换检验 p = 0.0008）、成本外推。假设与分析计划在主跑之前**预注册**（OSF），pilot 数据排除在确证分析之外——这在测量研究里是高规格的操作。

**实现**：对 OpenRouter 聚合器 API 跑一个可恢复、幂等的 runner——每个请求是确定性的单元重复，失败指数退避重试、从不进数据；每条响应原样存储 UTC 时间戳、延迟、服务提供商、上报模型串、token 用量（含缓存 token 计数，支撑响应缓存筛查）与成本。单元以种子洗牌顺序执行，让限流缺口近似均匀散布在各模型单元上（设计上的随机缺失）而非耗尽整个任务或语言。

**成本**：完整普查 326,047 条响应（23.3M 输入 / 1.16M 输出 token），**$34.44，合每模型 $0.21**——比同等重复次数的长生成归因低约三个数量级。这就是"单 token"的全部意义：身份检查便宜到可以持续做。

**复现性**：提示（四语全文）、原始响应（含完整服务元数据）、分析代码全开放（Zenodo 数据集与软件归档分开发布），预注册在 OSF。每个数字由具名 artifact 文件产出、可从原始响应端到端再生。

---

## 6. 实验结果

### 6.1 RQ1：指纹存在且稳定

**非均匀且模型特异**：6,572 个有效单元格中，中位熵 1.00 bit、中位众数答案份额 0.71（对照均匀基线熵 1–6.6 bit）。模型特异性用分裂对半检验：同模型对半间中位 JSD **0.075**，异模型对半间 **0.489**（6,564 真 vs 107 万 impostor 单元格级试验）——**一个数量级的分离**，这就是验证性能的全部统计基础。

**对服务栈鲁棒**：OpenRouter 的路由提供了自然实验——31 个模型由两个以上提供商服务且覆盖足够（34 个提供商对，每对 ≥ 15 共享单元）。跨提供商中位距离 0.227：高于单部署分裂噪声底（0.140）但远低于 impostor 中位（0.463）；70.6% 的提供商对落在 impostor 距离的第 5 百分位之下。用不同提供商采集的参考做验证仍达 **AUC = 0.880**（同栈 0.971）——指纹大体上扛住了服务栈变化；扛不住的那些对，恰恰是 §6.4 的异常候选。

**T=0 确定性**：提供商内 90.4% 单元格贪心确定；跨提供商合并后降到 84.5%——缺口是服务栈方差：**同一模型的不同上游部署产生不同但各自稳定的贪心答案**。

### 6.2 RQ2：谱系恢复

![Fig. 2 165 个服务模型在单 token 指纹平均 JSD 上的 UPGMA 层次聚类；叶标签按有档可查的家族着色。打印版标签过小，电子版可缩放，大图随 artifact 发布。](/vibe-reading/images/articles/one-token-is-enough-llm-fingerprinting/fig-2-upgma-clustering.png)

对 165 模型的距离矩阵做平均连接（UPGMA）层次聚类，树忠实表达距离结构（cophenetic 相关 0.886）。**家族信号在指纹空间中高度局部**：留一法 1-NN 把模型归入其有档可查家族的准确率 **59.5%**（163 个有同家族同伴的模型），对照频率加权随机基准 18.4%——3.2 倍于随机，精确二项 p < 10⁻³⁰。

一个值得注意的负面结果：在 k = 19 处平切树状图恢复家族的能力**很弱**（ARI = 0.023）。原因有二：标签集含一个 17 模型的"other"杂烩（不相关厂商）与若干单点家族；谱系信号住在**最近邻几何**而非全局紧凑簇里。这提示了一个方法论教训：对这类行为指纹，分类用 1-NN 局部结构，别指望全局聚类把家族切成干净的块。

逐家族精度/召回（家族 ≥ 8 成员）：

| Family | n | Precision | Recall |
| --- | --- | --- | --- |
| qwen | 30 | 0.50 | 0.73 |
| gpt | 21 | 0.70 | 0.90 |
| other | 17 | 0.20 | 0.06 |
| mistral | 16 | 0.87 | 0.81 |
| claude | 12 | 0.54 | 0.58 |
| glm | 12 | 1.00 | 0.83 |
| llama | 12 | 0.88 | 0.58 |
| gemini | 11 | 0.43 | 0.55 |
| deepseek | 8 | 0.46 | 0.75 |

有档可查的主谱系恢复良好（GLM 1.00/0.83、Mistral 0.87/0.81、GPT 0.70/0.90）；异质 "other" 标签预测性地失败（0.20/0.06）。被错分的模型逐个作为异常候选检查（RQ4）。

### 6.3 RQ3：验证与查询预算

![Fig. 3 验证 ROC：分裂对半指纹距离区分真身份宣称与 impostor（AUC = 0.971，EER = 7.3%；165 真 / 27,060 假试验）。](/vibe-reading/images/articles/one-token-is-enough-llm-fingerprinting/fig-3-verification-roc.png)

完整 40 单元下 **AUC = 0.971，EER = 7.3%**（165 真 / 27,060 impostor 试验）。这是主结果图——错误率已经低到可用，且这是在**一个查询 token 一份证据**的极限预算下达到的。

### 6.4 RQ4：生态异常

作者对异常的措辞很克制——**所有发现都是关于被服务分布的统计陈述，不是欺诈指控**（良性解释与披露处理见论文 §VIII：权重更新、经批准的量化、缓存层都可能造成偏离）。

**身份异常**（最劲爆的部分）：

- 一个以专有自研模型营销的旗舰端点（`writer/palmyra-x5`）指纹落在距 `qwen/qwen3-235b-a22b-2507` **0.141** 处——正好是真同模型距离的中位（0.140）、远低于 impostor 区间。**分布上与一个开源权重的 Qwen 部署不可区分。**
- 反向确认未标注谱系：`deepcogito/cogito-v2.1-671b`（文档记载训自 DeepSeek V3 基座）最近邻是三个 DeepSeek checkpoint（0.268–0.308，低于 impostor 第 5 百分位）；`xiaomi/mimo-v2.5-pro`、`inclusionai/ling-2.6-1t` 稳稳落在 Qwen 邻域。
- 信号也能被**抹掉**：`nvidia/llama-3.3-nemotron-super-49b-v1.5`（文档记载的 Llama-3.3 衍生）离 Qwen 模型（0.303）比离任何 Llama checkpoint 都近——重度后训练会覆写谱系先验，这给家族分类的能力划了上界。

**部署异常**：34 个同模型提供商对中 **10 个（29%）** 的分歧超出 impostor 距离第 5 百分位——被服务分布的差异比两个**不同**模型通常的差异还大。极端案例：`meta-llama/llama-3.2-3b-instruct` 在 Cloudflare vs Parasail 之间距离 **0.716**（深入 impostor 领地）；甚至 `openai/gpt-4` 经 Azure vs OpenAI 第一方也达到 0.392。

**服务层不透明**（内容盲审计看不到的异常）：旗舰 chat 端点对一个一词可见答案消耗 ~40–60 个 completion token——一个**不可验证的隐藏计算阶段**；提供商静默忽略推理禁用标志（0.76% 响应带推理 trace，14 个模型-提供商组合）；一个模型的唯一提供商对所有数字提示返回服务器错误、其余正常。

---

## 7. 消融实验

本文没有传统意义的模块消融，但三条补充分析承担了同样的角色——量化协议各设计选择的贡献与边界。

### 7.1 查询预算曲线（k 消融）

对 40 个探测单元做随机 k-子集重采样（90% 带宽），EER 随预算的收敛：

| k（探测单元数） | 1 | 4 | 8 | 16 | 32 | 40 |
| --- | --- | --- | --- | --- | --- | --- |
| EER (%) | 23.3 | 13.2 | 10.6 | 9.5 | 8.4 | 7.3 |
| 90% 带 (%) | 14–40 | 9–18 | 8–14 | 8–12 | 7–10 | – |

![Fig. 4 可靠性-成本权衡：EER 随探测单元数 k（40 单元组的随机子集）的变化。](/vibe-reading/images/articles/one-token-is-enough-llm-fingerprinting/fig-4-eer-query-budget.png)

关键读数：**单个单元就已远好于随机**（EER 23.3%）；8 个单元到 10.6%；k ≈ 16–24 之后曲线变平。在 k = 16 操作点上，按估计所用样本量（每单元 15 次重复）审计成本 = 16 × 15 = **240 次单输出 token 查询，共 ~16k 输入 token**——从典型定价模型的百分之几美分到前沿定价模型的几美分。**对端点的持续再审计在经济上是平凡的**——这是论文第一次为这类方法量化"一次可信的身份检查要花多少 token"。

### 7.2 缓存筛查（prefix cache 不是混淆项）

对相同提示的重复采样使 prompt-cache 命中成为设计内的预期产物：13.4% 的普查请求报告 prompt-cache 命中、覆盖 10.1% 的输入 token。但**前缀缓存复用的是已见输入前缀的确定性 KV 计算**——改变请求的成本与延迟，不改变 completion 从中解码的条件分布，重复仍是同一分布的独立抽样，不是混淆项。真正会干扰测量的是另一机制——**响应级缓存**（重放存储的 completion 而非重新解码），它会让 T=1.0 分布人为塌缩。论文把它当异常而非麻烦：响应方差塌缩 + 异常低且低方差的延迟构成一个联合签名，数据直接暴露；被筛出的单元格按异常处理、不进指纹证据。跑筛查的结果：**无响应缓存签名**——2,040 个 T=1.0 单答案单元格中只有 14 个同时有低于模型中位一半的中位延迟，且全部处于供应商负载方差可解释的普通亚秒延迟——没有一个接近 served cache 会产生的近瞬时特征。

### 7.3 隐藏计算的排除（协议纯度筛查）

「强制隐藏推理」的排除标准最终是**行为性而非声明性的**：收集过程发现，有端点宣称推理可选却无视禁用标志（把 token 预算烧在可见 trace 上，某些情况下只发生在特定上游）；有旗舰端点的 completion 消耗数倍于可见一词答案的 token 却不暴露任何推理 trace——对后者无法证明答案是直接单遍采样而非隐藏深思阶段的输出，同样排除。带 trace 的响应被编码为独立答案类、从不进指纹（0.76% = 2,486 / 326,047，14 个模型-提供商组合）。这个筛查本身成了生态观察：**服务层的隐藏计算正在成为一种普遍的部署形态**，而内容盲审计对它不可见。

---

## 8. 总结与展望

**贡献总结**（对应论文四条 contribution）：

1. **极小输出指纹**——黑盒行为指纹，每查询一个输出 token，无需 logits、无需长生成、无需所有方配合（§3）；
2. **迄今最大的单 token 行为普查**——165 个商用模型 × 10 任务 × 4 语言，~326,000 请求，总成本 $34.44（§5）；
3. **带显式成本-可靠性曲线的验证协议**——分裂样本 JSD：完整组 EER 7.3%、8 单元 10.6%（~120 次单 token 查询），首次为该类方法量化可信身份检查的 token 价格（§7.1）;
4. **生态发现与 artifact**——专有旗舰 ≡ 开源 Qwen、10/34 同模型提供商对超出 impostor 区间等异常，以独立可验证的分布偏差形式呈现；提示、带完整服务元数据的原始响应、分析代码全部发布（§6.4）。

**局限性**（论文 §VII-D，批判性读）：

- **指纹随模型更新漂移**，参考登记必须刷新；论文量化了短视界稳定性但没有多月漂移数据；
- **验证假设存在可信参考部署**——对完全闭源且无第一方可信渠道的模型，登记本身可能是循环的；
- 家族标签依赖公开文档，标签噪声只会压低（不会抬高）谱系结果；
- 隐藏推理端点被排除——推理后答案信道采样的已是另一种生成过程，混合两种机制会按协议而非谱系聚类；这把一整类（且越来越多）旗舰模型排除在了普查之外；
- **单一聚合器**——协议与聚合器无关，但生态发现未必能外推；
- 更根本的：论文自己承认**不提供密码学保证**——协议抬高了未被发现替换的成本，是硬件见证等提案的补充而非替代。

**未来方向**（idea 三法）：

- *弥补缺陷*：纵向漂移追踪（时间维度的指纹演化）；paraphrase 不变性的专项实验（论文自己只论证了原理、battery 已实现四语，但没跑专门实验）；放宽 token 预算后给**推理后答案信道**做指纹——方法论上独立且必要，否则 o-series 这类强制推理模型永远在射程之外；
- *新型方案*：watermark-aware 变体——水印会改变答案分布，指纹协议应能区分"被水印的真模型"与"被替换的模型"；
- *减少约束*：论文提到一个 companion study——共享指纹结构意味着模型间 tacit coordination（共享训练语料诱导共享先验，呼应 Schelling 聚点行为与算法单一文化）——多语言设计捕获的跨模型共享文化先验正是那项分析的原材料。

**读后感**：这篇论文最漂亮的地方是视角倒转——把行为文献里"LLM 不会采样均匀"这个被当作缺陷反复刻画的现象，翻过来当作取证信号，然后一路推到运营成本曲线（"一次审计几美分"）。方法上没有重型机器：JSD + 1-NN + 分裂对半，全是可以用三行 R 复现的东西；真正重的是**实验纪律**——预注册、幂等 runner、设计上的随机缺失、每条排除理由随数据发布、异常只做统计陈述不做动机指控。对做测量研究的人来说，这份纪律本身就是模板。

---

## 9. 相关阅读

- [Stealing Reasoning Traces from Proprietary LLM APIs](/vibe-reading/articles/stealing-reasoning-traces-llm-apis) — **同域对照**·LLM API 黑盒安全的另一面：从专有 API 窃取推理 trace，与本篇"验证 API 背后是不是宣称的模型"互为镜像，同在 [AI, Security, Papers] 分类下
- [vLLM CodeWiki：概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview) — **背景知识**·本篇反复讨论的服务栈因素（temperature 采样、前缀缓存、部署差异）在推理引擎侧的实现原理，读 §7 前建议先建立 serving 栈直觉
- [Kimi K3 Technical Report](/vibe-reading/articles/kimi-k3-technical-report) — **同基准对照**·Kimi K2/K2.5/K2.6 家族正是本篇 165 模型谱系聚类中清晰成簇的 kimi 家族——从被指纹审计的模型一侧看家族演化
