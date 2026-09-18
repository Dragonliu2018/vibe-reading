---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "终端引擎"
date: "2026-09-18T15:54:33+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "xterm.js", "IME"]
description: "terminal/manager.ts 把 xterm 实例池放在 React 之外的模块级 Map（后台 tab 保活 scrollback）；OSC52 剪贴板处理、glyph atlas 修复、三平台 IME 状态机、滚动竞态防御、Ctrl+L 而非 term.clear()——一屋子宿主引擎怪癖的收容所。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

`terminal/manager.ts`（2281 行）是 Termany 的终端渲染引擎核心。它要兑现 README 的承诺："Every tab is a persistent session: it keeps running, and keeps its scrollback, while backgrounded."。实现方式是第一设计决策（文件头注释 manager.ts:35-43）：**Session 活在 React 之外**——所有会话存在模块级 `Map`（manager.ts:187），React 组件（`TerminalPane.tsx`）只做三件事：提供宿主 div、attach/detach、ResizeObserver→`fitSession`。后台 tab 卸载组件时 shell 与 scrollback 不丢；React 重渲染也永远不触碰 xterm 自管的 canvas/textarea。

另有一个硬约束驱动了创建时机：xterm 的 `open()` 必须在**已在 document 里的元素**上调用，否则渲染器初始化错误、"只画得出光标"——所以创建在 `getSession()`，`open()` 推迟到 `attachSession()`。

## 模块架构

```text title="terminal/ 的分工"
manager.ts（2281 行）
├─ sessions Map（会话池）+ activeSessionByPane / sessionIdsByPane（pane 路由）
├─ getSession()（幂等会话工厂，~300 行）→ spawnBackend()（WebSocketBackend / DemoBackend 二选一）
│    └─ wireBackend()：onData → writeSessionData；onExit → SSH 标记 / 重启 / close-pane
├─ attachSession()/detachSession()：host.appendChild(s.el) 移入移出，会话继续活
├─ 屏幕活动消费：completeAgentActivityIfIdle（喂 AgentIdleWatcher）
└─ 滚动/焦点/链接/字体/atlas/IME 一屋子宿主怪癖修复
agentActivityPrompt.ts / agentIdleWatcher.ts   屏幕分析（见活动与会话历史模块）
osc52.ts shellExit.ts webLinks.ts localLinks.ts scroll.ts fonts.ts glyphAtlas.ts
imeGuard.ts webkitGtkIme.ts nativeViewOcclusion.ts
```

## 调用链路

Session 的挂载/路由/数据流：

```text
TerminalPane.tsx mount → attachSession(sessionId, host, cwdFrom, sshTarget, paneId)
  ├─ 登记 activeSessionByPane（pane→当前会话）+ sessionIdsByPane（pane 拥有的全部会话：
  │   本地 + 多个 SSH 并存但只挂载一个）
  ├─ host.appendChild(s.el)（Session 自有的 el 移进宿主容器）
  ├─ 首次 attach 才 term.open(s.el) + WebglAddon + 三个 IME 修复 + 选择/粘贴监听
  └─ attach 故意不 focus（:1793-1798 注释：一次 tab 切换挂多个会话，挂载顺序不得决定键盘归属）

所有导出 API 第一行做归一化：activeSessionId(paneId) ?? paneId
  （fitSession / focusSession / scrollSessionToTop … 调用方传 paneId 或 session id 都行）

数据流：backend.onData → writeSessionData（滚动冷却判断）→ term.write(data, finishSessionWrite)
  finishSessionWrite：flushShellReadyCommands → completeAgentActivityIfIdle
                      → follow-output 吸底或恢复锁定视口
```

方法速查表：

<details>
<summary>关键函数速查</summary>

| 函数 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `getSession()` | 幂等会话工厂 + 历史回放 | `restoreSnapshots` 后做转义序列"中和"重置 |
| `attachSession()` | 挂进宿主 DOM | 移动 `s.el` 而非重建；不抢焦点 |
| `wireBackend()` | 接 backend 两回调 | onExit 分 SSH/重启/close-pane 三路 |
| `writeSessionData()` | 输出写入口 | 手动滚动 500ms 冷却内扣住不发 |
| `clearSession()` | 清屏 | 发 Ctrl+L 而非 `term.clear()` |
| `reconcileTerminalFocus()` | 焦点单一真源 | 非目标先 blur 后 focus 目标 |
| `spawnBackend()` | backend 选择 | WebSocketBackend vs DemoBackend |

</details>

## 核心实现

### 历史回放的中和重置

`getSession()` 创建会话时回放 SQLite 快照（`restoreSnapshots` + manager.ts:1424-1463）：死 shell 留下的 alt screen/鼠标上报/滚动态不能污染新 shell——一套复杂的转义序列"中和"逻辑，`?1049l`（退出 alt screen）只在回放确实结束于 alt screen 时发送，否则会执行 stale cursor restore。

