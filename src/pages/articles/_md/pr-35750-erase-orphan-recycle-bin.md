---
title: "修复 DROP CATALOG RECYCLE BIN 无法清理孤立条目的缺陷"
source:
  project: "Doris"
  type: "PR"
  id: "35750"
  url: "https://github.com/apache/doris/pull/35750"
date: "2026-07-01"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Java"]
description: "将 eraseDatabaseInstantly / eraseTableInstantly 从早失败改为延迟报错，确保 DbId/TableId 对应的孤立表和分区能被一并清除。"
readingTime: "6 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#35750](https://github.com/apache/doris/pull/35750) · **Issue** [#35748](https://github.com/apache/doris/issues/35748) · **合并分支** 3.0.0 · **变更行数** +69 行 · **合并时间** 2024-06-02

---

## 问题背景

PR [#31893](https://github.com/apache/doris/pull/31893) 为 `DROP CATALOG RECYCLE BIN` 命令奠定了基础，但其实现中存在一个隐蔽的场景遗漏。

`CatalogRecycleBin` 的三张 Map 相互独立：

```text title="回收站三张 Map 的独立生命周期"
idToDatabase   → { DbId: RecycleDatabaseInfo }
idToTable      → { TableId: RecycleTableInfo }    含 DbId 字段
idToPartition  → { PartitionId: RecyclePartitionInfo }  含 DbId / TableId 字段
```

当用户执行 `ALTER TABLE t DROP PARTITION p` 后，只有分区条目进入 `idToPartition`；DB 条目并不一定在 `idToDatabase` 中。以下场景可以复现问题：

```sql title="触发问题的操作序列"
-- 只 DROP PARTITION，DB 和 Table 并未进入回收站
ALTER TABLE t DROP PARTITION p30;

-- 回收站此时只有分区条目
SHOW CATALOG RECYCLE BIN;
-- | Partition | p30 | DbId=12056 | TableId=12258 | PartitionId=12257 |

-- 尝试按 DbId 清除 —— 旧行为直接报错
DROP CATALOG RECYCLE BIN WHERE 'DbId' = 12056;
-- ERROR: Unknown database id '12056'
-- 结果：p30 依然留在回收站，无法被清除
```

原因在于 PR #31893 的实现采用了**早失败（fail-fast）**模式：一旦 `idToDatabase.get(dbId)` 返回 `null`，立即抛出异常，后续对 `idToTable` 和 `idToPartition` 的级联清理代码根本不会执行。

---

## 根因：早失败的错误位置

回顾 PR #31893 中 `eraseDatabaseInstantly` 的原始逻辑：

```java title="CatalogRecycleBin.java — 旧实现（早失败）"
public synchronized void eraseDatabaseInstantly(long dbId) throws DdlException {
    // ❌ 在入口处检查 DB 是否存在，不存在就直接抛出
    RecycleDatabaseInfo dbInfo = idToDatabase.get(dbId);
    if (dbInfo == null) {
        throw new DdlException("Unknown database id '" + dbId + "'");
    }

    // 以下代码在 DB 不存在时永远不会执行
    Env.getCurrentEnv().eraseDatabase(dbId, true);
    idToDatabase.remove(dbId);
    idToRecycleTime.remove(dbId);
    // ... 清理 tables 和 partitions
}
```

`eraseTableInstantly` 存在完全一致的问题：若 `idToTable.get(tableId)` 为 `null`，同样提前抛出，遗留的孤立分区无法被清除。

---

## 修复策略：延迟报错

PR #35750 将校验时机从**入口**移到**出口**：先尝试清理所有相关条目，最后再判断是否真的什么都没找到。

```text title="控制流对比"
旧逻辑（早失败）              新逻辑（延迟报错）
─────────────────────        ─────────────────────
get(dbId) → null?            get(dbId) → null?
     │ yes                        │ yes
     ▼                            ▼
 throw Error              （跳过 DB 擦除，继续向下）
                                  │
                                  ▼
                          清理同 DbId 的所有 Tables
                                  │
                                  ▼
                          清理同 DbId 的所有 Partitions
                                  │
                                  ▼
                          全部为空？→ throw Error
                          否则成功返回
```

这一改动使命令的语义从"必须精确匹配 DB 条目"升级为"清除所有与该 DbId 相关的回收站记录"。

---

## 代码实现

### eraseDatabaseInstantly

```java title="CatalogRecycleBin.java — eraseDatabaseInstantly（修复后）"
public synchronized void eraseDatabaseInstantly(long dbId) throws DdlException {
    // 1. 若 DB 条目存在则擦除，不存在则跳过（不再提前报错）
    RecycleDatabaseInfo dbInfo = idToDatabase.get(dbId);
    if (dbInfo != null) {
        Env.getCurrentEnv().eraseDatabase(dbId, true);
        idToDatabase.remove(dbId);
        idToRecycleTime.remove(dbId);
        LOG.info("erase db[{}]: {}", dbId, dbInfo.getDb().getName());
    }

    // 2. 始终清理同 DbId 下的所有孤立 Table 条目
    List<Long> tableIdToErase = Lists.newArrayList();
    Iterator<Map.Entry<Long, RecycleTableInfo>> tableIterator = idToTable.entrySet().iterator();
    while (tableIterator.hasNext()) {
        Map.Entry<Long, RecycleTableInfo> entry = tableIterator.next();
        if (entry.getValue().getDbId() == dbId) {
            tableIdToErase.add(entry.getKey());
        }
    }
    for (Long tableId : tableIdToErase) {
        eraseTableInstantly(tableId);
    }

    // 3. 始终清理同 DbId 下的所有孤立 Partition 条目
    List<Long> partitionIdToErase = Lists.newArrayList();
    Iterator<Map.Entry<Long, RecyclePartitionInfo>> partitionIterator =
            idToPartition.entrySet().iterator();
    while (partitionIterator.hasNext()) {
        Map.Entry<Long, RecyclePartitionInfo> entry = partitionIterator.next();
        if (entry.getValue().getDbId() == dbId) {
            partitionIdToErase.add(entry.getKey());
        }
    }
    for (Long partitionId : partitionIdToErase) {
        erasePartitionInstantly(partitionId);
    }

    // 4. 延迟报错：三者均为空才说明真的找不到
    if (dbInfo == null && tableIdToErase.isEmpty() && partitionIdToErase.isEmpty()) {
        throw new DdlException("Unknown database id '" + dbId + "'");
    }
}
```

### eraseTableInstantly

`eraseTableInstantly` 采用完全对称的修复模式：

```java title="CatalogRecycleBin.java — eraseTableInstantly（修复后，关键差异）"
public synchronized void eraseTableInstantly(long tableId) throws DdlException {
    // 1. 若 Table 条目存在则擦除，否则跳过
    RecycleTableInfo tableInfo = idToTable.get(tableId);
    if (tableInfo != null) {
        // ... 擦除 OLAP/MV 表、从 Map 中移除、写 EditLog
    }

    // 2. 始终清理同 tableId 下的所有孤立 Partition 条目
    List<Long> partitionIdToErase = ...;
    for (Long partitionId : partitionIdToErase) {
        erasePartitionInstantly(partitionId);
    }

    // 3. 延迟报错：Table 和 Partition 均未找到才报错
    if (tableInfo == null && partitionIdToErase.isEmpty()) {
        throw new DdlException("Unknown table id '" + tableId + "'");
    }
}
```

> `erasePartitionInstantly` 无需改动——分区是叶节点，没有下级需要级联清理，原有的"找不到就报错"逻辑依然正确。

---

## 回归测试：新增两个场景

PR #35750 在原有测试套件中补充了两个**"目标不在回收站但其子条目在"**的覆盖场景：

```groovy title="test_drop_catalog_recycle_bin.groovy — 新增测试场景"
// 场景 A：Table 不在回收站，但其孤立 Partition 在
sql "ALTER TABLE tb1 DROP PARTITION p111;"
pre_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() > 0)

// 用 TableId 执行清除（Table 本身不在回收站）
table_id = pre_res[0][3]
sql "DROP CATALOG RECYCLE BIN WHERE 'TableId' = ${table_id};"

// 验证孤立分区被成功清除
cur_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)

// 场景 B：DB 不在回收站，但其孤立 Partition 在
sql "ALTER TABLE tb2 DROP PARTITION p111;"
pre_db_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "test_db" """
assertTrue(pre_db_res.size() == 0)  // DB 确认不在回收站
pre_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() > 0)

// 用 DbId 执行清除（DB 本身不在回收站）
db_id = pre_res[0][2]
sql "DROP CATALOG RECYCLE BIN WHERE 'DbId' = ${db_id};"

// 验证孤立分区被成功清除
cur_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)
```

---

## 效果对比

| 场景 | PR #31893（旧） | PR #35750（新） |
| --- | --- | --- |
| DB 在回收站，子条目也在 | ✅ 正常清除 | ✅ 正常清除 |
| DB **不在**回收站，子 Table/Partition 在 | ❌ 报错，子条目遗留 | ✅ 清除所有子条目 |
| Table **不在**回收站，子 Partition 在 | ❌ 报错，子条目遗留 | ✅ 清除所有子条目 |
| DB / Table / Partition 均不存在 | ❌ 报错 | ❌ 报错（行为不变） |

这次修复让 `DROP CATALOG RECYCLE BIN` 真正做到了"按 ID 清除所有关联记录"，而不仅仅是"必须精确匹配顶层条目"。
