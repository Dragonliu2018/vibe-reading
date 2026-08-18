---
source:
  type: "源码解读"
  project: "transformers"
  url: "https://github.com/huggingface/transformers"
title: "流水线"
date: "2026-08-18T16:40:20+08:00"
category: [AI, Infra, transformers, CodeWiki, "5.15.0"]
tags: ["transformers", "Pipeline", "任务 API", "工厂", "preprocess/forward/postprocess"]
description: "pipeline() 是最高门槛入口，工厂据 task 名懒加载 model+processor，Pipeline 基类用 preprocess/forward/postprocess 三段模板解耦模型无关转换与模型前向。本文解读三段拆分与 device 管理设计。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/transformers/CodeWiki/5.15.0/00-overview)

---

## 模块定位

`pipeline()` 是 transformers 门槛最低的入口——用户传一个 task 名和 model 名，工厂自动加载 model + tokenizer/processor，返回一个可 `pipe(inputs)` 调用的对象。`Pipeline` 基类把 task 执行固定成 `preprocess → forward → postprocess` 三段，让新增 task 只填三个钩子。它独立成模块，是把"模型 + 预处理 + 后处理 + 设备管理 + 批处理"封装成单次调用，让不用了解内部的人也能跑推理。

边界：流水线只管"端到端 task 执行"，不管模型怎么加载（建模核心+注册表），也复用 tokenizer/processor（分词/多模态）。

## 模块架构

`pipelines/`（10624 行，28 文件）按职责分：

- **Pipeline 基类**：`base.py:754`，继承 `_ScikitCompat, PushToHubMixin`。三个 `@abstractmethod`：`_sanitize_parameters`（返回 preprocess/forward/postprocess 三组 kwargs）、`preprocess`（输入→model 输入张量 dict）、`_forward`（模型前向）、`postprocess`（model 输出→python 对象）。`forward`（L1178）是 `_forward` 的包装，统一 device_placement + `torch.no_grad` + tensor 设备迁移。`run_single`（L1296）固定三段流程。`__call__`（L1212）路由到 run_single 或 get_iterator（批处理）。
- **工厂**：`__init__.py` 的 `pipeline()` 函数 + `SUPPORTED_TASKS` 注册表（每个 task 是 `{impl, pt, default, type}` dict，共 22 个）+ `TASK_ALIASES` + `PIPELINE_REGISTRY`。
- **具体 task**：`text_generation.py`、`text_classification.py`、`image_classification.py`、`automatic_speech_recognition.py` 等 22 个。
- **批处理工具**：`pt_utils.py` 的 `PipelineIterator`（拆包 batch）、`PipelineDataset`/`PipelineChunkIterator`。
- **注册表管理**：`base.py:1342` 的 `PipelineRegistry`（`check_task` 别名展开、`register_pipeline` 运行时注册）。

## 调用链路

`pipe("Hello world")` 的完整数据流：

```
__call__(inputs, **kwargs)                         base.py:1212
├── 输入格式检测（Chat 消息包装）
├── _sanitize_parameters(**kwargs) → (preprocess_params, forward_params, postprocess_params)
│   └── 与 __init__ 缓存的 self._preprocess_params 等合并
├── 路由: is_list/dataset/generator → get_iterator；else → run_single
└── run_single(inputs, ...)                        base.py:1296
    ├── preprocess(input_) → tokenizer(text, return_tensors="pt") → {input_ids, attention_mask, prompt_text}
    ├── forward(model_inputs, ...)                 base.py:1178
    │   ├── with device_placement(): torch.no_grad(): _ensure_tensor_on_device(model_inputs → device)
    │   ├── _forward(model_inputs) → model.generate(...) → {generated_sequence, ...}
    │   └── _ensure_tensor_on_device(outputs → CPU)
    └── postprocess(model_outputs) → decode(sequence) → [{"generated_text": ...}]
```

批处理路径 `get_iterator`（L1187）：`PipelineDataset(preprocess)` → `DataLoader(num_workers, batch_size, pad_collate)` → `PipelineIterator(forward)` → `PipelineIterator(postprocess)`，多线程预处理 + 动态 padding 批处理 + 逐 batch 推理 + 逐条后处理。`PipelineIterator.__next__`（pt_utils.py:23）先检查是否在拆包中途（`_loader_batch_index < loader_batch_size`），否则取下一 batch 开始拆包。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `__call__` in `base.py:1212` | 入口路由 | 模板方法，路由 run_single/get_iterator |
| `run_single` in `base.py:1296` | 单条流水线 | 固定 preprocess→forward→postprocess |
| `forward` in `base.py:1178` | _forward 包装 | 统一 device/no_grad，子类只实现 _forward |
| `pipeline()` in `__init__.py` | 工厂函数 | 据 task 查 SUPPORTED_TASKS，懒加载组件 |
| `PipelineRegistry.check_task` in `base.py:1342` | 别名展开查表 | |

