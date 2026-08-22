---
source:
  type: "源码解读"
  project: "Databend"
  url: "https://github.com/databendlabs/databend"
title: "SQL 解析"
date: "2026-08-22T15:17:11+08:00"
category: [Database, OLAP, Databend, CodeWiki, "1.2.925-patch-8"]
tags: ["Databend", "Rust", "SQL", "Parser", "AST"]
description: "Databend SQL 解析器——logos 词法分析 + nom/Pratt 混合语法分析，产出 150+ variant 的 Statement AST。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Databend/CodeWiki/1.2.925-patch-8/00-overview)

---

## 模块定位

SQL 解析模块（`src/query/ast/`，crate `databend-common-ast`，~39.5k 行）是编译流水线的**叶子节点**——它只负责将 SQL 文本转为 AST，不做任何语义分析或计划生成。它是 Databend 中唯一一个**零内部依赖**的 crate（`Cargo.toml` 只有 `nom`/`pratt`/`logos` 等第三方依赖），这使它可被多个 storage crate 直接复用（如解析 DDL）。

## 模块架构

解析器采用**两阶段混合架构**：语句级用 `nom` 组合子做递归下降，表达式级先 nom 解析出扁平元素列表再用 `pratt` crate 按优先级组装成树。词法分析由 `logos` 库自动从 `#[token]`/`#[regex]` 属性生成。

```
SQL Text → [logos] Tokenizer → Vec<Token>
         → [nom] statement() → 递归下降匹配语句结构
         → [nom] expr_element() → 扁平表达式元素列表
         → [pratt] PrattParser → Expr 表达式树
         → Statement AST
```

## 调用链路

```
parse_sql(tokens, dialect)                 [parser.rs:48]
└── run_parser(tokens, dialect, statement) [parser.rs:156]
    └── statement(input)                    [statement.rs:3156]
        └── statement_body(input)          [statement.rs:100]
            └── try_dispatch!(SELECT/CREATE/INSERT/...)
                └── query()/create_table()/insert_stmt()...
```

入口 `parse_sql`（`parser.rs:48`）先经 `tokenize_sql`（`parser.rs:42`）用 `logos` 扫描为 `Vec<Token>`，再经 `run_parser` 调用 `statement` 解析器。`try_dispatch!` 宏（`parser/mod.rs:15`）根据首 token 分派到不同语句解析器。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `tokenize_sql` | logos 词法扫描 | Token 借用原 SQL `&'a str` 零拷贝 |
| `parse_sql` | 解析入口 | 返回 `(Statement, Option<Format>)` |
| `statement_body` | 语句级分派 | `try_dispatch!` 宏按首 token 路由 |
| `expr`/`subexpr` | 表达式解析 | 先 nom 扁平化再 Pratt 组装 |
| `ExprParser::query` | 运算符优先级 | 返回 `Affix`（优先级+结合性） |
| `assert_reparse` | round-trip 验证 | 仅 debug 构建启用 |

</details>

## 核心实现

### Token 枚举与零拷贝词法

`Token`（`token.rs:26`）借用原始 SQL 字符串生命周期，避免拷贝；`TokenKind`（`token.rs:194`）是 `Copy` 枚举，由 `logos` 的 `#[token("SELECT", ignore(ascii_case))]` 属性自动生成词法分析器，涵盖 ~400+ SQL 关键字与符号：

```rust title="token.rs"
pub struct Token<'a> {
    pub source: &'a str,    // 原始 SQL 文本引用（零拷贝）
    pub kind: TokenKind,
    pub span: Range,        // 文本位置范围
}

#[derive(Logos, Clone, Copy)]
pub enum TokenKind {
    #[error] Error, EOI,
    Ident, LiteralString, LiteralInteger, ...
    #[token("SELECT", ignore(ascii_case))] SELECT,
    #[token("CREATE", ignore(ascii_case))] CREATE,
    // ...
}
```

### Statement 顶级 AST

`Statement`（`statements/statement.rs:48`）是巨型枚举，涵盖 DQL/DML/DDL/DCL/TCL 全部 SQL 语句类型（~150+ variant），派生 `Drive`/`DriveMut`（来自 `derive-visitor`）支持自动遍历：

```rust title="statement.rs"
#[derive(Debug, Clone, PartialEq, Drive, DriveMut)]
pub enum Statement {
    Query(Box<Query>),
    Insert(InsertStmt), Replace(ReplaceStmt), MergeInto(MergeIntoStmt),
    Delete(DeleteStmt), Update(UpdateStmt),
    CreateDatabase(CreateDatabaseStmt), CreateTable(CreateTableStmt),
    CreateUser(CreateUserStmt), Grant(GrantStmt), Revoke(RevokeStmt),
    CreateStage(CreateStageStmt), CreateTask(CreateTaskStmt),
    Begin, Commit, Abort,
    // ... 150+ variant
}
```

