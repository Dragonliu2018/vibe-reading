---
title: "支持主动清理 Catalog 回收站"
source:
  project: "Doris"
  type: "PR"
  id: "31893"
  url: "https://github.com/apache/doris/pull/31893"
date: "2026-07-01"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Java", "Recycle Bin", "DDL", "Nereids"]
description: "新增 DROP CATALOG RECYCLE BIN 命令，支持按 DbId/TableId/PartitionId 立即清除回收站条目，无需等待后台定时任务。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#31893](https://github.com/apache/doris/pull/31893) · **Issue** [#31348](https://github.com/apache/doris/issues/31348) · **合并分支** 3.0.0 · **变更行数** +345 行 · **合并时间** 2024-05-30

---

## 背景：CatalogRecycleBin 的工作方式

`CatalogRecycleBin` 继承自 `MasterDaemon`，是一个只在 FE Master 节点运行的后台服务。`DROP DATABASE / TABLE / PARTITION` 执行后，对象不会立即物理删除，而是连同时间戳写入内存 Map，等后台线程扫描超过保留时长（默认 1 天）后才真正擦除。其核心数据结构：

```java title="CatalogRecycleBin.java — 核心数据结构"
public class CatalogRecycleBin extends MasterDaemon implements Writable {
    private Map<Long, RecycleDatabaseInfo>  idToDatabase;  // dbId  → DB 信息
    private Map<Long, RecycleTableInfo>     idToTable;     // tableId → 表信息
    private Map<Long, RecyclePartitionInfo> idToPartition; // partitionId → 分区信息

    private Map<Long, Long> idToRecycleTime; // id → 进入回收站的时间戳
}
```

用户可以通过 `SHOW CATALOG RECYCLE BIN` 查询当前回收站内容，结果列为 `Type | DbName | DbId | TableId | PartitionId | Name | ...`：

```sql title="查询回收站示例"
SHOW CATALOG RECYCLE BIN WHERE NAME = "my_table";
```

**问题在于**：PR #31893 之前，没有任何 SQL 命令能主动触发清除——即便管理员明确知道某个 DbId，也只能修改保留时长配置或干等。

---

## 新增命令语法

PR #31893 新增了 `DROP CATALOG RECYCLE BIN` 命令，支持按三种粒度立即清除：

```sql title="DROP CATALOG RECYCLE BIN 用法"
-- 按 DB ID 清除（同时级联清除该 DB 下所有表和分区）
DROP CATALOG RECYCLE BIN WHERE 'DbId' = 12345;

-- 按 Table ID 清除（同时级联清除该表的所有分区）
DROP CATALOG RECYCLE BIN WHERE 'TableId' = 67890;

-- 按 Partition ID 清除（只清除该分区）
DROP CATALOG RECYCLE BIN WHERE 'PartitionId' = 11111;
```

`idType` 合法值为 `'DbId'`、`'TableId'`、`'PartitionId'`（不区分大小写），`id` 为整型。

---

## 实现路径解析

整个实现沿着 Nereids 命令框架的标准路径展开，从语法定义到执行共经过 5 层。

### 第一层：语法文法（DorisParser.g4）

在 `statementBase` 产生式中新增一条规则：

```antlr4 title="DorisParser.g4 — 新增产生式"
statementBase
    | DROP CATALOG RECYCLE BIN WHERE idType=STRING_LITERAL EQ id=INTEGER_VALUE
        #dropCatalogRecycleBin
    | unsupportedStatement
        #unsupported
    ;
```

- `STRING_LITERAL`：捕获带引号的 `'DbId'` / `'TableId'` / `'PartitionId'`
- `INTEGER_VALUE`：捕获目标 ID 的数值
- `#dropCatalogRecycleBin`：为该产生式命名，ANTLR 自动生成对应的 `DropCatalogRecycleBinContext` 类和 `visitDropCatalogRecycleBin` 回调

### 第二层：AST 节点（DropCatalogRecycleBinCommand.java）

新增命令类，实现 Nereids 命令框架的 `Command` 接口，同时标记为 `ForwardWithSync`（表示该命令需要转发给 FE Master 同步执行）：

```java title="DropCatalogRecycleBinCommand.java"
public class DropCatalogRecycleBinCommand extends Command implements ForwardWithSync {

    public enum IdType {
        DATABASE_ID,
        TABLE_ID,
        PARTITION_ID;

        public static IdType fromString(String idTypeStr) {
            if (idTypeStr.equalsIgnoreCase("DbId"))        return DATABASE_ID;
            if (idTypeStr.equalsIgnoreCase("TableId"))     return TABLE_ID;
            if (idTypeStr.equalsIgnoreCase("PartitionId")) return PARTITION_ID;
            throw new AnalysisException(
                "DROP CATALOG RECYCLE BIN: " + idTypeStr
                + " should be 'DbId', 'TableId' or 'PartitionId'.");
        }
    }

    private final IdType idType;
    private long id = -1;

    @Override
    public void run(ConnectContext ctx, StmtExecutor executor) throws Exception {
        Env.getCurrentEnv().dropCatalogRecycleBin(idType, id);
    }
}
```

