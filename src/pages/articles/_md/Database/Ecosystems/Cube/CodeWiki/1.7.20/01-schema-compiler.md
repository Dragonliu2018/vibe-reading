---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "语义编译器"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "TypeScript", "语义层", "SQL 编译"]
description: "Cube.js 语义层核心：数据模型编译与跨方言 SQL 生成"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

## 模块定位

`cubejs-schema-compiler` 是 Cube.js 语义层的心脏。它在整体架构中处于**语义层**——上游接收用户用 JavaScript / YAML / Jinja 写的数据模型（cube、measure、dimension、join、pre-aggregation 定义），下游产出可执行 SQL 查询和查询计划，供 query-orchestrator 执行。

一句话职责边界：**把声明式语义模型编译成跨方言 SQL**。它不执行查询、不连数据库、不做缓存——这些是 query-orchestrator 和 driver 的职责。它的产物是 `SqlResult`（SQL 字符串 + 参数 + 预聚合描述 + 元数据）。

模块规模 33,166 行 TypeScript（90 文件），内部按职责分化为五个子目录：

| 子目录 | 行数 | 职责 |
|--------|------|------|
| `parser/` | 16,042 | ANTLR 生成的 Python3/GenericSql parser + 手写 SqlParser/PythonParser（用于 inline where 优化） |
| `compiler/` | 9,033 | 编译流水线编排、符号解析、校验、join 图、meta 转换 |
| `adapter/` | 6,943 | SQL 拼装基类 BaseQuery、方言适配器、pre-aggregation 匹配 |
| `scaffolding/` | 974 | 脚手架/模板生成 |
| `extensions/` | 170 | Funnels / RefreshKeys / Reflection 三个扩展 |

> parser/ 的 16k 行大部分是 ANTLR 自动生成的 `Python3Parser.ts`（29.5 万行）和 `GenericSqlParser.ts`（4.7 万行），非手写业务逻辑。真正承载语义编译逻辑的是 `compiler/` 和 `adapter/`。

---

## 模块架构

schema-compiler 内部按"编译流水线"组织，五组组件协作完成"模型定义 → SQL"的转换：

```
┌─────────────────────────────────────────────────────────────────┐
│  DataSchemaCompiler（编排器，compiler/DataSchemaCompiler.ts）      │
│  持有 5 组 CompilerInterface[]，按 4 阶段串行执行                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │ CubeSymbols  │──▶│ CubeEvaluator│──▶│ CubeToMetaTransformer│ │
│  │ 符号解析      │   │ 语义求值      │   │ meta JSON 生成       │ │
│  │ (stage 1)    │   │ (stage 3)    │   │ (stage 3)            │ │
│  └──────────────┘   └──────────────┘   └────────────────────┘  │
│         │                  │                                    │
│         │   ┌──────────────┴───┐                                │
│         └──▶│   JoinGraph      │  join 路径图 + 行翻倍检测        │
│             │   (stage 3)      │                                │
│             └──────────────────┘                                │
│                                                                 │
│  ┌──────────────┐   ┌──────────────────────────────────────┐   │
│  │ CubeValidator│   │  Transpilers (Babel AST 变换链)         │   │
│  │ 合法性校验    │   │  ImportExport / CubePropContext / IIFE  │   │
│  │ (stage 1)    │   │  (stage 0-1)                           │   │
│  └──────────────┘   └──────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  V8 沙箱 (vm.createContext) — 隔离执行用户数据模型代码              │
│  AsyncLocalStorage — 让 cube() 全局函数感知当前文件名               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  adapter/ — SQL 生成层                                    │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │   │
│  │  │ BaseQuery  │─▶│ PreAggregations│─▶│ 方言子类         │  │   │
│  │  │ (模板方法) │  │ (匹配 + 描述)  │  │ PostgresQuery等 │  │   │
│  │  └────────────┘  └──────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**组件协作逻辑**：上半部分（compiler/）负责把数据模型文件编译成 `EvaluatedCube` 语义模型——CubeSymbols 先做轻量符号解析，CubeValidator 校验合法性，CubeEvaluator 在合法 cube 上做完整求值，JoinGraph 计算 join 路径。下半部分（adapter/）在语义模型基础上生成 SQL——`BaseQuery` 用模板方法定义 SQL 骨架，`PreAggregations` 负责预聚合匹配，方言子类覆盖差异点。两层通过 `CubeEvaluator` 和 `JoinGraph` 共享编译产物。

---

## 调用链路

### 链路 A：数据模型 → 编译完成（4 阶段流水线）

```
prepareCompiler() [compiler/PrepareCompiler.ts:61]
  │  实例化 CubeSymbols, CubeValidator, CubeEvaluator, JoinGraph, CubeToMetaTransformer
  │  组装 transpilers 链 + new DataSchemaCompiler
  ▼
