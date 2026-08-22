---
source:
  type: "源码解读"
  project: "vLLM"
  url: "https://github.com/vllm-project/vllm"
title: "V1 引擎"
date: "2026-08-22T18:02:27+08:00"
category: [AI, Infra, Inference, vLLM, CodeWiki, "0.27.1"]
tags: ["vLLM", "V1 引擎", "多进程", "ZMQ", "asyncio", "EngineCore"]
description: "解读 vLLM V1 引擎模块：AsyncLLM 与独立进程的 EngineCoreProc 通过 ZMQ 通信，用多进程 actor 模型解耦 asyncio IO 与 GPU 计算。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/vLLM/CodeWiki/0.27.1/00-overview)

---

## 模块定位

V1 引擎模块（`vllm/v1/engine/`）是 vLLM v0.27.1 的默认引擎核心。它解决一个核心矛盾：**LLM serving 既需要高吞吐的 GPU 计算，又需要低延迟的并发响应**。V0 把调度与执行放在同一进程，asyncio 事件循环会被持有 GIL 的 GPU forward 阻塞，导致所有并发请求卡顿。V1 用多进程 actor 模型——前端进程跑 asyncio 服务循环，独立进程跑引擎核心的 busy loop——把两者彻底解耦。`vllm/engine/llm_engine.py` 已退化为对 `vllm.v1.engine.llm_engine.LLMEngine` 的别名，V1 即默认。

## 模块架构

![V1 引擎模块架构](/vibe-reading/images/articles/vllm/01-v1-engine.svg)

模块分两半：**前端进程**持有 `AsyncLLM`（面向客户端的异步入口）、`InputProcessor`（构造 `EngineCoreRequest`）与 `OutputProcessor`（detokenize + 产出 `RequestOutput`）；**EngineCore 子进程**持有 `EngineCoreProc`（ZMQ 包装），内含 `EngineCore`（调度+执行编排，持有 `Scheduler` 与 `model_executor`）。两边用 ZMQ socket 双向通信：请求走 ROUTER→DEALER，输出走 PUSH→PULL，全部 msgpack 编码。`InputProcessor`/`OutputProcessor` 留在前端而非 EngineCore，是因为 detokenize 是纯 CPU 工作，放前端可避免占用 EngineCore 的 GPU 迭代间隙、且能在 asyncio 里按块分摊。

## 调用链路

一次 `AsyncLLM.generate()` 的完整调用链横跨两个进程：

```
[前端进程 / asyncio]
AsyncLLM.generate()                              # async_llm.py:544
└─ add_request()                                 # async_llm.py:283
   ├─ InputProcessor.process_inputs() → EngineCoreRequest   # async_llm.py:354
   ├─ OutputProcessor.add_request()             # 注册 RequestState + queue
   └─ AsyncMPClient.add_request_async()          # async_llm.py:432
      └─ input_socket.send_multipart()            # ZMQ ROUTER → EngineCore
└─ while not finished: q.get() → yield RequestOutput

[EngineCore 子进程]
process_input_sockets 线程                        # core.py:1645
└─ ZMQ DEALER recv → input_queue
run_busy_loop()                                  # core.py:1378
└─ _process_engine_step() → EngineCore.step()    # core.py:584
   ├─ scheduler.schedule() → SchedulerOutput
   ├─ model_executor.execute_model(non_block=True) → Future
   ├─ scheduler.get_grammar_bitmask()
   ├─ future.result() → ModelRunnerOutput
   └─ scheduler.update_from_output() → EngineCoreOutputs
process_output_sockets 线程                       # core.py:1743
└─ output_queue → ZMQ PUSH → 前端
```

数据类型沿链路变化：`EngineInput` → `EngineCoreRequest`（msgspec 结构，跨进程序列化）→ `SchedulerOutput`（调度决策）→ `ModelRunnerOutput`（采样结果）→ `EngineCoreOutputs`（msgspec 批量输出）→ `RequestOutput`（前端 detokenize 后的最终输出）。跨进程边界用 ZMQ + msgpack，跨进程传递的是序列化消息而非 Python 对象引用。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `AsyncLLM.generate` | async 生成器，yield RequestOutput | per-request queue + output_handler 后台拉取 |
| `AsyncLLM.add_request` | 注册请求到 input/output processor | 返回 RequestOutputCollector |
| `EngineCore.step` | 一次调度+执行+输出更新 | `execute_model(non_block=True)` 返回 Future |
| `EngineCore.step_with_batch_queue` | PP>1 的流水线版本 | batch_queue 异步多 batch 消除 bubble |
| `EngineCoreProc.run_busy_loop` | 子进程忙循环 | 阻塞式，非 asyncio |
| `AsyncMPClient.get_output_async` | 从 asyncio.Queue 取输出 | ZMQ PULL + msgpack 反序列化 |
| `OutputProcessor.process_outputs` | detokenize + 产出 RequestOutput | 按 `VLLM_V1_OUTPUT_PROC_CHUNK_SIZE` 分块 |

</details>

## 核心实现

### AsyncLLM 与 EngineCore 的进程边界

`AsyncLLM`（`async_llm.py:72`）继承 `EngineClient` 协议，是 API server 直接调用的入口。它的 `generate()` 是 async 生成器：先 `add_request()` 把请求序列化发给 EngineCore 并注册一个 `RequestOutputCollector`（基于 `asyncio.Event` 的单槽队列），然后循环 `await q.get()` yield 输出。与此同时，一个后台 `output_handler` 协程（`async_llm.py:676`）持续从 `AsyncMPClient.get_output_async()` 拉取 `EngineCoreOutputs`，调 `OutputProcessor.process_outputs()` 处理后推入各请求的 collector。

