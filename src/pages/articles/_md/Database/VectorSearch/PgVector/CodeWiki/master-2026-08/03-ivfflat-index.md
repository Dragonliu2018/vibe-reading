---
source:
  type: "源码解读"
  project: "pgvector"
  url: "https://github.com/pgvector/pgvector"
title: "IVFFlat 索引"
date: "2026-10-02T16:47:23+08:00"
category: [Database, VectorSearch, PgVector, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, PgVector, CodeWiki, "master-2026-08"]
tags: ["PgVector", "C", "kmeans", "PostgreSQL", "倒排索引"]
description: "pgvector IVFFlat 索引模块解读——Elkan 三角不等式加速的球面 kmeans（k-means++ 种子）、两级页结构（metapage→list→entry）、排序后装页的构建流水线与 DSM 并行 assign、probes 配对堆选 list 与精确距离零 recheck 扫描全解"
readingTime: "30 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/PgVector/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

IVFFlat 是 pgvector 的另一个 ANN 索引，代表与 HNSW 正交的哲学：**聚类划分 + 分区内精确比较**。"Flat"的含义就在于此——索引里存的是原始向量，扫描时距离精算，`xs_recheck = false`（ivfscan.c:411），近似的只是"哪些分区被探测"（probes 个 list 之外的近邻被漏掉）。它的工程定位：构建快、内存省、但需要表里有数据才能建（kmeans 要训练）；查询侧召回靠 `ivfflat.probes` 与 `lists` 的比值调节。本模块 8 个文件 ~4.1k 行，其中 `ivfkmeans.c` 是整个仓库算法密度最高的文件。

与 HNSW 的本质差异在 I/O 模式：HNSW 是随机图遍历，IVFFlat 是**顺序扫页**（`BAS_BULKREAD` ring buffer）——`ivfflatcostestimate`（ivfflat.c:86）甚至因此把 50% 页成本按顺序页折算（`sequentialRatio = 0.5`）。

## 模块架构

![IVFFlat 两级页结构：metapage → list → entry](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/ivfflat-structure.svg)

内部结构是严格的两级树：blkno 0 元页存 `magic 0x14FF1A7 / dimensions / lists`；blkno 1 起是 list 页链，每条 item 是一个 `IvfflatListData {startPage, insertPage, center}`——**聚类中心就存在 list 元数据里**，查询选 list、插入找 list 都靠它；再往下每个 list 挂一条 entry 页链（普通 index tuple：向量 + heaptid）。`startPage` 是扫描起点，`insertPage` 是追加"热尾"——vacuum 会把 insertPage 回拨到第一个有空间的旧页复用空间，`IvfflatUpdateList` 里的 `insertPage >= originalInsertPage` 防回退检查（ivfutils.c:254，注释 "prevent insert from overwriting vacuum"）防止插入者用旧值覆盖 vacuum 的回拨。页 ID `0xFF84` + 元页 magic 双重校验防误读。

## 调用链路

![IVFFlat 构建四步流水线（BuildIndex）](/vibe-reading/images/articles/pgvector-codewiki-master-2026-08/ivfflat-build-flow.svg)

