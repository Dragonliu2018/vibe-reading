---
source:
  type: "源码解读"
  project: "claude-code"
  url: "https://github.com/anthropics/claude-code"
title: "代码质量插件组"
date: "2026-08-11T23:04:56+08:00"
category: [AI, Agent, "AI Coding", "Claude Code", CodeWiki, "2.1.199"]
tags: ["claude-code", "Plugin", "code-review", "security", "多 Agent"]
description: "三个代码质量插件——code-review 9 步多模型置信度过滤、pr-review-toolkit 6 专项 agent、security-guidance 3 层安全审查 + 25 模式"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/00-overview)

---

## 模块定位

本模块含三个围绕代码审查与安全的插件：`code-review`（多 Agent 置信度过滤的 PR 审查）、`pr-review-toolkit`（6 个专项审查 agent 的工具箱）、`security-guidance`（编辑文件时的 3 层安全告警）。三者共享"降低 false positive、只报高置信问题"的设计哲学，但扩展点与实现方式迥异——前两个是纯 Markdown prompt 编排（零代码），第三个是重代码 Python 框架（2,193 行主 hook 脚本 + 7 辅助模块）。

## 模块架构

| 插件 | 版本 | 扩展点 | 代码量 | 核心机制 |
|------|------|--------|--------|----------|
| code-review | 1.0.0 | 1 command | 377 行 | 纯 prompt 编排 9 步多模型流水线 |
| pr-review-toolkit | 1.0.0 | 1 command + 6 agents | 1,020 行 | 纯 prompt 编排，6 专项 agent 各有专长 |
| security-guidance | 2.0.0 | hooks.json（4 事件） | 6,866 行 | Python 脚本 + regex + LLM API + Agent SDK |

**关键观察**：code-review 和 pr-review-toolkit 是"零代码"插件——全部用 Markdown prompt 编排，依赖 Claude Code 的 Task 工具实现多 agent 调度。security-guidance 是"重代码"插件——完整的 Python 安全审查框架，是本仓继 hookify 后第二个含实质代码的插件。

## 调用链路

### code-review 9 步多模型流水线

![code-review 9 步流水线](/vibe-reading/images/articles/claude-code-codewiki/code-review-pipeline.svg)

文字描述：`/code-review [--comment]` 触发 9 步流水线。Step 1-2 用 haiku 做门控（检查 PR 是否需要审查、收集 CLAUDE.md 路径）——最便宜的模型过滤不需要审查的 PR。Step 3 用 sonnet 做 PR 摘要——理解代码但不需要深度推理。Step 4 启动 4 并行 review agent：2 个 sonnet 审 CLAUDE.md 合规（规则匹配），2 个 opus 扫 bug（深度推理，Agent 3 只看 diff、Agent 4 看引入代码的安全/逻辑）。Step 5 对 Step 4 中 agents 3-4（两个 opus bug agent）发现的每个 issue 启动独立验证 subagent（bug→opus 验证、合规→sonnet 验证）。Step 6 丢弃未验证的 issue。Step 7-9 决定输出与 inline comment。

**三重置信度过滤**：Step 4 只标 HIGH SIGNAL（编译错/确定性逻辑错/明确违规）→ Step 5 独立验证 → Step 6 丢弃未确认。`code-review.md` L51 直述设计理念——"False positives erode trust and waste reviewer time"。

False positive 清单（`code-review.md` L79-86）：pre-existing issues、看似 bug 实际正确的代码、资深工程师不会标记的吹毛求疵、linter 能捕获的、通用代码质量问题（除非 CLAUDE.md 要求）、代码中 lint ignore 显式静默的。

### pr-review-toolkit 6 agent 分工

`/pr-review-toolkit:review-pr [review-aspects]` 据位置参数 `[review-aspects]`（如 `tests errors`）与变更文件类型选择适用 agent：

| Agent | 维度 | model | 评分体系 | 触发条件 |
|-------|------|-------|----------|----------|
| comment-analyzer | 注释准确性 | inherit | Critical/Improvement/Removals | 有注释/文档变更 |
| pr-test-analyzer | 测试覆盖 | inherit | 1-10（9-10=数据丢失/安全） | 有测试文件变更 |
| silent-failure-hunter | 错误处理 | inherit | CRITICAL/HIGH/MEDIUM | 有 error handling 变更 |
| type-design-analyzer | 类型设计 | inherit | 4 维各 1-10 | 有新类型引入 |
| code-reviewer | 通用审查 | **opus** | 0-100（仅报 ≥80） | 始终适用 |
| code-simplifier | 代码简化 | **opus** | 无评分，直接简化 | 通过审查后 |

