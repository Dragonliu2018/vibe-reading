---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Agent 运行时核心"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
tags: ["Orca", "运行时", "状态机", "SQLite"]
description: "OrcaRuntimeService 的 135 层 mixin 继承链、OrchestrationDb 的 75 组方法挂载、agent 会话的 fence/lease 三段式 acquire，以及 2 秒轮询的编排 coordinator。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

`src/main/runtime/`（~39 万行）是 Orca 的领域中枢：所有 agent 会话、终端记录、worktree 扫描、订阅推送的状态权威都在这里。RPC 层的 590 个方法 handler 只是薄壳，真正的业务规则全部落在 `OrcaRuntimeService` 的方法面上。它同时服务两种宿主形态——桌面窗口与 headless `orca serve`（`orcad/orcad-entry.ts:208` 同样实例化它），这是启动装配（见[主进程启动与生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/01-startup)）把依赖做成惰性闭包的原因。

## 模块架构

`orca-runtime.ts` 本体只有 58 行、一个空类定义：

```ts title="src/main/runtime/orca-runtime.ts"
class OrcaRuntimeService extends OrcaRuntimeWithResolveWaiter {}
type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>
export { OrcaRuntimeServiceExport as OrcaRuntimeService }
installRuntimeLinearCommandSurface(OrcaRuntimeServiceExport.prototype)
```

真实类是由**135 层线性 mixin 继承链**机械拼接的：

![runtime 组件结构](/vibe-reading/images/articles/orca-internals/runtime-structure.svg)

链顶是能力层（`OrcaRuntimeWithResolveWaiter` 管终端 waiter 的 resolve/reject 与权威窗口查找；`OrcaRuntimeWithDeliverPendingMessages` 做邮箱兜底重投递），链底 `OrcaRuntimeWithStateFields`（`orca-runtime-state-fields.ts`，约 700+ 行）是真正骨架——**所有实例状态与构造函数在这里**，构造时把 8 个命令面（File/Git/Repository/Review/Service/Skill/Edge/Linear）用 `installRuntime*CommandSurface` 代理挂到实例上。每个中间层文件头都有同一句注释：

```text title="所有 orca-runtime-*.ts 的文件头"
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered
// by AST equivalence and characterization tests.
```

这是从 god class **机械拆分**的产物：一文件一层一能力，任何能力的修改只碰一个文件。graphify 建图时它仍以 418 条边高居 god node 榜首——因为所有层最终合成一个对象。

三个状态真源挂在 runtime 上：`OrchestrationDb`（编排）、`AgentSessionRecordStore`（会话租约，见[会话数据层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/07-session-data)）、`RuntimeStore` 契约。

## 调用链路

依赖注入面（`startup/main-process-runtime-service.ts:71` 起）：runtime 不持有 pty/git/ssh 实现，而收**惰性闭包**——`getLocalProvider: () => getLocalPtyProvider()`（注释：daemon 后会被替换，eager 引用会冻结 pre-daemon provider）、`getSshProvider: (connectionId) => getSshPtyProvider(connectionId)`（SSH relay provider 事后注册会重连）、`onPtyStopped/onTerminalAgentStatus` 回调。

方法速查表：

<details>
<summary>runtime 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `createAgentSession(request, caller)` | host-authority 创建 agent 会话 | 幂等 ledger：`clientOperationId` + SHA-256 指纹，重复请求 replay 旧结果 |
| `onPtyData(ptyId, data)` | 输出扇出 | 字节序号累加 + OSC 状态扫描 + tail buffer |
| `writeTerminalAgentPrompt(handle, ...)` | prompt 事务写入 | generation/permission 序号双断言 + renderGate |
| `deliverPendingMessages(leaf, options)` | 邮箱兜底重投递 | 停靠中消息重投 + 类型级去重 |
| `getOrchestrationDb()` | 暴露编排 DB | `_orchestrationDb` 惰性创建于首次编排操作 |
| `reconcileWorktreeTabModels(ids)` | 批量 tab 模型对账 | 一次 store 写而非每 workspace 一写 |

</details>

## 核心实现

### OrchestrationDb：75 组方法挂载的编排真源

```ts title="src/main/runtime/orchestration/db/orchestration-db.ts"
class OrchestrationDbCore {
  db: Database.Database        // node:sqlite（src/main/sqlite/sync-database.ts 包装）
  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')   // + synchronous=NORMAL, busy_timeout=5000
    createTables.call(this as unknown as OrchestrationDb)
    migrate.call(this as unknown as OrchestrationDb)
    backfillFederatedStubHomeRuns(this.db)
    hardenOrchestrationDatabaseFiles(dbPath)   // 文件权限加固
  }
}
export type OrchestrationDb = OrchestrationDbCore & OrchestrationDbMethods
attachOrchestrationDbMethods(OrchestrationDbCore)
```

