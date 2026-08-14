---
source:
  type: "源码解读"
  project: "deepseek-harness"
  url: "https://github.com/deepseek-ai/deepseek-harness"
title: "Session 日志与持久化"
date: "2026-08-14T17:00:29+08:00"
category: [AI, Agent, "Harness Engineering", DeepSeek Harness, CodeWiki, "0.1.0-rc.5"]
tags: ["DeepSeek Harness", "Session Log", "Event Sourcing", "Persistence"]
description: "dsh 的 append-only SessionEvent log——model-visible 等价于 logged 的真相源，deriveMessages 投影、JSONL/SQLite 持久化、fork/resume 与检索。"
readingTime: "16 min"
aiModel: "Claude Sonnet 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeepSeek-Harness/CodeWiki/0.1.0-rc.5/00-overview)

---

## 模块定位

Session log 是 dsh 的**真相源**。`packages/core/session` 提供 append-only `SessionEvent` log 与 in-memory store（`ctx.sessions`），`packages/session/session-persistence` + `session-persistence-jsonl`/`session-persistence-sqlite` 提供持久化 seam，`packages/session-query/*` 提供检索。核心不变量：**model-visible ⟺ logged**——任何到达 model request 的内容必须可从 session log 重建，runtime invariant 断言之。fork/resume/transcripts/telemetry/persistence 都从这条 append-only 流派生。这层独立是因为它把"模型看到了什么"从内存状态变成可重放的事实流。

## 模块架构

```
core/session (ctx.sessions)  ──append-only──▶  Session.log: SessionEvent[]
   ├─ SessionStore (index.ts:792): create/prepare/enter/announce/flush/fork
   ├─ SurfaceManager (surface.ts): fold log → 有序 surface nodes
   ├─ deriveMessages() (index.ts:726): surface nodes → Message[]  (read model)
   └─ session/event emit (fire-and-forget) → persistence plugin write-behind
                          │
session-persistence (ctx.sessionPersistence)  ──seam──▶  PersistenceCoordinator
   ├─ PersistenceBackend<TornMarker> hooks: loadStored/appendBatch/commitRepair/list/close
   ├─ session-persistence-jsonl: 每 session 一个 .jsonl(.zstd)，chunk-rows 压缩
   └─ session-persistence-sqlite: SCHEMA_VERSION=15 (PRAGMA user_version)
                          │
session-query (ctx.sessionQuery): listSessions/readSession/filterEvents/traceSession/searchEvents
   └─ session-query-sqlite: FTS5 unicode61, live shadow durable
```

## 调用链路

append → broadcast → 投影 → 持久化：

```
Session.append(type, data, opts?)  (index.ts:604)
  ├─ snapshotJsonValue(data)           # one-pass JSON 验证+拷贝
  ├─ SurfaceManager.validateNext(event)  # 预验 surface transition
  ├─ log.push(event); eventsSnapshot 失效   # commit
  ├─ ctx.emit('session/event', session, event)  # fire-and-forget
  │     └─ persistence plugin 的 write-behind 监听器 buffer 进 batch
  └─ ctx.sessions.flush(session)  (index.ts:715)
        └─ ctx.parallel('session/flush')  # awaited durability checkpoint
              └─ PersistenceCoordinator 刷新 batch 到 backend

deriveMessages()  (index.ts:726)
  ├─ surface.nodes (SurfaceManager 维护的有序 seq 列表)
  ├─ 对每个未投影 node 调 deriveEventMessage(event)  (surface.ts:83)
  │     user/message → UserMessage; assistant/message → AssistantMessage
  │     tool/result → ToolResultMessage; 其他 → null (chunk 跳过)
  └─ 返回 fresh frozen Message[]  (复用已冻结 event data)
```

数据类型变化：`SessionEvent`（raw log）→ `SessionSurface.nodes`（有序 seq 投影）→ `Message[]`（model history）。`assistant/chunk` 在 log 中保留但 `deriveEventMessage` 跳过——assembled `assistant/message` 才是 authoritative。

## 核心实现

### SessionEvent 与 SessionEventMap

`SessionEvent`（`types.ts:404`）是基于 `type` 的 discriminated union，`switch(event.type)` 可无 cast 收窄 `event.data`。每条含 `seq`（单调，`seq = log.length`）、`time`、`data`。条件字段 `sourceEventSeqs?`/`surfaceOp?` 仅存在于 `SurfaceEventType`（`user/message` | `assistant/message` | `tool/result`）。