`review-pr.md` Step 3 用 `git diff --name-only` 识别变更文件，Step 4 据文件类型确定适用 agent；Step 5 支持 sequential（默认，交互友好）或 parallel（用户指定 `all parallel`）编排；Step 6 聚合为 Critical/Important/Suggestions/Positive 四级；Step 7 输出 Action Plan。

### security-guidance 3 层架构

security-guidance 实际是**三层**安全审查（`README.md` L1-7），不是简单 PreToolUse hook：

| 层 | 触发时机 | 机制 | 代码位置 |
|----|----------|------|----------|
| Layer 1: Pattern warnings | PostToolUse（Edit/Write/MultiEdit/NotebookEdit） | 纯 regex 检查 25 种模式 | `patterns.py` SECURITY_PATTERNS |
| Layer 2: LLM diff review | Stop hook | git diff + LLM 调用（Opus 4.7） | `security_reminder_hook.py` `handle_stop_hook()` |
| Layer 3: Agentic commit review | PostToolUse（Bash: git commit/push） | Agent SDK 驱动跨文件追踪数据流 | `handle_commit_review_posttooluse()` |

hooks.json 事件注册：

```json title="plugins/security-guidance/hooks/hooks.json（节选）"
SessionStart:     ensure_agent_sdk.py（安装 claude_agent_sdk）
UserPromptSubmit: security_reminder_hook.py（捕获 git baseline SHA）
PostToolUse:
  - matcher: Edit|Write|MultiEdit|NotebookEdit → pattern warnings
  - matcher: Bash, if: Bash(git commit:*) → commit review（asyncRewake）
  - matcher: Bash, if: Bash(git push:*) → push sweep（asyncRewake）
Stop:             security_reminder_hook.py（LLM diff review，asyncRewake）
```

<details>
<summary>方法/事件速查表</summary>

| 事件 | 处理函数 | 模式 | 阻止方式 |
|------|----------|------|----------|
| SessionStart | `ensure_agent_sdk.py` | 同步 | 不阻止（装依赖） |
| UserPromptSubmit | `handle_user_prompt_submit` | 同步 | 捕获 baseline SHA |
| PostToolUse（Edit 等） | `check_patterns` | 同步 | `additionalContext` 注入警告（不阻止） |
| PostToolUse（git commit） | `handle_commit_review_posttooluse` | asyncRewake | exit 2 + rewakeMessage |
| Stop | `handle_stop_hook` | asyncRewake | exit 2 + stderr |

</details>

## 核心实现

### code-review 的多模型分级

haiku→sonnet→opus 的分级匹配任务难度与模型成本：

- **haiku 门控（Step 1-2）**：判断"是否需要审查""收集 CLAUDE.md 路径"——是否决策与文件列举，用最便宜模型快速过滤
- **sonnet 摘要 + 合规（Step 3, Agent 1-2）**：PR 摘要需理解代码但不需深度推理；CLAUDE.md 合规是规则匹配而非逻辑推理，sonnet 足够且经济
- **opus 找 bug（Agent 3-4）**：bug 检测需深度推理，opus 是最强推理模型；两 agent 互补（Agent 3 只看 diff 不读上下文、Agent 4 看引入代码的安全/逻辑）
- **并行验证（Step 5）**：bug→opus 验证（需推理确认）、合规→sonnet 验证（规则匹配确认），这层是降 false positive 的关键

### pr-review-toolkit 的专项拆分

6 个 agent 各有独立评分体系（comment-analyzer 用 Critical/Improvement/Removals，type-design-analyzer 用 4 维 1-10，code-reviewer 用 0-100）。`code-reviewer` 和 `code-simplifier` 用 `model: opus`（需深度推理与代码生成），其余 4 个用 `model: inherit`（继承调用者模型，成本更低）。

**为什么拆 6 个而非一个通用 reviewer**：（1）深度优于广度——`silent-failure-hunter` 有 5 个审查阶段，这种深度不可能在通用 reviewer 实现；（2）选择性触发——无类型变更时不跑 `type-design-analyzer`，避免无关噪音；（3）独立评分——不同维度需不同评分体系；（4）模型选择——按维度选模型，通用 reviewer 无法按维度切换；（5）可组合——用户按需 `--aspects tests errors` 或 `all parallel`。

