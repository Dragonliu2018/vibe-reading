---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "决策模型"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "PyTorch", "Transformer", "评分规则", "校准"]
description: "laya/common.py 解读：DecisionModel 架构、build_sequence token 序列构造、proper_reward 严格正当评分规则与置信度估计。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview)

---

## 模块定位

`laya/common.py`（251 行）是整个项目的数学内核：**模型怎么搭、输入怎么拼、训练怎么打分、置信度怎么算**，全部在这一层定义。它不碰 IO、不碰设备管理、不知道 Hugging Face Hub 的存在——`agent.py` 只是它的工程外壳。同时它是唯一被推理端和训练端（notebook 的 `train_ddp.py`）共享的模块，`proper_reward` / `build_model` 在两边都以同名函数被引用，保证了"训练打分的分布"和"推理输出的分布"是同一个对象。

模块边界：凡是"给定张量做什么运算"归这里；"张量从哪来、放哪个设备、错了怎么降级"归 `agent.py`。

## 模块架构

模块内组件的静态划分是"一条数据变换管线上的四段"：

- **序列构造段**：`serialize_state()` / `render_criterion()` / `render_options()` / `build_sequence()`——把 (state, 问题定义) 变成 token id 列表和 marker 位；
- **模型段**：`DecisionModel`（`nn.Module`）——双向编码器 + 类型嵌入 + 决策头 + 动作头；`build_model()` 工厂按 cfg 构造；
- **评分段**：`proper_reward()` / `td_lambda_targets()`——训练期的奖励与目标构造；
- **度量段**：`ece_score()` / `confidence_from_probs()` / `temp_bucket()`——概率质量的度量与温度分桶。

组件间没有横向依赖，全部围绕"分布"这个核心数据形态：序列构造产出喂给模型的输入，模型输出选项分布 logits，评分段给分布打分，度量段把分布转成业务可读的置信度。

## 调用链路

![DecisionModel.forward 内部流程](/vibe-reading/images/articles/laya-internals/model-forward.svg)

推理期的关键路径是 `DecisionModel.forward()`（`common.py:105`）：编码器吃进 `input_ids` 得到 `last_hidden_state`，加上按问题类型查表的 `type_emb` 嵌入，过 2 层 `TransformerEncoder` 头部，然后在 `marker_pos` 指示的 MASK 位上 `torch.gather` 抽出每个选项的隐状态，`scorer` MLP 把它们映射成每选项一个 logit，无效位 `masked_fill(-1e4)`。分支出 `act_head`：取 CLS 池化向量拼上 4 个分布特征（top1 概率、top1−top2 差、归一化熵、选项数/255），预测"这个决策要不要人工复核"的动作概率。设计要点：**logits 与 act 的输入在 `forward` 内就分叉**——act 头消费的是 `logits.detach()` 后算出的特征，训练时梯度不会从 act 头流回 scorer，两个头各学各的。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `serialize_state()` | state 转文本（str 直过 / dict-list 转 JSON） | `ensure_ascii=False` 保住非拉丁原文 |
| `render_criterion()` | 单个 criteria 值转文本 | 结构化值转紧凑 JSON（`separators=(", ", ": ")`、`default=str`），防 Python repr 泄漏（PR #2 修复） |
| `render_options()` | 按类型渲染选项文本列表 | noul 恒为 `[false, true]`；0/False 是合法值不当作空 |
| `build_sequence()` | 拼 token 序列 + markers | 头部预算制：先保选项，instructions 只保底 8 token |
| `DecisionModel.forward()` | 序列 → (logits, act_logits) | marker 位 gather 打分；act 特征 detach 隔离梯度 |
| `build_model()` | cfg → DecisionModel | `attn_implementation="sdpa"` 默认走高效注意力 |
| `proper_reward()` | 分布 → 严格正当奖励 | log + 0.5·spherical + score 型加 RPS 惩罚 |
| `td_lambda_targets()` | 多轮轨迹的 TD(λ) 目标 | 按 `ep_group` 倒序累积混合 |
| `ece_score()` | 校准误差 | 15 桶加权平均 |
| `confidence_from_probs()` | 归一化熵置信度 | `1 − H(p)/log k`，对选项数不敏感 |
| `temp_bucket()` | (qtype, k) → 温度桶键 | 如 `"choice:6-10"`，按粒度分桶校准 |
| `collate_items()` | items → 批张量 | 自适应 target 有无，meta 字段透传 |

