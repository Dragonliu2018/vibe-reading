---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "Overview"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "OceanBase", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "OceanBase seekdb v1.4.0 源码解读概览：单机化的 AI 原生搜索数据库——VECTOR/全文/SQL 三模一体、vsag 插件化向量索引、ik 分词、DAAT/TAAT/BMW 统一检索原语、库内 AI 函数与 FORK 快照全景"
readingTime: "55 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v1.4.0（tag commit [`de5be277d`](https://github.com/oceanbase/seekdb/commit/de5be277d)，2026-08-26）· **协议** Apache 2.0 · **语言** C++20（+ Rust sql-nio）· **代码量** ~277 万行（src/ 含 oblib）· **仓库** [GitHub](https://github.com/oceanbase/seekdb)

---

## 总览

### 项目简介

**OceanBase seekdb** 是蚂蚁 OceanBase 团队推出的 AI 原生搜索数据库——把关系表、向量、全文、JSON、GIS 统一进一个引擎，让「一条 SQL 完成向量 + 全文 + 标量过滤的混合检索」，并把 embedding / rerank / LLM 推理做成 SQL 内置函数，支撑库内完整的 RAG 工作流。它解决的核心问题是：AI 应用（尤其是 Agent 的记忆检索）需要「持续写入 + 毫秒级并发检索」的 streaming workload，而传统向量数据库要么是纯内存侧车（无事务、无 SQL），要么是插件化扩容（MySQL 生态断裂）；seekdb 的答案是把 OceanBase 这个经过十年打磨的分布式数据库引擎**降维成单机检索引擎**，继承其 ACID、MVCC、MySQL 协议兼容与 LSM 存储栈，再在其上重建向量/全文/AI 三层检索能力。

值得强调的是 seekdb 与 OceanBase 主线的关系：它不是从零写的数据库，而是 OceanBase 4.x 的深度 fork。v1.4.0 是一次「外科手术式瘦身」的产物——git 历史里连续出现 `refactor(sql): remove legacy distributed execution framework`、`refactor: remove XA transaction support`、`remove table api from seekdb`、`refactor: remove unused HA and distributed scaffolding`、`Trim unsupported seekdb features (driven by dead config)` 等数十个裁剪提交：多租户机器（`ObMultiTenant` 整类删除）、ObRootService 集群大脑（整类删除，代之以进程内 `ObLocalManagementService`）、CDC、XA、Table API、分布式执行框架全部移除，换来的是源码从 300+ 万行降到 ~277 万行、单 binary 可以在 1C2G 上跑 VectorDBBench 的单机形态。

**项目边界**：seekdb 负责 AI 检索型负载（向量/全文/混合/OLTP 级小事务），不负责分布式扩展（多副本 Paxos 共识、分区均衡、集群管理已裁剪）——需要容灾时用 **standby 热备**（gRPC 日志流复制，类似 PostgreSQL WAL shipping），需要扩展时靠单机多 tablet 并行与 IVF/HNSW 索引。AI 推理本身也不在库内执行——`AI_EMBED` 等函数是「库内编排、库外执行」：seekdb 做 HTTP 客户端调用外部模型服务，模型配置通过 `CREATE AI MODEL` DDL 管理。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| VECTOR 类型与稀疏向量 | `src/data_plane/api/data_plane/vector/` + UDT 数组体系 | `VECTOR(N)` 稠密向量 = float32 数组（寄生 UDT/collection 类型）；`SPARSEVECTOR` = `ObMapType` 键值对 |
| 距离/相似度函数 | `src/storage/vector_type/` | `l2_distance` / `cosine_distance` / `inner_product` / `l1_distance` / `vector_norm` 等，SSE/AVX2 多目标 SIMD 内核 |
| 向量索引 | `src/observer/vector_index/` + `src/oblib/lib/vector/` | HNSW / HNSW_SQ / HNSW_BQ(RaBitQ) / HGRAPH / IVF(FLAT/SQ8/PQ) / SPIV 稀疏倒排，引擎是可插拔的 vsag 库（`VIAL_VSAG`/`VIAL_OB` 双路线枚举） |
| 全文索引 | `src/storage/fts/` | 5 种分词器：ik（中文，smart/max_word）/ ngram / ngram2 / beng / space（默认）；倒排存 4 张隐藏辅助表 |
| 混合检索 | `src/storage/retrieval/` | 全文 BM25 与稀疏向量共用 DAAT / TAAT / Block-Max WAND 迭代器体系，一条 SQL 内融合 |
| 库内 AI 函数 | `src/sql/engine/expr/ob_expr_ai/` | `AI_EMBED` / `AI_RERANK` / `AI_COMPLETE` / `AI_PROMPT`，libcurl 客户端，8 家 provider（OpenAI/Ollama/DashScope 等） |
| AI 模型管理 | `src/share/ai_service/` + `src/observer/ai_service/` | `CREATE/ALTER/DROP AI MODEL` DDL，endpoint 存 `__all_ai_model_endpoint` 内部表，api_key 加密落库 |
| 语义索引 | `src/observer/vector_index/ob_hybrid_vector_refresh_task.h` | hybrid vector index：文本列 + `endpoint` 参数，后台任务自动调 embedding 生成向量 |
| FORK 快照 | `src/rootserver/fork_table/` + `src/storage/ddl/ob_tablet_fork_task.h` | `FORK DATABASE/TABLE ... TO ...` 内核级 Copy-on-Write，宏块物理复用零拷贝；`MERGE TABLE ... STRATEGY FAIL/THEIRS/OURS` 合并 |
| Change Stream | `src/observer/change_stream/` | redo log 解析插件框架，`CS_PLUGIN_ASYNC_INDEX` 异步维护向量索引（delta HNSW） |
| Heap 表 | `src/share/schema/ob_table_schema.h:198` | `ORGANIZATION = HEAP` 无主键堆表 + 隐藏 `__pk_increment`，配 QUEUING/MODERATE/SUPER/EXTREME 四档老化模式 |
| 事务与 MVCC | `src/storage/tx/` | 2PC（`ObTxCtx` 状态机）+ GTS 全局时间戳 + MVCC，全部保留但参与者在单进程内 |
| Standby 热备 | `src/standby/` | gRPC 日志流复制 + 宏块级全量恢复 + promotion 晋升边界协议（防环，级联深度 16） |
| MySQL 兼容 | `src/observer/mysql/` + `src/sql/parser/` | MySQL 协议 + 方言扩展（`VECTOR`/`MATCH AGAINST`/`FORK`/`AI MODEL`），LangChain/LlamaIndex/任何 MySQL 客户端直连 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| OceanBase 4.x 引擎 | 核心底座 | SQL 优化器/执行器、LSM 存储（tablet/SSTable/palf 日志）、事务、schema 服务——seekdb 是其 fork |
| vsag | 核心 | 蚂蚁开源的向量索引库（HNSW/HGRAPH/IVF），`obvsag` adaptor 隔离层封装，`src/oblib/lib/vector/ob_vsag_adaptor.h` |
| libcurl | 核心 | AI 函数的 HTTP 客户端（easy 同步 + multi 批量多路复用），`src/sql/engine/expr/ob_expr_ai/ob_ai_func_client.cpp` |
| ik 分词算法 | 核心 | 移植自 elasticsearch-analysis-ik 体系的中文分词（Arbitrator 判优/多 processor 流水线），重写为 C++ |
| gRPC + protobuf | 核心 | standby 备库日志流与全量复制协议，`src/oblib/grpc/standbyservice.proto` |
| SQLite | 基础设施 | 单机版的元数据库（config 与 tablet_meta 表），`share::ObSQLiteConnectionPool`（`ob_server.h`） |
| Rust sql-nio | 可选 | seekdb 网络引擎（`ObSqlNioImpl`）的 Rust 重写，C ABI 暴露，`rust/sql-nio/` |
| bison/flex | 构建 | SQL 语法（`sql_parser_mysql_mode.y`）与 FTS 分词 DSL（`ftsparser.y`） |
| Bazel + CMake 双构建 | 构建 | v1.4.0 引入 Bazel 模块化（api 层重构的配套），CMake 兼容构建并存 |

