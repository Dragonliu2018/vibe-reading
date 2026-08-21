---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "查询调度中枢"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "tcop", "PostgresMain", "Portal", "查询流水线"]
description: "PostgreSQL tcop 模块——PostgresMain 主循环、exec_simple_query 四阶段编排、Simple/Extended Query 协议、Portal 五策略、ProcessUtility 分发"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/tcop/`（Traffic Cop）是 PostgreSQL 后端进程的中央调度中枢。每个 backend 进程 fork 后，最终都进入 `PostgresMain` 主循环——读取客户端查询消息，依次调用 parser → rewriter → planner → executor 执行，并把结果返回客户端。tcop 是整个查询生命周期的「编排器」，是唯一同时知道四个编译阶段的模块。它的存在让这四个阶段保持解耦：parser/rewrite/optimizer/executor 互不直接调用，全由 tcop 串联，任何一阶段可独立替换或缓存。

---

## 模块架构

tcop 由三块组成：**主循环与协议分发**（`postgres.c` 的 `PostgresMain`/`SocketBackend`/`exec_simple_query`/`exec_parse_message` 等）、**Portal 生命周期**（`pquery.c` 的 `PortalStart`/`PortalRun`/`PortalRunMulti`）、**utility 命令分发**（`utility.c` 的 `ProcessUtility`/`standard_ProcessUtility`/`ProcessUtilitySlow`）。`dest.c` 提供 `DestReceiver` 结果接收器抽象。

核心协作：`PostgresMain` 读消息 → `switch(firstchar)` 分发到 `exec_simple_query`（Simple Query）或 `exec_parse/bind/execute`（Extended Query）→ 两者都汇入 `CreatePortal → PortalStart → PortalRun → PortalDrop` 生命周期。

---

## 调用链路

`exec_simple_query`（`postgres.c:1012`）的四阶段流程，是理解整个查询路径的骨架：

```
char *query_string
  │
[postgres.c:604] pg_parse_query() → raw_parser()  ── 产出 List<RawStmt>
  │
[postgres.c:666] pg_analyze_and_rewrite_fixedparams()
  ├── parse_analyze_fixedparams()  ── 语义分析 → List<Query>
  └── pg_rewrite_query() → QueryRewrite()  ── 规则重写
  │
[postgres.c:971] pg_plan_queries() → planner()  ── 产出 List<PlannedStmt>
  │
