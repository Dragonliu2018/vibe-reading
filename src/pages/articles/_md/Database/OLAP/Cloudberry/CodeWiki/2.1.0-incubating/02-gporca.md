---
source:
  type: "源码解读"
  project: "Cloudberry"
  url: "https://github.com/apache/cloudberry"
title: "GPORCA 优化器"
date: "2026-08-20T11:29:59+08:00"
category: [Database, OLAP, Cloudberry, CodeWiki, "2.1.0-incubating"]
tags: ["Cloudberry", "C++", "MPP", "ORCA", "Cascades", "优化器"]
description: "Cloudberry gporca 模块——基于 Cascades 搜索框架的模块化 C++ 代价优化器，五库架构、120+ 变换规则、MPP 多维物理属性驱动搜索。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/00-overview)

---

## 模块定位

`src/backend/gporca/` 是 **GPORCA**——一个基于 Cascades 搜索框架的模块化 C++ 代价优化器，在 `optimizer=on` 时替代 PostgreSQL planner 处理复杂 MPP 查询。它只认自己设计的 XML 风格中间表示 DXL（Dynamic eXchange Language），完全不接触 PostgreSQL 的 C 结构（经 [gpopt 翻译桥](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/03-gpopt) 喂入/输出）。它的核心价值是**用 Cascades 的需求驱动搜索处理 MPP 的多维正交物理属性**（order/distribution/rewindability/partition propagation）——PostgreSQL planner 的自底向上动态规划处理不了这种多维需求，Cascades 自顶向下 + 记忆化 + 规则驱动刚好契合。

GPORCA 用 C++ 编写，与 PostgreSQL 的 C 内核完全隔离（独立的 GPOS 内存池、C++ 异常框架），是 Cloudberry 里唯一的大型纯 C++ 模块。它从 Greenplum 时期就存在，Cloudberry 沿用并跟踪上游 ORCA 演进，本解读聚焦其架构主线。

## 模块架构

```text
五库架构（src/backend/gporca/）
  libgpos/      基础设施层——内存池(CMemoryPool)/异常(GPOS_TRY/CATCH)/任务调度(gpos_exec)
  libgpdbcost/  代价模型层——CCostModelGPDB 为每算子有独立 Cost* 函数 + CCostModelParamsGPDB(50+ 可调因子)
  libgpopt/     优化器引擎层——Cascades 搜索 + 算子 + 变换规则 + 物理属性
    ├─ optimizer/  COptimizer(主入口) · COptimizerConfig · CEngine(搜索引擎)
    ├─ search/     CMemo · CGroup · CGroupExpression · CSearchStage
    ├─ operators/  COperator(基类) · CLogical*/CPhysical*/CScalar*/CPattern
    ├─ xforms/     CXform(变换规则基类) · CXformExploration/CXformImplementation(~120 条)
    └─ base/       CDistributionSpec/COrderSpec/CEnfdProps(物理属性) + enforcer
  libnaucrates/  元数据/DXL 层——CDXL* 节点 + CMDProviderSystempan(catalog 元数据源)
  server/        DXL 服务层

调用关系（经 gpopt 桥）
  gpopt/COptTasks.cpp:989 ── COptimizer::PdxlnOptimize(query_dxl, ...) ──→ libgpopt
       ├─ CTranslatorQueryToDXL 已把 PG Query → CDXLNode
       └─ 返回优化后 CDXLNode（物理计划），gpopt 再 CTranslatorDXLToPlStmt 翻回 PlannedStmt
```

GPORCA 的五库架构层次清晰：`libgpos` 是基础设施（内存/异常/任务），`libgpdbcost` 是代价模型，`libgpopt` 是优化器引擎（Cascades 搜索 + 算子 + 规则 + 物理属性），`libnaucrates` 是元数据与 DXL，`server` 是服务层。`libgpopt` 是核心，内含搜索引擎 `CEngine`、Memo 结构 `CMemo`/`CGroup`/`CGroupExpression`、算子族 `CLogical`/`CPhysical`/`CScalar`/`CPattern`、变换规则 `CXform`（约 120 条）、物理属性 `CDistributionSpec`/`COrderSpec`/`CEnfdProps` 及其 enforcer。

## 调用链路

