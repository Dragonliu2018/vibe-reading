---
title: "为 Map 类型实现 Lambda 函数"
source:
  project: "Databend"
  type: "PR"
  id: "16683"
  url: "https://github.com/databendlabs/databend/pull/16683"
  prType: "feat"
date: "2026-07-03"
category: [Database, Databend, Contributions]
tags: ["Databend", "SQL", "Map", "Lambda", "类型系统", "Evaluator"]
description: "实现 map_filter / map_transform_keys / map_transform_values 及其 JSON 变体。"
readingTime: "14 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#16683](https://github.com/databendlabs/databend/pull/16683) · **Issue** [#16639](https://github.com/databendlabs/databend/issues/16639) · **commit** [f6429ae](https://github.com/databendlabs/databend/commit/f6429aed486d8e100a8f8a32c8008319b2913d29) · **首发版本** v1.2.652-nightly · **变更行数** +813 / -57 行 · **合并时间** 2024-10-28

---

## 背景

Databend 在此 PR 之前已支持一套完整的 Array Lambda 函数：`array_filter`、`array_transform`（alias `array_map`、`array_apply`）、`array_reduce`，以及它们对应的 `json_array_*` 系列。

但 Map 类型一直缺少同等能力。当用户需要对一个 Map 做按条件过滤、对 key 或 value 批量变换时，只能：

1. 在应用层把 Map 取出来用代码循环处理，再写回 SQL
2. 拼接复杂的 SQL，用 `map_keys()` + `map_values()` 拆开后再用 `map()` 重新组合

两种方式都很笨拙。Issue #16639 提出需要：

```sql
-- 按条件保留键值对
SELECT map_filter({1:0,2:2,3:-1}, (k, v) -> k > v);
-- 对 key 做变换
SELECT map_transform_keys({1:1,2:2,3:3}, (k, v) -> k + 1);
-- 对 value 做变换
SELECT map_transform_values({1:1,2:2,3:3}, (k, v) -> k + v);
```

这个 PR 实现了上述 3 个 Map Lambda 函数，以及它们对应的 `json_map_*` 版本（操作 `Variant` 类型的 JSON map），共 **6 个新函数**。

---

## 前置知识

### Map 的内部存储结构

Databend 中 `Map(K, V)` 类型的物理存储形如：

```
Column::Map(Box<ArrayColumn>)
       │
       └── ArrayColumn {
               values: Column::Tuple([key_col, value_col]),  ← 键值对平铺存放
               offsets: [0, 2, 5, 5, ...]                   ← 每行包含多少对
           }
```

- **`values`**：所有行的键值对顺序拼接，存为 `Tuple` 列（两个子列：key 列和 value 列）
- **`offsets`**：长度为行数 + 1 的前缀和数组，`offsets[i]..offsets[i+1]` 就是第 `i` 行的键值对范围

例如，一张表有三行 Map 列：`{1:1}`、`{2:1, 1:2}`、`{3:3}`，其存储为：

```
key_col:   [1,   2, 1,   3  ]
value_col: [1,   1, 2,   3  ]
offsets:   [0,   1, 3,   4  ]
```

这种布局与 `Array` 完全对称，差别只在内层是 `Tuple` 而非单列。

### Lambda 函数执行架构

Databend 的 Lambda 函数是**语法层特殊处理**的，并非注册到函数注册表（FunctionRegistry）中的普通函数。整个执行路径分三段：

```
SQL 文本
   │
   ▼
Parser：识别 LambdaFunctionCall（AST 节点）
   │
   ▼
TypeChecker：resolve_lambda_function()
   · 推导参数类型（展开 Array/Map 内层）
   · 推导 lambda 表达式返回类型
   · 确定整个函数的返回类型
   │
   ▼
Evaluator：run_lambda()
   · 把 Array/Map 内层展开成 DataBlock
   · 在展开的 block 上运行 lambda 表达式
   · 按函数语义重组结果列
```

`GENERAL_LAMBDA_FUNCTIONS` 常量数组就是这套机制的入口：函数名在这里登记后，Binder 才会把对应调用路由到 lambda 路径，而不是作为普通函数解析。

---

## 设计参考

