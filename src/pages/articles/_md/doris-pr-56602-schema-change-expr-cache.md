---
title: "Schema Change 表达式缓存串用：一个被列名掩盖的跨索引 Bug"
source:
  project: "Doris"
  type: "PR"
  id: "56602"
  url: "https://github.com/apache/doris/pull/56602"
  prType: "fix"
date: "2026-07-21"
category: [Database, Apache Doris, Internals]
tags: ["Schema Change", "Rollup", "Doris", "Bug Fix"]
description: "Doris 在 Schema Change / Rollup 下发任务时用一个共享 objectPool 缓存表达式，列名相同但分属不同索引时会串用，导致 BE 侧 schema 错误。"
readingTime: "9 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#56602](https://github.com/apache/doris/pull/56602) · **Issue** - · **commit** [8e53a731ec8](https://github.com/apache/doris/commit/8e53a731ec8) · **首发版本** 3.1.3 / 4.0.0 · **变更行数** +155 行 · **合并时间** 2025-09-30

---

## 背景

Doris 的 `ALTER TABLE` 中有一类操作需要 BE 把旧 schema 的数据「改写」成新 schema 的数据，典型场景是 **Schema Change**（改列类型、加列等）和 **Rollup**（建物化 rollup）。FE 侧由 `SchemaChangeJobV2` / `RollupJobV2` 驱动：等历史事务结束后，给每个受影响的 tablet 下发一个 `AlterReplicaTask`，BE 收到后扫描原始数据、按表达式转换、写入新的 shadow tablet。

下发任务时，FE 需要把「列类型转换表达式」序列化成 Thrift 结构（`TAlterMaterializedViewParam`，内含一个 `TExpr`）传给 BE。构造一次 `TExpr` 不便宜（要遍历 Expr 树、做 `ExprToThriftVisitor.treeToThrift`），而同一张表可能有大量分区、每个分区又有多个副本——对每个副本都重算一遍是浪费。于是历史上引入了一个 `objectPool`（一个 `ConcurrentHashMap<Object, Object>`）做缓存：把已经算好的 `TAlterMaterializedViewParam` 存进去，遇到同样的 key 就直接复用。

这个优化本身合理，但缓存的 **key 选错了**：它用**列名字符串**当 key。当一个 Schema Change job 同时改了多个索引里**同名**的列时，第一个索引算出的 `TAlterMaterializedViewParam` 会被后续索引直接命中复用——可它们分属不同的索引，表达式里引用的 slot 并不一样。结果是 BE 拿着一个指向「别的索引 slot 表」的表达式去改写数据，触发 schema 错误。

PR #56602 修的就是这个串用问题。

---

## 前置知识

### 任务下发的主循环

`SchemaChangeJobV2.runWaitingTxnJob()` 的核心结构（修复前）是一个三层循环：分区 → shadow index → tablet/replica。简化后如下：

```java title="SchemaChangeJobV2.java（修复前）"
tbl.readLock();
Map<Object, Object> objectPool = new ConcurrentHashMap<Object, Object>();
try {
    for (long partitionId : partitionIndexMap.rowKeySet()) {
        Partition partition = tbl.getPartition(partitionId);
        Map<Long, MaterializedIndex> shadowIndexMap = partitionIndexMap.row(partitionId);
        for (Map.Entry<Long, MaterializedIndex> entry : shadowIndexMap.entrySet()) {
            long shadowIdxId = entry.getKey();
            MaterializedIndex shadowIdx = entry.getValue();
            long originIdxId = indexIdMap.get(shadowIdxId);

            Map<String, Expr> defineExprs = Maps.newHashMap();
            List<Column> fullSchema = tbl.getSchemaByIndexId(originIdxId, true);
            DescriptorTable descTable = new DescriptorTable();
            TupleDescriptor destTupleDesc = descTable.createTupleDescriptor();
            for (Column column : fullSchema) {
                SlotDescriptor destSlotDesc = descTable.addSlotDescriptor(destTupleDesc);
                destSlotDesc.setColumn(column);
                // 仅当该列在新 schema 里类型发生变化时，才生成一个 cast 表达式
                if (indexColumnMap.containsKey(SchemaChangeHandler.SHADOW_NAME_PREFIX + column.getName())) {
                    Column newColumn = indexColumnMap.get(
                            SchemaChangeHandler.SHADOW_NAME_PREFIX + column.getName());
                    if (!Objects.equals(newColumn.getType(), column.getType())) {
                        SlotRef slot = new SlotRef(destSlotDesc);
                        slot.setCol(column.getName());
                        defineExprs.put(column.getName(), slot.castTo(newColumn.getType()));
                    }
                }
            }
            for (Tablet shadowTablet : shadowIdx.getTablets()) {
                for (Replica shadowReplica : shadowTablet.getReplicas()) {
                    AlterReplicaTask task = new AlterReplicaTask(...,
                            JobType.SCHEMA_CHANGE, defineExprs, descTable,
                            originSchemaColumns, objectPool, ...);
                    schemaChangeBatchTask.addTask(task);
                }
            }
        }
    }
}
```

