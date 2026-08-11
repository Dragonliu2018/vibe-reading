---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "Overview"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "Agent", "Hooks", "MCP"]
description: "Claude Code 公开生态仓库解读——13 个官方插件的架构、5 类扩展点契约、hookify 规则引擎与部署示例"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v2.1.199 · **协议** Anthropic Commercial Terms · **语言** Markdown / Python / Bash / TypeScript / HCL · **代码量** ~40,000 行 · **仓库** [GitHub](https://github.com/anthropics/claude-code)

---

## 总览

### 项目简介

`anthropics/claude-code` 的公开 GitHub 仓库**不是 Claude Code CLI 的源码**——CLI 以压缩分发的 npm 包形式发布，源码不在此仓。这个仓库承载的是 Claude Code 的**官方生态资产**：13 个官方插件、部署示例（GCP gateway、企业 MDM 托管、权限预设）、仓库运维脚本与 CI 工作流。

它的核心价值是**声明式插件系统的规范与范例**。Claude Code 通过 5 类扩展点（commands / agents / skills / hooks / `.mcp.json`）被增强，而本仓的每个插件都是这套契约的一个可运行范本——从最简单的 `commit-commands`（3 个命令、325 行）到最复杂的 `plugin-dev`（7 个 skill、3 个 agent、~22,000 行的"造插件的插件"）。

**项目边界**：本仓负责插件定义、部署示例与仓库运维；**不负责** CLI 运行时实现（加载、注册、调度的内部逻辑不在本仓——本文能从声明式文件推断契约，运行时内部实现标注"不可见"）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| 插件清单 | `.claude-plugin/marketplace.json` + 各插件 `.claude-plugin/plugin.json` | 仓库根 marketplace 登记 13 插件；每插件 plugin.json 声明元信息 |
| Slash 命令 | `plugins/*/commands/*.md` | frontmatter `allowed-tools` 约束权限，正文驱动流程 |
| 子 Agent | `plugins/*/agents/*.md` | frontmatter `model`/`color`/`tools`，正文作系统提示 |
| Agent Skill | `plugins/*/skills/*/SKILL.md` | progressive disclosure：主文件 + references/examples/scripts |
| Hook 事件 | `plugins/*/hooks/hooks.json` + 脚本 | PreToolUse/PostToolUse/Stop/SessionStart/UserPromptSubmit |
| MCP 集成 | `plugins/*/.mcp.json` | 声明外部 MCP server，工具暴露给 Claude |
| GCP 部署 | `examples/gateway/gcp/` | Terraform + Docker + Cloud Run 反向代理 |
| 企业托管 | `examples/mdm/` | macOS mobileconfig + Windows admx/adml |
| 权限预设 | `examples/settings/` | strict / lax / bash-sandbox 三档 |
| 仓库运维 | `scripts/*.ts` + `.github/workflows/` | issue 自动化、重复检测、Claude 驱动的 triage |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Markdown + YAML frontmatter | 核心 | 插件扩展点的声明式定义（commands/agents/skills） |
| Python 3.7+ | 核心 | hookify 规则引擎、security-guidance hook 脚本 |
| Bash | 核心 | plugin-dev 校验脚本、hook 脚本、setup 脚本 |
| TypeScript | 可选 | `scripts/` 仓库 issue 管理脚本 |
| Terraform / HCL | 可选 | `examples/gateway/gcp` GCP 部署 |
| jq | 可选 | hook 脚本与校验脚本的 JSON 解析 |
| Claude Agent SDK | 可选 | security-guidance 的 agentic commit review |

---

## 快速上手

本仓无需构建——它是声明式资产集合。最快验证方式是装一个插件看效果：

```bash title="本地试用插件（需已装 Claude Code）"
# 在你的项目目录下
claude

# 在 Claude Code 内安装本仓的 marketplace 并启用插件
/plugin marketplace add https://github.com/anthropics/claude-code
/plugin install code-review
```

验证：输入 `/code-review`，若命令被识别并开始 PR 审查流程，说明插件契约生效。

开发者本地试用未发布插件：

```bash title="本地插件目录调试"
# 指向插件目录直接加载（不经 marketplace）
claude --plugin-dir /path/to/claude-code/plugins/hookify
```

> 内部加载链（扫描 `plugin.json` → 注册扩展点）见「运行时行为 > 启动流程」。

---

## 架构设计解析

### 系统架构

![Claude Code 仓库分层架构](/vibe-reading/images/articles/claude-code-codewiki/architecture.svg)

这套架构的核心思想是**声明式契约 + 进程隔离**：Claude Code 运行时（不在本仓）定义 5 类扩展点契约，本仓的插件用 Markdown + JSON + 脚本声明式地实现这些契约，运行时按需加载并调度。插件逻辑与运行时通过 stdin/stdout JSON 协议解耦，hook 脚本作为独立进程执行——崩溃不影响主进程，语言不限（Python/Bash/任一可执行）。

分四层，自上而下依赖递增：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|--------------------------|
| 运行时层 | （不在本仓） | 消费 5 类扩展点，提供加载/注册/调度——CLI 源码不可见，仅契约可见 |
| 插件契约层 | `.claude-plugin/`、各插件 `.claude-plugin/plugin.json`、`hooks/hooks.json`、`.mcp.json` | 定义扩展点契约——plugin.json 清单、marketplace 登记、5 扩展点 frontmatter 规范 |
| 官方插件层 | `plugins/`（13 个插件） | 实现契约的具体插件——按职责分 5 组：元插件/代码质量/开发流程/风格行为/Hook 引擎 |
| 示例与基础设施层 | `examples/`、`scripts/`、`.github/`、`.devcontainer/` | 部署拓扑、企业托管、权限预设、CI 运维——与插件逻辑正交 |

层间协作：运行时层向下扫描契约层的 `plugin.json` 发现插件，插件层的 13 个插件各自实现契约，示例层提供部署与治理模板。`marketplace.json`（仓库根 `.claude-plugin/`）是契约层的入口——登记所有可装插件及其 `source` 路径与 `category`。

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 声明式注册表 | `plugin.json` + `marketplace.json` | 用数据而非代码定义扩展点——加载即可用，无需编译，用户可读可改 |
| Frontmatter 元数据驱动 | `commands/*.md` 的 `allowed-tools`、`agents/*.md` 的 `model`/`tools` | 元数据与逻辑同文件，权限/模型约束随定义走，最小权限天然落地 |
| Progressive Disclosure | `plugin-dev/skills/*/SKILL.md` + `references/` + `examples/` + `scripts/` | 三层按需加载控制 context window——metadata 常驻、SKILL.md 触发加载、references 按需 |
| 钩子链 + 进程隔离 | `hooks/hooks.json` 多事件 + 独立脚本进程 | hook 崩溃不拖垮运行时；exit 0/2 语义传递决策 |
| 多模型分级编排 | `code-review/commands/code-review.md` 9 步 | haiku 门控、sonnet 摘要、opus 找 bug——按任务难度匹配模型成本 |
| Validation 闭环 | `plugin-dev/scripts/*.sh` + `plugin-validator` agent | 开发→校验→修复循环，bash 脚本零依赖可即跑 |
| 声明式规则引擎 | `hookify/core/rule_engine.py` + `.local.md` 规则文件 | 用户写 markdown 规则不写代码，Rule/Condition dataclass 驱动匹配 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `plugin.json` | 插件清单（name/version/description/author） | 插件安装→加载时读取 | 被 marketplace.json 引用 |
| `marketplace.json` | 仓库级插件登记表 | 仓库级静态 | 包含 13 个 plugin 条目 |
| `Rule` | hookify 规则（name/event/conditions/action/message） | 规则文件加载时由 `from_dict` 构造 | 含多个 `Condition` |
| `Condition` | 匹配三元组（field/operator/pattern） | 随 Rule 构造 | 被 `RuleEngine._check_condition` 消费 |
| `SECURITY_PATTERNS` | security-guidance 的 25 条安全模式 | 模块级常量 | 被 `check_patterns()` 遍历 |
| hook 事件 JSON | 运行时→hook 进程的 stdin | 单次 hook 调用 | 含 `tool_name`/`tool_input`/`hook_event_name` |

#### 核心抽象

5 类扩展点是整个生态的扩展契约——所有插件围绕它们构建：

| 扩展点 | 定义位置 | 实现形式 | 触发方式 |
|--------|----------|----------|----------|
| commands | `commands/*.md` frontmatter | Markdown + `allowed-tools` 白名单 | 用户输入 `/cmd` |
| agents | `agents/*.md` frontmatter | Markdown 系统提示 + `model`/`tools` | 主 Claude 用 Task 工具 spawn |
| skills | `skills/*/SKILL.md` frontmatter | SKILL.md + references/examples/scripts | description 匹配自动触发 |
| hooks | `hooks/hooks.json` | JSON 事件路由 + 脚本进程 | 运行时事件（PreToolUse 等） |
| MCP | `.mcp.json` | JSON server 配置 | 工具调用时启动 server |

---

## 代码目录

```
claude-code/
├── .claude-plugin/
│   └── marketplace.json        # 仓库级插件登记（13 插件 + owner + $schema）
├── plugins/                    # 官方插件层（13 个，~36,000 行）
│   ├── README.md               # 插件系统总览 + 结构规范
│   ├── plugin-dev/             # 元插件：7 skills + 3 agents + /create-plugin
│   ├── hookify/                # Python 规则引擎 + 4 hook 事件
│   ├── code-review/            # 9 步多模型 PR 审查
│   ├── pr-review-toolkit/      # 6 专项审查 agent
│   ├── security-guidance/      # 3 层安全审查 + 25 模式
│   ├── feature-dev/            # 7 阶段特性开发工作流
│   ├── commit-commands/        # /commit · /commit-push-pr · /clean_gone
│   ├── agent-sdk-dev/          # Agent SDK 项目脚手架 + py/ts verifier
│   ├── explanatory-output-style/  # SessionStart hook 教育洞察
│   ├── learning-output-style/     # SessionStart hook 互动学习
│   ├── ralph-wiggum/              # Stop hook 自循环迭代
│   ├── frontend-design/           # 前端设计 skill
│   └── claude-opus-4-5-migration/ # 模型迁移 skill
├── examples/                   # 部署示例
│   ├── gateway/gcp/            # Terraform + Docker + Cloud Run
│   ├── hooks/                  # hook 编写示例
│   ├── mdm/                    # macOS + Windows 企业托管
│   └── settings/               # strict/lax/bash-sandbox 权限预设
├── scripts/                    # TS issue 管理 + shell 运维脚本
├── .github/workflows/          # 12 个 CI workflow（issue triage/dedupe/sweep）
├── .devcontainer/              # dev container + firewall 隔离
├── CHANGELOG.md                # 版本变更日志（~400KB）
└── README.md
```

---

## 模块地图

![模块地图](/vibe-reading/images/articles/claude-code-codewiki/module-map.svg)

13 个插件按职责聚合成 7 个解读模块。依赖方向：`plugin-dev`（meta）的 7 个 skills 指导其他插件的开发；`hookify` 提供的 hook 模式被 `ralph-wiggum`/`explanatory`/`security-guidance` 等以不同方式实现；`examples/settings` 的权限预设治理所有插件的工具边界。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|------------|----------|
| 插件架构 | 5 扩展点契约 + 加载机制 | `.claude-plugin/marketplace.json` | 贯穿所有插件的共享契约，理解生态的基础 | [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) |
| plugin-dev | 造插件的插件 | `commands/create-plugin.md` | 元插件，提供 7 skills 开发其他插件，自指性范例 | [02-plugin-dev](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/02-plugin-dev) |
| hookify | 用户可配置的 hook 规则引擎 | `core/rule_engine.py` | 唯一含实质 Python 代码的插件，规则引擎 + 4 事件 | [03-hookify](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/03-hookify) |
| 代码质量插件组 | PR 审查 + 安全告警 | `code-review/commands/code-review.md` | 3 插件围绕审查与安全，多 Agent + 25 模式 | [04-code-quality-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/04-code-quality-plugins) |
| 开发流程插件组 | 特性开发 + git 自动化 + SDK 脚手架 | `feature-dev/commands/feature-dev.md` | 3 插件覆盖开发流程编排与自动化 | [05-dev-workflow-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/05-dev-workflow-plugins) |
| 风格行为插件组 | 输出风格 + 自循环 + 设计 + 迁移 | `ralph-wiggum/hooks/stop-hook.sh` | 5 插件影响 Claude 输出风格或运行行为 | [06-style-behavior-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/06-style-behavior-plugins) |
| 示例与部署 | 部署拓扑 + 企业托管 + 权限 + CI | `examples/gateway/gcp/terraform/main.tf` | 部署/运维/治理，与插件逻辑正交 | [07-examples-deployment](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/07-examples-deployment) |

> 模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

Claude Code 启动时的插件加载链（运行时内部实现不可见，以下由声明式契约推断）：

```
Claude Code 启动
  │
  ├─ 扫描已装插件目录（~/.claude/plugins/ 或项目 .claude/）
  │    └─ 定位每个插件的 .claude-plugin/plugin.json
  │
  ├─ 注入 ${CLAUDE_PLUGIN_ROOT} 环境变量
  │    └─ 指向插件安装根，供 hooks.json 命令引用
  │
  ├─ 注册 5 类扩展点
  │    ├─ commands/*.md     → 命令表（含 allowed-tools 白名单）
  │    ├─ agents/*.md       → agent 表（含 model/tools/color）
  │    ├─ skills/*/SKILL.md → skill 索引（description 用于匹配）
  │    ├─ hooks/hooks.json  → 事件路由表（PreToolUse/Stop/...）
  │    └─ .mcp.json         → MCP server 启动
  │
  └─ 权限叠加：managed settings > 用户 settings > 项目 settings > 插件 allowed-tools
```

对象装配的关键：`${CLAUDE_PLUGIN_ROOT}` 在 hooks.json 命令字符串中被运行时替换为插件实际路径，hook 脚本启动时从 `os.environ.get('CLAUDE_PLUGIN_ROOT')` 读取并据此设置 `sys.path`（见 `hookify/hooks/pretooluse.py` L14-23）。

### 核心运行流程

下面三条链路覆盖插件生态的核心运行模式：插件生命周期（安装到调用）、hook 事件处理（跨进程数据流）、多模型审查编排。

#### 安装与调用：插件生命周期

业务流程：用户安装插件 → 运行时启动扫描 → 注册 5 扩展点 → 运行时按扩展点类型触发执行。

![插件生命周期](/vibe-reading/images/articles/claude-code-codewiki/plugin-lifecycle.svg)

文字描述：`marketplace.json` 登记可装插件（`source` 指向 `./plugins/<name>`），用户经 `/plugin marketplace add` + `/plugin install` 获取。启动时扫描 `plugin.json`，将 commands 注册进命令表、agents 进 agent 表、skills 进 skill 索引、hooks 进事件路由、`.mcp.json` 启动 MCP server。调用时按扩展点类型分发：command 加载 `.md` 并以 frontmatter `allowed-tools` 约束本次工具权限；hook 事件经路由表执行脚本，stdin 传事件 JSON；skill 按 description 匹配加载 SKILL.md。数据从声明式定义 → 运行时注册表 → 触发时加载的 Markdown/脚本。

#### 事件处理：hook 跨进程数据流

hook 是最具体的跨进程数据流。以 hookify 拦截 `rm -rf` 为例：Claude 准备执行 Bash → 触发 PreToolUse → `hooks.json` 路由到 `pretooluse.py` → 脚本读 stdin JSON（`{tool_name, tool_input, hook_event_name}`）→ `load_rules(event="bash")` 加载 `.claude/hookify.*.local.md` → `RuleEngine.evaluate_rules` 匹配条件 → 返回 stdout JSON。返回 `{}` 放行；`{systemMessage}` 警告但放行；`{hookSpecificOutput: {permissionDecision: "deny"}}` 阻止。退出码语义：exit 0 = 正常/降级放行（hookify 永不阻塞），exit 2 = stderr 强制 Claude 继续（security-guidance 发现漏洞时）。

#### 审查编排：code-review 多模型流水线

`/code-review` 的 9 步流水线是多 Agent 编排的范例（详见 [04-code-quality-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/04-code-quality-plugins)）：haiku 门控（过滤不需要审查的 PR）→ haiku 收集 CLAUDE.md → sonnet 摘要 → 4 并行 review agent（2 sonnet 合规 + 2 opus 找 bug）→ 并行验证 → 过滤未验证 → 输出/inline comment。核心设计是三重置信度过滤：Step 4 只标 HIGH SIGNAL、Step 5 独立验证、Step 6 丢弃未确认——"false positive erode trust"。

### 状态流

![Stop Hook 状态流](/vibe-reading/images/articles/claude-code-codewiki/hook-state-flow.svg)

本仓最有意思的状态流转在 Stop hook：Claude 尝试结束时触发 Stop 事件，hook 脚本可阻止退出并强制继续。两条阻止路径语义不同——`ralph-wiggum` 的 `stop-hook.sh` 检测 `completion_promise` 未达，输出 `{decision: "block", reason: <原始 prompt>}` 重新注入 prompt 实现循环；`security-guidance` 的 `security_reminder_hook.py` 发现漏洞时 `exit 2` + stderr，强制 Claude 修复后继续（`CONTINUATION_SUFFIX` 保证修完继续原请求）。递归保护：`security_reminder_hook.py` 检查 `stop_hook_active` 跳过嵌套 Stop，`MAX_STOP_HOOK_FIRINGS=3` 限制最大触发次数；ralph-wiggum 用 `max_iterations` 字段。两者超限后均走 Ended 分支。

---

## 典型修改场景

#### 场景 1：新增一个带 MCP 的插件

| 文件 | 操作 | 关键约束 |
|------|------|----------|
| `my-plugin/.claude-plugin/plugin.json` | 新建 | `{name, version, description, author}` |
| `my-plugin/.mcp.json` | 新建 | 路径用 `${CLAUDE_PLUGIN_ROOT}`，env 用 `${VAR}` |
| `my-plugin/commands/query.md` | 新建 | frontmatter `allowed-tools` 列 `mcp__plugin_my-plugin_<server>__<tool>` |
| `.claude-plugin/marketplace.json` | 修改 | `plugins[]` 加条目（name + source + category） |

扩展点契约见「架构设计解析 > 核心概念」。对应校验：`plugin-dev/scripts` 的 `validate-hook-schema.sh`、`validate-agent.sh`。

#### 场景 2：给 hookify 加一种 operator（如 `not_regex_match`）

| 文件 | 修改点 |
|------|--------|
| `hookify/core/rule_engine.py` | `_check_condition` (L166-180) if-elif 链加分支 |
| `hookify/skills/writing-rules/SKILL.md` | Operators 部分加说明 |
| `hookify/README.md` | Operators Reference 表格加条目 |

`Condition.from_dict` 只原样存储 operator 字符串，无需改 `config_loader.py`。

#### 场景 3：给 security-guidance 加一种漏洞模式（如 SQL injection）

| 文件 | 修改点 |
|------|--------|
| `security-guidance/hooks/patterns.py` | `SECURITY_PATTERNS` 列表追加规则 dict（ruleName/regex/reminder） |
| `security-guidance/hooks/patterns.py` | `RuleId` IntEnum + `_RULE_NAME_TO_ID` dict 加映射 |

`check_patterns()` 自动遍历 `SECURITY_PATTERNS` + 用户自定义规则，新规则自动生效。`patterns.py` L328-334 的 assert 会在 import 时检查两者同步。

> 对应测试：本仓无正式 test 目录，`patterns.py` 的 import-assert 与 `hookify/core/rule_engine.py` 的 `if __name__ == '__main__'` 块是最近的等价物。

---

## 测试体系

本仓**无正式 test 目录**（无 `tests/`、无 `test_*.py`）。这是声明式生态的特质——插件定义本身就是"可执行文档"，正确性靠运行时加载验证。三层非正式校验替代测试：

| 校验层 | 位置 | 形式 |
|--------|------|------|
| Shell 校验脚本 | `plugin-dev/skills/*/scripts/*.sh` | `validate-agent.sh`、`validate-hook-schema.sh`、`hook-linter.sh`、`test-hook.sh` |
| Python 自测块 | `hookify/core/rule_engine.py` L277-313、`config_loader.py` L278-298 | `if __name__ == '__main__'` 可独立运行 |
| Import 时断言 | `security-guidance/hooks/patterns.py` L328-334 | `SECURITY_PATTERNS` 与 `_RULE_NAME_TO_ID` 同步检查 |

理解某个插件时，优先读它的 `README.md`（每个插件都有完整文档）与 `plugin-dev` 对应 skill 的 `examples/`（可复制的范本）。

---

## 阅读源码推荐路线

- **第一遍：理解插件契约**
  `.claude-plugin/marketplace.json`（仓库根登记表）→ `plugins/README.md`（结构规范）→ `plugins/code-review/.claude-plugin/plugin.json`（最小清单）→ `plugins/code-review/commands/code-review.md`（command frontmatter + 9 步流程）

- **第二遍：理解 5 扩展点的实例**
  `plugins/feature-dev/agents/code-explorer.md`（agent 定义）→ `plugins/plugin-dev/skills/plugin-structure/SKILL.md`（skill 定义）→ `plugins/hookify/hooks/hooks.json`（hook 注册）→ `plugins/hookify/hooks/pretooluse.py`（hook 执行器）

- **第三遍：深入唯一的代码模块**
  `plugins/hookify/core/config_loader.py` 的 `Rule`/`Condition` dataclass → `rule_engine.py` 的 `RuleEngine.evaluate_rules` → 4 个 hook 入口脚本如何共用 core 层

- **第四遍：选择重点子模块深入**
  元插件 [02-plugin-dev](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/02-plugin-dev) · 规则引擎 [03-hookify](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/03-hookify) · 审查流水线 [04-code-quality-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/04-code-quality-plugins) · 部署 [07-examples-deployment](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/07-examples-deployment)

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| 扩展点 | Claude Code 运行时定义的 5 类增强契约：commands/agents/skills/hooks/MCP |
| `${CLAUDE_PLUGIN_ROOT}` | 运行时注入的环境变量，指向插件安装根目录 |
| progressive disclosure | skill 的三层加载：metadata 常驻 → SKILL.md 触发加载 → references 按需 |
| allowed-tools | command frontmatter 字段，白名单约束该命令可用的工具 |
| asyncRewake | hook 字段，后台异步执行后通过 `rewakeMessage` 唤醒 Claude |
| HIGH SIGNAL | code-review 的设计原则，只报高置信度问题以避免 false positive |

### 参考资料

- [Claude Code 官方文档](https://code.claude.com/docs/en/overview)
- [Plugins 官方文档](https://docs.claude.com/en/docs/claude-code/plugins)
- [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk)
- 仓库 [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)（~400KB，版本演进明细）
