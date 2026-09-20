---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "SQL 解析与查询计划"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "查询优化器", "goyacc"]
description: "MatrixOne SQL 层解读：goyacc 解析器、binder 家族、createQuery 定向改写序列与向量/全文索引的插件化计划改写。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/sql/parsers/`（约 6 万行）与 `pkg/sql/plan/`（约 15.7 万行）负责把 SQL 文本变成可执行的计划：词法/语法解析产出 AST，bind 阶段解析表与列，改写阶段做谓词下推、join order、聚合重排、shuffle 决策、索引改写。它独立于执行层的原因是**语义与优化决策需要独立演化**——加一种索引、换一种 shuffle 策略不应触碰执行器；同时计划物化为 protobuf（`pkg/pb/plan`），使它天然成为 plan cache、PREPARE/EXECUTE 复用与跨 CN 传输的公共货币。

## 模块架构

```go title="pkg/sql/plan/types.go"
type QueryBuilder struct {          // L178：bind + 改写引擎
    qry *plan.Query; compCtx CompilerContext
    ctxByNode []*BindContext; tag2Table map[int32]*TableDef
    nextBindTag int32; optimizerHints *OptimizerHints
    // irregular index（IVF/fulltext）DML 维护相关字段 L222-247
}
type Binder interface {             // L432：表达式绑定接口
    // BindExpr / BindColRef / BindAggFunc / BindWinFunc / BindSubquery ...
}
type Rule interface {               // L160：节点级优化规则
    Match(*Node) bool; Apply(*Node, *Query, *process.Process)
}
type CompilerContext interface {    // L89：plan 与 catalog/会话的边界
    // Resolve / ResolveVariable / Stats / GetSnapshot / GetProcess ...
}
```

parsers 侧：`mysql_sql.y`（14.5k 行 yacc 文法）由 goyacc 生成 3 万行 `mysql_sql.go`，AST 节点在 `pkg/sql/parsers/tree/`。plan 侧的核心角色是 `QueryBuilder`（bind + 改写一体）、14 个 binder 子类（`table_binder.go`、`where_binder.go`、`projection_binder.go`…）、以及 `BaseOptimizer`（optimize.go:49）——注意它管理的 `Rule` 接口目前只有常量折叠一条 active 规则（`predicate_pushdown` 被注释掉），主体优化在 `createQuery` 的硬编码序列里。

## 调用链路

![SQL 解析与计划构建](/vibe-reading/images/articles/matrixone-internals/plan-pipeline.svg)

入口 `frontend/mysql_cmd_executor.go:2286` 对 SELECT/UPDATE/DELETE 调 `NewBaseOptimizer(ctx).Optimize(stmt)`，其余语句直接 `BuildPlan`。链条：`parsers.Parse`（sqlparse.go:26）→ `BuildPlan`（build.go:367，约 80 种语句的巨型 type-switch）→ `bindAndOptimizeSelectQuery` → `QueryBuilder.bindSelect`（query_builder.go:2950；bind 阶段 `preprocessCte → buildFrom → buildTable → addBinding`，各子句用对应 binder 绑定表达式）→ `createQuery`（query_builder.go:2102，改写阶段）→ `pruneUsedNodes` 压缩节点数组 → pb Plan。

改写序列是有序的：`optimizeFilters → determineJoinOrder → aggPushDown/aggPullup → applyAssociativeLaw → pushdownSemiAntiJoins → determineShuffleMethod → applyIndices → generateRuntimeFilters → remapAllColRefs`。顺序不可随意调换——`ReCalcNodeStats` 穿插其间且注释明确"determine shuffle 后不能随便重算"。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `parsers.Parse`（sqlparse.go:26） | 文本 → AST | 方言入口 `mysql.Parse`（mysql_lexer.go:73） |
| `BuildPlan`（build.go:367） | 语句 type-switch 分发 | DML 有独立 `bindAndOptimize*` 入口 |
| `QueryBuilder.bindSelect`（query_builder.go:2950） | 解析表/列/子查询 | binder 家族自委托 |
| `QueryBuilder.createQuery`（query_builder.go:2102） | 定向改写序列 | 顺序敏感，stats 穿插重算 |
| `BaseOptimizer.optimize`（optimize.go:61） | 节点级 rule 循环 | `exploreNode` 递归 + `rule.Match/Apply` |
| `applyIndices`（apply_indices.go:631） | 索引改写分发 | `indexplugin.Get(algo).Plan().ApplyForSort` |
</details>

