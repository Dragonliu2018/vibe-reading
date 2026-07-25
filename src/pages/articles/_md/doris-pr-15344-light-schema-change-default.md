---
title: "Light Schema Change 默认开启：一次四行的默认值翻转，与它顺带捎上的两个清理"
source:
  project: "Doris"
  type: "PR"
  id: "15344"
  url: "https://github.com/apache/doris/pull/15344"
  prType: "feat"
date: "2026-07-25"
category: [Database, Apache Doris, PRs]
tags: ["Schema Change", "Light Schema Change", "Doris", "DDL"]
description: "Doris 在 1.2.1 起将 light_schema_change 默认值从 false 翻为 true，新建表默认走元数据级加减列，同时修正了 SHOW CREATE TABLE 对 MOW 属性的输出。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#15344](https://github.com/apache/doris/pull/15344) · **Issue** - · **commit** [28bb13a0262](https://github.com/apache/doris/commit/28bb13a02624540cff4b1e5d2ad26fb119fd91f7) · **首发版本** 1.2.1 · **变更行数** +385 行 · **合并时间** 2022-12-28

---

## 背景

Doris 加减列（`ALTER TABLE ... ADD/DROP COLUMN`）历来是个重活。经典路径走 `SchemaChangeJobV2`：FE 为每个受影响的索引建 shadow index，给每个 tablet 下发 `AlterReplicaTask`，BE 收到后扫描原始数据、按表达式转换、写入新的 segment——一次列变更要真正重写数据文件。表越大、分区越多，这个 job 跑得越久，期间还要占住历史事务的可见版本。

`light_schema_change` 就是为「纯加减列」这种不需要改数据的场景准备的捷径：FE 只更新表/索引的 schema 元数据，再把新 schema 同步给 BE 的 tablet 元信息，整个过程不重写数据文件，加减列接近瞬时完成。它有一个前提——只对「不改列类型、不涉及表达式重算」的纯增删列生效；一旦涉及类型转换，`SchemaChangeHandler` 会判定该操作不可走 light 路径，自动回退到重型的 `SchemaChangeJobV2`。

```java title="SchemaChangeHandler.java"
boolean lightSchemaChange = olapTable.getEnableLightSchemaChange();
// ... 逐列检查 addColumnInternal / 类型是否变化 / 是否涉及 rollup ...
// 任何一项不满足就把 lightSchemaChange 置为 false，回退到 SchemaChangeJobV2
```

这个特性在 1.2 系列早期引入，但默认关闭，需要建表时显式 `"light_schema_change" = "true"` 才启用。原因无他——新特性，先灰度验证。PR #15344 做的事很直接：**经过一段时间验证后，把默认值从 `false` 翻成 `true`**，让新建表开箱即用走轻量 DDL。已有表不受影响（属性在建表时落定，不会被回溯改动）。

PR 的标题只提了 light schema change，但 diff 里还夹带了两个小清理：一个 `SHOW CREATE TABLE` 的输出修正，一个报错信息改写。下面逐个看。

---

## 前置知识

### 两个 schema 变更路径的分流

加减列请求进入 `SchemaChangeHandler` 后，会先用 `getEnableLightSchemaChange()` 判断这张表是否开启了 light 路径，再逐列检查操作本身是否「轻量可做」：

| 判定维度 | 满足则走 light | 不满足则回退 SchemaChangeJobV2 |
| --- | --- | --- |
| 表属性 `light_schema_change` | `true` | `false` |
| 操作类型 | 纯 ADD/DROP COLUMN | MODIFY COLUMN（改类型）/ 改 key |
| 列变更是否需要表达式 | 否 | 是（生成 cast Expr） |
| 是否涉及 rollup index | 否 | 是 |

两条路径对用户透明——`ALTER TABLE` 语句不变，FE 自动选路。区别只在执行代价：light 路径是元数据同步，重型路径是数据重写。

### 默认值的落点

`light_schema_change` 的默认值不在 `Config` 里，而在 `PropertyAnalyzer.analyzeUseLightSchemaChange`——建表时解析 `PROPERTIES` 的入口。这意味着默认值影响的是**新建表**：建表时把解析结果写进 `OlapTable` 的 `tableProperty`，之后该表的加减列都按这个值分流。所以「翻转默认值」=「翻转建表时未显式指定该属性时的取值」，存量表纹丝不动。

---

## 实现

### 核心改动：默认值 false → true

真正翻转默认值的只有 `PropertyAnalyzer` 里一个方法，两处 `return false` 改成 `return true`：

