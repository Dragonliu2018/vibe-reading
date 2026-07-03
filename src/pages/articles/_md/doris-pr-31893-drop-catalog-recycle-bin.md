---
title: "支持主动清理 Catalog 回收站"
source:
  project: "Doris"
  type: "PR"
  id: "31893"
  url: "https://github.com/apache/doris/pull/31893"
  prType: "feat"
date: "2026-07-01"
category: [Database, Apache Doris, Contributions]
tags: ["Apache Doris", "Java", "DDL", "Nereids"]
description: "新增 DROP CATALOG RECYCLE BIN 命令，支持按 DbId/TableId/PartitionId 立即清除回收站条目，无需等待后台定时任务。"
readingTime: "10 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#31893](https://github.com/apache/doris/pull/31893) · **Issue** [#31348](https://github.com/apache/doris/issues/31348) · **commit** [5c747be](https://github.com/apache/doris/commit/5c747be63468c35459b0b3b4977f17be906b4dc7) · **首发版本** 3.0.0 · **变更行数** +345 行 · **合并时间** 2024-05-30

---

## 背景

执行 `DROP DATABASE / TABLE / PARTITION` 后，对象不会立即删除，而是进入 **Catalog 回收站**，由后台守护线程按保留时长（由 `catalog_trash_expire_second` 配置，默认 1 天）定期扫描清除。这个机制有效防止误删，但带来一个运维困境：

**管理员明确要立刻清除某个条目时，无路可走。** 不管是特定 ID 需要复用、还是测试环境堆积了大量垃圾条目，都只能修改超时配置或等待后台任务。

