---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "协议翻译矩阵"
date: "2026-09-24T16:20:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "gjson", "SSE", "协议翻译"]
description: "协议翻译矩阵：7 种 wire 格式 N×M 注册表、gjson/sjson 字节级变换、SSE 状态机外置到 param、目录方向反转勘误、插件翻译钩子"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/translator/`（~40k 行）+ `sdk/translator/` 构成一个 **N×M wire-format 翻译矩阵**：7 种格式（`sdk/translator/formats.go`：`openai` / `openai-response` / `claude` / `gemini` / `codex` / `antigravity` / `interactions`）两两之间，请求正向翻译、响应反向翻译、SSE 逐块翻译。它是"任何客户端方言可以打到任何上游"这一核心承诺的全部实现层。矩阵是无状态纯函数的集合——没有任何 per-connection 对象，这使它可测试、可热插（`Unregister`）且天然并发安全。

**一个重要的方向勘误**（阅读此代码最大的坑）：顶层五个目录是 **`{上游 provider}/{客户端入站格式}`**——即 `internal/translator/{to}/{from}`，与注册 key 相反。证据：`internal/translator/codex/claude/init.go` 注册的是 `Register(Claude, Codex, ConvertClaudeRequestToCodex, ...)`——from=Claude（客户端）、to=Codex（上游），而目录是 `codex/claude`。看到 `internal/translator/gemini/openai/responses/` 应读作 `from=openai-response → to=gemini`。

## 模块架构

```
sdk/translator/
   ├── formats.go       # 7 个 Format 常量
   ├── types.go         # RequestTransform / ResponseTransform（函数式接口，非 interface）
   ├── registry.go      # Registry：requests/responses 两张双层 map[Format]map[Format]
   │                    #   + 包级单例 facade（Register/TranslateRequest/TranslateStream/...）
   ├── pipeline.go      # Pipeline 装饰器（对外 SDK 扩展点，internal 未用）
   └── plugin_hooks.go  # PluginHooks 5 钩子（插件介入翻译，核心路径）

internal/translator/
   ├── init.go          # 27 个匿名 import 触发全矩阵自注册（side-effect import）
   ├── {to}/{from}/     # 每对格式一个包 = 矩阵单元（勘误后的方向）
   ├── common/          # 共享工具：claude_messages.go / openai_tools.go / bytes.go
   └── translator/      # internal↔sdk 桥接（string 常量 → Format）
```

注册时机是 Go 的 side-effect import：每对格式一个包，包内 `init.go` 调 `translator.Register(...)`；`internal/translator/init.go` 用 27 个匿名 import 一次拉起全部注册（main.go 也 `_ import` 了它）。Why 自注册而非中央 switch：每对翻译器 1-2k 行，集中到一个注册中心会是数万行 god file；新增一对只需建目录 + init.go + 一行 import，零中心文件改动。

## 调用链路

以 Claude 客户端 → Codex 上游为例（注册于 `internal/translator/codex/claude/init.go`）：

```
请求方向（convertClaudeRequestToCodex in codex/claude/codex_claude_request.go）
├── system → developer 消息（过滤归因文本 util.IsClaudeCodeAttributionSystemText）
├── messages[] 扁平化为 input[]：
│     text→input_text/output_text · image→input_image · document→input_file
│     tool_use→function_call · tool_result→function_call_output（AlignClaudeToolResults 对齐挂起 ID）
├── thinking block → {"type":"reasoning","encrypted_content":signature}
│     经 sigcompat.CompatibleSignatureForProvider 转签名（internal/signature）
├── tools[] → function tools：buildShortNameMap 压缩 64 字符 MCP 工具名
├── thinking.budget_tokens → reasoning.effort（thinking.ConvertBudgetToLevel）
└── 强制 stream:true, store:false, include:["reasoning.encrypted_content"]

响应方向（ConvertCodexResponseToClaude in codex/claude/codex_claude_response.go）
└── SSE 事件状态机（param 持有）：
      response.created→message_start
      reasoning_summary_text.delta→thinking block content_block_delta
      output_text.delta→text delta
      function_call 事件攒进 DeferredStreamEvents → response.completed 统一补发
      response.completed→message_delta（stop_reason 映射 + usage）
