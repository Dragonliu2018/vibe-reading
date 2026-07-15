---
title: "在 SGLang 中接入 LongCat-AudioDiT：把扩散 TTS 塞进文生图框架"
source:
  project: "SGLang"
  type: "PR"
  id: "22191"
  url: "https://github.com/sgl-project/sglang/pull/22191"
  prType: "feat"
date: "2026-07-14"
category: [AI, 推理, SGLang, Contributions]
tags: ["Diffusion", "TTS", "Flow Matching", "DiT", "SGLang", "LongCat-AudioDiT", "VAE"]
description: "解读 PR #22191：如何在 SGLang multimodal_gen 框架中接入 LongCat-AudioDiT 扩散式 TTS 模型，涵盖单体 Stage 设计、WAV-VAE 混合精度、inline Euler ODE 积分器与 CFG/APG 双引导。"
readingTime: "20 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#22191](https://github.com/sgl-project/sglang/pull/22191) · **Issue** - · **commit** - · **首发版本** - · **变更行数** +2197 / -11 行（17 文件）· **合并时间** 2026-04-06（创建，截至写作时仍处 Open 状态）

---

## 背景

LongCat-AudioDiT 是美团 LongCat 团队的扩散式文本转语音（TTS）模型，**直接在波形 latent 空间上做 Conditional Flow Matching**，而非传统的频谱域（mel-spectrogram）+ vocoder 两段式。它支持纯文本 TTS 与**声音克隆（voice cloning）**——给定一段参考音频及其文本，克隆音色合成新内容。

SGLang 的 `multimodal_gen` 子系统此前已接入 Wan / Hunyuan / ZImage / Flux / LongCat-Image 等**图像/视频**扩散模型，形成"标准 Stage + 模型特定 `PipelineConfig` hooks"的组合式 pipeline 框架。但这些模型都有两个共同前提：（1）以 Diffusers `model_index.json` 声明组件；（2）生成流程能干净地拆成 `LatentPreparation → Denoising → Decoding` 三段式标准 Stage。

LongCat-AudioDiT 同时打破这两个前提：它以**单个 HuggingFace `PreTrainedModel`** 形式发布（无 `model_index.json`），且整条生成链路（文本编码 → ODE 求解 → VAE 解码）高度耦合在模型自己的 `forward` 里——ODE 积分器、CFG/APG 引导、prompt 音频的 VAE 编码都交织在同一个闭包中，无法拆给标准 `DenoisingStage`。本 PR 的工作正是为这类模型设计一条**单体 Stage（monolithic stage）**接入路径，并把 `AUDIO` 作为一等数据类型引入框架。

---

## 前置知识

### SGLang multimodal_gen 的组合式 Pipeline

`multimodal_gen` 把一次生成拆成一串 `PipelineStage`，由 `ComposedPipelineBase` 顺序执行。框架提供标准 Stage（`LatentPreparationStage` / `TimestepPreparationStage` / `DenoisingStage` / `DecodingStage`），其行为通过模型特定的 `PipelineConfig` hook 注入。模型通常只需实现自己的 `PipelineConfig` 和必要的模型特定 Stage。**本 PR 的 LongCat-AudioDiT 是例外**：它绕过这套标准 Stage，只用一个 `LongCatAudioDiTInferenceStage` 跑完全程。

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

推理 Stage 同样标注：

```text title="pipelines_core/.../longcat_audiodit.py"
# Reference: https://github.com/meituan-longcat/LongCat-AudioDiT/blob/main/inference.py
```

即 DiT 主干、WAV-VAE、CFM/APG 引导、文本归一化与时长估计等算法逻辑都从上游仓库 1:1 移植；SGLang 侧的工作不是重新设计算法，而是**把这套单体模型映射到 `multimodal_gen` 的 pipeline 框架**，并把 `AUDIO` 数据类型贯通到 CLI / HTTP server / 保存路径。

---

## 实现

### 模型架构总览