为什么是两个对象而非一个：`AsyncLLM` 跑在前端的 asyncio 事件循环里，负责协议适配与流式 yield；`EngineCore` 跑在独立进程，持有 GPU 资源与调度器。两者职责正交，用消息而非调用耦合，GPU 计算因此无法阻塞 asyncio。`EngineCoreClient.make_client()`（`core_client.py:90`）按 `multiprocess_mode` 与 `asyncio_mode` 选 `InprocClient`（同进程，离线用）/`SyncMPClient`/`AsyncMPClient`（在线用）。

### 多进程与 ZMQ IPC

`EngineCoreProc`（`core.py:1008`）是 `EngineCore` 的 ZMQ 包装，由 `CoreEngineProcManager`（`engine/utils.py:120`）通过 `multiprocessing.Process(target=EngineCoreProc.run_engine_core)` fork。fork 发生在 `MPClient.__init__` 调 `launch_core_engines()`（`utils.py:1054`）时，DP 场景下每个 DP rank 一个 EngineCore 进程。

EngineCoreProc 内部有两个 daemon 线程：`process_input_sockets`（ZMQ DEALER recv → `input_queue`）与 `process_output_sockets`（`output_queue` → ZMQ PUSH send）。主线程的 `run_busy_loop` 从 `input_queue` 取请求、调 `step()`、把输出放 `output_queue`。注释明确写道："overlap ZMQ socket IO with GPU since they release the GIL"（`core.py:1093`）。选 ZMQ 而非 `multiprocessing.Queue`，是因为 ZMQ socket recv/send 在等待时释放 GIL，能多路复用，且序列化开销更可控。

### 输出处理与异步分摊

`OutputProcessor`（`output_processor.py:429`）的 `process_outputs` 对每个 `EngineCoreOutput` 做：更新统计 → `IncrementalDetokenizer.update(new_token_ids)` 增量反 token 化 → 检测 stop string → 构造 `RequestOutput` 推入 per-request queue。增量 detokenizer（`detokenizer.py:42`）每次只处理新 token，避免重复解码全部历史；有 `FastIncrementalDetokenizer`（基于 tokenizers 库 `DecodeStream`）与 `SlowIncrementalDetokenizer` 两实现，按 tokenizers 版本自动选。

关键设计是 `output_handler` 的**分块让出**：一次 EngineCore 迭代可能产出整个 batch 的 token，若一次性处理会长时间占用事件循环。`output_handler` 按 `VLLM_V1_OUTPUT_PROC_CHUNK_SIZE`（默认 128）分块，每块后 `await asyncio.sleep(0)` 让出控制权（`async_llm.py:702`），保证其他请求的 `generate()` 能及时 yield。

### 容错与优雅关闭

错误传播路径清晰：Worker GPU 错误（如 OOM）→ `EngineCore.step` 捕获 → `run_engine_core` 的 except 发 `ENGINE_CORE_DEAD` 信号 → `MPClient.validate_alive` 设 `engine_dead=True` → `AsyncLLM.output_handler` 的 except 调 `OutputProcessor.propagate_error` → 把异常推入各请求 queue → `generate()` 抛出。`generate()` 中区分 `EngineDeadError`（不可恢复）、`VLLMClientError`（请求错误）等分别处理。`_handle_shutdown`（`core.py:1380`）支持 REQUESTED 状态下按 timeout 选 abort（立即中止）或 drain（等待完成）模式。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Actor | `EngineCoreProc` in `core.py:1008` | 引擎核心独占进程，靠消息通信，GPU 不阻塞前端 |
| 生产者-消费者 | `input_queue`/`output_queue` in `core.py:1027` | IO 线程与 busy loop 解耦，重叠 IO 与 GPU |
| 策略 | `EngineCoreClient.make_client` in `core_client.py:90` | 按同步/异步/多进程选 client 实现 |
| 异步分摊 | `output_handler` in `async_llm.py:676` | 分块处理避免长时间阻塞事件循环 |
| Finalizer | `BackgroundResources` in `core_client.py:406` | `weakref.finalize` 清理子进程，避免循环引用 |

## 模块间交互

引擎层向下调用 `v1/core` 的 `Scheduler`（`EngineCore.step` 调 `scheduler.schedule()` 与 `update_from_output()`）与 `v1/executor` 的 `model_executor`（`execute_model`）。`Scheduler` 类通过 `vllm_config.scheduler_config.get_scheduler_cls()` 动态获取，`executor_class` 由上层传入。向上被 `entrypoints` 依赖——serving handler 只依赖 `EngineClient` ABC（`engine/protocol.py`），不感知 `AsyncLLM` 内部。离线 `LLMEngine` 与在线 `AsyncLLM` 共享 EngineCore，只是 client 类型不同。

## 扩展方式

新增 utility method（如运行时配置热更新）：在 `EngineCore` 类加方法（`core.py`），无需改通信层——`_handle_client_request` 的 `UTILITY` 分支用 `getattr(self, method_name)(*args)` 反射分发（`core.py:1527`），前端调 `engine_core.call_utility_async("method", args)` 即可。修改输出后处理逻辑：在 `OutputProcessor.process_outputs`（`output_processor.py:589`）的 detokenize 后、`make_request_output` 前插入自定义逻辑。
