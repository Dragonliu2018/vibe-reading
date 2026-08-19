---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "Diff 解析与行号定位"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Git", "Diff", "LineResolver"]
description: "OpenCodeReview Diff 解析与行号定位——unified diff 状态机解析、三种 Mode 来源、ResolveLineNumbers 三级字符串匹配、跨文件重定位，解决「位置漂移」的工程解。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/diff/`（约 1,420 行，被 8 个文件 import）是「确定性工程」最直接的体现。它做两件事：解析 git diff（三种 Mode）产出 `model.Diff`，以及把 LLM 审查意见的 `ExistingCode` 通过字符串匹配映射回真实行号（`ResolveLineNumbers`）。后者正是 README 强调的「独立定位/反思模块」——LLM 无法可靠计数行号，但 `ExistingCode` 是代码摘录，通过确定性匹配可精确定位，从根上解决通用 agent 的「位置漂移」痛点。

## 模块架构

```
internal/diff/
├── git.go             # Provider：git diff 获取（三种 Mode 构造器）+ GetDiff
├── resolver.go        # ResolveLineNumbers 三级匹配 + indexedLine
├── parser.go          # ParseDiffText 状态机解析 unified diff
├── relocation.go      # ReLocateComment（LLM 重新生成 ExistingCode）+ BuildReLocationMessages
├── hunk.go            # Hunk/HunkLine 结构 + ParseHunks
├── workspace_file.go  # workspace 模式文件读取
└── gitignore.go       # .gitignore 模式加载
```

核心组件：`Provider`（git diff 封装，三种构造器）、`Hunk`/`ParseDiffText`（解析器）、`ResolveLineNumbers`/`indexedLine`（行号定位）、`ReLocateComment`（LLM 重定位）。`InputResolution`（`ResolvedBase`/`ResolvedHead`/`ExactRange`）冻结每次运行的不可变 commit 端点，与 `agent.SealedInput` 协作防 ref 漂移。

## 调用链路

完整链路：**获取 diff → 解析 hunk → 过滤 → 逐文件 dispatch → Plan/Main LLM 审查 → ResolveLineNumbers 重定位**：

```
# 获取与解析（agent.go:519-526 创建 Provider）
diff.NewCommitProvider / NewProvider(range) / NewWorkspaceProvider
  └─ provider.GetDiff(ctx)  # git.go：按 Mode 调 git diff/git show/workspace
       └─ ParseDiffText(rawDiffText)  # parser.go：状态机扫描 → []model.Diff

# 审查后重定位（cmd/shared.go:377 emitRunResult）
emitRunResult
  └─ diff.ResolveLineNumbers(comments, ag.Diffs())  # resolver.go:15
       ├─ resolveFromHunk（hunk 内匹配，new 侧优先 → old 侧）+ matchConsecutive 滑动窗口
       ├─ resolveFromFileContent（全文件 NewFileContent 逐行扫描兜底）
       └─ RelocateAcrossFiles（跨所有 diff 字符串匹配，仅唯一命中才重定位）

# code_comment 工具内（llmloop/loop.go:566）
executeToolCall → diff.ResolveComment → RelocateAcrossFiles → BuildReLocationMessages → ReLocateComment（LLM 重新生成）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Provider.GetDiff` (`git.go`) | 按 Mode 获取 diff | Range `merge-base..to`；Commit `--diff-merges=first-parent` |
| `ParseDiffText` (`parser.go`) | 解析 unified diff | `inHunk` 状态机区分 header 与 content |
| `ResolveLineNumbers` (`resolver.go:15`) | 行号重定位 | 三级匹配链，用 `normalizeLine` 归一化 |
| `resolveFromHunk` (`resolver.go`) | hunk 内匹配 | new 侧优先 → old 侧；`matchConsecutive` 滑动窗口 |
| `RelocateAcrossFiles` (`resolver.go`) | 跨文件重定位 | 仅唯一命中才重定位，多命中放弃 |
| `ReLocateComment` (`relocation.go`) | LLM 重新生成 ExistingCode | 与 llm/telemetry 解耦的封装 |
</details>

## 核心实现

### ResolveLineNumbers 位置漂移解法

这是 README 强调的「确定性工程」亮点。LLM 返回的意见只携带 `ExistingCode`（代码片段）而非真实行号——因为 LLM 无法可靠计数。`ResolveLineNumbers` 通过三级匹配定位真实行号：

1. `resolveFromHunk`——在 diff hunk 内匹配，`extractSideLines` 先取 new 侧（context+added 行 + new-file 行号），再取 old 侧；`matchConsecutive` 做滑动窗口精确匹配。
2. `resolveFromFileContent`——全文件 `NewFileContent` 逐行扫描兜底。
3. `RelocateAcrossFiles`——当 `ExistingCode` 属于另一个文件时（声明/实现分离场景），跨所有 diff 做字符串匹配，**仅在唯一命中时重定位**，多命中则放弃——避免用一次错误替换另一次错误。

