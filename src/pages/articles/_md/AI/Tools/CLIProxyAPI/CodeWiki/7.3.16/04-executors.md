---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "Provider 执行器"
date: "2026-09-24T16:18:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "执行器", "Cloaking", "uTLS"]
description: "Provider 执行器：六方法 ProviderExecutor 契约、Claude 执行链（cloaking 伪装 + CCH 签名）、Codex WebSocket 双工、reasoning 回放接线、fast error 路径、helps 公共层"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/runtime/executor/` 是全项目最大的模块（~52k 行生产代码，160 个文件），每家上游 provider 一个执行器：把统一 `Request`（某 `Format` 的 JSON 载荷）翻译成上游 wire 格式、注入凭据与身份特征、发起 HTTP/WebSocket 调用、把流式响应逐块转回统一 `StreamResult`。它独立存在的理由很朴素——**上游差异天然按家分化**：wire 格式、限流响应头、身份伪装要求、reasoning 编码方式每家都不同，这些差异封装在一族文件里（如 `claude_executor{,_execute,_stream,_request}.go` 四件套），互不污染。

一个容易搞错的边界：**Executor 接口不在 `sdk/cliproxy/executor/types.go` 里**——types.go 只承载数据契约（Request/Options/Response/StreamChunk/StreamResult + 错误标记接口 + 40 个 Metadata key）。真正的执行器接口是 `ProviderExecutor`，定义在 `sdk/cliproxy/auth/conductor.go:16`（消费方 Conductor 的依赖倒置），实现散布在 `internal/runtime/executor/`。

## 模块架构

```
ProviderExecutor 契约（sdk/cliproxy/auth/conductor.go:16）
   Identifier / Execute / ExecuteStream / Refresh / CountTokens / HttpRequest
   + 可选：RequestAuthPreparer（请求前补凭据）、ExecutionSessionCloser（会话资源释放）
        ▲ 实现
┌───────┴────────────────────────────────────────────┐
│ internal/runtime/executor/                          │
│  ├── claude_executor*.go      # cloak / CCH / 5h/7d │
│  ├── codex_executor*.go + codex_websockets_*.go     │
│  ├── gemini / antigravity / kimi / xai / devin /     │
│  │   meta / aistudio / vertex / grokbuild / iflow…  │
│  ├── openai_compat（泛化适配器，任意 OpenAI 兼容上游）│
│  └── helps/                  # ~90 文件公共层        │
│      uTLS 传输 / usage 提取 / payload 规则 / 日志    │
└─────────────────────────────────────────────────────┘
```

契约数据类型（`sdk/cliproxy/executor/types.go:89-267`）里最值得注意的两个语义错误接口——它们是 Conductor 调度系统的信号通道：`StatusError`（401/402/429 触发凭据状态更新）与 `RequestScopedError`（请求级失败，**不得换凭据重试、不得据此降低凭据可用性**）。

## 调用链路

以 Claude 为例的 `ExecuteStream` 骨架（所有 executor 同构，公共步骤沉到 helps，无显式基类——弱形态模板方法）：

```
ExecuteStream in claude_executor_stream.go
├── EnsureSessionContext / ParseSuffix（thinking 后缀剥离）
├── claudeCreds(auth) → baseURL + "/v1/messages?beta=true"
├── resolveClaudeFingerprintPolicy（该凭据的伪装档位）
├── TranslateRequestPairWithAPIKeyModelCompatibility   # 翻译进：SourceFormat → claude
├── ApplyRequestThinking + ApplyPayloadConfigWithTrackedPaths
├── applyCloakingInternal（系统提示注入/敏感词混淆）
├── 一组 wire 约束：ensureModelMaxTokens（Anthropic 拒绝缺 max_tokens）
│   enforceCacheControlLimit(4)（最多 4 个 cache breakpoint）/ extractAndRemoveBetas
├── SanitizeClaudeMessagesForClaudeUpstream（internal/signature 清洗历史 thinking 签名）
├── finalizeAnthropicMessagesBodyCCH（CCH 签名）→ applyClaudeHeadersWithNativeProfile
├── helps.NewUtlsHTTPClient → doClaudeUpstreamRequest   # 上游调用
└── 成功：goroutine 逐行读 SSE
    ├── StreamUsageBuffer.ObserveClaudeStream（提 usage/TTFT）
    ├── restoreClaudeOAuthToolNamesFromStreamLine（MCP 工具名反混淆）
    ├── TranslateStream(..., &param)（每行翻译回客户端格式，param 是状态机）
    └── out <- StreamChunk{Payload}
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `NewClaudeExecutor` in `claude_executor.go:139` | 无状态工厂 | 只持 `*config.Config`，凭据由 Conductor 传入 |
| `Execute` in `claude_executor_execute.go:20` | 非流式全链路 | 三件套结构（Execute/ExecuteStream/ExecuteRequest） |
| `classifyClaudeUpstreamErrorWithCooling` in `claude_executor_request.go:649` | 错误分类 | 5h/7d 统一窗口 → credentialScoped |
| `restoreResponseModel` in `claude_executor.go:161` | 还原模型名 | 防上游偷换模型 |
| `CodexAutoExecutor.ExecuteStream` in `codex_websockets_executor.go:80` | HTTP/WS 策略路由 | 双实现组合 |
| `streamCodexDuplex` in `codex_websockets_duplex.go` | WS 双工流 | 帧经 `WebSocketResponseObserver` 外发 |
| `wrapClaudeThinkingReplayStream` in `claude_thinking_replay.go:138` | 回放缓存包装 | 装饰 StreamResult |
| `prepareClaudeThinkingReplayRequest` in `claude_thinking_replay.go` | 请求前回放注入 | 见 [09-thinking](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/09-thinking) |
</details>

