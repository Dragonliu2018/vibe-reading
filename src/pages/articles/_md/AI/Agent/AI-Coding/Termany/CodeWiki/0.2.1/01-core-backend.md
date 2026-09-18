---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "核心接缝"
date: "2026-09-18T15:41:05+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "ITerminalBackend", "WebSocket"]
description: "packages/core 是 Termany 的单一接缝：ITerminalBackend 六方法契约、非对称 wire 协议（JSON 入 / 裸文本出 / CLOSE 4000 带外退出元数据）、WebSocketBackend 的竞速重试，以及 13 条内置 agent runtime 预设与 revision 迁移机制。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

`packages/core` 只有 322 行、6 个文件、**零 npm 依赖**，却是整个仓库的架构支点。`backend.ts` 文件头注释自称 "The single seam between 'the terminal UI' and 'where the shell actually runs'"：接口之上的所有东西（xterm.js 渲染、tabs、AI 层）在 web / desktop / cloud 间共享，接口之下每个环境自带实现——今天只有 `WebSocketBackend`（连本地或远程 PTY server），Roadmap 里的 `LocalPtyBackend`（进程内 node-pty）是第二个。新增一个 shell 运行位置 = 多写一个实现，UI 永不改变。

它同时收纳了与接缝同源的另外两块共享知识：`AgentRuntimeConfig`（"一个 agent 怎么被启动"的预设表，web/server 两侧都要读）和 `splitAgentRuntimeNotices`（剥离已知 adapter 噪音的纯函数）。零依赖 + TS 源码即入口（`package.json` 的 `main`/`exports` 直指 `src/index.ts`，无构建产物）——web 侧经 `apps/web/vite.config.ts:29` 的 alias `"@termany/core": coreSrc` 直接编译其源码，注释明言 "no build step for the shared"。

## 模块架构

六个文件按"契约 → 实现 → 共享知识"分三层：

```text title="packages/core/src/"
backend.ts           # 契约：ITerminalBackend + ClientMessage + ShellExit + CLOSE 4000 编解码
ws-backend.ts        # 唯一实现：WebSocketBackend（重试/outbox/退出语义）
agentRuntime.ts      # AgentRuntimeConfig 类型 + BUILTIN_RUNTIMES 13 条预设 + revision 迁移
agentDiagnostics.ts  # splitAgentRuntimeNotices：剥离 legacy codex-acp 的预算告警噪音
bot.ts               # BotIdentity：Bot 的用户可配置身份（与模型/runtime 正交）
index.ts             # barrel export
```

`index.ts` 只做 re-export——core 的所有消费者（web 侧 8 处、server 侧 6 处）都从这里拿东西，没有一个文件反向依赖外部包。

## 调用链路

`WebSocketBackend` 从构造到退出的完整生命周期（全部在 `ws-backend.ts`）：

```text
constructor(url, params?)
  └─ params 写入 wsUrl.searchParams（falsy 值跳过）→ connect()
       ├─ new WebSocket(url)
       ├─ onopen   → open = true; everOpened = true; flush(outbox)   ← 竞速分水岭
       ├─ onmessage → typeof e.data === "string" ? dataCb?.(e.data)   ← 零解析透传
       └─ onclose  → disposed? return（静默）
                    ├─ !everOpened && attempts < 8 → 400ms × attempts 线性退避重连
                    ├─ !everOpened && 重试耗尽   → exitCb?.("unable to connect …")
                    └─ everOpened 后的 close     → exitCb?.(undefined, parseShellExit(code, reason))

write / resize / uploadFiles
  └─ send(msg: ClientMessage) → JSON.stringify → open ? ws.send : outbox.push（open 时 flush）
dispose()
  └─ disposed = true → 清 retryTimer → try { ws.close() } catch {}
```

模块级常量 `MAX_CONNECT_ATTEMPTS = 8`、`RETRY_DELAY_MS = 400`（总计约 11 秒）。回调槽各只有一个（`dataCb`/`exitCb`），没有多订阅者——上层 manager 自己做扇出。

方法速查表（`<details>` 折叠）：

<details>
<summary>方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `onData(cb)` | 注册原始输出回调 | 文本帧即终端输出，无封装无解析 |
| `write(data)` | 发送按键 | 经 outbox 缓冲，调用方不关心连接时机 |
| `resize(cols, rows)` | 通知新视口 | clamp 到 ≥1 由 server 侧做 |
| `uploadFiles(paths)` | SSH pane 上传 | 请求走 JSON 帧，实际传输由 server 侧 trzsz 接管 |
| `onExit(cb)` | 退出/失败通知 | reason 仅传输层失败；exit 仅真实会话结束 |
| `dispose()` | 主动关闭 | 置 disposed 保证 onclose 静默 |
| `parseShellExit(code, reason)` | 恢复 ShellExit | undefined = unknown，绝非 clean exit |
| `encodeShellExit(exit)` | 序列化进 CLOSE reason | 上限 123 UTF-8 字节，此 JSON 最坏 ~30 |