`IdType.fromString()` 在解析阶段就完成合法性校验，非法 `idType` 字符串立即抛出 `AnalysisException`，不会传递到执行层。

### 第三层：访问者注册（LogicalPlanBuilder + CommandVisitor）

`LogicalPlanBuilder.visitDropCatalogRecycleBin` 将语法树节点转换为命令对象：

```java title="LogicalPlanBuilder.java — visitDropCatalogRecycleBin"
@Override
public LogicalPlan visitDropCatalogRecycleBin(DropCatalogRecycleBinContext ctx) {
    // 去掉引号：'DbId' → DbId
    String idTypeStr = ctx.idType.getText().substring(1, ctx.idType.getText().length() - 1);
    IdType idType = IdType.fromString(idTypeStr);
    long id = Long.parseLong(ctx.id.getText());
    return ParserUtils.withOrigin(ctx, () -> new DropCatalogRecycleBinCommand(idType, id));
}
```

`CommandVisitor` 接口新增默认方法，完成 Visitor 模式的闭环注册：

```java title="CommandVisitor.java — 新增默认方法"
default R visitDropCatalogRecycleBinCommand(
        DropCatalogRecycleBinCommand cmd, C context) {
    return visitCommand(cmd, context);
}
```

### 第四层：路由层（Env → InternalCatalog）

`Env.dropCatalogRecycleBin` 作为门面转发给 `InternalCatalog`，后者按 `idType` 分发：

```java title="InternalCatalog.java — dropCatalogRecycleBin"
public void dropCatalogRecycleBin(IdType idType, long id) throws DdlException {
    switch (idType) {
        case DATABASE_ID:
            Env.getCurrentRecycleBin().eraseDatabaseInstantly(id);
            break;
        case TABLE_ID:
            Env.getCurrentRecycleBin().eraseTableInstantly(id);
            break;
        case PARTITION_ID:
            Env.getCurrentRecycleBin().erasePartitionInstantly(id);
            break;
        default:
            throw new DdlException(
                "DROP CATALOG RECYCLE BIN: idType should be 'DbId', 'TableId' or 'PartitionId'.");
    }
}
```

### 第五层：核心执行（CatalogRecycleBin 三个 Instantly 方法）

这一层是真正的"物理删除"，PR 在 `CatalogRecycleBin` 中新增了三个 `synchronized` 方法。

#### `erasePartitionInstantly`（基础单元）

```java title="CatalogRecycleBin.java — erasePartitionInstantly"
public synchronized void erasePartitionInstantly(long partitionId) throws DdlException {
    // 1. 查找，不存在即报错
    RecyclePartitionInfo partitionInfo = idToPartition.get(partitionId);
    if (partitionInfo == null) {
        throw new DdlException("No partition id '" + partitionId + "'");
    }
    // 2. 物理擦除（清理 tablet 数据、BE 侧存储）
    Partition partition = partitionInfo.getPartition();
    Env.getCurrentEnv().onErasePartition(partition);
    // 3. 从回收站 Map 中移除
    idToPartition.remove(partitionId);
    idToRecycleTime.remove(partitionId);
    // 4. 记录 EditLog + 打印日志
    Env.getCurrentEnv().getEditLog().logErasePartition(partitionId);
    LOG.info("erase table[{}]'s partition[{}]: {}", tableId, partitionId, partitionName);
}
```

#### `eraseTableInstantly`（级联分区）

表的擦除先处理自身，再扫描 `idToPartition` 找出所有属于该表的分区逐一调用 `erasePartitionInstantly`：

```java title="CatalogRecycleBin.java — eraseTableInstantly"
public synchronized void eraseTableInstantly(long tableId) throws DdlException {
    RecycleTableInfo tableInfo = idToTable.get(tableId);
    if (tableInfo == null) throw new DdlException("Unknown table id '" + tableId + "'");

    // 物理擦除 OLAP/MV 表（清理底层 tablet）
    Table table = tableInfo.getTable();
    if (table.getType() == TableType.OLAP || table.getType() == TableType.MATERIALIZED_VIEW) {
        Env.getCurrentEnv().onEraseOlapTable((OlapTable) table, false);
    }
    idToTable.remove(tableId);
    idToRecycleTime.remove(tableId);
    Env.getCurrentEnv().getEditLog().logEraseTable(tableId);

    // 级联删除：同 tableId 下的所有分区
    List<Long> partitionIdToErase = idToPartition.entrySet().stream()
        .filter(e -> e.getValue().getTableId() == tableId)
        .map(Map.Entry::getKey)
        .collect(toList());
    for (Long partitionId : partitionIdToErase) {
        erasePartitionInstantly(partitionId);
    }
}
```

#### `eraseDatabaseInstantly`（双层级联）

库的擦除最为彻底——先擦库本身，再级联擦除所有属于该 DB 的表（表又会继续级联擦除其分区），最后再扫一遍清理直接挂在该 DB 下的孤立分区：

