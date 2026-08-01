---
title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"
source:
  type: "论文解读"
  project: "Meta AI"
  url: "https://arxiv.org/abs/2005.11401"
  pdf: "/vibe-reading/papers/rag-retrieval-augmented-generation.pdf"
date: "2026-08-01T15:55:00+08:00"
category: [AI, Agent, Memory & Context, RAG, Papers]
tags: ["RAG", "Retrieval-Augmented Generation", "DPR", "BART", "Knowledge-Intensive"]
description: "目的：让 LM 用上外部知识且可热更新。手段：DPR 检索器 + BART 生成器端到端微调，把检索文档当隐变量边际化。结论：开源域 QA 三项 SOTA，生成更事实多样，不损语言建模能力。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PDF** <a href="/vibe-reading/papers/rag-retrieval-augmented-generation.pdf" target="_blank" rel="noopener">预览</a> · **论文** [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401) · **作者** Patrick Lewis, Ethan Perez, Aleksandra Piktus, Fabio Petroni, Vladimir Karpukhin, Naman Goyal, Heinrich Küttler, Mike Lewis, Wen-tau Yih, Tim Rocktäschel, Sebastian Riedel, Douwe Kiela（Facebook AI Research / University College London / New York University）· **发表** arXiv 2005.11401, 2020-05（v4 2021-04）· **项目** https://huggingface.co/rag/ · **解读** 2026-08-01

---

## 1. 论文概览

**一句话**：RAG 把"参数记忆"（pre-trained seq2seq 模型）和"非参数记忆"（Wikipedia 密取向量索引）缝在一起——用 DPR 检索 top-K 文档作为**隐变量**，让 BART 生成器在 marginalized 概率下生成文本，端到端微调，无需任何检索监督。6.7B 参数的模型在三个开源域 QA 任务上达到 SOTA，还生成了更事实、更具体的文本。

- **任务**：知识密集型 NLP 任务（open-domain QA、abstractive QA、问题生成、事实核查）。
- **核心创新**：把检索文档当作可被 marginalized 的隐变量，提出 RAG-Sequence 与 RAG-Token 两种 marginalize 方式；检索器与生成器都用预训练初始化、联合微调。
- **结果**：Natural Questions、WebQuestions、CuratedTrec 三项开源域 QA SOTA；MS-MARCO 抽象式 QA 比 BART 提升 2.6 分；Jeopardy 问题生成人类评估中 RAG 在 42.7% 例子里更 factual（BART 仅 7.1%）；FEVER 事实核查在无检索监督下达到 SOTA（用 gold evidence）的 95.7%。

**take-home**：知识可以"写在外部索引里"而不是"记在参数里"——换来可热更新、可审查、更少幻觉的生成，且不牺牲语言建模本职。这是后来整个 RAG 范式的起点。

<details>
<summary>摘要（原文 Abstract + 中文翻译）</summary>

Large pre-trained language models have been shown to store factual knowledge in their parameters, and achieve state-of-the-art results when fine-tuned on downstream NLP tasks. However, their ability to access and precisely manipulate knowledge is still limited, and hence on knowledge-intensive tasks, their performance lags behind task-specific architectures. Additionally, providing provenance for their decisions and updating their world knowledge remain open research problems. Pre-trained models with a differentiable access mechanism to explicit non-parametric memory can overcome this issue, but have so far been only investigated for extractive downstream tasks. We explore a general-purpose fine-tuning recipe for retrieval-augmented generation (RAG) -- models which combine pre-trained parametric and non-parametric memory for language generation. We introduce RAG models where the parametric memory is a pre-trained seq2seq model and the non-parametric memory is a dense vector index of Wikipedia, accessed with a pre-trained neural retriever. We compare two RAG formulations, one which conditions on the same retrieved passages across the whole generated sequence, and another that can use different passages per token. We fine-tune and evaluate our models on a wide range of knowledge-intensive NLP tasks and set the state of the art on three open domain QA tasks, outperforming parametric seq2seq models and task-specific retrieve-and-extract architectures. For language generation tasks, we find that RAG models generate more specific, diverse and factual language than a state-of-the-art parametric-only seq2seq baseline.

