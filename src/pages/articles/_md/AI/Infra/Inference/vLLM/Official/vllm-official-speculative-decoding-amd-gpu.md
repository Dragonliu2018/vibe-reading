---
title: "在 AMD GPU 上探索 vLLM 中的投机解码"
source:
  type: "article"
  project: "vLLM"
  url: "https://mp.weixin.qq.com/s/rW_BnVzLNx4Av--UZ008cg"
  author: "AMD&EmbeddedLLM"
  site: "vLLM 官方博客（公众号 vLLM）"
date: "2026-08-27T11:43:39+08:00"
category: [AI, Infra, Inference, vLLM, Official]
tags: ["vLLM", "Speculative Decoding", "AMD GPU", "ROCm", "MTP", "EAGLE-3", "DFlash", "DSpark"]
description: "vLLM 官方博客：在 AMD Instinct GPU 上探索 native MTP、Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark 五种投机解码草稿结构，多个模型与工作负载组合的 output throughput 超过非投机基线两倍，最高 2.87 倍。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [在 AMD GPU 上探索 vLLM 中的投机解码](https://mp.weixin.qq.com/s/rW_BnVzLNx4Av--UZ008cg) · **作者** AMD&EmbeddedLLM · **来源** vLLM 官方博客（公众号 vLLM）· **原文发布** 2026-08-23 · **转载** 2026-08-27

---

> vLLM 通过 --speculative-config 支持 native MTP、Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark 五种草稿结构。AMD 与 Embedded LLM 在 AMD Instinct GPU 上的测量显示，多个模型与工作负载组合的 output token throughput 超过非投机基线两倍，最高 2.87 倍。

**TL;DR：**  投机解码让 vLLM 得以在目标模型的一次前向中验证多个草稿 token。在我们的实验中，它对 output-token throughput 的影响随草稿方法与提议长度而变化，也取决于模型家族、草稿 checkpoint、工作负载与接受行为。

---
## 引言

大语言模型支撑着相当广泛的应用，但要把它们大规模部署好，需要细致的优化。标准的自回归解码是多数 LLM 部署系统采用的基线：模型生成一个 token，把它追加到序列上，再用更新后的序列生成下一个 token。这个过程简单可靠，但由于输出 token 必须严格从左到右产生，部署循环每次只能推进一个已提交的 token。

投机解码[1]在这条基线之上引入了一套草稿-验证机制。一个轻量的草稿组件提出若干候选的未来 token，目标模型在这些候选被提交之前对其进行验证。当多个草稿 token 被接受时，系统就能用目标模型的一次验证提交多个输出 token，同时保持目标模型的输出行为不变。

本文探讨投机解码在 vLLM 中如何工作，并分享我们测试环境中的测量结果。我们先回顾自回归解码基线与草稿-验证过程，随后考察五种投机草稿方法：native MTP、Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark。这些方法的区别在于草稿组件从目标模型获取信息的方式，以及候选 token 是按顺序生成、自回归生成、并行生成，还是走一条混合路径。最后，我们说明如何启用在我们环境中测试过的这些方法，报告在 AMD Instinct™ MI300X 与 MI355X GPU 上、基于 ROCm™ 开放软件平台的实验测量结果，并讨论实践中的调参与可观测性考量。

---
## 自回归解码基线

在标准自回归解码中，每一个 decode step 产生并提交一个新 token。例如，生成四个输出 token 需要四个顺序执行的 decode step：
```text
Step 1:  context            → model → T1
Step 2:  context + T1       → model → T2
Step 3:  context + T1 T2    → model → T3
Step 4:  context + T1 T2 T3 → model → T4
```

每一步之后，生成的 token 被追加到序列上，成为下一步输入的一部分。这让解码循环足够直接，但也意味着每一个输出 token 都要付出一次模型 decode step。在长生成过程中，这种逐 token 的循环会主导延迟，并限制部署吞吐。

于是，投机解码背后的关键问题是：

> 我们能否在保持原模型输出行为的同时，减少生成过程"一次只前进一个 token"的次数？

投机解码的做法是把提议与验证分开。草稿组件先提出若干候选的未来 token；原模型作为目标模型，再在这些候选被提交之前对其进行验证。

---
## 投机解码的核心思路

投机解码并不替换原模型。它把原模型保留为目标模型，由目标模型对最终输出负责，并在它前面加上一个更快的提议阶段。

整个过程分为两部分：

  - 草稿（Draft）：提出若干候选的未来 token。
  - 验证（Verify）：用目标模型检查这些候选。



如图 1 所示，在每一轮投机解码中，一个轻量的草稿组件提出一个或多个未来 token。这些 token 只是候选，不会立即提交。随后目标模型在一次验证中评估整条候选 token 序列。

验证从左到右进行。每个草稿 token 都用目标模型在对应位置上的结果来检查。被接受的 token 提交到输出序列。一旦某个草稿 token 被拒绝，同一次提议中后面的候选就不再被接受。

如果某个草稿 token 被拒绝，则由目标模型给出下一个 token。剩余的草稿 token 被丢弃，生成从更新后的序列继续。

从概念上看，标准自回归解码是这样推进的：
```text
target model  → T1
target model  → T2
target model  → T3
target model  → T4
```

而投机解码允许多个候选位置一起被评估：
```text
draft proposes   T1   T2   T3   T4(muted)
model verifies   ✓    ✓    ✗    stop
commit           T1   T2   replacement token   -
```

当多个候选被接受时，这能减少目标模型的解码轮数。当草稿组件产出的 token 被目标模型接受时，一次目标模型验证就能提交多个输出 token。当提议被拒绝时，由目标侧的结果决定生成如何继续。

![图 1. 投机解码流程：草稿组件提出候选的未来 token，目标模型在输出 token 被提交之前对其进行验证。](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig01.png)

###  一个简单的接受/拒绝示例

图 2 给出了一轮投机解码的例子。绿色方框是通过验证的草稿 token，红色方框标出第一个被拒绝的草稿 token，灰色方框是随后被丢弃的草稿 token。输出中的蓝色 token 来自目标模型，而非草稿提议。

![图 2. 对一次草稿提议的从左到右验证。前两个草稿 token 被接受，被拒绝的位置改用目标模型的 token，剩下的候选被丢弃。](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig02.png)

假设当前的 prompt 是：
```text
The weather today is
```

草稿组件提出若干未来 token：
```text
sunny   and   warm   outside
```

目标模型从左到右验证这些草稿 token：
```text
draft proposes   sunny   and   warm   outside
model verifies   ✓       ✓     ✗      stop
commit           sunny   and   clear  -
```

前两个草稿 token `sunny` 和 `and` 被接受。在第三个位置上，草稿提议的是 `warm`，但目标模型选择了 `clear`。剩下的候选 `outside` 因为位于第一个被拒绝的位置之后而被丢弃。

