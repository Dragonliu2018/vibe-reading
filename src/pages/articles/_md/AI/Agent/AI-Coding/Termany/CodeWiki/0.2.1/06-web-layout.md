---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "状态与布局"
date: "2026-09-18T15:52:10+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "Zustand", "布局"]
description: "Workspace ▸ Page ▸ Tab ▸ Pane 的 Notion 式三段式模型（树节点 + tab 列表 + pane 二叉分裂树），Zustand 单 store selector 订阅；布局真源在 server SQLite，多窗口靠 page 独占实现免版本号的 mergeLayout 合并。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

`state/store.ts`（2563 行）是 web 侧的全局状态：布局（四级嵌套）、Agent 会话收件箱、chrome（主题/键位/rail）。核心设计是文件头自述的 **Notion-style model**——不是单一布局树，而是"多层树 + 每个树节点挂一个 tab 列表 + 每个 tab 挂一棵 pane 二叉分裂树"的三段式。另一个关键决策是**布局真源在 server SQLite**，webview 只是"server state 的反射"（`state/sync.ts:22` 注释）——多窗口共享同一份记录、重启恢复完整布局。

`SplitView.tsx`（889 行）负责渲染侧：递归分裂树、gutter resize、⌘M maximize、拖拽重排；`keybindings.ts`（279 行）是 ~60 个可重绑 action 的目录。

## 模块架构

```text title="三段式布局模型"
Workspace（icon rail，多窗口共享）
└─ TreeNode（sidebar，无限嵌套：既是 page 又是 folder）
     ├─ children: TreeNode[]（任意深度）
     └─ htabs: HTab[]（每个节点自带终端 tab 列表）
          └─ HTab.layout: Pane（二叉分裂树）
               ├─ leaf：{kind:"leaf", id, view?, sshTarget?, agentSession?, …}
               │        ↑ leaf.id 就是 terminal session 注册表里的 session id（store.ts:44 注释）
               └─ split：{kind:"split", dir:"row"|"col", children: Pane[], sizes?}
```

配套小模块各有分工：`paneFocus.ts`（96 行纯函数：MRU 焦点历史）、`paneViewCycle.ts`（⌘E 循环集）、`layoutMerge.ts`（85 行：多窗口合并）、`sync.ts`（278 行：水合 + SSE + debounce 写回）、`windows.ts`（窗口私有偏好，localStorage per-window 前缀 `termany.window.<label>.*`）。

## 调用链路

一个窗口的生命周期与一条改动的传播路径：

```text
启动：waitForServer()（轮询 /api/state ≤12s）→ loadState()（GET 水合 + 旧 localStorage 一次性迁移）
      → adoptView()（落位本窗口 remembered activeNodes）→ 首次 render（main.tsx 保证 render 前完成）

改动：组件调 store action（inActiveWs + updateNode 不可变树改写管道）
      → zustand set 触发 selector 级重渲
      → sync.ts 的 useStore.subscribe → debounced 400ms PUT /api/state（带 clientId）
      → server 整表重写 → SSE /api/state/events 推快照
      → 其他窗口 applyRemoteState()（跳过自己 clientId 的回声；applyingRemote = true 防乒乓）
           → mergeLayout(state.workspaces, remote, ownPage)
                本窗口 own page：本地副本必胜（原位嫁接回远端树）
                其余一切：照抄发送方
```

## 核心实现

### 数据模型与 god 节点

`AgentConversation = Extract<Pane, {kind:"leaf"}> + {…}`（store.ts:192-241）——**Agent 收件箱的一等会话复用了 pane leaf 的全部字段**，注释直言"它和页内 Agent pane 用同一个 leaf 形状，共享一套 chat runtime"。额外字段涵盖群聊（`agentGroup: {memberIds, leadMemberId, runtimeId, topics, activeTopicId}`）、私信（`agentPrivateMessages`）、组织（文件夹/pin/排序/未读计数）。graphify 把它标为 21-edge god node 的原因：群聊、A2A 委托、私信投递、Topic 管理、文件夹组织全部挂在同一个扁平接口上（State 接口约 30 个 `addAgent*/setAgent*/deliverAgent*/organizeAgent*` action）。