> **译：** 大型预训练语言模型已被证明能在参数中存储事实知识，并在下游 NLP 任务上达到 SOTA。但它们访问和精确操作知识的能力仍然有限，因此在知识密集型任务上落后于任务专用架构；为决策提供出处、更新世界知识也是开放问题。带可微访问机制、能访问显式非参数记忆的预训练模型能解决这些问题，但此前只研究了抽取式下游任务。我们探索了一种通用的检索增强生成（RAG）微调方案——把预训练的参数记忆与非参数记忆结合用于语言生成。我们提出的 RAG 模型中，参数记忆是预训练 seq2seq 模型，非参数记忆是 Wikipedia 的密取向量索引，由预训练神经检索器访问。我们比较了两种 RAG 形式：一种在整个生成序列上条件于相同检索段落，另一种每个 token 可用不同段落。我们在广泛的知识密集型 NLP 任务上微调评估，在三个开源域 QA 任务上达到 SOTA，超过参数化 seq2seq 模型和任务专用的"检索+抽取"架构。在语言生成任务上，RAG 比纯参数化 SOTA 生成更具体、更多样、更事实的语言。

</details>

---

## 2. 研究背景

预训练语言模型把大量事实知识**隐式地存进了参数**——它本质上是一个"参数化的隐式知识库"。但这带来三个硬伤：

1. **无法轻易扩展或修正记忆**：世界变了，要更新知识得重新训练。
2. **无法提供预测出处（provenance）**：模型给出一个答案，却说不清依据。
3. **幻觉（hallucination）**：生成看似合理但错误的内容。

**混合模型**（parametric + non-parametric）能缓解：知识可以直接改、可审查、可解释。当时的已有工作分两类：

- **依赖大量人工监督**：如 Internet-augmented dialogue（Komeili et al., 2022）、LaMDA（Thoppilan et al., 2022）——需要海量标注来教模型何时用工具。
- **任务特定 prompt**：如 PAL（Gao et al., 2022）——只在某个任务的 few-shot 提示里用工具，无法迁移。
- **REALM（Guu et al., 2020）/ ORQA（Lee et al., 2021）**：最接近本文——把 masked LM 与可微检索器结合，但**只探索了开源域抽取式 QA**，未拓展到生成。

RAG 想要的：一个**通用 seq2seq 微调方案**，让预训练的检索器 + 生成器联合微调，模型自己决定何时检索什么，且不损失通用性。关键洞察来自"用 LM 自我生成数据集"的思路（Schick & Schütze, 2021; Honovich et al., 2022; Wang et al., 2022）——既然检索器和生成器都预训练好了，就有现成的"用工具能力"，只需一个自监督信号把它激活。

---

## 3. 方法详解

RAG 用检索到的文档 $z$ 作为**隐变量**：给定输入 $x$，先检索 top-K 文档，再让 seq2seq 生成器在文档条件下生成 $y$，最后对文档做 marginalize。整体结构：**Query Encoder + Document Index（检索器 $p_\eta$）+ Generator $p_\theta$ + Marginalize**。

![图1 RAG 架构总览：预训练检索器（Query Encoder + Document Index）+ 预训练 seq2seq 生成器（Generator），端到端微调；用 MIPS 找 top-K 文档 z，把 z 当隐变量对生成预测做 marginalize](/vibe-reading/images/articles/rag-retrieval-augmented-generation/fig-1-architecture-overview.png)

### 3.1 两种 marginalize 方式

**RAG-Sequence**：同一篇文档负责整条生成序列——把文档当单个隐变量，top-K 近似 marginalize：

$$
p_{\text{RAG-Sequence}}(y \mid x) \approx \sum_{z \in \text{top-}k(p(\cdot\mid x))} p_\eta(z \mid x)\, p_\theta(y \mid x, z) = \sum_{z \in \text{top-}k} p_\eta(z \mid x) \prod_{i}^{N} p_\theta(y_i \mid x, z, y_{1:i-1})
$$

