---
source:
  type: "源码解读"
  project: "Relax"
  url: "https://github.com/redai-infra/Relax"
title: "模型集成"
date: "2026-08-18T17:52:22+08:00"
category: [AI, Infra, Training, Relax, CodeWiki, "0.1.0"]
tags: ["Relax", "Qwen3-Omni", "Dots-OCR", "GLM-MoE-DSA", "Megatron Bridge", "全模态"]
description: "解读 Relax 模型集成层：Qwen3-Omni 全模态模型、GLM-MoE-DSA 融合注意力、Dots-OCR 双侧适配，以及 Megatron Bridge 桥接模式与 HF↔Megatron 权重转换。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/Relax/CodeWiki/0.1.0/00-overview)

---

## 模块定位

`relax/models/`（4,551 行）是横跨后端层的模型集成模块，为特定模型族（Qwen3-Omni 全模态、Dots-OCR、GLM-MoE-DSA）提供 Megatron 训练侧与 SGLang 推理侧的模型定义与 bridge。它独立成层而非写死在 backends，因为三模型族架构差异巨大（全模态 MRoPE+MoE / MLA+DSA 稀疏注意力 / 双模态 RoPE），无法统一抽象；且双侧复用（Dots-OCR 的 `DotsVisionTransformer` 被 Megatron 与 SGLang 同时使用）；注册隔离（一个模型族导入失败不应阻塞其他）。全模态（text+vision+audio）是 Relax 的旗舰特性，Qwen3-Omni 适配是该模块的核心。

## 模块架构

三模型族各自独立目录，通过 `relax/models/__init__.py` 分层 try/except 注册。Megatron 侧统一走 Bridge-Provider 模式（`MegatronModelBridge` 装饰器注册 + `GPTModelProvider` 提供 layer spec），SGLang 侧通过 `EntryClass` 列表注册外部模型包。`__init__.py` 优先尝试上游 `megatron.bridge.models` 导入，失败回退到 Relax 本地实现——设计使上游集成后可减少自身维护。

```
models/
├── __init__.py              分层 try/except 注册（优先上游 bridge，回退本地）
├── qwen_omni/               全模态旗舰（text+vision+audio）
│   ├── modeling_qwen3_omni/
│   │   ├── model.py (411)   Qwen3OmniMoeModel（MegatronModule，独立组合三子模型）
│   │   ├── utils.py (356)   get_rope_index（3D MRoPE，6 种模态组合）
│   │   └── rope.py          Qwen3OmniMoeThinkerTextRotaryEmbedding
│   ├── qwen3_omni_bridge.py  Qwen3OmniMoEBridge（HF↔Megatron 映射）
│   └── qwen3_omni_provider.py  Qwen3OmniModelProvider
├── glm_moe_dsa/             GLM-MoE DSA 注意力
│   ├── dsa_attention.py (682)  DSAMultiLatentAttention / DSAMLASelfAttention
│   ├── glm5_bridge.py (304)    GLM5Bridge
│   ├── glm5_provider.py        MLAModelProvider
│   └── ops/                    tilelang sparse_mla / indexer kernels
└── dots_ocr/               Dots-OCR（双侧适配）
    ├── vision.py (296)     DotsVisionTransformer（纯 PyTorch，双侧复用）
    ├── megatron/           DotsOCRModel + DotsOCRBridge + DotsOCRModelProvider
    └── sglang/             DotsOCRForCausalLM + DotsOCRImageProcessor（EntryClass）
```

## 调用链路

Megatron 训练侧 Bridge→Provider→Model 调用链（以 GLM-5 为例）：

```
backends/megatron/__init__.py:15  import relax.models    # 触发 @MegatronModelBridge.register_bridge
backends/megatron/model_provider.py: get_model_provider_func()
  → AutoBridge.from_hf_pretrained(args.hf_checkpoint)    # 加载 HF 模型
  → bridge.to_megatron_provider()                         # Bridge.provider_bridge()
      → GLM5Bridge.provider_bridge()                      # 设 layer_spec = get_glm5_dsa_spec
      → 返回 MLAModelProvider
  → provider.provide(pre_process, post_process)           # Provider.provide()
      → 构建模型实例（GPTModel with DSA spec）

=== SGLang 推理侧（Dots-OCR）===
--sglang-external-model-package relax.models.dots_ocr.sglang
  → SGLang 扫描 EntryClass = [DotsOCRForCausalLM]          # sglang/model.py:143
  → 扫描 BaseMultimodalProcessor 子类 DotsOCRImageProcessor
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Qwen3OmniMoeModel.forward` | 全模态前向 | vision/audio 编码→mask 注入→MRoPE position→language_model |
| `get_rope_index` | 3D MRoPE 位置编码 | 处理 6 种模态组合（纯文/图/视频/音频/Audio-in-Video） |
| `DSAMLASelfAttention.get_absorb_query_key_value_tensors` | 产两套 QKV | core attention + sparse indexer，absorbed MLA 减 KV cache |
| `get_glm5_dsa_spec` | 组装 DSA layer spec | 绕过 Megatron Core CP=1 断言 |
| `DotsVisionTransformer.forward` | 视觉编码 | flash_attn 延迟导入避 SGLang fork 死锁 |
| `Bridge.provider_bridge` | HF config→Megatron Provider | 翻译参数与 layer_spec |
| `Bridge.mapping_registry` | HF↔Megatron 权重名映射 | 如 q_proj/k_proj/v_proj→linear_qkv |
| `DotsOCRForCausalLM.forward` | SGLang 推理前向 | 复用 SGLang Qwen2Model + general_mm_embed_routine |

