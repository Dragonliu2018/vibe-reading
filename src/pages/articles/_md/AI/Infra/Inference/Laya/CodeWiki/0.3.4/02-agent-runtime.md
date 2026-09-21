---
source:
  type: "源码解读"
  project: "Laya"
  url: "https://github.com/NandhaKishorM/laya"
title: "推理运行时"
date: "2026-09-21T00:15:00+08:00"
category: [AI, Infra, Inference, Laya, CodeWiki, "0.3.4"]
contentType: "CodeWiki"
tags: ["Laya", "推理", "PyTorch", "降级", "safetensors"]
description: "laya/agent.py 解读：Agent 检查点加载、tokenizer 自愈、兼容性校验、设备两级降级与 system_one 单次前向推理。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview)

---

## 模块定位

`laya/agent.py`（360 行）是单检查点的**推理运行时**：把"从 Hugging Face Hub 拿到的一个目录"变成一个可调用对象，并扛下所有工程脏活——下载、跨版本兼容自愈、架构校验、设备选择、两级 CPU 降级、精度选择、温度缩放推理。它对上暴露的契约只有一个：`system_one(state, questions) -> dict`（别名 `predict`）。

模块边界：模型长什么样、序列怎么拼，全在 `common.py`；选哪个检查点，在 `router.py`。`Agent` 只回答"这一个检查点怎么跑好"。

## 模块架构

`Agent` 实例持有五个状态：`cfg`（来自检查点目录的 `rl_agent_config.json`，含 `max_len` / `head_max_len` / `temperature` / `temperature_by_options` / `amp_dtype`）、`tok`（tokenizer）、`model`（`DecisionModel`）、`device` / `dtype`（运行环境决议结果）。`RLAgent` 是历史别名（`agent.py:348`），`load()` 模块级函数是便捷构造器——两者都指向同一个类，兼容两代 API 习惯。

模块内还有三个包级私有函数构成"加载质检流水线"：`_fix_tokenizer_config()`（tokenizer 自愈）、`_verify_compatibility()`（架构校验）、以及 `Agent.__init__` 主体里的设备/精度决议。它们不挂在类上，因为都是"构造时跑一次"的过程性逻辑。

## 调用链路

加载链（构造期）：

![Agent 加载与降级链](/vibe-reading/images/articles/laya-internals/agent-load.svg)