</details>

## 核心实现

### 为何拆成 preprocess/forward/postprocess 三段

将"模型无关的输入输出转换"与"模型前向推理"解耦。`preprocess`（如 tokenize）和 `postprocess`（如 decode）是 task-specific 但 model-agnostic——同一 text-generation pipeline 的这两个对所有 CausalLM 都一样；`_forward` 是 model-specific 热路径直接调 `model.generate()`。基类 `forward()` 统一包裹 device placement、`torch.no_grad`、tensor 设备迁移，子类 `_forward` 只关心"怎么调模型"。这种分离让批处理时 `preprocess` 可在 DataLoader 多线程 worker 并行执行（L1207）而 `forward` 在主线程 GPU 串行，`postprocess` 可流式 yield——三段混在一起则无法用 DataLoader 多线程预处理。

### pipeline() 工厂的懒加载

加载顺序遵循依赖链：① **Config 优先**（`__init__.py:900`）——先加载 `AutoConfig`，config 决定后续加载行为；② **Task 推断**——task 未指定但 model 是 str 时调 `get_task(model)` 查 Hub 的 `pipeline_tag`；③ **Model 加载**（L1031）——`load_model()` 用 `targeted_task["pt"]` 的 AutoModel 类元组逐一尝试 `from_pretrained`，支持 dtype fallback（bf16 失败回退 fp32）；④ **Processor 按需加载**（L1047）——读 pipeline_class 的 `_load_*` 标志（True=必须/None=可选/False=不加载），`_load_pipeline_component` 实现"True=必须成功，None=失败返回 None"软失败。`TextGenerationPipeline` 设 `_load_tokenizer=True`/`_load_image_processor=False` 等。这样 `pipeline("text-generation", model="gpt2")` 自动加载 tokenizer + model。

### device 管理

层次：① accelerate 互斥——model 有 `hf_device_map` 时不允许传 `device`（已多设备分布）；② device 推断优先级——`device=None`+`hf_device_map` 取首设备，`None` 默认 0，`-1` CPU，int≥0 按硬件可用性映射（cuda→mlu→musa→npu→hpu→xpu→mps→cpu）；③ `model.to(device)` 仅 device 不同且非 accelerate 加载时；④ `forward` 时 `device_placement` context + `_ensure_tensor_on_device` 迁移输入到 model device、输出回 CPU；⑤ torch.distributed 已初始化时用 `model.device` 覆盖。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `Pipeline.run_single`/`__call__`（base.py:1296,1212） | 固定三段流程，子类填钩子 |
| 工厂 | `pipeline()` + `SUPPORTED_TASKS`（`__init__.py`） | 据 task 名选 Pipeline 类 + 懒加载组件 |
| 注册表 | `SUPPORTED_TASKS` + `PIPELINE_REGISTRY.register_pipeline`（base.py:1361） | 运行时注册新 task，`_registered_impl` 记录供 save 序列化 |
| 策略 | 各 Pipeline 子类（TextGenerationPipeline 等） | 同接口不同 task 实现 |

## 模块间交互

Pipeline 持有 `model`（PreTrainedModel，`load_model` 经 `config.architectures` 动态 import 模型类）+ `tokenizer`/`feature_extractor`/`image_processor`/`video_processor`/`processor`（经对应 `Auto*.from_pretrained` 加载）。`_load_*` 类属性声明需要哪些预处理器。Processor 非空且其他组件 None 时自动拆解（`base.py:937`：`self.tokenizer = getattr(self.processor, "tokenizer", None)`）。`_pipeline_calls_generate=True` 的子类调 `model._prepare_generation_config` + 可选加载 assistant model 做 speculative decoding（`load_assistant_model` L314）。用户直接 `pipe(inputs)` 调用，也经 `transform`/`predict` 兼容 scikit-learn 接口。

## 扩展方式

新增 task pipeline（如 text-embedding）：在 `pipelines/` 建 `text_embedding.py` 继承 `Pipeline` 实现四个抽象方法设 `_load_*` 类属性；在 `__init__.py` 导入并往 `SUPPORTED_TASKS` 加条目（`impl`/`pt`/`default`/`type`），跑 `utils/check_pipeline_typing.py --fix_and_overwrite` 重生成 `@overload`；可选在 `base.py` 的 `SUPPORTED_PEFT_TASKS` 加 PEFT 兼容。自定义某 task 后处理：覆写对应 pipeline 的 `postprocess`（如 `text_generation.py:432`），从 `model_outputs["additional_outputs"]` 提取 scores（需在 `_sanitize_parameters` 的 `forward_params` 加 `output_scores=True`，`_forward` 传给 generate）。注册自定义 pipeline 类（不改源码）：`PIPELINE_REGISTRY.register_pipeline(task, pipeline_class, pt_model, default, type)`，`save_pretrained` 时序列化到 config 的 `custom_pipelines` 字段可复现保存加载。
