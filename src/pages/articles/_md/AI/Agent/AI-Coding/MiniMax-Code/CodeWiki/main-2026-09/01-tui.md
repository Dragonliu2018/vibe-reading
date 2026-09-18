---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "TUI 终端前端"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "TUI", "ACP", "pi-tui"]
description: "packages/tui 解读——三入口（交互 TUI / headless exec / ACP）在 createTuiRuntime→TuiRuntimeAdapter(CliService) 汇合；渲染引擎为 pi-tui 0.84.2 vendored fork（BASELINE hash 台账 + LOCAL_CHANGES 可选择性同步上游）；deferred runtime 让首帧渲染与初始化并行"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`tui`（~15.5 万行，474 文件）拥有全部终端交互：交互 TUI、headless exec、ACP 三个入口，加上登录/provider/插件管理等 CLI 子命令。它是 V2 runtime 的**唯一消费方**——架构文档写明 "TUI delegation uses the current runtime task services"。模块的核心价值不在"画界面"，而在两点：一是把三种前端形态收敛到同一 runtime adapter（一次声明区分三种 surface，而非三套 runtime）；二是管理一个 vendored 的渲染引擎 fork（既深度定制又能选择性同步上游）。

## 模块架构

![TUI 三入口](/vibe-reading/images/articles/minimax-code/tui-entries.svg)

内部结构按"入口 → 生命周期 → adapter → 渲染"纵向切分：`cli/` 是 commander 组装层（`TuiCliCommandContribution` 注册表让子命令零侵入注册）；`tui/launcher.ts` 与 `tui/app-composition.ts` 是组合根，装配 widgets/controller/state/theme；`runtime/` 是桥接层——`lifecycle.ts`（920 行）的 `createTuiRuntime()` 创建 runtime，`adapter.ts` 的 `TuiRuntimeAdapter` 实现 `TuiRuntime` 总接口；`tui/engine/` 是 vendored 渲染引擎；`acp/` 与 `headless/` 是另两个入口的适配层。关键设计是 `runtime/port.ts` 把 TUI 的需求切成约 12 个窄接口（TuiSessionPort、TuiConversationPort…）——**按消费能力切片复用同一 adapter**：ACP 取 11 个 port 的交集类型 `TuiAcpRuntime`，headless 取自己的子集。

## 调用链路

三个入口的启动链：

```
交互 TUI：runTuiCli → createTuiProgram().parseAsync → launchTui (launcher.ts:149)
  → TTY 检查 → ProcessTerminal + createMcodeSharedAuthSession
  → createTuiRuntime({surface:'tui'})      动态 import，不 await
  → createTuiApp({runtime: createDeferredTuiRuntime(promise)}) → app.start()
  → Promise.race([runtime, app.stopped, processStopFailure]) (launcher.ts:489)
headless：runTuiCli → runTuiExecCommand (cli/run-exec-command.ts:29)
  → resolveTuiExecInvocation → createTuiRuntime({surface:'headless'})
  → runTuiExec(input, {runtime}) (headless/runner.ts:114)
ACP：runTuiCli → runTuiAcpCommand (cli/run-acp-command.ts:35)
  → createTuiRuntime({surface:'acp'}) → serveTuiAcpStdio
  → createTuiAcpAgent({runtime})     console 重定向到 stderr 保 stdio 纯净
```

