---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "多模态与工具调用"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "多模态", "Function Call", "Reasoning Parser", "VLM"]
description: "xLLM 多模态与工具调用解读：图像/视频/音频预处理器、FunctionCall 格式检测、Reasoning 解析。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

多模态与工具调用（`processors/` + `function_call/` + `parser/`）是推理前后的处理层，与模型推理正交。`processors` 在推理前把图像/视频/音频转为模型可吃的 embedding；`function_call` 在推理中检测并解析工具调用格式；`parser` 解析推理过程（如 `<think>` 标签）。这层独立是因为这些是"协议层"逻辑——与外部格式耦合，不该混入模型或调度代码。`~11.4k` 行 C++。

## 模块架构

```
processors/                     # 多模态 pre-processing
├── multimodal_processor.cpp      # MultimodalProcessorBase + 工厂注册
├── image_processor.h             # 图像处理器基类
├── clip_image_processor          # CLIP 图像处理
├── glm4v_image_processor / glm4v_video_processor  # GLM-4V 专用
├── kimi25_image_processor         # Kimi 2.5
├── minicpmv_image_processor      # MiniCPM-V
├── audio_processor.h             # 音频处理
├── clip_prompt_processor         # prompt 预处理
└── ...

function_call/                  # 工具调用格式检测与解析
├── function_call_parser.h        # FunctionCallParser 统一入口 + get_parser_auto
├── base_format_detector          # 格式检测基类
├── deepseekv3_detector / deepseekv32_detector  # DeepSeek 格式
├── glm45_detector / glm47_detector  # GLM 格式
├── qwen25_detector               # Qwen 格式
├── kimik2_detector               # Kimi K2 格式
├── partial_json_parser/          # 流式 JSON 解析
└── core_types.h                 # FunctionCall 数据结构

parser/                         # 推理内容解析
├── reasoning_parser.h            # ReasoningParser 入口 + get_parser_auto
├── reasoning_detector            # 推理标签检测
└── detector_registry             # 检测器注册表
```

## 调用链路

多模态请求与工具调用的处理链：

```text
# 多模态（VLM）请求
APIService::ChatCompletionsHttp
  └─ MultimodalProcessorFactory(model_type) → processor  in processors/multimodal_processor.cpp
     └─ processor.process(images/audio) → MMData(embeddings)  in framework/multimodal/mm_data.h
        └─ Request 携带 MMData → Sequence.input_embedding
           └─ VLMExecutor → CausalVLM.forward(embeds + tokens)

# 工具调用解析（推理后）
CausalLM.forward → logits → token
  └─ FunctionCallParser::get_parser_auto(tool_call_parser, model_type)  in function_call/function_call_parser.h
     └─ detector.detect(token_text) → ToolCall / FunctionCall
        └─ 增量 JSON 解析（partial_json_parser）
           └─ 写入 RequestOutput 的 tool_calls 字段

# Reasoning 解析
token 流 → ReasoningParser::get_parser_auto(reasoning_parser, model_type)  in parser/reasoning_parser.h
  └─ 检测 <think> 等标签 → 分离 reasoning content 与 final answer
```

## 核心实现

### MultimodalProcessor 注册

`MultimodalProcessorFactory`（`processors/multimodal_processor.cpp`）经 `ModelRegistry` 注册（`REGISTER_MULTIMODAL_PROCESSOR` 宏），与模型一一关联。各处理器（`clip_image_processor`/`glm4v_image_processor` 等）把原始图像/视频/音频转为定长 embedding 张量，封装进 `MMData`（`framework/multimodal/mm_data.h`）。`Sequence` 持有 `MMData`，执行时作为 `input_embedding` 注入模型。

设计决策：**为什么处理器与模型绑定而非全局**？不同模型的视觉编码器预处理不同（分辨率、归一化、patch 切分），与模型架构耦合，故按 `model_type` 注册。

### FunctionCallParser 自动检测

`FunctionCallParser`（`function_call/function_call_parser.h`）的 `get_parser_auto` 按 `model_type` 自动选择检测器：

```cpp title="function_call/function_call_parser.h"
static std::string get_parser_auto(std::string parser_name, std::string model_type);
```

各 `FormatDetector`（`deepseekv3_detector`/`glm45_detector`/`qwen25_detector`/`kimik2_detector`）实现特定格式的工具调用检测：流式增量解析模型输出中的工具调用 JSON，提取 `name`/`arguments`。`partial_json_parser/` 处理不完整 JSON 的增量解析（token 逐个到达时实时匹配）。

设计决策：**流式增量解析**而非等完整输出再解析，因为流式服务中 token 逐个到达，需实时判断"是否进入工具调用模式"并增量构建 JSON，否则首 token 延迟（TTFT）会被完整解析阻塞。

### ReasoningParser 推理分离

`ReasoningParser`（`parser/reasoning_parser.h`）检测模型输出中的推理内容（如 DeepSeek-R1 的 `<think>...</think>`），把输出分离为 `reasoning_content`（思考过程）与 `content`（最终答案）。`reasoning_detector` 检测标签边界，`detector_registry` 管理多种标签格式。这在 API 响应中体现为 `reasoning_content` 字段，让前端可折叠显示思考过程。

## 模块间交互

- **被 APIService 调用**：Chat 请求时按 model_type 取 processor 预处理多模态输入。
- **被 LLMMaster 调用**：`generate_request` 中 `FunctionCallParser::get_parser_auto` 与 `ReasoningParser::get_parser_auto` 设置解析器（`xllm.cpp` 的 `run()` 中调用）。
- **依赖 Framework**：`MMData`/`RequestOutput` 来自 `framework/`；parser 结果写入 `RequestOutput`。
- **与 Models 关联**：processor 经 `ModelRegistry` 与模型绑定。

## 扩展方式

- 新增多模态处理器：继承 `MultimodalProcessorBase`，用 `REGISTER_MULTIMODAL_PROCESSOR` 注册。
- 新增工具调用格式：继承 `BaseFormatDetector`，在 `FunctionCallParser::get_parser_auto` 增加 model_type 分支。
- 新增 reasoning 标签：在 `detector_registry` 注册新检测器。
