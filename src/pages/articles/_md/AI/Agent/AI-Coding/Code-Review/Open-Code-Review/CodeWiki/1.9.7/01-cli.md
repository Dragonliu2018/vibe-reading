---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "命令行接口"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "cobra", "CLI", "bubbletea"]
description: "OpenCodeReview 命令行接口层——cobra 命令树、flag 解析、装配产物（commonContext/llmRuntime）、provider 交互式 TUI、Markdown/JSON/SARIF 输出格式化。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`cmd/opencodereview/`（约 8,500 行非测试 Go）是整个项目的接口层与装配中枢。它**不承载业务逻辑**——所有审查/扫描/会话逻辑都委托给 `internal/` 包。它的职责是三件事：解析命令行参数并校验、把跨 7 个 internal 包的依赖一次性物化成两个装配产物（`commonContext` 和 `llmRuntime`）下传给 agent、把 agent 产出的审查意见格式化输出（Markdown/JSON/SARIF）。它是 review/scan/delegate 三条路径的共享装配层，差异只在「是否建 LLMClient / 是否建 session / 是否并发」。

## 模块架构

cmd 层内部围绕 cobra 命令树组织，每个子命令一个文件，公共装配与输出逻辑抽到 `shared.go`/`output.go`/`shared_flags.go`：

```
cmd/opencodereview/
├── main.go            # main()：telemetry.Init + rootCmd.Execute
├── root.go            # ocr 根命令 + 10 子命令注册
├── review_cmd.go      # review（核心入口 executeReviewContext）
├── scan_cmd.go        # scan（executeScan）
├── delegate_cmd.go    # delegate（preview/rule）
├── session_cmd.go     # session（list/show/rm）
├── config_cmd.go      # config（set/get/provider/model）
├── llm_cmd.go         # llm（test/providers）
├── rules_cmd.go       # rules（check）
├── viewer_cmd.go      # viewer（StartServer）
├── shared.go          # 装配核心：loadCommonContext/loadLLMRuntime/emitRunResult
├── output.go          # 输出格式化（text/json）
├── sarif.go           # SARIF 输出
├── shared_flags.go    # 共享 flag（output/audience/exclude...）
├── provider_tui.go    # bubbletea 交互式 provider/model 配置（~3,000 行）
├── provider_cmd.go    # provider 命令
├── flag_suggest.go    # flag 拼写建议（levenshtein）
└── arg_errors.go completion.go version.go git.go background_file.go ...
```

核心组件：命令树（`root.go`）、装配器（`shared.go` 的 `loadCommonContext`/`loadLLMRuntime`/`emitRunResult`）、输出策略（`output.go`+`sarif.go`）、交互式 TUI（`provider_tui.go`）。它们通过 `ResultProvider` 接口（`shared.go:318`）抽象 agent/scan agent 的产出，使输出层无需区分调用方。

## 调用链路

review 命令的装配→执行→输出链（`executeReviewContext` in `review_cmd.go:110`）：

```
executeReviewContext(reviewOptions)
├─ loadCommonContext(repoDir, rulePath, maxTools, maxGitProcs, requireGit=true)
│    → *commonContext{Template, RepoDir, Resolver, FileFilter, GitRunner, IsGitRepo}
├─ applyCLIExcludes(cc, excludes)                 # 合并 --exclude
├─ validateReviewRefs(repoDir, opts)              # #112 ref 注入防护
├─ loadReviewResumeState(repoDir, opts) → *session.ResumeState
├─ loadLLMRuntime(cc.Template, toolConfigPath, ResolveOptions{Provider,Model})
│    → *llmRuntime{Client, Model, Provider, PlanToolDefs, MainToolDefs, Collector, RetryCollector, AppCfg, RuntimeConfig}
│      内部: toolsconfig.Load → agent.BuildToolDefs(plan/main) → llm.ResolveEndpointWithOptions → llm.NewLLMClient
├─ resolveMaxTokens(tpl, cfg, cli)
├─ validateResumeIdentity(ctx, cc, opts, rt, resumeState) → *agent.SealedInput
├─ buildToolRegistry(collector, fileReader)        # 注册 5 个内建工具
├─ initMCPClients + mcp.CollectToolDefs            # MCP 工具追加到 toolDefs
├─ agent.New(agent.Args{...27 字段...}) → *Agent
├─ ag.Run(ctx) → []model.LlmComment                 # 编排见 Agent 执行引擎模块
├─ rt.RetryCollector.Freeze(sessionID) → *llm.RetryReport
├─ reviewResultError(runErr, manifest)              # 决定 exit code
└─ emitRunResult(ctx, ag, comments, ..., format)
     ├─ diff.ResolveLineNumbers(comments, ag.Diffs())   # 行号重定位
     ├─ telemetry.RecordReviewDuration / PrintTraceSummary
     └─ outputJSONWithWarnings / outputSARIF / outputTextWithWarnings
```

