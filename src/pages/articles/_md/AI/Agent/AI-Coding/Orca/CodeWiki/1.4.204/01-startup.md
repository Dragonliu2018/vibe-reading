---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "主进程启动与生命周期"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
tags: ["Orca", "Electron", "启动流程"]
description: "Orca 主进程的 composition root：preflight→ready→launch 三阶段装配、单实例锁退出码 3 契约、pull-as-proof 深链握手与 serve/desktop 双模式同构。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

这个模块是 Electron 主进程的 **composition root（装配根）**：`src/main/index.ts` 只有 115 行，全部工作下沉到 `src/main/startup/` 的约 90 个非测试文件；`window/`、`tray/`、`menu/`、`dock/` 是它驱动的呈现层。它不包含业务规则，但**装配顺序本身是正确性约束**——单实例锁必须在 userData 路径决定之后、Crashpad 必须在首个 renderer spawn 之前、IPC 分两波注册各有原因。读懂这个模块就理解了"Orca 是怎么长出来的"。

## 模块架构

模块内部是"**一个可变单例 + 一串阶段函数**"的结构。`mainProcessState`（`startup/main-process-state.ts`）是唯一跨阶段可变状态容器——约 60 个字段全部从 `null` 起步、由后续阶段填充：

```ts title="src/main/startup/main-process-state.ts"
/** Mutable composition-root state shared by startup, window, serve, and quit phases. */
export const mainProcessState = {
  mainWindow: null as BrowserWindow | null,
  isQuitting: false,              // Cmd+Q 锁存，让 close handler 跳过确认
  store: null as Store | null,
  runtime: null as OrcaRuntimeService | null,
  runtimeRpc: null as OrcaRuntimeRpcServer | null,
  skillShareDeepLinks: new SkillShareDeepLinkState(),
  osOpenedMarkdownFiles: new OsOpenedMarkdownFileState(),
  markdownFileOpenListenerReady: false,   // 渲染器 listener 存活证明
  gpuCrashFallbackTracker: new GpuCrashFallbackTracker({...}),
  isServeMode: false,
  shellPathReady: Promise.resolve(),      // 发布给渲染器 Git barrier
  tray: null as Tray | null,
  // …共约 60 个字段
}
```

preflight 写入 `devInstanceIdentity`/`isServeMode`，ready 阶段写入 `store`/`runtime`，窗口控制器写入 `mainWindow`，quit 阶段读一切做排水——**字段即装配顺序文档**。围绕它的阶段函数各司其职：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| `runMainProcessPreflight` | `startup/main-process-preflight.ts:96` | ready 前必须完成的一切（锁/注入/Crashpad/GPU） |
| `initializeMainProcessReady` | `startup/main-process-ready.ts:11` | ready 后三段：foundation → runtime services → launch |
| `openMainWindow` | `startup/main-window-controller.ts:51` | 断言 15 个服务非空后建窗口 |
| `createMainWindow` | `window/createMainWindow.ts` | 纯 Electron 窗口工厂（收 ~15 个崩溃恢复回调） |
| `createSystemTray` | `tray/system-tray.ts` | 模块级单例（Tray 被 GC 会回收图标，必须持活） |
| `registerAppMenu` | `menu/register-app-menu.ts` | 菜单 + `rebuildAppMenu` 幂等重建 |

## 调用链路

![启动装配链](/vibe-reading/images/articles/orca-internals/startup-assembly.svg)

阶段 0 在模块加载即执行（`app.whenReady` 之前）：`setMainWindowOpener(openMainWindow)` 用 setter 注入打破 actions↔controller 的 import 环，然后 `runMainProcessPreflight()` 返回 false 则直接退出。阶段 1-2 在 whenReady 后：foundation（Store/代理/SSH host key）与 runtime services（`new OrcaRuntimeService(...)`）顺序执行，然后 **i18n/menu 与 runtime launch 并行**——`main-process-ready.ts` 的注释解释了为什么："窗口创建不读任何翻译字符串……串行只是拖慢 renderer"。阶段 3 `openMainWindow()` 与 `runtimeRpc.start()`（等 `shellPathReady`）并行，托盘再延迟到 `ready-to-show` 后 `setImmediate` 创建（外加 12 秒兜底 timer）。

**serve/desktop 双模式同构**是关键设计：`launchServeMode()`（`main-process-runtime-launch.ts:121`）与 `launchDesktopMode()`（同文件 ：213）共享 95% 装配，只在最后一步分叉——serve 永不建窗口、注册 signal handler、`syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, ...)` 发布空窗口图。这正是 `shouldActivateDesktopForSecondInstance()`（`single-instance-lock.ts:18`）存在的原因：systemd 以 `serve` 形式拉起第二实例时，不得把 headless 服务器激活成桌面窗口。

方法速查表：

