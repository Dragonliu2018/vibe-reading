---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "SELECT 与查询计划"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "查询优化器", "LogEst"]
description: "select.c 的 tag-0100~1000 编译流水线、where.c 的 beam search 近似 DP、LogEst 对数代价模型、自动索引回收期与 28 条展平规则"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

SQLite 的查询优化器。where.c 文件头自述（:13-17）：*"this module is responsible for selecting indices, you might also think of this module as the 'query optimizer'"*。但"优化"被拆成两半：**语法树重写层**（select.c 的 flattening、谓词下推、常量传播、外连接强度削减）和**计划搜索层**（where.c 的嵌套循环序 + 索引选择）。SQLite 的路线是"先重写到最简，再对最简树做轻量搜索"——与 Cascades/动态规划学派完全不同，这是嵌入式约束（规划时间严格有界、不预分配大内存）的产物。

## 模块架构

优化器的**四层对象模型**（whereInt.h 全文 665 行）：

| 结构 | 行号 | 职责 |
| --- | --- | --- |
| `WhereInfo` | :472 | 最外层上下文与返回值，持有 nLevel 个 WhereLevel |
| `WhereLevel` | :73 | **单个嵌套循环的实现**（游标、跳转地址、LEFT JOIN 标志寄存器） |
| `WhereLoop` | :129 | **一种候选算法**（代价三元组 rSetup/rRun/nOut 均 LogEst） |
| `WherePath` | :213 | solver 工作单元：一条路径 + 累计代价 + isOrdered |
| `WhereClause`/`WhereTerm` | :353/:274 | WHERE 分解容器 / 单个约束项（WO_* 操作符掩码） |
| `WhereMaskSet` | :412 | 稀疏游标号→连续 bit，**join 上限 64 表的来源** |

whereInt.h:199-211 的注释明说搜索模型：把 WhereLoop 看作图中节点，WherePath 是路径。

## 调用链路

`sqlite3Select()`（select.c:7651，函数头 :7617-7649 有权威 outline）的完整流水线：