| 组件 | 类型 | 说明 |
|------|------|------|
| `text_encoder` | `UMT5EncoderModel`（UMT5-base，768d） | 冻结；取 `last_hidden_state` + 首层 hidden（`text_add_embed`），做 LayerNorm（`text_norm_feat`） |
| `transformer` | `LongCatAudioDiTTransformer` | 24 层 CrossDiT：self-attn + cross-attn + FFN，global AdaLN，RoPE，QK-Norm，ConvNeXt-V2 文本卷积，long skip |
| `vae` | `LongCatAudioDiTVae` | WAV-VAE：Snake 激活 + weight-norm Conv1d，2048× 下采样，`latent_dim=64`，`scale=0.71` |
| (无 scheduler) | — | ODE 积分器内联在 `forward` 里，不用框架的 `FlowMatchEulerDiscreteScheduler` |

DiT 关键超参（`LongCatAudioDiTConfig`）：`dit_dim=1536`、`dit_depth=24`、`dit_heads=24`（`dim_head=64`）、`dit_text_dim=768`、`dit_ff_mult=4.0`、`dit_adaln_type="global"`、`dit_long_skip=True`、`dit_text_conv=True`、`dit_qk_norm=True`、`repa_dit_layer=8`、`latent_dim=64`、`sampling_rate=24000`、`latent_hop=2048`、`max_wav_duration=30.0`。

VAE 关键超参（`LongCatAudioDiTVaeConfig`）：`channels=128`、`c_mults=[1,2,4,8,16]`、`strides=[2,4,4,8,8]`（乘积 = 2048 = `downsampling_ratio`）、`encoder_latent_dim=128`（瓶颈后 split 成 mean+scale → `latent_dim=64`）、`use_snake=True`、`scale=0.71`。

DiT 主干数据流：

```
text_ids → UMT5 → text_embed(768→1536) → ConvNeXtV2×4 → text 条件
audio latent [B, 64, T] → input_embed(64→1536) → (+ latent_cond) → x
time → sinusoidal → MLP → t
                                                                   │
24 × LongCatAudioDiTBlock:                                          │
  global AdaLN(scale/shift/gate×6) → self-attn(RoPE+QKNorm)         │
  → cross-attn(text) → FFN                                          │
                                                                   ▼
  + long_skip (x_clone) → norm_out(AdaLN) → proj_out(1536→64) → 速度场 v(x,t)
```

### 关键设计 1：单体 Stage 替代标准三段式

`LongCatAudioDiTPipelineConfig` 的 docstring 直接点明这一取舍：

```python title="configs/pipeline_configs/longcat_audiodit.py"
@dataclass
class LongCatAudioDiTPipelineConfig(PipelineConfig):
    """...
    Unlike image/video pipelines the entire generation loop (ODE solve + VAE
    decode) is handled inside the model's own ``forward`` method, so most of the
    standard ``DenoisingStage`` / ``DecodingStage`` callbacks are not used.
    The pipeline uses a single monolithic ``LongCatAudioDiTInferenceStage`` that
    drives the full inference and returns the waveform directly.
    """
    task_type: ModelTaskType = ModelTaskType.T2A
    dit_precision: str = "bf16"
    vae_precision: str = "fp16"
```

Stage 的 docstring 给出三条理由：

```text title="pipelines_core/.../longcat_audiodit.py"
# This approach is correct because:
# - The ODE solver is a custom inline Euler integrator tightly coupled to the model.
# - The VAE encode/decode for prompt audio must happen inside the same forward pass.
# - The CFG / APG guidance is woven into the ODE function closure.
```

即 ODE 积分器、prompt 音频 VAE 编码、CFG/APG 引导三者耦合在 `forward` 的 `fn(t, x)` 闭包里，强行拆给标准 `DenoisingStage` 反而要重写框架。于是 pipeline 只挂一个 Stage：

```python title="runtime/pipelines/longcat_audiodit.py"
def create_pipeline_stages(self, server_args: ServerArgs):
    self.add_stage(
        LongCatAudioDiTInferenceStage(
            model=self.get_module("model"),
            tokenizer=self.get_module("tokenizer"),
        ),
        "longcat_audiodit_inference_stage",
    )
```

