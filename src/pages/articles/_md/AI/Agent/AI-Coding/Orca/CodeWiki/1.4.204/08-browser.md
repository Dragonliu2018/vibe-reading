---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "嵌入式浏览器"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "浏览器", "CDP"]
description: "506 个文件的浏览器子系统：跨机器页面所有权 lease、Design Mode 采集链与主侧三重清洗安全网、headless offscreen 回退、agent-browser 独立守护进程自动化。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

`src/main/browser/`（506 个文件）是嵌入式浏览器子系统。它要解决的根本矛盾：agent 的 runtime 可以跑在远端服务器（headless serve）或被手机驱动，而 **Chromium 页面必须活在有用户的地方**（桌面 webview / 手机投屏）。解法是把页面"所有权"从"页面在哪渲染"中拆出来——用 lease 做跨机器的会话化凭据。命名前缀即子系统：`agent-browser-bridge-*`（agent 自动化）、`browser-client-*`/`paired-runtime-*`（远程租约与页面执行）、`grab-guest-*`（Design Mode 采集脚本）、`cdp-*`（CDP 命令面）、`browser-screencast-*`（投屏）。

## 模块架构

![浏览器模块结构](/vibe-reading/images/articles/orca-internals/browser-lease.svg)

三层结构：**页面所有权**（authority runtime 的 lease registry ↔ 配对 host 的 client lease，中间是 placement 决策）→ **tab 创建三分支**（client/offscreen/desktop）→ **两条采集/自动化链**（Design Mode 人→agent、agent-browser 自动化）。

## 调用链路

**打开浏览器 tab**（`runtime-browser-commands-browser-tab-create.ts:22` 的 `browserTabCreate`）三分支：placement 为 client（远程/移动请求）时必须 `caller.pairedDeviceId`（否则 `forbidden`）→ `createRuntimeBrowserClientPage` 经 lease registry 选一个具备 `webview` capability 的 host → `pages.publishClientPage`；headless serve（无 renderer `<webview>`）用主进程 offscreen WebContents 兜底（`offscreen-browser-backend.ts`："headless serve has no renderer `<webview>`"）；桌面走 `createBrowserTabInRenderer`，renderer 挂 webview 后回调 `registerGuest`（`browser-manager-registration.ts`）把 `browserPageId → webContentsId` 注册进 `browserManager`。

**Design Mode 点击 → agent prompt**：

```text
renderer browser-pane → IPC browser:setGrabMode（isTrustedBrowserRenderer 鉴权
  + queueGrabModeOperation 串行化）
→ browserManager.setGrabMode 向 guest 注入 grab-guest-*.ts 脚本
→ 用户点中元素 → 采集 selector / elementPath / cssClasses / nearbyElements
  / selectedText / reactComponents / sourceFile / textSnippet / htmlSnippet
  / computedStyles / rectViewport
→ clampGrabPayload() 主侧二次清洗
→ browser:captureSelectionScreenshot（CDP clip 裁剪截图）
→ GrabConfirmationSheet 的 formatGrabPayloadAsText
→ annotation tray 以 promptDelivery="submit-after-ready" 送入 agent prompt
```

**agent 自动化命令**：agent 工具 `browser_click/browser_goto/browser_fill...` → `resolveBrowserCommandTarget()`（含懒唤醒：给 authoritative window 发 `browser:activateView` 并 `waitForTabRegistration`）→ `requireAgentBrowserBridge().click(...)` → `AgentBrowserBridge` 拉起独立二进制 `agent-browser-<platform>-<arch>` 守护进程（`agent-browser-bridge-process.ts:12`），经 `CdpWsProxy` 对真实 webContents 执行 CDP；命令排队（`agent-browser-bridge-queue.ts`）+ 陈旧 session 清扫（`agent-browser-orphan-sweep.ts`）。

方法速查表：

<details>
<summary>浏览器关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `publishClientPage()` in page registry | 发布页面记录 | 幂等：replacement 需先 retire |
| `updatePageMetadata()` | 元数据更新 | revision 单调，旧 host 乱序更新被拒 |
| `replaceClientPagePlacement()` | 接管页面放置 | 接管方 revision 归零 |
| `BrowserHostLeaseRegistry.attach()` | host 挂载 | 同 clientId 换代 `fenceLease('replaced')` |
| `handlePageCommand()` in client lease | 页面命令准入 | 四元组身份校验不匹配即断连 |

</details>

## 核心实现

### lease：跨机器页面所有权的会话化凭据