推理链（每次 `predict`）：`system_one()` → 逐问题 `_to_internal()` 规范化 → `build_sequence()` 产出 `(ids, markers)` → 选项溢出检查 → `collate_items()` 拼批 → autocast 前向 → numpy 化 → 逐问题 `temp_bucket` 取温度 → softmax → 按类型组装答案。端到端图见概览的[数据流 SVG](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/00-overview#核心运行流程)。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Agent.__init__()` | 下载 + 校验 + 构型 + 上设备 | 本地路径拼错直接 raise 而非静默走 Hub |
| `_fix_tokenizer_config()` | 修复 tokenizer_config 跨版本字段 | 就地改写缓存文件，幂等 |
| `_verify_compatibility()` | 权重与架构严格匹配检查 | 缺任一必需前缀/形状不匹配即 ValueError |
| `system_one()` / `predict` | 单次前向答所有问题 | OOM 自动 CPU 重跑一次 |
| `_to_internal()` | 用户问题 dict → 内部格式 | criteria 为 list 时转 `{c: None}`；instructions 非字符串转 JSON |
| `load()` | 模块级便捷构造 | subfolder 只下载对应目录 |

</details>

## 核心实现

### 加载自愈：两道防线

**第一道：tokenizer 跨版本修复**（`agent.py:21`）。`_fix_tokenizer_config()` 处理两类已知的 transformers 版本不兼容：`tokenizer_class` 为空或 `TokenizersBackend` 时改写为 `PreTrainedTokenizerFast`（并清掉 `backend` / `is_local` 噪声字段）；mmBERT/Gemma 系 tokenizer 的 `extra_special_tokens` 存成了 list（transformers 期望 dict，直接抛 `'list' object has no attribute 'keys'`）时改写为编号映射。关键是它**就地改写 Hub 缓存里的文件**（`json.dump` 回写），幂等且对后续所有进程生效——异常整体吞掉（`except Exception: pass`），修不好就交给 transformers 原生报错。

**第二道：架构严格校验**（`agent.py:49`）。`_verify_compatibility()` 在 `load_state_dict(strict=True)` 之前做三层检查：cfg 必需键（`encoder` / `head_layers`）、权重必需前缀（`encoder.` / `type_emb.` / `scorer.` / `act_head.`）、逐参数形状比对（最多展示 5 条不匹配 + 缺失键计数）。动机写在错误消息里：拿一个普通 BERT 权重喂给 Laya 时，用户看到的是"这不是 RL Agent 决策模型"而不是一屏 shape mismatch 栈。

### subfolder 捆绑下载

三个检查点打包在一个 Hub repo（`convaiinnovations/laya`）下，`Agent.__init__` 用 `allow_patterns=[f"{subfolder}/*"]` 只下载目标子目录（`agent.py:127`）——捆绑发布不强迫每个用户下载全家桶。同时防御了一个易犯错误：本地路径不存在时，若字符串长得像路径（`/`、`./`、`../` 开头或 `os.path.isabs`），直接 `FileNotFoundError` 而不是把它当 repo 名静默去 Hub 搜索（`agent.py:117`）。

### 设备决议与两级降级

精度选择（`agent.py:196-201`）遵循硬件代次：cfg 默认 `amp_dtype`，但 CUDA 算力 < 8（无 bf16 的老卡）强制 fp16；CPU/MPS 用 fp32。设备决议（`agent.py:156-172`）：`device=None` 时按 **cuda → mps → cpu** 顺序自动探测可用的第一个；用户显式传 `cuda` / `mps` 但不可用时，打印警告并回退 CPU 而不是抛异常。`reference_compile=False`（`agent.py:190`）关掉 ModernBERT 的默认 `torch.compile`——注释写明原因：Laya 的 batch 只有几个问题，compile 的收益变亏损，且部分平台会挂起。

两级降级共享同一个哲学——**降级可以，沉默不可以**：

```python title="laya/agent.py"
except (RuntimeError, torch.cuda.OutOfMemoryError) as e:
    if self.device.type != "cpu":
        # Record what actually went wrong: the reason matters more than the symptom,
        # and it is the only place the underlying exception is ever surfaced.
        fell_back_from, fell_back_why = self.device, e
```

构造期 `.to(device)` 失败 → 转 CPU + fp32，并打印完整原因、性能预期（~200-500 ms 而非 ~35 ms）和 Blackwell 显卡的 nightly torch 安装命令（`agent.py:218`）。推理期 `system_one` 内前向 OOM → 同样落 CPU 重跑（`agent.py:278`）。两级都只在非 CPU 设备上触发，CPU 上失败说明真有 bug，直接 re-raise。

### system_one：单次前向与温度分桶

推理编排的核心循环在结果组装段（`agent.py:300-337`）：

```python title="laya/agent.py"
for r, qid in enumerate(ids):
    k = len(items[r]["markers"])
    qt = QTYPES[q["t"]]
    t_scale = self.temperature_by_options.get(temp_bucket(qt, k), self.temperature[qt])
    z = logits[r, :k] / max(1e-3, float(t_scale))
    p = np.exp(z - z.max()); p = p / p.sum()
```

温度查表是两级 fallback：先查 `temperature_by_options` 的细粒度桶（`temp_bucket(qt, k)` 如 `"choice:6-10"`），miss 则退回按 qtype 的三温度。softmax 手写在 numpy 上（减 max 防 overflow）而不是 `torch.softmax`，因为 logits 已经搬回 CPU numpy——省一次设备往返。三种答案的组装差异：`choice` 取 argmax 键名 + 全选项概率；`score` 输出**期望分数** `Σ i·p_i`（连续值而非硬选档位——序数回归的正确姿势）加 legend；`noul` 输出 `p[1]`（true 档概率）且置信度改用 `max(p, 1−p)`（`agent.py:335`）。每个答案都附 `act_probability`（act 头的 softmax，"该决策建议人工介入"的信号）。`usage` 的 `output_tokens: 0` 是非自回归架构的诚实自述。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 自愈适配器 | `_fix_tokenizer_config()` in `laya/agent.py` | 隔离上游版本漂移，加载路径对用户透明 |
| 卫语句式校验 | `_verify_compatibility()` | fail-fast，错误消息可行动 |
| 备忘录（cfg 即状态） | `self.cfg` dict 贯穿加载与推理 | 校准温度等运行参数与权重同源存放、可就地修改 |
| 优雅降级 | 两级 OOM fallback | 服务可用性优先，但降级必带原因输出 |

## 模块间交互

import 自 `common.py`（七个符号，见[决策模型](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/01-decision-model)的交互节）。被 `router.py` 在 `Router.load()` 内**延迟 import**（`agent.py` 的 torch/transformers 导入开销因此不阻塞 `import laya`）；被 `tests/test_local_e2e.py` 直接消费做端到端验证。与 `lang.py` / `presets.py` / `email.py` 无联系。

## 扩展方式

- **换自定义检查点**：`Agent("本地目录")` 或 `Router(models={"mine": ("repo", "subfolder")})`——目录里备齐 `rl_agent_config.json` + `model.safetensors` + `tokenizer/`（+ 可选 `encoder/`）即可，校验逻辑会自动把关。
- **接入已有 Agent 实例**：`Router.attach("english", existing_agent)` 注入而非重载（见[模型路由](/vibe-reading/articles/AI/Infra/Inference/Laya/CodeWiki/0.3.4/03-router)）。
- **调序列预算**：运行时改 `agent.cfg["head_max_len"]` / `agent.cfg["max_len"]`（高基数选项场景的标准处方），`system_one` 每次调用都从 cfg 现读（`agent.py:256-257`）。
