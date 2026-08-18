---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "PIPO 模型与核心组件"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "Python", "Compressor", "MTP"]
description: "PIPOCompressor / MTP 头 / ConfidenceHead / Qwen3_5ForCausalPIPO 的定义、forward 数据流与设计决策"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

`pipo/qwen3_5/` 是 PIPO 的核心抽象层——把 Qwen3.5 backbone 之上的三个新组件（compressor、MTP、confidence head）封装成可被训练侧（HuggingFace `Qwen3_5ForCausalPIPO`）与推理侧（SGLang `qwen3_5_pipo.py`）**共享**的模型定义。它不依赖 ms-swift 或 SGLang 的任何实现，只依赖 `transformers` 基类，因此训练与推理可以各自装配同一套组件。graphify 数据中 `PIPOCompressor`（degree 15）、`Qwen3_5ForCausalPIPO`（degree 25）、`Qwen3_5MultiTokenPredictor`（degree 16）均为 god node，是全图最核心的抽象。

## 模块架构

本模块由四组组件构成，静态关系如下：

- **`PIPOCompressor`**（`compressor.py:L84`）：抽象基类，契约 `forward(embeds, **kwargs) → latent`。三子类 `LinearCompressor`/`MLPCompressor`/`GatedCompressor` 是可互换策略，经 `COMPRESSOR_REGISTRY` 按 `config.compressor_type` 选取。`GatedCompressor` 在早期消融中被弃用（未注册）。
- **`ConfidenceHead`**（`compressor.py:L18`）：独立于 compressor 的轻量头，`RMSNorm(2H)→Linear(2H,H)→SiLU→Linear(H,1)`，输入 `(backbone_hidden, mtp_hidden)` 拼接，输出 per-position 的 raw logit。
- **`Qwen3_5MultiTokenPredictor`**（`modeling_qwen3_5_mtp.py:L405`）：MTP 头，含 `fc(2H→H)`、两个 `pre_fc_norm`、1 层 full-attention `Qwen3_5DecoderLayer`、`norm`。它复用 backbone 的 `embed_tokens` 与 `lm_head`，不建独立词表。
- **`Qwen3_5ForCausalPIPO`**（`modeling_qwen3_5_mtp.py:L503`）：训练侧 HF 模型，组合 `Qwen3_5TextModel`（32 层 backbone）+ `compressor` + `mtp` + `lm_head`（tied）+ `confidence_head`，并在 `forward` 中编排 Pair-In/Pair-Out 的训练/推理前向与 chunked loss。

之所以把 compressor 与 ConfidenceHead 都放在 `compressor.py` 一个文件，是因为两者**结构对齐要求最高**——训练侧与 SGLang 推理侧都 import 它，权重 key 直接匹配（`compressor.*`/`confidence_head.*` 无需 remap），同文件保证两边同步演进不漂移。

## 调用链路

### 训练 forward（`labels is not None`）

```
Qwen3_5ForCausalPIPO.forward (modeling_qwen3_5_mtp.py:L644)
├─ 奇数长度补 PAD → 偶数                                   [L676-684]  input_ids[B,T]→[B,T+1]
├─ _embed_pad_and_compress(input_ids, attn_mask)            [L591-612]
│   ├─ embed_tokens(input_ids) → embeds [B,T,H]             [L604]
│   └─ compressor(embeds) → compressed [B,T//2,H]          [L605]
├─ self.model(compressed) → backbone_hidden [B,L,H]         [L691-697]  (L=T//2)
├─ backbone_hidden_in = backbone_hidden[:, :-1]             [L717]
│  sampled_token1   = input_ids[:, 2::2]                     [L720]      (teacher forcing)
├─ self.mtp(embed(sampled_token1), hidden_states=mtp_hidden_in) → mtp_out [B,L-1,H]  [L722]
├─ _chunked_linear_cross_entropy(backbone_hidden_in, labels[:,2::2], lm_head) → backbone_loss  [L729]
├─ _chunked_linear_cross_entropy(mtp_out, labels[:,3::2], lm_head, return_log_p_at_label=True) → mtp_loss  [L742]
├─ _chunked_conf_loss(backbone_hidden_in, mtp_out, labels[:,3::2], confidence_head,
│      conf_target = mtp_log_p_at_label.exp().clamp(0,1)) → conf_loss              [L766]
└─ loss = backbone_loss + mtp_loss_weight*mtp_loss + sft_conf_loss_weight*conf_loss  [L751,775]
```

### 推理 forward（`labels is None`）

