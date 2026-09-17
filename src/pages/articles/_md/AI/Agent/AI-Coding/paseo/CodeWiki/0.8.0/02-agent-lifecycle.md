---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Agent 生命周期与时间线"
date: "2026-09-17T23:53:10+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "状态机", "Timeline", "Coalescing"]
description: "paseo AgentManager 状态机——lifecycle 四态与 closed/archived 正交分离、ensureAgentLoaded 的 resume 语义、60ms stream coalescing、provider session 才是 timeline 真源的持久化设计。"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/server/agent/` 的核心文件群（`agent-manager.ts` 5,253 行、`agent-storage.ts` 441 行、`agent-timeline-store.ts`、`agent-projections.ts`、`agent-run-state.ts`、`agent-loading.ts`、`agent-stream-coalescer.ts`、`timeline-projection.ts`）回答一个问题：**"一个 agent" 在 daemon 里是什么**。答案是三层正交的概念：身份（Paseo agent ID + 持久化记录）、运行时（provider 进程，可关可换）、timeline（事件历史，真源在 provider session）。把这三层拆开，是本模块所有设计决策的出发点。

## 模块架构

```
AgentManager（agent-manager.ts）
├── agents: Map<agentId, LiveManagedAgent>    # 内存态（idle 常驻）
├── runLifecycleMutation()                     # per-agent 串行生命周期队列
├── AgentRunState（agent-run-state.ts）        # 随机 token 防 stale 结算
├── streamAgent() → startTurn → handleStreamEvent
│   └── AgentStreamCoalescer                   # 60ms 窗口合并
├── InMemoryAgentTimelineStore                 # {epoch, rows, nextSeq}
│   └── timeline-projection.ts                 # canonical → projected 只读派生
├── AgentStorage（agent-storage.ts）           # $PASEO_HOME/agents/ JSON
└── agent-loading.ts: ensureAgentLoaded()      # closed → runtime 的 resume 入口
```

## 调用链路

**一次 turn 的完整链**（真正的"响应循环"就在这里，而非 agent-response-loop.ts）：

```
streamAgent() in agent-manager.ts:2428
├─ startPendingForegroundTurn() → session.startTurn()     # provider 侧
│    └─ turn_started 事件
├─ AgentRunState.createTurnStream() → 逐事件 yield
├─ handleStreamEvent()（:4033）
│    └─ coalescer.handle()          # 被缓冲则吞掉，60ms 后批量 flush
├─ recordTimeline()（:4657）
│    ├─ timelineStore.append()      # 内存 canonical rows
│    └─ 异步 durable append
├─ dispatchStream()                 # 广播 agent_stream
└─ 终态事件 → finalizeForegroundTurn()（:2533）
     ├─ pendingReplacement 且无错 → 保持 running（等替换 turn）
     ├─ lastError → error
     └─ 否则 → idle
        └─ emitState() → checkAndSetAttention()（:4707）
             # running→idle 置 "finished" attention；进 error 置 "error"