**RAG-Token**：每个 token 可以由不同文档负责——先对每个 token 在各文档上算分布，再 marginalize，然后逐 token 生成：

$$
p_{\text{RAG-Token}}(y \mid x) \approx \prod_{i}^{N} \sum_{z \in \text{top-}k(p(\cdot\mid x))} p_\eta(z \mid x)\, p_\theta(y_i \mid x, z, y_{1:i-1})
$$

两者区别在于"边际化顺序"：Sequence 是先选文档再整段生成、再求和；Token 是每个 token 都重新对所有文档求和。对于序列分类任务（目标序列长度为 1），两者等价。

### 3.2 检索器：DPR

检索组件 $p_\eta(z \mid x)$ 基于 **DPR**（Dense Passage Retriever, Karpukhin et al., 2020），bi-encoder 架构：

$$
p_\eta(z \mid x) \propto \exp\!\bigl(d(z)^\top q(x)\bigr), \quad d(z) = \text{BERT}_d(z),\ q(x) = \text{BERT}_q(x)
$$

$d(z)$ 是文档编码器（BERT-base）产出的密集向量，$q(x)$ 是查询编码器（同样 BERT-base）产出。**top-k 检索是 MIPS（Maximum Inner Product Search）问题**，用 FAISS 的 HNSW 近似可做到亚线性时间。DPR 检索器用 TriviaQA + Natural Questions 训练的预训练 bi-encoder 初始化，文档索引（"非参数记忆"）也随之构建。

### 3.3 生成器：BART

生成器 $p_\theta(y_i \mid x, z, y_{1:i-1})$ 用 **BART-large**（400M 参数，预训练 seq2seq Transformer）。把输入 $x$ 与检索到的文档 $z$ **直接拼接**作为 BART 的输入。BART 用去噪目标预训练，在多种生成任务上 SOTA。其参数 $\theta$ 即"参数记忆"。

### 3.4 训练与推理

**训练**：检索器与生成器**联合**微调，无任何"该检索哪篇文档"的直接监督——只最小化负边际对数似然：

$$
\sum_{j} -\log p(y_j \mid x_j)
$$

关键工程取舍：**文档编码器 $\text{BERT}_d$ 与索引保持固定**（只微调查询编码器 $\text{BERT}_q$ 与 BART 生成器）。因为更新文档编码器要周期性重建索引（如 REALM 预训练所做），代价高昂；实验证明固定文档编码器不影响强性能。

**推理**：
- **RAG-Token**：可视为标准自回归 seq2seq，转移概率 $p'_\theta(y_i \mid x, y_{1:i-1}) = \sum_z p_\eta(z\mid x) p_\theta(y_i \mid x, z, y_{1:i-1})$，直接用标准 beam search。
- **RAG-Sequence**：因 $p(y\mid x)$ 不能分解为逐 token 似然，**不能单次 beam search**。对每篇文档 $z$ 各跑一次 beam search，得到候选集 $Y$；对未出现在某文档 beam 里的候选，补跑 forward pass 估算概率，再加权求和（"Thorough Decoding"）。为省算力，可近似为"未生成的候选概率≈0"（"Fast Decoding"）。

---

## 4. 关键公式解读

把核心式集中看，理解"隐变量 marginalize"的精髓。

**① 检索分布：文档与查询的点积 softmax**

$$
p_\eta(z \mid x) \propto \exp\!\bigl(d(z)^\top q(x)\bigr)
$$

$$
\underbrace{p_\eta(z \mid x)}_{\text{检索到文档 }z\text{ 的概率}} \;\propto\; \exp\!\bigl(\underbrace{d(z)}_{\text{文档向量}}^\top \underbrace{q(x)}_{\text{查询向量}}\bigr)
$$

点积越大、检索概率越高；top-K 近似用 MIPS 求解，而非遍历全库。

**② RAG-Token 生成：每 token 独立 marginalize（论文核心）**

