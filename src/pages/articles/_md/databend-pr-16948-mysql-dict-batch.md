---
title: "用 IN 批量查询加速 MySQL 字典读取"
source:
  project: "Databend"
  type: "PR"
  id: "16948"
  url: "https://github.com/databendlabs/databend/pull/16948"
  prType: "perf"
date: "2026-07-04"
category: [Database, Databend, Contributions]
tags: ["Databend", "MySQL", "Dictionary", "性能优化", "批量查询", "sqlx"]
description: "将 MySQL 字典查询从逐行 WHERE key = ? 改为批量 WHERE key IN (...)，引入两组宏统一类型分发，附带 SQL 注入安全修复。"
readingTime: "13 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#16948](https://github.com/databendlabs/databend/pull/16948) · **Issue** [#16550](https://github.com/databendlabs/databend/issues/16550) · **commit** [25d615f](https://github.com/databendlabs/databend/commit/25d615f1cfa7e2dadd0717e1b98f04f452f78a2f) · **首发版本** v1.2.666-nightly · **变更行数** +526 / -190 行 · **合并时间** 2024-11-29

> 📎 本文是 [用 mget 批量加速 Redis 字典查询](/vibe-reading/articles/databend-pr-16766-redis-dict-mget) 的后续，MySQL 字典的同类优化，建议先阅读原文。

---

## 背景

PR #16766 完成了 Redis 字典的批量优化（`GET` → `MGET`），reviewer sundy-li 在那次 review 中同时指出 MySQL 字典也存在相同问题，并建议用 `WHERE key IN (...)` 实现批量查询。本 PR 是这一建议的落地实现。

旧实现对 Column 类型的 key 列逐行发起查询，每行一次独立的数据库请求：

```sql title="旧 SQL（逐行，N 行 = N 次往返）"
SELECT {value} FROM {table} WHERE {key} = ? LIMIT 1
```

MySQL 的网络往返成本叠加连接开销，比 Redis 更重。1w 行数据需要 26 秒，10w 行超过 18 分钟。

---

## 前置知识

### 旧实现的参数绑定方式

旧实现使用 sqlx 的 `?` 占位符 + `.bind(key)` 传参，每次调用走一次完整的 prepare → execute 往返：

```rust title="旧实现（每行绑定一次参数）"
let value: Option<String> = sqlx::query_scalar(sql)
    .bind(self.format_key(key))
    .fetch_optional(pool)
    .await?;
```

### IN 查询与批量返回

`WHERE key IN (v1, v2, ..., vN)` 允许一次查询返回所有匹配行。与 Redis mget 类似，RTT 从 N 次降为 1 次，代价是结果需要按原始顺序重新对应回去。

由于 MySQL 不保证返回顺序与 IN 列表一致，新实现在 SQL 中同时 **SELECT key 和 value**，返回后建 `HashMap<key, value>` 再按原始列顺序回填。

### sqlx 的类型系统

sqlx 通过泛型参数推导从数据库行中提取的 Rust 类型，例如：

```rust
let res: Vec<(String, i32)> = sqlx::query_as(sql).fetch_all(pool).await?;
```

不同的 key/value 类型组合（bool/String/i32/f32…）需要不同的类型参数，这在 Databend 中通过宏来统一处理。

---

## 实现

### SQL 模板的改造

初始化时构建的 SQL 模板从单值查询改为批量 IN 查询，同时新增 key 列到 SELECT：

```rust title="SQL 模板变化"
// 旧：单行查询，用 ? 占位
let sql = format!(
    "SELECT {} FROM {} WHERE {} = ? LIMIT 1",
    &sql_source.value_field, &sql_source.table, &sql_source.key_field
);

// 新：批量 IN 查询，key 也 SELECT 出来以便对应
let sql = format!(
    "SELECT {}, {} FROM {} WHERE {} in",
    &sql_source.key_field,   // ← 新增：把 key 也查出来
    &sql_source.value_field,
    &sql_source.table,
    &sql_source.key_field
);
```

`in` 后面没有括号——括号和具体 key 值在执行时动态拼接，模板只保留公共前缀。

### format_key 的 SQL 注入修复

旧实现的字符串 key 直接拼入 SQL，存在注入风险：

```rust title="format_key 修复前后对比"
// 旧：字符串直接拼入，无引号无转义
ScalarRef::String(s) => s.to_string()

// 新：加单引号，内部单引号转义
ScalarRef::String(s) => format!("'{}'", s.replace("'", "\\'"))
```

