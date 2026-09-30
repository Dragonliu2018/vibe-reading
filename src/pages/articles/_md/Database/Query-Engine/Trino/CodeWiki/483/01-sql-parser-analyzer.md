---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "SQL 解析与分析"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "ANTLR", "AST", "语义分析"]
description: "Trino 483 SQL 解析三层模块（grammar/parser/analyzer）与语义分析流程深度解读"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

这是 SQL 进入引擎的第一段旅程：**把字符串变成"语义完备、可直接规划"的中间表示**。模块横跨三个 Maven 模块——`trino-grammar`（ANTLR 语法）、`trino-parser`（parser + AST）、`trino-main/sql/analyzer`（语义分析）——产出 `Analysis`（约 70 个 side-table 的语义结果集）交给 LogicalPlanner。

职责边界：**到这里为止只回答"这条 SQL 是什么意思"，不回答"怎么执行"**（join 顺序、分布、算子选择都是规划器的事）。权限检查（列级审计）也在这里完成入口收口。

## 模块架构

483 的三层拆分比早期版本更细：

- **trino-grammar**：只有 `SqlBase.g4`（51K 的 ANTLR 语法）+ `SqlKeywords.java`，依赖仅 antlr4-runtime/guava——语法演进不重编 AST 消费方；
- **trino-parser**：`SqlParser`（入口）、`AstBuilder`（parse tree → AST 映射，185K）、`tree/`（317 个 AST 类）；**零引擎依赖**，可被插件（谓词下推时解析 SQL 片段）与 verifier 复用；
- **analyzer**（trino-main 内）：`Analyzer` 编排 + `StatementAnalyzer`（357K，语句级）+ `ExpressionAnalyzer`（255K，表达式级）+ `sql/rewrite/`（SHOW/DESCRIBE 改写）。

值得注意的 483 实况：`ParsingOptions` 已不存在（decimal 处理移进 `ExpressionAnalyzer.visitDecimalLiteral`）；`StatementSplitter` 已移到 CLI（服务端 wire 协议一次一条语句，切分只是 REPL 需求）。

## 调用链路

