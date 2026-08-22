---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "执行层"
date: "2026-08-22T22:29:54+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.18"]
tags: ["SGLang", "model_executor", "ForwardBatch", "CUDA Graph", "ModelRunner"]
description: "SGLang 执行层：ForwardBatch 批次装配、ModelRunner 三路分发、CUDA Graph 分桶重放与 hook 机制。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.18/00-overview)

---

## 模块定位

model_executor 是执行层，承载"一次 forward 的全部逻辑"：把 `managers` 的 CPU 侧 `ScheduleBatch` 装配成 GPU 侧 `ForwardBatch`，驱动 `model.forward`，用 CUDA Graph 消除 kernel launch 开销，再做采样。它连接编排层与模型算子层——`ModelRunner` 持有 `model: nn.Module` 调 `layers/` 实现，同时读写 `mem_cache` 的 KV 物理池。它不调度、不组批——那是 managers 的事。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-v0518/model-executor-architecture.svg)

模块核心是三个对象。**`ForwardBatch`**（`forward_batch_info.py:377`）是 `@dataclass`，把一次 forward 需要的 ~85 个张量/元数据（`input_ids`/`positions`/`seq_lens`/`out_cache_loc`/`sampling_info`/`spec_info`/`capture_hidden_mode`…）打包成对象，还继承 `ForwardBatchDeepSeekMHAMixin`（`forward_batch_deepseek_mha_mixin.py:20`）按模型架构选择性扩展 MLA chunked prefix cache 字段。**`ModelRunner`**（`model_runner.py:284`）持有 `model: nn.Module`、`attn_backend`、三个 runner（`decode_cuda_graph_runner`/`prefill_cuda_graph_runner`/`eager_runner`）、`req_to_token_pool`、`token_to_kv_pool_allocator`、`sampler`。**`ForwardContext`**（`forward_context.py:34`）是 frozen dataclass 模块级单例，深层 attention 层经 `get_attn_backend()`/`get_token_to_kv_pool()` 取当前 backend 与 KV pool，免去逐层传参。

`_forward_raw`（`model_runner.py:1641`）按 `ForwardMode` 与 `can_run_graph` 三路分发：CUDA graph 重放、prefill CUDA graph、EagerRunner（内部再分 decode/extend/idle）。Runner 体系是 `BaseRunner(ABC)`（`base_runner.py:209`）→ `EagerRunner`（`eager_runner.py:76`） + `BaseCudaGraphRunner`（`base_cuda_graph_runner.py:105`）→ `{DecodeCudaGraphRunner, PrefillCudaGraphRunner}`；后端 `BaseCudaGraphBackend(ABC)`（`base_cuda_graph_backend.py:28`）有 `FullCudaGraphBackend`/`BreakableCudaGraphBackend`/`TcPiecewiseCudaGraphBackend` 三实现，由 `CudaGraphConfig`（`cuda_graph_config.py:123`）的 `Phase`(DECODE/PREFILL)+`Backend`(FULL/BREAKABLE/TC_PIECEWISE/DISABLED) 配置选择。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-v0518/model-executor-call-chain.svg)

从 `Scheduler.run_batch`（`scheduler.py:3626`）出发 → `TpModelWorker.forward_batch_generation`（`tp_worker.py:574`）→ `ForwardBatch.init_new`（`forward_batch_info.py:703`，CPU→GPU 张量）→ `ModelRunner.forward`（`:1497`）→ `_forward_raw`（`:1641`，发布 ForwardContext）→ 判断 `can_run_graph`？DECODE/IDLE → **路径 A**: `decode_cuda_graph_runner.execute`（graph 重放）；EXTEND + prefill_cg.can_run_graph → **路径 B/C**: `prefill_cuda_graph_runner.execute` 或 `forward_split_prefill`；else → **路径 D**: `eager_runner.execute`（`_execute_decode`/`_execute_extend`/`_execute_idle`）→ `model.forward`（Attention/MoE/Norm 层）→ `ModelRunner.sample`（`:1758`）→ `next_token_ids`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `forward` (`model_runner.py:1497`) | 外层 forward 入口 | 包裹 canary/profiler |
| `_forward_raw` (`:1641`) | 三路分发核心 | 发布 ForwardContext 后判断 can_run_graph |
| `init_new` (`forward_batch_info.py:703`) | 从 ScheduleBatch 构建 ForwardBatch | positions 计算(decode=clamp, extend=compute) |
| `execute` (各 Runner) | 执行 forward | DecodeCudaGraphRunner: load_batch + backend.replay |
| `can_run_graph` (各 Runner) | 判断能否走 CUDA graph | 检查 bs 在捕获范围 + DP/TBO 兼容 |
| `_pad_to_bucket` (`base_cuda_graph_runner.py:137`) | 找到 ≥raw_size 的最小桶 | bisect.bisect_left |
| `capture_one` (各 Backend) | 录制一个 shape 的 graph | Full: 2次warmup+CUDAGraph; Breakable: 分段; Tc: torch.compile |
| `replay` (各 Backend) | 重放已捕获 graph | Full: graph.replay(); Tc: compiled_fn() |
| `sample` (`model_runner.py:1758`) | 采样 + logprob | sampler(logits_output, sampling_info) |
| `_prepare_eager_forward_batch` (`:1408`) | 非 decode-graph 路径预处理 | DP/MLP-sync padding + attn_tp 归一化 |
| `share_input_buffer` (`input_buffers.py:16`) | flyweight 共享 buffer | 按 (name, numel, dtype, device) 合并 |

