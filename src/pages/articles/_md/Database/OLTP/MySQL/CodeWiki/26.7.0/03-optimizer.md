---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "查询优化器"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "超图优化器", "DPhyp", "AccessPath"]
description: "新老双优化器、超图 DPhyp 连接序搜索、interesting orders NFSM/DFSM、range optimizer 区间树、成本模型与直方图的源码解读"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

优化器把语义化的 `Query_block` 变成成本最低的 `AccessPath` 物理计划树。MySQL 26.7 里同时存在两套完整的计划搜索：老的 **prefix search**（`sql_planner.cc`，greedy 枚举）与新的**超图优化器**（`sql/join_optimizer/`，DPhyp 连通子图枚举）——后者在 `join_optimizer.h:30` 的设计注释里明言"意图最终完全接管老优化器，目前接近 feature complete"。双轨并存的现状让这个模块格外值得读：你能同时看到"演进中的替换"如何共享一套执行层（AccessPath→RowIterator）。

涉及文件：`sql/sql_optimizer.cc`（`JOIN::optimize`）、`sql/sql_planner.cc`（老优化器）、`sql/join_optimizer/`（~37k 行新优化器）、`sql/range_optimizer/`（~2 万行区间分析）、`sql/histograms/`、`sql/opt_cost*.cc`。

## 模块架构

```text
Query_block（解析器产出）
  ▼
JOIN::optimize (sql/sql_optimizer.cc:344)
  ├─── 老路径（默认）: make_join_plan → Optimize_table_order::choose_table_order
  │                    （greedy prefix search, sql_planner.cc:2330）
  └─── 超图路径（optimizer_switch=hypergraph_optimizer）:
         MakeJoinHypergraph            # Table_ref 树 → RelationalExpression → 超图
         BuildInterestingOrders        # 收集排序需求 + 函数依赖 → LogicalOrderings
         EnumerateAllConnectedPartitions + CostingReceiver   # DPhyp 枚举估价
         FinalizePlanForQueryBlock     # 定稿 AccessPath 树
  ▼
root AccessPath ──(CreateIteratorFromAccessPath)──► RowIterator 树（执行器模块）
```

## 调用链路

超图优化器的完整计划搜索链：

### FindBestQueryPlan：计划搜索总入口

`FindBestQueryPlan`（`join_optimizer.cc:10103`）外层是**最多 3 次尝试**的重试循环（`max_attempts = 3`）：`FindBestQueryPlanInner`（`:9465`）通过输出参数反馈 retry 请求与新的 `subgraph_pair_limit`（初始值来自 `optimizer_max_subgraph_pairs`）；子图对数超限时先经 `GraphSimplifier`/`SimplifyQueryGraph` 合并节点把图化小再重跑；join order hint 导致无解时清 hint 重试；3 次耗尽报 `ER_NO_QUERY_PLAN_FOUND`。

```text
FindBestQueryPlan (join_optimizer.cc:10103)
└─ FindBestQueryPlanInner (:9465)
   ├─ MakeJoinHypergraph (make_join_hypergraph.cc:3862)
   │    ├─ MakeRelationalExpressionFromJoinList → RelationalExpression 树
   │    │    （TABLE / INNER_JOIN / LEFT_JOIN / SEMIJOIN / ANTIJOIN /
   │    │      STRAIGHT_INNER_JOIN=101 / FULL_OUTER_JOIN / MULTI_INNER_JOIN=102）
   │    ├─ FlattenInnerJoins → PushDownJoinConditions（谓词下压）→ UnflattenInnerJoins
   │    └─ FindHyperedgeAndJoinConflicts → JoinHypergraph（图 + 业务载荷）
   ├─ BuildInterestingOrders → LogicalOrderings::Build()      # NFSM→DFSM
   └─ EnumerateAllConnectedPartitions(graph, &receiver)       # DPhyp 算法
        └─ CostingReceiver (join_optimizer.cc:309)
             ├─ FoundSingleNode()            # 单表：扫/索引/ref 候选
             ├─ FoundSubgraphPair(l, r, e)   # 子图对：ProposeHashJoin/ProposeNestedLoopJoin
             └─ m_access_paths: NodeMap → 最廉候选集
```

