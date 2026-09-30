---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "向量索引体系"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "vsag", "HNSW", "IVF", "向量索引"]
description: "vsag 插件化索引：6 张隐藏表 + 三份内存 MemData 的 adaptor、per-LS 调度器的异步任务、写路径同步插 inc 索引/落盘置 null、ObDASHNSWScanIter 九子迭代器融合查询"
readingTime: "40 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

向量索引是 seekdb 相对「普通二级索引」的根本分野：普通索引是持久化 B-tree，而向量索引的内存 vsag 实例是**可重建的缓存**——数据真身在隐藏辅助表（delta buffer 行 + snapshot blob），内存图结构（HNSW 邻接/IVF 质心）只是加速层。因此它需要普通索引没有的一整套基础设施：SCN 一致性检查、Paxos 日志集成（follower 内存重建）、全局内存管控、leader 切换钩子、断点续跑的后台任务——这些决定了它必须以「服务 + 调度器 + 任务」形态存在（`src/observer/vector_index/`，~2.65 万行），而不是挂在 tablet table store 里的另一种 SSTable。本模块覆盖四个代码区域：服务与任务（`observer/vector_index/`）、vsag 隔离层（`oblib/lib/vector/`）、查询融合（`sql/das/iter/`）、写入钩子（`storage/ls/ob_ls_tablet_service.cpp`）。

## 模块架构

一个向量索引的完整物理构成（DDL 生成，`resolver/ddl/ob_vec_index_builder_util.h:49-66` 的命名后缀即清单）：

```
数据表 t (embedding VECTOR(N))
 └─ VECTOR INDEX（6 张隐藏辅助表，INDEX_TYPE_VEC_*，share/schema/ob_schema_struct.h:330-350）
    ├─ rowkey_vid / vid_rowkey      # rowkey↔vid 双向映射
    ├─ delta_buffer                 # 增量行 <vid, type, extra_info>（vector 列置 null！）
    ├─ index_id                     # 索引参数与状态
    ├─ snapshot                     # vsag 索引 fserialize 的二进制 blob（持久层真身）
    └─ embedded（hybrid 语义索引）  # 文本列自动 embedding 的向量
内存侧（一个 ObPluginVectorIndexAdaptor，query/api/query/vector/ob_vector_index_adaptor.h）：
    incr_data_   → vsag inc 索引句柄 + roaring 位图 + SCN + vid 边界   # 增量层
    snap_data_   → vsag snapshot 索引句柄（重启后从 snapshot 表 fdeserialize 回来）
    vbitmap_data_ → insert/delete roaring64 位图
```

三个类的分工：**`ObPluginVectorIndexService`**（tenant 级单例，"Manage all vector index adapters of a tenant"）多重继承暴露三面——`query::ObIVectorIndexService`（查询面）、`storage::ObIVectorIndexRuntime`（DML 写入面：`acquire_adapter_guard` 等）、三个 logservice handler（挂进 Paxos 复制/检查点框架，leader 切换自动 `activate()/deactivate()`）；**`ObPluginVectorIndexMgr`**（"Manage all vector index adapter in a ls"）以 tablet_id 为 key 的两级 hash map 管理 adaptor——`complete_index_adpt_map_`（full info 完整 adaptor）+ `partial_index_adpt_map_`（只知道部分 tablet 时的被动创建），**adaptor 可先按部分组件创建（`ObAdapterCreateType{CreateTypeInc/BitMap/Snap/FullPartial/Complete/Embedded}`），凑齐后 `replace_with_complete_adapter` 原子替换**；**`ObPluginVectorIndexLoadScheduler`**（per-LS，"schedule vector tasks for a ls"）继承 `data_plane::ObIVectorIndexScheduler + ObTimerTask + 三个 logservice handler`，1s 基础周期轮转四类任务（`ADAPTER_MAINTENANCE/FOLLOWER_SYNC/HNSW_OPTIMIZE/IVF_TASK`，各 10s 节流），内置三个任务 executor（async/ivf/embedding）。

