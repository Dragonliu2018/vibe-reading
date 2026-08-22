---
source:
  type: "源码解读"
  project: "xLLM"
  url: "https://github.com/jd-opensource/xllm"
title: "服务接口层"
date: "2026-08-22T17:19:22+08:00"
category: [AI, Infra, Inference, xLLM, CodeWiki, "0.10.1"]
tags: ["xLLM", "brpc", "OpenAI API", "pybind"]
description: "xLLM 服务接口层解读：APIService 的 OpenAI/Anthropic 兼容 API、brpc HTTP 服务注册、C/Python 绑定。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/xLLM/CodeWiki/0.10.1/00-overview)

---

## 模块定位

服务接口层是 xLLM 与外部世界的边界。它把 HTTP/brpc 请求转化为引擎可消费的 `RequestParams`，再把 `RequestOutput` 序列化回 HTTP 响应。这层存在的核心理由是**协议隔离**：OpenAI API 格式会演进、Anthropic 格式不同、C API 与 Python API 的调用约定各异，把它们集中在一层处理，引擎层（Master/Engine/Scheduler）就无需感知任何外部协议细节。该层包含 `api_service/`（HTTP/brpc 实现）、`server/`（服务注册）、`c_api/`（C 接口）、`cc_api/`（C++ 接口）、`pybind/`（Python 绑定）与 `proto/`（协议定义）。

## 模块架构

服务接口层内部按"协议适配 → 服务实现 → 绑定出口"组织：

- **APIService**（`api_service/api_service.h`）是 brpc 服务总入口，继承 `proto::XllmAPIService`，为每个端点同时提供 `XxxHttp`（HTTP）与 `Xxx`（brpc 强类型）两个重载。它持有 `Master*`，但不直接调度——而是转发到具体 ServiceImpl。
- **ServiceImpl 族**（`chat_service_impl`/`completion_service_impl`/`embedding_service_impl`/`image_generation_service_impl`/`audio_generation_service_impl`/`rerank_service_impl`/`sample_service_impl`/`rec_completion_service_impl`）：每种业务（Chat/Completion/Embed/...）一个 Impl，负责请求解析、参数校验、调用 `Master::handle_request`、流式输出组装。`AnthropicServiceImpl` 专门适配 Anthropic Messages API 格式差异。
- **server/`XllmServerRegistry`**（`server/xllm_server_registry.cpp`）：注册表模式，按名创建 HTTP server（如 `"HttpServer"`），`start()` 接收 `APIService` 启动 brpc。
- **pybind/bind.cpp + pybind/llm.py**：pybind11 绑定导出 `Options`/`LLMMaster`/`RequestOutput`/`RequestParams` 等 C++ 类，Python 层 `LLM` 类（`pybind/llm.py`）封装高层 API（`generate`/`embed`/`chat`），供离线推理与测试使用。
- **c_api/llm.h**：C 语言接口，供外部 C 程序直接调用推理。

## 调用链路

以 `POST /v1/chat/completions` 为例，HTTP 请求到 Master 的链路：

```text
HTTP 请求
  └─ APIService::ChatCompletionsHttp()         in api_service/api_service.cpp
       ├─ ChatServiceImpl::HandleChatRequest()  in api_service/chat_service_impl.cpp
       │    ├─ 解析 ChatRequest → RequestParams (messages, sampling, stream)
       │    ├─ ChatTemplate::apply(messages)    组装 prompt
       │    └─ master->handle_request(messages, prompt_tokens, sp, call, callback)
       │         in distributed_runtime/llm_master.cpp
       │         └─ threadpool_->schedule( tokenize → generate_request → scheduler_->add_request )
       └─ callback(RequestOutput) → JSON 序列化 → HTTP 响应（流式/非流式）
```