authority 侧 `BrowserHostLeaseRegistry`（`runtime/browser-host-lease-registry.ts:54`）持有 `leasesByClientId`、`pagePlacements`、`pageReconciliations`、`tunnels`。client 侧 `PairedRuntimeBrowserHostLease`（`browser/paired-runtime-browser-host-lease.ts:28`）的重连窗口 `reconnectGraceMs`（默认 15s）内可恢复，超时 `failTerminal`。`handlePageCommand` 逐条校验 `authorityRuntimeId / authorityEpoch / browserHostClientId / browserHostGeneration` 四元组，不匹配即 `Stale browser host page command` 终止连接。核心洞见写在 `onClientPageFenced` 的注释里："**The page itself outlives the host that placed it**"——页面记录比放置它的 host 活得久，`pairedDeviceId` 字段注明 "identifies the viewer across reconnects"。

**命令账本**：`BrowserHostCommandResultSettler`（容量上限 + duplicate 检测）+ authority 侧 `issueClientPageCommand/settleClientPageCommand`，保证 at-least-once 传输下的幂等结算。

### clampGrabPayload：被采集页面反噬 agent 的防线

guest 内容脚本运行在被访问页面里，主进程 `clampGrabPayload()`（`browser-grab-payload.ts:18`）做三重清洗——注释明言这是 "main-side safety net: even if the guest runtime is compromised"：`GRAB_BUDGET` 截断、`GRAB_SECRET_PATTERNS` 密钥擦除、URL 剥 query/hash（防 token 泄漏）、`GRAB_SAFE_ATTRIBUTE_NAMES` 白名单。**Design Mode 的数据被当不可信输入处理**——防的是"被采集页面反噬 agent"。

### 远程页面的网络路由与投屏

远程页面的流量经 `browser-network-tunnel-*` + `ssh-browser-network-execution-route.ts` / `wsl-browser-network-execution-route.ts` 用桌面 SOCKS 隧道路由到正确的执行主机（页面在桌面渲染，但网络出口要贴近执行环境）。`browser-screencast-*` 用 CDP screencast 把页面帧推给订阅者——包括手机（`ActiveBrowserScreencastSubscriber.pairedDeviceId`）。

### 工厂注入与 Node host 缺省

`runtime-browser-commands-factory.ts` 的注释给出关键 why：`orca-runtime-browser.ts` 会拖入整个 Electron 集群（15 个 Node host 加载不了的模块），所以 Node host（`orca serve`）上"缺 provider = 所有 browser RPC 拒绝并返回 `browser_unavailable`"，而不是静默假成功。分层 mixin：`RuntimeBrowserCommandsWithBrowserClick extends RuntimeBrowserCommandsWithActiveScreencastsByPageId extends ...`，每个 `runtime-browser-commands-*.ts` 是机械拆分的类成员。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双向 lease + 四元组身份 | host-lease-registry / paired lease | 跨机器所有权需要会话化凭据 |
| 命令账本 | `BrowserHostCommandResultSettler` | at-least-once 下的幂等结算 |
| 主侧清洗安全网 | `clampGrabPayload()` | defense in depth 防 guest 被攻破 |
| 分层 mixin 拆文件 | `runtime-browser-commands-*` | 与 runtime 链同手法（`@ts-nocheck` 机械拆分） |
| 工厂注入缺省拒绝 | `runtime-browser-commands-factory.ts` | Node host 不假成功 |

## 模块间交互

与 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)：`RuntimeBrowserCommandHost` 是唯一注入面（god node `BrowserCommandTargetParams` 81 条边的成因——所有命令文件都消费它的 12 个方法）。与 renderer：`browser-pane/` 组件树（annotate/host-guest/navigate/stream-remote）经 preload `web-browser-api.ts` 调 grab/导航 IPC；主→renderer 走 `notifyRendererNavigation`、`browser:activateView`。与远程/移动：`startPairedRuntimeBrowserClientHost`（`paired-runtime-browser-client-host-runtime.ts:150`）向远端 authority 发起配对。

## 扩展方式

**给 Design Mode 新增一种元素信息采集**（如 aria-description）：

1. `src/shared/browser-grab-types.ts`：扩展 `BrowserGrabPayload` target 类型 + `GRAB_BUDGET` 加长度预算（属性则同时进 `GRAB_SAFE_ATTRIBUTE_NAMES`）；
2. `grab-guest-element-context-script.ts`：guest 侧采集字段；
3. **强制**：`browser-grab-payload.ts` 的 `clampGrabPayload()` 镜像加 clamp + secret 清洗——主侧安全网必须覆盖新字段；
4. `GrabConfirmationSheet.tsx` 的 `formatGrabPayloadAsText()` 加一行输出。