## 调用链路

三条链路贯穿索引的一生：

```
【查询】ObDASHNSWScanIter::do_table_scan (das/iter/ob_das_hnsw_scan_iter.cpp:56)
├─ init_rel_map(ObPluginVectorIndexAdaptor*) → 绑定内存 adaptor
├─ process_adaptor_state() → 检查 inc/snap MemData 的 SCN 新鲜度
│    （PVQ_REFRESH/PVQ_LACK_SCN → 触发 refresh 或等待，adaptor.h:115）
├─ vsag knn_search（incr 索引 + snap 索引各一次）+ delta_buf_iter_ 扫磁盘增量兜底
├─ init_sort()（refine_k 重排）→ vid_rowkey_iter_ 把 vid 翻译回 rowkey
└─ 按 DAS 迭代器协议吐行

【写入】ObLSTabletService::insert_vector_index_rows (storage/ls/ob_ls_tablet_service.cpp:3385)
   # 在 insert_tablet_rows 之前、经 insert_rows_to_tablet 统一拦截，按表类型分派三类分支：
├─ is_vector_delta_buffer() → acquire_adapter_guard(INDEX_TYPE_VEC_DELTA_BUFFER_LOCAL)
│    ├─ adaptor->insert_rows(rows, vid_idx, type_idx, vector_idx, ...)   # 同步插内存 inc 索引（读己之写）
│    ├─ rows[k].storage_datums_[vector_idx].set_null()   # 磁盘 delta buffer 行不落向量本体
│    └─ adaptor->update_can_skip(NOT_SKIP)               # 令查询侧跳过优化的标记复位
├─ is_hybrid_vector_index_log() → 仅 ObDmlFlag::DF_DELETE 时调 handle_insert_incr_table_rows
│    （把删除事件灌进 adapter 增量数据；INSERT/UPDATE 不走此路——删除与写入在增量层的维护不对称）
├─ is_vector_index_id() → 同步模式下 update_index_id_dml_scn(snapshot.version_) 并置 can_skip；
│    异步索引（is_vector_index_sync_mode_async）则跳过——增量维护整体交给后台/Change Stream；
│    acquire_adapter_guard 失败仅 LOG_WARN（tmp_ret），不阻断 DML 主路径
└─ IVF 分支校验 outrow LOB：向量字节长超过 get_lob_inrow_threshold() 即报 OB_ERR_UNEXPECTED
    （IVF 路径不支持 outrow 向量）

【后台】scheduler runTimerTask → execute_all_memdata_sync_task
├─ ObVectorIndexTask::process_one()（DAG：读 inc 隐藏表增量 → add_index 进 vsag → 推进 scn_）
├─ renew_single_snap_index()：内存 vsag fserialize → 写 snapshot 隐藏表（持久层真身）
└─ leader 经 ObVectorIndexSyncLog 写 Paxos 日志（512 tablet/批）→ follower 回放进
     ping-pong 双 map（first/second_mem_sync_map_）→ follower 内存 vsag 与 leader 收敛
```

方法速查表（按链路）：

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `acquire_adapter_guard` | 按 tablet_id 借出 adaptor（引用计数） | `ObVectorIndexAdapterCandiate` 持四个 guard |
| `insert_rows` | DML 事务内同步插 inc 索引 | vector 列落盘置 null——内存才是真身 |
| `knn_search` | vsag KNN（稠密/稀疏两个重载） | 带 ef_search/filter 位图/iter_ctx 分页游标 |
| `fserialize/fdeserialize` | snapshot 表的 blob 读写 | vsag 索引的持久化协议 |
| `process_adaptor_state` | 查询前 SCN 一致性检查 | 不新鲜则查询内触发 refresh |
| `top_k_search`（BMW 侧） | — | 见[统一检索原语](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/07-retrieval) |

