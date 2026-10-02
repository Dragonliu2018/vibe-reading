---
source:
  type: "源码解读"
  project: "pgvector"
  url: "https://github.com/pgvector/pgvector"
title: "HNSW 索引"
date: "2026-10-02T16:47:23+08:00"
category: [Database, VectorSearch, PgVector, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, PgVector, CodeWiki, "master-2026-08"]
tags: ["PgVector", "C", "HNSW", "PostgreSQL", "近似最近邻"]
description: "pgvector HNSW 索引模块解读——图结构物化为索引页（element/neighbor 双 tuple）、两阶段构建与共享内存并行图、HnswSearchLayer 双堆束搜索（论文 Alg 2）、四级空间复用插入、vacuum 重搜修边与两把页面锁协议全解"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

HNSW 是 pgvector 两个 ANN 索引中查询性能更好的那个（速度-召回权衡优于 IVFFlat，代价是构建慢、内存大，且无需训练阶段即可空表建索引）。本模块共 8 个文件 ~5.5k 行，是仓库最大的模块。它要解决的核心难题是：**把一个内存图算法（Malkov & Yashunin 2016）完整地搬到 Postgres 的页式存储里，且不牺牲并发性**——图搜索是随机指针跳转，而 Postgres 索引页是顺序字节，pgvector 用"元素 tuple + 邻接 tuple"双元组设计完成翻译，`hnswutils.c` 的注释逐条对应论文的 Algorithm 1/2/4/5。

## 模块架构

![HNSW 磁盘结构与构建形态](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/hnsw-structure.svg)

内部结构围绕"一图两态三组锁"组织。**一图**：逻辑上是多层跳表式图（`HnswInitElement` 按 `level = -log(u)·ml`、`ml = 1/log(m)` 随机掷层，L0 度数 2m、其余层 m），物理上是 blkno 0 元页 + 元素页链。**两态**：构建期 `HnswElement` 是内存对象（通过 `HnswPtrDeclare` 双态指针支持串行私有内存/并行共享内存两种形态，hnsw.h:171），物化后变成页面上的 `HnswElementTupleData`（type 1）+ `HnswNeighborTupleData`（type 2）两种元组，元素 tuple 携带 `neighbortid` 反指向自己的邻接 tuple，两者**尽量同页**存放（hnswbuild.c:204）减少搜索时的读页次数。**三组锁**：两把页面锁（页 0 `HNSW_UPDATE_LOCK` 管写者与 vacuum、页 1 `HNSW_SCAN_LOCK` 管扫描与 vacuum——"页面锁即锁"，hnsw.h:49 注释强调锁编号必须等于页号）+ 内存图并行构建的 `entryLock`/`entryWaitLock`/per-element LWLock。

## 调用链路

![HnswSearchLayer 搜索流程（hnswutils.c 论文 Alg 2）](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/hnsw-search-flow.svg)

