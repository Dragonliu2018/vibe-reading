---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "Agent 执行引擎"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Agent", "ReviewAgent", "Concurrency"]
description: "OpenCodeReview ReviewAgent 执行引擎——diff 审查编排、场景化 prompt 构建、并发子审查、coverage 冻结、Plan/Main 两阶段、续审指纹匹配。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/agent/`（约 2,370 行）是「确定性工程 × Agent 混合」中 **Agent 侧 + 确定性约束**的交汇点。`ReviewAgent` 负责 diff 审查的编排：解析 diff、过滤、注册 coverage 分母、复用续审、并发 dispatch 子审查、构建场景化 prompt、聚合意见。它把「单文件内工具往返」委托给 `llmloop.Runner`，自身只管「审什么、怎么编排」——agent 保持确定性工程约束（coverage 分母在 dispatch 前冻结、SealedInput 防止 ref 移动、budget gate 在信号量获取前检查），llmloop 处理 agent 无法预知的动态决策（模型选什么工具、何时 task_done）。

## 模块架构

```
internal/agent/
├── agent.go      # ReviewAgent 核心（1894 行）：New/Run/dispatchSubtasks/executeSubtask/prompt 构建
├── identity.go   # ResolveIdentity/SealedInput（续审身份，与 session 协作）
├── estimate.go   # estimateDiffCost/estimateDiffFileTokens（预算前视）
├── preview.go    # Preview（delegate/preview 复用，不开 LLM）
└── util.go       # stripEmptyPlanBlock 等工具
```

核心组件：`Agent` struct（持有 diff 侧状态 + runner + session）、`Args`（27 字段依赖容器，由 cmd 装配）、`RuntimeConfig`（非密钥运行时配置白名单）。`Agent` 把工具循环委托给 `llmloop.Runner`，把 coverage/manifest 状态管理委托给 `session.ManifestBuilder`。

## 调用链路

`New` → `Run` 的编排链（模板方法）：

```
New(args Args) *Agent                                      # agent.go:205
  ├─ 自动检测 git branch
  ├─ initManifest()（种子化 manifest）
  └─ runner = llmloop.NewRunner(Deps{...,DiffLookup:a.findDiff, AllDiffs:a.allDiffs, NewRequestMeta:a.newRequestMeta})

Run(ctx) ([]LlmComment, error)                              # agent.go:276
  ├─ llm.ContextWithSessionKey(ctx, SessionID())
  ├─ loadDiffs(ctx)                                          # diff.Provider → GetDiff → ResolveInput
  ├─ injectDiffMap + Tools.Freeze()
  ├─ filterDiffs / filterLargeDiffs
  ├─ [MaxTokensBudget>0] estimateDiffCost（预算预警）
  ├─ RecordResumeLineage
  ├─ dispatchSubtasks(ctx)                                   # agent.go:569
  │    ├─ filterLargeDiffs + registerCoverage（冻结分母）
  │    ├─ applyResume（fingerprint 匹配 → markReused 或 toDispatch）
  │    └─ for each diff: go executeSubtask(fileCtx, d)       # sem 并发，默认 8
  │         ├─ executePlanPhase（可选，低于 PlanModeLineThreshold 跳过）
  │         ├─ Phase 2: 构建 main_task prompt（占位符替换）→ runner.RunPerFile
  │         └─ executeReviewFilter（REVIEW_FILTER_TASK 后处理）
  ├─ runner.WaitBackground()
  ├─ finalizeManifest（applyInputIdentity + b.Finalize）
  └─ session.Finalize()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `New` (`agent.go:205`) | 初始化 Agent | 自动检测 git branch；构造 runner 注入闭包 |
| `Run` (`agent.go:276`) | 模板方法编排 | 固定骨架 loadDiffs→filter→dispatch→finalize |
| `dispatchSubtasks` (`agent.go:569`) | 并发 dispatch | `sem` 默认 8；budget 前视 gate 在获取 slot 前检查 |
| `executeSubtask` (`agent.go:1211`) | 单文件两阶段 | Plan 可选跳过；`AwaitKey` 等同文件异步评论 |
| `resolveSystemRule` (`agent.go:1591`) | 按路径 glob 选规则文本 | 确定性匹配，不靠 LLM 猜语言 |
| `BuildToolDefs` (`agent.go:1875`) | 区分 plan/main 工具集 | `ToolDefsByPhase(planOnly)` 过滤 |
</details>

## 核心实现

### 场景化 prompt 构建

`executeSubtask`（`agent.go:1257`）对 main_task 模板做占位符替换：`{{current_file_path}}`/`{{system_rule}}`/`{{change_files}}`/`{{diff}}`/`{{requirement_background}}`/`{{plan_guidance}}`。agent 不改模板结构，只做变量绑定，保持模板可配置性。当 plan 无结果时，`stripEmptyPlanBlock`（`util.go:32`）先用正则移除 `### Review Plan` 包裹块再替换 `{{plan_guidance}}`，避免字面 token 泄漏。plan 可选跳过由 `PlanModeLineThreshold` 控制——低于阈值不浪费 LLM 调用。`resolveSystemRule`（`agent.go:1591`）按路径 glob 选择规则文本，是「确定性规则匹配」的落地：同一文件路径永远解析到同一规则，消除 LLM 语言识别的不确定性。