### 版本历史

| 版本 | 日期 | 里程碑 |
| --- | --- | --- |
| v1.0.0 | 2025-11-12 | 首个 release：VECTOR/FTS/混合检索 + OceanBase 引擎单机化改造 |
| v1.1.0 | 2026-01-29 | hybrid vector index（语义索引）与 embedding 任务链、`DBMS_HYBRID_SEARCH.GET_SQL`、**FORK/MERGE TABLE**（commit `5f7a4856d` "Table Fork for Multi-Version Data in AI Workflows"） |
| v1.2.0 | 2026-04-13 | standby 热备与简化 rootservice 落地（`Supports standby and a simplified rootservice`），异步索引修复 |
| v1.3.0 | 2026-05-15 | Change Stream 框架 + **async HNSW 索引**（写路径与索引构建解耦）、Android 平台支持 |
| **v1.4.0** | **2026-08-26** | **单机化瘦身收官**：删除分布式执行框架/XA/CDC/Table API/多租户；api 化分层重构（`data_plane/api`、`query/api`）；写路径解耦（官方博客：QPS 提升 22 倍、并发 P99 降至 1/19） |

> 版本间的关键转折在 v1.3.0→v1.4.0：官方发布博客《你在用错误的 Benchmark 选 Agent 的向量数据库》明确描述了重写动机——旧版本写入路径同步构建索引，被 HNSW 写放大拖垮（69 QPS / P99 410ms）；v1.4.0 改为「写路径不碰索引」：事务提交只写 redo log，向量由 Change Stream 管道异步灌进内存 delta 索引，查询固定走 delta HNSW + snapshot HNSW 两索引合并。

---

## 快速上手

面向代码阅读者的最短路径（Linux/macOS，详见 `docs/developer-guide/zh/build-and-run.md`）：

```bash
# 1. 构建（CMake，首次 --init 拉依赖；产物 build_release/src/observer/seekdb）
./build.sh release --init --make

# 2. 启动单机实例（obd 包装脚本，读 tools/deploy/single.yaml）
./tools/deploy/obd.sh prepare -p /tmp/obtest
./tools/deploy/obd.sh deploy -c ./tools/deploy/single.yaml

# 3. MySQL 客户端连接（端口取自 single.yaml 的 mysql_port，如 10000）
mysql -h127.0.0.1 -P10000 -uroot
```

端到端验证——一条 SQL 跑通「建表 + 向量/全文双索引 + 混合检索」：

```sql title="来自 README.md 的混合检索示例"
CREATE TABLE articles (
    id INT PRIMARY KEY,
    title TEXT,
    content TEXT,
    embedding VECTOR(384),
    FULLTEXT INDEX idx_fts(content) WITH PARSER ik,
    VECTOR INDEX idx_vec (embedding) WITH(DISTANCE=l2, TYPE=hnsw, LIB=vsag)
) ORGANIZATION = HEAP;

-- 混合检索：向量距离 + 全文打分 + 标量过滤在同一条 SQL 下推
SELECT title, l2_distance(embedding, '[...]') AS vector_distance,
       MATCH(content) AGAINST('关键词' IN NATURAL LANGUAGE MODE) AS text_score
FROM articles
WHERE MATCH(content) AGAINST('关键词' IN NATURAL LANGUAGE MODE)
ORDER BY vector_distance APPROXIMATE LIMIT 10;
```

另一种零构建体验是 Python SDK（嵌入式模式，进程内库形态）：