三链在 `createTuiRuntime` → `TuiRuntimeAdapter(CliService)` 处汇合。此后数据流是拉模型：`sendMessage()` 返回 `AsyncGenerator<TuiStreamEvent>`，`watchEvents()` 返回 `AsyncGenerator<TuiRuntimeEvent>`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runTuiCli()` in cli/main.ts:81 | CLI 总入口，路由到子命令 | `RunTuiCliDependencies` 全量依赖注入（process/createRuntime 可替换） |
| `createTuiProgram()` in cli/program.ts:52 | commander 组装 | `TuiCliCommandContribution` 注册表 + 重名冲突检测 |
| `launchTui()` in tui/launcher.ts:149 | 交互模式启动 | deferred runtime + Promise.race 竞态生命周期 |
| `createTuiApp()` in tui/app-composition.ts | 组合根装配 widgets/controller | `createTuiApplicationWidgets()` widget bag |
| `createTuiRuntime()` in runtime/lifecycle.ts | 创建 runtime + adapter | surface 门控能力：headless 关弹卡、headless/acp 启用 quarantined |
| `TuiRuntimeAdapter.sendMessage()` in runtime/adapter.ts:171 | 流式对话 | 委托 conversationAccess，AsyncGenerator |
| `TuiChatController.submit()` in controller/chat-controller.ts:344 | 提交消息 + optimistic user cell | 快照式 state + turnProjection 流式投影 |
| `createTuiAcpAgent()` in acp/agent.ts | ACP agent app（2111 行） | Keyed Serial Executor：session/MCP/config/permission 四类变更按 sessionId 串行化 |

</details>

## 核心实现

### 渲染引擎 = vendored fork，不是 npm 依赖

`tui/engine/` 是 [earendil-works/pi](https://github.com/earendil-works/pi-mono) `@earendil-works/pi-tui` 0.84.2（commit `836aee6`，2026-08-18 导入）的 source fork。为什么 vendored：mcode 需要产品级 hook——L009 给 `components/editor.ts` 加状态捕获/恢复与 paste 拦截（从而删掉了自研编辑状态机）、L007 给 Markdown 代码块加 chrome——这些改动等不起上游发版。管理机制是三件套：`BASELINE.json`（上游逐文件 hash）+ `LOCAL_CHANGES.md`（L001–L029 变更台账）+ `public.ts` 唯一导入边界（UPSTREAM.md 明文禁止产品代码 import 实现文件）。这让 fork 既可定制又可**选择性同步**——L017-L021 就是选择性吸收 Pi 0.84.4 修复的记录，每条附上游 commit hash。`rendering/component.ts` 只给 Pi `Component` 加了 `dispose?()` 生命周期 veneer。

注意与 agent 栈的区别：pi-mono 主体是 v0.79.1，而 tui engine 是 0.84.2——**两处独立 vendored，版本不同步**。渲染栈完全自研于这个 fork 之上（`McodeInteractiveRenderer` 包 Pi TUI，regular 行内滚动 / fullscreen 双模式，`TuiSurfaceHost` 持有两套布局根，模式切换后 `TuiThemeController.rebindUi()` 重绑）。

### 事件消费的双路径与流式渲染

TUI 有两条并行消费路径。**前台 turn 流**：`TuiChatController.submit()` 创建 turnId、画 optimistic user cell，`TuiRunCoordinator.execute()`（application/run-coordinator.ts:165）逐事件拉取 generator，delta 流入 `TuiTurnProjection.applyStreamEvent` → `TuiLiveTurnProjection.applyDelta`（thinking → appendThinking、content → appendAssistantDelta、toolCalls → applyToolCalls）写入 TranscriptStore cell，`onChange()` 触发 `tui.requestRender()` 合帧重绘。**后台事件流**：`TuiRuntimeEventFlow.consume()`（controller/runtime/runtime-event-flow.ts:208）watchEvents 主循环 + 断线重连指数退避（250ms→10s），`session.start` 触发 `consumeLiveTurn` 经 `watchSessionTurn` 续传（afterCursor），`resync-required` 帧时 `reconcileOwnerHistory` 全量恢复。错误呈现走 `runtime-error-presentation.ts` 的分类器（按 errorCode 与 message 正则归为 auth/rate-limit/quota 等，生成带"下一步"文案的 cell）。

### surface 门控与 ACP 的串行化

`createTuiRuntime` 中 `capabilities.questionnaireReply/permissionPrompt/elicitation = surface !== 'headless'`（ACP **保留**弹卡能力，headless 关闭——编辑器侧 ACP 的 permission ask 经协议映射到客户端确认），且 headless/acp（及 test 数据环境）启用 `startupExecutionPolicy: 'quarantined'`——一次声明区分三种前端形态。ACP 侧 `createTuiAcpAgent` 用 Keyed Serial Executor 把 session/MCP/config/permission 四类变更各自按 sessionId 串行化，防编辑器并发请求竞态；console 重定向到 stderr 保持 stdio 协议纯净。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 依赖注入贯穿 | `RunTuiCliDependencies`（main.ts:42）、`LaunchTuiDependencies`（launcher.ts:111） | 可测试性（配合 `isVitestRuntime()` 替换 telemetry） |
| Facade + 按域分片 | `TuiRuntimeAdapter` + 9 个 `runtime/adapters/*-access.ts` | god class 名声下是纯门面 |
| Deferred / 竞态生命周期 | `createDeferredTuiRuntime`（runtime/deferred.ts）+ 多处 Promise.race | UI 先渲染，区分 runtime 失败/用户提前退出/进程死亡 |
| Contribution Registry | `TuiCliCommandContribution`（program.ts:335）+ `TuiCommandCatalog`（commands/catalog.ts:542） | 斜杠命令与子命令的零侵入扩展点 |
| Ledger fork | engine 的 BASELINE.json + LOCAL_CHANGES.md | vendored 代码的可审计演进 |

## 模块间交互

依赖（package.json 实证）：`@mavis/local-runtime-v2`（`workspace:*`，核心：`CliService`、`createLocalRuntimeHost`、`getDefaultLocalRuntimeConfig`）、`@mavis/config`、`@mavis/oauth-core`（登录 UI 与共享 auth 会话）、`@mavis/oauth-lease-protocol` + `@mavis/mcode-tools-host`（lease broker 客户端/宿主集成）、`@mavis/agent-tools`、`@mavis/browser-core`（headless-chrome-provider）、`@mavis/shared`，及外部 `commander`、`@agentclientprotocol/sdk`、`@earendil-works/pi-coding-agent`。交互方式全部**进程内直调**——adapter 方法直接调 CliService 的 async 方法，流式数据走 AsyncGenerator。tui 是 `@mavis/local-runtime`（v1）的三个 import 方之一（embedded-host 明确 "legacy fallback is disabled"）。

## 扩展方式

- **新增斜杠命令**：`tui/commands/catalog.ts` 的 `DEFAULT_COMMAND_CATALOG` 加 `TuiCommand` 定义 → `tui/controller/product/command-flow.ts` 的 `TuiCommandFlow.createHandlers()` 注册 handler；autocomplete 由 Editor 的 provider 自动取 catalog。
- **新增 UI widget**：`tui/app-composition.ts` 的 `createTuiApplicationWidgets()` 实例化并加入 widget bag → `tui/shell/chat-layout.ts` 放进 regular/fullscreen 两套布局；改 engine 图元须记入 `LOCAL_CHANGES.md` 台账。
- **新增 CLI 子命令**：新建 `cli/xxx-command.ts`，在 `cli/program.ts` 注册 + `cli/main.ts` 加注入项与动态 import；或走 `TuiCliCommandContribution` 注册表零侵入接入。