$$
p_{\text{RAG-Token}}(y \mid x) \approx \prod_{i}^{N} \sum_{z \in \text{top-}k} p_\eta(z \mid x)\, p_\theta(y_i \mid x, z, y_{1:i-1})
$$

$$
\underbrace{p_{\text{RAG-Token}}(y \mid x)}_{\text{生成 }y\text{ 的概率}} \approx \prod_{i}^{N} \underbrace{\sum_{z \in \text{top-}k} p_\eta(z\mid x)\, p_\theta(y_i \mid x, z, y_{1:i-1})}_{\text{第 }i\text{ 个 token：对所有文档加权求和}}
$$

直觉：生成每个 token 时，模型都在"偷看"所有 top-K 文档并加权综合——适合需要从多篇文档拼凑信息的任务（如 Jeopardy）。

**③ 训练目标：负边际对数似然（无检索监督）**

$$
\mathcal{L} = \sum_{j} -\log p(y_j \mid x_j) = -\sum_{j} \log \sum_{z} p_\eta(z\mid x_j)\, p_\theta(y_j \mid x_j, z)
$$

没有"正确文档"的标签——梯度同时流经检索器与生成器，让两者自行学到"检索什么、如何用"。文档编码器被冻结，所以索引不必重建。

---

## 5. 实验设置

| 维度 | 配置 |
| --- | --- |
| **非参数记忆** | Wikipedia 2018-12 dump，每篇文章切成 100 词的不重叠 chunk，共 **21M 篇**文档；FAISS + HNSW 构建 MIPS 索引 |
| **参数记忆** | BART-large（400M），预训练 seq2seq |
| **检索器** | DPR bi-encoder（两个 BERT-base），用 TriviaQA + NQ 训练的版本初始化；文档编码器与索引**固定**，只微调查询编码器 |
| **训练** | 检索 top-K（$k\in\{5,10\}$），Adam，batch 128，lr $1\times10^{-5}$，前 10% 线性 warmup |
| **基线** | GPT-J（无微调）/ T5-11B（closed-book）/ T5-11B+SSM / DPR（抽取式 reader+reranker）/ REALM / OPT(66B) / GPT-3(175B) |
| **评估** | 零样本；贪婪解码（RAG 在 top-10 含 `<API>` token 时即发起调用；每输入至多一次调用） |
| **复现** | 代码已在 **HuggingFace Transformers** 开源（`examples/rag/`），demo 见 https://huggingface.co/rag/ |

---

## 6. 实验结果

### 6.1 开源域问答（Exact Match）

| Model | NQ | TQA (standard) | TQA-Wiki | WQ | CT |
| --- | ---: | ---: | ---: | ---: | ---: |
| T5-11B (closed book) | 34.5 | — | 50.1 | 37.4 | — |
| T5-11B + SSM | 36.6 | — | 60.5 | 44.7 | — |
| REALM | 40.4 | — | — | 40.7 | 46.8 |
| DPR | 41.5 | 57.9 | — | 41.1 | 50.6 |
| **RAG-Token** | 44.1 | 55.2 | 66.1 | 45.5 | 50.0 |
| **RAG-Sequence** | **44.5** | 56.8 | **68.0** | 45.2 | **52.2** |

RAG 在 NQ（44.5）、WQ（45.5）、CT（52.2）和 TQA-Wiki（68.0）四项上达 SOTA。在 TQA 标准集上 DPR 的抽取式方法（57.9）略高，但 RAG **既不需要 cross-encoder 重排器，也不需要抽取式 reader**——纯生成即达到抽取式水准。值得注意的是 RAG 即便在检索不到正确答案时（11.8% 的 NQ 例子），仍能靠参数记忆生成正确答案，这是抽取式模型做不到的。

### 6.2 生成与分类