几乎全部 action 走同一条不可变树改写管道：`set(s => ({workspaces: inActiveWs(s, ws => ({...ws, roots: updateNode(ws.roots, activeNodeId(s), n => …)}))}))`——`updateNode/removeNode/insertSibling` 等纯函数（store.ts:824-880）做结构共享（`children !== n.children` 才拷贝），让 zustand 的引用相等判断生效。

### 分裂、网格与 retile

`splitFocused()` 调 `splitPane()`（store.ts:532）：**向同方向父 split 合并**（`pane.dir === dir` 时 splice 插入而非新建一层嵌套），保证干净网格；插入/删除子节点时 **sizes 清空为 undefined**（子集变了旧比例作废，回落均分）；上限 `MAX_PANES_PER_TAB = 6`。`addPane` 走 `tileLayout`：flatten 后按 `gridRows(n)` 查表（`[[1],[2],[3],[2,2],[3,2],[3,3]]`）重建均分网格——注释解释 why：逐次追加整高列会让第 5 个 pane 只剩 ~300px。`retilePanes` 循环 `layoutPresets(n)`（均衡网格 → 4 种 main+sidebar → 全列/全行），`shapeKey()` 指纹去重。`nudgeSplit`（⌃⌘方向键）walk 到 focused leaf 沿请求轴**最近的祖先 divider**，STEP=0.03、MIN=0.08 挪一条 gutter。

### 持久化边界

服务端 SQLite 存布局（含 `sshTarget`/agent 会话——leaf 字段注释明说 "Kept in layout state so relaunch reconnects to the same host"）；localStorage 只存窗口私有与偏好（per-window 视点、keybindings、rail 可见性、theme）。Agent 消息持久化有界：`MAX_PERSISTED_AGENT_MESSAGES = 400` 条 + 单条 content 截 12,000 字；`hydrated` 门闩防止从未加载成功的窗口用内存默认值覆盖 SQLite（sync.ts:13-17）。

### layoutMerge：为什么 merge 而不是覆盖

文件头注释（layoutMerge.ts:1-8）给出免版本号的冲突仲裁基础：**"PAGES are exclusive"**——page 一次只归一个窗口（windows.ts + Rust 侧 `claim_page`），所以对本窗口拥有的那个 page 它是唯一写者、副本必胜；其余照抄发送方。这解决了两个真问题：debounce 窗口期丢失（保存是 400ms debounce，"总有几百毫秒的本地修改是别人快照不知道的"，直接覆盖会撤销它们）；整记录重写没有 revision/timestamp（`mergeLayout` 按 id 找 home workspace，把本窗口的 page 子树原位嫁接回远端树；发送方不知道这个 page 就整棵 home workspace 保留本地版）。两个安全网：本窗口 page 被远端删了 → `adoptView("")` 重落位；远端快照没有本窗口 page（说明 server 落后）→ 立即回写。

### SplitView：递归渲染与交互分工

`SplitTree({pane, path})` 递归：leaf → `PaneSlot`，split → flex 容器 + 每 child 包 `.split-cell`（`flexGrow: sizes[i]`）；`path` 是 child-index trail 供 `resizeSplit(path, sizes)` 提交。⌘M maximize：`htab.maximized` 存在且 pane 数 >1 → 底层 SplitTree 保留（被放大 pane 渲染为 ghost 占位，**布局和终端不卸载**）+ `ZenOverlay`（portal 到 body 的暗色 scrim；web pane 是 native child webview 会盖过 DOM，scrim 要 `registerOccluder` 让中间原生视图保持可见）。

交互分工是有意的三层：⌘D/⇧⌘D 分裂纯 store 变换（App.tsx handlers 调 `splitFocused`）；鼠标拖 gutter 在 SplitView（像素换算 + clamp 0.08）；⌥⌘方向键焦点导航 `paneInDirection()`（App.tsx:37-72）**不查布局树而查渲染后的 DOM rects**——注释：树只知道"两个并排"，不知道嵌套分裂+手动 resize 后的几何落位。拖拽重排用 pointer 事件 + `elementFromPoint` 探测四种落点（tab/侧栏页/tab 条空白/pane 边缘），落点高亮直接操作 DOM class（不走 React 状态，避免拖拽中整树重渲）。

### keybindings：目录/行为/持久化三分离

