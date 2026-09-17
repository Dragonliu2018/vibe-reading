---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Desktop 桌面端"
date: "2026-09-18T00:04:45+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Electron", "webview", "桌面应用"]
description: "paseo Desktop——Electron 壳复用 Expo web export、daemon 作为 detached 托管子进程（ELECTRON_RUN_AS_NODE 复用二进制）、ws+unix:// 本地桥接、多窗口 hybrid land-on 与 webview 键盘边界。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/desktop/`（~26,700 行）是 Electron 壳：renderer 加载 App 包的 Expo web export（10 篇的 `isElectron` 分支就是为它准备），main 进程管理 daemon 子进程、多窗口、内置浏览器。它的存在证明了一个架构主张：**desktop 只是"又一个 client"**——agent 编排、协议、UI 全部复用，desktop 独有的只有 OS 集成（窗口、菜单、文件对话框、内置浏览器、更新器）。

## 模块架构

```
packages/desktop/src/
├── main.ts（1065 行）/ desktop-startup.ts     # 入口 runDesktopStartup({bootstrap})
├── daemon/
│   ├── daemon-manager.ts: startDaemon()       # 托管子进程生命周期
│   ├── node-entrypoint-launcher.ts            # ELECTRON_RUN_AS_NODE=1 复用二进制
│   └── local-transport.ts: LocalTransportManager  # ws+unix:// 桥接
├── pending-open-project-store.ts              # per-webContents 的 land-on 路径
├── features/
│   ├── browser-webviews/registry.ts           # (host window, workspace) 键的 guest 注册表
│   ├── browser-profile.ts                     # persist:paseo-browser 共享分区
│   ├── browser-keyboard/                      # 快捷键保留 + agent 键边界
│   └── browser-capture.ts                     # guest.capturePage 截图
├── preload.ts                                 # 沙箱编译，单一 paseo:invoke 通道
└── quit-lifecycle.ts                          # 退出时是否回收 daemon
```

## 调用链路

**启动与 daemon 托管链**：

```
main.ts → runDesktopStartup()（desktop-startup.ts）
└── app.whenReady()
    ├── 注册 paseo:// 自定义 protocol（SPA fallback）
    ├── 菜单 / daemon/window/dialog/notification/browser-automation IPC
    └── desktopWindowOwner.openPrimary()     # 首窗

startDaemon() in src/daemon/daemon-manager.ts
├── resolveDesktopDaemonStatus()             # 捆绑 CLI daemon status --json 探测
├── shouldRestartForVersion()                # 版本不匹配先 stop（热替换）
├── createNodeEntrypointInvocation()         # ELECTRON_RUN_AS_NODE=1 复用 Electron 二进制跑 Node 入口
├── spawnProcess(..., {detached: true}) + child.unref()
│    # 1.2s grace 期观察早退（DETACHED_STARTUP_GRACE_MS）
└── pollForRunningDaemon()                   # 200ms × 150 次轮询
     # 环境注入 PASEO_DESKTOP_MANAGED=1、PASEO_WEB_UI_ENABLED=false
     # paseo.pid 锁文件记 pid/desktopManaged
```

renderer 连 daemon **不走 TCP**：状态含 `listen` 字段（Unix socket / Windows named pipe），main 进程用 `ws` 库通过 `ws+unix://` 连 socket 并桥接（renderer 无法直连 Unix socket）——`src/daemon/local-transport.ts` 的 `LocalTransportManager`。

<details>
<summary>组件速查表</summary>

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `runDesktopStartup()` | `desktop-startup.ts` | whenReady 装配 + 首窗 |
| `createWindow()` | `main.ts:663` | 可复用窗口工厂（⌘⇧N/second-instance/open-in-new-window 共用） |
| `startDaemon()` | `daemon/daemon-manager.ts` | detached 托管 + 版本协商 |
| `LocalTransportManager` | `daemon/local-transport.ts` | renderer ↔ main ↔ Unix socket 桥 |
| `PendingOpenProjectStore` | `pending-open-project-store.ts` | `Map<webContentsId, path>` 的 land-on 暂存 |
| `isPaseoBrowserWebviewAttach` | `main.ts`（will-attach-webview） | guest 安全校验：强制 sandbox、删 host preload |
| `activeBrowserIdsByHostWindow` | `features/browser-webviews/registry.ts` | `Map<number, Map<workspaceId, browserId>>` |
| `classifyBrowserReservedShortcut` | `features/browser-keyboard/` | Cmd/Ctrl+T/L/R 保留判定 |
| `stopDesktopManagedDaemonOnQuitIfNeeded()` | `quit-lifecycle.ts` | 退出回收策略 |

</details>

## 核心实现

### daemon 为什么是子进程而非内嵌

四个理由（`docs/architecture.md:107/428` + 代码佐证）：

