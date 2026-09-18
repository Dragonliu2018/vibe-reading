---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "PTY 服务"
date: "2026-09-18T15:43:12+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "node-pty", "SQLite"]
description: "apps/server 是单进程三合一：node-pty over WebSocket 的 PTY host、~40 个端点的零框架 REST 路由、node:sqlite 会话持久化。wireSession 装配线、shell 寿命大于连接寿命的 detach 语义、ScrollRing 三重落库、trzsz 带内传输管线。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

`apps/server` 是 Termany 的本地 Node 服务，~11k 行承载三件事：**PTY host**（node-pty over WebSocket，一个连接 = 一个 shell 会话）、**全部 REST API**（~40 个端点）、**会话持久化**（`node:sqlite` 的 `DatabaseSync` 写 `~/.termany/termany.db`）。运行时依赖只有 8 个包（node-pty / trzsz / undici / ws / ACP SDK / Anthropic SDK 等）——没有 express，路由是 `createServer()` 回调里一条 **if-else 顺序匹配链**（`apps/server/src/index.ts`，2019 行）。

这个 2019 行的 god file 是刻意的：`index.ts:140-147` 注释写明 "Today it runs locally and spawns a shell on this machine. The SAME server, moved behind auth + a container-per-session sandbox, becomes the cloud backend — the web frontend doesn't change a line."——它是 `ITerminalBackend` 接缝背后的那台机器。文件顶部还有一处全局性动作：`setGlobalDispatcher(new EnvHttpProxyAgent())`（index.ts:1-5），因为 Node 全局 fetch 默认不读代理环境变量，这行让 api.anthropic.com 被区域封锁的用户能走 `HTTPS_PROXY`。

## 模块架构

index.ts 是总装车间，20 个本地模块几乎全部被它直接 import；ACP 子系统在其后又藏了两层（`agentCredentials`/`agentProcess`/`acpConfigCompatibility`/`fastClawRuntime` 只被 `acpRuntime.ts` 引用）：

```text title="apps/server/src/ 的层次"
index.ts（2019 行）
├── HTTP server + WebSocketServer（同一 http 实例，一个端口双协议）
├── ~40 REST 路由（if-else 链）           ← sessions / fs / git / agents / ssh / system / theme
├── wss.on("connection") → reattach 或 spawn → wireSession()
├── db.ts          node:sqlite · 5 张表 · WAL · 单事务批量 upsert
├── ptyEnvironment.ts / shellPath.ts     PTY 环境注入 / login-shell PATH 解析
├── fileTransfer.ts + trzszFilter.ts     带内传输协议 plug 链
├── config.ts / theme.ts                 KV 配置 / AI 生成主题
└── （域模块）agentActivity / agentSessions / git / ssh / sshPortForwarding /
    systemStats / sessionPorts / foregroundJob / filePicker / folderPicker …
```

端口：`DEFAULT_PORT` 5174（dev 5175，靠 `npm_lifecycle_event === "dev"` 区分，避免与已安装的 Termany.app 抢端口）；`EADDRINUSE` 时 5 次 × 300ms 重试（`tryListen()`）。`__TERMANY_VERSION__` 由 `scripts/bundle-server.mjs` 用 esbuild `--define` 烧进 bundle，桌面端启动时靠 `/api/version` 比对决定能否复用旧 server。

## 调用链路

PTY 会话从 WebSocket 连接到 shell 退出的完整链路（`wss.on("connection")`，index.ts:1787-1987）：

