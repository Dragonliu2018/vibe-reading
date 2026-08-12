---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "插件架构"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "Agent", "Hooks", "MCP"]
description: "Claude Code 插件系统契约——plugin.json 清单、5 类扩展点 frontmatter、marketplace 登记、加载与权限层级"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

本模块不是某个具体插件，而是**贯穿所有 13 个插件的共享契约**——Claude Code 运行时定义的 5 类扩展点（commands / agents / skills / hooks / `.mcp.json`）、`plugin.json` 清单规范、`marketplace.json` 登记机制，以及运行时加载与权限层级。

理解这套契约是阅读任何具体插件的前提：每个插件都是这 5 个扩展点的某种组合实现。本模块从声明式文件推断契约（运行时 CLI 源码不在本仓，内部加载算法不可见，能从 frontmatter 字段和 hook 脚本 I/O 确认的部分标注"由结构推断"）。

## 模块架构

插件系统的静态结构是一个**两层登记 + 五类扩展点**的声明式注册表：

```
仓库根
└── .claude-plugin/
    └── marketplace.json          ← 仓库级登记：13 插件 + owner + $schema

每个插件
├── .claude-plugin/
│   └── plugin.json               ← 插件清单（name/version/description/author）
├── commands/*.md                 ← 扩展点 1：slash 命令（frontmatter 驱动）
├── agents/*.md                   ← 扩展点 2：子 agent（frontmatter 驱动）
├── skills/*/SKILL.md             ← 扩展点 3：Agent Skill（progressive disclosure）
├── hooks/hooks.json + 脚本       ← 扩展点 4：事件 hook（进程隔离）
└── .mcp.json                     ← 扩展点 5：MCP server 配置
```

`marketplace.json` 是仓库级入口，登记每个插件的 `name`、`source`（相对路径如 `./plugins/code-review`）、`category`（如 `productivity`/`development`）、`description` 与可选 `author`。运行时经 `/plugin marketplace add` 注册仓库后，按 `source` 定位各插件目录。

## 调用链路

### plugin.json 清单契约

最小且统一的清单——多数插件的 `plugin.json` 只含 4 个基础字段（`name`/`version`/`description`/`author`）；`security-guidance` 多一个 `homepage` 字段；`plugin-dev` 较特殊，其 `.claude-plugin/plugin.json` 不在常规位置（结构见 [02-plugin-dev](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/02-plugin-dev)）。按 `plugin-dev/skills/plugin-structure` 的 manifest 参考，`plugin.json` 还可含 `repository`/`license`/`keywords` 及自定义路径配置（`commands`/`agents`/`hooks`/`mcpServers`）。

```json title="plugins/code-review/.claude-plugin/plugin.json"
{
  "name": "code-review",
  "description": "Automated code review for pull requests using multiple specialized agents with confidence-based scoring",
  "version": "1.0.0",
  "author": {
    "name": "Boris Cherny",
    "email": "boris@anthropic.com"
  }
}
```

| 字段 | 类型 | 用途 |
|------|------|------|
| `name` | string | 插件唯一标识（kebab-case），用于 `/plugin install <name>` |
| `version` | string | 语义化版本，marketplace 展示 |
| `description` | string | 一句话定位，marketplace 展示 |
| `author` | object | `{name, email}`，可选 |

> `plugin.json` **不含**扩展点声明——扩展点由目录约定自动发现（`commands/`、`agents/`、`skills/`、`hooks/`、`.mcp.json`）。清单只管元信息，目录结构管扩展点。这是"约定优于配置"的体现。

### 5 扩展点 frontmatter 契约

每个扩展点用 Markdown/JSON + frontmatter 声明，元数据与逻辑同文件：

**command**（`commands/*.md`）：

```yaml title="plugins/code-review/commands/code-review.md frontmatter"
---
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), mcp__github_inline_comment__create_inline_comment
description: Code review a pull request
---
```

`allowed-tools` 是**白名单**——命令执行期间只允许这些工具（共 8 条），且支持参数前缀限定（`Bash(gh pr diff:*)` 只允许 `gh pr diff` 开头的命令）。这是最小权限原则的声明式落地。

**agent**（`agents/*.md`）：