</details>

## 核心实现

### build_sequence：把问题编进序列

这是 Laya 最核心的发明——选项文本本身就在输入里，每个选项前置一个 MASK token 作为"打分位"：

```python title="laya/common.py"
def build_sequence(tok, state, q, max_len=512, head_max_len=192, ...):
    """Format: [CLS] <type> instructions [SEP] MASK opt0  MASK opt1 ... [SEP] state [SEP]."""
```

![token 序列布局](/vibe-reading/images/articles/laya-internals/sequence-format.svg)

预算分配算法（`common.py:70-75`）体现了明确的优先级：**选项文本最贵、instructions 次之、state 垫底**。头部总预算 `head_max_len` 先全部留给选项（每选项截到 48 token）；若选项溢出导致 `opt_budget < 16`，先把 instructions 截到只剩 `max(8, opt_budget)` 保底，再按 `(head_max_len - 16) // n_options` 均摊截断每个选项；state 用 `max_len` 减去头部后的剩余空间装，默认截右端（保留开头，`truncate_left=False`），传 `truncate_left=True` 则反向保留结尾（`st[-room:]`）。两个防御细节：文本里的 `mask_token` 字符串被替换成空格——防止用户输入伪造打分位；`markers` 只保留落在 `max_len` 内的位置，选项被完全截掉会在 `agent.py:263` 抛出 `ValueError` 而不是静默丢选项。

这个设计也直接解释了 README 承认的 Banking77 短板：77 个选项平摊 256 token 头部预算，每选项只剩 ~3 token，文本彼此不可区分，准确率崩到 0.425。

### DecisionModel：双向编码器上的决策头

```python title="laya/common.py"
class DecisionModel(nn.Module):
    def __init__(self, encoder, head_layers=2, n_act=2, dropout=0.1):
        d = encoder.config.hidden_size
        self.encoder = encoder
        layer = nn.TransformerEncoderLayer(d, max(1, d // 64), 4 * d, dropout,
                                           batch_first=True, norm_first=True)
        self.head = nn.TransformerEncoder(layer, head_layers, enable_nested_tensor=False)
        self.type_emb = nn.Embedding(3, d)          # choice/score/noul 三类
        self.scorer = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, d), nn.GELU(), nn.Linear(d, 1))
        self.act_head = nn.Sequential(nn.Linear(d + 4, 256), nn.GELU(), nn.Linear(256, n_act))
        self.register_buffer("temperature", torch.ones(3))
```

三处值得讲的设计决策：

1. **类型嵌入而非三套头**（`common.py:109`）：`h + self.type_emb(qtype)[:, None, :]` 把问题类型以加性嵌入广播到每个 token。一个模型同时服务三种语义不同的原语，靠这个信号让头部学会区分"选项间互斥的 choice"与"有序的 score"。
2. **头部是又两层 Transformer 而不是 MLP**（`common.py:97`）：选项 token 之间需要互相看见——判断"选项 A 是不是最佳答案"依赖与其它选项的对比，这要求注意力而非逐点映射。`norm_first=True` 是 Pre-LN 结构，训练更稳；`nhead = max(1, d // 64)` 随编码器宽度自适应（d=768 时 12 头），FFN 维度 4d。`head_layers=0` 时 `self.head` 为 `None`，`forward()` 里 `if self.head is not None` 直接跳过头部层——允许只训 scorer 的极简配置。
3. **temperature 是 buffer 不是超参**（`common.py:102`）：`register_buffer("temperature", torch.ones(3))` 让校准温度随 `state_dict` 一起存取——但注意权重侧的 `rl_agent_config.json` 里另有 `temperature` / `temperature_by_options` 两键，推理时 `agent.py` 用的是 cfg 字典那份（见[推理运行时](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/02-agent-runtime)），buffer 这份主要服务于训练期保存的完整性。

