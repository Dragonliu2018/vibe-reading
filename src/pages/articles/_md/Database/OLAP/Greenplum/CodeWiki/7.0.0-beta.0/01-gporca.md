---
source:
  type: "源码解读"
  project: "Greenplum"
  url: "https://github.com/greenplum-db/gpdb"
title: "GPORCA 优化器"
date: "2026-08-14T15:39:30+08:00"
category: [Database, OLAP, Greenplum, CodeWiki, "7.0.0-beta.0"]
tags: ["Greenplum", "C++", "ORCA", "Cascades", "查询优化器"]
description: "GPORCA——基于 Cascades 搜索框架的模块化 C++ 代价优化器：Memo、变换规则与多阶段需求驱动搜索。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Greenplum/CodeWiki/7.0.0-beta.0/00-overview)

---

## 模块定位

GPORCA 是 GPDB 在 `optimizer=on` 时替代 PostgreSQL planner 的代价优化器，位于 `src/backend/gporca/`，是仓库内一个自包含的 C++ 子项目（~41 万行）。它与 GPDB 的 C 内核通过 DXL（一种 XML 中间表示）解耦：上游 `gpopt` 翻译桥把 PostgreSQL `Query` 树转成 DXL 逻辑树喂进来，GPORCA 在 Memo 上用变换规则搜索等价计划，输出最优物理 DXL 树，再由 `gpopt` 翻译回 `PlannedStmt`。它的核心价值在于用 Cascades 框架的"需求驱动搜索"处理 MPP 优化特有的多维度正交物理属性（顺序、分布、可重wind、分区传播），这是 PostgreSQL 自底向上动态规划无法优雅承担的。

## 模块架构

GPORCA 按库分层，自底向上依赖：

| 库 | 代码量 | 职责 |
|----|--------|------|
| `libgpos` | 32K | OS 抽象层：内存池 `CMemoryPool`、线程 `CAutoTaskScope`、同步原语、异常 `CException`、任务本地存储 |
| `libnaucrates` | 130K | DXL 解析/序列化（`CTranslatorDXLToExpr`/`CTranslatorExprToDXL`）、统计信息 `IStatistics`、元数据对象 `IMDRelation` 等 |
| `libgpopt` | 208K | 优化器核心：算子 `COperator` 层次、Memo `CGroup`/`CGroupExpression`、变换 `CXform`、引擎 `CEngine`/`CScheduler`/`CJob`、属性 `CDrvdProp`/`CReqdProp`/`CEnfdProp` |
| `libgpdbcost` | 4K | 代价模型 `CCostModelGPDB` 与参数 `CCostModelParamsGPDB` |
| `server` | 37K | 单元测试与 minidump 离线重放工具 `CMinidumperUtils` |

`libgpos` 是地基（不依赖其他 ORCA 库）；`libnaucrates` 依赖 `libgpos`；`libgpopt` 依赖前两者；`libgpdbcost` 依赖 `libgpopt`。入口类 `COptimizer` 定义在 `libgpopt`（`include/gpopt/optimizer/COptimizer.h`），`server/` 主要承载测试与工具。关键设计：全局状态（内存池、元数据访问器、代价模型）通过 `libgpos` 的任务本地存储（`CTaskLocalStorage`）传播——`COptCtxt` 继承自 `CTaskLocalStorageObject`，靠 `COptCtxt::PoctxtFromTLS()` 存取，不依赖全局变量。

## 调用链路

从入口 `COptimizer::PdxlnOptimize`（`libgpopt/src/optimizer/COptimizer.cpp:230`）到输出物理 DXL 的主路径：

