---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "Overview"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "代码审查", "AI Agent", "LLM", "MCP", "OpenTelemetry"]
description: "OpenCodeReview v1.9.7 源码架构解读——阿里开源 AI 代码审查 CLI，确定性工程 × Agent 混合架构，从 CLI 命令到 Agent 引擎、LLM 工具循环、行号定位、会话续审的 11 个核心模块 internals。"
readingTime: "55 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v1.9.7 · **协议** Apache-2.0 · **语言** Go 1.25.5 · **代码量** ~28,000 行业务 + ~8,500 行 CLI · **仓库** [GitHub](https://github.com/alibaba/open-code-review)

---

## 总览

### 项目简介

**OpenCodeReview**（命令名 `ocr`）是阿里巴巴开源的 AI 代码审查 CLI 工具。它源自阿里集团内部的官方 AI 代码审查助手——过去两年在内部服务了数万名开发者、识别出百万级代码缺陷，经过大规模验证后孵化为开源项目。只需配置一个模型端点即可上手。

它读取 Git diff，把变更文件通过一个**带 tool-use 能力的 agent**发给可配置的 LLM，生成**行级精确**的结构化审查意见。agent 可以读取完整文件内容、搜索代码库、查看其他变更文件作为上下文，从而产出深度审查而非表面 diff 反馈。除了 diff 审查，`ocr scan` 还能审查整个文件，用于审计陌生代码库或没有有意义 diff 的目录。

这个项目的核心哲学是 **「确定性工程 × Agent 混合」**——README 把它作为对外宣讲的标题。其出发点是对通用 agent（如 Claude Code + Skills 做代码审查）痛点的反思：

- **覆盖不全**：大 changeset 上 agent 倾向于「偷懒」，只审查部分文件；
- **位置漂移**：报告的行号/文件经常对不上真实代码位置；
- **质量不稳**：纯语言驱动的 Skill 难以调试，prompt 微调就导致质量波动。

根因是**纯语言驱动架构对审查流程缺乏硬约束**。OpenCodeReview 的解法是把「绝不能出错的步骤」交给工程逻辑（确定性），把「动态决策」交给 agent。一个对比基准（50 个开源仓库、200 个真实 PR、10 种语言、80+ 资深工程师标注 1505 条 ground truth）显示：与 Claude Code 通用 agent 相比，同模型下 OpenCodeReview 的 **Precision 和 F1 显著更高，token 仅约 1/9，且更快**——Recall 刻意较低，是用召回换精确度与低噪声的有意取舍。

**项目边界**：OpenCodeReview 负责审查（产出结构化审查意见），不负责自动改代码。在委托模式（Delegation）下由宿主 coding agent 决定是否修复；OCR 仅做确定性的文件选择与规则解析。它是一个 CLI/CI 工具，不是一个代码生成器。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|----------|------|
| diff 审查 | `cmd/opencodereview/review_cmd.go` · `internal/agent/agent.go` | workspace/range/commit 三种模式，agent + 工具循环深度审查 |
| 全文件扫描 | `cmd/opencodereview/scan_cmd.go` · `internal/scan/agent.go` | 不依赖 git diff，整文件/目录审查，批次切分 |
| 委托模式 | `cmd/opencodereview/delegate_cmd.go` · `internal/delegate/` | OCR 管文件选择+规则，宿主 agent 用自己的 LLM 执行审查 |
| 断点续审 | `internal/session/resume.go` · `resume_identity.go` | 基于 fingerprint + 密封身份，跨中断恢复，防 ref 漂移 |
| 会话查看器 | `cmd/opencodereview/viewer_cmd.go` · `internal/viewer/` | 浏览器端浏览/回放审查会话，DNS rebinding 防护 |
| 多 provider | `internal/llm/providers.go` · `resolver.go` | ~25 家内置 provider，三种 API 协议，API key 可从命令解析 |
| 行号定位 | `internal/diff/resolver.go` · `relocation.go` | 三级字符串匹配 + LLM 重定位，解决「位置漂移」 |
| 规则匹配 | `internal/config/rules/` · `template/` | 模板引擎 + glob 规则匹配，比纯语言驱动更稳定 |
| MCP 扩展 | `internal/mcp/` | Model Context Protocol 接入外部工具扩展 agent 能力 |
| 遥测 | `internal/telemetry/` | OpenTelemetry span/metric，一次审查一个 trace |
| SARIF 输出 | `cmd/opencodereview/sarif.go` | 标准 SARIF 格式供 CI 集成 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Go 1.25.5 | 核心 | 主语言，`net/http` mux、`html/template`、`embed` |
| spf13/cobra | 核心 | CLI 命令树与 flag 解析 |
| charmbracelet/bubbletea | 核心 | Provider/Model 交互式 TUI |
| anthropic-sdk-go | 核心 | Anthropic Messages API client |
| openai-go/v3 | 核心 | OpenAI Chat Completions + Responses API client |
| tiktoken-go | 核心 | token 估算，BPE 数据 `go:embed` 内嵌离线可用 |
| mark3labs/mcp-go | 可选 | MCP 客户端，stdio + 远程 HTTP |
| bmatcuk/doublestar/v4 | 核心 | gitignore glob `**` 匹配 |
| go-opentelemetry.io/otel | 可选 | OpenTelemetry SDK |
| GitHub Action / npm | 分发 | `action.yml` GitHub Action、`@alibaba-group/open-code-review` npm 包 |