</details>

## 核心实现

### ITerminalBackend：六方法契约

```ts title="packages/core/src/backend.ts"
export interface ITerminalBackend {
  onData(cb: (data: string) => void): void;
  write(data: string): void;
  uploadFiles(paths: string[]): void;
  resize(cols: number, rows: number): void;
  onExit(cb: (reason?: string, exit?: ShellExit) => void): void;
  dispose(): void;
}
```

`onExit` 的双参数语义是精心分开的：`reason` 仅在**传输层本身失败**时设置（连不上 server）；`exit` 在 backend 能观察到时携带 shell 的结束方式。这个区分直接驱动了前端的处置策略——`shellExit.ts` 的 `shellExitDisposition()` 据此决定关 pane 还是重启。

### 非对称 wire 协议与 CLOSE 4000

client → server 是 JSON 结构帧（低频控制 + 输入），三种 `ClientMessage`：`{type:"input"}`、`{type:"resize"}`、`{type:"upload-files"}`。server → client **没有 JSON——所有文本帧都是原始终端输出**。退出元数据走第三条通道：

```ts title="packages/core/src/backend.ts"
export const SHELL_EXIT_CLOSE_CODE = 4000;   // WebSocket 私有应用段 4000-4999

export function encodeShellExit(exit: ShellExit): string {
  return JSON.stringify({ exitCode: exit.exitCode, signal: exit.signal ?? 0 });
}

export function parseShellExit(code: number, reason: string): ShellExit | undefined {
  if (code !== SHELL_EXIT_CLOSE_CODE || !reason) return undefined;
  /* JSON.parse → 逐字段防御性校验 → 不合法返回 undefined */
}
```

为什么退出不走数据流？`backend.ts` 的 doc comment 给出答案：每个 server→client 文本帧都是 raw 终端输出，**任何带内哨兵都可能撞上 shell 合法打印的字节**（`cat` 一个二进制文件、恰好等于 sentinel 的编译输出）。CLOSE 帧是唯一不会被误认成终端输出的通道，而 4000-4999 是 WebSocket 保留给私有应用的码段——"only THIS code means 'the shell ended and here is how'"。`parseShellExit` 的 undefined 契约覆盖三种"无信息"情况：老 server、传输层 close、reason 截断——调用方必须当 unknown 处理，绝不当 clean exit。

Server 侧对端（`apps/server/src/index.ts:511-519` 的 `pty.onExit`）：先发一条 `[termany] shell exited …` 转义文本行（仅本地 shell），再 `ws.close(SHELL_EXIT_CLOSE_CODE, encodeShellExit(...))`。

### 竞速重试：everOpened 分水岭

`ws-backend.ts` 头注释解释重试只针对**初次**连接：bundled PTY server 与 webview 并行启动，可能输掉几百毫秒的竞速，此时宣布会话死亡是错误的；而 "Once a connection has opened, a close is a real exit"。`everOpened` 布尔就是这条语义的分水岭——它同时决定了 onclose 走哪个 `exitCb` 分支、以及退避计时器是否重臂。

### BUILTIN_RUNTIMES：13 条预设与 revision 迁移

`agentRuntime.ts` 的预设表是 web/server 共享的 agent 启动知识：

```ts title="packages/core/src/agentRuntime.ts"
export const AGENT_RUNTIME_REVISION = 6;

const BUILTIN_RUNTIMES: Record<string, RuntimePreset> = {
  claude:   managed("claude-agent-acp", 1),          // Termany 打包的 bridge
  codex:    managed("codex-acp", 1),
  opencode: stdio("opencode", "acp", 1),             // 用户 PATH 上的 CLI
  gemini:   stdio("gemini", "--acp", 2),
  kimi:     stdio("kimi", "acp", 2),
  kilocode: stdio("kilo", "acp", 2),
  cursor:   stdio("cursor-agent", "acp", 2),
  openclaw: stdio("openclaw", "acp", 3),
  hermes:   stdio("hermes", "acp", 3),
  omp:      stdio("omp", "acp", 3),
  droid:    stdio("droid", "exec --output-format acp-daemon", 3),
  fastclaw: { protocol: "acp-http", endpoint: "http://127.0.0.1:18953/acp", apiKey: "" },  // rev 4
  grok:     stdio("grok", "agent stdio", 5),
};
```

每条预设带私有 `revision` 字段（引入版本）。`inheritsDefaultAgentRuntime({id, runtime?, runtimeRevision?})` 用它做合并仲裁，17-18 行注释写明设计目标："The introduction revision is per agent: **adding a new adapter must not re-enable an older adapter that the user explicitly turned off**"——用户存档没有 `runtime` 字段、且 `runtimeRevision` 早于该预设的引入版，才跟随新默认；显式配置过的归用户所有；**`BUILTIN_RUNTIMES` 里没有该 id 时返回 false**（不继承任何默认）。配套的 `defaultAgentRuntime(id)` 用 `Object.prototype.hasOwnProperty.call` 做原型链安全查找（防 `"toString"` 之类的键误命中），命中则**解构剥掉 `revision` 字段**返回纯 `AgentRuntimeConfig`（revision 是内部仲裁数据，不该外露到用户配置），未知 id 返回 `undefined`。