```text
连接（URL query: ?session=&ssh=&agent=&cwdFrom=）
├─ reattach 分支：ptySessions 有同 id 且 sshTarget 匹配
│    → 顶掉旧 ws、重挂 handler（shell 不重启）                 ← index.ts:1800-1850
├─ 目标变了（local↔SSH / hostA↔hostB）→ killSession + 全新 spawn
├─ resolveSpawnCwd(cwdFrom, sessionId, followForeground=true)  ← index.ts:1720-1740
│    活 PTY cwd > DB 存量 cwd > home；FG_CWD_PROCS 白名单（仅 claude）允许
│    前台进程 cwd 覆盖 shell cwd（claude -w chdir 进 worktree 后 split 应落 worktree）
├─ spawn(sshArgs ? "ssh" : SHELL, …, {env: ptyEnvironment(...)})  ← index.ts:1951-1959
├─ sshPortForwarding.register(sessionId, …)
└─ wireSession(sessionId, session)                              ← index.ts:469-537

wireSession 装配线（四件事）
├─ sampleOnceOutputSettles()：输出静默 150ms 后采前台进程 → noteForegroundJob
├─ emit(data) 单一出口：ws.send + ringAppend + noteOutput + jobSampler.noteOutput
│   （Windows 另有 trackOscCwd 从输出流抓 OSC 7 cwd）
├─ createTransferPipeline({protocols: sshTarget ? TRANSFER_PROTOCOLS : []})
│    本地 pane 拿空协议数组（纯直通），只有 SSH pane 装 trzsz 过滤器
└─ pty.onExit → dispose sampler → 本地 shell 打灰色退出行
     → ws.close(4000, encodeShellExit(exitCode, signal)) → noteExit
     → sshPortForwarding.remove(id) → dirty ring 落库 → ptySessions.delete
```

方法速查表：

<details>
<summary>关键函数速查</summary>

| 函数 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `wireSession()` | PTY 会话总装配 | emit 单一出口；传输协议只给 SSH pane |
| `emit()` (index.ts:483) | 所有客户端可见字节的必经点 | ring/活动追踪/采样一处接线 |
| `resolveSpawnCwd()` | spawn 目录解析 | 前台 cwd 白名单防 `make -C` 落 temp 目录 |
| `defaultShell()` | 选 shell | `TERMANY_SHELL` > Windows powershell > `$SHELL`/zsh |
| `sanitizeForReplay()` (index.ts:298) | 历史回放消毒 | 剥 trzsz magic/OSC 52/DSR/ED3/RIS/mode-enable |
| `flushScroll()` (index.ts:601) | 10s 定时落库 | 顺带把 ring chunks 合并成单 string |
| `reapDetachedSessions()` | 每小时收尸 | DETACH_TTL 默认 7 天 |
| `shutdown()` (index.ts:1994) | SIGINT/SIGTERM | sweepCwds(800ms) → flushScroll → 杀全部 pty |

</details>

## 核心实现

### 无框架路由与读取工具

路由零依赖：每个分支 `if (req.method === "POST" && reqUrl.pathname === "/api/foo")` 自带 `json()`/`fail()` 闭包。开头统一 `Access-Control-Allow-Origin: *` + OPTIONS 预检（web 前端可能跑在浏览器 tab 而非 Tauri webview）。`readJson()`（1MB 上限）与 `readBuffer()`（20MB 上限）做请求体读取。`/api/version` 的注释（index.ts:1362-1364）点明立场：要 "cheap and dependency-free so it answers even if everything else is broken"。端点按功能分组：sessions/state/scroll（恢复）、fs（list/stat/media/read/write）、git（overview/diffs/worktrees）、agent（acp/chat/sessions/usage/detect）、ssh（profiles/test/forward）、system（stats/kill）、activity（SSE）、models（BYOK）、theme。

### shell 寿命 > WebSocket 寿命

`index.ts:367-376` 注释确立核心语义：**shell 寿命大于 WebSocket 寿命**。`ws.on("close")` 只是 `session.ws = null` + `detachedAt = Date.now()` + dirty ring 冲一次库——PTY 继续跑。真正终结会话的只有两件事：shell 自己退出，或 `POST /api/forget` / DETACH_TTL 到期。这是"关窗重开 shell 还在"的 server 侧基础；README Roadmap 的 "Session reconnect" 指的是前端在 page reload 后主动重连 + scroll replay 的完整闭环（服务端 detach/reattach 机制已就绪）。

### spawn 细节：login shell 与 OSC 7

Unix 下 `SHELL_ARGS = ["-l"]`（index.ts:206-208）——login shell 跑 `/etc/zprofile` + `~/.zprofile`（brew shellenv、fnm/pyenv），否则从 GUI app 继承的最小 PATH 会让用户 profile 全部 "command not found"。Windows 下 powershell 以 `-NoLogo -NoProfile -NoExit -Command OSC7_PS_HOOK` 启动：重写 `prompt` 函数，每次画 prompt 前发 **OSC 7**（file:// URI 报 cwd，iTerm2/VS Code 同款约定），`trackOscCwd()`（index.ts:217-229）从原始输出抓取存 `oscCwdByPid`——因为 Windows 既没有 `/proc/pid/cwd` 也没有 `lsof -d cwd`。`-NoProfile` 防用户 profile（Conda 初始化）让打包的无头 app 卡几分钟。

