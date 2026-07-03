---
title: "修复非 DATE 类型使用 current_date 默认值时的误导性报错"
source:
  project: "Doris"
  type: "PR"
  id: "35760"
  url: "https://github.com/apache/doris/pull/35760"
date: "2026-07-01"
category: [Database, Apache Doris, Contributions]
tags: ["Apache Doris", "Java", "FE", "DDL"]
description: "将 ColumnDef.analyzeDefaultValue() 中的类型兼容性检查前移到字面量构造之前，确保非法默认值给出准确的错误提示而非内部实现细节。"
readingTime: "5 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#35760](https://github.com/apache/doris/pull/35760) · **Issue** [#35758](https://github.com/apache/doris/issues/35758) · **commit** [af945d2](https://github.com/apache/doris/commit/af945d2ed56473576ecc03224601a6328285efcb) · **首发版本** 3.0.0 · **变更行数** +42 行 · **合并时间** 2024-06-12

---

## 背景

在 `CREATE TABLE` 时，为非 DATE/DATEV2 类型的列指定 `current_date` 作为默认值，Doris 会抛出一个令人困惑的错误：

```sql title="触发误导性报错的建表语句"
CREATE TABLE t1 (a INT, b DOUBLE DEFAULT current_date)
DISTRIBUTED BY HASH(a) PROPERTIES('replication_num' = '1');
-- ERROR 1105 (HY000): errCode = 2, detailMessage = Invalid floating-point literal: CURRENT_DATE
```

"Invalid floating-point literal: CURRENT_DATE"——这是一条**内部实现细节**，对用户完全没有指导意义：用户看到这个报错，完全不知道问题出在哪里，也不知道该如何修改。

正确的报错应该是：
```
Types other than DATE and DATEV2 cannot use current_date as the default value
```

