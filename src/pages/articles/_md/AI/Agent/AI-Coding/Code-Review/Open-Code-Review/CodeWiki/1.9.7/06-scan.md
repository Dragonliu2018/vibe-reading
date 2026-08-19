---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "扫描引擎"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Scan", "Batch", "FullFile"]
description: "OpenCodeReview 扫描引擎——全文件审查模式（ocr scan），文件枚举、批次切分（语言/目录亲和）、批内并发+批间串行、去重与全局摘要、预算前视门控。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/scan/`（约 1,700 行）是 `ocr scan` 全文件审查模式的编排器。与 `ReviewAgent`（diff 驱动）相对，`ScanAgent` **不依赖 git diff**，直接读取整文件内容注入审查，用于审计陌生代码库或没有有意义 diff 的目录。它只拥有 scan 专属逻辑（文件枚举、模板渲染、过滤、批次切分、去重、摘要），把单文件 LLM tool-use 循环委托给共享的 `llmloop.Runner`。

## 模块架构

```
internal/scan/
├── agent.go      # ScanAgent 核心（1091 行）：NewAgent/Run/dispatchBatch/executeSubtask
├── provider.go   # 文件枚举器（git ls-files / filepath.WalkDir）
├── batch.go      # 三种分批策略
├── estimate.go   # 成本估算（与 agent/estimate.go 同步常量）
└── preview.go    # 预览
```

核心组件：`ScanAgent`（编排器，结构与 `ReviewAgent` 对称）、`Provider`（文件枚举器，git/非 git 双路径）、`BatchStrategy`（三种分批）。它与 `ReviewAgent` 共享 `llmloop.Runner`、`CommentWorkerPool`、`CommentCollector`，但用独立 `ScanTemplate` 与 `model.ScanItem` 载体。

## 调用链路

`executeScan`（`scan_cmd.go:108`）→ `scan.NewAgent` → `ag.Run(ctx)`：

```
Run(ctx) ([]model.LlmComment, error)                       # scan/agent.go:302
  ├─ NewProvider(repoDir, paths, runner, maxFileSize) + Enumerate(ctx) → []ScanItem
  ├─ filterScanItems（二进制/扩展名/用户规则）
  ├─ filterLargeScans（丢弃超 80% MaxTokens 的文件）
  ├─ estimateCost → 若超 MaxTokensBudget 打印警告
  ├─ dispatchSubtasks                                         # agent.go:509
  │    ├─ groupBatches(items, strategy, BatchSize)           # batch.go:45
  │    └─ for batch in batches（批间串行）:
  │         dispatchBatch(batch) → sem 并发执行
  │           for item in batch: go executeSubtask(fileCtx, item)
  │                ├─ maybeRunPlan（可选 PLAN_TASK）
  │                ├─ renderMessages（{{file_content}} 注入整文件）
  │                └─ a.runner.RunPerFile(ctx, messages, newPath)
  │         maybeRunDedup（批后去重）                          # agent.go:883
  ├─ maybeRunProjectSummary（全局摘要）                       # agent.go:805
  └─ session.Finalize
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Run` (`scan/agent.go:302`) | 扫描编排 | 枚举→过滤→分批→dispatch |
| `Provider.Enumerate` (`provider.go:80`) | 文件枚举 | git 用 `ls-files`，非 git 用 `WalkDir` |
| `groupBatches` (`batch.go:45`) | 分批 | 三策略；桶间排序保证确定性 |
| `dispatchBatch` (`agent.go:586`) | 批内并发 | sem + wg；batch 前视 budget gate |
| `maybeRunDedup` (`agent.go:883`) | 批后去重 | 失败保留原始评论（降级） |
| `maybeRunProjectSummary` (`agent.go:805`) | 全局摘要 | 失败静默跳过 |
</details>

## 核心实现

### scan vs review 的核心差异

全文件驱动 vs diff 驱动是根本差异。review Agent 以 `From/To/Commit` diff 区间为输入审查变更行；scan Agent 不依赖 git diff，直接读取整文件内容注入 `{{file_content}}` 占位符（`agent.go:renderMessages`）。因此 scan 使用独立 `template.ScanTemplate`（含 `PlanTask`/`DedupTask`/`ProjectSummaryTask`），通过 `toLoopTemplate`（`agent.go:162`）只提取 `llmloop.Runner` 需要的字段复用共享循环，而非把 review 模板的 diff 专属字段混入。`{{change_files}}` 占位符用固定哨兵 `"(not applicable in full-scan mode)"` 替代——全文件扫描无「其他变更文件」概念。`file_read_diff` 工具在 scan 中无意义，`scan_cmd.go:176` 显式从 `MainToolDefs` 排除，但 `injectScanContentMap`（`agent.go:403`）仍将整文件内容注入 DiffMap 作为回退。`ScanItem.AsDiff()`（`model/scan.go`）把整文件适配为 `Diff` 形状，供复用 diff 路径的代码（行号解析、file_read_diff）使用。