配套新增 `format_keys`，将整个 `HashSet<ScalarRef>` 格式化为逗号分隔的字符串：

```rust title="format_keys"
fn format_keys(&self, keys: HashSet<ScalarRef>) -> String {
    keys.into_iter()
        .map(|key| self.format_key(key))
        .collect::<Vec<String>>()
        .join(",")
}
```

### 两组宏：统一类型分发

MySQL 的 key 和 value 都有多种类型（bool / String / i8~i64 / f32 / f64），原本用 `with_integer_mapped_type!` 宏 + 手写 match 处理，代码重复度高。本 PR 引入两个宏进一步抽象。

**`fetch_single_row_by_sqlx!`**（Scalar 路径，单行查询）：

```rust title="fetch_single_row_by_sqlx! 宏"
macro_rules! fetch_single_row_by_sqlx {
    ($pool:expr, $sql:expr, $key_scalar:expr, $val_type:ty, $format_val_fn:expr) => {{
        match $key_scalar {
            DataType::Boolean => {
                sqlx_fetch_optional!($pool, $sql, bool, $val_type, $format_val_fn)
            }
            DataType::String => {
                sqlx_fetch_optional!($pool, $sql, String, $val_type, $format_val_fn)
            }
            DataType::Number(num_ty) => with_integer_mapped_type!(|KEY_NUM_TYPE| match num_ty {
                NumberDataType::KEY_NUM_TYPE => {
                    sqlx_fetch_optional!($pool, $sql, KEY_NUM_TYPE, $val_type, $format_val_fn)
                }
                // Float32 / Float64 分支...
            }),
            _ => Err(ErrorCode::DictionarySourceError(...)),
        }
    }};
}
```

**`fetch_all_rows_by_sqlx!`**（Column 路径，批量查询）：

```rust title="fetch_all_rows_by_sqlx! 宏"
macro_rules! fetch_all_rows_by_sqlx {
    ($pool:expr, $sql:expr, $key_scalar:expr, $val_type:ty, $format_key_fn:expr) => {
        match $key_scalar {
            DataType::Boolean => {
                let res: Vec<(bool, $val_type)> =
                    sqlx::query_as($sql).fetch_all($pool).await?;
                res.into_iter()
                    .map(|(k, v)| ($format_key_fn(ScalarRef::Boolean(k)), v))
                    .collect()
            }
            DataType::String => {
                let res: Vec<(String, $val_type)> =
                    sqlx::query_as($sql).fetch_all($pool).await?;
                res.into_iter()
                    .map(|(k, v)| ($format_key_fn(ScalarRef::String(&k)), v))
                    .collect()
            }
            // Number 类型分支类似...
        }
    };
}
```

两个宏都以 `$key_scalar`（key 的 `DataType`）作为分发条件，由 `$val_type` 决定 sqlx 从数据库中提取的 Rust 类型，由 `$format_val_fn` / `$format_key_fn` 控制结果转换。

### get_column_values_from_mysql：批量查询核心

```rust title="get_column_values_from_mysql 核心流程"
async fn get_column_values_from_mysql(...) -> Result<Value<AnyType>> {
    let key_cnt = column.len();
    let mut all_keys = Vec::with_capacity(key_cnt);  // 保留原始顺序（含重复和 null）
    let mut key_set = HashSet::with_capacity(key_cnt); // 去重，null 排除

    for item in column.iter() {
        if item != ScalarRef::Null {
            key_set.insert(item.clone());
        }
        all_keys.push(self.format_key(item)); // null → "NULL"（字符串，回填时按位置跳过）
    }

    // 全 null 时直接返回默认值列
    if key_set.is_empty() {
        /* 全填 default_value */
        return Ok(...);
    }

    // 拼 IN 查询：SELECT key, value FROM table WHERE key in (k1, k2, ...)
    let new_sql = format!("{} ({})", sql, self.format_keys(key_set));
    let key_type = column.data_type().remove_nullable();

    // 按 value 类型分发，fetch_all 一次取回所有匹配行
    match value_type.remove_nullable() {
        DataType::String => {
            let kv_pairs: HashMap<String, String> =
                fetch_all_rows_by_sqlx!(pool, &new_sql, key_type, String, |k| self.format_key(k));
            for key in all_keys {
                match kv_pairs.get(&key) {
                    Some(v) => builder.push(Scalar::String(v.to_string()).as_ref()),
                    None => builder.push(default_value.as_ref()), // key 不在表中，或原始为 null
                }
            }
        }
        // Boolean / Number 类型分支类似...
    }
    Ok(Value::Column(builder.build()))
}
```