### 版本历史

项目版本演进到 v1.9.7。从 git log 可见近期重点：新增内置 provider（Gemini）、扩展语言支持（R、Zig、Elm、Thrift、Cap'n Proto、`.ipynb`、Jsonnet）、配置支持从命令解析 `api_key`/`auth_token`、安装支持 `OCR_GITHUB_MIRROR` 镜像下载资产、多语言 README（中/日/韩/俄）、i18n 页面。架构层面，「确定性工程 × Agent 混合」是贯穿版本的主线——行号定位反思模块、密封身份续审、模板引擎规则匹配都是这条主线的具体落地。

### 顶层上下文图

OpenCodeReview 作为 CLI 工具，与外部角色/系统的边界：

- **用户/CI**：在终端或 CI 流水线中运行 `ocr review`/`scan`/`delegate`；
- **LLM Provider**：OpenAI/Anthropic/Gemini/DashScope/DeepSeek 等 ~25 家，OCR 通过 HTTP 调用；
- **Git 仓库**：OCR 依赖 Git ≥ 2.41 做 diff 生成、代码搜索、仓库操作；
- **宿主 Coding Agent**（Claude Code/Codex/Cursor/OpenCode）：在委托模式下，OCR 把文件清单+分组规则交给宿主 agent，由后者用自己的 LLM 驱动审查；
- **MCP 工具服务器**：可选，外部 stdio/HTTP 进程扩展 agent 的工具能力；
- **OTel 后端**（如 Langfuse）：可选，接收 span/metric 做可观测性。

---

## 快速上手

```bash title="安装与首次审查"
# 安装（npm 全局，提供 ocr 命令）
npm install -g @alibaba-group/open-code-review

# 配置 LLM provider 与 model（交互式 TUI 引导，含连通性测试）
ocr config provider
ocr config model

# 进入项目，审查工作区所有变更
cd your-project
ocr review

# 端到端验证：审查某分支相对 main 的变更
ocr review --from main --to feature-branch
# 预期输出：结构化审查意见，含 path/start_line-end_line/severity/category
```

委托模式无需配置 LLM（OCR 侧 LLM-free）：`ocr delegate preview` 输出可审查文件清单，`ocr delegate rule src/main.go` 输出按规则分组的 markdown 交给宿主 agent。

> 内部调用链（main 走了哪些步骤、连接怎么建立）见「运行时行为 > 启动流程」。本节只回答「怎么让项目跑起来」。

---

## 架构设计解析

### 系统架构

OpenCodeReview 的架构思想是**分层 + 装配产物驱动**：上层是纯装配层，把跨多个包的依赖一次性物化成 struct（`commonContext` 和 `llmRuntime`），下游通过 `Args` 字段复制拿走，不再回头调上层。这使得 review/scan/delegate 三条路径能复用同一装配逻辑，只在「是否建 LLMClient / 是否建 session / 是否并发」上分叉。五层自顶向下依赖：

