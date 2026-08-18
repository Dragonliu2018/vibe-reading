---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "多模态处理"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, Training, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "ProcessorMixin", "多模态", "图像处理", "占位符展开"]
description: "ProcessorMixin 组合 tokenizer + image_processor 成单一对象，统一加载与调用。__call__ 分模态处理后用占位符替换把多模态输入合并成 model forward 的张量字典。本文解读组合设计与 _merge_kwargs 四级优先级。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

多模态处理模块为 LLaVA、Qwen-VL、CLIP 等多模态模型提供统一的预处理器。`ProcessorMixin` **组合**（而非继承）tokenizer + image_processor + video_processor 成单一对象，让用户一行 `AutoProcessor.from_pretrained()` 就能加载全部子预处理器，并通过 `__call__` 把图像/视频/音频/文本一次性转成 model forward 接受的张量字典。它独立成模块，是因为多模态输入需要"占位符展开"这种跨模态协调——text 中的 `<image>` 占位符要根据 image 处理结果展开成对应数量的 token，分开调用无法协调。

边界：处理只管"原始模态→model 输入张量"，不管模型怎么前向（建模核心），也复用 tokenizer（分词框架）与 image_transforms（纯函数）。

## 模块架构

- **ProcessorMixin 基类**：`processing_utils.py:597`，继承 `PushToHubMixin`。子处理器属性（`tokenizer`/`image_processor`/`video_processor`/`feature_extractor`）通过 `get_attributes()`（L1735）反射 `__init__` 签名动态推断。关键方法 `__call__`（L652）、`from_pretrained`（L1683）、`save_pretrained`（L1107）、`_merge_kwargs`（L1508）、`apply_chat_template`（L1976）、`post_process_image_text_to_text`（L2316）。
- **图像处理两层**：`ImageProcessingMixin`（`image_processing_base.py:61`，from_pretrained/save_pretrained）→ `BaseImageProcessor`（`image_processing_utils.py:60`，定义 `preprocess` 模板方法骨架）→ backend 子类 `TorchvisionBackend`（`image_processing_backends.py:86`，GPU/torch.Tensor）/`PilBackend`（L416，CPU/np.ndarray）。
- **变换纯函数**：`image_transforms.py`，无状态函数 `resize`/`normalize`/`center_crop`/`rescale`/`pad`，被 backend 在 `_preprocess` 中调用。
- **AutoProcessor 注册表**：`PROCESSOR_MAPPING_NAMES`（`auto_mappings.py:1024`）经 `_LazyAutoProcessorMapping` 包装成 `AutoProcessor`。

## 调用链路

`ProcessorMixin.__call__` 的多模态分发：

```
__call__(images, text, videos, audio, **kwargs)        processing_utils.py:652
├── prepare_inputs_layout()                              # L712：远程图/音频 fetch，文本包装成 list
├── validate_inputs()
├── _merge_kwargs(**kwargs)                             # L1508：按模态分离 kwargs → 4 个子 dict
│   └── 优先级: call-time flat > modality-specific > init-time > _defaults
├── 分模态处理:
│   ├── images → _process_images → image_processor(images) → {pixel_values}  # 含占位符替换
│   ├── videos → _process_videos → video_processor(videos) → {pixel_values_videos}
│   └── audio → _process_audio → {input_features}
├── 文本处理:
│   ├── get_text_with_replacements(text, image_replacements, ...)  # L815：<image> 占位符展开
│   ├── tokenizer(text, **text_kwargs) → {input_ids, attention_mask}
│   └── _check_special_mm_tokens()                      # 校验 token 数与 patch 数一致
└── 合并 → 过滤 unused_input_names → BatchFeature(data, tensor_type=return_tensors)
```

数据流：`image → pixel_values`；`text → input_ids + attention_mask`；`video → pixel_values_videos`；`audio → input_features`。占位符替换让 text 的 `<image>` 展开为与图像 patch 数对应的 token 序列。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `__call__` in `processing_utils.py:652` | 多模态统一入口 | 分模态处理 + 占位符替换合并 |
| `_merge_kwargs` in `processing_utils.py:1508` | 按模态分离 kwargs | 四级优先级合并，解决同名参数冲突 |
| `from_pretrained` in `processing_utils.py:1683` | 加载全部子处理器 | `_get_arguments_from_pretrained` 自动加载 |
| `get_attributes` in `processing_utils.py:1735` | 反射推断子处理器 | 避免显式声明，支持向后兼容 |
| `preprocess` in `image_processing_utils.py:383` | 图像预处理骨架 | 模板方法，backend 实现 `_preprocess` |

</details>

## 核心实现

### 为何组合 tokenizer + image_processor 成单一对象

