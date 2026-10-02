---
source:
  type: "源码解读"
  project: "pgvector"
  url: "https://github.com/pgvector/pgvector"
title: "SQL 接口与索引注册"
date: "2026-10-02T16:47:23+08:00"
category: [Database, VectorSearch, PgVector, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, PgVector, CodeWiki, "master-2026-08"]
tags: ["PgVector", "SQL", "PostgreSQL", "AccessMethod", "opclass"]
description: "pgvector SQL 接口层解读——sql/vector.sql 1212 行的 114 函数/24 opclass/2 个 ACCESS METHOD 全景、ordering operator 与 support proc 协议、IndexAmRoutine 注册链路（PG19 static const 二分写法）、0.8.7 注释重放迁移与版本兼容策略全解"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

这一层是 pgvector 与 Postgres 目录机制打交道的唯一界面：把 C 能力**声明**成 SQL 对象（类型/函数/运算符/opclass/AM），把索引**注册**成 access method，把版本演进**固化**成迁移链。它没有算法，却是理解"为什么新增一个距离度量要改 SQL 文件而不是 C 代码"的钥匙——pgvector 的所有扩展点都以目录对象的形式存在，C 代码只认协议编号。

一个容易误解的事实先行澄清：pgvector **没有显式 `CREATE OPERATOR FAMILY`**——24 个 opclass 各自隐式创建同名 family；且 AM 索引 opclass 的语义不是常规的 comparison strategy，而是 **ordering operator**（`amcanorderbyop = true`、`amstrategies = 0`）。

## 模块架构

![SQL 目录对象全景（sql/vector.sql）](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/sql-am-objects.svg)

`sql/vector.sql` 按「control 文件 → 类型 → 函数 → 运算符 → opclass → AM」五段展开，四种类型（vector/halfvec/sparsevec/bit）逐段同构。关键结构决策：

- **`STORAGE = external`**（CREATE TYPE 处）：向量最大 64KB，不压缩不打齐，走 TOAST external 避开压缩路径的性能开销
- **公开函数与私有函数分离**：距离/工具函数用户可直调；"implementation of X operator" 系列（COMMENT 明示私有）是运算符/opclass 的实现细节
- **opclass 是索引与类型的唯一耦合点**：`OPERATOR 1 <-> FOR ORDER BY float_ops` 声明排序算子，`FUNCTION 1-5` 注册 support proc——C 侧 `hnsw.h:37`/`ivfflat.h:40` 的编号宏与之一一对应
- **cast 级别方向不对称**（sql/vector.sql:692-698）：`vector → halfvec` 为 `AS IMPLICIT`（可隐式自动转换），`halfvec → vector` 却是 `AS ASSIGNMENT`（仅赋值语境）——"窄化有损所以显式、放宽无损反而只许赋值"看似反直觉，实则是把隐式转换限制在"向 halfvec 列写 vector 值"这一主路径上，避免表达式里被悄悄换类型；数组桥同理：`array_to_vector` 全部 ASSIGNMENT，`vector → float4[]` 却是 IMPLICIT（vector.sql:238）

## 调用链路

![扩展加载到索引回调的注册链路](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/am-registration-chain.svg)

从 `CREATE EXTENSION` 到 executor 回调是四跳：control 文件决定加载哪个 .sql 与 .so；`.sql` 把对象写进 pg_am/pg_opclass 等系统目录；`CREATE INDEX … USING hnsw` 时 executor 经 `pg_am.amhandler` 调 `hnswhandler()`（hnsw.c:266）拿到 `IndexAmRoutine` 函数表；此后 planner/executor 全部按槽位回调。`AM 不属于 schema` 是 `relocatable = true`（vector.control:4）成立的前提——所有函数/类型随 schema 移动，AM 全局唯一不动。版本化安装脚本由 Makefile 的 `DATA_built` 规则生成：`sql/$(EXTENSION)--$(EXTVERSION).sql: sql/$(EXTENSION).sql` 就是一条 `cp` 复制（Makefile:48-49），vector.sql 是唯一真源。

<details>
<summary>方法速查表</summary>