## 核心实现

### binder 家族（Go 版模板方法）

`baseBinder` 内嵌于 14 个子类型，持 `impl Binder` 字段自委托（base_binder.go:71 `b.impl.BindExpr(...)`）——公共绑定逻辑在基类，差异方法（列引用、聚合、窗口）由子类覆写。这是 Go 没有 inheritance 时的标准模板方法替代，代价是所有子类都要小心维护 `impl` 指针。

列引用解析在 `baseBindColRef`（base_binder.go:319）：无表名前缀时先查 `bindingByCol`（当前上下文的绑定），未命中再查 `aliasMap`——UNION 场景下 alias 命中且项目表达式本身是列引用时，**复用已有 project 表达式的 RelPos** 而非当前 projectTag（避免对同一列生成两份投影）；`depth > 0` 时生成 `CorrColRef`（相关子查询引用）；当前上下文解析失败沿 parent 链上溯（跳过某些中间 parent），成功后置 `ctx.isCorrelated` 标记；ENUM/SET 类型列会包装成 cast 函数（`BindFuncExprImplByPlanExpr`）。

### 为什么主体优化是定向改写而非 Cascades

HTAP 场景的重头是工程化改写：聚合下推/上拉、shuffle、runtime filter——每一步都依赖前序的 stats 形态（行数、NDV），且带代价阈值（如 `threshHoldForShuffleJoin=120000`，shuffle.go）。Cascades 的 memo 探索对这类"带阈值的顺序改写"收益低、复杂度高，因此 MatrixOne 选择了**在 `createQuery` 里写死有序序列**，`Rule` 接口只留给可独立应用的节点级规则。（此为代码结构推断的动机，官方文档表述待核实。）

### 计划物化为 protobuf

`pkg/pb/plan/plan.pb.go`（约 6.1 万行生成代码）是计划的唯一形态。为什么不是 Go 结构体：plan 要跨 CN 传输（分布式执行时随 Scope 序列化）、要进 plan cache（frontend/plan_cache.go）与 PREPARE/EXECUTE 复用，pb 提供免反射的紧凑序列化与跨版本兼容。代价是调试时需要在 pb 与语义之间来回映射。

### 向量/全文索引改写的插件化

`ORDER BY l2_distance(embedding, q) LIMIT k` 这类形状由 `buildVectorSortContext`（apply_indices_vector.go:64）模式匹配，然后 `indexplugin.Get(algo).Plan().ApplyForSort(...)` 分发到各算法的 `apply_indices_<algo>.go`。`apply_indices.go:618` 的注释直说动机："pluginless hardcoded switch 是让 CAGRA/IVF-PQ 落后于 HNSW/IVF-FLAT 的 bug 面"——一个循环保持算法集合单一真源。详见 [AI 原生检索](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/09-ai-index)。

### DML 的独立入口与 legacy 回退

INSERT/REPLACE/LOAD/UPDATE/DELETE 各有独立 bind 子阶段（`bind_insert.go` 等），现代路径出错时**按条件回退 legacy 规划器**（build.go）：INSERT 仅当错误是 `ErrUnsupportedDML` 且（无 `OnDuplicateUpdate` 或错误消息等于 `noPkOnDupUpdateMsg`——无主键表的退化 ODKU）时回 `buildInsert`（build.go:82-85）；DELETE/UPDATE/LOAD 均按 `ErrUnsupportedDML` 回退（build.go:233/274/308）；**REPLACE 是唯一无 legacy 回退的 DML 入口**——它把 external-table 哨兵错误（`externalTableUnsupportedDMLMsg`）转换为用户可见的 InvalidInput 错误，不让内部信号泄漏给客户端（build.go:150-158 注释）。

v4.1.4 新增 `irregularMaint*` 字段（types.go:222-247）处理 IVF/fulltext 这类 **1:N 行映射索引**——它们的维护子计划无法套用 `UpdateCtx` 模型，在 `createQuery` 之后追加 post-optimizer 形态的维护计划。

### createQuery 的改写纪律