![OpenCodeReview 分层架构](/vibe-reading/images/articles/open-code-review/architecture.svg)

分层用文字解读：**接口层**用 cobra 构建命令树，用 bubbletea 做 provider 配置 TUI，用 `ResultProvider` 接口让 review/scan 两种 agent 的产出走同一输出路径（Markdown/JSON/SARIF）——这是「策略模式」让输出多态。**编排层**是两个 agent（`ReviewAgent` 负责 diff 审查、`ScanAgent` 负责全文件扫描）加会话编排（`session`），agent 做「审什么、怎么编排」，把「单文件内工具往返」委托给执行层。**执行层**的 `llmloop` 是通用 LLM 工具循环引擎（不感知审查语义），`tool` 是从生产 trace 蒸馏的场景化工具集，`mcp` 把外部工具适配进 `tool.Provider` 接口。**能力层**提供 LLM provider 抽象（含重试三件套）、diff 解析与行号定位、git 子进程限流封装。**基础层**是被高频依赖的共享件——配置体系（模板引擎 + 规则匹配 + allowlist）、数据模型（`model.Diff`/`LlmComment`/`ScanItem`）、遥测、路径/输出工具。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接口层 | `cmd/opencodereview/` | 隔离外部交互（CLI/TUI/输出格式），保护核心不受协议变化影响 |
| 编排层 | `internal/agent/` `internal/scan/` `internal/session/` | 编排审查/扫描流程，协调 agent 与会话状态，承载「确定性约束 + 动态决策」边界 |
| 执行层 | `internal/llmloop/` `internal/tool/` `internal/mcp/` | 驱动 LLM↔tool 往返、提供场景化工具、接入外部工具 |
| 能力层 | `internal/llm/` `internal/diff/` `internal/gitcmd/` | 适配 LLM provider、解析 diff 与定位行号、封装 git 子进程 |
| 基础层 | `internal/config/` `internal/model/` `internal/telemetry/` `internal/stdout/` `internal/pathutil/` | 共享配置/数据模型/可观测性/基础设施 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 命令模式 | `root.go` `AddCommand` | cobra 命令树，每个子命令自包含 flag 定义与 `RunE` |
| 模板方法 | `agent.Run` in `agent.go:276` · `template.LoadDefault` in `template.go:123` | 编排固定骨架（loadDiffs→filter→dispatch→finalize），子步骤可变；prompt 模板 manifest + prompts 分离 |
| 建造者 + Freeze | `ManifestBuilder` in `session/manifest.go:330` · `tool.Registry.Freeze` | 两段式不可变构建（sealed→frozen），运行期只读，防并发写 |
| 策略 | 三 API 协议 in `llm/client.go` · 输出格式 in `shared.go:367` · 行号匹配 in `diff/resolver.go` | 同接口多实现按 Protocol/format/匹配级别分派 |
| 观察者 | `retryObserver` in `llm/retry_observer.go` · `CommentCollector` | retry middleware 在 SDK 循环内记录 attempt；collector 作 comment sink |
| 注册表 | `llm/providers.go` `registry` · `tool.Registry` · `mcp.RegisterAll` | provider/工具静态注册 + 运行期 freeze，MCP 动态发现 |
| 适配器 | `mcp.Provider` in `mcp/provider.go:17` · `FileReader` in `tool/filereader.go` | MCP `CallTool` → `tool.Provider`；workspace 磁盘 vs `git show` 统一 |
| 装配产物 | `commonContext`/`llmRuntime` in `cmd/shared.go` | 把跨 7 包依赖物化为 struct，下游不回头调 cmd |
| 密封身份 | `agent.SealedInput`/`identity.go` + `session/resume_identity.go` | 冻结 commit SHA 防 ref 漂移，续审决策在 session 创建前完成 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `model.Diff` | 单文件 git 变更（含 unified diff 文本、NewFileContent、增删行数） | 一次 review run | 由 `diff.Provider` 产出，被 agent/tool/llmloop 消费 |
| `model.LlmComment` | 一条 LLM 审查意见（path/start_end_line/severity/category/suggestion_code） | 一次 subtask | 由 `code_comment` 工具产出，经 `ResolveLineNumbers` 重定位后输出 |
| `model.ScanItem` | 全文件扫描载体（携带整文件内容，非 diff） | 一次 scan run | 由 `scan.Provider.Enumerate` 产出，`AsDiff()` 适配复用 diff 路径 |
| `session.RunManifest` | 单次 run 的不可变 coverage 快照（schema `ocr.run-manifest/v1`） | run 结束冻结 | 由 `ManifestBuilder` 构建，嵌入 session_end 落盘 |
| `llmloop.Runner` | 跨文件工具循环执行器 | per-session | agent/scan 各构建一个，注入 `Deps` |
| `llm.ResolvedEndpoint` | 解析后的 LLM 端点（URL/Token/Model/Protocol） | per-run | 由 `resolver.go` 4 策略解析 |