`keybindings.ts` 零 store/UI 依赖，只定义 `ActionDef {id, label, group, default, hideInPalette?, desktopOnly?}` 目录；行为表在 App.tsx 的 `handlers` useMemo（App.tsx:222-296，注释："To add a shortcut: append an entry here and a matching case in App.tsx's handler map"）；override 存 localStorage 叠加在默认之上（新版本新增 action 仍显示默认键）。Chord 匹配基于 `KeyboardEvent.code`（物理键、布局无关）+ **精确修饰符集合**（⌘T 与 ⌘⌥T 是不同 chord，重绑可预测；特例：⌘⇧= 与 ⌘= 在 macOS webview 报告不一致，视为同一快捷键）；跨平台由 `chordForPlatform` 转换——非 mac 把 ⌘→Ctrl、⌃⌘→Ctrl+Alt（防两个修饰符塌缩成一个键）。`hideInPalette`（如 ⌘1-9 切 tab）从 ⌘P palette 隐藏但仍在 Settings 列出；`desktopOnly`（如 newWindow）在浏览器整个卸载。全局派发是 App.tsx 一个 **capture 阶段**的 document keydown 监听，`e.isComposing` 跳过 IME 组合键。⌘P palette 复用同一 `ACTIONS`——命令面板与快捷键设置共用一份目录。

### 为什么选 Zustand

单 `create<State>((set, get) => …)`，无 reducer 样板；15 个模块直接 `useStore(selector)` 精确订阅（如 SplitView 只订 `activeHtab(s)?.focused === leaf.id` 的布尔）——2563 行布局状态下 selector 级订阅避免整 app 重渲；`useStore.getState()` 让非 React 代码（keydown handler、sync.ts、shell 退出回调）命令式读写。复杂纯逻辑抽到独立可测小模块（paneFocus/paneViewCycle/layoutMerge 都带 .test.ts）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变树改写管道 | `updateNode`/`inActiveWs` + 结构共享 | selector 订阅与引用相等判断的前提 |
| 单一焦点真源 | `HTab.focused` + `focusHistory`（paneFocus.ts） | DOM focus 永远由状态推导，React remount 竞态可控 |
| 免版本号合并 | `mergeLayout`（page 独占 = 唯一写者必胜） | 整记录存储下最便宜的冲突仲裁 |
| 目录/行为分离 | `keybindings.ts` vs App.tsx handlers | Settings、palette、tooltip 三处共用一份目录 |
| 会话外置 | terminal/manager 的 Map（见[终端引擎](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/07-web-terminal)） | `moveHTab` 注释："terminal sessions live outside React keyed by id, so this just relocates the HTab object — the shells keep running" |

## 模块间交互

下游消费：`SplitView` 的 PaneSlot 按 `leaf.view` 分发到 TerminalPane/FileTree/GitDiffView/SystemMonitor/AgentHistory/AgentUsage/WebBrowserPane/AgentPane 八种视图；TreeSidebar/HTabBar/SideRail/AgentWorkspace 是四个 UI 骨架消费面。上游：`sync.ts` 的 SSE 流与 PUT 写回连 server；`windows.ts` 的 `takenPages` 只读 Rust 侧 page 仲裁结果。⌘E 循环集 `CYCLABLE_PANE_VIEWS` 与 rail 可见性联动（隐藏的视图跳过）。

## 扩展方式

**新增一种 pane 视图类型（如 docker）**：`PaneView` union 加值 → `paneViewCycle.ts` 的 `CYCLABLE_PANE_VIEWS`（自动进 ⌘E 循环与 pane 菜单顺序）→ `rail-config.ts` 加 rail 项（右栏 + Settings 可见性开关，`normalizeRailVisibility` 保证缺失项默认可见）→ `SideRail.tsx` 加图标 → 新建组件并在 `SplitView.tsx:464-497` 分发链加分支。对应测试 `paneViewCycle.test.ts`、`rail-config.test.ts`。

**新增一个可绑定快捷键 action**：`keybindings.ts` 的 `ACTION_DEFINITIONS` 追加 + App.tsx `handlers` map 加 case——Settings 与 palette 自动出现该行，无需其它改动。

**新增一条布局写入路径**：只需写 store action（走 `inActiveWs + updateNode` 管道），sync 的订阅自动同步。切记不绕过 store 直接 `setState` 大对象（会破坏 own-page 必胜的合并假设），窗口私有状态走 `writeWindowPref`。
