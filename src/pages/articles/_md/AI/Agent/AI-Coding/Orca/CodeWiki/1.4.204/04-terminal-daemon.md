---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "终端守护进程"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
tags: ["Orca", "终端", "PTY", "xterm"]
description: "orcad 独立终端守护进程：三方拓扑与收养机制、scrollback 跨重启的三段式冷恢复、@xterm/headless 无头解析 OSC、遥测永不影响终端的硬规则。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

终端是 Orca 承载 agent 的原生宿主，而"scrollback 跨重启存活、app 更新不打断正在跑的 agent"决定了终端系统必须**进程外置**。`src/main/daemon/` 是独立构建的 orcad 守护进程（入口 `daemon-entry.ts`，asar-unpacked），持有全部 PTY 子进程；`src/main/pty/` 是 spawn 环境的纯函数层（main 与 daemon 共用）；`src/main/ghostty/` 是 **Ghostty 配置导入器**（复刻其 XDG 搜索顺序、解析 config、映射到 Orca 设置——README 的 "Ghostty-class terminals" 是能力宣传，不是嵌入 Ghostty）；`src/main/emulator/` 则是移动设备模拟器（scrcpy/adb/simctl），与终端仿真无关——真正的仿真是 daemon 内的 `@xterm/headless`。

## 模块架构

![终端守护进程结构](/vibe-reading/images/articles/orca-internals/terminal-daemon.svg)

三方拓扑：Electron main 进程是**客户端**（`daemon/client.ts` 的 `DaemonClient`），守护进程是**服务器**（`DaemonServer` 监听 Unix socket/命名管道，token 认证），renderer 只面对 main 暴露的 `IPtyProvider`。守护进程内 `TerminalHost`（`terminal-host.ts`）是会话管理核心——`sessions = new Map<string, Session>()`，`createOrAttach()` 是唯一入口（同 sessionId 的并发创建用 `pendingCreations` 串行化，避免一个死路径卡死所有后续 create/attach）、`killedTombstones` 上限 1000、`agentSessionGenerations` 管理 agent 会话世代。每个 `Session` 持有 node-pty 子进程 + `HeadlessEmulator`。

main 进程侧的 provider 适配层同样是单类分层拆文件（与 runtime 的 mixin 链同思路）：

```text title="DaemonPtyAdapter 继承链"
DaemonPtyAdapter (daemon-pty-adapter.ts, 实现 IPtyProvider)
└─ DaemonPtyDaemonRecovery        # 掉线重连 / respawn
    └─ DaemonPtyCheckpointPersistence → DaemonPtyCheckpointScheduler  # 5s 脏检查点
        └─ DaemonPtyConnectionLifecycle → … → DaemonPtyRuntimeState    # 持 coldRestoreCache
```

## 调用链路

一个终端从创建到输出回流（数据类型标注）：

```text
renderer terminal-pane
  → connectPanePty → connectIpcPty → spawnIpcPty
  → window.api.pty.spawn(opts): PtyApi['spawn'] → {id, incarnationId?, snapshot?, replay?}
  → ipcMain 'pty:spawn' → runPtyIpcSpawn (src/main/ipc/pty/ipc/spawn-run.ts)
  → DaemonClient.request('createOrAttach', request: CreateOrAttachRequest)
     # 双 socket 顺序连接：先 control 后 stream，各自 sendDaemonHello
     # (token + PROTOCOL_VERSION + clientId)；两个 socket 的 daemon identity
     # 必须一致（sameDaemonIdentity），否则抛 DaemonProtocolError。
     # 两层代数防护：connectionGeneration 防 respawn 后旧 socket 的
     # stale 'close' 事件拆掉新连接（handleDisconnect 校验代数）；
     # connectionAttemptGeneration 让 disconnect() 后的旧连接尝试步骤
     # 被 assertConnectionAttemptCurrent 中止
  → DaemonServer → daemon-request-router → TerminalHost.createOrAttach()
  → createPtySubprocess (node-pty；spawn 参数由 pty/ 下纯函数组装)
  → PTY 输出 → Session.HeadlessEmulator.writeSync()
     # 无头 xterm 解析：提取 OSC 7 cwd / title / agent 状态
  → session-output-plane → daemon-stream-data-batcher → stream socket NDJSON
  → DaemonPtyAdapter.setupEventRouting() 消费 'data' 事件
     → markSessionDirty()（触发检查点调度）+ 扇出 dataListeners → IPC → xterm 渲染
```