因此，下一轮解码从这里继续：
```text
The weather today is   sunny   and   clear
```

---
## 各种草稿方法是怎么工作的

尽管所有投机解码方法都遵循同一套草稿-验证流程，它们在草稿组件的设计、以及与目标模型的配合方式上有所不同。

主要差异有三点：

  - 从目标模型收到的信息类型。
  - 这些信息如何被纳入草稿过程。
  - 候选 token 是按顺序生成还是并行生成。



据此，本文讨论的草稿方法可以归为三大类：model-native 的 MTP 模块、独立的 MTP drafter，以及专门的 target-conditioned 草稿网络。

  - **model-native 的 MTP 模块：**  直接内建在目标模型架构里；使用模型自带的辅助预测路径；按顺序生成候选 token。
  - **独立的 MTP drafter：**  使用与特定目标模型配对的独立 checkpoint；推理时使用目标模型的 activation 与共享的 KV cache 信息；按顺序生成候选 token。
  - **专门的 target-conditioned 草稿网络：**  使用为特定目标模型训练的独立 speculator 模型，包括 EAGLE-3、DFlash 与 DSpark。EAGLE-3 基于目标模型的 hidden state 自回归地生成草稿，DFlash 基于目标模型的 hidden state 并行地生成整块草稿，DSpark 则再加上轻量的因果修正与基于置信度的前缀选择。



这些分类描述的是草稿组件的架构，而不是目标模型的家族。一个目标模型可以同时支持 native MTP，并另有单独训练的 EAGLE-3、DFlash 或 DSpark 草稿模型。

草稿组件并不完全独立工作。视方法而定，草稿组件可能收到：

  - 来自目标模型的一个 hidden 表示。
  - 来自若干选定目标层的 hidden state。
  - 目标模型的 KV cache。
  - 由多个目标模型表示组合而成的特征。



以下各节说明每种方法如何使用这些信息，以及如何生成候选 token。

### Native MTP

Multi-Token Prediction（MTP）指的是一类 model-native 的机制，用于预测下一个 token 之外的更远 token。在 vLLM 中，当目标模型包含兼容的辅助预测组件时，native MTP 即可用[2]。具体的 MTP 架构在各模型家族之间有所不同，但每一种实现都提供了一条提议未来 token 的辅助路径。

在第一个投机步骤上，MTP 组件把来自目标模型的一个 hidden 表示与当前 token 的信息结合起来，预测第一个草稿 token。在后续步骤上，新产生的草稿 token 与上一次 MTP 步骤产生的 hidden state 被用来预测下一个候选。在提议出配置数量的候选之后，目标模型在一次验证中把它们一起评估。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig03.png)

许多 native MTP 实现遵循类似的模式：来自目标模型或上一次 MTP 预测的 hidden 表示，与移位后的输入 token 或最新草稿 token 的 embedding 相结合：

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig04.png)

这两个输入承担不同的作用：（1）hidden 表示携带前序序列的信息；（2）token embedding 标明草稿要从哪个最新 token 继续。在常见实现里，两者沿 hidden 维度拼接，经变换后再进入辅助预测层。

物理 MTP 层的数量与配置的投机长度是两个不同的概念。当 `num_speculative_tokens` 超过 checkpoint 直接提供的预测深度时，vLLM 可以通过额外的前向来复用这条 MTP 路径。因此，更大的值会在验证之前提议出更多候选，但也带来更多顺序执行的草稿工作。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig05.png)

Native MTP 与目标模型架构紧密相关。在许多实现里，MTP 路径的一部分与目标模型共享组件，这可以让额外的显存开销保持在相对温和的水平。不过，生成多个投机 token 仍然需要在验证之前顺序执行草稿。

### Gemma 4 MTP

Gemma 4 使用一个独立打包、与特定目标模型配对的 MTP 草稿组件[3]。尽管该草稿组件有自己的 checkpoint，它在推理时仍与目标模型紧密相连。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig06.png)

草稿组件使用目标模型产生的 activation，并共享目标模型的 KV cache。这让它可以复用目标模型已经算好的上下文信息，而不必自己再处理一遍已接受的前缀。

与 native MTP 一样，草稿组件的层数与配置的投机长度是两件事。当请求多个候选 token 时，草稿组件按顺序生成它们：

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig07.png)

### EAGLE-3

EAGLE-3 使用一个为特定目标模型训练的专门草稿网络。该草稿组件有自己的执行路径，但仍紧密地以目标模型产生的信息为条件[4]。

在目标模型的前向过程中，EAGLE-3 记录目标 Transformer 三个阶段的 hidden state：靠前、居中、靠后。它们是同一条已接受序列在目标模型处理的不同阶段上的上下文表示。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig08.png)

这三个 hidden state 被拼接并投影成单一的融合目标特征。该融合表示随后与采样 token 的 embedding 结合，再进入 EAGLE-3 的草稿 decoder。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig09.png)

这两个输入承担不同的作用：

  - 融合目标特征用目标模型前向过程中若干阶段的信息，概括已接受的序列。
  - 采样 token 的 embedding 标明草稿要从哪个 token 继续。



EAGLE-3 自回归地生成草稿 token。对第一个草稿 token，它使用由已接受序列算出的融合目标特征，加上采样 token 的 embedding。一个草稿 token 产生之后，它的 embedding 被送入下一个草稿阶段。

由于目标模型尚未处理后面那些投机位置，这些位置上的目标模型 hidden state 并不存在。因此，EAGLE-3 在延续草稿序列时使用上一次草稿组件的输出。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig10.png)

这种顺序反馈让后面的草稿 token 沿被提议的序列直接依赖前面的草稿 token。不过，生成更多投机 token 同样意味着验证之前有更多顺序执行的草稿工作。

### DFlash

DFlash 使用一个为特定目标模型训练的专门草稿网络。与按顺序生成候选 token 的 MTP 和 EAGLE-3 不同，DFlash 并行地预测一整块未来位置[5]。

DFlash 的每个草稿 block 以一个 anchor token（锚点 token）开头。anchor 是目标模型产生或确认过的已知 token，所以 DFlash 不需要预测它；它为后面那些被 mask 的位置提供一个已知的起点。在后续解码轮中，它通常是上一次验证返回的那个额外目标 token。

anchor 占据 block 的第一个位置，其余位置被 mask 并行预测：

一个草稿 block 以一个已确认的 anchor token 开头，后面跟着被 mask 的位置：

Position| 0| 1| 2| 3| 4| 5| 6
---|---|---|---|---|---|---|---
Input| anchor| mask| mask| mask| mask| mask| mask

这里 `anchor` 是已知的目标模型 token，被 mask 的位置由 DFlash 预测。

DFlash 的一次前向就预测出所有被 mask 的位置：

Position| 0| 1| 2| 3| 4| 5| 6
---|---|---|---|---|---|---|---
Output| anchor| draft1| draft2| draft3| draft4| draft5| draft6

