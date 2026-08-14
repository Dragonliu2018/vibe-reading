---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "交互与护栏"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Approval", "Guard", "Plan", "Interaction"]
description: "dsh 横切于 agent/tools 事件的交互护栏——approval/permission/commands、loop hygiene、plan 状态、context 注入与 hook bridge。"
readingTime: "15 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

`packages/interaction`、`guard`、`plan`、`todo`、`context`、`compaction`、`goal`、`hooks`、`settings`、`credentials` 这组包是横切关注点——它们不属任何一级层，而是挂在 `agent/*` 与 `tools/*` 事件上的监听器，拦截驱动而不侵入 loop。这层独立是因为它把"人机协作策略"与"循环卫生"从 agent loop 抽离：不同部署有不同 answerer（交互 UI、ACP 自动化、headless fail-closed），换策略不改 loop。

## 模块架构

```
interaction (人类协作面)
  ├─ user-approval (ctx.approval): ApprovalService, request() → ApprovalOutcome, 'approval/request' waterfall
  ├─ user-questions (ctx.userQuestions): ask() → AskUserQuestionAnswer
  ├─ permission-presets (ctx.permissionPresets): PresetSpec{sandbox+approval}, 'permission/preset' log-only
  ├─ commands (ctx.commands): register/list/find/execute, 无 turn 包裹
  └─ tool-ask-user (Consumer): ask_user_question tool
guard (循环卫生)
  ├─ timeout-policy: tools/execute around-dispatch, deadline(exec.signal, timeoutMs)
  └─ repeat-tool-reminder: tools/post-execute + agent/pre-step reset, WeakMap<Agent,Chain>
plan / todo / context / compaction / goal (logged state + 注入)
  ├─ plan-mode (ctx.planMode): 'plan/mode' log-only, foldPlanMode() 纯 fold
  ├─ context/agent-instructions: agent/pre-step batch fold 注入 workspace 指令
  └─ compaction/compaction-basic
hooks (Claude Code/Codex bridge) + settings/credentials
```

## 调用链路

### 需 approval 的 tool

```
tools pipeline 对 'ask' 决策 → ctx.approval.request(req)  (user-approval/src/index.ts:127)
  ├─ hasOpenTurn() 校验（turn 是 commit/replay 边界）
  ├─ append('approval/asked')
  └─ decide() (:304):
     ├─ signal aborted → cancelled
     ├─ effectivePolicy()==='never' → rejected  (dispatch 前, :312)
     └─ ctx.waterfall('approval/request', req, () => 'unavailable')  # answerer 返回词表
        └─ append('approval/decided')
model 只见最终 tool result；approval/asked+decided 是 log-only
```

### guard deadline 拦截

```
timeout-policy/apply() (:55) 注册 ctx.on('tools/execute', async (exec, next) => ...)
  ├─ ctx.tools.get(exec.name)?.timeoutMs  # 声明性 metadata
  ├─ 未声明 → next() 透传
  └─ 声明 → using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
        ├─ swap exec.signal=d.signal 给下游 dispatch
        ├─ finally 还原 upstream signal（保持 post-execute 见 caller signal）
        └─ dispatch 后若 timer 触发 → toolTimeoutResult(timeoutMs) 替换
cooperative：仅 notify exec.signal，不 hard kill
```

### plan 作为 logged state 进出

```
/plan [message] → commands.register (:269) → set(agent, true)
  ├─ 无 open turn → session.append('plan/mode', {active}) + agent.inject(narration) (:440-443) → committed
  └─ 有 open turn → pendingIntents WeakMap (:431) → queued，等下个 agent/pre-step (:205) → onBoundary() → append
exit_plan_mode execute (:321) → foldPlanMode() 校验 + ctx.userQuestions.ask() 评审 → approved → pendingIntents.set({active:false})
resume/fork/compaction 直接 foldPlanMode(events) 恢复
```

## 核心实现

### Approval seam

`ApprovalService extends Service`（`user-approval/src/index.ts`），`ctx.approval`。`request(req: ApprovalRequest): Promise<ApprovalOutcome>`，Outcome 闭集 `'allowed-once'|'rejected'|'cancelled'|'unavailable'`（`types.ts`）。Policy 是 `'ask'|'never'`。`decide()` waterfall 默认 `() => 'unavailable'`（`:320`），service 自身从不 prompt human（README "No built-in answerer"）。'never' 在 dispatch 前短路（`:312`），保证 listener 注册序无法破坏确定性。事件 `approval/asked`/`decided`/`policy` 均为 log-only，`effectiveApprovalPolicy(events)` 是纯 fold，resume 无需补状态。

### Permission presets

`PermissionPresetService`，`PresetSpec` 仅 bundle `sandbox: SandboxMode` + `approval: ApprovalPolicy`。默认 `workspace-write`（workspace-write+ask）、`danger-full-access`（danger-full-access+never）。`effectivePermissionPreset(events)` 纯 fold，`custom` 是 derived-only 无法持久化。

### Commands（无 model turn）

`CommandRuntime extends TypertRemoteService`（`commands/src/index.ts`），`register/list/find/execute`。`parseCommand()` 识别 `/name args`。`execute` 返回 `CommandExecution` 或 `undefined`；事件 `command/run`（handler 前 mint `commandId`）+ `command/done`（结算）直接 append，**无 turn 包裹**。人类命令是 UI-plane action，result 在 UI 渲染、不进 model history。需 model-visible 工作时由 producer 显式 `agent.steer()`。