方法速查表：

<details>
<summary>daemon 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `startDaemon(opts)` in `daemon-main.ts` | 启动守护进程 | 返回 `DaemonHandle.shutdown()` |
| `TerminalHost.createOrAttach()` | 会话唯一入口 | `pendingCreations` 串行化并发创建 |
| `probeDaemonSocket()` in `daemon-launch-paths.ts` | 探测旧 daemon | "socket 能 accept 连接"即存活证明 |
| `getDaemonEntryPath()` | 定位 daemon 入口 | packaged 下把 `app.asar` 重定向到 `app.asar.unpacked` |
| `buildColdRestorePayload()` | 构造冷恢复载荷 | `{scrollback, cwd, cols, rows, oscLinks?, lastTitle?}` |
| `ColdRestoreReplayWriter` | 限速重放 | 每 event-loop turn 限 64K chars / 1024 ops |

</details>

## 核心实现

### 为什么要独立守护进程

三个理由都有代码注释背书：(a) **自动更新存活**——更新时 Electron app 目录被替换，daemon 在外运行且 socket 可探测存活即可被收养，正在跑的 shell/agent 不因 UI 更新死亡；(b) **主进程崩溃不杀 PTY**；(c) **性能隔离**——daemon 吞吐大（batcher、data-gap 丢弃）。Windows 上 `daemon-host-relocation.ts` 的 `hostRootDir()` 把 daemon 宿主物化到 `%LOCALAPPDATA%`（`materializeRelocatedDaemonHost()`：临时目录 + 原子 rename + marker 校验版本），因为安装目录下的副本过不了 NSIS 更新。

`daemon-entry.ts:151` 还对 node-pty 的 C++ `Napi::Error` 单独抑制——native PTY 异常只杀单个 PTY，不让整个 daemon 连带所有终端一起死（非 PTY 异常仍 fatal）。

### 收养机制：换代的竞态安全

main 启动先探测 socket，活着的旧 daemon 直接**收养**（`daemon-endpoint-adoption.ts`、`daemon-launched-child.ts`）而不是杀掉重启。防 PID 复用误判靠两层身份：PID 记录 + launch nonce（`daemon-pid-identity.ts`、`daemon-pid-record-quarantine.ts`）；换代用 `.swap/.hold` 原子 rename（`daemon-spawner.ts:164`）。macOS 上 TCC 归因要求 daemon 钉在打包 app bundle（`daemon-tcc-attribution.ts`）；登录会话死亡时 `MacosLoginSessionDeathWatch` 故意以 crash 风格 `process.exit(1)` 退出，让新 daemon 走冷恢复（`daemon-entry.ts:246-254` 注释明说）。

### 冷恢复三段式：scrollback 为什么不丢

这是本模块最精巧的设计（README 卖点 "scrollback that survives restarts"）：

1. **写**：main 侧 adapter 每 data 事件 `markSessionDirty()`，`DaemonPtyCheckpointScheduler` 是 dirty-gated 5 秒定时器（非永久轮询），只序列化脏 session——经 `terminal-checkpoint-serializer.ts`（xterm `SerializeAddon` + `serializeWithAbsoluteCursor`）写 `terminal-history/<sessionId>/checkpoint.json`。daemon 崩溃是 "crash-style exit"——`onRetire` 和 SIGTERM 之外的死亡都不写 clean `endedAt`，这个"脏标记"是恢复的触发器；
2. **读**：下次 spawn 时 `history-reader.ts` 检测到 unclean 元数据 → 读 checkpoint → `ColdRestoreReplayWriter` 把快照字节重放进一个**新的 HeadlessEmulator**——每 event-loop turn 限 64K 字符 / 1024 ops（防大 scrollback 卡死，切片避开 UTF-16 代理对）→ 再序列化得到 `scrollbackAnsi + rehydrateSequences`；
3. **送**：`buildColdRestorePayload()`（`daemon-pty-spawn-result.ts:178`）把 `ColdRestoreInfo` 塞进 spawn 结果给 renderer 重放（`apply-reattach-payload.ts` 判定 `RESET_GRAPHIC_RENDITION + replay`）；同时 `getRecoveredHistorySeedSegments()` 作为 seed segments 随 `createOrAttach` 喂给 daemon 自己的 emulator——带 `COLD_RESTORE_SEED_MODE_RESET`，防止死掉的 TUI 的鼠标模式经任何下游再序列化泄露（**包括移动端**）。`ColdRestorePayloadCache` 是 16MB LRU（`MAX_COLD_RESTORE_CACHE_BYTES`，get 命中后 delete+set 重新插入实现 LRU，超限从最旧条目淘汰并触发 `onEvict`）：条目字节用 `getColdRestorePayloadBytes` 以**字符串 code-unit 数 ×2** 近似 V8 字符串存储成本（免重扫/展平多 MB rope）；StrictMode 双挂载第二次 spawn（`isNew=false`）必须还能拿到缓存（"remount safety"）。