与 Redis 版本的差异在于：Redis 的 mget 按 key 顺序返回结果，可以直接用下标对应；MySQL 的 IN 查询不保证顺序，所以用 `HashMap<String, value>` 中转，`all_keys` 保存每行格式化后的 key 字符串做 lookup。

---

## 测试

### 回归测试

`tests/sqllogictests/suites/query/functions/02_0077_function_dict_get.test` 大幅重写，新增 121 行，覆盖：

- 所有 key 类型作为主键（int / string / uint16 / float / bool）
- Scalar 路径：单值查询、key 不存在、default 值回退
- Column 路径：来自表列，含 null key、重复 key、含单引号的特殊字符串
- 非确定性结果场景（active 列多行匹配，注释说明两种合法结果）

**字符串转义测试**，验证 `format_key` 的引号处理：

```sql title="特殊字符串 key 的测试"
-- 插入含单引号的数据
insert into mysql_t values(..., (3, '\'Lily\'', ...), (4, '\'\'Tom\'\'', ...))

-- 含单引号的 key 查询结果应为 NULL（转义后不匹配表中的 key）
query ITI
select id, name, dict_get(mysql_dic_id, 'age', id) as age from mysql_t where age > 35
----
3 'Lily' 41
4 ''Tom'' 55
```

测试依赖 `mock_source/mysql_source.rs` 中的 Mock MySQL 服务，该服务同步改造以支持 `SELECT key, value FROM table WHERE key IN (...)` 语法解析，原先只支持 `WHERE key = ?` 的 `BinaryOp::Eq` 匹配，现改为解析 `Expr::InList`，多 key 依次查找对应行返回。

### 性能测试

复现步骤（来自 PR 描述，参考 `02_0077_function_dict_get.test`）：

```sql title="性能测试 SQL"
-- 建 MySQL 字典
CREATE OR REPLACE DICTIONARY d1 (key VARCHAR NULL, value VARCHAR NOT NULL)
PRIMARY KEY key
SOURCE(mysql(host='...' port='3306' ...));

-- 建测试表，插入 1w / 10w / 100w 行数据，执行：
SELECT key, dict_get(d1, 'value', key) FROM test_table;
```

| 数据量 | 旧实现（逐行 WHERE = ?） | 新实现（批量 WHERE IN） | 加速比 |
|---|---|---|---|
| 1w 行 | 26.839 s | 3.256 s | **8×** |
| 10w 行 | 1122.486 s | 100.100 s | **11×** |
| 100w 行 | 未完成（超时） | 7654.867 s | - |

加速比低于 Redis 的百倍级别，原因在于 MySQL 处理大 IN 列表本身有数据库侧开销（索引扫描、结果集传输），且 100w 行的 IN 列表本身很大，查询耗时仍很可观。

---

## Review

**b41sh**：null key 可以在遍历时直接跳过，不加入 key_set。→ 已采纳，`if item != ScalarRef::Null` 的判断正是这一建议的落地。

**b41sh**：用 `key_set` 替代原先的 `unique_keys` 变量名，语义更清晰。→ 已采纳。

---

## 意义与影响

这个 PR 完成了 Issue #16550 的 MySQL 优化任务，与 PR #16766（Redis mget）合在一起，字典功能的两个主要数据源都获得了批量查询加速：

- **性能**：MySQL 字典的 Column 路径从 O(N) 次数据库往返降为 O(1) 次，10w 行从 18 分钟降至 100 秒
- **安全**：`format_key` 修复了旧版字符串不加引号的 SQL 注入漏洞
- **可维护性**：两组宏（`fetch_single_row_by_sqlx!` / `fetch_all_rows_by_sqlx!`）统一了类型分发逻辑，消除了大量重复的 match 分支

---

## TODO

- [ ] 当前把所有 key 格式化为字符串再拼入 SQL，有额外的类型转换开销；后续计划直接使用 key 的原生 Rust 类型（`bool`、`i32` 等）作为 sqlx 查询参数，进一步降低开销

---

## 参考

- [sqlx query_as 文档](https://docs.rs/sqlx/latest/sqlx/fn.query_as.html)
- [Databend Dictionary 功能介绍](https://docs.databend.com/sql/sql-commands/ddl/dictionary/)