### 链接：跨行拼接与服务器验证

不用 xterm 自带 WebLinksAddon，而是自定义 `ILinkProvider` 两套：`registerWebLinks`（webLinks.ts:135-145）只匹配 `http(s)://`（`new URL()` 二次校验 protocol），**Cmd+click** 才 activate；核心增强是 `mapLine`/`continues`/`computeWebLinks` 把被 rich CLI 硬换行（CRLF 或顶满终端宽）截断的 URL **跨 ≤16 行拼接**后再匹配。`registerLocalPathLinks`（localLinks.ts:196-218）：三个正则（FILE_URL/WINDOWS_PATH/UNIX_PATH，相对路径须 ≥2 段——单个裸词不是路径），候选经 `resolvePaths` 回调 **POST `/api/resolve-paths` 让服务器对着该 shell 的 live cwd stat 验证**，5 秒 TTL 缓存避免 hover 反复 stat。URL provider 先注册，防 URL 路径段被当文件。

### 字体与 glyph atlas 修复

`fonts.ts`：`Symbols Nerd Font Mono` 被 splice 进字体栈（在所有真实 family 之后、generic 关键字之前）——powerlevel10k/starship 输出的 Nerd Font PUA 字形在系统等宽字体里是 tofu，浏览器 per-glyph fallback 保证字母来自主字体、只有图标落到 symbols 字体。配套 `refreshOnSymbolsFontLoad()`（manager.ts:1302-1320）：@font-face 异步加载完成后对所有 open 的 terminal `clearTextureAtlas()` + `refresh()`，否则字体到位前画进 atlas 的 tofu 永远留在纹理里。

`glyphAtlas.ts` 的 `createGlyphAtlasRepairer` 修的**不是** GPU 上下文丢失（那是 `onContextLoss(() => webgl.dispose())` 回落 DOM 渲染），而是 xterm **共享 glyph atlas 页合并** bug（文件头长注释 glyphAtlas.ts:1-38）：所有 pane 共享同一 `CharAtlasCache`，但各持独立 WebGL 上下文的 atlas 页 GPU 副本；atlas 页满时合并 4 页成大页、后续页索引整体前移、纹理坐标原地改写——version 比较变成两个无关小整数碰巧相等 → 跳过本应做的上传 → 画出"特定字符变成特定其他字形"，**resize 能治**（即"拖一下 split 就恢复"的症状）。修法：`onAtlasPagesMerged()` 从 WebglAddon 实例读**未导出类型**的 `onRemoveTextureAtlasCanvas` 事件（仅在合并路径触发；官方 typings 里没有，未来版本不再发出则返回 undefined），监听到后对**所有** open 的 terminal `clearTextureAtlas()`（只修一个会把邻居弄花）。节流 2s（`ATLAS_REPAIR_MIN_INTERVAL_MS`）——冷却窗口内的修复请求**被推迟到窗口末尾而非丢弃**（丢弃会让 pane 错乱到下一次合并），一次合并经多个 pane 转发触发数十次请求时合并成一次修。

### 滚动写路径的竞态防御

`writeSessionData`（manager.ts:105-119）把滚轮后 500ms（`MANUAL_SCROLL_COOLDOWN_MS`）内到达的 PTY 数据**扣住不发** `term.write`（上限 1500ms）——因为 xterm 的 `ydisp` 只在原生 scroll 事件异步回程后才更新，间隙内的写会让 xterm 自己的"贴底跟随"把用户拉回底部（manager.ts:62-77 长注释）。TUI 重绘还会偷移 viewport，`finishSessionWrite` 每次写后把 viewport 钉回 `lockedViewportY`。

### 清屏：Ctrl+L 而非 term.clear()

`clearSession`（manager.ts:2015-2040 注释）：`term.clear()` 单方面砍 buffer，会让用相对光标重绘的 TUI（claude/codex）与实际屏幕失步；**Ctrl+L 让正在运行的程序自己重画**。

### OSC 52：剪贴板的安全边界

xterm.js 解析 OSC 52 后直接丢弃（只有 title/颜色 handler），不加 handler Claude Code 等的复制就静默消失。`registerOsc52`（osc52.ts:47-49）补上，规则严格（osc52.ts:60-100）：只认写形式（target `c`/`s`）；空 payload = 清空剪贴板请求 → **吞掉不执行**（"后台 agent 擦掉用户刚复制的东西有百害无一利"）；base64 ≤1.4MB 防 runaway；**读形式 `52;c;?` 拒绝应答**——终端里跑半自主 agent，回读剪贴板是密码外泄通道；写不 await（parser 同步跑在渲染热路径上，等剪贴板会卡住全部终端输出）；两步解码（`Uint8Array.from(atob(...))` + TextDecoder，直接用 atob 的字符串会 mojibake）。

### 三平台 IME 修复

