---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "Agent 工具集与 MCP"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "AgentTools", "MCP", "ToolCalling"]
description: "OpenCodeReview Agent 工具集与 MCP——场景化蒸馏的六个内建工具、tool.Provider 注册表、CommentCollector 评论收集、MCP 客户端接入外部工具。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/tool/`（约 1,265 行）+ `internal/mcp/`（约 312 行）定义审查 agent 可调用的工具集。这是 README 所述「场景化工具集」的落地——README 说工具集是从生产 trace 分析（调用频率分布、每工具重复率、新工具对调用链影响）蒸馏得来，比通用 agent 工具包更稳定可预测。`tool` 提供六个内建工具 + 注册表 + 评论收集器，`mcp` 把外部 MCP 工具适配进同一 `tool.Provider` 接口，让 agent 能力可外接扩展。

## 模块架构

```
internal/tool/
├── definitions.go        # Tool 标识 + Provider 接口 + Registry
├── filereader.go          # FileReader 基础设施（workspace 磁盘 vs git show）
├── file_read.go           # file_read 工具（读指定行范围，500 行截断）
├── file_read_diff.go      # file_read_diff 工具（从 DiffMap 读已解析 diff）+ DiffMap
├── file_find.go           # file_find 工具（git ls-files / ls-tree / WalkDir）
├── code_search.go         # code_search 工具（git grep，-F/-P/-i）
├── code_comment.go        # code_comment 工具（提交审查意见）
├── comment_collector.go   # CommentCollector 线程安全评论存储
├── response_message.go    # TaskCheckpoint 结果信封
└── stub.go                # StubProvider 占位实现

internal/mcp/
├── client.go              # MCP 客户端（stdio 子进程 + 远程 HTTP）
└── provider.go            # 适配 MCP → tool.Provider + ToToolDef
```

核心抽象是 `tool.Provider` 接口（`Tool()` + `Execute`），六个内建实现 + MCP 适配器都满足它，`Registry` 统一注册 + `Freeze` 后只读。

## 调用链路

注册 → 执行链：

```
# 注册阶段（cmd/review_cmd.go:572 buildToolRegistry）
reg := tool.NewRegistry()
reg.Register(tool.NewFileRead(fr))           # file_read
reg.Register(tool.NewFileFind(fr))           # file_find
reg.Register(tool.NewFileReadDiff(DiffMap{}))# file_read_diff
reg.Register(tool.NewCodeSearch(fr))         # code_search
reg.Register(&tool.CodeCommentProvider{Collector}) # code_comment
# MCP 随后注入：mcp.RegisterAll(tools, mc, serverCfg.Tools)

# 执行阶段（llmloop/loop.go:453 executeToolCall）
tool.OfName(call.Function.Name)
  ├─ t.IsKnown() == false → 动态路径：Tools.Get(name).Execute(ctx, dynArgs)  # MCP 工具入口
  ├─ TaskDone → 解析 state → Complete()/Fail()
  └─ 已知工具 → lookupTool(Tools, t).Execute(ctx, args)
       └─ code_comment 特殊：强制注入当前 newPath 防幻觉路径 → ParseComments
            → diff.ResolveComment → 跨文件搜索 → LLM 定位 → Collector.Add
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Registry.Freeze` (`definitions.go`) | 冻结后只读 | 防运行期并发写 |
| `FileReader.Read` (`filereader.go:71`) | 统一文件读取 | workspace 磁盘 vs `git show ref:path` 对上层透明 |
| `FileReadProvider.Execute` (`file_read.go`) | 读指定行范围 | 500 行截断 + 行号格式化 |
| `CodeSearchProvider` (`code_search.go:58`) | `git grep` 搜索 | `-F`/`-P`/`-i`；非 git 回退 `--no-index` |
| `CommentCollector.Add/Since/ReplaceSince` | 评论收集 | per-Agent 实例，批次级去重 |
| `mcp.RegisterAll` (`provider.go:33`) | 注册 MCP 工具 | 跳过保留名/已注册名 |
</details>

## 核心实现

### 为什么是「场景化蒸馏」

`internal/config/toolsconfig/tools.json` 的 `plan_task`/`main_task` 分配是直接体现。六个工具的 phase 分配：

| 工具 | plan | main | 职责 |
|---|---|---|---|
| `file_read` | false | true | 读指定行范围，500 行截断 |
| `code_comment` | false | true | 提交审查意见 |
| `task_done` | false | true | 声明完成/失败 |
| `code_search` | true | true | `git grep` 全仓库文本搜索 |
| `file_find` | true | true | `git ls-files` 按名查找 |
| `file_read_diff` | true | true | 读已解析的 diff |

plan 阶段只有探索性工具（search/find/read_diff），没有 `code_comment`/`task_done`——plan 阶段只做分析不输出意见。main 阶段全量启用。`BuildToolDefs`（`agent.go:1875`）通过 `ToolDefsByPhase(planOnly)` 过滤。plan 工具通过 `{{plan_tools}}` 注入 prompt 仅作参考（`formatToolDefs` 标注 "reference only — do not call"），main 工具由 llmloop Runner 实际执行。