```python
import pyseekdb
client = pyseekdb.Client(path="./seekdb.db", database="test")   # embedded 单机
collection = client.create_collection(name="demo")             # Chroma 风格 collection
collection.add(ids=["1"], documents=["向量数据库"], metadatas=[{"k": 1}])
```

---

## 架构设计解析

### 系统架构

seekdb 的架构思想可以概括为三句话：**底座降维**（分布式数据库裁成单机检索引擎，保留正确性骨架）、**索引旁路**（向量/全文索引不走 LSM 主路径，用隐藏辅助表 + 内存插件索引 + 异步任务维护）、**接口立缝**（用三条 header-only API 层把 300 万行单体的模块边界固化，为持续裁剪铺路）。

![seekdb 分层架构](/vibe-reading/images/articles/seekdb/architecture.svg)

单进程 `seekdb` binary 内部自上而下五层。**协议与进程层**：MySQL 协议监听（`src/observer/mysql/`）、单 runtime 资源调度（v1.4.0 已把多租户 `ObMultiTenant` 掏空成 `ObServerRuntimeController` 持有的唯一 `ObServerRuntime`）、rootserver 管理服务进程内化（`ObLocalManagementService`）。**SQL 查询层**：parser → resolver → rewrite → optimizer → code generator → 向量化执行引擎（Volcano pull 模型 + 256 行批处理），检索语义扩展全部以「语法 + 表达式注册 + DAS 迭代器」三点挂进来。**DAS 数据访问层**：把对 domain index（向量/全文隐藏表）的扫描封装成统一迭代器协议（`ObDASIter`，`src/sql/das/iter/`），是 SQL 引擎与存储检索原语的接驳层。**存储与检索层**：tablet/LSM 主体之外，并列三个检索子系统——向量索引服务（`observer/vector_index/`，内存 vsag 索引 + 调度器）、统一检索原语（`storage/retrieval/`，DAAT/TAAT/BMW）、FTS 分词器（`storage/fts/`），以及 palf 日志、2PC 事务、Change Stream 框架。**基础库**：oblib（含 vsag adaptor）、SQLite 元数据库、gRPC/protobuf。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 协议与进程层 | `src/observer/`、`src/rootserver/`、`src/standby/` | 进程生命周期、协议解码、管理面（DDL 调度/冻结/备库）——单 binary 部署形态的承载者 |
| SQL 查询层 | `src/sql/`、`src/pl/`、`src/query/api/` | 语义理解与计划生成，隔离「SQL 是什么」与「数据怎么存」 |
| DAS 数据访问层 | `src/sql/das/` | 把索引扫描抽象成迭代器协议，让执行引擎不感知 domain index 的物理形态 |
| 存储与检索层 | `src/storage/`、`src/logservice/`、`src/data_plane/api/` | LSM 事务存储 + 三套检索子系统 + 日志复制；正确性（ACID/MVCC/redo）的唯一守护者 |
| 基础库 | `src/oblib/` | 容器/内存/RPC/JSON/加密等与业务无关的通用件，含 vsag adaptor 隔离层 |