`LongCatAudioDiTInferenceStage.forward` 完成全部工作：解析文本/参考音频 → 时长估计 → tokenize → 调 `model(...)` → 返回 `OutputBatch(output=[waveform], audio=waveform, audio_sample_rate=sr)`。

### 关键设计 2：绕过 Diffusers 组件加载

LongCat-AudioDiT 以单个 `PreTrainedModel` 发布，没有 `model_index.json`。`LongCatAudioDiTPipeline` 覆盖 `load_modules` 直接 `from_pretrained`，并把 `_required_config_modules` 置空：

```python title="runtime/pipelines/longcat_audiodit.py"
_required_config_modules: list[str] = []   # 无 Diffusers 组件

def load_modules(self, server_args, loaded_modules=None):
    if loaded_modules:
        return loaded_modules
    model = LongCatAudioDiTModel.from_pretrained(self.model_path)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device)
    model.transformer.to(torch.bfloat16)   # DiT: bf16
    model.vae.to_half()                     # VAE: fp16（对齐参考 inference.py）
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder_model)
    return {"model": model, "tokenizer": tokenizer}
```

为避免依赖外部 `audiodit` 包，pipeline 在模块顶层把 config/model 注册进 HuggingFace Auto 体系：

```python title="runtime/pipelines/longcat_audiodit.py"
AutoConfig.register("audiodit", LongCatAudioDiTConfig, exist_ok=True)
AutoModel.register(LongCatAudioDiTConfig, LongCatAudioDiTModel, exist_ok=True)
```

`LongCatAudioDiTConfig` 用 `sub_configs` 把 `vae_config` 与 `text_encoder_config`（`UMT5Config`）声明为子配置，`from_pretrained` 时连同 UMT5 文本编码器一起加载——文本编码器作为 `LongCatAudioDiTModel` 的子模块构造、权重随主 checkpoint 一起加载，无需单独下载。`utils.py` 的 `KNOWN_NON_DIFFUSERS_DIFFUSION_MODEL_PATTERNS` 加一行 `"longcat-audiodit": "LongCatAudioDiTPipeline"`，让框架识别这类非 Diffusers 模型。

### 关键设计 3：WAV-VAE 的 fp16 数值对齐

VAE 的 `encode`/`decode` 不是简单 `.half()`，而是**严格复刻上游 `AutoencoderPretransform(model_half=True)` 的 dtype 顺序**。`LongCatAudioDiTVae` 的 docstring 与代码注释反复强调：瓶颈操作必须发生在 fp16 编码器输出上、在最终 `.float()` 转换之前：

```python title="runtime/models/dits/longcat_audiodit.py"
def encode(self, audio):
    is_half = next(self.encoder.parameters()).dtype == torch.float16
    if is_half:
        audio = audio.half()
    latents = self.encoder(audio)
    # VAE bottleneck runs in the same dtype as encoder output (fp16)
    # to match original: bottleneck.encode(latents) happens before .float()
    mean, scale_param = latents.chunk(2, dim=1)
    stdev = F.softplus(scale_param) + 1e-4
    latents = torch.randn_like(mean) * stdev + mean   # reparameterize
    if is_half:
        latents = latents.float()
    return latents / self.scale
```

`encoder_latent_dim=128` 在瓶颈处 split 成 mean + scale 两路各 64 维，重参数化后得 `latent_dim=64`，再除以 `scale=0.71` 归一化。`decode` 同理：`z = latents * scale` → fp16 → decoder → `.float()`。这种"在哪一步转 dtype"的细节若错位，生成音频与参考实现会有可听差异。

### 关键设计 4：inline Euler ODE 积分器

用 15 行手写 Euler 积分器替换 `torchdiffeq` 依赖，消除一个外部依赖且更易在框架内调试：

```python title="runtime/models/dits/longcat_audiodit.py"
def odeint_euler(fn, y0, t):
    """Simple Euler ODE integrator (equivalent to torchdiffeq.odeint
    with method='euler')."""
    ys = [y0]
    y = y0
    for i in range(len(t) - 1):
        dt = t[i + 1] - t[i]
        y = y + fn(t[i], y) * dt
        ys.append(y)
    return torch.stack(ys)
```