Issue [#35758](https://github.com/apache/doris/issues/35758) 明确指出了这个问题，`varchar`、`int`、`double` 等类型均会触发。

---

## 前置知识

FE 在处理 `CREATE TABLE` 语句时，会对每一列调用 `ColumnDef.analyzeDefaultValue()` 方法，验证列的默认值是否合法。对于函数式默认值（如 `current_date`、`current_timestamp`），需要做两件事：

1. **类型兼容性检查**：`current_date` 只能用于 DATE / DATEV2；`current_timestamp` 只能用于 DATETIME / DATETIMEV2。
2. **字面量构造**：根据列的实际类型，将默认值字符串转换为对应的字面量对象（`IntLiteral`、`FloatLiteral`、`StringLiteral` 等）。

问题的根源在于这两步的**执行顺序**。

---

## 实现

### 根因：字面量构造先于类型检查

旧代码的执行顺序是：先执行 `switch (primitiveType)` 构造字面量，构造失败时抛出内部异常；类型兼容性检查放在 switch **之后**，实际上永远无法被执行到：

```java title="ColumnDef.java — 旧代码执行顺序（PR 前）"
// 步骤 1：按类型构造字面量 ← 对 DOUBLE 类型，尝试 new FloatLiteral("CURRENT_DATE")
switch (primitiveType) {
    case TINYINT: ...
    case FLOAT:
    case DOUBLE:
        defaultExpr = new FloatLiteral(defaultValue);  // ← 此处抛出 "Invalid floating-point literal"
        break;
    ...
}

// 步骤 2：检查 current_date 类型兼容性 ← 永远执行不到
if (defaultValueExprDef.getExprName().equals(DefaultValue.CURRENT_DATE.toLowerCase())) {
    switch (primitiveType) {
        case DATE:
        case DATEV2:
            break;
        default:
            throw new AnalysisException("Types other than DATE and DATEV2 ...");  // 被截断
    }
}
```

对 `DOUBLE` 类型，`FloatLiteral("CURRENT_DATE")` 在内部尝试将字符串 `"CURRENT_DATE"` 解析为浮点数，失败后直接抛出 `"Invalid floating-point literal: CURRENT_DATE"`，后面的类型兼容性检查根本没有机会执行。

### 修复：类型检查前移

将类型兼容性检查移到 `switch` **之前**，确保先拦截非法的函数式默认值，再进行字面量构造：

```java title="ColumnDef.java — 修复后的执行顺序"
// 步骤 1：先检查 current_timestamp / current_date 的类型兼容性
if (defaultValueExprDef.getExprName().equalsIgnoreCase("now")) {
    switch (primitiveType) {
        case DATETIME:
        case DATETIMEV2:
            break;
        default:
            throw new AnalysisException("Types other than DATETIME and DATETIMEV2 "
                    + "cannot use current_timestamp as the default value");
    }
} else if (defaultValueExprDef.getExprName().equalsIgnoreCase(DefaultValue.CURRENT_DATE)) {
    switch (primitiveType) {
        case DATE:
        case DATEV2:
            break;
        default:
            throw new AnalysisException("Types other than DATE and DATEV2 "
                    + "cannot use current_date as the default value");
    }
}

// 步骤 2：类型合法后，再构造字面量
switch (primitiveType) {
    case FLOAT:
    case DOUBLE:
        defaultExpr = new FloatLiteral(defaultValue);  // 此时 current_date 已被前面拦截
        break;
    ...
}
```

### 顺带修复：大小写不敏感比较

旧代码使用 `equals("now")` 和 `equals(DefaultValue.CURRENT_DATE.toLowerCase())` 做精确匹配，新代码统一改为 `equalsIgnoreCase(...)`：

| 比较方式 | 旧代码 | 新代码 |
| --- | --- | --- |
| `now` 匹配 | `equals("now")` | `equalsIgnoreCase("now")` |
| `current_date` 匹配 | `equals(DefaultValue.CURRENT_DATE.toLowerCase())` | `equalsIgnoreCase(DefaultValue.CURRENT_DATE)` |

这使得 `CURRENT_DATE`、`Current_Date` 等大小写变体也能被正确识别，与 SQL 标准对关键字大小写不敏感的要求保持一致。

---

## 测试

### 回归测试

在 `regression-test/suites/correctness_p0/test_current_date.groovy` 中补充三种非法类型的测试用例，覆盖字符串、整数、浮点数场景：

```groovy title="test_current_date.groovy — 新增三种非法类型测试"
// varchar 使用 current_date 默认值
sql "DROP TABLE IF EXISTS test_varchar_default"
test {
    sql """create table test_varchar_default(a int, b varchar(100) default current_date)
    distributed by hash(a) properties('replication_num'="1");"""
    exception "Types other than DATE and DATEV2 cannot use current_date as the default value"
}

// int 使用 current_date 默认值
sql "DROP TABLE IF EXISTS test_int_default"
test {
    sql """create table test_int_default(a int, b int default current_date)
    distributed by hash(a) properties('replication_num'="1");"""
    exception "Types other than DATE and DATEV2 cannot use current_date as the default value"
}

// double 使用 current_date 默认值（原 Bug 的触发场景）
sql "DROP TABLE IF EXISTS test_double_default"
test {
    sql """create table test_int_default(a int, b double default current_date)
    distributed by hash(a) properties('replication_num'="1");"""
    exception "Types other than DATE and DATEV2 cannot use current_date as the default value"
}
```

三个用例均断言报错信息为明确的类型限制提示，而非内部字面量构造异常。

---

## 意义与影响

| 对比维度 | PR 前 | PR 后 |
| --- | --- | --- |
| `double DEFAULT current_date` | `Invalid floating-point literal: CURRENT_DATE` | `Types other than DATE and DATEV2 cannot use current_date as the default value` |
| `int DEFAULT current_date` | `Invalid integer literal: CURRENT_DATE` | 同上 |
| `varchar DEFAULT current_date` | 可能抛出其他内部异常 | 同上 |
| `current_date` 大小写变体 | 部分情况下匹配不一致 | 大小写不敏感，行为一致 |

这是一个典型的**报错体验**修复——功能约束本身没有变化（非 DATE/DATEV2 类型确实不能用 `current_date`），但错误信息从"内部实现细节"变为"用户可理解的操作指引"，遵循了"错误信息应告诉用户该做什么，而非系统内部发生了什么"的设计原则。