v1.4.0 最值得讲的结构决策是 **API 立缝**：`src/data_plane/api/data_plane/`（17 个子系统目录）、`src/query/api/query/`（19 个）、`src/storage/api/storage/` 三条纯头文件接口层，把上游 `sql ↔ storage` 互相 include 内部头的巨型依赖环斩成 `sql → data_plane(头) ← storage` 的单向依赖。以 FTS 为例，`data_plane/api/data_plane/fts/ob_fts_parser.h` 定义分词器接口 `ObIFTParserDesc`，SQL 层（`ob_expr_tokenize.cpp`、DML 写路径）与实现层（`storage/fts/`）都只 include 这份头——api 层不引入新命名空间（接口仍住在 `storage`），是物理分层而非逻辑分层。CMake 注释自白了动机：这是 **Bazel 模块化**的前置工程，配套产物是 `observer_module_sources.bzl` 等按模块登记的构建清单。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 接口隔离层（header-only seam） | `data_plane/api/`、`query/api/`、`storage/api/` | 300 万行单体解耦：实现可裁剪、调用方只依赖接口（`server_service<T>()` 服务定位器按类型取实现） |
| 插件 + 注册表 | FTS 分词器 `FTS_BUILD_IN_PARSER_LIST` X-macro（`ob_fts_parser_helper.h`）、Change Stream `ObCSPluginRegistry`、向量算法 `VIAL_VSAG/VIAL_OB` | 扩展点用「Desc 单例 + 工厂 if-else」最小机制注册，新增分词器/插件/算法库零侵入核心 |
| Pimpl / 门面 | `ObRetrievalProgram::Impl`（retrieval 入口）、`StandbyModule`（备库） | deep-module 门面收窄公共面；`standby_module_disabled.cpp` 提供编译期可裁剪 stub |
| 状态机 | `ObDDLTaskStatus`（`src/share/ob_ddl_common.h:135`，48 个状态含 FTS/向量专用段）、`ObHybridVectorRefreshTaskStatus`、`ObCSRummode`（Change Stream） | 长生命周期任务可断点续跑：崩溃/重启后从内部表恢复状态继续推进 |
| 模板方法 | IVF 扫描 `ObDASIvfBaseScanIter::process_ivf_scan` + 子类实现 pre/post | FLAT/SQ8 与 PQ 共享扫描骨架，只特化编解码步骤 |
| 策略分派表 | `ObVectorDistanceDispatch<float>::distance_funcs[]`（`data_plane/vector/ob_vector_metric.h`） | 距离度量枚举 → SIMD 内核的映射收敛一处，新增度量只改表 |
| 观察者/回调 | `ObIVectorIndexRuntime` 三个 logservice handler（replay/checkpoint/locallog） | 向量索引内存态挂进 palf 复制框架，leader 切换自动 `activate()/deactivate()` |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `ObTablet` | 数据分片容器（tablet），一个表按分区映射到若干 tablet | 随表创建，LS 内常驻 | 归属 `ObLS`（日志流）；持有 table store（SSTable 数组）+ memtable |
| `ObLS`（LogStream） | 日志流 = 复制与一致性的基本单位，内含一批 tablet | 进程启动时从 slog/super block 引导 | 挂 palf handle；事务参与者按 LS 划界 |
| `ObPluginVectorIndexAdaptor` | 一个向量索引的运行时实体：隐藏表 tablet id 集合 + 内存 vsag 句柄（inc/snapshot/bitmap 三份 `ObVectorIndexMemData`） | 引用计数 + 空闲淘汰（`clean_deprecated_adapters()`） | 由 `ObPluginVectorIndexMgr` 两级 hash map 管理，被 DAS 迭代器消费 |
| `ObVectorIndexMemData` | 单份内存索引数据：vsag 句柄 + roaring 位图 + SCN + vid 边界 | guard 借还，scheduler 维护 | `incr_data_`（增量）/`snap_data_`（存量）/`vbitmap_data_` |
| 隐藏辅助表（aux table） | 向量索引 6 张（rowkey_vid/vid_rowkey/delta_buffer/index_id/snapshot/embedded），FTS 4 张（rowkey_doc/doc_rowkey/倒排/doc_word） | 随 DDL 任务状态机逐张生成 | 就是普通表——复用事务/compaction/备份全套能力 |
| `ObAIFuncModel` | 一次 AI 调用的门面：表达式信息 + endpoint 配置 | eval 级（临时 arena） | 组合 `ObAIFuncClient`（curl）与 provider 策略（`ObOpenAIUtils` 等） |
| `ObAiModelEndpointInfo` | AI 模型端点配置（url/api_key 密文/provider/请求模板） | 存 `__all_ai_model_endpoint` 内部表，eval 时现场解析 | 被 `ObIAiEndpointResolver` 解析 |
| `ObRetrievalProgram` | 第二代统一检索入口（Pimpl，compile→start→pull） | 查询级 | 编排 `ObIRetrievalExecution`；v1.4.0 生产路径仍走第一代迭代器体系 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ObIFTParserDesc` | `data_plane/api/data_plane/fts/ob_fts_parser.h` | `ObIKFTParserDesc`/`ObNgramFTParserDesc`/`ObNgram2FTParserDesc`/`ObBasicEnglishFTParserDesc`/`ObWhiteSpaceFTParserDesc` | `FTS_BUILD_IN_PARSER_LIST` X-macro + `get_desc()` if-else 单例 |
| `ObVecIndexIAsyncTask` | `observer/vector_index/ob_vector_index_async_task_util.h:271` | `ObVectorAsyncIndexBuilt`/`ObVectorAsyncIndexOptinal`/IVF load/clean/`ObHybridVectorRefreshTask` | per-LS LoadScheduler 挂 3 个 executor 轮转，任务落内部表可恢复 |
| `ObAIFuncIEmbed/IComplete/IRerank` | `sql/engine/expr/ob_expr_ai/ob_ai_func.h` | `ObOpenAIUtils`/`ObOllamaUtils`/`ObDashscopeUtils`/`ObSiliconflowUtils` 内的策略 | `get_embed_provider()` 按 endpoint 的 provider 字符串分派 |
| `ObCSPlugin` | `observer/change_stream/ob_change_stream_plugin.h` | `ObCSPluginAsyncIndex`（当前唯一） | `CS_PLUGIN_TYPE` 枚举 + Registry；`CS_PLUGIN_MAX_TYPE` 扩展点 |
| `ObIVectorIndexRuntime` | `storage/api/storage/vector/ob_i_vector_index_runtime.h` | `ObPluginVectorIndexService` | `server_service<ObIVectorIndexRuntime>()` 服务定位器绑定 |
| `ObSRLookupIter` 装饰器族 / `ObDASIter` | `sql/das/iter/` | HNSW/IVF/TextRetrieval/SPIV/GlobalLookup 等 20+ 迭代器 | `ob_das_iter.cpp` 工厂 + `DAS_ITER_*` 类型枚举 |
| `ObIDDLPipeline : ObPipeline` | `storage/ddl/ob_ddl_pipeline.h` | `ObVectorIndexDDLPipeline` 等 | DDL 任务状态机按状态装配算子（`ObIVFCenterAppendBufferOperator` 等） |

---

## 代码目录

```shell
seekdb/
├── src/
│   ├── observer/            # 进程入口与服务装配（main.cpp、ob_server.cpp、omt/）
│   │   ├── mysql/           # MySQL 协议（obmp_query 等 obmp_* 命令处理器）
│   │   ├── vector_index/    # 向量索引服务与异步任务调度（~2.7 万行）
│   │   ├── change_stream/   # redo 消费插件框架（async index）
│   │   └── virtual_table/   # 系统视图（__all_virtual_*）
│   ├── sql/                 # SQL 引擎（~99 万行）
│   │   ├── parser/          # bison 语法（sql_parser_mysql_mode.y + ftsparser.y）
│   │   ├── resolver/        # 语义解析（ddl/ 下有 vec/fts 索引 builder util）
│   │   ├── engine/expr/     # 表达式（ob_expr_ai/、距离/vec_* 系列）
│   │   └── das/             # 数据访问服务 + iter/（20+ 扫描迭代器）
│   ├── storage/             # 存储引擎（~77 万行）
│   │   ├── blocksstable/    # 宏块/微块/SSTable/编码
│   │   ├── tablet/ ls/     # tablet 与日志流、memtable、compaction
│   │   ├── vector_index/    # IVF kmeans 训练（Elkan）
│   │   ├── vector_type/     # 距离 SIMD 特化（兼容垫片 + data_plane 声明）
│   │   ├── fts/             # 分词器实现 + ik/ + dict/（27 万词内嵌词典）
│   │   ├── retrieval/       # 统一检索原语（~1.1 万行，34 文件）
│   │   ├── tx/              # 2PC 事务（ob_tx_ctx.cpp 22 万行）
│   │   └── ddl/             # DDL 管线（含 fork tablet 任务）
│   ├── oblib/               # 基础库（~36 万行，含 lib/vector vsag adaptor）
│   ├── logservice/          # palf 日志 + apply/replay/localservice
│   ├── rootserver/          # 进程内管理服务（local_management、ddl_task/、fork_table/）
│   ├── share/               # 跨层共享（schema、ai_service、vector 常量）
│   ├── standby/             # gRPC 热备模块（v1.4.0 新增顶层目录）
│   ├── data_plane/api/      # 存储侧 header-only 接口层（17 子系统）
│   ├── query/api/           # SQL 侧 header-only 接口层（19 子系统）
│   ├── storage/api/         # 存储自留 runtime 接口缝
│   ├── pl/                  # PL/SQL 过程语言
│   └── objit/               # PL 对象编译基础设施
├── rust/sql-nio/            # 网络引擎 Rust 重写（C ABI）
├── deps/oblib → src/oblib   # v1.4.0 oblib 已并入 src/（deps/ 仅剩初始化脚本）
├── unittest/                # 单测（data_plane/logservice/observer/query/...）
├── tools/deploy/            # obd.sh 部署脚本 + single.yaml
└── docs/                    # mkdocs 开发者指南 + 发布博客
```

> 三条 `api/` 目录是「物理三级嵌套映射成逻辑一级 include」：`src/data_plane/api/data_plane/fts/ob_fts_parser.h` 的 include 写法是 `#include "data_plane/fts/ob_fts_parser.h"`——调用方感知不到 `api/` 这层物理目录，只看到模块的对外接口面。

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/seekdb/module-dependencies.svg)