```
LlmComment ──产出── code_comment 工具
    │ 重定位
    └── diff.ResolveLineNumbers ──→ 真实行号

Diff ──产出── diff.Provider ──→ ReviewAgent ──dispatch──→ Runner.RunPerFile
                                                          │
ScanItem ──AsDiff──→ ScanAgent ──dispatch──→ Runner ──→ LLMClient ──→ ToolCalls
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|----------|--------|----------|
| `llm.LLMClient` | `llm/client.go` | `OpenAIClient`/`AnthropicClient`/`OpenAIResponsesClient` | `NewLLMClient` 按 `Protocol` switch 分发 |
| `tool.Provider` | `tool/definitions.go` | `FileReadProvider`/`FileFindProvider`/`CodeSearchProvider`/`CodeCommentProvider`/`FileReadDiffProvider`/`mcp.Provider` | `Registry.Register`，`Freeze` 后只读 |
| `rules.Resolver`/`DetailResolver` | `config/rules/system_rules.go` | `composedResolver`（custom+project+global+system 四层） | `rules.NewResolver` 构造 |
| `ResultProvider` | `cmd/shared.go:318` | `agent.Agent`/`scan.Agent` | 让 `emitRunResult` 多态消费 |

---

## 代码目录

```
open-code-review/
├── cmd/opencodereview/        # CLI 入口与命令（~8,500 行）
│   ├── main.go                # main()：InitEmbeddedLoader + telemetry.Init + rootCmd.Execute
│   ├── root.go                # ocr 根命令 + 10 个子命令注册
│   ├── review_cmd.go          # ocr review：executeReviewContext 主入口
│   ├── scan_cmd.go            # ocr scan
│   ├── delegate_cmd.go        # ocr delegate（preview/rule）
│   ├── shared.go             # 装配核心：loadCommonContext/loadLLMRuntime/emitRunResult
│   ├── output.go sarif.go     # 输出格式化（Markdown/JSON/SARIF）
│   └── provider_tui.go        # bubbletea 交互式 provider 配置 TUI（~3,000 行）
├── internal/
│   ├── agent/                 # ReviewAgent 执行引擎（~2,370 行）
│   ├── scan/                  # 全文件扫描引擎（~1,700 行）
│   ├── llmloop/               # LLM 工具循环引擎（~1,270 行）
│   ├── llm/                   # LLM provider 抽象与重试（~4,550 行，最大模块）
│   ├── session/               # 会话编排/续审/持久化（~2,860 行）
│   ├── diff/                  # diff 解析与行号定位（~1,420 行）
│   ├── tool/ + mcp/           # 场景化工具集 + MCP（~1,580 行）
│   ├── viewer/                # 浏览器会话查看器（~1,250 行）
│   ├── config/ + delegate/   # 配置/规则/模板/委托（~1,160 行）
│   ├── telemetry/             # OpenTelemetry（~910 行）
│   ├── model/                 # 共享数据模型（~120 行，高扇入）
│   ├── gitcmd/ stdout/ pathutil/ suggestdiff/  # git/输出/路径/diff 工具基础设施
│   └── release/               # 发布元信息
├── plugins/open-code-review/ # 各 coding agent 集成插件（Claude Code/Codex/Cursor/OpenCode/QCA）
├── skills/                    # 可移植 agent skill（含委托模式 SKILL.md）
├── examples/                  # CI 集成示例（GitHub Actions/GitLab/Gerrit/Codeup/Bitbucket/GitFlic）
├── pages/                     # 文档站源
├── action.yml                 # GitHub Action 定义
└── install.sh / package.json  # 安装与 npm 分发
```

> `internal/model/` 是被 import 最多的包（24 次），但因只含纯数据结构不独立成模块，在「核心概念」覆盖。`cmd/` 与 `internal/` 的职责边界：cmd 是纯装配层，所有业务逻辑委托给 internal。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/open-code-review/module-dependencies.svg)

模块间依赖方向自顶向下（接口层→编排层→执行层→能力层→基础层），编排层 agent/scan 把单文件工具循环委托给 llmloop，llmloop 再调 llm/tool/diff。`commonContext` 与 `llmRuntime` 是 cmd 层两个装配产物，把跨 7 包依赖一次性物化。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|------------|----------|
| 命令行接口 | CLI 命令树、flag、TUI、输出格式 | `executeReviewContext` in `review_cmd.go:110` | 装配与输出是独立关注点，隔离外部交互 | [命令行接口](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/01-cli) |
| LLM 提供商抽象 | 多 provider、API 协议、重试、token | `llm.NewLLMClient` / `ResolveEndpointWithOptions` | provider 适配是可替换的叶子模块，独立演进 | [LLM 提供商抽象](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/02-llm-provider) |
| 审查会话编排 | 会话清单、断点续审、密封身份 | `session.New` / `ManifestBuilder.Finalize` | 会话状态机与续审安全是独立子系统 | [审查会话编排](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/03-session) |
| Agent 执行引擎 | ReviewAgent 编排、prompt、并发子审查 | `agent.New` / `agent.Run` | 审查编排逻辑独立于通用工具循环 | [Agent 执行引擎](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/04-agent) |
| LLM 工具循环 | 通用工具往返、压缩、并发池 | `llmloop.Runner.RunPerFile` | 通用引擎与审查语义解耦，agent/scan 复用 | [LLM 工具循环](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/05-llmloop) |
| 扫描引擎 | 全文件审查、批次切分、去重摘要 | `scan.NewAgent` / `scan.Agent.Run` | 全文件驱动与 diff 驱动是两种审查范式 | [扫描引擎](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/06-scan) |
| Diff 解析与行号定位 | diff 解析、行号重定位、跨文件重定位 | `diff.Provider.GetDiff` / `diff.ResolveLineNumbers` | 「位置漂移」的工程解，确定性工程核心 | [Diff 解析与行号定位](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/07-diff) |
| Agent 工具集与 MCP | 场景化工具、MCP 外部工具 | `tool.Registry` / `mcp.RegisterAll` | 工具是 agent 能力的扩展点，MCP 外接 | [Agent 工具集与 MCP](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/08-tool-mcp) |
| 报告查看器 | 浏览器会话浏览/回放 | `viewer.StartServer` / `store.LoadSession` | 可视化复盘独立于审查主链路 | [报告查看器](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/09-viewer) |
| 配置体系与委托 | 模板引擎、规则匹配、allowlist、委托 | `template.LoadDefault` / `rules.NewResolver` | 确定性规则注入是「比纯语言驱动更稳定」的根 | [配置体系与委托](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/10-config) |
| 遥测与统计 | OTel span/metric、一次审查一个 trace | `telemetry.Init` / `StartSpan` | 可观测性横切所有模块，独立下沉 | [遥测与统计](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/11-telemetry) |

---

## 运行时行为

### 启动流程

进程启动（`cmd/opencodereview/main.go`）：

```
main()
├─ llm.AppVersion = Version              # 版本注入 llm 包
├─ llm.InitEmbeddedLoader()               # 内嵌 tiktoken BPE 数据，离线 CountTokens
├─ ctx := context.Background()
├─ if telemetry.Init(ctx) {              # 读 ~/.opencodereview/config.json + env
│     defer telemetry.ShutdownWithTimeout(ctx, 5s)   # 进程退出 flush 批量 span/metric
│  }
└─ rootCmd.Execute()                     # cobra 分发到子命令
```

对象装配发生在 `executeReviewContext`（review）的装配阶段：配置来自命令行 flag > 环境变量 > `~/.opencodereview/config.json` > 内嵌默认（`template.LoadDefault` 从 `embed.FS` 读 `task_template.json`+`prompts/*.md`）。实例化顺序：`loadCommonContext` 先建 `gitcmd.Runner`（全局 git 子进程 limiter）→ `rules.NewResolver`（加载 system+project+global+custom 四层规则）→ `template`；`loadLLMRuntime` 再建 `toolsconfig` → `agent.BuildToolDefs`（plan/main 两套 toolDefs）→ `llm.ResolveEndpointWithOptions`（4 策略解析 provider）→ `llm.NewLLMClient` → `CommentCollector` + `RetryCollector`（均 per-run）。依赖注入是**手动构造 + 大 struct 传递**：`agent.Args`（27 字段）把 cmd 装配好的引用一次性下传给 `agent.New`，agent 再把 `Deps` 下传给 `llmloop.NewRunner`。无 DI 容器。单例是 `telemetry` 全局 provider、`gitcmd.Runner` 全局 limiter。

### 核心运行流程

后续链路覆盖三种执行模式：默认 review（diff 驱动）、scan（全文件）、delegate（委托）。

#### 默认模式：review 主链路

业务流程：用户运行 `ocr review` → 装配公共上下文 → 校验 ref 注入 → 加载续审状态 → 装配 LLM 运行时 → 校验密封身份 → 构建 agent → 并发审查每个文件 → 行号重定位 → 输出。

![review 请求数据流](/vibe-reading/images/articles/open-code-review/data-flow.svg)

文字解读：`executeReviewContext`（`review_cmd.go:110`）先调 `loadCommonContext` 装配 `commonContext`（template+rules+gitrunner），再 `validateReviewRefs` 在任何 git 调用前拒绝以 `-` 开头的 ref（#112 注入防护）并用 `git rev-parse --verify --end-of-options` 验证 commit。`loadLLMRuntime` 构建 `llmRuntime`（含两套 toolDefs + LLMClient + Collector），`validateResumeIdentity` 严格在 `agent.New` **之前**调用——因为 `session.New` 会立即写 `session_start`，拒绝续审不能留孤儿文件；它复算 `SealedInput`（冻结 commit SHA 防运行期 ref 移动）并比对父 run 身份。`agent.New` 写 session_start、initManifest、构造 `llmloop.Runner` 注入 `Deps`。`ag.Run` 编排 `loadDiffs → filterDiffs → registerCoverage（冻结 coverage 分母）→ applyResume（复用 checkpoint）→ dispatchSubtasks`：用 `sem` 信号量并发 N 个文件（默认 8），每个 `executeSubtask` 跑可选 Plan 阶段 → `runner.RunPerFile` 工具循环 → `executeReviewFilter`。工具循环内 `LLMClient.CompletionsWithCtx` → 解析 tool_calls → `executeToolCall`（`code_comment` 走异步 `CommentWorkerPool`，其余同步执行）→ 三区压缩（soft 60%/warn 80%）→ 终止判定。结束后 `finalizeManifest` + `session.Finalize` 落盘，`emitRunResult` 调 `diff.ResolveLineNumbers` 做**跨全部 diffs 的最终行号重定位**，再按格式输出。关键设计决策：coverage 分母在 dispatch 前冻结（保证 partial 结果可发布）、`code_comment` 后处理异步化（降低延迟）、续审决策前置（防孤儿 session）。

#### 扫描模式：scan

业务流程：用户运行 `ocr scan` → 复用装配 → 用 ScanTemplate → 排除 file_read_diff 工具 → 枚举文件 → 批次切分 → 批内并发审查 → 批间去重 → 全局摘要 → 输出。

`executeScan`（`scan_cmd.go:108`）复用 `loadCommonContext`（`requireGit=false`，允许非 git 目录）和 `loadLLMRuntime`，但用独立 `ScanTemplate`（`PlanTask`/`DedupTask`/`ProjectSummaryTask` 独立演化）。`scan.Provider.Enumerate` 用 `git ls-files`（git 仓库）或 `filepath.WalkDir`（非 git）。`groupBatches` 按语言/目录分批——**批间串行**（同语言文件时间相邻提高 prompt-cache 命中率），批内 `sem` 并发。每批后 `maybeRunDedup` 去重，全部完成后 `maybeRunProjectSummary` 全局摘要。scan 的 `llmloop.Deps.NewRequestMeta=nil`，请求不进 retry report。数据载体是 `model.ScanItem`（整文件内容，非 diff），`{{change_files}}` 用固定哨兵替代（全文件扫描无「其他变更文件」概念）。

#### 委托模式：delegate

业务流程：用户运行 `ocr delegate preview/rule` → 复用装配 → OCR 输出文件清单+分组规则 markdown → 宿主 agent 用自己的 LLM 执行审查。

`executeDelegatePreview`/`executeDelegateRule`（`delegate_cmd.go:166`）调 `loadDelegateContext`（复用 `loadCommonContext` + `validateReviewRefs`，但**不建 LLMClient、不建 session、不调 RetryCollector**）。`preview` 调 `agent.Preview`（只跑 diff 解析+filter，不开 LLM）输出可审查文件清单；`rule` 调 `delegate.GroupRules` 按 `source|pattern|text` 三元组分组（相同规则文本但来源/pattern 不同则分属不同组），`RuleGroupsMarkdown` 渲染 markdown。delegate 是纯装配产物输出——OCR 管文件选择+规则解析（确定性部分），宿主 agent 管审查执行（LLM 调用部分）。

### 状态流

会话/审查有明确的状态机，集中在 `session` 包的 coverage 五不相交集合与 `TerminalState`：

- **文件级 coverage 状态**：`Selected`（分母）→ 进入 `Completed` ∪ `Reused` ∪ `Failed` ∪ `Waived` 之一。`Selected = Completed ∪ Reused ∪ Failed ∪ Waived`。
- **run 终态 `TerminalState`**（`manifest.go:941` `computeTerminal`）：有 `RunFailure` 必 `failed`；`selected=0` 为 `skipped`；`failed=0` 为 `complete`；全 `failed` 为 `failed`；否则 `partial`。
- **ManifestBuilder 两道边界**：`sealed`（selected 集合关闭）→ `frozen`（Finalize 后所有 mutating 调用报错）。
- **工具循环终止 `MainLoopStop`**（`llmloop/loop.go:214`）：`StopNone` / `StopMaxRounds`（预算耗尽）/ `StopEmptyRounds`（连续 3 轮无有效 result）/ `StopCompression`。

相关代码：`Coverage`/`TerminalState` 枚举定义在 `internal/session/manifest.go:231/274`，状态转换方法 `MarkCompleted`/`MarkReused`/`MarkFailed` 在 `ManifestBuilder`，由 `agent.go` 的 `registerCoverage`/`applyResume`/`markCompleted` 触发。

---

## 典型修改场景

#### 场景 1：新增一种语言支持

需改三处（来自 config 模块）：`internal/config/allowlist/supported_file_types.json` 加扩展名；`internal/config/rules/system_rules.json` 的 `path_rule_map` 加 `"**/*.xxx": "xxx.md"`；新增 `rules/rule_docs/xxx.md` 规则文件。无需改 Go 源码，`LoadDefault` 自动从 embed.FS 加载。

