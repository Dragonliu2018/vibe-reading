---
source:
  type: "源码解读"
  project: "sglang"
  url: "https://github.com/sgl-project/sglang"
title: "Entry Points"
date: "2026-08-09T23:30:00+08:00"
category: [AI, Infra, Inference, SGLang, CodeWiki, "0.5.17"]
tags: ["SGLang", "entrypoints", "Engine", "FastAPI", "ZMQ IPC"]
description: "SGLang 接口层：Engine 装配三进程、HTTP/gRPC/OpenAI 兼容 API、ASGI 中间件与子进程监控。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/SGLang/CodeWiki/0.5.17/00-overview)

---

## 模块定位

entrypoints 是 SGLang 与外部世界的边界。它负责两件事：**进程装配**（把 TokenizerManager、Scheduler、DetokenizerManager 三个组件按进程拓扑拉起来）和**协议适配**（把 HTTP/OpenAI/Anthropic/Ollama/gRPC 等外部协议，统一翻译成内部 `GenerateReqInput` 并交给编排层）。它不碰 GPU、不做调度——这些都在它装配出来的子进程里。它是整个系统的"启动器 + 协议网关"。

## 模块架构

![模块架构](/vibe-reading/images/articles/sglang-internals/entrypoints-architecture.svg)

模块内部围绕 `Engine` 组织。`Engine`（`entrypoints/engine.py:199`）继承 `EngineBase`（ABC，定义 generate/flush_cache/update_weights/shutdown 六个抽象方法）并混入 `EngineScoreMixin`（提供 score 能力，与生成逻辑解耦）。`http_server` 用 FastAPI+uvicorn 做网络前端，挂载三类 ASGI 原生中间件（CORS、请求解压、API Key 鉴权）；API 兼容子包 `openai/`、`anthropic/`、`ollama/` 各有 protocol + serving，但最终都委托 `tokenizer_manager.generate_request`。

架构的关键不在"有哪些 handler"，而在**进程边界**：`Engine._launch_subprocesses`（`engine.py:1036`）把 Scheduler 放子进程（`mp.Process`，每 TP rank 一个），DetokenizerManager 也放子进程，TokenizerManager 留主进程与 HTTP server 共享 asyncio 循环。子进程间靠 ZMQ PUSH/PULL/DEALER 通信。`SubprocessWatchdog` + `atexit` + SIGQUIT handler 三重保险防泄漏。这样划分是为了 GPU 资源隔离、GIL 不互相阻塞、以及 NCCL 通信域需要进程级初始化——详见下文设计决策。

## 调用链路

![调用链路](/vibe-reading/images/articles/sglang-internals/entrypoints-call-chain.svg)

两条主路径。**路径 A（流式生成）**：HTTP handler `openai_v1_chat_completions` 收到 `ChatCompletionRequest` → `OpenAIServingChat.handle_request`（`openai/serving_chat.py`）`_convert_to_internal_request` 渲染 chat template 组装 `GenerateReqInput` → 流式走 `_generate_chat_stream` 调 `Engine.generate` → `TokenizerManager.generate_request`（`:754`）做 tokenize + `_dispatch_to_scheduler`（ZMQ PUSH）+ `_wait_one_response`（async generator）。返回路径是 `handle_loop`（asyncio task，`:2159`）从 Detokenizer ZMQ PULL 收 `BatchStrOutput`，`_handle_batch_output` 存入 `state.out_list` 并 `state.event.set()` 唤醒 generator，最终 `stream_results` 转 SSE。**路径 B（控制面 RPC）**：`Engine.collective_rpc` / `update_weights_from_tensor` 构造 `RpcReqInput`，用 `send_to_rpc`（DEALER socket）`sock_send` 后**同步** `sock_recv(flags=BLOCKY)` 等待 Scheduler 返回——区别于路径 A 的异步流式，控制面是请求-响应语义。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|--------------|
| `Engine.__init__` (`engine.py:224`) | 解析 ServerArgs、注册 atexit、调 `_launch_subprocesses` | 工厂 Callable 可被子类覆盖换 Ray 后端 |
| `_launch_subprocesses` (`engine.py:1036`) | 装配三组件 | 复用于 HTTP server 与 Python API 两入口 |
| `Engine.generate` (`engine.py:352`) | 同步生成入口，返回 dict 或 iterator | 委托 tokenizer_manager，不碰 GPU |
| `async_generate` (`engine.py:453`) | 异步流式入口 | AsyncIterator yield |
| `collective_rpc` (`engine.py:1585`) | 同步 RPC 到 Scheduler | DEALER socket，BLOCKY 等待 |
| `update_weights_from_tensor` (`engine.py:1402`) | 热更新权重 | 走 tokenizer_manager→Scheduler 子进程 |
| `_ApiKeyASGIMiddleware` (`utils/auth.py:149`) | API Key 鉴权 | ASGI-native 以保留 client disconnect 事件 |
| `TokenizerManager.generate_request` (`tokenizer_manager.py:754`) | tokenize + 分发 + 等待 | async generator + asyncio.Event |

</details>

## 核心实现

### Engine 进程装配

