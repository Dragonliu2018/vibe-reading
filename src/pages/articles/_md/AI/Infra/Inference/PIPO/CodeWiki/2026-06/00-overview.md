---
source:
  type: "源码解读"
  project: "PIPO"
  url: "https://github.com/redai-infra/PIPO"
title: "Overview"
date: "2026-08-18T21:08:21+08:00"
category: [AI, Infra, Inference, PIPO, CodeWiki, "2026-06"]
tags: ["PIPO", "Python", "LLM 推理加速", "多 token 预测"]
description: "Pair-In, Pair-Out：在 Qwen3.5 上用 latent 压缩 + MTP + 置信度门控加速 LLM 推理的源码解读"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2026-06（commit `23ff0fa`）· **协议** Apache-2.0 · **语言** Python ≥ 3.12 · **代码量** ~10,400 行（`pipo/` + `sglang_eval.py`，不含 third_party）· **仓库** [github.com/redai-infra/PIPO](https://github.com/redai-infra/PIPO) · **论文** [arXiv 2605.27255](https://arxiv.org/abs/2605.27255)

---

## 总览

### 项目简介

**PIPO**（Pair-In, Pair-Out）是 [arXiv 2605.27255](https://arxiv.org/abs/2605.27255) 的官方实现，来自小红书 AI 平台与中国人民大学。它解决一个核心问题：**长思维链推理让自回归解码成为现代 LLM 的主要推理成本**。已有的加速方案分两路独立发展——输入侧的 latent compression（把多个 token 压成一个潜变量）和输出侧的 multi-token prediction / speculative decoding（一次预测多个 token）。PIPO 把这两条路统一成一组镜像操作：

- **Pair-In**：`PIPOCompressor` 把相邻两个 token embedding 折叠成一个 latent，backbone 在半长序列上运行，做**输入侧压缩**；
- **Pair-Out**：`Qwen3_5MultiTokenPredictor`（MTP 头）从一个 hidden state 展开一个额外输出 token，做**输出侧展开**；
- **ConfidenceHead**：一个轻量置信度头决定 MTP 预测的 draft token 是否应被接受，**免去传统 speculative decoding 昂贵的 verifier pass**。

关键洞见是：PIPO 的 compressor 与 MTP 头互为镜像——compressor 折叠两个输入 token 成一个 latent，MTP 头展开一个 hidden 成一个额外输出 token，两者共享 backbone 与 `lm_head`，参数空间一致。而为消除 verifier 成本，PIPO 训练 `ConfidenceHead` 预测 draft token 的接受率，并发现 **On-Policy Distillation（OPD）天然匹配 speculative decoding 的拒绝采样准则**，于是置信度头可以与 OPD 一起以近乎零额外成本训练。

在 AIME 2025、GPQA-Diamond、LiveCodeBench v6、LongBench v2 上用 Qwen3.5-4B/9B 的实验表明，PIPO 相对常规解码提升 pass@4 最多 +7.15 分，同时带来最高 2.64× 首 token 延迟与 2.07× 每 token 延迟加速。

**项目边界**：PIPO 负责 Qwen3.5 backbone 之上的 compressor + MTP + confidence head 的训练（SFT/OPD）与推理（SGLang 两阶段 decode）路径。它**不负责**重新设计 backbone 架构、不替代 SGLang/ms-swift 框架本身（而是 fork 后扩展），当前也**只支持 Qwen3.5 系列** backbone。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
| --- | --- | --- |
| Pair 压缩（2→1 latent） | `pipo/qwen3_5/compressor.py` | `PIPOCompressor` 基类 + Linear/MLP/Gated 三策略，2D/3D 双兼容 |
| MTP 头（1→1 额外 token） | `pipo/qwen3_5/modeling_qwen3_5_mtp.py` | `Qwen3_5MultiTokenPredictor`，1 层 full-attention decoder |
| 置信度门控 | `pipo/qwen3_5/compressor.py` | `ConfidenceHead`：RMSNorm→Linear→SiLU→Linear，训练/推理共享 |
| SFT 训练 | `pipo/trainer/swift_sft_trainer.py` | `PIPOSeq2SeqTrainer`：随机 PAD 增强 + conf warm-start |
| OPD 蒸馏训练 | `pipo/trainer/swift_gkd_trainer.py` | `PIPOGKDTrainer`：SGLang rollout + chunked sampled-KL + conf EAGLE 目标 |
| ms-swift 插件注册 | `pipo/trainer/swift_plugin.py` | `Qwen3_5MtpLoader` + `register_model` + GKD 热路由 |
| SGLang 两阶段 decode | `third_party/sglang/.../qwen3_5_pipo.py` | Phase1 backbone（CUDA Graph）+ Phase2 MTP（eager） |
| 数据构建 | `pipo/dataset/build_*_data_on_results_jsonl.py` | 从 9B teacher rollout 构建 SFT/RL 数据 |
| 评测流水线 | `sglang_eval.py` + `pipo/eval/` | in-process Engine + 三阶段评分（规则→LCB→Excel） |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| **ms-swift**（fork） | 核心 | 训练框架：LoRA SFT + GKD RL trainer 扩展，`TrainerFactory` 注册 |
| **SGLang**（fork） | 核心 | 推理引擎：两阶段 decode、CUDA graph、调度、KV cache |
| **LiveCodeBench**（fork） | 核心 | 代码题执行评测（`lcb_runner`） |
| PyTorch + DeepSpeed ZeRO-2 | 核心 | 分布式训练，8 GPU DDP + 梯度分桶 reduce-scatter |
| transformers（HuggingFace） | 核心 | 模型定义基类、`DynamicCache`、`create_causal_mask` |
| Qwen3.5-4B / 9B | 基座 | LoRA 基座（4B 学生）+ 蒸馏教师（9B teacher） |
| flash-attention-2 | 可选 | 注意力实现；mRoPE bsz=1 有 bug 时 fallback `sdpa` |

### 顶层上下文图

```
              ┌─────────────┐  9B teacher rollout
              │ 9B teacher  │ ──────────────┐
              └─────────────┘               ▼
       ┌─────────────────────┐   ┌──────────────────┐
       │  研究者（训练/评测）  │──▶│  sglang_eval.py  │──┐
       └─────────────────────┘   └──────────────────┘  │ results.jsonl
                    │                      │            ▼
                    │ bash swift_sft.sh     │  ┌──────────────────┐
                    │ bash swift_opd.sh     │  │ pipo/dataset/     │
                    ▼                      │  │ build_*_data      │
              ┌──────────────────┐          │  └──────────────────┘
              │  PIPO 训练管线    │◀─────────┘         │ SFT/RL 数据
              │ (SFT + OPD)      │                    │
              └──────────────────┘                    │
                    │ merged checkpoint                │
                    ▼                                  ▼
              ┌──────────────────┐            ┌──────────────────┐
              │ SGLang 推理后端   │◀───────────│  pipo/eval 三阶段  │
              │ --enable-pipo    │            │  评分 + Excel     │
              └──────────────────┘            └──────────────────┘
                    │
                    ▼ 服务加速输出 [token1, token2] / step
```

PIPO 的外部交互方有三：研究者（驱动训练/评测脚本）、9B teacher（提供 rollout 蒸馏信号）、SGLang 推理引擎（部署加速后的 checkpoint）。数据在 `results.jsonl` 与 `data/*.jsonl` 之间回流：teacher rollout → 评测填 accuracy → build 脚本构训练数据 → 训练 → 推理。

---

## 快速上手

```bash title="快速上手"
# 1. 环境
conda create -n pipo python=3.12 -y && conda activate pipo
cd /path/to/PIPO && bash scripts/install.sh   # 装 fork 的 sglang + ms-swift + 依赖

# 2. 下载 checkpoint（HF: AlbertTan/PIPO）放到 PIPO/outputs/
# 3. 合并 LoRA 权重
bash scripts/merge_lora.sh outputs/Qwen3.5-4B/sft_mlp_sft_all_65535_0.25_2epochs/checkpoint-1500

# 4. 用 PIPO 路径评测（端到端验证）
python sglang_eval.py --model_path=outputs/Qwen3.5-4B/sft_mlp_sft_all_65535_0.25_2epochs/checkpoint-1500-merged
# 结果写入 <model_path>/eval/，含 results.jsonl + stats.xlsx
```

最简的"跑起来了"验证：`sglang_eval.py` 启动 in-process `sglang.Engine(enable_pipo=True)`，对 AIME/GPQA/LiveCodeBench/LongBench 逐题生成并写 `*-results.jsonl`，再调 `pipo/eval/eval.sh` 三阶段评分产出 `stats.xlsx`。对照基线只需 `--model_path=Qwen/Qwen3.5-4B`（常规解码）或加 `--enable_eagle`（Qwen3.5 原生 MTP + EAGLE-2 投机解码）。

---

## 架构设计解析

### 系统架构

PIPO 的设计思想是**用对称的压缩-展开操作统一输入侧与输出侧的加速**，并把"是否信任 draft token"这一原本需要 verifier 的问题转化为一个可随训练习得的轻量二分类。架构上分五层，自上而下依赖：

![PIPO 分层架构](/vibe-reading/images/articles/pipo-internals/architecture.svg)

最上层是**评测与入口层**，`sglang_eval.py` 用 in-process `sglang.Engine` 驱动生成，`pipo/eval/` 做后处理评分——它既是基线对照的入口，也是 OPD 训练 rollout 的提供者（9B teacher 在此 rollout）。**训练层**含两条线：SFT（`PIPOSeq2SeqTrainer`）做监督微调与 conf head warm-start，OPD（`PIPOGKDTrainer`）做在策略蒸馏；两者通过 `swift_plugin.py` 注册到 ms-swift 的 `TrainerFactory`。**模型与组件层**是核心——`pipo/qwen3_5/` 定义 `PIPOCompressor`、`Qwen3_5MultiTokenPredictor`、`ConfidenceHead` 与 `Qwen3_5ForCausalPIPO`，被训练层与推理层**共享**（推理侧 SGLang 直接 import `compressor.py`）。**推理后端层**是 fork 后扩展的 SGLang，`qwen3_5_pipo.py` 实现两阶段 decode，`tp_worker`/`schedule_batch`/`cuda_graph_runner` 贯穿 PIPO 专属的 `input_ids_pair`、`pipo_padded_input_ids`、`pipo_backbone_hidden`、`pipo_phase`、`pipo_token2_conf` 字段。最底**数据与基座层**：`pipo/dataset/` 从 teacher rollout 构数据，Qwen3.5 冻结 backbone 作 LoRA 基座，9B teacher 作蒸馏教师。

层间依赖方向单一（上层依赖下层），关键跨层关系有两条：OPD 训练器依赖 9B teacher（蒸馏），SGLang 推理后端依赖模型层的 `compressor.py`（结构对齐，权重名直接匹配无需 remap）。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 评测与入口 | `sglang_eval.py`、`pipo/eval/` | 隔离生成与评分，提供端到端验证与 OPD rollout 数据 |
| 训练 | `pipo/trainer/` | 编排 SFT/OPD 流程，协调模型 forward 与 ms-swift 框架 |
| 模型与组件 | `pipo/qwen3_5/` | 承载 Pair-In/Pair-Out 核心抽象，训练/推理共享，不依赖任何外部框架实现 |
| 推理后端 | `third_party/sglang/`（扩展部分） | 适配 SGLang 调度与 CUDA graph，把模型层落地产能为两阶段 decode |
| 数据与基座 | `pipo/dataset/`、Qwen3.5、9B teacher | 封装数据构建与外部模型依赖，对上提供训练数据与教师信号 |

### 设计模式

| 模式 | 位置（文件:方法） | 为什么用 |
| --- | --- | --- |
| 注册表 + 工厂 | `compressor.py:COMPRESSOR_REGISTRY` / `get_compressor` | compressor 类型可插拔，训练/推理共享同一查表逻辑 |
| 插件注册 | `swift_plugin.py:register_model` / `_patch_gkd_trainer_for_pipo` | 不改 ms-swift 源码即注入 `model_type=qwen3_5_mtp` 与 GKD 重路由 |
| 模板方法 | `PIPOCompressor.forward` / `init_weights` | 基类定契约，子类（Linear/MLP/Gated）填实现 |
| 策略 | `config.compressor_type` 选 compressor；`evaluator_map` 选评分器 | 同接口多实现，运行时切换 |
| 分块处理 | `_chunked_linear_cross_entropy`、`_compute_chunked_sampled_kl` | 把 `O(T×V)` logits 峰值压到 `O(chunk×V)`，长上下文训练必需 |
| 权重绑定 | `Qwen3_5ForCausalPIPO._tied_weights_keys` | `lm_head` 与 `embed_tokens` 共享，减参数且 backbone/MTP logit 空间一致 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `PIPOCompressor` | 把 `[..., 2T, H]` 折成 `[..., T, H]` 的 latent 压缩器 | 模型 `__init__` 实例化，随 checkpoint 存取 | 被 `Qwen3_5ForCausalPIPO` 与 SGLang 模型共享 import |
| `Qwen3_5MultiTokenPredictor` | MTP 头：`hidden + token1_embed → 额外 token` | 同上 | 复用 backbone 的 `embed_tokens`/`lm_head` |
| `ConfidenceHead` | 预测 MTP token2 接受率的轻量头（~6.6M 参数） | 模型 `__init__` 无条件实例化 | 输入 `(backbone_hidden, mtp_hidden)` 拼接 |
| `Qwen3_5ForCausalPIPO` | 训练侧 HF 模型，组合上述三组件 | `from_pretrained` 加载 | 组合 compressor/mtp/confidence_head/lm_head |
| `input_ids_pair` | 推理 decode 时每请求最近 2 token `[B,2]` | `prepare_for_decode` 构建，每步重建 | SGLang `ForwardBatch` 的 pipo 字段 |
| `pipo_backbone_hidden` | Phase1 backbone 输出，供 Phase2 用 | CUDA graph replay 后挂回 `forward_batch` | Phase1 写、Phase2 读 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `PIPOCompressor`（基类） | `compressor.py:L84` | `LinearCompressor`、`MLPCompressor`、`GatedCompressor`（弃用） | `COMPRESSOR_REGISTRY` dict + `config.compressor_type` |
| `PIPOGKDTrainer`（OPD 契约） | `swift_gkd_trainer.py` | 继承 ms-swift `GKDTrainer` | `swift_plugin` 热补丁 `TrAINER_MAPPING['gkd']` |
| 评分器（`evaluator_map`） | `evaluator.py` | `MathEvaluator`、`MCQEvaluator` | dict 注册，按 dataset 名分派 |


---

## 代码目录

```
PIPO/
├── pipo/                          # PIPO 核心包（~10,400 行）
│   ├── qwen3_5/                   # 模型与组件层
│   │   ├── compressor.py          # PIPOCompressor + ConfidenceHead + REGISTRY
│   │   ├── modeling_qwen3_5_mtp.py # Qwen3_5ForCausalPIPO + MTP + chunked loss
│   │   ├── modeling_qwen3_5.py    # Qwen3.5 backbone（HuggingFace 移植）
│   │   ├── configuration_qwen3_5.py # Config（含 compressor_type 字段）
│   │   └── modular_qwen3_5.py     # modular 模型组合
│   ├── trainer/                   # 训练层
│   │   ├── swift_plugin.py        # ms-swift 插件：注册 + GKD 热路由
│   │   ├── swift_sft_trainer.py    # PIPOSeq2SeqTrainer（SFT）
│   │   └── swift_gkd_trainer.py   # PIPOGKDTrainer（OPD，2171 行，最复杂）
│   ├── dataset/                   # 数据构建
│   │   ├── build_sft_data_on_results_jsonl.py
│   │   ├── build_rl_data_on_results_jsonl.py
│   │   └── export_cached_dataset.sh
│   ├── eval/                       # 评测三阶段 + benchmark 加载
│   └── constants.py / utils.py    # prompt 模板与工具
├── sglang_eval.py                 # 评测入口（in-process sglang.Engine）
├── scripts/                       # install/download/merge_lora/swift_sft/swift_opd
├── third_party/                   # fork 的 SGLang / ms-swift / LiveCodeBench
│   └── sglang/python/sglang/srt/
│       ├── models/qwen3_5_pipo.py # PIPO 推理模型（forward 三分支 + load_weights）
│       ├── managers/tp_worker.py   # 两阶段采样 + confidence gating
│       └── managers/schedule_batch.py # input_ids_pair / pipo_padded_input_ids
└── .agents/PIPO.md                # 项目知识库（agent 工作前必读）
```

一级目录清晰：`pipo/` 是 PIPO 自有代码，`third_party/` 是三个被 fork 扩展的框架，`scripts/` 是启动脚本，`sglang_eval.py` 是评测入口。模块级文件分析见各模块文档。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/pipo-internals/module-dependencies.svg)

模块依赖以 `pipo/qwen3_5`（模型与组件）为 hub：训练层（SFT/OPD）和推理层（SGLang）都 import 它的 compressor/confidence head；数据层向训练层喂数据、向评测层消费 results.jsonl；OPD 额外依赖 9B teacher 做蒸馏。`swift_plugin.py` 是训练层与 ms-swift 框架的黏合剂（注册 + 热路由），SGLang 推理后端则扩展了 `tp_worker`/`schedule_batch`/`cuda_graph_runner`。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| PIPO 模型与组件 | 定义 Pair-In/Pair-Out 核心架构 | `compressor.py:PIPOCompressor` | 核心抽象层，训练+推理共享，不依赖任何框架 | [01-pipo-model](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/01-pipo-model) |
| SFT 训练器 | SFT 阶段：随机 PAD 增强 + conf warm-start | `compute_loss` in `swift_sft_trainer.py` | 数据增强与 conf head 预热逻辑专属，对接 ms-swift | [02-sft-trainer](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/02-sft-trainer) |
| OPD 训练器 | 在策略蒸馏：rollout + sampled-KL + conf EAGLE 目标 | `_compute_loss_single` in `swift_gkd_trainer.py` | 最大最复杂模块（2171 行），蒸馏专属且 force PIPO rollout | [03-opd-trainer](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/03-opd-trainer) |
| SGLang 推理后端 | 两阶段 decode + CUDA graph + 调度 | `forward` in `qwen3_5_pipo.py` | 推理加速执行层，fork 扩展 SGLang | [04-sglang-inference](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/04-sglang-inference) |
| 数据构建 | 从 teacher rollout 构 SFT/RL 数据 | `main` in `build_sft_data_on_results_jsonl.py` | 数据流水线独立于训练，产出可缓存 | [05-dataset](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/05-dataset) |
| 评测系统 | in-process 评测 + 三阶段评分 | `main` in `sglang_eval.py` | 评测独立于训练，兼做 OPD rollout 产出方 | [06-eval](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/06-eval) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

## 运行时行为

### 启动流程

PIPO 有三个启动入口，共享一套对象装配逻辑：

```
sglang_eval.py:main (L229)
  → get_args → 构造 engine_kwargs{enable_pipo, disable_radix_cache, PIPO_CONF_THRESHOLD}
  → sgl.Engine(**kwargs)            # in-process 引擎，读 qwen3_5_pipo 模型
  → load_datasets → 逐题 async_generate → 写 results.jsonl → 调 eval.sh

swift_sft.sh → swift sft --external_plugins pipo/trainer/swift_plugin.py --model_type qwen3_5_mtp
  → swift_plugin 导入触发三连：_patch_cached_dataset_max_length / register_model / _patch_gkd_trainer_for_pipo
  → TrainerFactory.get_trainer_cls(task_type=pipo) → PIPOSeq2SeqTrainer
  → Qwen3_5MtpLoader.get_model → Qwen3_5ForCausalPIPO.from_pretrained（含 compressor_type 多源读取）

swift_opd.sh → swift rlhf --rlhf_type gkd --external_plugins ...
  → 同上插件注册 → TRAINER_MAPPING['gkd'] 已被热路由 → PIPOGKDTrainer
  → _prepare_sglang_engine force enable_pipo/disable_radix_cache → colocate SGLang rollout
```

对象装配的关键：compressor + ConfidenceHead 在 `Qwen3_5ForCausalPIPO.__init__` 中**无条件实例化**（不论是否训练 conf，都进 autograd 图，靠 ghost forward 保持 ZeRO-2 桶对齐）；`compressor_type` 由 `Qwen3_5MtpLoader` 按 `env > LoraConfig > additional_config.json > 路径推断 > config 默认` 优先级读取；LoRA `target_modules` 按后缀匹配，同时打到 backbone 层与 `mtp.layers.0` 投影。

### 核心运行流程

下面三条链路覆盖了 PIPO 的训练与推理运行模式。前两条是核心加速与蒸馏主链路，第三条是数据增强训练链路。

#### 推理：PIPO 两阶段 Decode（加速主链路）

业务流程：用户 prompt → 偶数 padding → prefill 压缩 → 进入 decode 循环，每步采两个 token（Phase1 backbone 走 CUDA Graph 采 token1，Phase2 MTP + 置信度门控采 token2）→ 输出 `[token1, token2]`。

![两阶段 Decode 数据流](/vibe-reading/images/articles/pipo-internals/decode-flow.svg)

文字描述：`tokenizer_manager._tokenize_one_request` 先把奇数长度补 PAD 成偶数；prefill 时 `schedule_batch.prepare_for_extend` 保存完整 `pipo_padded_input_ids` 并把 `seq_lens`/`extend_lens` 减半到压缩粒度，`qwen3_5_pipo.forward` 的 extend 分支 embed 全量 token → compressor 折半 → backbone → 采 token1 配 PAD。进入 decode 循环后，`prepare_for_decode` 从每请求末尾 2 token 建 `input_ids_pair[B,2]`；**Phase1** 走 CUDA Graph replay：embed pair → compress → backbone → 存 `pipo_backbone_hidden` → `lm_head` → 采 token1（此处 GPU→CPU sync）；`tp_worker` 随即切 `pipo_phase=2`，`can_run` 返回 False 使 **Phase2** 走 eager forward：embed(token1) + norm(backbone_hidden) 拼接 → `mtp_fc` → 1 层 `mtp_block` → `confidence_head` 出 `pipo_token2_conf` → `lm_head` → 采 token2，再按 `PIPO_CONF_THRESHOLD` 把低置信 token2 替换成 PAD，最终 `torch.stack([token1, token2])` 作为 `next_token_ids`。

#### 训练：OPD 一次 step（蒸馏主链路）

业务流程：9B teacher rollout 采 response → batch 编码（response_prefix 对齐 + parity PAD）→ student 压缩模式 forward → teacher PAD-compacted forward → chunked sampled-KL + conf BCE → micro-chunks 逐个 backward。

![OPD 训练数据流](/vibe-reading/images/articles/pipo-internals/opd-flow.svg)

文字描述：`PIPOGKDTrainer._prepare_sglang_engine` 强制 `enable_pipo=True`/`disable_radix_cache=True` 并 colocate SGLang 采 `response_token_ids`；`_encode_with_rollout_response` 先 prompt-only 编码（自动追加 qwen3_5 的 `response_prefix` `⊖\n`），再手动拼 rollout token，奇数 prompt 补 parity PAD 以镜像 SGLang 的 `_tokenize_one_request`。学生侧 `_student_compressed_logits` 走与推理一致的压缩路径（`embed_pad_compress → backbone → teacher-force token1 → mtp`），保证每个可训练参数都有梯度且分布与推理对齐；教师侧 `_teacher_hidden_pad_compacted` 用稳定 argsort + gather 剥掉 PAD、跑 vanilla Qwen3.5、再用 `cumsum(non_pad_mask)-1` 重映射回原位（PAD 位取前一个 non-PAD，等价 prefix-without-PAD 条件）。`_compute_chunked_sampled_kl` 沿 token 维分块计算 `log p_s(y) − log p_t(y)` 的 sampled reverse-KL，并顺手用 `α(y)=min(1, p_t/p_s)=exp(-per_pos_loss.clamp(min=0))` 作 conf head 的 BCE 目标（.detach 防梯度泄漏）。最后 `_compute_loss_micro_chunks` 把 batch 按 sample 拆成 B=1 micro-chunk 逐个 `accelerator.backward(sub_loss/N)`，靠 `set_gradient_accumulation_boundary(False)` 累积到 ZeRO-2 的 `all_grad_tensors` 而不 flush。

#### 训练：SFT 一次 step（数据增强链路）

`PIPOSeq2SeqTrainer.compute_loss` 先 strip ms-swift 附加键、mask 掉 thinking template 的 `⊖\n`（`N_BOT_TOKENS=2`），再按 `pad_ratio ~ Uniform[0, max_pad_ratio]` 调 `_build_random_padded_inputs` 在生成部分的 token pair 上随机插 PAD——保证 prompt 长度偶数、总长偶数、所有 PAD 落奇数位（pair 第二个，即 token2 位置），镜像推理时 conf gate 跳过 token2 的分布。随后 `model(**inputs)` 由 `Qwen3_5ForCausalPIPO.forward` 内部完成 `backbone_loss + mtp_loss_weight*mtp_loss + sft_conf_loss_weight*conf_loss`，其中 conf 目标在确定性 teacher 假设下退化为 `p_s_mtp(label_token2)`（与 OPD 目标在极限下坍缩到同一值，保证 warm-start 无缝迁移）。

### 状态流

PIPO 推理 decode 的核心是 `pipo_phase` 状态机，驱动 Phase1→Phase2 切换：

```
        pipo_phase=1                       sample token1 (GPU→CPU sync)
prefill ─────────────▶ Phase1(backbone, CUDA Graph) ────────────────┐
  (extend)                   │ set pipo_phase=2                        │
                             ▼                                        ▼
                        Phase2(MTP+conf, eager) ◀── pipo_backbone_hidden
                             │
                             ▼ sample token2 + gate(conf<threshold→PAD)
                        output [token1, token2] ──▶ prepare_for_decode(下一步, pipo_phase 重置为1)
```

`pipo_phase` 由 `tp_worker` 在 Phase1 采样后置 2，`cuda_graph_runner.can_run` 见 `pipo_phase==2` 返回 False 跳过 graph，`qwen3_5_pipo.forward` 据此走 Phase2 分支；下一步 `prepare_for_decode` 重建 `input_ids_pair` 时隐式重置回 Phase1。相关代码：状态枚举即 `pipo_phase` 整数（无独立定义，散见于 `tp_worker.py:L543-544` 与 `qwen3_5_pipo.py` forward 分支），转换由 `tp_worker.forward_batch_generation` 触发。

## 典型修改场景

#### 场景 1：切换 compressor 类型（linear ↔ mlp）

```bash title="改启动脚本参数"
bash scripts/swift_sft.sh linear   # arg1 → COMPRESSOR_TYPE env（优先级最高）
```

无需改代码——`COMPRESSOR_REGISTRY` 已注册 `linear`/`mlp`，`Qwen3_5MtpLoader.get_model` (`swift_plugin.py:L147-153`) 按 env 读类型，SGLang 侧 `qwen3_5_pipo.py` 同查表。推理侧 `load_weights` 中 `compressor.*` 是 direct match，新 compressor 的参数名需与 checkpoint 一致。

#### 场景 2：切换 OPD 的 KL 模式（sampled ↔ topk ↔ full）

```bash title="swift_opd.sh 环境变量"
export OPD_KL_MODE=topk      # 默认脚本 topk；trainer 默认 sampled
export GKD_LOGITS_TOPK=32     # topk 模式的 K
```

切换发生在 `_compute_loss_single` (`swift_gkd_trainer.py:L1617-1620`)：`use_sampled=(beta==1.0 and mode=='sampled')` → 调 `_compute_chunked_sampled_kl`；否则 → `_compute_chunked_jsd_loss`。注意 `OPD_TOPK_SOURCE` 已被忽略，topk 始终用 student/teacher/label 三者并集。

#### 场景 3：调推理 gating 阈值

```bash title="推理/rollout 阈值"
python sglang_eval.py --pipo_conf_threshold 0.95   # ≥0 启用门控；<0 总是提交；=1.0 跳过 Phase2
```

`PIPO_CONF_THRESHOLD` 经 `sglang_eval.py` 写入环境变量，被 `tp_worker.py:_pipo_conf_threshold` 读取；`<0` 不 gate，`[0,1)` 把 `sigmoid(conf_logit)<阈值` 的 token2 替换为 PAD，`>=1.0` 短路跳过 Phase2 省 latency。

## 阅读源码推荐路线

- **第一遍：理解核心模型抽象**
  `pipo/qwen3_5/compressor.py` 的 `PIPOCompressor`/`LinearCompressor`/`MLPCompressor`/`ConfidenceHead` → `pipo/qwen3_5/modeling_qwen3_5_mtp.py` 的 `Qwen3_5ForCausalPIPO.__init__`(`L516`) 与 `forward`(`L644`)，看清 Pair-In/Pair-Out 的张量流转与 chunked loss。
- **第二遍：理解推理加速链路**
  `third_party/sglang/python/sglang/srt/models/qwen3_5_pipo.py` 的 `forward` 三分支（extend/Phase1/Phase2）与 `load_weights` → `tp_worker.py` 的 `forward_batch_generation`(`L530-559`) 看 token1/token2 采样与 gating → `schedule_batch.py:prepare_for_decode` 看 `input_ids_pair` 构建。
- **第三遍：理解 OPD 蒸馏**
  `pipo/trainer/swift_gkd_trainer.py` 的 `_student_compressed_logits`(`L590`) 与 `_teacher_hidden_pad_compacted`(`L702`) → `_compute_chunked_sampled_kl`(`L1349`) 看 sampled-KL 与 conf EAGLE 目标 → `_compute_loss_micro_chunks`(`L1782`) 看 ZeRO-2 backward。
- **第四遍：理解插件与数据闭环**
  `pipo/trainer/swift_plugin.py` 的注册与热路由 → `pipo/dataset/build_sft_data_on_results_jsonl.py` 看从 teacher rollout 到 SFT 数据 → `sglang_eval.py` 看评测/rollout 入口。然后按需深入模块文档与两个深度附件（[OPD KL 与置信度目标](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/03-opd-trainer-kl-and-conf)、[两阶段 decode 机制](/vibe-reading/articles/AI/Infra/Inference/PIPO/CodeWiki/2026-06/04-sglang-two-phase-decode)）。

## 附录

**术语表**：

| 术语 | 含义 |
| --- | --- |
| Pair-In / Pair-Out | 压缩两个输入 token 成一个 latent / 展开一个 hidden 成一个额外输出 token |
| MTP | Multi-Token Prediction，一次预测多个 token |
| OPD | On-Policy Distillation，在策略蒸馏，学生自己 rollout 再对齐教师分布 |
| EAGLE | 一种投机解码框架；PIPO 用其 per-pair accept rate 作 conf head 训练目标 |
| sampled reverse-KL | 只在学生采样的 token 上算 `log p_s(y) − log p_t(y)`，无偏估计 `D_KL(p_s‖p_t)` |
| parity PAD | 为保证序列偶数长度而在 prompt 末尾补的 PAD，对齐 SGLang tokenization |
| ghost forward | 零值前向，只为让参数进 autograd 图、保持 ZeRO-2 桶对齐，不影响 loss |
| `pipo_phase` | SGLang decode 阶段标记：1=backbone（CUDA Graph），2=MTP+conf（eager） |

**参考资料**：

- 论文：[Pair-In, Pair-Out: Latent Multi-Token Prediction for Efficient LLMs](https://arxiv.org/abs/2605.27255)
- 项目知识库：`/Users/ace/code/ai/PIPO/.agents/PIPO.md`（agent 工作前必读，含完整字段索引与环境变量参考）
- 依赖框架：[SGLang](https://github.com/sgl-project/sglang)、[ms-swift](https://github.com/modelscope/ms-swift)
- checkpoint/dataset：[Hugging Face AlbertTan/PIPO](https://huggingface.co/AlbertTan/PIPO)