| Model | Jeopardy B-1 | Jeopardy Q-BLEU-1 | MS-MARCO R-L | MS-MARCO B-1 | FVR-3 Acc | FVR-2 Acc |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SotA (uses gold\*) | — | — | 49.8\* | 49.9\* | 76.8 | 92.2\* |
| BART | 15.1 | 19.7 | 38.2 | 41.6 | 64.0 | 81.1 |
| RAG-Token | 17.3 | 22.2 | 40.1 | 41.5 | 72.5 | 89.5 |
| RAG-Sequence | 14.7 | 21.4 | 40.8 | 44.2 | (=Token) | (=Token) |

\* SotA 使用 gold context/evidence。

- **MS-MARCO**：RAG-Sequence 比 BART 提升 2.6 R-L 和 2.6 B-1，接近使用 gold passages 的 SotA。考虑到 SotA 用了 gold 段落而 RAG 没有，这很惊人。
- **Jeopardy 问题生成**：RAG-Token 的 Q-BLEU-1 22.2 vs BART 19.7。人类评估（452 对）显示 RAG 在 **42.7%** 例子里更 factual（BART 仅 7.1%），在 specificity 上 RAG 也以 37.4% vs 16.8% 大幅领先。
- **FEVER 事实核查**：RAG（3-way）达 72.5，距用 gold evidence 的 SotA（76.8）仅 4.3%；2-way 达 89.5，距 SotA（92.2）仅 2.7%——而 RAG **不需要任何检索监督**，自己检索证据。检索到的 top-1 文档 71% 来自 gold 文章，top-10 覆盖 90%。

### 6.3 生成多样性

| Model | MS-MARCO tri-gram | Jeopardy tri-gram |
| --- | ---: | ---: |
| Gold | 89.6% | 90.0% |
| BART | 70.7% | 32.4% |
| RAG-Token | 77.8% | 46.8% |
| RAG-Sequence | 83.5% | 53.8% |

RAG（尤其 RAG-Sequence）的生成明显比 BART 更多样——**无需任何 diversity-promoting 解码技巧**。

### 6.4 语言建模能力是否受损？

| Model | WikiText PPL | CCNet PPL |
| --- | ---: | ---: |
| T5 / BART (comparable) | 基准 | 基准 |
| RAG（无 API 调用） | 不升 | 不升 |

RAG 微调**不损害**纯语言建模能力——因为检索器是加法性的，不调用时等价于原模型。

---

## 7. 消融实验

### 7.1 检索消融：学习检索 vs 冻结 vs BM25

| Model | NQ | TQA | WQ | CT | Jeopardy B-1 | MS-MARCO R-L | FVR-3 | FVR-2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RAG-Token-BM25 | 29.7 | 41.5 | 32.1 | 33.1 | 17.5 | 55.5 | 75.1 | 91.6 |
| RAG-Token-Frozen | 37.8 | 50.1 | 37.1 | 51.1 | 16.7 | 55.9 | 72.9 | 89.4 |
| **RAG-Token** | 43.5 | 54.8 | 46.5 | 51.9 | 17.9 | 56.2 | 74.5 | 90.6 |

（dev 集；BM25 = 用词频检索替换 dense 检索；Frozen = 冻结检索器只训练生成器）

- **学习检索 > 冻结检索 > BM25**（开源域 QA 上 dense 检索至关重要）。
- **例外：FEVER 上 BM25 反而最好**（FVR-3 75.1 vs dense 74.5），因为 FEVER 的 claim 高度实体中心，词频匹配恰好契合。

### 7.2 索引热替换（hot-swapping）

用 2016-12 的 Wikipedia 索引 vs 2018-12 索引，查 82 位在这期间换届的世界领导人：

| 索引 | 问题对应年份 | 正确率 |
| --- | --- | ---: |
| 2016 索引 | 2016 领导人 | 70% |
| 2018 索引 | 2018 领导人 | 68% |
| 2018 索引 | 2016 领导人 | 12% |
| 2016 索引 | 2018 领导人 | 4% |

匹配时高正确率、错配时接近随机——证明**只需换索引即可更新模型的世界知识，无需重新训练**。这是参数记忆模型（T5/BART）做不到的。

### 7.3 检索文档数 $K$ 的影响

