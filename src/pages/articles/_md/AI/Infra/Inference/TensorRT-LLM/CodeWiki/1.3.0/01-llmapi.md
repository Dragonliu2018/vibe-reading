---
source:
  type: "源码解读"
  project: "TensorRT-LLM"
  url: "https://github.com/NVIDIA/TensorRT-LLM"
title: "llmapi"
date: "2026-08-12T12:04:11+08:00"
category: [AI, Infra, Inference, TensorRT-LLM, CodeWiki, "1.3.0"]
tags: ["TensorRT-LLM", "LLM API", "模板方法", "策略模式"]
description: "llmapi 是 TensorRT-LLM 的用户入口——LLM/AsyncLLM 统一 API，通过模板方法与策略模式实现后端可切换。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/TensorRT-LLM/CodeWiki/1.3.0/00-overview)

---

## 模块定位

llmapi 是 TensorRT-LLM 的最高层——用户通过 `LLM.generate()` / `AsyncLLM` 与引擎交互的唯一入口。它负责输入归一化、tokenize、sampling 参数准备、后处理钩子，把用户意图转成底层 executor 能消费的 `GenerationRequest`。模块独立存在是为了**隔离用户与引擎内部**：用户不需要知道 executor 拓扑、调度策略、KV cache 布局，只需调用 `generate(prompt, sampling_params)`。

## 模块架构

llmapi 的核心是 `BaseLLM` 抽象基类，承载所有后端无关逻辑；`_TorchLLM` 覆写 `_build_model()` 钩子注入 Torch 后端装配；`LLM` 是用户直接使用的近乎空的子类。这种模板方法 + 策略的设计让新增后端只需继承并覆写一个方法。

```
BaseLLM (llm.py:273)            ← 后端无关：generate/generate_async/_preprocess
  └── _TorchLLM (llm.py:1668)   ← Torch 后端：_build_model() 覆写
        └── LLM (llm.py:1838)   ← 用户入口（近乎空，承载 docstring）
              └── AsyncLLM       ← RL/agentic 异步生命周期管理
```

## 调用链路

从 `LLM.generate()` 到 executor 提交的三层调用：

```
LLM.generate(prompts)                      [llm.py:549]
  → 输入归一化 → 逐条 generate_async(streaming=False)
    → BaseLLM.generate_async()             [llm.py:654]
      ├─ _prepare_sampling_params()        [llm.py:1377]  → SamplingParams 填默认
      ├─ _preprocess(inputs)               [llm.py:775]   → 文本 → token IDs
      └─ self._executor.generate_async()   → GenerationResult (future)
    → future.result() 阻塞等待
  → RequestOutput._from_generation_result() [llm.py:76]
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|------------|
| `generate()` | 批量同步生成 | 先全部提交再全部等待，实现批量并行 |
| `generate_async()` | 单条异步提交 | 统一入口，同步是异步的包装 |
| `_preprocess()` | tokenize + 多模态 | 返回 token_ids + prompt + multimodal_params |
| `_build_model()` | 装配引擎 | 模板方法钩子，子类覆写 |

## 核心实现

### BaseLLM 与后端策略

`BaseLLM.__init__` in `llmapi/llm.py:277` 定义初始化骨架：根据 `backend` 参数选择 `llm_args_cls`（`TorchLlmArgs` 或 `AutoDeployLlmArgs`），校验 kwargs，创建 `self.args`，最后调用 `self._build_model()`——这是模板方法钩子。`BaseLLM._build_model()` 提供基础实现，`_TorchLLM._build_model()` in `llm.py:1740` 覆写它，增加 tokenizer 加载、input processor 创建、`GenerationExecutor.create()` 调用。

后端选择是策略模式：`backend="pytorch"` → `TorchLlmArgs`，`backend="_autodeploy"` → `AutoDeployLlmArgs`（动态导入）。这让不同后端使用不同配置 schema，而 generate 逻辑完全复用。

### 同步 vs 异步设计

核心设计是**异步优先，同步是异步的包装**。`generate_async()` in `llm.py:654` 是真正提交请求的方法，返回 `RequestOutput`（继承 `GenerationResult`，是 future-like 对象）。`generate()` in `llm.py:549` 循环调 `generate_async(streaming=False)`，再 `future.result()` 阻塞。好处：统一路径（不存在两套逻辑）、批量并行（先全部提交再全部等待）、流式支持（`streaming=True` 返回的 `RequestOutput` 可迭代）。

`AsyncLLM` in `_torch/async_llm.py:7` 面向 RL/agentic 场景，异步指的是**生命周期管理异步**（`setup_async` / `release` / `resume` / `update_weights` 用 async/await），而非生成本身。它还增加 `pause_generation` / `resume_generation` 控制在途请求。

### RequestOutput 的实例化控制

`RequestOutput.__init__` 直接 raise RuntimeError（`llm.py:70`），强制通过 `_from_generation_result()` 工厂方法创建。原因：`RequestOutput` 需从 `GenerationResult` 继承 dict 状态、注入 tokenizer 和 post_processor_hook，直接实例化会缺少上下文。这是工厂方法模式的典型应用。

### LlmArgs 配置体系

`TorchLlmArgs` in `llm_args.py:5057` 继承 `BaseLlmArgs`（pydantic `StrictBaseModel`），包含 PyTorch 后端特有参数：`generation_config`、`cuda_graph_config`、`multimodal_config`、`moe_config`、`attn_backend`、`torch_compile_config` 等。pydantic 校验确保配置正确性，`__init__.py` 导出的 `LlmArgs` 实际是 `TorchLlmArgs` 的别名。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `BaseLLM.__init__` → `_build_model()` in `llm.py:277` | 后端无关骨架，子类只覆写钩子 |
| 策略 | `backend` 分支选 `llm_args_cls` in `llm.py:302` | 多后端可切换 |
| 工厂方法 | `RequestOutput._from_generation_result()` in `llm.py:76` | 控制实例化上下文 |
| 上下文管理器 | `__enter__`/`__exit__` in `llm.py:1649` | 确保 GPU 资源释放，atexit + weakref 防 GC 阻塞 |

## 模块间交互

llmapi 向下依赖 `executor`（`GenerationExecutor` 提交请求）、`inputs`（输入处理）、`sampling_params`、`llm_args`、`llm_utils`（`CachedModelLoader` 模型加载）、`mpi_session`（多 GPU 通信）。被 `tensorrt_llm/__init__.py` 顶层导出，被 `_torch/async_llm.py` 继承，被多个 `modeling_*.py` 导入 `TorchLlmArgs` 做类型检查。

## 扩展方式

**新增后端**：创建 `XxxLlmArgs(BaseLlmArgs)` 配置 schema → 创建 `_XxxLLM(BaseLLM)` 覆写 `_build_model()` → 在 `BaseLLM.__init__` 的 backend 分支添加 `elif`。generate 逻辑无需改动。

**新增生成参数**：per-request 参数加到 `generate()` / `generate_async()` 签名；配置级参数加到 `BaseLlmArgs` / `TorchLlmArgs` 的 `Field`；需传到 executor 的修改 `GenerationRequest` 构造。