<details>
<summary>startup 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runMainProcessPreflight()` | ready 前装配 | Crashpad/scheme 表/Keychain 名都要在 ready 前落定 |
| `acquireSingleInstanceLock()` | 单实例锁 | 失败 `app.exit(3)`，在 userData 决定之后（dev 与 packaged 锁不同命名空间） |
| `initializeReadyFoundation()` | Store/代理/host key | `initialProxyApplicationReady` 发布不 await，由 session guard 兜底 |
| `initializeReadyRuntimeServices()` | 实例化 runtime | 之后 `configureRuntimeServices` 挂 automations/plugins/bridges |
| `openMainWindow()` | 建主窗口 | `requireMainWindowServices` 断言 15 个服务非空 |
| `createSystemTrayDeferred()` | 托盘延迟 | `trayCreated` 幂等 + 12s 兜底（`TRAY_CREATE_FALLBACK_MS`） |
| `publishOsOpenedMarkdownFiles()` | 深链缓冲发布 | 仅在 listener ready 锁存置位后 push |

</details>

## 核心实现

### 单实例锁：退出码 3 是给 systemd 的契约

`acquireSingleInstanceLock()`（`startup/single-instance-lock.ts:40`）为什么存在：Orca 往 `<userData>/` 写两个发现文件——`orca-runtime.json`（RPC 端点）和 `agent-hooks/endpoint.env`。无锁时每次双击都会 clobber，旧实例退出后 `orca status` 误报 `stale_bootstrap`（文件内注释原文）。

锁失败时退出码是硬编码的：

```ts title="src/main/startup/single-instance-lock.ts"
export const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = 3
```

这是给 systemd `RestartPreventExitStatus=` 的稳定契约——文件注释明说 "changing it silently un-fixes #11935"。锁必须在 `configureDevUserDataPath()` **之后**获取，因为 Electron 锁身份派生自 userData 路径：dev（`orca-dev`）与 packaged 锁在不同命名空间。dev 默认 skip（`shouldSkipSingleInstanceLock()`：`isDev && !isServeMode`，E2E 可用 `ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK=1` 强制）以支持多 worktree 并行 `pnpm dev`；packaged macOS 另有诊断旁路 `shouldBypassSingleInstanceLock()`（仅 `ORCA_BYPASS_SINGLE_INSTANCE_LOCK=1` 时生效，走 `logSingleInstanceLockBypass` 记录）。

第二个实例的激活裁决是 `shouldActivateDesktopForSecondInstance()`（`single-instance-lock.ts:18`）——实现就是 `!argvRequestsServeMode(argv)`：**duplicate `orca serve` 是监督者产物**（systemd unit 传 CLI 形式的 `serve` 参数，CLI 重定向不会改写它），只匹配 flag 形式会把活着的 headless 服务器提升成桌面窗口（同样会 un-fix #11935）。

### pull-as-proof 握手：对抗 webContents.send 的静默丢弃

Electron 的 `webContents.send` 对没有 listener 的渲染器是**静默丢弃**。"Open With" 打开 markdown、`orca://skill-share/` 深链都可能发生在任何窗口存在之前。解法（`publishOsOpenedMarkdownFiles()` in `src/main/index.ts:45` + `ui:consumePendingMarkdownFileOpens` handler）：

1. 主进程先 buffer：`state.osOpenedMarkdownFiles.capture(process.argv)`（缓冲队列容量 `MAX_PENDING_OS_OPENED_MARKDOWN_FILES = 32`）；
2. 渲染器 mount 后**主动 pull**（`consumePendingMarkdownFileOpens()`），pull 本身把 `state.markdownFileOpenListenerReady = true` 置位——此后主进程才敢 push；
3. `did-finish-load` 时**清掉 ready 位**（`main-window-controller.ts:172`）：reload 后旧 listener 没了，必须等新渲染器重新 pull。

投递失败（窗口/webContents 已销毁或 resolve 拒绝）时 `state.osOpenedMarkdownFiles.restore(filePaths)` 把文件放回缓冲，不丢。同一模式复用三处：markdown 文件（`os-opened-markdown-files.ts`）、skill share 深链（`skill-share-deep-link-state.ts` 的 `SkillShareDeepLinkState.capture/consume`）、托盘的 Settings 请求（`pendingOpenSettings` 定时标志）。

### preflight 必须先于 ready 的全部理由

`runMainProcessPreflight()` 的注释逐条说明各调用为什么不能等 ready：Crashpad 必须在第一个 renderer spawn 前装好（否则 native CHECK 只剩 exit code）；privileged scheme 表在 ready 时冻结；macOS safeStorage 的 Keychain service name 在 ready 前解析（dev 必须提前 `app.setName`）；`initDataPath()` 必须在 dev/E2E 的 userData override 之后、`app.setName` 之前 capture，否则大小写敏感文件系统上路径漂移。