与 EAGLE-3 一样，DFlash 也先把目标模型若干层的 hidden state 融合成一个表示。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig11.png)

主要区别在于这个融合表示的用法。EAGLE-3 把它与采样 token 的 embedding 一起放在自回归草稿网络的输入端。DFlash 则把融合后的目标上下文转换成额外的 Key 与 Value 表示，在草稿网络的每一层都可用。

因此，来自被 mask 草稿位置的 Query 可以同时 attend 到两类信息：

  - 由目标模型导出的 Key 与 Value 表示。
![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig12.png)



也就是说，目标模型的上下文在整个草稿网络中始终可用，而不是只在输入端被提供一次。

草稿 block 生成之后，目标模型在一次验证中评估所有被提议的 token。接受判定随后从左到右应用：被接受的 token 一路提交，直到第一个被拒绝的位置，其余候选被丢弃。
```text
draft proposal      D1       D2       D3       D4       D5
acceptance result   accept   accept   reject   discard  discard
committed output    D1       D2       目标模型 token   -   -
```

这里，目标模型的 token 替换第一个被拒绝的草稿 token，其余草稿 token 被丢弃。

DFlash 的一个决定性特征是所有被 mask 的位置在草稿网络的一次前向中一起被预测。
```text
draft1 | draft2 | draft3 | draft4    （一起预测）
```

这与顺序草稿不同：
```text
draft1 → draft2 → draft3 → draft4
```

由于所有被 mask 的位置一起被预测，在同一次前向中，后面的位置并不以前面位置的采样输出为条件。这去掉了自回归草稿所使用的逐 token 反馈。因此，后面那些位置的有效程度取决于训练出的 checkpoint 与工作负载，在使用更长的草稿 block 时尤其如此。

### DSpark

DSpark 在并行草稿之外增加了两个机制：

  - 一个轻量的顺序 head，在草稿 block 内部的 token 之间引入依赖。
  - 基于置信度地选择提交给目标模型验证的前缀。



DSpark 用一个改造过的 DFlash 模型作为并行骨干[6]。骨干在一次前向中完成所有位置的主要草稿计算，为每个草稿位置产出一个 hidden state 和一组基础 logits。因此它继承了 DFlash 一节里描述的 target-conditioned 特性。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig13.png)

一个完全并行的草稿组件在预测每个位置时，并没有先看到同一 block 中较早位置选中的 token。当存在多个合理的延续时，这可能产出不自洽的组合。例如 "of course" 与 "no problem" 都可能是合理的延续，但逐位置独立预测有可能产出 "of problem"。

DSpark 通过在并行骨干之后应用一个轻量的顺序 head 来处理这种行为。骨干仍然一起算出每个位置的基础 logits，随后由顺序 head 从左到右选取 token，并用已选中的草稿 token 的信息调整每个位置。

DSpark 用的是一个轻量的 Markov 头，在被选中的草稿 token 之间引入依赖。对每个位置，Markov 头用紧邻的前一个已选中 token 产出一个小的偏置，用它去调整并行骨干产出的基础 logits：

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig14.png)

主草稿网络在一次前向中一起处理所有候选位置。之后只有轻量的 Markov 头从左到右运行，用前一个已选中的草稿 token 调整每个位置。

![图片](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig15.png)

这让同一 block 内后面的草稿 token 能够依赖已经选出的 token，而不必为每个位置都重跑一遍完整的草稿网络。

DSpark 的设计还包含一个置信度头（confidence head），可以选出更短的草稿前缀交给目标模型验证。该特性在我们实验所用的 vLLM 路径中没有启用，因此 benchmark 结果只反映并行草稿网络与轻量的 Markov 修正。

目标模型在一次验证中评估被提议的序列，草稿 token 从左到右提交，直到第一个被拒绝的位置。

### 各草稿方法小结

图 3 并排给出五种草稿方法的可视对比：草稿组件长什么样、它用到目标模型的哪些信息、以及候选 token 是按顺序还是并行生成。图下方的表格用紧凑形式重述同一组对比。在这五种方法里，目标模型都仍然在一次验证中评估被提议的序列，接受判定都从左到右应用，直到第一个被拒绝的草稿 token。

![图 3. 本文讨论的五种投机解码方法的草稿结构与 token 生成模式。](/vibe-reading/images/articles/vllm-official-speculative-decoding-amd-gpu/fig16.png)

方法| 草稿组件| 用到的目标模型信息| 草稿 token 如何生成
---|---|---|---
Native MTP| 模型自带的辅助 MTP 路径| 目标模型或上一次 MTP 的 hidden 表示，与当前草稿 token 的信息结合| 通过重复使用 MTP 路径按顺序生成
Gemma 4 MTP| 与目标模型配对的独立 MTP 草稿组件| 目标模型的 activation 与共享的目标 KV cache| 通过配对的 MTP 组件按顺序生成
EAGLE-3| 专门的自回归草稿网络| 目标模型前向过程中靠前、居中、靠后三处捕获的 hidden state，融合成一个表示| 按顺序生成，每个草稿 token 影响下一个
DFlash| 专门的并行草稿网络| 融合后的目标模型 hidden state，作为额外的 Key 与 Value 信息提供给每一层草稿层| 所有候选位置在一次并行前向中一起被预测
DSpark| DFlash 式并行草稿网络 + 轻量 Markov 头| 与并行草稿网络相同的 target-conditioned 信息| 一次并行前向，随后对 token 选取做轻量的顺序调整

---
## 如何在 vLLM 中启用投机解码

在 vLLM 中，投机解码通过 `--speculative-config` 配置。各方法之间的主要差异在于方法名、是否需要独立的草稿 checkpoint，以及请求多少个候选 token。当前的 vLLM 支持 mtp、eagle3、dflash、dspark 作为 method 值。

方法| 是否需要独立草稿 checkpoint| 典型配置
---|---|---
Native MTP| 否| `"method": "mtp"`
`"num_speculative_tokens": <N>`
Gemma 4 MTP| 是| `"method": "mtp"`
`"model": "<matching-assistant>"`
`"num_speculative_tokens": <N>`
EAGLE-3| 是| `"method": "eagle3"`
`"model": "<matching-speculator>"`
`"num_speculative_tokens": <N>`
DFlash| 是| `"method": "dflash"`
`"model": "<matching-speculator>"`
`"num_speculative_tokens": <N>`
DSpark| 是| `"method": "dspark"`
`"model": "<matching-speculator>"`
`"num_speculative_tokens": <N>`

对 native MTP，草稿组件随目标模型一起提供，所以省略 model 字段：
```bash
vllm serve <target-model> \
  --speculative-config '{
    "method": "mtp",
    "num_speculative_tokens": <N>
  }'
```