`t = torch.linspace(0, 1, steps)`（默认 16 步），`fn(t, x)` 是把 CFG/APG 引导编织进去的速度场闭包。

### 关键设计 5：CFG 与 APG 双引导

`fn(t, x)` 内部对每步做两次 transformer 前向（条件 + 无条件），再按 `guidance_method` 合并：

```python title="runtime/models/dits/longcat_audiodit.py"
def fn(t, x):
    # prompt 区域固定为 prompt_noise→latent_cond 的线性插值（声音克隆锚定音色）
    x[:, :latent_len] = prompt_noise * (1 - t) + latent_cond[:, :latent_len] * t
    output = self.transformer(x=x, text=text_condition, ..., latent_cond=latent_cond)
    pred = output["last_hidden_state"]
    if cfg_strength < 1e-5:
        return pred
    # 无条件分支：清零 prompt 区域 + 空文本
    x[:, :latent_len] = 0
    null_pred = self.transformer(x=x, text=neg_text, ...,
                                 latent_cond=empty_latent_cond)["last_hidden_state"]
    if guidance_method == "cfg":
        return pred + (pred - null_pred) * cfg_strength
    # APG: 把 (pred - null) 投影到 cond 方向的正交/平行分量
    ...
    out = _apg_forward(pred_sample, null_sample, cfg_strength, apg_buffer,
                       eta=0.5, norm_threshold=0.0, dims=[-1, -2])
    return F.pad((out - x_s) / (1 - t), (0, 0, latent_len, 0), value=0.0)
```

**CFG** 是经典 `pred + (pred - null) * strength`。**APG（Adaptive Projected Guidance）** 把引导差 `diff = pred_cond - pred_uncond` 经动量缓冲（`momentum=-0.3`）平滑后，投影到条件预测方向的正交分量 + `eta=0.5` 倍平行分量，再叠加回条件预测——相比 CFG 在高引导强度下更不易过饱和。`_project` 用 float64 做正交化保证数值精度。默认 `guidance_method="cfg"`，`--guidance-method apg` 切换。

### 关键设计 6：声音克隆与时长估计

纯文本 TTS 时，时长由文本字符数估算（`_approx_duration_from_text`：中文 0.21s/字、英文 0.082s/字，按主语言把"其他字符"归并）。声音克隆时多一步：先 VAE 编码参考音频得到精确 prompt 帧数 `prompt_dur`，再用参考音频实际时长 / 其文本估算时长的比值（clip 到 `[1.0, 1.5]`）校正生成段时长，最终 `duration = min(gen_dur + prompt_dur, max_frames)`：

```python title="pipelines_core/.../longcat_audiodit.py"
prompt_wav_1d = _load_audio_tensor(prompt_audio_path, sr)        # librosa 加载
_, prompt_dur = self.model.encode_prompt_audio(prompt_wav.to(device))
prompt_time = prompt_dur * full_hop / sr
dur_sec = _approx_duration_from_text(gen_text, max_duration=max_duration - prompt_time)
if prompt_text:
    approx_pd = _approx_duration_from_text(prompt_text, max_duration=max_duration)
    ratio = float(np.clip(prompt_time / approx_pd, 1.0, 1.5))
    dur_sec = dur_sec * ratio
duration = int(dur_sec * sr // full_hop)
duration = min(duration + prompt_dur, int(max_duration * sr // full_hop))
```

模型 `forward` 里 prompt 区域通过 `x[:, :latent_len] = prompt_noise*(1-t) + latent_cond*t` 在每步重新锚定——保证克隆音色不被 ODE 流冲散。生成后 `pred_latent = sampled[:, prompt_dur:]` 丢掉 prompt 段再解码。文本归一化（`_normalize_text`：转小写、引号转空格、压缩空白）与拼接 `"[prompt_text] [gen_text]"` 都对齐上游。

### 关键设计 7：RoPE 的 lazy build 防 meta-device 损坏

`LongCatAudioDiTRotaryEmbedding`（Qwen2 风格）刻意不在 `__init__` 注册任何 buffer，而是首次 `forward` 时 lazy 构建 cos/sin：

