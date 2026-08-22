---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "SQL 解析与规划"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "DFParser 包装 sqlparser，SqlToRel 完成 AST→LogicalPlan 与名字解析（binding），含 CTE/相关子查询。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/sql` 负责 SQL 字符串到逻辑计划的转换：词法/语法解析产出 AST（`DFParser`），AST→LogicalPlan 翻译含名字解析/binding（`SqlToRel`）。它与 catalog/execution crate 解耦——通过 `ContextProvider` trait 查表 schema 与 UDF，使 SQL 前端能在无完整 catalog 的场景（单测、嵌入式）使用。binding 与翻译紧耦合但**不做类型 coercion**，留给后续 Analyzer。

## 模块架构

sql 内部沿解析→规划两阶段组织：

- **`DFParser`**（`parser.rs:291`）：包装 `sqlparser::Parser`，持 `options`。经 `DFParserBuilder`（`:333`）链式构建，支持方言与递归限制。
- **`SqlToRel<'a, S: ContextProvider>`**（`planner.rs:336`）：核心规划器，持 `context_provider` 引用、`options`、`ident_normalizer`。
- **`PlannerContext`**（`planner.rs:193`）：规划状态（CTE map、`outer_query_schema` 相关子查询、`create_table_schema`），`Clone` 时只 clone CTEs 实现作用域隔离。
- **子模块**：`statement.rs`（总入口）、`query.rs`（SELECT）、`select.rs`（SELECT 子句）、`expr/`（AST Expr→Expr）、`relation/`（表引用）、`cte.rs`、`set_expr.rs`、`resolve.rs`、`unparser/`（LogicalPlan→SQL 反向）。

## 调用链路

```text
SQL String
 → DFParserBuilder::new(sql).build()           # parser.rs:365  tokenize→Parser
 → DFParser::parse_statements()                # :426  循环 parse_statement
 → DFParser::parse_statement()                 # :469  按关键字分发
     ├─ CREATE → parse_create() :698（EXTERNAL→CreateExternalTable）
     ├─ COPY → parse_copy()  EXPLAIN → parse_explain()
     └─ 其他 → parse_and_handle_statement() → sqlparser 原生
 → Statement (DF 扩展 AST)                     # parser.rs:254
 → SqlToRel::statement_to_plan(DFStatement)    # statement.rs:180
 → sql_statement_to_plan(Statement)            # :195
 → query_to_plan(Query, &mut PlannerContext)    # query.rs:37
     ├─ plan_with_clause(with)                 # cte.rs:32  注册 CTE
     ├─ SetExpr::Select → select_to_plan()      # select.rs:56
     └─ limit()/order_by()
 → LogicalPlan
```

## 核心实现

### SqlToRel 与 ContextProvider 解耦

```rust title="datafusion/sql/src/planner.rs:336"
pub struct SqlToRel<'a, S: ContextProvider> {
    pub(crate) context_provider: &'a S,
    pub(crate) options: ParserOptions,
    pub(crate) ident_normalizer: IdentNormalizer,
}
```

`ContextProvider` trait（定义在 `expr/src/planner.rs:40`）提供 `get_table_source`/`get_function_meta`/`get_aggregate_meta`/`get_window_meta`/`create_cte_work_table`。SqlToRel 只依赖这个 trait 而非 catalog 结构——由 core 的 `SessionState` 经 `SessionContextProvider` 适配器实现。注释（`expr/planner.rs:35`）明确：让 SQL 规划器不直接依赖 catalog，支持无完整 catalog 的场景。

### 名字解析（binding）：CTE 优先 + 外层 schema

表名解析在 `create_relation()`（`relation/mod.rs:78`）：优先级 **CTE（PlannerContext 内）→ catalog（`ContextProvider::get_table_source`）**。列名解析在 `sql_identifier_to_expr()`（`expr/identifier.rs:31`）：先查当前 schema，再查 `outer_query_schema`（相关子查询，返回 `Expr::OuterReferenceColumn`），都找不到返回未限定 `Expr::Column`（延迟到 analyzer 报错）。复合标识符 `schema.table.column` 经 `search_dfschema` 多段匹配，支持结构体字段访问。

