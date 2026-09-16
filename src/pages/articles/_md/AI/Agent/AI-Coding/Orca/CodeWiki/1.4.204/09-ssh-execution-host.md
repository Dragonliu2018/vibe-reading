---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "SSH 远程执行"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
tags: ["Orca", "SSH", "远程开发"]
description: "ExecutionHost 判别联合抽象、SshConnection 双 transport 回退链、重连梯子双计数器、live/unverifiable/exited 三词判决词汇。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

"Run agents on a beefy remote box with full file editing, git, and terminals — auto-reconnect and port forwarding included"是这个模块的使命。它包括 `src/main/ssh/`（78k 行）与 `src/shared/` 里的 execution host 抽象。核心设计立场写在 AGENTS.md 的 `docs/reference/ssh-execution-boundary.md`：**execution host 拥有一切触碰执行的东西；失联不是进程死亡的证明**。

## 模块架构

![SSH 与 Execution Host](/vibe-reading/images/articles/orca-internals/ssh-execution-host.svg)

Orca 没有定义 fat interface，而是**用类型系统 + 纯函数集**表达 host 抽象：

```ts title="src/shared/execution-host.ts"
export type ExecutionHostKind = 'local' | 'ssh' | 'runtime'
export type ExecutionHostId = typeof LOCAL_EXECUTION_HOST_ID | `ssh:${string}` | `runtime:${string}`
export type ParsedExecutionHost =
  | { kind: 'local'; id: typeof LOCAL_EXECUTION_HOST_ID }
  | { kind: 'ssh'; id: `ssh:${string}`; targetId: string }
  | { kind: 'runtime'; id: `runtime:${string}`; environmentId: string }
```

`parseExecutionHostId()`（71 行）是唯一解析入口；`toSshExecutionHostId()`（:53）用 `encodeURIComponent` 编码 targetId——注释明确 why：`|` 是 `composeWorktreeHostIdentity` 的分隔符，未编码的 pipe 会把 alias 重绑到另一个 host。一个关键语义分裂（:176-205）：`getSshTargetIdForExecutionHost()` 回答"本客户端**可拨**的连接"（路由 PTY/Git provider 用）；`getRepoSshConnectionId()` 回答"**持有该 repo 文件**的 SSH target"（runtime host 内嵌 target 只能以 `(environmentId, targetId)` 二元组寻址，本客户端无法独立拨通）。

注册表 `buildExecutionHostRegistry()`（`execution-host-registry.ts:199`）是纯函数：本地永远第一条，聚合 runtime environments、settings 聚焦的 host、repo 行引用的 host 四路来源；`sshHealth()` 把 `SshConnectionStatus`（connected/connecting/deploying-relay/reconnecting/auth-failed/…）折叠为统一 health。main 和 renderer 复用同一函数——状态没有第二份拷贝。

## 调用链路

添加 host → 连接 → 打开远程 worktree/终端 → 断线重连：

```text
添加 target：renderer → IPC ssh:addTarget（src/main/ipc/ssh.ts:84）
  （ssh:importConfig 从 ~/.ssh/config 导入——Include 指令也解析）
  → SshConnectionStore；targetId = user@host:port 规范化身份

连接：ssh:connect → SshConnectionManager.connect(target)
  → new SshConnection(target, callbacks) → conn.connect()（ssh-connection.ts:671）
     ├─ resolveWithSshG 解析 ProxyJump/Include，必要时 spawn proxy 进程
     ├─ 凭据梯子：agent → 私钥 → passphrase → password → keyboard-interactive
     │   （每级可经 requestCredential() 回 renderer 弹窗；PAM 多轮走 answerKeyboardInteractive）
     ├─ ssh2 失败且 isSystemSshFallbackError / requiresSystemSshForSecurityKey
     │   → 回退 system-ssh 二进制（doSystemSshProbe 跑 echo ORCA-SYSTEM-SSH-OK；
     │     GitHub restricted shell 特判 isGitHubRestrictedShellProbeSuccess）
     └─ 成功 → reconnectLadder.markConnected() → 状态 connected → 部署 relay

打开远程 worktree：resolveWorktreeExecutionHost()（worktree-execution-host-resolution.ts:81）
  裁决 {hostId, connectionId, owner}——终端、文件、重连提示都从这一个答案路由
打开远程终端：远端跑常驻 orca-relay 守护进程（ssh-relay-deploy.ts 部署：
  原生依赖缓存、版本化安装、GC、takeover 仲裁）；PTY 由 relay 托管
  （ssh-relay-session.ts，124KB 核心会话管理）；relay 建立时
  registerSshGitProvider(this.targetId, gitProvider)——远端 git 走 relay RPC

断线：ssh2 client end/close/error → onDrop（身份守卫 this.client !== client
  防旧 client 迟到事件）→ scheduleReconnect() 问 SshReconnectLadder.next()
  → {retry, delayMs} 或 give-up → runReconnectAttempt() → attemptConnect()
```

