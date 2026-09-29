---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "会话与事务"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "事务"]
description: "TiDB 会话与事务解读：sessionctx.Context 贯穿设计、LazyTxn 三态、TxnManager 与四种隔离级别 provider"
readingTime: "22 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/session/` + `pkg/sessiontxn/` + `pkg/sessionctx/` 构成语句执行的编排中枢：server 层每连接持有一个 session，所有语句在这里获得事务上下文、schema 快照与变量环境，再被派发给编译执行。事务语义（autocommit、显式 BEGIN/COMMIT、乐观/悲观、四种隔离级别）不是散落在 executor 里的 if，而是集中在 `TxnManager` + 隔离级别 provider 的一套钩子体系。命名提示：2026 快照中实现类型是小写 `session`（`session.go:194`），对外只暴露 `sessionctx.Context` 接口——**接口即模块边界**。

## 模块架构

```
pkg/session/
├── session.go            # session 结构 + executeStmtImpl（语句编排）
├── txn.go                # LazyTxn：Invalid/Pending/Valid 三态包装 kv.Transaction
├── tidb.go               # runStmt/finishStmt/autoCommitAfterStmt（提交决策）
├── txnmanager.go         # txnManager：TxnManager 实现（全部委托 provider）
└── bootstrap.go          # 首次启动建系统表
pkg/sessiontxn/
├── interface.go          # TxnManager / TxnContextProvider 接口（:160/:116）
├── internal/txn.go       # EnterNewTxn 的公共实现
├── isolation/base.go     # baseTxnContextProvider（模板方法基座）
│   ├── readcommitted.go / repeatable_read.go   # 悲观 RC/RR provider
│   ├── optimistic.go / serializable.go
│   └── staleread/        # stale read provider
pkg/sessionctx/variable/
└── session.go            # SessionVars / TransactionContext（StmtCtx 与 TxnCtx 分离）
pkg/kv/kv.go              # Storage/Transaction 接口（:263，模块间的接缝）
```

## 调用链路

```
session.ExecuteStmt → executeStmtImpl            pkg/session/session.go:2424
├─ PrepareTxnCtx (session.go:5145)               # 无事务则惰性进新事务（不取 TSO）
├─ executor.ResetContextOfStmt                   # 每语句重建 StmtCtx
├─ sessiontxn.GetTxnManager(s).OnStmtStart        # → provider.OnStmtStart
│   （重试走 OnStmtRetry；session.go:2882）
├─ [编译执行] Compiler.Compile → ExecStmt.Exec
└─ runStmt (session.go:2991) → finishStmt (tidb.go:225)
    ├─ txn.StmtCommit / StmtRollback             txn.go:743/759
    │   # 先回调 TxnManager.OnStmtCommit/OnStmtRollback 再 flush/discard staging
    └─ autoCommitAfterStmt (tidb.go:321)
        └─ !InTxn() → CommitTxn (session.go:984) → doCommitWithRetry
```

BEGIN/COMMIT 的落点：`SimpleExec` in `pkg/executor/simple.go:652` 调 `EnterNewTxn(EnterNewTxnWithBeginStmt)`（`isolation/base.go:81`）——`CommitBeforeEnterNewTxn` 清残留 + `SetInTxn(true)` + 把**当前最新 InfoSchema 固化进 TxnCtx**；COMMIT 语句本身只置 `InTxn=false`（`simple.go:791`），真正提交由语句结束的 `autoCommitAfterStmt` 统一完成。

| 概念 | 位置 | 职责 |
| --- | --- | --- |
| `SessionVars` | `variable/session.go:809` | 全部会话变量 + `TxnCtx` + status 位标志 |
| `TransactionContext` | `variable/session.go:181` | StartTS/InfoSchema/forUpdateTS 等，按 savepoint 拆两段 |
| `LazyTxn` | `pkg/session/txn.go:49` | kv.Transaction 的三态包装 |
| `TxnContextProvider` | `sessiontxn/interface.go:116` | 隔离级别钩子全集 |

## 核心实现

### sessionctx.Context：为什么一切都走接口传递

`session` 结构里没有全局变量，一切状态（变量、事务、警告、内存追踪）都挂在 `sessionctx.Context`（`sessionctx/context.go:80`）上随调用链传递。三个理由：**并发会话数以万计**，全局状态互踩；**internal session**（DDL/stats 后台任务）需要与用户会话同构但独立的环境；**会话可序列化**（`EncodeStates/DecodeStates`，context.go:83）支撑 serverless 场景的迁移。两个典型避环设计顺带说明架构纪律：session 持 `dom any`（实为 `*domain.Domain`）与 `SessionVars.TxnManager any` 都是为了不反向 import domain/sessiontxn——类型断言发生在使用点，依赖方向保持单向。

### LazyTxn 三态与惰性 TSO

```
Invalid ─语句触发→ Pending（txnFuture 未取 TSO）─取 TSO→ Valid ─commit/rollback→ Invalid
                 └── 未激活即结束 → 直接丢弃（changeToInvalid）
```