DataSchemaCompiler.compile() [compiler/DataSchemaCompiler.ts:547]
  └─ doCompile() [ts:254]
      ├─ repository.dataSchemaFiles()                  加载 .js/.yaml/.jinja 文件
      ├─ vm.createContext({cube(), view(), context(), require(), ...})  V8 沙箱 [ts:397]
      │
      ├─【Stage 0】compilePhaseFirst({ cubeNameCompilers }, 0)
      │    └─ 执行原始 JS → CubeDictionary.compile() 收集 cube 名称
      │
      ├─【Stage 1】compilePhase({ preTranspileCubeCompilers }, 1)
      │    └─ 用 stage 0 名称做 Babel 符号替换（CUBE.status → orders.status）
      │    └─ CubeSymbols.compile() [CubeSymbols.ts:314] → createCube() 构建符号表
      │    └─ CubeValidator.compile() [CubeValidator.ts:1399] 校验合法性
      │
      ├─【Stage 2】compilePhase({ viewCompilers }, 2)  [条件执行：shouldCompileViews()]
      │    └─ View 层符号解析
      │
      ├─【Stage 3】compilePhase({ cubeCompilers, contextCompilers, metaCompilers }, 3)
      │    ├─ CubeEvaluator.compile() [CubeEvaluator.ts:218]
      │    │    └─ prepareCube() [ts:247] → prepareJoins / preparePreAggregations / prepareMembers
      │    ├─ JoinGraph.compile() [JoinGraph.ts:64] → buildJoinEdges() [ts:112] → new Graph(nodes)
      │    ├─ ContextEvaluator.compile()
      │    └─ CubeToMetaTransformer.compile() → 生成 meta JSON
      │
      └─ throwIfAnyErrors() [ts:550]
```

**数据结构变化**：原始文件字符串 → V8 沙箱执行后的 `CubeDefinition[]`（带 name/fileName）→ Stage 1 符号替换后的 transpiled 代码 → `CubeDefinitionExtended`（带惰性求值 proxy）→ `EvaluatedCube`（完整语义模型，含 joins/preAggregations/measures/dimensions）→ meta JSON。

**设计考量**：分四阶段是因为 transpile 需要知道所有 cube 名称才能做符号替换，但 cube 名称只有在 stage 0 执行后才知道——典型的"先收集再变换"两遍扫描。每个 stage 调用 `cleanup()` 清空数组再重新执行，确保各阶段从干净状态开始。

### 链路 B：查询请求 → SQL 生成（buildSqlAndParams）

```
CompilerApi.getSql(query) [server-core/CompilerApi.ts:350]
  ├─ getSqlGenerator(query) [ts:315]
  │   ├─ getCompilers() → prepareCompiler() / 缓存的 Compiler
  │   ├─ getDialectClass(dataSource, dbType) → 返回 BaseQuery 子类
  │   └─ createQueryByDataSource() → QueryFactory.createQuery() [adapter/QueryFactory.ts:7]
  │       └─ new PostgresQuery(compilers, opts) → initFromOptions() [BaseQuery.js:251]
  │           └─ 解析 measures/dimensions/filters → BaseMeasure/BaseDimension/BaseFilter 对象
  │
  └─ sqlGenerator.buildSqlAndParams(exportAnnotatedSql) [adapter/BaseQuery.js:877]
      ├─ [if useNativeSqlPlanner] → buildSqlAndParamsRust() [ts:932]  Tesseract Rust 路径
      ├─ [if external pre-agg]    → externalQuery().buildSqlAndParams()
      └─ [默认 JS 路径]
          buildParamAnnotatedSql() [BaseQuery.js:772]
            ├─ preAggregations.findPreAggregationForQuery()  尝试匹配 pre-agg
            ├─ [if preAgg && 无 cumulative] → rollupPreAggregation()
            ├─ [if preAgg && 有 cumulative] → regularAndTimeSeriesRollupQuery() [ts:830]
            └─ [无 pre-agg] → fullKeyQueryAggregate() [ts:1262]
                ├─ [无 multiplied/cumulative] → simpleQuery() [ts:1244]
                └─ [有 multiplied] → 拆分 measure 到子查询 → joinFullKeyQueryAggregate()