### 批次切分策略

`batch.go` 的 `BatchStrategy` 三种：`BatchNone`（每文件独立，安全默认值，等价 v1 逐文件）、`BatchByLanguage`（按扩展名）、`BatchByDirectory`（按一级目录）。分批按「语言亲和性」或「目录亲和性」分组——目的是让相邻批次的 LLM 请求共享 prompt-cache 前缀（同语言文件的 system prompt 和工具定义一致）。`groupBatches`（`batch.go:45`）先按 `batchKeyFunc` 分桶，再按 `BatchSize` 切片，桶间排序保证确定性。`BatchSize` 在分组内做二次切片控制单批文件数。

### 文件枚举与降级容错

`Provider.Enumerate`（`provider.go:80`）：git 仓库用 `git ls-files`，非 git 目录用 `filepath.WalkDir`。`isBinaryFile` NUL 嗅探识别二进制，`filterByPaths` 路径前缀匹配。降级容错贯穿全链：Plan 失败回退无计划模式（`agent.go:789`）；Dedup 失败保留原始评论（`agent.go:921`）；Summary 失败静默跳过（`agent.go:844`）。

### 估算与预算门控

`estimate.go` 的粗粒度启发式（非计费级精度）：`avgMainRoundsPerFile=7`、`avgOutputTokensPerRound=700`、`promptOverheadTokens=2000`。`estimateFileTokens` 同时服务聚合估算和每文件预算前视（`dispatchBatch` 行 632），保证门控逻辑与估算口径一致。Dedup/Summary 阶段按每文件约 3 条评论假设推算下游输入量。预算前视门控（`dispatchBatch` 行 630-644）获取 slot 前检查 `TotalTokensUsed() + estimateFileTokens(it)` 是否超预算，避免排队注定超额的文件。

### 可恢复性

`initResumeInfo`/`resumeItem` 基于 `sha256(path+content)` 指纹匹配已完成的文件，跳过重复审查——scan 用 `LoadResumeState`（`skipUnparseable=false`，一行坏就整体失败，因 scan 无 manifest 兜底）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 分治/批处理 | `groupBatches` (`batch.go:45`) | 按亲和性分桶提升 prompt-cache 命中 |
| 并发扇出+信号量 | `dispatchBatch` (`agent.go:586`) | sem 控并发，每文件独立 timeout |
| 预算前视门控 | `dispatchBatch` 行 630 | 获取 slot 前检查，避免排队注定超额 |
| Provider 适配 | `provider.go` | git/非 git 双路径枚举 |
| 降级容错 | Plan/Dedup/Summary | 失败回退，不阻塞主流程 |

## 模块间交互

scan 依赖 `llmloop`（共享 Runner）、`llm`（LLMClient+token 计数）、`model`（ScanItem/Diff/LlmComment）、`tool`（Registry/CommentCollector/FileReadDiff）、`session`（持久化/恢复）、`diff`（gitignore 加载/路径排除）、`gitcmd`、`config/{rules,template,allowlist}`、`telemetry`。被调用方：`cmd/scan_cmd.go` 是唯一入口。scan 与 review 共享 `loadCommonContext`/`loadLLMRuntime`/`emitRunResult`/`llmloop.Runner`/`CommentWorkerPool`/`diff.ResolveLineNumbers`；差异在 `ScanTemplate` vs `template.Template`、`scan.Provider.Enumerate` vs `diff.Provider.GetDiff`、batch 分组+dedup+summary、`NewRequestMeta=nil`（scan 请求不进 retry report）、manifest 始终 nil。

## 扩展方式

- **新增批次策略**（如按文件大小分组）：改 `batch.go` 加 `BatchBySize` 常量 + `batchKeyFunc` 新分支 + `sizeKey` 函数；`scan_cmd.go` 的 `--batch` flag 经 `parseBatchStrategy` 自动路由。
- **新增估算维度**（如按评论密度修正）：改 `estimate.go:estimateCost` 调整系数或增加复杂度权重；同步改 `estimateFileTokens` 保持单文件估算与聚合口径一致。
- **调整并发/超时**：改 `scan_cmd.go:executeScan` 传入的 `MaxConcurrency`/`ConcurrentTaskTimeout`，或改 `agent.go:dispatchBatch` 行 587 默认值。
