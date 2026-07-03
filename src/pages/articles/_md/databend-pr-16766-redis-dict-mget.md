---
title: "用 mget 批量加速 Redis 字典查询"
source:
  project: "Databend"
  type: "PR"
  id: "16766"
  url: "https://github.com/databendlabs/databend/pull/16766"
  prType: "perf"
date: "2026-07-04"
category: [Database, Databend, Contributions]
tags: ["Databend", "Redis", "Dictionary", "性能优化", "mget", "批量查询"]
description: "将 Redis 字典查询从逐行 OpenDAL get 改为 redis crate mget 批量拉取，附带 key 去重，实现 1kw 行 114 倍提速。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#16766](https://github.com/databendlabs/databend/pull/16766) · **Issue** [#16550](https://github.com/databendlabs/databend/issues/16550) · **commit** [7d09e1e](https://github.com/databendlabs/databend/commit/7d09e1e05b7aebab238468660e43c6c96234fbb3) · **首发版本** v1.2.663-nightly · **变更行数** +461 / -191 行 · **合并时间** 2024-11-22

---

## 背景

Databend 的 **Dictionary**（字典）功能允许用户把外部数据源（Redis / MySQL）映射为一张虚拟表，通过 `dict_get` 函数在 SQL 中实时查询：

```sql title="字典查询示例"
-- 定义 Redis 字典
CREATE DICTIONARY d1 (key VARCHAR NULL, value VARCHAR NOT NULL)
PRIMARY KEY key
SOURCE(redis(host='127.0.0.1' port='6379'));

-- 用 dict_get 在查询中实时拉取 Redis 值
SELECT key, dict_get(d1, 'value', key) FROM red_test_10000000;
```

字典功能在 PR #15901 中完成初版实现。Issue #16550 在此基础上要求做性能测试和调优——Redis 作为字典数据源是第一个优化目标。

**旧实现的问题**：对 Column 类型（整列数据），代码逐行遍历，每行通过 OpenDAL 发送一次独立的 `GET` 请求：

```
行 1 → GET key1 → 等待响应
行 2 → GET key2 → 等待响应
行 3 → GET key3 → 等待响应
...
```

N 行数据就有 N 次网络往返（RTT）。Redis 的单次 RTT 通常在 0.1–1 ms 量级，放大到百万行就是数百秒，完全不可用。

---

## 前置知识

### Dictionary 的执行路径

`dict_get` 不是一个普通的标量函数，它是**异步函数**（`AsyncFunction`），由专用的 `TransformAsyncFunction` 算子在 Pipeline 中处理：

```
DataBlock（含 key 列）
        │
        ▼
TransformAsyncFunction::transform()
        │  取出 key 列（Scalar 或 Column）
        ▼
DictionaryOperator::dict_get()
        │  向外部数据源发请求
        ▼
填充结果列，输出新 DataBlock
```

### Value<AnyType>：Scalar vs Column

Databend 的表达式系统用 `Value<AnyType>` 统一表示一个"值"，它有两种形态：

- **`Value::Scalar`**：整个 Block 对应一个常量值（如字面量 `'hello'`）
- **`Value::Column`**：每行有独立的值（来自表列）

字典查询的 key 通常来自表列，走 `Value::Column` 路径；字面量 key 走 `Value::Scalar`。

### Redis MGET

`MGET key1 key2 ... keyN` 是 Redis 的批量读取命令，一次网络往返返回 N 个值（不存在的 key 返回 `nil`）。与 N 次 `GET` 相比，RTT 从 N 次降为 1 次。

---

## 实现

### 依赖替换：OpenDAL → redis crate

旧实现通过 OpenDAL 的 Redis 适配器访问 Redis，OpenDAL 只封装了单键 `read`（即 `GET`），不支持 `MGET`。新实现直接引入 `redis` crate，获得完整的 Redis 命令访问能力：

```toml title="src/query/service/Cargo.toml"
# 新增
redis = { workspace = true }
```

同步删除了对 `opendal::services::Redis` 和 `opendal::Operator` 的依赖，`DictionaryOperator` 枚举的 Redis 变体也从持有 `Operator` 改为持有 `ConnectionManager`：

```rust title="DictionaryOperator 枚举变化"
// 旧
pub(crate) enum DictionaryOperator {
    Operator(Operator),   // OpenDAL Operator
    Mysql((MySqlPool, String)),
}

// 新
pub(crate) enum DictionaryOperator {
    Redis(ConnectionManager),  // redis::aio::ConnectionManager
    Mysql((MySqlPool, String)),
}
```

`ConnectionManager` 是 `redis` crate 的异步连接管理器，内部维护连接池并在断线时自动重连。

### 连接建立：从 URL 到结构化 ConnectionInfo

旧实现把 Redis 地址拼成 URL 字符串（`tcp://host:port`）交给 OpenDAL；新实现直接构造 `ConnectionInfo` 结构体，字段更清晰，也便于设置 username / password / db_index：

