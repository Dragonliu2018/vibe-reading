---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "查询分析器"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Analyzer", "QueryTree", "语义分析"]
description: "ClickHouse 查询分析器源码解读——AST→QueryTree 类型化中间表示、QueryAnalyzer 多 Pass 语义分析与标识符解析。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Analyzer/` 是 ClickHouse 较新的查询分析子系统，把 Parsers 产出的 AST 转换为类型化的 QueryTree（查询树），做语义分析、名称解析、类型推导、常量折叠。它独立成模块因为 QueryTree 作为类型化中间表示（IR）承载分析与优化，比在 AST 上直接做更强大——这是 ClickHouse 近年最重要的架构演进，逐步替代旧的直接 AST→QueryPlan 路径。

## 模块架构

```text
src/Analyzer/
  ├─ IQueryTreeNode.h       ── 查询树节点基类（16 种 QueryTreeNodeType）
  ├─ QueryNode.h            ── QueryNode 核心（17 个 SQL 子句 section）
  ├─ QueryTreeBuilder.h/.cpp── AST → QueryTree 构建（纯结构映射）
  ├─ InDepthQueryTreeVisitor.h ── CRTP 访问者基类（带 Context 管理）
  ├─ Resolve/QueryAnalyzer.h/.cpp ── 语义分析核心（名称解析/类型推导）
  ├─ Resolve/IdentifierResolver.h  ── 标识符解析（词法作用域+多上下文）
  ├─ QueryTreePassManager.h/cpp    ── Pass 管理器（37 个 Pass，责任链）
  └─ ColumnNode.h/ConstantNode.h/FunctionNode.h/IdentifierNode.h/... ── 各节点类型
```

核心：`QueryTreeBuilder` 纯结构映射（AST→QueryTree），`QueryAnalyzer`（QueryAnalysisPass）做语义分析，`QueryTreePassManager` 编排 37 个 Pass。`IdentifierResolver` 是独立的标识符解析子系统。

## 调用链路

