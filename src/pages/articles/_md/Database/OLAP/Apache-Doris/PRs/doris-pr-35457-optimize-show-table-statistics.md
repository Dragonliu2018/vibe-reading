---
title: "SHOW DATA 去锁：把表统计从现场遍历改成 volatile 快照"
source:
  project: "Doris"
  type: "PR"
  id: "35457"
  url: "https://github.com/apache/doris/pull/35457"
  prType: "perf"
date: "2026-07-29T20:30:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "FE", "OlapTable", "锁优化", "TabletStatMgr"]
description: "Doris 把 OlapTable 的数据量/副本数/行数统计从每次 SHOW DATA 现场遍历加读锁，改成 TabletStatMgr 周期预计算 + volatile 快照读取，读取路径 O(1) 且无需持锁。"
readingTime: "9 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PR** [#35457](https://github.com/apache/doris/pull/35457) · **Issue** - · **commit** [cc2648c1567](https://github.com/apache/doris/commit/cc2648c15678df80320ded6742808dc5f947949f) · **首发版本** 2.1.8 / 3.0.0 · **变更行数** +173 行 · **合并时间** 2024-05-28

---

## 背景

`SHOW DATA`、`SHOW PARTITIONS`、库配额检查、Prometheus 指标导出，这些 FE 侧的元数据查询都要拿到一张表的数据量（`dataSize`）、副本数（`replicaCount`）、远端数据量（`remoteDataSize`）、行数等统计信息。

在 #35457 之前，`OlapTable` 没有把这些统计「存」下来，而是每次查询都**现场遍历**整棵 partition → materialized index → tablet → replica 的元数据树累加出来：

```java title="OlapTable.java（旧实现）"
public long getDataSize(boolean singleReplica) {
    long dataSize = 0;
    for (Partition partition : getAllPartitions()) {
        dataSize += partition.getDataSize(singleReplica);
    }
    return dataSize;
}

public long getDataSize() {
    return getDataSize(false);
}
```

遍历本身要访问 partition / tablet / replica 的内存结构，因此调用方必须持有 `OlapTable` 的读锁，典型的调用点是这样包起来的：

```java title="ShowDataStmt.java（旧实现）"
olapTable.readLock();
try {
    tableSize = olapTable.getDataSize();
    replicaCount = olapTable.getReplicaCount();
    remoteSize = olapTable.getRemoteDataSize();
} finally {
    olapTable.readUnlock();
}
```

这套「现场遍历 + 读锁」的做法有两个问题：

1. **重复计算**。`TabletStatMgr` 本来就每 60 秒周期性遍历一次全集群的 tablet 元数据来汇总行数（写回 `index.setRowCount`），`SHOW DATA` 再遍历一遍是纯粹的重复劳动，大表下耗时可观。
2. **锁竞争**。读锁虽然共享，但一旦有线程在等写锁（schema change、load、alter），后续读锁会排在写锁后面被阻塞。`SHOW DATA` 持锁时间越长，与 DDL/load 抖动的概率越高，极端情况下还会放大死锁风险（后续 PR #39807 标题就直指「Reduce lock when get table statistics」的 deadlock potential）。

#35457 的思路很直接：既然 `TabletStatMgr` 已经在周期性地算这些数，**把它算好的结果存进 `OlapTable`，查询时直接读，不再现场遍历，也不再持锁**。

## 前置知识

### TabletStatMgr

`TabletStatMgr` 继承自 `MasterDaemon`，在 FE 主节点上按 `tablet_stat_update_interval_second`（默认 60 秒）周期执行 `runAfterCatalogReady()`。它遍历所有库表，对每个 tablet 取「版本追平且行数最小的 replica」作为该 tablet 的行数（行数小说明 compaction 更彻底，更准确），写回 `MaterializedIndex.setRowCount`。

#35457 之前它只汇总行数；之后它顺手把数据量、副本数等也一并算好。

### OlapTable 的读写锁

`OlapTable` 内部用一把读写锁保护 partition / index / tablet 树结构的并发访问。DDL、load 等修改结构操作走写锁；遍历结构走读锁。读统计信息旧路径要拿这把读锁，正是因为要遍历这棵树。

### CloudTabletStatMgr

存算分离模式下对应的统计组件，额外维护一份 `cloudTableStatsMap`，并定义了一个独立的 `CloudTableStats` 类。原生模式（非云）则没有这个 map，统计散落在各 `OlapTable` 上。

## 实现

核心改动一句话：**把「现场遍历计算」改成「周期预计算 + volatile 快照读取」**。分三部分看。

### 1. 新增 `OlapTable.Statistics` 快照

