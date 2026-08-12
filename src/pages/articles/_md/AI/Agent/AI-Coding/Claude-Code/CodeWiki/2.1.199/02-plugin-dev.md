---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "plugin-dev 元插件"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "Agent", "Skill", "progressive disclosure"]
description: "plugin-dev——造插件的插件：7 个 expert skills + 3 个 agent + 8 阶段 /create-plugin 引导，progressive disclosure 的自指性范例"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

`plugin-dev` 是本仓最大的插件（58 文件、~22,000 行），也是唯一的**元插件**——它的作用是帮助开发者构建其他 Claude Code 插件。它自身就是一个完整插件，因此是插件系统契约（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture)）的最佳实践范本：7 个 skill 各覆盖一个插件开发维度，3 个 agent 分工生成/校验/审查，1 个命令 `/plugin-dev:create-plugin` 用 8 阶段引导把 skill 和 agent 串成流水线。

它的核心价值是**自指性**：`skill-development/SKILL.md` L294-316 明确指出"Study the skills in this plugin as examples of best practices"——plugin-dev 的 7 个 skill 本身就是 progressive disclosure 的示范。

## 模块架构

```
plugins/plugin-dev/
├── commands/
│   └── create-plugin.md          ← 8 阶段引导入口
├── agents/
│   ├── agent-creator.md          ← 生成 agent 配置（model: sonnet, tools: Write/Read）
│   ├── plugin-validator.md       ← 全面校验插件（tools: Read/Grep/Glob/Bash）
│   └── skill-reviewer.md         ← 审查 skill 质量（tools: Read/Grep/Glob）
└── skills/                       ← 7 个 expert skills
    ├── plugin-structure/         ← 目录结构 + manifest + auto-discovery
    ├── command-development/      ← slash 命令 + frontmatter
    ├── agent-development/        ← agent 结构 + system prompt + <example>
    ├── hook-development/         ← 9 种 hook 事件 + prompt-based hooks
    ├── mcp-integration/          ← stdio/SSE/HTTP + .mcp.json + OAuth
    ├── plugin-settings/          ← .local.md 配置 + YAML 解析
    └── skill-development/        ← SKILL.md 结构 + progressive disclosure 方法论
```

每个 skill 遵循 `skill-development/SKILL.md` L79 定义的 **progressive disclosure 三层加载系统**：

| 层 | 目录 | 加载时机 | 内容 |
|----|------|----------|------|
| 1 Metadata | SKILL.md frontmatter | 始终在 context（~100 words/skill） | name + description |
| 2 SKILL.md body | SKILL.md 正文 | skill 触发时加载（<5k words） | 核心指导，覆盖 80% 场景 |
| 3 Bundled resources | `references/` + `examples/` + `scripts/` | Claude 按需加载 | references 深度文档 / examples 可复制代码 / scripts 可执行校验工具 |

7 个 skill 的 `description` 均用第三人称 + 具体 trigger phrase（如 `"create a hook"`、`"add a PreToolUse hook"`），决定自动加载时机。

## 调用链路

### create-plugin 8 阶段流程

```
/plugin-dev:create-plugin [description]
  │
  ├─ Phase 1: Discovery            理解用途，识别插件类型（无 skill 加载）
  ├─ Phase 2: Component Planning   【MUST】加载 plugin-structure skill → 输出组件表
  ├─ Phase 3: Detailed Design      【CRITICAL】逐组件细化，消除歧义
  ├─ Phase 4: Structure Creation   mkdir + plugin.json + README + .gitignore
  ├─ Phase 5: Component Implement  ← 核心：按组件类型加载不同 skill
  │    ├─ Skills:    加载 skill-development → skill-reviewer 审查
  │    ├─ Commands:  加载 command-development
  │    ├─ Agents:    加载 agent-development → agent-creator 生成 → validate-agent.sh
  │    ├─ Hooks:     加载 hook-development → validate-hook-schema.sh + test-hook.sh
  │    ├─ MCP:       加载 mcp-integration
  │    └─ Settings:  加载 plugin-settings
  ├─ Phase 6: Validation           plugin-validator + skill-reviewer + 校验脚本
  ├─ Phase 7: Testing              cc --plugin-dir 本地测试指引
  └─ Phase 8: Documentation        README 完整性 + 可选 marketplace 发布
```

