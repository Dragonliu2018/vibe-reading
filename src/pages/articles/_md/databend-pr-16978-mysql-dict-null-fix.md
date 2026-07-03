---
title: "修复 MySQL 字典值列含 NULL 时的解码崩溃"
source:
  project: "Databend"
  type: "PR"
  id: "16978"
  url: "https://github.com/databendlabs/databend/pull/16978"
  prType: "fix"
date: "2026-07-04"
category: [Database, Databend, Contributions]
tags: ["Databend", "MySQL", "Dictionary", "Bug Fix", "sqlx", "Option"]
description: "PR #16948 的批量查询宏在解码含 NULL 的 MySQL 值列时崩溃，用 Option<T> 包裹值类型并配合 filter_map 修复，两行改动覆盖标量和批量两条路径。"
readingTime: "8 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#16978](https://github.com/databendlabs/databend/pull/16978) · **Issue** [#16976](https://github.com/databendlabs/databend/issues/16976) · **commit** [c496fce](https://github.com/databendlabs/databend/commit/c496fce811d1a12095b75a34a81af728f070c8d8) · **首发版本** v1.2.668-nightly · **变更行数** +133 / -86 行 · **合并时间** 2024-12-02

> 📎 本文是 [用 IN 批量查询加速 MySQL 字典读取](/vibe-reading/articles/databend-pr-16948-mysql-dict-batch) 的后续 bug fix，建议先阅读原文。

---

## 背景

PR #16948 将 MySQL 字典的值列查询从 `sqlx::query_scalar` 改为 `sqlx::query_as`，后者将整行结果解码为 Rust 元组。这一改动在 MySQL 值列含 NULL 时会触发运行时崩溃（Issue #16976）：

```shell title="复现错误"
error: APIError: ResponseError with 3115: Dictionary Sqlx Error,
cause: error occurred while decoding column 1: unexpected null;
       try decoding as an `Option`
```

复现步骤（来自 Issue #16976）：

```sql title="MySQL 侧"
CREATE TABLE user(id int, name varchar(100));
INSERT INTO user VALUES (1, 'Amy'), (2, null);  -- name 列含 NULL
```

```sql title="Databend 侧"
CREATE OR REPLACE DICTIONARY mysql_dic(id int, name string)
PRIMARY KEY id
SOURCE(mysql(host='localhost' port='3306' ...));

SELECT dict_get(mysql_dic, 'name', 2);  -- 崩溃
```

---

## 问题根因

sqlx 的 `query_as::<_, (KeyType, ValType)>` 在解码行时，若列值为 NULL 而目标类型不是 `Option<T>`，会直接返回错误。旧的 `query_scalar::<_, Option<String>>` 天然支持 NULL（因为返回类型已是 `Option`），而 PR #16948 引入的两个宏均使用了裸类型：

```rust title="PR #16948 引入的问题——裸类型无法解码 NULL"
// sqlx_fetch_optional! 宏（标量路径）
let res: Option<($key_type, $val_type)> = sqlx::query_as(...).fetch_optional(pool).await?;
//                          ^^^^^^^^^ 若该列为 NULL，sqlx 在此处报错

// fetch_all_rows_by_sqlx! 宏（批量路径）
let res: Vec<($key_type, $val_type)> = sqlx::query_as(...).fetch_all(pool).await?;
//                       ^^^^^^^^^ 同上
```

---

## 修复

### 标量路径：sqlx_fetch_optional!

将值类型从 `$val_type` 改为 `Option<$val_type>`，同时用 `and_then` 替换 `map`，让 NULL 值自然传播为 `None`：

```rust title="sqlx_fetch_optional! 修复前后"
// 修复前
let res: Option<($key_type, $val_type)> =
    sqlx::query_as(&$sql).fetch_optional($pool).await?;
Ok(res.map(|(_, v)| $format_val_fn(v)))

// 修复后
let res: Option<($key_type, Option<$val_type>)> =
    sqlx::query_as(&$sql).fetch_optional($pool).await?;
Ok(res.and_then(|(_, v)| v.map($format_val_fn)))
```