### security-guidance 的 25 种安全模式

`patterns.py` 的 `SECURITY_PATTERNS` 列表（L30-261）按类别分组：

| 类别 | 模式数 | 典型规则 |
|------|--------|----------|
| 命令注入 | 7 | `eval()`、`os.system()`、`subprocess shell=True`、`new Function()`、Go `exec.Command("sh","-c",...)`、GitHub Actions `${{ }}` 注入、`child_process.exec` |
| XSS | 6 | `dangerouslySetInnerHTML`、`document.write`、`innerHTML=`、`outerHTML=`、`insertAdjacentHTML`、`<script src>` 无 SRI |
| 不安全反序列化 | 6 | `pickle.load`、`cPickle/cloudpickle/dill`、`joblib.load`、`marshal.loads`、`shelve.open`、`torch.load` 无 `weights_only` |
| 加密/TLS | 3 | `createCipher` 无 IV、`AES.MODE_ECB`、`verify=False`/`InsecureSkipVerify` |
| 其他 | 3 | `yaml.load` 无 Safe、`yaml.unsafe_load`、Python stdlib XML（XXE） |

每条规则结构：`{ruleName, path_filter?, regex/substrings, reminder}`。`eval_injection` 规则用负向 lookbehind `(?<![a-zA-Z0-9_\.])eval\(` 排除 PyTorch `model.eval()` 等方法调用——这是误报治理的细节。

Layer 1（pattern）用 `additionalContext` 注入警告（**不阻止**），每文件每规则仅告警一次（`atomic_check_and_mark_warning`）。Layer 2（Stop LLM）发现漏洞 `sys.exit(2)` 强制 Claude 修复，最多迭代 3 次（`MAX_STOP_HOOK_FIRINGS=3`）。Layer 3（commit agentic）用 `asyncRewake: true` 后台执行，与 single-shot LLM review 竞速（`_agentic_review_with_race`，agentic 先启，180 秒后 fallback 也启，先完成者胜）。

### Extensibility 信任模型

`extensibility.py` L22-33：用户自定义规则通过 `security-patterns.{yaml,json}` 加载，前缀 `user:`，与内置规则合并。框架明确声明"may ADD checks but must NOT suppress findings"——防止恶意 PR 通过修改 `.md` 文件抑制安全发现。用户自定义 regex 会检查 ReDoS（catastrophic backtracking）。内置规则不可单独禁用，只能 `ENABLE_PATTERN_RULES=0` 全关。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 多模型分级编排 | `code-review.md` 9 步 | 按任务难度匹配模型成本 |
| 三重置信度过滤 | code-review Step 4-6 | HIGH SIGNAL + 独立验证 + 丢弃未确认，降 false positive |
| 专项 agent 拆分 | pr-review-toolkit 6 agent | 深度优于广度 + 选择性触发 + 独立评分 |
| 三层递进审查 | security-guidance pattern/LLM/agentic | 不同时机不同深度，pattern 零成本→LLM 复杂漏洞→agentic 跨文件 |
| asyncRewake 竞速 | `security_reminder_hook.py` `_agentic_review_with_race` | agentic 与 fallback 竞速，保障可用性 |
| 递归保护 | `stop_hook_active` + `MAX_STOP_HOOK_FIRINGS=3` | 防 Stop hook 无限循环 |
| 信任模型 | `extensibility.py` "may ADD not suppress" | 防恶意 PR 抑制安全发现 |

## 模块间交互

三个插件都依赖 Claude Code 的 Task 工具调度子 agent（code-review 9 步内 spawn 多个 haiku/sonnet/opus agent，pr-review-toolkit spawn 6 专项 agent）。security-guidance 的 Layer 3 用 Claude Agent SDK 驱动 agent 跨文件追踪数据流。三者与 [01-plugin-architecture](/vibe-reading/articles/AI/Agent/AI%20Coding/Claude%20Code/CodeWiki/2.1.199/01-plugin-architecture) 的 hook I/O 契约一致——security-guidance 的 exit 2 是"强制继续"语义的实例。

> 补充：`code-review/README.md` 描述的评分体系是"0-100 置信度阈值 80"，但 `code-review.md` 实际用的是"验证/未验证"二元判断（Step 5-6）。以 command 文件为准——README 可能为早期设计或简化描述。待核实。