`GetScanItems`（hnswscan.c:25，论文 Alg 5）先从元页拿入口点，高层每层 `HnswSearchLayer(ef=1)` 贪心下降——ef=1 即纯贪心路由；只有第 0 层用 `ef=hnsw_ef_search` 做真正的束搜索。`HnswSearchLayer`（hnswutils.c:824）的主循环弹出 candidate 堆 C（小根）最近候选 c，若 c 已比 result 堆 W（大根）的堆顶 f 还远则整层收敛——这是束搜索的标准终止条件。每个未访问邻居经 `HnswLoadElementImpl` 算距离，其中藏着一个关键短路：**比当前 W 堆顶还远的元素连内存都不加载**（maxDistance 检查，hnswutils.c:534）——磁盘态下每次加载邻居都是一次 `ReadBuffer`，这个剪枝是查询性能的命脉。达标者同时入 C/W 双堆（一个 `HnswSearchCandidate` 挂两个 pairing heap 节点），W 超 ef 弹出的最差者在 iterative scan 开启时转入 discarded 堆而非丢弃——`w` 耗尽后 `ResumeScanItems`（hnswscan.c:61）从 discarded 取下一批入口点续搜，这就是 0.8.0 迭代扫描在 HNSW 上的实现。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `hnswhandler` (hnsw.c:266) | 返回 IndexAmRoutine | PG≥19 static const；`amcanorderbyop`/`amoptionalkey`/`amcanbuildparallel` 全开 |
| `hnswcostestimate` (hnsw.c:134) | 代价估计 | 自建公式 `entryLevel*m + layer0TuplesMax*selectivity`；无排序键返回无穷大 |
| `hnswbuild` → `BuildIndex` (hnswbuild.c:1088) | 构建入口 | 两阶段；`maintenance_work_mem` 耗尽自动 FlushPages |
| `InsertTuple` (hnswbuild.c:486) | 内存图插入 | 持 `flushLock` 共享锁防与 flush 竞争 |
| `FlushPages` (hnswbuild.c:303) | 内存图物化 | 两轮写页（邻居磁盘位置未定时先占位） |
| `HnswInsertTupleOnDisk` (hnswinsert.c:695) | 磁盘插入（运行期/构建共用） | `building=true` 跳过单条 WAL，构建尾段一次性 `log_newpage_range` |
| `HnswFindElementNeighbors` (hnswutils.c:1281) | 插入找邻居（Alg 1） | 高层 ef=1 下降，目标层 ef=efConstruction |
| `SelectNeighbors` (hnswutils.c:1064) | 邻居启发式筛选（Alg 4） | 优先"比所有已选邻居都近"的点，保图连通性 |
| `HnswSearchLayer` (hnswutils.c:824) | 单层束搜索（Alg 2） | 双堆 + visited 三形态哈希（TID/relptr/指针） |
| `hnswgettuple` (hnswscan.c:189) | 逐个吐结果 | 从降序链表尾取最近者；`xs_recheck=false` |
| `hnswbulkdelete` (hnswvacuum.c:777) | vacuum 入口 | 四步：清 TID → 修图 → 断言 → 标删 |
| `RepairGraphElement` (hnswvacuum.c:225) | 重搜修边 | 对受影响元素重跑 `HnswFindElementNeighbors` 整体覆写 |
| `HnswFreeOffset` (hnswinsert.c:44) | 空间复用 | 原地覆写已删除 tuple，继承其 version |
| `AddDuplicateOnDisk` (hnswinsert.c:585) | 相同向量合并 | 只追加 heaptid（最多 10 个），不建新节点 |

</details>

## 核心实现

### 磁盘图：双 tuple 设计与版本号

```c title="src/hnsw.h — 元页"
typedef struct HnswMetaPageData
{
	uint32		magicNumber;      /* 0xA953A953 */
	uint32		version;          /* 索引格式版本（HNSW_VERSION 1），非图版本 */
	uint32		dimensions;
	uint16		m;                 /* 构建参数固化，运行期全靠元页 */
	uint16		efConstruction;
	BlockNumber entryBlkno;      /* 入口点三元组 */
	OffsetNumber entryOffno;
	int16		entryLevel;
	BlockNumber insertPage;      /* 插入位置提示，支持空间复用 */
}			HnswMetaPageData;
```

元素 tuple（type 1）携带 `level/deleted/version/heaptids[10]/neighbortid/Vector data 内嵌`；邻接 tuple（type 2）是 `version + count + indextids[]` 定长数组，容量 `(level+2)*m`。两个"version"语义不同，极易混淆：元页的 `version` 是**索引格式版本**（升级迁移用），tuple 内 `uint8 version`（1..15 循环）是**运行期图版本**——`MarkDeleted` 每次删除递增，超过 15 回绕为 1（hnswvacuum.c:697-700），`HnswLoadNeighborTids`（hnswutils.c:761）在两次迭代之间发现 `ntup->version != element->version` 就放弃这批邻居，调用方以"邻居为空"降级继续而不崩溃。`heaptids[10]`（`HNSW_HEAPTIDS`，hnsw.h:69 注释 "Make graph robust against non-HOT updates"）吸收非 HOT 更新产生的新 TID——一个图节点最多挂 10 个堆 TID，避免重复建点。

m 上限 100（`HNSW_MAX_M`）不是拍脑袋：约束链是 `HnswGetMaxLevel(m)`（hnsw.h:133）必须保证最高层元素的邻接 tuple `6*(level+2)*m` 字节单页可容纳，8KB 页下 m=100 保证层数上界 ≥11。

### 两阶段构建与并行图