### spawn 环境纯函数层

`src/main/pty/` 被 main 和 daemon 共用：Windows PATH 注册表合成（`windows-environment-path.ts`）、WSL env（`wsl-orca-env.ts`）、OMZ/OMP wrapper（`omp-shell-wrapper.ts`）、codex 预检（`codex-shell-launch-preflight.ts`）。`daemon-entry.ts` 以依赖注入把 `createPtySubprocess` 传给 `startDaemon`，而非直接 import——保持 daemon 可独立构建。

### 遥测永不影响终端

反复出现的硬规则：`daemon-adoption-telemetry-event.ts:9` 注释 "every failure dies here — telemetry can never cost a terminal"；`daemon-audit-eligibility-event.ts` 用单调时钟（防 NTP 回拨）做节流，遥测总预算 1000 events/session；`trackDaemonPtyCwdDeniedIfDiverged()` 只在"daemon 读不了 cwd 而 main 能读"的真正分歧时上报（#17696）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Daemon + endpoint adoption | `daemon-endpoint-adoption.ts` | 会话跨 app 重启存活 |
| 协议版本 + capability 分支 | `daemon/types.ts` 的 `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` | app 更新后新旧 daemon 共存（`supportsXxx(this.protocolVersion)`） |
| 冷恢复（检查点/重放/缓存） | `cold-restore-*.ts` 三件套 | 崩溃后的确定性重建 |
| 遥测预算 | `daemon-audit-*` | 旁路永不阻塞主路径 |
| 单类分层拆文件 | `DaemonPtyAdapter` 继承链 | 与 runtime mixin 链同一手法 |

## 模块间交互

与 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)的边界：main 进程为每个 worktree 维护 `RuntimePtyWorktreeRecord`，从 daemon 事件流（exit/OSC title/OSC 9999）持续折叠状态；`orcad-runtime-split-pty-backed-terminal.ts` 把 runtime 终端接到 daemon-backed provider。历史目录 `getDaemonHistoryDir()`（`userData/terminal-history`）按"每个持有文件的主机各挂一次"——本机、WSL、远端 SSH 各自的 main 进程写自己那份。远程主机的终端由 [SSH 远程执行](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/09-ssh-execution-host)的 relay daemon 托管，协议同构。

## 扩展方式

**新增 shell 集成钩子**（新 OSC/自定义 prompt 标记）：daemon 侧 `HeadlessEmulator` 的 `TerminalOscCwdTitleScanner` / `terminal-view-attribute-responder.ts` 加解析 → spawn 参数配合改 `pty/shell-startup-env.ts` → **恢复路径必须同步改** `terminal-history-seed-segments.ts` 和 `terminal-mode-rehydrate-sequences.ts`，否则恢复时模式/数据丢失（repo 大量 `repro-*` 测试即为此类回归）。

**改协议**：`daemon/types.ts` 加请求 + capability 版本常量，`daemon-protocol-version.ts` 的 `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` 保证旧 daemon 兼容。

**改 scrollback 行为**：`history-reader.ts` 检测 + `daemon-pty-spawn-result.ts` 的 `buildColdRestorePayload` 分支 + renderer `apply-reattach-payload.ts`；缓存预算改 `MAX_COLD_RESTORE_CACHE_BYTES`，重放速率改 `REPLAY_CHARS_PER_TURN`。
