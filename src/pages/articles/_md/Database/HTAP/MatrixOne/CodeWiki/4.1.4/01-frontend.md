---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "前端协议层"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "MySQL 协议", "会话管理"]
description: "MatrixOne frontend 模块解读：MySQL 协议栈、会话与事务骨架、语句分发策略，以及 proxy 的透明认证与连接迁移。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/frontend/`（约 7.5 万行非测试 Go）与 `pkg/proxy/`（约 7.5k 行）是 MatrixOne 与外部世界的全部边界：MySQL 线协议的收发与握手、会话状态与系统变量、认证鉴权、SQL 语句分发，以及 v4 新增的 CDC / clone / data branch 等前端自处理命令。它向上承诺"MySQL drop-in replacement"（协议与语义兼容），向下把一切可下推的语句交给 plan → compile 引擎链，自己只保留"必须在会话上下文里做的事"——这就是它独立的理由：协议兼容是一个独立演化的战争面（MySQL 8.0 的行为全集远比想象中大），不能与执行内核耦合。

## 模块架构

核心组件按职责分三层：

- **连接层**：`MOServer`（server.go）监听并握手；`Routine`（routine.go:45）是一个连接的载体，持原子替换的协议指针（TLS 升级后换实现）、`Session` 与双层 ctx；`RoutineManager` 管全部连接。
- **协议层**：`MysqlProtocolImpl`（mysql_protocol.go:207）自研协议栈（替代 goetty 的 `Conn`+`MemBlock` 在 mysql_buffer.go）。读写接口拆成 `MysqlReader` + `MysqlWriter` 组合的 `MysqlRrWr`（types.go:1649），proxy 复用同一实现。
- **会话层**：`Session = feSessionImpl`（types.go:928，持 `TxnHandler` / `TxnCompilerContext` / `MysqlResultSet` / 系统变量）+ 用户态字段（session.go:116，`prepareStmts/priv/tempTables`）。`TxnComputationWrapper`（computation_wrapper.go:57）是会话与执行引擎的桥。

```go title="pkg/frontend/routine.go"
type Routine struct {
    protocol atomic.Pointer[holder[MysqlRrWr]]  // 协议实现，TLS upgrade 后原子换指针
    ses *Session
    cancelRoutineCtx context.Context            // 连接级
    cancelRequestFunc context.CancelFunc        // 请求级（KILL QUERY 用）
    inProcessRequest bool
    cancelled atomic.Bool
}
```

## 调用链路

![frontend 调用链](/vibe-reading/images/articles/matrixone-internals/frontend-flow.svg)

一条 SQL 的主干是 `handleRequest` → `ExecRequest`（按 MySQL 命令字分发）→ `doComQuery`（parse + 逐语句循环）→ `executeStmtWithWorkspace`（事务骨架）→ `dispatchStmt` 按 `StmtKind().ExecLocation()` 二分：`EXEC_IN_FRONTEND` 走 `execInFrontend`（self_handle.go 的巨型 switch：SHOW/SET/CDC/data branch 等会话级命令），`EXEC_IN_ENGINE` 走 `TxnComputationWrapper.Compile`（buildPlan → 权限 → `compile.New`）→ `Run` → `getDataFromPipeline` 回调收 batch → `WriteResponse` 序列化回发。

数据形态从 MySQL packet 一路变为 AST → Plan → Batch → result set；全程贯穿一个 `ExecCtx` 请求上下文对象。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `RoutineManager.Handler`（routine_manager.go:362） | 解析命令字并派发 | `ToRequest(payload)` 统一入口 |
| `ExecRequest`（mysql_cmd_executor.go:3568） | COM_* 分发 | COM_STMT_* 改写为文本 SQL |
| `doComQuery`（mysql_cmd_executor.go:3289） | parse + 语句循环 | `GetComputationWrapper` 函数变量可测试替换 |
| `executeStmtWithWorkspace`（mysql_cmd_executor.go:2914） | 事务生命周期骨架 | 成功 commit / 异常 rollback 兜底 |
| `handleDataBranch`（data_branch.go:295） | data branch 命令分发 | 纯 Go 在 frontend 完成，不下推 |
| `MysqlProtocolImpl.Write` | 结果集序列化 | `WriteResultSetRow2` 逐行流式 |
</details>

## 核心实现

### 语句级事务骨架

`executeStmtWithWorkspace` 用模板方法固化了"Create txn → StartStatement → IncrStatementID → dispatch → finishTxnFunc"的骨架：`finishTxnFunc`（txn.go:105）统一处理 autocommit / BEGIN / COMMIT / ROLLBACK / 异常回滚，成功走 `commitTxnFunc`，失败兜底 `rollbackTxnFunc`。`TxnHandler.Create`（txn.go:274）在已激活事务上先提交旧事务再开新事务（`createUnsafe`），并用 serverStatus 位图同步 MySQL 协议状态字——事务正确性不散落在各语句处理里，而是集中在这一个骨架。

回滚本身分两层：多语句事务（autocommit=0）内语句出错时，若不是"回滚整个事务"级别的错误（`isErrorRollbackWholeTxn` 决定 `byRollback`），且当前不是派生语句（`IsDerivedStmt`），`TxnHandler.Rollback`（txn.go:636-638）走 **statement 级回滚**——`txnOp.GetWorkspace().RollbackLastStatement(th.txnCtx)` 只撤销本条语句的写入，事务可继续；否则退化为 `rollbackUnsafe` 整事务回滚。提交失败时 `commitUnsafe` 用 `isTxnCommitResultUnknown`（txn.go:79）区分"提交结果未知"（网络错误等，不能断言失败）与普通失败；事务失效走 `invalidateTxnUnsafe`（txn.go:249），位图上**只清 `SERVER_STATUS_IN_TRANS`、保留 `SERVER_STATUS_AUTOCOMMIT`**（只清 `OPTION_BEGIN`、保留会话级 autocommit 设置）——因为 autocommit 偏好是跨事务的会话属性，不能被一次事务失败抹掉。