```
forward(labels=None)
├─ _embed_pad_and_compress → backbone → backbone_hidden [B,L,H]
├─ logits = lm_head(backbone_hidden); logits1 = logits[:,-1:]            [L811-812]
├─ sampled_token1 = _sample_from_logits(logits1)                          [L814]
├─ mtp_out = self.mtp(embed(sampled_token1), hidden_states=backbone_hidden[:,-1:])  [L820]
├─ logits2 = lm_head(mtp_out); sampled_token2 = _sample_from_logits(logits2)        [L826-828]
└─ return (logits1, mtp_logits=[logits2], sampled_tokens=stack[tok1,tok2])           [L835]
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Qwen3_5ForCausalPIPO.__init__` (L516) | 装配 backbone+compressor+mtp+lm_head+conf | compressor 经 `COMPRESSOR_REGISTRY` 查表；conf 无条件实例化 |
| `_embed_pad_and_compress` (L591) | embed + 压缩 + 建 pair_mask | compressor 2D/3D 双兼容；丢弃未压缩的 position_ids 等 kwargs |
| `forward` (L644) | 训练/推理分支 + chunked loss | 训练算三项 loss；推理采两个 token |
| `_chunked_linear_cross_entropy` (L98) | 分块 CE，可选返回 `log p_s(label)` | piggy-back 避免二次 lm_head 前向 |
| `_chunked_conf_loss` (L206) | 分块 BCE on ConfidenceHead | 输入 detach 防退化；target 由 caller 传 |
| `_init_weights` (L566) | 模型权重初始化 | 显式跳过 compressor，由 plugin 显式 init |

</details>

## 核心实现

### Compressor 策略族与恒等初始化

三种 compressor 都实现"折叠相邻 pair"的同一契约，差异在拟合能力与初始化：

```python title="compressor.py（节选）"
class LinearCompressor(PIPOCompressor):       # L108
    def forward(self, embeds, **kwargs):
        # 2D: [num_tokens, H] 或 3D: [B, T, H] → reshape 合并相邻两 token → Linear(2H→H)
class MLPCompressor(PIPOCompressor):           # L171
    def forward(self, embeds, **kwargs):
        # reshape → Linear(2H→2H) → SiLU → Linear(2H→H)
class GatedCompressor(PIPOCompressor):         # L142（弃用，未注册）
    def forward(self, embeds, **kwargs):
        # α·e_i + β·e_{i+1} + δ(e_i - e_{i+1})，用 0::2/1::2 切片
```

三者 `init_weights` 都把权重初始化为**近似恒等叠加** `e_i + e_{i+1}`：`LinearCompressor` 的 `W=[I_H | I_H]`、`MLPCompressor` 第一层单位阵第二层 `[I_H | I_H]`、`GatedCompressor` bias 归零使 `σ(0)=0.5`。这样训练初始时 compressor 等价于把相邻 embedding 相加，backbone 看到的分布与原序列相近，**避免随机初始化导致 backbone 一开始就面对陌生的 latent 分布**。`COMPRESSOR_REGISTRY`（`L215`）只注册 `linear`/`mlp`，`GatedCompressor` 注释标"discarded in early ablation"。

### ConfidenceHead：为何输入是 (backbone_hidden, mtp_hidden) 拼接

`ConfidenceHead`（`compressor.py:L18-81`）的任务是预测 MTP 输出的 token2 会被 verify model 接受的概率。这个概率取决于两路信号：`backbone_hidden`（Phase1 输出，反映 token1 位置的上下文表示质量与"这个 pair 位置本身有多难"）和 `mtp_hidden`（Phase2 输出，反映 token2 预测本身的置信度）。单看 `mtp_hidden` 不够——缺少 backbone 提供的"位置难度"先验。拼接为 2H 后让 3 层 MLP 学习两者交互。参数量刻意保持 `~H²`（4B 模型约 6.6M），避免与 backbone/MTP 竞争容量。结构与调用：

```python title="compressor.py:ConfidenceHead"
def forward(self, backbone_hidden, mtp_hidden):
    x = torch.cat([backbone_hidden, mtp_hidden], dim=-1)   # [..., 2H]
    x = self.norm(x); x = self.fc1(x); x = self.act(x)
    return self.fc2(x).squeeze(-1)                          # [...] raw logit
```

### Chunked loss：把 O(T×V) 峰值压到 O(chunk×V)