两种情况下均返回 `None`，调用方统一用 `default_value` 填充：
- 行不存在（key 不在 MySQL 表中）
- 行存在但值列为 NULL

### 批量路径：fetch_all_rows_by_sqlx!

将 `Vec<(key, val)>` 改为 `Vec<(key, Option<val>)>`，再用 `filter_map` 跳过值为 NULL 的行，使其不进入 `HashMap`：

```rust title="fetch_all_rows_by_sqlx! 修复（以 String 值类型为例）"
// 修复前
let res: Vec<(String, $val_type)> = sqlx::query_as($sql).fetch_all($pool).await?;
res.into_iter()
    .map(|(k, v)| ($format_key_fn(ScalarRef::String(&k)), v))
    .collect()

// 修复后
let res: Vec<(String, Option<$val_type>)> = sqlx::query_as($sql).fetch_all($pool).await?;
res.into_iter()
    .filter_map(|(key, val)| match (key, val) {
        (k, Some(v)) => Some(($format_key_fn(ScalarRef::String(&k)), v)),
        _ => None,   // 值为 NULL 的行直接丢弃
    })
    .collect()
```

被 `filter_map` 丢弃的行不会进入 `kv_pairs` HashMap。后续按原始列顺序回填时，查不到该 key 对应值，同样回退为 `default_value`——行为与"key 不存在"一致。

---

## 测试

### 回归测试

Mock MySQL 数据集中新增第 5 行（id=5，其余列全部为 NULL），验证两条路径均能正确处理 NULL 值列：

```rust title="tests/sqllogictests/src/mock_source/mysql_source.rs（mock 数据变更）"
// 修复前：4 行，无 NULL 值
let block = vec![
    vec![Value::Int(1), Value::Int(2), Value::Int(3), Value::Int(4)],
    vec![Value::Bytes("Alice"..), Value::Bytes("Bob"..), ...],
    ...
];

// 修复后：5 行，第 5 行 name/age/salary/active 均为 None
let block: Vec<Vec<Option<Value>>> = vec![
    vec![Some(Value::Int(1)), ..., Some(Value::Int(5))],
    vec![Some(Value::Bytes("Alice"..")), ..., None],  // name[5] = NULL
    vec![Some(Value::UInt(24)), ..., None],            // age[5]  = NULL
    vec![Some(Value::Double(100.0)), ..., None],       // salary[5] = NULL
    vec![Some(Value::Int(1)), ..., None],              // active[5] = NULL
];
```

`block` 的元素类型从 `Vec<Value>` 改为 `Vec<Option<Value>>`，行写入时 `None` 列用 `rw.write_col(None::<i64>)?` 发送 MySQL NULL 协议帧。

测试用例预期结果同步更新——key=5 的行现在存在于 MySQL 表中，查 `id` 列得 `5`，其余值列返回 NULL（即 `default_value`）：

```sql title="02_0077_function_dict_get.test 预期变化"
-- 修复前（mock 无第 5 行，key not found，全部返回 default NULL）
SELECT dict_get(mysql_dic_id, 'id', 5), dict_get(mysql_dic_id, 'name', 5), ...
----
NULL NULL NULL NULL NULL

-- 修复后（key 存在，值列为 NULL，返回 default_value）
----
5 NULL NULL NULL NULL
```

---

## 意义与影响

- **正确性**：MySQL 字典现在能正确处理值列含 NULL 的数据，不再崩溃
- **语义**：MySQL NULL → Databend `default_value`（通常为 NULL），与 SQL 对 NULL 的一贯处理语义一致
- **覆盖范围**：修复同时覆盖标量（Scalar）和批量列（Column）两条执行路径，以及所有支持的值类型（Bool / String / Integer / Float）

> **后续**：MySQL 字典的 key 仍以字符串格式化拼入 SQL，后续计划用原生类型直接绑定，详见 [PR #16948 TODO](/vibe-reading/articles/databend-pr-16948-mysql-dict-batch#todo)。