`Engine.__init__`（`engine.py:224`）先 `load_plugins()`，构造 `ServerArgs`，注册 `atexit.register(self.shutdown)`，然后调 classmethod `_launch_subprocesses`（`engine.py:1036`）。装配流程：`_set_envs_and_config` 设 NCCL/CUDA 环境 → `PortArgs.init_new`（`server_args.py:9518`）分配四组 ZMQ ipc name → `_launch_scheduler_processes`（`:832`）对每个 (pp_rank, tp_rank) 起 `mp.Process(target=run_scheduler_process_func)`，DP>1 时先起 `DataParallelController` → `_launch_detokenizer_subprocesses`（`:950`）→ `init_tokenizer_manager`（`:147`）在主进程实例化 `TokenizerManager` → `scheduler_init_result.wait_for_ready()`（`:1743`）经 `mp.Pipe` 等子进程 ready → `SubprocessWatchdog(processes).start()`。

装配能同时服务两个入口：`http_server.launch_server`（`:2748`）调 `Engine._launch_subprocesses` 拿到 tokenizer_manager 后启动 FastAPI；`sgl.Engine(...)` 直接暴露 `generate()`。维护一条变更只改一处。三个工厂 Callable（`init_tokenizer_manager_func`/`run_scheduler_process_func`/`run_detokenizer_process_func`，`engine.py:216-218`）可被子类覆盖——RayEngine 就是覆盖 `_launch_scheduler_processes` 用 Ray actor 替代 `mp.Process`（`engine.py:842` docstring）。

### 鉴权与中间件

API Key 鉴权刻意做成 **ASGI-native 中间件**而非 FastAPI `Depends`（`utils/auth.py:149` `_ApiKeyASGIMiddleware`）。原因是生成请求可能持续数秒到数十秒，FastAPI Depends 在请求开始后无法感知中途断连，ASGI 层中间件能透传 `receive` channel 的 cancel 事件——这对长连接推理避免"客户端走了、服务还在算"至关重要。CORS、请求解压同理用 `app.add_middleware`。Ollama 路由路径还支持环境变量自定义（`http_server.py:1953`）以避开 OpenAI 路由冲突。

### 多 API 兼容层

OpenAI/Anthropic/Ollama 三个子包各有 `protocol.py`（Pydantic 模型）+ `serving.py`（转换逻辑），但都委托同一个 `tokenizer_manager.generate_request`。Anthropic 甚至直接包装 `openai_serving_chat`（`http_server.py:337-339`）复用 OpenAI chat 逻辑。这种"协议翻译 + 统一后端"让用户用现有客户端（LangChain、Ollama CLI、Anthropic SDK）零改动接入。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Mixin | `Engine(EngineScoreMixin, EngineBase)` (`engine.py:199`) | Engine 1827 行已很大，score 域独立 mixin 解耦 |
| 工厂+模板方法 | `_launch_subprocesses` + 三个可覆盖 Callable (`engine.py:216-218`) | 同套装配逻辑服务本地 mp.Process 与 Ray 后端 |
| ABC 模板方法 | `EngineBase` (`EngineBase.py:7`) 六抽象方法 | HTTP engine 与 Python API engine 统一契约 |
| ASGI 中间件 | CORS/Decompression/ApiKey (`http_server.py:460`) | 保留 client disconnect 事件，长连接安全 |
| 策略 | 单/多 tokenizer、Rust/Python server 分支 (`http_server.py:2548`) | 配置项切换而非代码分支爆炸 |
| 全局单例 | `_GlobalState` + `set_global_state` (`http_server.py:198`) | FastAPI 路由是模块函数，无法 DI，用模块级全局 |

## 模块间交互

entrypoints 向下依赖 `managers`：`Engine` 持有 `TokenizerManager`（主进程内直接引用，`engine.py:277`），经 ZMQ 与 Scheduler/Detokenizer 子进程通信。`Engine.generate` → `tokenizer_manager.generate_request` 是同进程 Python 调用（无 IPC），之后 `tokenizer_manager._dispatch_to_scheduler` 才跨进程 ZMQ PUSH。被依赖方：`http_server.launch_server` 被 CLI `sglang serve` 调用；`Engine` 类被 `sglang.Engine` 直接暴露给 Python API 用户。进程边界与 IPC 细节（ipc:// vs tcp://、msgpack 序列化、mp.Pipe 就绪同步）见概览「运行时行为 > 启动流程」与 [02-managers](./02-managers)。

## 扩展方式

新增一个 API 兼容层（如 Gemini）：新建 `entrypoints/gemini/{protocol,serving}.py`（`GeminiServing` 委托 `tokenizer_manager.generate_request`）→ `http_server.py` import + `lifespan` 初始化 + 注册路由。参考 `anthropic/serving.py` 包装 OpenAI 的模式。新增鉴权方式改 `utils/auth.py:149` 的 `add_api_key_middleware`，注意必须保持 ASGI-native。新增 HTTP 中间件在 `http_server.py:460` 后 `app.add_middleware`，考虑洋葱模型执行顺序。扩展点的契约（`EngineBase`）见概览「核心概念 > 核心抽象」。
