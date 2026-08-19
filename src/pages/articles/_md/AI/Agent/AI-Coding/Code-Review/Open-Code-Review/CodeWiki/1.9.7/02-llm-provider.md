---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "LLM 提供商抽象"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "LLM", "Provider", "Retry"]
description: "OpenCodeReview LLM 提供商抽象层——~25 家内置 provider、三种 API 协议（Chat/Anthropic/Responses）、4 策略端点解析、重试三件套、token 用量统一抽取、API key 从命令动态解析。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/llm/`（约 4,550 行，是项目最大的模块，被 19 个文件 import）是 LLM 调用的唯一出口。它是一个**纯叶子模块**——不依赖 `internal/` 下任何包，只依赖外部 SDK（`anthropic-sdk-go`、`openai-go/v3`、`tiktoken-go`）和标准库。它把「多 provider、多 API 协议、重试、token 统计、密钥解析」全部封装在 `LLMClient` 接口后，对上层只暴露 `ChatRequest`/`ChatResponse` 统一类型，使审查引擎无需感知具体 provider 差异。

## 模块架构

```
internal/llm/
├── client.go           # LLMClient 接口 + 三 client 构造 + ChatRequest/Response/Message
├── providers.go        # 内置 provider 注册表（registry 切片 + init map）
├── resolver.go         # 4 策略端点解析 → ResolvedEndpoint
├── responses_client.go # OpenAI Responses API client（GPT-5.x/o-series）
├── retry_report.go     # RetryCollector → 不可变 RetryReport
├── retry_meta.go       # RequestMeta（请求身份：provider/model/file/taskType/requestNo）
├── retry_boundary.go   # finalizeRequest/reviseAttempt（修正 HTTP 200 后暴露的错误）
├── retry_observer.go   # HTTP middleware（SDK retry 循环内记录 attempt）
├── usage_resolver.go   # token 用量多 JSON path 探测
├── keycmd.go           # api_key/auth_token 从命令解析
├── keycmd_unix.go      # sh -c（保持 tty 交互）
├── keycmd_windows.go   # cmd.exe /S /C
├── sessionkey.go       # prompt-cache affinity key 派生
├── embedded_loader.go  # go:embed tiktoken BPE 数据，离线 CountTokens
└── protocol.go         # Protocol 常量与校验
```

核心组件：`Provider` 注册表（`providers.go`）、`Resolver` 端点解析器（`resolver.go`）、三个 `LLMClient` 实现（`client.go`+`responses_client.go`）、重试三件套（`retry_*`）、密钥解析器（`keycmd_*`）。它们通过 `ResolvedEndpoint` 这一中间 DTO 串联：resolver 解析出端点 → `NewLLMClient` 按 `Protocol` 分发到具体 client。

## 调用链路

一次 LLM 调用的链路：

