---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Model Executor"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "model_executor", "ForwardBatch", "CUDA Graph", "ModelRunner"]
description: "SGLang 执行层：ForwardBatch 批次装配、ModelRunner 三路分发、CUDA Graph 分桶重放与 hook 机制。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.17/00-overview)

---

## 模块定位

model_executor 是执行层，承载"一次 forward 的全部逻辑"：把 `managers` 的 CPU 侧 `ScheduleBatch` 装配成 GPU 侧 `ForwardBatch`，驱动 `model.forward`，用 CUDA Graph 消除 kernel launch 开销，再做采样。它连接编排层与模型算子层——`ModelRunner` 持有 `model: nn.Module` 调 `layers/` 实现，同时读写 `mem_cache` 的 KV 物理池。它不调度、不组批——那是 managers 的事。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-internals/model-executor-architecture.svg)

模块核心是三个对象。**`ForwardBatch`**（`forward_batch_info.py:412`）是 `@dataclass`，把一次 forward 需要的 ~50 个张量/元数据（`input_ids`/`positions`/`seq_lens`/`out_cache_loc`/`sampling_info`/`spec_info`/`capture_hidden_mode`…）打包成对象，还继承 `ForwardBatchDeepSeekMHAMixin` 按模型架构选择性扩展 chunked prefix cache 字段。**`ModelRunner`**（`model_runner.py:283`）持有 `model: nn.Module`、`attn_backend`、三个 runner（`decode_cuda_graph_runner`/`prefill_cuda_graph_runner`/`eager_runner`）、`req_to_token_pool`、`token_to_kv_pool_allocator`、`sampler`。**`ForwardContext`**（`forward_context.py:35`）是 frozen dataclass 模块级单例，深层 attention 层经 `get_attn_backend()`/`get_token_to_kv_pool()` 取当前 backend 与 KV pool，免去逐层传参。

`_forward_raw`（`:1593`）按 `ForwardMode` 与 `can_run_graph` 三路分发：CUDA graph 重放、prefill CUDA graph、EagerRunner（内部再分 decode/extend/idle）。Runner 体系是 `BaseRunner(ABC)` → `EagerRunner` + `BaseCudaGraphRunner` → `{DecodeCudaGraphRunner, PrefillCudaGraphRunner}`；后端 `BaseCudaGraphBackend(ABC)` 有 `FullCudaGraphBackend`/`BreakableCudaGraphBackend`/`TcPiecewiseCudaGraphBackend` 三实现，由 `CudaGraphConfig`（`cuda_graph_config.py`）的 `Phase`(DECODE/PREFILL)+`Backend`(FULL/BREAKABLE/TC_PIECEWISE/DISABLED) 配置选择。`HookManager` 与 `ForwardInputBuffers` 是辅助：前者 JSON 配置驱动挂 PyTorch hook，后者用 flyweight 跨 runner 共享 static buffer 保证 cuda graph 捕获/重放 `data_ptr` 一致。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-internals/model-executor-call-chain.svg)

入口是 `TpModelWorker.forward_batch_generation`（`tp_worker.py:561`），它先 `ForwardBatch.init_new`（`forward_batch_info.py:739`）从 `ScheduleBatch` 构建 GPU 张量（算 positions、填 extend 字段、准备 LoRA）。然后 `ModelRunner.forward`（`:1449`）进入 `with forward_context(ForwardContext(attn_backend))` 发布全局上下文，调 `_forward_raw`（`:1593`）三路分发：若 `can_run_graph` 为真走 `decode_cuda_graph_runner.execute`（`load_batch` 拷入 static buffer → `backend.replay` 重放 → 截取 `raw_num_token` 行）；否则 EagerRunner 按 mode 走 `_execute_decode`/`_execute_extend`/`_execute_idle`，内部 `attn_backend.init_forward_metadata` 规划 attention metadata 后调 `model_runner.model.forward(input_ids, positions, forward_batch)`。

