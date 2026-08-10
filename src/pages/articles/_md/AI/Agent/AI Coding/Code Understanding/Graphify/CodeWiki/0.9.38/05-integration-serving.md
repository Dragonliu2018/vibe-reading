---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "Integration & Serving"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, "AI Coding", "Code Understanding", Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "MCP", "skill注册", "PreToolUse hooks", "Claude Code", "Git hooks"]
description: "graphify 集成层：15+ AI 助手 skill 注册、MCP server 双兼容、PreToolUse nudge/deny 拦截、fail-open 原则与版本检测。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI Coding/Code Understanding/Graphify/CodeWiki/0.9.38/00-overview)

---

## 模块定位

集成与服务层是 graphify 与外部世界的边界——它把 graphify 注册到 15+ 种 AI 助手中（写 skill 文件和 settings.json），通过 MCP 协议暴露 tools，用 PreToolUse hooks 在 AI 助手读文件前 nudge "先查图"。模块覆盖 `install.py`（2291 行）、`serve.py`（2290 行）、`hooks.py`（718 行）、`__main__.py`（716 行）、`report.py`（300 行）。

模块的核心设计原则是 **fail-open**——任何 hook 异常都静默返回 exit 0，不阻止用户操作。graphify 自身的 bug 不应该阻断 git commit 或 Claude Code 的工具调用。

## 模块架构

![集成与服务架构](/vibe-reading/images/articles/graphify-internals/integration-architecture.svg)

模块内部按功能分三块。**安装**（`install.py`）的 `dispatch_install_cli()` 检测目标 AI 助手平台，写 skill 文件和 `settings.json`，注册 hooks。**MCP 服务**（`serve.py`）的 `_build_server()` 构建 MCP server，通过 HTTP transport 暴露 graphify tools。**Hooks**（`hooks.py` + `cli.py`）分两套独立的 hook 机制——Git hooks（post-commit/post-checkout 触发图重建）和 PreToolUse hooks（AI 助手读文件前 nudge/deny）。

入口 `__main__.main()` 先做 `_check_skill_version()` 版本戳检查，再分派到 install 或 `dispatch_command()`。

## 调用链路

### install 流程

```
graphify install
  └─ __main__.main() → dispatch_install_cli(cmd)    install.py
     ├─ 检测目标平台 (或 --platform 参数)
     ├─ _resolve_graphify_exe()                      install.py L1395
     │   └─ 解析 graphify 可执行文件绝对路径
     ├─ 写 skill 文件 (graphify/skills/<platform>/SKILL.md)
     ├─ 写 settings.json (PreToolUse hook 注册)
     │   └─ .claude/settings.json (Claude Code)
     │   └─ .codebuddy/settings.json (CodeBuddy)
     ├─ _refresh_all_version_stamps()                install.py L57
     │   └─ 所有平台写 .graphify_version 文件
     └─ 输出安装成功 + 使用提示
```

### MCP serve 流程

```
graphify-mcp (或 graphify serve)
  └─ serve._main() → _build_server()                serve.py
     ├─ 创建 MCP server (starlette HTTP transport)
     │   └─ 双兼容: 1.x decorator API / 2.x on_* constructor-callback
     ├─ list_tools()                                serve.py L1489
     │   └─ 返回 graphify tools (extract/query/path/explain/...)
     │      每个 tool 的 inputSchema 自动注入 project_path (L1624-1637)
     ├─ list_resources()                            serve.py L1883
     │   └─ graphify://graph 等资源 URI
     ├─ read_resource()                             serve.py L1895
     │   └─ 按 URI 分派返回内容
     └─ tool handler 分派
         └─ _handlers dict: tool name → handler 函数 (L1640 区域)
```

### PreToolUse hook-guard 流程