```
COptimizer::PdxlnOptimize(query_dxl, mda, pceeval, search_stages, opt_config)
 ├─ CAutoOptCtxt → COptCtxt::PoctxtCreate(mp, md_accessor, pceeval, opt_config)   [COptCtxt.h:311]
 │     └─ 存入 TLS（EtlsidxOptCtxt）
 ├─ CTranslatorDXLToExpr::PexprTranslateQuery()   DXL → CExpression 逻辑树   [libnaucrates]
 ├─ CQueryContext::PqcGenerate()                  包装查询上下文
 ├─ PexprOptimize(mp, pqc, search_stage_array)
 │    ├─ CEngine engine(mp); engine.Init(pqc, search_stage_array)   [CEngine.h:218]
 │    │     ├─ PgroupInsert(root, pexpr, ExfInvalid, …)  递归插入子表达式到 Memo
 │    │     └─ CXformFactory::Pxff()->Instantiate()      创建全部 ~120 个 xform
 │    └─ engine.Optimize()                          [CEngine.cpp:1674]
 │          FOR each search stage (ul=0..nStages):
 │            if FSearchTerminated() break            ← 上一阶段已达成本要求即停
 │            poc = new COptimizationContext(mp, rootGroup, reqdProps, …)
 │            CScheduler sched(mp, ulJobs);  CScheduler::Run(&sc)   多线程作业调度
 │              └─ Job: CJobTransformation → CXform::Transform() 生成等价表达式入 Memo
 │              └─ Job: CJobOptimization → engine.OptimizeGroupExpression()
 │                    ├─ FCheckReqdProps()  算子能否满足所需属性
 │                    ├─ PdrgpocOptimizeChildren()  递归优化子组
 │                    ├─ FCheckEnfdProps()  [CEngine.cpp:2048] 决定是否插入 enforcer
 │                    └─ CostCompute() → ICostModel->Cost()  CCostModelGPDB 估算
 │            PexprExtractPlan(rootGroup, …)   提取当前阶段最优物理计划
 ├─ CreateDXLNode(pexprPlan, …)   CExpression 物理 → CDXLNode   CTranslatorExprToDXL
 └─ return pdxlnPlan   物理计划 DXL
```

<details>
<summary>方法速查</summary>

| 方法 | 一行职责 | 关键决策 |
|------|----------|----------|
| `PdxlnOptimize` (COptimizer.cpp:230) | 优化入口，编排翻译→搜索→回译 | 通过 TLS 传 COptCtxt |
| `CEngine::Optimize` (CEngine.cpp:1674) | 多阶段搜索循环 | 阶段间成本递进，达要求即停 |
| `CScheduler::Run` (CScheduler.h:171) | 多线程作业调度 | Job 挂起/恢复解耦依赖与执行 |
| `FCheckEnfdProps` (CEngine.cpp:2048) | 决定是否插入 enforcer | 4 维属性 Epet* 判定 |
| `CCostModelGPDB::Cost` (libgpdbcost) | 算子代价估算 | 按算子 switch 分支 |

</details>

## 核心实现

### Memo：等价表达式分组（CGroup / CGroupExpression）

Cascades 的核心数据结构是 **Memo**——把搜索过程中产生的等价表达式按"组"去重共享，避免重复计算。`CGroup`（`include/gpopt/search/CGroup.h:72`）代表一组逻辑等价的表达式，持有 `CList<CGroupExpression> m_listGExprs`（组成员链表）、组级推导属性 `m_pdp` 与统计 `m_pstats`、两个 `CJobQueue`（exploration / implementation）、以及一个状态机 `EState`（`estUnexplored → estExploring → estExplored → estImplementing → estImplemented → estOptimizing → estOptimized`）。`m_pgroupDuplicate` 用于组合并（把重复组指针归并到规范组）。

`CGroupExpression`（`CGroupExpression.h:37`）是 Memo 的成员：`COperator *m_pop`（算子）+ `CGroupArray *m_pdrgpgroup`（子组数组），并记录 `m_exfidOrigin`（生成它的 xform ID，用于追溯）和 `m_eol`（优化级别 Low/High）。一个 group 可以有多个 group expression（同语义、不同算子/子组组合），搜索时按优化上下文分别求最优。

### 算子与表达式层次（COperator / CExpression）

算子继承树（`include/gpopt/operators/COperator.h:50`）分四支：

```
COperator
├── CLogical   (CLogicalGet / CLogicalSelect / CLogicalInnerJoin / CLogicalGbAgg …)
├── CPhysical  (CPhysicalTableScan / CPhysicalInnerHashJoin / CPhysicalMotionGather …)
├── CScalar    (CScalarCmp / CScalarIdent / CScalarConst / CScalarAggFunc …)
└── CPattern    (CPatternTree / CPatternLeaf / CPatternMultiLeaf …)   ← xform 模式匹配用
```