<details>
<summary>vsag 适配层接口速查（oblib/lib/vector/ob_vsag_adaptor.h，namespace obvsag）</summary>

```
typedef void* VectorIndexPtr（内部 HnswIndexHandler*）
enum IndexType { HNSW_TYPE=0, HNSW_SQ_TYPE=1, HNSW_BQ_TYPE=5(RaBitQ), HGRAPH_TYPE=6, IPIVF_TYPE=8(稀疏) }
enum QuantizationType { FP32, SQ8 }
construct_vsag_create_param()   # 拼 JSON 参数；SQ8→"sq8"、BQ→"rabitq" 量化分支
create_index()                  # vsag::Factory::CreateIndex(type_str, json, allocator)
knn_search() ×3 重载            # 稠密带 ef_search/filter/iter_ctx；稀疏带 n_candidate
cal_distance_by_id()            # 按 vid 精算（BQ refine 用）
serialize/fserialize 四件套     # snapshot 持久化协议
FilterInterface{test(id)}       # 过滤下推接口，OB 侧由 ObHnswBitmapFilter 实现
ObVsagSearchAlloc : vsag::Allocator   # 内存记账桥（all_vsag_use_mem_ 全局计数器）
```
</details>

## 核心实现

### 算法体系与 LIB 参数

算法唯一真源在 `query/api/query/vector/ob_vector_index_util.h:114`：

```cpp title="src/query/api/query/vector/ob_vector_index_util.h"
enum ObVectorIndexAlgorithmType : uint16_t {
  VIAT_HNSW = 0, VIAT_HNSW_SQ, VIAT_IVF_FLAT, VIAT_IVF_SQ8, VIAT_IVF_PQ,
  VIAT_HNSW_BQ, VIAT_HGRAPH, VIAT_SPIV, VIAT_IPIVF,
};
enum ObVectorIndexAlgorithmLib { VIAL_VSAG = 0, VIAL_OB };   // LIB 参数：vsag 插件 or OB 自研
```

`"plugin"` 命名的由来即此：**算法库可插拔**——`VIAL_VSAG/VIAL_OB` 双路线，所有 vsag 专有代码被隔离在 `obvsag` adaptor 之后，上层只见 `void *index_` 句柄；`WITH(...)` 的 DDL 参数由 `ObVectorIndexParam`（util.h:196）承载（`type_/lib_/dist_algorithm_/dim_/m_/ef_construction_/ef_search_/nlist_/nbits_/refine_type_/bq_bits_query_` 及刷新控制 `sync_interval_type_{VSIT_IMMEDIATE,MANUAL,NUMERIC 秒}` + `sync_mode_async_`）。**hybrid 语义索引的判定**是 `endpoint_[512]` 非空（util.h:351 的 `is_hybrid_index()`）——DDL 带文本列 + AI endpoint 时，后台 refresh 任务自动调 embedding 把文本转成向量（见[库内 AI 函数](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/08-ai-functions)）。

执行计划侧的 4 种扫描模式（`ObVecIndexType`，注释标明 4351/4352/4353 版本演进）：`VEC_INDEX_POST_WITHOUT_FILTER`（纯 ANN）、`VEC_INDEX_PRE`（先构过滤位图再喂 vsag）、`VEC_INDEX_POST_ITERATIVE_FILTER`（遍历中逐 id 过滤）、`VEC_INDEX_ADAPTIVE_SCAN`（运行时自适应，`ObVecIdxAdaTryPath{PRE/ITERATIVE/IN/POST}`）；选择性护栏如 `MAX_HNSW_BRUTE_FORCE_SIZE = 20000`——小表直接暴力扫更快。

### 异步任务体系：断点续跑的 per-LS 工厂

