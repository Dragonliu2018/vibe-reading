---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Agent Provider 适配"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "CLI Agent", "适配器"]
description: "37 个 CLI agent 的声明式接入：TuiAgent 注册表、六种 prompt 注入策略、从 PTY 字节流识别 readiness 的 scanner，以及 foreground process 多策略检测。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

Orca 的适配哲学：**agent 差异必须收敛成数据，而不是散落成分支**。"25+ agent 各自成目录"是表象——真正的 agent 定义在 `src/shared/tui-agent-config.ts` 一张统一的声明式注册表里，`src/main/<agent>/` 目录只承载超出通用 TUI 宿主能力的深度集成。判断依据是 agent 暴露的能力面而非数量：`grok/`（15 个文件全是 hook 配置管理）、`kimi/`、`mimo/`（2 个文件）仅有 hook 集成；`codex/`、`claude/` 各有上百文件，因为它们走结构化协议（app-server JSON-RPC / agent-sdk stream-json）而非终端画面。

## 模块架构

![agent 适配链路](/vibe-reading/images/articles/orca-internals/agent-adaptation.svg)

四个层次：**注册表**（声明式配置，main 与 renderer 共读）→ **计划构建**（把 prompt 折进启动命令）→ **spawn**（providers 层的 PTY 生命周期）→ **检测**（readiness scanner + foreground process 多策略）。

## 调用链路

从选 agent 到 PTY 就绪：

```text
检测安装：detectInstalledAgents 用纯 fs 扫 PATH（零 which/where 子进程）
  命令列表来自 getTuiAgentDetectCommands()（含 aliases）

构造计划（renderer 侧）：buildAgentStartupPlan()（src/shared/tui-agent-startup.ts）
  按 promptInjectionMode 分支：
    argv                → ${baseCommand} -- ${quotedPrompt}     （claude、grok）
    flag-prompt         → ... --prompt ${quotedPrompt}         （opencode、mimo）
    flag-prompt-interactive → --prompt-interactive             （gemini、antigravity）
    flag-interactive    → -i                                    （copilot，裸 --prompt 跑完就退出）
    hermes-query        → planHermesStartupQuery()             （Hermes 自己管 ready 和提交）
    stdin-after-start   → 命令不含 prompt，prompt 留 followupPrompt 等就绪后粘贴
  → AgentStartupPlan { launchCommand, expectedProcess, followupPrompt, launchConfig, env, draftPrompt }

spawn 计划（main，providers 层）：createLocalPtyLaunchPlan()
  ├─ recognizeAgentProcessFromCommandLine()（agent-process-recognition.ts，
  │   处理 .exe 后缀、node/python 解释器脚本包装）
  ├─ assertSafeAgentStartupCwd() 拒绝在 root 类目录启动
  └─ POSIX: $SHELL -l；Windows: PowerShell 探测 + spawn 回退链 + WSL 上下文

env 构造：CODEX_HOME 的 Windows→WSL 路径翻译；
  ORCA_CODEX_HOME 在 profile 脚本跑完后重新 export（防 shell rcfile 冲掉托管 home）

readiness + 注入（stdin-after-start / draft 路径）：
  createDraftPasteReadyScanner(signal).observe(data) 增量扫描 PTY 输出
  → ready 后 bracketed paste 投递 followupPrompt（帧必须单次 PTY write）
```

方法速查表：

<details>
<summary>provider 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `resolveTuiAgentConfig()` | 默认值折叠 | `launchCmd`/`expectedProcess` 缺省回落 `detectCmd`，多数 agent 只需 3 行配置 |
| `buildAgentStartupPlan()` | 拼启动命令 | 六种注入模式的唯一分发点 |
| `recognizeAgentProcessFromCommandLine()` | 进程识别 | kimi 实际进程叫 `kimi-code`，不加 alias 识别就失败 |
| `resolveAgentForegroundProcessFromPs()` | 前台检测 | ps 快照建索引，进程树 + `stat` 含 `+` |
| `confirmShellForegroundProcess()` | Windows job 检查 | 失败只返回 false 不抛错——"missing proof ≠ 否定" |

</details>

## 核心实现

### 注册表：编译器强制穷尽

```ts title="src/shared/tui-agent.ts"
export type TuiAgent = 'claude' | 'claude-agent-teams' | ... | 'prime-agent'  // 37 个成员
```

`TUI_AGENT_CONFIG_SOURCE: Record<TuiAgent, TuiAgentConfigSource>` 意味着**加一个 union 成员而不加配置，TypeScript 直接报错**。每条配置的关键字段：

```ts title="src/shared/tui-agent-config.ts"
export type TuiAgentConfig = {
  detectCmd: string                       // PATH 上的二进制名，如 'kimi'
  detectCmdAliases?: readonly string[]     // kimi 实际运行为 kimi-code
  launchCmd: string                        // 可覆写如 'kiro-cli chat --tui'
  promptInjectionMode: AgentPromptInjectionMode  // 六种注入模式
  argvPromptSeparator?: '--'              // 防 prompt 被解析为子命令/flag
  draftPromptFlag?: string                // 原生 prefill（claude 的 --prefill）
  draftPromptEnvVar?: string              // 无 flag 时用 env（pi 的 ORCA_PI_PREFILL）
  preflightTrust?: 'cursor' | 'copilot' | 'codex'   // 预写 trust artifact
  draftPasteReadySignal?: DraftPasteReadySignal
  windowsShiftEnterEncoding?: 'csi-u'     // Windows 换行编码差异
}
```