![图3 检索文档数 K 对 NQ 与 MS-MARCO 的影响：RAG-Sequence 的 NQ 随 K 单调上升，RAG-Token 在 K=10 达峰；检索 recall 随 K 上升](/vibe-reading/images/articles/rag-retrieval-augmented-generation/fig-3-retrieved-docs-effect.png)

- 检索更多文档**单调提升** RAG-Sequence 的 NQ EM；RAG-Token 在 $K=10$ 达峰后略降。
- MS-MARCO 上，更多文档提升 R-L 但略损 B-1（RAG-Token）——更多的检索信息让回答更全面（R-L↑）但也可能引入噪声影响用词（B-1↓）。

### 7.4 文档后验：参数与非参数记忆如何协作

![图2 RAG-Token 在生成 Hemingway 的 Jeopardy 问题时各 token 的文档后验概率：生成"A Farewell to Arms"时 Doc 1 后验高，生成"The Sun Also Rises"时 Doc 2 高；首个 token 之后后验变平——参数记忆接管后续补全](/vibe-reading/images/articles/rag-retrieval-augmented-generation/fig-2-document-posterior.png)

以输入"Hemingway"生成 Jeopardy 问题为例：生成"The Sun Also Rises"时，提到该书的 Doc 2 后验最高；生成"A Farewell to Arms"时，Doc 1 主导。**但在每本书首个 token 之后，文档后验变平**——说明模型靠参数记忆补全书名，非参数检索只负责"引导出"具体知识。这是参数与非参数记忆协作的直接证据。

---

## 8. 总结与展望

### 贡献总结

RAG 是检索增强生成的奠基之作：首次把预训练的检索器与生成器缝成一个端到端、可微、隐变量 marginalize 的统一框架，证明了"知识放外部索引"这条路在通用 seq2seq 上可行且高效——6.7B 参数即可在多个知识密集任务上超过 175B 的纯参数模型，且生成更事实、更多样、可热更新、可审查。它直接定义了后来整个 RAG 范式（DPR + 生成器 + marginalize 的隐变量视角）。

### 局限性（批判性）

1. **检索是单次、不可交互的**：搜索引擎返回多条结果时，模型不能浏览、改写 query、多轮检索——复杂检索任务（如 §6.2 MS-MARCO 落后 GPT-3）受限于此。
2. **冻结文档编码器**：为省算力固定文档编码器，意味着检索器无法随任务进一步优化文档表示——后续工作（如 Atlas、RETRO）放开了这一限制。
3. **只评估了 Wikipedia 一种知识源**：未探索多源、异构、更新更频繁的知识库。
4. **RAG-Sequence 的 Thorough Decoding 开销大**：候选集 $|Y|$ 随序列变长膨胀，需多次 forward pass；Fast Decoding 的近似会损失精度。
5. **非参数记忆是"检索即用"的浅层利用**：模型只把检索文档拼到输入，不做跨文档推理、不引用具体句子。

### 未来方向（idea 三法）

- **弥补缺陷**：引入多轮交互式检索（类似 WebGPT 的浏览器），让模型能改写 query、浏览多条结果、自主决定何时停止检索；放开文档编码器联合训练，探索可微检索器的上限。
- **新型方案**：把检索的"成本"纳入 marginalize 目标（检索昂贵时少检索）；用强化学习让模型学会在检索与参数记忆间取舍；引入"检索失败"信号，让模型在检索无用时学会放弃。
- **减少约束**：去掉"每输入至多一次检索/固定 top-K"限制，让模型自主决定检索次数与 $K$；扩展到结构化知识源（SQL、KG）、多模态检索（图文混检），逼近通用 Agent 的知识访问边界。

> **回看意义**：RAG 之后，"LM + 外部检索"成了 LLM 应用的标配架构（Atlas、RETRO、各类 RAG 框架都沿此脉络）。它把"参数记忆 vs 非参数记忆"的权衡摆上台面，并用一个干净的隐变量公式给出了第一份可复现的答案——这正是它被广泛引用、成为 RAG 命名来源的原因。
