---
title: "在 SGLang 中接入 LongCat-AudioDiT：用框架 hooks 把耦合 ODE 纳入标准三段式"
source:
  project: "SGLang"
  type: "PR"
  id: "22191"
  url: "https://github.com/sgl-project/sglang/pull/22191"
  prType: "feat"
date: "2026-08-24T20:29:50+08:00"
category: [AI, Infra, Inference, SGLang, Contributions]
tags: ["Diffusion", "TTS", "Flow Matching", "DiT", "SGLang", "LongCat-AudioDiT", "VAE", "OpenAI API"]
description: "解读 PR #22191：如何在 SGLang multimodal_gen 中接入 LongCat-AudioDiT 扩散式 TTS——通过给框架新增 3 个 hooks（prepare_step_latent / prepare_branch_latent / get_cfg_policy）+ 升序 t scheduler + 每请求 CFG 策略，把耦合的 ODE 循环纳入标准 BeforeDenoising→Denoising→Decoding 三段式，并新增 OpenAI 兼容 /v1/audio/speech API。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
pinned: true
---

> **PR** [#22191](https://github.com/sgl-project/sglang/pull/22191) · **Issue** - · **commit** [15182d22](https://github.com/sgl-project/sglang/pull/22191/commits/15182d22bca5a7a3dad24adee632583d77b2ca6c) · **首发版本** - · **变更行数** +4202 / -42 行（25 文件）· **合并时间** -（截至 2026-08-24 仍处 Open 状态）

---

## 背景

LongCat-AudioDiT 是美团 LongCat 团队的扩散式文本转语音（TTS）模型，**直接在波形 latent 空间上做 Conditional Flow Matching**，而非传统的频谱域（mel-spectrogram）+ vocoder 两段式。它支持纯文本 TTS 与**声音克隆（voice cloning）**——给定一段参考音频及其文本，克隆音色合成新内容。

SGLang 的 `multimodal_gen` 子系统此前已接入 Wan / Hunyuan / ZImage / Flux / LongCat-Image 等**图像/视频**扩散模型，形成"标准 Stage + 模型特定 `PipelineConfig` hooks"的组合式 pipeline 框架。但这些模型都有两个共同前提：（1）以 Diffusers `model_index.json` 声明组件；（2）生成流程能干净地拆成 `LatentPreparation → Denoising → Decoding` 三段式标准 Stage。

LongCat-AudioDiT 同时打破这两个前提：它以**单个 HuggingFace `PreTrainedModel`** 形式发布（无 `model_index.json`），且整条生成链路（文本编码 → ODE 求解 → VAE 解码）在上游仓库里高度耦合在模型自己的 `forward` 里——ODE 积分器、CFG/APG 引导、prompt 音频的 VAE 编码都交织在同一个 `fn(t, x)` 闭包中。

本 PR 早期版本曾用一个**单体 `InferenceStage`** 包裹整条 `forward` 跑完全程（绕过标准 `DenoisingStage`/`DecodingStage`）。但随着 PR 推进，作者改用了更贴合框架的 **Hybrid 三段式**：不去绕过标准 `DenoisingStage`，而是**给框架 `PipelineConfig` 新增三个 hooks**，把耦合在 `fn(t, x)` 里的三件事——每步重写 prompt 区域、无条件分支清零、每请求独立引导策略——分别表达成 `prepare_step_latent` / `prepare_branch_latent` / `get_cfg_policy` 三个扩展点，再配一个升序 `t` 的定制 scheduler，让标准 `DenoisingStage` 直接驱动这条 ODE 循环。同时把 `AUDIO` 作为一等数据类型引入框架，并新增 OpenAI 兼容的 `/v1/audio/speech` API。

![LongCat-AudioDiT 接入 multimodal_gen：Hybrid 三段式 + 框架 hooks](/vibe-reading/images/articles/sglang-pr-22191-support-longcat-audiodit/architecture.svg)

上图自上而下标注了本 PR 的改动位置：入口层（黄）CLI / HTTP / Python API 三路补齐音频参数，外加**新增**（青）的 OpenAI `/v1/audio/speech` 端点 → `registry.py`（黄）登记 1B/3.5B + 新增 `SamplingParams`（青）→ `LongCatAudioDiTPipeline`（青，Hybrid style）`load_modules` 加载单体模型并拆出 transformer/vae/scheduler → 三段式：① `BeforeDenoisingStage`（青）一次性完成文本编码 + prompt VAE 编码 + 噪声/scheduler 初始化；② **标准 `DenoisingStage`（黄，被修改）** 跑 ODE 循环，靠新增的三个 hooks 驱动，transformer 的 `forward` 退化为单步速度场预测；③ `DecodingStage`（青，1D 音频专用）跑 WAV-VAE 解码，绕过（灰虚框）假设 5D 空间 VAE 的标准 `DecodingStage`。核心取舍在中间这块黄框：早期是绕过，现在是**扩展框架**让它跑得起来。

---

## 前置知识

### SGLang multimodal_gen 的组合式 Pipeline

`multimodal_gen` 把一次生成拆成一串 `PipelineStage`，由 `ComposedPipelineBase` 顺序执行。框架提供标准 Stage（`LatentPreparationStage` / `TimestepPreparationStage` / `DenoisingStage` / `DecodingStage`），其行为通过模型特定的 `PipelineConfig` hook 注入。多数模型只需实现自己的 `PipelineConfig` 和必要的模型特定 Stage。

本 PR 走的是 **Hybrid style**：模型特定 `BeforeDenoisingStage`（前置预处理）→ 标准 `DenoisingStage`（靠 hooks 驱动）→ 模型特定 `DecodingStage`（1D 音频解码）。为了让标准 `DenoisingStage` 适配 LongCat-AudioDiT 那条耦合的 ODE 闭包，作者向 `PipelineConfig` 新增了三个 hook（`prepare_step_latent` / `prepare_branch_latent` / `get_cfg_policy`）。

### Conditional Flow Matching（CFM）

CFM 训练一个速度场 `v(x, t)` 去拟合从噪声分布到数据分布的常微分方程（ODE）流。推理时用 ODE 积分器（这里是 Euler）从 `t=0`（噪声）积到 `t=1`（数据）得到样本。LongCat-AudioDiT 用 16 步 Euler 积分，相比传统扩散模型的几十上百步去噪大幅降低延迟。

### WAV-VAE 与波形 latent

WAV-VAE 直接把原始波形 `(B, 1, num_samples)` 编码成 latent `(B, latent_dim=64, num_frames)`，总下采样比 2048×（24kHz → 约 11.7 帧/s）。DiT 在这个 latent 空间里做流匹配，解码时再由 VAE 还原回波形。这绕过了 mel-spectrogram 的信息损失。

---

## 设计参考

本 PR 的模型实现文件头明确标注来源：

```text title="runtime/models/dits/longcat_audiodit.py"
# Copied and adapted from: https://github.com/meituan-longcat/LongCat-AudioDiT
"""PyTorch LongCatAudioDiT model — Conditional Flow Matching TTS with DiT backbone."""
```

推理 Stage 与 scheduler 同样标注上游出处：

```text title="pipelines_core/.../model_specific_stages/longcat_audiodit.py"
# Reference: https://github.com/meituan-longcat/LongCat-AudioDiT/blob/main/inference.py
```

即 DiT 主干、WAV-VAE、CFM/APG 引导、文本归一化与时长估计等算法逻辑都从上游仓库 1:1 移植；SGLang 侧的工作不是重新设计算法，而是**把上游那个耦合在 `forward` 里的生成闭包，拆解映射到 `multimodal_gen` 的标准三段式 + 三个新 hooks 上**，并把 `AUDIO` 数据类型贯通到 CLI / HTTP server / OpenAI API / 保存路径。

---

## 实现

### 模型架构总览

| 组件 | 类型 | 说明 |
|------|------|------|
| `text_encoder` | `UMT5EncoderModel`（UMT5-base，768d） | 冻结；取 `last_hidden_state` + 首层 hidden（`text_add_embed`），做 LayerNorm（`text_norm_feat`） |
| `transformer` | `LongCatAudioDiTTransformer(BaseDiT, LayerwiseOffloadableModuleMixin)` | 24 层 CrossDiT：self-attn + cross-attn + FFN，global AdaLN，RoPE，QK-Norm，ConvNeXt-V2 文本卷积，long skip；`forward` 退化为**单步速度场**预测，支持 FA/AITER/SAGE 注意力后端与 USP |
| `vae` | `LongCatAudioDiTVae` | WAV-VAE：Snake 激活 + weight-norm Conv1d，2048× 下采样，`latent_dim=64`，`scale=0.71` |
| `scheduler` | `AudioDiTFlowMatchScheduler` | 升序 `t`（0→1）、`dt>0` 的 Euler，替代上游内联 `odeint_euler` |

DiT 关键超参（`LongCatAudioDiTConfig`）：`dit_dim=1536`、`dit_depth=24`、`dit_heads=24`（`dim_head=64`）、`dit_text_dim=768`、`dit_ff_mult=4.0`、`dit_adaln_type="global"`、`dit_long_skip=True`、`dit_text_conv=True`、`dit_qk_norm=True`、`repa_dit_layer=8`、`latent_dim=64`、`sampling_rate=24000`、`latent_hop=2048`、`max_wav_duration=30.0`。

VAE 关键超参（`LongCatAudioDiTVaeConfig`）：`channels=128`、`c_mults=[1,2,4,8,16]`、`strides=[2,4,4,8,8]`（乘积 = 2048 = `downsampling_ratio`）、`encoder_latent_dim=128`（瓶颈后 split 成 mean+scale → `latent_dim=64`）、`use_snake=True`、`scale=0.71`。

DiT 主干数据流（`transformer.forward` 一次调用）：

```
text_ids → UMT5 → text_embed(768→1536) → ConvNeXtV2×4 → text 条件
audio latent [B, T, 64] → input_embed(64→1536) → (+ latent_cond) → x
time → sinusoidal → MLP → t  (global: norm_cond = t + text_mean)
                                                                   │
24 × LongCatAudioDiTBlock:                                          │
  global AdaLN(scale/shift/gate×6) → self-attn(RoPE+QKNorm)         │
  → cross-attn(text) → FFN                                          │
                                                                   ▼
  + long_skip (x_clone) → norm_out(AdaLN) → proj_out(1536→64) → 速度场 v(x,t)
```

注意：早期版本里 ODE 循环、CFG/APG、prompt 重写全在这个 `forward` 里，`forward` 返回整条轨迹；现在 `forward` 只做**一步**预测、返回速度 `v(x,t)`，循环交给标准 `DenoisingStage` + `AudioDiTFlowMatchScheduler`，CFG/APG 交给 `AudioDiTCFGPolicy.combine`。

### 关键设计 1：Hybrid 三段式 + 框架新增 3 个 hooks

`LongCatAudioDiTPipelineConfig` 的 docstring 点明这一取舍——不再用单体 Stage，而是把三个非标准行为表达成标准 `DenoisingStage` 的 hooks：

```python title="configs/pipeline_configs/longcat_audiodit.py"
@dataclass
class LongCatAudioDiTPipelineConfig(PipelineConfig):
    """...
    Three non-standard behaviors are expressed through framework hooks:

    1. Prompt-region rewrite each step — prepare_step_latent overwrites the
       prompt region ... before each model forward.
    2. Per-branch latent modification — prepare_branch_latent clears the
       prompt region (zeros it) for the unconditional CFG branch.
    3. APG guidance — a custom AudioDiTCFGPolicy overrides combine() to apply
       Adaptive Projected Guidance ...
    """
    task_type: ModelTaskType = ModelTaskType.T2A
    dit_precision: str = "bf16"
    vae_precision: str = "fp16"
    scheduler_class_override: str = "AudioDiTFlowMatchScheduler"
    should_use_guidance: bool = False
    enable_autocast: bool = False
```

这三个 hook 是**本 PR 对框架 `PipelineConfig` 的通用扩展**（写在 `base.py` 里、带默认实现），不止服务于 LongCat-AudioDiT：

```python title="configs/pipeline_configs/base.py"
def get_cfg_policy(self, batch) -> CFGPolicy:
    """Per-request policy 优先取 batch.cfg_policy，避免并发请求互相覆盖
    pipeline_config.cfg_policy 这个共享字段。"""
    per_request = getattr(batch, "cfg_policy", None)
    if per_request is not None:
        return per_request
    return self.cfg_policy

def prepare_step_latent(self, latent_model_input, timestep, batch) -> torch.Tensor:
    """每步 model forward 前改写 latent（默认不改）。clone 后再改，勿改 scheduler 内部状态。"""
    return latent_model_input

def prepare_branch_latent(self, latent_model_input, branch, batch, timestep) -> torch.Tensor:
    """为特定 CFG 分支改写 latent（默认不改，标准 CFG 各分支同一 latent）。"""
    return latent_model_input
```

标准 `DenoisingStage` 在两处调用它们（`denoising.py`）：

```python title="runtime/pipelines_core/stages/denoising.py"
# 3b. 每步 forward 前的模型特定 latent 改写
latent_model_input = server_args.pipeline_config.prepare_step_latent(
    latent_model_input, step.t_device, batch
)

# 分支 forward 前：无条件分支清零 prompt 区域
def predict_fn(branch):
    branch.configure_batch(batch)
    branch_latent = server_args.pipeline_config.prepare_branch_latent(
        latent_model_input, branch, batch, timestep
    )
    ...
    raw = self._predict_noise(..., latent_model_input=branch_latent, ...)

# CFG 策略也改成每请求取
cfg_policy = server_args.pipeline_config.get_cfg_policy(batch).build(...)
```

于是 pipeline 只挂三个 Stage（标准 `DenoisingStage` 用 `add_standard_denoising_stage()` 加入）：

```python title="runtime/pipelines/longcat_audiodit.py"
def create_pipeline_stages(self, server_args: ServerArgs):
    # 1. 前置：文本编码 + prompt 音频编码 + latent 准备 + scheduler
    self.add_stage(LongCatAudioDiTBeforeDenoisingStage(
        model=self.get_module("model"),
        tokenizer=self.get_module("tokenizer"),
        scheduler=self.get_module("scheduler"),
    ), "longcat_audiodit_before_denoising_stage")
    # 2. 标准 denoising 循环（hooks 驱动 prompt 重写 / 分支 / APG）
    self.add_standard_denoising_stage()
    # 3. 音频解码（WAV-VAE 1D，绕过假设 5D 的标准 DecodingStage）
    self.add_stage(LongCatAudioDiTDecodingStage(
        vae=self.get_module("vae"), model=self.get_module("model"),
    ), "longcat_audiodit_decoding_stage")
```

`BeforeDenoisingStage.forward` 产出喂给标准 `DenoisingStage` 的 `Req` 批：`latents`(y0) / `timesteps` / `scheduler` / `prompt_embeds` / `negative_prompt_embeds` / `do_classifier_free_guidance`，外加音频专属条件以 `batch._audio_*` 字段暂存（供 hooks 读取）：`_audio_prompt_latent_len` / `_audio_prompt_noise` / `_audio_latent_cond` / `_audio_empty_latent_cond` / `_audio_mask` / `_audio_cond_mask` / `_audio_text_condition_len`，以及每请求的 `batch.cfg_policy`。

### 关键设计 2：绕过 Diffusers 组件加载

LongCat-AudioDiT 以单个 `PreTrainedModel` 发布，没有 `model_index.json`。`LongCatAudioDiTPipeline` 把 `_required_config_modules` 置空、覆盖 `load_modules` 直接 `from_pretrained`，并把模型拆成标准 Stage 需要的几个子模块（`model` / `tokenizer` / `transformer` / `vae` / `scheduler`）返回：

```python title="runtime/pipelines/longcat_audiodit.py"
_required_config_modules: list[str] = []   # 无 Diffusers 组件

def load_modules(self, server_args, loaded_modules=None):
    if loaded_modules:
        return loaded_modules
    model = LongCatAudioDiTModel.from_pretrained(self.model_path)
    self._sync_dit_config_from_model(server_args, model)   # 对齐 1B/3.5B 维度
    device = get_local_torch_device()
    model = model.to(device)
    model.transformer.to(torch.bfloat16)   # DiT: bf16
    model.vae.to_half()                     # VAE: fp16
    model.eval()
    tokenizer = self._load_tokenizer(self.model_path, model.config.text_encoder_model)
    scheduler = AudioDiTFlowMatchScheduler()
    return {"model": model, "tokenizer": tokenizer,
            "transformer": model.transformer, "vae": model.vae, "scheduler": scheduler}
```

`_sync_dit_config_from_model` 把加载到的 HF 模型真实维度（`dit_dim` / `dit_heads` / `latent_dim`）写回 pipeline 的 `dit_config.arch_config`，让标准 `DenoisingStage` 的注意力/并行配置自动适配 1B 与 3.5B 两种规格。`_load_tokenizer` 优先用 checkpoint 自带的 tokenizer 文件（`local_files_only`），缺失或 sentencepiece 不全时回退到 Hub——注意它同时捕获 `OSError` 与 `ValueError`，因为 `AutoTokenizer` 在 sentencepiece 缺失时抛的是 `ValueError` 而非 `OSError`。

为避免依赖外部 `audiodit` 包，pipeline 在模块顶层把 config/model 注册进 HuggingFace Auto 体系（`exist_ok=True`）：

```python title="runtime/pipelines/longcat_audiodit.py"
AutoConfig.register("audiodit", LongCatAudioDiTConfig, exist_ok=True)
AutoModel.register(LongCatAudioDiTConfig, LongCatAudioDiTModel, exist_ok=True)
```

`LongCatAudioDiTConfig` 用 `sub_configs` 把 `vae_config` 与 `text_encoder_config`（`UMT5Config`）声明为子配置，`from_pretrained` 时连同 UMT5 文本编码器一起加载——文本编码器作为 `LongCatAudioDiTModel` 的子模块构造、权重随主 checkpoint 一起加载，无需单独下载。

模型到 Pipeline 的映射注册在 **`registry.py`**，用两步识别：一是 `KNOWN_NON_DIFFUSERS_DIFFUSION_MODEL_PATTERNS` 字典加一行 `"longcat-audiodit": "LongCatAudioDiTPipeline"`，让 HF id 含 `longcat-audiodit` 的模型命中本 Pipeline；二是 `register_configs` 显式登记两个官方权重路径与一个模糊匹配 detector：

```python title="registry.py"
"longcat-audiodit": "LongCatAudioDiTPipeline",
# ...
register_configs(
    sampling_param_cls=LongCatAudioDiTSamplingParams,
    pipeline_config_cls=LongCatAudioDiTPipelineConfig,
    hf_model_paths=[
        "meituan-longcat/LongCat-AudioDiT-1B",
        "meituan-longcat/LongCat-AudioDiT-3.5B",
    ],
    model_detectors=[lambda hf_id: "longcat-audiodit" in hf_id.lower()],
)
```

值得一提的是，本 PR 同时把 LongCat-Image 的 detector 从 `"longcat" in hf_id.lower()` 收窄成 `"longcat-image" in hf_id.lower()`——否则 `longcat-audiodit` 会被 image detector 误命中。新增模型迫使既有 detector 更精确，是注册表维护的常见连带改动。

### 关键设计 3：WAV-VAE 的 fp16 数值对齐 + 可复现采样

VAE 的 `encode`/`decode` 不是简单 `.half()`，而是**严格复刻上游 `AutoencoderPretransform(model_half=True)` 的 dtype 顺序**——瓶颈操作必须发生在 fp16 编码器输出上、在最终 `.float()` 转换之前：

```python title="runtime/models/dits/longcat_audiodit.py"
def encode(self, audio, generator=None):
    is_half = next(self.encoder.parameters()).dtype == torch.float16
    if is_half:
        audio = audio.half()
    latents = self.encoder(audio)
    # VAE bottleneck runs in the same dtype as encoder output (fp16)
    # to match original: bottleneck.encode(latents) happens before .float()
    mean, scale_param = latents.chunk(2, dim=1)
    stdev = F.softplus(scale_param) + 1e-4
    latents = randn_like_with_generator(mean, generator=generator) * stdev + mean  # reparameterize
    if is_half:
        latents = latents.float()
    return latents / self.scale
```

相比早期版本用 `torch.randn_like`，现在改用 `randn_like_with_generator(mean, generator=generator)`——接受一个 CPU `torch.Generator`。`BeforeDenoisingStage` 为声音克隆的 VAE 采样单独建一个**与噪声流同种子的 generator**（`vae_generator`），这样 VAE 后验采样不会消耗主噪声流的随机数，保证给定 `--seed` 下整条生成可复现。`encoder_latent_dim=128` 在瓶颈处 split 成 mean + scale 两路各 64 维，重参数化后得 `latent_dim=64`，再除以 `scale=0.71` 归一化。`decode` 同理：`z = latents * scale` → fp16 → decoder → `.float()`。这种"在哪一步转 dtype"的细节若错位，生成音频与参考实现会有可听差异。

### 关键设计 4：AudioDiTFlowMatchScheduler（替代 inline Euler）

早期版本在模型 `forward` 里内联了一个 15 行的 `odeint_euler`。现在它被提升成一个标准的 `BaseScheduler` 子类 `AudioDiTFlowMatchScheduler`，让标准 `DenoisingStage` 的循环逻辑可以复用：

```python title="runtime/models/schedulers/scheduling_audiodit_flow_match.py"
class AudioDiTFlowMatchScheduler(BaseScheduler):
    """Euler flow-matching scheduler with ascending t (0→1)."""
    order = 1

    def set_timesteps(self, num_inference_steps, device=None, **kwargs):
        grid = torch.linspace(0, 1, num_inference_steps + 1, device=device)
        self.timesteps = grid[:-1].clone()   # N 点: 0, 1/N, ..., (N-1)/N
        self.sigmas = grid                   # N+1 点: 0, ..., 1.0
        self._step_index = None

    def step(self, model_output, timestep, sample, **kwargs):
        if self._step_index is None:
            self._init_step_index(timestep)
        sigma = self.sigmas[self._step_index]
        sigma_next = self.sigmas[self._step_index + 1]
        dt = sigma_next - sigma            # > 0（升序）
        prev_sample = sample.to(torch.float32) + dt * model_output.to(torch.float32)
        prev_sample = prev_sample.to(model_output.dtype)
        self._step_index += 1
        return (prev_sample,)
```

为什么不用框架已有的 `FlowMatchEulerDiscreteScheduler`？因为两者**符号约定相反**：标准 scheduler 用降序 sigma（1→0）、`dt<0`，且模型输出符号约定不同（`v_longcat = -v_diffusers`）。与其在每步给预测取负、强行套用，不如写一个专用 scheduler，把上游 `odeint_euler` 的升序 `t`、正 `dt`、同符号 1:1 镜像下来。`set_timesteps` 产出 `N` 个升序时间步、`N+1` 个 sigma（终点 1.0），`step` 永远能读到 `sigmas[step_index+1]`。`scale_model_input` 直接返回原样（CFM 不缩放输入）。pipeline 通过 `scheduler_class_override = "AudioDiTFlowMatchScheduler"` 让 loader 选它。

### 关键设计 5：AudioDiTCFGPolicy（CFG/APG 从 forward 抽出到 combine）

早期版本里 CFG 与 APG 编织在 `forward` 的 `fn(t, x)` 闭包里。现在它们被搬到一个 `AudioDiTCFGPolicy`（`runtime/distributed/apg_cfg_policy.py`），由标准 `DenoisingStage` 的 CFG 机制经 `get_cfg_policy(batch)` 取出、在每步 cond + uncond 两次前向后调 `combine()` 合并：

```python title="runtime/distributed/apg_cfg_policy.py"
@dataclass
class AudioDiTCFGPolicy(CFGPolicy):
    guidance_method: str = "cfg"
    momentum: float = -0.3
    eta: float = 0.5
    norm_threshold: float = 0.0
    apg_buffer: _MomentumBuffer | None = field(init=False, default=None)

    def __post_init__(self):
        if self.guidance_method == "apg":
            self.apg_buffer = _MomentumBuffer(momentum=self.momentum)

    def combine(self, predictions, batch, cfg_scale, pipeline_config, *, cfg_parallel=False):
        if len(predictions) == 1:
            return predictions[0]
        pred, null_pred = predictions[0], predictions[1]
        if self.guidance_method == "cfg":
            return super().combine(...)            # 标准 CFG 复用父类
        # ── APG：在 sample 空间做正交投影 ──────────────────────────
        x = batch._current_latent                 # 由 prepare_step_latent 暂存
        t = batch._current_t
        latent_len = batch._audio_prompt_latent_len
        x_s, pred_s, null_s = x[:, latent_len:], pred[:, latent_len:], null_pred[:, latent_len:]
        pred_sample  = x_s + (1 - t) * pred_s      # velocity → sample
        null_sample  = x_s + (1 - t) * null_s
        out = _apg_forward(pred_sample, null_sample, cfg_scale, self.apg_buffer,
                           eta=self.eta, norm_threshold=self.norm_threshold, dims=[-1, -2])
        out = (out - x_s) / (1 - t)                # sample → velocity
        return F.pad(out, (0, 0, latent_len, 0), value=0.0)   # prompt 区域置 0
```

**CFG** 走经典线性外推，直接复用父类 `CFGPolicy.combine`。**APG（Adaptive Projected Guidance）** 把引导差 `diff = pred_cond - pred_uncond` 经动量缓冲（`momentum=-0.3`）平滑后，投影到条件预测方向的**正交分量** + `eta=0.5` 倍**平行分量**，再叠加回条件预测——相比 CFG 在高引导强度下更不易过饱和。

注意一个关键细节：APG 要在 **sample 空间**算，但标准 `DenoisingStage` 喂给 `combine` 的是 **velocity**。`combine` 读 `prepare_step_latent` 暂存的 `batch._current_latent` / `batch._current_t`，用 `x + (1-t)*v` 把 velocity 转成 sample、投影完再用 `(out - x)/(1-t)` 转回 velocity。这正是把闭包拆成 hooks + policy 后必须显式处理的"状态传递"——`prepare_step_latent` 既是 prompt 重写的 hook，也顺手把 APG 需要的当前 latent/t 存到 batch 上。`_project` 用 float64 做正交化保证数值精度，并在 MPS 设备上先把张量搬到 CPU 再算（CUDA 路径直接做）。

### 关键设计 6：声音克隆与时长估计

时长估计统一收口到 `_resolve_duration_frames`（`model_specific_stages/longcat_audiodit.py`），三条路径由 `BeforeDenoisingStage` 根据采样参数分派：

- **显式指定**：`duration_seconds` 不为空时直接换算 `gen_frames = int(duration_seconds * sr // full_hop)`，再 `+ prompt_dur` 得总帧数。注意 `duration_seconds` 语义是**生成段**长度（剥掉 prompt 后那段），克隆时内部仍要加上 `prompt_dur` 给条件留画布。
- **纯文本 TTS**：由文本字符数估算（`_approx_duration_from_text`：中文 0.21s/字、英文 0.082s/字，按主语言把"其他字符"归并）。
- **声音克隆**：先 VAE 编码参考音频得精确 prompt 帧数 `prompt_dur`，再用参考音频实际时长 / 其文本估算时长的比值（clip 到 `[1.0, 1.5]`）校正生成段时长，最终 `duration = min(gen_dur + prompt_dur, max_frames)`。

prompt 音频 VAE 编码在 `BeforeDenoisingStage.forward` 里**只做一次**，结果存到 `batch._audio_latent_cond` 供每步 hook 复用（早期版本每步重算）：

```python title="pipelines_core/.../model_specific_stages/longcat_audiodit.py (BeforeDenoisingStage.forward)"
prompt_wav_1d = _load_audio_tensor(prompt_audio_path, sr)        # librosa 加载
prompt_wav = prompt_wav_1d.unsqueeze(0)                         # (1, 1, T)
# Encode ONCE — the latent is reused across all denoising steps.
prompt_latent, prompt_dur = self.model.encode_prompt_audio(
    prompt_wav.to(device), generator=vae_generator)
prompt_time = prompt_dur * full_hop / sr
...
duration = _resolve_duration_frames(gen_text=gen_text, prompt_dur=prompt_dur,
    prompt_time=prompt_time, prompt_text=prompt_text,
    duration_seconds=duration_seconds, sr=sr, full_hop=full_hop,
    max_duration=max_duration)
```

声音克隆路径的时长校正逻辑收口在 `_resolve_duration_frames` 的 `prompt_dur > 0` 分支：

```python title="pipelines_core/.../model_specific_stages/longcat_audiodit.py (_resolve_duration_frames)"
elif prompt_dur > 0:                                    # 声音克隆路径
    dur_sec = _approx_duration_from_text(
        gen_text, max_duration=max(0.0, max_duration - prompt_time))
    if prompt_text:
        approx_pd = _approx_duration_from_text(prompt_text, max_duration=max_duration)
        if approx_pd > 0:
            ratio = float(np.clip(prompt_time / approx_pd, 1.0, 1.5))  # 参考时长/其文本估算
            dur_sec = dur_sec * ratio
    gen_frames = int(dur_sec * sr // full_hop)
...
return max(1, min(gen_frames + prompt_dur, max_frames))   # 含 prompt_dur，clip 到 max_frames
```

prompt 区域通过 `prepare_step_latent` 每步重写为 `prompt_noise*(1-t) + latent_cond*t`——保证克隆音色不被 ODE 流冲散。生成后 `post_denoising_loop` 把 prompt 段切掉（`latents[:, latent_len:]`），只解码生成段。文本归一化（`_normalize_text`：转小写、引号转空格、压缩空白）与拼接 `"[prompt_text] [gen_text]"` 都对齐上游。`duration_seconds` 超过 prompt 长度时会显式报错（`Prompt audio ... exceeds total duration`），避免静默截断。

### 关键设计 7：RoPE 的 lazy build 防 meta-device 损坏

`LongCatAudioDiTRotaryEmbedding`（Qwen2 风格）刻意不在 `__init__` 注册任何 buffer，而是首次 `forward` 时 lazy 构建 cos/sin：

```python title="runtime/models/dits/longcat_audiodit.py"
# Do NOT register any buffers here — they get corrupted by meta-device.
# Everything is built lazily in forward().
self._cos: torch.Tensor | None = None
self._sin: torch.Tensor | None = None
self._cached_len: int = 0
self._cached_device: torch.device | None = None

def _build(self, seq_len, device, dtype):
    """Build cos/sin tables entirely on CPU (matching original
    Qwen2RotaryEmbedding which builds in __init__ on CPU, then the
    whole model is moved with .to(device)), then move to target."""
    inv_freq = 1.0 / (self.base ** (torch.arange(0, self.dim, 2, dtype=torch.int64).float() / self.dim))
    t = torch.arange(seq_len, dtype=torch.int64).type_as(inv_freq)
    freqs = torch.outer(t, inv_freq)
    emb = torch.cat((freqs, freqs), dim=-1)
    self._cos = emb.cos().to(dtype=dtype, device=device)
    self._sin = emb.sin().to(dtype=dtype, device=device)
```

`from_pretrained` 用 meta-device 构造模型，若 `inv_freq` 在 `__init__` 里就注册成 buffer，会随 meta-device 路径冲突而损坏。lazy build 把构造推迟到首次 `forward`，且**刻意在 CPU 上算 `inv_freq` 与 cos/sin，再 `.to(device)` 搬到目标设备**——这与原 `Qwen2RotaryEmbedding` 在 `__init__` 于 CPU 构造、随后整个模型 `.to(device)` 搬迁的行为一致，从而产出 bit-identical 结果。`_cached_len` / `_cached_device` 避免同设备同长度的重复构造。

### 关键设计 8：Transformer 集成框架 DiT 体系

早期版本里 `LongCatAudioDiTTransformer` 是纯 `nn.Module`、注意力用 `nn.Linear`（未做 TP 并行）。现在它继承框架的 `BaseDiT, LayerwiseOffloadableModuleMixin`，接入框架的 DiT 基础设施：

```python title="runtime/models/dits/longcat_audiodit.py"
class LongCatAudioDiTTransformer(BaseDiT, LayerwiseOffloadableModuleMixin):
    _supported_attention_backends = {
        AttentionBackendEnum.FA,
        AttentionBackendEnum.AITER,
        AttentionBackendEnum.AITER_SAGE,
        AttentionBackendEnum.TORCH_SDPA,
        AttentionBackendEnum.SAGE_ATTN,
        AttentionBackendEnum.SAGE_ATTN_3,
    }
    _fsdp_shard_conditions: list = []
    _compile_conditions: list = []
    param_names_mapping: dict = {}
```

这意味着：（1）注意力可在 FlashAttention / AITER / SageAttention 等多个后端间切换；（2）self/cross attention 走 `_run_usp_attention`，支持 **USP（Unified Sequence Parallelism）** 序列并行；（3）`LayerwiseOffloadableModuleMixin` 让 24 层 DiT 可分层 offload 到 CPU，缓解长音频下的显存压力；（4）`_fsdp_shard_conditions` / `_compile_conditions` 留出 FSDP 分片与 torch.compile 的接入点。这一改造把早期 TODO 里的"接入 TP 并行"往前推了一大步——不再是无并行纯 `nn.Linear`，而是复用框架的并行/后端/编译基础设施。

### 框架贯通：AUDIO 作为一等数据类型 + OpenAI 兼容 API

为支持音频输出，框架侧补齐多处，并新增了一套 OpenAI 兼容的音频生成 API。

**`base.py`** 新增 `ModelTaskType.T2A` 与 `is_audio_gen()`，其 `data_type()` 返回 `DataType.AUDIO`：

```python title="configs/pipeline_configs/base.py"
class ModelTaskType(Enum):
    ...
    T2A = auto()  # Text to Audio
    def is_audio_gen(self) -> bool:
        return self == ModelTaskType.T2A
    def data_type(self) -> DataType:
        ...
        if self.is_audio_gen():
            return DataType.AUDIO
        ...
```

**`sampling_params.py`** 新增 `DataType.AUDIO`（默认扩展名 `wav`）、`prompt_audio_path` / `prompt_text` / `guidance_method` / `duration_seconds` 字段及对应 CLI 参数，扩展名白名单加入 `.wav`。配套的 **`configs/sample/longcat_audiodit.py`** 定义 `LongCatAudioDiTSamplingParams`，`data_type` 固定为 `DataType.AUDIO`，默认 `num_inference_steps=16`、`guidance_scale=4.0`（`_default_height` / `_default_width` 置空，音频无空间尺寸）。

**`entrypoints/utils.py`** 的 `post_process_sample` 增加 `DataType.AUDIO` 分支，用 `soundfile` 写 WAV（缺包时抛 `ImportError` 并提示安装）。

**HTTP server / 公共 entrypoint**：`encode_video_to_base64` 改名为通用的 `encode_file_to_base64`；新增 `_scheduler_response_has_no_output` 把"无输出"统一为 `output is None and output_file_paths is None and audio is None`，当 `output is None but audio is not None` 时把 `response.audio` 张量作为 `outputs_to_save` 传给 `save_outputs`；`first_output_file_path` / `existing_output_file_paths` 把 `[None]` 当成无路径处理；`vertex_generate` 重构为 `_vertex_instance_sampling_kwargs`，透传 `prompt_audio_path` / `prompt_text` / `guidance_method` / `duration_seconds`。

**OpenAI 兼容 `/v1/audio/speech` API**（`runtime/entrypoints/openai/audio_api.py`，新增 ~500 行）：一套完整 CRUD——

| 端点 | 功能 |
|------|------|
| `POST /v1/audio/speech` | 生成语音，直接返回音频字节（`Content-Disposition: attachment`） |
| `GET /v1/audio/speech` | 列出历史 speech 记录 |
| `GET /v1/audio/speech/{id}` | 取单条元数据 |
| `DELETE /v1/audio/speech/{id}` | 删除 |
| `GET /v1/audio/speech/{id}/content` | 下载音频内容 |

支持 JSON 与 `multipart/form-data`（后者可上传 `prompt_audio` 做声音克隆，或给 `prompt_audio_path` 一个 URL 由服务端 `httpx` 下载）。`encode_speech_audio` 把生成的 WAV 转成 `response_format`：`wav`/`flac`/`pcm`（裸 int16）直接由 `soundfile` 出，`mp3`/`opus`/`aac` 走 `ffmpeg`（带超时与 400 错误）；`speed != 1.0` 用 `librosa.effects.time_stretch` 变速。协议层（`protocol.py`）新增 `AudioSpeechRequest` / `AudioSpeechResponse` / `AudioSpeechListResponse`。一个安全细节：OpenAI 的 `voice` 字段只是个标签（`alloy` / Voices id），**绝不当作文件系统路径**；克隆用专门的 `prompt_audio` 上传或 `prompt_audio_path`，`_safe_upload_filename` 把上传名 strip 成 basename 防 path traversal。

### 完整数据流

```
sglang generate --model-path meituan-longcat/LongCat-AudioDiT-1B \
                --prompt "今天晴暖转阴雨..." [--prompt-audio ref.wav --prompt-text "..." --guidance-method apg]
  │  （或 POST /v1/audio/speech  ——  OpenAI 兼容）
  │
  ├─ LongCatAudioDiTPipeline.load_modules()
  │    ├─ LongCatAudioDiTModel.from_pretrained(model_path)   ← 单 checkpoint，含 UMT5+DiT+VAE
  │    ├─ _sync_dit_config_from_model（对齐 1B/3.5B 维度）
  │    ├─ model.to(cuda); transformer→bf16; vae.to_half()
  │    ├─ _load_tokenizer（优先 checkpoint 自带，回退 Hub）
  │    └─ AudioDiTFlowMatchScheduler()
  │
  ├─ ① BeforeDenoisingStage.forward()
  │    ├─ 解析 gen_text / prompt_audio_path / prompt_text / guidance_method / duration_seconds
  │    ├─ 声音克隆？→ librosa 加载 ref.wav → VAE encode（仅一次，独立 generator）→ prompt_dur → 校正 duration
  │    │  纯文本？  → duration_seconds 显式指定，否则 _approx_duration_from_text 估算
  │    ├─ _normalize_text + 拼接 → tokenizer → input_ids / attention_mask
  │    ├─ encode_text: UMT5 → last_hidden + first_hidden → LayerNorm
  │    ├─ y0 = randn(duration, 64)；prompt_noise = y0[:, :latent_len].clone()
  │    ├─ scheduler.set_timesteps(16)  →  t = linspace(0,1,17)[:-1]
  │    └─ batch._audio_* + batch.cfg_policy = AudioDiTCFGPolicy(cfg|apg)
  │
  ├─ ② 标准 DenoisingStage.forward()（×16 步，框架循环）
  │    每步：
  │    ├─ prepare_step_latent: prompt 区域 ← prompt_noise·(1-t) + latent_cond·t  （并存 _current_latent/_current_t）
  │    ├─ cond 分支 transformer.forward → v_cond   （单步速度场）
  │    ├─ prepare_branch_latent: uncond 分支 prompt 区域清零 → transformer.forward → v_null
  │    └─ AudioDiTCFGPolicy.combine: CFG(pred+(pred-null)·s) / APG(sample-space 正交投影) → v
  │        └─ scheduler.step(v) → y += dt·v   （dt>0，升序）
  │    └─ post_denoising_loop: 切掉 prompt 段
  │
  ├─ ③ DecodingStage.forward()（role_affinity=DECODER）
  │    └─ vae.decode(pred_latent) → waveform (1, num_samples)
  │
  └─ OutputBatch(output=[waveform], audio=waveform, audio_sample_rate=24000)
       └─ post_process_sample(AUDIO) → soundfile.write(out.wav)
            （OpenAI 路径再经 encode_speech_audio → wav/flac/pcm/mp3/opus/aac）
```

---

## 测试

PR 在 checklist 中标注的 `Add unit tests` **已勾选**——新增两个测试文件，共 46 个用例。

### 单元测试

`test/unit/test_longcat_audiodit.py`（27 个）覆盖：

- **Registry**：HF id 含 `longcat-audiodit` 命中 `LongCatAudioDiTPipelineConfig` 而非 image；image id 仍命中 `LongCatImagePipelineConfig`（验证 detector 收窄后不串）；`KNOWN_NON_DIFFUSERS_DIFFUSION_MODEL_PATTERNS` 含新条目。
- **Scheduler**：`set_timesteps` 产出升序时间步 `(0, 0.25, 0.5, 0.75)`、sigmas 终点 1.0；`step` 给出 `dt>0` 的正确 Euler 更新。
- **CFG Policy**：`build` 产出 cond/uncond 两分支；`cfg` 合并与父类一致；`apg` 合并把 prompt 区域置零、shape 不变。
- **PipelineConfig**：`task_type.is_audio_gen()` / `data_type()==AUDIO`；`dit_config` 头数非零；`get_pos/neg_prompt_embeds` 返回张量；`cond_kwargs` 接受 `None` mask；`get_cfg_policy` 优先取 `batch.cfg_policy`。
- **Sampling / HTTP helpers**：`_adjust_audio_fields` 给出 `.wav` 输出路径；`first_output_file_path` 忽略 `None`；`vertex_generate` 透传 seed/steps/输出名。

`test/unit/test_openai_audio_api.py`（19 个）覆盖：

- **Protocol**：`resolve_speech_text` 优先 OpenAI `input`、接受 `prompt` 别名、缺 input 报 400；`normalize_response_format` 默认 `wav`、拒绝未知；`normalize_speed` 边界；`voice` 是标签而非路径；`require_audio_model` 拒绝 image task / 接受 T2A；输出路径 drop null；`generator_device` 默认 None。
- **encode_speech_audio**：wav（`RIFF` 头）/ pcm（int16 长度）正确；ffmpeg 超时返回 400。
- **安全**：`_safe_upload_filename` 把 `../../x.wav` / `/etc/passwd` strip 成 basename。

### 回归验证方式

算法正确性靠**与上游 LongCat-AudioDiT 仓库 1:1 对齐**保证：DiT 主干、WAV-VAE、CFM/APG、文本归一化与时长估计逐行从上游移植；WAV-VAE 的 fp16 dtype 顺序严格复刻 `AutoencoderPretransform(model_half=True)`；RoPE lazy build 注释承诺与原 `Qwen2RotaryEmbedding` bit-identical；权重通过 `from_pretrained` 单 checkpoint 加载无键名重映射。`AudioDiTFlowMatchScheduler` 的 docstring 也明确标注其与上游 `odeint_euler` 行为等价。

---

## 问题

### 为什么从单体 Stage 改回标准三段式 + hooks？

早期版本判断 ODE 积分器、prompt VAE 编码、CFG/APG 三者耦合在 `fn(t, x)` 闭包里、无法拆给标准 Stage，于是用一个 `InferenceStage` 包裹整条 `forward`。但这条路的代价是放弃了框架 `DenoisingStage` 既有的一切：循环调度、CFG 分支管理、注意力后端选择、FSDP/compile/layerwise offload 接入点、PD 分离部署。

重新审视后发现，耦合的其实是**三个可分离的横切点**：（1）每步重写 prompt 区域——这是个"model forward 前改 latent"的 hook；（2）无条件分支清零 prompt 区域——这是个"每分支改 latent"的 hook；（3）CFG/APG 合并——这是个"两次预测后合并"的 policy。于是给 `PipelineConfig` 加三个带默认实现的 hook（`prepare_step_latent` / `prepare_branch_latent` / `get_cfg_policy`），把闭包拆成三个扩展点，标准 `DenoisingStage` 即可驱动。模型 `forward` 退化为单步速度场预测，APG 需要的当前 latent/t 由 `prepare_step_latent` 顺手暂存到 batch。这是比单体 Stage 更诚实的取舍——既保留了上游算法 1:1 不变，又复用了框架基础设施。

### 为什么自定义 AudioDiTFlowMatchScheduler 而非 FlowMatchEulerDiscreteScheduler？

框架已有的 `FlowMatchEulerDiscreteScheduler` 用降序 sigma（1→0）、`dt<0`，且模型输出符号约定与上游相反（`v_longcat = -v_diffusers`）。强行套用要在每步给预测取负，既容易出错也偏离上游实现。专用 scheduler 把上游 `odeint_euler` 的升序 `t`、正 `dt`、同符号 1:1 镜像，行为等价且更易核对。

### 为什么 DiT 用 bf16、VAE 用 fp16 而非统一精度？

对齐上游参考 `inference.py`：DiT 主干在 bf16 下推理质量与速度平衡最优；WAV-VAE 的编解码若改 bf16 会与训练时 fp16 的数值行为不一致，产生可听差异。`load_modules` 里分别 `model.transformer.to(torch.bfloat16)` 与 `model.vae.to_half()`，VAE 的 `encode`/`decode` 还在内部按 `is_half` 分支严格控 dtype 顺序。

### 为什么 RoPE 不在 `__init__` 里建 `inv_freq`？

`from_pretrained` 用 meta-device 构造模型，若 `inv_freq` 在 `__init__` 里就注册成 buffer，会随 meta-device 路径冲突而损坏。lazy build 把构造推迟到首次 `forward`，且刻意在 CPU 上算 `inv_freq` 与 cos/sin、再 `.to(device)` 搬到目标设备——复刻原 `Qwen2RotaryEmbedding` 在 `__init__` 于 CPU 构造后整体搬迁的行为，从而产出 bit-identical 结果。这是把外部模型搬进 HuggingFace `PreTrainedModel` 体系时常见的坑。

### 为什么 `get_cfg_policy` 要每请求独立？

`pipeline_config` 是 pipeline 级共享对象。若把每请求的 `guidance_method`（cfg/apg）写回 `pipeline_config.cfg_policy`，并发服务时多个请求会互相覆盖。`get_cfg_policy` 优先读 `batch.cfg_policy`（由 `BeforeDenoisingStage` 按本次请求参数构造），并发请求各取各的、不互斥。

### 为什么文本编码要 `last_hidden + first_hidden` 并做 LayerNorm？

`text_add_embed=True` 把 UMT5 首层 hidden 加到末层——首层保留更多 token 级别的原始信息，末层更具语义，相加增强条件信号；`text_norm_feat=True` 对两者都做 LayerNorm 稳定尺度。这是上游模型的训练时设计，推理必须复刻否则条件分布偏移。

---

## 意义与影响

本 PR 把 LongCat-AudioDiT 接入 SGLang `multimodal_gen`，使该模型获得统一 API（`DiffGenerator` Python API / `sglang generate` CLI / HTTP Server / **OpenAI 兼容 `/v1/audio/speech`**）与**声音克隆**能力，并首次把**音频生成**作为一等任务类型引入框架。

更重要的是它**示范了框架的可扩展边界**。早期"单体 Stage"方案暗示：耦合度高、非 Diffusers 组织的模型只能绕过标准 Stage。本 PR 的最终形态给出了反例——只要能把耦合闭包拆成若干个"forward 前后改 latent / 合并预测"的横切点，就可以给 `PipelineConfig` 加 hooks 让标准 `DenoisingStage` 驱动它，从而复用框架的循环调度、注意力后端、USP 并行、layerwise offload、PD 分离等全部基础设施。这三个新增 hook（带默认实现、写在 `base.py`）是框架级通用扩展，后续任何"每步要改 latent / 每分支要改 latent / 每请求独立引导"的模型都能直接用。

同时 `DataType.AUDIO` / `ModelTaskType.T2A` 的引入是框架级的：CLI 扩展名白名单、`post_process_sample` 的 WAV 写出路径、HTTP server 对 audio-only 输出的处理、OpenAI `/v1/audio/speech` 端点及 CRUD 都已贯通，后续音频模型无需再改这些公共路径。

### 与 LongCat-Image 接入路径的对比

| 方面 | LongCat-Image（PR #23274） | LongCat-AudioDiT（本 PR） |
|------|---------------------------|--------------------------|
| 模型组织 | Diffusers `model_index.json` + 多组件 | 单 HuggingFace `PreTrainedModel` |
| 组件加载 | 框架标准 `AutoProcessorLoader` 等 | 覆盖 `load_modules` 直接 `from_pretrained` |
| Stage 拆分 | 标准三段式 + 模型特定 Stage hooks | Hybrid 三段式：模型特定 Before/Decoding + **标准 DenoisingStage（新增 3 hooks 驱动）** |
| ODE/去噪 | 框架 `DenoisingStage` + `FlowMatchEulerDiscreteScheduler` | 框架 `DenoisingStage` + 定制 `AudioDiTFlowMatchScheduler`（升序 t） |
| DiT 基座 | 框架 `BaseDiT` | 框架 `BaseDiT` + `LayerwiseOffloadableModuleMixin`（FA/AITER/SAGE/USP） |
| 引导 | CFG + CFG Renorm | CFG + APG（`AudioDiTCFGPolicy`，每请求独立） |
| 输出类型 | `DataType.IMAGE` | `DataType.AUDIO`（新引入） |
| 对外 API | OpenAI `/v1/images/generations` | OpenAI `/v1/audio/speech`（新引入，含 CRUD） |

可见同一框架能容纳"标准三段式 + Diffusers 组件"和"Hybrid 三段式 + 单 PreTrainedModel + 框架 hooks"两类截然不同的模型，且两者都吃到了标准 `DenoisingStage` 的基础设施——组合式设计可增可减。

---

## TODO

- [x] 补单元测试（PR checklist 已勾选，新增 46 个用例）。
- [ ] 与上游参考 `inference.py` 做同文本/同参考音频的输出波形对比，确认数值一致（尤其 VAE fp16 dtype 顺序、APG float64 投影、以及 `transformer` 接入 `BaseDiT` 后注意力后端切换是否引入误差）。
- [x] 接入框架并行/后端基础设施：`transformer` 已继承 `BaseDiT`，支持 FA/AITER/SAGE 注意力后端与 USP 序列并行、layerwise offload。完整 TP（`ColumnParallelLinear`/`RowParallelLinear` 全层替换）仍待评估，3.5B 在大批量/长音频下收益明显。
- [ ] 长音频支持：当前 `max_wav_duration=30.0`（约 351 latent 帧），超长文本需分段拼接。
- [x] inline Euler 已升级为标准 `AudioDiTFlowMatchScheduler`（升序 t、`dt>0`、复用框架 `DenoisingStage` 循环）；更高阶积分器（Heun / 中点法）仍可作为后续质量优化。


---

## 参考

- [LongCat-AudioDiT HuggingFace](https://huggingface.co/meituan-longcat/LongCat-AudioDiT-1B)
- [LongCat-AudioDiT GitHub](https://github.com/meituan-longcat/LongCat-AudioDiT)
- [Adaptive Projected Guidance (APG)](https://arxiv.org/abs/2410.02416) — diff 分支投影引导
- Conditional Flow Matching（CFM）/ Flow Matching 综述
- UMT5（Universal Multilingual T5）文本编码器
- WAV-VAE：波形域音频自编码器（Snake 激活、weight-norm Conv1d）
- [OpenAI Audio API（/v1/audio/speech）](https://platform.openai.com/docs/api-reference/audio/createSpeech) — 本 PR 兼容的接口规范

---

## 相关阅读

- [LongCat-AudioDiT 论文解读](/vibe-reading/articles/longcat-audiodit-waveform-latent-diffusion-tts) — **设计来源**·本 PR 接入的模型原论文（波形隐空间扩散 TTS + Wav-VAE + DiT + APG），本篇的算法逻辑（CFM/APG/时长估计/文本归一化）均 1:1 移植自该论文实现
- [SGLang PR-23274：接入 LongCat-Image](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) — **同设计落地线**。同属 LongCat 系列接入 `multimodal_gen`，本篇与之对照可见框架如何同时容纳 Diffusers 多组件（image）与单 PreTrainedModel（audio）两类模型组织方式。