两个 legacy 精确匹配函数处理历史形态：`isLegacyNpxRuntime` 把早期"系统 `npx -y @agentclientprotocol/claude-agent-acp`（及 codex 同款）"的配置迁到打包 bridge——匹配条件是 command 精确等于 `npx`、args 精确等于 `-y <packageName>`，且 `distribution` 为 `undefined` 或 `"system"`、`modelSource` 为 `undefined` 或 `"agent"` 都算宽容命中，只认 claude 与 codex 两家包名（BUILTIN_RUNTIMES 注释："avoids requiring system Node/npx or downloading a second agent binary"）；`isLegacyFastClawRuntime` 把 FastClaw 旧的 stdio 预设（`command === "fastclaw" && args === "acp"`）标记为继承（CLI 改成 HTTP 网关后旧命令永远无法工作）。两者都只匹配**精确等于**旧内置预设的配置——custom 命令原地不动。

### 三种 distribution 与 acp-http

`AgentRuntimeConfig` 是判别联合：`protocol: "acp"` 形态带 `distribution: "managed" | "system" | "custom"`（Termany 打包 bridge / 用户 PATH CLI / 用户手写）和正交的 `modelSource: "termany" | "agent"`；`protocol: "acp-http"` 形态是 "BeeAI Agent Communication Protocol 0.2 over HTTP/SSE"（`{endpoint, apiKey}`，目前仅 fastclaw 用，server 侧对应 `fastClawRuntime.ts`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 端口-适配器 | `ITerminalBackend`（backend.ts）+ `WebSocketBackend` + `DemoBackend`（web/demo.ts） | 换环境零 UI 改动的全部机制 |
| 带外元数据通道 | `SHELL_EXIT_CLOSE_CODE`/`encodeShellExit`/`parseShellExit` | 协议数据与控制元数据物理隔离 |
| 版本化默认值 + 精确迁移 | `RuntimePreset.revision` + `inheritsDefaultAgentRuntime` + `isLegacy*Runtime` | 用户配置与内置默认的合并策略 |
| 白名单式噪音剥离 | `splitAgentRuntimeNotices`（agentDiagnostics.ts） | 只剥**已知**的 `CODEX_SKILL_BUDGET_NOTICE` 前缀；`while` 循环条件是内容 trimStart 后仍以该通知开头（可连续剥多条），但剩余部分存在且**不以空白开头就 break**——防止通知后紧跟正文无分隔时把回复本体误切掉；普通 warning/引用/代码属于回复本体必须保留，宁可漏剥不可误剥 |

## 模块间交互

**Web 侧 import**：`terminal/manager.ts`（`WebSocketBackend` + `ITerminalBackend`，唯一 new backend 的地方）、`terminal/shellExit.ts`（`ShellExit` 类型）、`agents.ts`（`defaultAgentRuntime` 等）、`AgentSettings.tsx`、`AgentPane.tsx`（`BotIdentity`）、`agentMessages.ts`（`splitAgentRuntimeNotices`）、`demo.ts`（接口注入 mock）。

**Server 侧 import**：`agentConfig.ts`（revision 机制）、`botIdentity.ts`、`nativeAcp.ts`/`geminiAuth.ts`（`defaultAgentRuntime`）、`acpRuntime.ts`（`splitAgentRuntimeNotices`）。

**例外**：`apps/server/src/index.ts`（76KB 主文件）**不 import core**——它手工镜像了 `ClientMessage` 类型、`SHELL_EXIT_CLOSE_CODE` 和 `encodeShellExit`（约 230-246 行），注释说明原因："kept in sync by hand because this server bundles standalone (see scripts/bundle-server.mjs) and does not depend on the workspace package"。改 wire 协议必须手动同步这一处，漏改是新消息静默失效的最可能路径。

## 扩展方式

**新增一个 backend 实现（如桌面 `LocalPtyBackend`）**：新建 `local-pty-backend.ts` implements 六方法 → `index.ts` 加 export → `apps/web/src/terminal/manager.ts` 的 `spawnBackend()` 按环境选择。UI 层零改动。

**新增一个内置 agent runtime**：`BUILTIN_RUNTIMES` 加条目，revision 填**当前** `AGENT_RUNTIME_REVISION`——填低了会让 revision 更早的用户配置被误判为该跟随内置默认。旧形态迁移在 `inheritsDefaultAgentRuntime` 加第三个 `isLegacyXxxRuntime` 分支。注意 `AGENT_RUNTIME_REVISION` 只在**内置默认本身变更**时递增，单纯新增条目不必动。

**修改 wire 协议**：同时改两处真相——`backend.ts` 的 `ClientMessage` 联合 + `ws-backend.ts` 的发送路径，以及 `apps/server/src/index.ts` 的手工镜像（类型 + `applyClientMessage` 分支）。
