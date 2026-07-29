---
title: "用 volatile 快照打破表统计读锁的死锁：1.2-lts 的减锁改造"
source:
  project: "Doris"
  type: "PR"
  id: "39807"
  url: "https://github.com/apache/doris/pull/39807"
  prType: "fix"
date: "2026-07-29T21:10:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "FE", "OlapTable", "锁优化", "死锁", "TabletStatMgr"]
description: "Doris 1.2-lts 把表统计数据量/副本数从 createTable 配额检查时的现场遍历加读锁，改成 TabletStatMgr 周期预计算的 volatile 快照读取，消除跨表读锁导致的公平锁死锁。"
readingTime: "9 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> 📎 本文与 [SHOW DATA 去锁：把表统计从现场遍历改成 volatile 快照](/vibe-reading/articles/doris-pr-35457-optimize-show-table-statistics) 是同一思路的两条落地线：#35457 走 master，#39807 把其中减锁部分单独摘到 branch-1.2-lts，并修掉了前者引入的两个回归。建议两篇对照阅读。

> **PR** [#39807](https://github.com/apache/doris/pull/39807) · **Issue** - · **commit** [367d2642dd2](https://github.com/apache/doris/commit/367d2642dd2821e1285d9d55f132d0757fab56c9) · **首发版本** -（合入 `branch-1.2-lts`）· **变更行数** +98 行 · **合并时间** 2024-08-28

---

## 背景

Doris 在 `createTable` 时要做库级配额检查——遍历库里所有表，累加已用数据量（`getDataSize`）和副本数（`getReplicaCount`），判断是否超出 `replicaQuota` / 数据量配额。问题出在「遍历」这一步：旧实现里每访问一张表都要拿该表的**读锁**，因为统计值是现场遍历 partition/tablet/replica 算出来的。

PR 描述里给了一个真实的死锁时间线，四个线程、两张表（table1 / table2）：

| 时间点 | create table 线程1 | create table 线程2 | table stat 线程 | truncate 线程 |
|---|---|---|---|---|
| t1 | 拿 table1 读锁 | | | |
| t2 | | 拿 table2 读锁 | | |
| t3 | | | 申请 table1 **写锁**，阻塞 | |
| t4 | | | | 申请 table2 **写锁**，阻塞 |
| t5 | 申请 table2 读锁——因 truncate 已在等 table2 写锁，被迫排队 | | | |
| t6 | | 申请 table1 读锁——因 table stat 已在等 table1 写锁，被迫排队 | | |

死锁成因是**公平锁**语义：一旦有写锁在队列里等待，后续的读锁请求不能「插队」共享，必须排在写锁后面。于是：

- 线程1 持有 table1 读锁，等 table2 读锁（排在 truncate 的写锁后面）；
- 线程2 持有 table2 读锁，等 table1 读锁（排在 table stat 的写锁后面）。

两条 create table 线程互相等对方手里的表读锁，形成循环等待。`table stat` 线程要拿写锁（`TabletStatMgr` 里 `table.writeLockIfExist()`），`truncate` 也要写锁，二者本来是正常排队，但因为 create table 的配额检查在遍历时拿了**一堆表读锁**，把无关节点拉进了依赖环。

PR 作者的结论很直接：「This deadlock situation usually occurs when it is a fair lock. So we should optimize the read lock.」——只要配额检查不再拿表读锁，环就断了。

## 前置知识

### OlapTable 的读写锁与公平锁

`OlapTable` 用一把读写锁保护 partition / index / tablet 树结构。DDL（create/alter/truncate）走写锁，遍历结构走读锁。Doris 的 `DorisLock` 默认按公平模式构造，读锁不会越过已在等待的写锁——这正是上面死锁的温床。

### 配额检查的调用链

`createTable` → `Database.getReplicaQuotaLeftWithLock()` → `getReplicaCountWithLock()`，后者遍历 `idToTable`，对每张 `OlapTable` 调 `getReplicaCount()`。旧代码里这个调用被包在 `olapTable.readLock() / readUnlock()` 里。`getUsedDataQuotaWithLock()` 同理。两条路径都会在持锁状态下访问多张表。

### TabletStatMgr

`TabletStatMgr` 继承 `MasterDaemon`，按 `tablet_stat_update_interval_second`（默认 60s）周期遍历全集群 tablet 元数据，本就要在 `table.writeLockIfExist()` 区段内逐 replica 累加行数。它天然是「写快照」的合适地点。

## 实现

核心思路与 #35457 一致：**把统计值的计算从读路径搬到 `TabletStatMgr` 的周期写路径，读路径只读一个 `volatile` 快照，不再拿表读锁**。区别在于 #39807 只摘了「减锁」必需的部分，字段更精简。

### 1. `OlapTable.Statistics` 快照

新增内部类，只放减锁需要的三个量：单副本数据量、多副本总数据量、副本数。用一个 `volatile` 引用发布：

```java title="OlapTable.java"
private volatile Statistics statistics = new Statistics();

public void setStatistics(Statistics statistics) {
    this.statistics = statistics;
}

public static class Statistics {
    @Getter private String dbName;
    @Getter private String tableName;
    @Getter private Long dataSize;            // single replica data size
    @Getter private Long totalReplicaDataSize;
    @Getter private Long replicaCount;

    public Statistics() { /* 全 0 */ }
    public Statistics(String dbName, String tableName,
                      Long dataSize, Long totalReplicaDataSize, Long replicaCount) { ... }
}
```

`volatile` 保证引用可见性：写端整对象替换，读端拿到的是完整的旧快照或新快照，不会读到半构造状态。这就是「volatile 发布」免锁读取模式。

> 对比 #35457：master 版的 `Statistics` 还多带 `remoteDataSize` / `rowCount` / `rowsetCount` / `segmentCount` 等字段，服务于 `SHOW DATA` 的完整列输出。#39807 只为破死锁，配额检查只需要数据量和副本数，故字段更少。

### 2. 读取路径：O(1) 读 volatile，不加锁

旧的三个遍历方法被删除，改为直接读 `statistics`：

```java title="OlapTable.java"
public long getDataSize() {
    return getDataSize(false);
}

public long getDataSize(boolean singleReplica) {
    if (singleReplica) {
        return statistics.getDataSize();
    }
    return statistics.getTotalReplicaDataSize();
}

public long getReplicaCount() {
    return statistics.getReplicaCount();
}
```

O(partition × tablet × replica) 的遍历降为 O(1) 字段读取，且无需 `OlapTable` 读锁——这正是断开死锁环的关键。

### 3. 写入路径：TabletStatMgr 周期预计算

`TabletStatMgr.runAfterCatalogReady()` 在本就持有的 `writeLockIfExist` 区段内，顺带累加每个 replica 的数据量和副本数，遍历完一张表后发布快照：

```java title="TabletStatMgr.java"
long tableDataSize = 0L;
long tableTotalReplicaDataSize = 0L;
long tableReplicaCount = 0L;
if (!table.writeLockIfExist()) {
    continue;
}
try {
    for (Partition partition : olapTable.getAllPartitions()) {
        long version = partition.getVisibleVersion();
        for (MaterializedIndex index : partition.getMaterializedIndices(IndexExtState.VISIBLE)) {
            for (Tablet tablet : index.getTablets()) {
                long tabletDataSize = 0L;
                for (Replica replica : tablet.getReplicas()) {
                    // ... 行数取版本追平且最小的 replica（略）
                    if (replica.getDataSize() > tabletDataSize) {
                        tabletDataSize = replica.getDataSize();
                    }
                    tableTotalReplicaDataSize += replica.getDataSize();
                    tableReplicaCount++;
                }
                tableDataSize += tabletDataSize;
            }
        }
        olapTable.setStatistics(new OlapTable.Statistics(db.getFullName(), table.getName(),
                tableDataSize, tableTotalReplicaDataSize, tableReplicaCount));
    }
} finally {
    table.writeUnlock();
}
```

写快照发生在已持有表写锁的区段内，发布后立即释放。统计的写与读通过 `volatile` 解耦，互不阻塞。

### 4. 调用方去锁 + 收窄 Database 锁范围

`ShowDataStmt` 直接去掉 `olapTable.readLock()` 包裹。`Database` 侧更讲究——`getUsedDataQuotaWithLock` / `getReplicaCountWithLock` 采用了**锁收窄**模式：只在 `Database` 读锁内把表列表拷出来，释放 `Database` 读锁后再遍历、读 `OlapTable` 快照：

```java title="Database.java"
public long getUsedDataQuotaWithLock() {
    long usedDataQuota = 0;
    List<Table> tables = new ArrayList<>();
    readLock();                          // Database 读锁
    try {
        tables.addAll(this.idToTable.values());
    } finally {
        readUnlock();                    // 立刻释放 Database 读锁
    }
    for (Table table : tables) {         // 此后不再持任何表读锁
        if (table.getType() != TableType.OLAP) {
            continue;
        }
        OlapTable olapTable = (OlapTable) table;
        usedDataQuota = usedDataQuota + olapTable.getDataSize();   // 读 volatile 快照
    }
    return usedDataQuota;
}
```

这样配额检查全程不持有 `OlapTable` 读锁，`Database` 读锁也只覆盖一次列表拷贝——死锁环里「create table 线程持表读锁等另一张表读锁」这一段被彻底拿掉，环自然断开。

改动后的数据流：

```
TabletStatMgr.runAfterCatalogReady (每 60s, 持 table 写锁)
        │  遍历 tablet/replica 累加
        ▼
olapTable.setStatistics(...)  ── volatile 写 ──┐
                                               │
createTable 配额检查 / SHOW DATA                │ volatile 读
  → olapTable.getDataSize() ← statistics ──────┘
  (无 OlapTable 读锁 → 公平锁死锁环断开)
```

## Review

**liutang123** 指出一个边界场景：FE 刚重启时，`statistics` 还没被 `TabletStatMgr` 跑过一轮初始化，`dataSize` 默认为 0。此时 `createTable` 的配额检查会以为「库是空的」，不受配额限制——可能放过本该拒绝的建表请求。

> 原文：When fe restarted, the `statistics` has not inited and the dataSize will be 0. At this point, `createTable` behavior will not be restricted.

**xy720**（作者）回应：理想做法是 `statistics` 未初始化时先尝试现场算一次；但这个逻辑打算先在 master 实现，1.2-lts 暂不加。

> 原文：As we discuss, if statistics is not inited, we should try init it first. But I think we may first implement this logic in master branch.

这是一个真实的窗口期风险：FE 重启后到 `TabletStatMgr` 首个周期（默认最多 60s）之间，配额检查会短暂失真。由于只影响「超额建表」这一限流场景、且窗口短，1.2-lts 选择接受该窗口以换取减锁收益。

## 问题

这次 1.2-lts 改造值得注意的是：它**没有重蹈 #35457 的两个覆辙**。对比 master 上 #35457 合入后被迫用两个后续 PR 修复的回归，#39807 的 diff 从一开始就是对的：

| 回归点 | #35457（master）原始 diff | #39807（1.2-lts） |
|---|---|---|
| `totalReplicaDataSize` 累加位置 | `+=` 误放 `if` 块内，每个 tablet 只计最大副本 → 总量少算，由 [#35818](https://github.com/apache/doris/pull/35818) 修复（详见[SHOW DATA 总量算错](/vibe-reading/articles/doris-pr-35818-fix-show-data-total-size)） | `+=` 在 `if` 之外，每个 replica 都计入 ✅ |
| `getDataSize(true)` 单副本路径 | 漏写 `return`，单副本拿到多副本总量，由 [#39751](https://github.com/apache/doris/pull/39751) 修复（详见[单副本数据量查成多副本](/vibe-reading/articles/doris-pr-39751-fix-single-replica-data-size)） | 有 `return statistics.getDataSize();` ✅ |

原因不难理解：#39807 是在 #35457 合入并暴露问题之后才动工的（2024-08 vs 2024-05），作者做摘取时已能参照前者的教训，把累加位置和返回语句写对。这正好印证了「把遍历逻辑收敛到唯一写入点后，写入点的正确性就是全集群统计的单点」——#35457 在单点上栽了两次，#39807 提前规避了。

## 意义与影响

- **打破死锁**。`createTable` 配额检查不再持有 `OlapTable` 读锁，公平锁下的跨表循环等待被根除。这是本 PR 的直接目标，也是它相对 #35457 更聚焦的价值——#35457 偏「读取去锁提速」，#39807 明确针对「死锁」。
- **读取 O(1) 化**。配额检查、`SHOW DATA` 从遍历整棵表树降为一次 `volatile` 字段读取，大表大集群下延迟下降。
- **锁收窄**。`Database` 读锁只覆盖表列表拷贝，不再覆盖整个遍历过程，进一步降低与 DDL 的锁交叠面。
- **代价**。统计值有最多一个周期（默认 60s）的延迟；FE 重启后到首个 `TabletStatMgr` 周期之间，配额检查短暂失真（见 Review）。对限流/观测用途可接受。

## TODO

- [ ] `statistics` 未初始化时（FE 重启窗口）配额检查返回 0，可能放过超额建表——作者计划在 master 实现按需初始化，1.2-lts 暂未处理
- [x] 修正 `totalReplicaDataSize` 累加位置（master 侧由 [#35818](https://github.com/apache/doris/pull/35818) 修复，1.2-lts 本 PR 即正确）
- [x] 修正 `getDataSize(true)` 漏 `return`（master 侧由 [#39751](https://github.com/apache/doris/pull/39751) 修复，1.2-lts 本 PR 即正确）