`Expr`（`expr.rs:42`）表达式枚举包含 `ColumnRef`/`BinaryOp`/`UnaryOp`/`Cast`/`FunctionCall`/`Case`/`Subquery`/`MapAccess` 等，`BinaryOperator` 含 35+ 运算符（含 `CosineDistance`/`L2Distance` 向量距离运算）。`Query`（`query.rs:42`）含 CTE（`with`）、`SetExpr`（SELECT/UNION/VALUES）、`order_by`/`limit`/`offset`。

### 表达式两阶段解析（nom + Pratt）

表达式解析分两步（`expr.rs:54`）：先用 nom 解析出扁平的 `ExprElement` 列表，再用 Pratt Parser 按优先级组装成树。注释（`expr.rs:139`）说明：

> Pratt parser 无法直接按文法解析表达式，所以先用 nom 提取操作数和运算符作为 Pratt parser 的输入。例如 `a + b AND c is null` 被 nom 解析为 `[col(a), PLUS, col(b), AND, col(c), ISNULL]`，再由 Pratt parser 组装为 `AND(PLUS(a,b), ISNULL(c))`。

```rust title="expr.rs"
pub trait PrattParser {  // pratt crate trait
    type Input; type Output;
    fn query(&mut self, _: &Self::Input) -> Affix;  // 优先级+结合性
    fn primary(&mut self, _: &Self::Input) -> Self::Output;  // 原子元素
    fn infix(&mut self, _: &Self::Input, l: Output, r: Output) -> Output;  // 中缀
    fn prefix(&mut self, _: &Self::Input, r: Output) -> Output;  // 前缀
}
```

**为什么混合而非纯手写或纯 parser generator**：Pratt Parser 精确控制运算符优先级（新增运算符只需加一行 `Affix` 常量），而复杂语法结构（如 `CAST(expr AS type)`）由 nom 完整解析为 `Nilfix` 原子元素。两阶段兼顾了语法复杂度和优先级正确性。

### 上下文敏感的 token 重解释

`subexpr()`（`expr.rs:72`）在收集 `ExprElement` 后，根据前一个元素的位置重解释 token 语义——前缀位置的 `BinaryOp::Plus` → `UnaryOp::Plus`，前缀的 `MapAccess::Bracket` → `Array` 字面量，前缀的 `MapAccess::DotNumber` → 浮点字面量 `.5`。这是手写解析器相对 parser generator 的优势——能表达上下文依赖的语法。

## 设计模式

### 双套 Visitor 系统

Databend AST 有**两套** Visitor：

- **`derive-visitor` 的 `Drive`/`DriveMut`**（自动派生）：用于外部 crate（如 bendsql）做表达式/标识符替换，通过 `#[derive(VisitorMut)]` + `#[visitor(Expr(enter))]` 声明关注点。
- **手写 `Walk`/`WalkMut` + `Visitor`/`VisitorMut` trait**（`visit.rs:101`）：内部使用，通过 `databend-common-ast-visit-derive` 过程宏自动派生，`VisitControl` 枚举控制遍历（`Continue`/`SkipChildren`/`Break`）。

### Backtrace 错误追踪

`Backtrace`（`error.rs:68`）在 `alt` 组合子的多分支尝试中记录**最远解析位置**，即使某分支被跳过也不丢失信息。`display_parser_error()` 最终输出带上下文的语义化错误（"expected `CREATE TABLE ...` but found ..."）。`Error::or`（`error.rs:100`）取更远的错误位置。

### Round-trip 验证

Debug 构建下（`parser.rs:51`），每条解析出的 Statement 会被 `to_string()` 后重新解析，验证结果一致（`assert_reparse`）。`reset_ast()`（`parser.rs:231`）在比较前规范化 AST（Literal 替换为 Null），确保语义等价比较。这是 AST crate 的回归安全网。

## 模块间交互

AST crate 是纯叶子节点——不依赖任何 databend 内部 crate。被 `databend-common-sql`（planner/binder）主消费，也被多个 storage crate 依赖（解析 `SHOW CREATE TABLE` 输出或系统表查询）。

编译流水线位置：`SQL Text → [ast: tokenize+parse] → Statement → [sql: Binder] → SExpr → ...`

## 扩展方式

**新增一种 SQL 语句语法**：在 `ast/statements/` 定义 struct（派生 `Drive, DriveMut`）→ 在 `statements/statement.rs` 的 `Statement` 枚举添加 variant → 在 `parser/statement.rs` 的 `try_dispatch!` 添加分派并编写解析函数 → 如有新关键字在 `token.rs` 添加 `TokenKind` → `Display` 实现保证 round-trip。

**新增一个运算符**：在 `expr.rs` 的 `BinaryOperator`/`UnaryOperator` 添加 variant → 在 `parser/expr.rs` 添加 `Affix` 优先级常量 + `binary_affix()` 分支 → 在 `parser/token.rs` 添加符号 `TokenKind`。