连接建立后 `ws._socket.setNoDelay(true)` 关 Nagle（否则小写入被 TCP 合并延迟 ~40ms）；客户端消息在 cwd 异步查询期间先进 `pendingMessages`，spawn 完成后回放（index.ts:1862-1886）。

### 持久化：SQLite 与 ScrollRing

五张表（db.ts:23-28）：`workspace`（每工作区一行布局）、`app_meta`（models/agents/userProfile 等 KV）、`session_cwd`、`session_scroll`（原始 PTY 输出尾）、`session_screen`（TUI 退出时的最终屏幕文本）。`PRAGMA journal_mode=WAL + synchronous=NORMAL`——WAL 让周期性 scroll flush 便宜；db.ts:6-13 注释自比 "the same shape Wave/Warp use: the backend owns a single .db as the source of truth (not the webview's localStorage)"。无 ORM，手写 prepared statement + 单事务批量 upsert（`setScrollBatch`，db.ts:193-209）。启动时把 scroll/screen 各裁到最新 40 行。

**Ring 机制**（index.ts:248-290）：每个活会话一条 `ScrollRing`（chunk 数组），`newRing(sessionId)` 从 `getScroll()` 播种所以跨启动**拼接**。上限 `SCROLL_CAP = 512KB`，溢出从头整块丢、再切到行边界（防 replay 从半个转义序列中间开始）。落库三重时机：10s 定时 `flushScroll()`、每次 detach/close、前端 pagehide 的 sendBeacon → `POST /api/scroll/flush`（app 退出可能 SIGKILL server，定时 flush 不够）。

**screen 快照**：TUI（claude/vim/htop）死在 alternate screen 时主屏 history 是空的（alt screen 按 terminal 语义在 replay 时丢弃）——前端在退出时抓可见屏纯文本，经 beacon 传给 `setScreenBatch()`；恢复时接在 raw history 之后（`── screen at last quit ──` 分隔）。

**cwd 持久化**：`sweepCwds()` 每 5 秒把活会话 cwd 写库——app 可能被 SIGKILL，不能依赖 shutdown hook。`cwdForPid()`（index.ts:1600-1617）三平台：Linux `/proc/<pid>/cwd`、macOS `lsof -a -d cwd -p <pid>`、Windows 回落 OSC 7 map。

### trzsz：与 shell 共享字节流的传输

`TRANSFER_PROTOCOLS` 目前只有 `trzszProtocol` 一个 plug。`fileTransfer.ts:3-13` 的架构注释讲清约束：跨 SSH 没有别的通道能回到人所在的机器，传输协议必须**与 shell 共享同一条字节流**——形态都一样（远端打印握手 → 本地端接管流 → 读/写本地文件 → 画进度条 → 交还流），只差字节，所以 terminal 侧写一次 `TransferProtocol` 接口，每个协议是一个 plug："a transfer begins because the stream said so, not because someone typed `tsz`"。

`createTransferPipeline()` 把协议**从 client 端向 shell 反向叠成链**而非中央 dispatcher——握手要到携带它的字节到达后一瞬间才被识别，dispatcher 得猜中间那拍该谁管，而 filter 本来就直通不认识的东西。`fromClient` 返回 bool（true = 传输中按键被协议吞掉）。`TransferProtocol.magic` 接口约定为**不带 `g` 标志**的正则（单次锚定匹配）；`stripTransferMagic()` 把 scrollback 里残留的握手序列剥掉再 replay——否则恢复 pane 时新 filter 会把历史里的握手当成"远端在请求传输"弹出没人发起的对话框；它为每个协议**复制一份带 `g` flag 的正则副本**（共享全局正则的 `lastIndex` 会在调用者间串味）。两个工程细节：npm trzsz 包是 UMD/CJS 动态 exports，用 default import 兼 esbuild 内联；只用 text/base64 模式，因为 PTY↔WebSocket 管线是 UTF-8 文本通道，二进制模式的非 ASCII 字节会损坏。握手魔术序列为 `ESC 7 BEL ::TRZSZ:TRANSFER:[SRD]:<版本号>[:<size>] 换行`（`/\x1b7\x07::TRZSZ:TRANSFER:[SRD]:[\d.]+(?::\d+)?\r?\n/`，trzszFilter.ts:38）。