| 对象/函数 | 一行职责 | 关键设计决策 |
|---|---|---|
| `vector.control` | 扩展清单 | `default_version '0.8.6'` · `relocatable true` |
| `Makefile` DATA_built | 由 vector.sql 生成版本化安装脚本 | EXTVERSION 与文件名必须同步 |
| `hnswhandler` (hnsw.c:266) | 返回 HNSW 的 IndexAmRoutine | PG≥19 static const；`amcanorderbyop`/`amoptionalkey`/`amcanbuildparallel` 均 true，`amcanunique`/`amcanmulticol`/`amcanparallel` 均 false，`amparallelvacuumoptions = VACUUM_OPTION_PARALLEL_BULKDEL` |
| `ivfflathandler` (ivfflat.c:184) | 返回 IVFFlat 的 IndexAmRoutine | `amsupport = 5`（kmeans 两个额外 proc）；能力位与 hnsw 相同 |
| `HnswInit` (hnsw.c:52) | 注册 hnsw.* GUC + LWLock tranche | `hnsw.ef_search` 范围 1..1000、默认 40（hnsw.h:60）；`MarkGUCPrefixReserved("hnsw")` 占前缀防撞名 |
| `IvfflatInit` (ivfflat.c:38) | 注册 ivfflat.* GUC + lists reloption | probes 是 USERSET，逐会话热调 |
| `vector--0.8.6--0.8.7.sql` | 0.8.7 迁移 | 147 条 COMMENT 重放，无任何 DDL |
| opclass `FUNCTION 1` | 查询距离 proc | 平方版/负内积版，索引内省 sqrt |
| opclass `FUNCTION 3/4`（ivf） | kmeans 距离/归一化 | 球面 kmeans 的度量保障 |
| opclass `FUNCTION 3/5`（typeinfo） | 传 `HnswTypeInfo`/`IvfflatTypeInfo` 指针 | `RETURNS internal`——SQL 目录携带 C 结构 |

</details>

## 核心实现

### 114 个函数的分层与"双注册"策略

`sql/vector.sql`（1212 行）的函数面按消费者分四层：I/O 五件套（in/out/typmod_in/recv/send，×3 类型）；公开距离与工具（`l2_distance` 等，用户可直调）；私有实现（比较六件套、算术、**索引内部距离**）；聚合（`accum/avg/combine`，`COMBINEFUNC` 支持并行聚合）。

「双注册」是这层最精妙的安排——同一距离语义挂三个不同的钩子，各有用途：

```sql title="sql/vector.sql — 同一度量的三个注册点"
CREATE OPERATOR <-> (PROCEDURE = l2_distance, ...);        -- 用户运算符：含 sqrt
CREATE OPERATOR CLASS vector_l2_ops ... AS
    OPERATOR 1 <-> (vector, vector) FOR ORDER BY float_ops, -- planner 匹配索引
    FUNCTION 1 vector_l2_squared_distance(vector, vector), -- 索引内部：省 sqrt
    FUNCTION 3 l2_distance(vector, vector);                 -- IVFFlat kmeans：真度量
```

`OPERATOR 1` 是 ordering operator 槽位（`amstrategies = 0` 说明没有 comparison strategy），`FOR ORDER BY float_ops` 声明 `<->` 产生的排序序与 float_ops family 的 btree 序一致——planner 据此把 `ORDER BY a <-> q` 匹配到索引（`amcanorderbyop=true`）。`<#>` 的 PROCEDURE 是 `vector_negative_inner_product`：SQL 语义是"最大内积优先"，取负后才能当距离 ASC 扫描（Postgres 索引扫描只支持一个方向）。

### support proc 协议：C 契约在 SQL 侧的镜像

```c title="src/hnsw.h / src/ivfflat.h — proc 编号契约"
#define HNSW_DISTANCE_PROC 1        /* 查询距离（平方版/负内积版） */
#define HNSW_NORM_PROC 2            /* cosine 类归一化 */
#define HNSW_TYPE_INFO_PROC 3       /* HnswTypeInfo 指针 */

#define IVFFLAT_DISTANCE_PROC 1
#define IVFFLAT_NORM_PROC 2
#define IVFFLAT_KMEANS_DISTANCE_PROC 3   /* Elkan 要求真度量 */
#define IVFFLAT_KMEANS_NORM_PROC 4       /* 球面 kmeans */
#define IVFFLAT_TYPE_INFO_PROC 5
```