</details>

## 核心实现

### ForwardBatch 与 init_new

`ForwardBatch`（`forward_batch_info.py:377`）约 80+ 字段，分七组：Required core inputs（`forward_mode`/`batch_size`/`input_ids`/`req_pool_indices`/`seq_lens`/`out_cache_loc`）、Borrowed GPU tensors、Config/flags、Host metadata、Forward-derived（`positions`/`extend_seq_lens`）、Runtime-filled、Attention planning。`init_new`（`:703`）是工厂方法，从 `ScheduleBatch` 构建——处理 positions 计算（decode 用 `clamp_position`，extend 用 `compute_position`）、mrope positions、LoRA 批次准备、kv-canary 等。`ForwardMode`（`:98`）是 IntEnum：EXTEND/DECODE/MIXED/IDLE/TARGET_VERIFY/DRAFT_EXTEND_V2/PREBUILT/SPLIT_PREFILL/DLLM_EXTEND，每个模式有 `is_cuda_graph()` 等判定方法。

### ModelRunner 三路分发

`_forward_raw`（`model_runner.py:1641`）的完整分发逻辑：第 0 步发布 `ForwardContext`（`:1648`）；第 1 步判断 `can_run_graph`（`is_cuda_graph()` 返回 True 的模式：DECODE/TARGET_VERIFY/IDLE/DLLM_EXTEND + `decode_cuda_graph_runner.can_run_graph`）；第 2 步路径 A：`decode_cuda_graph_runner.execute` 直接重放；第 3 步 `_prepare_eager_forward_batch`（DP/MLP-sync padding + attn_tp 归一化 + hisparse coordinator 刷新）；第 4 步路径 B：SPLIT_PREFILL → `forward_split_prefill`；第 5 步路径 C：EXTEND + prefill_cg.can_run_graph → `prefill_cuda_graph_runner.execute`；第 6 步路径 D：`eager_runner.execute`（按 mode 分 `_execute_decode`/`_execute_extend`/`_execute_idle`）。

### CUDA Graph 体系

Runner 继承：`BaseRunner(ABC)`（`base_runner.py:209`，定义 `warmup`/`_dummy_run` 模板）→ `EagerRunner`（无 graph 直接 `model.forward`）+ `BaseCudaGraphRunner`（`base_cuda_graph_runner.py:105`，`_pad_to_bucket` 工具）→ `DecodeCudaGraphRunner`（`:200`，bs 维度分桶）+ `PrefillCudaGraphRunner`（`:245`，token 维度分桶）。

Backend 继承：`BaseCudaGraphBackend(ABC)`（6 个抽象方法）→ `FullCudaGraphBackend`（每 shape 一个 `torch.cuda.CUDAGraph`）、`BreakableCudaGraphBackend`（分段捕获 + `DedupedCudaGraphMixin` 拓扑签名去重）、`TcPiecewiseCudaGraphBackend`（`torch.compile` 驱动）。

分桶 padding：`_pad_to_bucket`（`:137`）用 `bisect.bisect_left` 找 ≥raw_size 的最小桶。Decode 按 bs 维度捕获，过滤 `bs * captured_req_width % attn_tp_size == 0` 满足 TP 对齐约束。Prefill 按 token 维度捕获，`_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR = 2` 限制 padding 不超 2 倍。CUDA graph 把 decode 阶段每步的 kernel launch 开销从 ~100us 降到 ~10us 级——decode 每 req 只生成 1 token，计算量小但 launch 开销占比高。EagerRunner 永远先于 cuda graph runner 构建——其 static buffer 先注册成 canonical，后续 runner 经 `share_buffers()` 返回同地址 view，保证捕获与重放 `data_ptr` 相同（这是 cuda graph 正确性前提）。

