---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "终端子系统"
date: "2026-09-18T00:01:15+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "node-pty", "xterm.js", "Coalescing"]
description: "paseo 终端子系统——node-pty + headless xterm.js 双进程模型（worker 隔离防主循环洪泛）、5ms leading+trailing 输出合批、OSC 633 shell 集成、agent hook 注入与 4 MiB 软背压降级。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/terminal/`（~5,800 行）给 workspace 提供真正的终端：spawn PTY、流式输出到客户端、可被 agent 驱动（09 篇与 04 篇的 terminal 六件套工具相接）。它要同时满足三个苛刻条件：**延迟**（按键回显不能感知延迟）、**保真**（snapshot 重建后终端状态一致）、**隔离**（xterm 解析与 snapshot 序列化不能阻塞 daemon 主循环——agent 流量与终端帧共享同一 event loop）。

## 模块架构

```
terminal-manager-factory.ts            # 唯一入口 createConfiguredTerminalManager()
└── worker-terminal-manager.ts         # daemon 永远走 worker 路径
    └── terminal-worker-process.ts     # fork() + serialization:"advanced" IPC
        └── terminal.ts（47KB）
            ├── createTerminalSession()
            ├── node-pty（pty.spawn）
            └── headless xterm.js 实例（解析输出流 + snapshot 保真）

terminal-session-controller.ts（36KB） # daemon 侧：每客户端 stream 的会话控制器
terminal-output-coalescer.ts           # 5ms leading+trailing 合批（两处实例化）
terminal-restore.ts                    # 4 MiB 软背压 → 全量 snapshot 降级
shell-integration/zsh/                 # OSC 633 注入
agent-hooks/                           # Claude/Codex/OpenCode 生命周期 hook
activity/terminal-activity-tracker.ts  # 终端红点/attention
```

分层三段：接口层（`TerminalManager` 接口）、worker 层（进程隔离）、会话层（`terminal.ts` 的 PTY + xterm 双实例）。

## 调用链路

**一次 PTY 输出到客户端的路径**：

```
node-pty data 事件（worker 进程内）
└── createTerminalSession() in terminal.ts 的输出流
    ├── headless xterm.js 解析（snapshot 保真 + OSC 633/标题解析）
    └── 每终端一个 TerminalOutputCoalescer（IPC 前）
        # 空闲后首 chunk 同步立即 flush（按键回显零延迟）
        # 持续 burst 由 trailing timer 5ms 批量 Buffer.concat
        # ≤ 1 条 process.send / 5ms —— 防 IPC 洪泛
└── IPC → daemon 主进程
    └── terminal-session-controller.ts 的 ActiveTerminalStream.outputCoalescer
        # daemon 侧第二级合批（每客户端 stream 一个）
        └── 二进制帧 → 客户端（4 MiB 软背压检查）
```

非输出消息（snapshot/titleChange/exit）先 `flush()` 保序；批帧带**最后一个 chunk 的 revision**，供 `replayTerminalOutputAfterSnapshot()` 去重。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `createConfiguredTerminalManager()` | `terminal-manager-factory.ts` | 唯一入口（daemon 永远走 worker） |
| `createWorkerTerminalManager()` | `worker-terminal-manager.ts` | worker 进程管理 + `WorkerTerminalRecord.replayPreamble` 缓存 |
| `createTerminalSession()` | `terminal.ts` | PTY spawn + headless xterm + CSI handler |
| `applyTerminalSize()` | `terminal-size-ownership.ts` | claim/update 两级所有权（WeakMap 记 owner） |
| `killTerminalAndWait()` | `terminal-worker-protocol.ts` 协议 | graceful/force 双超时销毁 |
| `handle()` | `terminal-output-coalescer.ts` | 5ms leading+trailing 节流 |
| `markFlushed()` | `terminal-output-coalescer.ts:87-89` | snapshot 帧带外直发后防 leading-edge 紧贴 |
| `parseCommandFinishedOsc()` | `terminal.ts` | OSC 633 → `terminalCommandFinished` 事件 |

</details>

## 核心实现

### PTY + headless xterm 双实例

`createTerminalSession()`（`terminal.ts`）用 **node-pty**（`pty.spawn`）spawn shell，同时创建 headless xterm.js 实例解析输出流——解析不是为了渲染（客户端自己渲染），而是为了 **snapshot 保真**：客户端重连/新 tab 接入时，从 xterm 的 buffer 重建终端状态（~200k cell 对象），比回放原始字节流精确且高效。同时注册 CSI handler 回答 DA1/光标查询（nvim 等需要）。

resize 经 `terminal-size-ownership.ts` 的 `applyTerminalSize()`：claim/update 两级所有权（WeakMap 记 owner），防止闲置端（没在看的客户端）抢 PTY 尺寸。

### worker 进程隔离：为什么

`terminal-worker-process.ts` 把终端跑在独立 worker（fork + `serialization: "advanced"` IPC，协议在 `terminal-worker-protocol.ts`：请求 `createTerminal/getTerminalState/captureTerminal/send/killAll…` 带 requestId + 10s 超时，事件 `terminalCreated/terminalMessage/terminalExit/terminalActivityChange…`）。两个理由（`docs/terminal-performance.md` "main-loop flood"）：