C 侧 `index_getprocinfo(index, n, PROC)` 按编号取回 FmgrInfo，`amsupport = 3`（hnsw）/`5`（ivfflat）是目录侧的容量声明。typeinfo proc 用 `RETURNS internal` 直接传 C 结构指针（`hnsw_halfvec_support` 返回 static const `HnswTypeInfo`，hnswutils.c:1398），让 SQL 目录携带"每类型最大维度/归一化函数"这类 SQL 无法表达的信息；`HnswGetTypeInfo` 对未注册的 opclass（vector 各类）回退默认值（hnswutils.c:1380），新老 opclass 共存——**这就是新增类型不改索引代码的全部机制**。

handler 函数不标 IMMUTABLE/STRICT（vector.sql:350 对比其他函数）：handler 仅在 relcache 建 AM 时调用一次，纯度标注无意义。

### PG 19 兼容：handler 写法的二分

`hnsw.c:270` 起同一个 handler 用 `#if PG_VERSION_NUM >= 190000` 写成两种形态。PG≥19 用 **static const 指定初始化器**：所有字段必须显式列出（漏写编译报错而非静默置 NULL，等于一份版本契约清单），且 handler 可能被反复调用，返回静态结构才持久。旧路径用 `makeNode` + palloc 后逐字段 `#if PG_VERSION_NUM >= 140000/160000/170000/180000` 增量赋值——`amtranslatestrategy`/`amtranslatecmptype` 是 **PG 18** 引入的字段（hnsw.c:395 的 `#if >= 180000`）。向下兼容到 PG 13 全靠这套条件编译矩阵。

### 版本迁移：0.8.7 为什么全是 COMMENT

`sql/vector--0.8.6--0.8.7.sql`（296 行）除首行 `\echo` 外**全部 147 条是 `COMMENT ON`**，没有任何 CREATE/ALTER。原因：COMMENT 是在各历史版本的 vector.sql 里逐步补上的，但 `ALTER EXTENSION UPDATE` 的迁移脚本从不重放注释，存量安装的对象注释永远缺失——0.8.7 把全量注释补进迁移脚本，使所有升级路径收敛到与全新安装一致（#1013，对应提交 `Added comments to functions/operators/aggregates/data types`）。

0.8.7 的唯一功能修复（`avg` 空结果，CHANGELOG）是纯 C 修复——C 函数体经 `module_pathname` 在调用期动态解析，.so 更新即生效，**不需要 SQL 迁移**；这也是 0.8.5→0.8.6 迁移几乎为空的原因。迁移链的粒度规律：纯 C 修复 → 近似空的迁移脚本；涉及目录对象变更 → 真实 DDL；目录元数据补齐 → COMMENT 重放。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 间接层（目录协议） | opclass `FUNCTION n` ↔ C 宏编号 | 类型/度量/索引三轴解耦，扩展点全在 SQL |
| 版本二分写法 | `#if PG_VERSION_NUM >= 190000`（hnsw.c:270/ivfflat.c:187） | 新版本享受编译期完整性检查，老版本保兼容 |
| 前缀保留 | `MarkGUCPrefixReserved("hnsw")`（hnsw.c:111） | 防第三方 GUC 撞名 |
| 迁移链累积 | `sql/vector--X--Y.sql` 逐版本串接 | 任意老版本可跳级升级（Postgres 按 default_version 找路径） |

## 模块间交互

本层是其余三个模块的**对外出口**：`sql/vector.sql` 的 `LANGUAGE C` 声明把类型层/索引层的 `PG_FUNCTION_INFO_V1` 符号绑进目录；opclass 的 `OPERATOR 1` 让 planner 认得 `<->`；`CREATE ACCESS METHOD` 让 `CREATE INDEX USING hnsw` 有 AM 可用；`vector.control` + `_PG_init` 完成运行时装配。反向依赖只有一处：handler 与 GUC 注册的 C 实现在 `hnsw.c`/`ivfflat.c`（归索引模块的 AM 入口文件）。

## 扩展方式

- **新增索引类型**：C 侧写 `xxxhandler` 返回 IndexAmRoutine（PG≥19 用 static const）→ vector.sql 加 handler 函数 + `CREATE ACCESS METHOD` + 各类型 opclass（`OPERATOR 1` 复用现有 `<->`）→ `amvalidate` 校验逻辑
- **升级版本**：bump `vector.control` 的 `default_version` 与 `PG_MODULE_MAGIC_EXT` 的 version（vector.c:49）+ Makefile `EXTVERSION` 同步；纯 C 修复写近似空的迁移脚本，对象变更才写 DDL
- **新增 opclass**：照五段模板复制到对应类型段；`hnswvalidate`（hnsw.c:255）目前恒 true，无需改 C 校验