```python title="runtime/models/dits/longcat_audiodit.py"
# Do NOT register any buffers here — they get corrupted by meta-device.
# Everything is built lazily in forward().
self._cos: torch.Tensor | None = None
self._sin: torch.Tensor | None = None
```

注释解释：`from_pretrained` 用 meta-device 构造模型，若 `inv_freq` 在 `__init__` 里就建在 CPU、再随 `.to(device)` 整体搬迁，会和 meta-device 路径冲突导致损坏。lazy build 在目标 device 上直接构造，产生与原 `Qwen2RotaryEmbedding` bit-identical 的结果。

### 框架贯通：AUDIO 作为一等数据类型

为支持音频输出，框架侧补齐三处：

**`base.py`** 新增 `ModelTaskType.T2A`，其 `data_type` 返回 `DataType.AUDIO`：

```python title="configs/pipeline_configs/base.py"
class ModelTaskType(Enum):
    ...
    T2A = auto()  # Text to Audio
    def data_type(self) -> DataType:
        if self == ModelTaskType.I2M:
            return DataType.MESH
        if self == ModelTaskType.T2A:
            return DataType.AUDIO
        ...
```

**`sampling_params.py`** 新增 `DataType.AUDIO`（默认扩展名 `wav`）、`prompt_audio_path` / `prompt_text` / `guidance_method` 字段及对应 CLI 参数（`--prompt-audio-path` / `--prompt-text` / `--guidance-method`），并在 `_set_output_file_ext` 的扩展名白名单加入 `.wav`。

**`entrypoints/utils.py`** 的 `post_process_sample` 增加 `DataType.AUDIO` 分支，用 `soundfile` 写 WAV：

```python title="runtime/entrypoints/utils.py"
if data_type == DataType.AUDIO:
    if save_output and save_file_path:
        import soundfile as sf
        if isinstance(sample, torch.Tensor):
            audio_np = sample.squeeze().detach().cpu().numpy()
        else:
            audio_np = np.squeeze(sample)
        sr = audio_sample_rate or 24000
        os.makedirs(os.path.dirname(os.path.abspath(save_file_path)), exist_ok=True)
        sf.write(save_file_path, audio_np, sr)
    return None  # no video frames to return
```

**`http_server.py`** 处理音频-only 输出（`output is None but audio is not None`），并把 `encode_video_to_base64` 改名为通用的 `encode_file_to_base64`；`vertex_generate` 透传 `prompt_audio_path` / `prompt_text` / `guidance_method`。

**`pyproject*.toml`** 四处 diffusion 依赖组加入 `librosa`（`soundfile` 随 librosa 间接引入，但代码里显式 `import soundfile`）。

### 完整数据流

```
sglang generate --model-path meituan-longcat/LongCat-AudioDiT-1B \
                --prompt "今天晴暖转阴雨..." [--prompt-audio ref.wav --prompt-text "..."]
  │
  ├─ LongCatAudioDiTPipeline.load_modules()
  │    ├─ LongCatAudioDiTModel.from_pretrained(model_path)   ← 单 checkpoint，含 UMT5+DiT+VAE
  │    ├─ model.to(cuda); transformer→bf16; vae.to_half()
  │    └─ AutoTokenizer.from_pretrained("google/umt5-base")
  │
  └─ LongCatAudioDiTInferenceStage.forward()
       ├─ 解析 gen_text / prompt_audio_path / prompt_text / guidance_method
       ├─ 声音克隆？ → librosa 加载 ref.wav → VAE encode 得 prompt_dur → 校正 duration
       │  纯文本？  → _approx_duration_from_text 估算 duration
       ├─ _normalize_text + 拼接 → tokenizer → input_ids / attention_mask
       ├─ model.forward(input_ids, attention_mask, prompt_audio, duration, steps=16,
       │                cfg_strength=4.0, guidance_method="cfg"|"apg")
       │    ├─ encode_text: UMT5 → last_hidden + first_hidden → LayerNorm
       │    ├─ encode_prompt_audio: VAE encode → prompt_latent (声音克隆)
       │    ├─ y0 = randn(duration, 64);  prompt_noise = y0[:, :latent_len].clone()
       │    ├─ t = linspace(0, 1, 16)
       │    ├─ odeint_euler(fn, y0, t):  每步 fn 做 cond + uncond 两次 DiT 前向 → CFG/APG 合并
       │    │    └─ prompt 区域每步重锚: prompt_noise*(1-t) + latent_cond*t
       │    ├─ sampled = trajectory[-1];  去掉 prompt 段
       │    └─ vae.decode(pred_latent) → waveform (1, num_samples)
       └─ OutputBatch(output=[waveform], audio=waveform, audio_sample_rate=24000)
            └─ post_process_sample(AUDIO) → soundfile.write(out.wav)
```

