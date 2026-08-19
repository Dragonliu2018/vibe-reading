---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "遥测与统计"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "OpenTelemetry", "Telemetry", "Observability"]
description: "OpenCodeReview 遥测与统计——OpenTelemetry 集成，一次审查一个 trace，span/metric 懒加载，no-op 降级，ContentLogging 隐私开关，OTLP HTTP base path 适配。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/telemetry/`（约 910 行，被 8 个文件 import）是横切所有模块的可观测性层。基于 OpenTelemetry SDK，它把一次审查组织成一个 trace（`review.run` 根 span + 子 span），并记录 LLM 请求/token/耗时、工具调用、文件数、评论数等 metric。它是 best-effort 的——遥测不得中断主流程，禁用时 no-op 降级零侵入。

## 模块架构

```
internal/telemetry/
├── provider.go     # 全局单例 + Init/IsEnabled + OTel SDK 全局注册
├── exporter.go     # OTLP（gRPC/HTTP）+ console 导出器初始化
├── config.go       # ResolveConfig（三级优先级：default < config.json < env）
├── span.go         # StartSpan + ContextWithTraceParentFromEnv（W3C traceparent）
├── events.go       # Event + TraceSummary + PrintTraceSummary
├── metrics.go      # 懒加载 metric + RecordXxx（review/llm/tool）
└── shutdown.go     # Shutdown / ShutdownWithTimeout（flush 批量数据）
```

核心组件：全局单例（`tracerProvider`/`meterProvider`/`shutdownFuncs`/`initialized`）、`Config`、`TraceSummary`、metric handles（`mReviewDuration`/`mLLMRequests`/`mLLMTokens`/`mToolCalls` 等）。用单例 + 幂等 Init 模式。

## 调用链路

启动 → 审查记录 → 关闭：

```
main.go:21 telemetry.Init(ctx)  → bool                          # provider.go:32
  ├─ ResolveConfig(HomeConfigPath())                            # config.go:113（default < config.json < env）
  ├─ 按 cfg.Exporter 分派 → initOTLPProviders / initConsoleProviders  # exporter.go
  └─ otel.SetTracerProvider/SetMeterProvider 全局注册              # provider.go:62
main.go:22 if true → defer telemetry.ShutdownWithTimeout(ctx, 5s)

# 审查主链路
review_cmd.go:238 StartSpan(ctx, "review.run")                  # 根 span
llmloop/loop.go:278 StartLLMSpan + RecordLLMResult/RecordLLMRequest  # LLM 请求
llmloop/loop.go:467 StartToolSpan + RecordToolResult/RecordToolCall # 工具调用
shared.go:380-406 RecordReviewDuration/RecordCommentsGenerated + PrintTraceSummary  # 收尾

# 关闭
ShutdownWithTimeout → Shutdown                                  # shutdown.go:36/15
  └─ 遍历 shutdownFuncs 逐个 tp.Shutdown/mp.Shutdown flush 批量数据
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Init` (`provider.go:32`) | 初始化 OTel SDK | 返回 bool，幂等；禁用时不 defer Shutdown |
| `StartSpan` (`span.go:25`) | 开 span | `!IsEnabled()` 返回 `SpanFromContext`，零侵入 no-op |
| `Event` (`events.go:23`) | 记录事件 | best-effort |
| `RecordLLMRequest` (`metrics.go:107`) | 记录 LLM metric | 按 model 分维 |
| `PrintTraceSummary` (`events.go:86`) | 打印 trace 摘要 | FilesReviewed/Comments/Token/Duration |
| `ShutdownWithTimeout` (`shutdown.go:36`) | flush + 关闭 | 5s 超时 ctx，防进程退出阻塞 |
</details>

## 核心实现

### Init 返回 bool 与幂等

`Init`（`provider.go:32`）返回 `len(shutdownFuncs) > 0`，main.go 据此决定是否 defer `ShutdownWithTimeout`——禁用时无需 flush，避免空操作。`initialized` flag 保证多次调用安全。禁用时 `StartSpan`（`span.go:26`）返回 `trace.SpanFromContext(ctx)`，调用方可安全 `defer span.End()`，零侵入——这是 no-op 降级模式。