对 Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark，model 字段通常指向为该目标模型训练的 checkpoint：
```bash
vllm serve <target-model> \
  --speculative-config '{
    "method": "<method>",
    "model": "<matching-draft-checkpoint>",
    "num_speculative_tokens": <N>
  }'
```

Gemma 4 的 assistant checkpoint 虽然通过 model 字段提供，走的仍是 MTP 路径。vLLM 会把该 assistant 组件连到目标模型上，并允许它共享目标的 KV cache。

在启用某种方法之前，请确认：

  - 所安装的 vLLM 版本支持该方法与模型架构。
  - 草稿 checkpoint 与目标模型、方法相兼容。
  - `num_speculative_tokens` 与该 checkpoint 相兼容。
  - 该 model card 支持你打算使用的硬件与推理后端。



### 显存方面的考量

Native MTP 不加载独立的草稿 checkpoint，还可能与目标模型共享 embedding table 或输出 head 这类组件。Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark 会加载额外的草稿权重，因此需要预留足够的 GPU 显存余量。实际开销取决于草稿组件的大小、数值精度、tensor-parallel 配置与运行时缓冲区。

---
## 到哪里找预训练的草稿模型

已经有若干组织在 Hugging Face 上发布预训练的草稿模型。Google 为 Gemma 4 提供 MTP assistant，Z-Lab 维护一批 DFlash checkpoint。Red Hat AI 提供覆盖 EAGLE-3、DFlash 与 DSpark 的草稿模型，DeepSeek 的 DeepSpec 集合则为这三种方法提供配套 checkpoint。LightSeek 专注于面向 Kimi 的 EAGLE 系草稿模型，Inferact 发布面向 MiniMax 与 Kimi 的草稿模型。

草稿模型发布方| 方法| 代表性模型与目标
---|---|---
Google| Gemma 4 MTP| 面向 Gemma 4 E2B、E4B、12B、26B-A4B 与 31B 目标模型的 assistant checkpoint。[7]
LightSeek Foundation| EAGLE-3 与 EAGLE-3.1| 面向 Kimi-K2.5、Kimi-K2.6、Kimi-K2.7-Coder 的 EAGLE 系草稿模型，含标准版与 MLA 变体。[8]
Red Hat AI| EAGLE-3、DFlash 与 DSpark| 覆盖 Llama、Qwen、Gemma、GPT-OSS、GLM、Nemotron、Mistral 等目标家族的集合。常见后缀为 -speculator.eagle3、-speculator.dflash、-speculator.dspark。[9]
Z-Lab| DFlash| 面向 Qwen3、Qwen3.5、Qwen3.6、Gemma 4、Kimi、MiniMax、GPT-OSS、Llama 等目标的 DFlash checkpoint。checkpoint 命名一般遵循 <target>-DFlash 的形式。[10]
DeepSeek AI| EAGLE-3、DFlash 与 DSpark| DeepSpec 集合为 Qwen3-4B、Qwen3-8B、Qwen3-14B 以及 Gemma 4 12B 提供这三种方法的版本。例如 eagle3_qwen3_8b_ttt7、dflash_qwen3_8b_block7、dspark_qwen3_8b_block7。[11]
Inferact| EAGLE-3 与 DSpark| 包括 Inferact/MiniMax-M3-EAGLE3 及其 GQA 变体、Inferact/Kimi-K3-DSpark。[12]

---
## 实验设置与测量

启用投机解码之后，实际要回答的问题是：额外的草稿工作是否改善了端到端的部署性能。候选 token 不必每个位置都正确，因为目标模型会在它们被提交之前完成评估。因此性能取决于有多少被提议的 token 被接受，以及省下来的目标模型解码工作是否抵得过草稿与验证的成本。

我们用任务导向的 benchmark 而不是随机 token 序列来评估模型质量与部署性能。接受行为取决于真实模型输出的结构与可预测性，因此基于任务的 prompt 能更有代表性地反映实践性能。

主要性能指标是：

  - Output-token throughput，以及相对非投机基线的加速比。
  - Mean accepted length 与草稿 token 的 acceptance rate（在有数据时）。
  - 相对非投机基线的模型质量。



### 模型与实验覆盖

实验覆盖五种投机草稿方法，横跨若干目标模型家族。对勾表示该"目标模型 + 方法"组合有 benchmark 结果；短横表示该组合未纳入本次实验。

目标模型| Native MTP| Gemma 4 MTP| EAGLE-3| DFlash| DSpark
---|---|---|---|---|---
google/gemma-4-26B-A4B-it| -| ✓ Google| ✓ Red Hat AI| ✓ Z-Lab| -
google/gemma-4-31B-it| -| ✓ Google| ✓ Red Hat AI| ✓ Z-Lab| ✓ Red Hat AI
Qwen/Qwen3-8B| -| -| ✓ Red Hat AI| ✓ Z-Lab| ✓ DeepSeek
Qwen/Qwen3.5-27B| ✓ 内置| -| -| ✓ Z-Lab| -
Qwen/Qwen3.5-122B-A10B| ✓ 内置| -| -| ✓ Z-Lab| -
Qwen/Qwen3.6-27B| ✓ 内置| -| -| ✓ Z-Lab| -
Qwen/Qwen3.6-35B-A3B| ✓ 内置| -| -| ✓ Z-Lab| -
moonshotai/Kimi-K2.5| -| -| ✓ LightSeek| ✓ Z-Lab| -
MiniMaxAI/MiniMax-M3-MXFP8| -| -| ✓ Inferact| -| -

该表汇总了实验纳入的"目标模型 + 方法"组合，并展示投机解码在不同模型、工作负载与提议长度下的表现。每个结果都应在其测试配置内解读，因为模型架构、激活参数量、草稿组件大小、工作负载与部署条件都会影响性能。

### 吞吐测量

在吞吐方面，我们以标准自回归基线为参照测量每秒生成的 token 数，并扫一遍投机 token 数量，以研究投机深度如何影响端到端的部署吞吐。

> 英文原文此处是一张 Plotly 交互图（可切换目标模型，悬停查看 speedup 与所选的提议长度 N），公众号不支持交互内容。图中的数据在下一节「主要观察」中已以文字形式逐项给出；需要按模型逐条查看时，请到文末的英文原文链接。

 _图 4. 按方法与实验列出的实测 output throughput，并以非投机基线作为参照。用选择器切换目标模型，悬停在柱子上可看到 speedup 与所选的提议长度 N。_

###  主要观察

测量结果随目标模型、草稿方法、工作负载与提议长度而变化。

对 gemma-4-26B-A4B-it，在所测扫参范围内的最大吞吐比是：Gemma 4 MTP 在 GSM8K 与 MBPP 上分别为 2.74× 与 2.62×，DFlash 在 MATH500 与 HumanEval 上分别为 2.87× 与 2.79×。EAGLE-3 的测量结果在四个数据集上介于 2.11× 到 2.27× 之间。