所有匹配用 `normalizeLine`（trimSpace + 去除 `+`/`-` diff marker）做归一化，`splitAndNormalize` 跳过空行——「连续」指相邻非空行，使空行不破坏窗口匹配。LLM 产出的行号不可信，但 `ExistingCode` 是代码摘录，通过确定性字符串匹配可精确定位，避免依赖 LLM 计数能力。

### Parser 状态机

`ParseDiffText`（`parser.go`）用 `inHunk` bool 状态区分 header 与 content 行——outside hunk 时 `+++ b/file` 是文件 header，inside hunk 时 `+++i`（某 added line 内容恰好为 `+i`）是 insertion。不加状态判断会把 hunk 内的 `+++` content 行误判为 header，导致 insertions 计数错误。`finalizeDiff` 在 commit/range 模式用 `git show ref:path` 读文件，workspace 模式用 `readWorkspaceFileForDiff` 读磁盘。

### 三种 Mode 的 diff 来源差异

`git.go:GetDiff` 按模式分派：Range 模式 `git diff merge-base..to`；Commit 模式 `git show --diff-merges=first-parent`——注释明确解释 plain `git show` 对 merge commit 产出 `diff --cc` combined diff，`ParseDiffText` 无法解析，会静默产出零个可审查 diff；Workspace 模式先 `git diff HEAD`，失败时 fallback `git diff --staged`（处理 unborn repo 无 HEAD），再对 untracked 文件用 `ls-files --others` 枚举并手工合成 `--- /dev/null` diff。

### 过滤

`filterDiffs`（`git.go`）用 `.gitignore` + 硬编码 `providerDirIgnoreDirs` 过滤。`gitignore.go` 用 `bmatcuk/doublestar/v4` 支持 `**` glob。

> **关于「智能文件打包（bundling）」**：README 声称把 `message_en/zh` 等相关文件打包为一个审查单元。`internal/diff/` 包内无 bundling 逻辑——scan 模式按语言/目录分批（`scan/batch.go`），delegate 模式按相同 rule text 分组（`delegate/rulegroup.go`），review 模式 `agent.go:dispatchSubtasks` 逐文件 dispatch 但通过 `buildChangeFilesExcept` 将变更文件列表注入 Plan prompt 的 `{{change_files}}` 占位符做相关文件感知。README 的 bundling 描述可能是规划中或在其他维度实现——待核实。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 适配器 | `Provider`+`runGit` (`git.go`) | 封装 `gitcmd.Runner`，三种构造器对应三 Mode |
| 状态机解析器 | `ParseDiffText` (`parser.go`) | `inHunk` 区分 header/content |
| 策略（行号匹配） | `resolver.go` 三级策略链 | hunk→fileContent→crossFile 逐级兜底 |
| 模板方法 | `finalizeDiff` (`parser.go`) | commit/range 用 `git show`，workspace 读磁盘 |

## 模块间交互

diff 依赖 `gitcmd`（Runner 执行 git 命令）、`model`（Diff/LlmComment/CodeReviewResult）、`llm`（LLMClient/Message/ChatRequest，用于 re-location）、`config/template`（LlmConversation）、`telemetry`（LLMSpan）、`pathutil`（CanonicalPath/WithinBase 防路径逃逸）、`doublestar/v4`。被调方：`agent/agent.go`（Provider 创建 + GetDiff + ResolveInput + RemoteIdentity）、`cmd/shared.go:emitRunResult`（`ResolveLineNumbers`）、`llmloop/loop.go:566`（`ResolveComment`→`RelocateAcrossFiles`→`BuildReLocationMessages`→`ReLocateComment` 四级定位链）、`delegate_cmd.go`（`NewProvider`+`MergeBase`）、`agent/identity.go`（`ResolveInput` 身份解析）。

## 扩展方式

- **新增打包分组规则**（如按 stem 将 `message_en/zh` 配对）：review 模式改 `agent.go:dispatchSubtasks` 将 `toDispatch` 按 stem 分组后整组 dispatch；scan 模式改 `scan/batch.go` 新增 `BatchStrategy` + `batchKeyFunc`。
- **改行号映射逻辑**（如支持 fuzzy 匹配容忍空白差异）：改 `resolver.go:normalizeLine`（当前只 trimSpace+去 marker）或 `matchConsecutive`（当前精确匹配）；改 LLM 重定位 prompt 则改 `relocation.go:BuildReLocationMessages`。
- **新增 diff 来源**（如支持 stash diff）：改 `git.go:GetDiff` switch 加 case + 对应构造器 + `Mode` 常量，并在 `ResolveInput` 加端点解析。