### 配置三级优先级与 ContentLogging

`ResolveConfig`（`config.go:113`）default < config.json < env。JSON 适合用户持久偏好，env 适合 CI/临时覆盖，`OCR_ENABLE_TELEMETRY=1` 即开。`ContentLog`（`provider.go:78`，env `OCR_CONTENT_LOGGING`）是独立开关，默认 false——防止 prompt/response 内容泄漏到后端，隐私控制。

### OTLP HTTP base path 适配

`exporter.go:153` OTLP HTTP 用 `WithEndpointURL`（`otlpSignalURL` 拼 `/v1/traces`）。注释说明 gRPC `WithEndpoint` 无法表达路径前缀，导致 Langfuse `/api/public/otel` 的 span 被 404 丢弃——支持带 base path 的后端。

### 记录的事件与 span 组织

metric：审查耗时（`ocr.review.duration_seconds`）、文件数、评论数、LLM 请求/token/耗时（按 model 分维）、工具调用/执行耗时（按 `tool.name` 分维）。span 组织为一次审查一个 trace：`review.run` 根 span，子 span `tool.execute.*`、`llm.request`、`event.phase.completed`。`TraceSummary`（`events.go:72`）汇总 `FilesReviewed`/`CommentsGenerated`/`InputTokens`/`OutputTokens`/`TotalTokens`/`CacheReadTokens`/`CacheWriteTokens`/`Duration`/`SessionID`。

### TRACEPARENT 串联

`ContextWithTraceParentFromEnv`（`span.go:35`）注入上游 W3C traceparent，支持跨进程分布式追踪。`SetTextMapPropagator(TraceContext+Baggage)` 全局注册（`provider.go:67`）。

### 懒加载与 best-effort

`ensureMetrics()`（`metrics.go:32`）用 `initMetricsOnce` 首次调用注册，避免未启用时浪费。`checkMetricErr`（`metrics.go:75`）故意吞错——遥测不得中断主流程。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 单例 + 幂等 Init | `provider.go:32` | `initialized` flag 多次调用安全 |
| OTel SDK provider | `otel.SetTracerProvider` (`provider.go:62`) | 符合 OTel 规范全局注册 |
| No-op 降级 | `StartSpan` (`span.go:26`) | 禁用时返回 context span，零侵入 |
| 懒加载 metric | `ensureMetrics()` (`metrics.go:32`) | `sync.Once` 首次注册 |
| Best-effort | `checkMetricErr` (`metrics.go:75`) | 吞错不阻断主流程 |

## 模块间交互

被调用方：`cmd/main.go`（Init/Shutdown）、`review_cmd.go`+`scan_cmd.go`（`StartSpan` 根 span）、`internal/llmloop/loop.go`（LLM/工具 span 与 metric）、`cmd/shared.go`（汇总 metric + `PrintTraceSummary`）、`cmd/config_cmd.go`（`telemetry.enabled` 等配置键写入 `~/.opencodereview/config.json`）。依赖 `go-opentelemetry.io/otel` SDK + `internal/stdout`（输出重定向）。它是基础层叶子，被广泛依赖但不依赖业务模块。

## 扩展方式

- **新增 metric**（如审查通过率）：`metrics.go` 加全局 var + `ensureMetrics()` 注册 + 新 `RecordXxx(ctx, ...)`，调用方按 `RecordReviewDuration` 模式接入。
- **改导出目标**：运行时设 `OTEL_EXPORTER_OTLP_ENDPOINT`+`OTEL_EXPORTER_OTLP_PROTOCOL` env，或写 `~/.opencodereview/config.json` 的 `telemetry.otlp_endpoint`；代码层改 `initOTLPGRPCProviders`/`initOTLPHTTPProviders`（`exporter.go:99/153`）。
- **新增事件类型**：`events.go` 仿 `PhaseEvent`（`events.go:53`）加类型化包装，或业务侧直接 `telemetry.Event(ctx, name, attrs...)`。