```yaml title="plugins/feature-dev/agents/code-explorer.md frontmatter"
---
name: code-explorer
description: Deeply analyzes existing codebase features by tracing execution paths, mapping architecture layers, understanding patterns and abstractions, and documenting dependencies to inform new development
model: sonnet
tools: Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch, KillShell, BashOutput
color: yellow
---
```

| 字段 | 用途 |
|------|------|
| `model` | `haiku`/`sonnet`/`opus`/`inherit`，按任务难度匹配成本 |
| `tools` | 白名单，省略时继承调用者工具集 |
| `color` | agent 面板视觉标识 |
| `<example>` 块 | 正文中的触发示例，告诉主 Claude 何时 spawn 此 agent |

**skill**（`skills/*/SKILL.md`）：

```yaml title="plugins/plugin-dev/skills/plugin-structure/SKILL.md frontmatter"
---
name: Plugin Structure
description: This skill should be used when creating a new plugin or modifying plugin structure...
---
```

`description` 是 skill 的**触发契约**——运行时据此判断当前任务是否匹配该 skill。第三人称写法 + 具体 trigger phrase（如 `"create a hook"`）决定自动加载时机。

**hook**（`hooks/hooks.json`）：

```json title="plugins/hookify/hooks/hooks.json"
{
  "description": "Hookify plugin - User-configurable hooks from .local.md files",
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py", "timeout": 10 }] }
    ],
    "PostToolUse": [...],
    "Stop": [...],
    "UserPromptSubmit": [...]
  }
}
```

插件格式带 `description` wrapper（与 settings.json 中直接定义 hook 的格式区分）。关键字段：`type: "command"` 指定脚本进程、`timeout` 秒数、`${CLAUDE_PLUGIN_ROOT}` 路径变量。security-guidance 的 `hooks.json` 还用 `matcher`（匹配工具名）、`if`（条件如 `Bash(git commit:*)`）、`asyncRewake: true`（后台异步唤醒）。

**MCP**（`.mcp.json`）：声明外部 MCP server，运行时启动后工具暴露给 Claude。具体配置见 `plugin-dev/skills/mcp-integration/examples/` 的 stdio/sse/http 三种 server 模板。

<details>
<summary>方法/字段速查表</summary>

| 扩展点 | 关键 frontmatter 字段 | 触发方式 | 权限约束 |
|--------|----------------------|----------|----------|
| command | `allowed-tools`, `description`, `argument-hint` | 用户 `/cmd` | `allowed-tools` 白名单 |
| agent | `model`, `tools`, `color`, `name`, `description` | Task 工具 spawn | `tools` 白名单 |
| skill | `name`, `description` | description 匹配自动触发 | 继承调用者 |
| hook | `type`, `command`, `timeout`, `matcher`, `if`, `asyncRewake` | 运行时事件 | 进程隔离 + exit 码 |
| MCP | server `command`/`url` + `args`/`env` | 工具调用时 | server 内部实现 |

</details>

## 核心实现

### `${CLAUDE_PLUGIN_ROOT}` 注入机制

运行时在执行 hook 命令时，将 `${CLAUDE_PLUGIN_ROOT}` 替换为插件实际安装路径。hook 脚本据此定位自身代码：

```python title="plugins/hookify/hooks/pretooluse.py"
PLUGIN_ROOT = os.environ.get('CLAUDE_PLUGIN_ROOT')
# 将 PLUGIN_ROOT 的父目录加入 sys.path
# 因为 import 用 hookify.core.xxx 包路径，需 plugin 父目录在 path 上
sys.path.insert(0, os.path.dirname(PLUGIN_ROOT))
sys.path.insert(0, PLUGIN_ROOT)  # 兜底
```

**为什么注入父目录**：hook 命令是 `python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py`，脚本内部 `from hookify.core.config_loader import load_rules` 用的是 `hookify.core.xxx` 包路径，Python 需要插件的**父目录**在 `sys.path` 上才能解析 `hookify` 包。这个细节决定了 hookify 的 Python 模块能否被正确 import。

### 权限层级与 settings 治理

插件 command 的 `allowed-tools` 不是最终权限——它受 settings 层级约束：

```
managed settings (企业强制)
    > 用户 settings (~/.claude/settings.json)
        > 项目 settings (.claude/settings.json)
            > 插件 command 的 allowed-tools
```

`examples/settings/settings-strict.json` 的三个关键管理开关：