改写序列有三条纪律（query_builder.go）：`prepareSpecialIndexGuards` → `applyIndices` → `resetSpecialIndexGuards`（:2156-2158）包裹索引改写，防止改写期误删索引节点；`determineShuffleMethod` 之后调用 `ReCalcNodeStats` 时 **needResetHashMapStats 必须为 false**（:2155 注释——shuffle 决策已写进 HashmapStats，重置会推翻已做的决策）；`forceJoinOnOneCN`（:2168）之后**绝不许再调 ReCalcNodeStats**（:2169 注释 "after this, never call ReCalcNodeStats again!!!"）——plan 形态在此时已定型，重算 stats 会与执行器假设脱节。

### shuffle 两轮决策与阈值

`determineShuffleMethod` / `determineShuffleMethod2`（shuffle.go:747/769）分两轮：第一轮对 AGG/TABLE_SCAN/JOIN 分别调 `determineShuffleForGroupBy/ForScan/ForJoin`；第二轮自顶向下修正 Hybrid shuffle。scan 默认 **Hash shuffle**（shuffle.go:708），满足条件时升级 **Range**：首排序列是 ClusterBy 首列或 Pkey 首列（`FakePrimaryKeyColName` 直接跳过）、NDV ≥ `ShuffleThreshHoldOfNDV=50000`、类型在 int/uint/char/varchar/text 集合内（shuffle.go:721-744）。group-by 用 `factor = 1/pow(node.Outcnt/node.Selectivity/child.Outcnt, 0.8)` 自适应阈值（`threshHoldForShuffleGroup=64000 × factor`，shuffle.go:650）并选 **NDV 最高**的分组列做 shuffle 列；join 的 shuffle 分桶可被父 AGG 以 `ShuffleMethod_Reuse` 复用（shuffle.go:414）。第二轮：Hybrid 多 CN shuffle 在 `HashmapSize ≤ threshHoldForHybirdShuffle=4000000` 时**关闭 shuffle**并把父 AGG 的 ShuffleMethod 改回 `ShuffleMethod_Normal`（shuffle.go:788-793）。`optimizerHints.determineShuffle == 1` 完全禁用两轮决策、`== 2` 强制 scan 走 hash shuffle（shuffle.go:710）。

### ROLLUP / CUBE 的 AST 级改写

`bindSelect`（query_builder.go:2950）把 GROUP BY 的 ROLLUP 展开为**逐后缀子集 + 空集**（(a,b,c) → (a,b,c),(a,b),(a),()），CUBE 用回溯算法生成全部子集；多 grouping set 且非 Apart 模式时重写成 `UNION ALL` 链交给 `buildUnion`。bindSelect 追加节点的固定顺序是 AGG/SAMPLE → TIME WINDOW → WINDOW → PROJECT → DISTINCT → SORT，limit/offset 最终挂在排序节点上。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法（自委托） | base_binder.go:71 | 14 个 binder 共享骨架 |
| Rule-based（双轨制） | optimize.go:61 + createQuery 序列 | 节点级规则与全局形态改写分流 |
| Context 注入 | `CompilerContext`（frontend 侧实现 `TxnCompilerContext`，compiler_context.go:54，编译期断言 `var _ plan2.CompilerContext = &TxnCompilerContext{}`） | plan 不依赖 frontend 具体类型 |
| 插件分发 | apply_indices.go:631 | 算法集合可扩展 |

## 模块间交互

parsers → plan 单向（plan 只消费 `tree.*` AST）；`AddRewriteHints`（sqlparse.go）在 AST 上挂 `/*+{json}*/` 改写 hint。plan ↔ frontend 经 `CompilerContext` 解耦；plan → compile 产出 `*pb.plan.Plan`；plan ↔ indexplugin 是扩展点契约。注意 plan 不 import compile/colexec——依赖方向干净向下。

## 扩展方式

- **新增优化 rule**：节点级规则在 `pkg/sql/plan/rule/` 实现 `Match/Apply` 并加入 `optimize.go` 的 `defaultRules`；需要 stats/全局形态的改写则插入 `createQuery` 调用序列（参照 `associative_law.go` 的 `applyAssociativeLaw`）。
- **新增向量索引算法**：实现 indexplugin 的 Plan hook，把改写体放在 `apply_indices_<newalgo>.go` 的 `applyIndicesForSortUsing<NewAlgo>`，并让 `collectVectorIndexes`/`IsVectorIndexAlgo` 认识新 algo。
- **新增 DML 语句 bind**：`build.go:BuildPlan` type-switch 加 case；新建 `bind_<stmt>.go`（仿 `bind_insert.go`）或 `build_<stmt>.go`；涉及不规则索引则扩展 `irregularMaint*` 机制。