```java title="PropertyAnalyzer.java（修复后）"
public static Boolean analyzeUseLightSchemaChange(Map<String, String> properties) throws AnalysisException {
    if (properties == null || properties.isEmpty()) {
        return true;                       // 原为 false
    }
    String value = properties.get(PROPERTIES_ENABLE_LIGHT_SCHEMA_CHANGE);
    // set light schema change true by default
    if (null == value) {
        return true;                       // 原为 false
    }
    properties.remove(PROPERTIES_ENABLE_LIGHT_SCHEMA_CHANGE);
    if (value.equalsIgnoreCase("true")) {
        return true;
    } else if (value.equalsIgnoreCase("false")) {
        return false;
    }
    throw new AnalysisException(PROPERTIES_ENABLE_LIGHT_SCHEMA_CHANGE + " must be `true` or `false`");
}
```

两个 `return` 对应两种「未显式指定」的情况：`properties` 整个为空、或 `properties` 非空但不含 `light_schema_change` 键。两者都从 `false` 翻成 `true`，行为一致。显式传 `"true"` / `"false"` 的分支不动——用户仍可强制关闭。

### 调用方：去掉冗余的预初始化

`InternalCatalog` 建表流程里调用这个解析器。原代码先把局部变量预置为 `false` 再赋值：

```java title="InternalCatalog.java（修复前）"
Boolean enableLightSchemaChange = false;
try {
    enableLightSchemaChange = PropertyAnalyzer.analyzeUseLightSchemaChange(properties);
} catch (AnalysisException e) {
    throw new DdlException(e.getMessage());
}
```

`analyzeUseLightSchemaChange` 要么返回 `Boolean`、要么抛 `AnalysisException`（被 catch 后转抛 `DdlException`），不存在「走完 try 仍未赋值」的路径。所以那个 `= false` 是冗余的预初始化，PR 顺手去掉：

```java title="InternalCatalog.java（修复后）"
Boolean enableLightSchemaChange;
try {
    enableLightSchemaChange = PropertyAnalyzer.analyzeUseLightSchemaChange(properties);
} catch (AnalysisException e) {
    throw new DdlException(e.getMessage());
}
```

同一段里 `enableUniqueKeyMergeOnWrite` 也做了同样处理（`= false` → 去掉）。注意这**不是**把 MOW 也默认开启——`analyzeUniqueKeyMergeOnWrite` 的默认返回仍是 `false`，去掉预初始化只是清理，MOW 行为不变（文档也明确：1.2.0 里 MOW 仍默认关闭）。这点容易被 PR 的 head 分支名 `enable_mow_light` 误导，实际只翻转了 light schema change。

### 顺带清理一：SHOW CREATE TABLE 不再给非 UNIQUE 表输出 MOW 属性

`Env` 里拼 `SHOW CREATE TABLE` 时，对 MOW 属性的输出条件加了一个 `KeysType.UNIQUE_KEYS` 守卫：

```java title="Env.java（修复后）"
// unique key table with merge on write
if (olapTable.getKeysType() == KeysType.UNIQUE_KEYS && olapTable.getEnableUniqueKeyMergeOnWrite()) {
    sb.append(",\n\"").append(PropertyAnalyzer.ENABLE_UNIQUE_KEY_MERGE_ON_WRITE).append("\" = \"");
    sb.append(olapTable.getEnableUniqueKeyMergeOnWrite()).append("\"");
}
```

原条件只有 `if (olapTable.getEnableUniqueKeyMergeOnWrite())`。问题在于 `analyzeUniqueKeyMergeOnWrite` 并不校验 `keysType`——用户完全可以在一张 DUPLICATE 表上写 `"enable_unique_key_merge_on_write" = "true"`，这个值会被原样存进 `tableProperty`。修复前，`SHOW CREATE TABLE` 会把这条对 DUPLICATE 表毫无意义的属性也打印出来，让人误以为这张表开了 MOW。加上 `UNIQUE_KEYS` 守卫后，只有 MOW 真正生效的唯一键表才会输出该属性。

light schema change 的输出条件没动，仍是 `if (olapTable.getEnableLightSchemaChange())`——默认翻 true 后，新建表的 `SHOW CREATE TABLE` 会多出一行 `"light_schema_change" = "true"`。

### 顺带清理二：改一句报错文案

`ModifyTablePropertiesClause` 里，对 `ALTER TABLE` 试图改 `enable_unique_key_merge_on_write` 属性的报错，从含糊的 `Alter tablet type not supported` 改成准确的 `Can not change UNIQUE KEY to Merge-On-Write mode`：