模型层（以 `models/llama.py:563` 为例）：`LlamaForCausalLM.forward` → `self.model`（`embed_tokens` → decoder layers 循环，每层 `LlamaDecoderLayer` 做 q/k/v proj + `RadixAttention` + MLP + residual）→ final norm → `logits_processor` 产 `LogitsProcessorOutput`。注意 `ModelRunner.forward` 本身**不调 sample**——采样由 `TpModelWorker` 在 forward 后显式调 `model_runner.sample`（`:1710`）：`_preprocess_logits`（apply grammar mask 等 bias）→ `sampler` → `next_token_ids`。`ForwardMode`（`:98`）枚举 `EXTEND/DECODE/MIXED/IDLE/TARGET_VERIFY/DRAFT_EXTEND_V2/PREBUILT/SPLIT_PREFILL/DLLM_EXTEND`，`is_cuda_graph()` 判定 DECODE/TARGET_VERIFY/IDLE/DLLM_EXTEND 走 cuda graph。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|--------------|
| `ForwardBatch.init_new` (`:739`) | ScheduleBatch→GPU 张量 | 借用 out_cache_loc，不算 sampling |
| `ModelRunner.forward` (`:1449`) | 前向入口 | 发布 ForwardContext，不调 sample |
| `_forward_raw` (`:1593`) | 三路分发 | can_run_graph + ForwardMode |
| `ModelRunner.sample` (`:1710`) | 采样 | _preprocess_logits + sampler |
| `ModelRunner.load_model` (`:1047`) | 加载模型 | 持有 model: nn.Module |
| `init_cuda_graphs` (`:982`) | 捕获 cuda graph | 按 capture_bs 分桶 |
| `EagerRunner._execute_decode` (`:222`) | eager decode | attn_backend.init_forward_metadata |
| `DecodeCudaGraphRunner.execute` (`:1299`) | graph 重放 | load_batch + backend.replay |
| `capture_one_shape` (`:1032`) | 捕获一个桶 | backend.capture_one |
| `register_forward_hooks` (`hook_manager.py`) | 挂 hook | JSON 配置 + fnmatch 匹配模块名 |
| `share_input_buffer` (`input_buffers.py:16`) | buffer 共享 | (name,numel,dtype,device) 去重 view |

</details>

## 核心实现

### CUDA Graph 分桶与多 backend

CUDA graph 把 decode 阶段每步的 kernel launch 开销从 ~100us 降到 ~10us 级——decode 每 req 只生成 1 token，计算量小但 launch 开销占比高。分桶策略（`base_cuda_graph_runner.py:61` `get_batch_sizes_to_capture`）：按配置的 `capture_bs`（如 1,2,4,…,256）经 attn_tp/cp 对齐约束过滤，运行时 `_pad_to_bucket`（`:134`）把实际 bs 向上取整到最近桶，多出位置用 sentinel 填充。三种后端各有取舍：`FullCudaGraphBackend` 整图捕获 padding 到桶；`BreakableCudaGraphBackend`（BCG）可中断分段；`TcPiecewiseCudaGraphBackend` 用 torch compile 分段。EagerRunner 永远先于 cuda graph runner 构建——其 static buffer 先注册成 canonical，后续 runner 经 `share_buffers()` 返回同地址 view，保证捕获与重放 `data_ptr` 相同（这是 cuda graph 正确性前提，`cuda_graph_setup.py:103`）。

### Hook 配置驱动

`hook_manager.py` 是函数式而非类：`register_forward_hooks`（`:11`）从 `server_args.forward_hooks`（JSON）取 hook_specs，用 `fnmatch` 模式匹配模块名（如 `model.layers.*.mlp`），`resolve_callable` 动态 import hook 工厂（支持 `module.path:func` 或 `module.path.func`），挂 PyTorch `register_forward_hook`。优势：不修改模型代码即可注入调试/分析逻辑；hook 只在 eager 路径触发（cuda graph replay 不跑 Python hook），不影响重放性能；与 PyTorch 原生 hook 无缝集成。

### ForwardContext 全局上下文

