---
source:
  type: "源码解读"
  project: "DuckDB"
  url: "https://github.com/duckdb/duckdb"
title: "Parser"
date: "2026-08-22T14:18:13+08:00"
category: [Database, OLAP, DuckDB, CodeWiki, "1.5.5"]
tags: ["DuckDB", "C++", "Parser", "libpg_query", "AST"]
description: "DuckDB Parser 模块——基于 PostgreSQL libpg_query 的 SQL 解析器，SQL string → PG AST → DuckDB AST 的两阶段转换。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/DuckDB/CodeWiki/1.5.5/00-overview)

---

## 模块定位

Parser 模块负责将 SQL 字符串转换为 DuckDB 内部的抽象语法树（AST）。这是查询处理流水线的第一站——产出的 `SQLStatement` 会被 Planner 模块消费，进行名称绑定和逻辑计划生成。

DuckDB 没有自研 SQL parser，而是复用了 PostgreSQL 的 parser 内核（`third_party/libpg_query/`）。这个设计决策的核心在于：SQL 语法覆盖度和正确性是 parser 的关键指标，而 PostgreSQL parser 经过数十年验证，是最成熟的 SQL 解析器之一。DuckDB 的差异化价值在向量化执行引擎和列式存储，而非 parser。

## 模块架构

Parser 模块由三个核心组件构成：`PostgresParser`（libpg_query 封装）、`Transformer`（PG AST → DuckDB AST 转换器）和 `ParserExtension`（扩展钩子）。`Parser` 类本身是轻量级编排器，不包含任何解析逻辑。

```
SQL string
  → PostgresParser::Parse()        — libpg_query 词法+语法分析 → PGList* (PG AST)
  → Transformer::TransformParseTree()  — PG AST → vector<SQLStatement> (DuckDB AST)
  → 后处理（设置 query 文本、stmt_location）
```

AST 类型系统分四层：`SQLStatement`（27 个子类，按语句类型）、`QueryNode`（6 种，表达 SELECT/UNION/CTE 等查询结构）、`ParsedExpression`（20 种，表达式层次）、`TableRef`（7 种，FROM 子句引用）。每层都用 `ExpressionClass`/`StatementType` 等枚举标识类型，配合 `static constexpr TYPE` 常量和 `Cast<T>()` 模板实现编译期类型安全 + 运行时零开销转型。

## 调用链路

从 `Parser::ParseQuery` 出发的调用链：

```
Parser::ParseQuery(query)                           [parser.cpp:221]
  ├→ StripUnicodeSpaces(query, new_query)           — 替换 Unicode 空格为 ASCII
  ├→ [可选] parser_override 扩展拦截
  ├→ PostgresParser parser
  │    └→ parser.Parse(query)                       — libpg_query → PGList*
  ├→ Transformer transformer(options)
  │    └→ TransformParseTree(parser.parse_tree, statements)  [transformer.cpp:26]
  │         └→ TransformStatement(node)             [transformer.cpp:56]
  │              └→ TransformStatementInternal(node)  [transformer.cpp:133]
  │                   └→ switch(stmt.type) → Transform*(stmt)
  │                        ├→ T_PGSelectStmt → TransformSelectStmt()
  │                        ├→ T_PGInsertStmt → TransformInsert()
  │                        ├→ T_PGCreateStmt → TransformCreateTable()
  │                        └→ ... (~30 种)
  └→ 后处理：设置 stmt_location / stmt_length / query 文本
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Parser::ParseQuery` | 主入口，协调三组件 | 先预处理 Unicode 空格再调用 libpg_query |
| `Transformer::TransformStatementInternal` | 按 PG 节点类型分派 | switch-case 而非虚函数（不侵入 PG 代码） |
| `Transformer::TransformSelectStmt` | SELECT 语句转换 | 委托给 `QueryNode` 层次，支持 UNION/CTE |
| `StripUnicodeSpaces` | Unicode 空格预处理 | 状态机处理引号/dollar-quoted/注释内不替换 |
| `ParseExpressionList` | 便捷方法 | 构造 mock SQL `"SELECT " + list` 再提取子结构 |

</details>

## 核心实现

### 两阶段解析：PG AST → DuckDB AST