simpleQuery() [BaseQuery.js:1244]  建造者模式逐步拼接：
  commonQuery()  →  baseWhere()  →  groupByClause()  →  baseHaving()  →  orderBy()  →  groupByDimensionLimit()
   SELECT           WHERE           GROUP BY            HAVING           ORDER BY       LIMIT
```

**关键设计**：`buildParamAnnotatedSql()` 是 SQL 生成的调度中枢，它先尝试预聚合匹配——命中则走 `rollupPreAggregation()`（查预聚合表，低延迟），未命中则回退 `fullKeyQueryAggregate()`（直接查源数据）。`simpleQuery()` 内部用建造者模式按固定顺序拼接 SQL 子句，每个子句生成逻辑独立且可缓存。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `compile()` | `DataSchemaCompiler.ts:547` | 编译入口，幂等（compilePromise 缓存） | 避免并发重复编译 |
| `createCube()` | `CubeSymbols.ts:352` | 创建带惰性求值的 CubeDefinitionExtended | 处理 cube extends 和 view 引用 |
| `prepareCube()` | `CubeEvaluator.ts:247` | 编译 joins/preAggregations/members | 语义求值核心 |
| `buildJoin()` | `JoinGraph.ts:173` | 计算多 cube join 最短路径 | 用 node-dijkstra 最少 JOIN 数 |
| `findMultiplicationFactorFor()` | `JoinGraph.ts:300` | 递归检测行翻倍 | hasMany/belongsTo 的 sum/count 正确性保障 |
| `findPreAggregationForQuery()` | `PreAggregations.ts` | 匹配可用预聚合 | 集合包含 + granularity 层级 |
| `transformQueryToCanUseForm()` | `PreAggregations.ts:475` | 查询标准化为可匹配形式 | 拍平到 leaf measure 级别 |
| `buildSqlAndParams()` | `BaseQuery.js:877` | SQL 生成入口 | 调度 pre-agg 路径 vs 原始 SQL 路径 |
| `buildParamAnnotatedSql()` | `BaseQuery.js:772` | SQL 生成调度中枢 | 选 pre-agg 路径或回退 |
| `simpleQuery()` | `BaseQuery.js:1244` | 基础 SELECT 拼接 | 建造者模式 |
| `buildSqlAndParamsRust()` | `BaseQuery.js:932` | Rust SQL Planner 路径 | 性能优化，大查询加速 |
| `sqlTemplates()` | `BaseQuery.js` / `PostgresQuery.ts:78` | 模板化 SQL 片段 | 为 Rust Planner 提供纯数据描述 |

</details>

---

## 核心实现

### CubeSymbols 与 CubeEvaluator 分层

语义编译被刻意分成两层：`CubeSymbols`（`compiler/CubeSymbols.ts:281`）负责最基础的符号解析——收集 cube 定义、创建 `CubeDefinitionExtended`、解析 `CUBE`/`TABLE` 等符号引用；`CubeEvaluator extends CubeSymbols`（`compiler/CubeEvaluator.ts:203`）在此基础上做完整语义求值——`prepareCube()` 编译 joins、pre-aggregations、measures、dimensions，生成 `EvaluatedCube`。

```typescript title="compiler/CubeSymbols.ts:281"
export class CubeSymbols implements TranspilerSymbolResolver, CompilerInterface {
  public symbols: Record<string, CubeSymbolsDefinition>;    // cubeName → 符号表
  public cubeDefinitions: Record<string, CubeDefinition>;
  public cubeList: CubeDefinitionExtended[];

