---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "风格与行为插件组"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "output-style", "ralph-wiggum", "frontend-design"]
description: "五个风格与行为插件——explanatory/learning 输出风格、ralph-wiggum 自循环、frontend-design 设计 skill、opus-4.5 模型迁移"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

本模块含五个影响 Claude 输出风格或运行行为的插件。它们都不含复杂业务逻辑，而是通过不同扩展点**注入上下文或拦截行为**：`explanatory-output-style`/`learning-output-style` 用 SessionStart hook 注入指令；`ralph-wiggum` 用 Stop hook 拦截退出实现自循环；`frontend-design` 用 skill 自动触发提供设计指导；`claude-opus-4-5-migration` 用 skill 处理模型迁移。五个插件展示了"同一目标（影响 Claude 行为）的不同扩展点选择"。

## 模块架构

| 插件 | 扩展点 | 触发方式 | 代码量 | 影响维度 |
|------|--------|----------|--------|----------|
| explanatory-output-style | hook（SessionStart） | 会话开始自动 | 111 行 | 输出加教育洞察 |
| learning-output-style | hook（SessionStart） | 会话开始自动 | 132 行 | 互动学习，要求用户写代码 |
| ralph-wiggum | command（3）+ hook（Stop） | `/ralph-loop` 启动 | 745 行 | 自循环迭代 |
| frontend-design | skill | 前端任务自动匹配 | 95 行 | 前端设计指导 |
| claude-opus-4-5-migration | skill | 迁移任务触发 | 311 行 | model string/beta header/prompt 迁移 |

## 调用链路

### 输出风格 hook 机制

explanatory 与 learning 都用 SessionStart hook 注入指令，但注入内容不同：

```
会话开始
  └─ SessionStart 事件触发
     └─ hook 脚本输出 {hookSpecificOutput: {additionalContext: "<指令文本>"}}
        └─ Claude Code 将 additionalContext 注入 Claude 上下文
           ├─ explanatory: "在实现选择和代码库模式处加教育洞察"
           └─ learning: "在决策点要求用户写 5-10 行有意义代码，同时提供教育洞察"
```

两者差异：explanatory 只加教育性注释（被动）；learning 要求用户**主动写代码**（5-10 行），在决策点停下来让用户参与。learning 更激进——它改变交互模式而非仅改输出风格。

`explanatory/README.md` L58-62 给出重要的边界提示：

> Output styles that involve tasks besides software development, are better expressed as subagents, not as SessionStart hooks. Subagents change the system prompt while SessionStart hooks add to the default system prompt.

这划清了 hook 与 subagent 的边界：hook **追加**到默认 system prompt，subagent **替换** system prompt。轻量增强用 hook，深度角色切换用 subagent。

### ralph-wiggum 自循环机制

ralph-wiggum 是本组最有意思的插件——用 Stop hook 实现"while-true 循环"，让 Claude 反复处理同一任务直到完成。状态流见概览「运行时行为 > 状态流」的 SVG。

```
/ralph-loop <prompt>
  └─ 创建状态文件 .claude/ralph-loop.local.md
     frontmatter: active / iteration / max_iterations / completion_promise / started_at
     body: <原始 prompt>
  │
  └─ Claude 执行任务
     └─ Claude 尝试结束 → 触发 Stop hook
        └─ stop-hook.sh:
           ├─ 读 transcript_path 的最后一条 assistant 消息
           ├─ 用 perl -0777 提取 <promise>...</promise> 标签
           ├─ 与 completion_promise 字面比较
           ├─ 未达 → 输出 {decision:"block", reason:"<原始 prompt>", systemMessage:"🔄 Ralph iteration N"}
           │           ↑ 阻止 Stop，原始 prompt 作为新输入重新注入 → Claude 继续
           └─ 达成 / 达 max_iterations → 允许 Stop
```

`stop-hook.sh` 的实现细节：从 hook input 的 `transcript_path` 读 JSONL 对话历史，用 `jq` 提取最后一条 assistant 消息，用 `perl -0777` 提取 `<promise>` 标签与 `completion_promise` 字面比较。这展示了 hook 的 `decision: "block"` + `reason` 机制能实现循环执行——不只是"允许/拒绝"开关。

**"不撒谎"设计**（`setup-ralph-loop.sh` L179-203 + `ralph-loop.md` L18）：反复强调"ONLY output promise when TRUE — do not lie to exit"。模型可能为逃脱循环而输出虚假完成承诺，插件用 prompt 级约束防止（技术上无法验证 promise 真实性）。

### frontend-design skill 自动触发

`skills/frontend-design/SKILL.md` 的 `description` 让 skill 在前端任务时自动调用——运行时据 description 匹配当前任务。指导内容：bold 设计选择、排版、动画、视觉细节，避免三种通用 AI 默认美学——暖米色背景 + 衬线体 + 赤陶色、近黑背景 + 酸性绿/朱红单色、报刊式布局 + 细线分隔 + 零圆角（`SKILL.md` L31）。

