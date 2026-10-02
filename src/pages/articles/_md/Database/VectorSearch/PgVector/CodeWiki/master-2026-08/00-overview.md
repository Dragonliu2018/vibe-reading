---
source:
  type: "源码解读"
  project: "pgvector"
  url: "https://github.com/pgvector/pgvector"
title: "Overview"
date: "2026-10-02T16:47:23+08:00"
category: [Database, VectorSearch, PgVector, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, PgVector, CodeWiki, "master-2026-08"]
tags: ["PgVector", "C", "PostgreSQL", "向量检索", "HNSW"]
description: "pgvector master-2026-08 源码架构解读——Postgres 向量相似度检索扩展：四种向量类型的 varlena 布局与 SIMD 分发、HNSW 多层图与图修复 vacuum、IVFFlat 的 Elkan 球面 kmeans 与两级页结构、support proc 解耦与 IndexAmRoutine 注册全解"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** master-2026-08 · **协议** PostgreSQL License · **语言** C（PostgreSQL 扩展，支持 PG 13+） · **代码量** ~14,000 行 C + ~2,300 行 SQL · **仓库** [GitHub](https://github.com/pgvector/pgvector)
>
> **解读基线** commit [`e48241b`](https://github.com/pgvector/pgvector/commit/e48241b4dcc045b18902914f668d03d1d399dfbe)（2026-08-19，v0.8.6 后 56 个提交，0.8.7 开发中快照）

---

## 总览

### 项目简介

pgvector 是 PostgreSQL 的开源向量相似度检索扩展——在 Postgres 里存向量、算距离、建近似最近邻（ANN）索引。它解决的问题是：应用把 embedding 存进数据库后，`ORDER BY embedding <-> query LIMIT k` 这类 KNN 查询没有索引只能全表扫 + 排序。pgvector 补上这条路，同时把「向量」变成一等公民：和普通列一起 JOIN、一起事务、一起 ACID。

它的核心价值在于**复用而不是重造**：不自建存储引擎，图结构和倒排列表全部物化为普通 Postgres 索引页，免费获得 buffer manager、WAL 崩溃恢复、MVCC、vacuum 框架和并行构建——整个 C 实现只有 ~14k 行，是 Milvus（Go+C++ ~180 万行）、Faiss（~19 万行）这类专用系统的百分之一量级。

核心使用场景是 RAG/语义检索/embedding 相似查询。**项目边界**：它只提供向量类型和两种 ANN 索引（HNSW/IVFFlat），不做索引内乘积量化（PQ）——「量化」路线靠换类型实现（halfvec 半精度、bit 二值化），不提供分区/分布式/多副本等数据库级能力（那是宿主 Postgres 的事）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|---|---|---|
| vector 类型（float32） | `src/vector.c` | ≤16000 维，text/binary I/O，聚合 avg/sum |
| halfvec 类型（float16） | `src/halfvec.c` + `halfutils.c` | ≤16000 维，F16C SIMD 距离 |
| sparsevec 类型（稀疏） | `src/sparsevec.c` | COO 布局，dim ≤1e9、nnz ≤16000 |
| bit 距离 | `src/bitvec.c` + `bitutils.c` | 复用内核 VarBit，AVX-512 popcount |
| 6 种距离度量 | `src/vector.c` 等 | L2 / 内积 / 余弦 / L1 / Hamming / Jaccard |
| HNSW 索引 | `src/hnsw*.c`（8 文件） | 多层图，m / ef_construction reloption |
| IVFFlat 索引 | `src/ivf*.c`（8 文件） | kmeans 倒排，lists reloption + probes GUC |
| 迭代索引扫描 | `src/hnswscan.c` / `ivfscan.c` | 0.8.0+，过滤查询下自动续扫 |
| 并行索引构建 | `src/hnswbuild.c` / `ivfbuild.c` | 共享内存图 / 共享排序，`amcanbuildparallel` |
| 半精度/二值量化 | `halfvec.c` / `vector.c` 的 `binary_quantize` | 换类型降内存，非索引内 PQ |

### 技术栈

| 依赖 | 类型 | 用途 |
|---|---|---|
| PostgreSQL 13+ | 宿主 | 索引 AM 框架、varlena/fmgr、buffer/WAL、扩展机制 |
| GenericXLog | 核心 | 索引页的 WAL 全页日志（非事务性索引的标准做法） |
| lib/simplehash、pairingheap、tuplesort | 核心 | visited 哈希、候选/结果堆、构建排序 |
| GCC target_clones / IFUNC | 可选 | vector 距离内核的 CPU 分发（Linux） |
| F16C / AVX-512 intrinsics | 可选 | halfvec 半精度转换、bit popcount |

### 版本历史

| 版本 | 时间 | 里程碑 |
|---|---|---|
| 0.5.0 | 2023-08 | 新增 HNSW 索引；IVFFlat 并行构建 |
| 0.7.0 | 2024-04 | 新增 halfvec / sparsevec 类型；bit 类型可建索引；维度上限 16000 |
| 0.8.0 | 2024-10 | 迭代索引扫描（iterative scan），过滤查询自动续扫 |
| 0.8.6 | 2026-07 | 当前 release tag |
| 0.8.7（本基线） | 未发布 | `avg` 空结果修复、HNSW INSERT/VACUUM 竞态修复（#1010）、cast 加固（#1016）、全量 COMMENT 重放迁移 |

---

## 快速上手

```bash
cd /tmp && git clone https://github.com/pgvector/pgvector.git && cd pgvector
make && make install    # 需要 pg_config 在 PATH
```

```sql
CREATE EXTENSION vector;

CREATE TABLE items (id bigserial PRIMARY KEY, embedding vector(3));
INSERT INTO items (embedding) VALUES ('[1,2,3]'), ('[4,5,6]');

-- 无索引 = 精确搜索（完美召回）
SELECT * FROM items ORDER BY embedding <-> '[3,1,2]' LIMIT 5;

-- 建 HNSW 索引 = 近似搜索（速度换召回）
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops);
```

端到端验证：建索引后 `EXPLAIN ANALYZE` 应显示 `Index Scan using ... on items`，且 `ORDER BY embedding <-> '[3,1,2]'` 直接由索引输出有序结果，无需 Sort 节点。近似性体现在「可能漏掉个别真近邻」，已返回结果的距离值本身是精确的（`xs_recheck = false`，见[运行时行为](#核心运行流程)）。

---

## 架构设计解析

### 系统架构

先讲架构思想。pgvector 是一个**典型的「宿主寄生」扩展**：所有持久化状态都放进 Postgres 已有的设施里——类型走 varlena（可 TOAST）、索引走通用索引页 + GenericXLog、元数据走 reloption 和 GUC、SQL 接口走 extension 目录机制。它对内核唯一的「侵入」是注册了两个 index access method（hnsw/ivfflat），而这也是通过 `CREATE ACCESS METHOD` 这条官方通道完成的。这样设计换来的好处是：崩溃恢复、并发控制、流复制全部免费，代价是每次图遍历都要走 `ReadBuffer` 读页——pgvector 用短路剪枝（比当前最差结果远的元素连加载都不加载）把这条代价压到最低。

![pgvector 分层架构](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/architecture.svg)

四层职责与依赖方向：SQL 扩展接口层把 114 个 C 函数、24 个 opclass 和两个 AM 注册进系统目录；类型实现层提供四种向量类型和距离内核；索引引擎层实现 HNSW/IVFFlat 两个 `IndexAmRoutine`；PostgreSQL 内核在最底部提供一切基础设施。注意层间箭头方向：索引层**向上**调用类型层——距离计算不直连 C 符号，而是经 opclass 的 support proc（`FunctionCall2Coll`），这让新增类型/距离度量时索引代码零改动。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
|---|---|---|
| SQL 扩展接口层 | `sql/vector.sql`、`vector.control` | 把 C 能力声明进系统目录，使类型/运算符/索引对 SQL 可见 |
| 类型实现层 | `src/vector.c`、`halfvec.c`、`sparsevec.c`、`bitvec.c` + `halfutils`、`bitutils` | 承载向量数据模型与距离计算，向索引层暴露统一 proc 协议 |
| 索引引擎层 | `src/hnsw*.c`、`src/ivf*.c` | 用 Postgres 索引页实现两种 ANN 结构，对上满足 `IndexAmRoutine` 契约 |
| PostgreSQL 内核 | — | 提供存储/恢复/扩展/索引框架，pgvector 不复制任何一层 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 虚表/函数指针（Strategy） | `HnswTypeInfo`（`hnswutils.c:1396`）、`IvfflatTypeInfo`（`ivfutils.c:376`）、`HalfvecL2SquaredDistance` 等指针表（`halfutils.h:13`） | 类型差异和 CPU 差异都在一张函数表里隔离，索引代码不 switch 类型 |
| Support proc 解耦 | opclass `FUNCTION 1-5`（`hnsw.h:37`、`ivfflat.h:40`） | 索引与距离度量经 SQL 目录间接耦合，新增度量只改 SQL 不改 C |
| 启动期注册（Registry） | `_PG_init`（`vector.c:57`）→ 四个 Init | 扩展生命周期标准入口：装函数指针表、注册 GUC、注册 LWLock tranche |
| 双堆搜索（论文 Alg 2） | `HnswSearchLayer`（`hnswutils.c:824`） | candidate/result 两堆 + visited 哈希实现 ef 宽度可控的束搜索 |
| 两阶段构建 | `hnswbuild.c:1-36` 头注释 | 小图全内存快路径，大图自动降级磁盘路径，一条代码路径复用运行期插入 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---|---|---|---|
| `Vector` / `HalfVector` / `SparseVector` | 三种向量类型的磁盘/内存表示（varlena） | Datum 级，随行/索引元组 | 距离函数的输入；被 `HnswElementTupleData` 内嵌 |
| `HnswElement` | HNSW 图节点（构建期内存态，含每层邻居数组） | 一次 build/insert 期间 | 通过 `HnswPtrDeclare` 双态指针支持串行/并行 |
| `HnswElementTuple` + `HnswNeighborTuple` | 图节点的磁盘形态（type 1/type 2 两种索引元组） | 索引页内，vacuum 才清除 | 元素 tuple 携带 `neighbortid` 反指向邻接 tuple |
| `VectorArray` | IVFFlat 的定长向量数组（kmeans 样本/中心容器） | 构建期间 | `VectorArrayGet/Set` inline 访问器避免宏双求值 |
| `IvfflatListData` | 倒排 list 元数据（startPage/insertPage/center） | 索引生命周期 | 扫描按 center 距离选 list，插入找最近中心 |
| `IndexAmRoutine` | 索引 AM 函数表 | relcache 级 | hnsw/ivf 各一份，executor 按槽位回调 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|---|---|---|---|
| `IndexAmRoutine` | Postgres 内核 | `hnswhandler` / `ivfflathandler` | `CREATE ACCESS METHOD … HANDLER`（PG≥19 用 static const 指定初始化器） |
| opclass support proc 协议 | `hnsw.h:37`（1-3 号）、`ivfflat.h:40`（1-5 号） | `l2_distance`、`vector_spherical_distance` 等 | opclass `FUNCTION n`，`index_getprocinfo` 取回 |
| `HnswTypeInfo` / `IvfflatTypeInfo` | `hnswutils.c:1377` / `ivfutils.c:376` | vector（默认回退）/ halfvec / bit / sparsevec 四例 | 3 号 / 5 号 proc，`RETURNS internal` 传 C 结构指针 |
| `Normalize` / `CheckValue` 回调 | 同上 | cosine 类经 `l2_normalize` | 未注册时回退 vector 默认值（向后兼容） |

---

## 代码目录

```shell
pgvector/
├── src/                  # 全部 C 实现（27 个文件，~14k 行）
│   ├── vector.c/halfvec.c/sparsevec.c   # 三种类型全套（I/O/距离/cast/聚合）
│   ├── halfutils.c/h + bitutils.c       # 半精度转换与 popcount 的 SIMD 内核
│   ├── bitvec.c          # bit 类型的 hamming/jaccard 距离
│   ├── hnsw*.c/h         # HNSW 索引（8 文件 ~5.5k 行，全模块最大）
│   └── ivf*.c/h          # IVFFlat 索引（8 文件 ~4.1k 行）
├── sql/
│   ├── vector.sql        # 全量对象定义（1212 行，114 函数 + 24 opclass + 2 AM）
│   └── vector--X--Y.sql  # 逐版本升级迁移链（0.1.0 → 0.8.7）
├── test/
│   ├── sql/ + expected/  # 14 组 regression 测试（make installcheck）
│   └── t/                # 48 个 TAP 测试（WAL/vacuum/召回率/perl 驱动）
├── vector.control        # 扩展控制文件（default_version / relocatable）
└── Makefile              # PGXS 构建，OPTFLAGS=-march=native
```

---

## 模块地图

单层结构，4 个模块。模块间动态调用顺序见[运行时行为 > 核心运行流程](#核心运行流程)。

![模块依赖关系](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/module-dependencies.svg)

依赖方向可以概括为：SQL 接口层把 C 符号**绑进目录**（`CREATE FUNCTION … LANGUAGE C`），索引层再从目录**取回**（`index_getprocinfo`）——绕一圈目录是刻意的解耦设计，类型层和索引层因此没有任何直接 C 调用。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|---|---|---|---|---|
| 向量类型 | 四种类型的数据模型 + 距离内核 + cast + 聚合 | `vector.c` 的 `vector_in` / `VectorL2SquaredDistance` | 数据模型与索引无关：类型可以先于索引存在，精确搜索不需要任何索引代码 | [01-vector-types](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/01-vector-types) |
| HNSW 索引 | 多层图构建/搜索/插入/图修复 vacuum | `hnsw.c` 的 `hnswhandler` | 图算法自成体系：构建、搜索、删除修复三套独立算法，与其他模块只共享 proc 协议 | [02-hnsw-index](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/02-hnsw-index) |
| IVFFlat 索引 | kmeans 聚类 + 倒排页结构 + probes 扫描 | `ivfflat.c` 的 `ivfflathandler` | 与 HNSW 是两种正交的 ANN 哲学（聚类划分 vs 图导航），页面结构、构建管线、扫描方式完全不同 | [03-ivfflat-index](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/03-ivfflat-index) |
| SQL 接口与注册 | 对象目录定义 + AM 注册 + 版本迁移 | `sql/vector.sql`、`vector.c` 的 `_PG_init` | 唯一与 Postgres 目录机制打交道的层；升级迁移策略也在这层 | [04-sql-am-interface](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/04-sql-am-interface) |

---

## 运行时行为

### 启动流程

扩展没有常驻进程，"启动"即 `CREATE EXTENSION vector` 时的一次性装配：

```
CREATE EXTENSION vector
└─ postgres 加载 $libdir/vector.so
   └─ _PG_init (vector.c:57)          # .so 加载即调用，先于任何 SQL
      ├─ BitvecInit (bitutils.c:208)   # 装 popcount 函数指针（AVX-512 检测）
      ├─ HalfvecInit (halfutils.c:279) # 装 half 距离指针（CPUID 查 F16C/FMA）
      ├─ HnswInit (hnsw.c:52)          # 注册 hnsw.* GUC ×4 + LWLock tranche
      └─ IvfflatInit (ivfflat.c:38)    # 注册 ivfflat.* GUC ×3 + m/lists reloption
└─ 执行 sql/vector--0.8.6.sql          # 1212 行 DDL 进系统目录
   ├─ CREATE TYPE ×3 + 114 个函数 + 运算符 + 24 opclass
   └─ CREATE ACCESS METHOD hnsw/ivfflat TYPE INDEX HANDLER …
```

对象装配的关键点：**构建参数与查询参数分离**。`m`、`ef_construction`（HNSW）和 `lists`（IVFFlat）是 reloption，`add_int_reloption` 注册后固化进每个索引（HNSW 存元页）；`hnsw.ef_search`、`ivfflat.probes` 是 `PGC_USERSET` GUC，逐会话热调召回/延迟权衡。两套参数生命周期不同，这是有意设计：索引物理结构依赖前者不可在线改，查询精度本来就是论文里的查询期参数。

### 核心运行流程

三条主链路：**KNN 查询**（读路径，最热）、**构建**（DDL）、**插入与 vacuum**（写路径与维护）。查询链路如下，构建/插入的细节在模块文档展开。

#### 查询：HNSW 近邻搜索

业务流程：`ORDER BY embedding <-> q LIMIT k` → planner 选中 HNSW 索引 → executor 循环取 k 个堆 TID → 回表。

![HNSW 近邻查询端到端数据流](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/data-flow.svg)

文字描述：planner 在 `hnswcostestimate`（hnsw.c:134）里用 `entryLevel*m + layer0TuplesMax*selectivity` 的自建公式估算页数（genericcostestimate 刻画不了图遍历）；executor 侧 `hnswrescan` 把查询向量 Datum 放进 `orderByData.sk_argument`，`GetScanItems` 从元页入口点逐层 `HnswSearchLayer(ef=1)` 贪心下降，到第 0 层才用 `ef=hnsw_ef_search` 做双堆束搜索。距离计算走 support proc 1（平方版，省 sqrt），数据形态是 `Datum → Vector* → double` 的单向收缩。扫描全程持 `HNSW_SCAN_LOCK` 共享页锁防 vacuum 标删，但读完即放 pin——元素已拷贝进内存，锁只在批次边界起栅栏作用。

#### 构建：CREATE INDEX 的两种形态

HNSW 走两阶段（`hnswbuild.c` 头注释）：全表先进共享内存图（并行时 worker 各插各的 tuple、图只有一张），超 `maintenance_work_mem` 自动 `FlushPages` 降级为磁盘路径——后续 tuple 走与运行期 INSERT 完全相同的 `HnswInsertTupleOnDisk`，最后一次 `log_newpage_range` 记全量 WAL。IVFFlat 走四步流水线（采样 → Elkan kmeans → 全表 assign + 排序 → 逐 list 装页），并行只加速 assign 阶段，聚类中心 memcpy 进 DSM 保证所有 worker 判定一致。两者 `amcanbuildparallel=true`，但分工哲学不同：HNSW 分数据不分图，IVFFlat 分扫描不分中心。

#### 维护：INSERT 即时入图，VACUUM 重搜修边

HNSW 插入无 pending list——每条 INSERT 立即持 `HNSW_UPDATE_LOCK` 共享锁、随机掷层、`HnswFindElementNeighbors` 找邻居、反向更新被选中邻居，全程 GenericXLog。vacuum 是四步：清死 heap TID → `RepairGraph` 对受影响元素**重跑一遍找邻居**整体覆写邻接（而非局部补边）→ 全扫断言无悬挂边 → `MarkDeleted` 标记删除（空间留给插入的 `HnswFreeOffset` 原地复用，文件不收缩）。本基线的 #1010 修复正是 INSERT 与 VACUUM 并发时邻接去重竞态。

### 状态流

pgvector 没有长生命周期状态机，但有一个值得画的全景：**元素的删除态流转**（构建 → 存活 → vacuum 标删 → 空间复用）与**两个"版本"的语义区分**——元页 `version` 是索引格式版本（`HNSW_VERSION 1`，迁移用），元素/邻接 tuple 内的 `uint8 version`（1..15 循环）是运行期图版本，`MarkDeleted` 每次递增，迭代扫描靠它检测"上一批还活着、这一批被换掉"的元素。两者在 `hnswvacuum.c:697` 与 `hnsw.h:41` 各有定义。

---

## 典型修改场景

#### 场景 1：新增一种距离度量（如 chebyshev）

1. `src/vector.c`：加 `VectorChebyshevDistance` 内核（挂 `VECTOR_TARGET_CLONES`）+ `PG_FUNCTION_INFO_V1` 包装；halfvec 版内核进 `halfutils.c` 加 F16c 变体并在 `HalfvecInit` 装指针
2. `sql/vector.sql` + 新迁移脚本：`CREATE FUNCTION` + `CREATE OPERATOR` + **每个** opclass 加 `FUNCTION 1`（工作量最大处，SQL 文件是唯一注册点）
3. hnsw/ivf 的 C 代码**零改动**（只认 proc number）——若新度量不满足三角不等式（HNSW 图搜索正确性要求），须像 `vector_spherical_distance`（vector.c:704）那样先论证或变换
4. 对应测试：`test/sql/` 加同名 regression 文件

#### 场景 2：新增一种向量类型（如 int8 量化）

1. 新 `int8vec.c/h`：照抄 vector.c 全套（in/out/typmod/recv/send/cmp/聚合，600-1300 行）；有专用指令则建 `int8utils.c` 仿 halfutils 的 CPUID 指针分发
2. `sql/vector.sql`：五段模板复制（I/O → 公开函数 → 私有/cast → 运算符 → btree + 两种索引的全套 opclass）+ type-info proc
3. `hnswutils.c` / `ivfutils.c`：加 `*_int8vec_support` 返回该类型的 `TypeInfo`（`maxDimensions` 按 item 大小换算）；IVFFlat 还需 `UpdateCenter`/`SumCenter`（仿 ivfutils.c:370 的 bit/halfvec）
4. `_PG_init` 若需运行时分发则加 `Int8vecInit()`

#### 场景 3：调整索引精度参数

- 运行期：`SET hnsw.ef_search = 100`（GUC 即时生效，只影响第 0 层束宽）；配 `hnsw.iterative_scan` / `hnsw.max_scan_tuples` 控制过滤查询续扫
- 构建期：`CREATE INDEX … WITH (m = 32, ef_construction = 128)`，校验 `ef_construction >= 2*m`、`2 <= m <= 100`（hnsw.c:88 校验，100 是页大小硬上界 `HNSW_MAX_M`）；改构建参数必须重建索引——值固化在元页，运行期全部从元页读
- 对应测试：`test/t/003-*_recall.pl` 等 TAP 召回率测试

---

## 测试体系

```
test/
├── sql/ + expected/   # 14 组 regression：make installcheck 逐类型 × 逐索引组合
└── t/                 # 48 个 TAP（perl）：001-009 IVFFlat、010+ HNSW
                      #   WAL 回放 / vacuum 回收 / 构建与插入召回率 / lists 参数扫描
```

| 代码层 | 测试类型 | 典型文件 |
|---|---|---|
| 类型 I/O 与距离 | regression | `test/sql/vector_type.sql`、`halfvec.sql`、`sparsevec.sql`、`bit.sql` |
| cast / 聚合 | regression | `test/sql/cast.sql`（0.8.7 在此补了大量 cast 测试） |
| 索引行为（WAL/并发/召回） | TAP + perl | `test/t/001_ivfflat_wal.pl`、`010_hnsw_wal.pl`、`003_*_build_recall.pl` |
| 跨索引组合 | regression | `test/sql/hnsw_vector.sql` 等 9 个 × 类型矩阵 |

召回率测试是 ANN 索引独有的层：TAP 用固定随机种子生成数据集，比较索引结果与暴力搜索结果的重合率，任何影响搜索路径的改动都应跑它。改距离内核时优先读 `vector_type.sql`——它逐维度边界值打表，是距离函数最完整的可执行文档。

---

## 阅读源码推荐路线

- **第一遍：跑通查询主链路**
  `src/hnsw.c` 的 `hnswhandler`（看 AM 槽位分配）→ `src/hnswscan.c` 的 `hnswgettuple` → `GetScanItems`（论文 Alg 5 入口）→ `src/hnswutils.c` 的 `HnswSearchLayer`（824 行起，双堆主循环）
- **第二遍：理解数据模型**
  `src/vector.h` 的 `Vector`（8 行看懂 varlena 布局）→ `src/vector.c` 的 `vector_in`（177 行起）与 `CheckDim` → `src/halfutils.h` 的 `HalfToFloat4`（三档实现的取舍）
- **第三遍：理解磁盘结构与并发**
  `src/hnsw.h` 的 `HnswElementTupleData`/`HnswNeighborTupleData`（372 行起）与 `HNSW_UPDATE_LOCK`/`HNSW_SCAN_LOCK` 注释（49 行）→ `src/hnswinsert.c` 的 `HnswInsertTupleOnDisk` → `src/hnswvacuum.c` 的 `RepairGraph`
- **第四遍：另一条 ANN 路线与注册机制**
  `src/ivfkmeans.c` 的 `ElkanKmeans`（247 行起）→ `src/ivfscan.c` 的 `GetScanLists` → `sql/vector.sql` 通读一遍（1212 行，看 opclass 如何把 `<->` 绑到 FUNCTION 1）→ 各模块文档深入（[01](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/01-vector-types) [02](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/02-hnsw-index) [03](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/03-ivfflat-index) [04](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/04-sql-am-interface)）

---

## 附录

### 术语表

| 术语 | 含义 |
|---|---|
| ANN | Approximate Nearest Neighbor，近似最近邻——用召回换速度 |
| HNSW | Hierarchical Navigable Small World，分层可导航小世界图（Malkov & Yashunin 2016） |
| IVFFlat | Inverted File with Flat compression——kmeans 划分 + 分区内精确比较（"Flat" 指不做量化） |
| ef / ef_construction | 搜索束宽 / 构建期束宽（HNSW 论文记号） |
| m | HNSW 每层最大度数（L0 为 2m） |
| lists / probes | IVFFlat 的聚类数 / 查询探测的 list 数 |
| support proc | opclass 里的编号函数槽位，索引内部能力的注册协议 |
| reloption | per-relation 存储参数（如 `WITH (m = 16)`） |
| iterative scan | 0.8.0+ 的续扫机制：过滤后结果不足时自动扩大扫描 |
| GenericXLog | 非事务性索引的 WAL 通用接口 |

### 参考资料

- [HNSW 论文：Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)——`hnswutils.c` 注释逐条对应论文 Algorithm 1/2/4/5
- [Elkan 2003: Using the triangle inequality to accelerate k-means](https://www.aaai.org/Papers/ICML/2003/ICML03-022.pdf)——`ivfkmeans.c` 的剪枝依据
- [PostgreSQL 索引 API 文档](https://www.postgresql.org/docs/current/index-api.html)——`hnsw.c:259` 注释直接引用
- 本系列模块文档：[向量类型](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/01-vector-types) · [HNSW 索引](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/02-hnsw-index) · [IVFFlat 索引](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/03-ivfflat-index) · [SQL 接口与注册](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/04-sql-am-interface)
- 关联阅读：[PostgreSQL 18.6 CodeWiki](/vibe-reading/articles/Database/OLTP/PostgreSQL/CodeWiki/18.6/00-overview)（宿主内核）· [TimescaleDB 2.29.2 CodeWiki](/vibe-reading/articles/Database/TSDB/TimescaleDB/CodeWiki/2.29.2/00-overview)（同为 PG 扩展的另一条路线）· [Faiss 1.15.1 CodeWiki](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)（独立 ANN 库对比）