  public compile(cubes: CubeDefinition[], errorReporter: ErrorReporter): void
  public createCube(cubeDefinition: CubeDefinition): CubeDefinitionExtended  // 工厂，构建带惰性求值的 cube proxy
  public evaluateReferences<T>(cubeName, path, opts?): T                    // join path → 完整引用路径
  public static joinHintFromPath(path: string): { path, joinHint }
}
```

```typescript title="compiler/CubeEvaluator.ts:203"
export class CubeEvaluator extends CubeSymbols {
  public evaluatedCubes: Record<string, EvaluatedCube>;   // 编译后的完整 cube 语义模型
  public primaryKeys: Record<string, string[]>;           // cubeName → primaryKey 维度名列表

  public compile(cubes, errorReporter): void               // super.compile 后执行 prepareCube
  protected prepareCube(cube, errorReporter): EvaluatedCube // prepareJoins/preAggregations/members/hierarchies/accessPolicy
  public measuresForCube(cube): Record<string, MeasureDefinition>
  public isMeasure(measurePath): boolean
}
```

**为什么分两层**：符号解析是 transpile 阶段（stage 1）需要的——Babel 变换时要知道哪些名字是 cube 符号才能把 `CUBE.status` 替换为 `orders.status`。而完整语义求值依赖校验完成后的合法 cube 列表，属于 stage 3。分成两层让 transpile 阶段只用 `CubeSymbols`（轻量），求值阶段才用 `CubeEvaluator`（重量），避免循环依赖。

**createCube 的惰性 proxy** 是处理 cube `extends` 和 view 引用的关键。`createCube()`（`CubeSymbols.ts:352`）用 `Object.assign` 创建带惰性 getter 的 proxy 对象，让 `measures`/`dimensions` 等属性在**首次访问时才求值**——因为 view 引用的 cube 可能在编译时尚未完全解析，惰性求值让引用方推迟到 stage 3 才真正读取被引用方的完整定义。

### JoinGraph 最短路径与行翻倍检测

`JoinGraph`（`compiler/JoinGraph.ts:34`）把 cube 间 join 关系建模为有向图，解决两个核心问题：多 cube 查询时选 join 路径最少的那条，以及检测 `hasMany`/`belongsTo` 导致的行翻倍。

```typescript title="compiler/JoinGraph.ts:34"
export class JoinGraph implements CompilerInterface {
  private nodes: Record<string, Record<string, 1>>;          // 有向图: cube → {neighbor: 1}
  private undirectedNodes: Record<string, Record<string, 1>>; // 无向图，用于连通分量
  private edges: Record<string, JoinEdge>;                   // "from-to" → JoinEdge
  private graph: Graph | null;                               // node-dijkstra Graph 实例
  private builtJoins: Record<string, FinishedJoinTree>;      // join 结果缓存