动机有二：**统一加载/保存** + **多模态占位符替换**。`from_pretrained`（L1683）通过 `_get_arguments_from_pretrained`（L1815）自动加载所有子处理器（tokenizer 从 `tokenizer_config.json`，image_processor 从 `preprocessor_config.json`），`save_pretrained` 统一保存全部。更关键的是 `__call__` 中 image 处理与 text 处理有依赖——text 的 `<image>` 占位符需根据 image 处理结果（pixel_values 尺寸）展开成正确数量的 token（LlavaProcessor.replace_image_token 据 `height // patch_size` 计算），分开调用用户要手动协调。`_merge_kwargs`（L1508）把扁平 kwargs 按模态自动分发给对应子处理器，用户无需关心 `padding` 该给 tokenizer 还是 `do_resize` 该给 image_processor。

### image_processor 与 image_transforms 分工

`image_transforms.py` 提供无状态纯函数（`resize`/`normalize`/`center_crop`/`rescale`/`pad`），只接受 ndarray+参数不持有状态。`BaseImageProcessor`/backend 持有配置属性（`do_resize`/`size`/`image_mean`/`image_std`/`rescale_factor`），在 `preprocess`（L383）模板方法中编排：设默认值 → 标准化 kwargs（`size`→`SizeDict`）→ 验证 → 调 `_preprocess`。`TorchvisionBackend._preprocess`（L367）用 `torchvision.transforms.v2.functional` 操作 `torch.Tensor`（GPU 加速，按 shape 分组批量）；`PilBackend._preprocess`（L619）用 image_transforms 的 PIL/NumPy 函数操作 `np.ndarray`（CPU 逐张）。两者调用同样的逻辑序列（resize→crop→rescale→normalize→pad）但不同后端实现，变换逻辑可复用。

### TypedDict kwargs 系统

`ProcessingKwargs`（L433）把所有模态 kwargs 组织成分层 TypedDict（`text_kwargs`/`images_kwargs`/`videos_kwargs`/`audio_kwargs`），子类可继承加模型特定参数与 `_defaults`。`_merge_kwargs` 按四级优先级合并：call-time flat kwargs > modality-specific dicts > init-time kwargs > class `_defaults`，解决多模态处理中不同模态可能有同名参数（如 `return_tensors`）的冲突。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 组合优于继承 | `ProcessorMixin` 持有子处理器（L617 setattr） | 多模态统一前端，避免深继承树 |
| 模板方法 | `BaseImageProcessor.preprocess`（L383） | 固定骨架，backend 实现 `_preprocess` |
| Backend 策略 | `TorchvisionBackend`/`PilBackend` | GPU vs CPU 便携两种实现 |
| 注册表 | `_LazyAutoProcessorMapping` + `PROCESSOR_MAPPING_NAMES` | 数百 processor 按需 import，延迟导入避免循环依赖 |
| Mixin | `ProcessorMixin` + 各 model 子类（如 `LlavaProcessor`） | 子类声明子处理器参数即组合 |

## 模块间交互

`ProcessorMixin` 被 modeling（多模态 model 经 `AutoProcessor.from_pretrained` 获取）和 pipelines（`ImageTextToTextPipeline.preprocess` 调 `self.processor`，`postprocess` 调 `post_process_image_text_to_text`）消费。`model_input_names` property（L1953）聚合所有子处理器的 `model_input_names`（tokenizer 返回 `input_ids`/`attention_mask`，image_processor 返回 `pixel_values`）供 model forward。`MODALITY_TO_BASE_CLASS_MAPPING`（L128）把 "tokenizer" 模态映射到 `PreTrainedTokenizerBase`，`check_argument_for_proper_class`（L994）验证子处理器类型。当 `processor` 非空且其他组件为 None 时，Pipeline 自动拆解 `self.tokenizer = getattr(self.processor, "tokenizer", None)`（base:937）。

## 扩展方式

新增输入模态（如 depth）：在 `processing_utils.py` 定义 `DepthKwargs(TypedDict)` 加入 `ProcessingKwargs` 作为 `depth_kwargs`，在 `MODALITY_TO_AUTOPROCESSOR_MAPPING`/`MODALITY_TO_BASE_CLASS_MAPPING` 加条目，在 `__call__`（L671-678）加分支调 `_process_depth`，实现 `replace_depth_token`。注册新 processor：`AutoProcessor.register(MyModelConfig, MyModelProcessor)` + 在 `auto_mappings.py:1024` 的 `PROCESSOR_MAPPING_NAMES` 加条目。自定义图像预处理：继承 backend 覆写 `_preprocess`（参考 `image_processing_backends.py:367`），设 `valid_kwargs = MyImageProcessorKwargs` 加自定义参数。