`SessionEventMap`（`types.ts:236`）是 merge-extensible 接口，定义全部 append-only 事件词汇：`turn/start`、`turn/end`（携 `TurnEndReason`）、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header` 等。插件通过 declaration merging 扩展（如 compaction 的 `compaction/*`、hook 的 `hook/*`）。

### Ignorable envelope 与 required-on-read

`ignorable?: true`（`types.ts:422`）缺省意味着 required。未知 type 事件若无此标记，reader 必须拒绝重建而非静默丢弃——"absent `ignorable` = required"防的是静默丢事件：一个 forgotten marker over-refuses（inconvenience）而非 silently resume gutted session。`KNOWN_SESSION_EVENT_TYPES`（`known-event-types.ts`，由 `gen-persistence-catalog.ts` 生成）是 build-time 已知的全部 in-repo 事件类型，persistence read path 据此拒绝 unknown required type。

### 持久化 seam 与版本

`SessionPersistence extends Service`（`session-persistence/src/index.ts:84`）是抽象 seam，JSONL/SQLite 是 sibling provider。`PersistenceCoordinator`（`coordinator.ts`）共享 write-behind 编排：per-id 状态机 + bounded batching + crash repair + LRU inspection cache + revision freshness check。Backend 实现 `PersistenceBackend<TornMarker>` hooks。

两个版本号：`SCHEMA_VERSION = 15`（`session-persistence-sqlite/src/schema.ts:20`）是 SQLite 物理表结构版本，存于 `PRAGMA user_version`，`onDisk !== 0 && onDisk !== SCHEMA_VERSION` 直接 reject；`SESSION_FORMAT_VERSION = 0`（`types.ts:56`）是逻辑 session log 格式版本，stamped 进 `SessionHeader.version`。pre-release 期间 pinned 0 无兼容承诺。"backends reject old on-disk formats" 因一个 older runtime 无法语义正确解读 newer log（"能 parse"不等于"正确"）。

### Crash repair

`interruptedTurnClosers()`（`repair.ts:27`）为 crash-orphaned turn 合成 `tool/result`（`TOOL_NOT_STARTED`/`TOOL_OUTCOME_UNKNOWN`）+ `step/end` + `turn/end {interrupted}`——load 时合成 closer 而非 truncate。

### 检索 query

`SessionQueryEngine`（`ctx.sessionQuery`）组合 live `ctx.sessions` + optional `ctx.sessionPersistence` 的 live-preferred corpus：`listSessions`/`readSession`/`filterEvents`/`listEvents`（分类 `current`/`shadowed`/`log-only`）/`readSurface`/`traceSession`（lineage）/`traceEvent`（positional replacement chain）/`searchSessions`/`searchEvents`（FTS）。SQLite FTS5 `unicode61`，TEMP live rows shadow durable base。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Append-only log / Event-sourcing | `Session.log` immutable + `Session.append()`（`index.ts:604`） | replay = 从 log 重新派生 |
| Projection (read model) | `deriveMessages()` + `SurfaceManager`（`surface.ts:398`） | surface 是 log 上有序投影，cached incrementally |
| Seam (Provider swap) | `SessionPersistence` + `PersistenceBackend` hooks | JSONL/SQLite 共享 coordinator lifecycle |
| Declaration merging | `SessionEventMap`（`types.ts:236`）+ `TurnEndReasonMap` | 插件扩展事件词汇 |
| Crash repair (synthetic closers) | `interruptedTurnClosers()`（`repair.ts:27`） | 不 truncate 而合成缺失的 turn 结束 |

## 模块间交互

`ctx.sessions` 被 agent-loop 调用（append/deriveMessages/flush）；persistence plugin 订阅 `session/event` 做 write-behind；LLM 的 `assistant/chunk`/`assistant/message` 写入；tools 的 `tool/call`/`tool/result` 写入；UI（client runtime）从 `session/event` 渲染。`session/flush` 是 `ctx.parallel` awaited checkpoint——append 返回前保证 durable。

## 扩展方式

- **新增一种 model-visible 输入**：declaration-merge 扩展 `SessionEventMap`；若产生 LLM message，加入 `SurfaceEventType` union（`types.ts:343`）并实现 `deriveEventMessage`（`surface.ts:83`）投影规则；更新 `gen-persistence-catalog.ts` 重新生成 `known-event-types.ts`；若 event 携带非 JSON-serializable 数据会破坏 on-disk format，需 bump `SESSION_FORMAT_VERSION`。
- **新增 persistence backend**（如 Postgres）：实现 `SessionPersistence` 或 compose `PersistenceCoordinator` + 实现 `PersistenceBackend<TornMarker>` hooks；遵守 append-only、contiguous seq、`append` 返回前 durable、`load` 合成 crash closers 而非 truncate。
- **新增 SQLite 物理表/列**：bump `SCHEMA_VERSION`，`onDisk !== SCHEMA_VERSION` check 拒绝旧库，pre-release 不提供 migration 需删除重建 derived index。

## 重要设计决策

为什么 model-visible ⟺ logged：若 model-visible 内容不在 log 中，fork/resume/replay 无法重建 model history 导致 divergence，invariant 由 `dsh-session/invariant` companion + always-on validation 保证。为什么 chunk 事件保留：`seq` 必须 contiguous，chunks 不能从 canonical log 过滤；保留为 replay/UI 保真（token-level stream 重建）+ telemetry adoption consumer 从 `firstLiveSeq` 起 replay 作为 publication substitute。为什么 required-on-read 默认：absent `ignorable` = required，reader 遇未知 type 必须拒绝——防静默丢事件，over-refuse 优于 silently resume gutted session。为什么 fork/resume 从 log 派生：`create(id, { seed })` 验证 seed 走与 append 相同 invariant + rebuild surface + append `session/end-seed` marker；`fork(source, boundary?, childSessionId?)` 选 completed-turn prefix deep-clone seed events + child lineage metadata。