Issue #16639 直接引用了 Databricks 文档作为语义参考。三个函数的定义与 Databricks/Spark SQL 对齐：

| 函数 | 语义 | Lambda 签名 | 对标 Databricks |
|---|---|---|---|
| `map_filter` | 保留令 lambda 为 true 的键值对 | `(k, v) -> Boolean` | `map_filter` |
| `map_transform_keys` | 对每个 key 应用变换，返回新 Map | `(k, v) -> new_k` | `transform_keys` |
| `map_transform_values` | 对每个 value 应用变换，返回新 Map | `(k, v) -> new_v` | `transform_values` |

与 `array_filter` / `array_transform` 的差异在于：Map Lambda 的 lambda 总是接受 **两个参数**（k 和 v），而 Array Lambda 只接受一个。这一区别贯穿所有三层改动。

---

## 实现

### 层一：函数名注册

`src/query/functions/src/lib.rs` 中，`GENERAL_LAMBDA_FUNCTIONS` 是一个字符串常量数组，Binder 扫描函数调用时以此判断是否走 lambda 路径：

```rust title="src/query/functions/src/lib.rs"
pub const GENERAL_LAMBDA_FUNCTIONS: [&str; 16] = [
    "array_transform",
    "array_apply",
    "array_map",
    // ...已有的 array_* 和 json_array_* ...
    // 新增 ↓
    "map_filter",
    "map_transform_keys",
    "map_transform_values",
    "json_map_filter",
    "json_map_transform_keys",
    "json_map_transform_values",
];
```

数组大小从 10 扩展到 16，仅此一处改动即可让 Binder 识别新函数名。

### 层二：类型检查（`type_check.rs`）

这是改动最多的一层，`resolve_lambda_function` 方法承担了类型推导的全部工作。

#### 2.1 JSON 系列函数的输入类型转换

`json_map_*` 系列函数接受 `Variant` 类型，但执行时需先转换为具体的 `Map(String, Variant)` 类型，再走对应的 `map_*` 逻辑：

```rust title="src/query/sql/src/planner/semantic/type_check.rs（节选）"
if func_name.starts_with("json_") && !args.is_empty() {
    // 区分 json_array_* 和 json_map_* 的目标类型
    let target_type = if func_name.starts_with("json_array") {
        TypeName::Array(Box::new(TypeName::Variant))
    } else {
        // json_map_* → cast 为 Map(String, Variant)
        TypeName::Map {
            key_type: Box::new(TypeName::String),
            val_type: Box::new(TypeName::Variant),
        }
    };
    let func_name = &func_name[5..]; // 去掉 "json_" 前缀
    let mut new_args = args.to_vec();
    new_args[0] = Expr::Cast {
        span: new_args[0].span(),
        expr: Box::new(new_args[0].clone()),
        target_type,   // 插入显式 Cast 节点
        pg_style: false,
    };
    // 继续走 map_* 的逻辑
    return self.resolve_lambda_function(func_name, &new_args, lambda, span);
}
```

在此之前，`json_*` 逻辑统一把第一个参数转为 `Array(Variant)`，Map 系列需要不同的目标类型，这里做了分支处理。

#### 2.2 参数数量校验的重构

原来的检查逻辑是内联的 if/else，此 PR 把它提取为 `check_lambda_param_count` 方法，并加入了 map 系列（需要 2 个参数）的规则：

```rust title="check_lambda_param_count（新增）"
fn check_lambda_param_count(
    &mut self,
    func_name: &str,
    param_count: usize,
    span: Span,
) -> Result<()> {
    let expected_count = if func_name == "array_reduce" {
        2                           // acc + t
    } else if func_name.starts_with("array") {
        1                           // 单参数
    } else if func_name.starts_with("map") {
        2                           // k + v
    } else {
        unreachable!()
    };

    if param_count != expected_count {
        return Err(ErrorCode::SemanticError(format!(
            "incorrect number of parameters in lambda function, \
             {} expects {} parameter(s), but got {}",
            func_name, expected_count, param_count
        )).set_span(span));
    }
    Ok(())
}
```

用户如果写 `map_filter({...}, k -> k > 0)`（只给一个参数），会得到清晰的错误提示。

#### 2.3 内层类型的展开