方法速查：

<details>
<summary>优化器方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `JOIN::optimize` in `sql_optimizer.cc:344` | 单块优化入口 | `:654` 按 `using_hypergraph_optimizer()` 分流双管线 |
| `FindBestQueryPlan` in `join_optimizer.cc:10103` | 超图计划搜索总入口 | 超限/超时时用 `GraphSimplifier` 化简图重跑（最多 3 次） |
| `EnumerateAllConnectedPartitions` in `subgraph_enumeration.h:94` | DPhyp 连通子图枚举 | 天然不产生笛卡尔积计划 |
| `CostingReceiver::FoundSubgraphPair` in `join_optimizer.cc:4913` | 对每个子图对提案 AccessPath | 对应 DPhyp 论文的 EmitCsgCmp |
| `FinalizePlanForQueryBlock` in `finalize_plan.cc:873` | 计划定稿 | 可多次 FindBestQueryPlan 但 Finalize 只能一次 |
| `test_quick_select` in `range_optimizer.cc:484` | 区间优化器入口 | 返回 range/index_merge/skip-scan AccessPath |
| `Optimize_table_order::choose_table_order` in `sql_optimizer.cc:5448` | 老优化器连接序 | greedy search，深度受 optimizer_search_depth 限制 |

</details>

## 核心实现

### 超图与 NodeMap：用位图表达连接结构

`NodeMap = uint64_t`（`sql/join_optimizer/node_map.h:40`），每个表占一位，上限 61 张表（`MAX_TABLES = 64 - 3`，`sql/sql_const.h:109`，留 3 个伪表位）。图结构 `Hypergraph`（`hypergraph.h:92`）极简：`nodes[]` + `edges[]`，每条 `Hyperedge{NodeMap left, right}`——外连接/反连接/超谓词（`t1.a+t2.b=t3.c`）统一编码为超边，从结构上约束合法连接序，这是 DPhyp 相比老优化器最大的表达力优势（老代码需要 embedding map 特判）。`Node` 把边分成 `simple_edges`（单侧单节点，可用 `simple_neighborhood` 位图整体剔除）与 `complex_edges` 两个列表。三个性能细节写在头注释里：**边按有向方式存两份**（分支误预测减少，整体提速约 30%）；**`Node` 填充到 64 字节对齐 cache line**（5-10% 提升）；集合运算全用位图交集/并集（紧凑且极快，超过 61 表需动态 bitset 时打算把 NodeMap 类型模板化）。

### DPhyp：连通子图对枚举

`subgraph_enumeration.h` 的头注释直接给出算法出处——Neumann & Moerkotte 的 *Dynamic Programming Strikes Back*。算法从种子节点出发，`EnumerateAllConnectedPartitions` 反复找出"连通子图对 (S₁, S₂)"（S₁∪S₂ 连通且是某条超边两端可覆盖的集合），每找到一个对就回调 `receiver->FoundSubgraphPair()`——因为枚举的天然单位是"由谓词连接的子图对"，**不可能产出含笛卡尔积的连接序**。超时/超规模（`optimizer_max_subgraph_pairs`）时 `GraphSimplifier` 合并节点把图化小后重跑。

### CostingReceiver：估价与剪枝

`CostingReceiver`（`join_optimizer.cc:309`）持有 `NodeMap → AccessPathSet` 的映射，对每个子图只留最廉价候选（头注释承认目前每子计划只存单一 cost 值，未来要扩展 Pareto 多维——initial cost vs total cost 对 LIMIT 的意义）。join 形态由 `ProposeHashJoin()`（`:5341`）与 `ProposeNestedLoopJoin()`（`:6046`）提案。成本常量来自 `sql/join_optimizer/cost_constants.h`：**成本单位 1.0 定义为对 10 列 int、百万行 InnoDB 表全表扫描的每行平均成本**，其余常数按比值标定以降低硬件敏感度。