对 gemma-4-31B-it，Gemma 4 MTP 在 GSM8K 上达到 2.00×，在 MBPP 上达到 1.99×，DFlash 在 MATH500 上达到 2.34×，在 HumanEval 上达到 2.05×。EAGLE-3 与 DSpark 的测量结果在四个受评数据集上也都高于基线。取得最大实测吞吐的提议长度随工作负载而变。

对 Qwen3-8B，DSpark 的测量结果从 MATH500 上的 1.15× 到 GSM8K 上的 1.63×。DFlash 的测量结果介于 1.08× 到 1.27× 之间。EAGLE-3 在 GSM8K、HumanEval 与 MBPP 上高于基线，而它在 MATH500 上的最大实测值仍低于基线。

对 Qwen3.5-27B、Qwen3.5-122B-A10B 与 Qwen3.6-27B，在所测扫参范围内 native MTP 的最大实测值高于相应的 DFlash 最大值。这一组里最大的比值是 Qwen3.5-122B-A10B 在 MATH500 上的 2.20×。取得最大实测吞吐的 native MTP 提议长度随模型与数据集在 N=4 到 N=7 之间变化。

对 Qwen3.6-35B-A3B，DFlash 的测量结果介于 1.77× 到 2.06× 之间，四个数据集的最大值都出现在 N=7。Native MTP 的测量结果介于 1.28× 到 1.49× 之间，最大值出现在 N=6。与 Qwen3.6-27B 的测量结果之间的差异说明，同一家族内不同模型的结果也可能不同。

对 MiniMax-M3-MXFP8，EAGLE-3 在 HumanEval 上于 N=4 达到 2.09×。对 Kimi-K2.5，EAGLE-3 的测量结果最高达 2.33×，DFlash 最高达 2.68×。在所测扫参范围内，EAGLE-3 的最大值一般出现在 N=4，而 DFlash 的最大值出现在 N=7。

在这些实验中，取得最大实测吞吐的提议长度并不是一个常数。对顺序型方法，吞吐往往在 N 的前几个取值上上升，随后进入平台期。对 DFlash 与 DSpark，N=7 经常属于吞吐较高的设置之一，而更大的取值并不总能继续提升吞吐。

这些观察反映的是本研究所用的硬件、软件、目标模型、草稿 checkpoint、工作负载与扫参设置。

---
## 调参方面的考量

投机解码应当被当作一项运行时优化，而不是一个对所有工作负载都同样有效的固定设置。取得最高吞吐的 `num_speculative_tokens` 取决于有多少被提议的 token 被接受，以及省下来的目标模型解码工作是否抵得过草稿与验证的成本。

因此可观测性很重要。model card 的推荐值或示例配置提供了有用的起点，但最终设置应当用有代表性的工作负载与端到端测量来选定。有用的信号包括吞吐、mean accepted length、整体 acceptance rate 与逐位置 acceptance rate。

更大的提议窗口让系统有更多机会在一次验证中提交多个 token。但接受率可能在靠后的草稿位置上下降。一旦出现这种情况，额外的候选贡献很小，却仍要付出草稿与验证的开销，于是吞吐会走平甚至回落。

### 从受支持的配置起步

对 native MTP，N=1 是一个保守的起点，因为它引入的额外顺序草稿工作最少：
```json
{"method": "mtp", "num_speculative_tokens": 1}
```

确认正确性与稳定性之后，再扫更大的值，例如 2、3、4、5、6、7。

在我们的测量中，取得最大实测吞吐的 native MTP 设置随目标模型与工作负载而变。对 Qwen3.5-27B，最大实测吞吐出现在 GSM8K 与 MATH500 的 N=5、HumanEval 与 MBPP 的 N=4、MT-Bench 的 N=3。对 Qwen3.5-122B-A10B，在列出的四个推理与代码数据集上，最大实测吞吐都出现在 N=7。

Qwen3.6 的测量结果同样说明，这个设置在同一家族的不同模型之间也会变。对 Qwen3.6-27B，最大实测值出现在 N=4 或 N=5，而所测的 Qwen3.6-35B-A3B 配置的吞吐一直提升到 N=6。

对 Gemma 4 MTP 与 EAGLE-3，增大 N 同样会增加顺序草稿工作。因此即便 checkpoint 给出了推荐配置，扫一小段也仍然有用。在我们的 Gemma 4 与 EAGLE-3 实验中，实测吞吐一般在 N 的前几个取值上上升，随后进入平台期。

对 DFlash，从草稿 checkpoint 推荐或支持的提议长度起步。许多 DFlash checkpoint 是以固定 block 大小训练的。例如当：
```python
block_size = 16
```

时，最大提议长度通常是：
```python
num_speculative_tokens = 15
```

因为第一个位置是已确认的 anchor token，其余 15 个位置才是草稿候选。

这是所支持的最大提议长度，未必就是吞吐最高的设置。实践中，测试更小的取值是有用的，例如：
```python
N = 3, 7, 11, 15
```

在我们的 DFlash 实验中，N=7 经常属于吞吐较高的设置之一。在部分工作负载上，最大实测吞吐出现在 N=11。

对 DSpark，`num_speculative_tokens` 设定每一轮投机中生成的候选 token 数量。在我们的 vLLM 实验中，配置的整条提议都会提交给目标模型验证，因此 N=3 与 N=7 这类取值应当用端到端吞吐来比较。

### 监控接受行为

值得监控的信号包括：

信号| 它反映什么
---|---
Throughput| 端到端部署性能相对非投机基线的变化
Mean accepted length| 平均每一轮投机提交多少个草稿 token
Overall acceptance rate| 被提议的草稿 token 中有多大比例被接受
Per-position acceptance rate| 提议中靠后的位置是否仍然有用

逐位置的接受情况在调提议长度时尤其有帮助。如果前几个位置经常被接受、靠后的位置贡献很小，那么减小 `num_speculative_tokens` 可以省掉不必要的草稿工作，从而提升吞吐。

接受率指标应当与吞吐一起解读。当草稿生成很便宜时，某种方法即便接受率更低，相对基线的吞吐也可能更高；反过来，当草稿组件带来额外开销时，高接受率也不一定对应更高的吞吐。

### 让扫参匹配工作负载

不同的工作负载会产生不同的接受模式。

在我们 GSM8K 与 MATH500 的测量中，在所测扫参范围内，中等或更深的提议长度往往对应更高的实测吞吐。对 Qwen3.5-122B-A10B 上的 native MTP，实测吞吐一直提升到 N=7。对 DFlash，较高的实测值经常出现在 N=7 或 N=11。

在 HumanEval 与 MBPP 上，中等的提议长度常常属于吞吐较高的设置。代码有可预测的局部结构，但格式、标识符与实现选择都可能让一个看起来合理的延续偏离目标。