`attachOrchestrationDbMethods()`（`attach-orchestration-db-methods.ts`）以 `Object.assign(ctor.prototype, {...})` 挂载 **75 个方法组**，每组的本体是普通函数、以 `this: OrchestrationDb` 声明：

```ts title="src/main/runtime/orchestration/db/tasks/task-store.ts:245"
export function attachTaskStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTask, getTask, listTasks, listTasksWithDispatch, promoteReadyTasks
  })
}
```

为什么用挂载而不是 class 继承：与 mixin 链同理——按域分文件（tasks/runs/messages/worker-dispatch/federation/legacy）、单文件可控。类型用交叉 `OrchestrationDbCore & OrchestrationDbMethods`（注释：oxlint 禁止 class/interface merging，所以构造类型断言）。它解决的问题是**多 agent 并行开发的协调真源**：SQLite WAL 支撑同进程多调用方并发；`hasAnyDispatchContextsCache` 的注释解释了性能动机——渲染器每 16ms tick 重建编排上下文、每 terminal 2 条查询，绝大多数不跑编排的用户必须短路掉整个扇出。大量 `legacy-*` 方法组表明它在兼容旧协议（mail/question/takeover）的同时演进出了 pointer-delivery / structured worker / federation 三代投递机制。

### coordinator：DB 轮询式编排循环

`orchestration/coordinator.ts` 的 `run()` → `executeLoop(runId)` 每 `pollIntervalMs`（默认 2s）一次 `tick()`：

```text
tick()
├─ processMessages()        # db.getUnreadMessages：worker_done / escalation / decision_gate / heartbeat
├─ reblockTasksWithPendingGates()
├─ warnStaleDispatches()
├─ dispatchReadyTasks()     # maxConcurrent 默认 4；每 tick 至多建 1 个 worker terminal
│                            # 全部任务用同一 base snapshot 的 probeWorktreeDrift 派发
└─ checkConvergence()       # DAG 收敛判定（coordinator-dag-convergence.ts）
```

为什么是轮询而非事件驱动：结果全持久化在 DB，调用方用 `orchestration.taskList/runStatus` 查询而非等待——崩溃后循环可恢复（`lifecycle-reconciliation.ts` 收敛漏掉的 `worker_done/heartbeat`）。stale-base 检查防止把任务派发到 base 已漂移的 worktree：`baseDrift` 经 `runtime.probeWorktreeDrift` **每 tick 只探测一次**（同一 tick 内所有任务共用同一 base snapshot，探测失败 catch 返回 null 而非中断调度）；`dispatchTaskToWorker` 返回 `stale-base-refused` 时 `terminals.unshift(targetHandle)` 并 `slotsAvailable++`——终端句柄和槽位原样归还。注意 `decompose()` 显式抛错 "decomposition isn't implemented yet"——v1.4.204 尚无 AI 自动任务分解，任务须先用 `orchestration.taskCreate` RPC 预建（`run()` 与 `runFromExistingRun()` 两个入口的区别：RPC handler 预创建 run 记录以立即返回 ID，后者跳过 DB 插入）。

### AgentSessionRecordStore：lease 账本

```ts title="src/main/runtime/agent-session-record-store.ts"
export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000
export const AGENT_SESSION_CLAIM_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class AgentSessionRecordStore {
  static async open(args: { directory: string; hostId: string }): Promise<AgentSessionRecordStore>
  reserveOwner(request): Promise<AgentSessionReserveResult>     // CAS：fence+1 写意图
  commitProcessIdentity(args): Promise<AgentSessionRecord>      // 子进程回显 reservedSpawnToken
  proveOwner(args): Promise<...>                                 // provider handle link 验证
  renewLease / renewLeases(renewals)                             // 每 10s 续期
  evictProvenDeadOwner(args)                                     // 除 acquire 外唯一推 fence 的操作
  transitionHandoff(sessionId, transition: (record) => record)   // 纯函数转移
  reconcileOnRestart(args)                                       // 重启后逐条探测裁决
  admitOperation / recordOperationOutcome                        // durable operation ledger
  private transact = <T>(apply: () => T): Promise<T>             // 变异串行化
}
```

