---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "PostgreSQL 查询层"
date: "2026-09-23T00:55:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "PostgreSQL", "YSQL", "pggate", "YbSeqScan", "共享内存", "表达式下推"]
description: "YugabyteDB PostgreSQL 查询层解读——fork 整个 PG 15.12 而非协议中间层的三条硬理由、IsYBRelation 运行时分支 + 核心结构体加字段的改造模式、YbSeqScan 新 node 而非 Custom Scan、共享内存 Perform 通道全解"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

YSQL 的本质：**不是 libpq 协议中间层，而是把 PG backend 进程本身变成 DocDB 的客户端**。`src/postgres/`（PG 15.12 fork，~216 万行）+ `src/yb/yql/pggate/`（45.5k 行）+ tserver 的 `pg_client_session.cc`（4895 行）。三个架构事实：

1. **每节点一个 postmaster**：yb-tserver 经 `PgSupervisor` 拉起 postgres（默认 5433），psql 直连或经 Odyssey 分叉的 ysql connection manager（6433）
2. **每个 backend 进程内静态链接 pggate C++ 库**：`YBInitPostgresBackend()`（pg_yb_utils.c:1021）注入回调，pggate 与 PG **双向共享内存管理**（`PgMemctx` 挂到 PG MemoryContext）
3. **backend 只和本节点 tserver 通信**：`PgClient` 只有指向本地 tserver PgClientService 的 proxy——所有 DDL/元数据/锁/事务全部经本地 tserver 中转。本地地址从共享内存 `TServerSharedData` 读出

## 模块架构

### Table Access Method：不是换 AM，而是改 AM

任务中常猜测的 `yb_ddl`/`yb_basics` 扩展**不存在**。实际机制：

- **heap AM（oid 2）保留，heapam.c 内部运行时分支**：`heap_beginscan()` 开头 `if (IsYBRelation(relation)) return ybc_heap_beginscan(...)`（heapam.c:1171）；`heap_getnext/endscan/insert` 同样分支（`heap_insert` 对 YB relation 直接 `ereport(ERROR)`——写路径走 executor 层）。`IsYBRelation`（pg_yb_utils.c:410）= relkind 白名单 + 非 temp
- **index AM 在 `pg_am.dat` 新增两个 YB 专属 AM**：`lsm`（oid 9900，`yb_lsm.c`）与 `ybgin`（oid 8021，GIN 的 DocDB 版）。但用户 `CREATE INDEX USING btree` 时 relam 仍记 btree，存储端由 `index_create` 的 YB 分支调 `YBCCreateIndex`（index.c:1036）在 DocDB 创建**独立索引表**；执行期 `index_insert()`（indexam.c:308）分派到 `yb_aminsert`——**传 `ybctid: Datum` 而非 ItemPointer**
- PG 的 heap 文件、buffer manager、WAL、MVCC clog 对 YB relation 全部旁路

### pggate 组件与 tserver 配套

| 组件 | 文件 | 角色 |
|---|---|---|
| `PgApiImpl` | pggate.cc | API 实现中枢，持有 PgClient/PgTxnManager/PgSession |
| `PgSession` | pg_session.cc | 单 backend 会话；写缓冲 `buffer_`、Perform 选项组装 |
| `PgClient` | pg_client.cc:175 | RPC 客户端；`PerformAsync` **优先共享内存 exchange**（:1115），fallback 走 RPC proxy |
| `PgTxnManager` | pg_txn_manager.cc | 事务状态机；隔离级别映射、read point 的 10 级优先级 |
| `PgDocOp` | pg_doc_op.cc | RPC 执行器；并行化 `PopulateParallelSelectOps/ByYbctidOps`，限流 `parallelism_level_` |
| `PgOperationBuffer` | pg_operation_buffer.cc | 写操作缓冲；`DoAdd`（:381）做同行冲突检测（同行写必须分批） |

tserver 侧：`PgClientSession`（pg_client_session.cc:4794 的 Perform → :3520 DoPerform → :1565 `PrepareOperations` 把每个 op 包成 `YBPgsqlReadOp/WriteOp` 后 `session->Apply` + `FlushAsync`；**行数据写 response sidecar** :668）。

## 核心实现

### Fork 的改造模式（三手法，222 个文件有 YB 标记）

