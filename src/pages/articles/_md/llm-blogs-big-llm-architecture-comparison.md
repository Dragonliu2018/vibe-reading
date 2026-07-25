---
title: "The Big LLM Architecture Comparison"
source:
  type: "article"
  project: "LLM"
  url: "https://magazine.sebastianraschka.com/p/the-big-llm-architecture-comparison"
  author: "Sebastian Raschka, PhD"
  site: "Ahead of AI（Substack）"
date: "2026-07-25"
category: [AI, Models, Blogs]
tags: ["LLM", "Architecture", "Transformer", "MoE", "Attention", "DeepSeek", "Gemma", "Qwen", "Llama", "gpt-oss"]
description: "From DeepSeek V3 to GLM-5: A Look At Modern LLM Architecture Design"
readingTime: "70 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **原文** [The Big LLM Architecture Comparison](https://magazine.sebastianraschka.com/p/the-big-llm-architecture-comparison) · **作者** Sebastian Raschka, PhD · **来源** Ahead of AI（Substack）· **原文发布** 2025-07-19 · **中英对照·AI 译** 2026-07-25
> 翻译为 AI 初稿 + 人工校对，如有出入以原文为准。

---

**Last updated: Apr 2, 2026 (added Gemma 4 in section 23)**

> **译：** 最后更新：2026 年 4 月 2 日（在第 23 节中新增了 Gemma 4）。

It has been seven years since the original GPT architecture was developed. At first glance, looking back at GPT-2 (2019) and forward to DeepSeek V3 and Llama 4 (2024-2025), one might be surprised at how structurally similar these models still are.

> **译：** 自最初的 GPT 架构问世以来已经过去七年。乍一看，回望 GPT-2（2019），再前瞻 DeepSeek V3 和 Llama 4（2024–2025），人们或许会惊讶于这些模型在结构上竟仍如此相似。

Sure, positional embeddings have evolved from absolute to rotational (RoPE), Multi-Head Attention has largely given way to Grouped-Query Attention, and the more efficient SwiGLU has replaced activation functions like GELU. But beneath these minor refinements, have we truly seen groundbreaking changes, or are we simply polishing the same architectural foundations?

> **译：** 诚然，位置编码已从绝对位置编码演进到旋转位置编码（RoPE），多头注意力（MHA）已大体让位给分组查询注意力（GQA），更高效的 SwiGLU 也取代了 GELU 等激活函数。但在这些细枝末节的改良之下，我们究竟看到了开天辟地式的变革，还是只是在打磨同一套架构地基？

Comparing LLMs to determine the key ingredients that contribute to their good (or not-so-good) performance is notoriously challenging: datasets, training techniques, and hyperparameters vary widely and are often not well documented.

> **译：** 通过对比 LLM 来判定哪些关键因素促成了它们好（或不那么好）的性能，是出了名的困难：数据集、训练技巧和超参差异巨大，且往往缺乏充分文档。

However, I think that there is still a lot of value in examining the structural changes of the architectures themselves to see what LLM developers are up to in 2025. (A subset of them are shown in Figure 1 below.)

> **译：** 不过我认为，审视架构本身的结构变化、看看 LLM 开发者在 2025 年究竟在做什么，仍大有裨益。（其中一部分如下方图 1 所示。）

![Figure 1: A subset of the architectures covered in this article.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-01-subset-architectures-covered-article.png)

So, in this article, rather than writing about benchmark performance or training algorithms, I will focus on the architectural developments that define today's flagship open models.

> **译：** 因此，本文不谈基准性能或训练算法，而是聚焦于定义当今旗舰开源模型的架构演进。