`build_model()`（`common.py:129`）决定动作头的输出维度：`n_act = len(cfg.get("act_costs", {})) + 1`——动作空间大小由 cfg 的 `act_costs` 表长度决定（默认空表 → n_act=2，"自动执行 vs 人工复核"二分）。它的 `encoder_dir` 参数分支（`common.py:132-136`）：`encoder_dir` 非空**且路径存在**时从本地目录读 `AutoConfig` 并 `AutoModel.from_config` 构造（微调产物场景）；否则（None 或路径不存在）回退 `AutoModel.from_pretrained(cfg["encoder"])` 从 Hub 拉取。两个分支都传 `attn_implementation="sdpa"`。`render_options()` 的 noul 分支有固定回退文案：criteria 缺省时两个选项渲染为 `"false: no, the statement does not hold"` 与 `"true: yes, the statement holds"`（`common.py:44-45`），顺序恒为 `[false, true]`。

`forward()` 中的 `masked_fill(~marker_mask, -1e4)`（`common.py:117`）用 -1e4 而非 -inf：padding 位压到 softmax 之后约等于 0，又不至于在 fp16 autocast 下溢出成 NaN。

### proper_reward：严格正当评分规则当奖励

RLCD 的"CD"全部落在这个函数（`common.py:140`）：

$$
r = \underbrace{\sum_k t_k \log q_k}_{\text{log score}} \;+\; w_{sph} \cdot \underbrace{\frac{\sum_k t_k q_k}{\lVert q \rVert_2}}_{\text{spherical score}} \;-\; w_{rps} \cdot \underbrace{\frac{1}{k-1}\sum_k \Big(\sum_{j\le k} q_j - \sum_{j\le k} t_j\Big)^2}_{\text{RPS（仅 score 型）}}
$$

```python title="laya/common.py"
def proper_reward(q, target, qtype, mask, w_sph=0.5, w_rps=1.0, log_floor=-9.21):
    logq = torch.log(q.clamp_min(1e-12)).clamp_min(log_floor)
    log_score = (target * logq).sum(-1)
    sph = (target * q).sum(-1) / q.norm(dim=-1).clamp_min(1e-9)
    r = log_score + w_sph * sph
    is_score = (qtype == QTYPES["score"]).float()
    if is_score.any():
        ...  # RPS 项按 CDF 差平方累计
```

三个分量都是**严格正当**（strictly proper）评分规则：报告分布 q 只有在等于真实分布 t 时期望得分才最大。为什么不用纯交叉熵？因为 log score 对低概率区域的惩罚无界，会教模型过度保守；spherical score 有界且对整体形状敏感；RPS 只对 `score` 型问题生效（`is_score` 掩码门控），因为它的 CDF 项隐含"选项有序"假设——对无序的 choice/noul 加 RPS 反而是错误归纳偏置。`log_floor=-9.21`（即 ln(1e-4)）封住 log 的下界，训练在 fp16 下才不会被一个 -inf 毁掉整批梯度。训练侧如何把这个奖励变成策略梯度，见[RLCD 训练深度附件](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model-rlcd-training)。

同在评分段的 `td_lambda_targets()`（`common.py:169`）服务多轮对话轨迹的训练：按 `ep_group` 把同一 episode 的样本分组、组内按 `ep_step` 排序，取最后一步的 `target[:, 1]` 作为 bootstrap 值，倒序递推 $G = (1-\lambda)\,p_{true}[j+1] + \lambda G$ 并写回 `target[j] = (1-G, G)`；batch 没有 `ep_group` 字段时原样返回 `target.clone()`。当前发布的微调 notebook 未用到它（单轮数据），它是为多轮场景预留的契约。