1. **性能**：headless xterm 解析和全量 snapshot 序列化/GC 若跑在 daemon 主循环，会阻塞所有 agent 流量（终端帧与 agent 流量共享同一 event loop，`ws_runtime_metrics` 的 eventLoopDelay 是事实真源）；
2. **崩溃隔离**：Windows conpty 异步 spawn 失败无法就地捕获（会杀死进程），worker 化后单次失败只 reject 当前 create 请求（`reportInFlightTerminalCreateFailure()`），已有终端不受损。

### 性能管线：5ms 合批 + 双级部署

`terminal-output-coalescer.ts`（109 行）是 **leading+trailing 节流**，`DEFAULT_FLUSH_DELAY_MS = 5`：空闲后首 chunk 同步立即 flush（按键回显零延迟），持续 burst 由 trailing timer 5ms 批量 `Buffer.concat`。两处实例化：worker 侧每终端一个（IPC 前，≤1 条 process.send / 5ms）+ daemon 侧每客户端 stream 一个。基准：echo p50 ~2.3ms（`scripts/benchmark-terminal-latency.ts`）。

`markFlushed()` 处理一个微妙边角（`terminal-output-coalescer.ts:87-89`）：snapshot 帧带外直发后，防止下一个 chunk 被 leading-edge 紧贴着发出去（破坏批帧的 revision 去重）。

### 背压：4 MiB 软降级

`terminal-restore.ts`：`MAX_TERMINAL_OUTPUT_FRAME_BYTES = 256KB`（单帧上限）且 `MAX_CLIENT_BUFFERED_BYTES = 4MB`（bufferedAmount）——超限**降级为全量 snapshot 恢复**（比 01 篇的 64 MiB 硬切断温和：终端流有 snapshot 这条恢复路径，所以软背压先行，硬切兜底）。

### shell 集成与 agent hooks

- **shell-integration/zsh/**：`paseo-integration.zsh` 经 preexec/precmd 钩子发 **OSC 633**（命令开始 A/B/C、结束 D;exitCode）与 OSC 2 标题；`.zshenv` 经 ZDOTDIR 重定向注入而不污染用户配置。`terminal.ts` 的 `parseCommandFinishedOsc()` 消费为 `terminalCommandFinished` 事件——"终端里跑的命令结束了"是 workspace 活动状态的输入之一。
- **agent-hooks/**：向 Claude Code（settings.json hooks）/Codex/OpenCode 注入生命周期 hook（`claude.ts` 的 `CLAUDE_EVENT_STATES`：UserPromptSubmit→running、Stop→idle、Notification+idle_prompt→needs-input），事件喂 `activity/terminal-activity-tracker.ts` 的 `TerminalActivityTracker`，产生终端红点/attention 状态。安装由 `agent-hook-installer.ts` 的 install/uninstall + hookMarker 幂等管理。

### Windows 兼容细节

`resolveTerminalSpawnCommand` 处理 .cmd/.bat 的 MSVCRT 引号陷阱（类比 CVE-2024-27980）；`ensureNodePtySpawnHelperExecutableForCurrentPlatform` 修 darwin prebuild 缺执行位——跨平台终端的最后一公里都是这种细节。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| worker 进程隔离 | `terminal-worker-process.ts` | 主循环防洪泛 + 崩溃隔离 |
| 接口/实现分离 | `TerminalManager` 接口 + factory | in-process 实现留给测试 |
| leading+trailing 节流 | `terminal-output-coalescer.ts` | 首键零延迟 + burst 合批 |
| 两级所有权 | `terminal-size-ownership.ts` | resize 竞争仲裁 |
| 软背压 + 降级恢复 | `terminal-restore.ts` | snapshot 路径让温和降级可行 |

## 模块间交互

- 上游：`terminal-session-controller.ts` 挂在 Session 的 terminal 域（01 篇责任链）；04 篇的 terminal 六件套工具直达 manager；
- 下游：node-pty 子进程；二进制帧走 `@getpaseo/protocol/binary-frames`；
- 横向：agent-hooks 与 03 篇 provider 层协作（给 agent CLI 注入 hook）；activity tracker 喂 workspace 聚合状态。

## 扩展方式

新增一个终端 RPC：

1. `packages/server/src/server/messages.ts` 定义消息类型；
2. `terminal-session-controller.ts`：加进 `TerminalDispatchableMessage` 联合、`TERMINAL_MESSAGE_TYPES` 集合与 `dispatch()` switch（照 `handleRenameTerminalRequest` 模板）；
3. 需触达 PTY 时：`terminal-worker-protocol.ts` 加 `TerminalWorkerRequest` 变体 + `terminal-worker-process.ts` 分发 + `worker-terminal-manager.ts` 的 `sendRequest` 调用链；
4. 帧走二进制则改 `@getpaseo/protocol/binary-frames`；
5. 测试惯例：同目录 `terminal-session-controller.test.ts` / `worker-terminal-manager.test.ts`。
