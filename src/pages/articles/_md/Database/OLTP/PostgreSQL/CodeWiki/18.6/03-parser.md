---
source:
  type: "源码解读"
  project: "postgres"
  url: "https://github.com/postgres/postgres"
title: "SQL 解析器"
date: "2026-08-21T17:55:32+08:00"
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]
tags: ["PostgreSQL", "parser", "flex", "bison", "ParseState"]
description: "PostgreSQL parser 模块——flex/bison 两阶段解析（raw parse + semantic analysis）、ParseState 上下文、RangeTblEntry、base_yylex LALR(1) 处理"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)

---

## 模块定位

`src/backend/parser/` 把 SQL 文本翻译成语义完整的 `Query` 结构。严格分两阶段：**Raw Parse**（flex 词法 + bison 语法）把文本变原始语法树 `RawStmt`；**Parse Analysis**（语义分析）把 raw tree 转成语义完整的 `Query`，解析表名/列名/类型/函数对系统目录的引用。两阶段分离的核心原因是事务安全——raw parse 不访问任何目录，即使事务已 abort 仍能解析 SQL 以找到后续 ROLLBACK/COMMIT。

---

## 模块架构

parser 由两阶段文件组成。Raw parse：`parser.c`（入口 `raw_parser` + `base_yylex` 中间层）、`scan.l`（flex 词法）、`gram.y`（bison 语法，~21000 行最大单文件）。Semantic analysis：`analyze.c`（`parse_analyze`/`transformStmt` 总控）+ 15 个 `parse_*.c`（`parse_relation.c` 表/列、`parse_expr.c` 表达式、`parse_coerce.c` 类型转换、`parse_clause.c` FROM 子句、`parse_func.c`/`parse_type.c`/`parse_oper.c` 等）。

---

## 调用链路