```text
gpopt COptTasks::OptimizeTask() in COptTasks.cpp:883   [已有 CDXLNode* query_dxl]
  └─ COptimizer::PdxlnOptimize(mp, md_accessor, query_dxl, output_cols, cte_array,
                                expr_evaluator, num_segments, session_id, cmd_id,
                                search_strategy_arr, optimizer_config)  [libgpopt]
       └─ CEngine::Optimize()                              Cascades 搜索引擎
            ├─ 构造初始 CMemo：query_dxl → CExpression → CGroup（等价表达式集合）
            ├─ 多阶段搜索（CSearchStageArray）：
            │    exploration（逻辑等价探索，apply CXformExploration）
            │    → implementation（逻辑→物理，apply CXformImplementation）
            │    → optimization（代价估计 + 选最优 + 插 enforcer）
            ├─ 每阶段枚举 CGroupExpression，应用匹配的 CXform 转换规则 Transform()
            ├─ FCheckEnfdProps 检查 order/distribution/rewindability/partition propagation
            │    └─ 不满足时动态插入 Sort/Motion/Spool 等 enforcer 算子
            ├─ CCostModelGPDB 对每个物理算子算代价（CCostModelParamsGPDB 的 50+ 因子参数化）
            └─ 提取最优物理计划（cost 最低的 CGroupExpression）
       └─ 返回优化后 CDXLNode（物理计划）
```

数据类型：`CDXLNode*`（DXL 查询树）→ `CExpression*`（ORCA 内部表达式）→ `CGroup*`/`CGroupExpression*`（Memo）→ 优化后 `CDXLNode*`（物理计划）。全在 GPOS 内存池内，不接触 PG 结构。

<details>
<summary>方法速查表</summary>

| 方法/类 | 一行职责 | 关键设计决策 |
|---------|----------|-------------|
| `COptimizer::PdxlnOptimize` in `libgpopt/.../optimizer/COptimizer.cpp` | ORCA 主入口，输入输出 DXL | C++ 接口，隔离 PG 结构 |
| `CEngine::Optimize` in `libgpopt/.../engine/CEngine.cpp` | Cascades 搜索引擎主循环 | 多阶段（exploration/implementation/optimization） |
| `CMemo`/`CGroup`/`CGroupExpression` in `libgpopt/.../search/` | Memo 动态规划表（等价表达式分组） | 记忆化避免重复搜索 |
| `CXform` + `CXformFactory` in `libgpopt/.../xforms/` | 变换规则 + 工厂注册（~120 条） | 规则驱动，分 exploration/implementation |
| `COperator`（基类） in `libgpopt/.../operators/COperator.h` | 算子基类，`CLogical`/`CPhysical`/`CScalar`/`CPattern` 继承 | 工厂 + xform `Implement` 生成物理算子 |
| `FCheckEnfdProps` | 检查 order/distribution/rewindability/partition 四属性 | 不满足动态插 enforcer（Sort/Motion/Spool） |
| `CCostModelGPDB` in `libgpdbcost/.../CCostModelGPDB.h` | 每算子独立 `Cost*` 函数 | `CCostModelParamsGPDB` 50+ 可调因子参数化 |

</details>

## 核心实现

### Cascades 搜索框架：Memo + 规则 + 多阶段

GPORCA 的核心是 **Cascades 搜索框架**——自顶向下、需求驱动、记忆化的查询优化算法。`CMemo`（`libgpopt/.../search/CMemo.h`）持有 `CGroup`（一组逻辑等价的表达式），`CGroup` 内含 `CGroupExpression` 列表，构成 Memo 动态规划表。搜索流程由 `CEngine::Optimize` 驱动，分多阶段（`CSearchStageArray`）：**exploration**（用 `CXformExploration` 探索逻辑等价形态，如 join 交换律）、**implementation**（用 `CXformImplementation` 把逻辑算子转物理算子，如 `CLogicalJoin`→`CPhysicalHashJoin`/`CPhysicalNestLoopJoin`）、**optimization**（代价估计 + 选最优 + 插 enforcer）。每阶段枚举 `CGroupExpression`、用 pattern matching 找匹配的 `CXform` 转换规则、调 `Transform()` 虚函数产生新等价表达式加入 Memo，避免重复搜索。

### 变换规则：120+ CXform

`CXform`（`libgpopt/.../xforms/CXform.h`）是变换规则基类，约 120 条子类分两类：`CXformExploration`（逻辑等价探索，如 join 关联律、谓词下推）和 `CXformImplementation`（逻辑→物理实现，如 `InnerJoin`→`HashJoin`/`NLJ`）。规则经 `CXformFactory::Instantiate` 全局单例注册。每条规则定义一个 `CPattern`（匹配模式），搜索引擎用 pattern matching 在 Memo 里找可应用的 `CGroupExpression`，调 `Transform()` 产出新表达式。这种规则驱动让优化器可扩展——新增优化策略就是加一条 `CXform`，不改搜索引擎。

### MPP 物理属性与 enforcer