Qwen3.5 词表 V=248,320。长上下文训练（压缩后 L=64K）时，完整 `[1, 64K, V]` logits 在 bf16 约 31.7 GB，`F.cross_entropy` 内部 fp32 upcast 再加 ~63 GB，backbone 与 MTP 两个 head 合计 100+ GB peak。`_chunked_linear_cross_entropy`（`L98-203`）沿 token 维按 `PIPO_LOGITS_CHUNK=2048` 分块，transient buffer 限制在 `2048×248320×4B ≈ 2GB`，约 15× 压缩。数值上等价——`reduction='sum'` 后统一除以 `n_valid`，梯度通过 chunked backward 正常累积到 `lm_head.weight.grad`。

### SFT conf 目标与 piggy-back 优化

在**确定性 teacher 假设**下（SFT label 就是 teacher argmax，`p_t=δ_{y_t}`），EAGLE per-pair accept rate `AR=Σ_y min(p_s(y),p_t(y))` 退化为 `min(p_s(y_t),1)=p_s(y_t)`。于是 SFT 阶段的 BCE target 直接是 student MTP head 在 ground-truth token2 上的概率 `p_s_mtp(label_token2)`（`L763-765`）。这个目标在确定性 teacher 极限下与 OPD 的 `min(1,p_t/p_s)` 和 `1−TV(p_s,p_t)` 都坍缩到同一值（`L226-229`），所以 SFT 训出的 conf head 能无缝迁移到 OPD 而无需参数 reset。

实现上做了 piggy-back 优化：`_chunked_linear_cross_entropy(return_log_p_at_label=True)` 在 MTP CE 前向中顺手 gather 出 `log p_s(label)`（detached, fp32），caller 只需 `.exp().clamp(0,1)` 即得 conf target，**避免第二次 lm_head 前向**——在 V≈248K 时 lm_head 是 chunk 循环主导开销，节省约 2×。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注册表 + 工厂 | `compressor.py:COMPRESSOR_REGISTRY` / `get_compressor` (L221) | 类型可插拔，训练/推理共享查表 |
| 模板方法 | `PIPOCompressor.forward`/`init_weights` (L84) | 基类定契约，子类填实现 |
| 策略 | `config.compressor_type` | 同接口多实现运行时切换 |
| 权重绑定 | `_tied_weights_keys` (L512) | `lm_head` 与 `embed_tokens` 共享，backbone/MTP logit 空间一致 |
| 环境变量注入 | `LOGITS_CHUNK_SIZE`/`SFT_CONF_LOSS_WEIGHT`/`SFT_CONF_DETACH_INPUTS` (L95,557) | 运行时调参不改 config |

## 模块间交互

![模块依赖关系](/vibe-reading/images/articles/pipo-internals/module-dependencies.svg)

本模块是依赖 hub：`swift_plugin.py:L107` import `Qwen3_5ForCausalPIPO` 加载模型；`swift_sft_trainer.py` 与 `swift_gkd_trainer.py`（`_accumulate_conf_chunk` L941、`_finalise_conf` L1005）调 `confidence_head()` 前向；SGLang 侧 `qwen3_5_pipo.py:L57` import `PIPOCompressor`/`LinearCompressor`/`MLPCompressor`/`ConfidenceHead`/`COMPRESSOR_REGISTRY`。**关键**：SGLang 只 import compressor 模块，不 import `modeling_qwen3_5_mtp.py`——推理侧用自己的 `Qwen3_5ForCausalPIPO(nn.Module)` 重实现 backbone 调度，但复用 compressor/ConfidenceHead 的 Python 类定义，验证了 compressor 模块被设计为独立可复用。

## 扩展方式

- **新增 compressor 类型**：在 `compressor.py` 加子类实现 `forward`/`init_weights`，并在 `COMPRESSOR_REGISTRY` (L215) 注册；无需改 `modeling_qwen3_5_mtp.py`（经 registry 解耦），SGLang 侧因 import 整个 registry 自动包含。
- **换 ConfidenceHead 架构**：改 `compressor.py:L18` 的 `__init__`/`forward`，并同步更新 `modeling_qwen3_5_mtp.py:L766` 调用、`swift_gkd_trainer.py:L986` 与 `_finalise_conf` L1050 的 ghost forward 签名、SGLang `qwen3_5_pipo.py` 推理路径。
- **增加 MTP 预测 token 数**：当前 `Qwen3_5MultiTokenPredictor` 只预测一个额外 token（`forward` 返回 `[logits2]`）。要多预测需改 MTP block 为链式 + 扩展 `forward` 训练/推理路径 + SGLang 增加第三步采样（架构改动较大）。
