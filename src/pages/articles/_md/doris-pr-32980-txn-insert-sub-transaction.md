---
title: "引入子事务支持事务内多次写入同一张表"
source:
  project: "Doris"
  type: "PR"
  id: "32980"
  url: "https://github.com/apache/doris/pull/32980"
  prType: "enhancement"
date: "2026-08-05T14:30:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Transaction", "FE", "Java", "SubTransaction"]
description: "通过引入 sub_txn_id 分离 FE 与 BE 的事务标识，让用户可以在一个事务中多次 insert 同一张表，并支持 READ COMMITTED 隔离级别。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#32980](https://github.com/apache/doris/pull/32980) · **Issue** - · **commit** [42c4fadd](https://github.com/apache/doris/commit/42c4fadddb3a7fa812c0552f0ee62e43c323616b) · **首发版本** 3.0.0 · **变更行数** +4505 行 · **合并时间** 2024-05-07

---

## 背景

Doris 在此 PR 之前已支持事务型导入（transaction load），允许用户通过 `BEGIN` / `COMMIT` 显式控制事务：

```sql
begin;
insert into t1 select ...;
commit;
```

相关的前序 PR 包括 [#31666](https://github.com/apache/doris/pull/31666)（事务内 `insert into select`）、[#33034](https://github.com/apache/doris/pull/33034)（事务内 `update`）和 [#33100](https://github.com/apache/doris/pull/33100)（事务内 `delete`）。

但一个遗留问题始终存在：**一个事务内，同一个分区只能被写入一次**。也就是说下面这段看似合理的 SQL 无法执行：

```sql
begin;
insert into t1 select ...;   -- 第一次写入 t1
insert into t1 select ...;   -- 第二次写入 t1 → 失败
commit;
```

造成这一限制的根因在于 Doris 的事务机制：

* **BE 侧**：BE 用 `txn_id` 在 `txn_manager` 中记录分区、tablet、`DeltaWriter` 等导入上下文。如果用同一个 `txn_id` 对同一分区写入两次，后一次会**覆盖**前一次的上下文信息。
* **FE 侧**：FE 在 commit 事务时为每个分区计算一个新版本号（version），一个 version 对应一个 Rowset。但同一事务内多次导入会产生多个 Rowset，与"一个 txn → 一个 version"的模型冲突。

本 PR 通过引入 **子事务（sub-transaction）** 机制解决这一问题。

---

## 前置知识

### Doris 事务与版本机制

Doris 的写入流程涉及 FE 和 BE 的协作：

| 概念 | 说明 |
| --- | --- |
| `txn_id` | 事务唯一标识，由 FE 分配 |
| `partition version` | 分区版本号，每次成功导入后递增，是数据可见性的基础 |
| `Rowset` | 一次导入在 tablet 上生成的数据版本单元，与 version 一一对应 |
| `PublishVersionTask` | FE 发给 BE 的版本发布任务，让 BE 将 committed 数据变为 visible |

核心约束是：**分区的 version 必须连续递增**。一个事务为一个分区产生一个新 version，对应一个 Rowset。`PublishVersionDaemon` 负责将版本发布任务下发到 BE，BE 完成后数据才对用户可见。

### 旧版事务序列化

`TransactionState` 是 FE 侧记录事务状态的核心类，持久化到 BDBJE（FE 的元数据存储）。旧版通过 `Writable` 接口的手写二进制序列化（`write(DataOutput)` / `readFields(DataInput)`）逐字段读写。这种方式的缺点是：新增字段需要手动维护序列化顺序，且对复杂嵌套对象（如 Map、多态类型）支持不佳。

---

## 实现

### 核心思路：sub_txn_id

解决问题的关键是**分离 FE 和 BE 对事务的标识**：

* FE 侧仍然维护一个 `txn_id`，代表整个事务
* 事务内的每次导入操作分配一个 `sub_txn_id`，传递给 BE 作为写入标识
* commit 时，FE 为每个 sub-txn 分别计算分区版本号，再逐个发布

以 PR 作者给出的示例——表 `t` 有两个分区 `p1`（当前 version 3）和 `p2`（当前 version 4）：

| 命令 | FE | BE |
| --- | --- | --- |
| `BEGIN` | 标记事务开始 | |
| `insert into t partition(p1, p2)` | begin_txn → `txn_id`；`sub_txn_id1 = txn_id`（首次导入，sub_txn_id 等于 txn_id） | 用 `sub_txn_id1` 导入 |
| `insert into t partition(p1)` | 生成 `sub_txn_id2` | 用 `sub_txn_id2` 导入 |
| `insert into t partition(p1, p2)` | 生成 `sub_txn_id3` | 用 `sub_txn_id3` 导入 |
| `COMMIT` | commit_txn，计算分区版本：sub_txn_id1 → p1(4), p2(5)；sub_txn_id2 → p1(5)；sub_txn_id3 → p1(6), p2(6)。然后用各 sub_txn_id 分别向 BE 发送 publish 任务 | |

### 新增类：SubTransactionState

新文件 `SubTransactionState.java` 封装单次子事务的提交信息：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/SubTransactionState.java"
public class SubTransactionState {
    private long subTransactionId;
    private Table table;
    private List<TTabletCommitInfo> tabletCommitInfos;
    private SubTransactionType subTransactionType;

    public enum SubTransactionType {
        INSERT,
        DELETE
    }
}
```

`SubTransactionType` 区分 INSERT 和 DELETE 两种子事务，后续在版本计算和发布时会分别处理。

### TransactionEntry：子事务生命周期管理

`TransactionEntry` 是 FE 侧事务导入的入口协调器。`beginTransaction` 方法的核心逻辑——**首次调用开启真正的事务，后续调用生成 sub_txn_id**：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java"
public long beginTransaction(TableIf table, SubTransactionType subTransactionType) throws Exception {
    if (!isTransactionBegan) {
        // 首次导入：开启真正的 FE 事务，sub_txn_id = txn_id
        this.transactionId = Env.getCurrentGlobalTransactionMgr().beginTransaction(...);
        this.isTransactionBegan = true;
        this.transactionState = Env.getCurrentGlobalTransactionMgr()
                .getTransactionState(database.getId(), transactionId);
        return this.transactionId;
    } else {
        // 后续导入：生成新的 sub_txn_id
        long subTxnId = Env.getCurrentGlobalTransactionMgr().getNextTransactionId();
        this.transactionState.addTableId(table.getId());
        Env.getCurrentGlobalTransactionMgr().addSubTransaction(database.getId(), transactionId, subTxnId);
        return subTxnId;
    }
}
```

`DatabaseTransactionMgr` 内部维护 `subTxnIdToTxnId` 映射（`Map<Long, Long>`），`addSubTransaction` 将 `subTxnId → txnId` 存入此映射。这样当 BE 用 `sub_txn_id` 上报状态时，FE 的 `unprotectedGetTransactionState` 能通过该映射找到对应的 `TransactionState`。事务清理时 `cleanSubTransactions` 遍历移除该事务的所有子事务映射。

`subTransactionStates` 列表按顺序记录所有子事务状态，commit 时整体提交：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java — commit"
public TransactionStatus commitTransaction() throws Exception {
    if (isTransactionBegan) {
        // 将 sub_txn_id 列表设置到 transactionState
        beforeFinishTransaction();
        Env.getCurrentGlobalTransactionMgr().commitAndPublishTransaction(
                database, transactionId, subTransactionStates, commitTimeout);
    }
    // ...
}
```

`beforeFinishTransaction` 将 `subTransactionStates` 中的 sub_txn_id 列表提取到 `transactionState` 中，供后续 commit 和 publish 使用。

### DatabaseTransactionMgr：多子事务的版本计算

这是本 PR 变更量最大的文件（+587/-159）。新增了 `commitTransaction` 重载，接收 `List<SubTransactionState>`：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/DatabaseTransactionMgr.java"
public void commitTransaction(long transactionId, List<Table> tableList,
        List<SubTransactionState> subTransactionStates) throws UserException {
    // ...
    for (SubTransactionState subTransactionState : subTransactionStates) {
        checkCommitStatus(Lists.newArrayList(table), transactionState, ...);
        subTxnToPartition.put(subTransactionState.getSubTransactionId(), ...);
    }
    // 状态转换 + 持久化
    unprotectedCommitTransaction(transactionState, errorReplicaIds, subTxnToPartition,
            totalInvolvedBackends, subTransactionStates, db);
}
```

版本计算的核心在 `unprotectedCommitTransaction` 的新重载中。对每张表，按子事务顺序计算递增的分区版本号：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/DatabaseTransactionMgr.java — 版本计算"
protected void unprotectedCommitTransaction(TransactionState transactionState, ...,
        List<SubTransactionState> subTransactionStates, Database db) {
    // 按 tableId 分组子事务
    Map<Long, List<SubTransactionState>> tableToSubTransactionState = new HashMap<>();
    for (SubTransactionState sub : subTransactionStates) {
        tableToSubTransactionState.computeIfAbsent(sub.getTable().getId(), k -> new ArrayList<>()).add(sub);
    }

    for (Entry<Long, List<SubTransactionState>> entry : tableToSubTransactionState.entrySet()) {
        long tableId = entry.getKey();
        OlapTable table = (OlapTable) db.getTableNullable(tableId);
        long tableNextVersion = table.getNextVersion();
        Map<Long, Long> partitionToVersion = new HashMap<>();

        for (SubTransactionState sub : entry.getValue()) {
            TableCommitInfo tableCommitInfo = new TableCommitInfo(tableId);
            tableCommitInfo.setVersion(tableNextVersion);

            for (long partitionId : subTxnToPartition.get(sub.getSubTransactionId())) {
                long partitionNextVersion = table.getPartition(partitionId).getNextVersion();
                if (partitionToVersion.containsKey(partitionId)) {
                    // 同一事务内此分区已被前一个子事务写入，版本递增
                    partitionNextVersion = partitionToVersion.get(partitionId) + 1;
                }
                partitionToVersion.put(partitionId, partitionNextVersion);
                tableCommitInfo.addPartitionCommitInfo(
                        generatePartitionCommitInfo(table, partitionId, partitionNextVersion));
            }
            transactionState.addSubTxnTableCommitInfo(sub, tableCommitInfo);
        }
    }
    transactionState.setInvolvedBackends(totalInvolvedBackends);
}
```

`partitionToVersion` 这个 Map 是关键：它跟踪同一事务内同一分区的版本递增。第一次写入用 `partition.getNextVersion()`（表当前可见版本 +1），后续写入在前一个子事务的 version 上 +1。这样每个子事务都获得独立的、连续的分区版本号。

子事务的 commit 信息存储在 `TransactionState` 的新字段 `subTxnIdToTableCommitInfo` 中（`TreeMap`，按 sub_txn_id 排序），与旧版的 `idToTableCommitInfos`（tableId → TableCommitInfo）并行存在。

### PublishVersionDaemon：逐子事务发布

`PublishVersionDaemon` 负责将版本发布任务下发到 BE。旧版一个事务对应一组 `PublishVersionTask`；新版需要**按子事务逐个发布**。

`publishVersionTasks` 的类型从 `Map<Long, PublishVersionTask>` 变为 `Map<Long, List<PublishVersionTask>>`，即每个 BE 可能收到多个任务（每个子事务一个）：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/PublishVersionDaemon.java"
if (transactionState.getSubTransactionStates() != null) {
    // 有子事务：逐个 sub_txn 生成发布任务
    for (Entry<Long, TableCommitInfo> entry : transactionState.getSubTxnIdToTableCommitInfo().entrySet()) {
        long subTxnId = entry.getKey();
        List<TPartitionVersionInfo> partitionVersionInfos = generatePartitionVersionInfos(...);
        addPublishVersionTask(publishBackends, subTxnId, transactionState, ...);
    }
} else {
    // 无子事务：走原有路径
    addPublishVersionTask(publishBackends, transactionState.getTransactionId(), ...);
}
```

每个子事务的 `PublishVersionTask` 携带自己的 `TPartitionVersionInfo`（分区 ID + 版本号），BE 据此将对应 Rowset 设为 visible。由于版本号是连续递增的，BE 侧的版本连续性约束得以满足。

### TransactionState：JSON 序列化

引入子事务后，`TransactionState` 新增了 `subTxnIds`、`subTxnIdToTableCommitInfo`（`TreeMap<Long, TableCommitInfo>`）等复杂字段。手写二进制序列化维护成本过高，因此 PR 将 `write` 方法改为 JSON 序列化：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionState.java"
@Override
public void write(DataOutput out) throws IOException {
    Text.writeString(out, GsonUtils.GSON.toJson(this));
}

public static TransactionState read(DataInput in) throws IOException {
    if (Env.getCurrentEnvJournalVersion() < FeMetaVersion.VERSION_132) {
        // 旧元数据版本：走二进制 readFields
        TransactionState transactionState = new TransactionState();
        transactionState.readFields(in);
        return transactionState;
    } else {
        // 新元数据版本：走 JSON 反序列化
        String json = Text.readString(in);
        return GsonUtils.GSON.fromJson(json, TransactionState.class);
    }
}
```

配合 `FeMetaVersion.VERSION_132`（从 131 升至 132）做版本兼容：升级后首次重启，FE 仍能用旧 `readFields` 方法读取历史事务，新事务则用 JSON 格式写入。

### GsonUtils：多态类型注册

切换到 JSON 序列化后，`TransactionState` 内嵌的多态对象（`TxnCommitAttachment`、`RoutineLoadProgress`）需要 Gson 能正确识别子类。PR 在 `GsonUtils` 中注册了两个 `RuntimeTypeAdapterFactory`：

```java title="fe/fe-core/src/main/java/org/apache/doris/persist/gson/GsonUtils.java"
// TxnCommitAttachment 的多态适配器
private static RuntimeTypeAdapterFactory<TxnCommitAttachment> txnCommitAttachmentTypeAdapterFactory
        = RuntimeTypeAdapterFactory.of(TxnCommitAttachment.class, "clazz")
        .registerDefaultSubtype(TxnCommitAttachment.class)
        .registerSubtype(LoadJobFinalOperation.class, LoadJobFinalOperation.class.getSimpleName())
        .registerSubtype(MiniLoadTxnCommitAttachment.class, MiniLoadTxnCommitAttachment.class.getSimpleName())
        .registerSubtype(RLTaskTxnCommitAttachment.class, RLTaskTxnCommitAttachment.class.getSimpleName());

// RoutineLoadProgress 的多态适配器
private static RuntimeTypeAdapterFactory<RoutineLoadProgress> routineLoadTypeAdapterFactory
        = RuntimeTypeAdapterFactory.of(RoutineLoadProgress.class, "clazz")
        .registerDefaultSubtype(RoutineLoadProgress.class)
        .registerSubtype(KafkaProgress.class, KafkaProgress.class.getSimpleName());
```

`RuntimeTypeAdapterFactory` 是 Gson 的扩展工具，序列化时在 JSON 中写入 `clazz` 字段标记实际类型，反序列化时据此实例化正确的子类。Review 中 morningman 要求所有 `@SerializedName` 使用短名（如 `sti`、`stot`）以减小 edit log 体积，作者已采纳。

### OlapTxnInsertExecutor：事务导入执行器

PR 从 `OlapInsertExecutor` 中拆分出 `OlapTxnInsertExecutor`，专门处理事务模式下的 insert。在 `InsertIntoTableCommand` 中根据 `ctx.isTxnModel()` 选择执行器：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/trees/plans/commands/insert/InsertIntoTableCommand.java"
insertExecutor = ctx.isTxnModel()
    ? new OlapTxnInsertExecutor(ctx, olapTable, label, planner, insertCtx)
    : new OlapInsertExecutor(ctx, olapTable, label, planner, insertCtx);
```

`OlapTxnInsertExecutor` 的 `beginTransaction` 通过 `TransactionEntry` 获取 sub_txn_id（而非直接调用 `GlobalTransactionMgr.beginTransaction`），`onComplete` 将 tablet commit info 收集到 `TransactionEntry` 而非立即提交：

```java title="fe/fe-core/src/main/java/org/apache/doris/nereids/trees/plans/commands/insert/OlapTxnInsertExecutor.java"
@Override
protected void onComplete() {
    TransactionEntry txnEntry = ctx.getTxnEntry();
    if (ctx.getState().getStateType() == MysqlStateType.ERR) {
        cleanTransaction();   // 出错时 abort 子事务
    } else {
        txnEntry.addTabletCommitInfos(txnId, (Table) table, coordinator.getCommitInfos(),
                SubTransactionType.INSERT);
    }
}
```

### 隔离级别：READ COMMITTED

PR 在事务内提供 `READ COMMITTED` 隔离级别，有两个关键设计：

1. **事务内每条语句读到的是语句开始执行时已提交的数据**——不能读到同事务内其他语句的修改。
2. **DELETE 条件先于 INSERT 提交**。`delete from` 有两种实现：delete condition 和 insert。如果 delete condition 在 insert 之后提交，delete 会作用于 insert 的结果。为保证语义一致，PR 让 delete condition 先于 insert 提交：

```sql
-- delete 会作用于上面的 insert 结果
begin;
insert into t select * from t1 where id = 1;
delete from t where id = 1;
commit;
```

在 `TransactionEntry.beginTransaction` 中，如果当前子事务是 DELETE 且同一表已有 INSERT 子事务，直接抛异常阻止：

```java title="fe/fe-core/src/main/java/org/apache/doris/transaction/TransactionEntry.java"
if (subTransactionType == SubTransactionType.DELETE && subTransactionStates.stream()
        .anyMatch(s -> s.getTable().getId() == table.getId()
                && s.getSubTransactionType() == SubTransactionType.INSERT)) {
    throw new AnalysisException("Can not delete because there is a insert operation for the same table");
}
```

---

## 测试

### 回归测试

新增多个回归测试套件，覆盖事务内多次写入的核心场景：

| 测试文件 | 覆盖场景 |
| --- | --- |
| `regression-test/suites/insert_p0/txn_insert.groovy` | 事务内多次 insert、insert+delete 组合、超时回滚（+342 行） |
| `regression-test/suites/insert_p0/txn_insert_concurrent_insert.groovy` | 事务内并发 insert |
| `regression-test/suites/insert_p0/txn_insert_inject_case.groovy` | 注入故障点（commit 失败等） |
| `regression-test/suites/insert_p0/txn_insert_with_schema_change.groovy` | 事务内写入时发生 schema change |
| `regression-test/suites/insert_p2/txn_insert.groovy` | p2 级别事务导入 |

### 单元测试

`GlobalTransactionMgrTest` 新增 +803 行，包含关键的副本失败测试 `testCommitTransactionWithSubTxnAndReplicaFailed`，验证在副本异常时子事务提交的正确性。`DatabaseTransactionMgrTest` 新增 +278 行，`TransactionStateTest` 新增 +98 行。

---

## Review

**dataroaring** 提出了多个深入的场景质疑：

1. **副本连续性**：要求保证至少一个副本没有 version 空洞。作者补充了单元测试 `testCommitTransactionWithSubTxnAndReplicaFailed` 验证。

2. **insert + delete 语义歧义**：如果事务内对同一表先 insert 再 delete，delete 通过 push handler（delete condition）实现时会作用于 insert 结果，但 `delete from` 格式不会——对用户而言语义不一致。作者解释：`delete from t1` 与后续 `insert t1` 的情况下 delete 不影响下一次 insert（测试 case 14 覆盖）。

3. **隔离级别确认**：dataroaring 追问多线程场景下事务内 insert 的可见性，作者确认 Doris 提供 `READ COMMITTED` 隔离级别。

4. **修改副本数**：两次 insert 之间修改表的 replication num 会怎样——review 中提出但作者未在 PR 中处理该边界。

**morningman** 要求 `@SerializedName` 使用短名（`sti`、`stot`、`lst` 等）以减小 edit log 体积，作者已采纳。

**yujun777** 关注升级兼容性：FE 有历史事务时升级重启，能否用 JSON 格式读取？作者解释：元数据版本 131 时仍走原 `readFields` 方法读取旧格式事务。

---

## 问题

### delete-before-insert 的顺序约束

事务内 delete 和 insert 的执行顺序需要特别处理。PR 的解法是在 `beginTransaction` 中校验：如果同一表已有 INSERT 子事务，不允许再发起 DELETE 子事务。这意味着 delete 操作必须在 insert 之前执行，否则会抛异常。这一限制在 review 中引发了语义讨论——对于 `delete from` 格式，delete 不会作用于后续 insert 的结果，但对 delete condition（push handler）格式则会。PR 最终通过让 delete condition 先于 insert commit 来统一语义。

### BE 侧上下文覆盖

BE 的 `txn_manager` 用 `txn_id` 索引导入上下文，同一 `txn_id` 二次写入会覆盖。引入 `sub_txn_id` 后，BE 用 sub_txn_id 区分不同导入，每个子事务拥有独立的 `DeltaWriter` 和 tablet 写入上下文。commit 后 FE 通过 `ClearTransactionTask` 按 sub_txn_id 清理 BE 侧上下文。

---

## 意义与影响

| 能力 | PR 前 | PR 后 |
| --- | --- | --- |
| 事务内多次 insert 同一表 | ✗ | ✓ |
| 事务内 insert + delete 组合 | ✗ | ✓（受顺序约束） |
| 隔离级别 | - | READ COMMITTED |
| 事务序列化格式 | 二进制 | JSON（版本 132+） |

* **ETL 场景**：用户可以在一个事务内分批 insert 大量数据，无需拆分为多个事务，降低事务管理开销。
* **数据一致性**：同一事务内的多次写入要么全部可见、要么全部回滚，提供更强的原子性保证。
* **基础设施**：子事务机制为后续事务内 `update` / `delete` 的完整支持铺平道路（前序 PR #33034 / #33100 的配套改进）。
* **元数据演进**：`TransactionState` 切换到 JSON 序列化降低了后续新增字段的维护成本，但要求 FE 元数据版本升级到 132，集群升级时需注意兼容性。

> **限制**：Cloud 模式下子事务的 `commitAndPublishTransaction` 和 `addSubTransaction` / `removeSubTransaction` 接口抛出 `UnsupportedOperationException`，Cloud 模式支持留待后续。

> **后续**：本 PR 的事务导入仅在连接 Master FE 时正常工作——连接 follower FE 时 DML 转发到 Master 但事务上下文未一起传递，导致数据提前可见。[PR #35075](https://github.com/apache/doris/pull/35075) 通过在转发请求中携带 `TTxnLoadInfo` 修复了这一问题，详见[修复事务导入连接 Follower FE 时事务上下文丢失](/vibe-reading/articles/doris-pr-35075-txn-insert-follower-fe)。
