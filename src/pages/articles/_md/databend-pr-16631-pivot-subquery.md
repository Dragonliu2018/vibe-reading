---
title: "PIVOT/UNPIVOT 支持子查询"
source:
  project: "Databend"
  type: "PR"
  id: "16631"
  url: "https://github.com/databendlabs/databend/pull/16631"
date: "2026-07-02"
category: [Database, Databend, 源码解读]
tags: ["Databend", "SQL", "PIVOT", "子查询", "AST", "Binder"]
description: "深入解析 Databend 如何扩展 PIVOT 语法以支持子查询——从 AST 枚举设计、Parser 改造，到 Binder 中运行时执行子查询并回填列值的完整实现链路。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#16631](https://github.com/databendlabs/databend/pull/16631) · **Issue** [#16556](https://github.com/databendlabs/databend/issues/16556) · **commit** [4557131](https://github.com/databendlabs/databend/commit/4557131b0ef4e37b9c76f7b8c27254b04378c58a) · **合并分支** v1.2.647-nightly · **变更行数** +1,389 / -187 行 · **合并时间** 2024-10-20

---

## 背景

`PIVOT` 和 `UNPIVOT` 是行列转换的 SQL 语法，在数据分析场景下极为常用。在此 PR 之前，Databend 的 `PIVOT` 只允许在 `IN (...)` 子句里写**字面量列表**：

```sql title="旧语法——只支持硬编码列值"
SELECT *
FROM monthly_sales
PIVOT(SUM(amount) FOR month IN ('JAN', 'FEB', 'MAR', 'APR'));
```

这意味着用户必须事先知晓所有枚举值，并把它们硬编码进 SQL。一旦枚举值来自另一张表、或需要动态确定，就只能在应用层拼 SQL——既繁琐又容易注入。

Issue #16556 反映了这一痛点。此 PR 通过以下三种新语法完整解决了这个问题：

1. **`FROM` 子查询**：数据来源本身是子查询，`IN` 仍为字面量。
2. **`IN` 子查询**：数据来源为普通表，`IN` 里放子查询。
3. **双重子查询**：数据来源和 `IN` 都是子查询。

与此同时，`UNPIVOT` 的 `FROM` 子查询支持也在此 PR 中一并实现，保持了与 Snowflake 的兼容性（UNPIVOT 的 `IN` 子查询则暂不支持）。

---

## 前置知识

### PIVOT 的语义

`PIVOT` 的作用是将某一列的多个**行值**转换成多个**列**，并对每列进行聚合：

```sql title="PIVOT 基础语义"
SELECT *
FROM monthly_sales
PIVOT(SUM(amount) FOR month IN ('JAN', 'FEB', 'MAR', 'APR'));
-- 等价于：
SELECT empid,
  SUM_IF(amount, month='JAN') AS jan,
  SUM_IF(amount, month='FEB') AS feb,
  ...
FROM monthly_sales
GROUP BY empid;
```

Databend 的 PIVOT 实现走的是**语法脱糖（desugaring）**路径：在 Binder 阶段把 `PIVOT` 重写成等价的 `SELECT + GROUP BY` 语句，再走正常的 planner 流程。核心入口在 `SelectRewriter::rewrite_pivot()`。

### Databend SQL 查询处理分层

```
SQL 字符串
  └─ Parser（nom 解析器）→ AST
       └─ Binder（语义绑定）→ Logical Plan（SExpr）
            └─ Optimizer → Physical Plan
                 └─ Pipeline 执行引擎
```

本 PR 的改动主要集中在前两层：**AST 数据结构**和 **Binder 的 SelectRewriter**。

---

## 设计参考

Snowflake 是此功能的主要参考对象（Databend 在语法上与 Snowflake 高度兼容）：

