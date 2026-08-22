---
title: "修复事务导入连接 Follower FE 时事务上下文丢失"
source:
  project: "Doris"
  type: "PR"
  id: "35075"
  url: "https://github.com/apache/doris/pull/35075"
  prType: "fix"
date: "2026-08-05T15:00:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "Transaction", "FE", "Java", "Thrift"]
description: "通过在 MasterOp 请求中携带 TTxnLoadInfo，让 follower FE 转发 DML 到 master 时同步传递事务上下文，修复事务导入连接 follower FE 时数据提前可见的 bug。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#35075](https://github.com/apache/doris/pull/35075) · **Issue** - · **commit** [b699cf3b](https://github.com/apache/doris/commit/b699cf3ba0aaa934f752945517e6199a92e68cf6) · **首发版本** 3.0.0 · **变更行数** +233 行 · **合并时间** 2024-05-22

> 📎 本文是 [引入子事务支持事务内多次写入同一张表](/vibe-reading/articles/doris-pr-32980-txn-insert-sub-transaction) 的后续修复，建议先阅读原文了解事务导入与子事务机制。

---

## 背景

PR [#32980](https://github.com/apache/doris/pull/32980) 引入子事务机制，让用户可以在一个事务内多次写入同一张表：

```sql
begin;
insert into t1 select ...;
insert into t1 select ...;
commit;
```

但该实现有一个未覆盖的场景：**用户连接到 follower FE（非 Master 节点）时**。

Doris 的 FE 分为 Master 和 Follower/Observer 两类角色。事务导入中，DML 语句（`insert into select`、`update`、`delete`）需要转发到 Master FE 执行（因为事务状态由 Master 管理）。`MasterOpExecutor` 负责这个转发：

```
follower FE                        master FE
   |                                   |
   |  insert into t1 select ...        |
   |  ──── forward DML stmt ────►      |
   |                                   |  execute as normal stmt
   |                                   |  → commit & visible immediately!
   |  ◄──── result ─────────────       |
```

问题在于：**`#32980` 的 `TransactionEntry`（事务上下文）没有被一起转发**。Master FE 收到 DML 语句后，不知道它属于一个进行中的事务，于是当作普通语句执行——直接 commit 并立即可见。这彻底破坏了事务语义：数据在 `COMMIT` 之前就暴露给用户了。

PR body 一句话点明了问题：

> In txn load, the dml stmts are forward to master. But the txn context is not forward, so the dml stmt is handled as a normal stmt and visible if executed successfully.

---

## 实现

### 核心思路：在转发请求中携带事务上下文

解法是扩展 FE 间的 Thrift 通信协议，让 `TMasterOpRequest` 和 `TMasterOpResult` 携带 `TTxnLoadInfo`——一个序列化的事务上下文快照。每次转发 DML 时，follower FE 把当前事务状态打包发出；Master FE 收到后重建 `TransactionEntry`，在事务上下文下执行；执行完毕再把更新后的事务状态返回给 follower FE。

```
follower FE                           master FE
   |                                      |
   |  insert into t1 select ...           |
   |  + TTxnLoadInfo(label, txnId, ...)   |
   |  ──── forward ───────────────►       |
   |                                      |  restore TransactionEntry
   |                                      |  execute within txn context
   |                                      |  → no premature commit
   |  ◄──── result + TTxnLoadInfo ───     |
   |  update local TransactionEntry       |
```

### Thrift 协议扩展

新增 `TTxnLoadInfo` 结构体，包含事务的四个关键字段：

```thrift title="gensrc/thrift/FrontendService.thrift"
struct TTxnLoadInfo {
    1: optional string label
    2: optional i64 dbId
    3: optional i64 txnId
    4: optional i64 timeoutTimestamp
}
```

并将其加入请求和响应：

```thrift title="gensrc/thrift/FrontendService.thrift — TMasterOpRequest/TMasterOpResult"
struct TMasterOpRequest {
    // ... existing fields ...
    29: optional TTxnLoadInfo txnLoadInfo   // 新增：follower → master 携带的事务上下文
}

struct TMasterOpResult {
    // ... existing fields ...
    9: optional TTxnLoadInfo txnLoadInfo    // 新增：master → follower 返回的更新后上下文
}
```

### Master 侧：ConnectProcessor.proxyExecute

`proxyExecute` 是 Master FE 处理转发请求的入口。改动分两处——**执行前恢复事务上下文，执行后返回更新后的上下文**：

```java title="fe/fe-core/src/main/java/org/apache/doris/qe/ConnectProcessor.java — proxyExecute"
// 执行前：从请求中恢复事务上下文
if (request.isSetTxnLoadInfo()) {
    TransactionEntry transactionEntry = new TransactionEntry();
    transactionEntry.setTxnInfoInMaster(request.getTxnLoadInfo());
    ctx.setTxnEntry(transactionEntry);
}

// ... 执行 DML 语句 ...

// 执行后：返回更新后的事务上下文（commit/rollback 时 txnEntry 为 null）
if (request.isSetTxnLoadInfo()) {
    TransactionEntry transactionEntry = ConnectContext.get().getTxnEntry();
    if (transactionEntry != null) {
        result.setTxnLoadInfo(transactionEntry.getTxnInfoInMaster());
    }
}
```

`setTxnInfoInMaster` 从 `TTxnLoadInfo` 重建 `TransactionEntry`：首次 DML 只带 `label`（事务尚未开始），后续 DML 带 `txnId` + `dbId` + `timeoutTimestamp`（事务已开始），据此恢复 `isTransactionBegan` 状态和 `transactionState`。

### Follower 侧：MasterOpExecutor

Follower 侧的 `MasterOpExecutor` 在转发前后处理事务上下文的收发：

```java title="fe/fe-core/src/main/java/org/apache/doris/qe/MasterOpExecutor.java"
// 构建请求时：附上当前事务上下文
private TMasterOpRequest buildStmtForwardParams() throws AnalysisException {
    TMasterOpRequest params = new TMasterOpRequest();
    // ... existing params ...
    if (ctx.isTxnModel()) {
        params.setTxnLoadInfo(ctx.getTxnEntry().getTxnLoadInfoInObserver());
    }
    return params;
}

// 收到响应后：更新本地事务上下文
public void execute() throws Exception {
    result = forward(buildStmtForwardParams());
    if (result.getStatusCode() == 0 && ctx.isTxnModel()) {
        if (result.isSetTxnLoadInfo()) {
            ctx.getTxnEntry().setTxnLoadInfoInObserver(result.getTxnLoadInfo());
        } else {
            ctx.setTxnEntry(null);   // commit/rollback 后事务结束，清空上下文
            LOG.info("set txn entry to null");
        }
    }
    waitOnReplaying();
}
```

> **后续演进**：在当前代码库中，这段逻辑已从 `MasterOpExecutor` 上移到父类 `FEOpExecutor`，核心逻辑不变——`execute()` 中转发后更新 `txnLoadInfo`，`buildStmtForwardParams()` 中附加 `txnLoadInfo`。

### TransactionEntry：Master/Follower 分支

`TransactionEntry` 是本 PR 变更量最大的文件（+158/-52）。`beginTransaction`、`commitTransaction`、`abortTransaction` 三个方法都增加了 `isMaster()` 分支——Master 直接操作，Follower 转发到 Master：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java — beginTransaction"
public long beginTransaction(TableIf table) throws Exception {
    if (!isTransactionBegan) {
        if (Env.getCurrentEnv().isMaster()) {
            // Master：直接开启事务
            this.transactionId = Env.getCurrentGlobalTransactionMgr().beginTransaction(...);
        } else {
            // Follower：通过 MasterTxnExecutor 转发 beginTxn 请求
            MasterTxnExecutor masterTxnExecutor = new MasterTxnExecutor(ConnectContext.get());
            TLoadTxnBeginRequest request = new TLoadTxnBeginRequest();
            request.setDb(database.getFullName()).setTbl(table.getName())
                    .setLabel(label).setTimeout(timeoutSecond);
            TLoadTxnBeginResult result = masterTxnExecutor.beginTxn(request);
            this.transactionId = result.getTxnId();
        }
        // ...
    }
}
```

`commitTransaction` 和 `abortTransaction` 同理——Follower 通过 `MasterOpExecutor` 转发 `"commit"` / `"rollback"` 语句：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java — commitTransaction"
public TransactionStatus commitTransaction() throws Exception {
    if (isTransactionBegan) {
        if (Env.getCurrentEnv().isMaster()) {
            // Master：直接 commit + publish
            beforeFinishTransaction();
            Env.getCurrentGlobalTransactionMgr().commitAndPublishTransaction(...);
        } else {
            // Follower：转发 commit 语句到 Master
            OriginStatement originStmt = new OriginStatement("commit", 0);
            MasterOpExecutor masterOpExecutor = new MasterOpExecutor(originStmt, ConnectContext.get(),
                    RedirectStatus.NO_FORWARD, false);
            masterOpExecutor.execute();
            return waitingTxnVisible(this.dbId, this.transactionId);
        }
    }
}
```

### 上下文序列化：四个新方法

`TransactionEntry` 新增四个方法，负责 `TTxnLoadInfo` 与内部状态的相互转换：

| 方法 | 角色 | 职责 |
| --- | --- | --- |
| `getTxnLoadInfoInObserver()` | follower → 请求 | 将本地事务状态序列化为 `TTxnLoadInfo` 发出 |
| `setTxnLoadInfoInObserver()` | 响应 → follower | 用 Master 返回的 `TTxnLoadInfo` 更新本地状态 |
| `setTxnInfoInMaster()` | 请求 → master | 从 `TTxnLoadInfo` 重建 `TransactionEntry` |
| `getTxnInfoInMaster()` | master → 响应 | 将执行后的事务状态序列化返回 |

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java — setTxnInfoInMaster"
public void setTxnInfoInMaster(TTxnLoadInfo txnLoadInfo) throws DdlException {
    this.setTxnConf(new TTxnParams().setNeedTxn(true).setTxnId(-1));
    this.label = txnLoadInfo.getLabel();
    if (txnLoadInfo.isSetTxnId()) {
        // 后续 DML：事务已开始，恢复 txnId / dbId / transactionState
        this.dbId = txnLoadInfo.getDbId();
        this.database = Env.getCurrentInternalCatalog().getDbOrDdlException(dbId);
        this.transactionId = txnLoadInfo.getTxnId();
        this.transactionState = Env.getCurrentGlobalTransactionMgr()
                .getTransactionState(dbId, transactionId);
        Preconditions.checkNotNull(this.transactionState, "db_id=" + dbId + " txn_id=" + transactionId + " not found");
        this.isTransactionBegan = true;
        this.timeoutTimestamp = txnLoadInfo.getTimeoutTimestamp();
    }
    // 首次 DML：只设 label，事务尚未开始
}
```

### subTransactionStates 迁移到 TransactionState

PR 顺带将 `subTransactionStates` 列表从 `TransactionEntry` 迁移到 `TransactionState`。此前 `TransactionEntry` 持有独立的 `subTransactionStates`，与 `TransactionState` 中的副本存在同步负担。迁移后统一由 `TransactionState` 管理：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionState.java"
public void resetSubTransactionStates() {
    this.subTransactionStates = new ArrayList<>();
}

public void resetSubTxnIds() {
    this.subTxnIds = subTransactionStates.stream()
            .map(SubTransactionState::getSubTransactionId)
            .collect(Collectors.toList());
}
```

`TransactionEntry` 中的操作改为通过 `transactionState.getSubTransactionStates()` 访问，`beforeFinishTransaction` 中的排序和 `setSubTransactionStates` 调用也相应调整。

### getWaitingTxnStatus 超时改进

`GlobalTransactionMgr.getWaitingTxnStatus` 有两处改进：

1. **`txnStatus` 提到循环外**：此前声明在循环内，循环结束后无法访问。提到外面后，超时时能判断最终状态。
2. **COMMITTED 不再抛超时异常**：如果超时但事务已 COMMITTED（只是还没 VISIBLE），返回 COMMITTED 状态而非抛 `TimeoutException`，让调用方提示"数据稍后可见"而非"操作超时失败"。

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/GlobalTransactionMgr.java"
TransactionStatus txnStatus = null;   // 提到循环外
for (int i = 0; i < commitTimeoutSec; ++i) {
    // ... 轮询事务状态 ...
}
// 超时后：COMMITTED 返回而非抛异常
if (txnStatus == TransactionStatus.COMMITTED) {
    TWaitingTxnStatusResult statusResult = new TWaitingTxnStatusResult();
    statusResult.status = new TStatus();
    statusResult.setTxnStatusId(txnStatus.value());
    return statusResult;
}
throw new TimeoutException("Operation is timeout, txn status is " + txnStatus);
```

---

## 测试

### 回归测试

| 测试文件 | 覆盖场景 |
| --- | --- |
| `regression-test/suites/insert_p0/txn_insert.groovy` | 事务内用错误 label 的 insert 应报错（+4 行） |
| `regression-test/suites/insert_p0/txn_insert_inject_case.groovy` | 注入故障点——Master commit 成功但 publish 停止时，observer FE 应收到"data will be visible later"提示（+8 行） |

### 单元测试

`GlobalTransactionMgrTest` 适配 `subTransactionStates` 迁移：`generateSubTransactionStates` 改为调用 `transactionState.resetSubTransactionStates()` 和 `resetSubTxnIds()`，不再自行创建独立列表。

---

## 问题

### commit/rollback 时的事务上下文处理

`commit` 和 `rollback` 语句转发到 Master 后，Master 会结束事务并清空 `TransactionEntry`（`ctx.setTxnEntry(null)`）。因此响应中不携带 `txnLoadInfo`，follower 侧的 `MasterOpExecutor.execute()` 检测到 `result.isSetTxnLoadInfo() == false` 时，将本地 `txnEntry` 置为 null，正确终结事务生命周期。

### 首次 DML 与后续 DML 的区分

首次 DML 转发时事务尚未开始，`TTxnLoadInfo` 只携带 `label`（`txnId` 未设置）。Master 收到后调用 `beginTransaction` 开启事务，在响应中返回 `txnId` + `dbId` + `timeoutTimestamp`。后续 DML 转发时携带完整信息，Master 据此恢复已开始的事务状态。这一设计在 `setTxnInfoInMaster` 的 `if (txnLoadInfo.isSetTxnId())` 分支中体现。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| 连接 Master FE 的事务导入 | ✓ 正常 | ✓ 正常 |
| 连接 Follower FE 的事务导入 | ✗ 数据提前可见 | ✓ 正常 |
| commit 超时但已 COMMITTED | 抛超时异常 | 返回"data will be visible later" |

* **修复正确性 bug**：follower FE 场景下 DML 不再绕过事务直接可见，恢复了事务的原子性保证。这是 `#32980` 落地后最关键的配套修复——没有它，事务导入在实际部署中几乎不可用（用户通常连接 follower/observer FE 而非 Master）。
* **协议扩展**：`TTxnLoadInfo` 为 FE 间事务上下文传递建立了标准通道，后续事务相关功能（如 cloud 模式的事务导入）可复用这一机制。
* **状态管理收敛**：`subTransactionStates` 统一到 `TransactionState`，消除了 `TransactionEntry` 与 `TransactionState` 之间的状态同步隐患。