依赖主线沿「协议 → SQL → DAS → 检索原语 → 存储物理层」单向流动，三个检索子系统（向量索引/FTS/retrieval）互相不直接依赖，全部通过隐藏辅助表与 DAS 迭代器这两个媒介协作——这是混合检索能在一条 SQL 里融合三种检索而不产生模块环的关键。AI 函数层是旁挂的叶子（只依赖 share/ai_service 元数据 + curl），被向量索引的 hybrid refresh 任务反向复用（自动 embedding）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 进程底座与单 Runtime | 进程三段式启动、模块装配、单 runtime 资源调度 | `main.cpp` 的 `inner_main()` → `ObServer::init/start` | 装配复合根：60 个 `mods_*` 模块的唯一所有者，多租户机器被它掏空 | [进程底座与单 Runtime](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/01-observer-runtime) |
| SQL 引擎 | MySQL 方言解析、计划生成、向量化执行 | `ObMPQuery::process` → `ObSql::handle_text_query` | 语义层唯一入口，seekdb 全部检索语法在此挂载 | [SQL 引擎](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/02-sql-engine) |
| 存储引擎 | LSM 存储（tablet/SSTable/compaction）、heap 表、DDL 管线 | `ObLSTabletService`、`ObTablet` | 数据物理形态与正确性（ACID/MVCC）的唯一守护者 | [存储引擎](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/03-storage-engine) |
| 向量类型与距离内核 | VECTOR 表示、SIMD 距离、UDT 寄生 | `data_plane/api/data_plane/vector/` | 被三层（SQL/索引/DAS）共用的纯函数内核，须独立于任何消费方 | [向量类型与距离内核](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/04-vector-type) |
| 向量索引体系 | vsag 插件化索引、异步任务、DAS 扫描融合 | `ObPluginVectorIndexService` | 内存索引是「可重建缓存」，需要普通二级索引没有的服务基础设施（SCN 一致性/Paxos 集成/内存管控） | [向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index) |
| 全文检索与 ik 分词 | 分词器插件、词典 DAT、倒排写路径 | `ObFTParseHelper::segment` | 分词是 FTS 质量的命门，插件化让 ik/ngram 各自演进不碰框架 | [全文检索与 ik 分词](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/06-fts) |
| 统一检索原语 | DAAT/TAAT/BMW 打分迭代器、块统计上界 | `ObSRDaaTIterImpl`/`ObSRBMWIterImpl` | BM25 与稀疏内积数学同构，共用一套迭代器 = hybrid search 的打分底座 | [统一检索原语](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/07-retrieval) |
| 库内 AI 函数 | AI_EMBED/RERANK/COMPLETE/PROMPT 表达式与模型管理 | `ObExprAIEmbed::eval_ai_embed` | SQL 内 RAG 管道的粘合层，provider 多态与模型 DDL 都围它转 | [库内 AI 函数](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/08-ai-functions) |
| 日志事务与热备 | palf 日志、2PC/GTS、standby gRPC 复制 | `ObLogService`、`StandbyModule` | 正确性与容灾基座；单机化后仍保留完整协议骨架 | [日志事务与热备](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/09-logservice-tx-standby) |
| FORK 快照与 Change Stream | 内核级 COW 快照、redo 消费插件框架 | `ObForkTableTask`、`ObCSPluginAsyncIndex` | Agent 沙箱（FORK/回滚）与写路径解耦（异步索引）是 seekdb 区别于向量数据库的两大特色 | [FORK 快照与 Change Stream](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/10-fork-change-stream) |

---

## 运行时行为

### 启动流程