### 度量与校准：置信度、ECE、温度分桶

```python title="laya/common.py"
def confidence_from_probs(p, k):
    """Normalized Shannon entropy confidence: 1 - H(p) / log(k)."""
    ent = -(p * np.log(np.clip(p, 1e-12, 1.0))).sum()
    return float(np.clip(1.0 - ent / math.log(k), 0.0, 1.0))
```

置信度选**归一化熵**而非 top-1 概率，动机是跨题可比：二选一的 0.9 和二十选一的 0.3 传达的"确定程度"完全不同，除以 `log(k)` 后都归一到 [0,1] 同一语义；k < 2（单选项）直接返回 1.0。`noul` 型特殊（`agent.py:335`）：`max(p[1], 1−p[1])`，因为 k=2 时熵置信度分辨率太粗。`temp_bucket()` 把校准温度按 `(qtype, 选项数档位)` 分桶（`"2" / "3-5" / "6-10" / "11+"`），因为校准误差的结构随选项数变化——这直接对应 README 实测的"每 (类型, 选项数) 一个温度把 ECE 从 0.466 拉到 0.081"。

`ece_score()`（`common.py:187`）的实现是标准 15 桶 ECE：`np.linspace(0, 1, bins+1)` 划分置信度区间，每桶贡献 `桶样本占比 × |平均置信度 − 平均实际正确率|`，空输入返回 NaN。批组装侧的 `collate_items()`（`common.py:218`）接受**两层嵌套**的 batch（group of items，先展平 `[it for group in batch for it in group]`，空则返回 None），target 张量形状 `(n, kmax)`（kmax 为最大选项数）、仅当任一 item 带 `target` 时才创建，`label` 缺省填 −1，meta 字段透传时排除 `ids` / `markers` / `target` 三个大数组键。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 工厂方法 | `build_model()` in `laya/common.py` | encoder_dir 存在走本地 `from_config`、否则 Hub `from_pretrained`，编码器来源分叉收敛到一处 |
| 策略分发 | `render_options()` 按 `q["t"]` 三分支 | 三种原语的渲染差异集中一个函数，新原语只需加分支 |
| 值对象 | `QTYPES` / `QTYPE_NAMES` 双向映射 | qtype 在张量里是 int、在业务里是字符串，一处定义两向转换 |
| 防御式解析 | `render_criterion()` 的 `default=str` | 结构化 criteria 值永不 raise，保底转字符串 |

## 模块间交互

被 `agent.py` import（`build_sequence` / `build_model` / `collate_items` / `confidence_from_probs` / `temp_bucket` / `render_options` / `amp_dtype`）——是运行时唯一的重度消费者；被 notebook 训练脚本 import（`build_model` / `proper_reward` / `QTYPES`）。它不 import 任何内部模块，处在依赖图最底层。`router.py` 与它没有直接联系：路由决策发生在序列构造之前。

## 扩展方式

- **换编码器**：`rl_agent_config.json` 的 `encoder` 字段换成任何 `AutoModel` 支持的模型名，`build_model()` 会用 `AutoModel.from_pretrained(..., attn_implementation="sdpa")` 构造；头部维度 `d = encoder.config.hidden_size` 自动适配。
- **加第四种问题原语**：`QTYPES` 加键 → `render_options()` 加分支 → `type_emb` 的 `nn.Embedding(3, d)` 改 4 → `agent.py` 的 `system_one()` 结果组装加分支。这是全链路改动，成本最高，也说明三原语是刻意的封闭集合。
- **调序列预算**：`build_sequence()` 的 `max_len` / `head_max_len` 形参由 `agent.cfg` 传入，运行时改 cfg 即生效，无需改码。