```java title="CatalogRecycleBin.java — eraseDatabaseInstantly"
public synchronized void eraseDatabaseInstantly(long dbId) throws DdlException {
    RecycleDatabaseInfo dbInfo = idToDatabase.get(dbId);
    if (dbInfo == null) throw new DdlException("Unknown database id '" + dbId + "'");

    // 擦除 DB 本体
    Env.getCurrentEnv().eraseDatabase(dbId, true);
    idToDatabase.remove(dbId);
    idToRecycleTime.remove(dbId);

    // 级联擦除：该 DB 下所有表（表内部再级联分区）
    List<Long> tableIdToErase = idToTable.entrySet().stream()
        .filter(e -> e.getValue().getDbId() == dbId)
        .map(Map.Entry::getKey)
        .collect(toList());
    for (Long tableId : tableIdToErase) {
        eraseTableInstantly(tableId);
    }

    // 级联擦除：直接挂在该 DB 下的孤立分区（先于 DB 被 DROP 的分区）
    List<Long> partitionIdToErase = idToPartition.entrySet().stream()
        .filter(e -> e.getValue().getDbId() == dbId)
        .map(Map.Entry::getKey)
        .collect(toList());
    for (Long partitionId : partitionIdToErase) {
        erasePartitionInstantly(partitionId);
    }
}
```

---

## 级联删除语义

三个粒度的级联行为汇总：

| 命令 | 直接删除 | 级联删除 |
| --- | --- | --- |
| `DROP ... WHERE 'DbId' = X` | 该 DB | 该 DB 下的所有 Table + 所有 Partition |
| `DROP ... WHERE 'TableId' = X` | 该 Table | 该 Table 下的所有 Partition |
| `DROP ... WHERE 'PartitionId' = X` | 该 Partition | 无 |

> **注意**：`eraseDatabaseInstantly` 在清完库内所有表之后，还会再扫一遍 `idToPartition`，清理"直接挂在该 DB 下的孤立分区"——即先于数据库被单独 DROP 的分区，避免遗漏。

---

## 回归测试

PR 在 `regression-test/suites/catalog_recycle_bin_p0/` 下新增了完整的 Groovy 测试套件，覆盖三个粒度的场景：

```groovy title="test_drop_catalog_recycle_bin.groovy"
// 1. DROP PARTITION → 按 PartitionId 立即清除
sql "ALTER TABLE tb1 DROP PARTITION p1000;"
pre_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p1000" """
partition_id = pre_res[0][4]
sql "DROP CATALOG RECYCLE BIN WHERE 'PartitionId' = ${partition_id};"
cur_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p1000" """
assertTrue(pre_res.size() - cur_res.size() == 1)   // 确认减少 1 条

// 2. DROP TABLE → 按 TableId 清除，同时验证分区级联消失
sql "DROP TABLE tb1;"
pre_tb_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "tb1" """
table_id = pre_tb_res[0][3]
sql "DROP CATALOG RECYCLE BIN WHERE 'TableId' = ${table_id};"
cur_tb_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "tb1" """
assertTrue(pre_tb_res.size() - cur_tb_res.size() == 1)
cur_pt_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p111" """
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)  // 分区也消失

// 3. DROP DATABASE → 按 DbId 清除，三层全验证
sql "DROP DATABASE test_db;"
db_id = pre_db_res[0][2]
sql "DROP CATALOG RECYCLE BIN WHERE 'DbId' = ${db_id};"
// DB 消失、Table 消失、Partition 消失
```

测试逻辑遵循"操作前后 size 差值"断言模式，而非全量比较，避免并发测试环境中其他条目干扰结果。

---

## 调用链总结

```text title="TableId 清除的完整调用链"
SQL: DROP CATALOG RECYCLE BIN WHERE 'TableId' = 123
  ↓ DorisParser.g4（ANTLR 语法规则）
  ↓ LogicalPlanBuilder.visitDropCatalogRecycleBin()
      去掉引号、解析 IdType、构造命令对象
  ↓ DropCatalogRecycleBinCommand.run()
  ↓ Env.dropCatalogRecycleBin(TABLE_ID, 123)
  ↓ InternalCatalog.dropCatalogRecycleBin()  — switch(idType)
  ↓ CatalogRecycleBin.eraseTableInstantly(123)
      物理擦除 Table → 级联 erasePartitionInstantly(各分区)
      写 EditLog → 打印日志
```

---

## 效果与影响

| 对比维度 | PR 前 | PR 后 |
| --- | --- | --- |
| 立即清除 | 不支持，只能等后台任务 | `DROP CATALOG RECYCLE BIN WHERE ...` |
| 清除粒度 | — | DB / Table / Partition 三级 |
| 级联行为 | — | 删 DB 自动清表和分区，删表自动清分区 |
| ID 获取方式 | — | `SHOW CATALOG RECYCLE BIN WHERE NAME = "..."` 查询结果 |

对于 DBA 来说，这个命令在以下场景特别实用：

- **紧急释放存储**：某个误删的大表占用大量空间，不能等 1 天保留期
- **ID 复用场景**：需要回收特定 ID 以避免与新创建对象冲突
- **测试/开发环境**：频繁建删操作导致回收站条目堆积，需要快速清理