#### 场景 2：新增一个 Agent 工具

在 `internal/tool/definitions.go` 加 `Tool` 常量并加入 `allTools()`；新建 `internal/tool/xxx.go` 实现 `Provider` 接口（`Tool()` + `Execute`）；在 `cmd/review_cmd.go:572 buildToolRegistry` 中 `reg.Register`；在 `internal/config/toolsconfig/tools.json` 加工具定义 JSON，设 `plan_task`/`main_task` 标志。对应测试：`internal/tool/` 下同包 `*_test.go`。

#### 场景 3：新增一个内置 LLM provider

在 `internal/llm/providers.go` 的 `registry` 切片追加一个 `Provider` 条目（`Name`/`Protocol`/`BaseURL`/`EnvVar`/`Models`），`init()` 自动重建 map。若走 OpenAI 兼容协议则零代码改动（仅加一条 entry）；若新协议，还需在 `protocol.go` 加常量 + `NewLLMClient` switch case + 新建 `xxx_client.go` 实现 `CompletionsWithCtx`（含 `defer finalizeRequest` + `buildXxxParams` + `mapXxxResponse`）。对应测试：`internal/llm/` 下 `*_test.go`。

---

## 测试体系

测试与源码同目录，`*_test.go` 紧贴被测包（Go 惯例）。测试代码量约 55,000 行，与业务代码（~28,000 行）比例近 2:1，覆盖充分。