attention layer、KV cache 操作在模型深层，若把 `attn_backend`/`token_to_kv_pool`/`req_to_token_pool` 逐层传参会污染所有模型签名。`ForwardContext`（`forward_context.py:35`）用模块级全局变量 `_current` + context manager：`ModelRunner._forward_raw` 进 `with forward_context(...)` 发布，深层经 `get_attn_backend()` 取用。docstring（`:17-20`）说明用普通模块级变量（非 thread-local）安全，因为每 worker 进程单线程同步 forward；若将来多线程共享进程需迁 `contextvars.ContextVar`。这让模型层签名稳定在 `forward(input_ids, positions, forward_batch)` 三参数。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| CUDA graph 捕获-重放 | `decode_cuda_graph_runner.py` + `runner_backend/` | Strategy(BaseCudaGraphBackend) + Template Method(BaseCudaGraphRunner) |
| Hook（配置驱动非继承） | `hook_manager.py` + `cuda_graph_setup.py:196` | JSON 配置注入，eager-only 不影响 graph |
| Mixin | `ForwardBatch(ForwardBatchDeepSeekMHAMixin)` | 按模型架构选择性扩展字段 |
| 全局上下文 | `ForwardContext` (`forward_context.py:35`) | 免逐层传参，模型签名稳定 |
| Flyweight | `share_input_buffer` (`input_buffers.py:16`) | 跨 runner 共享 buffer，graph data_ptr 一致 |
| 三路分发 Strategy | `_forward_raw` (`:1593`) | cuda graph / prefill graph / eager |

## 模块间交互

向上与 `managers`：`TpModelWorker`（`managers/tp_worker.py:298`）是唯一调用方，持有 `ModelRunner`，`forward_batch_generation`→`ForwardBatch.init_new`→`ModelRunner.forward`→`sample`。向下与 `layers`/`models`：EagerRunner 与 cuda graph runner 都最终调 `model_runner.model.forward(input_ids, positions, forward_batch)`；模型内 `RadixAttention` 层经 `ForwardContext` 取 backend 与 KV pool。与 `mem_cache`：`ForwardBatch` 借用 `out_cache_loc`（KV slot 索引，`:427`），attention backend 经 `ForwardContext.get_token_to_kv_pool()` 取池，`set_kv_buffer` 写入、`get_key_buffer` 读取。与 `sgl-kernel`：attention 层（如 DeepSeek chunked prefix cache）调 sgl-kernel 的 Triton/CUDA op（`forward_batch_deepseek_mha_mixin.py:78`），`ModelRunner` 不直接调 kernel。与 `speculative`：spec worker 复用 `ModelRunner.forward` 做 verify（`is_verify=True` 让 TpWorker 跳过 sampling，spec worker 自己 `eagle_sample`）。

## 扩展方式

新增自定义层 hook：写 `my_hooks.py` 的 `def norm_hook(config): def fn(module,input,output): ...; return fn`，在 server args 配 `--forward-hooks '[{"name":"norm","target_modules":["model.layers.*.mlp"],"hook_factory":"my_hooks:norm_hook","config":{}}]'`，无需改 model_executor 代码。加 cuda graph 分桶：配 `--cuda-graph-config '{"decode":{"bs":[1,2,4,8,16,32,64]}}'`，新 backend 类型则在 `runner_backend/` 继承 `BaseCudaGraphBackend` 实现 `capture_one`/`replay`。改 ForwardBatch 加字段：在 `forward_batch_info.py:412` 加声明 + `init_new`（`:739`）构建赋值；若是 GPU 张量且参与 cuda graph，在 `decode_cuda_graph_runner` 的 `capture_prepare`/`load_batch` 加拷贝并注册 buffer；DeepSeek MHA 相关放 `forward_batch_deepseek_mha_mixin.py`。新增 ForwardMode：扩 `ForwardMode`（`:98`）+ `is_*()` 谓词 + `_forward_raw` 分支 + `EagerRunner.execute` 的 `_execute_xxx`。扩展点契约见概览「核心概念」。