1. **运行时分支**（最常见）：`if (IsYBRelation(...))` 分叉——heapam.c、indexam.c、`nodeModifyTable.c:1367`（ExecInsert 里 YB 走 `YBCHeapInsert`）
2. **核心结构体直接加字段**：`IndexAmRoutine` 加 `yb_aminsert/yb_amdelete/yb_amupdate/yb_ambackfill/yb_amgetbitmap` 族回调（amapi.h:127-161）；`EState` 加 `yb_exec_params/yb_es_is_single_row_modify_txn/yb_es_in_txn_limit_ht_for_reads`；`PlannerInfo/RelOptInfo` 加 `is_yb_relation`、batched-NL 的 `yb_cur_batched_relids`
3. **yb 专属新文件**：`access/yb_access/yb_scan.c`（**172KB 核心文件**：YbScanDesc、绑定下推谓词）、`executor/nodeYbSeqscan.c`/`nodeYbBitmapIndexscan.c`/`nodeYbBatchedNestloop.c`/`ybModifyTable.c`（DML 全家）、`optimizer/util/ybplan.c`、`catalog/yb_catalog/`（分布式 catalog 版本）

### 为什么不用 Custom Scan：新 node type 进内核

YB **没有用** Custom Scan/FDWRoutine 扩展点，而是把 plan node 直接加进内核：`T_YbSeqScan`/`T_YbBitmapIndexScan`/`T_YbBitmapTableScan`（nodes.h:62-63）+ `execProcnode.c:546` 分派。planner 侧 `create_seqscan_plan`（createplan.c:4412）对 YB relation 调 `make_yb_seqscan`，把 quals 分成 local/remote（`yb_extract_pushdown_clauses`）；`ybcCostEstimate`（yb_scan.c:4703）把 per-tuple cost 放大 10 倍模拟网络往返。

**为什么 fork 整个 PG**（证据链）：① `index_insert` 签名要改（ybctid vs ItemPointer）——AM extension 接口装不下；② planner 要感知分布式（batched NL、tablet 级并行）——字段直接长在 PlannerInfo/RelOptInfo 上；③ **PG 系统目录本身就是 DocDB 表**（`pg_class` 等以 `ybc_systable_beginscan` 扫描，bootstrap 模式都调 `YBCCreateDatabase`）——中间层方案 catalog 无法一致。代价：大版本升级沉重（11→15 用 `pg15_tests/` 整套上游回归矩阵重放背书；pg19 分支已在准备，git log 可见 merge 痕迹）。

### 事务：PG 驱动、DocDB 执行、无 SQL 层 2PC

- `xact.c` 事务边界挂钩子：`YBStartTransaction`/`YBCCommitTransaction`/`YBCAbortTransaction` → `FinishTransaction` RPC → tserver 的 `client::YBTransaction`（DocDB 事务系统，PG 侧完全不可见）
- **隔离级别映射**：`YBGetEffectivePggateIsolationLevel`（xact.c:2108）把 READ COMMITTED 映射成 REPEATABLE_READ（除非 `yb_enable_read_committed=on`）；SERIALIZABLE 映射到 DocDB serializable
- `PREPARE TRANSACTION` 不支持（reorderbuffer.c:2689 注释直言）；**savepoint → DocDB subtransaction**（请求带 `active_sub_transaction_id`，回滚靠 DocDB 冲突解析）
- **单行修改 fast path**：`yb_single_row_update_or_delete_path`（createplan.c:3487）在 WHERE 含全部 PK 时本地算出 ybctid，省掉"先读 ybctid 再写"的第二次 RPC，并可走单 tablet 事务

### MVCC 协调：read point 移交 + 语句级 in_txn_limit_ht

PG snapshot 对用户表失效；每个 tserver 会话有 `ConsistentReadPoint`（选择有 10 级优先级，pggate/README:130-175）。**语句读不见本语句写**：每语句取 `in_txn_limit` 随 `PgPerformOptionsPB` 下发，DocDB 侧抑制同事务更高 timestamp 的 provisional writes；写批在 Perform 前强制刷新并取新 limit。**read restart**：DocDB 混合时钟不确定性触发 `ERRCODE_YB_RESTART_READ`，查询层保留 read point 重试。