```
SQL 文本
 └─ SqlParser.createStatement (SqlParser.java)
     ├─ invokeParser (:144)
     │   ├─ SqlBaseLexer + CommonTokenStream
     │   ├─ 先 SLL + BailErrorStrategy（快路径）
     │   └─ ParseCancellationException → 降级 LL + NonRecoveringErrorStrategy
     ├─ new AstBuilder(location).visit(tree)   # parse tree → AST
     └─ PostProcessor.exitNonReserved (:255)   # 非保留字 token → IDENTIFIER
        ↓ Statement（AST）
 └─ Analyzer.analyze (Analyzer.java)
     ├─ StatementRewrite.rewrite   # 5 个 Rewrite（Guice Multibinder 插拔）：
     │                              # SHOW/DESCRIBE/EXPLAIN 改写为系统表 Query
     ├─ statementAnalyzerFactory.createStatementAnalyzer(...).analyze(node)
     │   └─ Visitor extends AstVisitor<Scope, Optional<Scope>>
     │       ├─ visitQuery (:1576)：CTE 进 scope.namedQueries → 建子 scope
     │       ├─ visitTable (:2319)：
     │       │   ① CTE 命中？ ② 物化视图新鲜度？ ③ view：重新 parseView
     │       │      → analyzeView（以 owner 身份递归 analyze，ViewAccessControl）
     │       │   ④ 真表：getTableHandle/getTableSchema/getColumnHandles
     │       │      + rowFilter/columnMask 分析
     │       └─ 表达式委托 ExpressionAnalyzer.analyzeExpression (:4747)
     │           ├─ visitFunctionCall → FunctionResolver.resolveFunction
     │           │   （多候选 → SignatureBinder 类型推导 → 逐参 coerceType 插 cast）
     │           ├─ visitIdentifier/Dereference → scope.resolveField
     │           │   → handleResolvedField 记录 columnReferences（权限审计）
     │           ├─ 子查询：analyzeSubquery (:3487) 递归（subqueryScope 挂 parent）
     │           └─ lambda：visitLambdaExpression (:3625) 构造参数 Field 建 scope
     └─ 收尾：对 tableColumnReferences 逐表 checkCanSelectFromColumns
        ↓ Analysis（scopes/columnReferences/types/coercions/resolvedFunctions/
                   namedQueries/tables/subqueries/rowFilters/columnMasks…）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `createStatement` in SqlParser | 文本 → Statement AST | SLL 快路径失败自动降级 LL |
| `invokeParser` in SqlParser.java:144 | 两阶段 ANTLR 驱动 | BailErrorStrategy 避免错误恢复开销 |
| `visitTable` in StatementAnalyzer.java:2319 | 表引用四级解析 | view 递归以 owner 身份，权限随身份切换 |
| `resolveField` in Scope.java:225 | 字段名 → ResolvedField | 本地→parent 递归，queryBoundary 切外层 |
| `resolveFunction` in FunctionResolver.java | 函数调用 → ResolvedFunction | 最具体签名仲裁，歧义抛 AMBIGUOUS_FUNCTION_CALL |
| `analyzeExpression` in ExpressionAnalyzer.java:4747 | 表达式语义统一入口 | 静态方法便于复用（view/routine 分析） |
| `rewrite` in StatementRewrite | 语法糖 → 系统表查询 | Guice Multibinder，新增 Rewrite 零侵入 |

</details>

## 核心实现

### Analysis：side-table 设计

```java title="analyzer/Analysis.java（节选）"
public class Analysis {
    private final Map<ScopeAware, Scope> scopes;              // scope 树
    private final Map<NodeRef<Expression>, ResolvedField> columnReferences;
    private final Map<NodeRef<Expression>, Type> expressionTypes;
    private final Map<NodeRef<Expression>, Type> expressionCoercions;
    private final Map<NodeRef<FunctionCall>, ResolvedFunction> resolvedFunctions;
    private final Map<NodeRef<Query>, Query> namedQueries;     // CTE
    private final Map<NodeRef<Table>, TableEntry> tables;      // TableHandle+列句柄
    private final Map<NodeRef<Node>, RowFilter> rowFilters;    // 行级安全
    private final Map<NodeRef<Node>, ColumnMask> columnMasks;  // 列脱敏
    // …约 70 个 side-table
}
```

为什么用 side-table 而不是把类型/解析结果写进 AST 节点字段？**AST 是纯语法、不可变、无 session 依赖的树**——view 递归分析、canonicalization、打印/重写都要求同一棵 Statement 可在不同 session 下反复分析。语义结果挂 `NodeRef`（身份键）查表，树本身零污染。

### Scope/Field：名字解析的骨架

`Field`（relationAlias/name/type/hidden + originTable/originColumnName——lineage 与列级审计的数据来源）；`Scope` 是 `@Immutable` 值对象，`parent` 指针 + `queryBoundary` 标志共同决定相关子查询能否引用外层字段。CTE 不展开成内联查询，而是以 `namedQueries` 挂进 scope，`visitTable` 前缀命中即复用——**同一 CTE 多处引用只分析一次**。

### view 展开的身份切换

`visitTable` 遇到 view：`parseView` 用 `sqlParser.createStatement` 重新解析存储的 SQL 文本（view 定义就是 SQL 字符串），然后 `analyzeView` 以 **owner 身份** new 一个 StatementAnalyzer 递归分析，权限检查走 `ViewAccessControl` 切换身份。这意味着：**查询者不需要 view 底表的权限**——这正是 view 作为安全边界的基础语义。

### nonReserved：关键字与标识符的和平共处

`PostProcessor.exitNonReserved`（SqlParser.java:255）在 parse 完成后把 nonReserved 列表里的 token 动态改写为 IDENTIFIER——于是 `SELECT count FROM t`（count 是非保留字）合法。新增关键字只需改 grammar 的 nonReserved 规则，无需动 Java 代码。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor 双精度分派 | `Node.accept` ↔ `AstVisitor.process`（Node.java:39） | 317 个 AST 类型的统一遍历协议 |
| 工厂+特化 | `AnalyzerFactory` → `StatementAnalyzerFactory.withSpecializedAccessControl` | view owner 身份切换 |
| 责任链 | `StatementRewrite` 的 5 个 Rewrite | 改写规则可插拔 |
| 不可变值对象 | `@Immutable Scope` / `Field` | scope 树可安全共享 |

## 模块间交互

- **被依赖**：trino-parser 被 trino-main、trino-verifier、docs 与 20+ 插件（iceberg/hive/base-jdbc 下推时解析 SQL 片段）使用——这是它必须零引擎依赖的原因；
- **向下游**：`Analysis` → `LogicalPlanner.plan(analysis)`（sql/planner）；
- **委托 Metadata**：`getTableHandle`、`getRedirectionAwareView`（Metadata.java:902）等；
- **委托函数解析**：`FunctionResolver.resolveFunction(session, name, parameterTypes, accessControl)`（FunctionResolver.java:118）——重载选择含搜索路径与权限过滤，详见[元数据与类型系统](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/08-metadata-types)；
- **委托 AccessControl**：`checkCanSelectFromColumns` 逐表收口（列级审计数据来自 `recordColumnUsage` in ExpressionAnalyzer.java:1066）。

## 扩展方式

**新增一种 DDL（如 CREATE FOO）**：① `SqlBase.g4` statement 规则加 `| CREATE FOO ... #createFoo`；② `tree/CreateFoo.java` AST 节点；③ `AstBuilder.visitCreateFoo`；④ `AstVisitor.visitCreateFoo` 基类转发；⑤ 多数 DDL 走 DataDefinitionTask 不经 analyze（见[查询与任务生命周期](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/03-query-lifecycle)的注册三处）；⑥ `TestSqlParser`/`TestStatementBuilder` 补用例。

**新增保留字**：grammar 词法加 token；若可能撞用户列名，同步加进 `nonReserved` 规则（:1098）避免破坏存量查询。

**改字段解析行为**：`resolveField`/`tryResolveField` in Scope.java:225/244；asterisk 行为在 `Scope.resolveAsteriskedIdentifierChainBasis`（Scope.java:181）。