| 特性 | Snowflake | Databend（此 PR 后） |
| --- | --- | --- |
| `FROM` 普通表 + `IN` 字面量 | ✅ | ✅ |
| `FROM` 子查询 + `IN` 字面量 | ✅ | ✅（新增） |
| `FROM` 普通表 + `IN` 子查询 | ✅ | ✅（新增，PIVOT 专属） |
| `FROM` 子查询 + `IN` 子查询 | ✅ | ✅（新增，PIVOT 专属） |
| UNPIVOT `FROM` 子查询 | ✅ | ✅（新增） |
| UNPIVOT `IN` 子查询 | ❌ | ❌（未实现，与 Snowflake 一致） |

---

## 实现

整个实现由四个紧密协作的层次组成，下面逐层展开。

### 第一层：AST 枚举扩展

**文件**：`src/query/ast/src/ast/query.rs`

改动的核心是引入一个新枚举 `PivotValues`，让 `Pivot` 结构体的 `values` 字段从固定的 `Vec<Expr>` 变成"要么是列值列表，要么是子查询"：

```rust title="src/query/ast/src/ast/query.rs — PivotValues 新枚举"
// 新增
#[derive(Debug, Clone, PartialEq, Drive, DriveMut)]
pub enum PivotValues {
    ColumnValues(Vec<Expr>),
    Subquery(Box<Query>),
}

// 修改前：pub values: Vec<Expr>
pub struct Pivot {
    pub aggregate: Expr,
    pub value_column: Identifier,
    pub values: PivotValues,   // 修改后
}
```

`Display` 的实现同步更新，能正确打印两种形式：

```rust title="Pivot::fmt — 对两种 values 变体分发"
impl Display for Pivot {
    fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {
        write!(f, "PIVOT({} FOR {} IN (", self.aggregate, self.value_column)?;
        match &self.values {
            PivotValues::ColumnValues(col_values) => {
                write_comma_separated_list(f, col_values)?;
            }
            PivotValues::Subquery(subquery) => {
                write!(f, "{}", subquery)?;
            }
        }
        write!(f, "))")?;
        Ok(())
    }
}
```

另一个重要改动是 `TableReference::Subquery` 变体新增了 `pivot` 和 `unpivot` 字段：

```rust title="TableReference::Subquery — 新增 pivot/unpivot 字段"
TableReference::Subquery {
    span: Span,
    lateral: bool,
    subquery: Box<Query>,
    alias: Option<TableAlias>,
    pivot: Option<Box<Pivot>>,    // 新增
    unpivot: Option<Box<Unpivot>>, // 新增
},
```

同时把 `pivot()` 和 `unpivot()` 两个辅助方法扩展为同时匹配 `Table` 和 `Subquery` 两种变体，这样上层代码无需关心数据来源是表还是子查询。

---

### 第二层：Parser 改造

**文件**：`src/query/ast/src/parser/query.rs`

改动有两处：

**① 把 `pivot`/`unpivot` 提升为独立函数**

原来 `pivot` 和 `unpivot` 是 `table_reference_element` 内的局部闭包，现在提升为模块级函数，以便在 `subquery` 规则里复用：

```rust title="parser/query.rs — pivot 独立函数（节选）"
fn pivot(i: Input) -> IResult<Pivot> {
    map(
        rule! {
            PIVOT ~ "(" ~ #expr ~ FOR ~ #ident ~ IN ~ "(" ~ #pivot_values ~ ")" ~ ")"
        },
        |(_pivot, _, aggregate, _for, value_column, _in, _, values, _, _)| Pivot {
            aggregate,
            value_column,
            values,
        },
    )(i)
}
```

注意 `IN (...)` 内部现在解析的是 `#pivot_values` 而不是 `#comma_separated_list1(expr)`——这正是支持子查询的关键。

**② 新增 `pivot_values` 规则**

```rust title="pivot_values 解析规则"
fn pivot_values(i: Input) -> IResult<PivotValues> {
    alt((
        map(query, |q| PivotValues::Subquery(Box::new(q))),
        map(comma_separated_list1(expr), PivotValues::ColumnValues),
    ))(i)
}
```