  public compile(cubes, errorReporter): void                 // 从 cube.joins 构建 edges + nodes + graph
  public buildJoin(cubesToJoin: JoinHints): FinishedJoinTree | null  // 核心：计算最短 join 路径
  protected buildJoinTreeForRoot(root, cubesToJoin): JoinTree | null // 对每个目标调用 graph.path()
  protected findMultiplicationFactorFor(cube, joins): boolean        // 递归检测 hasMany/belongsTo 行翻倍
  public connectedComponents(): Record<string, number>
}
```

**最短路径**：当查询涉及多个 cube 时，join 路径不唯一（A→B→C vs A→C→B→D）。`buildJoin()`（`JoinGraph.ts:173`）对每个目标 cube 调用 `graph.path(prevNode, toJoin)` 计算最短路径，`buildJoinTreeForRoot()`（`ts:219`）尝试以每个 cube 为根，选 join 数最少的树。**为什么**：最少 JOIN 数减少查询开销和中间结果大小。

**行翻倍检测**是 SQL 正确性的关键保障。`findMultiplicationFactorFor()`（`JoinGraph.ts:300`）递归检测 `hasMany`/`belongsTo` 导致的行翻倍——如果一个 cube 的行会因 `hasMany` join 翻倍，其 measure 聚合需要特殊处理（拆分到子查询 `aggregateSubQuery`），否则 `count`/`sum` 会因笛卡尔积重复计算。`buildJoinEdges()`（`ts:112`）还会校验：有 join 的 cube 如果有 multiplied measure（sum/avg/count/number）但没有 primaryKey，会报错——因为 primaryKey 是区分行身份的唯一方式，没有它就无法正确去重。

### 四阶段编译流水线与 V8 沙箱

数据模型文件是用户代码，直接 `require` 有安全风险和命名冲突。schema-compiler 用 **V8 沙箱 + AsyncLocalStorage** 隔离执行用户代码，并用四阶段流水线确保编译顺序正确。

```typescript title="compiler/DataSchemaCompiler.ts:397"
compileV8ContextCache = vm.createContext({
  cube(), view(), context(), view_group(), require(), asyncModule(), ...
});
const ctxFileStorage = new AsyncLocalStorage<FileContent>();  // ts:24
```

在 V8 沙箱 context 中定义全局函数 `cube()`、`view()`、`context()`，transpiled JS 文件在此 context 中执行，cube 定义通过 `cube(name, definition)` 全局调用被收集到 `cubes` 数组。

**四阶段流水线**（`DataSchemaCompiler.ts:512-522`）：

```
Stage 0: cubeNameCompilers      → 执行原始 JS → 收集 cube 名称
Stage 1: preTranspileCubeCompilers → 用 stage 0 名称做 Babel 符号替换 → CubeSymbols 解析 → CubeValidator 校验
Stage 2: viewCompilers          → View 层符号解析（条件执行）
Stage 3: cubeCompilers + metaCompilers → CubeEvaluator.prepareCube() → JoinGraph.compile() → CubeToMetaTransformer
```

**为什么四阶段**：transpile 需要知道所有 cube 名称才能把 `CUBE.status` 替换为 `orders.status`，但 cube 名称只有在 stage 0 执行后才知道。所以 stage 0 先执行原始代码收集名称，stage 1 用这些名称做 transpile（符号替换），stage 3 在 transpiled 代码上做完整求值。Stage 2 是条件执行——View 可引用其他 View，需先解析基础 View 才能解析引用 View。每个 stage 调用 `cleanup()`（`ts:388`）清空 `cubes`/`contexts`/`viewGroups` 数组再重新执行，确保各阶段从干净状态开始。Jinja/YAML 文件只在 stage 0 渲染一次（`ts:496-499`），后续阶段复用转换后的 JS。

**AsyncLocalStorage 解决全局函数的"我是谁"问题**：`cube()` 被 `vm.runInContext` 调用时没有 JS 调用栈信息，无法知道是哪个文件在调用它。`AsyncLocalStorage.run(file, fn)`（`ts:455`）在异步上下文中传播文件名，让 `cube()` 能通过 `ctxFileStorage.getStore()`（`ts:399`）获取当前文件名，实现文件级错误报告。`asyncModule()`（`ts:447`）也依赖此机制，确保异步模块代码在原始数据模型文件上下文中运行。`require()` 被拦截（`ts:457`）只允许加载已注册的 extension 或本地模块。

### 跨方言 SQL 生成双轨制

Cube.js 支持 29 种数据源，每种 SQL 方言不同（`date_trunc` vs `DATE_TRUNC`、`$1` vs `?`、HLL 实现差异）。schema-compiler 用**模板方法 + sqlTemplates 双轨制**适配方言。

`BaseQuery`（`adapter/BaseQuery.js:104`）用模板方法定义 SQL 生成骨架，子类覆盖差异点：

```typescript title="adapter/BaseQuery.js:104"
export class BaseQuery {
  buildSqlAndParams(exportAnnotatedSql): [string, any[]]   // 公开入口
  buildParamAnnotatedSql(): string                         // 核心调度
  simpleQuery(): string                                    // SELECT...FROM...WHERE...GROUP BY...
  // 可被子类覆盖的模板方法：
  newParamAllocator(expressionParams): ParamAllocator      // 占位符（默认 ?）
  newMeasure / newDimension / newFilter / newSegment       // 成员工厂
  convertTz(field): string                                 // 时区转换（子类覆盖）
  timeGroupedColumn(granularity, dimension): string        // 时间截断（子类覆盖）
  sqlTemplates(): object                                   // 模板化 SQL 片段（子类扩展）
}
```

```typescript title="adapter/PostgresQuery.ts:22"
export class PostgresQuery extends BaseQuery {
  public newParamAllocator(expressionParams) { return new PostgresParamAllocator(expressionParams); }  // $1, $2
  public convertTz(field): string { return `(${field}::timestamptz AT TIME ZONE '${this.timezone}')`; }
  public timeGroupedColumn(granularity, dimension): string { return `date_trunc('${...}', ${dimension})`; }
  public hllInit(sql): string; public hllMerge(sql): string; public countDistinctApprox(sql): string;
  public sqlTemplates(): object  // 覆盖 DATE_TRUNC, CONCAT, DATEDIFF 等模板
}
```

**为什么双轨并存**：两种机制并存是历史演进的产物。早期只有方法覆盖（每个方言覆盖 `convertTz` 等），后来引入 `sqlTemplates` 是为了支持 **Rust 原生 SQL Planner**（Tesseract）。`BaseQuery.sqlTemplates()` 返回嵌套对象——`params`（占位符格式）、`functions`（`DATETRUNC`/`CONCAT`/`DATEDIFF`）、`expressions`（`interval`/`extract`）、`types`（`string`/`float`）、`statements`（`generated_time_series_select`）。子类先调 `super.sqlTemplates()` 再覆盖特定模板。**关键**：Rust 侧需要纯数据描述（模板字符串 + Jinja-like 语法），不能调用 JS 方法。`sqlTemplates()` 返回的模板被传给 Rust SQL Planner，由 Rust 侧渲染最终 SQL——这是性能优化的关键，JS SQL 生成路径在大查询时较慢，Rust 路径可大幅加速。`buildSqlAndParamsRust()`（`BaseQuery.js:932`）是 Rust 路径入口，通过 napi 调用 Tesseract。

### Pre-aggregation 声明式匹配

预聚合（pre-aggregation）是 Cube.js 关系缓存的核心——预先聚合好的表，查询命中时直接查预聚合表而非源数据，实现亚秒级延迟。匹配逻辑在 `PreAggregations`（`adapter/PreAggregations.ts:108`）。

```typescript title="adapter/PreAggregations.ts:108"
export class PreAggregations {
  private readonly query: BaseQuery;
  public preAggregationForQuery: PreAggregationForQuery | undefined;

