---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "表达式引擎"
date: "2026-08-24T14:30:33+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "0.14.0"]
tags: ["Apache Doris", "exprs", "Expr", "AnyVal", "dlsym", "行式求值"]
description: "Doris 0.14.0 表达式引擎：Expr 树 + AnyVal 行式求值、ExprContext 上下文、SlotRef/FunctionCallExpr/BinaryPredicate、dlsym 函数动态加载。行式表达式路径（无 VExpr）。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/0.14.0/00-overview)

---

## 模块定位

本模块是 `be/src/exprs/`（~2.2 万行，92 文件），是 0.14.0 的**行式表达式求值引擎**，与 `exec/` 行式执行引擎紧密协作。`Expr` 树做谓词/投影/函数求值，`AnyVal` 是类型化的值包装。**0.14.0 没有 `vec/exprs/`（VExpr 向量化表达式）**——表达式是纯行式路径，与执行引擎的行式 Volcano 一致。

## 模块架构

```
Expr (exprs/expr.h:63) ── 表达式树基类（行式）
   ├─ ExprContext (exprs/expr_context.h:49) ── 求值上下文（内存池、行状态）
   │      friend Expr (:291)
   ├─ AnyVal (exprs/anyval.h) ── 类型化值包装（BooleanVal/IntVal/StringVal/...）
   │
   ├─ SlotRef (exprs/slot_ref.h:30 : public Expr)  ── 列引用叶子
   ├─ FunctionCallExpr / BinaryPredicate / InPredicate / LiteralExpr ...
   ├─ AggFnEvaluator (friend, expr.h:270)  ── 聚合函数求值
   │
   ├─ create_expr_tree()  ── 从 Thrift TExpr 构建 Expr 树
   └─ get_next()/eval()  ── 行式求值（对 TupleRow 求值返回 AnyVal）

dlsym 函数加载:
  函数符号 → dlsym 动态解析 → Expr 调用 C 函数指针求值
```

## 调用链路

```
[FE 下发]
FE Analyzer → Expr 树 → Thrift TExpr → 序列化下发 BE

[BE 构建]
create_expr_tree(TExpr) → Expr 树（SlotRef/FunctionCallExpr/...）  [exprs/expr.h:63]

[执行期求值]
ExecNode::get_next() 对每个 TupleRow:
  → ExprContext.prepare/open
  → Expr.eval(&row, context) → 递归求值
       ├─ SlotRef → 从 TupleRow 取列值（AnyVal）
       ├─ FunctionCallExpr → dlsym 取函数指针 → 调 C 函数求值
       └─ BinaryPredicate → 左右子树 AnyVal 比较
  → ExecNode::eval_conjuncts() (exec_node.h:160) ── 谓词过滤
  → AggFnEvaluator (expr.h:270 friend) ── 聚合（AggregationNode）
```

<details>
<summary>方法速查表</summary>

| 方法/类 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `Expr`（`expr.h:63`） | 表达式树基类 | 行式求值，`eval` 对 TupleRow 返回 AnyVal |
| `ExprContext`（`expr_context.h:49`） | 求值上下文 | 持有内存池、行状态，`Expr` friend（`:291`） |
| `SlotRef`（`slot_ref.h:30`） | 列引用叶子 | 从 TupleRow 取列值 |
| `create_expr_tree` | 构建 Expr 树 | 从 Thrift `TExpr` 递归构建 |
| `eval_conjuncts`（`exec_node.h:160`） | 谓词过滤 | `ExecNode` 静态方法，调 ExprContext 求值 |
| `AggFnEvaluator`（friend `:270`） | 聚合求值 | `AggregationNode` 的聚合路径 |

</details>

## 核心实现

### Expr 树 + AnyVal 行式求值

`Expr`（`exprs/expr.h:63`）是表达式树基类——`SlotRef`（`slot_ref.h:30`，`public Expr`）是列引用叶子，`FunctionCallExpr`/`BinaryPredicate`/`InPredicate` 等是内部节点。求值是**行式**的：对每个 `TupleRow`，`Expr.eval(&row, context)` 递归求值，`SlotRef` 从行取列值，`FunctionCallExpr` 调函数求值，结果以 `AnyVal`（`exprs/anyval.h`，类型化值包装如 `BooleanVal`/`IntVal`/`StringVal`）返回。`ExprContext`（`expr_context.h:49`）持有求值上下文（内存池、行状态），是 `Expr` 的 friend（`expr.h:291`）。`ExecNode::eval_conjuncts()`（`exec/exec_node.h:160`）调 `ExprContext` 做谓词过滤。

### dlsym 函数动态加载

函数求值用 **dlsym 动态加载**：函数符号经 `dlsym` 解析为 C 函数指针，`FunctionCallExpr` 调该指针求值。这使得 BE 可在运行期按 FE 下发的函数符号动态绑定实现，无需编译期硬编码所有函数。FE 侧 `catalog/FunctionSet.java` 注册函数元信息。

### 行式路径，无 VExpr

0.14.0 的表达式是纯行式——对 `TupleRow` 求值返回 `AnyVal`。**没有 `vec/exprs/VExpr` 向量化表达式**（向量化是 1.x 才引入，对 `Block` 列存批量求值 `ColumnPtr`）。这使 0.14.0 的 `exprs` 与 `exec`（行式 Volcano）天然匹配——两者都是行粒度，数据从 `OlapScanNode` 的列存 Page 解码为 `TupleRow` 后逐行求值。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合 | `Expr` 树（`:63`） | 表达式递归结构，子 Expr 求值 |
| 解释器 | `Expr.eval` | 解释执行表达式树（非编译） |
| 策略 | 函数按符号 dlsym 加载 | 运行期动态绑定函数实现 |
| 上下文对象 | `ExprContext`（`:49`） | 持有求值状态，避免到处传参 |

## 模块间交互

`exprs` 被 `exec`（`eval_conjuncts`/投影/聚合）强依赖，`AggregationNode` 经 `AggFnEvaluator`（friend `:270`）做聚合。FE 侧 `rewrite/`（`ExprRewriter` 规则）与 `catalog/FunctionSet.java` 定义函数元信息，经 Thrift `TExpr` 下发 BE 构建 `Expr` 树。**0.14.0 不与 `vec/exprs` 交互——该目录不存在。**

## 扩展方式

新增标量函数：在 `be/src/exprs/` 加实现（继承 `Expr`，`expr.h:63`），用 dlsym 注册符号；FE 侧 `catalog/FunctionSet.java` `init()` 注册函数元信息；`gensrc/thrift/Exprs.thrift` 补 `TFunction` 描述。新增谓词类型：实现 `Expr` 子类 + FE 侧 `analysis` 的解析。**0.14.0 不需要实现 `vec::` 向量化版**——这是与 1.x 扩展方式的差异（1.x 双轨需同时加 `VExpr` 列存版）。