任务接口 `ObVecIndexIAsyncTask`（`ob_vector_index_async_task_util.h:271`）只有一个纯虚 `do_work()` + `check_task_free()`；五类任务（`:74`）：`OB_VECTOR_ASYNC_INDEX_BUILT`（全量构建）、`OPTINAL`（HNSW `immutable_optimize`）、`IVF_LOAD/IVF_CLEAN`、`HYBRID_VECTOR_EMBEDDING`（语义索引 embedding）。**任务记录落内部表**（`ObVecIndexTaskStatus`：table_id/tablet_id/task_id/trigger_type/status/target_scn），executor 公共逻辑 `load_task_from_inner_table()` 让重启后恢复未完成任务；重试上限 `VEC_INDEX_TASK_MAX_RETRY_TIME = 3`、并发 `MAX_ASYNC_TASK_PROCESSING_COUNT = 128`；历史任务每 7 天由 `ObVectorIndexHistoryTask` 批量挪进 `__all_vector_index_task_history`。长批处理循环的**取消响应**由 `CHECK_TASK_CANCELLED_IN_PROCESS` 宏承担——每累加 `loop_cnt > 20` 才检查一次（避免每行判停的开销），取消判定来源是 `ObVecIndexAsyncTaskUtil::check_task_is_cancel`（DDL 删除任务 + `vec_idx_mgr_->get_async_task_opt().is_stop()` 停机信号两路）；`ObVecIndexAsyncTaskHandler` 线程池规格 `MAX_THREAD_COUNT = 12`、队列 `MAX_QUEUE_SIZE = 8`。

**hybrid refresh task 是唯一带跨请求状态机的任务**（`ob_hybrid_vector_refresh_task.h:37`：`TASK_PREPARE → PREPARE_EMBEDDING → WAITING_EMBEDDING → TASK_FINISH`）——因为 embedding 是异步外呼，`do_work()` 只推进状态机一步，靠 executor 反复 load 恢复继续；其 ctx（god node `ObHybridVectorRefreshTaskCtx`）持 `scan_iter_`（列序 `[vid][type][vector][chunk]`）、`embedding_task_`、`omt::ObAiServiceGuard ai_service_`，批大小 `BATCH_CNT = 2000`。读隐藏表统一走 `ObPluginVectorIndexUtils::read_local_tablet`（`ob_plugin_vector_index_utils.h:140`）。

### 查询融合：一个主迭代器编排九个子迭代器

`ObDASHNSWScanIter : ObDASIter`（`DAS_ITER_HNSW_SCAN`）实现 DAS 迭代器协议四件套（`do_table_scan/rescan/inner_get_next_row(s)`），内部编排覆盖全部隐藏表的九个子迭代器（`ob_das_hnsw_scan_iter.h:244`）：`delta_buf_iter_`（磁盘增量兜底——**未同步进 vsag 的行靠扫表兜住，正确性不依赖刷新时序**）、`index_id_iter_`、`snapshot_iter_`、`vid_rowkey_iter_`、`rowkey_vid_iter_`、`com_aux_vec_iter_`、`data_filter_iter_`、`func_lookup_iter_`、`pre_filter_iter_`。过滤下推三形态经 `ObHnswBitmapFilter`（实现 `obvsag::FilterInterface::test(int64_t id)`，支持 `BYTE_ARRAY/ROARING_BITMAP/SIMPLE_RANGE` 三形态，大位图自动升级 roaring）：PRE（普通索引先构位图再喂 vsag 的 `invalid` 参数）、IN（iterative 逐 id test）、POST。hybrid 场景 `distance_calc_` 对 embedded 表向量重算距离 + `distance_threshold_`。