构建是四步流水线（`BuildIndex` ivfbuild.c:1041，进度上报 `PROGRESS_IVFFLAT_PHASE_KMEANS/ASSIGN/LOAD`）。思想是**"排序后写页"**：全表扫一遍把每行分到最近中心，生成 (list, tid, vector) 虚拟 tuple 喂给 tuplesort 按 list 列排序——排序让同一 list 的 tuple 在输出流里连续，`InsertTuples` 因此对每个 list 只需持一页缓冲顺序填页，页内物理局部性直接决定查询时的顺序扫描速度。采样与 kmeans 只在 leader 单进程做（构建耗时大头），可并行的只有全表 assign 阶段——所有 worker 用 memcpy 进 DSM 的**同一份聚类中心**，保证同一向量无论谁扫到都归入同一 list（ivfbuild.c:920，并行正确性的关键）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `ivfflathandler` (ivfflat.c:184) | 返回 IndexAmRoutine | `amsupport=5`（比 HNSW 多 kmeans 两个 proc） |
| `ivfflatbuild` → `BuildIndex` (ivfbuild.c:1064) | 构建入口 | 四步流水线；DSM 不可用自动退化串行 |
| `InitBuildState` (ivfbuild.c:337) | 构建态装配 | 校验维度（varbit 不支持）、取 5 个 support proc |
| `SampleRows` (ivfbuild.c:133) | 采样 | ANALYZE 同款 BlockSampler + 水库采样，统计无偏 |
| `ComputeCenters` (ivfbuild.c:435) | 采样数 = lists×50 | 下限 10000，上限 blocks×MaxHeapTuplesPerPage |
| `IvfflatKmeans` (ivfkmeans.c:554) | 聚类入口 | 样本 0 走 RandomCenters（空表建索引） |
| `ElkanKmeans` (ivfkmeans.c:247) | Elkan 主循环 | 上下界剪枝，500 轮上限，changes==0 提前收敛 |
| `AssignTuples` (ivfbuild.c:972) | 全表分配 | 每行线性扫 centers 找最近（构建期 O(n·k·dim)） |
| `IvfflatParallelScanAndSort` (ivfbuild.c:656) | worker 主循环 | 并行堆扫 + Sharedsort 局部排序 |
| `InsertTuples` (ivfbuild.c:272) | 装页 | 排序后逐 list 开链填页 → `IvfflatUpdateList` |
| `GetScanLists` (ivfscan.c:48) | 选 list | maxProbes 大小的 pairingheap 在线选 top-N |
| `GetScanItems` (ivfscan.c:124) | 批量扫 list | 一次处理 probes 个最近 list，tuplesort 全局有序 |
| `ivfflatinsert` → `InsertTuple` (ivfinsert.c:73) | 运行期插入 | 即时生效，无 pending list |
| `FindInsertPage` (ivfinsert.c:20) | 找最近 list 热尾 | 空索引兜底选第一个 list |
| `ivfflatcostestimate` (ivfflat.c:86) | 代价估计 | `ratio = probes/lists` 按比例估启动成本 |
| `VectorArrayGet/Set` (ivfflat.h:322) | 数组访问器 | inline 函数而非宏——避免宏双重求值 |

</details>

## 核心实现

### Elkan kmeans：三角不等式剪枝与球面聚类

