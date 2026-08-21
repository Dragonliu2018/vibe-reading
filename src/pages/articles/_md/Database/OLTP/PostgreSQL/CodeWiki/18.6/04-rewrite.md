---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "查询重写"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "rewrite", "规则系统", "视图展开", "QueryRewrite"]
description: "PostgreSQL rewrite 模块——规则系统 QueryRewrite 三步流程、视图展开 fireRIRrules、INSTEAD 规则、递归检测"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/rewrite/` 是 PostgreSQL 的规则系统（Rule System）。在 parse analysis 之后、planner 之前，把用户定义的重写规则（`CREATE RULE`）应用到 `Query` 上，产出重写后的 Query 树列表。典型用于视图（view）展开——`SELECT on a view` 被重写为对底表的查询。规则系统比视图展开强大得多：`DO ALSO` 可做审计日志，`INSTEAD` 可做路由，条件规则可做条件分发。它在 planner 之前，因 planner 需要最终语义正确的 Query。

---

## 模块架构

核心引擎在 `rewriteHandler.c`（4884 行）：`QueryRewrite`/`RewriteQuery`/`fireRules`/`fireRIRrules`/`ApplyRetrieveRule`/`rewriteTargetView`。`rewriteManip.c`（1975 行）提供 Query 树操作工具（`OffsetVarNodes`/`ChangeVarNodes`/`AddInvertedQual`）。`rewriteDefine.c` 处理 `CREATE RULE` 存储。`rowsecurity.c` 注入行级安全（RLS）策略。`rewriteGraphTable.c`/`rewriteSearchCycle.c` 处理 SQL/PGQ 和 CTE SEARCH/CYCLE。

---

## 调用链路

```
[tcop/postgres.c] pg_rewrite_query()
  → [rewriteHandler.c:4794] QueryRewrite(parsetree)
      ├── Step 1: RewriteQuery()          # 处理非 SELECT 规则（INSERT/UPDATE/DELETE/MERGE）
      │     └── matchLocks() → fireRules() → rewriteRuleAction()
      ├── Step 2: fireRIRrules()           # 处理 ON SELECT 规则（视图展开）
      │     └── ApplyRetrieveRule()        # RTE_RELATION → RTE_SUBQUERY
      └── Step 3: 决定 canSetTag           # 优先原始查询，被 INSTEAD 替换则取最后同类型
      产出 List<Query>
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `QueryRewrite` | 重写总控三步 | 非 SELECT 规则先于 RIR |
| `RewriteQuery` | 处理非 SELECT 规则 | INSERT 先于 UPDATE/DELETE 放结果前 |
| `fireRules` | 触发匹配规则 | 区分 INSTEAD/QUAL_INSTEAD/DO ALSO |
| `fireRIRrules` | 视图展开 | RTE_RELATION→RTE_SUBQUERY，递归检测 |
| `ApplyRetrieveRule` | 单视图展开 | 设 security_barrier |
| `rewriteTargetView` | 自动可更新视图 | 无 INSTEAD 规则时尝试 |

---

## 核心实现

### 重写流程

`QueryRewrite`（`rewriteHandler.c:4794`）三步：①`RewriteQuery` 处理非 SELECT 规则（可能产 0-N 条 Query）；②对每条 `fireRIRrules` 处理 ON SELECT 规则（视图展开）；③决定 `canSetTag`（命令结果标签），优先原始查询，被 INSTEAD 替换则取最后同类型 INSTEAD 查询。

`RewriteQuery`（`rewriteHandler.c:4049`）对非 SELECT：递归处理 WITH 子句 DML → 调整 targetlist（`rewriteTargetListIU`）→ `matchLocks` 收集适用规则 → `fireRules` 触发 → 若是可自动更新视图 `rewriteTargetView` → 递归重写 product queries。

### 视图展开

`fireRIRrules`（`rewriteHandler.c:2041`）遍历 Query 的 rtable，对每个 `RTE_RELATION`：打开关系取 `rel->rd_rules`（RuleLock）→ 筛 `CMD_SELECT` 规则 → `ApplyRetrieveRule`（`rewriteHandler.c:1761`）展开：拷贝视图 `_RETURN` 规则的 Query → 递归 `fireRIRrules` 展开嵌套视图 → 将 RTE 从 `RTE_RELATION` 改为 `RTE_SUBQUERY` 塞入视图查询 → 设 `security_barrier`。