### interesting orders：NFSM→DFSM 的排序推理

`LogicalOrderings`（`interesting_orders.h:316`）解决"哪些排序值得保留"：一个元组流可同时满足多个逻辑排序（有 FD `{a}→c` 时 (ab) 蕴含 (abc)），若某计划恰好按需要的顺序产出行就能省一次 sort。实现把"当前遵循哪个排序"建模为 NFSM 状态（FD 是边），用标准 powerset 构造转成 DFSM（`ConvertNFSMToDFSM`）——此后每个 AccessPath 的排序状态只是一个整数（`AccessPath::ordering_state`，`access_path.h:427`，实际是 LogicalOrderings 的 StateIndex，用基础 int 类型是为避免头文件依赖），`CostingReceiver` 在组合子计划时 `ApplyFDs()` 沿 DFSM 前进，`DoesFollowOrder()` 查预计算 bitset 全是 O(1)。理论出处（Neumann/Moerkotte 两篇 order optimization 论文 + Simmen 1996）全文列在头注释。两个已知局限（头注释自述）：**传递性 FD 不总是被正确跟随**——排序 (a) 加 FD `{a}→b`、`{b}→c` 会推出 (ab)(abc) 但推不出 (ac)（有启发式补救）；FD 与 ordering 上限 64 个，超出静默忽略。

### in2exists 双重规划

被 IN-to-EXISTS 改写过的子查询（`WHERE x IN (SELECT ...)` → `WHERE EXISTS (... HAVING y=x)`）会**规划两次**：一次带改写条件、一次去掉（`sql_optimizer.cc:688` 的 `m_root_access_path_no_in2exists = FindBestQueryPlan(...)`）——外层由此可以在"物化子查询"与"直接执行"间按精确成本抉择。为什么必须规划两份：in2exists 加出的条件依赖外层取值，**物化前必须去掉它们——不去掉不但结果错误，代价估计也会失真**，进而选出次优连接序（`join_optimizer.h:70-100` 的完整设计说明；代码刻意不为两份规划共享计算，注释直言"共享的复杂度不值这点收益"）。这是"计划搜索与代价估计互相反馈"的少见于教科书的实例。

### range optimizer：SEL_ARG 区间树