```text
buildQueryTree(ast, context) in QueryTreeBuilder.cpp:1286
  └─ QueryTreeBuilder::buildQueryTreeNode() → ast->as<ASTSelectQuery>() 分派
     └─ 递归遍历 AST children 构建 QueryTreeNode 树（纯结构，无语义）
        └─ QueryTreePassManager::run(query_tree, context)
           └─ 依次执行 37 个 Pass：
              1. QueryAnalysisPass（必须首个）→ QueryAnalyzer::resolve()
                 ├─ resolveQuery → resolveIdentifiers → IdentifierResolver
                 ├─ resolveFunctions → FunctionFactory 重载解析
                 ├─ 类型推导、常量折叠、标量子查询求值
                 └─ GROUP BY/ORDER BY ALL 展开
              2..37. 后续 Pass（constant folding、CTE materialization、query aliases 等）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `QueryTreeBuilder::buildQueryTreeNode` | AST→QueryTree 纯映射 | 类型化节点+弱指针引用 |
| `QueryAnalyzer::resolve` in `Resolve/QueryAnalyzer.cpp` | 语义分析主入口 | switch 按节点类型分派 |
| `IdentifierResolver::tryResolveIdentifier` | 标识符解析 | 词法作用域+多上下文优先级 |
| `InDepthQueryTreeVisitor::visit` | 遍历查询树 | CRTP 非递归遍历 |
| `QueryTreePassManager::run` | 编排 Pass | 责任链，QueryAnalysisPass 必须首个 |

</details>

## 核心实现

### QueryNode：类型化查询树节点

`IQueryTreeNode`（`src/Analyzer/IQueryTreeNode.h`）是基类，16 种 `QueryTreeNodeType`（QUERY/UNION/IDENTIFIER/FUNCTION/COLUMN/CONSTANT/ TABLE/TABLE_FUNCTION/ARRAY_JOIN/SORT/INTERPOLATE/...）。每个节点有类型化子节点数组 + 弱指针数组（避免循环引用）。

```cpp title="src/Analyzer/QueryNode.h"
class QueryNode : public IQueryTreeNode {
    // 17 个 SQL 子句 section：with/Select/JoinTree/Where/GroupBy/Having/Window/OrderBy/Limit/Settings...
    QueryTreeNodePtr with_node_list;
    QueryTreeNodePtr projection_node_list;
    QueryTreeNodePtr query_node;
    QueryTreeNodePtr where_node;
    // ... 每个 section 是 nullable 子节点
    ContextMutablePtr context;   // 每 QueryNode 持独立 Context（SETTINGS 分层）
};
```

### QueryTreeBuilder：AST → QueryTree

`QueryTreeBuilder::buildQueryTreeNode`（`QueryTreeBuilder.cpp`）通过 `ast->as<ASTSelectQuery>()` 等遍历 AST，转换为 QueryTreeNode。纯结构映射，不做语义分析。Enum/Tuple 等 AST 节点有特殊处理分支。

### QueryAnalyzer：语义分析核心

`QueryAnalysisPass` 必须首个运行，建立不变量：无 `IdentifierNode`（全部解析为 ColumnNode/FunctionNode 等）、无 `MatcherNode`、所有 FunctionNode 已重载解析。`QueryAnalyzer::resolve`（`Resolve/QueryAnalyzer.cpp:194`）按 `QueryTreeNodeType` switch 分派。

标识符解析由独立的 `IdentifierResolver` + `IdentifierResolveScope` 子系统处理——词法作用域、别名优先级、Lambda 参数绑定、CTE 解析、JOIN USING 列匹配。解析有三种上下文（EXPRESSION/FUNCTION/TABLE_EXPRESSION），由 `IdentifierLookup` 控制。

### QueryTreePassManager：37 Pass 责任链

```cpp title="src/Analyzer/QueryTreePassManager.h"
class QueryTreePassManager {
    QueryTreePasses passes;     // 37 个 Pass
    void run(QueryTreeNodePtr & query_tree, ContextPtr context);
};
```

`ValidationChecker`（`QueryTreePassManager.cpp:83`）在 DEBUG 构建每 Pass 后校验不变量。Pass 间通过注释和注册顺序管理依赖——"解析在前、优化在后"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 访问者 | `InDepthQueryTreeVisitor<Derived>` | CRTP 模板遍历，`visitChildIfNeeded` 按类型分派 |
| 组合 | QueryTree 节点树 | 16 种节点统一基类 |
| 责任链 | `QueryTreePassManager` 37 Pass | 每关注一个变换，可组合 |
| 建造者 | `QueryTreeBuilder` | 分离构建与语义分析 |

## 重要设计决策

### 为什么引入 QueryTree 而非直接在 AST 上做

QueryTree 相比 AST 的优势：节点类型化（不靠字符串 ID）、弱指针引用（表达 CTE/子查询关系）、规范化（消除语法糖）、双向可转换性（QueryTree→AST 支持序列化）、通用 Pass 接口（每个 Pass 用统一 visitor 而非各写各的）。这使优化（常量折叠、谓词下推、CTE 物化）比在异构 AST 上做更系统化。旧路径（`InterpreterSelectQuery` 直接 AST→QueryPlan）仍保留，由 `allow_experimental_analyzer` 设置切换。

### 每 QueryNode 持独立 Context

为支持 `SETTINGS` 子句分层——子查询可覆盖父查询的设置。QueryNode 持 `ContextMutablePtr`，解析时按需派生。

## 扩展方式

新增查询树节点类型 `MaterializedViewNode`：建 `src/Analyzer/MaterializedViewNode.h` 继承 `IQueryTreeNode`，实现 `getNodeType`/`cloneImpl`/`toASTImpl`/`dumpTreeImpl`；在 `IQueryTreeNode::QueryTreeNodeType` 加枚举；`QueryTreeBuilder::buildExpression` 加构建分支；`QueryAnalyzer::resolve` switch 加处理；`QueryTreePassManager::ValidationChecker` 加校验；Planner 加计划生成分支。

## 模块间交互

Analyzer 接收 Parsers 的 AST，输出 QueryTree 给 Planner。import `Common`、`DataTypes`、`Functions`（FunctionFactory 重载解析）、`Interpreters/Context`。被 `InterpreterSelectQueryAnalyzer` 调用（新路径），`buildQueryTree` 在 `QueryTreeBuilder.cpp:1286`。AST→QueryTree 是单向，QueryTree→AST（`toASTImpl`）用于序列化与分布式传输。
