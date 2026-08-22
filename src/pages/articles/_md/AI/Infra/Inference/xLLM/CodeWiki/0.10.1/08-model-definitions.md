---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "模型定义"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "Models", "DeepSeek", "Qwen", "GLM", "注册表"]
description: "xLLM 模型定义解读：ModelRegistry 注册表机制、LLM/VLM/DiT/Rec 四类模型架构与宏注册扩展。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

模型定义（`models/`）是各模型架构的具体实现。它不包含执行逻辑（那是 runtime/layers/kernels 的事），只定义模型结构（层如何组合）与权重加载。这层独立是因为模型数量众多且持续增长，用注册表模式管理——新增模型零侵入，不动框架代码。`~50.2k` 行 C++。

## 模块架构

```
models/
├── model_registry.h           # ModelRegistry 单例 + REGISTER_* 宏 + create_*_model 工厂
├── llm/                        # 纯文本 LLM
│   ├── llm_model_base.h          # LlmModelImplBase<DecoderLayerType> 模板基类
│   ├── mtp_model_base.h          # MTP 推测模型基类
│   ├── deepseek_v2.h / v3.h / v32.h / v4.h  # DeepSeek 系列
│   ├── deepseek_mtp.h / v4_mtp.h  # DeepSeek MTP 草稿模型
│   ├── qwen2.h / qwen3.h / qwen3_5.h / qwen3_moe.h / qwen3_next.h  # Qwen 系列
│   ├── glm5.h / glm5_mtp.h       # GLM-5
│   ├── oxygen.h / mimo.h / joyai_llm_flash.h  # 其他模型
│   ├── npu/ / mlu/ / musa/       # 各后端的 decoder layer 实现
│   └── ...
├── vlm/                        # 视觉语言模型（CausalVLM）
├── dit/                        # 扩散 Transformer（图像/视频生成）
│   ├── autoencoders/ encoders/ pipelines/ processors/ schedulers/ transformers/ utils/
└── rec/                        # 推荐模型（RecCausalLM）
```

核心是 **ModelRegistry 注册表**：模型按 `model_type` 字符串注册，运行时查表创建。

## 调用链路

模型创建链路：

```text
xllm.cpp: run()
└─ get_model_type(model_path, backend)         # 从路径推断 model_type（如 "qwen3"）
   └─ create_master → LLMMaster → engine_->init()
      └─ init_model() in runtime/worker_impl
         └─ ModelContext(model_path, args, ...)   # 组装上下文
            └─ create_llm_model(context)           in models/model_registry.h
               └─ ModelRegistry::get_causallm_factory(model_type)
                  → CausalLMFactory(context)
                     └─ new XxxModel(context) → CausalLMImpl<ModelClass>(model, options)
```

## 核心实现

### ModelRegistry 与宏注册

`ModelRegistry`（`model_registry.h`）是单例，持有 `unordered_map<string, ModelMeta>`。`ModelMeta` 包含各类工厂（`CausalLMFactory`/`CausalVLMFactory`/`DiTModelFactory`/`RecModelFactory`/`MultimodalProcessorFactory`）与参数加载器（`ModelArgsLoader`/`QuantArgsLoader`/`TokenizerArgsLoader`）。

注册用宏完成，编译期自动执行：

```cpp title="models/model_registry.h"
#define REGISTER_CAUSAL_MODEL(ModelType, ModelClass) \
  const bool ModelType##_registered = []() { \
    ModelRegistry::register_causallm_factory( \
        #ModelType, [](const ModelContext& context) { \
          ModelClass model(context); \
          model->eval(); \
          return std::make_unique<CausalLMImpl<ModelClass>>( \
              std::move(model), context.get_tensor_options()); \
        }); \
    return true; \
  }()
```

设计决策：用静态变量初始化 + lambda 实现编译期注册，模型文件只需一行 `REGISTER_CAUSAL_MODEL(qwen3, Qwen3Model)` 即完成注册。`CausalLMImpl<Model>`（`causal_lm.h`）是类型擦除包装——把编译期具体的 `ModelClass` 包成运行期 `CausalLM*` 虚接口，兼顾性能（编译期绑定）与扩展（运行期多态）。

### LlmModelImplBase 模板基类

`LlmModelImplBase<DecoderLayerType>`（`llm_model_base.h`）是 LLM 模型基类，`forward` 实现通用的逐层前向：

```cpp title="models/llm/llm_model_base.h"
ModelOutput forward(torch::Tensor tokens, torch::Tensor positions,
                    std::vector<KVCache>& kv_caches, const ModelInputParams& input_params) {
  auto h = embed_tokens_(tokens);                    # 词嵌入
  auto attn_metadata = AttentionMetadataBuilder::build(input_params, ...);
  std::optional<torch::Tensor> residual;
  for (size_t i = 0; i < layers_.size(); i++) {      # 逐层
    h = layers_[i](h, residual, positions, attn_metadata, kv_caches[i], input_params);
    if (!input_params.record_layer(i, h.device())) return ModelOutput();  # 中断支持
  }
  auto [hidden, residual_out] = norm_(h, residual);  # 终归一化
  return ModelOutput(hidden, residual_out);
}
```

各具体模型（`qwen3.h`/`deepseek_v3.h` 等）继承此基类，只需定义 `layers_`（注入 `DecoderLayerType`）与 `load_state_dict`（权重名映射）。`record_layer` 与 `InterruptionBus` 配合实现层前向中断（`enable_forward_interruption`），用于延迟感知调度的抢占。

### 模型族与 MTP

DeepSeek/Qwen/GLM 系列各有 MTP（Multi-Token Prediction）草稿模型变体（`deepseek_mtp.h`/`qwen3_5_mtp.h`/`glm5_mtp.h`），配合 `SpeculativeEngine` 做推测解码：草稿模型快速生成候选 token，主模型验证。`mtp_model_base.h` 是 MTP 模型基类。

### DiT 模型（扩散生成）

`models/dit/` 是扩散 Transformer 模型，用于图像/视频/音频生成。结构比 LLM 复杂：含 `autoencoders`（VAE）、`encoders`、`transformers`（DiT 主干）、`schedulers`（采样调度）、`pipelines`（生成流水线）、`processors`。对应 `DiTMaster`/`DiTEngine` 与 `dit_scheduler`。

## 模块间交互

- **被 Runtime 依赖**：`WorkerImpl::init_model` 调 `create_llm_model` 创建 `CausalLM*`。
- **依赖 Layers**：模型类继承 `LlmModelImplBase`，注入 decoder layer（`layers/{backend}/`）。
- **依赖 Framework**：`ModelContext`/`ModelArgs`/`StateDict`/`ModelLoader` 来自 `framework/`。
- **依赖 Processors**：VLM 模型经 `MultimodalProcessorFactory` 关联多模态预处理器。

## 扩展方式

新增模型（最常见场景）：
1. 在 `models/llm/` 新建 `xxx.h`，继承 `LlmModelImplBase<XxxDecoderLayer>`，实现 `forward`/`load_state_dict`
2. 在 `models/llm/npu/`（或对应后端）定义 `npu_xxx_decoder_layer_impl`
3. 用宏注册：`REGISTER_CAUSAL_MODEL(xxx, XxxModel)` + `REGISTER_MODEL_ARGS(xxx, ...)` + `REGISTER_TOKENIZER_ARGS(xxx, ...)`
4. 在 `models/model_registry.cpp` 的 `model_backend_` map 增加后端映射