CreatePortal → PortalDefineQuery → PortalStart → PortalRun → PortalDrop
  └── [pquery.c:685] PortalRun → ExecutePlan → ExecProcNode 迭代器
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PostgresMain` | backend 查询主循环 | sigsetjmp 最外层错误恢复，非 PG_TRY |
| `exec_simple_query` | Simple Query 全流程 | 多语句包隐式事务 |
| `exec_parse_message` | Extended Query Parse | 预编译 CachedPlanSource 可复用 |
| `PortalStart` | 选择执行策略 | `ChoosePortalStrategy` 五策略 |
| `PortalRun` | 执行 Portal | max_rows 支持游标分批 |
| `ProcessUtility` | DDL/utility 分发 | hook 扩展 + Event Trigger 分层 |

---

## 核心实现

### PostgresMain 主循环

`PostgresMain`（`postgres.c:4188`）是 backend 永不退出的主循环。关键结构：

```c
// src/backend/tcop/postgres.c:4188
void PostgresMain(const char *dbname, const char *username);
// sigsetjmp(local_sigjmp_buf, 1) 设错误恢复锚点  ← postgres.c:4397
// for (;;) {
//   if (send_ready_for_query) ReadyForQuery();  // 发 'I'/'T'/'E' 状态码
//   firstchar = ReadCommand(&input_message);    // 阻塞读消息
//   switch(firstchar) {
//     PqMsg_Query    → exec_simple_query()
//     PqMsg_Parse    → exec_parse_message()
//     PqMsg_Bind     → exec_bind_message()
//     PqMsg_Execute  → exec_execute_message()
//     PqMsg_Sync     → finish_xact_command()
//     PqMsg_Terminate → 退出
//   }
// }
```

错误恢复用 `sigsetjmp`/`longjmp` 而非 `PG_TRY`（`postgres.c:4397` 注释）：`PG_TRY` 的 CATCH 块执行时无外层异常处理器，若恢复代码本身出错会无 catch-all；`sigsetjmp` 始终保持最外层锚点。恢复序列：`EmitErrorReport` → `AbortCurrentTransaction`（事务系统才知道如何正确回滚锁/buffer/snapshot）→ `PortalErrorCleanup` → 若在 extended query 中设 `ignore_till_sync` 跳过到 Sync。

事务状态机通过 `ReadyForQuery` 的状态码体现：`'I'`（idle，`TBLOCK_DEFAULT`/`TBLOCK_STARTED`）、`'T'`（in transaction）、`'E'`（error，等 ROLLBACK）。

### exec_simple_query 全流程

`exec_simple_query`（`postgres.c:1012`）处理 Simple Query Protocol。一条 query_string 可含多条 SQL（分号分隔）。关键点：

- **多语句隐式事务**：`use_implicit_block = (list_length > 1)`（`postgres.c:1114`），`BeginImplicitTransactionBlock` 把所有语句包一个隐式事务。
- **每条 parsetree 独立 Portal**：循环内对每个 `RawStmt` 分别 analyze→rewrite→plan→Portal 全流程。
- **内存管理**：非最后一条用独立 `per_parsetree_context`，处理完即释放；最后一条复用 `MessageContext`。
- **快照管理**：analyze 前 `PushActiveSnapshot`，plan 后 `PopActiveSnapshot`；执行前重新取快照（`postgres.c:1219-1228` 注释：避免锁表前取快照导致可见性异常）。

### Extended Query 协议

扩展协议拆五条消息，支持参数化与预编译：

```
PqMsg_Parse    → exec_parse_message()   ── pg_parse + analyze → CachedPlanSource（预编译）
PqMsg_Bind     → exec_bind_message()    ── 绑参数 → CachedPlan → CreatePortal + PortalStart
PqMsg_Describe → exec_describe_*()      ── 返回 RowDescription
PqMsg_Execute  → exec_execute_message() ── PortalRun（max_rows 支持部分执行）
PqMsg_Sync     → finish_xact_command()  ── 事务边界，发 ReadyForQuery
```

Portal 在扩展协议中的角色：Parse 创建 `CachedPlanSource`（预编译计划源）；Bind 绑参数生成 `CachedPlan` 创建并初始化 Portal；Execute 调 `PortalRun`，`max_rows>0` 支持游标分批（返回 `PortalSuspended`）。错误后 `ignore_till_sync=true` 跳过所有消息直到 Sync（保证协议同步）。

| 维度 | Simple Query | Extended Query |
| --- | --- | --- |
| 多语句 | 一条消息多条 SQL | 每条一条 |
| 参数化 | 不支持 | 支持 `$1`,`$2` 占位符 |
| 预编译 | 每次全量 | CachedPlanSource 复用 |
| 部分执行 | 不支持 | max_rows 游标式 |

### Portal 机制

Portal（`portal.h:115`）是「ready-to-run 状态容器」，封装已编译计划 + 绑定参数 + 执行策略 + 执行器状态 + 结果元数据 + 资源所有权。五种执行策略由 `ChoosePortalStrategy`（`pquery.c:210`）在 `PortalStart` 时选：

```
PORTAL_ONE_SELECT      — 单条 SELECT，PortalStart 即 ExecutorStart
PORTAL_ONE_RETURNING   — INSERT/UPDATE/DELETE with RETURNING
PORTAL_ONE_MOD_WITH    — SELECT with modifying CTE
PORTAL_UTIL_SELECT     — 返回元组的 utility（SHOW/EXPLAIN）
PORTAL_MULTI_QUERY     — 一般情况（多语句/无 RETURNING DML/DDL）
```

Portal 存在的理由：解耦「查询编译」和「查询执行」——游标分批、参数复用（Bind 后多次 Execute）、资源隔离（独立 `ResourceOwner`/`MemoryContext`）、策略分发统一五条执行路径。

### ProcessUtility 分发

DDL/utility 命令（CREATE/ALTER/DROP/COMMIT/VACUUM）不走 executor，走 `ProcessUtility`（`utility.c:499`）。分层：`ProcessUtility_hook`（插件如 pg_stat_statements）→ `standard_ProcessUtility`（`utility.c:543`，fast path 处理事务控制/copy/vacuum 等）→ `ProcessUtilitySlow`（`utility.c:1092`，需 Event Trigger 的 DDL）。

为什么 DDL 不走 executor：executor 的三段式专为 DML 行流设计；DDL 是元数据操作，需权限检查、依赖追踪、事件触发器、子命令递归——完全不同的执行模型。分层还因 Event Trigger 代码不能在 `START TRANSACTION` 时调用（`utility.c:534` 注释：刷新 event trigger 缓存需有效事务），故事务控制命令在 fast path，需 event trigger 的 DDL 下放 `ProcessUtilitySlow`。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 编排器（Orchestrator） | `exec_simple_query` | 单点串联四阶段，保持阶段解耦 |
| 状态容器 | Portal | 解耦编译与执行，支持游标/复用/隔离 |
| 钩子 | `ProcessUtility_hook`、`ExecutorStart_hook` | 插件注入不改内核 |
| sigsetjmp 恢复 | `postgres.c:4397` | 最外层 catch-all，恢复代码出错也能回锚点 |

---

## 模块间交互

tcop 调用下游入口：`raw_parser`（parser）、`parse_analyze_*`（parser）、`QueryRewrite`（rewrite）、`planner`（optimizer）、`ExecutorStart/Run`（executor）、`ProcessUtility`（utility 自身）、`StartTransactionCommand`/`CommitTransactionCommand`（access/transam xact）、`CreateDestReceiver`（dest）。被 `backend_startup.c:124` 的 `BackendMain` 唯一调用。

---

## 扩展方式

**新增协议消息**：`libpq/protocol.h` 定义消息类型码 → `PostgresMain` 的 `switch(firstchar)` 加 case（`postgres.c:4752`）→ 编写 `exec_xxx_message()` 复用现有 parse/bind/execute 逻辑 → 处理事务边界与 `ignore_till_sync` 错误恢复。

**新增 Portal 策略**：`portal.h` 的 `PortalStrategy` enum 加类型 → `ChoosePortalStrategy`（`pquery.c:210`）加选择逻辑 → `PortalStart`/`PortalRun` 的 switch 加 case → 处理快照管理。