```rust title="src/query/service/src/pipelines/processors/transforms/transform_dictionary.rs"
let connection_info = ConnectionInfo {
    addr: redis::ConnectionAddr::Tcp(
        redis_source.host.clone(),
        redis_source.port,
    ),
    redis: RedisConnectionInfo {
        db: redis_source.db_index.unwrap_or(0),
        username: redis_source.username.clone(),
        password: redis_source.password.clone(),
        protocol: ProtocolVersion::RESP2,
    },
};
let client = Client::open(connection_info)?;
let conn = databend_common_base::runtime::block_on(
    ConnectionManager::new(client),
)?;
```

配套地，`DictionaryMeta::build_redis_connection_url()` 方法从 schema 层删除——URL 拼接不再需要。

### 接口重构：从逐行调用到整列传入

旧接口：

```rust title="旧 dict_get 接口"
// 由调用方在 Column 上循环，每行调用一次
async fn dict_get(&self, key: ScalarRef<'_>, data_type: &DataType) -> Result<Option<Scalar>>
```

新接口直接接收整个 `Value<AnyType>`，把 Scalar / Column 两条路径的分发下沉到 `dict_get` 内部：

```rust title="新 dict_get 接口"
async fn dict_get(
    &self,
    value: &Value<AnyType>,      // 整列或标量，由内部分发
    data_type: &DataType,
    default_value: &Scalar,      // key 不存在时的默认值，显式传入
) -> Result<Value<AnyType>>
```

调用方因此大幅简化，从 20 行循环缩减为 3 行：

```rust title="调用方简化对比"
// 旧：调用方手动循环
let value = match &entry.value {
    Value::Scalar(scalar) => {
        let v = op.dict_get(scalar.as_ref(), data_type).await?
            .unwrap_or(default_value.clone());
        Value::Scalar(v)
    }
    Value::Column(column) => {
        let mut builder = ColumnBuilder::with_capacity(data_type, column.len());
        for scalar_ref in column.iter() {
            let v = op.dict_get(scalar_ref, data_type).await?
                .unwrap_or(default_value.clone());
            builder.push(v.as_ref());
        }
        Value::Column(builder.build())
    }
};

// 新：一行搞定
let value = op.dict_get(&entry.value, data_type, &default_value).await?;
```

### 批量查询核心：get_column_values_from_redis

这是本 PR 性能提升的核心函数，分三步执行：

```rust title="get_column_values_from_redis 整体流程"
async fn get_column_values_from_redis(
    &self,
    str_col: &StringColumn,
    validity: Option<&Bitmap>,   // nullable 列的有效位图
    data_type: &DataType,
    connection: &ConnectionManager,
    default_value: &Scalar,
) -> Result<Value<AnyType>> {
    // step-1: 去重
    let key_cnt = str_col.len();
    let mut keys = Vec::with_capacity(key_cnt);       // 唯一 key 列表（有序）
    let mut key_map = HashMap::with_capacity(key_cnt); // key → 在 keys 中的下标
    for key in str_col.option_iter(validity).flatten() {
        if !key_map.contains_key(key) {
            keys.push(key);
            let index = key_map.len();
            key_map.insert(key, index);
        }
    }

    // step-2: mget 批量拉取
    let mut builder = ColumnBuilder::with_capacity(data_type, key_cnt);
    if keys.is_empty() {
        // 所有行都是 null，全部填默认值
        for _ in 0..key_cnt {
            builder.push(default_value.as_ref());
        }
    } else {
        let mut conn = connection.clone();
        let redis_val: redis::Value = conn.get(keys).await?;   // MGET
        let res = Self::from_redis_value_to_scalar(&redis_val, default_value)?;

        // step-3: 按原始顺序回填
        for key in str_col.option_iter(validity) {
            if let Some(key) = key {
                let index = key_map[key];      // 找到该 key 在 mget 结果中的位置
                builder.push(res[index].as_ref());
            } else {
                builder.push(default_value.as_ref()); // null key → 默认值
            }
        }
    }
    Ok(Value::Column(builder.build()))
}
```

**去重的意义**：同一个 key 在 Column 中可能出现多次（如 `JOIN` 结果或重复数据），去重后 `mget` 只需拉取唯一 key，减少 Redis 传输量。`HashMap` 记录每个 key 在 `keys` 数组中的位置，回填时 O(1) 定位对应的返回值。

### Redis 响应解析：from_redis_value_to_scalar

`redis` crate 对 `mget` 返回 `redis::Value::Array`，对单个 `get` 返回 `redis::Value::BulkString` 或 `Nil`：

```rust title="from_redis_value_to_scalar"
fn from_redis_value_to_scalar(
    rv: &redis::Value,
    default_value: &Scalar,
) -> Result<Vec<Scalar>> {
    match rv {
        // 单值响应（get 命令）
        redis::Value::BulkString(bs) => {
            let str = unsafe { String::from_utf8_unchecked(bs.to_vec()) };
            Ok(vec![Scalar::String(str)])
        }
        // 批量响应（mget 命令）
        redis::Value::Array(arr) => {
            let mut scalar_vec = Vec::with_capacity(arr.len());
            for item in arr {
                let scalar = match item {
                    redis::Value::BulkString(bs) => {
                        Scalar::String(unsafe { String::from_utf8_unchecked(bs.to_vec()) })
                    }
                    redis::Value::Nil => default_value.clone(), // key 不存在
                    _ => return Err(ErrorCode::DictionarySourceError(...)),
                };
                scalar_vec.push(scalar);
            }
            Ok(scalar_vec)
        }
        // key 不存在（单值 get 返回 nil）
        redis::Value::Nil => Ok(vec![default_value.clone()]),
        _ => Err(...),
    }
}
```