GPORCA 的 `FCheckEnfdProps` 检查四种正交物理属性：**order**（排序）、**distribution**（MPP 数据分布，对应 [cdb](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/01-cdb) 的 Locus）、**rewindability**（可回卷，支持 Nested Loop 多次扫描）、**partition propagation**（分区表传播）。当子计划不满足父节点要求的属性时，搜索引擎动态插入 **enforcer** 算子——Sort（补 order）、Motion（补 distribution，这就是 ORCA 直接生成 Motion 节点的地方）、Spool（补 rewindability）。`CDistributionSpec`/`COrderSpec`/`CEnfdProps`（`libgpopt/base/`）定义这些属性。这是 ORCA 与 PG planner 的根本区别：PG 用单一 cost 比较选路径，ORCA 用多维属性需求驱动搜索并按需插 enforcer，MPP 的 distribution 属性正是靠这套机制在优化期处理。

### 代价模型与 DXL

`CCostModelGPDB`（`libgpdbcost/.../CCostModelGPDB.h`）为每种物理算子有独立的 `Cost*` 函数，参数化于 `CCostModelParamsGPDB` 的 50+ 个可调代价因子（如 seq_page_cost、cpu_tuple_cost、random_page_cost 等 GPDB 特有因子），可按集群负载校准。DXL（`libnaucrates`）是 XML 风格中间表示，`CDXL*` 类表达查询树与计划树，实现 C++ 优化器与 C 执行器的完全解耦，配合 **minidump** 支持——优化失败时可把输入 DXL 序列化成 minidump 文件离线重放调试，不必重现整个查询。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Cascades（Memo + 规则 + 多阶段搜索） | `CMemo`/`CGroup`/`CXform`/`CEngine` in `libgpopt/.../search,engine,xforms` | MPP 多维正交物理属性需需求驱动搜索，自底向上 DP 处理不了 |
| 规则驱动（pattern matching + Transform） | `CXform` + `CXformFactory` ~120 条 | 新增优化策略只加规则不改搜索引擎，可扩展 |
| 工厂 | `CXformFactory::Instantiate` 全局单例；算子 `Implement` 生成物理算子 | 规则/算子种类多，统一生命周期与创建 |
| Enforcer（属性强制） | `FCheckEnfdProps` + `CEnfdProps` + Sort/Motion/Spool | 多维属性不满足时按需插算子，dynamics insertion |
| 五库分层 | libgpos/libgpdbcost/libgpopt/libnaucrates/server | 基础/代价/引擎/元数据/服务职责分离，层次清晰 |

## 模块间交互

GPORCA 被 [gpopt 翻译桥](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/03-gpopt) 调用：`COptTasks::OptimizeTask`（`gpopt/utils/COptTasks.cpp:989`）调 `COptimizer::PdxlnOptimize`，输入 `gpopt` 已翻译好的 `CDXLNode*`（query_dxl），输出优化后的 `CDXLNode*`（plan_dxl），gpopt 再用 `CTranslatorDXLToPlStmt` 翻回 `PlannedStmt`。ORCA 的元数据（表/列/约束信息）经 `CMDProviderSystempan` 从 GPDB catalog 读取，缓存在 `CMDAccessor` 里。输入输出都是 DXL——ORCA 从不接触 PG 的 C 结构。这是与 [查询优化器](/vibe-reading/articles/Database/OLAP/Cloudberry/CodeWiki/2.1.0-incubating/04-optimizer) PG planner 路径的**互斥选择**关系（`standard_planner` 先试 ORCA，失败 fallback PG planner）。ORCA 在 DXL 优化阶段直接生成 Motion 节点（通过 distribution 属性的 enforcer），不需走 cdbpath 的 Path 层插入。

## 扩展方式

- **新增一条变换规则**：在 `libgpopt/include/gpopt/xforms/` 加 `CXformXxx` 类（继承 `CXformExploration` 或 `CXformImplementation`），实现 `PexprPattern()`（匹配模式）和 `Transform()`（转换逻辑）；在 `CXformFactory` 注册。仿现有 ~120 条规则的写法。
- **新增一个物理算子**：在 `libgpopt/include/gpopt/operators/` 加 `CPhysicalXxx`（继承 `CPhysical`），实现代价函数（在 `libgpdbcost` 的 `CCostModelGPDB` 加对应 `Cost*`）；加一条 `CXformImplementation` 把对应逻辑算子转该物理算子；必要时在 gpopt 的 `CTranslatorDXLToPlStmt` 加 DXL→Plan 反向翻译。
- **修改代价因子**：改 `libgpdbcost/include/gpdbcost/CCostModelParamsGPDB.h` 的参数定义；或通过 GUC `optimizer_*` 调整（gpopt 的 `CConfigParamMapping` 把 GUC 映射为 ORCA trace flag）。

扩展点契约：GPORCA 的扩展本质是"在 Memo 上加一种变换规则或物理算子"，必须同步规则定义（libgpopt xforms）、代价函数（libgpdbcost）、必要时 gpopt 的双向翻译，保持 DXL 作为单一中间表示的一致性。