`OlapTable` 新增一个内部类 `Statistics`，把一张表的所有统计字段集中到一个对象里，并用一个 `volatile` 引用持有：

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
    @Getter private Long remoteDataSize;      // single replica remote data size
    @Getter private Long replicaCount;
    @Getter private Long rowCount;
    @Getter private Long rowsetCount;
    @Getter private Long segmentCount;
    // ... 构造函数：无参全 0，全参赋值
}
```

`volatile` 保证引用的可见性：写端整引用替换（`setStatistics` 赋一个新对象），读端拿到的要么是旧快照要么是新快照，不会看到半构造的对象。这就是「volatile 发布」模式——用一个不可变快照替换，免锁读取。

### 2. 读取路径：O(1) 读 volatile，不再遍历不再加锁

`getDataSize` / `getRemoteDataSize` / `getReplicaCount` 全部改成直接读 `statistics`：

```java title="OlapTable.java"
public long getDataSize() {
    return getDataSize(false);
}

public long getDataSize(boolean singleReplica) {
    if (singleReplica) {
        statistics.getDataSize();   // ⚠️ 此处缺 return，见「问题」节
    }
    return statistics.getTotalReplicaDataSize();
}

public long getRemoteDataSize() {
    return statistics.getRemoteDataSize();
}

public long getReplicaCount() {
    return statistics.getReplicaCount();
}
```

旧实现里 `getDataSize` / `getRemoteDataSize` / `getReplicaCount` 三个遍历 partition 的方法被整体删除，O(partition × tablet × replica) 的遍历降为 O(1) 的字段读取。

### 3. 写入路径：TabletStatMgr 周期预计算

`TabletStatMgr.runAfterCatalogReady()` 在本来就要持有的 `writeLockIfExist` 区段内，顺带累加每个 replica 的数据量、副本数，遍历完一张表后用 `setStatistics` 发布快照：

```java title="TabletStatMgr.java"
for (Replica replica : tablet.getReplicas()) {
    if (replica.getDataSize() > tabletDataSize) {
        tabletDataSize = replica.getDataSize();
        tableTotalReplicaDataSize += replica.getDataSize();  // ⚠️ 位置有误，见「问题」节
    }
    if (replica.getRemoteDataSize() > tabletRemoteDataSize) {
        tabletRemoteDataSize = replica.getRemoteDataSize();
    }
    tableReplicaCount++;
}
tableDataSize += tabletDataSize;
// ...
olapTable.setStatistics(new OlapTable.Statistics(db.getName(), table.getName(),
        tableDataSize, tableTotalReplicaDataSize,
        tableRemoteDataSize, tableReplicaCount, tableRowCount, 0L, 0L));
```

关键点：写快照发生在已经持有表写锁的区段内，写锁本身保证了遍历期间结构不被改，发布后立刻释放锁。统计写入与读取通过 volatile 解耦，互不阻塞。

存算分离侧的 `CloudTabletStatMgr` 做同样改造，并顺手把原来独立的 `CloudTableStats` 类删掉，统一复用 `OlapTable.Statistics`——两套模式的统计模型就此收敛到一个类型。

### 4. 调用方去锁

统计读取不再需要 `OlapTable` 读锁，所有调用点把 `readLock()/readUnlock()` 包裹去掉：

```java title="ShowDataStmt.java（新实现）"
// 直接读，不再 olapTable.readLock()
tableSize = olapTable.getDataSize();
replicaCount = olapTable.getReplicaCount();
remoteSize = olapTable.getRemoteDataSize();
```

`Database` 侧同理，`getUsedDataSize()` 去掉内层 `olapTable.readLock`，只保留 `Database` 自身的读锁；方法 `getReplicaCountWithLock` 顺势重命名为 `getReplicaCount`，`DbsProcDir`、`Database.getReplicaQuotaLeftWithLock` 等调用点跟随改名。`PrometheusMetricVisitor` 的云表指标也改用 `OlapTable.Statistics` 的 getter。

改动后的数据流如下：

```
TabletStatMgr.runAfterCatalogReady (每 60s, 持 table 写锁)
        │  遍历 tablet/replica 累加
        ▼
olapTable.setStatistics(...)  ── volatile 写 ──┐
                                               │
ShowDataStmt / Database.getUsedDataSize        │ volatile 读
  → olapTable.getDataSize()  ← statistics ─────┘
  (无 OlapTable 读锁)
