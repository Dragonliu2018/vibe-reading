---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "旧版优化器"
date: "2026-08-23T18:57:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Analyzer", "Legacy Planner", "Impala"]
description: "Doris 3.1.4 旧版优化器：Impala 式 Analyzer + DistributedPlanner，Nereids 不支持时的回退安全网。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

旧版优化器由 `analysis/`（~9 万行，`Analyzer` + 各 `Stmt`）与 `planner/`（~2.5 万行，`DistributedPlanner`）组成，是 Nereids 全面接管前的查询规划路径，源自早期 Impala 式分析器。在 3.1.4-rc02 中它**不再作为默认**（默认是 [Nereids](01-nereids-optimizer)），但完整保留作为**回退安全网**：当 Nereids 遇到不支持的语法/特性或抛 `MustFallbackException` 时，`StmtExecutor.executeByLegacy()` 接管。它独立成文正是因为这条"兜底路径"在 3.1.x 仍是真实存在的代码域，理解回退边界对诊断查询行为至关重要。

## 模块架构

旧版优化器是命令式的"分析→计划"两阶段，没有 Memo、没有代价搜索，依赖 `Analyzer` 的 select block 与 slot id 映射做符号解析：

```
SQL 文本
   │  legacy parser (JavaCC，Nereids 之前的解析器)
   ▼
StatementBase (Stmt)
   │  Analyzer.analyzeStmt()  ── 符号绑定：slot id / table alias / 子查询 scope
   ▼
analyzed Stmt (带 Analyzer 上下文)
   │  Planner / DistributedPlanner.createPlanFragments()
   ▼
PlanFragment 树 (SingleNodePlan → 分布式切分)
   │  交给 Coordinator 调度（与 Nereids 共用）
   ▼
```

`Analyzer`（`analysis/Analyzer.java:116`）是旧版核心——它存储"每个 select block 的分析状态"（`Analyzer.java:514` 描述 "an analyzer stores analysis state for a single select block"），通过 slot id 到 analyzer/block 的映射（`:427`）管理列引用与子查询作用域，支持嵌套 `analyze()` 调用并强制深度（`:164` "Current depth of nested analyze() calls"）。

## 调用链路

```
StmtExecutor.executeByLegacy (StmtExecutor.java:669 调用)
  └─ parse (legacy parser，产出 StatementBase)
  └─ analyzedStmt.analyze(analyzer)  ── Analyzer.analyzeStmt
       ├─ register table alias / resolve slot / bind function
       └─ 子查询递归 analyze (嵌套 scope)
  └─ planner = new Planner(...)  或 DistributedPlanner
  └─ DistributedPlanner.createPlanFragments (planner/DistributedPlanner.java:81)
       ├─ 单节点计划 SingleNodePlan
       └─ createPlanFragments(singleNodePlan, isPartitioned, fragments) (:104)
            └─ 递归按 Exchange 边界切分 PlanFragment
  └─ Coordinator 消费 fragments（与 Nereids 路径汇合）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Analyzer.analyzeStmt` | 符号绑定 | select block 状态 + slot id 映射，Impala 式作用域 |
| `DistributedPlanner.createPlanFragments` (`:81`) | 计划切分 | 递归按 Exchange 切分，SingleNodeExec 短路 |
| `StmtExecutor.executeByLegacy` | 回退执行 | 重置 Nereids 失败状态后走 legacy 全流程 |

</details>

## 核心实现

### 回退判定：何时走 legacy

回退发生在 `StmtExecutor`（`StmtExecutor.java:636-670`）：

```java title="StmtExecutor.java"
try {
    executeByNereids(queryId);
} catch (NereidsException | ParseException e) {
    // only must fall back + unsupported command could use legacy planner
    if ((e instanceof NereidsException
            && !(((NereidsException) e).getException() instanceof MustFallbackException))
            || !(parsedStmt instanceof LogicalPlanAdapter
                && ((LogicalPlanAdapter) parsedStmt).getLogicalPlan() instanceof Command)) {
        // 不是 MustFallback 也不是 Command → 报错，不回退
        context.getState().setError(e.getMessage());
        return;
    }
    context.getState().setNereids(false);   // 标记走 legacy
    executeByLegacy(queryId);              // 回退
}
```

设计决策：**为何不是所有 Nereids 失败都回退**——只有显式声明"必须回退"（`MustFallbackException`）或属于 Command 类语句（DDL 等）才回退；普通 NereidsException 直接报错。这避免了对 Nereids 真正 bug 的静默掩盖：真正失败要暴露，而非悄悄退化。

### Analyzer 的 select block 模型

`Analyzer` 用 "block" 模型管理查询作用域（`:514`）：每个 SELECT/子查询是一个 block，持有自己的 slot 注册表、表别名到 view 定义的映射（`:520`）。子查询通过新建子 Analyzer 并标记 `isSubquery`（`:169`）递归分析，保证列引用按词法作用域解析。这是经典 Impala 分析器设计，与 Nereids 的 unbound→bound bound 计划树风格不同——前者命令式带状态，后者声明式纯数据。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 命令式分析器 | `analysis/Analyzer.java` | 带 block 状态的符号解析，Impala 沿袭 |
| 递归计划切分 | `DistributedPlanner.createPlanFragments` | 树形递归，按 Exchange 边界自然切分 |
| 策略回退 | `StmtExecutor` 异常分支 | 显式异常类型决定回退，避免静默退化 |

## 模块间交互

旧版优化器**依赖** `catalog/`（表/列元数据绑定）、`datasource/`（外部表）。**被** `qe/StmtExecutor` 在回退时调用。与 `nereids/` 是互斥关系——同一条 SQL 只走其一，由 `StmtExecutor` 异常处理决定。产物 `PlanFragment` 树交给同一个 `qe/Coordinator`，故下游协调与执行对两条路径透明。

## 扩展方式

3.1.x 不建议在旧版优化器新增能力——它是回退路径，逐步淘汰中。若必须支持某 Nereids 未覆盖的语法：优先在 `nereids/parser/` 增强解析与 `nereids/rules/` 增规则；确需 legacy 支持时改 `analysis/` 对应 `Stmt` 与 `DistributedPlanner`。对应测试：`regression-test/suites/nereids_p0/` 与 `regression-test/suites/load_p0/`。