## 核心实现

### Claude 执行链：订阅身份保真的全套工程

`Execute` in `claude_executor_execute.go:20-442` 是理解"CLIProxyAPI 为什么能保住订阅配额"的最好样本，四个关键机制串联：

1. **Cloaking**（`applyCloakingInternal` in `claude_executor_cloaking.go`）：给非原生客户端注入 Claude Code 系统提示片段、伪造 user ID、`ObfuscateSensitiveWords` 混淆敏感词，使第三方客户端流量在 Anthropic 侧看起来像原生 Claude Code。`resolveClaudeFingerprintPolicy` in `claude_fingerprint_policy.go` 按凭据决定完整 wire 伪装档位（betas 集合、extended-cache-ttl、CLI identity seed、diagnostics 注入）；**与 cloak 互斥**——确认入站是原生 Claude Code（`helps/claude_client_detection.go`）则强制关闭伪装。
2. **CCH 签名**（`finalizeAnthropicMessagesBodyCCH` in `claude_signing.go`）：cache-control-hash 请求体签名——OAuth 凭据永远签，第三方网关保持 body 稳定以命中计费缓存。
3. **wire 约束族**：`ensureModelMaxTokens`（Anthropic 拒绝缺 `max_tokens` 的请求，默认 1024）、`enforceCacheControlLimit(body, 4)`（每请求最多 4 个 cache breakpoint）、`upgradeClaudeCacheControlTTL`（1h 池）、`extractAndRemoveBetas`（body 里的 betas 挪到 header）。
4. **uTLS 传输**（`helps.NewUtlsHTTPClient` in `utls_client.go`）：模拟 Firefox ClientHello 指纹绕 TLS 指纹检测；`TransportCache[K]` LRU 上限防 per-credential 代理轮换时连接池无限增长。

### Codex 双 transport：Auto 路由与 WebSocket 双工

`CodexWebsocketsExecutor` **组合而非替代**——内嵌 `*CodexExecutor`，`/responses/compact` 与 WS 升级失败回退 HTTP。`CodexAutoExecutor`（`codex_websockets_executor.go:39-91`）只在「下游本身是 websocket 传输 **且** 该凭据开启 `websockets`」时走 WS；条件不满足但必需时返回 `UpstreamWebsocketReplayRequiredError` 而非静默降级。WS executor 持 `codexWebsocketSessionStore` 按会话复用长连接（per-session `reqMu` 串行化），实现 `CloseExecutionSession`（可选接口）释放会话资源；`streamCodexDuplex` 上游事件双工推送而非 SSE 单向拉，每帧经 `WebSocketResponseObserver` 外发。双工模式下还有 `applyCodexIdentityConfuseBody/Headers`（身份混淆）与强制 `stream=true`。响应中途注入新输入的 steering 模式见 `docs/STEERING.md`——一旦响应开始，连接绑死账号与模型，不再跨账号 failover。