`Pending` 态的意义：`set @@x=1; select 1` 这类不碰数据的语句**不消耗 TSO 往返**，第一个真正需要读写的语句才激活事务。语句级修改先进 `stagingHandle`（`initStmtBuf`）：语句失败 `StmtRollback` 丢弃 staging，成功 `StmtCommit → flushStmtBuf` 合入事务 MemBuffer——**语句原子性在 session 层实现**，与 TiKV 无关。

### TxnManager 与隔离级别：四个类只差两个函数

`TxnManager` 接口（`sessiontxn/interface.go:160`）的全部方法都委托给 `TxnContextProvider`；provider 按（乐观/悲观 × RC/RR/SI）组合出五个实现：`baseTxnContextProvider`（`isolation/base.go:57`）是模板方法基座，子类只注入 `getStmtReadTSFunc` 与 `getStmtForUpdateTSFunc` 两个函数字段。第六个维度是 **stale read**（`sessiontxn/isolation/staleread/processor.go`）：`NewStaleReadProcessor` 在语句级决定读 TS 来源——显式 `AS OF TIMESTAMP` 评估新 TS、事务内则复用 `TxnCtx.StartTS`（`evaluateFromTxn`），配套返回对应的 stale InfoSchema，与事务体系解耦。对比读三个实现就看懂隔离级别的全部差异：

- RR（`repeatable_read.go:67`）：`getStmtReadTSFunc = getTxnStartTS`——整事务恒用 `TxnCtx.StartTS`，即**快照读**；
- RC（`readcommitted.go:180`）：`getStmtTS` 每条语句取最新 TSO——每语句新快照；
- 悲观istic RR：写语句前 `updateForUpdateTS` 抬升 `forUpdateTS`，当前读看到最新提交。

写-写冲突检测不在 session 层：乐观冲突由 TiKV prewrite 报错（session 侧 `doCommitWithRetry` 重放），悲观锁由 `kv.Transaction.LockKeys`（store 层）先加。乐观重放的**重试上限随事务大小递减**：`doCommitWithRetry` 里 `maxRetryCount = commitRetryLimit - int64(float64(commitRetryLimit-1) * txnSize / kv.TxnTotalSizeLimit)`——大事务每次重放代价高，给更少机会；且 `BatchInsert`、悲观事务、pipelined DML 三种情况直接禁止重试（语义不可安全重放），`TxnCtx.CouldRetry=false` 时 `RetryLimit` 归零。这套"session 定语义、store 定冲突"的分工让隔离级别调整（如新增 serializable provider）只动一个文件。

### EnterNewTxn 固化 InfoSchema

`baseTxnContextProvider.EnterNewTxn`（`base.go:122-128`）把 `GetLatestInfoSchema()` 的结果存进 `TxnCtx.InfoSchema`——**同一显式事务的所有语句看到同一份 schema**，避免 DDL 在事务中途改变列语义。planner/executor 全部经 `GetTxnInfoSchema()` 取用。`schemaValidator` 在 commit 前做最后一次校验（本事务读过的表 schema 是否已变，变了则报 retryable 错误），这是事务与 DDL 的交叉保护。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Context | `sessionctx.Context` in `context.go:80` | 状态随调用链显式流动，无全局变量 |
| 模板方法 + 策略 | `baseTxnContextProvider` in `isolation/base.go:57` | 隔离级别差异收敛为两个函数注入 |
| 状态机 | `LazyTxn` in `txn.go:49` | 惰性 TSO + 语句 staging 的生命周期建模 |
| 委托 | `txnManager` in `pkg/session/txnmanager.go:53` | session 不感知隔离细节，全部转发 |

## 模块间交互

上游：server 层每连接 `driver.OpenCtx` 建 session（经 `TiDBContext` 防腐，见 [10-server](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/10-server)）。下游：executor 经 `sessionctx.Context` 读变量与事务；commit 走 `kv.Transaction.Commit` 进 store 层（见 [08-store](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/08-store) 的 2PC）。侧向：`GetTxnInfoSchema` 消费 domain 的 `InfoCache`（见 [09-domain-infoschema](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/09-domain-infoschema)）；错误路径经 `OnStmtErrorForNextAction` 决定悲观重试或 TiFlash 回退。

## 扩展方式

新增会话变量：`pkg/sessionctx/vardef/tidb_vars.go`（定义+默认值）+ `pkg/sessionctx/variable/sysvar.go`（`SysVar` 注册与 validation）+ 消费点；影响其他变量的联动要挂 `variable/setvar_affect.go`。调整事务行为开关：改 `isolation/base.go` 公共钩子或具体 provider 的 `getStmtForUpdateTSFunc`；语句边界行为改 `pkg/session/tidb.go` 的 `finishStmt/autoCommitAfterStmt` 与 `txn.go` 的 `StmtCommit/StmtRollback`。