```text title="sqlite3Select 编译流水线"
1. sqlite3SelectPrep: 展开('*'/子查询) → 名称解析 → 类型信息
2. sqlite3WindowRewrite (window.c:958)   # 窗口函数包一层子查询隔离
3. FROM 第一遍扫描:
   ├─ 外连接强度削减 (:7803, sqlite3ExprImpliesNonNullRow)
   └─ flattenSubquery (:7940, 定义 :4334)  # 28 条 Restriction 白名单
4. multiSelect 分流（compound）/ EXISTS→JOIN / propagateConstants (:7985)
5. FROM 第二遍: pushDownWhereTerms + 子查询四选一
   （co-routine / CTE 复用 / 视图复用 / materialize）
6. sqlite3WhereBegin (where.c:6826)
   ├─ whereShortCut (:6350)      # 单表 rowid 等值零成本出计划
   ├─ whereLoopAddAll (:4937)    # 候选生成（btree/vtab/OR-term）
   ├─ wherePathSolver (:5834)    # beam search 求解（两遍）
   └─ sqlite3WhereCodeOneLoopStart (wherecode.c)  # 生成 opcode
7. selectInnerLoop (:1908) → OP_ResultRow
8. sqlite3WhereEnd (:7529)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `sqlite3Select` in select.c:7651 | SELECT 总编译器 | 函数头 outline 带 tag-select-XXXX 可 grep 定位 |
| `flattenSubquery` in select.c:4334 | 子查询展平 | 28 条 Restriction 每条对应一个历史 ticket |
| `propagateConstants` in select.c:5007 | 常量传播树重写 | 改打 `EP_FixedCol` 而非改写为字面量，规避 affinity 陷阱 |
| `sqlite3WhereBegin` in where.c:6826 | 优化器主入口 | 快路径 + 候选 + 求解 + 代码生成一体 |
| `whereShortCut` in where.c:6350 | rowid/唯一索引等值直达 | `rRun=33`（≈10 行代价）跳过整个 planner |
| `wherePathSolver` in where.c:5834 | N-best beam search | 每代保留 mxChoice=12/18 条路径 |
| `whereLoopAddBtreeIndex` in where.c:3219 | 单索引候选代价 | 全部 LogEst 整数运算 |
| `sqlite3WhereCodeOneLoopStart` in wherecode.c | 计划→opcode | `codeAllEqualityTerms` 把约束装进 regBase[] |

</details>

## 核心实现

### LogEst：log2(x)×10 的整数代价模型

所有代价量（rSetup/rRun/nOut/表大小）都是 LogEst——16 位级整数，换算见 util.c 的 `sqlite3LogEst()`。选对数域的三个理由：**(a) 代价的乘法组合变加法**，`sqlite3LogEstAdd` 一次近似公式搞定，纯整数无浮点；**(b) 估计本身只有 1-2 位有效精度**，对数域 +3/-2 微调等价于线性域细粒度偏好且永不溢出；**(c) 巨表（10^12 行）与小表同量程安全比较**。SQLite 的成本本质是**逻辑 IO 估算**（访问的行数的对数），没有 Postgres 式的 CPU+shared_buffers 双参数——因为它没有运行时缓存命中率信息可利用。

单索引扫描代价公式（where.c:3544-3577）：每行步进 `nOut + 1 + 15*szIdxRow/szTabRow`（索引行小则便宜）+ 一次 seek 的 LogEstAdd + 非覆盖索引的回表代价 + IN 乘数。有 STAT4 时改用直方图样本查表（`whereRangeScanEst`，:3472）。

### beam search 而非精确 DP

`wherePathSolver`（:5834）逐代扩展路径：先求长度 1 的 N 条最优，再扩展到长度 2……每代只留 `mxChoice` 条（nLoop≤1→1、2→5、3+→12 或 18，:5859-5876）。候选替换按 (rCost, nRow, rUnsort) **向量字典序**。64 表 join 的精确 DP 是 N!×N 级；beam width 12 + `iPlanLimit` 20000（whereInt.h:442，超限降级为 abbreviated search 并打 SQLITE_WARNING 日志而非失败）保证最坏情况可预期。

Cascades 需要规则引擎和 Memo 结构，与"单个 .c 文件、可裁剪到几十 KB"的部署目标冲突——where.c:13 的自我定位就是反 Cascades 的宣言。代价是可能错过最优 join 序（官方文档公开承认 "does not attempt to be exact"）。

### 自动索引：LogEst 框架内的自然竞争

自动索引（`WHERE_AUTO_INDEX`）在 `whereLoopAddBtree()` 生成（where.c:4063-4116）：一次性建索引代价 `rSetup = rLogSize + rSize + 28`（即 X·N·log₂N，X=7），查找侧 `nOut=43`（假设每次命中 20 行）。它不需要特判——rSetup 大 rRun 小的候选与 rSetup=0 的嵌套循环在同一 LogEst 加法框架下自然竞争。回收期判断在 solver：外层预计迭代 `<28` 次（`aFrom[0].nRow = MIN(nQueryLoop, 48)`，:5920）则 N·logN 建索引成本收不回。

### 展平优先：rewrite-then-plan 架构

SQLite 把尽可能多的优化放在**树重写层**，planner 只面对"已经最简"的树。重写层优化彼此正交、可逐条用 `OptimizationEnabled(db, SQLITE_Xxx)` 独立关闭做 A/B 回归测试；where.c 保持单一职责。`flattenSubquery` 的 28 条 Restriction 是**白名单式安全证明**——每条对应"展平会改变语义"的一个已知场景，注释里带着历史 ticket 编号。

常量传播的工程细节值得单独一提（select.c:4974-5005 注释）：`WHERE t1.a=39 AND t2.b=t1.a` **不改写**为 `b=123`，而是给 `a` 打 `EP_FixedCol` 把常量挂上——因为 affinity/collation 语义下 `b=a` 为真而 `b=123` 为假的反例存在（BLOB affinity 列）。

### 窗口函数：重写隔离

`sqlite3WindowRewrite`（window.c:958）在流水线最早期把含窗口函数的 SELECT 包一层子查询：子查询内做 PARTITION BY+ORDER BY 排序，父查询消费；设 `SF_WinRewrite` 禁止对这结构再展平。执行期子查询固定走 co-routine。Why：窗口函数需要"按 partition 顺序消费行"，与 where.c 的嵌套循环模型正交——用重写把它隔离在流水线之外，**where.c 对窗口函数零感知**。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| N-best beam search | `wherePathSolver` | 规划时间严格有界 |
| 白名单重写 | `flattenSubquery` 28 条 Restriction | 每条可独立验证安全 |
| 模板 + 插入 | `WhereLoopBuilder.pNew` 复用模板对象 | 每候选零堆分配 |
| 两遍求解 | `whereInterstageHeuristic`（:6262）+ 二次 solver | 第一遍拿行数估计，第二遍才让 ORDER BY 代价完整参与 |
| OR 递归 | `exprAnalyzeOrTerm`（whereexpr.c:692）+ `WhereOrSet` 留 top-3 | OR 天然是"多个独立搜索的并" |

## 模块间交互

- **与 expr.c**：whereexpr.c 只做"形态分析"（列在哪侧、操作符掩码、prereq 位图），等价性判定借用 `sqlite3ExprCompare`/`sqlite3ExprImpliesNonNullRow`。表达式求值成本**不计入** LogEst——代价模型只算行数与页访问。
- **与 vdbe**：planner 不直接碰 btree；它生成 `OP_OpenRead/OP_SeekGE/OP_IdxGT` 序列由 VDBE 调 btree 游标。唯一间接耦合是代价参数来自 `Index.aiRowLogEst[]`（analyze.c 的 ANALYZE 产物）。
- **与 vtab.c**：`vtabBestIndex()`（where.c:1672）在候选生成期调扩展的 xBestIndex 协商。
- **行数估计沿链累加**：`pParse->nQueryLoop += nRowOut`（where.c:7195）——内层子查询的自动索引判定依赖它。

## 扩展方式

| 想改什么 | 改哪里 |
| --- | --- |
| 新约束利用启发式 | whereexpr.c:1150 `exprAnalyze()` + where.c:3035 `whereLoopOutputAdjust()` |
| 新 join 代价启发式 | where.c:5834 `wherePathSolver()` 或 :6262 中间修正 |
| 新索引使用算法（如 skip-scan） | where.c:3219 候选枚举 → wherecode.c 代码生成 → whereInt.h 加 wsFlags |
| 新树重写优化 | select.c 流水线插一个 tag 阶段 + 独立 static 函数 + sqliteInt.h 注册 `SQLITE_Xxx` 开关 |
| 调自动索引激进程度 | where.c:4087-4109 的 TUNING 常量（grep `TUNING` 约 30 处，每处附换算断言） |

工程惯例：所有优化必须挂 `OptimizationEnabled` 开关以便 A/B 测试；`WHERETRACE`/`TREETRACE` 条件编译块是调试输出的标准通道。