`CPhysical`（`CPhysical.h:30`）定义 4 种正交计划属性 `GPOPT_PLAN_PROPS = 4`：order、distribution、rewindability、partition propagation。`CExpression`（`CExpression.h:57`）是树/DAG 表示，持有算子 `m_pop` + 子表达式数组，并带推导属性 `m_pdprel`/`m_pdpplan` 与从 Memo 提取时的成本 `m_cost`，`m_pgexpr` 反向指向其所属的 group expression。

### 变换规则与工厂（CXform / CXformFactory）

`CXform`（`include/gpopt/xforms/CXform.h:47`）定义约 120 个 `EXformId`，分两类：`CXformExploration`（逻辑→逻辑，如 `ExfJoinAssociativity` 改 join 顺序、`ExfPushGbBelowJoin` 下推聚合）与 `CXformImplementation`（逻辑→物理，如 `ExfInnerJoin2HashJoin` 把 `CLogicalInnerJoin` 变为 `CPhysicalInnerHashJoin`）。每条规则实现模式匹配表达式 `m_pexpr`、承诺级别 `Exfp()`（None/Low/Medium/High，控制搜索优先级）、与 `Transform(pxfctxt, pxfres, pexpr)`（生成等价表达式加入 `CXformResult`）。

`CXformFactory`（`CXformFactory.h:30`）是全局单例，`Instantiate()` 一次性创建全部 xform 实例存入 `m_rgpxf[ExfSentinel]` 数组，并维护 exploration/implementation 的 bitset。搜索前确保全部就绪，按 ID 索引访问。

### 搜索引擎与多阶段作业调度（CEngine / CScheduler / CJob）

搜索由 `CEngine`（`engine/CEngine.h`）驱动，经 `CSearchStageArray` 配置多阶段策略——每阶段定义自己的 xform 集合与成本目标，前阶段达成本要求即 `FSearchTerminated()` 提前停。每阶段把工作分解为 Job：`CJobGroupExpression`/`CJobGroup`/`CJobOptimization`/`CJobTransformation`（`CJob.h:82`）。`CScheduler::Run()`（`CScheduler.h:171`）在多线程上并发执行 job：取无依赖 job → `FExecute()` → 返回 `EjrRunnable`（重排）/ `EjrSuspended`（挂起等子组）/ `EjrCompleted`（通知依赖者）。Job 模式解耦了 Memo 优化的天然数据依赖（探索一个 group 前需先探索其子 group）与执行调度，支持并行优化。

### Enforcer 属性：MPP 优化的需求驱动搜索

这是 GPORCA 区别于 PostgreSQL planner 的关键。`CEnfdProp::EPropEnforcingType`（`include/gpopt/base/CEnfdProp.h:67`）对每个物理算子在给定上下文下，为 4 种属性各算一个类型：

- `EpetRequired`——算子自身无法满足，必须插入 enforcer（如要求 table scan 输出有序 → 插 Sort）
- `EpetOptional`——可从子节点请求并保持（如 filter 透传排序）
- `EpetProhibited`——禁止强制（"否决"，任一属性 Prohibited 则 `FProhibited()` 跳过整个算子）
- `EpetUnnecessary`——算子自身已满足

`FCheckEnfdProps`（`CEngine.cpp:2048`）在优化每个 group expression 时**自顶向下**把属性需求传播给子组，递归优化子组后再决定是否 `AppendEnforcers()` 生成 Sort/Motion/Spool。其中 distribution 属性是 MPP 独有：join 需两侧分布对齐、group-by 需按分组键重分布、结果需 gather 到 coordinator，不同 Motion 类型对应不同 `CDistributionSpec`。