| 代码层 | 测试类型 | 代表文件 |
|--------|----------|----------|
| CLI/装配 | 命令行 + 装配 | `cmd/opencodereview/review_cmd_test.go`、`shared_test.go`、`config_dispatch_test.go` |
| Provider TUI | 交互测试 | `cmd/opencodereview/provider_tui_*_test.go`（持久化/回滚/自定义表单等） |
| Agent 引擎 | 单元 + e2e | `cmd/opencodereview/manual_e2e_retry_test.go`、`retry_report_e2e_test.go` |
| 重试/输出 | 单元 | `cmd/opencodereview/output_manifest_test.go`、`emit_run_result_test.go` |
| SARIF | 单元 | `cmd/opencodereview/sarif_test.go` |

`internal/` 下每个包都有对应 `_test.go`（如 `internal/agent/`、`internal/llm/`、`internal/session/`、`internal/diff/` 等）。想理解某个模块，优先阅读它对应的 `_test.go`——测试即「可执行文档」，修改某层代码时参照对应测试。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `cmd/opencodereview/main.go` → `root.go` 的 `rootCmd` → `review_cmd.go:executeReviewContext` → `shared.go:loadCommonContext` + `loadLLMRuntime` + `emitRunResult` → `agent/agent.go:New` + `Run`
- **第二遍：理解工具循环与工具集**
  `internal/llmloop/loop.go:RunPerFile` → `executeToolCall` → `internal/tool/definitions.go` 的 `Provider` 接口 → `internal/tool/code_comment.go`（意见如何产出）+ `filereader.go`（文件如何读）
