---
title: "修复按 DbId/TableId 清除回收站时未级联清理子分区的缺陷"
source:
  project: "Doris"
  type: "PR"
  id: "35750"
  url: "https://github.com/apache/doris/pull/35750"
date: "2026-07-01"
category: [Database, Apache Doris, Contributions]
tags: ["Apache Doris", "Java"]
description: "将 eraseDatabaseInstantly / eraseTableInstantly 从早失败改为延迟报错，确保顶层对象（DB/Table）本身不在回收站时，其下的子条目也能被一并清除。"
readingTime: "6 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#35750](https://github.com/apache/doris/pull/35750) · **Issue** [#35748](https://github.com/apache/doris/issues/35748) · **commit** [67f1ae8](https://github.com/apache/doris/commit/67f1ae8a12f18615ecee185ccaf1694f543d0e0b) · **首发版本** 3.0.0 · **变更行数** +69 行 · **合并时间** 2024-06-02

---

## 背景

PR [#31893](https://github.com/apache/doris/pull/31893) 于 2024-05-30 引入 `DROP CATALOG RECYCLE BIN` 命令后的第二天，Issue [#35748](https://github.com/apache/doris/issues/35748) 随即被提出，描述了一个命令无法处理的场景。

`CatalogRecycleBin` 的三张 Map（`idToDatabase` / `idToTable` / `idToPartition`）**独立维护**，各自有不同的生命周期。当执行 `ALTER TABLE t DROP PARTITION p` 时，**只有分区条目进入 `idToPartition`**，DB 和 Table 条目并不一定存在于回收站中。

此时若按 DbId 触发清除，会命中 PR #31893 实现中的早失败逻辑：

```sql title="Issue #35748 的复现步骤"
-- 只 DROP PARTITION，回收站里只有分区条目，DB 本身不在回收站
mysql> SHOW CATALOG RECYCLE BIN;
+-----------+------+-------+---------+-------------+---------------------+
| Type      | Name | DbId  | TableId | PartitionId | DropTime            |
+-----------+------+-------+---------+-------------+---------------------+
| Partition | p30  | 12056 | 12258   | 12257       | 2024-05-31 22:36:45 |
+-----------+------+-------+---------+-------------+---------------------+

-- 尝试按 DbId 清除 → 报错，分区 p30 留在回收站无法被清除
mysql> DROP CATALOG RECYCLE BIN WHERE 'DbId' = 12056;
ERROR 1105 (HY000): errCode = 2, detailMessage = Unknown database id '12056'
```

相同问题也存在于 TableId 场景：Table 本身不在回收站，但其下仍有分区条目时，按 TableId 清除同样报错。

---

## 前置知识

理解此问题需要明确三张 Map 的**独立写入时机**：

| 操作 | 写入哪张 Map |
| --- | --- |
| `DROP DATABASE db` | `idToDatabase` + `idToTable`（db 下所有表）+ `idToPartition`（表下所有分区） |
| `DROP TABLE t` | `idToTable` + `idToPartition`（表下所有分区） |
| `ALTER TABLE t DROP PARTITION p` | 仅 `idToPartition` |

因此，单独 DROP PARTITION 后，回收站里只有分区条目，对应的 DB 和 Table 条目**根本不存在**于 `idToDatabase` / `idToTable` 中——这就是"DB 不在回收站但其分区仍在"的根本原因。

---

## 实现

### 根因：入口处的早失败

PR #31893 的 `eraseDatabaseInstantly` 在**方法入口**检查 DB 是否存在，不存在就立即抛出异常，后续的级联清理代码永远不会执行：

```java title="旧实现：入口处早失败（PR #31893）"
public synchronized void eraseDatabaseInstantly(long dbId) throws DdlException {
    RecycleDatabaseInfo dbInfo = idToDatabase.get(dbId);
    if (dbInfo == null) {
        throw new DdlException("Unknown database id '" + dbId + "'");
        // ↑ 提前退出，以下级联清理代码永远不执行
    }
    Env.getCurrentEnv().eraseDatabase(dbId, true);
    // ... 清理同 dbId 的 tables 和 partitions
}
```

### 修复：出口处的延迟报错

将"是否找到任何条目"的判断移到**方法出口**：先无条件扫描并清理所有关联条目，最后再决定是否报错：

```java title="CatalogRecycleBin.java — eraseDatabaseInstantly（修复后）"
public synchronized void eraseDatabaseInstantly(long dbId) throws DdlException {
    // 1. DB 条目若存在则擦除，否则跳过（不再提前报错）
    RecycleDatabaseInfo dbInfo = idToDatabase.get(dbId);
    if (dbInfo != null) {
        Env.getCurrentEnv().eraseDatabase(dbId, true);
        idToDatabase.remove(dbId);
        idToRecycleTime.remove(dbId);
        LOG.info("erase db[{}]: {}", dbId, dbInfo.getDb().getName());
    }

    // 2. 无论 DB 是否存在，始终清理同 DbId 下的所有 Table 条目
    List<Long> tableIdToErase = Lists.newArrayList();
    for (Map.Entry<Long, RecycleTableInfo> e : idToTable.entrySet()) {
        if (e.getValue().getDbId() == dbId) tableIdToErase.add(e.getKey());
    }
    for (Long tableId : tableIdToErase) eraseTableInstantly(tableId);

    // 3. 无论 DB 是否存在，始终清理同 DbId 下的所有分区条目（含 DB 不在回收站的情形）
    List<Long> partitionIdToErase = Lists.newArrayList();
    for (Map.Entry<Long, RecyclePartitionInfo> e : idToPartition.entrySet()) {
        if (e.getValue().getDbId() == dbId) partitionIdToErase.add(e.getKey());
    }
    for (Long partitionId : partitionIdToErase) erasePartitionInstantly(partitionId);

    // 4. 延迟报错：三者均为空，说明该 DbId 在回收站中完全没有记录
    if (dbInfo == null && tableIdToErase.isEmpty() && partitionIdToErase.isEmpty()) {
        throw new DdlException("Unknown database id '" + dbId + "'");
    }
}
```

`eraseTableInstantly` 采用完全对称的模式：Table 条目不存在时不报错，仍扫描并清理同 `tableId` 下所有属于该表的分区条目（包括 Table 本身不在回收站的情形）；只有 Table 和分区均未找到时才报错。

> `erasePartitionInstantly` 无需改动——分区是叶节点，没有下级需要级联，原有"找不到就报错"的逻辑完全正确。

---

## 测试

### 回归测试

在原有回归测试基础上补充两个"按 ID 清除但顶层对象不在回收站"的场景：

```groovy title="test_drop_catalog_recycle_bin.groovy — 新增场景"
// 场景 A：Table 不在回收站，但其下分区在
//（先 DROP PARTITION，不 DROP TABLE）
sql "ALTER TABLE tb1 DROP PARTITION p111;"
pre_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() > 0)     // 确认分区在回收站

// 用 TableId 清除（Table 本身不在回收站）
sql "DROP CATALOG RECYCLE BIN WHERE 'TableId' = ${table_id};"
cur_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)  // 分区被清除 ✓

// 场景 B：DB 不在回收站，但其下分区在
pre_db_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "test_db" """
assertTrue(pre_db_res.size() == 0)    // 确认 DB 不在回收站
pre_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() > 0)     // 确认分区在回收站

// 用 DbId 清除（DB 本身不在回收站）
sql "DROP CATALOG RECYCLE BIN WHERE 'DbId' = ${db_id};"
cur_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)  // 分区被清除 ✓
```

---

## 意义与影响

| 场景 | PR #31893（旧） | PR #35750（新） |
| --- | --- | --- |
| DB / Table / Partition 均在回收站 | ✅ 正常清除 | ✅ 正常清除 |
| DB 不在回收站，但其下 Table / Partition 在 | ❌ 报错，子条目遗留 | ✅ 清除所有关联条目 |
| Table 不在回收站，但其下 Partition 在 | ❌ 报错，子条目遗留 | ✅ 清除所有关联条目 |
| DbId / TableId 在回收站中无任何记录 | ❌ 报错 | ❌ 报错（行为不变） |

将错误检查从"入口前置"改为"出口兜底"，用最小改动（2 文件，+69 行）完成语义升级：命令从"必须精确匹配顶层条目"变为"清除所有与该 ID 关联的回收站记录"。