方法速查表：

<details>
<summary>SSH 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `connect(target)` in manager | 每 target 一条连接 | `connectingTargets` 的 symbol 防迟到清除 |
| `disconnectConnection(targetId, conn)` | 按连接实例断开 | 按 targetId 断开会拆掉替代连接的活 transport |
| `attemptConnect()` | 一次连接尝试 | `++connectGeneration`，全部竞态防护的核 |
| `resolveWorktreeExecutionHost()` | worktree 归属裁决 | "One rule for 'which host does this worktree execute on'" |
| `getPtyExecutionHost(ptyId)` | PTY 归属 | id 内嵌 owner；`'foreign'` ≠ `null` |
| `SshConnection.writeFile()` | 远端写文件 | 双 transport 分流 SFTP / system-ssh |

</details>

## 核心实现

### 为什么统一 execution host 抽象

因为"代码在哪跑"不是布尔值——同一个 repo id 可同时存在于 local、SSH、runtime 三个 host 上。分散的 `if (repo.connectionId)` 已经产过两个 bug：#11163（main/renderer 各自推导 host，把一个 host 的 pane 路由到另一个）和 `getRepoExecutionHostId` 注释里的 legacy `connectionId` vs `executionHostId` 双拼写问题（路由读原始字段会把 `ssh:<target>` 行答成 local，导致**远端操作跑在客户端上**）。抽象的落点是"一个规则、两边共用"（该文件头注释）。`WorktreeExecutionHostResolution` 的 `{kind:'unresolved', reason:'ambiguous'|'unknown'|'malformed'}` 刻意不合并：`unknown` 可以当本地文件夹处理，`malformed` 必须拒绝；`unresolved` 永远不是 `local`（#6648、#17799：不能授权客户端读远端路径）。

### "失联不判死"：三词判决词汇

```ts title="src/shared/agent-status-run.ts:33"
export type AgentStatusRunVerdict = 'live' | 'unverifiable' | 'exited'
```

SSH 断开只证明**客户端失去联系**，不证明远端进程退出——远端 agent 可能还在跑（OS sleep/wake、网络抖动都是常见假死）。判定词汇覆盖 `AgentStatusPtyRunRecord.verdict`、journal（`unverifiable` 不携带结束时刻）、foreground 进程证据（SSH-to-Windows 永远 unverifiable，因为只有 POSIX 有真正的前台原语）。`ssh-orphan-sweep-pane-state-verdicts.test.ts:318` 明确引用边界文档：孤儿 PTY 的状态"保持自己的 verdict，绝不坍缩成 idle"。配套机制：relay 有 grace 期让重连后 reattach PTY 而非杀掉。

### SshReconnectLadder：双计数器的退避设计

