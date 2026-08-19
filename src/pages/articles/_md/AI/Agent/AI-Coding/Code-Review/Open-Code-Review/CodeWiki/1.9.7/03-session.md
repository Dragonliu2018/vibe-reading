---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "审查会话编排"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Session", "Resume", "Manifest"]
description: "OpenCodeReview 审查会话编排——RunManifest coverage 快照、断点续审（resume）、密封身份防 ref 漂移、JSONL append-only 持久化、会话列表查询。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/session/`（约 2,860 行，被 13 个文件 import）管理一次审查 run 的完整生命周期：会话清单（manifest）构建与冻结、断点续审（resume）、JSONL 持久化、历史会话查询。它是「确定性工程」在会话维度的体现——通过 coverage 五不相交集合 + 密封身份，保证 partial 结果可发布、续审安全（拒绝不留孤儿）、ref 漂移防护。`agent.go` 是它的最大消费者，几乎每个 manifest 方法都有调用点。

## 模块架构

```
internal/session/
├── manifest.go         # RunManifest + ManifestBuilder（两段式不可变构建）
├── history.go          # SessionHistory 顶层容器 + finalizeOnce 幂等收尾
├── persist.go          # jsonlWriter（append-only JSONL + parentUuid 链）
├── resume.go           # ResumeState（重放父 session 的只读 checkpoint 索引）
├── resume_identity.go  # ValidateResume（身份密封校验，防 ref/隐式漂移）
├── list.go             # ListSessions/LoadDetail（历史会话查询）
├── comments.go         # LoadComments（评论聚合，后发覆盖先发）
└── testing.go          # 测试辅助
```

核心组件：`ManifestBuilder`（构建器）、`jsonlWriter`（持久化）、`ResumeState`（续审索引）、`ResumeRequest`/`RunIdentity`/`ResumeLineage`（身份密封三件套）。它们通过 `SessionHistory` 顶层容器聚合：它持有 `ManifestBuilder`、`finalManifest`、`persist`。

## 调用链路

一次 review 会话的创建→持久化→续审→聚合链：