---

## 测试

PR 在 checklist 中标注了 `[ ] Add unit tests`（未勾选），截至写作时尚未补单测。作者在 PR body 中给了两条 CLI 示例（纯文本 TTS 与声音克隆），并附 `tts.wav` / `prompt.wav` / `clone.wav` 三个音频文件用于人工试听验证，但 `Accuracy Tests` 与 `Speed Tests and Profiling` 两节均留空。

### 回归验证方式

由于无自动化测试，正确性目前靠**与上游 LongCat-AudioDiT 仓库 1:1 对齐**保证：

- DiT 主干、WAV-VAE、CFM/APG、文本归一化与时长估计逐行从上游 `inference.py` / `model/*` 移植；
- WAV-VAE 的 fp16 dtype 顺序严格复刻 `AutoencoderPretransform(model_half=True)`，docstring 与代码注释反复强调瓶颈操作须在 `.float()` 之前发生；
- RoPE lazy build 注释承诺与原 `Qwen2RotaryEmbedding` bit-identical；
- 权重通过 `from_pretrained` 单 checkpoint 加载，无键名重映射。

---

## 问题

### 为什么不用框架的标准 `DenoisingStage` / `DecodingStage`？

LongCat-AudioDiT 的 ODE 积分器、prompt 音频 VAE 编码、CFG/APG 引导三者耦合在 `forward` 的 `fn(t, x)` 闭包里——每步 ODE 都要做 cond + uncond 两次 DiT 前向，prompt 区域每步重新锚定（`prompt_noise*(1-t)+latent_cond*t`），APG 还要在两预测间做正交投影。强行拆成标准 Stage 要么得把闭包拆散后用一堆 hook 拼回，要么得改框架支持"自定义 ODE 闭包"。用一个 `LongCatAudioDiTInferenceStage` 跑完全程是更诚实的取舍，docstring 也明确列出了三条理由。

### 为什么 DiT 用 bf16、VAE 用 fp16 而非统一精度？

对齐上游参考 `inference.py`：DiT 主干在 bf16 下推理质量与速度的平衡最优；WAV-VAE 的编解码若改 bf16 会与训练时 fp16 的数值行为不一致，产生可听差异。`load_modules` 里分别 `model.transformer.to(torch.bfloat16)` 与 `model.vae.to_half()`，VAE 的 `encode`/`decode` 还在内部按 `is_half` 分支严格控 dtype 顺序。

### 为什么 RoPE 不在 `__init__` 里建 `inv_freq`？

`from_pretrained` 用 meta-device 构造模型，若 `inv_freq` 在 `__init__` 里就建在 CPU、再随 `.to(device)` 整体搬迁，会和 meta-device 路径冲突导致 buffer 损坏。lazy build 在目标 device 上直接构造 cos/sin，既避开 meta-device 问题，又产出与原实现 bit-identical 的结果。这是把外部模型搬进 HuggingFace `PreTrainedModel` 体系时常见的坑。

### 为什么文本编码要 `last_hidden + first_hidden` 并做 LayerNorm？

`text_add_embed=True` 把 UMT5 首层 hidden 加到末层——首层保留更多 token 级别的原始信息，末层更具语义，相加增强条件信号；`text_norm_feat=True` 对两者都做 LayerNorm 稳定尺度。这是上游模型的训练时设计，推理必须复刻否则条件分布偏移。

### 为什么用 inline Euler 而非 `torchdiffeq`？