scan 命令（`executeScan` in `scan_cmd.go:108`）复用 `loadCommonContext`（`requireGit=false`）、`loadLLMRuntime`，但用 `template.LoadScanDefault()`，并 `excludeToolDef(rt.MainToolDefs, "file_read_diff")`（scan 无 diff）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `loadCommonContext` (`shared.go:72`) | 装配 template/rules/gitrunner | `requireGit` 区分 review/scan；`resolveWorkingDir` 用 `--show-toplevel` 锚定 monorepo 根（修 #287） |
| `loadLLMRuntime` (`shared.go:187`) | 装配 LLM client+toolDefs | `sanitizeEndpointHost` 剥离凭证只留 host，供 manifest 的 `runtime_config_sha256`，密钥不外泄 |
| `emitRunResult` (`shared.go:367`) | 行号定位+输出 | `isMachineReadable` 控制 json/sarif 静默 stdout（单一文档不能混进度行） |
| `validateReviewRefs` (`review_cmd.go:457`) | ref 注入防护 | `--end-of-options` 确保 `^{commit}` 不被当 option |
| `flagErrorWithSuggestion` (`flag_suggest.go:16`) | flag 拼写建议 | levenshtein ≤2 找最接近 flag |
</details>

## 核心实现

### 装配产物 commonContext 与 llmRuntime

`loadCommonContext`（`shared.go:72`）把 review/scan 在调 LLM 前需共享的启动序列固化：`template.LoadDefault` 加载嵌入式 YAML 模板、`resolveWorkingDir` 在 git repo 用 `--show-toplevel` 锚定仓库根（修复 monorepo 子目录下相对路径无法解析的 #287）、`rules.NewResolver` 加载四层规则、`gitcmd.New(maxGitProcs)` 创建全局 git 子进程 limiter。`requireGit` 参数区分两者：review 强制 git（diff 概念依赖 git），scan 允许非 git 目录。

`loadLLMRuntime`（`shared.go:187`）把 LLM 侧状态独立成一个 bundle，因为 `toolDefs` 来自 `toolsconfig`、`client` 来自 endpoint 解析、`collector` 是 per-run 的——三者生命周期不同但都需在 `agent.New` 前就绪。`sanitizeEndpointHost`（`shared.go:241`）剥离 URL 的 scheme/userinfo/path/query/fragment，只留小写 `host[:port]`，确保 `RuntimeConfig.EndpointHost` 不泄露密钥到 manifest 的 `runtime_config_sha256`。

### emitRunResult 与行号定位

`emitRunResult`（`shared.go:367`）在格式化输出前调 `diff.ResolveLineNumbers(comments, ag.Diffs())`——LLM 返回的 comment 行号是相对 diff hunk 内的偏移，需映射回文件绝对行号（详见 Diff 模块）。此调用保证三种输出格式都拿到正确行号。`isMachineReadable`（`shared.go:290`）控制 json/sarif 是否静默 stdout：机器可读格式必须是单一文档，不能混入进度行。

### Provider 交互式 TUI

`provider_tui.go`（~3,000 行）用 bubbletea 的 Model-Update-View 模式实现交互式 provider/model 配置。`providerTUIModel`（`provider_tui.go:118`）实现 `Init()`/`Update()`/`View()`，通过 `tuiStep`/`providerTab`/`customProviderStep`/`manualStep` 枚举驱动多步骤状态机，引导用户选 provider、输 API key、选 model，然后自动测连通性。用于 `ocr config provider` 和 `ocr config model`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 命令模式 | `root.go:32` `AddCommand` | cobra 命令树，子命令自包含 |
| 策略（输出多态） | `shared.go:367` 按 `outputFormat` 分发 | `ResultProvider` 接口让 review/scan 共享输出路径 |
| MVU TUI | `provider_tui.go` bubbletea | 状态机驱动多步骤配置向导 |
| 装配产物 | `commonContext`/`llmRuntime` | 跨 7 包依赖物化为 struct，下游不回头调 cmd |
| flag 建议 | `flag_suggest.go:16` | 用户体验：拼写错误给「Did you mean」 |

## 模块间交互

cmd 层是纯装配层，依赖几乎全部 `internal/` 包：`agent`/`scan`/`session`/`llm`/`diff`/`tool`/`mcp`/`delegate`/`viewer`/`config`(rules/template/toolsconfig/testconnection)/`telemetry`/`model`/`gitcmd`/`llmloop`/`stdout`/`suggestdiff`。交互方式全是函数调用 + struct 传递（`agent.Args` 27 字段一次性下传）。无循环依赖——cmd 单向依赖 internal。

## 扩展方式

- **新增子命令**（如 `ocr report`）：新建 `report_cmd.go` 定义 `var reportCmd = &cobra.Command{...}` + `init()` 注册 flag，在 `root.go` 的 `init()` 加 `rootCmd.AddCommand(reportCmd)`。共享 flag 提取到 `shared_flags.go`。
- **新增输出格式**（如 XML）：在 `output.go` 加 `outputXML(...)`；在 `emitRunResult`（`shared.go:419`）format 分支加 `if outputFormat == "xml"`；在 `shared_flags.go` 的 `completeEnum` 加 `"xml"`；在 `isMachineReadable` 决定是否静默。
- **新增共享 flag**：在 `shared_flags.go` 加 `addXxxFlag(cmd, target)`，在 review/scan 的 `registerXxxFlags` 调用，在 `reviewOptions`/`scanOptions` 加字段。