### agent 与 llmloop 分工边界

agent 负责「审什么、怎么编排」（diff 解析、过滤、并发 dispatch、prompt 绑定、coverage/manifest 状态机），llmloop 负责「单文件内工具往返」（`RunPerFile` 执行 LLM↔tool 循环、memory compression、grace round）。`newRequestMeta`（`agent.go:265`）是唯一 provider/model 读取点，确保 5 种请求类型的 retry report 身份一致。re-location LLM 调用虽在 llmloop 的 `executeToolCall` 内发起，但 prompt 来自 `deps.Template.ReLocationTask`，语义仍由上层注入——llmloop 是通用引擎，不感知审查语义。

### 并发子审查与结果聚合

`dispatchSubtasks`（`agent.go:569`）用 `sem := make(chan struct{}, MaxConcurrency)`（默认 8）+ `sync.WaitGroup` fan-out N 个 per-file goroutine。预算前视门控在获取 slot 前检查 `TotalTokensUsed() + estimateDiffFileTokens(d) > MaxTokensBudget`，避免排队注定超额的文件，超额标 `SetPendingFailureCause(Budget)`。`CommentCollector` 是线程安全的全局 sink，各 goroutine 通过 `code_comment` 工具写入，`dispatchSubtasks` 末尾 `Comments()` 一次性聚合。异步 `CommentWorkerPool` 把 comment 后处理（tracking/re-tracking/reflection/validation）移出关键路径，`AwaitKey(newPath)`（`agent.go:1322`）在 review filter 前等待同文件单元完成。

### 续审指纹匹配

`applyResume`（`agent.go:789`）用 `reviewItemFingerprint`（mode+oldPath+newPath+diffText 的 SHA-256）匹配父 session checkpoint，复用项直接 `CommentCollector.Add` + `markReused`，未命中进 `toDispatch`。`ResolveIdentity`（`identity.go:45`）在 session 创建前计算身份（无副作用），`SealedInput`（`identity.go:25`）冻结 commit SHA 防止 ref 在 admission 和 dispatch 间移动——续审决策必须在 `session.New`（写 session_start）之前完成，否则 rejected resume 留磁盘痕迹。

### 成本估算与 RuntimeConfig

`estimateDiffCost`/`estimateDiffFileTokens`（`estimate.go:55`）按固定常量（`promptOverheadTokens=2000`/`avgMainRoundsPerFile=7`/`avgOutputTokensPerRound=700`）估算，是 floor 而非精确值（agent tool-use 会膨胀），用于 budget 预警和 per-file look-ahead gate。常量与 `internal/scan/estimate.go` 刻意同步但 re-declare 以避免 agent→scan 跨包依赖。`RuntimeConfig`（`agent.go:171`）是 `RuntimeConfig{Protocol, EndpointHost, Language, Timeout}`——非密钥白名单，`EndpointHost` 已被 `sanitizeEndpointHost` 脱敏，专供 manifest 的 `runtime_config_sha256`，密钥/token 永不外泄。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法 | `Run` (`agent.go:276`) | 编排固定骨架，子步骤 override |
| 建造者 | `Args` 27 字段 + `RuntimeConfig` | 逐步装配后整体传入 |
| 策略 | prompt 占位符替换 + `resolveSystemRule` | 不改模板结构，只做变量绑定 |
| 观察者 | `CommentCollector` 作 sink + coverage 状态转换 | 多 goroutine 写入，末尾聚合 |
| 委托/门面 | 委托 `llmloop.Runner` 执行工具循环 | agent 只管编排 |

## 模块间交互

agent 依赖 `llmloop`（Runner）、`llm`（Client/Message/ToolDef/RequestMeta）、`tool`（Registry/CommentCollector/DiffMap）、`session`（SessionHistory/ManifestBuilder/ResumeState）、`diff`（Provider/InputResolution）、`model`（Diff/LlmComment）、`config/{rules,template,toolsconfig}`、`gitcmd`、`telemetry`+`stdout`。被调用方：`cmd/shared.go` 的 `loadLLMRuntime` 调 `agent.BuildToolDefs` 装配工具定义 + 构造 `agent.RuntimeConfig`；`emitRunResult` 通过 `ResultProvider` 接口消费产出；`delegate_cmd.go:130` 调 `agent.Preview` 做预览（不开 LLM）。

## 扩展方式

- **改 prompt 模板**：改 `config/template` 的 `task_template.json`（增删占位符），在 `executeSubtask`（`agent.go:1259`）或 `executePlanPhase`（`agent.go:1693`）加 `strings.ReplaceAll` 行。
- **新增审查策略**（如对 test 文件走不同 prompt 分支）：在 `executeSubtask` Phase 2 前加路径判断选不同 template 消息集，或扩展 `resolveSystemRule` 规则解析。
- **改子审查聚合逻辑**（如按 severity 排序截断）：改 `dispatchSubtasks` 末尾聚合（`agent.go:745`），或在 `CommentCollector.Comments()` 返回前加后处理。
- **改 review filter 规则**：改 `filterTools`（`agent.go:1345`）的 ToolDef 或 `executeReviewFilter`（`agent.go:1399`）解析逻辑。