`alt` 先尝试解析子查询，失败则回退到逗号分隔的表达式列表。顺序很重要——子查询以 `SELECT`/`WITH` 关键字开头，与字面量表达式不会产生歧义。

**③ 子查询规则新增 `pivot`/`unpivot`**

```rust title="subquery 规则扩展"
let subquery = map(
    rule! {
        LATERAL? ~ "(" ~ #query ~ ")" ~ #table_alias? ~ #pivot? ~ #unpivot?
    },
    |(lateral, _, subquery, _, alias, pivot, unpivot)| {
        TableReferenceElement::Subquery {
            lateral: lateral.is_some(),
            subquery: Box::new(subquery),
            alias,
            pivot: pivot.map(Box::new),
            unpivot: unpivot.map(Box::new),
        }
    },
);
```

至此，`(SELECT ...) PIVOT(...)` 和 `(SELECT ...) UNPIVOT(...)` 都能被正确解析。

---

### 第三层：Binder — SelectRewriter 扩展

**文件**：`src/query/sql/src/planner/binder/bind_query/bind_select.rs`

这是改动最大的一层，也是实现的核心。

#### QueryExecutor 注入

`SelectRewriter` 新增一个字段 `subquery_executor`，用于在重写阶段同步执行子查询：

```rust title="SelectRewriter — 新增 subquery_executor 字段"
struct SelectRewriter<'a> {
    column_binding: &'a [ColumnBinding],
    new_stmt: Option<SelectStmt>,
    is_unquoted_ident_case_sensitive: bool,
    subquery_executor: Option<Arc<dyn QueryExecutor>>,  // 新增
}

impl<'a> SelectRewriter<'a> {
    pub fn with_subquery_executor(
        mut self,
        subquery_executor: Option<Arc<dyn QueryExecutor>>,
    ) -> Self {
        self.subquery_executor = subquery_executor;
        self
    }
}
```

`Binder` 在构建 `SelectRewriter` 时把自身持有的 `subquery_executor` 传递进去：

```rust title="Binder::bind_select — 注入 executor"
let mut rewriter =
    SelectRewriter::new(self.name_resolution_ctx.unquoted_ident_case_sensitive)
        .with_subquery_executor(self.subquery_executor.clone());
```

#### rewrite_pivot 核心逻辑

`rewrite_pivot` 在遇到 `PivotValues::Subquery` 时，先**同步执行**子查询，再把结果转换成字面量列表，最终复用原有的列值处理逻辑：

```rust title="SelectRewriter::rewrite_pivot — 两路分发"
match &pivot.values {
    PivotValues::ColumnValues(values) => {
        self.process_pivot_column_values(
            pivot, values, &new_aggregate_name,
            aggregate_args, &mut new_select_list, stmt,
        )?;
    }
    PivotValues::Subquery(subquery) => {
        let query_sql = subquery.to_string();
        if let Some(executor) = &self.subquery_executor {
            // 同步执行子查询（在异步运行时内用 block_on）
            let data_blocks = databend_common_base::runtime::block_on(async move {
                executor.execute_query_with_sql_string(&query_sql).await
            })?;
            // 提取列值，转换为字面量
            let values = self.extract_column_values_from_data_blocks(
                &data_blocks, subquery.span
            )?;
            // 复用列值路径
            self.process_pivot_column_values(
                pivot, &values, &new_aggregate_name,
                aggregate_args, &mut new_select_list, stmt,
            )?;
        } else {
            return Err(ErrorCode::Internal(
                "SelectRewriter's Subquery executor is not set",
            ));
        }
    }
}
```

#### 结果列值提取与验证

`extract_column_values_from_data_blocks` 对子查询结果施加两条约束，并将满足条件的行值逐一包装成 `Expr::Literal`：