### 一个调参流程示例

  1. 从该 checkpoint 支持或推荐的配置起步。
  2. 用有代表性的 prompt 与生成设置做 benchmark。
  3. 记录吞吐、mean accepted length 与 acceptance rate。
  4. 向更小和更大两侧各扫若干提议长度。
  5. 依据与目标工作负载最相关的指标选定设置。在这些实验中，端到端部署吞吐是主要的选择指标。



被选中的配置未必拥有最长的提议、最高的接受率或最大的 mean accepted length。选择时应当权衡草稿成本、验证成本、被接受的 token 数，以及与目标工作负载最相关的那个指标。

---
## 为新的目标模型训练 speculator

本文不深入讲 speculator 训练。下面的流程总结自所引用的 vLLM Speculators 与 DeepSpec 资料[13]、[14]、[15]中的实践要点。

典型流程是：

  1. 准备有代表性的 prompt。
  2. 用目标模型生成回复。
  3. 选择 hidden state 的产生模式。
  4. 收集所需的目标模型 hidden state。
  5. 训练 speculator。
  6. 测试接受情况与部署吞吐。



### 准备有代表性的 prompt

先从能反映预期工作负载的 prompt 开始，例如对话、数学、代码生成、工具调用或多语言任务。评估用的 prompt 要单独留一份。

用于训练的回复应当由该 speculator 将要支持的那个目标模型生成。tokenizer、chat template、thinking 模式与生成配置也应当与预期的部署一致。vLLM 文档强调：把目标模型的 tokenizer 或 chat template 套到已有回复上，并不能让数据变成 target-specific 的；回复本身必须来自目标模型。

### 选择 hidden state 的获取方式

speculator 在训练过程中接收来自目标模型的内部 hidden state。vLLM Speculators 的流程支持三种提供方式：

训练模式| 工作方式| 主要考量
---|---|---
Online| hidden state 在需要时由运行中的 vLLM server 生成，用完即丢| 避免大量磁盘缓存，但需要同时为目标推理与训练准备资源
Offline| hidden state 在训练开始之前生成并存好| 之后所有 GPU 都可用于训练，但需要可观的存储
Hybrid| hidden state 在第一个 epoch 生成并缓存，之后复用| 生成成本只付一次，且不需要独立的预处理阶段

所选模式改变的是 hidden state 从哪里来，训练流程的其余部分大体相同。

### 收集目标模型信息

一个 vLLM server 可以运行目标模型，并暴露所选草稿方法需要的那些层的 hidden state。当选用自定义的目标层时，speculator 训练配置里也必须使用同一组层的选择。

要收集的信息取决于方法：

  - EAGLE-3 使用选定目标模型层的 hidden state 做自回归草稿。[4]
  - DFlash 使用目标模型特征来训练一个并行预测一整块未来位置的网络。[16]
  - DSpark 在 DFlash 式草稿网络上增加轻量的顺序 head 与置信度头。[6]
  - MTP 训练微调的是目标模型自己的 MTP 组件，因此要求目标模型本身已经包含兼容的 MTP 层。[13]



### 训练并测试 speculator

speculator 的配置必须与目标模型的 hidden size、词表、tokenizer 以及所选目标层相匹配。草稿网络深度、block 大小、序列长度、学习率这些方法特定的设置也要一并选定。

训练完成后，检查 checkpoint，并在 vLLM 中把它与目标模型一起部署。仅凭训练 loss 不足以判断结果；真正要看的测量是 accepted length、acceptance rate、草稿延迟、GPU 显存占用与端到端部署吞吐。vLLM Speculators 教程覆盖了从数据准备、hidden state 抽取，到 checkpoint 测试与部署的完整路径。

当某个工作负载上的接受情况不佳时，可以调整 prompt 组成或训练配置，再重复这一流程。核心原则是：使用与该 speculator 预期支持的场景相同的目标模型、生成模式与代表性工作负载。

---
## 总结

本文把 vLLM 中的投机解码作为一种面向 LLM 部署的草稿-验证方法做了探讨。草稿组件提出候选的未来 token，目标模型在任何 token 被提交之前完成评估。

我们考察了五种草稿方法：native MTP、Gemma 4 MTP、EAGLE-3、DFlash 与 DSpark。它们的主要区别在于如何使用来自目标模型的信息，以及候选 token 是按顺序生成、并行生成，还是走"并行预测 + 轻量顺序修正"的组合路径。

实验覆盖了选定的 Gemma、Qwen、MiniMax 与 Kimi 模型，运行在 AMD Instinct™ MI300X 与 MI355X GPU 上，使用 ROCm™ 软件平台。实测吞吐随目标模型、草稿 checkpoint、工作负载、提议长度与部署配置而变化。

在所测配置中，一些设置带来的变化较小，或者吞吐低于非投机基线，同时也有若干"模型 + 工作负载"组合的吞吐比超过 2×。观察范围上端的例子包括：gemma-4-26B-A4B-it 上 DFlash 的 2.87×、同一目标上 Gemma 4 MTP 的 2.83×，以及 Kimi-K2.5 上 DFlash 的 2.68×。

提议长度同样是一个重要的实验变量。增大 `num_speculative_tokens` 有时会在前几个设置上提升吞吐，而更大的取值可能导致平台期或吞吐下降。checkpoint 的推荐值可以作为起点，但选定部署配置时，仍然需要有代表性工作负载上的测量与接受率指标。

## 后续工作

后续的 benchmark 可以纳入非学习型的方法，例如 N-gram 投机解码与 suffix decoding，尤其是针对代码编辑与 agentic 循环这类存在重复 token 模式的工作负载。

在并发度、prompt 与输出长度、batch size 与采样设置上做更广的评估，也有助于说明投机解码在不同部署条件下的行为。

另一个有价值的方向是研究 speculator 的训练数据如何影响代码、数学、对话、多语言 prompt、工具调用与结构化输出上的接受情况。这能在为特定工作负载选择或训练草稿 checkpoint 时给出更清晰的指导。

最后，对草稿生成、目标验证、KV cache 行为、图执行与调度做更深入的 profiling，将有助于解释我们在不同目标模型与工作负载上观察到的性能差异。

---
## 附录

附录关注的是逐草稿位置的接受行为。

> 原文此处是一组 JS 驱动的交互面板，无法在公众号呈现，需要逐个组合查看时请到文末的英文原文链接。

**MAL**  指 mean accepted length，**AR**  指 acceptance rate。

**实验中使用的 vLLM serve 命令示例**

### `google/gemma-4-26B-A4B-it`

基线：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve google/gemma-4-26B-A4B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768
```

Gemma 4 MTP：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve google/gemma-4-26B-A4B-it \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --speculative-config '{"model":"google/gemma-4-26B-A4B-it-assistant","num_speculative_tokens":4}'
```

EAGLE-3：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve google/gemma-4-26B-A4B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.8 \
  --speculative-config '{"model":"RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3","num_speculative_tokens":1,"method":"eagle3"}'