### claude-opus-4-5-migration 迁移内容

迁移 skill 处理三类变更：（1）model strings（`sonnet-4.x`/`opus-4.1` → `opus-4.5` 的 API model id）；（2）beta headers（移除旧 beta header、加新的）；（3）prompt 调整（适配 Opus 4.5 的能力差异）。skill 自动扫描代码中的 model 引用并替换。

<details>
<summary>命令/hook 速查表</summary>

| 命令/hook | 插件 | 作用 |
|-----------|------|------|
| `/ralph-loop` | ralph-wiggum | 启动自循环，创建状态文件 |
| `/cancel-ralph` | ralph-wiggum | 终止循环，删状态文件 |
| Stop hook | ralph-wiggum | 拦截退出，检测 promise，重注入 prompt |
| SessionStart hook | explanatory | 注入教育洞察指令 |
| SessionStart hook | learning | 注入互动学习指令 |
| skill 自动触发 | frontend-design | 前端任务时加载设计指导 |
| skill 触发 | opus-4.5-migration | 迁移任务时加载替换规则 |

</details>

## 核心实现

### SessionStart hook 的 additionalContext 注入

`learning-output-style/hooks-handlers/session-start.sh` 输出 JSON：

```json title="SessionStart hook 输出（示意）"
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "When the user reaches a decision point, request they write 5-10 lines of meaningful code..."
  }
}
```

`additionalContext` 字段是 SessionStart hook 的专属输出——运行时将其追加到 Claude 的上下文。这与 PreToolUse 的 `permissionDecision: "deny"`、Stop 的 `decision: "block"` 是不同事件的不同输出契约（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 的 I/O 表）。

### ralph-wiggum 的状态文件与错误处理

状态文件 `.claude/ralph-loop.local.md` 用 frontmatter（`active`/`iteration`/`max_iterations`/`completion_promise`/`started_at`）+ body（原始 prompt）控制循环。`stop-hook.sh` L28-48 对状态文件做防御性校验：

```bash title="plugins/ralph-wiggum/hooks/stop-hook.sh"
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Ralph loop: State file corrupted" >&2
  rm "$RALPH_STATE_FILE"    # 删除损坏的状态文件
  exit 0                     # 允许停止（不阻止）
fi
```

所有错误路径都删除状态文件并 `exit 0`（允许 Claude 停止），避免损坏的状态文件永久阻止会话结束。这与 hookify 的 fail-safe 哲学一致，但与 security-guidance 的 fail-closed 相反。

### frontend-design 与 opus-migration 的设计理念共鸣

`frontend-design` SKILL.md 列举三种 AI 默认美学反例（暖米色+衬线+赤陶等，L31）；`opus-4.5-migration` 的 `references/prompt-snippets.md` L65-69 的 `<frontend_aesthetics>` snippet 则列举另一组反例（Inter/Roboto/Arial 字体、紫色渐变白底）。两者都旨在让前端产出避免模板化 AI 美学，前者作为 skill 自动激活，后者将设计指导内联为可注入的 prompt snippet——同一目标在两个扩展点的不同封装。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| SessionStart 上下文注入 | explanatory/learning hook | 会话开始自动生效，无需用户记忆 |
| Stop hook 循环 | ralph-wiggum `decision:"block"`+`reason` | 用 hook 机制实现 while-true，prompt 重注入 |
| 状态文件驱动 | ralph-wiggum `.local.md` frontmatter | 循环状态持久化，跨 hook 调用保持 |
| Skill 自动触发 | frontend-design description 匹配 | 无需用户调用，任务匹配自动加载 |
| Prompt 级约束 | ralph-wiggum "do not lie to exit" | 防模型为逃脱循环输出虚假承诺 |
| 防御性状态校验 | ralph-wiggum `stop-hook.sh` 数值校验 | 损坏状态文件不永久阻止会话 |

## 模块间交互

五个插件都通过 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 的扩展点契约影响 Claude：SessionStart hook（explanatory/learning）、Stop hook（ralph-wiggum）、skill 自动触发（frontend-design/opus-migration）。ralph-wiggum 的 Stop hook 循环是概览「状态流」SVG 的核心案例。explanatory/learning 的 hookify 风格规则文件（`.local.md`）与 [03-hookify](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/03-hookify) 的规则格式呼应——但 explanatory/learning 用 shell 脚本硬编码指令，hookify 用 dataclass 规则引擎通用化。

## 扩展方式

新增一种 output style：复制 `explanatory-output-style` 结构——建 `hooks/hooks.json`（SessionStart 事件）+ shell 脚本输出 `additionalContext`。轻量增强用 hook；若需深度角色切换（替换 system prompt 而非追加），改用 subagent（见 explanatory README L58-62 的边界提示）。

给 ralph-wiggum 加最大迭代次数：状态文件 frontmatter 已有 `max_iterations` 字段，`stop-hook.sh` 已校验 `iteration >= max_iterations` 即允许停止——无需改动，已是内置功能。