`hnswbuild.c` 头注释把构建讲得很直白：**in-memory 阶段**全图进内存，`BuildGraph` 逐 tuple `InsertTuple`，`memoryUsed >= memoryTotal` 时发 NOTICE 并 `FlushPages`；**on-disk 阶段**后续 tuple 走 `HnswInsertTupleOnDisk(building=true)`——与运行期 INSERT 完全相同的代码路径，唯一差别是不记单条 WAL，最后 `log_newpage_range` 一次全量 WAL。

并行构建（`amcanbuildparallel=true`）是**分数据不分图**：`HnswBeginParallel`（hnswbuild.c:925）分配 DSM，`HnswShared`（含 `ConditionVariable workersdonecv`）+ `maintenance_work_mem` 大小的 `hnswarea` 共享图区；所有 worker（含 leader 自己，`HnswLeaderParticipateAsWorker`）通过 `table_beginscan_parallel` 抢同一个堆扫描，各自把分到的 tuple 插入**同一张**共享图。共享图里不能用绝对指针（各进程 DSM 映射地址不同），`HnswPtrDeclare` 让 `base == NULL` 时当普通指针、`base != NULL` 时当 relptr 相对偏移——这是整个并行构建的基石。并发由 per-element `LWLock lock` 保护邻居数组（读时拷贝到局部再操作，最小化临界区）+ `entryLock`/`entryWaitLock` 序列化入口点变更（等待锁的先到先得避免死锁，hnswbuild.c:449 注释）。`HnswSharedMemoryAlloc` 是单次 >1MB 报错的 bump 分配器——O(1) 且无需回收，整块一次性释放。

### 插入：四级空间复用与锁升级

运行期插入链：`hnswinsert`（独立 memory context）→ `HnswInsertTupleOnDisk`：持 `HNSW_UPDATE_LOCK` **共享**页锁（让 vacuum 能等在途插入、且不干扰读）→ 读元页 → `HnswInitElement` 掷层 → 若新元素层级可能超过入口点（`element->level > entryPoint->level`），**释放共享锁、升级 ExclusiveLock、重读最新入口点**再继续（hnswinsert.c:720）——与内存路径的 `entryWaitLock` 串行化完全同构。找邻居后 `UpdateGraphOnDisk`：先 `FindDuplicateOnDisk` 去重（相同向量只追加 heaptid），再落盘 + `HnswUpdateNeighborsOnDisk` 反向更新被选中的邻居。

`AddElementOnDisk`（hnswinsert.c:144）的四级放位策略：① 当前页放得下元素+邻接双 tuple（最快路径）；② `HnswFreeOffset` **原地复用已删除元素的空间**（`PageIndexTupleOverwrite`，并继承被删 tuple 的 version 防迭代扫描读到陈旧数据，hnswinsert.c:224）；③ 大 tuple 跨页：元素放尾页、邻接放新页；④ 追加新页（`LockRelationForExtension` 序列化扩页）。vacuum 的删除空间不归还页面分配器，全部留给这个复用路径——索引文件只增不缩，是换并发简单性的有意取舍。

并发语义是"尽力而为"而非严格：`UpdateNeighborOnDisk`（hnswinsert.c:474）拿排他锁后重查 `ConnectionExists`（可能已被并发插入写入同一条边），代码里留着 `TODO Retry updating connections if not`（hnswinsert.c:509）；`AddDuplicateOnDisk` 竞争失败就放弃去重走正常插入（hnswinsert.c:617）。本基线的 #1010 修复（"Fix duplicate neighbors race between HNSW INSERT and VACUUM"）正是这条路径上竞态的收口。

### Vacuum：重搜修边，不是补丁

`hnswbulkdelete` 四步是本模块最精彩的工程设计：