```
[tcop/postgres.c] exec_simple_query
  → pg_parse_query(query_string) → raw_parser(str, RAW_PARSE_DEFAULT)   # 阶段一
      产出 List<RawStmt>
  → pg_analyze_and_rewrite_fixedparams()
      → parse_analyze_fixedparams() → transformTopLevelStmt → transformStmt  # 阶段二
      → pg_rewrite_query() → QueryRewrite()   # 重写（非 parser）
      产出 List<Query>
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `raw_parser` | flex/bison 解析文本 | 不访问目录，事务安全 |
| `base_yylex` | token lookahead 过滤 | 多 token 降为单 token 保 LALR(1) |
| `parse_analyze_fixedparams` | 语义分析总入口 | ParseState 上下文递归 |
| `transformStmt` | 按 nodeTag 分发 | SelectStmt→Query 的语义转换 |
| `transformFromClause` | FROM 子句 → RTE | 10 种 RTEKind 工厂 |
| `transformColumnRef` | 列引用 → Var | parentParseState 链外层引用 |

---

## 核心实现

### Raw Parse

`raw_parser`（`parser.c`）用 flex（`scan.l`，1430 行）+ bison（`gram.y`，21024 行）。`scan.l` 用 start condition 状态机（`<xc>`块注释、`<xq>`字符串、`<xd>`标识符、`<xdolq>`dollar-quoting 等）管理复杂词法，关键字表在 `kwlist.h` 用 `PG_KEYWORD` 宏定义。

`base_yylex`（`parser.c`）是 flex `core_yylex` 与 bison 之间的中间层，解决 SQL 需多 token lookahead 但 bison 是 LALR(1) 的问题：对 `NOT`/`WITH`/`NULLS`/`FORMAT` 等 token 做 lookahead，据后续 token 替换为 `_LA` 专用 token（如 `NOT_LA`），将多 token 区分降为单 token。

`gram.y` 用 `%pure-parser`（可重入）+ `%union`（~40 种语义值类型）+ 优先级声明（UNION 最低到 JOIN 最高）+ `parse_toplevel`/`stmtmulti`/`stmt`/`simple_select` 产生式。`RawStmt`（`parsenodes.h:2227`）包装单条语句含位置信息。

### Parse Analysis

`parse_analyze_fixedparams`（`analyze.c`）→ `transformStmt` 按 `nodeTag` 分发到 `transformSelectStmt`/`transformInsertStmt` 等。以 SELECT 为例（`analyze.c:1742`），`transformSelectStmt` 顺序：`transformWithClause`（CTE）→ `transformFromClause`（FROM→RTE）→ `transformTargetList`（目标列）→ `transformWhereClause`（WHERE/HAVING）→ `transformSortClause`/`transformGroupClause`/`transformDistinctClause`/`transformLimitClause` → `resolveTargetListUnknowns` → `parseCheckAggregates`。

**ParseState**（`parse_node.h:211`）是语义分析全程上下文，核心字段：`p_rtable`（范围表）、`p_namespace`（可见列）、`p_joinlist`（join 树）、`p_target_relation`（DML 目标表）、`p_expr_kind`（表达式种类）、`parentParseState`（子查询外层引用链）。需要它因分析递归——子查询有自己 ParseState，通过 `parentParseState` 实现外层列引用（`varlevelsup`）。

**RangeTblEntry**（`parsenodes.h:1139`）表 FROM 子句一个数据源，10 种 `RTEKind`：`RTE_RELATION`（表）、`RTE_SUBQUERY`（子查询）、`RTE_JOIN`、`RTE_FUNCTION`、`RTE_VALUES`、`RTE_CTE` 等，各有 `addRangeTableEntryFor*` 工厂（`parse_relation.c`）。

**列引用解析**：`ColumnRef` → `transformColumnRef`（`parse_expr.c:509`）按字段数分发——1 字段 `colNameToVar`（`parse_relation.c:930`）搜 `p_namespace`；2 字段 `relname.colname` 先找 RTE 再 `scanNSItemForColumn`。`colNameToVar` 通过 `parentParseState` 链向上查找支持子查询引用外层列。

**类型转换**（`parse_coerce.c`，3414 行）：`coerce_to_target_type` → `can_coerce_type` 检查 → `coerce_type` 执行 → `coerce_type_typmod` 约束。支持隐式（`COERCION_IMPLICIT`）/赋值/显式转换。

### 关键数据结构对比

| raw tree 节点 | 分析后节点 | 转换 |
| --- | --- | --- |
| `RawStmt` | `Query` | 含 rtable/jointree/targetList |
| `SelectStmt` | `Query` | FROM RangeVar→RangeTblRef |
| `ColumnRef` | `Var` | 含 varno(RTE索引)/varattno(列号)/varlevelsup |
| `ResTarget` | `TargetEntry` | 含 resno/resjunk |
| `RangeVar` | `RangeTblEntry` | 10 种 RTEKind |

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段编译 | raw parse + analyze | 事务安全：aborted 事务仍可解析找 ROLLBACK |
| 上下文对象 | ParseState | 递归分析共享 rtable/namespace，parentParseState 链支持外层引用 |
| 工厂方法 | `addRangeTableEntryFor*` | 10 种 RTE 各自构造逻辑 |
| Hook | `p_pre_columnref_hook`/`p_paramref_hook` | PL/pgSQL 等扩展自定义列/参数解析 |

### 为什么 gram.y 这么大

PostgreSQL 支持极丰富 SQL 方言：DDL（CREATE/ALTER/DROP 涵盖表/索引/视图/序列/函数/类型/操作符/扩展/发布/订阅数十种对象）、DML（SELECT/INSERT/UPDATE/DELETE/MERGE 各自复杂语法）、DCL/TCL、PL/pgSQL 交互（CALL）、窗口函数、递归 CTE、JSON/SQLJSON、GRAPH_TABLE、属性图。每种语法独立产生式，故 21000+ 行。

---

## 模块间交互

parser 依赖 `catalog`（`table_open` 查表 OID/列）、`utils/lsyscache`（目录缓存 `get_attname` 等）、`nodes`（节点定义/构造）、`utils/adt`（内置类型函数）。被 tcop `pg_parse_query`/`pg_analyze_and_rewrite_*` 调用，也被 `parse_utilcmd.c`（utility 子查询延迟分析）和 PL/pgSQL（`RAW_PARSE_PLPGSQL_*` 模式）调用。

---

## 扩展方式

**新增 SQL 语法**：`kwlist.h` 加 `PG_KEYWORD` → `gram.y` 加 `%token`/`%type`/产生式 → 多 token lookahead 时在 `base_yylex` 加 `_LA` 处理 → 需新节点时 `parsenodes.h` 加 struct → `analyze.c transformStmt` switch 加 case + 写 `transformXxxStmt`。

**新增 RangeTblEntry 类型**：`parsenodes.h` 的 `RTEKind` enum 加 + RTE 加字段 → `parse_relation.c` 加 `addRangeTableEntryForXxx` → `parse_clause.c transformFromClauseItem` 加分支 → `parse_relation.c scanRTEForColumn` 加列扫描 → `ruleutils.c` 加 deparse → `copyfuncs.c`/`equalfuncs.c`/`outfuncs.c` 加节点支持。

**新增内置数据类型**：`pg_type.dat` 定义 OID → `parse_type.c typenameTypeId` 处理 → `parse_coerce.c can_coerce_type`/`coerce_type` 加转换路径 → `utils/adt/` 加 I/O 函数/运算符 → `pg_operator.dat`/`pg_opclass.dat` 定义索引支持。