> **为什么自底向上 DP 处理不了**：System-R 风格 DP 按 join order 自底向上枚举，每层只留一个最优方案。但 MPP 的 distribution 需求是**自顶向下**传播的（父节点要求子节点按特定分布键哈希），且同一 group 在不同 (order, distribution, rewindability) 组合下有不同最优物理实现。Cascades 用 `COptimizationContext` 以 `(group, required_props, search_stage)` 为键，同一 group 在不同 required distribution 下有独立最优方案——这是"需求驱动搜索"而非盲目枚举。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Cascades 框架（Memo + 规则 + 搜索） | `CGroup`/`CGroupExpression`、`CXform`、`CEngine` | Memo 共享等价表达式避免重复，规则驱动而非硬编码转换顺序，支持多阶段成本递进 |
| 作业调度（Job Scheduling） | `CJob`/`CJobFactory`/`CScheduler` | 解耦 Memo 优化数据依赖与执行，支持多线程并行优化 |
| Visitor | `CExpressionHandle` + `DeriveXXX()`（`CExpression.h:282-306`） | 同一套属性推导逻辑在 CExpression（初始树）与 CGroupExpression（Memo）上统一运行，按需 lazy derivation |
| 工厂 | `CXformFactory::Instantiate()` | xform 数量大且需搜索前全部就绪，统一生命周期管理 |

## 模块间交互

GPORCA 与外界**只通过 DXL 通信**，不暴露 C++ 内部结构：

- **上游**：`gpopt/utils/COptTasks.cpp:956` 的 `COptimizer::PdxlnOptimize(mp, &mda, query_dxl, …, search_strategy_arr, optimizer_config)` 是唯一入口。`gpopt` 负责 Query→DXL（`CTranslatorQueryToDXL`）、设置 trace flag（如 `EopttraceDisableMotions` 对 coordinator-only 查询禁用 motion）、调 ORCA、再把结果 DXL→`PlannedStmt`（`CTranslatorDXLToPlStmt`）。
- **元数据**：ORCA 不直接读 PostgreSQL 系统表，通过 `CMDAccessor`（`include/gpopt/mdcache/CMDAccessor.h:89`）→ `IMDProvider` 间接访问，缓存为 `CMDRelation`/`CMDIndex` 等。`IMDProvider` 实现有 `CMDProviderSystempan`（GPDB catalog）与 `CMDProviderMemory`（minidump 回放，离线调试）。
- **内存与异常隔离**：GPDB 调用前用 `GPOS_TRY_HDL(&errhdl)` 设置错误处理，ORCA 的 `CException` 经此向上传播到 GPDB 的 `PG_CATCH`；ORCA 内存全在 `CMemoryPool`（独立于 PG `MemoryContext`），优化失败或超时可整池释放而不影响查询执行上下文。
- **C↔C++ 边界**：`gpopt` 的 `Execute()` 在 GPOS 线程内运行 `OptimizeTask`，C/C++ 通过 FFI 切换内存与异常体系（见 `COptTasks.cpp:1145` `GPOPTOptimizedPlan`）。

## 扩展方式

新增一条变换规则（以"把 LeftSemiJoin 转 SemiJoin 的 exploration 规则"为例）：

1. 定义 xform ID：`CXform::EXformId` 枚举末尾（`ExfInvalid` 前）加 `ExfLeftSemiJoin2SemiJoin`（`include/gpopt/xforms/CXform.h`）。
2. 新建 `CXformLeftSemiJoin2SemiJoin` 继承 `CXformExploration`，实现构造函数（定义匹配模式）、`Exfid()`/`SzId()`/`Exfp()`/`Transform()`（参考 `libgpopt/src/xforms/CXformJoinAssociativity.cpp`）。
3. 注册到工厂：`CXformFactory::Instantiate()`（`libgpopt/src/xforms/CXformFactory.cpp:140`）中 `Add(GPOS_NEW(mp) CXformLeftSemiJoin2SemiJoin(mp))`，顺序须与枚举一致；在 `xforms.h` include 新头；更新 `libgpopt/src/xforms/Makefile`。
4. （可选）若不属于默认 exploration 集，在 `CSearchStage::PdrgpssDefault` 显式加入。

新增物理算子/调整代价参数的场景同理——分别在 `COperator::EOperatorId` 加枚举 + 实现 `CPhysical*` + 加 implementation xform + 在 `libgpdbcost/src/CCostModelGPDB.cpp` 的 `Cost()` switch 加分支；代价参数调默认值在 `libgpdbcost/src/CCostModelParamsGPDB.cpp` 构造函数。

> GPORCA 的 **minidump 机制**（`CMiniDumperDXL`）在异常时把查询 DXL + 优化器配置 + 元数据快照写入文件，可用 `server/src/startup/main.cpp` 的 minidump runner 离线重放，是 ORCA 开发调试的核心工具。