1. **RemoveHeapTids**（hnswvacuum.c:36）：全链页扫描，vacuum callback 清死 heaptid；heaptids 清空的元素进 `deleting` tidhash。同时记录 `highestPoint`/`fallbackPoint`（最高/次高层级的存活元素，供入口点替换）。**此步不动图边**。
2. **RepairGraph**（hnswvacuum.c:378）：先 `LockPage(UPDATE_LOCK, ExclusiveLock)` 后立即释放——**栅栏语义**："此点之前的插入可能带将删邻居，之后的插入不会"（原文注释）。然后对每个 `NeedsUpdated`（邻居含 deleting 成员，或 L0 未满即"槽位被清"）的元素跑 `RepairGraphElement`：**重新执行一遍 `HnswFindElementNeighbors`，整体覆写其邻接 tuple**。选重搜而非补边的理由：重建后邻接质量等同新插入（复用一条代码路径），局部补边难以保证图连通性。
3. **ConfirmRepaired**（hnswvacuum.c:507）：全扫断言无存活元素指向 deleting 成员，否则 `elog(ERROR, "hnsw graph not repaired")`。
4. **MarkDeleted**（hnswvacuum.c:594）：先 UPDATE_LOCK 排他屏障（等在途插入），再 SCAN_LOCK 排他屏障（等在途**扫描**——扫描不持 buffer pin，靠此锁保证读到的已加载元素不被标删），逐元素 `LockBufferForCleanup` 标 `deleted=1`、向量区清零、邻接全 invalid、version 递增。空间留给 `HnswFreeOffset`。

### 扫描与迭代续扫

`hnswgettuple` 从 `so->w`（距离**降序**链表）尾部取最近者，一个元素可连吐多个 heaptid；`xs_recheck = xs_recheckorderby = false`（hnswscan.c:324）——**返回的距离是精确算出的，近似的只是"漏掉哪些候选"**，这与 lossy 索引的 recheck 语义有本质区别。`so->first` 时整个 `GetScanItems` 包在 `HNSW_SCAN_LOCK` 共享锁里。iterative scan 的 strict 模式用 `so->previousDistance` 强制跨批次距离单调不减（hnswscan.c:313），relaxed 允许乱序换吞吐。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 双态指针（fat pointer） | `HnswPtrDeclare`（hnsw.h:171） | 同一套容器代码跑串行私有内存和并行共享内存两种形态 |
| 双堆束搜索 | `HnswSearchLayer`（hnswutils.c:824） | ef 宽度可控的 candidate/result 分离，论文 Alg 2 原味 |
| 页面锁当读写屏障 | `HNSW_UPDATE_LOCK`/`HNSW_SCAN_LOCK`（hnsw.h:49） | 比 buffer pin 便宜且能跨调用持锁，vacuum 的栅栏全靠它 |
| 共享段内 bump 分配 | `HnswSharedMemoryAlloc`（hnswbuild.c:660） | 并行构建无需 free，分配 O(1) |
| 建造者两轮写 | `FlushPages`（hnswbuild.c:303） | 邻居位置未定时先占位再回填，解决循环引用的物化次序 |

## 模块间交互

依赖：经 `HnswInitSupport`（hnswutils.c:155）从 opclass 取距离/norm/TypeInfo 三个 proc——与类型层零直接耦合；`HnswElementTupleData` 内嵌 `Vector` 布局（hnsw.h:381）是唯一的结构复用。被依赖：`hnsw.c` 的 handler 与 `hnswcostestimate` 是 executor/planner 的回调入口。与 IVFFlat 模块**完全平行无交集**——两者只在 `HnswTypeInfo` 协议上共享抽象。`_PG_init`（vector.c:59）经 `HnswInit`（hnsw.c:52）注册 4 个 GUC（`hnsw.ef_search`/`iterative_scan`/`max_scan_tuples`/`scan_mem_multiplier`）与 LWLock tranche（PG19 起用带名字的 `LWLockNewTrancheId("HnswBuild")`）。

## 扩展方式

- **新增类型支持**（三件套）：(a) 实现 `HnswTypeInfo` 并注册为 support proc 3（现有四例：vector 内建默认 + `hnsw_halfvec_support`/`hnsw_bit_support`/`hnsw_sparsevec_support`，hnswutils.c:1396）；(b) 距离函数注册 proc 1；(c) cosine 类还需 norm proc 2（零范数向量直接跳过不索引，`HnswCheckNorm` hnswutils.c:175）。`hnswvalidate` 恒 true，无需改 AM
- **调搜索精度**：`SET hnsw.ef_search`（GUC 即时生效）；构建期 `WITH (m=, ef_construction=)` 需重建——值固化在元页，运行期全部从元页读
- **调搜索行为**：`hnsw.iterative_scan = strict_order|relaxed_order` + `hnsw.max_scan_tuples` + work_mem×`hnsw.scan_mem_multiplier` 控制续扫深度与内存