### INSTEAD 规则 vs INSTEAD OF 触发器

| 特性 | INSTEAD 规则 | INSTEAD OF 触发器 |
| --- | --- | --- |
| 定义 | `CREATE RULE ... DO INSTEAD` | `CREATE TRIGGER ... INSTEAD OF` |
| 处理位置 | rewrite 阶段 | executor 阶段 |
| 作用对象 | 表和视图 | 仅视图 |
| 效果 | 替换原始 Query | 保留原始 Query 交 executor |

### 规则匹配与触发

`matchLocks`（`rewriteHandler.c:1686`）从 `relation->rd_rules` 取规则，按 `rule->event == event` 匹配，过滤 disabled/复制角色不匹配的规则。`fireRules`（`rewriteHandler.c:2483`）据 `isInstead`/`qual` 分三类：

| isInstead | qual | querySource | 行为 |
| --- | --- | --- | --- |
| true | false | `QSRC_INSTEAD_RULE` | 替换原始查询 |
| true | true | `QSRC_QUAL_INSTEAD_RULE` | 条件替换（`CopyAndAddInvertedQual` 加反条件） |
| false | - | `QSRC_NON_INSTEAD_RULE` | DO ALSO 同时执行 |

### 关键数据结构

规则存储在 `pg_rewrite` catalog（`pg_rewrite.h:32`）：`ev_type`（'1'=SELECT..'4'=DELETE）、`is_instead`、`ev_qual`/`ev_action`（序列化 node tree）。`RewriteRule`（`prs2lock.h:24`）含 `event`/`qual`/`actions`/`enabled`/`isInstead`。`RuleLock`（`prs2lock.h:40`）通过 `Relation->rd_rules` 访问，relcache 从 `pg_rewrite` 加载。OLD/NEW 占位符 `PRS2_OLD_VARNO=1`/`PRS2_NEW_VARNO=2` 在 `rewriteRuleAction` 中重写为实际 rangetable index。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 规则引擎 | `fireRules` 三类规则 | 声明式改写，视图是特例（ON SELECT DO INSTEAD） |
| 递归检测 | `rewrite_events`/`activeRIRs` | 防无限递归，检测到报错 |
| 上下文传播 | `rewriteRuleAction` 的 Var 重写 | OLD/NEW 映射到实际 RTE |

### 规则系统的能力边界与危险

- **递归检测**：`RewriteQuery` 用 `rewrite_events` 列表（L4503）、`fireRIRrules` 用 `activeRIRs`（L2189），检测到报 `infinite recursion detected`。
- **INSERT 先于其他**（L4600）：INSERT 放结果前部（`lcons`），UPDATE/DELETE 放后部（`lappend`）——因 UPDATE/DELETE 规则动作可能需在原始修改前执行。
- **ON SELECT 规则严格约束**（`DefineQueryRewrite` L315-412）：必须 INSTEAD、单 SELECT 动作、无 qual、必须命名 `_RETURN`、一关系一个。
- **MERGE 限制**：`matchLocks` L1738 拒绝 MERGE 与非 SELECT 规则组合。

---

## 模块间交互

rewrite 依赖 `catalog`（`pg_rewrite` 表，relcache 加载 RuleLock）、`parser/analyze`（Query 结构）、`nodes`（节点遍历/修改）。被 tcop `pg_analyze_and_rewrite_*` 内部调 `QueryRewrite`。`rowsecurity.c` 的 `get_row_security_policies` 在重写时注入 RLS 策略。

---

## 扩展方式

**新增规则类型（如 MERGE 规则）**：`rewriteHandler.c matchLocks`（L1738）移除 MERGE 拒绝 → `RewriteQuery` 的 `CMD_MERGE` 分支（L4304）加 `fireRules` 结果处理 → `rewriteRuleAction` 确保 OLD/NEW 映射 MERGE 目标关系。

**增强自动可更新视图**：`rewriteTargetView` 调 `view_query_is_auto_updatable`（L2725）检查可更新性 → 放宽 `view_col_is_auto_updatable`（L2667）条件 → `rewriteTargetView` 列映射加新类型处理 → 更新 `error_view_not_updatable`（L2873）错误信息。
