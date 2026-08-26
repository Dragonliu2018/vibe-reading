---
title: "LongCat-Image-Edit 接入 SGLang：图像编辑（I2I）的隐空间拼接与联合 VL 编码"
source:
  project: "SGLang"
  type: "PR"
  id: "35829"
  url: "https://github.com/sgl-project/sglang/pull/35829"
  prType: "feat"
date: "2026-08-26T14:34:07+08:00"
category: [AI, Infra, Inference, SGLang, PRs]
tags: ["Diffusion", "DiT", "I2I", "SGLang", "Qwen2.5-VL", "LongCat-Image", "Sequence Parallelism"]
description: "解读 PR #35829：SGLang 扩散框架接入 LongCat-Image-Edit 图像编辑（I2I），核心是条件图双路径（VL 联合编码 + VAE 参考隐空间拼接 [noisy|reference]）、RoPE 双模态 id 与三处 review 中暴露的框架缺陷修复。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#35829](https://github.com/sgl-project/sglang/pull/35829) · **Issue** - · **commit** [284ed9d](https://github.com/sgl-project/sglang/commit/284ed9d1d3c12c46cd27464a407ac7d741794a95) · **首发版本** - · **变更行数** +799 行（12 文件）· **合并时间** 2026-08-25

> 📎 本文是 [在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) 的后续，建议先阅读原文了解 T2I pipeline 与组合式框架。

---

## 背景