`ssh-reconnect-ladder.ts:22-78` 的关键设计：`delayIndex` 每次 scheduled retry 都推进（**flap 也退避**），`consecutiveFailedAttempts` 只在握手失败时推进，`reconnection-failed` 恰好在 `RECONNECT_BACKOFF_MS.length` 次失败握手后到达、flap 永不触发。flap 场景延迟封顶 `FLAP_DELAY_CAP_MS`——推导（:15-20）来自 relay grace 期最短值减去连接超时和 relay 重建预算：重试晚于这个上限会让 relay 超时关闭、带走所有远端 PTY。连接稳态满 60s（`STABLE_CONNECTION_MS`）则重置梯子。

### SFTP 文件编辑与端口转发

`SshConnection.writeFile`（:597）双 transport 双实现：ssh2 走懒加载 `this.sftp(signal)` + `resolveSftpTransferPathIfMapped`（:507 注释："resolve on the same session that writes — a later session is not authoritative for this one's namespace"）+ 双取消（`createLinkedSshFileTransferSignal` + `raceSftpFileTransferWithAbort`，并吞掉 abort 后 SFTP 流的迟到错误）；system-ssh transport 走 `writeFileViaSystemSsh`（Windows 远端多级写策略）。端口转发是 provider 链：`SshPortForwardManager` 构造时注入 `[Ssh2PortForwardProvider, SystemSshPortForwardProvider]`，`canHandle(conn)` 按 transport 选择；`updateForward` 失败时保留原 ID 回滚保证 renderer 引用不悬空。

### 78k 行目录的组织法

`ssh-connection-manager.ts` 头注释说明了拆分原则："保持每个文件低于 300 行 oxlint max-lines 阈值，同时保持单一职责边界"。整体形态是一个巨型 `SshConnection`（1700+ 行，文件头注释声明**故意超行数上限**——"SSH connection lifecycle, credential retries, reconnect policy, and transport fallback 有意共置一处，使状态迁移可在一个文件内审计"）+ 上百个小文件各管一个横切关注点。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 判别联合 + 单点解析 | `execution-host.ts` | 消费方 switch，编译器强制穷尽 |
| 纯函数注册表 | `buildExecutionHostRegistry()` | main/renderer 复用，状态无第二份 |
| attempt generation | `connectGeneration` + symbol | 被取代的尝试无权发布任何结果 |
| provider 策略链 | 端口转发 / 文件传输 | 双 transport 能力不同 |
| 三态 verdict 词汇 | `agent-status-run.ts:33` | 禁止发明同义词（AGENTS.md:77） |

## 模块间交互

与 [Git Worktree 生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/05-git-worktree)：Git 操作不直接碰 SSH——`providers/ssh-git-dispatch.ts` 维护 `Map<connectionId, SshGitProvider>`，由 `ssh-relay-session.ts:1206` 在 relay 会话建立时注册（远端 git 走 relay RPC，不是每次 spawn `ssh git ...`）；断线后 `requireSshGitProvider` 抛固定文案提示重连。与 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)：PTY 归属由 id 决定而非路径（`terminal-execution-host.ts:15`）。与 [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon)：远端 orcad 与本地同构。Git capability 按 host 隔离缓存（`sshCapabilitiesByProvider` WeakMap——重连即新 provider，同连接的并发共享探测结果）。

## 扩展方式

**新增一种远程 host 类型**（如 `docker:<containerId>`）：

1. `src/shared/execution-host.ts`：`ExecutionHostKind` 加 `'docker'`；`ExecutionHostId` 加模板串；`ParsedExecutionHost` 加分支；`parseExecutionHostId()` 加前缀解析（禁 `|`）；加构造函数；
2. `execution-host-registry.ts`：加 `dockerHealth()` 折叠函数 + 收集来源路；
3. 消费方全是 switch on `kind`，编译器报出需要补齐的位置——判别联合而非 interface 的直接收益；
4. 需要本客户端拨连接则按 relay 模式接入（参照 `ssh-relay-session.ts:1206`）；
5. 遵守边界规则：新 host 的进程存活判定只能用 `live/unverifiable/exited` 三词，失联不得渲染为退出；与客户端交换的 RPC/流帧要能力协商（未知 opcode 会被静默丢弃）。