几个关键点：

- **shadow index / origin index**：Schema Change 不会原地改，而是为每个要改的索引建一个 shadow index，数据从 origin index 转换写入 shadow index。`indexIdMap` 把 `shadowIdxId → originIdxId` 对应起来。
- **`defineExprs`**：一个 `Map<String, Expr>`，key 是列名，value 是把 origin 列转成新类型的 `Expr`（典型是 `SlotRef.castTo(newType)`）。只有类型真变了才会放进 map。
- **`descTable`**：每次循环新建一个 `DescriptorTable`，里面给每个列分配 `SlotDescriptor`，`SlotRef` 就指向这些 descriptor。
- **`objectPool`**：在循环**外面**只建一次，所有分区、所有 shadow index、所有副本共用。

### objectPool 到底缓存了什么

缓存的读写在 `AlterReplicaTask.toThrift()` 里，每个任务序列化时都会查一次：

```java title="AlterReplicaTask.java"
if (defineExprs != null) {
    for (Map.Entry<String, Expr> entry : defineExprs.entrySet()) {
        Object value = objectPool.get(entry.getKey());     // key = 列名字符串
        if (value == null) {
            TAlterMaterializedViewParam mvParam = new TAlterMaterializedViewParam(entry.getKey());
            mvParam.setMvExpr(ExprToThriftVisitor.treeToThrift(entry.getValue()));
            req.addToMaterializedViewParams(mvParam);
            objectPool.put(entry.getKey(), mvParam);        // 按列名缓存
        } else {
            TAlterMaterializedViewParam mvParam = (TAlterMaterializedViewParam) value;
            req.addToMaterializedViewParams(mvParam);       // 命中即复用
        }
    }
}
// ...
req.setDescTbl(DescriptorToThriftConverter.toThrift(descTable));
```

注意两件事被同时塞进同一个 `req`：一份是 `materializedViewParams`（可能来自缓存），一份是 `descTbl`（当次循环新建的 `descTable`，每次都是新鲜的）。

### TSlotRef 里藏了什么

`ExprToThriftVisitor` 序列化 `SlotRef` 时，写进去的是**数字形式的 slot id 和 tuple id**，而不是列名：

```java title="ExprToThriftVisitor.java"
public Void visitSlotRef(SlotRef expr, TExprNode msg) {
    msg.slot_ref = new TSlotRef(expr.getDesc().getId().asInt(),
                                expr.getDesc().getParentId().asInt());
}
```

而 slot id 由 `DescriptorTable` 自己的 `IdGenerator` 从 0 开始递增分配：

```java title="DescriptorTable.java"
private final IdGenerator<SlotId> slotIdGenerator = SlotId.createGenerator();

public SlotDescriptor addSlotDescriptor(TupleDescriptor d) {
    SlotDescriptor result = new SlotDescriptor(slotIdGenerator.getNextId(), d.getId());
```

```java title="IdGenerator.java"
protected int nextId = 0;
```

也就是说，**slot id 是「在某个 descTable 内的位置下标」**，不是全局唯一 ID。BE 拿到 `req` 后，只能拿 `TSlotRef.slot_id` 去对应的 `TDescriptorTable` 里查 slot 的含义。`mvParam` 和 `descTbl` 必须配对——同一个 `req` 里的两者必须来自同一次构造。

---

## 实现

### 根因：key 是列名，value 却是索引相关的

把上面三段拼起来，bug 的链条就清楚了：