### 双层 ctx 与 KILL 语义

连接级 `routineCtx` > 事务级 `txnCtx`（不能被 KILL QUERY 取消）> 请求级 `requestCtx`（每条 SQL 超时）。`Routine.killQuery` 只 cancel `requestCtx`，`killConnection`（routine.go:398）才断网：杀别的连接时它不直接关 socket，而是经 `execCallbackBasedOnRequest(false, closeConn)`（routine.go:136）把关闭动作挂到目标连接的请求回调里，让其对端在安全点执行；自身资源释放集中在 `cleanup()`（routine.go:434），用 `closeOnce` 保证只执行一次，顺序是先 `mc.waitAndClose()`（等迁移控制器结束会话迁移）再释放其余资源——连接销毁与会话迁移互不踩踏。frontend 在 `handleRequest` 末尾检测 `routineCtx.Done` 主动回滚并关闭（routine.go:360 附近）。这组分层让"杀查询不杀事务、杀连接必回滚"成为协议层显式语义。

### proxy 透明认证（salt 中继）

proxy 用 `frontend.MysqlProtocolImpl` 自己与客户端握手（client_conn.go:238），把 CN 返回的 handshake 中的 salt 替换为 proxy 自己的 salt（server_conn.go:346-360 注释 "proxy send its salt"），再把客户端的握手响应原样转发给 CN——CN 完全不感知 proxy 的存在，密码验证照常工作。

配套的 `connCache`（conn_cache.go:183）按 `LabelHash` 缓存后端已认证连接：**Push 前**先经 `resetSession`（conn_cache.go:289，向 CN 发 `CmdMethod_ResetSession` RPC 清空 frontend 会话，超时 3 秒）再入缓存；**Pop 复用时**依次检查 CN 健康度（`canReuseCN` 为 false 时弹出并 `sc.Quit()` 弃用）、过期时间、认证——认证失败只 `return nil` 不弹出（连接留在缓存中待后续处理），成功则执行 `setConnectionIDSQL`（`/* cloud_nonuser */ SET CONNECTION ID TO %d`，conn_cache.go:41）重绑连接号。配合 `Routine.migrateConnectionTo`（routine.go:490）实现 CN 重平衡时的会话迁移。

路由与健康保护在 `router.Route`（router.go:278）：`health.pick` 做 CN 健康熔断，**全部候选繁忙/不健康时快速失败**（`allCNServersBusyErr`，router.go:40——宁可报错也不把连接挂死）；只剩单个候选时直接返回（半开探测经 selectOne 会丢失探测槽位）；`RouteForTransfer`（router.go:323）为会话迁移选路时**绕过熔断/探测门**——迁移流量不应消耗恢复探测的配额；缓存连接复用经 `CanReuseCachedCN`（router.go:347）与健康状态对齐。

### prepared statement 的文本化

`COM_STMT_PREPARE` 被直接改写为 `prepare %s from %s` 文本，二进制执行参数由 `ParseExecuteData` 填入后统一走文本查询主链路——用一条主链路换取协议双轨代码的消失，代价是参数绑定在校验上稍弱。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 | `cdc_state_machine.go:129` `ExecutorStateMachine.initTransitions` | CDC executor 9 态生命周期（Idle→Running→Paused…）显式转移表 |
| 策略模式 | `StmtKind().ExecLocation()/OutputType()` | 语句自描述执行位置与输出形态，分发逻辑零 if-else 蔓延 |
| 模板方法 | `executeStmtWithWorkspace` + `dispatchStmt` 的 `*Session/*backSession` 分支 | 骨架固化，差异下沉 |
| 接口组合 | `MysqlReader + MysqlWriter → MysqlRrWr`（types.go:1649） | proxy 与 server 复用同一协议实现 |

## 模块间交互

frontend 是全库最高扇入的"消费者"：import `sql/parsers`（130 处）、`vm/engine`（58 处）、`sql/plan`（45 处）、`txn/client`（18 处）。三个关键交互点：`buildPlan`（mysql_cmd_executor.go:2199）把 `TxnCompilerContext` 传给 plan 层；`computation_wrapper.go:587` 用 `ses.GetTxnHandler().GetStorage()` 构造 `compile.NewCompile`；事务经 `TxnHandler` → `txnClient.New`。被 import 方：`pkg/proxy` 直接复用 10 个 frontend 符号（`NewMysqlClientProtocol` 等），`pkg/bootstrap` 用内部 SQL 做升级。

## 扩展方式

- **新增 MySQL 命令**：`mysql_protocol_predefines.go` 加 CommandType → `ExecRequest` 加 case → 需特殊解析则在 `GetComputationWrapper` 仿 `isCmdGetDdlSql` 加分支 → `self_handle.go` 加 `case *tree.Xxx`。
- **新增系统变量**：`variables.go` 的 `gSysVarsDefs` 加一项 `SystemVariable{Name/Scope/Dynamic/Type/Default}` 即自动获得 SET/SHOW 支持。
- **新增前端命令**（如新的 data branch 操作）：parser 产 AST → `execInFrontend` 加 case + 仿 `authenticateDataBranchStatement` 做权限 → 新 handler 文件；长生命周期任务配 `ExecutorStateMachine` 状态转移。