LongCat-Image 是美团 LongCat 团队的文生图模型，基于 **Flow Matching + MMDiT** 架构（Flux 同族），使用 **Qwen2.5-VL（7B）** 作为文本编码器。SGLang 的 `multimodal_gen` 子系统在 [PR #23274](https://github.com/sgl-project/sglang/pull/23274) 中接入了它的 **T2I（文生图）** 能力——那时条件输入只有一段文本 prompt，经 Qwen2.5-VL 自回归 **Prompt Rewrite** 扩写后送入 DiT 去噪。

本 PR 要解决的是另一类任务：**图像编辑（I2I，image-to-image）**。对应模型是 [meituan-longcat/LongCat-Image-Edit](https://huggingface.co/meituan-longcat/LongCat-Image-Edit) 及其蒸馏加速版 [LongCat-Image-Edit-Turbo](https://huggingface.co/meituan-longcat/LongCat-Image-Edit-Turbo)。I2I 与 T2I 的本质区别在于：编辑任务有一张**条件图（reference image）**，模型既要"看懂"这张图（通过 VL 编码），又要在隐空间里把它作为参考信号注入去噪过程，从而保证"只改指定部分，其余细节不变"。

挑战不在新增一个模型，而在于 I2I 的数据流与 T2I 截然不同：

- **条件图要走两条路**：一条降采样 2× 喂给 Qwen2.5-VL 做联合 text+image 编码（替代 T2I 的纯文本 Prompt Rewrite）；另一条原分辨率经 VAE 编码、pack 后作为**参考隐空间**拼接在噪声 latent 之后。
- **隐空间序列变长**：DiT 每步要在 `[noisy | reference]` 拼接后的序列上做 joint-attention，再用 `slice` 把参考 token 的预测丢弃。
- **RoPE 要区分模态**：噪声 token 与参考 token 共享同一空间网格，但必须用不同的 modality id，否则模型无法区分"待去噪"与"参考锚点"。

PR 作者 ITerydh 把这些差异收敛到一个新的 `LongCatImageEditPipelineConfig`（继承 T2I 配置）+ 一个新的模型特定 Stage 里，尽量复用框架已有的标准去噪 / 解码链路。review 过程中还顺带暴露并修复了三处 `multimodal_gen` 框架本身潜藏的缺陷（见「问题」节）。

![LongCat-Image-Edit Pipeline 架构（7 阶段）](/vibe-reading/images/articles/sglang-pr-35829-longcat-image-edit/pipeline-architecture.svg)

上图标注了 Edit pipeline 的 7 个 Stage：黄色框 `LongCatImageEditTextEncodingStage` 是唯一新增的模型特定 Stage（联合 VL 编码），蓝色框其余 6 个全部复用框架标准实现。与 T2I 的 6 阶段相比，Edit 多了 `ImageVAEEncodingStage`（编码参考图），并用 VL 联合编码 Stage 取代了 T2I 的 `LongCatPromptRewriteStage` + `TextEncodingStage` 两段——编辑任务不再需要把 prompt 扩写成长文本，而是要把图片本身"读"进 conditioning。

## 前置知识

### SGLang multimodal_gen 的组合式 Pipeline

`multimodal_gen` 把一次生成拆成一串 `PipelineStage`，由 `ComposedPipelineBase` 顺序执行。框架提供一批**标准 Stage**（`LatentPreparationStage` / `TimestepPreparationStage` / `DenoisingStage` / `DecodingStage`），它们的行为通过一个模型特定的 `PipelineConfig` 的若干 hook 方法注入。模型只需实现自己的 `PipelineConfig`（描述 latent 形状、pack/unpack、sigma 调度、CFG 后处理等）和必要的**模型特定 Stage**，就能拼出完整 pipeline。这套机制在 [T2I 接入文章](/vibe-reading/articles/sglang-pr-23274-support-longcat-image)里有完整说明，本篇不重复，只聚焦 Edit 与 T2I 的差异。

### T2I 与 Edit 的数据流对照

| 维度 | T2I（#23274） | Edit（本 PR） |
| --- | --- | --- |
| 条件输入 | 纯文本 prompt | 文本 prompt **+ 条件图** |
| prompt 编码 | Qwen2.5-VL `.generate()` 扩写 → 纯文本编码 | Qwen2.5-VL **联合 text+image 编码**（不扩写） |
| 第二条条件路径 | 无 | 条件图 → VAE encode → pack → **参考隐空间** |
| DiT 输入序列 | `[text | noisy]` | `[text | noisy \| reference]`（参考拼在噪声后） |
| RoPE 模态 | 文本 0 / 图像 1 | 文本 0 / 噪声 1 / **参考 2** |
| 噪声 dtype | float32 | **bf16**（与 prompt embeds 同） |
| 输出分辨率 | 固定 / ceil 到 32 | 条件图面积 ~1MP / **ceil 到 16** |
| CFG | renorm + prompt rewrite 开 | **renorm off / rewrite off**，plain CFG |

理解了这张对照表，后面的实现细节就只是在逐条落地。

## 设计参考

实现严格对齐 diffusers 的参考实现 `LongCatImageEditPipeline`（`pipeline_longcat_image_edit.py`）。PR body 与多处代码注释都显式标注了"mirrors diffusers ... reference"，关键对齐点包括：

- 输出分辨率按条件图面积（~1MP）反推，ceil 到 16 的倍数——**故意**与 `multimodal_gen.utils` 里共享的 `calculate_dimensions`（ceil 到 32）不同，单独实现 `_calculate_edit_dimensions`。
- 参考图用 argmax 采样做 VAE 编码，pack 后沿 seq 维拼在噪声 latent 之后，预测时把参考 token 的预测 slice 掉。
- RoPE position id：噪声 token 用 modality 1、参考 token 用 modality 2，两者都以**完整文本序列长度**为起点偏移。
- prompt 模板与 `prompt_template_encode_prefix/suffix` 逐字一致，`<|image_pad|>` 占位符按每图 token 数展开。

这种"逐行对齐 diffusers"的策略，让 SGLang 的输出能与 diffusers 参考实现做逐像素 parity 校验（review 中 BBuf 正是据此判断 T2I 的 padding mask 行为偏离了 diffusers 参考行为）。

## 实现

### Pipeline 的 7 阶段组合

`LongCatImageEditPipeline` 继承 `LoRAPipeline` + `ComposedPipelineBase`，在 `create_pipeline_stages` 里依次 add 7 个 Stage：

```python title="runtime/pipelines/longcat_image.py"
class LongCatImageEditPipeline(LoRAPipeline, ComposedPipelineBase):
    pipeline_name = "LongCatImageEditPipeline"

    _required_config_modules = [
        "text_encoder", "tokenizer", "text_processor",
        "vae", "transformer", "scheduler",
    ]

    def create_pipeline_stages(self, server_args: ServerArgs):
        # 1. 加载条件图，缩放到计算出的输出分辨率，设 batch.height/width
        self.add_stage(InputValidationStage())
        # 2. 联合 text+image (VL) prompt 编码；CFG 开时负 prompt 也对同一张图编码
        self.add_stage(LongCatImageEditTextEncodingStage(...))
        # 3. 参考图 VAE 编码 → packed batch.image_latent，
        #    DenoisingStage 把它拼在噪声 latent 之后（dim=1）
        self.add_stage(ImageVAEEncodingStage(vae=self.get_module("vae")))
        # 4. latent 准备（噪声用 prompt-embeds dtype 即 bf16）
        self.add_standard_latent_preparation_stage()
        # 5. 时间步准备（mu 只取 packed noisy token 计数）
        self.add_standard_timestep_preparation_stage(prepare_extra_kwargs=[_prepare_mu])
        # 6. 标准去噪循环；slice_noise_pred 每步丢弃参考 token 的预测
        self.add_standard_denoising_stage()
        # 7. 标准 VAE 解码
        self.add_standard_decoding_stage()
```

注释里的步骤编号就是上图 Stage 1–7。除了 Stage 2 是新增模型特定 Stage、Stage 3 是给 Edit 新启用标准 Stage 外，其余都是 T2I 已经验证过的标准链路。`pipeline_name = "LongCatImageEditPipeline"` 还让 `composed_pipeline_base` 的 residency 白名单放行它在分组路径上多保留 `vae` 组件：

```python title="runtime/pipelines_core/composed_pipeline_base.py"
"LongCatImageEditPipeline": {"vae"},
```

### 联合 VL prompt 编码：LongCatImageEditTextEncodingStage

这是本 PR 唯一新增的模型特定 Stage（256 行，`stages/model_specific_stages/longcat_image_edit.py`）。它替代了 T2I 的 `LongCatPromptRewriteStage`（自回归扩写）+ `TextEncodingStage`（纯文本编码）两段，改为一次性把"编辑指令 + 条件图"送进 Qwen2.5-VL 做联合编码。

核心是 prompt 模板的拼装。Edit 用的系统前缀把模型设定为"image editing expert"，并在用户段插入 `<|vision_start|><|image_pad|><|vision_end|>` 占位符：

```python title="stages/model_specific_stages/longcat_image_edit.py"
PROMPT_TEMPLATE_ENCODE_PREFIX = (
    "<|im_start|>system\nAs an image editing expert, first analyze the content and "
    "attributes of the input image(s). Then, based on the user's editing instructions, "
    "clearly and precisely determine how to modify the given image(s), ensuring that "
    "only the specified parts are altered and all other aspects remain consistent with "
    "the original(s).<|im_end|>\n<|im_start|>user\n"
    "<|vision_start|><|image_pad|><|vision_end|>"
)
PROMPT_TEMPLATE_ENCODE_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n"
```

`<|image_pad|>` 是单个占位符，真正的图片 token 数要靠 VL 处理器算出来再展开。Stage 先把条件图降采样 2× 喂给 `image_processor`（与 diffusers 的 `resize(h//2, w//2)` 一致），拿到 `image_grid_thw` 后按 `merge_size²` 算出每图 token 数，把占位符原地复制展开：

```python title="stages/model_specific_stages/longcat_image_edit.py"
merge_length = self.text_processor.image_processor.merge_size**2
num_image_tokens = int(image_grid_thw.prod().item()) // merge_length
text = PROMPT_TEMPLATE_ENCODE_PREFIX
while IMAGE_TOKEN in text:
    text = text.replace(IMAGE_TOKEN, "<|placeholder|>" * num_image_tokens, 1)
text = text.replace("<|placeholder|>", IMAGE_TOKEN)
prefix_ids = self.tokenizer(text, add_special_tokens=False)["input_ids"]
vision_start_id = self.tokenizer.convert_tokens_to_ids("<|vision_start|>")
prefix_len = prefix_ids.index(vision_start_id)   # DiT conditioning 的切片起点
```

`prefix_len` 是关键：它定位 `<|vision_start|>` 在前缀 token 序列里的下标。后面 Qwen2.5-VL 跑完前向，要从 `hidden_states` 里切出 `[vision_start ... vision_end, 512-token body]` 这一段作为 DiT 的 conditioning——即既包含 VL image token，又包含 512 token 的编辑指令 body：

```python title="stages/model_specific_stages/longcat_image_edit.py"
body = _tokenize_prompt_for_encode(prompt, self.tokenizer)   # 512 token body
suffix_ids = self._get_suffix_ids()
input_ids = torch.cat((prefix_ids_t, body.input_ids, suffix_ids_t), dim=-1).to(device)
attention_mask = torch.cat((prefix_mask_t, body.attention_mask, suffix_mask_t), dim=-1).to(device)
with set_forward_context(current_timestep=0, attn_metadata=None):
    outputs = self.text_encoder(input_ids=input_ids, attention_mask=attention_mask,
                                pixel_values=pixel_values, image_grid_thw=image_grid_thw,
                                output_hidden_states=True, use_cache=False)
hidden_states = outputs.hidden_states[-1]
# 保留 [vision_start ... vision_end, 512-token body]
return hidden_states[:, prefix_len:-suffix_len, :]
```

CFG 开启时，负 prompt 用**同一张条件图、同一套 prefix**再编码一次，正负两路 embeds 分别落进 `batch.prompt_embeds` / `batch.negative_prompt_embeds`。Stage 通过 `component_uses` 声明 `text_encoder` 为 `memory_intensive`，配合 `use_declared_component` 上下文管理器，让组件驻留管理器在 SP 场景下正确调度显存——这是支持 Ulysses SP 的前提。

### 条件图双路径与 [noisy | reference] 拼接

条件图在 Edit 里有两条独立路径，这是 I2I 与 T2I 最根本的数据流差异。第二条路径（参考隐空间）由标准的 `ImageVAEEncodingStage` 完成，但其 pack / 拼接 / 切片逻辑全在 `LongCatImageEditPipelineConfig` 的 hook 里：

```python title="configs/pipeline_configs/longcat_image.py"
def postprocess_image_latent(self, latent_condition, batch):
    if latent_condition.dim() == 5 and latent_condition.shape[2] == 1:
        latent_condition = latent_condition.squeeze(2)   # 去 frames 维 [B,C,1,H,W]→[B,C,H,W]
    batch_size = batch.batch_size
    # 单张参考图复制到 batch_size
    if batch_size > latent_condition.shape[0]:
        latent_condition = latent_condition.repeat(batch_size // latent_condition.shape[0], 1, 1, 1)
    _, num_channels_latents, height, width = latent_condition.shape
    return _pack_latents(latent_condition, batch_size, num_channels_latents, height, width)
```

pack 把 `[B, C, H, W]` 按 2×2 重排成 `[B, (H/2)(W/2), C*4]`，与噪声 latent 同形。随后 `DenoisingStage` 把它沿 seq 维（`dim=1`）拼在噪声 latent 之后，DiT 对拼接后的 `[noisy | reference]` 序列做 joint-attention。去噪完一步，`slice_noise_pred` 把参考 token 的预测整段丢掉，只保留噪声部分的预测送进 scheduler：

```python title="configs/pipeline_configs/longcat_image.py"
def slice_noise_pred(self, noise, latents):
    # 丢弃拼在后面的参考图 token 的预测
    return noise[:, : latents.size(1)]
```

下图标出了这条拼接机制与 RoPE 模态 id 的布局：

![Edit 隐空间序列布局](/vibe-reading/images/articles/sglang-pr-35829-longcat-image-edit/sequence-layout.svg)

上图沿 seq 维展开 DiT 每步的输入输出序列：输入是 `[text embeds (mod 0) | noisy latents (mod 1) | reference latents (mod 2)]`，三段共用一套 RoPE，但 image token（噪声与参考）都以完整文本长度 `N` 为起点偏移；参考与噪声 token 数相同（`S_noise = S_ref`），因为参考图被 resize 到了与输出同分辨率。DiT 预测出 `[noise_pred | ref_pred]` 后，`slice_noise_pred` 只保留前 `S_noise` 个噪声预测，`ref_pred` 整段丢弃——参考 token 只在 attention 里当锚点，不参与流匹配更新。

### RoPE position id：双模态与文本偏移

`_edit_img_ids` 负责给 `[noisy | reference]` 两段 packed token 各自生成 RoPE position id。两段网格形状相同（参考图与输出同分辨率），区别只在 modality id：

```python title="configs/pipeline_configs/longcat_image.py"
def _edit_img_ids(self, batch, num_token, device):
    vae_scale_factor = self.vae_config.get_vae_scale_factor()
    h = 2 * (int(batch.height) // (vae_scale_factor * 2))
    w = 2 * (int(batch.width) // (vae_scale_factor * 2))
    noisy_ids = _prepare_pos_ids(modality_id=1, token_type="image",
                                  start=(num_token, num_token), height=h // 2, width=w // 2)
    ref_ids = _prepare_pos_ids(modality_id=2, token_type="image",
                                start=(num_token, num_token), height=h // 2, width=w // 2)
    noisy_ids = self._maybe_shard_pos_ids_for_sp(batch, noisy_ids)
    ref_ids = self._maybe_shard_pos_ids_for_sp(batch, ref_ids)
    return torch.cat([noisy_ids, ref_ids], dim=0).to(device)
```

`num_token` 是 `batch.prompt_embeds[0].shape[1]`，即完整文本序列长度（VL image tokens + 512 body）。噪声与参考的 `start` 都设成 `(num_token, num_token)`——意思是 image token 的位置编号从文本序列末尾开始累计，避免与文本 RoPE 位置重叠。modality 1 / 2 的区分让 MMDiT 的 RoPE 能在同一个空间网格里分辨"这里是要去噪的"还是"这里是参考锚点"。

值得注意的是 `img_ids` 不在 latent 准备阶段一次性建好（T2I 那样），而是每步在 `prepare_pos_cond_kwargs` / `prepare_neg_cond_kwargs` 里重建——因为文本起点偏移 `num_token` 依赖 VL 编码后的实际 token 数，在 latent 准备时还未知：

```python title="configs/pipeline_configs/longcat_image.py"
def maybe_prepare_latent_ids(self, latents):
    # img_ids（noisy + reference）每步在 prepare_*_cond_kwargs 里建，
    # 因为文本起点偏移依赖 VL image token 数，latent 准备时未知
    return None
```

### SP 填充：重复最后一个 token 而非补零

Sequence Parallelism（SP）要求序列长度能被 `sp_world_size` 整除。Edit 分辨率约 1MP，`(h/2)(w/2)` 常常是奇数，SP 必须补齐。基类默认补零，但 Edit 不能用——补的零 token 会带上文本 token 0 的 RoPE 位置，污染 attention。Edit 改成**重复最后一个真实 token**来补齐：

```python title="configs/pipeline_configs/longcat_image.py"
def shard_latents_for_sp(self, batch, latents):
    # (h/2)*(w/2) 在 ~1MP 编辑分辨率下常为奇数，SP 必须补齐，
    # 且补的 pad 不加 mask（USPAttention 不接受与 replicated 文本前缀并存的 mask）。
    # 重复最后一个 token，而非基类的零（零会带文本 token 0 的 RoPE）。
    if latents.dim() == 3 and model_parallel_is_initialized():
        sp_world_size = get_sp_world_size()
        remainder = latents.shape[1] % sp_world_size
        if remainder:
            pad = latents[:, -1:].expand(-1, sp_world_size - remainder, -1)
            latents = torch.cat([latents, pad], dim=1)
    return super().shard_latents_for_sp(batch, latents)
```

RoPE position id 也走同一套分片逻辑（`_maybe_shard_pos_ids_for_sp`），保证 id 与 latent 分片完全对齐。去噪结束后，`post_denoising_loop` 还要把 SP gather 留下的尾部 pad token 截掉，再 unpack 回 `(h/2)(w/2)` 网格。

### DiT 改动：文本前缀不进 all-to-all

SP 的 all-to-all 通信要把序列在 rank 间重排。但文本 conditioning 是**每个 rank 都持有的复制前缀**，不该参与 all-to-all。PR 给 `LongCatImageSingleAttentionBlock.forward` 加了 `num_replicated_prefix` 参数，把文本前缀排除在 USPAttention 的 all-to-all 之外：

```python title="runtime/models/dits/longcat_image.py"
def forward(self, hidden_states, image_rotary_emb=None,
            num_replicated_prefix: int = 0, ...):
    ...
    x = self.attn(q, k, v, num_replicated_prefix=num_replicated_prefix)
```

联合 attention 块调用时传入 `num_replicated_prefix=text_seq_len`，让文本前缀留在本地、只对图像 token 做 SP 切分。

### 采样默认值与注册顺序

Edit 与 Edit-Turbo 的采样参数分别落在两个 dataclass：

```python title="configs/sample/longcat_image.py"
@dataclass
class LongCatImageEditSamplingParams(SamplingParams):
    # 输出分辨率由条件图推导（~1MP），不设默认 height/width
    # 参考实现用空负 prompt + plain CFG（无 renorm、无 prompt rewrite）
    num_frames: int = 1
    num_inference_steps: int = 50
    guidance_scale: float = 4.5
    negative_prompt: str = ""
    enable_cfg_renorm: bool = False
    enable_prompt_rewrite: bool = False

@dataclass
class LongCatImageEditTurboSamplingParams(LongCatImageEditSamplingParams):
    # 蒸馏版：8 步，CFG 关
    num_inference_steps: int = 8
    guidance_scale: float = 1.0
```

注册时有个细节：**Turbo 必须在 Edit 之前注册**，这样 `register_configs` 的 detector 优先匹配 Turbo。因为两个 detector 都要求 `longcat` + `edit`，Turbo 额外要求 `turbo`——若 Edit 先注册，`LongCat-Image-Edit-Turbo` 这个 id 会被 Edit 的 detector 抢先命中（它不含 "turbo not in" 的排除条件就出问题）：

```python title="registry.py"
# LongCat-Image-Edit-Turbo（先注册，detector 才能赢）
register_configs(
    sampling_param_cls=LongCatImageEditTurboSamplingParams,
    pipeline_config_cls=LongCatImageEditPipelineConfig,
    hf_model_paths=["meituan-longcat/LongCat-Image-Edit-Turbo"],
    model_detectors=[lambda hf_id: "longcat" in hf_id.lower()
                     and "edit" in hf_id.lower() and "turbo" in hf_id.lower()],
)
# LongCat-Image-Edit
register_configs(
    sampling_param_cls=LongCatImageEditSamplingParams,
    pipeline_config_cls=LongCatImageEditPipelineConfig,
    hf_model_paths=["meituan-longcat/LongCat-Image-Edit"],
    model_detectors=[lambda hf_id: "longcat" in hf_id.lower()
                     and "edit" in hf_id.lower() and "turbo" not in hf_id.lower()],
)
```

### 配置 hook 速查

`LongCatImageEditPipelineConfig` 继承 T2I 的 `LongCatImagePipelineConfig`，覆写 / 新增的 hook 汇总如下：

| hook | 作用 | 与 T2I 的差异 |
| --- | --- | --- |
| `calculate_condition_image_size` | 输出 ~1MP / ceil 16 | T2I 用共享 /32 helper |
| `get_latent_dtype` | 返回 prompt dtype（bf16） | T2I 用 float32 |
| `maybe_prepare_latent_ids` | 返回 None | T2I 此处建好 id |
| `preprocess_vae_encode` | squeeze frames 维 | T2I 无此步 |
| `postprocess_image_latent` | pack + 复制参考图 | T2I 无参考图 |
| `shard_latents_for_sp` | 重复最后 token 补齐 | T2I 补零 |
| `_edit_img_ids` | mod 1/2 双模态 id | T2I 单模态 |
| `prepare_pos/neg_cond_kwargs` | 每步建 txt_ids + img_ids | T2I 一次建好 |
| `slice_noise_pred` | 丢弃参考 token 预测 | T2I 不切片 |
| `post_denoising_loop` | 截掉 SP pad | T2I 不需要 |
| `expand_conditioning_to_sample_batch` | num_outputs>1 时复制 embeds | **本 PR 新增给 T2I 基类共享** |

## 测试

### 单元测试

新增 `test_longcat_image_edit_config.py`（157 行，纯 CPU 的 config hook 测试），覆盖：

- `test_edit_dimensions_match_diffusers_formula`：对 4 组宽高比验证 `_calculate_edit_dimensions` 与 diffusers 公式逐一致，且结果都是 16 的倍数。
- `test_edit_config_task_type_and_generator`：断言 `task_type == I2I`、`generator_device == "cpu"`。
- `test_slice_noise_pred_drops_reference_tokens`：噪声 shape `(1,200,64)`、latent `(1,100,64)`，切片后应为 `(1,100,64)` 且等于 `noise[:, :100]`。
- `test_postprocess_image_latent_packs_2x2`：`(1,16,8,8)` latent → pack 成 `(1,16,64)`。
- `test_edit_img_ids_modalities_and_offset`：1024×1024 输出下，`img_ids` 形状 `(2*64*64, 3)`，噪声段 modality 全 1、参考段全 2，两段空间坐标一致且以 `num_token` 为起点。
- `test_expand_conditioning_repeats_embeds_for_num_outputs`：单 prompt + `num_outputs_per_prompt=2`，展开后 embeds 形状 `(2,850,3584)` 且两路相同（非垃圾值）。
- `test_expand_conditioning_noop_for_single_output`：`num_outputs=1` 时 embeds 引用不变（no-op）。
- `test_t2i_config_unchanged`：回归 T2I 配置未被破坏——`task_type == T2I`、`slice_noise_pred` 不切片、`maybe_prepare_latent_ids` 仍返回非 None。

同时更新 `test_qwen2_5vl_generation.py`：原 `test_explicit_attention_mask_is_limited_to_cached_generation` 改名为 `test_explicit_attention_mask_is_honored_without_a_cache`，并断言两种 flag 状态——LongCat（`honor_cache_free_padding_mask=True`）在无 cache 路径也传 mask；其它 pipeline（`False`）保持原行为（无 cache 时丢弃 mask）。

## Review

review 由 BBuf（也是最终 merge 人）完成，提出三个关键意见，作者全部接受并修复：

1. **`num_outputs_per_prompt > 1` 批次不匹配**：BBuf 指出 `prompt_embeds` 在文本编码阶段固定 batch 1，而图像 / 噪声 latent 按 `prompts * num_outputs` 构建，DiT 的 `cat([encoder, hidden], dim=1)` 会撞 batch 维度。要求重复正负 embeds 并加 `n=2` 测试。作者随后提交 commit `19ba110` 修复（见「问题」节）。
2. **cache-free mask 改变了 T2I 输出**：BBuf 指出 mask 改动也影响现有 LongCat T2I（`longcat_postprocess_text` 保留全部 512 body token 含 padding），PR 描述里"T2I 行为不变"的声明不成立，要求做 diffusers parity 校验并更新描述。作者承认声明有误，并澄清：T2I 本就喂了 padded body，加 mask 是**向 diffusers 参考行为对齐的修正**（diffusers 的 `_encode_prompt` 确实把 attention_mask 传给文本编码器），不是回归。
3. **把 mask 改动限定到 LongCat**：BBuf 指出共享 Qwen2.5-VL 编码器上挂的 cache-free padding mask 会让带 padding 的 Qwen-Image 请求也拿到非 None mask，把 LocalAttention 切到 PyTorch SDPA 路径，改变 Qwen-Image 跨后端输出；不应在这个 PR 里动 Qwen-Image 的 ground truth。作者在 commit `d49ce44` 用 `honor_cache_free_padding_mask` flag 把 mask 限定到 LongCat（T2I + Edit），其它 pipeline 维持原 fast path（见「问题」节）。

BBuf 最终 LGTM 通过。

## 问题

PR 在实现 Edit 的过程中，暴露并修复了三处 `multimodal_gen` 框架本身潜藏的缺陷。这三处都不是 Edit 独有，只是 Edit 的新场景才触发。

### 缺陷 1：num_outputs>1 的 conditioning 批次不匹配

`LongCatImagePipelineConfig` 此前从未覆写 `expand_conditioning_to_sample_batch`。在 `--num-outputs-per-prompt N`（单请求多输出，`batch_size = prompts * num_outputs`）路径上，文本 embeds 停在 batch 1，而噪声 / 参考 latent 按 batch N 构建，joint-attention 的 `cat([encoder, hidden], dim=1)` 直接 batch 维不匹配。修复方式是仿照 `QwenImagePipelineConfig` 引入 `PromptToSampleBatchExpander`，把正负 embeds、masks、seq_lens 重复到 batch N（`n=1` 时 no-op）。这段逻辑加在 **T2I 基类**上，因此 T2I 与 Edit 同时受益：

```python title="configs/pipeline_configs/longcat_image.py"
def expand_conditioning_to_sample_batch(self, batch):
    # 噪声/参考 latent 按 batch_size = prompts * num_outputs 构建，文本编码却按 prompt，
    # 把 embeds 重复到匹配。num_outputs==1 时 no-op。T2I 与 Edit 共用。
    expander = PromptToSampleBatchExpander.from_batch(batch)
    if expander is None:
        return batch
    for field_name in ("prompt_embeds", "negative_prompt_embeds",
                       "prompt_embeds_mask", "negative_prompt_embeds_mask",
                       "prompt_seq_lens", "negative_prompt_seq_lens"):
        expander.expand_field(batch, field_name)
    return batch
```

### 缺陷 2：分组路径未设组件驻留管理器

`forward_batch`（分组 n>1 的执行路径）在调用 `execute_group_with_profiling` 前从未设置 `component_residency_manager`，而 `forward` 和 `forward_batch_sequentially` 都设了。结果分组 n>1 路径对所有 pipeline（不止 LongCat）都崩在 `'NoneType' has no begin_request`。修复就是补上同样的两行：

```python title="runtime/pipelines_core/composed_pipeline_base.py"
self.component_residency_manager = get_global_component_residency_manager(
    self, server_args
)
self.executor.component_residency_manager = self.component_residency_manager
return self.executor.execute_group_with_profiling(self.stages, batches, server_args)
```

### 缺陷 3：Qwen2.5-VL cache-free padding mask 未限定作用域

为了让 LongCat 在 cache-free（扩散文本编码不走 KV cache）路径上也能 mask 掉 padding body，作者在共享的 Qwen2.5-VL 编码器里加了 padding mask。但这会波及所有用 Qwen2.5-VL 的 pipeline——带 padding 的 Qwen-Image 请求会拿到非 None mask，把 `LocalAttention` 从专用 kernel 切到 PyTorch SDPA 路径，跨后端改变 Qwen-Image 输出。修复是引入 `honor_cache_free_padding_mask` flag，由 `TextEncoderLoader` **只对 LongCat**（T2I + Edit）置真，其余 pipeline 维持 `attn_mask = attention_mask if use_cache else None` 的原 fast path：

```python title="runtime/loader/component_loaders/text_encoder_loader.py"
model_config.honor_cache_free_padding_mask = isinstance(
    server_args.pipeline_config, LongCatImagePipelineConfig
)
```

Qwen2.5-VL 侧在 cache-free 路径上按 flag 决定是否传 mask，并在 `create_causal_mask` 返回 None 时用新增的 `_build_causal_padding_mask` 兜底构建因果+padding bool mask：

```python title="runtime/models/encoders/qwen2_5vl.py"
honor_mask = use_cache or self.honor_cache_free_padding_mask
attn_output = self.attn(query_states, key_states, value_states,
                        attn_mask=attention_mask if honor_mask else None)
```

作者验证 LongCat sp1/sp8 输出与限定作用域前字节一致；单元测试同时断言两种 flag 状态。

## 意义与影响

本 PR 让 SGLang 的 LongCat-Image 家族从"只能文生图"扩展到"能做图像编辑"，补齐了 I2I 这块。结合此前已接入的 T2I（#23274）与 AudioDiT（#22191），LongCat 的多模态生成能力在 SGLang 里已具规模。

工程上的价值不止于多支持一个模型：

- **框架扩展范式验证**：Edit 用"继承 T2I 配置 + 覆写 hook + 加一个模型特定 Stage"就拼出了与 T2I 数据流截然不同的 I2I pipeline，标准去噪 / 解码链路零改动复用。这证明 `multimodal_gen` 的组合式 Stage + PipelineConfig hook 抽象确实能容纳差异很大的任务族。
- **顺带修复框架缺陷**：三处缺陷（conditioning 批次展开、分组路径驻留管理器、mask 作用域）都不是 Edit 独有，只是此前未触发。本 PR 一并修掉，T2I 与其它 pipeline 同步受益。
- **SP 上的 I2I 可用性**：参考隐空间拼接让序列变长，PR 用"重复最后 token 补齐 + 文本前缀不进 all-to-all"保证了 SP（含 8 卡 Ulysses）下 Edit 仍可跑，且输出与 sp1 一致。

PR body 自述当前重点是正确性，未做性能测试（蒸馏版 Turbo 仅 8 步、关 CFG，是为低延迟场景预备）。用法示例已覆盖 sp1 与 sp8 两种配置。

## TODO

- [ ] 性能 benchmark：PR body 明确"当前引入新模型，无需性能测试，重点是正确性"。Turbo 版（8 步 / CFG off）的低延迟特性有待后续量化。
- [ ] diffusers 逐像素 parity 校验：review 中 BBuf 要求的 LongCat T2I / Edit 与 diffusers 参考实现的逐像素输出对比，目前以代码逻辑对齐为准，缺自动化 parity 比对。

## 参考

- diffusers `LongCatImageEditPipeline` 参考实现（`pipeline_longcat_image_edit.py`）：本 PR 的 `_calculate_edit_dimensions` / prompt 模板 / `[noisy|reference]` 拼接与 slice 逻辑均逐行对齐此参考。
- [meituan-longcat/LongCat-Image-Edit](https://huggingface.co/meituan-longcat/LongCat-Image-Edit) 与 [LongCat-Image-Edit-Turbo](https://huggingface.co/meituan-longcat/LongCat-Image-Edit-Turbo)（Hugging Face 模型卡）。

## 相关阅读

- [在 SGLang 中接入 LongCat-Image：一个文生图 DiT 模型的全栈适配](/vibe-reading/articles/sglang-pr-23274-support-longcat-image) — **前序·同模型 T2I**·本篇 I2I 直接建立在 T2I 的 `LongCatImagePipelineConfig` 与组合式 pipeline 框架之上，先读此篇可快速理解本文复用的标准 Stage 与 hook 机制。
- [SGLang PR #22191：接入 LongCat-AudioDiT](/vibe-reading/articles/sglang-pr-22191-support-longcat-audiodit) — **同设计落地线**·同属 LongCat 系列接入 `multimodal_gen`，对照可见框架如何同时容纳图像（多组件 VAE + VL 编码器）与音频（单 PreTrainedModel）两类模型组织方式。
- [xLLM PR #957：LongCat-Image-Edit CUDA 算子](/vibe-reading/articles/xllm-pr-957-longcat-image-edit-cuda) — **同模型另一框架**·LongCat-Image-Edit 在 xLLM 推理框架一侧的 CUDA 算子落地，与本篇 SGLang 侧的 pipeline 接入对照可见同一模型在两套推理框架里的差异化适配路径。
- [LongCat-Image 技术报告](/vibe-reading/articles/longcat-image-technical-report) — **对应论文**·LongCat-Image 模型本身的设计（MMDiT 架构、Flow Matching、Qwen2.5-VL 编码），本篇的 DiT 与 RoPE 设计均源于此。