### Guard

- **timeout-policy**（`guard/timeout-policy/src/index.ts:56`）：function/namespace plugin，零 config。注册单个 `tools/execute` around-dispatch listener，读 `ctx.tools.get(exec.name)?.timeoutMs`（声明性 metadata，registry 不 enforce），用 `@deepseek-ai/dsh-timeout` 的 `deadline()` 武装 `exec.signal`，超时替换为结构化 `TOOL_TIMEOUT` result。
- **repeat-tool-reminder**（`guard/repeat-tool-reminder/src/index.ts:213`）：advisory，不在 tool list。注册 `tools/post-execute` observe-enrich listener + `agent/pre-step` reset hook。`WeakMap<Agent,Chain>` 按 agent 计连续同参调用，达 `thresholds`（默认 `[3,5,8]`）注入 reminder 到 `PostToolDecision.additionalContexts`。

### Plan mode（logged state）

`PlanModeController extends Service`（`plan-mode/src/index.ts`），`static inject=['tools','systemPrompt']`。`plan/mode` 是 `{active:boolean}` log-only SessionEventMap 成员。`foldPlanMode(events)` 纯 fold（last-wins，无则 false）。`set(agent, active)` 返回 `'committed'|'queued'|'cancelled'|'noop'`；`get(agent)` 返回 `{active, pending?}`。`exit_plan_mode` tool 常驻注册。"Delete only after append succeeds" 保证 failed durable write 可重试。

### Context 注入（agent-instructions）

`packages/context/agent-instructions`（6618 行）经 **pre-step batch fold** 注入 model-visible context：`agent/pre-step` listener（`agent-instructions/src/index.ts:322`）把 `desired` 用 `decision.messages.toSpliced(lastClaimedIndex+1, 0, desired)`（`:346`）折入 batch，而非 `agent.inject()`。这区别于 plan/approval 的 `agent.inject()`（append 到 inbox/next-step）——workspace 指令是 durable user-role baseline，须与 direct prompt 一起进 step 1。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Seam | approval（`user-approval:30`）、user-questions、credentials、compaction | 不同部署换 answerer 不改 tools pipeline |
| Policy-interceptor | timeout-policy `tools/execute`（`:56`）、repeat-tool-reminder `tools/post-execute`（`:213`） | 注册序决定覆盖范围 |
| State-log | plan（`plan-mode:129`）、approval/policy、permission/preset、goal | 纯 fold 恢复，无 live mirror |
| Command-dispatcher | `CommandRuntime` 无 model turn | UI-plane action 不进 model history |
| Hook-bridge | `hooks-claude-code`/`hooks-codex` | 翻译外部 hook 协议到 typed interception points |

## 模块间交互

interaction 挂 `tools/*` 与 `agent/*` 事件：approval 的 `request()` 由 tools pipeline 调用；repeat-tool-reminder 挂 `tools/post-execute` + `agent/pre-step`；timeout-policy 挂 `tools/execute`。plan/todo 写 session event（`plan/mode`、`todo/write`、`command/run`、`command/done` 均 log-only）。`exit_plan_mode` 与 `ask_user_question` 共用 `ctx.userQuestions.ask()`。permission-presets 的 knob 事件被 `dsh-user-approval` 和 `dsh-tool-bash` 消费。

## 扩展方式

- **加一种 permission 策略**：`PresetSpec` 仅 bundle sandbox+approval。扩展 `PresetSpec`（`permission-presets/src/index.ts:55`）加 knob 字段，在 `set()` 里加对应 setter 调用。注意 `custom` 是 derived-only 无法持久化自定义 preset。
- **加一个 loop hygiene 规则**：在 `packages/guard/` 下新建 function/namespace plugin，镜像 repeat-tool-reminder 形态（`apply(ctx,config)` + `WeakMap<Agent,state>` + `prependContext` 到 `PostToolDecision.additionalContexts`）。`PostToolDecision` 已支持 `kind:'block'` 可升级为阻断。timeout 侧加新 `tools/execute` wrapper 时注意 cordis 注册序决定"timeout 覆盖整次 retry"（outer）vs"每次 attempt"（inner）。
- **加一个 hook bridge**：在 `packages/hooks/` 下新建包，基于 `hook-protocol` 库，把目标方言的 hook 事件映射到 typed interception points（`agent/*`、`tools/*`）。`hooks-claude-code` 是参考，native cordis plugin 能做一切 bridge 能做且更强（bridge 仅兼容路径）。

## 重要设计决策

为什么 approval 是 seam：不同部署不同 answerer（交互 UI、ACP automation bridge 机器策略、headless fail-closed）；seam 让每个部署 supply 终端 answerer 而不改 tools pipeline，service 自身从不 prompt human，'never' 在 dispatch 前短路保证 listener 注册序无法破坏确定性。为什么 plan 是 logged state：resume/fork/compaction 直接 `foldPlanMode(events)` 恢复，无 live mirror 要 sync，"Delete only after append succeeds" 保证 failed durable write 可重试。为什么 commands 不走 model turn：人类命令是 UI-plane action，result 在 UI 渲染不进 model history，需 model-visible 工作时由 producer 显式 `agent.steer()`。为什么 agent-instructions 经 pre-step fold 而非直接 inject：workspace 指令是 durable user-role baseline，须与 direct prompt 一起进 step 1，保持邻接；后续变更用 durable `user/message` 事件。