### 共享内存 fast path 与写缓冲

- **Perform 免走网络栈**：`pg_client.cc:1115` 优先 shared-memory exchange（写 req 到共享段 + `SendRequest`），大响应走专用 big segment + FetchData RPC；`TServerSharedData` 分发 catalog 版本/auth key——"backend 只连本地 tserver"的直接红利
- **写缓冲大胆延迟**：`PgSession::buffer_` 可跨语句缓冲（README 列出 8 类强制 flush 场景），理论依据"反正出错就回滚整个事务"；缓冲满 flush 不等待响应而记 in-flight ops

### 双向嵌套：YbGate——PG 代码也运行在 tserver 里

最新架构把**整个 PG backend 编成共享库 `libyb_pgbackend`**（根 CMakeLists.txt:853-877）链进 tserver：表达式下推经 `YBCNewEvalExprCall`（ybExpr.c:782）用 `ybSerializeNode` 序列化 PG Expr 树，tserver 侧 `DocPgExprExecutor` 经 YbGate API（ybgate_api.c）**用真 PG 求值器执行**——配 `yb_can_pushdown_func` 白名单（仅 builtin + immutable）。这解释了 bfpg 目录为何冻结（见[YQL 执行层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/09-yql-execution)）。

## 调用链路

一条 `SELECT * FROM t WHERE pk = 1` 的完整路径：

```
PG 进程内: exec_simple_query → pg_plan_query（产出含 YbSeqScan 的 plan）
→ ExecutorRun → ExecYbSeqScan → ybcFetchNextHeapTuple (yb_scan.c:512)
→ YbBeginScan (:3978): 展平 ScanKey + 绑定下推谓词 + YBCPgNewSelect
→ PgApiImpl::NewSelect → PgSelect → PgDocReadOp::SendRequestImpl (pg_doc_op.cc:355)
→ PgSession::Perform (pg_session.cc:915) → PgClient::PerformAsync (pg_client.cc:1166)
跨进程: 共享内存 exchange / PgClientService.Perform RPC
→ PgClientSession::DoPerform (pg_client_session.cc:3520)
→ PrepareOperations (:1565): YBPgsqlReadOp + FlushAsync
→ ReadRpc (client/async_rpc.cc:834) → tablet leader 的 TabletServerService.Read
→ docdb::PgsqlReadOperation → IntentAwareIterator 读 DocDB
返回: 行数据 response sidecar → PgDocOp::ProcessResponse → heap_form_tuple → psql
```

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 运行时分支 | IsYBRelation 全库分叉 | 保 PG 兼容测试矩阵可跑 |
| 桥接 | pggate C ABI（ybc_pggate.cc） | C++ 库进 C 进程 |
| 代理 | backend→tserver 中转一切 | 会话状态集中于 tserver（read point/事务/表缓存） |
| 双向共享 | PgMemctx + libyb_pgbackend 反向 | 内存管理统一 + 语义零漂移 |

## 模块间交互

- **与 tserver**：共享内存 + PgClientService（见[TServer 数据节点](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/03-tserver)）
- **与 master**：DDL 经 tserver 转 master（`PgCreateTable` → `client::TableCreator`）；catalog 版本经共享内存传播失效
- **与 YQL**：表达式下推见[YQL 执行层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/09-yql-execution)
- **fork 维护**：同仓库 in-tree fork 无 patch 文件；上游安全修复 commit 导入（`[DB-19141] Import CVE-2025-8715`）

## 扩展方式

**给 YSQL 支持新 PG 语法/执行特性**：① gram.y + analyze.c（上游已有则只需解锁 YB 白名单分支）；② planner：createplan.c + 新 node 需注册 T_ 枚举 + outfuncs/readfuncs/copyfuncs；③ executor 新 node 文件（模板 `nodeYbSeqscan.c`）或改 ybModifyTable 的 `YBC*` 调用序列；④ 协议层：pgsql_protocol.proto 加字段 → pggate 构造端与 docdb 执行端**成对修改**；⑤ 测试：regress/yb_*_schedule + pgwrapper 测试。

**新 DDL 特性**：pg_ddl.h 加语句类 → pg_client.proto 加 RPC → tserver/pg_create_table.cc + master table creator。