三个 agent 的介入时机：`agent-creator` 在 Phase 5（For Agents）生成 agent 配置；`plugin-validator` 在 Phase 6 全面校验；`skill-reviewer` 在 Phase 5（For Skills）+ Phase 6 双重审查。

5 个 Key Decision Points（`commands/create-plugin.md` L363-369）：Phase 1 后确认用途、Phase 2 后批准组件计划、Phase 3 后进入实现、Phase 6 后修复或继续、Phase 7 后继续文档化。每阶段加载不同 skill，避免一次性加载全部知识。

<details>
<summary>方法/阶段速查表</summary>

| 阶段 | 加载的 skill | 介入的 agent | 用户交互 |
|------|-------------|-------------|----------|
| 1 Discovery | — | — | 确认理解 |
| 2 Component Planning | plugin-structure | — | 批准组件表 |
| 3 Detailed Design | 按组件类型 | — | 回答澄清问题 |
| 5 Component Implement | skill/command/agent/hook/mcp/settings-development | agent-creator（agent 组件） | — |
| 6 Validation | — | plugin-validator + skill-reviewer | 修复或继续 |
| 7 Testing | — | — | 本地验证 |

</details>

## 核心实现

### Progressive Disclosure 三层加载

`skills/skill-development/SKILL.md` L78-84 阐述了 skill 系统的核心设计原则——**按需加载控制 context window**：

- **层 1（metadata）**：7 个 skill 的 description 总共 ~400 words，始终在 context，开销极小
- **层 2（SKILL.md body）**：目标 1,500-2,000 words/skill（`skill-development/SKILL.md` L190 设计目标），只在触发时加载，覆盖 80% 常见场景
- **层 3（references/examples/scripts）**：单文件数百到数千 words，只在 Claude 判断需要深度信息时加载

**为什么这样设计**：如果合成一个大文件，用户问"how to add a hook"时会加载整个插件开发知识库（~22,000 行），浪费 context window。拆成 7 个 skill 后，问"create a hook"只加载 `hook-development/SKILL.md`（~2,100 words），详细 pattern 放 `references/patterns.md`（~880 words）按需加载。这避免了"要么不加载，要么全加载"的二元困境。

### 三 Agent 分工与最小权限

三个 agent 通过 frontmatter `tools` 字段实现职责隔离与最小权限：

| Agent | model | tools | 职责 | 介入阶段 |
|-------|-------|-------|------|----------|
| agent-creator | sonnet | `["Write", "Read"]` | 生成 agent 的 identifier + whenToUse + systemPrompt | Phase 5 |
| plugin-validator | inherit | `["Read", "Grep", "Glob", "Bash"]` | 10 步全面校验插件 | Phase 6 |
| skill-reviewer | inherit | `["Read", "Grep", "Glob"]` | 8 步审查 skill 质量 | Phase 5 + 6 |

**为什么分三个而非一个**：（1）职责不同——creator 是生成器（Write），validator 是校验器（Read+Bash），reviewer 是审查器（纯 Read），合并会导致 system prompt 过长且职责模糊；（2）权限隔离——creator 只需写读，validator 需执行校验脚本，reviewer 纯只读，分开后各自最小权限；（3）独立触发——用户可能只审查一个 skill（触发 reviewer）而不校验整个插件（触发 validator），合并后无法精准触发。

`agent-creator` 用 sonnet（生成任务，sonnet 足够且经济），`plugin-validator`/`skill-reviewer` 用 `inherit`（继承调用者模型，校验成本可控）。

### plugin-validator 的 10 步校验

`agents/plugin-validator.md` L49-134 定义校验流程：

1. **Locate Plugin Root**——查找 `.claude-plugin/plugin.json`
2. **Validate Manifest**——JSON 语法（用 `jq`）、`name` kebab-case、`version` 语义化
3. **Validate Directory Structure**——Glob 扫描 `commands/`/`agents/`/`skills/`/`hooks/`
4. **Validate Commands**——每个 `.md` 有 frontmatter + `description`
5. **Validate Agents**——调用 `validate-agent.sh` 或手动检查 frontmatter + `<example>` 块
6. **Validate Skills**——每个 `skills/*/SKILL.md` 有 frontmatter + 引用文件存在
7. **Validate Hooks**——调用 `validate-hook-schema.sh` 检查 JSON + event names + `${CLAUDE_PLUGIN_ROOT}`
8. **Validate MCP**——JSON 语法 + stdio 有 `command` / SSE-HTTP 有 `url`
9. **Check File Organization**——README 存在、无多余文件、.gitignore
10. **Security Checks**——无硬编码 credentials、HTTPS/WSS、hooks 无安全问题