`main()`（`src/observer/main.cpp:858`）先把主线程迁到自建 1MB mmap 栈上执行 `inner_main()`（observer 主线程要长期充当管理线程，栈尺寸受控；Linux 上还会 `disable_hugepage_for_self_text()` 防止 THP 碰脏代码页拖慢启动）。`inner_main()` → 信号掩码 → 参数解析（`--embedded`/`--role PRIMARY|STANDBY`）→ daemon 化（PID 文件 `run/seekdb.pid`）→ 日志 `log/seekdb.log` → 给主线程装裸 `lib::Worker`（租户体系存在前先有内存归属上下文）→ `ObServer::init()`：

```
ObServer::init(opts, log_cfg)                          // ob_server.cpp:644 —— 构造一切，不启动服务
├─ init_config / init_tz_info_mgr / init_pre_setting   // 配置 + 内存预算发布点
├─ sql::init_sql_factories() / init_sys_var()          // SQL 静态工厂与系统变量基线
├─ init_io() / init_global_kvcache()                   // 设备 IO + 全局 KVCache
├─ init_schema()                                       // ObMultiVersionSchemaService + SQLite 元数据库 meta_db_pool_
├─ init_fts() / init_ob_service() / init_local_management_service()
├─ init_sql() / init_pl() / init_storage()             // SQL/PL 引擎 + 存储环境
└─ init_server_runtime()                               // 构造唯一租户 runtime

ObServer::start()                                      // ob_server.cpp:1116 —— 先就绪、后监听
├─ startup_accel_handler_.start()                      // 启动期并行任务池（启动完成后销毁）
├─ server_runtime_controller_.start() → initialize_server_runtime()   // 引导/刷新/bring_up 单 runtime
├─ local_management_service_.start_service() → standby_module_->start()
├─ wait_for_server_runtime()                           // 等 GTS 可用 + 备库回放就绪
└─ net_frame_.start()                                  // ★ 网络监听最后才打开——客户端进来时一切已就绪
```

对象装配的关键事实：**模块唯一所有权**——约 60 个 `mods_*` 指针（`mods_trans_service_`、`mods_ai_service_`、`mods_px_pools_` 等）由 `obs_construct_modules()` 在 boot 期创建并绑定进 runtime 服务槽（`ob_server.h:684-763` 注释："ObServer is the sole owner"），SQL/存储层消费时一律经 `gctx_` 拿**接口指针**（如 `optimizer_storage_service()` 声明返回 `data_plane::ObIOptimizerStorageService*`、实际返回 `storage::ObAccessService*`）——调用方只见接口不见实现类型。配置优先级为命令行 > 配置文件 > 编译期默认；单机资源（`max_cpu_/memory_size_/log_disk_size_`）由 `build_server_resource_config_()` 直接从 `GCONF` 读——不再有 unit/资源池层。

### 核心运行流程

三条主链路覆盖了 seekdb 的核心运行模式：检索查询（读路径）、写入与索引构建（写路径）、FORK 快照（Agent 沙箱）。

#### 查询路径：混合检索一条 SQL

业务流程：MySQL 协议收到 SQL → 解析/改写（`semantic_distance` 改写、APPROXIMATE 标记）→ 优化器生成含 domain scan 的计划 → DAS 对向量/全文隐藏表发起扫描（vsag KNN + retrieval 迭代器）→ 融合排序回行。

![混合检索查询数据流](/vibe-reading/images/articles/seekdb/data-flow-query.svg)

文字描述：`ObMPQuery::process`（`src/observer/mysql/obmp_query.cpp:58`）经 `process_single_stmt` 进 `ObSql::handle_text_query`（`src/sql/ob_sql.cpp:1991`），词法语法在 `sql_parser_mysql_mode.y` 产出带 `T_FUN_MATCH_AGAINST`/`T_FUN_SYS_VECTOR_DISTANCE`/`T_APPROX` 节点的解析树；resolver 把向量索引扫描落成 `ObLogTableScan` 的 vec scan 属性（4 种模式 `VEC_INDEX_POST_WITHOUT_FILTER/PRE/POST_ITERATIVE_FILTER/ADAPTIVE_SCAN`），`semantic_distance(col, q)` 则在 `ob_transform_pre_process.cpp` 改写为向量索引扫描 + 查询文本经 AI 模型 embed。执行时 DAS 迭代器各走各路：HNSW 系走 `ObDASHNSWScanIter`（编排 9 个子迭代器，对内存 inc/snap 两份 vsag 索引 KNN + `delta_buf_iter_` 兜住磁盘增量，`vid_rowkey_iter_` 把 vid 翻译回 rowkey）；IVF 系走 `ObDASIvfScanIter`（缓存质心 → nprobe 选桶 → 桶内精算）；全文与稀疏向量走 `create_text_retrieval_sub_tree()`（`ob_das_iter_utils.cpp`）按 token 数与 topk 情况装配 DAAT/TAAT/BMW 迭代器。多路结果经 refine/topk 归并后按 DAS 协议吐行回协议层。

#### 写入路径：提交不碰索引

业务流程：INSERT 带 VECTOR 列 → memtable + redo log（palf）→ 提交返回 → 事务内同步把向量插内存增量 vsag → 隐藏表落盘（vector 列置 null）→ 后台任务刷 snapshot/训练 IVF → hybrid 索引另由 Change Stream / embedding 任务异步补向量。

![写入与索引构建数据流](/vibe-reading/images/articles/seekdb/data-flow-write.svg)