Array Lambda 只需取 `Array(T)` 的内层 `T`；Map Lambda 需要从 `Map(K, V)` 中取出 `Tuple([K, V])`，再拆成两个独立的参数类型：

```rust title="内层类型推导（节选）"
let inner_ty = match arg_type.remove_nullable() {
    DataType::Array(box inner_ty) => inner_ty.clone(),
    DataType::Map(box inner_ty) => inner_ty.clone(),     // Map 内层是 Tuple(K, V)
    DataType::Null | DataType::EmptyArray | DataType::EmptyMap => DataType::Null,
    _ => return Err(...),
};

// 展开内层为 lambda 参数类型列表
let inner_tys = if func_name == "array_reduce" {
    vec![max_ty.clone(), max_ty.clone()]
} else if matches!(func_name, "map_filter" | "map_transform_keys" | "map_transform_values") {
    match &inner_ty {
        DataType::Null      => vec![DataType::Null, DataType::Null],
        DataType::Tuple(t)  => t.clone(),   // → [K_type, V_type]
        _ => unreachable!(),
    }
} else {
    vec![inner_ty.clone()]
};
```

Lambda 表达式在这两个类型环境下进行类型检查（k 绑定到 `K_type`，v 绑定到 `V_type`）。

#### 2.4 返回类型计算

三个函数的返回类型各不相同：

```rust title="返回类型推导（节选）"
let return_type = if func_name == "array_filter" || func_name == "map_filter" {
    // filter 不改变类型，直接返回原 Map 类型
    arg_type.clone()
} else if func_name == "map_transform_keys" {
    // key 类型变了，返回 Map(lambda_type, V)
    let map_inner = DataType::Tuple(vec![lambda_type.clone(), inner_tys[1].clone()]);
    wrap_nullable(arg_type, DataType::Map(Box::new(map_inner)))
} else if func_name == "map_transform_values" {
    // value 类型变了，返回 Map(K, lambda_type)
    let map_inner = DataType::Tuple(vec![inner_tys[0].clone(), lambda_type.clone()]);
    wrap_nullable(arg_type, DataType::Map(Box::new(map_inner)))
} else {
    // array_transform 等保持 Array 包装
    wrap_nullable(arg_type, DataType::Array(Box::new(lambda_type.clone())))
};
```

`nullable` 的包裹根据输入类型是否可空来决定，保证类型系统的一致性。

### 层三：执行引擎（`evaluator.rs`）

`run_lambda` 方法的执行分两条路径，对应 Databend 的两种数据模式。

#### 3.1 列批量模式（单列输入时）

当 lambda 函数只有一个参数且为完整列时，可以对所有行的内层数据一次性展开，避免逐行处理：

```
Column::Map(ArrayColumn)
       │ 展开
       ▼
DataBlock { col0: key_col, col1: value_col }   ← 所有行的键值对平铺
       │ 执行 lambda 表达式
       ▼
result_col（长度与键值对总数相同）
       │ 按 func_name 重组
       ▼
Column::Map(新的 ArrayColumn)
```

**map_filter 的 offsets 重建**：过滤后每行包含的键值对数量变了，需要从 bitmap 重算 offsets：

```rust title="map_filter offsets 重建"
let mut new_offset = 0u64;
let mut filtered_offsets = Vec::with_capacity(offsets.len());
filtered_offsets.push(0);
for window in offsets.windows(2) {
    let (start, end) = (window[0] as usize, window[1] as usize);
    let len = end - start;
    let removed = bitmap.null_count_range(start, len);  // 被过滤掉的数量
    new_offset += (len - removed) as u64;
    filtered_offsets.push(new_offset);
}
```

**map_transform_keys 的 key 唯一性检查**：变换后的 key 可能产生重复（如把 `{1:a, 2:b}` 的 key 都映射为 `0`），需要逐行检验：

```rust title="key 唯一性检查"
let mut key_set = HashSet::new();
for window in offsets.windows(2) {
    let (start, end) = (window[0] as usize, window[1] as usize);
    if start == end { continue; }
    key_set.clear();
    for i in start..end {
        let key = unsafe { result_col.index_unchecked(i) };
        if key_set.contains(&key) {
            return Err(ErrorCode::SemanticError(
                "map keys have to be unique".to_string()
            ));
        }
        key_set.insert(key);
    }
}
```

