---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "会话系统与持久化"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "SQLite", "drizzle", "JSONL", "持久化"]
description: "session-system + infra 解读——SessionRecord 36 字段契约（degree 241 全库最高）、record_json 真源 + columnar 部分索引双层 schema、手写顺序迁移（三段式 + 版本碰撞修复）、canonical history JSONL 五键 envelope 写前脱敏、读取四级回退"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`service/session-system/`（~3.3 万行）+ `src/infra/`（~2.1 万行）是 V2 的持久层：会话事实、消息 transcript、以及支撑它们的数据库/事件总线/调度器/跨进程租约等基础设施。它的独立存在的理由是**单写者边界**——turn-system 独占执行，本模块独占持久事实的 schema 与恢复语义。`session-system/owner.ts` 的 `SessionSystemOwner` 是唯一构造点，`initialize.ts` 注释明言 "The only Session owner graph. No repository may be constructed here"。

## 模块架构

![会话持久化](/vibe-reading/images/articles/minimax-code/session-persistence.svg)

纵切四层：业务门面（`SessionRecordService`，1192 行，负责字段规范化与错误语义）→ 契约接口（`SessionRepository`，contract.ts 纯 interface + 26 项能力清单 `SESSION_REPOSITORY_CAPABILITIES`）→ 唯一生产实现（`DrizzleSessionRepository` + codec/normalization/pagination/search/agent-binding 配套）→ `AppDb`（better-sqlite3 + drizzle）。transcript 是旁挂的第二持久化面：AgentHost 侧的 `DurableCanonicalHistoryStore`（包装校验 + `KeyedOperationLane` 串行化）落到 session-system 拥有的 `canonical-history-provider`（布局/迁移/checkpoint/恢复的唯一 owner）再到 JSONL 文件。

## 调用链路

