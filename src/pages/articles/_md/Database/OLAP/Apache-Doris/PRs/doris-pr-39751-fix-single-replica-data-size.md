---
title: "单副本数据量查成多副本：一个漏写的 return 让 SHOW DATA 走错分支"
source:
  project: "Doris"
  type: "PR"
  id: "39751"
  url: "https://github.com/apache/doris/pull/39751"
  prType: "fix"
date: "2026-07-29T22:10:00+08:00"
category: [Database, OLAP, Apache Doris, PRs]
tags: ["Apache Doris", "FE", "OlapTable", "Bug Fix"]
description: "Doris 修复单副本数据量查询错误：OlapTable.getDataSize(true) 漏写 return，导致单副本查询落到多副本总量分支，返回值偏大。一行补上 return 即修正。"
readingTime: "7 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> 📎 本文是 [SHOW DATA 去锁：把表统计从现场遍历改成 volatile 快照](/vibe-reading/articles/doris-pr-35457-optimize-show-table-statistics) 的后续修复，修的是该 PR 引入的第二个回归，建议先阅读原文。

> **PR** [#39751](https://github.com/apache/doris/pull/39751) · **Issue** - · **commit** [a3824d657bc](https://github.com/apache/doris/commit/a3824d657bc179b30158ea6949edcf53fb102f85) · **首发版本** 3.0.5 / 4.0.5 · **变更行数** +1 行 · **合并时间** 2025-02-19

---

## 背景

[#35457](https://github.com/apache/doris/pull/35457) 给 `OlapTable` 引入了 `Statistics` 快照，其中数据量分两个口径：

- `dataSize`：单副本数据量（每个 tablet 取最大副本后求和）
- `totalReplicaDataSize`：多副本数据量之和

对应的 getter 是重载方法 `getDataSize(boolean singleReplica)`：

- `singleReplica=true` → 应返回 `dataSize`
- `singleReplica=false` → 应返回 `totalReplicaDataSize`

#39751 报告的现象：**查询单副本数据量时结果不正确**——返回值偏大，实际拿到的是多副本总量。

## 实现

bug 出在 `OlapTable.getDataSize(boolean singleReplica)` 的 `singleReplica=true` 分支。#35457 引入时漏写了 `return`：

```java title="OlapTable.java（#35457 引入的有误写法）"
public long getDataSize(boolean singleReplica) {
    if (singleReplica) {
        statistics.getDataSize();   // ⚠️ 调用了但没 return
    }

    return statistics.getTotalReplicaDataSize();
}
```

`statistics.getDataSize()` 被调用、返回值却被丢弃，方法继续往下走，最终返回 `statistics.getTotalReplicaDataSize()`。也就是说，**无论 `singleReplica` 是 true 还是 false，都走多副本总量分支**。单副本查询因此拿到多副本口径的值——对三副本表就是约 3 倍的偏大。

#39751 的修复只补了一个 `return` 关键字：

```java title="OlapTable.java（#39751 修正后）"
public long getDataSize(boolean singleReplica) {
    if (singleReplica) {
        return statistics.getDataSize();
    }

    return statistics.getTotalReplicaDataSize();
}
```

整个 PR 的 diff 是名副其实的一行：`1 file changed, 1 insertion(+), 1 deletion(-)`。

> 这类「调用后忘 return」的笔误在 Java 里是经典陷阱：方法末尾恰好有一个兜底的 `return`，编译能过、不会抛异常，只是返回值不对，极难在单测中被偶然发现——尤其当两个分支返回的是「同类但量级不同」的值时。姊妹篇 [#35818](/vibe-reading/articles/doris-pr-35818-fix-show-data-total-size) 的 `+=` 位置错误与之同源：都是 #35457 收敛写入点时留下的细小笔误，被 `volatile` 快照的「延迟暴露」特性放大。

## 测试

本 PR **未附带任何测试**，diff 仅含 `OlapTable.java` 一行改动，无回归测试。单副本数据量口径的查询路径正确性靠线上反馈验证。结合 [#35818](/vibe-reading/articles/doris-pr-35818-fix-show-data-total-size) 也没有针对性的多副本回归测试，可见 #35457 引入的两个 `Statistics` 口径回归，整体缺乏单元测试层面的覆盖——这是「把遍历逻辑收敛到快照后，读路径无锁化」重构的测试盲区。

## Review

Review 顺畅，dataroaring、freemandealer 两位 approve，均留言「LGTM」，无实质性技术讨论。改动过于明确（缺 `return`、补 `return`），无争议空间。

## 问题

### 与 #35818 的关系：同一 PR 的两个姊妹回归

#35457 在 `Statistics` 的两个数据量口径上各栽了一个笔误，由两个独立 PR 分别修复：

| 回归 | 口径 | 笔误类型 | 修复 PR | 现象 |
|---|---|---|---|---|
| 多副本总量 | `totalReplicaDataSize` | `+=` 误放 `if` 内 | [#35818](https://github.com/apache/doris/pull/35818)（2024-06） | 三副本总量少算成一份 |
| 单副本值 | `dataSize` | 漏 `return` | [#39751](https://github.com/apache/doris/pull/39751)（2025-02） | 单副本查成多副本，偏大 |

两者方向相反（一个偏小、一个偏大），但根因相同：**把原本分散在调用点的遍历逻辑收敛到 `TabletStatMgr` 唯一写入点后，写入点的笔误就成了全集群统计正确性的单点**，且 `volatile` 快照读取让问题被延迟到下一个周期才暴露。#39751 距 #35457 合并近 9 个月才修复，也印证了这种延迟暴露的特性。

值得注意的是 #39751 的作者 xy720，正是后来在 `branch-1.2-lts` 上做 [#39807](https://github.com/apache/doris/pull/39807) 减锁改造、并在摘取 #35457 代码时提前规避了这两个笔误的人——见[用 volatile 快照打破表统计读锁的死锁](/vibe-reading/articles/doris-pr-39807-reduce-lock-table-statistics)。

## 意义与影响

- **修复单副本口径**。所有以 `getDataSize(true)` 查询单副本数据量的路径恢复正确，不再返回多副本总量。
- **影响范围**。单副本数据量用于容量评估、单副本口径的统计展示等场景；修复前在三副本及以上表上结果偏大约 N 倍（N = 副本数）。
- **定位** #35457 引入的两个回归之二（另一为 [#35818](/vibe-reading/articles/doris-pr-35818-fix-show-data-total-size)）。两个修复共同让 #35457 的 `Statistics` 快照口径回归正确。
- **回填**：本 PR 通过 cherry-pick [#48106](https://github.com/apache/doris/pull/48106) 回填到 `branch-3.0`（`dev/3.0.5-merged`），master 首发于 4.0.5。