### fast error：探测请求不烧配额

`claudeRequestIsFast` 识别 count_tokens / max_tokens=1 探测类小请求，其失败包装为 `claudeFastRequestError implements RequestScopedError`（`claude_executor_fast_error.go`）——**不得**让 Conductor 换凭据重试或降低凭据可用性，除非真命中凭据级限流（`IsCredentialScoped()`）。Why：Claude Code 每次启动发的探测请求如果按普通失败处理，会把健康凭据打入冷却、烧掉多凭据配额。

### helps/ 公共层：避免十族重写的基础设施

`internal/runtime/executor/helps/`（~90 个文件）承担：usage 提取与上报（`UsageReporter`/`StreamUsageBuffer` in `usage_helpers.go`——统一提各上游 usage、记 TTFT、`ObserveResponseModel` 检测上游偷换模型并告警）、uTLS 传输、配置驱动的 payload 规则引擎（`ApplyPayloadConfig*` 带 touched-path 追踪，供翻译后 reconcile）、Claude 身份种子与设备画像、敏感词匹配、会话/缓存辅助、代理辅助。新 executor 写出来通常不到 500 行——公共步骤都有现成函数。

### OpenAICompat：泛化适配器

任意 OpenAI 兼容上游（OpenRouter 等）**零代码接入**——`NewOpenAICompatExecutor`（`service_executors.go:343` 注册）用配置声明 base-url/key/模型映射，不需要新文件族。这是适配器模式的极致：矩阵里"openai 方言"一列被复用为整类上游的通道。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 工厂 + 注册表 | 每上游 `New*Executor` → `coreManager.RegisterExecutor` | Conductor 按 provider key 查找 |
| 适配器 | 每个 executor 把统一 Request 适配成上游 wire；OpenAICompat 泛化整类上游 | 上游差异封装单元 |
| 策略路由 | `CodexAutoExecutor`、`NewXAIAutoExecutor`（`xai_websockets_executor.go:1709`） | HTTP/WS 按凭据能力分发 |
| 装饰器 | `reporter.TrackHTTPClient(httpClient)`；`wrapClaudeThinkingReplayStream` | 观测与回放叠加不改主体 |
| 弱形态模板方法 | 全部 Execute 遵循同一骨架（creds→fingerprint→translate→thinking→payload→send→usage→translate back） | 靠约定+helps 复用，无基类 |

## 模块间交互

被 Conductor 调用（凭据已选定才进来）；出向依赖：`sdk/translator`（Translate* 进出）、`internal/signature`（跨 provider thinking 签名清洗）、`internal/cache`（reasoning 回放存取）、`internal/thinking`（后缀解析与配置应用）、`internal/registry`（能力查询）、`internal/client`（claude/codex/grokbuild 客户端）。错误语义经 `StatusError`/`RequestScopedError`/`Result.CredentialScope` 鸭子通道回传 Conductor；usage 统一经 `helps.UsageReporter` 的 `Publish` 走 Conductor 的 Hook。

## 扩展方式

**新增上游 provider**：标准做法是四件套文件族（`xxx_executor.go` 结构+工厂、`xxx_executor_execute.go` 非流式、`xxx_executor_stream.go` 流式、`xxx_executor_request.go` wire 构建），实现 `ProviderExecutor` 六方法，在 `sdk/cliproxy/service_executors.go` 注册。**无状态是硬约束**——executor 可能被并发凭据共享，一切会话态要么进 `Options.Metadata` 要么用可选接口（`ExecutionSessionCloser`）显式管理。OpenAI 兼容上游则零代码走 config。

**给某 executor 加降级**：改 `CodexAutoExecutor.ExecuteStream` 的路由条件或在 `Execute` 的升级失败分支加策略；错误若不该烧凭据，实现 `RequestScopedError`（参照 `codexDuplexConnectionError` in `codex_websockets_duplex.go:27`）。

**加用量观测**：不动 executor 解析逻辑，在 `helps/usage_helpers.go` 的 `UsageReporter` 加观察方法（参照 `ObserveCodexResponseModel`、`ObserveClaudeStream`），再到对应 stream 文件挂一行调用。
