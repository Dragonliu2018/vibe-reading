---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "开发流程插件组"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "feature-dev", "git", "Agent SDK"]
description: "三个开发流程插件——feature-dev 7 阶段工作流、commit-commands git 自动化、agent-sdk-dev 项目脚手架与校验"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

本模块含三个辅助开发流程的插件：`feature-dev`（7 阶段特性开发引导）、`commit-commands`（git commit/push/PR 自动化）、`agent-sdk-dev`（Claude Agent SDK 项目脚手架）。三者都偏"流程编排"——用 command + agent 的组合把开发工作流固化成可复用步骤，但复杂度梯度明显：feature-dev 重流程编排与 agent 协同，commit-commands 极简轻量，agent-sdk-dev 重交互式问答与自动校验闭环。

## 模块架构

| 插件 | 作者 | 扩展点 | 代码量 | 设计重心 |
|------|------|--------|--------|----------|
| feature-dev | Sid Bidasaria | 1 command + 3 agents | 678 行 | 重流程编排，agent 协同 |
| commit-commands | Anthropic | 3 commands | 325 行 | 轻量 allowed-tools 声明 |
| agent-sdk-dev | Ashwin Bhat | 1 command + 2 agents | 678 行 | 重交互问答 + 校验闭环 |

三个 `plugin.json` 结构完全一致——只有 `name`/`version`/`description`/`author` 四字段（见 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture)）。所有差异化体现在 commands/agents 的 frontmatter + 正文。

## 调用链路

### feature-dev 7 阶段工作流

```
/feature-dev [feature description]
  │
  ├─ Phase 1: Discovery              理解需求（无 agent，主 Claude 交互，确认理解）
  ├─ Phase 2: Codebase Exploration   【并行点①】2-3 个 code-explorer，各盯不同方面
  │                                    每个 agent 返回 5-10 个 key files → 主 Claude 亲自读
  ├─ Phase 3: Clarifying Questions   【CRITICAL: DO NOT SKIP】消除歧义，等用户回答
  ├─ Phase 4: Architecture Design    【并行点②】2-3 个 code-architect，各取不同策略
  │                                    minimal changes / clean architecture / pragmatic
  ├─ Phase 5: Implementation         【DO NOT START WITHOUT USER APPROVAL】主 Claude 实现
  ├─ Phase 6: Quality Review         【并行点③】3 个 code-reviewer，各审不同维度
  │                                    simplicity/DRY · bugs/correctness · conventions
  └─ Phase 7: Summary                记录成果，标记 todos complete
```

三个并行点：Phase 2（code-explorer ×2-3）、Phase 4（code-architect ×2-3）、Phase 6（code-reviewer ×3），都是"同角色、不同 focus"模式。五个用户交互点：Phase 1 确认理解、Phase 3 等待澄清、Phase 4 选择架构方案、Phase 5 等待实现批准、Phase 6 决定修复策略。Phase 3 和 Phase 5 有强约束（CRITICAL / DO NOT START WITHOUT USER APPROVAL）。

### commit-commands 三命令

| 命令 | allowed-tools | 用途 |
|------|---------------|------|
| `/commit` | `Bash(git add:*)`, `Bash(git status:*)`, `Bash(git commit:*)` | 单次提交，不能 push |
| `/commit-push-pr` | + `Bash(git checkout --branch:*)`, `Bash(git push:*)`, `Bash(gh pr create:*)` | 分支→提交→推送→PR 一条龙 |
| `/clean_gone` | 无 `allowed-tools`（不限） | 清理 `[gone]` 分支 + worktree |

`/commit` 与 `/commit-push-pr` 的 `allowed-tools` 差异体现最小权限——后者多了 branch/push/PR 工具。两个命令都用 Context 块自动注入 `git status`/`git diff HEAD`/`git branch` 动态信息，要求"single message"完成全部步骤。`/clean_gone` 无 `allowed-tools` 声明（需多种 git 命令组合），3 步显式 bash 脚本识别 `[gone]` 标记，带 `+` 前缀的分支先 `git worktree remove --force` 再删。

### agent-sdk-dev 脚手架流程

`/new-sdk-app` 5 步：

```
/new-sdk-app [project-name]
  ├─ Step 0: WebFetch 读官方文档（overview → 按语言选 SDK reference）
  ├─ Step 1: 交互式问答【ONE AT A TIME】Q1 语言 / Q2 项目名 / Q3 agent 类型 / Q4 起点 / Q5 工具链
  ├─ Step 2: Setup Plan（项目初始化 + WebSearch 查最新版本 + SDK 安装 + starter files + .env）
  ├─ Step 3: Implementation【VERIFY THE CODE WORKS BEFORE FINISHING】
  │           TS: npx tsc --noEmit 修完所有 type errors
  │           Py: 验证 imports + 语法
  └─ Step 4: Verification → 启动 agent-sdk-verifier-ts 或 -py，Review report → 修复
```

<details>
<summary>命令/agent 速查表</summary>

| 命令/agent | 模型 | 职责 | 关键约束 |
|-----------|------|------|----------|
| `/feature-dev` | inherit | 7 阶段编排 | Phase 3/5 强约束 |
| code-explorer | sonnet | 代码库探索，返回 key files | 并行 2-3 个 |
| code-architect | sonnet | 架构方案设计 | 并行 2-3 个不同策略 |
| code-reviewer | sonnet | 质量审查 | 并行 3 个，confidence ≥80 |
| `/commit` | inherit | 单次提交 | 不能 push |
| `/commit-push-pr` | inherit | 提交推送 PR | single message |
| `/new-sdk-app` | inherit | SDK 项目脚手架 | 逐个提问 |
| agent-sdk-verifier-py | sonnet | Python SDK 校验（8 项） | PASS / PASS WITH WARNINGS / FAIL |
| agent-sdk-verifier-ts | sonnet | TS SDK 校验（9 项） | 含 tsc --noEmit |