  public preAggregationsDescription(): FullPreAggregationDescription[]
  public findPreAggregationToUseForCube(cube): PreAggregationForCube | null
  public static transformQueryToCanUseForm(query: BaseQuery): TransformedQuery  // 查询标准化为可匹配形式
  private findPreAggregationForQuery(): PreAggregationForQuery | undefined
  private canPartitionsBeUsed(foundPreAgg): boolean
  public aggregationsColumns(cube, preAggregation): string[]
}
```

**匹配机制**：`transformQueryToCanUseForm()`（`PreAggregations.ts:475`）将运行时查询标准化为 `TransformedQuery` 结构，包含 `sortedDimensions`、`sortedTimeDimensions`、`leafMeasurePaths`、`measureToLeafMeasures`、`isAdditive`、`hasCumulativeMeasures`、`granularityHierarchies` 等。这个标准化形式用于与 pre-aggregation 的 `PreAggregationReferences` 做集合包含匹配——查询的 dimensions ⊆ pre-agg dimensions 且 measures ⊆ pre-agg measures 则该 pre-agg 可用。

**为什么先标准化**：直接匹配不可行，因为 measure 可能是表达式（引用多个 leaf measure），维度可能有 join path 前缀，时间维度可能有不同 granularity。`transformQueryToCanUseForm` 将查询"拍平"到 leaf measure 级别并排序维度使匹配可缓存。`leafMeasureAdditive` 和 `hasCumulativeMeasures` 决定 pre-agg 是否可加速——非 additive measure 不能用 rollup pre-agg，cumulative measure 需 over-time-series 查询。

**granularity 层级**：`granularityHierarchies()`（`BaseQuery.js:1873`）定义 granularity 层级（day < week < month < quarter < year），使 pre-agg 的 `month` 粒度可以服务于查询的 `day` 粒度——这是预聚合复用率的关键，一个月粒度的预聚合表可以回答日、周、月粒度的查询。`canPartitionsBeUsed()`（`ts:251`）检查是否可使用分区 pre-agg，`partitionDimension()`（`ts:270`）解析分区时间维度。

---

## 设计模式

| 模式 | 位置（文件 + 方法） | 为什么用 |
|------|---------------------|----------|
| **模板方法** | `BaseQuery.buildSqlAndParams()` / `simpleQuery()`（`adapter/BaseQuery.js:877/1244`） | SQL 结构对所有方言一致，仅函数语法不同。基类控制流程，子类只覆盖差异点 |
| **策略** | `CompilerInterface { compile(cubes, errorReporter) }`（`compiler/PrepareCompiler.ts:45`） | 编译分阶段执行不同职责，策略模式让每个编译器独立实现，通过数组组合控制顺序 |
| **工厂** | `prepareCompiler()`（`PrepareCompiler.ts:61`）/ `QueryFactory.createQuery()`（`adapter/QueryFactory.ts:7`）/ `BaseQuery.newMeasure()` 等（`BaseQuery.js:671-755`） | 查询对象创建需按数据源选不同 BaseQuery 子类；成员对象创建需按方言选特化类 |
| **责任链** | 4 阶段编译流水线（`DataSchemaCompiler.ts:512-522`），`compileObjects()` 用 `reduce` 串成 Promise 链（`ts:223`） | 编译有严格前后依赖（先收集名称才能符号替换，先校验才能求值），分阶段责任链确保顺序 |
| **访问者** | `TranspilerInterface { traverseObject(reporter) }`（`compiler/transpilers/transpiler.interface.ts:6`），Babel `traverse()` 遍历 AST | JS 数据模型文件需源码级变换，访问者模式让每个变换只关注自己关心的 AST 节点类型 |
| **建造者** | `simpleQuery()`（`BaseQuery.js:1244`）逐步拼接 `commonQuery → baseWhere → groupByClause → baseHaving → orderBy → groupByDimensionLimit` | SQL 由多子句组成，每子句独立可缓存，按固定顺序拼接 |

---

## 模块间交互

### import 的 cubejs 包

| 包 | 用途 | 关键导入 |
|----|------|---------|
| `@cubejs-backend/shared` | 环境配置、文件仓库抽象 | `SchemaFileRepository`, `getEnv`, `FileContent`, `isNativeSupported`, `parseSqlInterval` |
| `@cubejs-backend/native` | Rust 原生扩展（swc 转译、YAML/Jinja 解析、SQL Planner） | `NativeInstance`, `transpileJs`, `transpileYaml`, `PythonCtx` |

### 被谁消费

- **`cubejs-server-core`**（核心消费者）——`CompilerApi` 类通过 `prepareCompiler()` 创建编译器，通过 `getDialectClass()` 返回 `BaseQuery` 子类，通过 `getSql()` 调用 `buildSqlAndParams()`。
- **15+ driver 包**通过 `extends BaseQuery` 实现方言适配：`cubejs-duckdb-driver`（`DuckDBQuery`）、`cubejs-databricks-jdbc-driver`（`DatabricksQuery`）、`cubejs-ksql-driver`（`KsqlQuery`）、`cubejs-pinot-driver`（`PinotQuery`）、`cubejs-druid-driver`（`DruidQuery`）、`cubejs-firebolt-driver`（`FireboltQuery`）、`cubejs-questdb-driver`（`QuestQuery`）、`cubejs-vertica-driver`（`VerticaQuery`）、`cubejs-trino-driver`（`TrinoQuery extends PrestodbQuery`）等。
- **`cubejs-dbt-schema-extension`**——`Dbt.ts` 引用编译器接口。
- **`cubejs-cli`**——`generate.ts` / `validate.ts` 调用编译器。
- **`cubejs-client-core`**——`format.ts`（仅类型依赖）。

### 与 Tesseract 的跨语言交互

schema-compiler 与 Rust 侧 Tesseract 通过 **napi FFI** 通信。Tesseract 的 `CubeEvaluator` trait（`rust/cube/cubesqlplanner/cubesqlplanner/src/cube_bridge/evaluator.rs:37`）由 `#[nativebridge::native_bridge]` 宏生成 napi 绑定，其实现是 TS 侧 schema-compiler 的 `CubeEvaluator` 类。每次 Rust 调用 `measure_by_path()` / `dimension_by_path()` / `cube_by_path()` / `segment_by_path()` 等方法，都跨 FFI 回调 JS 侧解析数据模型——Tesseract 借用 schema-compiler 的语义求值能力，自己只专注 SQL 规划。