此外 preflight 是全仓库**依赖面最宽**的文件（一个文件 import ~60 个模块），但全部通过 setter 注入翻转——`setSecretStore(new ElectronSecretStore())`、`setPtyHostBindings({ipc: ipcMain, power: powerMonitor})`、`setRuntimeDesktopSurface(...)`、`setMainHttpClient(...)` 等。这让同一套 runtime/git/browser 代码在 Node host（`orca serve`）里可以注入 no-op 实现。

### 托盘延迟创建与 AppKit 死锁规避

`createSystemTrayDeferred()`（`main-window-actions.ts:105`）三层防护：`trayCreated` 布尔幂等；`ready-to-show` 后 `setImmediate` 创建避免与首帧竞争；12 秒兜底 timer。`system-tray.ts` 的 `scheduleTrayImage` 走 `deferAppKitSceneMutation`——从 AppKit callout 里直接调 `tray.setImage` 会死锁主线程。

### 崩溃可观测性贯穿启动

`createMainWindow` 的调用方注入一整组回调（`onRendererProcessGone`/`shouldRecoverRenderer`/`onRendererRecoveryExhausted`，见 `main-window-controller.ts:102-129`），把窗口层崩溃恢复与 startup 层的崩溃面包屑（`recordDurableCrashBreadcrumb`）、恢复熔断（`recoveryReloadInFlight`）、恢复对话框连成闭环。恢复计数用两个不同 breadcrumb 名区分 reload-stalled 与 breaker-open；`child-process-gone` 事件驱动 GPU crash fallback 判定（`gpuCrashFallbackTracker`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Composition Root / Service Locator | `mainProcessState` | 单一可变对象持有全部服务，字段即装配文档 |
| Setter 注入 | `setMainWindowOpener()` in `main-window-actions.ts:26` | index.ts 顶层注入，避免 actions↔controller import 环 |
| 门面 | `src/main/index.ts` | 115 行入口只做转发 |
| 拉取式握手 | `ui:consumePendingMarkdownFileOpens` | pull 即证明 listener 存活，对抗静默丢弃 |
| 定时标志 | `createWebContentsTimedFlag()` in `web-contents-timed-flag.ts` | 带 TTL 的一次性意图，防泄漏到后续 load |
| 激活门 | `createServeDesktopActivationGate()` in `serve-desktop-activation.ts` | headless 冷启动期拒绝拉起窗口 |

激活门是一个三状态机（`initializing` / `ready` / `blocked`）：`requestActivation` 在 `ready` 时立即激活、`initializing` 时缓冲为 pending、`blocked` 时调 `onBlocked`；`markReady` 只从 `initializing` 转入并补发 pending。`settleServeDesktopActivation()` 在 `hasPersistentPtyProvider === false` 时把门置 `blocked`——fail-closed（#8457），理由是 "persistent PTY provider unavailable"；门的 activateWindow 回调还会在 `isQuittingForUpdate()` 时跳过 `focusExistingWindow`。

## 模块间交互

startup 与其余系统的关系全部通过 `mainProcessState` 的填充顺序表达：ready 阶段实例化的 `OrcaRuntimeService`（见 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)）被 runtime launch 阶段用 `installRuntimeRpc()` 包进 `OrcaRuntimeRpcServer`（见[统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)）；窗口创建时的 `registerCoreHandlers` 把 15 个服务实参（非 state 读取）传给 IPC 层；渲染器通过 `app:awaitFirstWindowStartupServices` / `app:awaitGitEnvironmentStartupBarrier`（`main-process-ipc-bootstrap.ts:8,18`）等待主进程侧就绪 Promise，形成双向 barrier。quit 阶段（`main-process-quit.ts`）做两遍 will-quit 排水。

## 扩展方式

**新增启动参数**：`startup/serve-mode-argv.ts` 的 argv 解析处加识别 → `runMainProcessPreflight()` 消费（必须在 ready 前）→ 需要暴露给后续阶段则在 `mainProcessState` 加字段。

**新增托盘菜单项**：`tray/system-tray.ts` 的 `SystemTrayOptions` 加回调 → `getSystemTrayOptions()`（`main-window-actions.ts:78`）提供实现——需要通知渲染器时模仿 `openSettingsFromSystemMenu`（:54）：`showMainWindowFromTray()` + `webContents.send('ui:openXxx')` + 定时标志防丢。

**新增 deep link**：建 `SkillShareDeepLinkState` 式的 capture/consume 缓冲类 + `src/shared/` 里的 URL 解析函数 → `src/main/index.ts` 的 `app.on('open-url')` 加分支 → `registerMainProcessIpcHandlers()` 加 `ui:consumePendingXxx` handler 供渲染器 mount 时 pull。