```
Claude Code 即将 Read/Grep 源码文件
  └─ 触发 .claude/settings.json 中注册的 PreToolUse hook
     └─ graphify hook-guard                          cli.py L582
        ├─ _run_hook_guard(file_path)
        │   ├─ 检查 graphify-out/graph.json 是否存在
        │   ├─ 检查目标文件是否被 graph 覆盖 (_HOOK_SOURCE_EXTS)
        │   ├─ 检查 graph 是否新鲜 (_query_stamp_fresh)
        │   └─ 分支:
        │       ├─ graph 存在且新鲜 → soft nudge (_READ_NUDGE)
        │       │   └─ additionalContext: "先查图再读文件"
        │       ├─ graph 存在但 stale → stale nudge (_READ_NUDGE_STALE)
        │       │   └─ additionalContext: "graph 可能过期, 先 query 再 update"
        │       └─ strict 模式 + graph 新鲜 → deny (_READ_DENY)
        │           └─ permissionDecision: "deny"
        │           └─ _mark_session_denied() → 至多 1x/session
        └─ 任何异常 → exit 0 (fail-open)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `main()` `__main__.py` L460 | CLI 入口 | 版本检查 + 命令分派 |
| `dispatch_install_cli()` install.py | install/uninstall 分派 | 15+ 平台适配 |
| `_resolve_graphify_exe()` install.py L1395 | 解析可执行文件路径 | 供两套 hook 的 command 字段 |
| `_check_skill_version()` `__main__.py` L164 | 版本戳检查 | skill vs package 版本不匹配提示 |
| `_build_server()` serve.py | 构建 MCP server | starlette 1.x/2.x 双兼容 |
| `list_tools()` serve.py L1489 | 暴露 MCP tools | project_path 自动注入 |
| `_run_hook_guard()` cli.py L582 | PreToolUse 拦截 | fail-open, deny ≤1x/session |
| `_mark_session_denied()` cli.py | session 级 deny 标记 | 防止 strand agent |
| `generate()` report.py L71 | 生成 GRAPH_REPORT.md | 返回 Markdown 字符串 |

</details>

## 核心实现

### 15+ AI 助手平台适配

`install.py` 的 `dispatch_install_cli()` 检测目标 AI 助手并适配——每种平台有不同的 skill 文件格式、settings.json 结构、hook 注册方式。`graphify/skills/` 包下有 15+ 个平台子目录（claude/cursor/codex/gemini/copilot/aider/kilo/opencode/droid/trae/pi/kiro/claw/amp/agents/vscode/windows），每个包含平台专属的 skill 模板。

`_resolve_graphify_exe()`（`install.py` L1395）解析 graphify 可执行文件的绝对路径，供两套 hook 的 command 字段使用——确保 hook 能正确调用 `graphify hook-guard` 或 `graphify update`。

### MCP server 双兼容

`serve.py` 的 `_build_server()` 在运行时检测 starlette 版本，选择注册方式——1.x 用 decorator API（`@server.list_tools()`），2.x 用 `on_*` constructor-callback API（`server = Server(...)` + `@server.list_tools()` 注册为构造器回调）。pyproject.toml 注释说明：`serve.py` 是 dual-compat 的，cap 低于 starlette 3（测试范围）。

MCP server 暴露的 tools 通过 `list_tools()`（L1489）定义，`project_path` 参数自动注入——`_build_server` 遍历所有 tool 的 inputSchema 添加 `project_path` 字段（L1624-1637），无需每个 handler 手动添加。tool handler 通过 `_handlers` 字典分派（tool name → handler 函数）。

### PreToolUse nudge vs deny

`cli.py` 开头定义了四种 hook 输出常量：

- **`_SEARCH_NUDGE`**（L18）：Grep 前提示"先 `graphify query` 再 grep"。
- **`_READ_NUDGE`**（L28）：Read 前提示"先 `graphify query/explain/path` 再读文件"，适用于 subagent。
- **`_READ_NUDGE_STALE`**（L38）：graph 存在但可能过期时提示"先 query 再 update"。
- **`_READ_DENY`**（L57）：strict 模式下返回 `permissionDecision: "deny"`，阻止 Read。

deny 策略的关键设计是 **"at most once per session"**——`_mark_session_denied()` 确保 deny 至多每 session 触发一次。第一次 deny 后，后续 Read 自动降级为 soft nudge。这是为了防止 strand agent——如果 deny 一直阻止 Read，AI 助手会陷入无法读文件的死锁。

`_HOOK_SOURCE_EXTS`（`cli.py` L71）定义哪些文件扩展名触发 hook——包括 `.py`/`.js`/`.ts`/`.go`/`.rs`/`.java`/`.md` 等 ~30 种源码和文档扩展名。

### 两套独立的 hook 机制

仓库中有两套完全独立的 hook，容易混淆：

1. **hooks.py — Git hooks**（post-commit / post-checkout）：在 git 操作后触发 graph 重建。通过 `graphify hook install/uninstall/status` 命令管理，写入 `.git/hooks/` 目录。
2. **install.py + cli.py — PreToolUse hooks**：Claude Code / CodeBuddy 的 PreToolUse hooks，在 AI 助手调用工具前触发 nudge/deny。通过 `graphify claude install` 写入 `.claude/settings.json`，运行时由 `graphify hook-guard` 子命令执行。

两者共享 `_resolve_graphify_exe()` 解析的可执行文件路径。

### fail-open 原则

所有 hook 逻辑都遵循 fail-open——任何异常都静默返回、exit 0，不阻止用户操作。`_run_hook_guard()`（`cli.py` L582 docstring）和 `hooks.py` 的 embedded Python 中都有明确注释。这确保 graphify 自身的 bug 不会阻断 git commit 或 Claude Code 的工具调用。

### 版本检测机制

`_check_skill_version()`（`__main__.py` L164）在每次非 install/hook 命令运行时检查所有已知平台安装位置的 `.graphify_version` 文件。如果发现版本不匹配，区分两种情况：
- skill 比 package 新（stale `uv tool` CLI）——提示升级 package，不建议运行 install（会降级）
- skill 比 package 旧——提示运行 `graphify install` 更新

`_refresh_all_version_stamps()`（`install.py` L57）在每次成功 install 后刷新所有平台的版本戳，避免跨平台升级时的虚假警告。

### GRAPH_REPORT.md 生成

`report.generate()`（`report.py` L71）接收 `nx.Graph` + communities + cohesion + labels + gods + surprises + detection_result + token_cost，返回 Markdown 字符串。报告包含：Corpus Check（语料健康检查）、Summary、God Nodes、Surprising Connections、Import Cycles、Communities、Knowledge Gaps 等章节。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 平台分派 | `dispatch_install_cli()` in install.py | 15+ 平台适配，每平台独立 handler |
| 双兼容 API | `_build_server()` in serve.py | starlette 1.x/2.x 运行时选择 |
| 降级策略 | PreToolUse deny → nudge | deny ≤1x/session 防 strand |
| fail-open | 所有 hook 逻辑 | graphify bug 不阻断用户操作 |
| 自动注入 | `project_path` in serve.py L1624 | tool inputSchema 统一注入 |

## 模块间交互

- **→ cli.py**：install 完成后 skill 调用 `graphify` CLI；MCP server handler 调用 cli 的功能函数。
- **→ __main__.py**：`install.py` 的函数被 `__main__.py` re-export，保持 `from graphify.__main__ import <name>` 兼容。
- **→ report.py**：`cluster-only` 命令调 `report.generate()` 生成 GRAPH_REPORT.md。
- **→ exporters/html.py**：`cluster-only` 命令调 `to_html()` 生成 graph.html。
- **→ paths.py**：`_resolve_graphify_exe()` 用路径解析；hook 写入用原子写入。
- **← AI 助手**：Claude Code/Cursor/Codex 等通过 skill 文件或 MCP 协议调用 graphify。

## 扩展方式

### 新增一种 AI 助手支持

1. **`graphify/skills/<platform>/`**：创建平台专属 skill 模板目录
2. **`graphify/install.py`**：添加平台检测逻辑 + install/uninstall handler；在 `dispatch_install_cli()` 分派中添加新平台
3. **`graphify/__main__.py`**：re-export 新平台的 install 函数
4. **`_refresh_all_version_stamps()`**：添加新平台的版本戳路径
5. **对应测试**：`tests/test_<platform>.py`（参考 `tests/test_codebuddy.py`）

### 修改 hook 行为

1. **deny 触发条件**：编辑 `cli.py` `_run_hook_guard()`（L582）的判断逻辑；`GRAPHIFY_HOOK_STRICT_TTL` 环境变量控制新鲜度判定
2. **deny 措辞**：编辑 `cli.py` `_READ_DENY`（L57）的 `permissionDecisionReason` 字符串
3. **nudge 措辞**：编辑 `cli.py` `_READ_NUDGE`（L28）或 `_SEARCH_NUDGE`（L18）的 `additionalContext` 字符串（注意：这些常量被 `__main__.py` re-export，外部测试可能字节级比较）
4. **触发文件扩展名**：编辑 `cli.py` `_HOOK_SOURCE_EXTS`（L71）tuple

### 新增 MCP tool

1. **`serve.py` `list_tools()`**（L1489）：在 `_tools` 列表添加 `types.Tool(name=..., inputSchema=...)`
2. **`serve.py`**：添加 `def _tool_new_feature(arguments: dict) -> str:` handler 函数
3. **`serve.py` `_handlers` dict**：在 `_build_server()` 中将 handler 注册到 `_handlers` 字典
4. **`serve.py` `list_resources()`**（L1883）：如适合作为 resource，添加 `types.Resource(uri="graphify://new", ...)`
5. `project_path` 参数会自动注入（L1624-1637），无需手动添加