1. 同一个 Schema Change job 里，多个 shadow index 都对同名列 `event_date` 做了类型转换（比如 `DATE → DATETIME`），于是每个 shadow index 的 `defineExprs` 里都有一个 key 为 `"event_date"` 的条目。
2. `objectPool` 跨所有 shadow index 共享。第一个被处理的索引会把 `"event_date" → mvParam_A` 存进去，`mvParam_A` 内部的 `TSlotRef` 指向索引 A 的 `descTable_A` 的某个 slot id。
3. 轮到第二个索引时，`defineExprs` 里同样有 `"event_date"`，`objectPool.get("event_date")` **命中**，直接复用 `mvParam_A`——但它被塞进了携带 `descTable_B` 的 `req`。
4. BE 收到后用 `mvParam_A` 里的 `slot_id` 去 `descTable_B` 里查 slot，查到的是**完全不同的列**（或越界），触发 schema 错误。

关键矛盾在于：缓存的 **key（列名）在不同索引间是重复的**，但缓存的 **value（thrift 化的 Expr）是和某个具体索引的 descTable 绑定的**。用列名当 key，等于假设「同名列在所有索引里的表达式都一样」——这个假设不成立。

### 为什么「按索引隔离」就够了

修复没有去改 key 的语义，而是**把 objectPool 的作用域从「整个 job」缩小到「单个 MaterializedIndex」**：每个 shadow index 拥有自己的 `objectPool`，索引之间不再共享。

```java title="SchemaChangeJobV2.java（修复后）"
tbl.readLock();
try {
    Preconditions.checkState(tbl.getState() == OlapTableState.SCHEMA_CHANGE);
    // Create object pool per MaterializedIndex
    Map<Long, Map<Object, Object>> indexObjectPoolMap = Maps.newHashMap();
    for (long partitionId : partitionIndexMap.rowKeySet()) {
        // ...
        for (Map.Entry<Long, MaterializedIndex> entry : shadowIndexMap.entrySet()) {
            long shadowIdxId = entry.getKey();
            MaterializedIndex shadowIdx = entry.getValue();

            // Get or create object pool for this MaterializedIndex
            Map<Object, Object> objectPool = indexObjectPoolMap.get(shadowIdxId);
            if (objectPool == null) {
                objectPool = new ConcurrentHashMap<Object, Object>();
                indexObjectPoolMap.put(shadowIdxId, objectPool);
            }
            // ... 后续构造 defineExprs / descTable / 下发 task 不变
        }
    }
}
```

这里有一个值得追问的点：**为什么同一个 shadow index 跨多个分区共用 pool 是安全的？** 毕竟每次循环都会 `new DescriptorTable()`，slot id 看起来又只是「descTable 内的下标」。

答案在于 slot id 的分配方式：`DescriptorTable` 的 `IdGenerator` 从 0 开始递增，而同一个 shadow index 在所有分区里用的 `fullSchema = tbl.getSchemaByIndexId(originIdxId, true)` 是**同一份**（`originIdxId` 固定）。列的集合和顺序一致，`addSlotDescriptor` 按相同顺序分配，于是不同分区构造出的 `descTable` 对同一列分配到**相同的 slot id**。cached 的 `TSlotRef(slot_id=K)` 在该索引的任何一个分区的 `descTable` 里都恰好指向同一列。

换句话说：

| 比较维度 | slot id 是否一致 | 能否共享 pool |
| --- | --- | --- |
| 同一 shadow index、不同分区 | 一致（同 `originIdxId` → 同 schema → 同下标） | ✅ 安全 |
| 不同 shadow index | 不一致（不同 `originIdxId` → 不同 schema → 同下标指向不同列） | ❌ 串用 |

所以「按 `shadowIdxId` 隔离」恰好划出了 slot id 语义一致的边界——既修掉了跨索引串用，又保留了跨分区/副本的缓存收益。这是一个最小且正确的切分。

### 两处对称改动

同样的模式也存在于 `RollupJobV2.runWaitingTxnJob()`，PR 对它做了对称修复：

```java title="RollupJobV2.java（修复后）"
Preconditions.checkState(tbl.getState() == OlapTableState.ROLLUP);
// Create object pool per MaterializedIndex
Map<Long, Map<Object, Object>> indexObjectPoolMap = Maps.newHashMap();
for (Map.Entry<Long, MaterializedIndex> entry : this.partitionIdToRollupIndex.entrySet()) {
    // ...
    MaterializedIndex rollupIndex = entry.getValue();

    // Get or create object pool for this MaterializedIndex
    Map<Object, Object> objectPool = indexObjectPoolMap.get(rollupIndex.getId());
    if (objectPool == null) {
        objectPool = new ConcurrentHashMap<Object, Object>();
        indexObjectPoolMap.put(rollupIndex.getId(), objectPool);
    }
    // ...
}
```