- **第三遍：理解行号定位与续审安全**
  `internal/diff/resolver.go:ResolveLineNumbers` → `relocation.go:ReLocateComment`（三级匹配+LLM 重定位）→ `internal/session/resume_identity.go:ValidateResume` + `internal/agent/identity.go:SealedInput`（密封身份防 ref 漂移）
- **第四遍：选择重点子模块深入阅读**
  从「模块地图」选一个模块文档深入（如 LLM provider 的重试三件套、配置的模板引擎+规则匹配、llmloop 的三区压缩算法）。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| 确定性工程 × Agent 混合 | OCR 核心哲学：必须不出错的步骤用工程逻辑，动态决策交给 agent |
| SealedInput / 密封身份 | 预检冻结 commit SHA，运行期不再二次比对，防 ref 漂移 |
| ResolveLineNumbers / 行号定位 | 把 LLM 意见的 ExistingCode 通过字符串匹配映射回真实行号 |
| 三区压缩 | llmloop 把 messages 切成 frozen[0:2]/compress/active 三区做上下文压缩 |
| CommentWorkerPool | code_comment 后处理（行号解析/跨文件 refile）的异步池 |
| RunManifest | 单次 run 的不可变 coverage 快照，schema `ocr.run-manifest/v1` |
| Delegation Mode | OCR 管文件选择+规则，宿主 agent 用自己 LLM 执行审查（OCR 侧 LLM-free） |
| AACR-Bench | 项目的代码审查基准数据集（50 仓库/200 PR/1505 ground truth），发布在 HuggingFace |

### 参考资料

- 官方文档站：[open-codereview.ai/docs](https://open-codereview.ai/docs)（CLI Reference、Review Rules、Configuration、MCP Server、Delegation、CI/CD、Session Viewer、Telemetry）
- AACR-Bench 数据集：[HuggingFace Alibaba-Aone/aacr-bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench)
- 方法论参考：[deepwiki-rs](https://github.com/sopaco/deepwiki-rs)（四阶段流水线）、[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（分层分解）

### 工具推荐

- `ocr viewer`：本地起服务浏览/回放审查会话，是理解 run 行为的最佳工具
- `ocr review --preview` / `ocr delegate preview`：只看文件选择与过滤结果，不调 LLM，快速验证规则配置
- OpenTelemetry 后端（如 Langfuse）：配合 `OCR_ENABLE_TELEMETRY=1` 查看 span/metric