```

DFlash：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve google/gemma-4-26B-A4B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --attention-backend triton_attn \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.8 \
  --speculative-config '{"method":"dflash","model":"z-lab/gemma-4-26B-A4B-it-DFlash","num_speculative_tokens":15,"attention_backend":"triton_attn"}'
```

### `google/gemma-4-31B-it`

基线：
```bash
vllm serve google/gemma-4-31B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768
```

Gemma 4 MTP：
```bash
vllm serve google/gemma-4-31B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template /app/vllm/examples/tool_chat_template_gemma4.jinja \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --speculative-config '{"model":"google/gemma-4-31B-it-assistant","num_speculative_tokens":1}'
```

EAGLE-3：
```bash
vllm serve google/gemma-4-31B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --speculative-config '{"model":"RedHatAI/gemma-4-31B-it-speculator.eagle3","num_speculative_tokens":3,"method":"eagle3"}'
```

DFlash：
```bash
vllm serve google/gemma-4-31B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --attention-backend triton_attn \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.85 \
  --speculative-config '{"method":"dflash","model":"z-lab/gemma-4-31B-it-DFlash","num_speculative_tokens":15,"attention_backend":"triton_attn"}'
```

DSpark：
```bash
vllm serve google/gemma-4-31B-it \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --attention-backend triton_attn \
  --language-model-only \
  --reasoning-parser gemma4 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --max-num-batched-tokens 16384 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.85 \
  --speculative-config '{"model":"RedHatAI/gemma-4-31B-it-speculator.dspark","num_speculative_tokens":7,"method":"dspark","attention_backend":"triton_attn"}'
```

### `Qwen/Qwen3-8B`

基线：
```bash
vllm serve Qwen/Qwen3-8B \
  --trust-remote-code \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.85
```

EAGLE-3：
```bash
vllm serve Qwen/Qwen3-8B \
  --trust-remote-code \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.85 \
  --speculative-config '{"model":"RedHatAI/Qwen3-8B-Thinking-speculator.eagle3","num_speculative_tokens":5,"method":"eagle3"}'
```

DFlash：
```bash
vllm serve Qwen/Qwen3-8B \
  --trust-remote-code \
  --max-num-batched-tokens 16384 \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.85 \
  --speculative-config '{"model":"z-lab/Qwen3-8B-DFlash-b16","method":"dflash","num_speculative_tokens":7}'
```

DSpark：
```bash
vllm serve Qwen/Qwen3-8B \
  --trust-remote-code \
  --max-num-batched-tokens 16384 \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.85 \
  --speculative-config '{"model":"deepseek-ai/dspark_qwen3_8b_block7","method":"dspark","num_speculative_tokens":11}'
```

### `Qwen/Qwen3.5-27B`

基线：
```bash
vllm serve Qwen/Qwen3.5-27B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768
```

Native MTP：
```bash
vllm serve Qwen/Qwen3.5-27B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":1}'
```

DFlash：
```bash
vllm serve Qwen/Qwen3.5-27B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"dflash","model":"z-lab/Qwen3.5-27B-DFlash","num_speculative_tokens":15}'
```

### `Qwen/Qwen3.5-122B-A10B`

基线：
```bash
vllm serve Qwen/Qwen3.5-122B-A10B \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --max-num-batched-tokens 32768
```

Native MTP：
```bash
vllm serve Qwen/Qwen3.5-122B-A10B \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":7}'
```

DFlash：
```bash
vllm serve Qwen/Qwen3.5-122B-A10B \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"dflash","model":"z-lab/Qwen3.5-122B-A10B-DFlash","num_speculative_tokens":15}'
```

### `Qwen/Qwen3.6-27B`

基线：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve Qwen/Qwen3.6-27B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768
```

Native MTP：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve Qwen/Qwen3.6-27B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

DFlash：
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
vllm serve Qwen/Qwen3.6-27B \
  --tensor-parallel-size 2 \
  --max-num-batched-tokens 32768 \
  --speculative-config '{"method":"dflash","model":"z-lab/Qwen3.6-27B-DFlash","num_speculative_tokens":15}'
```

### `Qwen/Qwen3.6-35B-A3B`

基线：
```bash
VLLM_ROCM_USE_AITER=1 \
vllm serve Qwen/Qwen3.6-35B-A3B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --mm-encoder-tp-mode data \
  --max-num-batched-tokens 16384
```

Native MTP：
```bash
VLLM_ROCM_USE_AITER=1 \
vllm serve Qwen/Qwen3.6-35B-A3B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --mm-encoder-tp-mode data \
  --max-num-batched-tokens 16384 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}'
```

DFlash：
```bash
VLLM_ROCM_USE_AITER=1 \
vllm serve Qwen/Qwen3.6-35B-A3B \
  --trust-remote-code \
  --tensor-parallel-size 2 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --mm-encoder-tp-mode data \
  --max-num-batched-tokens 16384 \
  --speculative-config '{"method":"dflash","model":"z-lab/Qwen3.6-35B-A3B-DFlash","num_speculative_tokens":15}'
```

### `moonshotai/Kimi-K2.5`

基线：
```bash
VLLM_ROCM_USE_AITER=1 \
VLLM_ROCM_QUICK_REDUCE_QUANTIZATION=INT4 \
vllm serve moonshotai/Kimi-K2.5 \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --language-model-only \
  --reasoning-parser kimi_k2 \
  --enable-auto-tool-choice \
  --tool-call-parser kimi_k2
```

EAGLE-3：
```bash
VLLM_ROCM_USE_AITER=1 \
VLLM_ROCM_QUICK_REDUCE_QUANTIZATION=INT4 \
vllm serve moonshotai/Kimi-K2.5 \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --language-model-only \
  --reasoning-parser kimi_k2 \
  --enable-auto-tool-choice \
  --tool-call-parser kimi_k2 \
  --speculative-config '{"model":"lightseekorg/kimi-k2.5-eagle3-mla","method":"eagle3","num_speculative_tokens":3}'
```

DFlash：
```bash
VLLM_ROCM_USE_AITER=1 \
VLLM_ROCM_QUICK_REDUCE_QUANTIZATION=INT4 \
vllm serve moonshotai/Kimi-K2.5 \
  --trust-remote-code \
  --tensor-parallel-size 4 \
  --language-model-only \
  --reasoning-parser kimi_k2 \
  --enable-auto-tool-choice \
  --tool-call-parser kimi_k2 \
  --speculative-config '{"model":"z-lab/Kimi-K2.5-DFlash","method":"dflash","num_speculative_tokens":7}'
```

### `MiniMaxAI/MiniMax-M3-MXFP8`