---

## 扩展方式

### 新增 SQL 方言适配器

1. 在 `adapter/` 新建 `XxxQuery.ts`，`extends BaseQuery`，覆盖 `convertTz()`、`timeGroupedColumn()`、`hllInit()`/`hllMerge()`/`countDistinctApprox()`、`sqlTemplates()` 等模板方法。
2. 覆盖 `BaseQuery` 的 `newXxx()` 工厂方法（如 `newParamAllocator` [BaseQuery.js:747]、`newMeasure` [BaseQuery.js:671]、`newFilter` [BaseQuery.js:721]）返回方言特化类——参考 `adapter/MssqlQuery.ts:45` 的 `MssqlFilter extends BaseFilter` + `MssqlQuery` 覆盖 `newFilter`。
3. 在 server-core 的 `DriverDependencies.ts` 注册驱动包名映射。

### 新增 measure 类型（如 `median`）

1. `adapter/BaseMeasure.ts` ——在类型分发逻辑中添加 `median` 分支，实现 `medianSql()` 生成 `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ...)` 或方言等价。
2. `adapter/BaseQuery.js` ——`fullKeyQueryAggregateMeasures()`（`BaseQuery.js:1486`）中的 measure 分类逻辑（regular/multiplied/cumulative）需判断 `median` 是否 additive；`median` 非 additive，应归入 multiplied 分支或新增处理。
3. `compiler/CubeValidator.ts` ——在 measure type 校验白名单中添加 `'median'`。
4. `adapter/PreAggregations.ts:296` ——`aggregationsColumns()` 中 `rollup` 类型 pre-agg 的聚合函数映射需添加 `median` 分支（注意：多数数据源不支持在 rollup 上做 median，可能需排除）。
5. 各方言 `BaseQuery` 子类——`PostgresQuery` 覆盖 `medianSql()` 返回 `PERCENTILE_CONT`；`BigqueryQuery` 返回 `APPROX_QUANTILES`；`ClickHouseQuery` 返回 `quantile()`。