`test_quick_select()`（`sql/range_optimizer.cc:484`）把 WHERE 谓词转成索引访问区间。数据结构三层：`SEL_ROOT`/`SEL_ARG`（`tree.h:57/466`）是**红黑树节点 = 一个 keypart 的闭开区间**，节点双向链成有序区间表，`next_key_part` 指向后续 keypart 的另一棵树——形成分层区间图，`(kp1=1 AND kp2>5) OR (kp1=2)` 无需展开笛卡尔积；`SEL_TREE`（`tree.h:874`）按索引分槽，`tree_and()/tree_or()` 做代数合并。头注释给出最坏规模证明（区间图可达 O(2^(#keyparts/2))）并设节点数上限。`SEL_TREE::inexact` 标志标记"过宽近似"（如 `x mod 2 = 1`），扫描后必须回 FILTER 复查——准确性与可表示性的折中。

### 老优化器：greedy prefix search

`Optimize_table_order::choose_table_order`（`sql_optimizer.cc:5448`）→ `greedy_search()`（`sql_planner.cc:2330`）：每次贪心扩展一个表前缀，深度受 `optimizer_search_depth` 限制（等于表数时退化为 O(N!) 穷举），`optimizer_prune_level` 控制剪枝。老优化器最终也**收敛到 AccessPath**（`JOIN::create_access_paths`）——两条管线共用同一执行层，这是渐进替换得以安全进行的关键。

### 开关与默认值

```text
CMake: WITH_HYPERGRAPH_OPTIMIZER 默认 ON（编译进二进制）
       ENABLE_HYPERGRAPH_OPTIMIZER 默认 OFF（是否默认启用）   # CMakeLists.txt:2306-2317
运行时: SET optimizer_switch='hypergraph_optimizer=on'        # bit 24, sql_const.h:224
       （该名字在 sys_vars.cc:3299 注明"故意不写入文档"）
未编译超图时: update_optimizer_switch() 强制从变量清除该位（sys_vars.cc:3271），
       尝试开启则 check_optimizer_switch() 报 ER_HYPERGRAPH_NOT_SUPPORTED_YET（:3279）
限制:  不支持 UPDATE、不支持 hints（除 STRAIGHT_JOIN）、EXPLAIN 仅 FORMAT=tree
```

### 成本模型与直方图

老模型常量（`sql/opt_costconstants.h:66/208`）：`row_evaluate_cost=0.1`、`disk_temptable_create_cost=20.0` 等，**用户可通过 `mysql.server_cost`/`mysql.engine_cost` 表覆盖**。直方图两类（`histogram.h:315`）：`Equi_height`（等高桶，高基数列）与 `Singleton`（单值桶，低基数列），JSON 持久化于 `mysql.column_stats` 表；`ANALYZE TABLE ... UPDATE HISTOGRAM` 入口 `Sql_cmd_analyze_table::update_histogram`（`sql/sql_admin.cc:650`）。消费侧：老优化器 `get_histogram_selectivity`（`sql/item_cmpfunc.cc:252`），超图优化器 `HistogramSelectivity`（`estimate_selectivity.cc:57`）。被唯一索引覆盖的列不建直方图（无意义），且无自动增量更新——用 `information_schema.column_statistics` 观察时效。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 模板方法（Receiver） | `EnumerateAllConnectedPartitions<Receiver>`（`subgraph_enumeration.h`） | 枚举算法与"发现子图后做什么"解耦，可换计数器/估价器 |
| 状态机 | `LogicalOrderings` DFSM | 把指数级排序推理压缩成整数查表 |
| 组合 | AccessPath 树 | 计划空间天然是树 |
| 策略 | `sql_planner.cc` vs `join_optimizer/` 双实现 | 新旧替换期的共存 |

## 模块间交互

- **上游**：`Sql_cmd_dml::execute` 的 prepare 阶段（`sql/sql_select.cc:685`）调 `Query_expression::optimize` → `JOIN::optimize`；
- **下游**：`root AccessPath` 交给[执行器](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/04-executor)的 `CreateIteratorFromAccessPath`；
- **与统计**：基数估计读 DD 的 `table_stats/index_stats`（见[DD 模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/07-dd-ddl)）与直方图；
- **与引擎**：`test_quick_select` 经 `handler::records()` 等接口向引擎要统计；secondary engine（HeatWave 类）通过 `secondary_engine_cost_hook`（`join_optimizer.cc:327`）参与估价；
- **与执行反馈**：EXPLAIN ANALYZE 由 iterator 计时回填 `AccessPath::iterator` 指针，计划与执行双向可追溯。

## 扩展方式

- **新增 AccessPath 类型**（以 `INDEX_SKIP_SCAN` 的引用面为样本）：`access_path.h` 枚举加值 + params struct + 工厂 → `access_path.cc` 的 `CreateIteratorFromAccessPath` switch 加 case → 超图侧 `CostingReceiver` 提案 / 老优化器侧 `sql_planner.cc` 估价 → `explain_access_path.cc` 展示；
- **新增 optimizer_switch 开关**：`sql_const.h` 位定义 → `sys_vars.cc:207/3299` 名字串与默认值 → 消费点（如 `fix_semijoin_strategies` in `sql_optimizer.cc:3073`）；
- **新增直方图类型**：`histogram.h:315` 的 `enum_histogram_type` 加值 + 新子类（对照 `singleton.h`）+ `table_histograms.cc` 的构建与持久化。