基线：
```bash
VLLM_ROCM_USE_AITER=1 \
VLLM_ROCM_USE_AITER_FUSION_SHARED_EXPERTS=1 \
VLLM_ROCM_QUICK_REDUCE_QUANTIZATION=INT4 \
VLLM_USE_BREAKABLE_CUDAGRAPH=0 \
VLLM_ROCM_USE_AITER_MOE=1 \
vllm serve MiniMaxAI/MiniMax-M3-MXFP8 \
  --tensor-parallel-size 8 \
  --block-size 128 \
  --attention_config.indexer_kv_dtype fp8 \
  --linear-backend emulation \
  --attention-backend TRITON_ATTN \
  --language-model-only \
  --reasoning-parser minimax_m3 \
  --enable-auto-tool-choice \
  --tool-call-parser minimax_m3
```

EAGLE-3：
```bash
VLLM_ROCM_USE_AITER=1 \
VLLM_ROCM_USE_AITER_FUSION_SHARED_EXPERTS=1 \
VLLM_ROCM_QUICK_REDUCE_QUANTIZATION=INT4 \
VLLM_USE_BREAKABLE_CUDAGRAPH=0 \
VLLM_ROCM_USE_AITER_MOE=1 \
vllm serve MiniMaxAI/MiniMax-M3-MXFP8 \
  --tensor-parallel-size 8 \
  --block-size 128 \
  --attention_config.indexer_kv_dtype fp8 \
  --linear-backend emulation \
  --attention-backend TRITON_ATTN \
  --language-model-only \
  --reasoning-parser minimax_m3 \
  --enable-auto-tool-choice \
  --tool-call-parser minimax_m3 \
  --speculative-config '{"method":"eagle3","model":"Inferact/MiniMax-M3-EAGLE3","num_speculative_tokens":3,"attention_backend":"TRITON_ATTN"}'
```

## 致谢

我们要感谢参与这次合作的所有人，包括来自 AMD 的 Hongxia Yang 与 Peng Sun，以及来自 Embedded LLM 的 Pin Siang Tan、Jun Kang Chow 与 Ye Hur Cheong。

---
## 声明

测量在 AMD Instinct™ MI300X 与 MI355X 平台上、按以下配置运行。

**硬件配置**

  - 硬件 1：8× AMD Instinct™ MI300X GPU（gfx942），配 2× AMD EPYC™ 9654 96 核处理器。
  - 硬件 2：8× AMD Instinct™ MI355X GPU（gfx950），配 2× AMD EPYC™ 9575F 64 核处理器。该平台用于 MiniMax-M3-MXFP8 实验。



**软件配置**

Ubuntu 22.04.5 LTS、ROCm/HIP runtime 7.2.53211、vLLM 0.23.1rc1.dev1120+g0f0f28b53、PyTorch 2.11.0+gitd0c8b1f、Transformers 5.13.1、Python 3.12.13。

服务器厂商的配置可能不同，从而得到不同的结果。性能可能随配置、软件、vLLM 版本，以及是否使用最新驱动与优化而变化。

---
**参考链接**

1. vLLM 文档：Speculative Decoding — [docs.vllm.ai/en/latest/features/speculative_decoding/](https://docs.vllm.ai/en/latest/features/speculative_decoding/)
2. vLLM 文档：MTP Speculative Decoding — [docs.vllm.ai/en/latest/features/speculative_decoding/mtp/](https://docs.vllm.ai/en/latest/features/speculative_decoding/mtp/)
3. Google Developers Blog：Multi-token prediction in Gemma 4 — [blog.google/innovation-and-ai/technology/developers-tools/multi-token-prediction-gemma-4/](https://blog.google/innovation-and-ai/technology/developers-tools/multi-token-prediction-gemma-4/)
4. EAGLE-3 论文：Scaling up Inference Acceleration of Large Language Models via Training-Time Test — [arxiv.org/pdf/2503.01840](https://arxiv.org/pdf/2503.01840)
5. Z-Lab：DFlash GitHub 仓库 — [github.com/z-lab/dflash](https://github.com/z-lab/dflash)
6. DSpark 论文（arXiv preprint） — [arxiv.org/pdf/2607.05147](https://arxiv.org/pdf/2607.05147)
7. Google：Gemma 4 Hugging Face 集合 — [huggingface.co/collections/google/gemma-4](https://huggingface.co/collections/google/gemma-4)
8. LightSeek Foundation 在 Hugging Face 上的模型集合 — [huggingface.co/lightseekorg/models](https://huggingface.co/lightseekorg/models)
9. Red Hat AI：Speculator Models Hugging Face 集合 — [huggingface.co/collections/RedHatAI/speculator-models](https://huggingface.co/collections/RedHatAI/speculator-models)
10. Z-Lab：DFlash Hugging Face 集合 — [huggingface.co/collections/z-lab/dflash](https://huggingface.co/collections/z-lab/dflash)
11. DeepSeek-AI：DeepSpec Hugging Face 集合 — [huggingface.co/collections/deepseek-ai/deepspec](https://huggingface.co/collections/deepseek-ai/deepspec)
12. Inferact 在 Hugging Face 上的模型集合 — [huggingface.co/Inferact/models](https://huggingface.co/Inferact/models)
13. vLLM Speculators 文档：Training a Speculator — [docs.vllm.ai/projects/speculators/en/latest/user_guide/tutorials/train/](https://docs.vllm.ai/projects/speculators/en/latest/user_guide/tutorials/train/)
14. vLLM Project：Speculators GitHub 仓库 — [github.com/vllm-project/speculators](https://github.com/vllm-project/speculators)
15. DeepSeek-AI：DeepSpec GitHub 仓库 — [github.com/deepseek-ai/DeepSpec](https://github.com/deepseek-ai/DeepSpec)
16. DFlash 论文（arXiv preprint） — [arxiv.org/pdf/2602.06036](https://arxiv.org/pdf/2602.06036)
> vLLM 官方博客
> 
> vllm.ai/blog/2026-08-23-speculative-decoding-amd-gpus

---

## 相关阅读

- [vLLM CodeWiki · Overview](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview) — **同项目架构解读**·vLLM 推理引擎的整体架构与五层组织，本篇的投机解码是其在部署侧的关键吞吐优化之一。
- [vLLM CodeWiki · 调度器与 KV Cache](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/02-scheduler-kv-cache) — **同项目架构解读**·投机解码的草稿-验证机制建立在 vLLM 调度器与连续批处理之上，对照可见 speculator 如何与调度循环交互。
- [vLLM CodeWiki · V1 引擎](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/01-v1-engine) — **同项目架构解读**·V1 三进程引擎（AsyncLLM↔EngineCore↔Worker）是 speculator 落地的运行时基座。
- [Efficient Memory Management for Large Language Model Serving with PagedAttention](/vibe-reading/articles/AI/Infra/Inference/vLLM/Papers/vllm-pagedattention-efficient-memory-management) — **对应论文**·vLLM 的 PagedAttention 与连续批处理，本篇投机解码在此基础上进一步压缩每 token 的 decode step 次数。