设计决策：binding 放在 `SqlToRel` 而非单独 analyzer 阶段（`planner.rs:317` 注释）。原因是 binding 与 AST 翻译紧耦合——翻译每个节点需即时查 schema，因为后续节点翻译依赖前面已解析的类型信息（如函数参数推断）。分离为两阶段要么先遍历收集名字再翻译（信息冗余），要么翻译后回头修正（复杂重写）。但**不做类型 coercion**（`TypeCoercion` 留给 Analyzer），保持翻译"机械"。

### CTE 与相关子查询

CTE 在 `cte.rs`：非递归 CTE 直接 `query_to_plan` 注册到 `PlannerContext`；递归 CTE（`recursive_cte`，`cte.rs:72`）四步——编译 static term、经 `create_cte_work_table` 建临时 working table 注册为 CTE、编译 recursive term（引用 working table）、`LogicalPlanBuilder::to_recursive_query` 构建。相关子查询三入口（`expr/subquery.rs`）模式一致：`set_outer_query_schema(input_schema)` → 递归 `query_to_plan` → `all_out_ref_exprs()` 收集外层引用列 → 恢复 schema → 包为 `Expr::Exists`/`InSubquery`/`ScalarSubquery`。LATERAL 在 `create_relation_subquery`（`relation/mod.rs:173`）合并 outer_from + outer_query schema。

### resolve_table_references：表引用收集

`resolve.rs` 的 `RelationVisitor` 实现 sqlparser `Visitor` trait，区分真实表引用与 CTE 别名：`pre_visit_query` 把 CTE 名压入 `ctes_in_scope` 栈，`post_visit_query` 弹出并收集到 `all_ctes`，`insert_relation` 只记录不在当前 CTE 作用域的引用，正确处理 CTE 遮蔽同名表。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor | `RelationVisitor`（`resolve.rs:63`）、`has_work_table_reference`（`cte.rs:190`） | 遍历 AST 收集表引用、检查递归 CTE 引用 |
| Builder | `DFParserBuilder`（`parser.rs:333`）、`LogicalPlanBuilder` | 链式构建解析器与计划 |
| Context | `PlannerContext`（`planner.rs:193`）、`SqlToRel` 持 `ContextProvider` | 规划状态隔离 + 外部 schema 查询解耦 |
| 虚拟栈机 | `sql_expr_to_logical_expr`（`expr/mod.rs:66`） | 显式栈模拟 DFS，减栈深度（issue #1444），产后缀表示 |
| RAII Guard | `StackGuard`（`stack.rs:25`） | 进入深层递归前调高线程栈，Drop 恢复 |
| 责任链 | `ContextProvider::get_expr_planners()`（`expr/mod.rs:127`） | 多 ExprPlanner 依次尝试规划二元表达式 |

## 模块间交互

依赖 `common`（DFSchema/错误/配置）、`expr`（LogicalPlan/Expr/ContextProvider trait）、`sqlparser`/`arrow`。**不依赖** catalog/execution/physical-plan——`ContextProvider` 是解耦桥梁。被 `core` 调用：`SessionContext::sql` → `SessionState::create_logical_plan` → `DFParser` + `SqlToRel`。产出 `LogicalPlan`/`Expr` 喂给 optimizer 与物理计划器。

## 扩展方式

- **支持新 SQL 语法**（如 PIVOT）：`parser.rs::parse_statement` 加关键字分支 + `parse_pivot` 产 `Statement` 变体；`statement.rs::statement_to_plan` 加 match 分支 + `pivot_to_plan` 产 LogicalPlan。
- **自定义方言**：无需改源码，impl `sqlparser::dialect::Dialect`，经 `DFParserBuilder::with_dialect` 注入（`DFParser::parse_sql_with_dialect`，`:408`），SqlToRel 不感知方言。
- **新增 DDL**（如 CREATE INDEX）：`parse_create`（`:698`）加分支 + `Statement` 变体 + `statement.rs` match 分支产 `LogicalPlan::Ddl`，按需在 `ContextProvider` 加方法。