```rust title="extract_column_values_from_data_blocks — 约束校验"
fn extract_column_values_from_data_blocks(
    &self,
    data_blocks: &[DataBlock],
    span: Span,
) -> Result<Vec<Expr>> {
    let mut values: Vec<Expr> = vec![];
    for block in data_blocks {
        // 约束1：子查询必须只返回一列
        if block.num_columns() != 1 {
            return Err(ErrorCode::SemanticError(
                "The subquery of `pivot in` must return one column",
            ).set_span(span));
        }
        let columns = block.columns();
        for row in 0..block.num_rows() {
            match columns[0].value.index(row).unwrap() {
                ScalarRef::String(s) => {
                    // 约束2：列值必须是字符串类型
                    values.push(Expr::Literal {
                        span,
                        value: Literal::String(s.to_string()),
                    });
                }
                _ => {
                    return Err(ErrorCode::SemanticError(
                        "The subquery of `pivot in` must return a string type",
                    ).set_span(span));
                }
            }
        }
    }
    Ok(values)
}
```

这两条限制（单列 + 字符串类型）与 PIVOT 的语义一致——`IN` 子句的枚举值最终要作为列名，必须是字符串。

#### 整体数据流

```
SQL 文本: FROM t PIVOT(... IN (SELECT DISTINCT month FROM t))
  │
  ▼ Parser
AST: Pivot { values: PivotValues::Subquery(Query{...}) }
  │
  ▼ SelectRewriter::rewrite_pivot
  ├─ subquery.to_string() → "SELECT DISTINCT month FROM t"
  ├─ QueryExecutor::execute_query_with_sql_string(sql)
  │    └─ 返回 DataBlock[{ month: "JAN" }, { month: "FEB" }, ...]
  ├─ extract_column_values → [Literal("JAN"), Literal("FEB"), ...]
  └─ process_pivot_column_values（与原字面量路径完全相同）
       └─ 生成等价 SELECT + GROUP BY AST
  │
  ▼ 后续 Binder + Optimizer + 执行引擎（正常路径）
```

---

### 第四层：QueryExecutor trait 统一

**文件**：`src/query/sql/src/planner/query_executor.rs`  
**文件**：`src/query/service/src/schedulers/scheduler.rs`

此 PR 顺手做了一次清理：把原来仅用于动态采样的 `QuerySampleExecutor` trait 重命名为更通用的 `QueryExecutor`，并新增了 `execute_query_with_sql_string` 方法：

```rust title="query_executor.rs — 统一的 QueryExecutor trait"
#[async_trait]
pub trait QueryExecutor: Send + Sync {
    // 原有方法（用于动态采样）
    async fn execute_query_with_physical_plan(
        &self,
        plan: &PhysicalPlan,
    ) -> Result<Vec<DataBlock>>;

    // 新增方法（用于 PIVOT 子查询执行）
    async fn execute_query_with_sql_string(&self, sql: &str) -> Result<Vec<DataBlock>>;
}
```

`ServiceQueryExecutor` 实现了新方法——直接调用 `Planner::plan_sql` + `InterpreterFactory`，走完整的执行链路：

```rust title="ServiceQueryExecutor — execute_query_with_sql_string 实现"
async fn execute_query_with_sql_string(&self, query_sql: &str) -> Result<Vec<DataBlock>> {
    let mut planner = Planner::new(self.ctx.clone());
    let (plan, _) = planner.plan_sql(query_sql).await?;
    let interpreter = InterpreterFactory::get(self.ctx.clone(), &plan).await?;
    let stream = interpreter.execute(self.ctx.clone()).await?;
    let blocks = stream.try_collect::<Vec<_>>().await?;
    Ok(blocks)
}
```

---

## 测试

PR 在 `tests/sqllogictests/suites/query/` 下新增了两个测试文件的用例。

### pivot.test — 新增 5 个测试