三个独立的宿主引擎怪癖：`useImeGuard`（imeGuard.ts，31 扇入 god）给 React 输入控件防 WebKit 的**事件倒序**（先 `compositionend` 再提交键 keydown，此时 `isComposing` 已 false——中文 IME 下确认输入法的那次 Enter 会顺手提交外围对话框）；四信号合一（自跟踪 composing、isComposing、keyCode 229、compositionend 后 100ms 窗口）。`webkitGtkIme.ts` 整个接管 Linux WebKitGTK + Fcitx5 的组合输入（`createGtkImeCommitMachine` 在 document capture 阶段拦截全部 229 keydown 与 composition 事件，提交文本经 `term.input(data, true)` 恰好送一次）。`isLinuxWebKitGtk()` 与 `isMacWebKit()` 靠平台区分（UA 都是没有 Chrome token 的纯 WebKit）——manager.ts:1650-1661 注释记录了按 UA 匹配导致两修都在 Linux 跑、中文词重复两遍的事故。Mac 侧另有 `fixWebkitImeDirectInsert`（shift 全角标点"按两次才出字"）与 `fixAbandonedImeFinalize`（输入法切换后残留 marked-text 被 flush 成幻影空格）。

### shell 退出的前端处置

`wireBackend` 的 `onExit` → `shellExitDisposition(exit, aliveMs)`（shellExit.ts:38-47）三判据：**信号杀死**（segfault/OOM/kill -9）→ restart；**存活 ≤3s**（`RESTART_HEALTHY_MS`）→ 启动失败 → restart；其余 → close-pane。刻意**不**用 exit code 判定——bash/zsh 在 EOF 时退出码=最后一条命令的状态（Ctrl+D 前 grep 无匹配 → code 1，按码判会复活用户刚要求关闭的 pane）。`exit` undefined（socket 无说明地关闭）→ restart：关 pane 不可逆，需要正面证据。`MAX_AUTO_RESTARTS = 5` 熔断 + 活过 3s 重置计数（上限含义是"连续 5 次"而非"累计"）。**reason 为真时（初次连接重试耗尽的传输层失败）不递增重启计数**——WebSocketBackend 已耗尽自身 8 次重试，这里只写 `[session ended: …]` 后保留死内容。仅 pane 的**前台**会话享受 close-pane（本地 shell 躲在可见 SSH 会话后面时必须活着）。退出事件用 window CustomEvent（`SHELL_EXIT_EVENT`）解循环依赖——store 已 import 本模块，反向 import会成环，且退出的 shell 可能呆在无组件挂载的后台 tab 里。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| God-registry 会话池 | `sessions` Map（manager.ts:187） | 后台保活的实现载体；代价是所有入口穿过 getSession/activeSessionId |
| 命令式 DOM + 订阅式状态 | TerminalPane 只管宿主 div | 终端内容是高频字节流，过 React state 不可行；scroll state 是唯一进 React state 的东西 |
| 焦点单一真源 | `reconcileTerminalFocus` | split 时 React 各 pane effect 无顺序保证；失焦游标用透明色主题躲开 WebGL block cursor 的 cell 色覆盖 |
| 输入副作用链式串行化 | `terminalInputSendChains` | 保证"注册黄点 → 写 Enter"的服务端顺序 |
| 引擎门控互斥 | `isMacWebKit` / `isLinuxWebKitGtk` | 两个 IME 修复同时跑 = 词打两遍 |

## 模块间交互

上游：`SplitView` 的 PaneSlot 挂载 TerminalPane；`store` 的 closeLeaf/disposePaneSessions 经 id 清理会话。下游：`@termany/core` 的 `WebSocketBackend`（唯一 new 点）与 `shellExit` 的 CLOSE 4000 消费。横向：`completeAgentActivityIfIdle` 与 server 的 activity API 交互（见[活动与会话历史](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/04-agent-activity)）；`servedUrls`/`focusHandoff`/`desktopFileDrop` 是三个小的配套监听器。UI 圆点/徽章由组件层消费 `subscribeAgentActivity`。

## 扩展方式

**新增一个 OSC 序列处理**：新文件仿 `registerOsc52(term, write?)` 签名——`term.parser.registerOscHandler(N, data => …)`，handler 同步、返回 false 表示不处理、不 await；在 `getSession()` 创建区（`registerWebLinks`/`registerOsc52`/`registerLocalPathLinks` 三连处）对每个新 Terminal 注册一次。

**新增一个宿主引擎 IME 修复**：纯状态机（hooks 注入便于测试，配 `.test.ts`）+ UA/平台门控（务必与现有两个门控互斥）；在 `attachSession()` 首次 open 块挂载；事件轨迹接 `imeLog`（`?imedebug` overlay）。

**新增一种终端叠加层**：识别信号加进 `agentActivityPrompt.ts` 谓词；`completeAgentActivityIfIdle` 消费新信号并同步 server 协议；视觉叠加本体挂 `TerminalPane.tsx`（绝对定位 div 订阅 `subscribeAgentActivity`），不是画进 xterm canvas。
