---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "LLM 工具循环"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "LLM", "ToolLoop", "Compression"]
description: "OpenCodeReview LLM 工具循环引擎——通用 tool-call 往返驱动、三区上下文压缩、CommentWorkerPool 异步评论、四路终止判定。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/llmloop/`（约 1,270 行）是 agent 引擎的底层执行器——一个**通用 LLM 工具调用循环引擎**。它驱动「LLM 生成 tool_call → 执行工具 → 回填结果 → 再调 LLM」的往返，直到 LLM 给出最终答复，并负责上下文压缩与并发管理。它不感知审查语义：`ReviewAgent` 和 `ScanAgent` 各自构建 `Deps` 注入模板/工具/DiffLookup 闭包后调 `NewRunner` → `RunPerFile`，llmloop 只负责循环驱动、压缩、池调度。

## 模块架构

```
internal/llmloop/
├── loop.go          # Runner + RunPerFile 循环主逻辑（746 行）
├── compression.go   # 三区上下文压缩 + 异步压缩任务（379 行）
└── pool.go          # CommentWorkerPool 信号量并发池（149 行）
```

核心组件：`Runner`（跨文件 per-session 执行器）、`Deps`（依赖束，由 agent/scan 注入）、`MainLoopStop`（终止原因枚举）、`CommentWorkerPool`（异步评论池）、`compressionState`（per-conversation 压缩簿记）。

## 调用链路

一轮循环（`RunPerFile` `loop.go:239`，`for` 循环 `toolReqCount` 递减驱动）：