不变量写在 `agent-session-lease-transitions.ts` 头注释：*a session admits a writer only after a reservation, an observed process identity, and a proved provider handle — in that order, at one fence.* 完整状态机（reserved → new-owner-proving → live → renew/evict/handoff → unreconciled）见概览的[状态流](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview#状态流)，此处补三个细节：

- **重启零信任**：`AgentSessionRecordStore.open()` 即 `markAgentSessionStoreLeasesUnreconciled(loaded.state)`——"a restart grants no writer on the strength of what the previous process wrote"；孤儿 spawn token **一律 kill，绝不收养**；
- **重试恢复原预约**：`acquisition.ts` 注释 "Retries must recover the original reservation, not mint a second child"——避免重试制造第二个子进程；
- **操作账本幂等**：`admitOperation`（per-client 512 / global 4096 上限）保证跨连接重试幂等，claim key 退役保留 30 天（"a rotation cannot strand a running agent"）。

### RuntimeStore 契约与 RuntimePtyWorktreeRecord

`runtime-store-contract.ts` 不是类而是**结构化契约类型**：把 `../persistence` 的 Store 按 runtime 实际需要的子集投影出来，大量字段可选——测试 mock 可裁剪。`runtime-terminal-state-records.ts` 维护两级终端记录：`RuntimeLeafRecord`（叶子 = tab+pane，含 `ptyGeneration/writable/lastOscTitle/lastAgentStatus`）与 `RuntimePtyWorktreeRecord`（pty 与 worktree 的绑定：`ptyId/incarnationId/worktreeId/launchAgent/agentSessionOwners/foregroundAgent/lastExplicitAgentStatus`）——注释明确区分"agent 自报的 OSC 9999 状态"与"从 OSC title 推断的状态"两条证据链。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 机械拆分的线性继承链 | 135 层 `OrcaRuntimeWith*` | god class 拆到一文件一层；AST 等价 + characterization 测试保证行为不变 |
| prototype 方法挂载 | `attachOrchestrationDbMethods` → 75 个 `attach*` | 同上，按域分文件 |
| 命令面代理（facade + Proxy） | `runtime-linear-command-surface.ts` 的 `overrideAwareReceiver` | 注释："a facade override (test spy) has to win for re-entrant `this` calls too" |
| 纯函数状态转移 + 事务壳 | lease 转移全是 `(record) => record`；store 层 `transact()` 包裹 | "a rejected transition never lands" |
| 订阅注册表 | `runtime-subscription-registry.ts` 的 `registerOwned` | 返回 `{releaseIfCurrent()}` 防 ABA 抢清理 |
| 惰性闭包注入 | 构造函数收 `getLocalProvider` 等闭包 | 启动次序与生命周期解耦 |

## 模块间交互

runtime 是扇出中心（见概览[模块地图](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview#模块地图)）：对上，`RpcDispatcher` 的每个 handler 直接调它的方法面；对下，它以 provider 接口消费 [终端守护进程](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/04-terminal-daemon)（`IPtyProvider`）、[Git Worktree 生命周期](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/05-git-worktree)（git commands）、[嵌入式浏览器](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/08-browser)（`RuntimeBrowserCommandHost`）。与 [Relay](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/10-relay-cloud) 的耦合全部间接：经 store 的 `getSshRemotePtyLeases`、`orca-runtime-notify-ssh-state-changed.ts`、以及 OrchestrationDb 的 federation 方法组——runtime 不直接 import relay 模块。

## 扩展方式

新增一个 runtime 能力（如新 RPC 方法组 `foo.*`）：

1. **链上插一层**：新建 `src/main/runtime/orca-runtime-foo.ts`，写 `export class OrcaRuntimeWithFoo extends <链上某层>`，把该层的父类改为 extends 它（选层即决定方法能被哪些上层调用）；
2. **方法注册**：`rpc/methods/foo.ts` + `methods/index.ts` 的 `ALL_RPC_METHODS`（详见[统一 RPC 层](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/02-rpc)）；
3. **命令面**：参照 `installRuntime*CommandSurface` 在 `orca-runtime-state-fields.ts` 构造函数挂载，并在 `orca-runtime-core.ts` 的 `RuntimeInstalledCommandSurfaces` 补类型；
4. **编排持久化**：`orchestration/db/` 新建域目录 + `attach-foo-store.ts`，在 `attachOrchestrationDbMethods()` 注册，并在 `orchestration-db-methods.ts` 与 `schema/migrate.ts` 补签名与建表。