```
review_cmd.go:146 loadReviewResumeState(repoDir, opts)
  └─ session.LoadReviewResumeState (resume.go:107, skipUnparseable=true)
       重放父 session JSONL → ResumeState{Items, Manifest, Closed}

review_cmd.go:375 validateResumeIdentity(ctx, cc, opts, rt, resumeState)
  ├─ agent.ResolveIdentity (identity.go:45)   # 不创建任何 session/manifest，算 RunIdentity
  └─ state.ValidateResume(ResumeRequest{Identity, Provider, Model, *Explicit})  # resume_identity.go:50

agent.New (agent.go:218) → session.New (history.go:150)
  ├─ 生成 sessionID，创建 jsonlWriter 写 session_start
  └─ if opts.Operation != "" → 创建 ManifestBuilder

agent.initManifest (agent.go:864)  # SetInput/SetExecution/ParentRunID
agent.registerCoverage (agent.go:1158)  # RegisterSelected + SealSelected（冻结分母）
agent.applyResume (agent.go:789)  # fingerprint 匹配 → ReusableItem → markReused 或加入 toDispatch

# 子审查执行中：RecordReviewItemDone (history.go:252) 落 checkpoint + manifest.MarkCompleted/Failed
agent.finalizeManifest (agent.go:1180) → ManifestBuilder.Finalize (manifest.go:742)
  # sweep（仍 selected→failed）+ validate + computeTerminal + freeze
session.Finalize (history.go:319) → jsonlWriter.WriteSessionEnd (persist.go:363)
  # manifest 嵌入 session_end 最后一条物理记录，flush+close
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `ManifestBuilder.SealSelected`/`Finalize` (`manifest.go`) | 两段式冻结 | sealed→frozen，防并发写；`cloned()` 深拷贝交付 |
| `LoadReviewResumeState` (`resume.go:107`) | 重放父 session 得 checkpoint 索引 | `skipUnparseable=true` 容忍坏行 |
| `ReusableItem` (`resume.go:240`) | 判断文件可否复用 | checkpoint 行 + 父 manifest 双重背书 |
| `ValidateResume` (`resume_identity.go:50`) | 身份密封校验 | Mode/RepositorySHA/SourceArtifactSHA/RuleConfigSHA 全等 |
| `Finalize` (`history.go:319`) | 幂等收尾 | `finalizeOnce sync.Once`，多路径并发安全 |
</details>

## 核心实现

### RunManifest 与 coverage 五集合

`RunManifest`（`manifest.go:274`，schema `ocr.run-manifest/v1`）是单次 run 的不可变、版本化 coverage 快照，同时序列化到 CLI JSON 和持久化 session 文件，保证两个出口算不出两份 coverage。`Coverage`（`manifest.go:231`）定义五个不相交文件集：`Selected`（分母）= `Completed ∪ Reused ∪ Failed ∪ Waived`。`CoverageItem.ItemID` 由 `ItemID(operation, mode, oldPath, newPath)` SHA256 派生，**内容无关**，使同一逻辑文件跨 resume 链稳定；`Fingerprint` 才含 diff 内容，用于 checkpoint 匹配。`TerminalState`（`computeTerminal` `manifest.go:941`）从 coverage 派生：有 `RunFailure` 必 `failed`；`selected=0` 为 `skipped`；`failed=0` 为 `complete`；全 `failed` 为 `failed`；否则 `partial`——替代旧的 `completed_with_errors` 启发式，让消费者可 switch on 枚举可靠推断。

### 密封身份防 ref 漂移

这是整个 resume 安全模型的咽喉，三层联动：

1. `agent.ResolveIdentity`（`identity.go:45`）在**任何 session/manifest 创建前**算出 `RunIdentity`（Mode/SourceArtifactSHA256/RuleConfigSHA256/RepositorySHA256），其中 `sourceArtifactSHA256` 哈希两次过滤后的 selected set——漏一个 filter pass 就得到一个永不被记录的 digest，resume 会误拒。
2. `state.ValidateResume`（`resume_identity.go:50`）先 `validateInputIdentity` 逐字段比对：父 manifest 必须存在且 schema/operation/selected 非空；Mode 必须相同（否则 item_id 无法对齐）；RepositorySHA256/SourceArtifactSHA256/RuleConfigSHA256 必须全等。**全等而非降级部分复用**——混合两份输入算出的结果没有任何字段能区分，报告会自相矛盾。provider/model 单独处理：未显式传 flag 而变了（config/env 改的）就拒绝，防「隐式漂移」；显式传 flag 才允许跨 provider/model resume。
3. `SealedInput`（`identity.go:25`）把预检解析的 commit 端点 `diff.InputResolution` 回传给 run，`review_cmd.go:227` 注入 agent，运行期 diff 加载和 file_read 都用**冻结的 commit** 而非用户输入的 ref——ref 可能在预检后移动，不密封就会「预检通过、运行期实际跑新 commit」，把密封决定架空。

`review_cmd.go:375 validateResumeIdentity` 把三者串起来，注释明说「必须在 agent.New 之前，否则 session_start 已落盘」。

### JSONL 持久化

`persist.go` 的 `jsonlWriter` 是 append-only JSONL 流 + `parentUuid` 链——每条记录带 uuid/parentUuid 串联。checkpoint 类记录（`review_item_done`/`reused`/`failed`、`resume_lineage`）写后立即 `Flush`，让 run 中途崩溃也不丢断点。路径 `$HOME/.opencodereview/sessions/<encodeRepoPath(repoDir)>/<sessionID>.jsonl`，权限 0700 目录/0600 文件。记录类型：`session_start`/`review_item_done`/`review_item_reused`/`review_item_failed`/`llm_request`/`llm_response`/`llm_error`/`tool_call`/`resume_lineage`/`session_end`。`session_end` 带 `run_manifest` 字段，是最后一条物理记录。`sanitizeReason`（`manifest.go:662`）是 redaction floor：strip URL credentials/Bearer/secret key=value、控制字符、UTF-8 coerce、500 rune 截断。

### resume 定位断点

`LoadReviewResumeState`（`resume.go:107`，`skipUnparseable=true`）逐行重放，`applyResumeLine`（`resume.go:150`）按 type 折叠：done/reused 写入 `Items[fingerprint]`，failed 删除同 fingerprint 项（retract）。review 复用依赖父 manifest 而非行本身——`ReusableItem`（`resume.go:240`）先 `manifestReusableFingerprints` 收集 Completed+Reused 的 fingerprint 白名单，行不在白名单就不复用。这是「一个被丢的 review_item_failed 行无害」的根本原因：父 manifest 也记录了失败，coverage 不会撒谎。`LoadResumeState`（`skipUnparseable=false`）用于 scan，一行坏就整体失败（scan 无 manifest 兜底）。

### 会话列表查询

`list.go` 的 `ListSessions`（`list.go:109`）枚举 sessions 目录下 `.jsonl` 文件，`loadSummaryFromFile` 调 `walkSessionFile` 重放并 `applyRecordToSummary` 折叠成 `Summary`。session_end 的 run_manifest 若 schema 匹配则取 manifest 覆盖计数，否则标 `Legacy=true` 从 checkpoint 行兜底计数，按 StartTime 倒序。`LoadComments`（`comments.go:17`）按 fingerprint 后发覆盖先发、failed 清零的语义聚合评论。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Builder + Freeze | `ManifestBuilder` (`manifest.go:330`) | 两段式不可变构建，sealed→frozen |
| Append-only JSONL + parentUuid 链 | `jsonlWriter` (`persist.go`) | 崩溃不丢断点，记录可溯源 |
| Resume = 重放只读索引 + 双重证据 | `ResumeState` (`resume.go`) | checkpoint 行 + 父 manifest 双背书，单方面坏行不误复用 |
| Sealed Input / 密封身份 | `identity.go`+`resume_identity.go` | 预检冻结 commit 端点，运行期不二次比对 |
| sync.Once 幂等收尾 | `SessionHistory.Finalize` (`history.go:319`) | 多路径并发安全，所有调用方见同结果 |

## 模块间交互

session 依赖 `internal/llm`（Message/ToolCall/CountTokens）、`internal/model`（LlmComment）、`internal/diff`（InputResolution，经 `agent.SealedInput` 传入）。被调用方：`cmd/review_cmd.go`（`ValidateResume`/`LoadReviewResumeState`）、`scan_cmd.go`（`LoadResumeState`）、`session_cmd.go`（`ListSessions`/`LoadDetail`/`LoadComments`）、`internal/agent/agent.go`+`identity.go`（manifest 全套 API、`New`、`Finalize`、`RecordReviewItem*`、`ResolveIdentity`）、`internal/viewer`（`store.go` 反序列化 `RunManifest`）。

## 扩展方式

- **新增 coverage 类别/状态**：改 `manifest.go` 的 `itemState`/`Coverage`/`computeTerminal`/`buildCoverageLocked`/`transition` 加状态，并在 `validateLocked` 加不变式。`ManifestSchemaVersion` 是冻结的 v1，breaking 需升 schema 版本并在 `applyResumeLine`/`applyRecordToSummary` 做向前兼容。
- **改持久化格式/新增记录类型**：改 `persist.go` 的 `jsonlWriter` 加 `WriteXxx`，同步改 `resume.go:resumeRecord`、`list.go:summaryRecord`（两者是 JSONL 行的 struct 镜像），以及 `applyResumeLine`/`applyRecordToSummary` 的 switch 加 case。
- **新增会话查询维度**（如按 provider/terminal_state 过滤）：改 `list.go` 的 `Summary` 加字段 + `applyRecordToSummary` 填充 + `ListSessions` 加过滤参数；若维度来自 manifest 直接读 `Summary.RunManifest` 无需改重放。