注意 `ModelRunner.forward`（`:1497`）本身**不调 sample**——采样由 `TpModelWorker` 在 forward 后显式调 `model_runner.sample`（`:1758`）：`_preprocess_logits`（apply grammar mask 等 bias）→ `sampler` → `next_token_ids`。模型层（以 `models/llama.py:111` 为例）：`LlamaForCausalLM.forward` → `self.model`（`embed_tokens` → decoder layers 循环，每层做 q/k/v proj + `RadixAttention`（`radix_attention.py:91`）+ MLP + residual）→ final norm → `logits_processor` 产 `LogitsProcessorOutput`。`ForwardBatch` 作为第三个位置参数传入 `model.forward`，模型内部层通过 `forward_batch.positions`/`forward_batch.seq_lens` 等读取元数据。

### ForwardContext 全局单例

`ForwardContext`（`forward_context.py:34`）是 `@dataclass(frozen=True, slots=True)`。`_current` 模块级全局变量，`forward_context()` contextmanager（`:78`）支持 `dataclasses.replace` 创建覆盖范围。模型深层代码（如 RadixAttention 层在 80+ 层 transformer 内部）通过 `get_attn_backend()`/`get_token_to_kv_pool()`/`get_req_to_token_pool()` 深度读取。Frozen 设计防止意外修改。注释（`:18-21`）说明每个 worker 进程内只有一个 Python 线程执行 forward，所以模块级全局是安全的。

### ForwardInputBuffers Flyweight

`share_input_buffer`（`input_buffers.py:16`）按 `(name, numel, dtype, device)` 合并相同 buffer。多个 runner（decode cg / prefill cg / eager / speculative draft）共享同一物理分配，避免重复分配 GPU 显存。`share_buffers()`（`:71`）遍历所有字段对每个 buffer 调用 `share_input_buffer`。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|----------|
| ABC 模板方法 | `BaseRunner` `base_runner.py:209`；`BaseCudaGraphBackend` `base_cuda_graph_backend.py:28` | 统一 capture-replay 生命周期骨架 |
| Flyweight 享元 | `ForwardInputBuffers` `input_buffers.py:59`；`share_input_buffer` `:16` | 跨 runner 共享 static buffer 保证 data_ptr 一致 |
| 全局上下文 | `ForwardContext` `forward_context.py:34` | 深层 attention 层免逐层传参 |
| 策略模式 | `BaseCudaGraphBackend` 三实现 `Full/Breakable/TcPiecewise` | `resolve_decode_backend`/`resolve_prefill_backend` 工厂选择 |
| 命令模式 | `HookManager.register_forward_hooks` `hook_manager.py:11` | JSON 配置驱动 PyTorch hook |
| Mixin | `ForwardBatchDeepSeekMHAMixin` `forward_batch_deepseek_mha_mixin.py:20`；`DedupedCudaGraphMixin` `cuda_graph_dedup_mixin.py:295` | 按模型架构/后端选择性扩展字段 |

## 模块间交互

`ModelRunner.req_to_token_pool`/`token_to_kv_pool`/`token_to_kv_pool_allocator` 持有 mem_cache 引用。`ForwardBatch.out_cache_loc` 是本次 forward 输出 token 在 KV pool 中的位置索引。通过 `ForwardContext`：`get_token_to_kv_pool()` = `get_attn_backend().token_to_kv_pool`，attention backend 在 `__init__` 时缓存 pool 引用。`Scheduler` 调 `ModelRunner.forward` → 返回 `ModelRunnerOutput`（`logits_output` + `can_run_graph`），`can_run_graph` 告知 Scheduler 是否走了 CUDA graph（影响 overlap 的 WAR barrier）。

## 扩展方式

#### 新增 runner backend

1. 在 `cuda_graph_config.py` 的 `Backend` 类中加标识，注册到 `ALLOWED_BACKENDS_PER_PHASE`
2. 在 `runner_backend/` 下新建 backend 文件，继承 `BaseCudaGraphBackend`（`:28`），实现 6 个抽象方法
3. 在 `runner_backend/utils.py` 的 `resolve_decode_backend`/`resolve_prefill_backend` 中加分支

#### 新增 hook

1. 编写 hook factory 函数（如 `module:make_hook`），返回 `fn(hook_module, input, output)`
2. 在 `server_args.forward_hooks` 中配置 spec：`{"name": ..., "target_modules": ["model.layers.*.mlp"], "hook_factory": "...", "config": {...}}`
3. CUDA graph capture 阶段的 hook 注册到 `ModelRunner.capture_tail_hooks`（`model_runner.py:340`）