| 字段 | 作用 |
|------|------|
| `allowManagedPermissionRulesOnly` | 只允许 managed settings 定义的 allow/ask/deny，用户级和项目级权限被忽略 |
| `allowManagedHooksOnly` | 只允许 managed settings 批准的 hooks，插件的 `hooks.json` 被忽略 |
| `strictKnownMarketplaces` | 限制可用 marketplace 列表（空数组 = 无 marketplace 可用） |

**设计决策**：为什么 `allowed-tools` 用白名单而非黑名单？白名单默认拒绝——新增工具不会自动获得权限，符合最小权限原则。command 只声明它实际需要的工具（如 `/commit` 只允许 `git add/status/commit`，不允许 push），降低误操作风险。

### Hook I/O 契约与退出码语义

hook 与运行时通过 stdin/stdout JSON + 退出码通信，这是整个系统最具体的跨进程契约：

| 退出码 | 语义 | 使用者 |
|--------|------|--------|
| `0` + `{}` | 无匹配，放行 | hookify 正常路径 |
| `0` + `{systemMessage}` | 警告但放行 | hookify warning 规则 |
| `0` + `{hookSpecificOutput: {permissionDecision: "deny"}}` | 阻止工具执行 | hookify blocking 规则（PreToolUse） |
| `0` + `{decision: "block", reason}` | 阻止 Stop 并重注入 | ralph-wiggum 循环 |
| `2` + stderr | 强制 Claude 继续（修复问题） | security-guidance 发现漏洞 |

**两种失败哲学**：hookify 永远 `exit 0`（`finally: sys.exit(0)`）——hook 出错也不阻塞用户，fail-safe 放行；security-guidance 发现漏洞时 `exit 2`——强制 Claude 修复，fail-closed 拦截。选择取决于场景：hookify 是用户配置的便利规则，不应因自身 bug 阻塞工作流；security-guidance 是安全审查，漏报代价高于误报。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 声明式注册表 | `plugin.json` + `marketplace.json` | 数据定义扩展，加载即可用，无需编译 |
| 约定优于配置 | 扩展点目录名（`commands/`/`agents/`/...）自动发现 | 清单不列扩展点，目录约定即声明，减少配置噪声 |
| Frontmatter 元数据驱动 | 各 `.md` 文件 frontmatter | 元数据与逻辑同文件，权限/模型约束随定义走 |
| 白名单权限 | `allowed-tools` | 默认拒绝，最小权限，新增工具不自动授权 |
| 进程隔离 + JSON 协议 | hook 独立进程 + stdin/stdout | 崩溃不拖垮运行时，语言不限，可独立测试 |

## 模块间交互

插件契约层是所有插件的地基——每个插件都实现这 5 个扩展点的某种子集。典型组合：

| 插件 | 用到的扩展点 |
|------|-------------|
| code-review | command（1） |
| feature-dev | command（1）+ agent（3） |
| plugin-dev | command（1）+ agent（3）+ skill（7） |
| hookify | command（4）+ agent（1）+ skill（1）+ hook（4 事件）+ Python core |
| security-guidance | hook（4 事件）+ Python 脚本 |
| ralph-wiggum | command（3：`/ralph-loop`/`/cancel-ralph`/`/help`）+ hook（Stop） |

`marketplace.json`（本模块）→ 各插件 `plugin.json`（本模块）→ 各扩展点 frontmatter（本模块）→ 运行时加载调度（不可见）。插件契约层不依赖任何具体插件，但所有插件依赖它。

## 扩展方式

新增插件的标准流程由 `plugin-dev` 插件的 `/plugin-dev:create-plugin` 命令固化（8 阶段引导，详见 [02-plugin-dev](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/02-plugin-dev)）。手工新增需：

1. 建 `my-plugin/.claude-plugin/plugin.json`（4 字段清单）
2. 按需建扩展点目录（`commands/`/`agents/`/`skills/`/`hooks/`/`.mcp.json`）
3. 在仓库根 `.claude-plugin/marketplace.json` 的 `plugins[]` 加条目（name + source + category）
4. 用 `plugin-dev` 的校验脚本验证（`validate-agent.sh`、`validate-hook-schema.sh`）

扩展点的契约定义见本模块「核心实现」与概览「架构设计解析 > 核心概念」。