文字描述：关键钩子在 `ObLSTabletService::insert_vector_index_rows`（`src/storage/ls/ob_ls_tablet_service.cpp:3385`）——DML 事务内经服务定位器 `server_service<ObIVectorIndexRuntime>()` 拿到向量索引服务，`adaptor->insert_rows()` **同步**把向量插进内存 inc 索引（保证读己之写），随后 `rows[k].storage_datums_[vector_idx].set_null()` 让磁盘 delta buffer 行只存 `<vid, type, extra_info>` 而不落向量本体（内存才是向量真身）。昂贵的图构建/序列化/kmeans 训练全部交给 per-LS 的 `ObPluginVectorIndexLoadScheduler`（1s timer，四类任务 `ADAPTER_MAINTENANCE/FOLLOWER_SYNC/HNSW_OPTIMIZE/IVF_TASK` 各 10s 节流）：refresh 任务把内存 vsag `fserialize` 成 blob 写入 snapshot 隐藏表（snapshot 表 = vsag 索引的序列化持久层，重启后 `fdeserialize` 回内存）。声明了 async 索引的表则把这条链搬到 Change Stream：`ObCSPluginAsyncIndex` 解析 redo 行生成 `ObASyncIndexEvent`('I'/'D', vid, vec_data) 批量灌索引——写入与索引构建物理解耦，这是官方博客宣称 QPS 提升 22 倍的机制本体。

#### FORK 路径：Agent 沙箱秒级快照

业务流程：`FORK DATABASE agent_state TO sandbox_42` → DDL 任务取 `fork_snapshot_version` → tablet 级 DAG：Prepare（选 ≤ 快照版本的 SSTable 参与者）→ Reuse（`ObSSTableCloneParam` 克隆元数据，宏块物理复用零拷贝）→ 后续写入走正常 LSM（COW 生效）→ `MERGE TABLE ... STRATEGY THEIRS/OURS/FAIL` 回主线或 `DROP DATABASE` 丢弃。

文字描述：`ObForkTableTask : ObDDLTask`（`src/rootserver/fork_table/ob_fork_table_task.h:35`）驱动 `ObTabletForkPrepareTask`/`ObTabletForkReuseTask`（`src/storage/ddl/ob_tablet_fork_task.h:217`）：`ObTabletForkUtil::get_participants()` 按 `fork_snapshot_version` 挑出全部 `end_scn <= 快照版本` 的 SSTable，`process_reuse_sstable()` 用 `ObSSTableCloneParam`（携带 `root_block_addr`/`data_block_macro_meta_addr`/列校验和）在目标 tablet 重建 SSTable 元数据——数据宏块不复制，两个表共享同一批物理宏块，fork 秒级完成；此后双方各自的 memtable/merge 独立演进，形成 Copy-on-Write。`check_has_async_vector_index()`（`ob_fork_table_helper.h`）表明带异步向量索引的表有专门处理分支。合并回主线用 `T_MERGE_TABLE`（语法文件 4433 行，`STRATEGY FAIL/THEIRS/OURS` 三策略）。

### 状态流

![关键状态机](/vibe-reading/images/articles/seekdb/state-flow.svg)

三个有代表性的状态机：**DDL 任务状态机**（`ObDDLTaskStatus`，`src/share/ob_ddl_common.h:135`）是域索引构建的总谱——FTS 索引走 `PREPARE → GENERATE_ROWKEY_DOC_SCHEMA(25) → WAIT_ROWKEY_DOC_TABLE_COMPLEMENT(26) → GENERATE_DOC_AUX_SCHEMA(27) → WAIT_AUX_TABLE_COMPLEMENT(28)`，ik 索引额外先 `LOAD_DICTIONARY(46)` 灌词典，向量索引走 `GENERATE_ROWKEY_VID_SCHEMA(29) → GENERATE_VEC_AUX_SCHEMA(31) → GENERATE_VID_ROWKEY_SCHEMA(33)`，最后 `BUILD_DATA(48)` 回填存量数据。**hybrid 向量刷新任务**（`ob_hybrid_vector_refresh_task.h:37`）是唯一带跨请求状态机 + 外部 AI 调用的任务：`TASK_PREPARE → PREPARE_EMBEDDING → WAITING_EMBEDDING（轮询 AI 服务）→ TASK_FINISH`——因为 embedding 是异步外呼，`do_work()` 只推进状态机一步，靠 executor 反复 load 恢复继续。**Change Stream fetcher** 在 IDLE（无 async 索引表，10s 睡眠兜底）与运行态间切换，靠 schema version 变化唤醒。

---

## 典型修改场景

#### 场景 1：新增一种向量索引算法（如 `_diskann`）

1. `src/query/api/query/vector/ob_vector_index_util.h:114` — `ObVectorIndexAlgorithmType` 加 `VIAT_DISKANN`、`ObVectorIndexParam` 加参数
2. `src/oblib/lib/vector/ob_vsag_adaptor.h` — `IndexType` 加 `DISKANN_TYPE`，`construct_vsag_create_param()` 加 JSON 分支，`create_index()` 分发 `vsag::Factory::CreateIndex("diskann", ...)`
3. 扫描协议与 HNSW 相同则复用 `ObDASHNSWScanIter`；需磁盘分页则新建 `ob_das_diskann_scan_iter.h` + `DAS_ITER_DISKANN_SCAN` + 工厂注册（详见[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)）

#### 场景 2：新增一个 AI 表达式函数（如 `AI_SUMMARIZE`）

1. 新建 `src/sql/engine/expr/ob_expr_ai/ob_expr_ai_summarize.{h,cpp}`（仿 `ObExprAIRerank` 三件套：`calc_result_typeN` + `eval_ai_summarize` + `cg_expr`）
2. item type `T_FUN_SYS_AI_SUMMARIZE`（`src/query/api/query/parser/ob_item_type.h`，2082-2084 之后顺延）
3. `ob_expr_operator_factory.cpp` `REG_OP` 注册；如带运行时元数据再在 `ob_expr_extra_info_factory.cpp` `REG_EXTRA_INFO`
4. provider 层 `ob_ai_func_utils.h` 加 body/parse 函数（详见[库内 AI 函数](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/08-ai-functions)）

#### 场景 3：新增一种 BM25 打分变体（如 BM25F 字段权重）