### ptyEnvironment 与 shellPath

`ptyEnvironment()`（ptyEnvironment.ts:20-40）注入 `TERM=xterm-256color` 和 `TERMANY_PANE_ID`（对标 `ITERM_SESSION_ID`/`TMUX_PANE`），并做 locale 修复——Finder 启动的打包 app 常无 LANG，zsh 回落单字节 locale 会把 IME 的 UTF-8 输入渲染成替换字符。修复逻辑：已任一 UTF-8 locale 则不动；否则删非 UTF-8 的 `LC_ALL`（LC_ALL 会压过 LC_CTYPE）、设 `LC_CTYPE=en_US.UTF-8`（darwin）/`C.UTF-8`（其余）、无 LANG 时补上——只在字符分类类别修，不动用户语言；**Windows 直接返回不做修复**（`if (platform === "win32") return env`）。`removePackageManagerLifecycleEnvironment()` 剥掉 `npm_config_*`/`npm_package_*`/`npm_lifecycle_*` 变量，否则交互 shell 里后续每个 npm 命令都会把启动器的 pnpm 配置当自己的——**只在检测到 `npm_lifecycle_event` 等 marker 时才清**（打包版 app 由 Finder 启动、没有这些标记，天然不需要清理；刻意启动传 npm 变量的用户不受影响）。

`shellPath.ts` 解决 PTY 之外 spawn 命令（agent CLI 等）的 PATH 问题：`loginShellValue()` 先 `-lc` 再 `-lic` 求值（非交互 zsh **跳过 ~/.zshrc**，而那正是 CLI installer 加 PATH 的地方），求值用 MARKER 标记包裹防止 rc 文件输出干扰、结果进程级缓存；`resolveExecutable()` 调 `isRunnable()` 时还读 shebang 验证解释器仍存在（X_OK 通过但 ENOENT 的 uv/pipx 工具，Homebrew 换 Python 后常见）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单一出口 | `emit()`（index.ts:483） | 输出、持久化、活动追踪、采样一处接线，新消费者零遗漏 |
| 协议 plug 链 | `createTransferPipeline`（fileTransfer.ts:87-126） | 带内协议识别天然适合 filter 链而非 dispatcher |
| SSE 全量快照自愈 | activity/state 事件流（index.ts:425-462） | 推完整快照而非增量，断线重连不用补事件序列；`clientId` 让写者忽略自己的回声 |
| 三平台策略函数 | `cwdForPid()`、`memoryStats()` 等 | 差异内聚在单个函数，调用方无感 |
| best-effort 降级 | 端口探测、`repo: false` 空态 | 能力缺失返回空而非报错，按钮干脆不出现 |

## 模块间交互

被 `index.ts` 直接 import 的 20 个模块见模块架构图；`trzszFilter` 只被 `fileTransfer` 引用，`agentCredentials`/`agentProcess`/`acpConfigCompatibility`/`fastClawRuntime` 只被 `acpRuntime` 引用——index.ts 只见 acpRuntime 一个 ACP 门面。对 core 包的关系是"手工镜像"而非 import（见[核心接缝](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/01-core-backend)的例外说明）。上游消费者：web 的 `WebSocketBackend`（WS 协议）与全部 fetch 调用（REST），desktop 的 `spawn_server_child()`（进程看护）。

## 扩展方式

**新增 REST 端点**：index.ts 的 if-else 链加分支，模式固定（`readJson(req).then(body => json(200, …)).catch(fail)`）；逻辑重抽独立文件加进顶部 import。

**新增一种持久化状态**：`db.ts` 加表（或塞 `app_meta` KV）+ getter/批量 upsert（仿 `setScrollBatch` 的事务模板）；需随会话遗忘则加进 `forgetSessions()` 的 DELETE；app 可能被 SIGKILL 就补 interval + `.unref()` + pagehide beacon 通道。

**改 PTY 环境注入**：单点改 `ptyEnvironment()`（唯一调用点是 spawn 处），`ptyEnvironment.test.ts` 有 103 行现成测试覆盖 locale 修复/lifecycle 剥离/`TERMANY_PANE_ID` 各场景。