```
ResolveEndpointWithOptions(ResolveOptions{Provider,Model})   # resolver.go
  ├─ tryOCRConfig → tryOCREnv → tryCCEnv → tryShellRC        # 4 策略，首个 URL+Token+Model 齐全者
  └─ finalizeResolvedEndpoint → ResolvedEndpoint{URL,Token,Model,Protocol,AuthHeader,...}

NewLLMClient(ep, retryCollector)                              # client.go
  └─ switch ep.Protocol → NewAnthropicClient / NewOpenAIResponsesClient / NewOpenAIClient(默认)

client.CompletionsWithCtx(ctx, ChatRequest{Model,Messages,Tools,...}) → *ChatResponse
  ├─ defer finalizeRequest                                      # retry_boundary：修正 last attempt → Finalize outcome
  ├─ buildXxxParams(req)                                        # 共享 ChatRequest → provider SDK 参数
  ├─ expandSessionKeyInHeaders/Body                             # sessionkey.go：{ocr_session_key} 占位替换
  ├─ sdk.Chat.Completions.New / Messages.New / Responses.New   # HTTP 调用（SDK 自带 5 次 retry + retryObserver middleware）
  ├─ mapXxxResponse(sdkResp) → ChatResponse                      # 含 resolveUsage 从原始 JSON 抽 token
  └─ retryObserver 记录每 attempt → RetryCollector.RecordAttempt
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `ResolveEndpointWithOptions` (`resolver.go`) | 4 策略解析端点 | 首个齐全者返回，避免逐个试错浪费 |
| `NewLLMClient` (`client.go`) | 按 Protocol 分发 client | 工厂模式，共享上层类型 |
| `CompletionsWithCtx` (各 client) | 执行 LLM 调用 | `defer finalizeRequest` 保证所有退出路径终结重试报告 |
| `resolveUsage` (`usage_resolver.go`) | 抽 token 用量 | 多 JSON path 探测，区分 Anthropic cache token 与 OpenAI cached_tokens |
| `resolveKeyCmd` (`keycmd.go`) | 从命令解析密钥 | deferred 到 cheap validation 后执行；cappedBuffer 64KiB 防 `cat /dev/urandom` |
| `RetryCollector.Freeze` (`retry_report.go`) | 构建不可变报告 | 5 条 outcome 优先级规则防 last attempt 误导 |
</details>

## 核心实现

### Provider 注册与端点解析

`providers.go` 用硬编码 `[]Provider` 切片（含 Anthropic、OpenAI、Gemini、DashScope、DeepSeek、Kimi、xAI、LiteLLM 等约 25 家），`init()` 构建 `registryMap` 实现快速 lookup。`copyProvider` 防调用方修改内部 `Models` 切片。preset provider 从 registry 拿默认 `BaseURL`/`Protocol`/`AuthHeader`，用户 config 可 override；custom provider 必须自带 `url`+`protocol`。这样 preset 降低配置门槛，custom 保留灵活性。

`resolver.go` 的 `ResolveEndpointWithOptions` 按 `tryOCRConfig → tryOCREnv → tryCCEnv → tryShellRC` 四策略优先级尝试，首个 `URL+Token+Model` 齐全者经 `finalizeResolvedEndpoint` 返回 `ResolvedEndpoint`。

### 三种 API 协议分流

`NewLLMClient` 按 `ResolvedEndpoint.Protocol` switch 分发：Anthropic 走 `AnthropicClient`（Messages API `/v1/messages`）；OpenAI Responses 走 `OpenAIResponsesClient`（`/v1/responses`，stateless，`store=false`，`PromptCacheKey` 从 `req.SessionID` 派生）；其余走 `OpenAIClient`（Chat Completions `/v1/chat/completions`）。Responses API 是 GPT-5.x/o-series 的新协议，语义不同（`Instructions` 而非 system message、`function_call`/`function_call_output` item 而非 tool role），需独立 client 但共享上层 `ChatRequest`/`ChatResponse` 以保持调用方透明。

### 重试三件套

重试体系分三层职责，避免单点逻辑需同时理解 SDK 内部状态和业务语义：

- **`retryObserver`**（`retry_observer.go`）：HTTP middleware，注入 SDK retry 循环内，每次 HTTP attempt 调 `RetryCollector.RecordAttempt`。但只能看到 HTTP 状态码和 transport error，看不到 body decode 后的错误。
- **`finalizeRequest`/`reviseAttempt`**（`retry_boundary.go`）：在 client 返回后修正 HTTP 200 后才暴露的错误（EOF、stream 中断、Responses 非 terminal status）。三个 client 的 `CompletionsWithCtx` 都 `defer finalizeRequest`。
- **`RetryCollector.Freeze`**（`retry_report.go`）：run 结束后构建不可变 `RetryReport`，`validateReport` 交叉校验所有聚合数。`Finalize` 的 5 条 outcome 优先级规则（no attempt→no record；parent cancelled→cancelled；reqErr→failed；success+error attempt→recovered；clean→succeeded）确保 outcome 不被 last attempt 误导——例如 cancel 发生在 backoff 期间时 last attempt 是 error，但 outcome 应为 cancelled。

### API key 从命令动态解析

`keycmd.go` 的 `resolveKeyCmd` 执行用户配置的 `api_key_cmd`/`auth_token_cmd` shell 命令获取 credential。关键设计：命令执行被 **deferred** 到所有 cheap validation 之后（`tryProviderConfig` 第 504 行），避免 config typo 触发 1Password/pinentry prompt 后再失败丢弃 credential；`cappedBuffer`（64KiB）防止 `cat /dev/urandom` 撑爆内存；`WaitDelay` 处理 grandchild 进程继承 stdout pipe 导致 `Wait` 永久阻塞；平台特定 `newKeyCmd`——Unix 用 `sh -c`（不用 `Setpgid` 以保持 tty 交互），Windows 用 `cmd.exe /S /C`（通过 `SysProcAttr.CmdLine` 绕过 `syscall.EscapeArg` 引号转义）。

### Token 用量统一抽取

`usage_resolver.go` 的 `resolveUsage` 定义多组 JSON path（`usage.prompt_tokens`、`prompt_tokens`、`data.usage.prompt_tokens`、`usage.input_tokens` 等），`probePathIndex` 按序探测首个命中。`anthropicCacheReadPathCount`/`anthropicCacheWritePathCount` 区分 Anthropic 风格的 cache token（需加到 total）和 OpenAI 风格的 `cached_tokens`（已包含在 `prompt_tokens` 中）。不同 provider/代理层返回的 JSON 结构差异大，path 表 + 首中策略避免为每家 provider 写专用 parser。

### 内嵌 BPE 与 session key

`embedded_loader.go` 通过 `go:embed bpe_data/*.tiktoken` 将 tiktoken 的 BPE 编码数据（`cl100k_base`、`o200k_base`、`p50k_base`、`r50k_base`）嵌入二进制，`InitEmbeddedLoader` 在 `main.go` 启动时调用 `tiktoken.SetBpeLoader`，消除运行时从 OpenAI 公网拉取 BPE 数据的网络依赖，确保离线环境 `CountTokens` 可用。`sessionkey.go` 的 `SessionTaskKey(sessionKey, taskType, scope)` 按 (session, task type, file) 粒度派生 prompt-cache affinity key——prompt cache 按前缀匹配，全 run 共享一个 key 会将不相关对话 pin 到同一 cache node，按 task 粒度切分使每条对话的 growing prefix 落在一致节点上。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表 | `providers.go` `registry`+`registryMap` | 静态 provider 注册，`LookupProvider`/`ListProviders` 查询 |
| 工厂 | `client.go` `NewLLMClient` | 按 Protocol 分发，`ClientConfig` 作中间 DTO |
| 策略 | 三协议各有 `buildParams`+`mapResponse`+`CompletionsWithCtx` | 共享接口，独立实现 |
| 观察者 | `retry_observer.go` `newRetryObserver` | HTTP middleware 注入 SDK retry 循环记录 attempt |
| 命令 | `keycmd.go` `resolveKeyCmd` | credential 获取抽象为 shell 命令执行 |
| 模板方法 | `retry_boundary.go` `finalizeRequest` | 三 client 统一的「修正→Finalize」序列 |

## 模块间交互

llm 是纯叶子模块，**不依赖任何 internal 包**。被调用方：`cmd/`（`main.go` 调 `InitEmbeddedLoader`；`shared.go` 调 `ResolveEndpointWithOptions`+`NewLLMClient`+`NewRetryCollector`；`llm_cmd.go` 测连通性；`provider_tui.go`/`config_cmd.go` 调 `ListProviders`/`LookupProvider`）、`internal/llmloop/`（调 `CompletionsWithCtx` + `WithRequestMeta` + session key）、`internal/agent`/`internal/scan`（调 `CountTokens` 估算）、`internal/session`/`internal/mcp`/`internal/diff`（用 `llm.Message` 等共享类型）。

## 扩展方式

- **新增 provider**：在 `providers.go` 的 `registry` 追加 `Provider` 条目，`init()` 自动重建 map。走 OpenAI 兼容协议则零代码改动；新协议还需在 `protocol.go` 加常量 + `NewLLMClient` switch case + 新建 `xxx_client.go`。
- **新增 API 协议**：`protocol.go` 加常量并扩展 `NormalizeProtocol`/`ValidateProtocol`；`client.go` switch 加 case；新建 `xxx_client.go` 实现 `CompletionsWithCtx`（含 `defer finalizeRequest`、`buildXxxParams`、`mapXxxResponse`）。
- **调整重试策略**：`RetryCodes` 经 `sanitizeRetryCodes`+`retryCodesMiddleware` 注入 SDK 强制对指定 HTTP 状态码注入 `x-should-retry: true`；SDK retry 次数在各 client 构造函数硬编码（`WithMaxRetries(5)`）；`Finalize` outcome 优先级规则在 `retry_report.go:452` 调整。