`APIService` 为每个端点提供 `Xxx` 与 `XxxHttp` 两个入口：brpc 强类型入口供内部 RPC 调用（如 PD 分离时跨实例通信），HTTP 入口供外部客户端。两者共享 `ServiceImpl` 的核心逻辑。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `APIService::ChatCompletionsHttp` | HTTP Chat 入口 | 委托 ChatServiceImpl，支持流式 SSE |
| `ChatServiceImpl::HandleChatRequest` | 解析+校验+转发 Master | 共享 call/callback 机制 |
| `CompletionServiceImpl` | 文本补全（无 system prompt 组装） | 复用 Master::handle_request(prompt) |
| `EmbeddingServiceImpl` | 向量编码 | task_type="embed"，走 EmbeddingWorker |
| `AnthropicServiceImpl` | Anthropic Messages 格式适配 | 字段名/流式格式差异转换 |
| `ImageGenerationServiceImpl` | DiT 图像生成 | backend="dit"，走 DiTMaster |
| `APIService::do_fork_master` | 热扩容：fork 新 Master | 运行期创建新实例 |
| `APIService::do_sleep/do_wakeup` | 实例休眠/唤醒 | 转发 Master::sleep/wakeup |

</details>

## 核心实现

### ServiceImpl 委托与流式回调

`APIService` 本身不做业务逻辑，而是持有各 `ServiceImpl` 的 `unique_ptr`，将请求委托下去。`ChatServiceImpl::HandleChatRequest` 完成 Chat 请求的完整处理：它解析 `ChatRequest` 中的 `messages` 与 `RequestParams`，构造 `OutputCallback`（流式时每次 token 回调、非流式时末次回调），再调 `master->handle_request`。

```cpp title="api_service/api_service.h"
class APIService : public proto::XllmAPIService {
  Master* master_;
  std::unique_ptr<ChatServiceImpl> chat_service_impl_;
  std::unique_ptr<EmbeddingServiceImpl> embedding_service_impl_;
  std::unique_ptr<ImageGenerationServiceImpl> image_generation_service_impl_;
  std::unique_ptr<AnthropicServiceImpl> anthropic_service_impl_;
  // ... 每种业务一个 Impl
  std::unordered_map<std::string, Master*> masters_;  // fork 后多 Master
};
```

设计决策：**为什么用 Impl 委托而非 APIService 直接实现**？因为每种业务（Chat/Embed/ImageGen/...）的参数解析与输出格式差异大，集中在一个类会过于臃肿。委托给独立 Impl 后，新增端点只需加一个 Impl，`APIService` 仅做路由。`AnthropicServiceImpl` 尤其典型——Anthropic 的流式格式（`event: content_block_delta`）与 OpenAI 不同，独立 Impl 隔离这层差异。

### 热扩容与休眠唤醒

`APIService` 还承载实例级生命周期管理：`ForkMaster` 在运行期创建新的 `Master` 实例（不重启进程），`Sleep`/`Wakeup` 让实例释放/恢复显存。这些通过 `do_fork_master`/`do_sleep`/`do_wakeup` 辅助方法实现，返回错误信息供 HTTP 与 brpc 共用。这使 xLLM 支持弹性扩缩容——高峰时 fork 更多实例，低谷时 sleep 释放资源。

### Python 绑定

`pybind/bind.cpp` 用 pybind11 导出核心 C++ 类，`pybind/llm.py` 的 `LLM` 类封装高层 API：

```python title="pybind/llm.py"
class LLM:
    def __init__(self, model, task="generate", devices="npu:0", ...):
        # 构造 Options + LLMMaster，启动推理引擎
    def generate(self, prompts, sampling_params=None, ...):
        # 调用 master.handle_batch_request，同步返回结果
```

Python API 是 C++ Master 的薄封装，供离线推理、评测脚本与测试使用。在线服务则走 HTTP/brpc 路径。这种"双出口"设计让同一引擎既可做在线服务，也可做离线 SDK。

## 扩展方式

新增一个 API 端点需：
1. 在 `proto/xllm_service.proto` 定义请求/响应 message 与 RPC 方法
2. 在 `api_service/` 新建 `xxx_service_impl.h/.cpp`，继承对应基类，实现请求解析与 `master->handle_request` 调用
3. 在 `APIService` 增加该端点的 `Xxx`/`XxxHttp` 重载，持有新 Impl
4. 若有 Python 需求，在 `pybind/` 增加高层封装