</details>

## 核心实现

### Qwen3-Omni：全模态旗舰

`Qwen3OmniMoeModel`（`qwen_omni/modeling_qwen3_omni/model.py`，`MegatronModule`）独立组合三子模型——`audio_model`（HF `Qwen3OmniMoeAudioEncoderHF`）、`vision_model`（HF `Qwen3OmniMoeVisionEncoderHF`）、`language_model`（自定义 `Qwen3OmniGPTModel`）。注释明确 "standalone implementation that does not inherit from other models to maintain independence from version-specific implementations"。vision/audio encoder 直接复用 HF 实现，但通过 `hook_hf_module_setattr_for_tp_grad_sync` 钩子让 HF 模块在 Megatron TP 框架下正确同步梯度。

`forward`（`model.py:151-411`）三步：(1) Vision 编码（`pixel_values`+`image_grid_thw` → `vision_embeds`，通过 `image_mask`/`video_mask` 定位占位 token 替换）；(2) Audio 编码（`input_features`+`feature_attention_mask` → `audio_embeds`，`audio_mask` 替换）；(3) 组合嵌入 → `get_rope_index` 算 3D MRoPE position_ids → `language_model`。关键：position_ids 在模型内计算（`model.py:202` `position_ids = None` 注释），因多模态 MRoPE 需按 image/video/audio token 位置交错计算 3D 位置，无法在 dataset 层完成。`get_rope_index`（`utils.py:57-356`）处理 6 种模态组合，Audio-in-Video 需逐 token 比较 video/audio 时间戳交错排列。训练侧 `assert inference_params is None`（`:193`）明确不支持推理，推理走 SGLang 侧——避免 Megatron 侧维护 KV cache。

### GLM-MoE-DSA：MLA + DSA 融合注意力

`DSAMLASelfAttention`（`glm_moe_dsa/dsa_attention.py`，继承 `DSAMultiLatentAttention`）将 MLA（Multi-Latent Attention）与 DSA（Dynamic Sparse Attention）融合。`get_absorb_query_key_value_tensors`（`:412`）同时产两套 QKV：core attention（`query,key,wv`）与 sparse indexer（`index_query,index_key,head_weights`）。indexer 通过 `lighting_indexer` 选 top-k key 索引，`SparseMLA.apply` 只计算稀疏注意力，避免 O(n²) 全注意力矩阵物化。

四项关键优化（文件头注释）：(1) **CP support**——`scatter_to_sequence_parallel_region`/`gather_from` 在 CP 维 scatter/gather，原生 Megatron Core DSAttention 不支持 CP>1；(2) **Fused SparseMLA kernel（tilelang）**——`torch.autograd.Function`，forward 调 tilelang kernel，不物化 O(n²) 矩阵；(3) **Fused indexer kernel**——`IndexerFunction` 计算 query-key scores 并 top-k；(4) **Absorbed MLA**——KV up-projection 吸收到 query（`q_no_pe = einsum("thd,hdm->thm", q_no_pe, w_kc)`，`:475`）减 KV cache 内存。`GLM5Bridge`（`glm5_bridge.py:96`）故意不设 `experimental_attention_variant = "dsa"`，因 Megatron Core 原生 DSA 路径有 CP=1 断言——Relax fused `DSAMLASelfAttention` 通过自己的 tilelang kernel 直接支持 CP>1。

### Dots-OCR：双侧适配

Dots-OCR 是唯一同时适配 Megatron 与 SGLang 的模型族。Megatron 侧 `DotsOCRModel`（`megatron/model.py`，`MegatronModule`）只有 vision+language（无 audio），position embedding 用 `rope`（非 MRoPE），支持 CP `unsplit_mode`。SGLang 侧 `DotsOCRForCausalLM`（`sglang/model.py`，`nn.Module`）复用 SGLang `Qwen2Model` 作 language backbone，但 vision tower 直接实例化 Relax 自己的 `DotsVisionTransformer`，`forward` 通过 SGLang `general_mm_embed_routine` 编排多模态注入，`EntryClass = [DotsOCRForCausalLM]` 是 SGLang 外部模型注册约定。