</details>

## 核心实现

### feature-dev "先理解再行动"原则

`feature-dev.md` L14, L52-53：

> When launching agents, ask them to return lists of the most important files to read. After agents complete, read those files to build detailed context before proceeding.

**为什么不让 agent 直接返回分析结论**：agent（sonnet）返回的是摘要 + 文件列表，但摘要是**有损压缩**。主 Claude（通常更强模型）需亲自读原始文件建立第一手完整上下文，才能在 Phase 3（澄清问题）和 Phase 4（架构设计）做出准确判断。这形成"agent 做广度探索 → 主 Claude 做深度理解"分工。若主 Claude 只读 agent 摘要就继续，容易在澄清阶段遗漏 edge case、在架构阶段做出不符现有模式的决策。

### code-explorer 并行分治

`feature-dev.md` L41-50：启动 2-3 个 code-explorer，每个盯不同方面（similar features / high level architecture / UI patterns & testing & extension points），每个返回 5-10 个 key files。

**为什么并行多 agent 而非一个全面 agent**：单 agent 试图一次理解所有方面易陷入"广而浅"。分别派去追踪不同方面，每个能在自己聚焦维度做到深度追踪。并行不增等待时间，返回后主 Claude 合并多维度视角。经典分治-合并策略。

### code-reviewer 置信度过滤

`feature-dev/agents/code-reviewer.md` L23-33：confidence 0-100，**仅报 ≥80** 的问题。Phase 6 并行启动 3 个，若每个都报大量低置信问题，主 Claude 合并时会被噪音淹没。`≥80` 阈值确保只报"double-checked and verified"的高置信问题，让 Phase 6 的用户交互（fix now / fix later / proceed as-is）有意义。system prompt 明确"quality over quantity""minimize false positives"——与 [04-code-quality-plugins](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/04-code-quality-plugins) 的 code-review 共享同一哲学。

### agent-sdk-dev 的 py/ts 双 verifier

两个 verifier 共享报告格式（Overall Status: PASS / PASS WITH WARNINGS / FAIL + Critical Issues + Warnings + Passed Checks + Recommendations）和共同校验项（SDK 安装/版本、环境安全、SDK usage patterns、文档），但特有项不同：

| 维度 | verifier-py（8 项） | verifier-ts（9 项） |
|------|---------------------|---------------------|
| 特有 | requirements.txt/pyproject.toml、虚拟环境推荐 | tsconfig.json 配置、`npx tsc --noEmit` 实际编译、package.json scripts、ES modules `type:"module"` |
| 明确不查 | PEP 8、命名、import 排序 | `type` vs `interface`、格式化、命名 |

**为什么分开**：Python 和 TS 的 SDK 校验差异显著——TS 需编译检查、ES modules 验证，Python 需虚拟环境、版本约束。合并为一个 agent 会让 system prompt 含大量不相关项，降低准确率。分开后每个 verifier 的 8-9 项全部针对自己语言，prompt 更聚焦。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 分治-合并 | feature-dev Phase 2/4/6 并行 agent | 聚焦维度做深度，主 Claude 合并多视角 |
| 广度探索→深度理解 | feature-dev agent 返回文件列表，主 Claude 亲读 | 避免有损摘要导致误判 |
| 最小权限声明 | commit-commands `allowed-tools` 差异 | 每命令只声明实际需要的工具 |
| 强约束交互点 | feature-dev Phase 3/5 CRITICAL 标注 | 防止跳过关键确认 |
| 置信度阈值 | code-reviewer ≥80 | 降 false positive，让用户交互有意义 |
| 语言专项拆分 | agent-sdk-dev py/ts verifier | 聚焦各自语言特有校验项 |
| 校验闭环 | `/new-sdk-app` Step 3-4 VERIFY + verifier agent | 代码必须通过验证才算完成 |

## 模块间交互

feature-dev 的 3 个 agent（code-explorer/code-architect/code-reviewer）通过 Task 工具被主 Claude spawn，返回文件列表或审查结果。commit-commands 纯靠 `allowed-tools` 约束 + Context 注入，无 agent。agent-sdk-dev 的 verifier agent 读官方文档（WebFetch）对照校验。三者都依赖 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 的 command frontmatter 契约。

## 扩展方式

给 feature-dev 加 Testing 阶段（Phase 6 与 7 之间）：改 `feature-dev.md` 插入新阶段（可复用 code-reviewer 或新建 test-reviewer agent）+ `README.md` 更新阶段数 + Phase 1 的 todo 模板。

给 commit-commands 加 conventional commits 模板：改 `commit.md`/`commit-push-pr.md` 加 `type(scope): description` 约束。

> 补充发现：`commit-commands/README.md` L43-45 声称 `/commit` "Follows conventional commit practices"、"Avoids committing files with secrets"、"Includes Claude Code attribution"，但实际 `commit.md`（17 行）中**没有**这些显式指令——依赖 Claude 默认行为而非命令约束。这是文档与实现的 gap，修改时宜让实现对齐 README 承诺。