```sql title="tests/sqllogictests/suites/query/pivot.test — 三种新语法"
-- 1. FROM 子查询 + IN 字面量
SELECT empid,jan,feb,mar,apr FROM (
    SELECT * FROM (SELECT * FROM monthly_sales)
        PIVOT(SUM(amount) FOR MONTH IN ('JAN', 'FEB', 'MAR', 'APR'))
    ORDER BY EMPID
);

-- 2. FROM 普通表 + IN 子查询
SELECT empid,jan,feb,mar,apr FROM (
    SELECT * FROM monthly_sales
        PIVOT(SUM(amount) FOR MONTH IN (SELECT DISTINCT month FROM monthly_sales))
    ORDER BY EMPID
);

-- 3. FROM 子查询 + IN 子查询（双重子查询）
SELECT empid,jan,feb,mar,apr FROM (
    SELECT * FROM (SELECT * FROM monthly_sales)
        PIVOT(SUM(amount) FOR MONTH IN (SELECT DISTINCT month FROM monthly_sales))
    ORDER BY EMPID
);
```

另外还有两个**错误路径**测试，验证语义约束：

```sql title="错误路径：IN 子查询违反约束"
-- 错误1：子查询返回多列（应报 error 1065）
PIVOT(SUM(amount) FOR MONTH IN (SELECT DISTINCT month, month FROM monthly_sales))

-- 错误2：子查询返回非字符串类型（应报 error 1065）
PIVOT(SUM(amount) FOR MONTH IN (SELECT DISTINCT empid FROM monthly_sales))
```

### unpivot.test — 新增 1 个测试

```sql title="tests/sqllogictests/suites/query/unpivot.test — FROM 子查询"
SELECT empid,dept,month,sales FROM (
    SELECT * FROM (SELECT * FROM monthly_sales_1)
        UNPIVOT(sales FOR month IN (jan, feb, mar, april))
    ORDER BY empid
);
```

所有测试均为 Logic Test（对齐预期输出行），不含 Unit Test。

---

## 意义与影响

### 功能完整性

此 PR 使 Databend 的 `PIVOT` 语法达到与 Snowflake 同等的表达能力。用户可以直接在 SQL 里写动态枚举，无需在应用层预先查询枚举值并拼接 SQL，大幅简化了复杂数据分析场景的查询写法。

### 架构设计

`PivotValues` 枚举是一个优雅的开闭设计：新增变体不影响已有的 `ColumnValues` 路径，Binder 的核心重写逻辑 `process_pivot_column_values` 被提取为独立函数后两条路径共用，避免了代码重复。

`QueryExecutor` trait 的统一也值得关注——原来 `QuerySampleExecutor` 仅服务于优化器的动态采样，此次扩展后 `execute_query_with_sql_string` 让 Binder 层也可以"在绑定期间执行子查询"，为未来更多类似的编译期执行场景（如常量折叠子查询、TTL 表达式求值等）打下了基础。

### 执行时机的权衡

PIVOT `IN` 子查询的执行发生在**绑定阶段**（而非执行阶段），通过 `block_on` 在同步上下文中调用异步执行器。这意味着：

- **优点**：子查询结果在 plan 阶段就确定，后续优化器可以看到完整的列列表，生成最优计划。
- **限制**：`IN` 子查询**不能引用外层查询的列**（因为外层查询此时还没有执行），只能是独立的子查询。这与 Snowflake 的行为一致。

---

## 参考

- [PR #16631](https://github.com/databendlabs/databend/pull/16631) — fix(query): support subquery in pivot
- [Issue #16556](https://github.com/databendlabs/databend/issues/16556) — PIVOT subquery 需求原始 Issue
- [Snowflake PIVOT 文档](https://docs.snowflake.com/en/sql-reference/constructs/pivot) — Databend 对齐的语法参考
- [Snowflake UNPIVOT 文档](https://docs.snowflake.com/en/sql-reference/constructs/unpivot) — UNPIVOT 行为参考
- [Databend PIVOT 文档](https://docs.databend.com/sql/sql-commands/query-syntax/query-pivot) — 官方语法说明