每条配置都带 `// Why:` 注释说明为什么这样配——如 continue 用 `cn` 因为 `continue` 是 shell builtin；trae 用 `traecli` 检测以避开 bytedance/trae-agent 的 `trae-cli` 二进制。`src/shared/agent-kind.ts` 的 telemetry 映射用 `satisfies Record<TuiAgent, ConcreteAgentKind>`——加 agent 漏改映射同样是编译错误，运行时对脏 IPC 值回落 `'other'` 而非丢事件。

### readiness 为什么从 PTY 字节流识别

第三方 TUI 是黑盒，没有 API 告知"composer 挂载完成"。`draft-paste-ready-scanner.ts` 顶部注释系统性地记录了每个坑：

- agent 先开 DECSET 2004（bracketed paste）、后挂 composer，opencode 中间静默 ~1.5-2s——静默窗口会在 composer 存在之前触发，所以 opencode 的信号**故意不挂 quiet fallback**；
- grok 启动时 shimmer logo 导致输出永不静默，必须用 `❯` glyph marker；但 `❯` 也是 starship/pure 的默认 shell prompt，所以 anchor 在 alt-screen 切换（`\x1b[?1049h`）上，且 `\x1b[?1049l` 撤销 anchor（否则 grok 退出后会把草稿粘进 shell）；
- 转义序列跨 chunk 分裂 → 512 字节 ring buffer + `ANCHOR_CARRY_CHARS = 7`；
- Windows 传统 console 渲染 `> ` 而非 `❯` → 回落 quiet window。

trust 菜单会吞掉 bracketed paste 的按键 → `agent-trust-presets.ts` 预写与用户手动接受后完全相同的 trust artifact（注释明确：这是唯一有文档支持的绕过，`--trust` flag 只在 headless 模式生效）。

### foreground process 多策略检测

`providers/agent-foreground-process.ts` 是"哪个进程代表这个 agent"的裁决器。POSIX 用 `ps` 快照（`getProcessTableSnapshot`）建索引、`collectDescendantsFromIndex()` 取 PTY shell 的整棵进程树、靠 `stat` 含 `+` 判定前台、`resolveOuterWrapperForegroundProcess()` 返回外层 wrapper（shell→omp→pi 树返回 omp 而非 pi）。Windows 委托 `windows-agent-foreground-process.ts`，用 PTY Job Object 的 PID 集合做 liveness anchor。`available` 三态语义很讲究：扫描失败（missing proof）绝不覆盖 caller 已识别的 agent——"a failed scan cannot prove fallback ownership"；`forceProcessScan` 下扫不到曾识别的名字 = agent 已退出的权威证据。远端场景用 `agent-foreground-process-remote-evidence.ts` 的旁证。

### 深度集成目录：两种协议栈

`codex/` 走 app-server JSON-RPC（`codex-app-server-client.ts`、`codex-structured-journal-translation.ts`），`claude/` 走 agent-sdk stream-json（`claude-stream-json-connection.ts`）——这些 agent 的 readiness/blocked prompt 来自**协议事件**而非终端画面。Orca 还向 Claude Code 等 agent 安装 managed hooks/statusline（`src/main/claude/hook-script.ts`、`statusline-script.ts`），hook 进程带 `ORCA_PANE_KEY` env POST 回 loopback server——这是 agent 状态的权威上报通道，详见[会话数据层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/07-session-data)。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 声明式注册表 + 策略枚举 | `tui-agent-config.ts` | 通用行为做成封闭枚举，agent 只声明选哪个；新增"模式"才需要写代码 |
| `satisfies` 编译期穷尽 | `agent-kind.ts` | 漏映射 = 编译错误 |
| 多策略检测 + 三态语义 | `agent-foreground-process.ts` | "missing proof ≠ 否定"贯穿始终 |
| 反向通道（hooks） | 各 `<agent>/hook-service.ts` | agent 主动上报，优于被动屏幕识别 |

## 模块间交互

`src/shared/tui-agent-config.ts` 是唯一真源，main 与 renderer 共读（launch 计划在 renderer 侧就算好完整命令串再发给 main）。`providers/` 拥有 PTY 生命周期（spawn/env/foreground/termination），spawn 落到 [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon)；`runtime/` 是会话编排层（`orca-runtime-create-agent-session.ts`、`runtime-agent-launch-resolution.ts` 的 `resolveBareAgentLaunchCommand` 支持用户 `agentCmdOverrides`）；`agent-hooks/` + 各 `<agent>/hook-service.ts` 是反向通道。

## 扩展方式

**新增一个 CLI agent**（最重要场景）——编译器强制必改四处：

1. `src/shared/tui-agent.ts`：`TuiAgent` union 加成员；
2. `src/shared/tui-agent-config.ts`：`TUI_AGENT_CONFIG_SOURCE` 加配置（漏加编译失败）；
3. `src/shared/tui-agent-display-names.ts`：加显示名；
4. `src/shared/agent-kind.ts`：加 telemetry 映射 + `telemetry-events.ts` 的 `AgentKind` enum。

按需：二进制名与 `detectCmd` 不一致时在 `agent-process-recognition.ts` 加 entrypoint identity；有首启 trust 菜单加 `agent-trust-presets.ts`；quiet window 不够时在 `draft-paste-ready-scanner.ts` 加新的 `DraftPasteReadySignal` spec；要做 hook 集成则新建 `src/main/<agent>/hook-service.ts`（mimo 就是只有这个的最小目录）。**无需碰 `providers/`、`runtime/`**——通用 PTY/启动/检测链路对所有 agent 复用。
