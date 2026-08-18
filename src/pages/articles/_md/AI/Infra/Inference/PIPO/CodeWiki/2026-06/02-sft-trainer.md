---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "SFT 训练器"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "SFT", "LoRA", "ms-swift"]
description: "PIPOSeq2SeqTrainer 的随机 PAD 增强、thinking-template masking、conf warm-start 与 swift_plugin 注册机制"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/00-overview)

---

## 模块定位

SFT 训练器把 Qwen3.5 冻结 backbone 之上的 PIPO 组件（compressor + MTP + confidence head）通过 LoRA 监督微调出来。它不重新设计训练框架，而是以**插件 + 子类**方式接入 ms-swift：`swift_plugin.py` 负责把 `model_type=qwen3_5_mtp`/`task_type=pipo` 注册进 ms-swift 的 `TrainerFactory` 并热路由 GKD trainer，`swift_sft_trainer.py` 的 `PIPOSeq2SeqTrainer` 负责两件 PIPO 专属逻辑——**训练时随机插入 PAD**（让模型见过推理时 conf gate 跳过 token2 的分布）与 **confidence head 的 warm-start**。所有 loss 计算其实在 `Qwen3_5ForCausalPIPO.forward` 内部完成，trainer 只做数据预处理与日志。

## 模块架构

两组组件，静态关系简单：

- **`PIPOSeq2SeqTrainer`**（`swift_sft_trainer.py:L15`）：继承 ms-swift `Seq2SeqTrainer`。覆写 `compute_loss`（数据增强 + BOT masking + 调 model）与 `_log_component_losses`（记录 backbone/mtp/conf 三项 loss 与校准指标）。核心私有方法 `_build_random_padded_inputs`（`L111`）做向量化随机 PAD 插入。
- **`Qwen3_5MtpLoader`**（`swift_plugin.py:L101`）：继承 ms-swift `ModelLoader`。`get_model`（`L104`）负责读 `compressor_type`（多源优先级）、设 config、调 `Qwen3_5ForCausalPIPO.from_pretrained`、并在 checkpoint 缺 compressor 权重时显式 `init_weights()`。模块级还有 `_patch_cached_dataset_max_length`（`L15`）monkey-patch ms-swift 缓存数据集的 max_length 过滤。

之所以 trainer 不算 loss 而交给 model：PIPO 的三项 loss（backbone CE / MTP CE / conf BCE）共享中间量（`mtp_log_p_at_label` 既喂 MTP CE 又喂 conf target），放在 model forward 里能 piggy-back 避免二次 lm_head 前向；trainer 只管数据塑形。

## 调用链路