```

一个澄清：`agent-response-loop.ts` 名字有误导性——它**不是** prompt 主循环，而是结构化 JSON 生成工具（`getStructuredAgentResponse()` in `agent-response-loop.ts:307`：prompt + JSON Schema → 剥 markdown fence → 校验失败带错误重试 2 次 → 多 provider 降级 `StructuredAgentFallbackError`），供 CLI 的 `--output-schema` 使用。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `createAgent()` | `agent-manager.ts:1200` | 建档（lifecycle 即 `initializing`）+ spawn provider session |
| `streamAgent()` | `agent-manager.ts:2428` | turn 主循环：startTurn → 逐事件消费 → 终态结算 |
| `ensureAgentLoaded()` | `agent-loading.ts:62` | closed → runtime：resume 或重建 + provider 历史回放 |
| `closeAgentRuntime()` | `agent-manager.ts:1637` | 只释放 provider 进程，保留全部身份/timeline |
| `archiveAgent()` | `agent-manager.ts` | 软删除：快照入注册表 → archivedAt → 级联子 agent |
| `runLifecycleMutation()` | `agent-manager.ts:2220` | archive/labels/detach 排入 per-agent 串行队列 |
| `handleStreamEvent()` | `agent-manager.ts:4033` | coalescer 之后的流事件落库与广播 |
| `recordTimeline()` | `agent-manager.ts:4657` | timeline append + durable 持久化 |
| `getTimelineRows()` | `agent-manager.ts:1154` | 游标分页读（tail/after/before） |
| `applySnapshot()` | `agent-storage.ts:249` | 写队列内的落盘投影（保证不覆盖 archivedAt） |
| `settleForegroundRun()` | `agent-run-state.ts:115` | 用随机 token 防旧取消结算新 turn |

</details>

## 核心实现

### 状态机：lifecycle 与 archivedAt 正交

`AGENT_LIFECYCLE_STATUSES` 枚举（`agent-lifecycle.ts` in protocol 包）共五值：`initializing / idle / running / error / closed`——前四个是 **live 运行态**（`initializing → idle → running → idle/error`），`closed` 不是 live 态，而是"无 provider runtime 的持久化记录态"——落盘字段就是 `agent.lifecycle`（`toStoredAgentRecord()` in `agent-projections.ts:83`）。关键转移：

- 建档即 `initializing`（`buildManagedAgentForRegister()` in `agent-manager.ts:3527`）；
- turn 被接受置 `running`（`streamAgent()` 内 streamForwarder，`agent-manager.ts:2494`）；
- `finalizeForegroundTurn()`（`:2533`）三分支决定终态（见调用链）。

`closed` 与 `archived` 是两个独立维度：`closeAgentRuntime()`（`:1637`）只释放 provider 进程，保留 Paseo 身份、timeline、workspace、labels、title、parent 关系；`archivedAt` 才是软删时间戳。**runtime residency** 设计：idle agent 常驻内存，只有显式 lifecycle 动作（archive、替换、reload、workspace 拆除、daemon 关停）才关 runtime——避免"看不见的 agent 被悄悄杀掉"。

**resume 语义**在 `ensureAgentLoaded()`（`agent-loading.ts:62`，注意不在 manager 内）：双 `waitForAgentClose` barrier 防 close 竞态；`pendingAgentInitializations` 去重并发加载；有 persistence handle 走 `resumeAgentFromPersistence()`，否则按存档 config 重建；最后 `hydrateTimelineFromProvider()` 回放 provider 历史——`historyPrimed` 标志保证已水化的 timeline 不重复追加（`initializeAgentTimelineForRegister()` in `agent-manager.ts:3495`）。reload 先释放旧 runtime 再 resume：idle provider 进程可能仍持有排他 writer。

### 持久化：单 JSON + 原子写，无迁移

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`AgentStorage`（`agent-storage.ts`）刻意做减法：

- 单 agent 单 JSON 文件，`STORED_AGENT_SCHEMA`（zod，`:45`）运行时校验，字段全部 `.optional()` + `.default()`——**没有迁移框架**，新字段天然向前兼容，坏文件直接 skip（`readRecordFile()` in `agent-storage.ts:370`）；
- 原子写 `writeJsonFileAtomic()`（temp + rename）；`queueRecordMutation()`（`:162`）per-agent 写队列串行化——写队列内跑 projection，防 pre-archive 旧记录在 archive 后落盘覆盖 `archivedAt`（`applySnapshot()` in `agent-storage.ts:249`）；
- cwd 变更时写新路径并 unlink 旧路径（`writeRecord()` in `agent-storage.ts:187`）；`projectDirNameFromCwd()`（`:430`）用 `path.win32.parse` 跨平台处理盘符/UNC。

⚠️ 待核实：timeline 的持久性实际依赖 provider session 回放（如 Claude Code transcript）而非独立 durable store——v0.8.0 bootstrap 实测未传 `durableTimelineStore`，且会清理 obsolete `agent-timelines/` 目录。即 **provider session 才是 timeline 真源，Paseo 内存 store 是 canonical 视图**。

### Timeline 模型与 coalescing

`InMemoryAgentTimelineStore`：per-agent `{epoch, rows, nextSeq}`，row = `{seq, timestamp, item, turnId?, providerMessageId?}`。`fetch()`（`agent-timeline-store.ts:203`）支持 tail/after/before 游标分页；**epoch 不匹配 → `fetchReset(staleCursor)`，seq 断层 → gap reset**，客户端全量重拉——这就是断线重连后 catch-up 的机制（配合 01 篇的 resume session）。

`AgentStreamCoalescer`（`agent-stream-coalescer.ts`）是 daemon 侧的第一层平滑（客户端还有第二层，见 10 篇）：

- 60ms 窗口（`AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS`）合并 `assistant_message`/`reasoning`/`tool_call` 三类增量；
- **leading-edge 首事件立即 flush**——首 token 不延迟；
- 文本按 `messageId` 拼接（`collapseEntries()`），tool_call 按 `callId` 原位替换，终态 tool_call 即时 flush。

接入点在 `handleStreamEvent()`（`agent-manager.ts:4033`）：先 `coalescer.handle()`，被缓冲则直接吞掉。

`timeline-projection.ts` 是只读派生层：canonical rows → projected entries（`assistant_merge`/`reasoning_merge`/`tool_lifecycle`/`identity`），带 `sourceSeqRanges` 可回溯——投影永不写回 canonical。

### 并发控制：token 与串行队列

两个机制防"旧动作污染新状态"：

- `AgentRunState`（`agent-run-state.ts`）用每次 run 的随机 `token` 追踪：`settleForegroundRun(agentId, token)`（`:115`）发现 token 不匹配就放弃——旧取消不会结算新 turn；
- `runLifecycleMutation()`（`agent-manager.ts:2220`）把 archive/labels/detach 排进 per-agent 串行队列，防止并发生命周期动作交错。

### 归档级联

`archiveAgent()` 的顺序（`agent-manager.ts`）：快照入注册表 → 置 `archivedAt` 并把 `lastStatus` 从 `running`/`initializing` 归一为 `idle`（`normalizeArchivedStatus()` in `agent-archive.ts`，同时清 attention）→ 通知订阅者 → 关 runtime → **解析子 agent**——跨 workspace 或仍在某客户端 tab 里打开的子 agent 被 detach（变成普通 root agent），其余递归级联归档（`cascadeArchiveChildren()`，级联循环内逐个在 `runLifecycleMutation` 里复核 label 与 `archivedAt` 防 TOCTOU）。级联的判定键是 label `paseo.parent-agent-id`（`PARENT_AGENT_ID_LABEL` in protocol `agent-labels.ts`）。级联是防止 subagent 舰队比编排者活得久的机制。`create_agent_request` 可选 `autoArchive`：首个终态 turn 事件后自动归档，若 agent 拥有隔离 workspace 连 workspace 一起归档（managed worktree 在最后一个引用消失时删除）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + 落盘字面量 | `finalizeForegroundTurn()` in `agent-manager.ts:2533` | 状态字面化：父 agent 不因子 agent 运行而变 running（workspace 聚合态另行计算） |
| 写队列（actor 化） | `queueRecordMutation()` in `agent-storage.ts:162` | 单写者串行化，防旧快照覆盖新事实 |
| token 防伪结算 | `settleForegroundRun()` in `agent-run-state.ts:115` | 异步竞态下旧回调作废 |
| 只读投影 | `timeline-projection.ts` | canonical 与展示形态解耦，投影可随时重算 |
| leading+trailing 节流 | `agent-stream-coalescer.ts` | 首 token 零延迟 + 突发批量合并 |

## 模块间交互

- 向上：经 `dispatchStream()`/`emitState()` 喂 01 篇的 Session（`agent_stream`/`agent_update` 广播）；
- 向下：spawn/驱动 03 篇的 provider session（`AgentSession` 接口）；
- 横向：workspace 归属由 11 篇的 workspace registry 管理，agent 只持有 `workspaceId`；
- graphify god nodes 印证核心地位：`AgentManager`（266 边）、`AgentStreamEvent`（291 边，全图第一）、`AgentTimelineItem`（147 边）。

## 扩展方式

- **新增 agent 状态**：`AGENT_LIFECYCLE_STATUSES`（`agent-manager.ts:188` re-export，源头 protocol messages）+ `AgentStatusSchema` + `finalizeForegroundTurn()` 三分支 + `checkAndSetAttention()` 转移 + `BUSY_STATUSES`（`:552`）+ `agent-projections.ts` 落盘 + `STORED_AGENT_SCHEMA.lastStatus` default——状态是贯穿性概念，改动面本身就是它复杂度的证明；
- **改持久化格式**：`STORED_AGENT_SCHEMA` 加 optional 字段即可（向前兼容）；投影改动在 `toStoredAgentRecord()`（`agent-projections.ts:63`）；写必须过 `applySnapshot()`/`queueRecordMutation()`，勿绕过写队列；
- **改 timeline 结构**：`AgentTimelineRow`（`agent-timeline-store-types.ts`）+ `InMemoryAgentTimelineStore.append/fetch` + `timeline-projection.ts` 投影规则 + 客户端 reducer（见 10 篇的修改场景）。