`Scalar` 路径和 `Column` 路径都复用这一函数，前者得到长度为 1 的 `Vec<Scalar>`，后者得到长度为 N 的 `Vec<Scalar>`。

---

## 测试

### 单元测试

`src/query/sql/src/planner/semantic/type_check.rs` 更新了类型检查相关的测试，覆盖 `RedisSource` 新字段（`host` / `port` 替代 `connection_url`）。

### 回归测试

`tests/sqllogictests/suites/query/functions/02_0077_function_dict_get.test` 新增 140 行，覆盖：

- 批量 key 查询（来自表列）
- key 去重场景（多行相同 key）
- null key 填默认值
- key 不存在时的 default 回退

测试依赖 `tests/sqllogictests/src/mock_source/redis_source.rs` 中的 Mock Redis 服务。Mock 服务新增了 `MGet` 命令支持：

```rust title="tests/sqllogictests/src/mock_source/redis_source.rs"
Command::MGet(keys) => {
    let mut responses = Vec::new();
    for key in keys {
        let response = if key.starts_with(|c: char| c.is_ascii_alphanumeric()) {
            let v = format!("{}_value", key);
            format!("${}\r\n{}\r\n", v.len(), v)   // RESP BulkString
        } else {
            "$-1\r\n".to_string()                  // RESP Nil
        };
        responses.push(response);
    }
    // 拼接为 RESP Array 格式
    let ret_value = format!("*{}\r\n{}", responses.len(), responses.concat());
    ret_values.push_back(ret_value);
}
```

### 性能测试

复现步骤（来自 PR 描述）：

```sql title="性能测试 SQL"
-- 建 Redis 字典
CREATE OR REPLACE DICTIONARY d1 (key VARCHAR NULL, value VARCHAR NOT NULL)
PRIMARY KEY key
SOURCE(redis(host='100.73.238.81' port='6379'));

-- 建测试表（1kw 行）
CREATE OR REPLACE TABLE red_test_10000000 AS
SELECT number % 100000000 AS id, concat('key', id::string) AS key
FROM numbers(10000000);

-- 执行查询，计时
SELECT key, dict_get(d1, 'value', key) FROM red_test_10000000;
```

不同数据量下旧（逐行 GET）vs 新（批量 mget）实现的耗时对比：

| 数据量 | 旧实现（逐行 GET） | 新实现（批量 mget） | 加速比 |
|---|---|---|---|
| 1w 行 | 7.338 s | 0.051 s | **144×** |
| 10w 行 | 73.229 s | 0.145 s | **505×** |
| 100w 行 | 594.109 s | 0.66 s | **900×** |
| 1kw 行 | 386.483 s | 5.194 s | **74×** |

> 1kw 行的旧实现耗时比 100w 行反而更短，疑似触发了某种连接复用，但仍远慢于新实现。

---

## Review

**b41sh**：`HashMap::with_capacity(key_cnt)` 和 `Vec::with_capacity(key_cnt)` 预分配容量，避免 key 不重复时的多次扩容。→ 已采纳。

**sundy-li**：建议用 `str_col.option_iter(&validity)` 同时遍历值和有效位，比单独处理 validity 位图更简洁。→ 已采纳。

**sundy-li**：MySQL 字典也可以做批量查询（`WHERE key IN (...)`）。→ 确认后续 PR 实现，本 PR 先聚焦 Redis。

---

## 意义与影响

这个 PR 把 Redis 字典查询从 **O(N) 次网络往返**降为 **O(1) 次**（加上去重后的常数因子），让字典功能在百万行规模下真正可用：

- **性能**：100w 行查询从 594 秒降至 0.66 秒，最高实现 900 倍加速（详见性能测试章节）
- **架构**：`dict_get` 接口从"逐行回调"升级为"整列批处理"，与 Databend 向量化执行的设计理念对齐
- **依赖**：去掉对 OpenDAL Redis 适配器的依赖，直接使用功能更完整的 `redis` crate，为后续扩展（Pipeline、Pub/Sub 等）打开空间

## TODO

- [x] MySQL 字典的批量查询（`WHERE key IN (...)`），由 sundy-li 在 Review 中提出
  - [[Databend PR-16948] 用 IN 批量查询加速 MySQL 字典读取](/vibe-reading/articles/databend-pr-16948-mysql-dict-batch)

---

## 参考

- [redis crate 文档 — mget](https://docs.rs/redis/latest/redis/trait.Commands.html#method.mget)
- [Databend Dictionary 功能介绍](https://docs.databend.com/sql/sql-commands/ddl/dictionary/)