1. `src/sql/engine/expr/ob_expr_bm25.h` — `p_k1/p_b` 常量与 `eval()` 参数布局扩展
2. `src/storage/retrieval/ob_block_max_iter.h` — `ObBlockMaxBM25RankingParam` 加 per-field 列索引，`calc_max_score` 按字段求上界
3. `ob_block_stat_collector.h` — `ObBM25MaxScoreParamCollector` 逐字段收集；`dim_weights_` 加权通道已就位可直接复用（详见[统一检索原语](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/07-retrieval)）

---

## 测试体系

```
unittest/
├── data_plane/     # 检索原语契约测试（retrieval/test_retrieval_program_contract.cpp）
├── storage/        # tablet/compaction/tx/fts 分词
├── sql/            # 表达式/迭代器
├── observer/       # 服务装配
├── query/ logservice/ rootserver/ share/ oblib/ standby/
└── run_tests.sh    # 聚合入口（CMake 提供 pretest 目标 + Bazel 模块单测目标）
```

| 代码层 | 测试类型 | 例子 |
| --- | --- | --- |
| retrieval 检索原语 | 契约测试（新 facade 未接生产路径前的先行规范） | `unittest/data_plane/retrieval/test_retrieval_program_contract.cpp` |
| 表达式/迭代器 | 单元测试 | `unittest/sql/`、`unittest/storage/` |
| DML/DDL 行为 | 集成测试 + mysqltest（`docs/developer-guide/zh/mysqltest.md`） | 回归框架 |
| 启动/部署 | 端到端 | `tools/deploy/obd.sh` + `unittest/run_tests.sh` |

想理解某个子系统，优先看它对应的 unittest 目录——retrieval 的 contract test 甚至先于生产实现存在，是「可执行规范」的样本。

---

## 阅读源码推荐路线

- 第一遍：理解主流程（跑起来 + 一条 SQL 的旅程）
  `src/observer/main.cpp` 的 `inner_main()` → `src/observer/ob_server.cpp` 的 `ObServer::init()`（看模块构造顺序）→ `src/observer/mysql/obmp_query.cpp` 的 `ObMPQuery::process()` → `src/sql/ob_sql.cpp` 的 `ObSql::handle_text_query()` → `src/sql/das/ob_das_scan_op.cpp`（看 domain index 分支）
- 第二遍：理解向量检索闭环（seekdb 的灵魂）
  `src/sql/resolver/ddl/ob_vec_index_builder_util.h`（6 张隐藏表如何生成）→ `src/storage/ls/ob_ls_tablet_service.cpp:3385` 的 `insert_vector_index_rows()`（写入钩子）→ `src/observer/vector_index/ob_plugin_vector_index_service.h`（服务/adaptor/Mgr 三件套）→ `src/sql/das/iter/ob_das_hnsw_scan_iter.h:244`（9 个子迭代器如何融合）
- 第三遍：理解统一打分与全文
  `src/storage/retrieval/ob_sparse_bmw_iter.cpp` 的 `top_k_search()`（BMW 五状态机）→ `ob_block_stat_iter.h`（skip index 块统计）→ `src/storage/fts/ob_ik_ft_parser.cpp` 的 `get_next_token()` → `ik/ob_ik_arbitrator.cpp`（smart 模式判优）
- 第四遍：理解底座取舍（这个 fork 改了什么）
  `src/observer/omt/ob_server_runtime_controller.h:45`（单 runtime 注释）→ `src/rootserver/ob_local_management_service.h:78`（ObRootService 的替代者）→ `src/standby/ob_standby_grpc.h`（备库协议）→ `git log v1.3.0..v1.4.0 --oneline | grep refactor`（瘦身史）

---

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| domain index | 域索引：挂在表上的「非 B-tree」索引族（向量/全文），seekdb 中以一组隐藏辅助表 + 专有扫描迭代器实现 |
| vid / doc_id | 向量索引行号 / 全文文档号——rowkey 与检索空间之间的映射中介（rowkey_vid/vid_rowkey 两张双向表） |
| SPIV | 稀疏向量倒排（sparse-vector inverted index）：每个非零维一条记录，rowkey=(dim, docid)，value 即 posting payload |
| delta HNSW / snapshot HNSW | 内存增量层 / 序列化存量层的双索引结构（类 LSM 分层），查询时两路 KNN 合并 |
| BMW | Block-Max WAND：用块级分数上界做 topk 剪枝的倒排遍历算法 |
| DAAT / TAAT | 文档地址递增（归并堆）/ 词项地址递进（分区 hash 累加）两种倒排遍历顺序 |
| ik | 中文分词器（源自 ES 生态 IK Analyzer 体系）：smart（智能判优）与 max_word（细粒度）双模式 |
| vsag | 蚂蚁开源向量索引库（HNSW/HGRAPH/IVF），seekdb 经 `obvsag` adaptor 层隔离使用 |
| hybrid vector index / 语义索引 | 带文本列 + AI endpoint 的向量索引：后台 refresh 任务自动调 embedding 把文本转成向量 |
| promotion | standby 备库晋升为主库，`StandbyPromotionBoundary` 带 source_chain 防环 |
| heap 表 | 无主键堆表（`ORGANIZATION = HEAP`），隐藏 `__pk_increment` 列做行号，collection 语义的载体 |

### 参考资料

- [seekdb 仓库](https://github.com/oceanbase/seekdb) 与 [官方文档 OceanBase.ai](https://oceanbase.ai)
- 发布博客《你在用错误的 Benchmark 选 Agent 的向量数据库》（仓库 `docs/blog/launch_blog_zh.md`）——写路径解耦、delta/snapshot 双索引、FORK COW 的第一手动机
- [vsag 向量索引库](https://github.com/ant-bee/vsag)、[elasticsearch-analysis-ik](https://github.com/infinilabs/analysis-ik)（ik 分词器上游体系）
- DeepWiki: oceanbase/seekdb（README 徽章链接的自动文档）