Issue [#31348](https://github.com/apache/doris/issues/31348) 由团队成员 **mymeiyi** 提出，建议新增按 ID 主动删除的命令，使 DBA 能精确控制回收站内容。由于回收站中名称可能重复（同名表可以被 DROP 多次），建议按内部 ID 而非名称进行操作。

---

## 前置知识

`CatalogRecycleBin` 继承自 `MasterDaemon`，只在 FE Master 节点运行。其核心是三张 `Long → Info` 的 Map，分别存储回收站中的数据库、表和分区信息，外加一张时间戳索引：

```java title="CatalogRecycleBin.java — 核心数据结构"
public class CatalogRecycleBin extends MasterDaemon implements Writable {
    private Map<Long, RecycleDatabaseInfo>  idToDatabase;   // dbId → DB 信息
    private Map<Long, RecycleTableInfo>     idToTable;      // tableId → 表信息
    private Map<Long, RecyclePartitionInfo> idToPartition;  // partitionId → 分区信息
    private Map<Long, Long>                 idToRecycleTime; // id → 进站时间戳
}
```

用户可通过 `SHOW CATALOG RECYCLE BIN WHERE NAME = "..."` 查询当前回收站内容，结果列包含 `DbId / TableId / PartitionId`——这些 ID 即为新命令的操作目标。

---

## 实现

整个实现沿 Nereids 命令框架的标准路径展开，9 个文件，+345 行。

### 语法层（DorisParser.g4）

在 `statementBase` 产生式末尾追加一条规则：

```antlr4 title="DorisParser.g4 — 新增产生式"
statementBase
    | DROP CATALOG RECYCLE BIN WHERE idType=STRING_LITERAL EQ id=INTEGER_VALUE
        #dropCatalogRecycleBin
    ;
```

`STRING_LITERAL` 捕获带引号的类型字符串（`'DbId'` / `'TableId'` / `'PartitionId'`），`INTEGER_VALUE` 捕获整型 ID，`#dropCatalogRecycleBin` 使 ANTLR 自动生成对应的 Context 类和 Visitor 回调。

### 命令对象（DropCatalogRecycleBinCommand.java）

新增命令类实现 `Command` 接口，同时标记为 `ForwardWithSync`——确保命令被转发给 FE Master 节点同步执行。内嵌枚举 `IdType` 在解析阶段完成合法性校验：

```java title="DropCatalogRecycleBinCommand.java"
public class DropCatalogRecycleBinCommand extends Command implements ForwardWithSync {

    public enum IdType {
        DATABASE_ID, TABLE_ID, PARTITION_ID;

        public static IdType fromString(String s) {
            if (s.equalsIgnoreCase("DbId"))        return DATABASE_ID;
            if (s.equalsIgnoreCase("TableId"))     return TABLE_ID;
            if (s.equalsIgnoreCase("PartitionId")) return PARTITION_ID;
            throw new AnalysisException(
                "DROP CATALOG RECYCLE BIN: " + s + " should be 'DbId', 'TableId' or 'PartitionId'.");
        }
    }

    private final IdType idType;
    private final long id;

    @Override
    public void run(ConnectContext ctx, StmtExecutor executor) throws Exception {
        Env.getCurrentEnv().dropCatalogRecycleBin(idType, id);
    }
}
```

### 解析层（LogicalPlanBuilder）

`visitDropCatalogRecycleBin` 去掉 `idType` 两端的引号后，交给 `IdType.fromString()` 解析——非法字符串在此抛出 `AnalysisException`，不会进入执行层：

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

### 路由层（Env → InternalCatalog）

`Env` 作为门面，将调用透传给 `InternalCatalog`，后者按 `idType` switch 分发到 `CatalogRecycleBin` 的三个新方法：

```java title="InternalCatalog.java — dropCatalogRecycleBin"
public void dropCatalogRecycleBin(IdType idType, long id) throws DdlException {
    switch (idType) {
        case DATABASE_ID:  Env.getCurrentRecycleBin().eraseDatabaseInstantly(id);  break;
        case TABLE_ID:     Env.getCurrentRecycleBin().eraseTableInstantly(id);     break;
        case PARTITION_ID: Env.getCurrentRecycleBin().erasePartitionInstantly(id); break;
        default: throw new DdlException("idType should be 'DbId', 'TableId' or 'PartitionId'.");
    }
}
```

### 执行层（CatalogRecycleBin）

PR 在 `CatalogRecycleBin` 中新增三个 `synchronized` 方法，物理擦除回收站条目并写 EditLog。三者之间存在**级联关系**：

```text title="三个方法的级联调用关系"
eraseDatabaseInstantly(dbId)
  ├─ eraseDatabase(dbId)           物理擦除 DB
  ├─ eraseTableInstantly(tableId)  ← 该 DB 下的所有 Table（递归）
  │    ├─ onEraseOlapTable(...)    物理擦除 OLAP/MV 表
  │    └─ erasePartitionInstantly  ← 该 Table 下的所有 Partition
  └─ erasePartitionInstantly(...)  ← 直接挂在该 DB 下的孤立 Partition
```

级联语义汇总：

| 命令 | 直接删除 | 级联删除 |
| --- | --- | --- |
| `'DbId' = X` | 该 DB | 该 DB 下所有 Table + 所有 Partition |
| `'TableId' = X` | 该 Table | 该 Table 下所有 Partition |
| `'PartitionId' = X` | 该 Partition | 无 |

---

## 测试

### 回归测试

在 `regression-test/suites/catalog_recycle_bin_p0/test_drop_catalog_recycle_bin.groovy` 中新增完整测试套件，覆盖三个粒度的清除场景。断言采用"操作前后 size 差值"模式，避免并发测试环境中其他条目干扰结果：

```groovy title="test_drop_catalog_recycle_bin.groovy — 三个粒度的核心断言"
// 1. PartitionId 清除
sql "ALTER TABLE tb1 DROP PARTITION p1000;"
pre_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p1000" """
partition_id = pre_res[0][4]
sql "DROP CATALOG RECYCLE BIN WHERE 'PartitionId' = ${partition_id};"
cur_res = sql """ SHOW CATALOG RECYCLE BIN WHERE NAME = "p1000" """
assertTrue(pre_res.size() - cur_res.size() == 1)    // p1000 消失

// 2. TableId 清除：验证分区也级联消失
sql "DROP TABLE tb1;"
table_id = pre_tb_res[0][3]
sql "DROP CATALOG RECYCLE BIN WHERE 'TableId' = ${table_id};"
assertTrue(pre_tb_res.size() - cur_tb_res.size() == 1)  // tb1 消失
assertTrue(pre_pt_res.size() - cur_pt_res.size() == 1)  // p111 也消失

// 3. DbId 清除：三层全验证（DB + Table + Partition 均消失）
sql "DROP DATABASE test_db;"
db_id = pre_db_res[0][2]
sql "DROP CATALOG RECYCLE BIN WHERE 'DbId' = ${db_id};"
// DB、Table、Partition 同步验证
```

---

## 意义与影响

| 对比维度 | PR 前 | PR 后 |
| --- | --- | --- |
| 立即清除 | 不支持，只能等后台任务 | `DROP CATALOG RECYCLE BIN WHERE ...` |
| 清除粒度 | — | DB / Table / Partition 三级 |
| 级联行为 | — | 删 DB 自动清所有子 Table 和 Partition |
| ID 获取 | — | `SHOW CATALOG RECYCLE BIN WHERE NAME = "..."` |

典型使用场景：回收特定 ID 避免与新对象冲突、测试环境清理堆积的垃圾条目。

> **注意**：此命令仅清除 FE 的元数据回收站，**不能**用于紧急释放磁盘空间。FE 擦除元数据后，BE 会将 tablet 文件 rename 至本地 `trash/` 目录，物理磁盘空间须等到 `trash_file_expire_time_sec`（默认 86400s）到期后才真正回收。如需立即释放磁盘，应执行 `ADMIN CLEAN TRASH ON ("be_host:port")`。

> **后续**：PR 合并 3 天后，发现当顶层 DB/Table 不在回收站但其子 Partition 仍存在时，`eraseDatabaseInstantly` 的早失败逻辑会导致孤立子条目无法清除。[PR #35750](https://github.com/apache/doris/pull/35750) 修复了这一场景，详见[修复按 DbId/TableId 清除回收站时未级联清理子分区的缺陷](/vibe-reading/articles/doris-pr-35750-erase-orphan-recycle-bin)。