```
PIPOSeq2SeqTrainer.compute_loss (swift_sft_trainer.py:L43)
├─ Strip swift-specific keys (compute_loss_func/loss_scale/...)            [L53-60]
├─ Mask BOT tokens：找最后一个 -100，其后 N_BOT_TOKENS=2 个 label 设 -100    [L62-73]  mask ⊖\n
├─ Sample pad_ratio ~ Uniform[0, max_pad_ratio]                              [L75-82]
├─ _build_random_padded_inputs(input_ids, labels, pad_ratio)                 [L89, def L111]
│   ├─ Step1 保证 prompt 长度偶数（奇数则尾部插 PAD, label=-100）             [L158-169]
│   ├─ Step2 保证总长偶数                                                     [L171-175]
│   ├─ Step3-4 识别 eligible pair（奇数位 label≠-100）→ 随机选 split          [L177-195]
│   └─ Step5 向量化构建：非 split→(t1,t2)；split→(t1,PAD,t2,PAD)              [L197-231]
├─ model(**inputs) → Qwen3_5ForCausalPIPO.forward (内部算三项 loss)          [L97]
├─ _log_component_losses(outputs)                                            [L99, def L233]
└─ return (loss, outputs) or loss                                            [L109]
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `compute_loss` (L43) | 数据增强 + BOT mask + 调 model + 日志 | 不自己算 loss，model forward 内部完成 |
| `_build_random_padded_inputs` (L111) | 向量化随机 PAD 插入 | 所有 PAD 落奇数位（token2 位置），镜像推理 gating |
| `_log_component_losses` (L233) | 记录三项 loss + conf 校准指标 | 从 `Qwen3_5MTPCausalLMOutput` 读字段 |
| `training_step` (L266) | 包裹 template.forward_context + super | |
| `Qwen3_5MtpLoader.get_model` (swift_plugin.py:L104) | 加载模型 + 读 compressor_type | env>LoraConfig>additional_config>path>default |
| `_patch_gkd_trainer_for_pipo` (swift_plugin.py:L268) | 热路由 GKD→PIPOGKDTrainer | 覆写 'gkd' key，用户无需新 CLI flag |

</details>

## 核心实现

### 随机 PAD 插入：训练时镜像推理 gating 分布

推理时 `ConfidenceHead` 的 `sigmoid(output)` 作 per-pair commit gate——高则 commit token2，低则用 PAD 替换 token2（见 `compressor.py:L30-34` 注释）。这意味着推理时模型会遇到 PAD 分隔的 pair（token1 + PAD）。若训练时模型从未见过此模式，conf gate 的行为在推理时是 untested 的。`_build_random_padded_inputs` 是**训练时数据增强**：每步采 `pad_ratio ~ Uniform[0, max_pad_ratio]`（默认上限 0.25），在生成部分的 token pair 上随机把 `(t_{2p}, t_{2p+1})` 拆成 `{t_{2p}, PAD}, {t_{2p+1}, PAD}`，让模型见过 0 到 max_pad_ratio 的完整密度谱。

实现上有四个不变量保证（docstring `L119-129`）：

1. **prompt 长度偶数**：pair 边界必须与 prompt/generation 边界对齐，否则 compressor 会把无监督 token 与有监督 token 混进同一 pair。奇数则在 prompt 尾部插一个 PAD（label=-100）。
2. **总长偶数**：保证能干净配对。
3. **所有 PAD 落奇数位**：pair 结构 `(t_{2p}, t_{2p+1})` 中偶数位是 token1、奇数位是 token2。split pair 输出 `(t1, PAD, t2, PAD)`——t1 在偶数位、PAD 在奇数位，与推理时 conf gate skip token2 完全一致。
4. **eligible 判定**：`eligible_mask = labs[1::2] != -100`（`L182`）检查奇数位（token2 位置）label 是否需监督——只有 generation pair 才 eligible for PAD 插入。

### thinking-template masking：N_BOT_TOKENS=2

Qwen3.5 thinking template 格式 `<think>⊖\n...内容...\n</think>`，其中 `⊖\n` 是 thinking block 开头标记，本身不承载语义。代码找 labels 中最后一个 -100（prompt 结尾边界），其后 2 个 label 也设 -100，mask 掉 `⊖\n`（常量 `N_BOT_TOKENS=2`，`L12`），防止模型学习预测格式标记而非 thinking 内容本身。

### compressor_type 多源读取优先级

`Qwen3_5MtpLoader.get_model`（`swift_plugin.py:L147-153`）按以下优先级读 `compressor_type`：

```python
compressor_type = (
    os.environ.get("COMPRESSOR_TYPE")     # 1. env（最高，CLI 覆盖，保证实验可重复）
    or lora_compressor_type               # 2. LoraConfig.from_pretrained（adapter_config.json）
    or saved_compressor_type              # 3. additional_config.json（旧格式 fallback）
    or path_compressor_type               # 4. 路径名自动检测（"mlp"/"linear" in path）
    or compressor_default                 # 5. config.compressor_type（默认 "mlp"）
)
```

env 最高允许 shell 层覆盖（`swift_sft.sh:19` 取 arg1 → `:72` export），保证同一 checkpoint 可用不同 compressor 重训；LoraConfig > additional_config 因前者是 ms-swift 标准保存路径；path detection 兜底便于交互调试。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件注册 | `swift_plugin.py:register_model` (L240) | 不改 ms-swift 源码注入 `model_type=qwen3_5_mtp` |
| 工厂 | `TrainerFactory.TRAINER_MAPPING['pipo']` (trainer_factory.py:L16) | `task_type` → trainer 类，`importlib` 延迟导入避循环依赖 |
| 热补丁 | `_patch_gkd_trainer_for_pipo` (swift_plugin.py:L268) | 覆写 `'gkd'` key 使用户无需新 CLI flag，加载 plugin 即切 |
| 模板方法 | `compute_loss` 调 `super` + 覆写 | 继承 `Seq2SeqTrainer` 只加 PIPO 逻辑 |

## 模块间交互

`swift_plugin.py` 是本模块与 ms-swift 框架的黏合剂：加载 plugin 触发三连自动执行——`_patch_cached_dataset_max_length`(L98)、`register_model`(L240)、`_patch_gkd_trainer_for_pipo`(L288)。`TrainerFactory.get_trainer_cls(args)` 据 `task_type=pipo` 经 `TRAINER_MAPPING` 动态加载 `PIPOSeq2SeqTrainer`。trainer 调 `model(**inputs)` 进入 `Qwen3_5ForCausalPIPO.forward`，由 model 内部算 `backbone_loss + mtp_loss_weight*mtp_loss + sft_conf_loss_weight*conf_loss` 返回 `Qwen3_5MTPCausalLMOutput`，trainer 的 `_log_component_losses` 从中读字段记录。SFT 数据来自 `pipo/dataset` 的 `build_sft_data_on_results_jsonl.py` 产出（经 `export_cached_dataset.sh` 缓存为 parquet，由 `swift_sft.sh --cached_dataset` 加载）。

## 扩展方式

- **换 LoRA target_modules**：改 `swift_sft.sh:53` 的 `--target_modules`（如只训 attention 层去掉 `gate_proj` 等）。`--modules_to_save` (L54) 列全量训练模块（含 `confidence_head`/`compressor`/`mtp.*`）。
- **关掉 conf head SFT warm-start**：`export SFT_CONF_LOSS_WEIGHT=0`（`swift_sft.sh:36`），`Qwen3_5ForCausalPIPO.__init__` 使 `need_sft_conf=False`，conf head 走 ghost forward 保持 DDP graph 对齐但不产生有效梯度；并从 `--modules_to_save` 移除 `confidence_head`。
- **换 compressor 类型**：`bash scripts/swift_sft.sh linear`（arg1 → `COMPRESSOR_TYPE` env，优先级最高），或在 `COMPRESSOR_REGISTRY` 注册新类型后用 env 选。