注意 `key_set.clear()` 在每行之间调用——不同行之间 key 可以相同，只有同一行内不能重复。

#### 3.2 行标量模式（多列输入或标量时）

当有多个参数列（map 列 + 其他列）时，无法整体展开，退化为逐行处理。每行的 Map 值是一个 `ScalarRef::Map`：

```rust title="ScalarRef::Map 分支（行模式）"
ScalarRef::Map(col) => {
    let (key_col, value_col) = match col {
        Column::Tuple(t) => (t[0].clone(), t[1].clone()),
        _ => unreachable!(),
    };
    // 把这一行的 key/value 各自作为一列，构成 DataBlock
    let entries = scalars              // 其他参数列（常量展开）
        .into_iter()
        .map(|(scalar, ty)| BlockEntry::new_const_column(ty, scalar, col_len))
        .chain([key_col.clone().into(), value_col.clone().into()])
        .collect();
    let block = DataBlock::new(entries, col_len);

    let result_col = self.eval_lambda_block(&block, &expr)?;
    let val = match func_name {
        "map_filter" => { /* 过滤 key/value */ ... }
        "map_transform_keys" => { /* 替换 key */ ... }
        "map_transform_values" => { /* 替换 value */ ... }
        _ => unreachable!(),
    };
    builder.push(val.as_ref());
}
```

两条路径的语义完全一致，列模式是行模式的向量化批量优化版本。

---

## 测试

### 单元测试

`src/query/ast/tests/it/parser.rs` 新增三个 snapshot 用例，验证三个函数的 AST 解析正确：

```rust title="src/query/ast/tests/it/parser.rs"
r#"MAP_FILTER({1:1,2:2,3:4}, (k, v) -> k > v)"#,
r#"MAP_TRANSFORM_KEYS({1:10,2:20,3:30}, (k, v) -> k + 1)"#,
r#"MAP_TRANSFORM_VALUES({1:10,2:20,3:30}, (k, v) -> v + 1)"#,
```

解析结果以 `testdata/expr.txt` 形式固化，新增 395 行快照内容。

### 回归测试

`tests/sqllogictests/suites/query/functions/02_0074_function_map.test` 新增 127 行，覆盖：

| 场景 | 说明 |
|---|---|
| 字面量 Map 的基本用法 | 三个函数的基础语法验证 |
| nullable value 场景 | `{1:null, 2:2}` 中 null 的处理 |
| key/value 类型混用 | 用 value 类型推导 key 的变换 |
| 空 Map `{}` | 边界条件 |
| 表列输入 | `map_lambda_test` 表的 col1/col2 |
| 错误场景 | lambda 返回非 boolean（error 1065）、类型不兼容（error 1006）、key 重复 |
| JSON variant 版本 | `json_map_transform_keys/values/filter` |

其中一个有代表性的错误测试：

```sql title="key 重复时报错"
-- {2:1, 1:2} map 所有行的 key 相加后会产生重复
statement error 1006
select map_transform_keys(col1, (k, v) -> k + v) from map_lambda_test;
```

---

## 意义与影响

这个 PR 填补了 Databend 在 Map 类型上 **函数式操作** 的空白：

- **表达力**：`map_filter` + `map_transform_keys` + `map_transform_values` 构成了对 Map 的完整 functional pipeline，无需把数据拉到应用层处理
- **类型安全**：类型检查阶段静态确定返回 Map 的 key/value 类型，不依赖运行时推断
- **JSON 兼容**：通过 cast 复用 map_* 实现，`json_map_*` 系列零额外执行代码，维护成本极低
- **架构复用**：整体沿用了 Array Lambda 已有的执行框架（`run_lambda` → `eval_lambda_block`），新代码主要是 Map 特有的拆包/重组逻辑，而非重新发明执行引擎

---

## 参考

- [Databricks map_filter 文档](https://docs.databricks.com/en/sql/language-manual/functions/map_filter.html)
- [Databricks transform_keys 文档](https://docs.databricks.com/en/sql/language-manual/functions/transform_keys.html)
- [Databricks transform_values 文档](https://docs.databricks.com/en/sql/language-manual/functions/transform_values.html)