```
RunPerFile(ctx, messages, newPath) (bool done, MainLoopStop, error)
  for ; toolReqCount > 0; toolReqCount-- {
    ├─ llm.ContextWithSessionKey(ctx, sessionKey)           # 命中同一 prompt cache 节点
    ├─ fs.AppendTaskRecord(MainTask, messages)              # 先建记录再发请求（retry report 依赖 RequestNo）
    ├─ LLMClient.CompletionsWithCtx(reqCtx, ChatRequest{...}) # 带 telemetry span
    ├─ resp.Content() + resp.ToolCalls()
    ├─ [len(calls)==0] 追加 user 提示重试，不消耗预算外轮次
    ├─ for call in calls: executeToolCall(ctx, newPath, call, rec, thinking)
    │    ├─ task_done → Complete()/Fail()
    │    ├─ code_comment → CommentWorkerPool.SubmitFor(newPath, resolveAndCollect)  # 异步
    │    └─ 其他工具 → p.Execute(ctx, args)（同步 file_read/file_find/code_search）
    ├─ addNextMessage（assistant tool_call + tool result）→ 触发压缩判定
    │    ├─ 60% MaxTokens（tokenSoftThreshold）→ 异步后台压缩
    │    └─ 80%（tokenWarningThreshold）→ 同步压缩
    └─ 终止判定：task_done→done；failed→error；预算耗尽→StopMaxRounds+graceRound；
              连续 3 轮无 result→StopEmptyRounds；压缩后仍超→StopCompression
  }
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `RunPerFile` (`loop.go:239`) | 单文件工具循环 | `toolReqCount` 驱动；4 路终止 |
| `executeToolCall` (`loop.go:453`) | 分发执行 tool_call | `code_comment` 异步，其余同步 |
| `addNextMessage` (`loop.go:673`) | 追加消息+触发压缩 | 双阈值 60%/80% |
| `partitionMessages` (`compression.go:126`) | 三区切分 | frozen[0:2]/compress/active |
| `CommentWorkerPool.SubmitFor` (`pool.go:74`) | 异步提交评论后处理 | 按 key 隔离 drain |
| `WaitBackground` (`loop.go:123`) | join 后台 goroutine | 保证 Freeze 不见半截请求 |
</details>

## 核心实现

### 终止判定

`RunPerFile` 的 for 循环有四路出口（`loop.go:261-382`）：(a) `task_done` state=DONE→完成；(b) `task_done` FAILED 或工具 `Failed`→error；(c) `toolReqCount` 归零→`StopMaxRounds` + grace round（补一轮 `code_comment`）；(d) 连续 3 轮无有效 result→`StopEmptyRounds`（`maxConsecutiveEmptyRounds=3`）；(e) 压缩后仍超 warnLimit→`StopCompression`。`MainLoopStop`（`loop.go:214`）让上层用精确分类归因失败，而非从文本猜测。

### tool_call 并发与异步评论

仅 `code_comment` 走异步路径——`CommentWorkerPool.SubmitFor(newPath, ...)` 提交，主循环立即返回 `tool.CommentSucceed` 不阻塞 LLM 轮次；其余工具同步 `p.Execute`。comment 后处理（行号解析、跨文件 re-location、LLM re-locate）耗时长，offload 降低整体延迟。`CommentWorkerPool`（`pool.go:37`）用 `chan struct{}` 做信号量限并发（默认 8），`sync.WaitGroup` 做 join，`SubmitFor`/`AwaitKey` 按 key 隔离 drain——`AwaitKey(newPath)` 在 `executeSubtask` 末尾调，保证 review filter 看到全部评论。Pool 内每个 worker 有 `defer recover()`（`pool.go:99`），单单元 panic 不影响池。

### 三区上下文压缩

`partitionMessages`（`compression.go:126`）把 messages 切成三区：frozen[0:2]（system+首条 user，保留任务指令不丢）/ compress / active。`computeActiveZoneSize`（`compression.go:101`）从尾部按 token 预算贪心纳入 active 区。压缩结构为 frozen[0:2] + 摘要追加到 user 消息 + active 尾部 rounds。双阈值触发：60% MaxTokens（`tokenSoftThreshold`）触发**异步**后台压缩；80%（`tokenWarningThreshold`，由 `PromptTokenLimit` 暴露）触发**同步**压缩。摘要嵌入 user 消息而非独立 system，避免改变消息序号语义；active 区从尾部贪心保留最新上下文。

压缩失败时保留原 messages 继续超限运行，由后续轮次重试——截断到 frozenEnd 会丢弃全部对话上下文，比暂时超限更糟。`triggerAsyncCompression`（`compression.go:291`）check-and-set `pendingJob`，goroutine 完成后比对自身 job 指针判定是否被取消/取代（经典 owner check 模式）。`compressionState` per-conversation 私有，不放 `Runner`，避免多文件互相覆盖（#384）。

### 错误传播与 boundary

LLM 调用失败→`return error`；压缩失败→保留原 messages 继续（`compression.go:256,688`）。`runner.WaitBackground()` 在 `ag.Run` 末尾 join 后台 goroutine，确保 `RetryCollector.Freeze` 不会看到 un-finalized 请求——`loop.go:106-125` 注释解释了为何不能让 Freeze 看到半截请求。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 状态机+迭代循环 | `RunPerFile` (`loop.go:239`) | `toolReqCount` 驱动 + `consecutiveEmptyRounds`/`stop` 状态迁移 |
| 策略（三区压缩） | `partitionMessages` (`compression.go:126`) | 压缩策略与调用方解耦 |
| 对象池 | `CommentWorkerPool` (`pool.go:37`) | 信号量限并发 + WaitGroup join + 按 key 隔离 |
| 异步任务所有权 | `triggerAsyncCompression` (`compression.go:291`) | check-and-set + owner check 防取代 |

## 模块间交互

llmloop 依赖 `llm`（`LLMClient`/`Message`/`ToolDef`）、`tool`（`Registry`/`Provider`/`Tool`）、`template`（`Template` 阈值与 prompt）、`session`（`SessionHistory` 会话落盘）、`diff`（行号解析）、`telemetry`（span/计量）。被调方：`internal/agent`（diff 审查，注入 `MAIN_TASK`）与 `internal/scan`（全文件扫描，注入 `FULL_SCAN_TASK`）各自构建 `Deps` 后调 `NewRunner` → `RunPerFile`。

## 扩展方式

- **改压缩策略**（如改 frozen 区大小或摘要嵌入位置）：改 `compression.go` 的 `partitionMessages`（行 126）与 `runCompression`（行 212），同步改 `tokenSoftThreshold`/`tokenWarningThreshold`（行 21）。
- **调并发度**（comment 后处理 worker 数）：改 `pool.go` 的 `NewCommentWorkerPool`（行 52）传入值，或改 `loop.go:614` 的 `if r.deps.CommentWorkerPool != nil` 分支判定异步/同步。
- **新增终止条件**（如总 token 预算上限）：在 `RunPerFile` for 循环顶部加判定并赋 `stop` 新枚举值，扩展 `MainLoopStop`（行 216）。