1. **独立生命周期**：detached + unref 使 daemon 可在 app 崩溃后存活；"restart the app = 完整 reset"（`quit-lifecycle.ts` 的 `stopDesktopManagedDaemonOnQuitIfNeeded`，Settings "Keep daemon running after quit" 可选退出不回收）；
2. **代码复用**：同一份 daemon 被 CLI/mobile 复用，桌面只是另一 client；
3. **版本独立协商**：`shouldRestartForVersion()` 允许 daemon 与 app 版本不匹配时热替换（protocol 层的 append-only 契约使这成为常态而非异常，见 05 篇）；
4. **安全隔离**：main 进程不做 agent 编排，仅经 local-transport 桥接 socket。

`ELECTRON_RUN_AS_NODE=1` 复用 Electron 二进制跑 Node 入口——不要求用户另装 Node，分发的 daemon 就是同一份二进制。

### 多窗口：hybrid land-on 模型

`createWindow()`（`main.ts:663`）可复用：菜单 ⌘⇧N、`second-instance`、侧栏 "Open in new window" 都经 `desktopWindowOwner.openAdditional()` 开新窗。**每个窗口都有完整侧栏**，没有 per-window project ownership。"land on a project" 由 per-`webContents` 的 `PendingOpenProjectStore`（`Map<webContentsId, path>`）实现：窗口挂载时经 `paseo:get-pending-open-project` 取走（take）并走与 CLI `paseo <path>` 相同的流程（路径解析在 `open-project-routing.ts` 的 `parseOpenProjectPathFromArgv`）。

**window-state v1 限制**（刻意接受）：仅首个窗口恢复/持久化几何，其余默认尺寸 + OS 级联——避免多窗争抢单一 store 相互覆盖；要解除需 per-window state keys（`main.ts:668` 注释）。

### 内置浏览器：guest 管理与键盘边界

这是 desktop 最复杂的一块（agent 可以开浏览器 tab 并自动化）：

- **guest 校验**：`will-attach-webview` 强制 sandbox、删 host preload、替换为 browser keyboard preload；
- **注册表**：`activeBrowserIdsByHostWindow: Map<number, Map<workspaceId, browserId>>`——active browser 按 **(host window, workspace)** 键；每次 `did-attach` 显式重注册（reparent 保留的 `<webview>` 会换 guest 而不换 DOM 元素，注册必须重复）；
- **共享 profile**：`persist:paseo-browser` partition，全 tab/workspace/窗口共享 cookie 与登录态；清除仅走 Settings → General → Clear browser data（清共享 session + reload live guests，不删 saved tabs）；
- **键盘边界**（架构文档的 ASCII 图值得引用）：

```
Human key → guest WebContents
  ├─ Cmd/Ctrl+T/L/R ───────→ reserved browser-shell action
  └─ page keydown
       ├─ page prevents ────→ page owns it
       └─ published shortcut → guest preload → IPC(browserId) → Paseo resolver

Agent browser_keypress → guest sendInputEvent(skipIfUnhandled)
  ├─ guest handles ────────→ page owns it
  └─ guest 不处理 ─────────→ stop；绝不 redispatch 到 host window
```

人类键与 agent 键走不同路径，且 agent 键**永不穿透到 host composer**——一个未处理的 Enter 止于 guest，不会掉进宿主输入框。

### preload 与 IPC

`preload.ts` 沙箱编译（注释明确禁止 local require，防 0.1.108 回归 #2103），仅 `exposeInMainWorld("paseoDesktop")` 暴露 `invoke`——**单一 `paseo:invoke` 通道复用**大部分命令。构建分发：electron-builder 三平台（mac dmg+notarize+hardenedRuntime 最低 13.0、win nsis x64+arm64、linux AppImage/deb/rpm）；AppImage 文件名刻意不带 `${version}` 以便 updater 原地覆盖；`asarUnpack` node-entrypoint-runner 与 shell-integration；CLI 捆绑为 `bin/paseo`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 托管子进程（detached） | `startDaemon()` in `daemon/daemon-manager.ts` | daemon 独立生命周期 + 版本热替换 |
| 单一 IPC 通道复用 | `paseo:invoke` + `createDaemonCommandHandlers()` | 通道数不随命令数膨胀 |
| take 语义暂存 | `PendingOpenProjectStore` | land-on 路径一次性消费 |
| 注册-验证分离 | `will-attach-webview` 校验 + `did-attach` 注册 | webview guest 可被静默替换 |

## 模块间交互

- renderer = App 包的 web export（10 篇），`src/desktop/` 是 App 内的 Electron 专有分支；
- daemon 探测复用捆绑 CLI 的 `daemon status --json`（07 篇）；本地桥接消费 01 篇的 Unix socket listen；
- `browser_keypress`/`browser_new_tab` 等是 04 篇工具目录面向 agent 的浏览器自动化面。

## 扩展方式

新增一个 IPC 通道两种模式：(a) 走既有 `paseo:invoke` 复用通道——`createDaemonCommandHandlers()` 加 handler 名，renderer 调 `window.paseoDesktop.invoke(command, args)`，需要 preload 便利方法则在 `preload.ts` 扩展；(b) 专用 `ipcMain.handle("paseo:xxx")` 直接在 `main.ts` 注册（如 `paseo:browser:focus`）。事件推送统一 `webContents.send("paseo:event:*")`。