输出结构化 Validation Report（Critical Issues / Warnings / Component Summary / Overall Assessment PASS/FAIL）。

### Bash 校验脚本（零依赖闭环）

每个 skill 自带校验脚本，形成"开发 → 校验 → 修复"闭环：

| 脚本 | 位置 | 校验内容 |
|------|------|----------|
| `validate-hook-schema.sh` | `hook-development/scripts/` | hooks.json 语法、event name 合法性、hook type、timeout 范围（5-600s）、硬编码路径检测 |
| `hook-linter.sh` | `hook-development/scripts/` | 13 项检查（shebang、`set -euo pipefail`、stdin 读取、jq 使用、exit code、JSON 输出等） |
| `test-hook.sh` | `hook-development/scripts/` | 用 sample input 实际执行 hook，显示 exit code/duration/output，支持 `--create-sample` |
| `validate-agent.sh` | `agent-development/scripts/` | frontmatter 字段（name 3-50 chars + 格式正则、`<example>` 块、model/color 合法值）、system prompt 长度（20-10,000 chars） |
| `parse-frontmatter.sh` | `plugin-settings/scripts/` | 从 `.local.md` 提取 YAML frontmatter 或单个字段 |

**为什么用 bash 而非 Python**：（1）零依赖——bash 在 macOS/Linux 预装，无需 `pip install`；（2）与 hook 生态一致——Claude Code 的 command hook 本身就是 bash 脚本；（3）即时可执行——`./validate-agent.sh agent.md` 直接跑，无解释器启动开销；（4）可被 agent 直接调用——`plugin-validator` 的 tools 含 `Bash`，直接在 agent 内调用脚本。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Progressive Disclosure | `skill-development/SKILL.md` L78-84 + 所有 skill 的四层结构 | 三层按需加载控制 context window |
| 单一职责 + 最小权限 | 三 agent 的 `tools` frontmatter | 职责隔离 + 权限隔离 + 独立触发 |
| Validation 闭环 | `scripts/*.sh` + `plugin-validator` agent | 开发→校验→修复循环，零依赖可即跑 |
| 自指性范例 | `skill-development/SKILL.md` L294-316 | 用自身的 skill 结构示范 skill 应该怎么写 |
| 阶段化 Skill 加载 | `create-plugin.md` 8 阶段各加载不同 skill | 避免一次性加载全部知识，按进度注入 |

## 模块间交互

plugin-dev 与被开发的插件是**元关系**：它通过 Skill tool 加载自身 skill 提供 domain knowledge，通过 Task tool 调用 agent 执行自动化操作（生成/校验/审查），最终产出一个独立的、符合插件规范的插件目录。它的 7 个 skill 指导其他 12 个插件的开发（见概览模块地图的 meta 虚线连接）。

## 扩展方式

新增一个 plugin-dev skill（如 `mcp-transport` 专处理 MCP transport 层）：

1. 新建 `skills/mcp-transport/SKILL.md`（frontmatter `name`/`description` + trigger phrases）
2. 新建 `skills/mcp-transport/references/`（从 `mcp-integration/references/server-types.md` 拆分 transport 内容）
3. 修改 `skills/mcp-integration/SKILL.md` 精简 transport 部分，加 `See also` 指向
4. 修改 `README.md` Skills 列表加第 8 个 skill
5. 修改 `commands/create-plugin.md` Phase 5 MCP 部分加加载指引

给 `create-plugin` 加 marketplace 发布阶段：在 Phase 8 后加 Phase 9，新建 `skills/marketplace-publishing/SKILL.md`，更新 `create-plugin.md` 的 phase 计数与 Key Decision Points。

> 注意：`agents/plugin-validator.md` L183 含一段疑似开发对话残留（"Excellent work! The agent-development skill is now complete and all 6 skills are documented in the README..."）——实际 plugin-dev 有 7 个 skill，且 `create-plugin.md` L29 自称"7 phases"但实际定义 8 个 Phase，均为源码自身的计数不一致，不影响功能但宜清理。