两处改动加起来只有 +18 / -2 行核心逻辑，剩下的 136 行是回归测试。

`RollupJobV2` 里 `descTable` 是按 tablet 新建的，但只要同一个 rollup index 的 schema 不变，slot id 布局就不变，因此按 `rollupIndex.getId()` 隔离同样成立。Schema Change 是确认的触发路径（`MODIFY COLUMN` 改类型会生成 cast 表达式），Rollup 这边属于同源模式的一致性修复。

---

## 测试

### 回归测试

新增 `regression-test/suites/schema_change_p0/test_alter_rollup_table.groovy`，专门构造触发条件：一张列很多的表，先加两个 rollup，再对同名列做类型修改。

```groovy title="test_alter_rollup_table.groovy"
sql """
    ALTER TABLE ${tbName}
    ADD ROLLUP r_event_user (event_date, event_time, user_id, country, city, age, balance);
"""
sleep(10000)

sql """
    ALTER TABLE ${tbName}
    ADD ROLLUP r_complex (event_date, event_time, user_id, ipv6_addr, last_ip,
                          json_data, create_time, update_time);
"""
sleep(10000)

// 关键：对同时出现在 base 和两个 rollup 里的 event_date 做类型修改
sql """
    ALTER TABLE ${tbName} MODIFY COLUMN event_date DATETIME
"""

sql """
    insert into ${tbName}
    (user_id, event_date, event_time, country, city, age, is_active,
     balance, score, last_ip, json_data, seq_col)
    values ...;
"""
```

`event_date` 原本是 `date`，同时出现在 base 表、`r_event_user`、`r_complex` 三处。`MODIFY COLUMN event_date DATETIME` 会让这三个索引各自生成一份 `defineExprs["event_date"] = cast(date→datetime)`——正好命中「同名列、跨索引」的场景。修复前，第二个索引会复用第一个索引的 `mvParam`，导致后续 insert 在 BE 侧报 schema 错误；修复后路径正常完成。

测试没有显式断言错误码，而是靠「整条 DDL + insert 链路在修复前会失败、修复后能跑通」来回归——这是 Doris schema_change_p0 套件的常见写法。

---

## 意义与影响

这个 bug 的危害在于它的**隐蔽性**：

- **触发条件窄但真实**：需要一次 Schema Change 同时触及多个包含同名列的索引。单索引改类型、或多个索引改不同列名的场景都不会触发，所以能长期潜伏。日常最容易踩中的就是「表上有多个 rollup / 物化视图，然后对某个公共列做 `MODIFY COLUMN` 改类型」。
- **现象指向错误的方向**：报错出现在 BE 侧的数据改写阶段，表现为 schema 不匹配，很容易让人去查 BE 的 schema 处理逻辑，而不是 FE 的缓存共享问题。
- **修复点小而准**：没有重构整个序列化路径，也没有放弃缓存（缓存对大分区表的任务下发确实有意义），只是把缓存的作用域对齐到了 slot id 语义一致的边界——`MaterializedIndex`。

从更通用的角度看，这是一个经典的「**缓存 key 的粒度小于 value 的有效域**」问题：value 依赖于「索引 + descTable 布局」，key 却只取了「列名」。只要存在两个 value 不同但 key 相同的条目，缓存就会静默地返回错误结果。这类 bug 在任何按「业务名」做 key、而 value 实际依赖更多上下文的缓存里都可能复现。

首发版本回填到 3.1.3 与 4.0.0 两条线，说明社区认定这是一个值得回填的稳定性修复。在升级到这两个版本后，带 rollup / 物化视图的表做列类型变更会更可靠。

---

## 参考

- Doris Schema ChangeHandler / Rollup 任务下发：`fe/fe-core/src/main/java/org/apache/doris/alter/SchemaChangeJobV2.java`、`RollupJobV2.java`
- 任务序列化与缓存：`fe/fe-core/src/main/java/org/apache/doris/task/AlterReplicaTask.java`
- SlotRef 的 Thrift 序列化：`fe/fe-core/src/main/java/org/apache/doris/analysis/ExprToThriftVisitor.java`
- Slot id 分配语义：`fe/fe-core/src/main/java/org/apache/doris/analysis/DescriptorTable.java`、`fe/fe-common/src/main/java/org/apache/doris/common/IdGenerator.java`
