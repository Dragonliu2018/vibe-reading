---
title: "支持 PI 作为列默认值"
source:
  project: "Doris"
  type: "PR"
  id: "36280"
  url: "https://github.com/apache/doris/pull/36280"
date: "2026-07-01"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Java", "DDL", "FE"]
description: "新增 PI 关键字，允许 DOUBLE 类型列以圆周率作为默认值。"
readingTime: "6 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#36280](https://github.com/apache/doris/pull/36280) · **Issue** [#34228](https://github.com/apache/doris/issues/34228) · **commit** [fd6ecbc](https://github.com/apache/doris/commit/fd6ecbc9b425f9c5dbbc52016db57bcefaeb6b5c) · **首发版本** 3.0.0 · **变更行数** +173 行 · **合并时间** 2024-06-26

---

## 背景

Issue [#34228](https://github.com/apache/doris/issues/34228) 由社区成员 **Yukang-Lian** 提出，请求为 Doris 列默认值系统添加更多函数支持，列举了 `pi`、`e`、`random`、`uuid_numeric` 等数学/工具函数。

PR #36280 率先落地其中的 `PI`，使以下建表语句成为可能：

```sql title="新增语法：PI 作为列默认值"
CREATE TABLE t1 (
    k TINYINT,
    v DOUBLE NOT NULL DEFAULT PI
)
UNIQUE KEY(k)
DISTRIBUTED BY HASH(k)
PROPERTIES("replication_num" = "1");
```

插入时若不指定 `v` 列，其默认值将自动填入圆周率。

---

## 前置知识

Doris 的函数式默认值（如 `CURRENT_DATE`、`CURRENT_TIMESTAMP`）不是在 DDL 执行时求值然后存储字面量，而是将**函数名**作为元信息保存，在每次写入缺省列时动态填充。PR #36280 对 PI 采用了相同机制，但有一个重要区别：PI 是数学常数，不随时间变化，因此其值可以在定义期固定为一个高精度字符串。

DOUBLE（IEEE 754 双精度浮点）可表示约 15～16 位有效数字。Doris 将 PI 存储为 `"3.14159265358979323846"`（20 位，参考 C 标准库 `<math.h>` 中的 `M_PI`），读取时由 DOUBLE 自然截断，实际精度为 `3.141592653589793`。

---

## 实现

### 语法层

**DorisLexer.g4** 新增 `PI` token：

```antlr4 title="DorisLexer.g4 — 新增 PI token"
PI: 'PI';
```

**DorisParser.g4** 在列默认值的备选项中加入 `PI`，并将其加入 `nonReserved` 列表（允许 `pi` 作为普通标识符使用，避免与用户已有的列名冲突）：

```antlr4 title="DorisParser.g4 — 默认值语法扩展"
columnDef
    : ... (DEFAULT (nullValue=NULL | INTEGER_VALUE | DECIMAL_VALUE | PI
           | stringValue=STRING_LITERAL | CURRENT_DATE
           | defaultTimestamp=CURRENT_TIMESTAMP ...))?
    ;

nonReserved
    | PI
    ;
```

**PLParser.g4** 同步将 `PI` 加入存储过程解析器的非保留字列表。

### 常量定义（DefaultValue.java）

PI 的字符串值统一定义在 `DefaultValue` 类中，注释说明了精度选择的依据：

```java title="DefaultValue.java — PI_DEFAULT_VALUE 常量"
public static String PI = "PI";

// "3.14159265358979323846" 对应 <math.h> 中的 M_PI（20 位有效数字）。
// DOUBLE 精度约为 15~16 位，此值已完全覆盖其精度上限。
// 若需 long double 精度，应使用 M_PIl。
public static DefaultValue PI_DEFAULT_VALUE =
        new DefaultValue("3.14159265358979323846", PI);
```

### 解析层（LogicalPlanBuilder.java）

在 `visitColumnDef` 的默认值分支中，新增 `PI` token 的处理：

```java title="LogicalPlanBuilder.java — PI 解析分支"
} else if (ctx.CURRENT_DATE() != null) {
    defaultValue = Optional.of(DefaultValue.CURRENT_DATE_DEFAULT_VALUE);
} else if (ctx.PI() != null) {
    defaultValue = Optional.of(DefaultValue.PI_DEFAULT_VALUE);
}
```

### 类型检查（ColumnDef.java）

复用 PR [#35760](https://github.com/apache/doris/pull/35760) 建立的"类型前置检查"框架，在字面量构造之前验证列类型：

```java title="ColumnDef.java — PI 类型前置检查"
} else if (null != defaultValueExprDef
        && defaultValueExprDef.getExprName().equalsIgnoreCase(DefaultValue.PI)) {
    switch (primitiveType) {
        case DOUBLE:
            break;
        default:
            throw new AnalysisException(
                "Types other than DOUBLE cannot use pi as the default value");
    }
}
```

当前只允许 `DOUBLE` 类型使用 PI 默认值。`FLOAT` 同样是浮点类型，但精度仅为 6～7 位有效数字，低于 PI 的意义精度，因此未被纳入支持范围。

---

## 测试

`regression-test/suites/correctness_p0/test_default_pi.groovy` 覆盖四类场景：

```groovy title="test_default_pi.groovy — 核心测试场景"
// 场景 1：INSERT INTO 省略 v1 列，验证 PI 默认填充
sql " insert into ${tableName} (k, v2) values (1, 1); "
qt_insert_into1 """ select * from ${tableName} order by k; """
// 预期：v1 = 3.141592653589793

// 场景 2：Stream Load，指定 v1=pi() 显式填充
streamLoad {
    set 'columns', 'k, v1=pi(), v2'
    file 'test_default_pi_streamload.csv'
}
qt_stream_load_csv1 """ select * from ${tableName} order by k; """

// 场景 3：部分更新（enable_unique_key_partial_update=true）
// 验证 PI 默认值在部分列更新模式下也能正确填充

// 场景 4：非法类型验证
test {
    sql """create table t(a int, b varchar(100) default pi) ..."""
    exception "Types other than DOUBLE cannot use pi as the default value"
}
test {
    sql """create table t(a int, b int default pi) ..."""
    exception "Types other than DOUBLE cannot use pi as the default value"
}
test {
    sql """create table t(a int, b float default pi) ..."""
    exception "Types other than DOUBLE cannot use pi as the default value"
}
```

场景 3（部分更新）特别重要——`UNIQUE KEY` 表的部分列写入是常见场景，需要确认默认值在此模式下同样生效。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| `v DOUBLE DEFAULT PI` | ❌ 语法报错 | ✅ 支持，自动填入 `3.141592653589793` |
| `v FLOAT DEFAULT PI` | — | ❌ 报错（类型不支持） |
| `v INT DEFAULT PI` | — | ❌ 报错（类型不支持） |

PI 是数学计算、物理模拟、地理坐标系等场景下的高频常量，作为列默认值可以避免应用层重复传递这个固定值。此 PR 也是 Issue #34228 中数学常数系列（`pi`、`e`）落地的第一步。