IVF 侧是模板方法模式：`ObDASIvfBaseScanIter::process_ivf_scan()` 公共骨架 + 子类特化 `process_ivf_scan_post/pre()`（`ObDASIvfScanIter` FLAT/SQ8、`ObDASIvfPQScanIter` PQ）。IVF 的 KNN **不走内存 vsag**，而是「缓存的质心 → 算查询向量到各质心距离 → 选 nprobe 桶 → 扫 `saved_rowkeys` 分页 → 桶内精算排序」；质心缓存在 `ObIvfCacheMgr`（`ObPluginVectorIndexMgr::ivf_cache_mgr_map_`），三类质心数据（注释：ivfflat needs center ids; ivfsq needs sq metas and center ids; ivfpq needs center ids and pq center ids），由 `ObPluginVectorIndexService::get_ivf_aux_info()` 经生成的 SQL 读隐藏表 + LOB read service 解出 float 数组后写入。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器（隔离第三方库） | `obvsag::VectorIndexPtr` + `FilterInterface` + `ObVsagSearchAlloc` | 换索引库不动 SQL/存储两侧；vsag 内存置于 OB MemoryContext 记账之下 |
| 可重建缓存 + 持久真身分离 | 内存 vsag vs snapshot blob 隐藏表 | 索引可丢可重建，容灾以表为单位；重启 fdeserialize 恢复 |
| 引用计数 guard | `inc_ref/dec_ref_and_check_release` + `idle_cnt_` 空闲淘汰 | 查询持 adaptor 期间后台可并发 refresh；`clean_deprecated_adapters()` 回收 |
| 状态机 + 内部表持久化 | `ObVecIndexTaskStatus`/hybrid refresh 四状态 | 长任务断点续跑、崩溃恢复、可观测 |
| ping-pong 双 map | follower 的 `first/second_mem_sync_map_` | 处理 map 与等待 map 轮换，回放期间不阻塞读 |
| 模板方法 | IVF 扫描 pre/post 特化 | FLAT/SQ8/PQ 共享扫描骨架 |

## 模块间交互

向上被 DAS 迭代器消费（`ObDASHNSWScanIter`/`ObDASIvfScanIter` 经 guard 拿 adaptor）；被存储层**反向**消费（`insert_vector_index_rows` 经 `server_service<ObIVectorIndexRuntime>()`——storage→observer 的合法反向通道）；向 oblib 依赖 vsag adaptor 与距离内核；与 logservice 通过三个 handler 集成（replay/checkpoint/locallog——leader 把 memdata sync tablet 列表写 Paxos 日志，follower 回放重建内存，`FOLLOWER_SYNC` 任务驱动）；hybrid refresh 反向消费 AI 函数层的 `ObAIFuncModel::call_dense_embedding`（查询文本/文档文本自动 embed）；IVF 训练依赖 `storage/vector_index/ob_vector_kmeans_ctx.h`（Elkan kmeans）。异步模式的表则把增量维护交给 Change Stream（见[FORK 快照与 Change Stream](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/10-fork-change-stream)）。

## 扩展方式

新增向量索引算法（如 `_diskann`）：① `ob_vector_index_util.h:114` 加 `VIAT_DISKANN` + `ObVectorIndexParam` 参数；② schema/DDL 校验与参数序列化；③ `ob_vsag_adaptor.h` 的 `IndexType` 加 `DISKANN_TYPE`（注释要求与 VIAT 对齐）+ `construct_vsag_create_param()` JSON 分支 + `create_index()` 分发 `vsag::Factory::CreateIndex("diskann", ...)`（vsag 上游不支持则需扩 fork）；④ `ob_plugin_vector_index_utils.h` 的 VIAT→vsag 映射与构建分支；⑤ 扫描协议同 HNSW（内存图）可复用 `ObDASHNSWScanIter`；需磁盘分页则新建 `ob_das_diskann_scan_iter.h` + `DAS_ITER_DISKANN_SCAN` + `ob_das_iter.cpp` 工厂注册 + `ob_log_table_scan.h` 的 vec scan 判断；⑥ 后台构建加 `ob_vector_index_async_task_util.h:74` 的 task type + 新 executor（仿 `ob_ivf_async_task_executor.h`）+ scheduler 的 `ObVectorTaskScheduleType`；⑦ 需训练步骤（类 kmeans）则加训练 ctx 并接 `ObIvfBuildHelper` 式 helper map。
