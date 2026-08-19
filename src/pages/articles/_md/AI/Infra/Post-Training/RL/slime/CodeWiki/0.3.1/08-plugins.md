---
source:
  type: "源码解读"
  project: "slime"
  url: "https://github.com/THUDM/slime"
title: "插件机制"
date: "2026-08-19T23:01:24+08:00"
category: ["AI", "Infra", "Post-Training", "RL", "slime", "CodeWiki", "0.3.1"]
tags: ["slime", "插件", "模型定义", "rollout buffer"]
description: "slime 的插件层：模型定义（glm/qwen/minimax）与离线数据 buffer 生成。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/00-overview)

---

## 模块定位

`slime_plugins/` 是 slime 的可插拔扩展层，分两半：`models/` 是模型结构定义（接入 Megatron 的 `GPTModel` 体系，按模型族提供 attention/MLP 变体），`rollout_buffer/` 是服务化的离线数据生成 + 回放 buffer（独立进程跑 rollout + reward，把产出灌进 buffer 供训练消费）。这一层证明 slime 的"扩展不分叉内核"原则——新模型结构与离线生成 workflow 都作为插件接入，内核（`slime/`）不需要为每个模型/每个数据源改代码。

## 模块架构

![插件层组件](/vibe-reading/images/articles/slime-internals/plugins-arch.svg)

`models/` 下按模型族组织：`glm4.py` / `glm5/glm5.py`（GLM 系列）、`qwen3_5.py` / `qwen3_5_vl.py` / `qwen3_next.py`（Qwen 系列）、`minimax_m2.py`，以及可复用的 attention 组件 `hf_attention.py` / `learnable_softmax_attention.py` / `flash_dot_product_attention.py` 与 `qwen_gdn_backend.py`。`model_provider.py`（在 `backends/megatron_utils/`）通过模型名分发到对应定义，`hf_to_megatron/` 与 `megatron_to_hf/` 的转换器也按模型族对应。`rollout_buffer/` 下 `buffer.py` 的 `BufferQueue` + `RolloutBuffer` 是服务端 buffer，`generator/base_generator.py` 的 `BaseGenerator` 是离线生成 worker，`rollout_buffer_example.py` 是用法示例。

## 核心实现

### 模型定义插件

`slime_plugins/models/` 的每个文件定义一种模型族的 Megatron 模型构造。它们接 Megatron 的 `GPTModel` / transformer_layer 体系，提供该模型特有的 attention 与 MLP 变体。可复用组件横跨多个模型族：`learnable_softmax_attention.py`（可学习 softmax 的 attention 变体）、`flash_dot_product_attention.py`（flash dot-product attention）、`hf_attention.py`（HF 兼容 attention）。`glm5/glm5.py` 是 GLM-5 的定义（独立子包，复杂度高）。这些定义被 `model_provider.py` 按模型名加载，checkpoint 转换器（`hf_to_megatron/glm.py` 等）与之配对——加新模型须同时加定义 + 两个方向转换器（见 [Megatron 后端模块](/vibe-reading/articles/AI/Infra/Post-Training/RL/slime/CodeWiki/0.3.1/03-megatron-backend)）。

### 离线数据 buffer 与生成 worker

`rollout_buffer/` 是 slime"灵活数据生成"的另一条路径——服务化的离线生成。`BaseGenerator`（`base_generator.py`）在独立进程里跑：`worker_process` 消费 task queue，对每个任务调 `rollout_func` + `reward_func` 生成样本，产出送 done queue。`send_data_to_buffer` 把产出灌进 `RolloutBuffer`。`run` / `entry` 是入口，`input_file` 是 prompt 源。`normalize_group_data`（`algo="grpo"`）在 buffer 侧做组归一化，`is_valid_group` 过滤无效组（`min_valid_group_size` + `task_type`）。`query_single_turn` 是单轮 LLM 查询封装（`tools` 参数支持工具调用）。

`buffer.py` 的 `BufferQueue`（`_get_valid_groups_with_timeout` 带超时取有效组）+ `RolloutBuffer`（`write` / `read`）是 buffer 的服务端实现，`discover_generators` 动态发现生成器。这条路径让数据生成可以完全独立于训练循环异步进行——训练循环从 buffer 读现成的 `(prompt, response, reward)` 组，而非每步在线生成。`run_rollout`（`buffer.py` 与 `base_generator.py` 各有一个）是 RPC 入口。

### 与在线 rollout 的关系

离线 buffer 与在线 rollout（模块 02）是互补的两条数据路径。在线 rollout 每步由 `RolloutManager.generate` 调 SGLang 实时生成，保证 on-policy；离线 buffer 预生成数据灌入 buffer，训练循环读取，适合无需 on-policy 的场景（如 SFT 数据、固定的 reward 标注）。`RolloutDataSourceWithBuffer`（`slime/rollout/data_source.py`，模块 02）的 `get_samples` 先从 buffer 取再从 prompt 源取，是在线与离线在同一数据接口下的融合。

## 扩展方式

新增模型：在 `slime_plugins/models/` 加定义文件（参考同族已有实现，如 `qwen3_5.py`），在 `hf_to_megatron/` 与 `megatron_to_hf/` 各加转换器，`model_provider.py` 按模型名分发。新增离线生成器：继承 `BaseGenerator`，实现 `run` / `entry`（或直接用 `worker_process` + 自定义 `rollout_func` / `reward_func`），`discover_generators` 自动发现。`rollout_buffer_example.py` 是模板。加 buffer filter：实现 `is_valid_group` 签名的函数，用 `--buffer-filter-path` 注入 `RolloutDataSourceWithBuffer`。