关键函数：`BaseMeasure.isAdditive()` 决定 measure 能否被 rollup pre-agg 加速——`median` 不可加，必须在 `fullKeyQueryAggregateMeasures` 中被正确分类为 multiplied measure，走子查询聚合路径。

### 新增 pre-aggregation partition 维度（按非时间维度分区）

1. `compiler/CubeSymbols.ts` ——`PreAggregationDefinition` 类型中扩展 `partitionGranularity` 或新增 `partitionDimension` 字段。
2. `adapter/PreAggregations.ts:251` ——`canPartitionsBeUsed()` 当前只检查 `partitionGranularity + timeDimensions`，需扩展为也检查非时间分区维度。
3. `adapter/PreAggregations.ts:270` ——`partitionDimension()` 当前从 `references.timeDimensions[0]` 取分区维度，需支持从非时间维度取。
4. `adapter/PreAggregations.ts:256` ——`addPartitionRangeTo()` 需支持非时间维度的 range 语义（非 dateRange）。
5. `compiler/CubeValidator.ts` ——校验新分区维度字段的合法性。

关键函数：`PreAggregations.preAggregationDescriptionsFor()`（`PreAggregations.ts:227`）是分区展开入口——它调用 `canPartitionsBeUsed()` 判断是否分区，然后 `addPartitionRangeTo()` 为每个分区生成独立 pre-agg 描述。
