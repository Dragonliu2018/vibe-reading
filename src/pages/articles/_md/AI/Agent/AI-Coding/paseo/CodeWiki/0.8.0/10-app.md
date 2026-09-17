---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "App 客户端"
date: "2026-09-18T00:02:25+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Expo", "React Native", "状态管理"]
description: "paseo Expo App——~39 万行的 iOS/Android/Web 三端客户端：host-runtime 五元连接 union、zustand+React Query 双轨状态、rAF 竞速 reducer 队列 + paced reveal 两层流式平滑、14 种 workspace tab。"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/app/src/`（~39 万行，2,011 个 TS/TSX 文件）是三端客户端：iOS/Android（React Native via Expo）、Web（Expo web export）、以及 Desktop 的 renderer（Electron 加载同一 web export，`isWeb` 在 Electron 下同为 true）。本篇只看架构骨架——这个包的规模决定了"逐文件讲"没有意义，有意义的数它**怎么组织 39 万行**：路由怎么防 native 白屏、状态怎么分轨、流式输出怎么在手机上不卡。

## 模块架构

```
packages/app/
├── index.ts                # polyfillCrypto() → Unistyles → expo-router/entry（顺序刻意）
├── src/app/                # Expo Router 路由树（h/[serverId]/* host 子树）
├── src/runtime/            # host-runtime.ts（85.7K）：连接生命周期 + host 注册表
├── src/stores/             # zustand ~20 个域 store（session-store 59.8K / workspace-layout 68.3K）
├── src/data/               # React Query（query-client + push-router 断连失效）
├── src/contexts/session-context.tsx   # client.on("agent_stream") 的消费入口
├── src/timeline/ + agent-stream/      # 流式渲染管线（本篇核心）
├── src/workspace-tabs/     # 14 种 tab kind 的 discriminated union
├── src/screens/（33k 行）/ composer/ / voice/ / file-explorer/ / terminal/ / mobile-panels/
└── src/desktop/            # Electron 专有（文件对话框/标题栏）
```

## 调用链路

**启动链**：

```
index.ts
├── polyfillCrypto()              # 必须先于任何 import（文件级副作用顺序）
├── 配置 Unistyles
└── import "expo-router/entry"
    └── 路由树 src/app/：根层 / welcome new sessions settings open-project
        └── host 子树 h/[serverId]/*（叶子路由由 host _layout 以相对名注册）
            └── startHostRuntimeBootstrap()（navigation/host-runtime-bootstrap.ts）
                ├── store.boot()                    # AsyncStorage + zod 恢复 host 注册表
                └── getDaemonStartService().startIfEnabled()   # 仅 desktop 托管 daemon
```

关键路由规则（`docs/expo-router.md`）：root layout 只注册 `h/[serverId]`，叶子路由由 `app/h/[serverId]/_layout.tsx` 以**相对名**注册——Expo Router 在 native 上对错误层级"静默白屏"，注册孙路由会挂出无参数的空 index。启动时 `/` 只跳 host 边界，由 host index 恢复 remembered workspace，**禁止直接跳 workspace 叶子**。

<details>
<summary>架构速查表</summary>

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `ActiveConnection` | `runtime/host-runtime.ts` | 五元 union（directTcp/directSocket/directPipe/remoteSsh/relay） |
| `selectBestConnection` | `runtime/host-runtime.ts` | 并发探测候选取最优 |
| `session-store` | `stores/session-store.ts` | per-server agents map + timeline 状态（游标/head/tail） |
| `workspace-layout-store` | `stores/workspace-layout-store.ts` | persist middleware，key `serverId:workspaceId` |
| `createViewedTimelineOwner` | `timeline/viewed-timeline-sync.ts:368` | 流事件入队 owner |
| `createSessionAgentStreamReducerQueue` | `timeline/session-stream-reducers.ts:1910` | 按 agentId 攒批 + rAF/timer 竞速 flush |
| `computeRevealStep` | `agent-stream/text-reveal.ts` | paced reveal 步长（∝ backlog） |
| `layoutStream` | `agent-stream/layout.ts` | layout item identity（memo 边界） |
| `deriveWorkspaceAgentVisibility` | `workspace-tabs/agent-visibility.ts` | tab ↔ archive 桥接 |
| `strategy-resolver.ts` | `agent-stream/` | web 虚拟化 vs native inverted FlatList 二分 |

</details>

## 核心实现

### 连接：host-runtime 与五元 union

`runtime/host-runtime.ts`（85.7KB）是连接生命周期的核心。`ActiveConnection` 是五元 discriminated union：`directTcp`（远程 daemon 的 host:port）/`directSocket`（本机 Unix socket）/`directPipe`（Windows named pipe）/`remoteSsh`（SSH 隧道）/`relay`（E2EE 中继）——一个 host 可以有多条候选连接，`selectBestConnection` 并发探测取最优。host registry 从 AsyncStorage 经 zod 校验恢复（`StoredHostRegistrySchema`）。真正消费 daemon 的是 `@getpaseo/client` 的 `DaemonClient`（06 篇对内引擎），WebSocket 工厂按平台分裂（`runtime/websocket-factory.ts` / `.web.ts`）。

### 状态管理：双轨分界

**zustand 管 UI 会话态，React Query 管可重取的服务端态**，分界清晰：

- `stores/session-store.ts`（59.8K）：`create()` + `subscribeWithSelector`，持有 per-server 的 agents map（`Agent` 含 `archivedAt`、`parentAgentId`、`turn: TurnLiveness`）、workspace/project 描述符、每个 agent 的 timeline 状态（`agentStreamHead/tail/timelineCursor`）；
- `stores/workspace-layout-store.ts`（68.3K）：`persist` middleware，key 为 `serverId:workspaceId`（`buildWorkspaceTabPersistenceKey`），落盘前过 `WorkspaceLayoutPersistedStateSchema.safeParse` + `stripEphemeralTabsFromLayout`（commit_diff 等临时 tab 不持久化），带版本化 `migrate`；
- React Query（`src/data/query-client.ts` + `push-router.ts`）：断连重连后失效缓存。

### 流式渲染管线：两层平滑

这是 App 最精巧的部分（对照 `docs/agent-stream-performance.md`）。事件路径：`contexts/session-context.tsx:519` 的 `client.on("agent_stream", ...)` → `owner.enqueueStreamEvent()` → `createSessionAgentStreamReducerQueue`（`session-stream-reducers.ts:1910`）。为什么在手机上能平滑？**三层独立机制**：

1. **reducer 队列按帧提交**：`createAgentStreamReducerQueue`（`:1748`）按 agentId 攒批，`scheduleAgentStreamReducerFlush` 让 `requestAnimationFrame` 与 48ms `setTimeout`（`AGENT_STREAM_REDUCER_FLUSH_DELAY_MS = 16*3`）竞速——帧回调对齐 paint 节拍；隐藏 tab 帧不触发，timer 兜底使 store 永远前进；
2. **paced reveal**：store 存全文，只有渲染切片被限速。`agent-stream/text-reveal.ts` 的纯函数 `computeRevealStep`：步长 ∝ backlog / 150ms horizon（`TEXT_REVEAL_HORIZON_MS`）——burst 让追赶加速而非跳变。**arrival 决定 target，reveal 速率由 backlog 推导**，这是平滑的本质。首次见到的文本整段显示（history hydration/虚拟行重挂载无需特判）；phase 离开 `streaming` 立即 snap。`hooks/use-revealed-text.ts` 只负责 rAF 时钟；
3. **memo 边界**：`agent-stream/layout.ts` 的 `layoutStream` 保持 layout item identity，`HistoryStreamRow` 双重 memo——否则 inverted FlatList 每次 prepend 会让 ~50 个挂载行全量重渲（100–250ms/帧）。

加上 daemon 侧的 60ms coalescer（02 篇），一条 assistant 消息从 provider 到手机屏幕经过了 **daemon 合批 → wire → reducer 攒批 → paced reveal** 四级平滑管线。渲染策略在 `strategy-resolver.ts` 二分：web 用自研 `strategy-web.tsx`（web-virtualization.ts 虚拟化），native 用 `strategy-native.tsx`（inverted FlatList）。

### workspace-tabs：14 种 tab 与 archive 桥接

`workspace-tabs/model.ts`：`WorkspaceTab {tabId, target: WorkspaceTabTarget}`，target 是 14 种 kind 的 discriminated union（`agent`/`draft`/`terminal`/`browser`/`provider_subagent`/`changes_tree`/`files`/`pull_request`/`working_diff`/`plugin`/`setup`/`commit_diff`…）。**tab 是纯客户端 UI 态，archive 是 daemon 侧持久生命周期**——桥接点是 `workspace-tabs/agent-visibility.ts` 的 `deriveWorkspaceAgentVisibility`：按 `archivedAt` 分出 `activeAgentIds` 与 `knownAgentIds`，root agent 进 `autoOpenAgentIds`。规则（`docs/agent-lifecycle.md`）：客户端 hydrate layout 后，**关闭 root agent 的 tab 即触发归档**；subagent 的 tab 关闭是 layout-only（另一个客户端还开着就保护）；跨 workspace subagent 自动开 tab（打开 workspace 不显空）。

### 跨平台策略

`constants/platform.ts`：`isWeb = Platform.OS === "web"`（Electron 下同为 true——desktop 就是 Expo web export 包 Electron 壳，`src/desktop/` 提供 daemon 托管对接、窗口控制、更新）。三分天下：`isWeb`→DOM、`isNative`→Haptics/推送、`isElectron`→文件对话框/标题栏。细粒度分裂用 `.web.ts`/`.native.ts` 后缀文件（websocket 工厂、`runtime/replica-cache/row-store-factory` native 走 SQLite、web 走 IndexedDB）。`mobile-panels/model.ts` 的手势 settle 函数带 `"worklet"` 标注跑在 reanimated UI 线程。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| discriminated union 状态 | `ActiveConnection` 五元 / `WorkspaceTabTarget` 十四元 | 穷尽 switch，拒绝 bag of booleans |
| 双轨状态 | zustand + React Query | 会话态与可重取态的生命周期不同 |
| rAF/timer 竞速 | `scheduleAgentStreamReducerFlush` | 隐藏 tab 也能前进，可见 tab 对齐 paint |
| 纯函数 reveal 步长 | `computeRevealStep` in `agent-stream/text-reveal.ts` | 可单测、无时钟依赖 |
| memo identity | `layoutStream` + `areLayoutItemsEquivalent` | inverted FlatList 的 prepend 重渲防线 |
| 文件级 polyfill 顺序 | `index.ts` | crypto polyfill 必须先于任何 import |

## 模块间交互

- 下游：`@getpaseo/client/internal/daemon-client`（06 篇）直连；protocol（05 篇）的消息类型直接驱动 reducer；
- 上游：Desktop（12 篇）加载本包的 web export；CLI 的 open-project 走 desktop；
- 横向：tab/archive 语义与 02 篇的 daemon 生命周期契约严格对齐（agent-lifecycle.md 是双端共同规范）。

## 扩展方式

- **新增 screen**：`src/app/h/[serverId]/` 加文件 + 在其 `_layout.tsx` 注册 `Stack.Screen`（相对名）+ 全局路由跳回 workspace 统一走 `navigation/workspace-route-navigation.ts` 的 `navigateToWorkspace()`（处理 POP_TO 防隐藏 deck 堆叠）；
- **新增一种 timeline 事件渲染**：protocol 的 timeline item 类型 → `types/stream.ts` 的 reducer（`applyStreamEvent`/`reduceStreamUpdate`，在 `session-stream-reducers.ts` 消费）→ `agent-stream/model.ts` 的 layout 映射 + `areLayoutItemsEquivalent` 加新字段（**漏加则 memo 静默失效**）→ `agent-stream/view.tsx` 行渲染器。

⚠️ 待核实：desktop 的 web export 是否经 `expo export --web` 产物由 Electron 直接加载（scripts 佐证但 Electron 主进程加载路径未逐行读）；relay 连接的 offer fragment 握手细节。