### FileReader vs FileRead vs FileReadDiff

- `FileReader`（`filereader.go:58`）是基础设施类，**不是 `Provider`**，不直接对 LLM 暴露。它封装 workspace 磁盘读取和 `git show <ref>:<path>` ref 读取的统一接口。
- `FileReadProvider`（`file_read.go:15`）是 `Provider` 实现，包装 `FileReader.ReadLines`，增加 500 行截断、行号格式化（`LINE_RANGE`/`IS_TRUNCATED` 元信息）。
- `FileReadDiffProvider`（`file_read_diff.go:33`）不读文件系统，从 `DiffMap` 取预解析 diff——审查场景下 diff 已在初始化时算好，重复 `git diff` 是浪费。`DiffMap` 构建时深拷贝、只读。

### code_search 如何搜索

`code_search.go:58` `buildGrepArgs` 组装 `git grep` 参数：`-F` 固定字符串或 `-P` Perl 正则；`-i` 忽略大小写；`--max-count 100` 截断；ref 模式附加 rev 参数。`runGitGrep`（`code_search.go:110`）通过 `Runner.RunSplit` 分离 stdout/stderr。非 git 目录回退 `--no-index` 模式。结果按文件分组输出。

### CommentCollector 评论收集

`CommentCollector` 是 per-Agent 实例（`agent.go:210` 注入），保证不同仓库审查不串扰。`Snapshot()`/`Since()`/`ReplaceSince()` 支持批次级去重：先快照 → 跑一批 → 取增量 → 去重 → 替换回去。`RemoveByPathAndIndices` 支持按路径+索引精确删除。`code_comment` 工具产出的评论经 `diff.ResolveComment` → 跨文件 re-location → LLM 定位后 `Collector.Add`。

### MCP 如何接入

`client.go:30` `NewClient` 启动 stdio 子进程，`client.Connect` + `ListTools` 初始化并缓存工具列表。`client.go:71` `NewRemoteClient` 用 `StreamableClientTransport` 连远程 HTTP，`headerTransport`（`client.go:126`）注入自定义 header 并对 401/403 给清晰错误。`provider.go:33` `RegisterAll` 按 `allowedTools` 白名单过滤，保留名冲突跳过，用 `tool.Dynamic(name)` 创建 `Tool` 标识后注册 `&Provider{...}`。配置通过 `MCPServerConfig`（`config_cmd.go:310`）的 `type` 字段区分 stdio/remote，支持 `setup` 预执行命令（`review_cmd.go:540`）。`CollectToolDefs`（`provider.go:99`）从已注册 MCP 客户端收集 `llm.ToolDef` 供 LLM 调用。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表 | `Registry` (`definitions.go:79`) | map + Freeze，运行期只读 |
| 策略 | `Provider` 接口 + 六实现 | `executeToolCall` 按 Tool.Name 分派 |
| 门面 | `FileReader` (`filereader.go`) | 隐藏 workspace vs `git show` 差异 |
| 适配器 | `mcp.Provider` (`provider.go:17`) | MCP `CallTool` → `tool.Provider`；`ToToolDef` 适配 InputSchema |
| 冻结快照 | `DiffMap` + `Registry.Freeze` | 构建时深拷贝/只读 |

## 模块间交互

tool 依赖 `gitcmd`（`FileReader.Runner` 执行 `git show`/`git grep`/`git ls-files`/`git ls-tree`）、`diff`（`file_find.go` `LoadGitignorePatterns`/`IsPathExcluded`；`loop.go:566` `ResolveComment` 定位行号）、`model`（`LlmComment`）、`pathutil`（`CanonicalPath`+`WithinBase` 防路径逃逸）；mcp 依赖 `llm`（`ToolDef`/`FunctionDef`）。被调用方：`agent.New` 创建 Registry + CommentCollector；`llmloop.Runner.executeToolCall`（`loop.go:453`）是唯一执行入口；`cmd/review_cmd.go` 和 `scan/agent.go` 负责组装。MCP 与 tool 协作：`mcp.RegisterAll` 遍历 `Client.Tools()` 跳过保留名后注册 `tool.Dynamic(name)`。

## 扩展方式

- **新增内建工具**（如 `git_blame`）：`definitions.go` 加 `GitBlame = Tool{name:"git_blame"}` 并加入 `allTools()`；新建 `git_blame.go` 实现 `Provider`（`Tool()`+`Execute`）；`review_cmd.go:572 buildToolRegistry` 中 `reg.Register`；`toolsconfig/tools.json` 加定义 JSON 设 `plan_task`/`main_task`。
- **接入 MCP 外部工具**（如 Jira 查询）：`~/.opencodereview/config.json` 的 `mcp_servers` 下加 `MCPServerConfig` 条目（`command`/`args` 或 `url`/`headers`，`tools` 白名单可选）。**无需改 Go 代码**——`review_cmd.go:560 mcp.NewClient` + `RegisterAll` 自动发现注册，`CollectToolDefs` 自动收集 `llm.ToolDef`。