```java title="ModifyTablePropertiesClause.java（修复后）"
} else if (properties.containsKey(PropertyAnalyzer.ENABLE_UNIQUE_KEY_MERGE_ON_WRITE)) {
    throw new AnalysisException("Can not change UNIQUE KEY to Merge-On-Write mode");
}
```

MOW 是建表时定的属性，不支持后续 `ALTER` 切换，文案改清楚让用户知道自己卡在哪。

---

## 测试

### 单元测试

`CreateTableAsSelectStmtTest` 里大量断言 `SHOW CREATE TABLE` 的完整输出串。默认值翻转后，CTAS 建出的表也带上了 `light_schema_change=true`，所以每条期望串都要补一行：

```java title="CreateTableAsSelectStmtTest.java（修复后）"
Assertions.assertEquals(
        "CREATE TABLE `select_decimal_table` (\n"
                + "  `userId` varchar(65533) NOT NULL,\n"
                + "  `amount_decimal` decimal(10, 2) NOT NULL\n"
                + ") ENGINE=OLAP\n"
                + "DUPLICATE KEY(`userId`)\n"
                + "COMMENT 'OLAP'\n"
                + "DISTRIBUTED BY HASH(`userId`) BUCKETS 10\n"
                + "PROPERTIES (\n"
                + "\"replication_allocation\" = \"tag.location.default: 1\",\n"
                + "\"in_memory\" = \"false\",\n"
                + "\"storage_format\" = \"V2\",\n"
                + "\"light_schema_change\" = \"true\",\n"      // 新增
                + "\"disable_auto_compaction\" = \"false\"\n"
                + ");",
        showCreateTableByName("select_decimal_table").getResultRows().get(0).get(1));
```

这是 PR 385 行增量里的大头（+351 行）——不是新逻辑，而是把默认值变更传导到所有 `SHOW CREATE TABLE` 的 golden 期望上。

### 回归测试

几个 `.out` golden 文件（`test_recover.out`、`test_ctas.out`、`test_ctl.out`、`test_array_show_create.out`）做了同样的事：给每条 `SHOW CREATE TABLE` 的期望输出补上 `"light_schema_change" = "true"`：

```text title="test_recover.out（修复后，节选）"
... PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"in_memory" = "false",
"storage_format" = "V2",
"light_schema_change" = "true",
"disable_auto_compaction" = "false"
);
```

测试本身没新增用例——PR 的 checklist 也勾了「No Need」加单测。因为这是一个纯默认值翻转，验证手段就是确认所有依赖 `SHOW CREATE TABLE` 输出的 golden 都跟着变了，没有遗漏。

---

## 意义与影响

这个 PR 的价值不在代码量（核心逻辑四行），在于**把一个已经验证过的优化从 opt-in 推成默认**：

- **新建表开箱即用轻量 DDL**。此后绝大多数加减列不再触发数据重写，大表的 DDL 延迟从分钟级降到秒级。存量表不受影响，需要的话仍可显式建新表迁移。
- **行为变更需关注兼容性**。PR 带 `kind/behavior-changed` 标签。对依赖 `SHOW CREATE TABLE` 输出做 diff 或解析的下游工具（数据平台、元数据同步、CI 比对），会多出一个 `light_schema_change` 属性——这也是为什么测试里那么大的 golden 更新量：任何把建表 DDL 当字符串比对的系统都会受影响。
- **两条清理提升了元数据一致性**。MOW 属性只在唯一键表输出，避免误导；报错文案更准确。它们和默认值翻转没有直接因果关系，更像是作者在重生成 golden 文件时顺手把同一段 `SHOW CREATE TABLE` 逻辑里的小毛病一起修了。

从工程节奏看，这是一个典型的「特性落地收尾」PR：特性本身在更早的 PR 里实现并灰度，本 PR 只负责把开关拨到默认开，并把因此产生的全量 golden 涟漪一次性消化掉。首发版本 1.2.1（文档明确「该功能在 1.2.1 及之后版本默认开启」）。

---

## 参考

- 建表属性解析：`fe/fe-core/src/main/java/org/apache/doris/common/util/PropertyAnalyzer.java`
- 建表流程注入属性：`fe/fe-core/src/main/java/org/apache/doris/datasource/InternalCatalog.java`
- `SHOW CREATE TABLE` 拼装：`fe/fe-core/src/main/java/org/apache/doris/catalog/Env.java`
- light 路径分流判定：`fe/fe-core/src/main/java/org/apache/doris/alter/SchemaChangeHandler.java`
- 文档：`docs/zh-CN/docs/sql-manual/sql-reference/Data-Definition-Statements/Create/CREATE-TABLE.md`（注明 1.2.1 起默认开启）