(As you may remember, [I wrote about multimodal LLMs](https://magazine.sebastianraschka.com/p/understanding-multimodal-llms) not too long ago; in this article, I will focus on the text capabilities of recent models and leave the discussion of multimodal capabilities for another time.)

> **译：**（或许你还记得，[我不久前写过关于多模态 LLM 的文章](https://magazine.sebastianraschka.com/p/understanding-multimodal-llms)；本文将聚焦近期模型的文本能力，多模态能力留待日后另起一篇讨论。）

**Tip:** This is a fairly comprehensive article, so I recommend using the navigation bar to access the table of contents (just hover over the left side of the Substack page).

> **译：** **提示：** 本文篇幅较长，建议用导航栏查看目录（把鼠标悬停在 Substack 页面左侧即可）。

---

## 1. DeepSeek V3/R1

As you have probably heard more than once by now, [DeepSeek R1](https://arxiv.org/abs/2501.12948) made a big impact when it was released in January 2025. DeepSeek R1 is a reasoning model built on top of the [DeepSeek V3 architecture](https://arxiv.org/abs/2412.19437), which was introduced in December 2024.

> **译：** 你如今大概已不止一次听说，[DeepSeek R1](https://arxiv.org/abs/2501.12948) 于 2025 年 1 月发布时造成了巨大影响。DeepSeek R1 是一个建立在 [DeepSeek V3 架构](https://arxiv.org/abs/2412.19437)（于 2024 年 12 月推出）之上的推理模型。

While my focus here is on architectures released in 2025, I think it's reasonable to include DeepSeek V3, since it only gained widespread attention and adoption following the launch of DeepSeek R1 in 2025.

> **译：** 虽然本文聚焦 2025 年发布的架构，但我认为把 DeepSeek V3 也纳入进来是合理的，毕竟它是在 2025 年 DeepSeek R1 发布之后才获得广泛关注与采用的。

If you are interested in the training of DeepSeek R1 specifically, you may also find my article from earlier this year useful: [Understanding Reasoning LLMs](https://magazine.sebastianraschka.com/p/understanding-reasoning-llms)

> **译：** 如果你对 DeepSeek R1 的训练特别感兴趣，我今年早些时候写的这篇文章或许也有用：[理解推理 LLM（Understanding Reasoning LLMs）](https://magazine.sebastianraschka.com/p/understanding-reasoning-llms)

In this section, I'll focus on two key architectural techniques introduced in DeepSeek V3 that improved its computational efficiency and distinguish it from many other LLMs:

> **译：** 本节聚焦 DeepSeek V3 引入的两项关键架构技术，它们提升了计算效率，也使 DeepSeek V3 不同于多数其他 LLM：

- Multi-Head Latent Attention (MLA)
- Mixture-of-Experts (MoE)

> **译：**
> - 多头潜在注意力（MLA）
> - 混合专家（MoE）

### 1.1 Multi-Head Latent Attention (MLA)

Before discussing Multi-Head Latent Attention (MLA), let's briefly go over some background to motivate why it's used. For that, let's start with Grouped-Query Attention (GQA), which has become the new standard replacement for a more compute- and parameter-efficient alternative to Multi-Head Attention (MHA) in recent years.

> **译：** 在讨论多头潜在注意力（MLA）之前，先简要铺垫一些背景，说明为何要使用它。为此，先从分组查询注意力（GQA）讲起——近年来它已成为替代多头注意力（MHA）的新的标准方案，在计算与参数上更高效。

So, here's a brief GQA summary. Unlike MHA, where each head also has its own set of keys and values, to reduce memory usage, GQA groups multiple heads to share the same key and value projections.

> **译：** 这里对 GQA 做个简要小结。MHA 中每个注意力头都有自己的一组键（key）和值（value）；而为降低内存占用，GQA 让多个头共享同一组键值投影。

For example, as further illustrated in Figure 2 below, if there are 2 key-value groups and 4 attention heads, then heads 1 and 2 might share one set of keys and values, while heads 3 and 4 share another. This reduces the total number of key and value computations, which leads to lower memory usage and improved efficiency (without noticeably affecting the modeling performance, according to ablation studies).

> **译：** 例如，如下方图 2 进一步所示，若有 2 个键值组和 4 个注意力头，则头 1、头 2 可共享一组键值，头 3、头 4 共享另一组。这减少了键值计算总量，从而降低内存占用、提升效率（据消融研究，对建模性能无明显影响）。

![Figure 2: A comparison between MHA and GQA. Here, the group size is 2, where a key and value pair is shared among 2 queries.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-02-comparison-between-mha-gqa-here.png)

So, the core idea behind GQA is to reduce the number of key and value heads by sharing them across multiple query heads. This (1) lowers the model's parameter count and (2) reduces the memory bandwidth usage for key and value tensors during inference since fewer keys and values need to be stored and retrieved from the KV cache.

> **译：** 因此，GQA 的核心思想是通过让多个查询头共享键值头来减少键值头数量。这既（1）降低了模型参数量，又（2）减少了推理时键值张量的内存带宽消耗——因为需要存取的 KV cache 中键值更少。

(If you are curious how GQA looks in code, see my [GPT-2 to Llama 3 conversion guide](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/07_gpt_to_llama/converting-llama2-to-llama3.ipynb) for a version without KV cache and my KV-cache variant [here](https://github.com/rasbt/LLMs-from-scratch/blob/main/pkg/llms_from_scratch/llama3.py).)

> **译：**（如果你好奇 GQA 在代码中长什么样，可参见我的 [GPT-2 到 Llama 3 转换指南](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/07_gpt_to_llama/converting-llama2-to-llama3.ipynb)（不含 KV cache 的版本），以及我的 KV cache 变体[见此](https://github.com/rasbt/LLMs-from-scratch/blob/main/pkg/llms_from_scratch/llama3.py)。）

While GQA is mainly a computational-efficiency workaround for MHA, ablation studies (such as those in the [original GQA paper](https://arxiv.org/abs/2305.13245) and the [Llama 2 paper](https://arxiv.org/abs/2307.09288)) show it performs comparably to standard MHA in terms of LLM modeling performance.

> **译：** 尽管 GQA 主要是为 MHA 做的计算效率上的折中，但消融研究（如 [GQA 原始论文](https://arxiv.org/abs/2305.13245)和 [Llama 2 论文](https://arxiv.org/abs/2307.09288)中的）表明，在 LLM 建模性能上它与标准 MHA 相当。

Now, Multi-Head Latent Attention (MLA) offers a different memory-saving strategy that also pairs particularly well with KV caching. Instead of sharing key and value heads like GQA, MLA compresses the key and value tensors into a lower-dimensional space before storing them in the KV cache.

> **译：** 而多头潜在注意力（MLA）则提供了一种不同的省内存策略，且与 KV cache 搭配尤其契合。它不像 GQA 那样共享键值头，而是在把键值张量存入 KV cache 之前先压缩到低维空间。

At inference time, these compressed tensors are projected back to their original size before being used, as shown in the Figure 3 below. This adds an extra matrix multiplication but reduces memory usage.

> **译：** 推理时，这些被压缩的张量先被投影回原始尺寸再使用，如下方图 3 所示。这多了一次矩阵乘法，但降低了内存占用。

![Figure 3: Comparison between MLA (used in DeepSeek V3 and R1) and regular MHA.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-03-comparison-between-mla-used-deepseek.png)

(As a side note, the queries are also compressed, but only during training, not inference.)

> **译：**（附带一提，查询也会被压缩，但仅在训练时如此，推理时不会。）

By the way, MLA is not new in DeepSeek V3, as its [DeepSeek-V2 predecessor](https://arxiv.org/abs/2405.04434) also used (and even introduced) it. Also, the V2 paper contains a few interesting ablation studies that may explain why the DeepSeek team chose MLA over GQA (see Figure 4 below).

> **译：** 顺带一提，MLA 在 DeepSeek V3 中并非首创——其前代 [DeepSeek-V2](https://arxiv.org/abs/2405.04434) 也使用了（甚至引入了）它。V2 论文还包含若干有趣的消融研究，或许能解释为何 DeepSeek 团队选择 MLA 而非 GQA（见下方图 4）。

![Figure 4: Annotated tables from the DeepSeek-V2 paper, https://arxiv.org/abs/2405.04434](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-04-annotated-tables-deepseek-v2-paper.png)

As shown in Figure 4 above, GQA appears to perform worse than MHA, whereas MLA offers better modeling performance than MHA, which is likely why the DeepSeek team chose MLA over GQA. (It would have been interesting to see the "KV Cache per Token" savings comparison between MLA and GQA as well!)

> **译：** 如上方图 4 所示，GQA 的表现似乎不如 MHA，而 MLA 的建模性能优于 MHA，这大概就是 DeepSeek 团队选择 MLA 而非 GQA 的原因。（若能看到 MLA 与 GQA 在「每 token 的 KV cache」节省量上的对比，那就更有意思了！）

To summarize this section before we move on to the next architecture component, MLA is a clever trick to reduce KV cache memory use while even slightly outperforming MHA in terms of modeling performance.

> **译：** 在进入下一个架构组件之前小结一下：MLA 是一个减少 KV cache 内存占用、建模性能甚至略胜 MHA 一筹的巧妙技巧。

### 1.2 Mixture-of-Experts (MoE)

The other major architectural component in DeepSeek worth highlighting is its use of Mixture-of-Experts (MoE) layers. While DeepSeek did not invent MoE, it has seen a resurgence this year, and many of the architectures we will cover later also adopt it.

> **译：** DeepSeek 中另一个值得关注的重大架构组件是混合专家（MoE）层。DeepSeek 并未发明 MoE，但今年它重新流行起来，后文将涉及的许多架构也都采用了它。

You are likely already familiar with MoE, but a quick recap may be helpful.

> **译：** 你大概已经熟悉 MoE，但快速回顾一下或许有帮助。

The core idea in MoE is to replace each FeedForward module in a transformer block with multiple expert layers, where each of these expert layers is also a FeedForward module. This means that we swap a single FeedForward block for multiple FeedForward blocks, as illustrated in the Figure 5 below.

> **译：** MoE 的核心思想是把 transformer 块中的每个前馈（FeedForward）模块替换为多个专家层，其中每个专家层本身也是一个 FeedForward 模块。也就是说，我们用一个 FeedForward 块换来了多个 FeedForward 块，如下方图 5 所示。

![Figure 5: An illustration of the Mixture-of-Experts (MoE) module in DeepSeek V3/R1 (right) compared to an LLM with a standard FeedForward block (left).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-05-illustration-mixture-experts-moe-module.png)

The FeedForward block inside a transformer block (shown as the dark gray block in the figure above) typically contains a large number of the model's total parameters. (Note that the transformer block, and thereby the FeedForward block, is repeated many times in an LLM; in the case of DeepSeek V3, 61 times.)

> **译：** transformer 块内的 FeedForward 块（即上图中的深灰色块）通常占据模型总参数的相当大一部分。（注意，transformer 块以及其中的 FeedForward 块在 LLM 中会重复多次；DeepSeek V3 中是 61 次。）

So, replacing *a single* FeedForward block with *multiple* FeedForward blocks (as done in a MoE setup) substantially increases the model's total parameter count. However, the key trick is that we don't use ("activate") all experts for every token. Instead, a router selects only a small subset of experts per token. (In the interest of time, or rather article space, I'll cover the router in more detail another time.)

> **译：** 因此，把*单个* FeedForward 块替换为*多个* FeedForward 块（如 MoE 设置那样）会大幅增加模型总参数量。但关键技巧在于：我们不会为每个 token 激活（"activate"）全部专家，而是由路由器（router）为每个 token 仅选出一小部分专家。（受篇幅所限，路由器的细节我另起一篇再讲。）

Because only a few experts are active at a time, MoE modules are often referred to as *sparse*, in contrast to *dense* modules that always use the full parameter set. However, the large total number of parameters via an MoE increases the capacity of the LLM, which means it can take up more knowledge during training. The sparsity keeps inference efficient, though, as we don't use all the parameters at the same time.

> **译：** 由于同一时刻仅有少数专家活跃，MoE 模块常被称为**稀疏**（sparse）的，与始终使用全部参数的**稠密**（dense）模块相对。但 MoE 带来的庞大参数总量提升了 LLM 的容量，意味着训练时能吸纳更多知识。而稀疏性又使推理保持高效，因为我们不会同时用到所有参数。

For example, DeepSeek V3 has 256 experts per MoE module and a total of 671 billion parameters. Yet during inference, only 9 experts are active at a time (1 shared expert plus 8 selected by the router). This means just 37 billion parameters are used per inference step as opposed to all 671 billion.

> **译：** 例如，DeepSeek V3 的每个 MoE 模块有 256 个专家，总参数量 6710 亿。但推理时每次仅有 9 个专家活跃（1 个共享专家 + 路由器选出的 8 个）。也就是说，每次推理步骤只用 370 亿参数，而非全部 6710 亿。

One notable feature of DeepSeek V3's MoE design is the use of a shared expert. This is an expert that is always active for every token. This idea is not new and was already introduced in the [DeepSeek 2024 MoE](https://arxiv.org/abs/2401.06066) and [2022 DeepSpeedMoE paper](https://arxiv.org/abs/2201.05596)s.

> **译：** DeepSeek V3 MoE 设计的一个显著特点是用到了共享专家（shared expert）——它对每个 token 都始终激活。这一想法并不新鲜，已在 [DeepSeek 2024 MoE](https://arxiv.org/abs/2401.06066) 和 [2022 年 DeepSpeedMoE 论文](https://arxiv.org/abs/2201.05596)中提出。

![Figure 6: An annotated figure from "DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models", https://arxiv.org/abs/2401.06066](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-06-annotated-figure-deepseekmoe-towards-ultimate.png)

The benefit of having a shared expert was first noted in the [DeepSpeedMoE paper](https://arxiv.org/abs/2201.05596), where they found that it boosts overall modeling performance compared to no shared experts. This is likely because common or repeated patterns don't have to be learned by multiple individual experts, which leaves them with more room for learning more specialized patterns.

> **译：** 使用共享专家的益处最早在 [DeepSpeedMoE 论文](https://arxiv.org/abs/2201.05596)中被指出：他们发现它能提升整体建模性能（相对于没有共享专家）。这很可能是因为通用或重复的模式不必由多个独立专家各自学习，从而为它们腾出更多空间去学习更专门的模式。

### 1.3 DeepSeek Summary

To summarize, DeepSeek V3 is a massive 671-billion-parameter model that, at launch, outperformed other open-weight models, including the 405B Llama 3. Despite being larger, it is much more efficient at inference time thanks to its Mixture-of-Experts (MoE) architecture, which activates only a small subset of (just 37B) parameters per token.

> **译：** 小结一下：DeepSeek V3 是一个庞大的 6710 亿参数模型，发布时性能超过了包括 405B Llama 3 在内的其他开源权重模型。尽管体量更大，得益于其混合专家（MoE）架构——每个 token 仅激活一小部分（370 亿）参数——它在推理时高效得多。

Another key distinguishing feature is DeepSeek V3's use of Multi-Head Latent Attention (MLA) instead of Grouped-Query Attention (GQA). Both MLA and GQA are inference-efficient alternatives to standard Multi-Head Attention (MHA), particularly when using KV caching. While MLA is more complex to implement, a study in the DeepSeek-V2 paper has shown it delivers better modeling performance than GQA.

> **译：** 另一个关键区别是 DeepSeek V3 使用多头潜在注意力（MLA）而非分组查询注意力（GQA）。MLA 和 GQA 都是标准多头注意力（MHA）在推理上的高效替代，尤其在使用 KV cache 时。虽然 MLA 实现更复杂，但 DeepSeek-V2 论文中的研究表明它的建模性能优于 GQA。

## 2. OLMo 2

The OLMo series of models by the non-profit Allen Institute for AI is noteworthy due to its transparency in terms of training data and code, as well as the relatively detailed technical reports.

> **译：** 非营利组织 Allen Institute for AI 推出的 OLMo 系列模型值得关注，原因在于其在训练数据和代码上的透明度，以及相对详尽的技术报告。

While you probably won’t find OLMo models at the top of any benchmark or leaderboard, they are pretty clean and, more importantly, a great blueprint for developing LLMs, thanks to their transparency.

> **译：** 虽然你大概不会在任何基准或排行榜顶端看到 OLMo 模型，但它们相当干净，更重要的是——得益于其透明度——它们是开发 LLM 的出色蓝本。

And while OLMo models are popular because of their transparency, they are not that bad either. In fact, at the time of release in January (before Llama 4, Gemma 3, and Qwen 3), [OLMo 2](https://arxiv.org/abs/2501.00656) models were sitting at the Pareto frontier of compute to performance, as shown in Figure 7 below.

> **译：** 虽然 OLMo 模型因透明度而受欢迎，但它们本身也不差。事实上，今年 1 月发布时（早于 Llama 4、Gemma 3 和 Qwen 3），[OLMo 2](https://arxiv.org/abs/2501.00656) 模型正位于「算力—性能」的帕累托前沿上，如下方图 7 所示。

![Figure 7: Modeling benchmark performance (higher is better) vs pre-training cost (FLOPs; lower is better) for different LLMs. This is an annotated figure from the OLMo 2 paper, https://arxiv.org/abs/2501.00656](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-07-modeling-benchmark-performance-higher-better.png)

As mentioned earlier in this article, I aim to focus only on the LLM architecture details (not training or data) to keep it at a manageable length. So, what were the interesting architectural design choices in OLMo2 ? It mainly comes down to normalizations: the placement of RMSNorm layers as well as the addition of a QK-norm, which I will discuss below.

> **译：** 如前文所述，为控制篇幅，我只聚焦 LLM 的架构细节（不谈训练或数据）。那么 OLMo 2 有哪些有趣的架构设计选择？主要就在于归一化：RMSNorm 层的位置，以及新增的 QK-norm，下文逐一讨论。

Another thing worth mentioning is that OLMo 2 still uses traditional Multi-Head Attention (MHA) instead of MLA or GQA.

> **译：** 还有一点值得一提：OLMo 2 仍使用传统的多头注意力（MHA），而非 MLA 或 GQA。

### 2.1 Normalization Layer Placement

Overall, OLMo 2 largely follows the architecture of the original GPT model,  similar to other contemporary LLMs. However, there are some noteworthy deviations. Let's start with the normalization layers.

> **译：** 总体而言，OLMo 2 大体沿用原始 GPT 模型的架构，与其他当代 LLM 类似。但也有一些值得注意的偏差。先从归一化层讲起。

Similar to Llama, Gemma, and most other LLMs, OLMo 2 switched from LayerNorm to RMSNorm.

> **译：** 与 Llama、Gemma 及多数其他 LLM 一样，OLMo 2 从 LayerNorm 改用 RMSNorm。

But since RMSNorm is old hat (it's basically a simplified version of LayerNorm with fewer trainable parameters), I will skip the discussion of RMSNorm vs LayerNorm. (Curious readers can find an RMSNorm code implementation in my [GPT-2 to Llama conversion guide](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/07_gpt_to_llama/converting-gpt-to-llama2.ipynb).)

> **译：** 不过 RMSNorm 已是老生常谈（它本质上是 LayerNorm 的简化版，可训练参数更少），故跳过 RMSNorm 与 LayerNorm 的讨论。（感兴趣的读者可在我的 [GPT-2 到 Llama 转换指南](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/07_gpt_to_llama/converting-gpt-to-llama2.ipynb)中找到 RMSNorm 的代码实现。）

However, it's worth discussing the placement of the RMSNorm layer. The original transformer (from the "[Attention is all you need](https://arxiv.org/abs/1706.03762)" paper) placed the two normalization layers in the transformer block *after* the attention module and the FeedForward module, respectively.

> **译：** 但 RMSNorm 层的位置值得讨论。原始 transformer（出自 "[Attention is all you need](https://arxiv.org/abs/1706.03762)" 论文）把两个归一化层分别置于 transformer 块中注意力模块和 FeedForward 模块之*后*。

This is also known as Post-LN or Post-Norm.

> **译：** 这也被称为 Post-LN 或 Post-Norm。

GPT and most other LLMs that came after placed the normalization layers *before* the attention and FeedForward modules, which is known as Pre-LN or Pre-Norm. A comparison between Post- and Pre-Norm is shown in the figure below.

> **译：** GPT 及其后的多数 LLM 把归一化层放在注意力与 FeedForward 模块之*前*，即 Pre-LN 或 Pre-Norm。Post-Norm 与 Pre-Norm 的对比如下图所示。

![Figure 8: A comparison of Post-Norm, Pre-Norm, and OLMo 2's flavor of Post-Norm.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-08-comparison-post-norm-pre-norm.png)

In [2020, Xiong et al.](https://arxiv.org/abs/2002.04745) showed that Pre-LN results in more well-behaved gradients at initialization. Furthermore, the researchers mentioned that Pre-LN even works well without careful learning rate warm-up, which is otherwise a crucial tool for Post-LN.

> **译：** [2020 年 Xiong 等人](https://arxiv.org/abs/2002.04745)指出，Pre-LN 在初始化时梯度表现更良好。研究者还提到，Pre-LN 即便不仔细做学习率预热（warm-up）也能奏效，而这正是 Post-LN 否则不可或缺的关键手段。

Now, the reason I am mentioning that is that OLMo 2 adopted a form of Post-LN (but with RMSNorm instead of LayerNorm, so I am calling it *Post-Norm*).

> **译：** 我之所以提这些，是因为 OLMo 2 采用了一种 Post-LN 形式（但用 RMSNorm 替代了 LayerNorm，因此我称之为 *Post-Norm*）。

In OLMo 2, instead of placing the normalization layers before the attention and FeedForward layers, they place them after, as shown in the figure above. However, notice that in contrast to the original transformer architecture, the normalization layers are still inside the residual layers (skip connections).

> **译：** 在 OLMo 2 中，归一化层并非放在注意力与 FeedForward 层之前，而是放在之后，如上图所示。但要注意，与原始 transformer 架构不同的是，归一化层仍位于残差连接（skip connection）内部。

So, why did they move the position of the normalization layers? The reason is that it helped with training stability, as shown in the figure below.

> **译：** 那么他们为何移动归一化层的位置？原因是有助于训练稳定性，如下图所示。

![Figure 9: A plot showing the training stability for Pre-Norm (like in GPT-2, Llama 3, and many others) versus OLMo 2's flavor of Post-Norm. This is an annotated figure from the OLMo 2 paper, https://arxiv.org/abs/2501.00656](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-09-plot-showing-training-stability-pre.png)

Unfortunately this figure shows the results of the reordering together with QK-Norm, which is a separate concept. So, it’s hard to tell how much the normalization layer reordering contributed by itself.

> **译：** 遗憾的是，这张图展示的是重排序与 QK-Norm 合在一起的结果，而 QK-Norm 是一个独立的概念。因此很难判断归一化层重排序本身贡献了多少。

### 2.2 QK-Norm

Since the previous section already mentioned the QK-norm, and other LLMs we discuss later, such as Gemma 2 and Gemma 3, also use QK-norm, let's briefly discuss what this is.

> **译：** 既然上一节已提到 QK-norm，且后文将讨论的 Gemma 2、Gemma 3 等也使用 QK-norm，这里简要讨论一下它是什么。

QK-Norm is essentially yet another RMSNorm layer. It's placed inside the Multi-Head Attention (MHA) module and applied to the queries (q) and keys (k) before applying RoPE. To illustrate this, below is an excerpt of a Grouped-Query Attention (GQA) layer I wrote for my [Qwen3 from-scratch implementation](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch05/11_qwen3) (the QK-norm application in GQA is similar to MHA in OLMo):

> **译：** QK-Norm 本质上又是一个 RMSNorm 层，位于多头注意力（MHA）模块内部，在施加 RoPE 之前作用于查询（q）和键（k）。为说明这点，下方是我为 [Qwen3 从零实现](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch05/11_qwen3)所写的分组查询注意力（GQA）层的一段节选（GQA 中的 QK-norm 用法与 OLMo 中 MHA 的类似）：

```python title="GroupedQueryAttention 节选"
class GroupedQueryAttention(nn.Module):
    def __init__(
        self, d_in, num_heads, num_kv_groups,
        head_dim=None, qk_norm=False, dtype=None
    ):
        # ...

        if qk_norm:
            self.q_norm = RMSNorm(head_dim, eps=1e-6)
            self.k_norm = RMSNorm(head_dim, eps=1e-6)
        else:
            self.q_norm = self.k_norm = None

    def forward(self, x, mask, cos, sin):
        b, num_tokens, _ = x.shape

        # Apply projections
        queries = self.W_query(x) 
        keys = self.W_key(x)
        values = self.W_value(x) 

        # ...

        # Optional normalization
        if self.q_norm:
            queries = self.q_norm(queries)
        if self.k_norm:
            keys = self.k_norm(keys)

        # Apply RoPE
        queries = apply_rope(queries, cos, sin)
        keys = apply_rope(keys, cos, sin)

        # Expand K and V to match number of heads
        keys = keys.repeat_interleave(self.group_size, dim=1)
        values = values.repeat_interleave(self.group_size, dim=1)

        # Attention
        attn_scores = queries @ keys.transpose(2, 3)
        # ...
```

As mentioned earlier, together with Post-Norm, QK-Norm stabilizes the training. Note that QK-Norm was not invented by OLMo 2 but goes back to the [2023 Scaling Vision Transformers paper](https://arxiv.org/abs/2302.05442).

> **译：** 如前所述，QK-Norm 与 Post-Norm 共同稳定了训练。注意 QK-Norm 并非 OLMo 2 发明，可追溯至 [2023 年的 Scaling Vision Transformers 论文](https://arxiv.org/abs/2302.05442)。

### 2.3 OLMo 2 Summary

In short, the noteworthy OLMo 2 architecture design decisions are primarily the RMSNorm placements: RMSNorm after instead of before the attention and FeedForward modules (a flavor of Post-Norm), as well as the addition of RMSNorm for the queries and keys inside the attention mechanism (QK-Norm), which both, together, help stabilize the training loss.

> **译：** 简言之，OLMo 2 值得关注的架构设计决策主要在于 RMSNorm 的位置：把 RMSNorm 放在注意力和 FeedForward 模块之*后*而非之前（一种 Post-Norm），以及在注意力机制内部为查询和键新增 RMSNorm（QK-Norm）——两者共同帮助稳定训练损失。

Below is a figure that further compares OLMo 2 to Llama 3 side by side; as one can see, the architectures are otherwise relatively similar except for the fact that OLMo 2 still uses the traditional MHA instead of GQA. (However, the [OLMo 2 team released a 32B variant](https://huggingface.co/allenai/OLMo-2-0325-32B-Instruct) 3 months later that uses GQA.)

> **译：** 下图进一步把 OLMo 2 与 Llama 3 并排对比；可以看出，除了 OLMo 2 仍用传统 MHA 而非 GQA 之外，两者架构其余部分相对接近。（不过 [OLMo 2 团队 3 个月后发布了一个 32B 变体](https://huggingface.co/allenai/OLMo-2-0325-32B-Instruct)，该变体使用了 GQA。）

![Figure 10: An architecture comparison between Llama 3 and OLMo 2.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-10-architecture-comparison-between-llama-3.png)

## 3. Gemma 3

Google's Gemma models have always been really good, and I think they have always been a bit underhyped compared to other popular models, like the Llama series.

> **译：** Google 的 Gemma 模型一直相当不错，而且我认为相比 Llama 系列等其他热门模型，它一直被有些低估。

One of the distinguishing aspects of Gemma is the rather large vocabulary size (to support multiple languages better), and the stronger focus on the 27B size (versus 8B or 70B). But note that Gemma 2 also comes in smaller sizes: 1B, 4B, and 12B.

> **译：** Gemma 的一个显著特点是相当大的词表规模（以更好地支持多语言），以及更侧重 27B 这一档（相对于 8B 或 70B）。但注意 Gemma 2 也有更小的尺寸：1B、4B 和 12B。

The 27B size hits a really nice sweet spot: it's much more capable than an 8B model but not as resource-intensive as a 70B model, and it runs just fine locally on my Mac Mini.

> **译：** 27B 这一档恰到好处地踩在甜点上：比 8B 模型能力强得多，又不像 70B 那样吃资源，在我的 Mac Mini 上本地运行毫无压力。

So, what else is interesting in [Gemma 3](https://arxiv.org/abs/2503.19786)? As discussed earlier, other models like Deepseek V3/R1 use a Mixture-of-Experts (MoE) architecture to reduce memory requirements at inference, given a fixed model size. (The MoE approach is also used by several other models we will discuss later.)

> **译：** 那么 [Gemma 3](https://arxiv.org/abs/2503.19786) 还有什么有趣之处？如前所述，DeepSeek V3/R1 等模型用混合专家（MoE）架构来在给定模型尺寸下降低推理时的内存需求。（MoE 方案也被后文将讨论的其他若干模型采用。）

Gemma 3 uses a different "trick" to reduce computational costs, namely sliding window attention.

> **译：** Gemma 3 用了另一种「技巧」来降低计算开销，即滑动窗口注意力。

### 3.1 Sliding Window Attention

With sliding window attention (originally introduced in the [LongFormer paper in 2020](https://arxiv.org/abs/2004.05150) and also already used by [Gemma 2](http://arxiv.org/abs/2408.00118)), the Gemma 3 team was able to reduce the memory requirements in the KV cache by a substantial amount, as shown in the figure below.

> **译：** 借助滑动窗口注意力（最早在 [2020 年 LongFormer 论文](https://arxiv.org/abs/2004.05150)中提出，[Gemma 2](http://arxiv.org/abs/2408.00118) 也已使用），Gemma 3 团队得以大幅降低 KV cache 的内存需求，如下图所示。

![Figure 11: An annotated figure from Gemma 3 paper (https://arxiv.org/abs/2503.19786) showing the KV cache memory savings via sliding window attention.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-11-annotated-figure-gemma-3-paper.png)

So, what is sliding window attention? If we think of regular self-attention as a *global* attention mechanism, since each sequence element can access every other sequence element, then we can think of sliding window attention as *local* attention, because here we restrict the context size around the current query position. This is illustrated in the figure below.

> **译：** 那么什么是滑动窗口注意力？若把常规自注意力视为一种*全局*注意力机制（因为每个序列元素都能访问其他所有元素），那便可把滑动窗口注意力视为*局部*注意力，因为这里我们把上下文范围限制在当前查询位置周围。如下图所示。

![Figure 12: A comparison between regular attention (left) and sliding window attention (right).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-12-comparison-between-regular-attention-left.png)

Please note that sliding window attention can be used with both Multi-Head Attention and Grouped-Query Attention; Gemma 3 uses grouped-query attention.

> **译：** 请注意，滑动窗口注意力既可与多头注意力、也可与分组查询注意力搭配使用；Gemma 3 使用的是分组查询注意力。

As mentioned above, sliding window attention is also referred to as *local* attention because the local window surrounds and moves with the current query position. In contrast, regular attention is *global* as each token can access all other tokens.

> **译：** 如上所述，滑动窗口注意力也被称为*局部*注意力，因为局部窗口环绕并跟随当前查询位置移动。相对地，常规注意力是*全局*的，每个 token 都能访问所有其他 token。

Now, as briefly mentioned above, the Gemma 2 predecessor architecture also used sliding window attention before. The difference in Gemma 3 is that they adjusted the ratio between global (regular) and local (sliding) attention.

> **译：** 如前文简要提及，前代 Gemma 2 架构此前也用过滑动窗口注意力。Gemma 3 的不同在于调整了全局（常规）与局部（滑动）注意力的比例。

For instance, Gemma 2 uses a hybrid attention mechanism that combines sliding window (local) and global attention in a 1:1 ratio. Each token can attend to a 4k-token window of nearby context.

> **译：** 例如，Gemma 2 用一种混合注意力机制，以 1:1 的比例组合滑动窗口（局部）与全局注意力。每个 token 可关注到 4k token 的邻近上下文窗口。

Where Gemma 2 used sliding window attention in every other layer, Gemma 3 now has a 5:1 ratio, meaning there's only 1 full attention layer for every 5 sliding windows (local) attention layers; moreover, the sliding window size was reduced from 4096 (Gemma 2) to just 1024 (Gemma 3). This shifts the model's focus towards more efficient, localized computations.

> **译：** Gemma 2 是隔层使用滑动窗口注意力，而 Gemma 3 的比例变为 5:1——即每 5 个滑动窗口（局部）注意力层才有 1 个全局注意力层；此外，滑动窗口大小从 Gemma 2 的 4096 缩小到 Gemma 3 的仅 1024。这将模型的关注点转向更高效的局部化计算。

According to their ablation study, the use of sliding window attention has minimal impact on modeling performance, as shown in the figure below.

> **译：** 据其消融研究，使用滑动窗口注意力对建模性能的影响微乎其微，如下图所示。

![Figure 13: An annotated figure from Gemma 3 paper (https://arxiv.org/abs/2503.19786) showing that sliding window attention has little to no impact on the LLM-generated output perplexity.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-13-annotated-figure-gemma-3-paper.png)

While sliding window attention is the most notable architecture aspect of Gemma 3, I want to also briefly go over the placement of the normalization layers as a follow-up to the previous OLMo 2 section.

> **译：** 滑动窗口注意力虽是 Gemma 3 最显著的架构特征，但作为对上一节 OLMo 2 的延续，我也想简要谈谈归一化层的位置。

### 3.2 Normalization Layer Placement in Gemma 3

A small but interesting tidbit to highlight is that Gemma 3 uses RMSNorm in both a Pre-Norm and Post-Norm setting around its grouped-query attention module.

> **译：** 一个小却有趣的细节：Gemma 3 在其分组查询注意力模块周围同时使用了 Pre-Norm 和 Post-Norm 两种 RMSNorm 设置。

This is similar to Gemma 2 but still worth highlighting, as it differs from (1) the Post-Norm used in the original transformer (“Attention is all you need”), (2) the Pre-Norm, which was popularized by GPT-2 and used in many other architectures afterwards, and (3) the Post-Norm flavor in OLMo 2 that we saw earlier.

> **译：** 这与 Gemma 2 类似，但仍值得强调，因为它不同于：（1）原始 transformer（「Attention is all you need」）使用的 Post-Norm；（2）由 GPT-2 推广、其后被许多架构采用的 Pre-Norm；（3）我们前文看到的 OLMo 2 那种 Post-Norm 变体。

![Figure 14: An architecture comparison between OLMo2 and Gemma 3; note the additional normalization layers in Gemma 3.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-14-architecture-comparison-between-olmo2-gemma.png)

I think this normalization layer placement is a relatively intuitive approach as it gets the best of both worlds: Pre-Norm and Post-Norm. In my opinion, a bit of extra normalization can't hurt. In the worst case, if the extra normalization is redundant, this adds a bit of inefficiency through redundancy. In practice, since RMSNorm is relatively cheap in the grand scheme of things, this shouldn't have any noticeable impact, though.

> **译：** 我认为这种归一化层布局相当直观，可谓兼得 Pre-Norm 与 Post-Norm 之长。在我看来，多加一点归一化并无坏处；最坏情况下，若多出的归一化是冗余的，也只是因冗余带来少许低效。而实践中，从整体看 RMSNorm 相当廉价，因此不会有明显影响。

### 3.3 Gemma 3 Summary

Gemma 3 is a well-performing open-weight LLM that, in my opinion, is a bit underappreciated in the open-source circles. The most interesting part is the use of sliding window attention to improve efficiency (it will be interesting to combine it with MoE in the future).

> **译：** Gemma 3 是一个性能出色的开源权重 LLM，在我看来在开源圈子里被有些低估。最有趣的部分是用滑动窗口注意力来提升效率（将来把它与 MoE 结合会很有看点）。

Also, Gemma 3 has a unique normalization layer placement, placing RMSNorm layers both before and after the attention and FeedForward modules.

> **译：** 此外，Gemma 3 的归一化层位置很独特：在注意力和 FeedForward 模块前后都放置 RMSNorm 层。

### 3.4 Bonus: Gemma 3n

A few months after the Gemma 3 release, Google shared [Gemma 3n](https://developers.googleblog.com/en/introducing-gemma-3n/), which is a Gemma 3 model that has been optimized for small-device efficiency with the goal of running on phones.

> **译：** Gemma 3 发布数月后，Google 推出了 [Gemma 3n](https://developers.googleblog.com/en/introducing-gemma-3n/)——一个为小型设备效率而优化的 Gemma 3 模型，目标是能在手机上运行。

One of the changes in Gemma 3n to achieve better efficiency is the so-called Per-Layer Embedding (PLE) parameters layer. The key idea here is to keep only a subset of the model's parameters in GPU memory. Token-layer specific embeddings, such as those for text, audio, and vision modalities, are then streamed from the CPU or SSD on demand.

> **译：** Gemma 3n 为提升效率所做的改动之一，是所谓逐层嵌入（Per-Layer Embedding，PLE）参数层。其核心思想是只把模型参数的一部分保留在 GPU 内存中；针对 token 层的特定嵌入（如文本、音频、视觉模态的嵌入）则按需从 CPU 或 SSD 流式加载。

The figure below illustrates the PLE memory savings, listing 5.44 billion parameters for a standard Gemma 3 model. This likely refers to the Gemma 3 4-billion variant.

> **译：** 下图展示了 PLE 的内存节省，列出一个标准 Gemma 3 模型有 54.4 亿参数。这很可能指的是 Gemma 3 的 40 亿参数变体。

![Figure 15: An annotated figure from Google's Gemma 3n blog (https://developers.googleblog.com/en/introducing-gemma-3n/) illustrating the PLE memory savings.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-15-annotated-figure-google-s-gemma.png)

The 5.44 vs. 4 billion parameter discrepancy is because Google has an interesting way of reporting parameter counts in LLMs. They often exclude embedding parameters to make the model appear smaller, except in cases like this, where it is convenient to include them to make the model appear larger. This is not unique to Google, as this approach has become a common practice across the field.

> **译：** 54.4 亿与 40 亿参数的差异，源于 Google 报告 LLM 参数量的一种有趣做法：他们常常把嵌入参数排除在外，让模型显得更小；但像这种场景下，又方便地把它们算进去让模型显得更大。这并非 Google 独有，此种做法已成为整个领域的惯例。

Another interesting trick is the [MatFormer](https://arxiv.org/abs/2310.07707) concept (short for Matryoshka Transformer). For instance, Gemma 3n uses a single shared LLM (transformer) architecture that can be sliced into smaller, independently usable models. Each slice is trained to function on its own, so at inference time, we can run just the part you need (instead of the large model).

> **译：** 另一个有趣的技巧是 [MatFormer](https://arxiv.org/abs/2310.07707) 概念（Matryoshka Transformer 的缩写）。例如，Gemma 3n 采用单一共享的 LLM（transformer）架构，可被切片成更小、可独立使用的模型。每个切片都被训练得能独立运作，因此推理时我们可以只运行所需的那一部分（而非整个大模型）。

## 4. Mistral Small 3.1

[Mistral Small 3.1 24B](https://mistral.ai/news/mistral-small-3-1), which was released in March shortly after Gemma 3, is noteworthy for outperforming Gemma 3 27B on several benchmarks (except for math) while being faster.

> **译：** [Mistral Small 3.1 24B](https://mistral.ai/news/mistral-small-3-1) 于 3 月紧随 Gemma 3 之后发布，其亮点在于：在多个基准上（数学除外）超过了 Gemma 3 27B，同时更快。

The reasons for the lower inference latency of Mistral Small 3.1 over Gemma 3 are likely due to their custom tokenizer, as well as shrinking the KV cache and layer count. Otherwise, it's a standard architecture as shown in the figure below.

> **译：** Mistral Small 3.1 推理延迟低于 Gemma 3 的原因，可能在于其自定义 tokenizer、以及缩小了 KV cache 和层数。除此之外就是标准架构，如下图所示。

![Figure 16: An architecture comparison between Gemma 3 27B and Mistral 3.1 Small 24B.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-16-architecture-comparison-between-gemma-3.png)

Interestingly, earlier Mistral models had utilized sliding window attention, but they appear to have abandoned it in Mistral Small 3.1 if we consider the default setting (`“sliding_window”: null`) in the official [Model Hub configuration file](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/blob/main/config.json). Also, the [model card](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503) makes no mention of it.

> **译：** 有趣的是，早期的 Mistral 模型曾使用滑动窗口注意力，但 Mistral Small 3.1 似乎弃用了它——若看官方 [Model Hub 配置文件](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/blob/main/config.json)的默认设置（`"sliding_window": null`）。而且其 [model card](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503) 也未提及。

So, since Mistral uses regular Grouped-Query Attention instead of Grouped-Query Attention with a sliding window as in Gemma 3, maybe there are additional inference compute savings due to being able to use more optimized code (i.e., FlashAttention). For instance, I speculate that while sliding window attention reduces memory usage, it doesn't necessarily reduce inference latency, which is what Mistral Small 3.1 is focused on.

> **译：** 因此，既然 Mistral 用的是常规分组查询注意力，而非 Gemma 3 那样带滑动窗口的分组查询注意力，或许是因为能用更优化的代码（如 FlashAttention）从而额外省下推理计算开销。例如，我推测：滑动窗口注意力虽能降低内存占用，却未必降低推理延迟——而这正是 Mistral Small 3.1 所聚焦的。

## 5. Llama 4

The extensive introductory discussion on Mixture-of-Experts (MoE) earlier in this article pays off again. [Llama 4](https://ai.meta.com/blog/llama-4-multimodal-intelligence/) has also adopted an MoE approach and otherwise follows a relatively standard architecture that is very similar to DeepSeek V3, as shown in the figure below. (Llama 4 includes native multimodal support, similar to models like Gemma and Mistral. However, since this article focuses on language modeling, we only focus on the text model.)

> **译：** 本文前面关于混合专家（MoE）的长篇铺垫再次派上用场。[Llama 4](https://ai.meta.com/blog/llama-4-multimodal-intelligence/) 也采用了 MoE 方案，其余部分遵循一个相对标准、与 DeepSeek V3 非常相似的架构，如下图所示。（Llama 4 像 Gemma、Mistral 等模型一样包含原生多模态支持。但本文聚焦语言建模，故只关注文本模型。）

![Figure 17: An architecture comparison between DeepSeek V3 (671-billion parameters) and Llama 4 Maverick (400-billion parameters).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-17-architecture-comparison-between-deepseek-v3.png)

While the Llama 4 Maverick architecture looks very similar to DeepSeek V3 overall, there are some interesting differences worth highlighting.

> **译：** 虽然 Llama 4 Maverick 架构整体看来与 DeepSeek V3 非常相似，但也有一些值得关注的有趣差异。

First, Llama 4 uses Grouped-Query Attention similar to its predecessors, whereas DeepSeek V3 uses Multi-Head Latent Attention, which we discussed at the beginning of this article. Now, both DeepSeek V3 and Llama 4 Maverick are very large architectures, with DeepSeek V3 being approximately 68% larger in its total parameter count. However, with 37 billion active parameters, DeepSeek V3 has more than twice as many active parameters as Llama 4 Maverick (17B).

> **译：** 首先，Llama 4 与其前代一样使用分组查询注意力，而 DeepSeek V3 使用的是本文开头讨论过的多头潜在注意力。两者都是非常大的架构，DeepSeek V3 的总参数量约大 68%。但 DeepSeek V3 有 370 亿活跃参数，是 Llama 4 Maverick（170 亿）的两倍多。

Llama 4 Maverick uses a more classic MoE setup with fewer but larger experts (2 active experts with 8,192 hidden size each) compared to DeepSeek V3 (9 active experts with 2,048 hidden size each). Also, DeepSeek uses MoE layers in each transformer block (except the first 3), whereas Llama 4 alternates MoE and dense modules in every other transformer block.

> **译：** Llama 4 Maverick 用的是更经典的 MoE 设置：更少但更大的专家（2 个活跃专家，每个隐藏维度 8192），而 DeepSeek V3 是 9 个活跃专家、每个隐藏维度 2048。此外，DeepSeek 在每个 transformer 块（前 3 个除外）都用 MoE 层，而 Llama 4 是隔块交替使用 MoE 与稠密模块。

Given the many small differences between architectures, it is difficult to determine their exact impact on final model performance. The main takeaway, however, is that MoE architectures have seen a significant rise in popularity in 2025.

> **译：** 鉴于架构间存在诸多细小差异，很难判定它们对最终模型性能的确切影响。但主要结论是：MoE 架构在 2025 年显著流行起来。

## 6. Qwen3

The Qwen team consistently delivers high-quality open-weight LLMs. When I helped co-advising the LLM efficiency challenge at NeurIPS 2023, I remember that the top winning solutions were all Qwen2-based.

> **译：** Qwen 团队持续产出高质量的开源权重 LLM。当年我协助指导 NeurIPS 2023 的 LLM 效率挑战赛时，我记得排名前列的获奖方案全都是基于 Qwen2 的。

Now, Qwen3 is another hit model series at the top of the leaderboards for their size classes. There are 7 dense models: 0.6B, 1.7B, 4B, 8B, 14B, and 32B. And there are 2 MoE models: 30B-A3B, and 235B-A22B.

> **译：** 如今 Qwen3 又是一个在各尺寸档排行榜顶端的热门模型系列。有 7 个稠密模型：0.6B、1.7B、4B、8B、14B、32B。以及 2 个 MoE 模型：30B-A3B 和 235B-A22B。

(By the way, note that the missing whitespace in "Qwen3" is not a typo; I simply try to preserve the original spelling the Qwen developers chose.)

> **译：**（附带一提，"Qwen3" 里没有空格并非笔误；我只是尽量保留 Qwen 开发者所选的原始拼写。）

### 6.1 Qwen3 (Dense)

Let's discuss the dense model architecture first. As of this writing, the 0.6B model may well be the smallest current-generation open-weight model out there. And based on my personal experience, it performs really well given its small size. It has great token/sec throughput and a low memory footprint if you are planning to run it locally. But what's more, it's also easy to train locally (for educational purposes) due to its small size.

> **译：** 先讲稠密模型架构。截至写作时，0.6B 模型大概是当前世代最小的开源权重模型。就我个人体验，以如此小的体量而言它性能相当好。若打算本地运行，它 token/秒吞吐出色、内存占用低。更妙的是，因体量小，本地训练（出于学习目的）也很容易。

So, Qwen3 0.6B has replaced Llama 3 1B for me for most purposes. A comparison between these two architectures is shown below.

> **译：** 因此，对多数用途而言，Qwen3 0.6B 已替代了 Llama 3 1B。下方是这两种架构的对比。

![Figure 18: An architecture comparison between Qwen3 0.6B and Llama 3 1B; notice that Qwen3 is a deeper architecture with more layers, whereas Llama 3 is a wider architecture with more attention heads.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-18-architecture-comparison-between-qwen3-0.png)

If you are interested in a human-readable Qwen3 implementation without external third-party LLM library dependencies, I recently implemented [Qwen3 from scratch (in pure PyTorch)](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch05/11_qwen3).

> **译：** 如果你对一份不依赖第三方 LLM 库、人类可读的 Qwen3 实现感兴趣，我最近写了[从零实现的 Qwen3（纯 PyTorch）](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch05/11_qwen3)。

The computational performance numbers in the figure above are based on my from-scratch PyTorch implementations when run on an A100 GPU. As one can see, Qwen3 has a smaller memory footprint as it is a smaller architecture overall, but also uses smaller hidden layers and fewer attention heads. However, it uses more transformer blocks than Llama 3, which leads to a slower runtime (lower tokens/sec generation speed).

> **译：** 上图中的计算性能数据，基于我从零实现的 PyTorch 版本在 A100 GPU 上的运行。可以看出，Qwen3 整体架构更小、隐藏层更小、注意力头更少，因此内存占用更小。但它比 Llama 3 用了更多 transformer 块，导致运行更慢（生成速度 token/秒 更低）。

### 6.2 Qwen3 (MoE)

As mentioned earlier, Qwen3 also comes in two MoE flavors: 30B-A3B and 235B-A22B. Why do some architectures, like Qwen3, come as regular (dense) and MoE (sparse) variants?

> **译：** 如前所述，Qwen3 也有两个 MoE 版本：30B-A3B 和 235B-A22B。为什么像 Qwen3 这样的架构要同时提供常规（稠密）与 MoE（稀疏）变体？

As mentioned at the beginning of this article, MoE variants help reduce inference costs for large base models. Offering both dense and MoE versions gives users flexibility depending on their goals and constraints.

> **译：** 如本文开头所述，MoE 变体有助于降低大型基座模型的推理成本。同时提供稠密与 MoE 两个版本，让用户能根据自身目标和约束灵活选择。

Dense models are typically more straightforward to fine-tune, deploy, and optimize across various hardware.

> **译：** 稠密模型通常更易于在各种硬件上微调、部署和优化。

On the other hand, MoE models are optimized for scaling inference. For instance, at a fixed inference budget, they can achieve a higher overall model capacity (i.e., knowledge uptake during training due to being larger) without proportionally increasing inference costs.

> **译：** 另一方面，MoE 模型为规模化推理而优化。例如，在固定推理预算下，它们能取得更高的整体模型容量（即因体量更大而训练时吸纳更多知识），而推理成本不必成比例增加。

By releasing both types, the Qwen3 series can support a broader range of use cases: dense models for robustness, simplicity, and fine-tuning, and MoE models for efficient serving at scale.

> **译：** 通过同时发布两类模型，Qwen3 系列可覆盖更广的用例：稠密模型面向稳健、简洁和微调，MoE 模型面向大规模高效服务。

To round up this section, let's look at Qwen3 235B-A22B (note that the A22B stands for "22B active parameters) to DeepSeek V3, which has almost twice as many active parameters (37B).

> **译：** 收尾本节，来看看 Qwen3 235B-A22B（注意 A22B 表示「220 亿活跃参数」）与 DeepSeek V3 的对比，后者的活跃参数几乎是前者的两倍（370 亿）。

![Figure 19: An architecture comparison between DeepSeek V3 and Qwen3 235B-A22B.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-19-architecture-comparison-between-deepseek-v3.png)

As shown in the figure above, the DeepSeek V3 and Qwen3 235B-A22B architectures are remarkably similar. What's noteworthy, though, is that the Qwen3 model moved away from using a shared expert (earlier Qwen models, such as [Qwen2.5-MoE](https://qwenlm.github.io/blog/qwen2.5-max/) did use a shared expert).

> **译：** 如上图所示，DeepSeek V3 与 Qwen3 235B-A22B 架构惊人地相似。但值得注意的是，Qwen3 模型放弃了使用共享专家（更早的 Qwen 模型如 [Qwen2.5-MoE](https://qwenlm.github.io/blog/qwen2.5-max/) 是用共享专家的）。

Unfortunately, the Qwen3 team did not disclose any reason as to why they moved away from shared experts. If I had to guess, it was perhaps simply not necessary for training stability for their setup when they increased the experts from 2 (in Qwen2.5-MoE) to 8 (in Qwen3). And then they were able to save the extra compute/memory cost by using only 8 instead of 8+1 experts. (However, this doesn't explain why DeepSeek V3 is still keeping their shared expert.)

> **译：** 遗憾的是，Qwen3 团队并未公开放弃共享专家的原因。若要我猜，或许是在他们的设置下，当专家数从 Qwen2.5-MoE 的 2 个增加到 Qwen3 的 8 个后，对训练稳定性而言共享专家已无必要。于是他们能用 8 个而非 8+1 个专家来省下额外的计算/内存开销。（但这并不能解释为何 DeepSeek V3 仍保留共享专家。）

**Update.** [Junyang Lin](https://x.com/JustinLin610/status/1947364862184853626), one of the developers of Qwen3, responded as follows:

> **译：** **更新。** Qwen3 的开发者之一 [Junyang Lin](https://x.com/JustinLin610/status/1947364862184853626) 如此回复：

> At that moment we did not find significant enough improvement on shared expert and we were worrying about the optimization for inference caused by shared expert. No straight answer to this question honestly.

> **译：** 那时我们没发现共享专家带来足够显著的提升，而且我们担心共享专家给推理优化带来的麻烦。说实话，这个问题没有直截了当的答案。

## 7. SmolLM3

[SmolLM3](https://huggingface.co/blog/smollm3) is perhaps not as nearly as popular as the other LLMs covered in this article, but I thought it is still an interesting model to include as it offers really good modeling performance at a relatively small and convenient 3-billion parameter model size that sits between the 1.7B and 4B Qwen3 model, as shown in the figure below.

> **译：** [SmolLM3](https://huggingface.co/blog/smollm3) 大概不像本文涵盖的其他 LLM 那么出名，但我仍认为它值得纳入，因为它在相对小而便利的 30 亿参数体量上提供了相当好的建模性能——介于 Qwen3 的 1.7B 和 4B 之间，如下图所示。

Moreover, it also shared a lot of the training details, similar to OLMo, which is rare and always appreciated!

> **译：** 此外，它也像 OLMo 一样公开了大量训练细节，这很罕见，也总是令人 appreciated！

![Figure 20: An annotated figure from the SmolLM3 announcement post, https://huggingface.co/blog/smollm3, comparing the SmolLM3 win rate to Qwen3 1.7B and 4B as well as Llama 3 3B and Gemma 3 4B.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-20-annotated-figure-smollm3-announcement-post.png)

As shown in the architecture comparison figure below, the SmolLM3 architecture looks fairly standard. The perhaps most interesting aspect is its use of NoPE (No Positional Embeddings), though.

> **译：** 如下方架构对比图所示，SmolLM3 架构看起来相当标准。不过或许最有趣的一点是它使用了 NoPE（无位置编码）。

![Figure 21: A side-by-side architecture comparison between Qwen3 4B and SmolLM3 3B.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-21-side-side-architecture-comparison-between.png)

### 7.1 No Positional Embeddings (NoPE)

NoPE is, in LLM contexts, an older idea that goes back to a 2023 paper ([The Impact of Positional Encoding on Length Generalization in Transformers](https://arxiv.org/abs/2305.19466)) to remove explicit positional information injection (like through classic absolute positional embedding layers in early GPT architectures or nowadays RoPE).

> **译：** 在 LLM 语境下，NoPE 是一个较早的想法，可追溯至 2023 年一篇论文（[《位置编码对 Transformer 长度泛化的影响》](https://arxiv.org/abs/2305.19466)），旨在移除显式的位置信息注入（如早期 GPT 架构中经典的绝对位置编码层，或如今的 RoPE）。

In transformer-based LLMs, positional encoding is typically necessary because self-attention treats tokens independently of order. Absolute position embeddings solve this by adding an additional embedding layer that adds information to the token embeddings.

> **译：** 在基于 transformer 的 LLM 中，位置编码通常是必要的，因为自注意力把 token 视作与顺序无关。绝对位置编码通过额外加一个嵌入层、把信息加到 token 嵌入上来解决此问题。

![Figure 22: A modified figure from my Build A Large Language Model (From Scratch) book (https://www.amazon.com/Build-Large-Language-Model-Scratch/dp/1633437167) illustrating absolute positional embeddings.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-22-modified-figure-my-build-large.png)

RoPE, on the other hand, solves this by rotating the query and key vectors relative to their token position.

> **译：** 而 RoPE 则通过让查询和键向量按其 token 位置旋转来解决此问题。

In NoPE layers, however, no such positional signal is added at all: not fixed, not learned, not relative. Nothing.

> **译：** 然而在 NoPE 层中，根本不加入任何此类位置信号：既非固定、也非学习、也非相对。什么都没有。

Even though there is no positional embedding, the model still knows which tokens come before, thanks to the causal attention mask. This mask prevents each token from attending to future ones. As a result, a token at position *t* can only see tokens at positions *≤ t*, which preserves the autoregressive ordering.

> **译：** 尽管没有位置编码，模型仍能知道哪些 token 在前，这要归功于因果注意力掩码（causal attention mask）。该掩码阻止每个 token 关注到未来的 token。结果是，位置 *t* 处的 token 只能看到位置 *≤ t* 的 token，从而保住了自回归顺序。

So while there is no positional information that is explicitly added, there is still an implicit sense of direction baked into the model's structure, and the LLM, in the regular gradient-descent-based training, can learn to exploit it if it finds it beneficial for the optimization objective. (Check out the NoPE paper's theorems for more information.)

> **译：** 因此，虽然没有显式加入位置信息，模型结构中仍内蕴一种隐式的方向感，而 LLM 在常规基于梯度下降的训练中，若发现它对优化目标有益，便能学会利用它。（更多信息可参看 NoPE 论文的定理。）

So, overall, the [NoPE paper](https://arxiv.org/abs/2305.19466) not only found that no positional information injection is necessary, but it also found that NoPE has better length generalization, which means that LLM answering performance deteriorates less with increased sequence length, as shown in the figure below.

> **译：** 总的来说，[NoPE 论文](https://arxiv.org/abs/2305.19466)不仅发现无需注入位置信息，还发现 NoPE 有更好的长度泛化能力——即随着序列长度增加，LLM 回答性能下降得更少，如下图所示。

![Figure 23: An annotated figure from the NoPE paper (https://arxiv.org/abs/2305.19466) showing better length generalization with NoPE.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-23-annotated-figure-nope-paper-https.png)

Note that the experiments shown above were conducted with a relatively small GPT-style model of approximately 100 million parameters and relatively small context sizes. It is unclear how well these findings generalize to larger, contemporary LLMs.

> **译：** 注意，上述实验是在约 1 亿参数的相对较小的 GPT 风格模型、且相对较小的上下文规模上做的。这些发现能在多大程度上推广到更大的当代 LLM，尚不清楚。

For this reason, the SmolLM3 team likely only "applied" NoPE (or rather omitted RoPE) in every 4th layer.

> **译：** 出于这个原因，SmolLM3 团队可能只在每第 4 层才「应用」NoPE（更确切说是省略 RoPE）。

## 8. Kimi K2 and Kimi K2 Thinking

[Kimi K2](https://moonshotai.github.io/Kimi-K2/) recently made big waves in the AI community due to being an open-weight model with an incredibly good performance. According to benchmarks, it's on par with the best proprietary models like Google's Gemini, Anthropic's Claude, and OpenAI's ChatGPT models.

> **译：** [Kimi K2](https://moonshotai.github.io/Kimi-K2/) 近期在 AI 社区掀起巨浪，因为它是一个性能极其出色的开源权重模型。据基准测试，它已与 Google 的 Gemini、Anthropic 的 Claude、OpenAI 的 ChatGPT 等最顶尖的专有模型旗鼓相当。

A notable aspect is its use of a variant of the relatively new [Muon](https://github.com/KellerJordan/Muon) optimizer over AdamW. As far as I know, this is the first time Muon was used over AdamW for any production model of this size ([previously](https://arxiv.org/abs/2502.16982), it has only been shown to scale up to 16B). This resulted in very nice training loss curves, which probably helped catapult this model to the top of the aforementioned benchmarks.

> **译：** 一个显著之处是它用了相对较新的 [Muon](https://github.com/KellerJordan/Muon) 优化器的一个变体，而非 AdamW。据我所知，这是首次在如此规模的量产模型上用 Muon 替代 AdamW（[此前](https://arxiv.org/abs/2502.16982)仅证明其可扩展到 16B）。这带来了相当漂亮的训练损失曲线，可能正助推该模型登顶前述基准。

While people commented that the loss was exceptionally smooth (due to the lack of spikes), I think it's not exceptionally smooth (e.g., see the OLMo 2 loss curve in the figure below; also, the L2 norm of the gradient would probably be a better metric to track training stability). However, what's remarkable is how well the loss curve decays.

> **译：** 虽有人评论说该损失曲线异常平滑（因没有尖刺），我认为它并非异常平滑（例如见下图中 OLMo 2 的损失曲线；而且梯度 L2 范数可能是衡量训练稳定性更好的指标）。不过，真正了不起的是损失曲线衰减得有多好。

However, as mentioned in the introduction of this article, training methodologies are a topic for another time.

> **译：** 不过，如本文导言所述，训练方法的话题留待日后再谈。

![Figure 24: Annotated figures from the Kimi K2 announcement blog article (https://moonshotai.github.io/Kimi-K2/) and the OLMo 2 paper (https://arxiv.org/abs/2305.19466).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-24-annotated-figures-kimi-k2-announcement.png)

The model itself is 1 trillion parameters large, which is truly impressive.

> **译：** 模型本身有 1 万亿参数，着实令人惊叹。

It may be the biggest LLM of this generation as of this writing (given the constraints that Llama 4 Behemoth is not released, proprietary LLMs don't count, and Google's 1.6 trillion [Switch Transformer](https://arxiv.org/abs/2101.03961) is an encoder-decoder architecture from a different generation).

> **译：** 截至写作时，它可能是本世代最大的 LLM（前提是：未发布的 Llama 4 Behemoth 不算、专有 LLM 不算，且 Google 1.6 万亿的 [Switch Transformer](https://arxiv.org/abs/2101.03961) 是不同世代的编码器-解码器架构）。

It's also coming full circle as Kimi K2 uses the DeepSeek V3 architecture we covered at the beginning of this article except they made it larger, as shown in the figure below.

> **译：** 这也算是一种循环回归——Kimi K2 用的正是本文开头讲过的 DeepSeek V3 架构，只不过他们把它做得更大了，如下图所示。

![Figure 25.1: An architecture comparison between DeepSeek V3 and Kimi K2.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-25-1-architecture-comparison-between-deepseek.png)

As shown in the figure above, Kimi K2 is basically the same as DeepSeek V3, except that it uses more experts in the MoE modules and fewer heads in the Multi-head Latent Attention (MLA) module.

> **译：** 如上图所示，Kimi K2 基本与 DeepSeek V3 相同，区别只在于 MoE 模块用了更多专家、多头潜在注意力（MLA）模块用了更少的头。

Kimi K2 is not coming out of nowhere. The earlier Kimi 1.5 model discussed in the [Kimi k1.5: Scaling Reinforcement Learning with LLMs paper](https://arxiv.org/abs/2501.12599), was impressive as well. However, it had the bad luck that the DeepSeek R1 model paper was published on exactly the same date on January 22nd. Moreover, as far as I know, the Kimi 1.5 weights were never publicly shared.

> **译：** Kimi K2 并非凭空冒出。[Kimi k1.5: Scaling Reinforcement Learning with LLMs 论文](https://arxiv.org/abs/2501.12599)中讨论的更早的 Kimi 1.5 模型同样出色。不过它运气不佳：DeepSeek R1 模型论文恰好在同一天（1 月 22 日）发表。而且据我所知，Kimi 1.5 的权重从未公开。

So, most likely the Kimi K2 team took these lessons to heart and shared Kimi K2 as an open-weight model, before DeepSeek R2 was released. As of this writing, Kimi K2 is the most impressive open-weight model.

> **译：** 因此，Kimi K2 团队很可能是吸取了这些教训，抢在 DeepSeek R2 发布之前把 Kimi K2 作为开源权重模型放出。截至写作时，Kimi K2 是最令人惊艳的开源权重模型。

**Update:** On Nov 6, 2025 the Kimi K2 team also released their new “Thinking” model variant. The architecture is unchanged from Kimi K2 above, except that they extended the context size from 128k to 256k.

> **译：** **更新：** 2025 年 11 月 6 日，Kimi K2 团队还发布了新的「Thinking」模型变体。架构与上文 Kimi K2 相同，只是把上下文规模从 128k 扩展到 256k。

According to the [benchmarks shared by the Kimi team](https://moonshotai.github.io/Kimi-K2/thinking.html), the model exceeds the performance of the leading proprietary LLMs. (Unfortunately, there is no direct comparison to DeepSeek R1.

> **译：** 据 [Kimi 团队公布的基准](https://moonshotai.github.io/Kimi-K2/thinking.html)，该模型超越了领先的专有 LLM。（遗憾的是没有与 DeepSeek R1 的直接对比。）

![Figure 25.2: DeepSeek R1 versus Kimi K2 Thinking architecture (top) and Kimi K2 Thinking benchmarks (bottom).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-26-2-deepseek-r1-versus-kimi.png)

## 9. GPT-OSS

OpenAI’s [released](https://openai.com/index/introducing-gpt-oss/) gpt-oss-120b and gpt-oss-20b, their first open-weight models since GPT-2 in 2019, about one week after I wrote this article. Since OpenAI’s open-weight models have been so widely anticipated, I updated this article to include them. I will keep this section brief, but I have written another, much more detailed article dedicated to the gpt-oss models here: [From GPT-2 to gpt-oss: Analyzing the Architectural Advances](https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the)

> **译：** OpenAI [发布](https://openai.com/index/introducing-gpt-oss/)了 gpt-oss-120b 和 gpt-oss-20b，这是自 2019 年 GPT-2 以来其首批开源权重模型，距我写下本文约一周。由于 OpenAI 的开源权重模型备受期待，我更新本文将其纳入。本节从简，但我另写了一篇更详尽的、专门讨论 gpt-oss 模型的文章：[从 GPT-2 到 gpt-oss：解析架构演进（From GPT-2 to gpt-oss: Analyzing the Architectural Advances）](https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the)

Before summarizing the interesting tidbits, let's start with an overview of the two models, gpt-oss-20b and gpt-oss-120b, as shown in Figure 26 below.

> **译：** 在小结有趣细节之前，先从两个模型 gpt-oss-20b 和 gpt-oss-120b 的概览讲起，如下方图 26 所示。

![Figure 26: Architecture overview of the two gpt-oss models.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-27-architecture-overview-two-gpt-oss.png)

Looking at Figure 26, the architecture contains all the familiar components we have seen in other architectures discussed previously. For instance, Figure 27 puts the smaller gpt-oss architecture next to Qwen3 30B-A3B, which is also an MoE model with a similar number of active parameters (gpt-oss has 3.6B active parameters, and Qwen3 30B-A3B has 3.3B).

> **译：** 看 Figure 26，该架构包含了我们此前讨论过的其他架构中所有熟悉的组件。例如，Figure 27 把较小的 gpt-oss 架构与 Qwen3 30B-A3B 并排放在一起，后者也是 MoE 模型、活跃参数数相近（gpt-oss 有 36 亿活跃参数，Qwen3 30B-A3B 有 33 亿）。

![Figure 27: Architecture comparison between gpt-oss and Qwen3](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-28-architecture-comparison-between-gpt-oss.png)

One aspect not shown in Figure 27 is that gpt-oss uses sliding window attention (similar to Gemma 3, but in every other layer instead of using a 5:1 ratio).

> **译：** Figure 27 中未展示的一点是：gpt-oss 使用了滑动窗口注意力（类似 Gemma 3，但是隔层使用，而非 5:1 比例）。

#### 9.1 Width Versus Depth

Figure 27 shows that gpt-oss and Qwen3 use similar components. But if we look at the two models closely, we see that Qwen3 is a much deeper architecture with its 48 transformer blocks instead of 24.

> **译：** Figure 27 显示 gpt-oss 与 Qwen3 用了相似组件。但细看这两个模型，会发现 Qwen3 是一个深得多得架构——它有 48 个 transformer 块而非 24 个。

On the other hand, gpt-oss is a much wider architecture:

> **译：** 另一方面，gpt-oss 是一个宽得多的架构：

- An embedding dimension of 2880 instead of 2048
- An intermediate expert (feed forward) projection dimension of also 2880 instead of 768

> **译：**
> - 嵌入维度为 2880 而非 2048
> - 中间专家（前馈）投影维度同样为 2880 而非 768

It's also worth noting that gpt-oss uses twice as many attention heads, but this doesn't directly increase the model's width. The width is determined by the embedding dimension.

> **译：** 还值得注意 gpt-oss 用了两倍的注意力头，但这并不直接增加模型宽度。宽度由嵌入维度决定。

Does one approach offer advantages over the other given a fixed number of parameters? As a rule of thumb, deeper models have more flexibility but can be harder to train due to instability issues, due to exploding and vanishing gradients (which RMSNorm and shortcut connections aim to mitigate).

> **译：** 在固定参数量下，哪种方式更有优势？经验法则：更深的模型灵活性更大，但训练更难，容易因梯度爆炸/消失而不稳定（RMSNorm 和残差连接正是为缓解此问题）。

Wider architectures have the advantage of being faster during inference (with a higher tokens/second throughput) due to better parallelization at a higher memory cost.

> **译：** 更宽的架构优势在于推理更快（token/秒吞吐更高），得益于更好的并行度，但内存代价更高。

When it comes to modeling performance, there's unfortunately no good apples-to-apples comparison I am aware of (where parameter size and datasets are kept constant) except for an ablation study in the [Gemma 2 paper (Table 9)](https://arxiv.org/abs/2408.00118), which found that for a 9B parameter architecture, a wider setup is slightly better than a deeper setup. Across 4 benchmarks, the wider model achieved a 52.0 average score, and the deeper model achieved a 50.8 average score.

> **译：** 至于建模性能，遗憾的是据我所知没有很好的同口径对比（参数规模和数据集保持一致），只有 [Gemma 2 论文（Table 9）](https://arxiv.org/abs/2408.00118)中的一项消融研究：对于 9B 参数架构，更宽的设置略好于更深的设置。在 4 个基准上，更宽模型平均 52.0 分，更深模型平均 50.8 分。

#### 9.2 Few Large Versus Many Small Experts

As shown in Figure 27 above, it's also noteworthy that gpt-oss has a surprisingly small number of experts (32 instead of 128), and only uses 4 instead of 8 active experts per token. However, each expert is much larger than the experts in Qwen3.

> **译：** 如上方 Figure 27 所示，同样值得注意的是 gpt-oss 的专家数量惊人地少（32 个而非 128 个），且每个 token 仅用 4 个活跃专家而非 8 个。但每个专家都比 Qwen3 中的专家大得多。

This is interesting because the recent trends and developments point towards more, smaller models as being beneficial. This change, at a constant total parameter size, is nicely illustrated in Figure 28 below from the DeepSeekMoE paper.

> **译：** 这很有意思，因为近期的趋势与发展都指向「更多、更小的专家」更有利。在总参数量不变的情况下，这种变化如下方 Figure 28（取自 DeepSeekMoE 论文）清晰展示。

![Figure 28: An annotated figure from "DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models", https://arxiv.org/abs/2401.06066](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-29-annotated-figure-deepseekmoe-towards-ultimate.png)

Notably, unlike DeepSeek's models, neither gpt-oss nor Qwen3 uses shared experts, though.

> **译：** 不过值得注意的是，与 DeepSeek 的模型不同，gpt-oss 和 Qwen3 都不使用共享专家。

#### 9.3 Attention Bias and Attention Sinks

Both gpt-oss and Qwen3 use grouped query attention. The main difference is that gpt-oss restricts the context size via sliding window attention in each second layer, as mentioned earlier.

> **译：** gpt-oss 和 Qwen3 都用分组查询注意力。主要区别是 gpt-oss 在每隔一层用滑动窗口注意力来限制上下文规模，如前所述。

However, there's one interesting detail that caught my eye. It seems that gpt-oss uses bias units for the attention weights, as shown in Figure 29 below.

> **译：** 不过有个细节引起我注意：gpt-oss 似乎在注意力权重上使用了偏置单元（bias units），如下方 Figure 29 所示。

![Figure 29: gpt-oss models use bias units in the attention layers. See code example here.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-30-gpt-oss-models-use-bias.png)

I haven't seen these bias units being used since the GPT-2 days, and they are commonly regarded as redundant. Indeed, I found a recent paper that shows mathematically that this is at least true for the key transformation (`k_proj`). Furthermore, the empirical results show that there is little difference between with and without bias units (see Figure 30 below).

> **译：** 自 GPT-2 时代以来我就没见过这些偏置单元被使用，它们通常被视为冗余。确实，我找到一篇近期论文，用数学证明了至少对键变换（`k_proj`）来说确实如此。而且实证结果也表明有无偏置单元差异甚微（见下方 Figure 30）。

![Figure 30: Table from https://arxiv.org/pdf/2302.08626 showing the average test loss when the models were trained from scratch with and without bias units.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-31-table-https-arxiv-org-pdf.png)

Another detail you may have noticed is the definition of `sinks` in the code screenshot in Figure 30. In general models, attention sinks are special "always-attended" tokens placed at the start of the sequence to stabilize attention, which is especially useful in long-context scenarios. I.e., if the context gets very long, this special attended token at the beginning is still attended to, and it can learn to store some generally useful information about the entire sequence. (I think it was originally proposed in the [Efficient Streaming Language Models with Attention Sinks](https://arxiv.org/abs/2309.17453) paper.)

> **译：** 你或许还注意到 Figure 30 代码截图中 `sinks` 的定义。在一般模型中，注意力汇（attention sinks）是放在序列开头的特殊「始终被关注」的 token，用以稳定注意力，这在长上下文场景中尤其有用。也就是说，当上下文变得很长时，开头这个被关注的特殊 token 仍被关注，它可以学习存储一些关于整个序列的通用有用信息。（我认为它最初在 [Efficient Streaming Language Models with Attention Sinks](https://arxiv.org/abs/2309.17453) 论文中提出。）

In the gpt-oss implementation, *attention sinks* are not actual tokens in the input sequence. Instead, they are learned per-head bias logits that are appended to the attention scores (Figure 31). The goal is the same as with the above-mentioned attention sinks, but without modifying the tokenized inputs.

> **译：** 在 gpt-oss 实现中，*注意力汇*并非输入序列中真实的 token，而是逐个注意力头学到的偏置 logit，附加在注意力分数上（Figure 31）。其目标与上述注意力汇相同，但无需修改分词后的输入。

![Figure 31: The use of attention sinks in gpt-oss; based on the Hugging Face code [here](https://github.com/huggingface/transformers/blame/369c99d0cea403b77bd0aef818527106453fd9fc/src/transformers/models/gpt_oss/modular_gpt_oss.py).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-32-use-attention-sinks-gpt-oss.png)

For more information about gpt-oss, and how it compares to GPT-2, please see my other gpt-oss article: [From GPT-2 to gpt-oss: Analyzing the Architectural Advances](https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the)

> **译：** 关于 gpt-oss 的更多信息及其与 GPT-2 的对比，请见我的另一篇 gpt-oss 文章：[从 GPT-2 到 gpt-oss：解析架构演进](https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the)

## 10. Grok 2.5

A few weeks after this article first went online, xAI released the weights of their 270B-parameter Grok 2.5 model.

> **译：** 本文首次上线几周后，xAI 发布了其 2700 亿参数 Grok 2.5 模型的权重。

I thought it would be worth including here, since Grok 2.5 was xAI's flagship production model last year. Up to this point, all models we discussed were released as open-weight models from the start. For example, gpt-oss is likely not an open-weight clone of GPT-4 but rather a custom model trained specifically for the open-source community.

> **译：** 我认为值得把它纳入，因为 Grok 2.5 是 xAI 去年的旗舰量产模型。到此为止，我们讨论的所有模型都是一开始就作为开源权重发布的。例如，gpt-oss 大概不是 GPT-4 的开源权重克隆，而是专为开源社区定制的模型。

With Grok 2.5, we get a rare look at a real production system, even if it is last year's.

> **译：** 借 Grok 2.5，我们难得能窥见一个真实的量产系统，哪怕是去年的。

Architecturally, Grok 2.5 looks fairly standard overall (Figure 32), but there are a few noteworthy details.

> **译：** 架构上，Grok 2.5 整体看来相当标准（Figure 32），但有几个值得关注的细节。

![Figure 32: Grok 2.5 next to a Qwen3 model of comparable size](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-33-grok-2-5-next-qwen3.png)

For instance, Grok 2.5 uses a small number of large experts (eight), which reflects an older trend. As discussed earlier, more recent designs such as those in the DeepSeekMoE paper favor a larger number of smaller experts (this is also present in Qwen3).

> **译：** 例如，Grok 2.5 用了少量大专家（8 个），这反映了一种较早的趋势。如前所述，DeepSeekMoE 论文等更近期的设计倾向于更多更小的专家（Qwen3 也是如此）。

Another interesting choice is the use of what amounts to a shared expert. The additional SwiGLU module shown on the left in Figure 32 functions as an always-on, shared expert. It is not identical to the classic shared-expert design since its intermediate dimension is doubled, but the idea is the same. (I still find it interesting that Qwen3 omitted shared experts, and it will be interesting to see if that changes with Qwen4 and later models.)

> **译：** 另一个有趣的选择是使用了实质上的共享专家。Figure 32 左侧那个额外的 SwiGLU 模块充当一个常开的共享专家。它与经典的共享专家设计并不完全相同（其中间维度翻倍了），但思路一致。（我仍觉得 Qwen3 省去共享专家这点很有意思，且看 Qwen4 及后续模型是否会改变。）

## 11. GLM-4.5

[GLM-4.5](https://arxiv.org/abs/2508.06471) is another major release this year.

> **译：** [GLM-4.5](https://arxiv.org/abs/2508.06471) 是今年的又一个重要发布。

It is an instruction/reasoning hybrid similar to Qwen3, but even better optimized for function calling and agent-style contexts.

> **译：** 它是类似 Qwen3 的指令/推理混合体，但更针对函数调用和 agent 式场景做了优化。

![Figure 33: GLM-4.5 benchmark from the official GitHub repository at https://github.com/zai-org/GLM-4.5](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-34-glm-4-5-benchmark-official.png)

As shown in Figure 34, GLM-4.5 comes in two variants. The flagship 355-billion-parameter model outperforms Claude 4 Opus on average across 12 benchmarks and trails only slightly behind OpenAI’s o3 and xAI’s Grok 4. There is also GLM-4.5-Air, a more compact 106-billion-parameter version that delivers performance only marginally below the 355-billion model.

> **译：** 如 Figure 34 所示，GLM-4.5 有两个变体。旗舰的 3550 亿参数模型在 12 个基准上平均超过 Claude 4 Opus，仅略逊于 OpenAI 的 o3 与 xAI 的 Grok 4。另有 GLM-4.5-Air，一个更紧凑的 1060 亿参数版本，性能仅略低于 3550 亿模型。

Figure 35 compares the 355-billion architecture to Qwen3.

> **译：** Figure 35 把这 3550 亿参数架构与 Qwen3 做了对比。

![Figure 34: GLM-4.5 next to a similarly-sized Qwen3 model.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-35-glm-4-5-next-similarly.png)

The designs are largely similar, but GLM-4.5 adopts a structural choice first introduced by DeepSeek V3: 3 dense layers precede the Mixture-of-Experts (MoE) blocks. Why? Starting with several dense layers improves convergence stability and overall performance in large MoE systems. If MoE routing is introduced immediately, the instability of sparse expert selection can interfere with early syntactic and semantic feature extraction. So, one might say that by keeping the initial layers dense ensures the model forms stable low-level representations before routing decisions begin to shape higher-level processing.

> **译：** 两者设计大体相似，但 GLM-4.5 采用了 DeepSeek V3 首创的一种结构选择：在混合专家（MoE）块之前先有 3 个稠密层。为什么？以数个稠密层起步能改善大型 MoE 系统的收敛稳定性和整体性能。若一开始就引入 MoE 路由，稀疏专家选择的不稳定可能干扰早期句法与语义特征提取。因此可以说，让初始层保持稠密，能确保模型在路由决策开始塑造更高层处理之前，先形成稳定的低层表示。

Also, GLM-4.5 uses a shared expert similar to DeepSeek V3 (and unlike Qwen3).

> **译：** 此外，GLM-4.5 像 DeepSeek V3 一样使用了共享专家（而与 Qwen3 不同）。

(Interestingly, GLM-4.5 also retains the attention bias mechanism used in GPT-2 and gpt-oss.)

> **译：**（有趣的是，GLM-4.5 还保留了 GPT-2 和 gpt-oss 所用的注意力偏置机制。）

## 12. Qwen3-Next

On 11 September 2025, the Qwen3 team released Qwen3 Next 80B-A3B (Figure 35), available in both Instruct and Thinking variants. While its design builds on the previously discussed Qwen3 architecture, I included it here as a separate entry to keep the figure numbering consistent and to draw attention to some of its design changes.

> **译：** 2025 年 9 月 11 日，Qwen3 团队发布了 Qwen3 Next 80B-A3B（Figure 35），提供 Instruct 与 Thinking 两个变体。其设计虽建立在前面讨论过的 Qwen3 架构之上，但我把它作为独立条目纳入，以保持图号连贯，并凸显它的一些设计变化。

### 12.1 Expert Size and Number

The new Qwen3 Next architecture stands out because, despite being 3× smaller than the previous 235B-A22B model (Figure 35), it introduces four times as many experts and even adds a shared expert. Both of these design choices (a high expert count and the inclusion of a shared expert) were future directions I had highlighted prior to this release, particularly in the video version of the article that I linked at the top.

> **译：** 新的 Qwen3 Next 架构令人瞩目，因为尽管它比此前的 235B-A22B 模型小 3 倍（Figure 35），却引入了 4 倍之多的专家，甚至加上了共享专家。这两个设计选择（高专家数 + 共享专家）正是我在此次发布前就指出的未来方向，尤其是在本文顶部所链视频版中。

![Figure 35: The original Qwen3 model released in May (left) next to the Qwen3 Next model released in September (right).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-36-original-qwen3-model-released-may.png)

### 12.2 Gated DeltaNet + Gated Attention Hybrid

The other highlight is that they replace the regular attention mechanism by a [Gated DeltaNet](https://arxiv.org/abs/2412.06464) + [Gated Attention](https://arxiv.org/abs/2505.06708) hybrid, which helps enable the native 262k token context length in terms of memory usage (the previous 235B-A22B model model supported 32k natively, and 131k with [YaRN](https://arxiv.org/abs/2309.00071) scaling.)

> **译：** 另一亮点是他们用 [Gated DeltaNet](https://arxiv.org/abs/2412.06464) + [Gated Attention](https://arxiv.org/abs/2505.06708) 混合取代了常规注意力机制，这有助于在内存层面实现原生的 262k token 上下文长度（此前的 235B-A22B 模型原生支持 32k，借助 [YaRN](https://arxiv.org/abs/2309.00071) 缩放可达 131k）。

So how does this new attention hybrid work? Compared to grouped‑query attention (GQA), which is still standard scaled dot‑product attention (sharing K/V across query‑head groups to cut KV‑cache size and memory bandwidth as discussed earlier but whose decode cost and cache still grow with sequence length), their hybrid mechanism mixes *Gated DeltaNet* blocks with *Gated Attention* blocks with in a 3:1 ratio as shown in Figure 36.

> **译：** 那么这种新的注意力混合如何运作？相比仍是标准缩放点积注意力的分组查询注意力（GQA，如前所述通过跨查询头组共享 K/V 来削减 KV cache 体积和内存带宽，但其解码成本和 cache 仍随序列长度增长），他们的混合机制以 3:1 比例混合 *Gated DeltaNet* 块与 *Gated Attention* 块，如 Figure 36 所示。

![Figure 36: The Gated DeltaNet + Gated Attention hybrid mechanism. Note that these are arranges in a 3:1 ratio, meaning that 3 transformer blocks with Gated DeltaNet are followed by 1 transformer block with Gated Attention. The right subfigure is from the official Qwen3 blog: [https://qwen.ai/blog?id=4074cca80393150c248e508aa62983f9cb7d27cd&from=research.latest-advancements-list](https://qwen.ai/blog?id=4074cca80393150c248e508aa62983f9cb7d27cd&from=research.latest-advancements-list)](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-37-gated-deltanet-gated-attention-hybrid.png)

We can think of the gated attention block as standard scaled-dot-product attention that can be used in GQA, but it has a few tweaks on top. The main differences between *gated attention* and plain GQA block are:

> **译：** 我们可以把 gated attention 块视为可用于 GQA 的标准缩放点积注意力，但之上做了若干调整。*gated attention* 与普通 GQA 块的主要区别是：

1. an output gate (sigmoid-controlled, usually per-channel) that scales the attention result before it is added back to the residual;
2. zero-centered RMSNorm for QKNorm, rather than a standard RMSNorm;
3. partial RoPE (on a subset of dimensions).

> **译：**
> 1. 一个输出门控（sigmoid 控制，通常逐通道），在注意力结果加回残差之前对其缩放；
> 2. QKNorm 用零中心化的 RMSNorm，而非标准 RMSNorm；
> 3. 部分 RoPE（仅作用于部分维度）。

Note that these are essentially just stability changes to GQA.

> **译：** 注意这些本质上只是对 GQA 的稳定性改动。

The Gated DeltaNet is a more significant change. In the DeltaNet block, q, k, v and two gates (α, β) are produced by linear and lightweight convolutional layers with normalization, and the layer replaces attention with a fast‑weight *[delta rule](https://arxiv.org/abs/2412.06464)* update.

> **译：** Gated DeltaNet 则是更重大的改动。在 DeltaNet 块中，q、k、v 以及两个门控（α、β）由线性层和轻量卷积层（带归一化）产生，该层用快权重的 *[delta rule](https://arxiv.org/abs/2412.06464)* 更新取代了注意力。

However, the tradeoff is that DeltaNet offers less precise content‑based retrieval than full attention, which is why one gated attention layer remains.

> **译：** 然而代价是：DeltaNet 在基于内容的检索上不如全注意力精确，因此仍保留一个 gated attention 层。

Given that attention grows quadratically, the DeltaNet component was added to help with memory efficiency. In the "linear-time, cache-free" family, the DeltaNet block is a essentially an alternative to Mamba. Mamba keeps a state with a learned state-space filter (essentially a dynamic convolution over time). DeltaNet keeps a tiny fast-weight memory updated with α and β and reads it with q, with small convolutions only used only to help form q, k, v, α, β.

> **译：** 鉴于注意力按二次方增长，加入 DeltaNet 组件是为了提升内存效率。在「线性时间、无 cache」家族中，DeltaNet 块本质上是 Mamba 的替代方案。Mamba 用一个学习到的状态空间滤波器维持一个状态（本质上是随时间的动态卷积）。DeltaNet 维持一个用 α 和 β 更新的微型快权重记忆，并用 q 读取它，小卷积仅用于辅助生成 q、k、v、α、β。

### 12.3 Multi-Token Prediction

The two subsections above describe two design decisions geared towards efficiency. Since all good things come in threes, the Qwen3 also adds another efficiency-technique on top: [Multi-Token Prediction](https://arxiv.org/abs/2404.19737) (MTP).

> **译：** 上面两个小节描述了两个面向效率的设计决策。好事成三，Qwen3 还在其上叠加了另一项效率技术：[多 token 预测](https://arxiv.org/abs/2404.19737)（Multi-Token Prediction，MTP）。

(Note that DeepSeek V3 & V3.2, and later GLM-4.5 and MiniMax-M2 all use MTP during training; however, since it’s a training technique, I haven’t explicitly discussed it in the architecture comparisons.)

> **译：**（注意 DeepSeek V3 与 V3.2，以及后来的 GLM-4.5 和 MiniMax-M2 都在训练时使用 MTP；不过由于它是一种训练技术，我在架构对比中未专门讨论。）

Multi-token prediction trains the LLM to predict several future tokens, instead of a single one, at each step. Here, at each position *t*, small extra heads (linear layers) output logits for *t+1...t+k*, and we sum cross-entropy losses for these offsets (in the [MTP](https://arxiv.org/abs/2404.19737) paper the researchers recommended *k=4*). This additional signal speeds up training, and inference may remain at generating one token at a time. However, the extra heads can be used in speculative multi-token decoding, which is what Qwen3-Next seems to do, however, the details are still a bit sparse:

> **译：** 多 token 预测训练 LLM 在每步预测多个未来 token 而非单个。这里在每个位置 *t*，额外的小型头（线性层）输出 *t+1…t+k* 的 logits，我们对这些偏移的交叉熵损失求和（[MTP](https://arxiv.org/abs/2404.19737) 论文中研究者建议 *k=4*）。这一额外信号加速训练，而推理仍可保持每次生成一个 token。不过这些额外头可用于投机式多 token 解码，这似乎正是 Qwen3-Next 所为，只是细节仍较简略：

> Qwen3-Next introduces a native Multi-Token Prediction (MTP) mechanism, which not only yields an MTP module with a high acceptance rate for Speculative Decoding but also enhances the overall performance.Additionally, Qwen3-Next specifically optimizes the multi-step inference performance of MTP, further improving the acceptance rate of Speculative Decoding in real scenarios through multi-step training that maintains consistency between training and inference. [Souce: Qwen3-Next blog post](https://qwen.ai/blog?id=4074cca80393150c248e508aa62983f9cb7d27cd&from=research.latest-advancements-list)

> **译：** Qwen3-Next 引入了原生的多 token 预测（MTP）机制，它不仅产生了一个对投机解码（Speculative Decoding）有高接受率的 MTP 模块，还提升了整体性能。此外，Qwen3-Next 专门优化了 MTP 的多步推理性能，通过保持训练与推理一致的多步训练，进一步提高了真实场景下投机解码的接受率。[来源：Qwen3-Next 博文](https://qwen.ai/blog?id=4074cca80393150c248e508aa62983f9cb7d27cd&from=research.latest-advancements-list)

### 12.4 Qwen3-Coder-Next

In early February 2026, the Qwen3 team [shared](https://github.com/QwenLM/Qwen3-Coder/blob/main/qwen3_coder_next_tech_report.pdf) the 80B Qwen3-Coder-Next model (3B parameters active), which made big headlines for outperforming much larger models like DeepSeek V3.2 (37B active) and Kimi K2.5 and GLM-7.5 (both 32B active) on coding tasks.

> **译：** 2026 年 2 月初，Qwen3 团队[公布](https://github.com/QwenLM/Qwen3-Coder/blob/main/qwen3_coder_next_tech_report.pdf)了 80B 的 Qwen3-Coder-Next 模型（活跃参数 3B），因在编程任务上超过 DeepSeek V3.2（活跃 37B）、Kimi K2.5 与 GLM-7.5（均活跃 32B）等大得多的模型而登上头条。

Moreover, the Qwen3-Coder-Next SWE-Bench Pro Performance is roughly on par with Claude-Sonnet-4.5 (and only slightly below Claude-Opus-4.5), which is impressive for an open-weight model!

> **译：** 此外，Qwen3-Coder-Next 的 SWE-Bench Pro 性能与 Claude-Sonnet-4.5 大致相当（仅略低于 Claude-Opus-4.5），对一个开源权重模型而言令人印象深刻！

Note that the architecture behind Qwen3-Coder-Next is exactly the same as Qwen3-Next 80B, which we discussed above (in fact, they used Qwen3-Next as a base model to train Qwen3-Coder-Next. Since this is an article about LLM architectures, the training details are outside the scope. However, interested readers can find more information in their [detailed technical report on GitHub](https://github.com/QwenLM/Qwen3-Coder/blob/main/qwen3_coder_next_tech_report.pdf).

> **译：** 注意 Qwen3-Coder-Next 背后的架构与上文讨论的 Qwen3-Next 80B 完全相同（事实上，他们以 Qwen3-Next 为基座模型来训练 Qwen3-Coder-Next）。由于本文讲的是 LLM 架构，训练细节不在范围内。不过感兴趣的读者可在其 [GitHub 上的详细技术报告](https://github.com/QwenLM/Qwen3-Coder/blob/main/qwen3_coder_next_tech_report.pdf)中找到更多信息。

## 13. MiniMax-M2

Recently, open-weight LLM developers shared flavors of their core architectures optimized for efficiency. One example is Qwen3-Next (see previous section), which replaces some of the full attention blocks with a fast gated DeltaNet module. Another example is DeepSeek V3.2, which uses sparse attention, a linear attention variant that trades off some modeling performance for improved computational performance (I plan to cover this mechanism in more detail in an upcoming article).

> **译：** 近期，开源权重 LLM 开发者分享了为效率而优化的核心架构变体。一个是 Qwen3-Next（见上一节），用快速的 gated DeltaNet 模块替换了部分全注意力块。另一个是 DeepSeek V3.2，使用稀疏注意力——一种线性注意力变体，以牺牲部分建模性能换取更佳计算性能（我计划在后续文章中详述此机制）。

Now, [MiniMax-M1](https://arxiv.org/abs/2506.13585) falls into a similar category to the models above, in that it uses a linear attention variant (lightning attention) that offers improved efficiency over regular (full) attention. I originally didn’t cover MiniMax M1 as it wasn’t quite as popular as some of the other models discussed here. However, their new [MiniMax-M2](https://huggingface.co/MiniMaxAI/MiniMax-M2) release is currently considered the best open-weight model (according to benchmark performance), which makes it too big to ignore.

> **译：** 而 [MiniMax-M1](https://arxiv.org/abs/2506.13585) 与上述模型属同类，使用线性注意力变体（lightning attention），效率优于常规（全）注意力。我起初没讲 MiniMax M1，因为它不像此处讨论的其他某些模型那么出名。但他们新发布的 [MiniMax-M2](https://huggingface.co/MiniMaxAI/MiniMax-M2) 目前被认为是最好的开源权重模型（就基准性能而言），因此不容忽视。

![Figure 37: MiniMax-M2 benchmark performance compared to other popular open-weight and proprietary LLMs. Image from the official model hub release [readme](https://huggingface.co/MiniMaxAI/MiniMax-M2) file.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-38-minimax-m2-benchmark-performance-compared.png)

As shown in the overview figure below, I grouped MiniMax-M2 with the other decoder-style transformer LLMs as it does not use the efficient lightning attention variant proposed in MiniMax-M1. Instead, the developers went back to using full attention, likely to improve modeling (and benchmark) performance.

> **译：** 如下方概览图所示，我把 MiniMax-M2 与其他解码器式 transformer LLM 归在一组，因为它并未使用 MiniMax-M1 提出的高效 lightning attention 变体。开发者转而回归全注意力，很可能是为提升建模（及基准）性能。

![Figure 38: A timeline of the main LLMs covered in this article, next to some of the attention-hybrid models that constitute more efficient alternatives, trading off some modeling performance with improved efficiency.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-39-timeline-main-llms-covered-article.png)

Overall, MiniMax-M2 is surprisingly similar to Qwen3. Besides changing the number of layers, sizes, etc., it uses the same components overall.

> **译：** 总体而言，MiniMax-M2 与 Qwen3 惊人地相似。除了改变层数、各维度尺寸等，它整体用的是相同组件。

### 13.1 Per-Layer QK-Norm

Perhaps the one noteworthy highlight here is that MiniMax-M2 uses a so-called “per_layer” QK-Norm instead of the regular QK-Norm. A closer look at the [code](https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/models/minimax_m2.py#L222C23-L222C45) reveals that it is implemented like this inside the attention mechanism:

> **译：** 这里或许唯一值得关注的亮点是：MiniMax-M2 使用了所谓「per_layer」QK-Norm，而非常规 QK-Norm。细看[代码](https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/models/minimax_m2.py#L222C23-L222C45)，其在注意力机制内的实现如下：

```python title="MiniMax QK-Norm 实现"
self.q_norm = MiniMaxText01RMSNormTP(self.head_dim * self.total_num_heads, eps=...)

self.k_norm = MiniMaxText01RMSNormTP(self.head_dim * self.total_num_kv_heads, eps=...)
```

Here, the `hidden_size` equals the concatenated heads (`num_heads * head_dim`), so the RMSNorm has a scale vector with distinct parameters for every head (and each head dim).

> **译：** 这里 `hidden_size` 等于拼接后的头数（`num_heads * head_dim`），因此 RMSNorm 拥有一个对每个头（以及每个头维度）都有独立参数的缩放向量。

So, the “`per_layer`” means that the RMSNorm (used for QK-Norm as explained earlier) is defined in each transformer block (as in regular QK-Norm), but, in addition, instead of reusing it across attention heads, it’s a unique QK-Norm for each attention head.

> **译：** 因此「`per_layer`」的意思是：用于 QK-Norm 的 RMSNorm 定义在每个 transformer 块中（与常规 QK-Norm 一样），但除此之外，它并非跨注意力头复用，而是每个注意力头都有独立的 QK-Norm。

The [model configuration file](https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/config.json) also includes a sliding-window attention setting (similar to Gemma 3 in section 3), but, as in Mistral 3.1 (discussed in section 4), it is disabled by default.

> **译：** [模型配置文件](https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/config.json)中还包含一个滑动窗口注意力设置（类似第 3 节的 Gemma 3），但与第 4 节讨论的 Mistral 3.1 一样，默认是禁用的。

Otherwise, besides the per-layer QK-Norm, the architecture is very similar to Qwen3, as shown in the figure below.

> **译：** 除此之外，除了逐层 QK-Norm，该架构与 Qwen3 非常相似，如下图所示。

![Figure 39: Comparison between Qwen3 and MiniMax-M2.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-40-comparison-between-qwen3-minimax-m2.png)

### 13.2 MoE Sparsity

Other interesting tidbits, as shown in the figure below, include the fact that they don’t use a shared expert (similar to Qwen3 but unlike Qwen3-Next). As mentioned earlier, in my opinion, shared experts are useful because they reduce redundancy among the other experts.

> **译：** 如下图所示，其他有趣细节包括：他们不使用共享专家（类似 Qwen3，但与 Qwen3-Next 不同）。如前所述，我认为共享专家是有用的，因为它能减少其他专家间的冗余。

Also, as apparent from the figure above, MiniMax-M2 is twice as “sparse” as Qwen3. I.e., at roughly the same size as Qwen3 235B-A22B, MiniMax-M2 has only 10B instead of 22B active experts per token (that is, 4.37% of the parameters are used in each inference step in MiniMax-M2, whereas Qwen3 uses 9.36% active tokens).

> **译：** 另外，从上图明显可见，MiniMax-M2 的「稀疏度」是 Qwen3 的两倍。即在与 Qwen3 235B-A22B 大致相同的体量下，MiniMax-M2 每个 token 仅有 100 亿活跃专家而非 220 亿（也就是说，MiniMax-M2 每次推理步骤用到 4.37% 的参数，而 Qwen3 用 9.36% 活跃 token）。

### 13.3 Partial RoPE

Lastly, similar to MiniMax-M1, MiniMax-M2 uses a “partial” instead of regular RoPE inside the attention modules to encode positional information. Similar to regular RoPE, the rotations are applied to the queries and keys after applying QK-Norm.

> **译：** 最后，与 MiniMax-M1 类似，MiniMax-M2 在注意力模块内使用「部分」RoPE 而非常规 RoPE 来编码位置信息。与常规 RoPE 一样，旋转是在施加 QK-Norm 之后作用于查询和键。

Partial RoPE here means only the first `rotary_dim` channels of each head get rotary position encodings, and the remaining `head_dim - rotary_dim` channels remain unchanged.

> **译：** 此处的部分 RoPE 意为：每个头仅前 `rotary_dim` 个通道获得旋转位置编码，其余 `head_dim - rotary_dim` 个通道保持不变。

In the official M1 [README](https://github.com/MiniMax-AI/MiniMax-01) file, the developers mention

> **译：** 在官方 M1 [README](https://github.com/MiniMax-AI/MiniMax-01) 文件中，开发者提到

> Rotary Position Embedding (RoPE) applied to half of the attention head dimension with a base frequency of 10,000,000

> **译：** 旋转位置编码（RoPE）作用于注意力头维度的一半，基频为 10,000,000

We can picture it as follows:

> **译：** 我们可以如此示意：

```
Full RoPE:     [r r r r r r r r]
Partial RoPE:  [r r r r — — — —]
```

where in the conceptual illustration above, the “r”s show rotated (position-encoded) dimensions, and the dashes are the untouched dimensions.

> **译：** 上方概念示意中，「r」表示被旋转（位置编码）的维度，破折号表示未被触碰的维度。

What’s the point of this? In the [M1 paper](https://arxiv.org/abs/2501.08313), the developers stated that

> **译：** 这有什么意义？在 [M1 论文](https://arxiv.org/abs/2501.08313)中，开发者称：

> …implementing RoPE on half of the softmax attention dimensions enables length extrapolation without performance degradation.

> **译：** ……在一半的 softmax 注意力维度上实施 RoPE，能实现长度外推而不损失性能。

My speculation is that this prevents “too much” rotation for long sequences, and particularly those that are longer than the longest documents in the training dataset. I.e., the rationale here could be that no rotation is better than a “bad” or “too extreme” rotation that the model hasn’t seen before in training.

> **译：** 我猜测这能避免长序列（尤其长于训练集中最长文档的那些序列）出现「过多」旋转。也就是说，这里的考量可能是：不旋转好过一种模型在训练中从未见过的「糟糕」或「过于极端」的旋转。

## 14. Kimi Linear

There’s recently been a revival in linear attention mechanisms to improve the efficiency of LLMs.

> **译：** 近期，为提升 LLM 效率，线性注意力机制出现了复兴。

The attention mechanism introduced in the Attention Is All You Need paper (2017), aka scaled-dot-product attention, remains the most popular attention variant in today’s LLMs. Besides traditional multi-head attention, it’s also used in the more efficient flavors like grouped-query attention, sliding window attention, and multi-head latent attention.

> **译：** 《Attention Is All You Need》（2017）中提出的注意力机制，即缩放点积注意力，仍是当今 LLM 中最流行的注意力变体。除了传统的多头注意力，它也用于分组查询注意力、滑动窗口注意力、多头潜在注意力等更高效的变体。

### 14.1 Traditional Attention and Quadratic Costs

The original attention mechanism scales quadratically with the sequence length:
Attention(Q, K, V) = softmax(QKᵀ / √d) · V

> **译：** 原始注意力机制随序列长度呈二次方增长：
> Attention(Q, K, V) = softmax(QKᵀ / √d) · V

This is because the query (Q), key (K), and value (V) are *n*-by-*d* matrices, where *d* is the embedding dimension (a hyperparameter) and *n* is the sequence length (i.e., the number of tokens).

> **译：** 这是因为查询（Q）、键（K）、值（V）都是 *n*×*d* 矩阵，其中 *d* 是嵌入维度（一个超参），*n* 是序列长度（即 token 数）。

You can find more details on attention in my other article: [Understanding and Coding Self-Attention, Multi-Head Attention, Causal-Attention, and Cross-Attention in LLMs](https://magazine.sebastianraschka.com/p/understanding-and-coding-self-attention)

> **译：** 关于注意力更多细节，可参看我的另一篇文章：[理解并实现 LLM 中的自注意力、多头注意力、因果注意力与交叉注意力](https://magazine.sebastianraschka.com/p/understanding-and-coding-self-attention)

![Figure 40: Illustration of the quadratic cost in attention due to sequence length *n*.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-41-illustration-quadratic-cost-attention-due.png)

### 14.2 Linear attention

Linear attention variants have been around for a long time, and I remember seeing tons of papers in the 2020s. For example, one of the earliest I recall is the 2020 [Transformers are RNNs: Fast Autoregressive Transformers with Linear Attention](https://arxiv.org/abs/2006.16236) paper, where the researchers approximated the attention mechanism:
Attention(Q, K, V) = softmax(QKᵀ / √d) · V ≈ φ(Q)(φ(K)ᵀV)

> **译：** 线性注意力变体由来已久，我记得 2020 年代见过大量论文。例如，我印象中较早的一篇是 2020 年的 [Transformers are RNNs: Fast Autoregressive Transformers with Linear Attention](https://arxiv.org/abs/2006.16236) 论文，研究者对注意力机制做了近似：
> Attention(Q, K, V) = softmax(QKᵀ / √d) · V ≈ φ(Q)(φ(K)ᵀV)

Here, φ(·) is a kernel feature function, set to φ(x) = elu(x) + 1 .

> **译：** 这里 φ(·) 是核特征函数，取 φ(x) = elu(x) + 1。

This approximation is efficient because it avoids explicitly computing the n \times n attention matrix QK^T . Instead of performing all pairwise token interactions (which cost O(n^2d) time and memory).

> **译：** 这一近似之所以高效，是因为它避免了显式计算 n×n 注意力矩阵 QK^T，不必执行所有 token 两两交互（那需 O(n²d) 时间和内存）。

I don’t want to dwell too long on these older attempts. But the bottom line was that they reduced both time and memory complexity from O(n^2) to O(n) to making attention much more efficient for long sequences.

> **译：** 我不想在这些早期尝试上着墨过多。但结论是它们把时间和内存复杂度从 O(n²) 降到 O(n)，使注意力对长序列高效得多。

However, they never really gained traction as they degraded the model accuracy, and I have never really seen one of these variants applied in an open-weight state-of-the-art LLM.

> **译：** 然而，它们从未真正流行起来，因为会降低模型精度，而且我也从未真正见过这些变体被用于开源权重的最先进 LLM。

### 14.3 Linear Attention Revival

In the second half of this year, there was a bit of a revival of linear attention variants. The first notable model was [MiniMax-M1](https://arxiv.org/abs/2506.13585) with lightning attention, a 456B parameter mixture-of-experts (MoE) model with 46B active parameters, which came out back in June.

> **译：** 今年下半年，线性注意力变体略有复兴。第一个值得关注的模型是 [MiniMax-M1](https://arxiv.org/abs/2506.13585)，使用 lightning attention，一个 4560 亿参数的混合专家（MoE）模型、活跃参数 460 亿，于 6 月问世。

Then, in August, the Qwen3 team followed up with Qwen3-Next, which I discussed in more detail above. Then, in September, the DeepSeek Team announced DeepSeek V3.2. All three models (MiniMax-M1, Qwen3-Next, DeepSeek V3.2) replace the traditional quadratic attention variants in most or all of their layers with efficient linear variants.

> **译：** 接着 8 月，Qwen3 团队推出 Qwen3-Next（上文已详述）。然后 9 月，DeepSeek 团队发布 DeepSeek V3.2。这三个模型（MiniMax-M1、Qwen3-Next、DeepSeek V3.2）都在其大多数或全部层中，用高效的线性变体取代了传统的二次注意力变体。

Interestingly, there was a recent plot twist, where the MiniMax team released their new 230B parameter M2 model (discussed in section 13) without linear attention, going back to regular attention. The team stated that linear attention is tricky in production LLMs. It seemed to work fine with regular prompts, but it had poor accuracy in reasoning and multi-turn tasks, which are not only important for regular chat sessions but also agentic applications.

> **译：** 有趣的是，近期出现了反转：MiniMax 团队发布新的 2300 亿参数 M2 模型（见第 13 节）时却没有用线性注意力，回归了常规注意力。团队表示线性注意力在量产 LLM 中很棘手。它在常规提示下似乎工作良好，但在推理和多轮任务上精度较差——而这些不仅对常规聊天会话重要，对 agent 式应用也重要。

This could have been a turning point where linear attention may not be worth pursuing after all. However, it gets more interesting. In October, the Kimi team released their new [Kimi Linear](https://arxiv.org/abs/2510.26692) model with linear attention.

> **译：** 这本可能成为一个转折点，让人认为线性注意力终究不值得追求。然而事情更有意思：10 月，Kimi 团队发布了使用线性注意力的新 [Kimi Linear](https://arxiv.org/abs/2510.26692) 模型。

![Figure 41: An overview of the linear attention hybrid architectures.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-42-overview-linear-attention-hybrid-architectures.png)

Side note: I could have grouped Qwen3-Next and Kimi Linear with the other transformer-state space model (SSM) hybrids in the overview figure. Personally, I see these other transformer-SSM hybrids as SSMs with transformer components, whereas I see the models discussed here (Qwen3-Next and Kimi Linear) as transformers with SSM components. However, since I have listed IBM Granite 4.0 and NVIDIA Nemotron Nano 2 in the transformer-SSM box, an argument could be made for putting them into a single category.

> **译：** 旁注：我本可在概览图中把 Qwen3-Next 和 Kimi Linear 与其他 transformer-状态空间模型（SSM）混合体归在一起。我个人把那些 transformer-SSM 混合体视为「带 transformer 组件的 SSM」，而把此处讨论的模型（Qwen3-Next 和 Kimi Linear）视为「带 SSM 组件的 transformer」。不过既然我已把 IBM Granite 4.0 和 NVIDIA Nemotron Nano 2 列在 transformer-SSM 框里，也可以论证把它们归入单一类别。

### 14.4 Kimi Linear vs. Qwen3-Next

Kimi Linear shares several structural similarities with Qwen3-Next. Both models rely on a hybrid attention strategy. Concretely, they combine lightweight linear attention with heavier full attention layers. Specifically, both use a 3:1 ratio, meaning for every three transformer blocks employing the linear Gated DeltaNet variant, there’s one block that uses full attention as shown in the figure below.

> **译：** Kimi Linear 与 Qwen3-Next 在结构上有若干相似之处。两者都依赖混合注意力策略：将轻量线性注意力与较重的全注意力层结合。具体而言，两者都用 3:1 比例——即每 3 个采用线性 Gated DeltaNet 变体的 transformer 块，就有 1 个采用全注意力的块，如下图所示。

![Figure 42: Qwen3-Next and Kimi Linear side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-43-qwen3-next-kimi-linear-side.png)

Gated DeltaNet is a linear attention variant with inspiration from recurrent neural networks, including a gating mechanism from the [Gated Delta Networks: Improving Mamba2 with Delta Rule](https://arxiv.org/abs/2412.06464) paper. In a sense, Gated DeltaNet is a DeltaNet with Mamba-style gating, and DeltaNet is a linear attention mechanism. Due to the overview-nature of this article, DeltaNet would be good topic for a separate article in the future.

> **译：** Gated DeltaNet 是一种线性注意力变体，灵感来自循环神经网络，包含来自 [Gated Delta Networks: Improving Mamba2 with Delta Rule](https://arxiv.org/abs/2412.06464) 论文的门控机制。某种意义上，Gated DeltaNet 是带 Mamba 式门控的 DeltaNet，而 DeltaNet 是一种线性注意力机制。鉴于本文的概览性质，DeltaNet 适合日后另起一篇详述。

Note that the omission of the RoPE box in the Kimi Linear part of the figure above is intentional. Kimi applies NoPE (No Positional Embedding) in multi-head latent attention MLA) layers (global attention). As the authors state, this lets MLA run as pure multi-query attention at inference and avoids RoPE retuning for long‑context scaling (the positional bias is supposedly handled by the Kimi Delta Attention blocks). For more information on MLA, and multi-query attention, which is a special case of grouped-query attention, please see my [The Big LLM Architecture Comparison](https://magazine.sebastianraschka.com/p/the-big-llm-architecture-comparison) article.

> **译：** 注意上图中 Kimi Linear 部分省略 RoPE 框是故意的。Kimi 在多头潜在注意力（MLA）层（全局注意力）中应用 NoPE（无位置编码）。如作者所言，这让 MLA 在推理时作为纯多查询注意力运行，并避免为长上下文缩放重调 RoPE（位置偏置据称由 Kimi Delta Attention 块处理）。关于 MLA 以及作为分组查询注意力特例的多查询注意力的更多信息，请见我的[《大型 LLM 架构对比》](https://magazine.sebastianraschka.com/p/the-big-llm-architecture-comparison)一文。

**In addition, I’ve written more about Gated DeltaNet [here](https://sebastianraschka.com/llms-from-scratch/ch04/08_deltanet/).**

> **译：** **此外，我[在此](https://sebastianraschka.com/llms-from-scratch/ch04/08_deltanet/)更多写了关于 Gated DeltaNet 的内容。**

### 14.5 Kimi Delta Attention

Kimi Linear modifies the linear attention mechanism of Qwen3-Next by the Kimi Delta Attention (KDA) mechanism, which is essentially a refinement of Gated DeltaNet. Whereas Qwen3-Next applies a scalar gate (one value per attention head) to control the memory decay rate, Kimi Linear replaces it with a channel-wise gating for each feature dimension. According to the authors, this gives more control over the memory, and this, in turn, improves long-context reasoning.

> **译：** Kimi Linear 通过 Kimi Delta Attention（KDA）机制修改了 Qwen3-Next 的线性注意力机制，KDA 本质上是 Gated DeltaNet 的改良。Qwen3-Next 用一个标量门控（每个注意力头一个值）控制记忆衰减率，而 Kimi Linear 将其替换为对每个特征维度的逐通道门控。据作者称，这能对记忆给予更精细的控制，进而改善长上下文推理。

In addition, for the full attention layers, Kimi Linear replaces Qwen3-Next’s gated attention layers (which are essentially standard multi-head attention layers with output gating) with Multi-Head Latent Attention (MLA). This is the same MLA mechanism we discussed earlier in the DeepSeek V3/R1 section but with an additional gate. (To recap, MLA compresses the key/value space to reduce the KV cache size.)

> **译：** 此外，对于全注意力层，Kimi Linear 用多头潜在注意力（MLA）替换了 Qwen3-Next 的 gated attention 层（后者本质上是带输出门控的标准多头注意力层）。这与我们前文 DeepSeek V3/R1 节讨论的 MLA 机制相同，只是多了一个门控。（回顾一下，MLA 压缩键/值空间以减小 KV cache 体积。）

There’s no direct comparison to Qwen3-Next, but compared to the Gated DeltaNet-H1 model from the Gated DeltaNet paper (which is essentially Gated DeltaNet with sliding-window attention), Kimi Linear achieves higher modeling accuracy while maintaining the same token-generation speed.

> **译：** 没有与 Qwen3-Next 的直接对比，但相比 Gated DeltaNet 论文中的 Gated DeltaNet-H1 模型（本质上是带滑动窗口注意力的 Gated DeltaNet），Kimi Linear 在保持相同 token 生成速度的同时取得了更高的建模精度。

![Figure 43: Annotated figure from the Kimi Linear paper showing that Kimi Linear is as fast as GatedDeltaNet, and much faster than an architecture with multi-head latent attention (like DeepSeek V3/R1), while having a higher benchmark performance.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-44-annotated-figure-kimi-linear-paper.png)

Furthermore, according to the ablation studies in the [DeepSeek-V2 paper](https://arxiv.org/abs/2405.04434), MLA is on par with regular full attention when the hyperparameters are carefully chosen.

> **译：** 此外，据 [DeepSeek-V2 论文](https://arxiv.org/abs/2405.04434)中的消融研究，在精心选择超参时，MLA 与常规全注意力相当。

And the fact that Kimi Linear compares favorably to MLA on long-context and reasoning benchmarks makes linear attention variant once again promising for larger state-of-the-art models. That being said, Kimi Linear is 48B-parameter large, but it’s 20x smaller than Kimi K2. It will be interesting to see if the Kimi team adopts this approach for their upcoming K3 model.

> **译：** 而 Kimi Linear 在长上下文和推理基准上对比 MLA 表现良好，使线性注意力变体再次对大型最先进模型显得有前景。话虽如此，Kimi Linear 有 480 亿参数，但比 Kimi K2 小 20 倍。且看 Kimi 团队是否会为即将到来的 K3 模型采用此方案。

## 15. Olmo 3 Thinking

Allen AI [released their new Olmo 3](https://allenai.org/blog/olmo3) 7B and 32B models on November 20. (The official spelling was changed from OLMo to Olmo, so I will be adopting that in this section.)

> **译：** Allen AI 于 11 月 20 日[发布了新的 Olmo 3](https://allenai.org/blog/olmo3) 7B 和 32B 模型。（官方拼写从 OLMo 改为 Olmo，本节随之采用。）

As mentioned earlier, Olmo models are always interesting because they are fully open-source. Here, that means that the team also shares [detailed training reports](https://www.datocms-assets.com/64837/1763662397-1763646865-olmo_3_technical_report-1.pdf), multiple checkpoints, information about the training data, and so forth. In other words, Olmo models are fully transparent.

> **译：** 如前所述，Olmo 模型总是因其完全开源而值得关注。这里意味着团队还共享了[详尽的训练报告](https://www.datocms-assets.com/64837/1763662397-1763646865-olmo_3_technical_report-1.pdf)、多个检查点、训练数据信息等。换言之，Olmo 模型完全透明。

This time, the Olmo suite also comes in an additional reasoning model flavor (next to base and instruct models), and there are lots of interesting details about the training in Olmo 3’s [technical report](https://www.datocms-assets.com/64837/1763662397-1763646865-olmo_3_technical_report-1.pdf). However, since this is an article about architectural comparisons, this section focuses only on Olmo 3’s architecture.

> **译：** 这次 Olmo 系列还多了一个推理模型变体（在 base 和 instruct 模型之外），Olmo 3 的[技术报告](https://www.datocms-assets.com/64837/1763662397-1763646865-olmo_3_technical_report-1.pdf)中有大量有趣的训练细节。不过由于本文是架构对比，本节只聚焦 Olmo 3 的架构。

The closest model to compare Olmo 3 to would be Qwen3, as the Qwen3 series has two models of similar size, and the Qwen3 models have a similar performance.

> **译：** 与 Olmo 3 最具可比性的模型当属 Qwen3，因为 Qwen3 系列有两个尺寸相近的模型，且性能相似。

First, let’s take a look at the smaller of the two, Olmo 3 7B.

> **译：** 先看两者中较小的那个，Olmo 3 7B。

![Figure 44: Olmo 3 7B and Qwen3 8B side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-45-olmo-3-7b-qwen3-8b.png)

As we can see, the Olmo 3 architecture is relatively similar to Qwen3. However, it’s worth noting that this is essentially likely inspired by the Olmo 2 predecessor, not Qwen3.

> **译：** 可见 Olmo 3 架构与 Qwen3 较为相似。但值得注意的是，它本质上更可能是受前代 Olmo 2 启发，而非 Qwen3。

Similar to Olmo 2, Olmo 3 still uses post-norm instead of pre-norm, as they found in the Olmo 2 paper that it stabilizes the training.

> **译：** 与 Olmo 2 一样，Olmo 3 仍使用 post-norm 而非 pre-norm，因为他们在 Olmo 2 论文中发现这能稳定训练。

Interestingly, the 7B model still uses multi-head attention similar to Olmo 2. However, to make things more efficient and shrink the KV cache size, they now use sliding window attention (e.g., similar to Gemma 3).

> **译：** 有趣的是，7B 模型仍像 Olmo 2 一样使用多头注意力。但为提升效率、缩小 KV cache，他们现在使用了滑动窗口注意力（如类似 Gemma 3）。

Next, let’s look at the 32B model.

> **译：** 接着看 32B 模型。

![Figure 45: Olmo 3 32B and Qwen3 32B side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-46-olmo-3-32b-qwen3-32b.png)

Overall, it’s the same architecture but just scaled up. Also, the proportions (e.g., going from the input to the intermediate size in the feed forward layer, and so on) roughly match the ones in Qwen3.

> **译：** 整体上架构相同，只是放大了。而且各项比例（如前馈层从输入到中间尺寸的扩展等）大致与 Qwen3 一致。

My guess is the architecture was initially somewhat smaller than Qwen3 due to the smaller vocabulary, and they then scaled up the intermediate size expansion from 5x in Qwen 3 to 5.4 in Olmo 3 to have a 32B model for a direct comparison.

> **译：** 我猜测，由于词表更小，该架构最初比 Qwen3 略小，随后他们把中间尺寸的扩展比从 Qwen3 的 5 倍放大到 Olmo 3 的 5.4 倍，以得到一个可直接对比的 32B 模型。

Also, note that the 32B model uses grouped query attention.

> **译：** 另外注意，32B 模型使用分组查询注意力。

Perhaps a last small detail is that Olmo 3 uses YaRN for context extension for the supported context length of 64k, but only for the global (non-sliding-window-attention) layers. ([YaRN](https://arxiv.org/abs/2309.00071) is essentially a careful RoPE rescaling technique, which helps preserve model quality better at long context sizes.)

> **译：** 或许最后一个细节：Olmo 3 在支持的 64k 上下文长度上用 YaRN 做上下文扩展，但仅用于全局（非滑动窗口注意力）层。（[YaRN](https://arxiv.org/abs/2309.00071) 本质上是一种谨慎的 RoPE 重缩放技术，有助于在长上下文规模下更好保持模型质量。）

In Qwen3, YaRN is optional to extend the native context from 32k tokens to 131k tokens.

> **译：** 在 Qwen3 中，YaRN 是可选的，用于把原生上下文从 32k token 扩展到 131k token。

If you are interested in additional architecture details, I implemented Olmo 3 from scratch in a standalone notebook [here](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/13_olmo3/standalone-olmo3.ipynb).

> **译：** 若对更多架构细节感兴趣，我在[此处](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/13_olmo3/standalone-olmo3.ipynb)用独立 notebook 从零实现了 Olmo 3。

![Figure 46: [Olmo 3 from-scratch implementation](https://github.com/rasbt/LLMs-from-scratch/blob/main/ch05/13_olmo3/standalone-olmo3.ipynb)](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-47-olmo-3-scratch-implementation-https.png)

## 16. DeepSeek V3.2

This article started with DeepSeek V3, which was released back in December 2024. There have been multiple DeepSeek releases back then, but I largely skipped them as they were not big flagship-model releases like DeepSeek V3 and DeepSeek R1.

> **译：** 本文始于 DeepSeek V3（2024 年 12 月发布）。当时 DeepSeek 有过多次发布，但我大多略过了，因为它们不像 DeepSeek V3 和 DeepSeek R1 那样是重大的旗舰模型发布。

![Figure 47: A timeline of the DeepSeek model releases since DeepSeek V3. The main models are shown in red.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-48-timeline-deepseek-model-releases-since.png)

However, DeepSeek V3.2 was a really big release as it is on par with the current GPT-5.1 and Gemini 3.0 Pro models on certain benchmarks.

> **译：** 然而 DeepSeek V3.2 是一次真正重大的发布，它在某些基准上与当前的 GPT-5.1 和 Gemini 3.0 Pro 模型相当。

The architecture is overall similar to DeepSeek V3 but they added a sparse attention mechanism to improve efficiency.

> **译：** 架构整体与 DeepSeek V3 相似，但他们加入了一种稀疏注意力机制以提升效率。

![Figure 48: The DeepSeek model architecture with multi-head latent and sparse attention.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-49-deepseek-model-architecture-multi-head.png)

I originally planned to write a short section about DeepSeek V3.2 for this article, but it turned into a >5000 word write-up, so I moved it to a separate article, which I linked below: [A Technical Tour of the DeepSeek Models from V3 to V3.2](https://magazine.sebastianraschka.com/p/technical-deepseek)

> **译：** 我原本打算为本文写一小节关于 DeepSeek V3.2，但写成了 5000 多字，于是移到单独一篇文章，链接如下：[从 V3 到 V3.2 的 DeepSeek 模型技术之旅（A Technical Tour of the DeepSeek Models from V3 to V3.2）](https://magazine.sebastianraschka.com/p/technical-deepseek)

## 17. Mistral 3

On December 2, 2025, one day after the DeepSeek V3.2 release, the Mistral team released their new [Mistral 3](https://mistral.ai/news/mistral-3) model suite. This includes three smaller dense models (3B, 8B, and 14B) under the Ministral 3 name, as well as their new Mistral 3 Large flagship model, which is a 675B parameter MoE (with 41B parameters active). More specifically, the Mistral 3 Large model consists of

> **译：** 2025 年 12 月 2 日，DeepSeek V3.2 发布次日，Mistral 团队发布了新的 [Mistral 3](https://mistral.ai/news/mistral-3) 模型套件。包括 Ministral 3 名下三个较小的稠密模型（3B、8B、14B），以及新的 Mistral 3 Large 旗舰模型——一个 6750 亿参数的 MoE（活跃参数 410 亿）。具体而言，Mistral 3 Large 模型由以下部分组成：

- An MoE Language Model with 673B params and 39B active
- A 2.5B Vision Encoder

> **译：**
> - 一个 673B 参数、39B 活跃的 MoE 语言模型
> - 一个 2.5B 的视觉编码器

(Since this article focuses on the LLM aspects, we will ignore the vision encoder in this section. I should perhaps update my [multimodal LLMs article](https://magazine.sebastianraschka.com/p/understanding-multimodal-llms) sometime, though.)

> **译：**（由于本文聚焦 LLM 层面，本节将忽略视觉编码器。不过我也许该更新我的[多模态 LLM 文章](https://magazine.sebastianraschka.com/p/understanding-multimodal-llms)。）

First, it’s interesting to note that it’s Mistral’s first MoE since Mixtral in 2023 (earlier in this article, I wrote that Mistral abandoned MoEs, and DeepSeek V3 last year ushered in an MoE revival).

> **译：** 首先，有趣的是这是 Mistral 自 2023 年 Mixtral 以来的首个 MoE（本文前面我写过 Mistral 放弃了 MoE，而去年 DeepSeek V3 引领了 MoE 复兴）。

The release blog article says that all model sizes come in base, instruct, and reasoning variants, which is nice. However, their reasoning version of their 675B model is not available yet.

> **译：** 发布博文称所有尺寸都有 base、instruct 和 reasoning 变体，这很好。不过其 675B 模型的 reasoning 版本尚未发布。

Another interesting tidbit is that Mistral partnered with NVIDIA here to optimize tokens/sec throughput on Blackwell chips, [according to their announcement](https://mistral.ai/news/mistral-3). This is nice because it means the Ministral models will run a bit faster than comparable models on my little DGX Spark (I still have to test this).

> **译：** 另一个有趣细节：据其[公告](https://mistral.ai/news/mistral-3)，Mistral 此处与 NVIDIA 合作，优化了 Blackwell 芯片上的 token/秒吞吐。好处是 Ministral 模型在我那台小 DGX Spark 上会比可比模型跑得稍快（我还没测）。

Besides the token/sec speed advantage of Mistral 3, based on quality benchmarks, though their smaller models, Ministral, look on par with Qwen3. The larger flagship model is on par with DeepSeek V3.1.

> **译：** 除了 token/秒的速度优势，从质量基准看，Mistral 3 较小的 Ministral 模型与 Qwen3 相当。更大的旗舰模型与 DeepSeek V3.1 相当。

Since the release of Mistral 3 was just one day after DeepSeek V3.2’s release, they didn’t include any V3.2 comparisons in their article (except for the LMArena Elo score, where DeepSeek V3.2 is slightly ahead with 1423 vs 1418).

> **译：** 由于 Mistral 3 发布距 DeepSeek V3.2 仅一天，其文章中没有 V3.2 的对比（除 LMArena Elo 分数外，DeepSeek V3.2 以 1423 比 1418 略微领先）。

Unfortunately, it’s not possible to do an apples-to-apples comparison right now, because Mistral 3 Large currently doesn’t have a reasoning model, and DeepSeek V3.2 didn’t share the benchmark results for their non-thinking mode, but in case you are curious, I overlaid the DeepSeek V3.2-Thinking numbers (from the [DeepSeek V3.2 report](https://arxiv.org/abs/2512.02556)) with the Mistral 3 Large benchmark chart.

> **译：** 遗憾的是现在无法做同口径对比，因为 Mistral 3 Large 目前没有 reasoning 模型，而 DeepSeek V3.2 未公开其非 thinking 模式的基准结果。但若你好奇，我把 DeepSeek V3.2-Thinking 的数据（取自 [DeepSeek V3.2 报告](https://arxiv.org/abs/2512.02556)）叠加到了 Mistral 3 Large 基准图上。

![Figure 49: Mistral 3 Large benchmarks from the [Mistral 3 announcement](https://mistral.ai/news/mistral-3), with the DeepSeek V3.2 results (from the [DeepSeek V3.2 paper](https://arxiv.org/abs/2512.02556)) overlayed on top of it.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-50-mistral-3-large-benchmarks-mistral.png)

Looking at the Mistral Large 3 Instruct model with the DeepSeek V3.2-Thinking model next to it (numbers are from the DeepSeek V3.2 paper), the V3.2-Thinking model is obviously much better. So, I am staying tuned for the Mistral 3 Large Thinking release and look forward to seeing the updated plot!

> **译：** 把 Mistral Large 3 Instruct 模型与 DeepSeek V3.2-Thinking 模型并排看（数字取自 DeepSeek V3.2 论文），V3.2-Thinking 显然好得多。因此我持续关注 Mistral 3 Large Thinking 的发布，期待看到更新后的图！

So, right now, I would say that, thanks to the optimizations, Mistral 3 Large is a great candidate for cost-effective, low-latency deployments. DeepSeek V3.2-Thinking is great if you want to maximize answer quality. Another selling point of Mistral 3 Large is that it offers multimodal support as well (DeepSeek V3.2 is text-only).

> **译：** 所以当下我会说：得益于这些优化，Mistral 3 Large 是高性价比、低延迟部署的优秀候选。若追求回答质量最大化，DeepSeek V3.2-Thinking 很好。Mistral 3 Large 的另一个卖点是它也提供多模态支持（DeepSeek V3.2 仅文本）。

By the way, my focus on DeepSeek V3.2 here in this section comes from the fact that the models were released so close to each other, within a day of each other. Plus, they have an almost identical size, 671B and 673B, which makes for an interesting comparison!

> **译：** 顺便一提，本节聚焦 DeepSeek V3.2 是因为这两个模型发布时间挨得太近，前后相差一天。加上它们尺寸几乎相同（671B 与 673B），使得对比很有意思！

Unfortunately, there is no technical report. that contains more information about the model development. However, since it’s an open-weight model, we do have the model weights [on Hugging Face hub to analyze](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4/blob/main/params.json), though. So, let’s take a closer look at Mistral 3 Large.

> **译：** 遗憾的是没有包含更多模型开发信息的技术报告。不过既然是开源权重模型，我们有 [Hugging Face hub 上的模型权重可供分析](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512-NVFP4/blob/main/params.json)。那么，我们来细看 Mistral 3 Large。

As it turns out, Mistral 3 Large is exactly the same architecture as DeepSeek V3 and V3.1! The only difference is that they increased the size of the experts by a factor of 2 while decreasing the number of experts by the same factor.

> **译：** 结果发现，Mistral 3 Large 与 DeepSeek V3 和 V3.1 的架构完全相同！唯一区别是他们把专家尺寸放大了 2 倍，同时把专家数量缩小了相同倍数。

![Figure 50: DeepSeek V3 and Mistral 3 Large side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-51-deepseek-v3-mistral-3-large.png)

However, while it’s effectively the same architecture, it is likely the Mistral team trained Mistral 3 from scratch rather than initializing it from DeepSeek V3 and further training it, because Mistral uses its own tokenizer.

> **译：** 然而，尽管实质是相同架构，Mistral 团队很可能是从零训练了 Mistral 3，而非从 DeepSeek V3 初始化后继续训练，因为 Mistral 用的是自家 tokenizer。

Next to Kimi K2, Mistral 3 is now the second model series to use the DeepSeek V3 architecture. However, where the Kimi K2 team scaled up the model size from 671B to 1 trillion, the Mistral 3 team only changed the expert size ratio and added a vision encoder for multimodal support. But yes, why not? I think DeepSeek V3 is a pretty solid architecture design, plus it has these nice MoE and MLA efficiency aspects to it. So, why change what ain’t broke? A lot of the secret sauce these days is in the training pipeline as well as the inference scaling strategies.

> **译：** 继 Kimi K2 之后，Mistral 3 如今是第二个使用 DeepSeek V3 架构的模型系列。不过 Kimi K2 团队把模型尺寸从 671B 放大到 1 万亿，而 Mistral 3 团队只改了专家尺寸比例并增加视觉编码器以支持多模态。但有何不可呢？我认为 DeepSeek V3 是相当扎实的架构设计，又有 MoE 和 MLA 这些高效之处。既然没坏，何必改？如今很多秘方都在训练流程和推理扩展策略上。

## 18. Nemotron 3 Nano and Super

This article is not an exhaustive list of all LLMs out there. To keep it manageable, I am focusing on the main highlights. Here, “highlights” means that they are either very popular, perform very well, or have an interesting architecture component.

> **译：** 本文并非所有 LLM 的详尽清单。为控制篇幅，我只聚焦主要亮点。此处「亮点」指它们要么很流行、要么性能很强、要么有有趣的架构组件。

That being said, it’s time to finally add one of NVIDIA’s models to this list. NVIDIA [just released](https://www.google.com/search?client=safari&rls=en&q=nemotron+3&ie=UTF-8&oe=UTF-8) their newest entry in the Nemotron series, Nemotron 3, on December 15th, 2025. What’s nice about Nemotron is, is that it doesn’t come with just the open weights and a [technical report](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Nano-Technical-Report.pdf), but NVIDIA also shares the [dataset](https://huggingface.co/nvidia/datasets?search=nemotron&p=0) and [training code](https://huggingface.co/datasets/nvidia/Nemotron-Pretraining-Code-v2) similar to Olmo 3.

> **译：** 话虽如此，终于该把 NVIDIA 的一个模型加入清单了。NVIDIA 于 2025 年 12 月 15 日[发布](https://www.google.com/search?client=safari&rls=en&q=nemotron+3&ie=UTF-8&oe=UTF-8)了 Nemotron 系列的最新成员 Nemotron 3。Nemotron 的可取之处在于，它不仅提供开源权重和[技术报告](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Nano-Technical-Report.pdf)，NVIDIA 还像 Olmo 3 一样共享了[数据集](https://huggingface.co/nvidia/datasets?search=nemotron&p=0)和[训练代码](https://huggingface.co/datasets/nvidia/Nemotron-Pretraining-Code-v2)。

According to the [announcement article](https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models), Nemotron 3 comes in three sizes:

> **译：** 据[公告文章](https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models)，Nemotron 3 有三个尺寸：

1. Nano (30B-A3B),

2. Super (100B), (later, this was updated to 120B, see section 18.1)

3. and Ultra (500B).

> **译：**
> 1. Nano（30B-A3B），
> 2. Super（100B），（后来更新为 120B，见 18.1 节）
> 3. 和 Ultra（500B）。

### 18.1 Nemotron 3 Nano

Architecture-wise, the models are a Mixture-of-Experts (MoE) Mamba-Transformer hybrid architecture. As of this writing (Dec 17), only the Nano model has been released as open-weight model, so the discussion below will focus on it, as illustrated in the figure below.

> **译：** 架构上，这些模型是混合专家（MoE）Mamba-Transformer 混合架构。截至写作时（12 月 17 日），只有 Nano 模型作为开源权重发布，故下文讨论聚焦于它，如下图所示。

![Figure 51.1: Outline of the Nemotron 3 Nano model, which is a Transformer-Mamba hybrid.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-52-1-outline-nemotron-3-nano.png)

As illustrated above, Nemotron 3 Nano (30B-A3B) is a 52-layer hybrid Mamba-Transformer model that interleaves [Mamba-2](https://arxiv.org/abs/2405.21060) sequence-modeling blocks with sparse Mixture-of-Experts (MoE) feed-forward layers, and uses self-attention only in a small subset of layers.

> **译：** 如上所示，Nemotron 3 Nano（30B-A3B）是一个 52 层的 Mamba-Transformer 混合模型，将 [Mamba-2](https://arxiv.org/abs/2405.21060) 序列建模块与稀疏混合专家（MoE）前馈层交错排列，且仅在少数层中使用自注意力。

Regarding the MoE modules, each MoE layer contains 128 experts but activates only 1 shared and 6 routed experts per token.

> **译：** 关于 MoE 模块，每个 MoE 层包含 128 个专家，但每个 token 仅激活 1 个共享专家和 6 个路由专家。

The Mamba-2 layers would take a whole article itself to explain (perhaps a topic for another time). But for now, conceptually, you can think of them as similar to the Gated DeltaNet approach that Qwen3-Next and Kimi-Linear use, which I introduced above. You can also read more about it in my other Beyond Standard LLMs article: [Beyond Standard LLMs](https://magazine.sebastianraschka.com/p/beyond-standard-llms)

> **译：** 要解释 Mamba-2 层得另起整篇（也许留待日后再谈）。但就目前而言，概念上可把它们视作与上文介绍的 Qwen3-Next 和 Kimi-Linear 所用 Gated DeltaNet 方案类似。也可在我另一篇 Beyond Standard LLMs 文章中读到更多：[Beyond Standard LLMs](https://magazine.sebastianraschka.com/p/beyond-standard-llms)

The similarity between Gated DeltaNet and Mamba-2 layers is that both replace standard attention with a gated-state-space update. The idea behind this state-space-style module is that it maintains a running hidden state and mixes new inputs via learned gates. In contrast to attention, it scales linearly instead of quadratically with the input sequence length.

> **译：** Gated DeltaNet 与 Mamba-2 层的相似之处在于：两者都用门控状态空间更新取代标准注意力。这种状态空间式模块的思想是维持一个持续的隐藏状态，并通过学习到的门控混合新输入。与注意力不同，它随输入序列长度线性而非二次方地增长。

What’s actually quite exciting about this architecture is its really good performance compared to pure transformer architectures of similar size, while achieving much higher tokens-per-second throughput.

> **译：** 这一架构令人兴奋之处在于：相比相似尺寸的纯 transformer 架构，它性能相当好，同时 token/秒吞吐高得多。

Overall, this is an interesting direction, even more extreme than Qwen3-Next and Kimi-Linear in its use of only a few attention layers. However, one of the strengths of the transformer architecture is its performance at a (really) large scale. I am curious to see how Nemotron 3 Super and especially Ultra will compare to the likes of DeepSeek V3.2.

> **译：** 总体而言，这是一个有趣的方向，甚至比 Qwen3-Next 和 Kimi-Linear 更极端，只用了寥寥几层注意力。然而 transformer 架构的优势之一在于（真正）大规模下的性能。我很好奇 Nemotron 3 Super、尤其是 Ultra 与 DeepSeek V3.2 之流相比会如何。

### 18.2 Nemotron 3 Super

On March 11, 2026, NVIDIA now also released the 120B Super version as [open-weight models](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16) on the Hugging Face Hub alongside a nice new “[Super”-focused technical report](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Super-Technical-Report.pdf).

> **译：** 2026 年 3 月 11 日，NVIDIA 又把 120B 的 Super 版本作为[开源权重模型](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16)发布到 Hugging Face Hub，并附上一篇不错的、聚焦「Super」的新[技术报告](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Super-Technical-Report.pdf)。

Compared to the Nano model, besides scaling the architecture, there are two main modifications to the architecture.

> **译：** 与 Nano 模型相比，除了放大架构，还有两处主要改动。

First Nemotron 3 Super uses [Multi-Token Prediction (MTP)](https://arxiv.org/abs/2404.19737), which is a technique that trains the LLM to predict multiple future tokens at each step, rather than a single one.

> **译：** 首先，Nemotron 3 Super 使用[多 token 预测（MTP）](https://arxiv.org/abs/2404.19737)，这是一种训练 LLM 在每步预测多个未来 token 而非单个 token 的技术。

Instead of training the model only with the standard next-token objective, MTP also trains it to predict multiple future token offsets from the same position. This provides a richer training signal and, according to the Super report, improves both modeling quality and inference efficiency.

> **译：** MTP 不只用标准下一 token 目标训练模型，还训练它从同一位置预测多个未来 token 偏移。这提供了更丰富的训练信号，据 Super 报告，能同时提升建模质量和推理效率。

![Figure 51.2: Multi-Token Prediction versus regular next token prediction. (Left subfigure inspired by the [MTP paper](https://arxiv.org/abs/2404.19737).) Originally, MTP was only used during training, not inference; hence, the inference time steps (bottom) show a single next-token prediction.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-53-2-multi-token-prediction-versus.png)

A key difference from the standard uses of MTP (which I've drawn in figure 51.2 above) is that Nemotron 3 Super does not use it only during training.

> **译：** 与 MTP 的标准用法（我已在上方 Figure 51.2 中画出）的一个关键不同是：Nemotron 3 Super 并非仅在训练时使用它。

The Nemotron 3 Super explicitly uses MTP at inference time as well, where the shared-weight MTP head acts as an internal draft model for native speculative decoding. During generation, the model can then propose candidate continuations and then verify them with the main model. This reduces inference latency without needing a separate external draft model.

> **译：** Nemotron 3 Super 在推理时也明确使用 MTP，其中共享权重的 MTP 头充当内部草稿模型，用于原生投机解码。生成时，模型可提出候选续写，再用主模型验证。这降低了推理延迟，无需单独的外部草稿模型。

Since this is not quite standard MTP, it is perhaps more accurate to describe Nemotron 3 Super as using shared-weight MTP for speculative decoding than to call it something like “MTP-3” like in other architectures (like Step 3.5 Flash, which I covered [here](https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight)).

> **译：** 由于这不完全是标准 MTP，把 Nemotron 3 Super 描述为「用共享权重 MTP 做投机解码」或许比像其他架构那样称之为「MTP-3」更准确（如 Step 3.5 Flash，我在[此处](https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight)讲过）。

The second main difference compared to Nano is that the Super architecture uses latent experts, meaning that the experts operate in latent space (the inputs to the MoE layer are down-projected from 4096 to 1024 dimensions, the experts are applied, and then the outputs are up-projected back from 1024 to 4096 dimensions.

> **译：** 相对 Nano 的第二个主要不同是：Super 架构使用潜在专家（latent experts），即专家在潜在空间中运作（MoE 层的输入从 4096 维下投影到 1024 维，施加专家，再从 1024 维上投影回 4096 维）。

![Figure 51.3: Nemotron 3 Super 120B-A12B with latent MoE layers, multi-token prediction, and the Mamba-2 hybrid attention approach.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-54-3-nemotron-3-super-120b.png)

Benchmark-wise Nemotron 3 Super is on par with Qwen3.5 122B-A10B and GPT-OSS 120B, but the throughput, thanks to the aforementioned “tricks” (MTP, latent MoE, and hybrid attention) is great: 2x faster than Qwen3.5 122B-A10B and (regarding the NVFP4 version) 2.2x faster than GPT-OSS 120B.

> **译：** 基准上，Nemotron 3 Super 与 Qwen3.5 122B-A10B 和 GPT-OSS 120B 相当，但得益于前述「技巧」（MTP、潜在 MoE、混合注意力），吞吐出色：比 Qwen3.5 122B-A10B 快 2 倍，（就 NVFP4 版本而言）比 GPT-OSS 120B 快 2.2 倍。

![Figure 51.4: Nemotron 3 Super benchmark comparison from the [Hugging Face Hub](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16/blob/main/accuracy_chart.png) page.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-55-4-nemotron-3-super-benchmark.png)

## 19. Xiaomi MiMo-V2-Flash

There’s been another impressive entry in December 2025. Xiaomi released their newest Xiaomi MiMo-V2-Flash with impressive benchmark performance matching DeepSeek V3.2, while only having half the parameters and being faster in inference. It’s a 309B Mixture-of-Experts (MoE) model with 15 active parameters per token.

> **译：** 2025 年 12 月还有一个令人印象深刻的发布。小米发布了最新的 Xiaomi MiMo-V2-Flash，基准性能可媲美 DeepSeek V3.2，参数却只有一半，且推理更快。它是一个 309B 的混合专家（MoE）模型，每 token 活跃参数 150 亿。

Interestingly, it uses sliding window attention (SWA) in a 5:1 ratio with global (regular) attention, similar to Gemma 3 (see section 3). However, it uses a much more aggressive sliding window size (128) that is 8 times smaller than Gemma 3 (1024).

> **译：** 有趣的是，它以 5:1 比例将滑动窗口注意力（SWA）与全局（常规）注意力搭配，类似 Gemma 3（见第 3 节）。但它用了激进得多的滑动窗口尺寸（128），比 Gemma 3（1024）小 8 倍。

![Figure 52: Xiaomi MiMo-V2-Flash compared to DeepSeek V3.2, which has similar benchmark performance.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-56-xiaomi-mimo-v2-flash-compared.png)

Based on my knowledge, this is the largest sliding window attention model to date.

> **译：** 据我所知，这是迄今为止最大的滑动窗口注意力模型。

Additionally, the Xiaomi model uses multi-token prediction (MTP), as described earlier in section 12.3.

> **译：** 此外，小米模型使用了多 token 预测（MTP），如前文 12.3 节所述。

## 20. Arcee AI Trinity Large

It’s been a while since the last LLM architecture addition. On January 27, Arcee AI (a company I hadn’t had on my radar up to then) began releasing versions of their open-weight 400B [Trinity Large](https://huggingface.co/collections/arcee-ai/trinity-large) LLMs on the model hub, along with two smaller variants.

> **译：** 距上一次 LLM 架构新增已有一段时日。1 月 27 日，Arcee AI（此前我未曾关注过的公司）开始在 model hub 上发布其开源权重 400B [Trinity Large](https://huggingface.co/collections/arcee-ai/trinity-large) LLM 的各版本，另有两种更小的变体。

Their flagship large model is a 400B param MoE (13B active params). The two smaller variants are Trinity Mini (26B with 3B active parameters) and Trinity Nano (6B with 1B active parameters).

> **译：** 其旗舰大模型是 400B 参数 MoE（活跃参数 130 亿）。两种更小的变体是 Trinity Mini（26B，活跃 30 亿）和 Trinity Nano（6B，活跃 10 亿）。

![Figure 53: Overview of the Trinity Large architecture (based on the model hub [config file](https://huggingface.co/arcee-ai/Trinity-Large-Preview/blob/main/config.json)).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-57-overview-trinity-large-architecture-based.png)

Along with the model weights, Arcee AI also released a nice [technical report](https://github.com/arcee-ai/trinity-large-tech-report) with lots of details.

> **译：** 连同模型权重，Arcee AI 还发布了不错的[技术报告](https://github.com/arcee-ai/trinity-large-tech-report)，内含大量细节。

So, let’s take a closer look at the 400B flagship model. The figure below compares it to the previously discussed GLM 4.5 (section 11), which is perhaps the most similar and is also relatively small. Also, the Trinity technical report showed that the modeling performance of the Trinity Large and GLM-4.5 base models are practically identical (I assume they didn’t compare it to more recent base models because many companies only share their fine-tuned models these days.)

> **译：** 那么细看 400B 旗舰模型。下图把它与前文讨论过的 GLM 4.5（第 11 节）对比，后者或许最相似且也相对较小。而且 Trinity 技术报告显示，Trinity Large 与 GLM-4.5 基座模型的建模性能几乎完全一致（我猜想他们没与更近的基座模型对比，是因为如今许多公司只公开其微调模型。）

![Figure 54: Arcee AI Trinity Large next to GLM 4.5 of a relatively similar size (400B vs 355B).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-58-arcee-ai-trinity-large-next.png)

But as we can see, there are several interesting architectural components added to the Trinity model.

> **译：** 但正如我们所见，Trinity 模型添加了若干有趣的架构组件。

First, there are the alternating local:global (sliding window) attention layers like in Gemma 3, Olmo 3, Xiaomi MiMo, etc., earlier. But instead of using the common 5:1 ratio that Gemma 3 and Xiaomi used, they opted for a 3:1 ratio similar to Olmo 3, and a relatively large sliding window size of 4096 (also similar to Olmo 3).

> **译：** 首先，是类似前文 Gemma 3、Olmo 3、Xiaomi MiMo 等的交替 local:global（滑动窗口）注意力层。但他们没有用 Gemma 3 和小米常用的 5:1 比例，而是选择了类似 Olmo 3 的 3:1 比例，以及相对较大的 4096 滑动窗口尺寸（也类似 Olmo 3）。

In addition to QK-Norm (covered in section 2, Olmo 2), they use NoPE in the global layers (we discussed NoPE in section 7, SmolLM3).

> **译：** 除了 QK-Norm（见第 2 节 Olmo 2），他们在全局层使用 NoPE（我们在第 7 节 SmolLM3 讨论过 NoPE）。

They also have a form of gated attention. They don’t have the full-blown GatedDeltaNet (discussed in section 12) but use a similar gating as in the attention mechanism in Qwen3-Next.

> **译：** 他们还有一种 gated attention。他们没有完整的 GatedDeltaNet（第 12 节讨论过），而是使用了与 Qwen3-Next 注意力机制中类似的门控。

But they modified the standard attention by adding elementwise gating to the scaled dot-product before the output linear projection (as shown in the figure below), which reduces attention sinks and improves long-sequence generalization. Additionally, it also helped with training stability.

> **译：** 但他们对标准注意力做了修改：在输出线性投影之前，对缩放点积施加逐元素门控（如下图所示），这减少了注意力汇并改善长序列泛化。此外也有助于训练稳定性。

![Figure 55: Illustration of the gating mechanism that Trinity Large uses in the attention mechanism.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-59-illustration-gating-mechanism-trinity-large.png)

You may have noticed the use of four (instead of two) RMSNorm layers in the previous Trinity Large architecture figure. This is their so-called depth-scaled sandwich norm, which is based on previous work but something I haven’t seen before in major architectures. Overall, it looks like a Gemma 3-like RMSNorm placement, but the twist here is that the gain of the second RMSNorm (in each block) is depth-scaled, meaning it’s initialized to about 1 / sqrt(L) (with L the total number of layers). So, early in training, the residual update starts small and grows as the model learns the right scale.

> **译：** 你或许注意到前一张 Trinity Large 架构图中用了四层（而非两层）RMSNorm。这是他们所谓的深度缩放三明治归一化（depth-scaled sandwich norm），基于以往工作但我在主流架构中未曾见过。整体看似 Gemma 3 式的 RMSNorm 布局，但此处关键在于：每个块中第二个 RMSNorm 的增益是按深度缩放的，即初始化约为 1/√L（L 为总层数）。因此训练初期，残差更新起步很小，随模型学到合适尺度而增长。

The MoE is a DeepSeek-like MoE with lots of small experts, but made it coarser as that helps with inference throughput (something we have also seen in Mistral 3 Large when they adopted the DeepSeek V3 architecture).

> **译：** 其 MoE 是类 DeepSeek 的 MoE，有大量小专家，但做得更粗粒度以利于推理吞吐（我们在 Mistral 3 Large 采用 DeepSeek V3 架构时也见过此做法）。

Lastly, there are some interesting details on the training improvements (a new MoE load-balancing strategy and another using the MuOpt optimizer), but since this is an architecture post, these are out of scope.

> **译：** 最后，训练改进方面有一些有趣细节（一种新的 MoE 负载均衡策略，另一种用 MuOpt 优化器），但由于本文是架构帖，超出范围。

## 21. GLM-5

Chinese New Year has become a surprisingly reliable window for strong open-weight releases. For example, GLM-4 and Qwen 1.5 were released in January and February 2024, and DeepSeek R1 and Qwen 2.5 were released in 2025.

> **译：** 春节已成为强开源权重发布的可靠窗口。例如 GLM-4 和 Qwen 1.5 在 2024 年 1、2 月发布，DeepSeek R1 和 Qwen 2.5 在 2025 年发布。

This year, z.AI (Zhipu AI) kicked things off (again relatively early) with GLM-5 on February 11, 2026, approximately a week before the Lunar New Year on February 17.

> **译：** 今年，z.AI（智谱 AI）再次较早地于 2026 年 2 月 11 日发布 GLM-5 拉开序幕，比 2 月 17 日的农历新年早约一周。

Compared to the GLM-4.5 model I covered earlier in this article (see section 11, released in summer 2025), its GLM-5 successor is twice the size: up from 355B parameters to 744B, pushing it into the territory between DeepSeek-V3.2 and Kimi K2.

> **译：** 与本文前面讲过的 GLM-4.5（见第 11 节，2025 年夏发布）相比，其后继 GLM-5 体量翻倍：从 355B 参数增至 744B，使其进入 DeepSeek-V3.2 与 Kimi K2 之间的区间。

Similar to GLM-4.5, GLM-5 is a Mixture-of-Experts (section 1.2) model, and the number of active parameters per token is only increased slightly: 40B in GLM-5 versus 32B in GLM-4.5.

> **译：** 与 GLM-4.5 类似，GLM-5 是混合专家（1.2 节）模型，每 token 活跃参数仅略增：GLM-5 为 400 亿，GLM-4.5 为 320 亿。

![Figure 56: Architecture of GLM-5 and GLM-4.5 side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-60-architecture-glm-5-glm-4.png)

Interestingly, as shown in Figure 56 above, GLM-5 adopts DeepSeek’s multi-head latent attention (MLA, see section 1.1) as well as DeepSeek Sparse Attention (which I covered in more detail in my [DeepSeek V3.2](https://magazine.sebastianraschka.com/p/technical-deepseek) article). The motivation for these modifications is to reduce the inference cost when working with long contexts.

> **译：** 有趣的是，如上方 Figure 56 所示，GLM-5 采用了 DeepSeek 的多头潜在注意力（MLA，见 1.1 节）以及 DeepSeek 稀疏注意力（我在 [DeepSeek V3.2](https://magazine.sebastianraschka.com/p/technical-deepseek) 一文中更详细讲过）。这些改动的动机是降低处理长上下文时的推理成本。

Other than that, the architecture is relatively similar. The increased size is mainly due to having more experts (256 instead of 160) and slightly increasing the layer sizes. For instance, the embedding dimension and expert size are now 6,144 (up from 5,120), and the intermediate projection size is also slightly up from 1,536 to 2,048. Interestingly, the number of layers (transformer blocks) is reduced from 92x to 78x. I am assuming this is to reduce inference costs and make the model faster (because layer depth can’t be parallelized).

> **译：** 除此之外，架构相对相似。体量增大主要因为专家更多（256 而非 160）以及层尺寸略增。例如嵌入维度和专家尺寸现为 6144（原 5120），中间投影尺寸也略增（从 1536 到 2048）。有趣的是，层数（transformer 块）从 92 减到 78。我猜测这是为降低推理成本、让模型更快（因为层深无法并行）。

I usually don’t include benchmarks here since this article is focused on the architecture. If I were to include training details and evaluations, this article would grow way out of scope and length. That being said, I saw that I included the GLM-4.5 benchmark back in July 2025, so I will make another exception here, because the benchmarks look truly impressive and on par with all major flagship LLM offerings (GPT-5.2 extra-high, Gemini Pro 3, and Claude 4.6 Opus). But again, it’s worth highlighting that benchmark performance isn’t necessarily equal to real-world performance.

> **译：** 由于本文聚焦架构，我通常不纳入基准。若再加入训练细节和评测，本文会严重超范围和超长。话虽如此，我发现 2025 年 7 月曾纳入过 GLM-4.5 基准，所以这里再破例一次，因为这些基准看起来确实惊艳，与所有主要旗舰 LLM（GPT-5.2 extra-high、Gemini Pro 3、Claude 4.6 Opus）相当。但仍要强调：基准性能未必等于真实世界性能。

![Figure 57: GLM architectures next to benchmarks. The GLM-4.7 architecture is similar to GLM-4.5. The benchmarks are taken from the GLM-5 release blog post: https://z.ai/blog/glm-5](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-61-glm-architectures-next-benchmarks-glm.png)

## 22. More February 2026 Releases: from Kimi K2.5 to Tiny Aya

In total, there have been 10 interesting open-weight LLM releases between January and February 2026:

> **译：** 2026 年 1 至 2 月间，共有 10 个值得关注的开源权重 LLM 发布：

1. Arcee AI’s Trinity Large (Jan 27, 2026)
2. Moonshot AI’s Kimi K2.5 (Jan 27, 2026)
3. StepFun Step 3.5 Flash (Feb 1, 2026)
4. Qwen3-Coder-Next (Feb 3, 2026)
5. z.AI’s GLM-5 (Feb 12, 2026)
6. MiniMax M2.5 (Feb 12, 2026)
7. Nanbeige 4.1 3B (Feb 13, 2026)
8. Qwen 3.5 (Feb 15, 2026)
9. Ant Group’s Ling 2.5 1T & Ring 2.5 1T (Feb 16, 2026)
10. Cohere’s Tiny Aya (Feb 17, 2026)
11. Sarvam 30B and 105B (Mar 6, 2026)

> **译：**
> 1. Arcee AI 的 Trinity Large（2026-01-27）
> 2. Moonshot AI 的 Kimi K2.5（2026-01-27）
> 3. StepFun Step 3.5 Flash（2026-02-01）
> 4. Qwen3-Coder-Next（2026-02-03）
> 5. z.AI 的 GLM-5（2026-02-12）
> 6. MiniMax M2.5（2026-02-12）
> 7. Nanbeige 4.1 3B（2026-02-13）
> 8. Qwen 3.5（2026-02-15）
> 9. 蚂蚁集团的 Ling 2.5 1T 与 Ring 2.5 1T（2026-02-16）
> 10. Cohere 的 Tiny Aya（2026-02-17）
> 11. Sarvam 30B 与 105B（2026-03-06）

I covered Arcee AI’s Trinity Large and z.AI’s GLM-5 in sections 19 and 20 above. However, since there was a lot of content to cover for the January-February time period, I wrote a standalone article with more information about the 10 architectures listed above here: [A Dream of Spring for Open-Weight LLMs: 10 Architectures from Jan-Feb 2026](https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight)

> **译：** Arcee AI 的 Trinity Large 和 z.AI 的 GLM-5 已在上方第 19、20 节讲过。但由于 1–2 月期间内容太多，我另写了一篇独立文章，详述上述 10 个架构：[《开源权重 LLM 的春日之梦：2026 年 1–2 月的 10 个架构》](https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight)

## 23. Gemma 4

After the Nemotron 3 Super release in March, the rest of the month was relatively quiet for flagship open-weight model releases. While I am still waiting for DeepSeek-V4, April at least brought us Google’s Gemma 4.

> **译：** 3 月 Nemotron 3 Super 发布后，当月余下时间旗舰开源权重模型发布相对沉寂。我仍在等 DeepSeek-V4，但 4 月至少带来了 Google 的 Gemma 4。

Architecture-wise, Gemma 4 (31B) looks pretty much unchanged compared to Gemma 3 (27B), as illustrated in the figure below.

> **译：** 架构上，Gemma 4（31B）相比 Gemma 3（27B）几乎未变，如下图所示。

![Figure 58: Gemma 3 (27B) and Gemma 4 (31B) side by side.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-62-gemma-3-27b-gemma-4.png)

(Note that Gemma 4 also has multimodal model support now, but I will leave the image encoder part for a separate article in the future; here, we only focus on the text portion.)

> **译：**（注意 Gemma 4 现在也有多模态模型支持，但图像编码器部分我留待日后另起一篇；此处只关注文本部分。）

As we can see in the figure above, Gemma 4 maintains a relatively unique Pre- and Post-norm setup and remains relatively classic, with a 5:1 hybrid attention mechanism combining a sliding-window (local) layer and a full-attention (global) layer. The attention mechanism itself is also classic Grouped Query Attention (GQA).

> **译：** 如上图所示，Gemma 4 保持了相对独特的 Pre- 与 Post-norm 设置，且相对经典，用 5:1 混合注意力机制组合滑动窗口（局部）层与全注意力（全局）层。注意力机制本身也是经典的分组查询注意力（GQA）。

However, a small change over Gemma 3, which is easy to overlook, is that for the global (full) attention layers they reuse the keys in the attention mechanism. I.e., they set values = keys, which should result in further KV cache size reduction.

> **译：** 然而，相比 Gemma 3 有一个容易忽略的小变化：对于全局（全）注意力层，他们在注意力机制中复用键。即令 values = keys，这应能进一步减小 KV cache 体积。

Furthermore, Gemma 4 also uses p-RoPE, where only 25% of the frequency pairs get positional information. This helps with reducing positional noise in long-context situations.

> **译：** 此外，Gemma 4 还使用 p-RoPE，仅 25% 的频率对获得位置信息。这有助于减少长上下文场景下的位置噪声。

But let’s not be fooled by the lack of big(ger) architectural changes. Looking at the benchmarks, Gemma 4 is a huge leap from Gemma 3! For instance, on the [AI Arena Leaderboard](https://arena.ai/leaderboard/text), Gemma 4 (31B) ranks similarly to the much larger Qwen3.5-397B-A17B model. But as I discussed in my model evaluation article, [Understanding the 4 Main Approaches to LLM Evaluation (From Scratch)](https://magazine.sebastianraschka.com/p/llm-evaluation-4-approaches), arena scores are a bit problematic as they can be gamed and are biased towards human (style) preference.

> **译：** 但别被缺乏更大架构改动所误导。看基准，Gemma 4 相比 Gemma 3 是一次巨大飞跃！例如在 [AI Arena Leaderboard](https://arena.ai/leaderboard/text) 上，Gemma 4（31B）的排名与大得多的 Qwen3.5-397B-A17B 模型相近。但正如我在模型评测文章[《理解 LLM 评测的 4 种主要方法（从零开始）》](https://magazine.sebastianraschka.com/p/llm-evaluation-4-approaches)中所讨论，arena 分数有点问题，可被刷分且偏向人类（风格）偏好。

However, if we look at some other common benchmarks, which I plotted below, we can see that it’s indeed a very clear leap over Gemma 3 and ranks on par with Qwen3.5 27B.

> **译：** 不过，若看其他一些常见基准（我绘于下方），可见它相对 Gemma 3 确是清晰的飞跃，与 Qwen3.5 27B 相当。

![Figure 59: Gemma 3 versus Gemma 4 versus Qwen3.5 (the numbers are taken from the [Gemma 4](https://huggingface.co/google/gemma-4-31B) and [Qwen3.5](https://huggingface.co/Qwen/Qwen3.5-27B) model hub pages).](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-63-gemma-3-versus-gemma-4.png)

Note that there is also a Mixture-of-Experts (MoE) Gemma 4 variant, which is illustrated below next to a Qwen3 model of similar size.

> **译：** 注意还有一个混合专家（MoE）版 Gemma 4，如下方与相近尺寸 Qwen3 模型并排所示。

![Figure 60: Qwen3 Coder Flash compared to Gemma 4 MoE.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-64-qwen3-coder-flash-compared-gemma.png)

As the figure above shows, the approaches are relatively similar except that Gemma 4 uses the unique Pre- and Post-norm placement discussed earlier.

> **译：** 如上图所示，两种方法相对相似，区别在于 Gemma 4 使用了前文讨论过的独特 Pre- 与 Post-norm 布局。

Benchmark-wise, the Gemma 4 MoE variant, which has 4B parameters less in total than the Gemma 4 (31B) dense variant, the performances are relatively similar.

> **译：** 基准上，Gemma 4 MoE 变体总参数比 Gemma 4（31B）稠密变体少 40 亿，性能相对相似。

![Figure 61: Gemma 4 MoE (26B-A4B) is only slightly worse than Gemma 4 (31) dense.](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-65-gemma-4-moe-26b-a4b.png)

If you are interested in a visual overview of all the architectures covered here, I put together an LLM Architecture Gallery [here](https://sebastianraschka.com/llm-architecture-gallery/).

> **译：** 若对本文涵盖的所有架构的视觉概览感兴趣，我在[此处](https://sebastianraschka.com/llm-architecture-gallery/)整理了一个 LLM 架构图集。

![LLM architecture gallery at [https://sebastianraschka.com/llm-architecture-gallery/](https://sebastianraschka.com/llm-architecture-gallery/)](/vibe-reading/images/articles/llm-blogs-big-llm-architecture-comparison/fig-66-llm-architecture-gallery-at-https.png)

**After all these years, LLM releases remain exciting, and I am curious to see what’s next!**

> **译：** **这么多年过去，LLM 的发布依旧令人兴奋，我很好奇接下来会有什么！**