DuckDB 不在 libpg_query 中直接生成 DuckDB AST，而是先生成 PG 原始 AST（`PGList*`），再用 `Transformer` 转换。这个两阶段设计的关键在于**解耦**——libpg_query 的修改最小化（仅 namespace 重命名和少量新增节点类型），当 PG parser 上游有新版本时只需更新 libpg_query 代码并在 Transformer 中增加对应的 `Transform*` 方法。

`Transformer` 是模块中逻辑最重的类，持有 `parent` 指针形成父子层级（递归 CTE/子查询时共享参数计数器）、`named_param_map`（命名参数映射）、`window_clauses`（窗口定义缓存）、`pivot_entries`（PIVOT 语句收集）和 `stack_depth`（深度限制防栈溢出）。

### DuckDB 对 PG parser 的语法扩展

DuckDB 在 PG parser 基础上添加了特有语法节点，通过在 grammar 中增加产生式规则生成新 PG 节点类型，然后在 Transformer 中添加对应处理：

- `T_PGMergeIntoStmt` — MERGE INTO 语法
- `T_PGCopyDatabaseStmt` — COPY DATABASE 语法
- `T_PGAttachStmt` / `T_PGDetachStmt` — ATTACH/DETACH 数据库
- `T_PGCreateSecretStmt` / `T_PGDropSecretStmt` — Secret 管理
- `T_PGPivot` / `PGPivotExpr` — PIVOT/UNPIVOT
- `PGLambdaFunction` / `PGSingleArrowFunction` — Lambda 表达式 `x -> x + 1`
- `PGPositionalReference` — 位置引用 `#1`

### ExpressionClass + ExpressionType 双维度枚举

DuckDB 使用双维度枚举系统而非 C++ RTTI：`ExpressionClass` 区分结构类型（COLUMN_REF vs FUNCTION vs CASE），决定 AST 节点的类层次；`ExpressionType` 区分语义类型（COMPARE_EQUAL vs OPERATOR_ADD），决定运算语义。这种设计使得同一个结构（如 `OperatorExpression`）可以表达多种运算，避免子类爆炸。

### Parser Extension 机制

`ParserExtension` 定义三个函数指针：`parse_function_t`（补充解析）、`plan_function_t`（直接产出逻辑计划）、`parser_override_function_t`（完全接管解析）。支持三种集成模式：override（完全替代）、fallback（libpg_query 失败后按 `;` 分割逐条尝试扩展）、strict（只使用扩展）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Adapter | `Transformer` in `transformer.cpp` | 将 PG C 结构 AST 适配为 DuckDB C++ AST，不侵入 PG 代码 |
| Visitor（受限） | `ParsedExpressionIterator` in `parsed_expression_iterator.hpp` | 遍历表达式子节点做属性传播（IsAggregate/HasSubquery） |
| Strategy/Plugin | `ParserExtension` in `parser_extension.hpp` | 允许扩展完全接管或补充 SQL 解析 |
| Type-Safe Downcasting | `BaseExpression::Cast<T>()` in `base_expression.hpp:136` | `static constexpr TYPE` + DEBUG 断言，运行时零开销 |

## 模块间交互

Parser 被 `ClientContext::ParseStatementsInternal`（`client_context.cpp:700`）调用。产出 `vector<unique_ptr<SQLStatement>>`，经 `StatementPreprocessor` 预处理后交给 Planner 的 `Planner::CreatePlan(SQLStatement&)`。每条 `SQLStatement` 携带 `type`（StatementType）、`query`（原始 SQL 文本，用于错误定位）、`stmt_location`/`stmt_length`（在原始 query 中的位置）和 `named_param_map`（命名参数映射）。

## 扩展方式

新增一种 SQL 语句类型（以 MERGE INTO 为例）：
1. PG grammar：`third_party/libpg_query/grammar/` 添加产生式规则
2. PG 节点结构：`third_party/libpg_query/include/nodes/parsenodes.hpp` 定义 `PGMergeIntoStmt`
3. DuckDB Statement 子类：`src/include/duckdb/parser/statement/merge_into_statement.hpp`
4. Transformer 分派：`src/parser/transformer.cpp` 的 `TransformStatementInternal()` switch 添加 `case T_PGMergeIntoStmt`
5. Transformer 方法：实现 `TransformMergeInto()`
6. StatementType 枚举：`src/include/duckdb/common/enums/statement_type.hpp` 添加 `MERGE_STATEMENT`