`ivfkmeans.c` 是注释引用论文最密集的文件。种子选择用 **k-means++**（`InitCenters` ivfkmeans.c:24，注释直引 Arthur & Vassilvitskii）：首个中心均匀随机，后续按 D² 加权概率抽样；副产物是每个样本到各中心的距离顺手写入 `lowerBound` 矩阵供初始分配复用。主循环 `ElkanKmeans`（ivfkmeans.c:247，引 Elkan ICML'03）用三条三角不等式界剪枝：算所有中心两两距离的一半（O(k²)）与每中心的 `s(c) = min d(c,c')/2`，跳过 `u(x) ≤ s(c(x))` 的点，剩余 (x,c) 对只有 `dxcx > lowerBound` 且 `dxcx > halfcdist` 才真正算距离——把 O(n·k·iter) 的距离计算剪到远低于此。

**双 proc 设计**是这个算法正确性的关键，也最容易被忽略：kmeans 用的距离必须满足三角不等式（Elkan 的前提），为此 opclass 单独注册 `IVFFLAT_KMEANS_DISTANCE_PROC`（proc 3）和 `IVFFLAT_KMEANS_NORM_PROC`（proc 4）：

- L2 opclass 的 kmeans 用**开根号的 L2**（不是平方 L2——平方不满足三角不等式，ivfkmeans.c:240 注释明说）；而查询路径的 proc 1 继续用 L2² 省开方，保序即可
- inner product / cosine opclass 走**球面 kmeans**（ivfkmeans.c:551 注释 "We use spherical k-means for inner product and cosine"）：内积/余弦空间不是度量空间，质心迭代在球面收敛——每轮质心先 `l2_normalize`，kmeans 距离用 `vector_spherical_distance` 角距离
- `CheckCenters`（ivfkmeans.c:540）做 NaN/Inf 与零范数终检，`IvfflatCheckMemoryUsage` 对照 `maintenance_work_mem` 报错（`lowerBound` 矩阵用 `MCXT_ALLOC_HUGE` 分配）

### 构建管线：采样、并行 assign、排序装页

采样数 `lists × 50`（下限 10000，ivfbuild.c:450）——注释直言 "The number of samples has a large effect on index build time"。`SampleRows` 复用 ANALYZE 的 `BlockSampler_Init/Next` + `reservoir_get_next_S`，先选块再块内水库采样，统计无偏且不用全表物化。两个边界情形：样本数少于 lists 时发 `NOTICE "ivfflat index created with little data"` 提醒低召回（ivfbuild.c:469）；样本数为 0（空表）走 `RandomCenters`（ivfkmeans.c:111）随机填满并归一化。

并行构建（`amcanbuildparallel=true`）的分工边界值得记住：**kmeans 不并行**（leader 做完把 centers memcpy 进 DSM），可并行的只有 assign 的全表扫描 + 局部排序。快照随构建模式切换：非 concurrent 构建直接用 `SnapshotAny`（持 AccessExclusiveLock 无人可见中间态），`CREATE INDEX CONCURRENTLY` 则 `RegisterSnapshot(GetTransactionSnapshot())`（ivfbuild.c:858-860）。worker 入口 `IvfflatParallelBuildMain`（ivfbuild.c:720）：并行堆扫（`table_beginscan_parallel`）+ `SortCoordinate`/`Sharedsort` 做自己那份排序，结束加 mutex 累计进度并 `ConditionVariableSignal` 唤醒在 `ParallelHeapScan`（ivfbuild.c:621）上睡眠的 leader。leader 也参与扫描（`IvfflatLeaderParticipateAsWorker`，编译期 `DISABLE_LEADER_PARTICIPATION` 可关）。排序的跨进程合并不需要 leader 干预——tuplesort 的 coordinate 机制直接给出全局有序流，leader 拿到后走同一个 `InsertTuples`。DSM 不可用或零 worker 启动时优雅退化串行（ivfbuild.c:885）。

unlogged 表走 `ivfflatbuildempty`（ivfbuild.c:1086）→ INIT_FORKNUM，heap 为空时 `RandomCenters`（ivfkmeans.c:111）随机向量填满并归一化。

### 扫描：probes 配对堆与迭代续扫

`ivfflatbeginscan`（ivfscan.c:253）读元页拿 lists，`probes = ivfflat_probes`（GUC），迭代扫描开启时 `maxProbes = Max(ivfflat_max_probes, probes)`，统一 clamp 到 lists。真正的选 list 发生在 `ivfflatgettuple` 首次调用的 `GetScanLists`（ivfscan.c:48）：遍历整条 list 页链算查询向量到每个 center 的距离，**maxProbes 大小的 pairingheap 在线选 top-N**——堆满后 `maxDistance` 是当前第 probes 近的距离，只有更近的才换堆顶，最后按距离近→远弹出写入 `so->listPages`。

`GetScanItems`（ivfscan.c:124）按批扫：`while (listIndex < maxProbes && ++batchProbes <= probes)`——一次批量处理 probes 个最近 list，每 list 沿 entry 页链顺序扫，所有 tuple 算距离后 (distance, heaptid) 进 tuplesort，批末全局有序输出。排序耗尽且未到 maxProbes 时再拉一批——这就是 `ivfflat.iterative_scan` 的 relaxed 模式（渐进搜索，每批结果不再保证全局有序）；未开启时一批结束即扫描结束。距离函数故意绕过 ScanKey 直接持 `FunctionCall2Coll`（ivfscan.c:73 注释 "for performance"），`SK_ISNULL` 时换成恒 0 的 `ZeroDistance`。还有一个容易忽略的正确性细节：排序期间不能 pin buffer，所以**强制 MVCC 快照**（ivfscan.c:390 注释引 PG index-locking 文档）——靠快照而非 pin 保证堆元组可见性。

### 插入：即时生效与 vacuum 竞态

`InsertTuple`（ivfinsert.c:73）：detoast → 有 NORM_PROC 则归一化（**零范数向量静默跳过**，ivfinsert.c:96，不报错不索引）→ 校验元页 magic → `FindInsertPage` **线性遍历全 list 页链**逐 center 算距离找最近 list（lists 很大时这是每次插入的 O(lists·dim) 开销，注释里没有缓存优化——改造点明确）→ 从 insertPage 起找有空间的页，页链尾 `LockRelationForExtension` + `IvfflatNewBuffer` 扩页接链，全程 GenericXLog。与 HNSW 不同，IVFFlat **没有 pending list/延迟插入**——每条插入即时生效（图插入需要全局锁才值得延迟，扁平链表不需要）。

vacuum（ivfvacuum.c）删死元组后把 insertPage 回拨到第一个有空间的旧页（ivfvacuum.c:107），与插入者的竞争由 `IvfflatUpdateList` 的防回退检查（ivfutils.c:254）封口。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 类型虚表 | `IvfflatTypeInfo`（ivfflat.h:188）+ proc 5 | kmeans 的浮点累加器与存储类型解耦，中心统一在 float32 精度算 |
| 双 proc 度量分离 | proc 1（查询）vs proc 3/4（kmeans） | 查询要保序省 sqrt，kmeans 要真度量（三角不等式），语义不同分槽注册 |
| 排序换局部性 | `AssignTuples` + `InsertTuples` | 一次排序把随机插入变成顺序装页 |
| 共享排序 | `Sharedsort` + `SortCoordinate`（ivfbuild.c:656） | 各 worker 局部排序、全局合并零拷贝汇流 |
| 在线 top-N | pairingheap（ivfscan.c:48） | O(n·log probes) 选 list，不物化全量距离 |

## 模块间交互

依赖类型层经 5 个 support proc（比 HNSW 多出 kmeans 距离/norm 两个）：距离（proc 1）在扫描/插入期用；`VectorUpdateCenter`/`HalfvecSumCenter`（ivfutils.c:322/360）直接调用 halfutils 的转换函数累加质心；`IvfflatTypeInfo` 的 `updateCenter` 把浮点均值二值化（bit 类型 `x[i] > 0.5`，ivfutils.c:338）。与 HNSW 模块完全平行——同样的 AM 契约、两套正交实现。`_PG_init` 经 `IvfflatInit`（ivfflat.c:38）注册 `ivfflat.probes`/`iterative_scan`/`max_probes` 三个 GUC 和 `lists` reloption。

## 扩展方式

- **新增类型支持**（四件事）：(a) 新类型的 SQL opclass 注册 5 个 support proc；(b) ivfutils.c 仿 `ivfflat_halfvec_support` 写一份 `IvfflatTypeInfo`（itemSize/updateCenter/sumCenter/normalize）；(c) kmeans 距离/归一化 proc 必须满足三角不等式（Elkan 前提，ivfkmeans.c:239）；(d) `InitBuildState`（ivfbuild.c:349）按 varbit 的先例处理不支持的情形
- **替换聚类算法**：只动 `ElkanKmeans` 单点，对外契约就是 `samples → centers`；`IVFFLAT_KMEANS_DEBUG` 编译开关输出 inertia 与 Davies-Bouldin 指标（ivfbuild.c:558）供评估
- **调采样策略**：`ComputeCenters`（ivfbuild.c:450）的 `lists × 50` / 下限 10000 两个常数；文件内已有 TODO 提示 k-means++ 阶段还能用三角不等式再剪（ivfkmeans.c:58）
- **调查询召回**：`SET ivfflat.probes = 10`（GUC，1..lists）；`ivfflat.iterative_scan = relaxed_order` + `ivfflat.max_probes` 支持先答快后补全