```

调用点在 executor：`CodexExecutor` 取 `from := opts.SourceFormat`、`to := "codex"`（`codex_executor_execute.go:41`），请求经 `sdktranslator.TranslateRequest`，流式响应对每行 SSE 调 `helps.TranslateStreamWithClaudeInputTokens` → `sdktranslator.TranslateStream`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `Register` in `registry.go:30` | 登记一对格式的请求+响应翻译器 | from=客户端/to=上游；Unregister 清空父 map |
| `TranslateRequest` in `registry.go:102` | 查表执行请求翻译 | 无路由时原样透传但强制重写 model 字段防前缀泄漏 |
| `TranslateStream` in `registry.go:218` | 逐块流式翻译 | 查表方向反转：from=上游/to=客户端 |
| `TranslateNonStream` in `registry.go:254` | 非流式响应翻译 | 原始请求字节一并传入（usage 对账） |
| `TranslateTokenCount` in `registry.go:281` | token 计数格式转换 | count_tokens 端点复用 |
| `HasRequestTransformer`/`NeedConvert` | 让调用方短路翻译 | 避免无谓字节拷贝 |
| `TranslateRequestEnvelope` in `registry.go:114` | 信封版（带 ModelInfo）+ 插件钩子 + summary 意图重放 | 核心编排点 |
</details>

## 核心实现

### 字节级 gjson/sjson：不定义中间模型

所有 `Convert*` 直接操作 `[]byte`（`gjson.ParseBytes` + `sjson.SetRawBytes`），不反序列化成 Go struct。Why 三条：**未知字段透传不丢**（上游协议演进不破坏代理——struct 方案会静默丢弃新字段）；避免大 payload 双份内存；性能（仓库自带 `request_benchmark_test.go`）。代价是函数极长——这正是 graphify 报出 5 个 god node（`ConvertOpenAIResponsesRequestToGemini` degree 158 等）的成因。

### 流式状态外置到 `param *any`

`ResponseStreamTransform` 的尾参 `param *any` 是流式翻译的灵魂：翻译器是**无状态可注册的函数值**，per-stream 状态由调用方（executor）分配，翻译函数首次调用时惰性初始化：

```go
// codex_claude_response.go:78
if *param == nil { *param = &ConvertCodexResponseToClaudeParams{...} }
// "Response type states: 0=none, 1=content, 2=thinking, 3=function"
```

这个设计一并解决了 **SSE 事件重排序**：Claude 协议要求 tool_use 块顺序合法，而 Codex 的 function_call 事件乱序到达——`shouldDeferCodexStreamEvent` 把它们攒进 `DeferredStreamEvents`，在 `response.completed` 统一 `appendCodexFunctionCallsFromTerminal` 补发。注册表不需要 per-connection 对象，executor 持 param 游过整条流。

### 响应查找方向反转

`TranslateStream(from, to, ...)` 中 from=**上游**、to=**客户端**，registry 内部做 `r.responses[to][from]` 查表——与 `Register` 的方向参数相反。Why：注册按"客户端能进来 + 上游能出去"成对登记，运行期只需调换方向参数即可复用同一张表。读代码时记住这对反转，否则会以为注册表装反了。

### thinking/签名跨格式保真

Claude thinking 的 `signature` ↔ Codex `reasoning.encrypted_content` 经 `internal/signature` 的 `sigcompat.CompatibleSignatureForProvider` 按 provider 转换；Grok 签名仅当目标模型是 grok 时透传（`codexClaudeTargetAcceptsGrokSignature` + `InspectGrokEncryptedContent` 校验）。请求翻译时 `appendReasoningContent` 只在 assistant 角色产出 reasoning item，防止历史 thinking 污染用户消息。丢失签名链的格式（如 OpenAI Chat Completions 无处放签名）由回放缓存兜底——见 [09-thinking](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/09-thinking)。

### 插件翻译钩子（核心路径）与 Pipeline（对外扩展点）

两套独立机制：`Pipeline`（`pipeline.go` 的 `UseRequest/UseResponse` 装饰器）目前 internal 未使用，仅 `sdk/translator/builtin` 对外暴露给 SDK/插件用户。真正生效的是 `PluginHooks` 5 钩子（由 `pluginhost` 实现、`sdk/cliproxy/service_plugins.go:128` 注入）：

1. 请求：native 翻译先跑 → `hooks.NormalizeRequest`（"normalizers run after native translation and own the final provider payload"）；若无 native 路由，先 Normalize 再 `hooks.TranslateRequest`（返回 `ok` 表示插件接管），失败原样回落并强制重写 `model` 字段防泄漏。
2. 响应：`NormalizeResponseBefore` → native transform（无则插件 `TranslateResponse`）→ 每个输出过 `NormalizeResponseAfter`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Registry + Facade | `Registry` 双层 map + 包级单例（`registry.go` 底部 `defaultRegistry`） | 注册与查询解耦，12 个包级函数免传引用 |
| 策略（函数值） | `RequestTransform`/`ResponseTransform` 是函数类型 | 无状态，注册即插即卸 |
| 状态机（流式） | `param *any` 惰性初始化 | per-stream 状态外置 |
| 装饰器 | `Pipeline.UseRequest/UseResponse` | 不侵入 registry 的扩展 |
| Side-effect import 注册 | `internal/translator/init.go` 27 个匿名 import | 声明即注册 |

## 模块间交互

- **入口**：`internal/api/server_routes.go` 按 URL 路由协议；`sdk/api/handlers/handlers_execution.go:81` 把入站格式写进 `Options{SourceFormat, ResponseFormat}`。
- **executor**：每个 executor 硬编码自己的 `to` 格式，调 `TranslateRequest/TranslateStream/TranslateNonStream`；`internal/translator/translator/translator.go` 把 internal 的 string 常量桥接为 `sdktranslator.Format`。
- **thinking**：`TranslateRequestEnvelope` 每次翻译后跑 `ExtractSummaryConfig`/`ApplySummaryConfigForModel`，把客户端的 reasoning 可见性意图跨格式重放。
- **插件**：`PluginHooks` 注入后全格式生效（见上）。

## 扩展方式

**新增一种 wire 格式**：`sdk/translator/formats.go` 加 `FormatFoo` + `internal/constant` 加常量 → 每个现有 `{上游}/` 下建 `foo/` 子目录写双向翻译（复用 `common/` 的共享工具减少矩阵新列成本）→ `internal/translator/init.go` 加 import → `server_routes.go` 加路由 → `sdk/api/handlers/` 建 handler 包。对应的翻译保真测试放 `test/`（参考 `builtin_tools_translation_test.go` 的 gjson 断言模式）。

**新增翻译 hook**：插件体系走 `internal/pluginhost` 扩展 `PluginHooks` 接口；核心翻译直接在 `Registry.TranslateRequestEnvelope`/`TranslateStream` 插阶段，或用 `Pipeline.UseRequest` 做无侵入装饰。

**调整某对格式的 thinking 映射**：改对应 `{上游}/{客户端}/` 包内的映射段（如 Claude→Codex 的 budget→effort 在 `codex_claude_request.go:396-423` 的 switch；反向 SSE 的 thinking 块开合在 `codex_claude_response.go` 的 `startCodexThinkingBlock`/`finalizeCodexThinkingBlock`）。