```

## 测试

这个 PR 没有附带新的单元测试——本质是一次「遍历改快照」的重构，正确性靠现有 `SHOW DATA` 回归用例覆盖，性能靠 doris-robot 在 PR 上自动跑的 TPC-H / TPC-DS / ClickBench 基准（`aliyun_ecs.c7a.8xlarge_32C64G`）确认无回归。这类「读路径去锁」的收益主要体现在大集群、高频 `SHOW DATA` 场景下的锁等待消除，标准基准测试难以直接体现，故此处不罗列具体数字。

## 问题

这次重构在合并后暴露了两个正确性回归，各由一个后续 PR 修复。它们恰好对应 `Statistics` 的两个语义维度——多副本总量与单副本值。

### `getDataSize()` 默认路径总量算错（#35818 修复）

`getDataSize()` 无参版本走 `getDataSize(false)`，返回 `statistics.getTotalReplicaDataSize()`，语义应当是「所有副本数据量之和」（与旧 `Tablet.getDataSize(false)` 的 `s.sum()` 一致）。但原始 diff 把累加语句放进了 `if` 块：

```java title="TabletStatMgr.java（#35457 原始写法，有误）"
if (replica.getDataSize() > tabletDataSize) {
    tabletDataSize = replica.getDataSize();
    tableTotalReplicaDataSize += replica.getDataSize();  // 只在每个 tablet 的最大副本上累加
}
```

`+=` 在 `if` 内，意味着每个 tablet 只有「最大那个副本」被计入 `totalReplicaDataSize`，结果它退化成了「各 tablet 最大副本之和」——和 `dataSize`（单副本口径）几乎相等，**三副本的总量被少算成了一份**。这直接导致 `SHOW DATA` 的总量偏小。[#35818](https://github.com/apache/doris/pull/35818) 「fix show data total size wrong」把这条 `+=` 移到 `if` 之外，对每个 replica 都累加，才恢复正确的多副本总量：

```java title="TabletStatMgr.java（#35818 修正后）"
if (replica.getDataSize() > tabletDataSize) {
    tabletDataSize = replica.getDataSize();
}
tableTotalReplicaDataSize += replica.getDataSize();  // 每个 replica 都计入
```

### `getDataSize(true)` 单副本路径漏 return（#39751 修复）

`getDataSize(boolean singleReplica)` 的 `singleReplica=true` 分支调用了 `statistics.getDataSize()` 却忘了 `return`，执行会继续落到方法末尾的 `return statistics.getTotalReplicaDataSize()`，于是单副本查询拿到的是多副本总量。[#39751](https://github.com/apache/doris/pull/39751) 「Fix show data size of single replica result incorrect」补上了这个 `return`：

```java title="OlapTable.java（#39751 修正后）"
public long getDataSize(boolean singleReplica) {
    if (singleReplica) {
        return statistics.getDataSize();
    }
    return statistics.getTotalReplicaDataSize();
}
```

> 这两个 bug 都不是「重构改坏了遍历逻辑」，而是「新写快照时的累加位置 / 返回语句」这类细小笔误。它们的教训是：把一个原本分散在调用点的遍历逻辑收敛到唯一写入点后，**写入点的正确性就成了全集群统计正确性的单点**——一旦写错，所有读取路径一起错，且因为读的是缓存快照，问题会被延迟暴露。

## 意义与影响

- **读取去锁**。`SHOW DATA`、库配额检查、proc 目录、Prometheus 指标等所有读统计的路径不再持有 `OlapTable` 读锁，直接消除了这些查询与 DDL / load 之间的锁竞争，也降低了死锁风险。后续 [#39807](https://github.com/apache/doris/pull/39807) 沿同一方向进一步收窄了 table statistics 的持锁范围。
- **读取复杂度 O(1)**。从遍历整棵 partition/tablet/replica 树降为一次 volatile 字段读取，大表和大集群下 `SHOW DATA` 延迟显著下降。
- **统计模型统一**。删除云模式独立的 `CloudTableStats`，原生与存算分离两种模式复用同一个 `OlapTable.Statistics` 类型，减少了一份重复定义。
- **代价**。统计值有最多一个更新周期（默认 60s）的延迟，且「现场遍历」被取消后，读到的永远是上一次 `TabletStatMgr` 周期跑完的快照。对 `SHOW DATA` 这类观测用途完全可接受；影响面覆盖所有依赖 `getDataSize` / `getReplicaCount` 的路径（配额、指标、proc）。

## TODO

- [x] 修复 `totalReplicaDataSize` 累加位置导致的 `SHOW DATA` 总量偏小 —— [#35818](https://github.com/apache/doris/pull/35818)

  > **后续**：#35818 把 `+=` 挪出 `if` 块，修正多副本总量被少算成一份的问题，但云模式 `CloudTabletStatMgr` 的同源笔误未修，详见[SHOW DATA 总量算错](/vibe-reading/articles/doris-pr-35818-fix-show-data-total-size)。

- [x] 修复 `getDataSize(true)` 单副本路径漏 `return` —— [#39751](https://github.com/apache/doris/pull/39751)

  > **后续**：#39751 补上漏写的 `return`，修正单副本查询拿到多副本总量的问题，详见[单副本数据量查成多副本](/vibe-reading/articles/doris-pr-39751-fix-single-replica-data-size)。
- [x] 进一步收窄 table statistics 读取时的持锁范围、降低死锁风险 —— [#39807](https://github.com/apache/doris/pull/39807)

  > **后续**：#39807 把本 PR 的减锁思路摘到 `branch-1.2-lts`，专门针对 `createTable` 配额检查的跨表读锁死锁，并提前规避了本文记录的两个笔误，详见[用 volatile 快照打破表统计读锁的死锁](/vibe-reading/articles/doris-pr-39807-reduce-lock-table-statistics)。