两侧共享 `DotsVisionTransformer`（`vision.py`，`PreTrainedModel` 子类）与 `DotsVisionConfig`——视觉编码器是纯 PyTorch 实现，不依赖 Megatron/SGLang 任何框架，因此双侧复用。`DotsVisionTransformer` 的 `_flash_attn_varlen_func`（`:19`）用**延迟导入**而非顶层，因顶层导入 flash_attn 会 eager 初始化 CUDA，导致 SGLang HTTP server 子进程在 `SGLangBaseProcessor` 的 `ProcessPoolExecutor` 内 fork CUDA-tainted 子进程死锁启动。`DotsOCRImageProcessor`（`sglang/processor.py`）用 dots 原生 `<|img|><|imgpad|><|endofimg|>` token 三重而非 Qwen-VL 的，因继承 `QwenVLImageProcessor` 会注入错误 token 并访问 dots.mocr 不存在字段。

### Bridge 模式与权重转换

三 Bridge 类继承 `MegatronModelBridge`，`@MegatronModelBridge.register_bridge` 装饰器注册：`GLM5Bridge`（`source=GlmMoeDsaForCausalLM, target=GPTModel, provider=MLAModelProvider`）、`Qwen3OmniMoEBridge`（`source=Qwen3OmniMoeForConditionalGeneration, target=Qwen3OmniMoeModel`）、`DotsOCRBridge`（`source="DotsOCRForCausalLM", target=DotsOCRModel`）。每 Bridge 实现两核心方法：`provider_bridge(hf_pretrained)`（HF config→Megatron Provider 参数）与 `mapping_registry()`（HF↔Megatron 权重名映射，如 HF `q_proj/k_proj/v_proj` 合并为 Megatron `linear_qkv.weight`）。Bridge 使同一份 HF checkpoint 无缝加载到 Megatron，训练后反向导出为 HF（`backends/megatron/model.py:save_hf_model` 经 `AutoBridge.save_hf_pretrained`）。`GLM5Bridge` 的 spec 替换是适配器实例：不修改 Megatron Core GPTModel，在 Provider 层替换 attention layer spec。

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
| --- | --- | --- |
| 桥接 | `MegatronModelBridge` + `@register_bridge` in 三 bridge 文件 | HF↔Megatron 参数命名/布局/分片互转，同 checkpoint 跨框架 |
| 适配器（双侧） | Dots-OCR Megatron 侧 `DotsOCRModel` + SGLang 侧 `DotsOCRForCausalLM` | 共享纯 PyTorch `DotsVisionTransformer`，两侧各自适配框架 |
| 注册隔离 | `models/__init__.py` 分层 try/except | 一模型族导入失败不阻塞其他，优先上游 bridge 回退本地 |
| spec 替换 | `GLM5Bridge` 设 `provider.transformer_layer_spec = get_glm5_dsa_spec` | 不改 Megatron Core，在 Provider 层注入 fused DSA attention |

## 模块间交互

models 被 `backends/megatron`（`model_provider.py:207` `AutoBridge.from_hf_pretrained` 自动选 bridge；`__init__.py:15` `import relax.models` 触发注册）与 `backends/sglang`（`--sglang-external-model-package` 指向 sglang 子包）调用。依赖 `utils/multimodal`（通用多模态数据处理；模型特定逻辑如 `get_rope_index` 在模型层，通用加载/预处理在 utils）。`backends/megatron/model.py` 的 `forward_step`（`:742`/`:990`）处理 VL 模型特殊路径（`is_vl_model` + `multimodal_train_inputs` + `unsplit_tokens` + bridge 内部 CP/SP 切分 + 动态 CP `pg_collection.cp` 替换）。详见概览「模块地图」。

## 扩展方式

- **接入新模型族**：新建 `models/{family}/megatron/`（`model.py` 定义 `MegatronModule` + `bridge.py` 定义 `MegatronModelBridge` 子类 + `provider.py` 定义 Provider）；`models/__init__.py` 加 `try: from relax.models.{family} import megatron`；需 SGLang 推理则新建 `{family}/sglang/model.py` 设 `EntryClass` + `processor.py`。关键：Bridge 的 `mapping_registry()` 需精确映射每权重名（参考 `glm5_bridge.py:108-304` 150+ 行映射）
- **为 Qwen3-Omni 新增模态**：`model.py` `Qwen3OmniMoeModel.__init__` 加 `tactile_model` 实例化 + `forward` 加编码段与 mask 替换；`utils.py` `get_rope_index` 加模态处理；`provider.py` 加 config 字段；`bridge.py` `mapping_registry` 加 `ReplicatedMapping`
- **替换 DSA kernel**：`ops/sparse_mla.py` `SparseMLA.forward/backward` 替换 `sparse_mla_fwd_interface` 调用；`ops/indexer.py` `IndexerFunction` 替换；新建 tilelang kernel interface。无需改 bridge/provider——kernel 对 Bridge/Provider 透明