```
创建：CliService → SessionRecordService.createSession（捕获 CapturedTaskAgentBinding 不可变执行载荷）
  → SessionRepository.create → insert local_runtime_sessions
查询：sessions/query/query-service.ts（侧栏聚合 SessionSidebarTreeInput 显式删除 agentName 防跨 Agent 契约收窄）
  → listRootPage / searchPage（FTS 文档读写）——全部 keyset cursor 分页
Fork：fork/data-capability.ts createSessionForkDataCapability
  → createInternalSession({sessionType:'branch', parentSessionId, visibility:'hidden'})
  → display boundary 按消息前缀复制 → assets.copyForMessagePrefix
  → infra/git/fork-worktree-adapter.ts（git worktree + .mavis-fork-ownership.json 所有权 sidecar）
删除：sessions/lifecycle/deletion-service.ts:33 固定顺序
  markLegacyMigrationDeleted → deleteCanvas → deleteArtifacts（peek 会话保留 token 账目）
  → Diff/Communication/ChannelBindings/Questionnaires/Permissions/Goal/QueryCollapse/Pin
  → reparentChildren（子会话挂回祖父）→ deleteSessionRecord → facts.handle({kind:'deleted'})
Transcript 写：AgentHost append/replace/compact/settleTurnTail
  → canonical-history-provider → infra/file/canonical-history-jsonl.ts
  （appendJsonl / publishJsonlIfAbsent / writeJsonlAtomically）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `createSession()` in sessions/lifecycle/record-service.ts | 会话创建门面 | 捕获不可变 agent 执行绑定 |
| `update()` in sessions/repo/contract.ts | 会话更新 | `expectedModel`/`expectedTitle` 乐观检查 |
| `applyAgentState()` in contract.ts:292 | agent 状态应用 | 返回 applied/duplicate/stale/conflict，runtimeSeq 防乱序 |
| `bindHistoryRelativeDir()` | 绑定 history 目录 | first-writer-wins，一次性分配 |
| `deleteSession()` in deletion-service.ts:33 | 级联删除 | 固定顺序，reparentChildren 防孤儿 |
| `initializeDatabase()` in infra/db/initialize.ts:60 | 启动迁移 | 备份 + 三段式 + 一致性断言 |

</details>

## 核心实现

### 双层 schema：record_json 真源 + columnar 部分索引

`schema/sessions.ts` 中 `record_json` 是真源，`columnarVersion=3` 门控的部分索引（`WHERE columnarVersion = 3`）让未回填的旧行不进新索引——**免全表重写**的渐进列化。由 migration-0006（DDL）/0007（backfill，1200 行）落地。`codec.ts` 的 `encodeSessionRow`/`decodeSessionRow` 承担行↔record 编解码。

### 手写顺序迁移而非 drizzle-kit generate

`migrations.ts` 的 `ALL_MIGRATIONS` 按域分组（runtime/session/cron/agent/canvas/miniapp/plugin），版本号记于 `local_runtime_v2_schema_migrations`。启动流程 `initializeDatabase`：读已应用版本 → 有 pending 时先 backup（SQLite online backup API + 独立只读连接 `PRAGMA integrity_check` 验证）→ **三段式**：`runMigrations(<7)` → `recoverLegacySessionRecordsBeforeBackfill` → `runMigrations(<15)` → `recoverSessionProjectMetadataBeforeRepair` → `runMigrations(ALL)` → `assertDatabaseSchemaConsistent`——中途插数据恢复是因为 backfill 必须发生在 DDL 之后、后续迁移之前。还有多个 `repair-*-version-collision` 迁移（0027/0028/0029），修复"已发布版本占了号但没建表"的碰撞。发布版 schema 由 `sql-contract.ts` + migration-0006 冻结。

### canonical history：JSONL、脱敏、四级回退

envelope 仅 5 个 key（`message_id`/`turn_id`/`message`/`turn_config`/`history_artifact`）。写前对 `SENSITIVE_COMPACT_KEYS`（apikey/token/cookie 等约 60 个敏感键）脱敏；崩溃尾巴由 `repairCanonicalHistory` 修复，`JsonlAppendCommitUncertainError` 处理提交不确定。**读取**带四级回退：`selectCanonicalHistorySource` 按 target 文件 → ledger snapshot → sqlite rows → sqlite blob 顺序选权威源。旧 opencode 数据由 `legacy-db` 的 `createLegacyOpencodeReadonlySource`（只读连接打开旧 `sourceDataDir/sqlite.db`）承接，`canonical-history-materializer.ts` 带 checkpoint 迁移。

### infra 横切设施

`AppDb`（client.ts:111-133）：v1 与 v2 进程**临时共用同一 DB 文件、各自连接**，故 PRAGMA 显式对齐（WAL / busy_timeout 5000 / foreign_keys ON）；better-sqlite3 原生模块加载路径可被 `sqlite3ModulePath`/`MAVIS_SQLITE3_MODULE_PATH` 覆盖（为 Electron native rebuild 服务）。`scheduler`（croner + `scheduler_jobs` 表持久化，业务侧只见无 start/stop 的能力面）；`event-bus`（live-only fan-out，单个订阅者抛错被吞）；`sse`（`BoundedRing` + `SubscriberRegistry`，溢出抛 `SubscriberOverflowError` 背压断流）；`runtime-owner`（proper-lockfile + lease 文件，ownerId `kind:pid:instanceId.opId`，process start token 防 PID 复用，四类租约）；`storage-retention` 双件——infra 侧只修剪固定日志根（7 天，2000 entry 预算防爆走），session-system 侧只做单次有界 Turn Diff 修剪，"已迁移 Session history 刻意排除在自动 retention 之外"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Repository + 契约接口 | contract.ts 纯 interface + capability 数组 | 实现可替换（测试/未来云端） |
| 单一 Owner 装配图 | `SessionSystemOwner`（owner.ts） | 防 repository 散构造 |
| CAS/幂等写 | `transitionSessionInteractionModeInTransaction`、`applyAgentState` | 乱序事件防御 |
| Port/Adapter | `DurableCanonicalHistoryProvider` 注入 store | AgentHost 与存储解耦 |
| 进程内 EventBus | infra/event-bus/index.ts | 订阅者隔离 |

## 模块间交互

runtime.ts 装配 `DatabaseClient`/`initializeDatabase`/`Scheduler`/`EventBus`/`RuntimeOwnerIdentity`；`application/session/runtime-session-composition.ts:418` 直接消费 `sessionSystem.repositories.sessions`；turn-system 的 production-composition 把 history provider 接给 AgentHost；`initialize.ts` re-export 各 repo（sessions/messages/usage/projects/queue/legacy-migration）供 application 层使用。

## 扩展方式

- **新增会话字段**（无 DDL 路径）：`SessionRecord`/`SessionCreateInput`（不可变字段加入 `CanonicalSessionUpdateFields` 的 Omit 列表）→ `record-service-fields.ts` 规范化 → `drizzle/codec.ts` 编解码（字段落 `record_json`/`extraDataJson`）；需按它过滤排序则加 columnar 列 + 新 migration（编号参考 0036）+ `schema-consistency.ts` 校验。
- **新增一张表**：`infra/db/schema/<域>.ts` `sqliteTable` → `migrations/<域>/migration-00NN-*.ts` 实现 up → `migrations.ts` 注册（注意版本碰撞先例）→ repo 层照 `sessions/repo/drizzle.ts` 模式建 contract + 实现 + `owner.ts` 装配。
- **新增 transcript 写入语义**（turn 级 mutation）：`agent-host/history/contracts.ts` 加 mutation 类型 → `durable-canonical-history-store.ts` 加方法（走 `lane.run` 串行化）→ provider 可选实现（缺省抛 `AgentHostDependencyUnavailableError`）。