16 步 Euler 极简（15 行），引入 `torchdiffeq` 整个依赖只为调一个 `odeint(method='euler')` 不划算；inline 版本还更易在框架内逐步调试（如打印每步速度场范数）。功能上与 `torchdiffeq.odeint(method='euler')` 等价。

---

## 意义与影响

本 PR 把 LongCat-AudioDiT 接入 SGLang `multimodal_gen`，使该模型获得统一 API（`DiffGenerator` Python API / `sglang generate` CLI / HTTP Server）与**声音克隆**能力，并首次把**音频生成**作为一等任务类型引入框架。

更重要的是它**拓宽了框架的接入边界**：此前 `multimodal_gen` 默认假设模型以 Diffusers `model_index.json` 声明组件、生成流程能拆成三段式标准 Stage。LongCat-AudioDiT 同时打破这两个前提（单 `PreTrainedModel` + 单体 `forward`），本 PR 用"绕过 `load_modules` + 单体 Stage + `KNOWN_NON_DIFFUSERS_DIFFUSION_MODEL_PATTERNS` 识别"的组合给出了一条可复用路径——后续任何耦合度高、非 Diffusers 组织的扩散模型（如其他 TTS / 音乐生成模型）都能照此接入。

同时 `DataType.AUDIO` / `ModelTaskType.T2A` 的引入是框架级的：CLI 扩展名白名单、`post_process_sample` 的 WAV 写出路径、HTTP server 对 audio-only 输出的处理都已贯通，后续音频模型无需再改这些公共路径。

### 与 LongCat-Image 接入路径的对比

| 方面 | LongCat-Image（PR #23274） | LongCat-AudioDiT（本 PR） |
|------|---------------------------|--------------------------|
| 模型组织 | Diffusers `model_index.json` + 多组件 | 单 HuggingFace `PreTrainedModel` |
| 组件加载 | 框架标准 `AutoProcessorLoader` 等 | 覆盖 `load_modules` 直接 `from_pretrained` |
| Stage 拆分 | 标准三段式 + 模型特定 Stage hooks | 单体 `InferenceStage` 跑全程 |
| ODE/去噪 | 框架 `DenoisingStage`（50 步） | 模型 `forward` 内 inline Euler（16 步） |
| TP 并行 | 全层 `ColumnParallelLinear`/`RowParallelLinear` | 纯 `nn.Linear`（未做 TP 并行） |
| 输出类型 | `DataType.IMAGE` | `DataType.AUDIO`（新引入） |
| 引导 | CFG + CFG Renorm | CFG + APG |

可见框架能同时容纳"标准三段式 + TP 并行"和"单体 Stage + 单卡"两类截然不同的模型，组合式设计可增可减。

---

## TODO

- [ ] 补单元测试（PR checklist 未勾选）。
- [ ] 与上游参考 `inference.py` 做同文本/同参考音频的输出波形对比，确认数值一致（尤其 VAE fp16 dtype 顺序与 APG float64 投影）。
- [ ] 接入 TP 并行：当前 DiT 用纯 `nn.Linear`，未做 `ColumnParallelLinear`/`RowParallelLinear`，多卡无法加速。3.5B 模型在大批量/长音频下收益明显。
- [ ] 长音频支持：当前 `max_wav_duration=30.0`（351 latent 帧），超长文本需分段拼接。
- [ ] 把 inline Euler 升级为更高阶积分器（如 Heun / 中点法）以减少步数，或在保持 16 步下提升质量。

---

## 参考

- [LongCat-AudioDiT HuggingFace](https://huggingface.co/meituan-longcat/LongCat-AudioDiT-1B)
- [LongCat-AudioDiT GitHub](https://github.com/meituan-longcat/LongCat-AudioDiT)
- [Adaptive Projected Guidance (APG)](https://arxiv.org/abs/2410.02416) — diff 分支投影引导
- Conditional Flow Matching（CFM）/ Flow Matching 综述
- UMT5（Universal Multilingual T5）文本编码器
- WAV-VAE：波形域音频自编码器（Snake 激活、weight-norm Conv1d）
