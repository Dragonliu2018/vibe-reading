---
title: "SHOW DATA 总量算错：一行 += 挪出 if 块，找回三副本丢失的两份"
source:
  project: "Doris"
  type: "PR"
  id: "35818"
  url: "https://github.com/apache/doris/pull/35818"
  prType: "fix"
date: "2026-07-29T22:00:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "FE", "OlapTable", "TabletStatMgr", "Bug Fix"]
description: "Doris 3.0 修复 SHOW DATA 在多副本下总数据量偏小的 bug：TabletStatMgr 把 totalReplicaDataSize 的累加误放在 if 块内，每个 tablet 只计最大副本，三副本被算成一份。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> 📎 本文是 [SHOW DATA 去锁：把表统计从现场遍历改成 volatile 快照](/vibe-reading/articles/doris-pr-35457-optimize-show-table-statistics) 的后续修复，修的是该 PR 引入的第一个回归，建议先阅读原文。

> **PR** [#35818](https://github.com/apache/doris/pull/35818) · **Issue** - · **commit** [7ba17cbfb31](https://github.com/apache/doris/commit/7ba17cbfb31f8b451c792a2e6e88367fb1356a6a) · **首发版本** 3.0.0 · **变更行数** +29 行 · **合并时间** 2024-06-04

---

## 背景

[#35457](https://github.com/apache/doris/pull/35457) 把 `OlapTable` 的表统计从「现场遍历」改成「`TabletStatMgr` 周期预计算 + `volatile` 快照读取」。新引入的 `OlapTable.Statistics` 有两个数据量字段：

- `dataSize`：单副本数据量（每个 tablet 取最大副本）
- `totalReplicaDataSize`：所有副本数据量之和（多副本总量）

`getDataSize()`（无参，`singleReplica=false`）返回的是 `totalReplicaDataSize`，也就是 `SHOW DATA` 里展示的「表总大小」。

#35818 报告的现象：**设置 `replica = 3` 时，`SHOW DATA` 返回的数据量明显偏小**。作者定位到原因——「the total size calculation only accounts for the maximum replica data size」，即总量口径退化成了单副本口径。

## 实现

bug 在 `TabletStatMgr.runAfterCatalogReady()` 的 replica 遍历循环里。#35457 引入时的写法把 `totalReplicaDataSize` 的累加放进了「取最大副本」的 `if` 块内：

```java title="TabletStatMgr.java（#35457 引入的有误写法）"
for (Replica replica : tablet.getReplicas()) {
    if (replica.getDataSize() > tabletDataSize) {
        tabletDataSize = replica.getDataSize();
        tableTotalReplicaDataSize += replica.getDataSize();  // ⚠️ 在 if 内
    }
    // ...
}
```

`+=` 在 `if (replica.getDataSize() > tabletDataSize)` 内，意味着**只有当某个副本的数据量刷新了当前 tablet 的最大值时，它才被计入总量**。一个 tablet 有 3 个副本，通常只有第 1 个副本（初始 `tabletDataSize=0`，任何副本都大于它）触发累加，后两个副本若数据量不大于已记录的最大值，就被跳过。

结果：`tableTotalReplicaDataSize` 实际累加的是「每个 tablet 的最大副本之和」，而不是「所有副本之和」。对三副本表，这几乎等于只算了一份，**丢失了另外两份**——正好与「总量退化成单副本口径」的现象吻合。

#35818 的修复就是把这条 `+=` 挪到 `if` 之外，对每个 replica 无条件累加：

```java title="TabletStatMgr.java（#35818 修正后）"
for (Replica replica : tablet.getReplicas()) {
    if (replica.getDataSize() > tabletDataSize) {
        tabletDataSize = replica.getDataSize();
    }
    tableTotalReplicaDataSize += replica.getDataSize();  // 每个 replica 都计入
    // ...
}
```

改动只有一行位置调整（diff 显示为删一行、加一行），但语义天差地别：`tabletDataSize`（单副本口径，取最大）与 `tableTotalReplicaDataSize`（多副本口径，求和）从此各走各的累加路径，互不干扰。

> 为何这种 bug 难以一眼看出：`+= replica.getDataSize()` 紧跟在 `tabletDataSize = replica.getDataSize()` 之后，缩进、变量名都高度相似，读代码时极易把它当成「取最大副本」逻辑的一部分。本质上这是两个独立口径（max vs sum）被错误地耦合进了同一个条件分支。

## 测试

### 回归测试

PR 附带修改了 `regression-test/suites/inverted_index_p0/test_show_data.groovy`，但需注意：**该测试用例的建表均使用 `replication_allocation = "tag.location.default: 1"`（单副本）**，并未直接覆盖 PR 描述的 `replica = 3` 场景。它的实际改动是测试辅助函数 `wait_for_show_data_finish` 的健壮性提升：

```groovy title="test_show_data.groovy（改动前后对比）"
// 旧：size 声明在循环内，仅当某次轮询与 origin 不同就立即返回
def size = result[0][2].replace(" KB", "").toDouble()
if (size != origin_size) { return size }

// 新：size 提到循环外，循环结束后再判断是否变化
def size = origin_size;
for (...) {
    size = result[0][2].replace(" KB", "").toDouble()
}
if (size != origin_size) { return size; }
```

同时把多处等待超时从 `300000`ms 降到 `120000`ms 以加速用例。这属于测试稳定性优化，**并非针对多副本总量 bug 的断言**。换句话说，这个一行修复本身没有专门的多副本回归测试兜底——正确性主要靠代码 review 与线上 `SHOW DATA` 现象验证。

## Review

Review 较为顺畅，gavinchou、xiaokang、swjtu-zhanglei、dataroaring 四位均 approve，xiaokang 留言「LGTM」。无实质性技术讨论——bug 定位清晰、改动极小，争议空间有限。值得注意的是 swjtu-zhanglei 正是 #35457 的作者，此处参与 review 了对自己 PR 的修复。

## 问题

### 云模式（CloudTabletStatMgr）的同源 bug 未修

#35457 同时改了原生模式的 `TabletStatMgr` 和存算分离的 `CloudTabletStatMgr`，两处都把 `+=` 放进了 `if` 块。但 #35818 **只修了 `TabletStatMgr`，没有动 `CloudTabletStatMgr`**。

核对当前 master 源码（`git blame`），`CloudTabletStatMgr.java:373` 的那行 `tableTotalReplicaDataSize += replica.getDataSize();` 仍归属于 #35457 的原始提交（`1a42a2acb68`，2024-05-28），从未被修正：

```java title="CloudTabletStatMgr.java（当前 master，仍是有误写法）"
for (Replica replica : tablet.getReplicas()) {
    if (replica.getDataSize() > tabletDataSize) {
        tabletDataSize = replica.getDataSize();
        tableTotalReplicaDataSize += replica.getDataSize();  // ⚠️ 仍在 if 内，未修
    }
    // ...
}
```

这意味着在存算分离模式下，`getDataSize(false)`（多副本总量）可能仍存在「只计各 tablet 最大副本」的少算问题。是否构成线上 bug 取决于云模式 replica 的数据量语义（云模式下数据在共享存储，各 replica 的 `getDataSize()` 是否各自独立计费/计大小），但至少从代码一致性看，这是一个遗留的同源隐患，与姊妹篇 [#39751](/vibe-reading/articles/doris-pr-39751-fix-single-replica-data-size) 修的另一个 #35457 回归一样，都是「收敛到唯一写入点后，写入点笔误被延迟暴露」的同类问题。

## 意义与影响

- **修复多副本总量**。`SHOW DATA`、库数据量配额检查等依赖 `getDataSize()`（多副本口径）的路径，在三副本及以上场景下恢复正确，总量不再被少算成单份。
- **影响范围**。所有读 `OlapTable.getDataSize()` 无参版本的路径——`SHOW DATA`、`Database.getUsedDataSize`、Prometheus 指标等——在 `replica > 1` 时均受影响，修复后一并校正。
- **定位** #35457 引入的两个回归之一；另一个是 `getDataSize(true)` 单副本路径漏 `return`，由 [#39751](https://github.com/apache/doris/pull/39751) 修复，详见[姊妹篇](/vibe-reading/articles/doris-pr-39751-fix-single-replica-data-size)。

## TODO

- [ ] `CloudTabletStatMgr` 的 `tableTotalReplicaDataSize += ` 仍在 `if` 块内，与 #35818 修的是同源问题，云模式下多副本总量可能仍少算——当前 master 未修
