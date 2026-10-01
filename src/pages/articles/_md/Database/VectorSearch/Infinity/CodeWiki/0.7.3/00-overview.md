---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "Overview"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity v0.7.3 源码解读概览：infiniflow 的 AI 原生数据库——C++23 modules 全模块化实现，三协议前端（thrift/PG/HTTP）、push 模型执行引擎、RocksDB 目录 + NewTxn 事务重写、HNSW/IVF/EMVB 向量索引族与 Lucene 风格倒排的混合检索全景"
readingTime: "50 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v0.7.3 · **协议** Apache-2.0 · **语言** C++23（C++20 modules）+ Python/Go SDK · **代码量** ~29.5 万行 C++（src/ 生产代码，另含 12.7 万行单元测试与 5.6 万行 thrift 生成代码）· **仓库** [GitHub](https://github.com/infiniflow/infinity)

---

## 总览

### 项目简介

Infinity 是 [infiniflow](https://github.com/infiniflow)（RAGFlow 背后的团队）开源的 **AI 原生数据库**：为 LLM 应用提供稠密向量、稀疏向量、张量（多向量）、全文与结构化数据的**混合检索**能力，服务 search/推荐/问答/对话/copilot 等 RAG 场景。项目 2022 年 7 月启动，2024 年 4 月发布 v0.1.0，当前 v0.7.3（2026-08）。

它的差异化路线可以概括为三句话：**一个数据库引擎而非向量库外挂**——完整的 SQL 管线（解析/绑定/优化/物理规划/并行执行）让混合检索拥有过滤、聚合、join（执行层尚未接线）、explain、事务的完整语义；**AI 类型一等公民**——`EMBEDDING/TENSOR/TENSOR_ARRAY/SPARSE/MULTI_VECTOR` 是逻辑类型系统的 5 个内建类型，CREATE TABLE 即声明，EXPLAIN 可见；**检索即查询**——`SEARCH MATCH TEXT(...) , MATCH VECTOR(...) FUSION('rrf')` 一条语句完成多路检索与融合，RRF/加权和/ColBERT 式 rerank 内建。

性能口号：百万级向量 0.1ms 延迟 / 15K+ QPS；3300 万文档全文检索 1ms / 12K+ QPS。**项目边界**：Infinity 是单机为主、可选 shared-storage 集群（1 写多读）的检索数据库——不做分布式分片（与 Milvus 的路线差异），不承载 OLTP 事务负载（快照隔离 + 表级冲突检测），执行引擎 v0.7.3 尚未支持 join 并行。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|---|---|---|
| 混合检索（dense/sparse/tensor/全文） | `planner/bound_select_statement_impl.cpp`、`executor/operator/physical_fusion_impl.cpp` | 一条 SEARCH 语句多路 MATCH + FUSION |
| 融合算法 RRF / 加权和 / MatchTensor rerank | `physical_fusion_impl.cpp:229/339/452` | rank_constant=60（对齐 ES） |
| HNSW 图索引（Plain/LVQ/Rabitq 三编码） | `storage/knn_index/knn_hnsw/hnsw_alg.cppm` | 建图后可 `OPTIMIZE` 降级压缩 |
| IVF 聚类倒排（SQ/PQ 量化） | `storage/knn_index/knn_ivf/ivf_index_storage.cppm` | 质心恒 f32，nlist = ratio·√N |
| 多向量 late interaction | `knn_index/emvb|plaid|smve` | ColBERT 式 MaxSim，EMVB 是 SIGIR'24 实现 |
| 全文检索（BM25/Block-Max WAND） | `storage/invertedindex/` | Lucene 风格 C++ 全栈，FST 字典 |
| 多语言分词 | `common/analyzer/` | cppjieba/sudachi/mecab/RAG（RAGFlow 移植）/ngram/ik |
| 二级索引（PGM learned index） | `storage/secondary_index/` | 不可变列存配 learned index |
| 事务（SI + WAL） | `storage/new_txn/` + `wal/` | 2025-05 重写，RocksDB 目录 |
| 快照 / 集群（1 写多读） | `main/cluster_manager.cppm`、`network/peer_*` | WAL 日志流复制，follower 上限 4 |
| 三协议接入 | `network/` | thrift（AST 直传）/ PG wire / HTTP REST |
| 嵌入式模式 | `embedded_infinity/`、`python/infinity_embedded` | 进程内 SDK 复用同一门面与存储 |
| 查询结果缓存 / 分页 | `storage/result_cache_manager.cppm` | 搜索节点级缓存（Optimizer 规则 6） |

### 技术栈

| 依赖 | 类型 | 用途 |
|---|---|---|
| C++23 + C++20 modules | 核心 | 全库 `.cppm` 接口 + `_impl.cpp` 分区，Ninja + clang modules 构建 |
| rocksdb | 核心 | 元数据目录存储（TransactionDB，自身 WAL 关闭） |
| thrift | 核心 | 主协议 IDL（66 个 Response 类型，ParsedExpr AST 直传） |
| oatpp | 核心 | HTTP REST 服务器 |
| boost::asio | 核心 | PG 协议 acceptor |
| cppjieba / sudachi / mecab | 核心 | 中/日/韩分词 |
| fastpfor | 核心 | posting list SIMD 位打包 |
| re2 / pcre2 | 核心 | 正则（REGEX/LIKE 与 RAG analyzer） |
| roaring / parallel-hashmap | 核心 | null 位图 / 无锁哈希表 |
| arrow | 可选 | 类型互转 |
| zstd/lz4/brotli | 可选 | 压缩 |
| ONNX Runtime MLAS | 核心 | GEMM（IVF 质心打分/SMVE 投影/EMVB） |
| Eigen | 核心 | EMVB 残差 SVD |
| vcpkg + CMake 4 | 构建 | 依赖管理与 C++ modules 工具链 |

### 版本历史

| 版本 | 时间 | 里程碑 |
|---|---|---|
| 项目启动 | 2022-07 | 初始引入 hyrise/sql-parser（后被重写为 Bison/Flex） |
| v0.1.0 | 2024-04 | 首个 release |
| v0.5.0 | 2024-12 | shared-storage 集群（1 写多读）、IVF 量化、查询缓存、集成 RAGFlow |
| new_txn 重写 | 2025-05~06 | PR #2553 引入 RocksDB 目录 + NewTxn；PR #2722 删除旧 TableEntry/SegmentEntry 内存树（**v0.6 存储引擎大重写**） |
| v0.6.0 | 2025-10 | 新事务系统定版 |
| v0.7.0 | 2026-05 | JSON 类型、Go SDK、ARM64、unnest JSON、二级函数索引 |
| v0.7.3 | 2026-08 | NULL 支持、RAG 分词器 language-aware stemming；本文基线 |

---

## 快速上手

```bash
# 1. 启动服务（Docker）
sudo mkdir -p /var/infinity && sudo chown -R $USER /var/infinity
docker pull infiniflow/infinity:nightly
docker run -d --name infinity -v /var/infinity/:/var/infinity \
  --ulimit nofile=500000:500000 --network host infiniflow/infinity:nightly

# 2. 安装客户端
pip install infinity-sdk==0.7.3
```

端到端验证——建表、插入、混合检索一条龙：

```python
import infinity

infinity_obj = infinity.connect(infinity.NetworkAddress("127.0.0.1", 23817))
db = infinity_obj.get_database("default_db")
table = db.create_table("my_table", {
    "num": {"type": "integer"},
    "body": {"type": "varchar"},
    "vec": {"type": "vector, 4, float"},
})
table.insert([{"num": 1, "body": "unnecessary and harmful", "vec": [1.0, 1.2, 0.8, 0.9]},
              {"num": 2, "body": "Office for Harmful Blooms", "vec": [4.0, 4.2, 4.3, 4.5]}])
res = (table.output(["num", "body"])
            .match_dense("vec", [3.0, 2.8, 2.7, 3.1], "float", "ip", 2)
            .to_pl())
print(res)
```

端口速查：thrift `23817`（SDK）、PG wire `5432`（可直接 `psql -h 127.0.0.1 -p 5432` 调试，SQL only for test）、HTTP `23820`（REST）。从源码构建需 clang ≥ 20 + CMake ≥ 4.0.3 + Ninja + vcpkg（`CMakeLists.txt` 强制要求）。

---

## 架构设计解析

### 系统架构

![分层架构](/vibe-reading/images/articles/infinity-internals/architecture.svg)

架构主线是**一条 SQL 编译管线 + 一个列存引擎 + 三协议前端**。分层自上而下：

- **接入层**：四个服务器前端并存于一个进程。thrift 是主协议——`SelectRequest` 传 `ParsedExpr` AST 树而非 SQL 文本，服务端跳过 SQL 解析直达 binder；PG wire 是兼容通道（OID 映射让 psql 读得懂向量列）；HTTP 是无状态 REST；peer server 服务集群节点间通信。
- **服务层**：会话（事务挂载点）、Infinity 门面（~140 个 API，三协议统一消费）、QueryContext（每查询的七阶段管线驱动）、ClusterManager（leader/follower/learner 角色与 WAL 复制）。
- **SQL 编译层**：三套 Flex/Bison 语法（SQL/表达式/Lucene 查询串）→ Binder（16 步绑定 + 9 个子 binder）→ Optimizer（6 条启发式规则）→ 函数目录（CastTable 代价矩阵驱动的重载解析）。
- **执行层**：push 模型（非火山拉模型）——90+ 物理算子、FragmentBuilder 把物理树切成可并行片段、TaskScheduler 做 morsel 驱动调度（每 fragment × 并行度 = 1 个 FragmentTask）。
- **存储层**：NewTxn 事务（Top/Bottom 两半提交）+ RocksDB 目录（版本化 KV）+ 列存（8192 定容 block，RowID 位绑定）+ 索引族（HNSW/IVF/倒排/PGM）。
- **类型底座**（横跨）：`parser/type/` 的 36 种逻辑类型（含 5 种 AI 类型）+ 异常体系 + 分词器。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|---|---|---|
| 接入层 | `src/network/` | 隔离协议细节，保护核心不受接口演化影响 |
| 服务层 | `src/main/` + `src/bin/` + `src/admin/` | 组合根与查询编排，会话/配置/集群生命周期 |
| SQL 编译层 | `src/parser/` + `src/planner/` + `src/function/` | 把声明式意图翻译为可执行计划，名字解析与类型检查 |
| 执行层 | `src/executor/` + `src/scheduler/` | 向量化并行执行，数据缩减先于交换 |
| 存储层 | `src/storage/` | 事务、目录、列存、索引的持久化与一致性 |
| 类型底座 | `src/parser/type/` + `src/common/` | 全库公共词汇，编译防火墙的最内层 |

### 设计模式

| 模式 | 代表位置 | 为什么用 |
|---|---|---|
| Facade（门面） | `Infinity`（`main/infinity.cppm`） | 三协议汇聚一点，网络层零存储依赖 |
| 两阶段初始化 | `InfinityContext::InitPhase1/2` | 先监听后定角色（follower 注册需要 peer 端口先可用） |
| Top/Bottom 两半提交 | `NewTxn::Commit`（`new_txn.cppm:170`） | 日志全局序 + Apply 分区并行的解耦 |
| 版本即键 MVCC | `catalog\|tbl\|{db}\|{name}\|{commit_ts}` | RocksDB 即 MVCC 目录，无 undo log |
| Push 算子模型 | `PhysicalOperator::Execute` | DataBlock 批推送，缓存友好 |
| Fragment + Exchange | `FragmentBuilder::BuildFragments` | 流水线并行 + 局部收敛再交换 |
| variant 类型擦除 | `AbstractHnsw`（60 alternative） | 搜索热路径零虚调用 |
| 命令模式 | `WalCmd` 层次 | PrepareCommit/CommitBottom/Replay/序列化四处多态分发 |
| 策略（编译期） | 16 个标量函数模板入口、`template-template param` 归并 | 签名形状固化到类型系统 |
| 写暂存 Staging | `BaseTxnStore::ToWalEntry` | 数据、WAL、Apply 从同一份暂存派生——redo 幂等 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---|---|---|---|
| `InfinityContext` | 进程级组合根，持有六件套 | 进程 | new 出 Config/Storage/SessionMgr/ClusterMgr/TaskScheduler |
| `Infinity` | 门面 API（~140 方法） | 每连接/每请求 | 消费 QueryContext |
| `BaseSession` | 会话，事务挂载点 | 连接级（thrift 显式 RPC） | 持有 `NewTxn` |
| `QueryContext` | 查询指挥部（七阶段管线） | 每语句 | 持有 parser/planner/optimizer 五件套 |
| `NewTxn` / `NewTxnManager` | 事务与事务管理 | 语句级 | 持有 WalEntry + KVInstance + TxnStore |
| `NewCatalog` / Meta 句柄 | 目录服务（非内存树） | 进程 / 临时 | RocksDB KV + 四张运行时注册表 |
| `PlanFragment` / `FragmentContext` / `FragmentTask` | 执行计划切片 / 调度单位 / worker 单元 | 查询级 | BlockingQueue 连接父子 |
| `DataBlock` / `ColumnVector` | 8192 行列批 / 列向量 | 块级 | BufferManager 管理的 BufferObj |
| `MemIndex` | 未 seal segment 的内存索引 | 跨事务 | dump 后换成 ChunkIndexMeta |
| `RowID` | 全局行标识 | 永久 | segment_id(高位) + block_id + offset(13bit) 位绑定 |

#### 核心抽象（扩展点契约）

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|---|---|---|---|
| `PhysicalOperator` | `executor/physical_operator.cppm:31` | 90+ 算子 | PhysicalPlanner switch |
| `OptimizerRule` | `planner/optimizer_rule.cppm` | 6 条规则 | `Optimizer::AddRule` |
| `ExpressionBinder` | `planner/expression_binder.cppm` | 9 个子 binder | final override |
| `WalCmd` | `wal/wal_entry.cppm:202` | ~30 个命令 | `ReadAdv` 反序列化工厂 |
| `BaseTxnStore` | `new_txn/base_txn_store.cppm:69` | 24 个写暂存 | ToWalEntry 多态 |
| `FileWorker` | `buffer/file_worker/file_worker.cppm:35` | 12 种文件格式 | BufferObj 持有 |
| `Analyzer` | `common/analyzer/analyzer.cppm` | 9+ 分词器 | AnalyzerPool 按名 |
| `BaseMemIndex` | `catalog/mem_index.cppm` | HNSW/IVF/倒排/EMVB/... 9 种 | MemIndex variant |

---

## 代码目录

```text
infinity/
├── src/
│   ├── bin/            # 进程入口（infinity_main.cpp）+ infinity_core 聚合模块
│   ├── main/           # 组合根：InfinityContext/Infinity 门面/QueryContext/Session/Config/ClusterManager
│   ├── admin/          # AdminExecutor（30+ 维护命令，4.3K 行单文件）
│   ├── network/        # 四协议前端（thrift 生成代码 5.6 万行在 infinity_thrift/ 子目录）
│   ├── parser/         # 三套 Flex/Bison 语法 + statement/expr AST + type/ 类型底座（4.5 万行）
│   ├── planner/        # Binder + LogicalPlanner + Optimizer（2.2 万行）
│   ├── expression/     # bound 表达式（KnnExpression/MatchExpression/...）
│   ├── function/       # 函数注册/重载解析/聚合/cast（1.2 万行）
│   ├── executor/       # 物理算子 + PhysicalPlanner + FragmentBuilder（3 万行）
│   ├── scheduler/      # TaskScheduler + FragmentContext/Task（2K 行，fragment_context 72KB）
│   ├── common/         # 异常/Status/分词器/SIMD/单例（2.9 万行）
│   ├── storage/        # 存储引擎（7.1 万行，不含 unit_test）：
│   │   ├── new_txn/ wal/        # 事务 + 日志（~1.7 万行，new_txn_impl.cpp 265KB）
│   │   ├── catalog/ meta/       # RocksDB 目录 + Meta 句柄 + BlockVersion
│   │   ├── knn_index/           # HNSW/IVF/DiskANN/EMVB/PLAID/SMVE/flat/sparse
│   │   ├── invertedindex/       # Lucene 风格倒排全栈（1.9 万行）
│   │   ├── column_vector/ buffer/ io/ persistence/  # 列向量/缓冲池/文件抽象/对象合并
│   │   ├── bg_task/ secondary_index/ fast_rough_filter/ compaction/
│   │   └── definition/         # 索引定义（index_hnsw/ivf/diskann/...）
│   └── unit_test/      # gtest（12.7 万行）
├── python/             # infinity_sdk（SDK）+ infinity_embedded（嵌入式）+ 测试
├── go/                 # Go SDK
├── client/cpp/         # C++ 客户端
├── thrift/             # 协议 IDL（infinity.thrift 66 个 Response 类型）
├── conf/               # TOML 配置样例（leader/follower/learner/minio）
├── test/sql/           # sqllogictest 回归集（basic/ddl/dml/dql/explain/snapshot）
├── gui/                # Next.js 网页控制台
└── benchmark/ docs/ example/
```

---

## 模块地图

![模块依赖](/vibe-reading/images/articles/infinity-internals/module-map.svg)

依赖方向自上而下（前端 → 服务 → 编译 → 执行 → 存储），类型底座横跨全库。模块间的动态调用顺序见下文「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|---|---|---|---|---|
| 服务外壳与生命周期 | 进程装配/门面/查询管线/集群 | `infinity_main.cpp` | 组合根唯一 new 子系统的地方 | [01](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/01-server-shell) |
| 网络协议层 | thrift/PG/HTTP/peer 四前端 | `infinity_thrift_service_impl.cpp` | 协议隔离，业务语义全下沉门面 | [02](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/02-network-protocols) |
| SQL 解析器 | 三套语法 + 双 AST + 类型底座 | `sql_parser.cpp` | 生成器世界与 modules 世界的隔离层 | [03](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/03-sql-parser) |
| 查询规划器 | Binder/Optimizer/bound 表达式 | `query_binder_impl.cpp:83` | 名字解析与逻辑计划是独立编译阶段 | [04](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/04-query-planner) |
| 执行器与调度器 | 物理算子/Fragment/Task | `fragment_context_impl.cpp:459` | push 模型与并行调度自成体系 | [05](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/05-executor-scheduler) |
| 函数库与表达式求值 | 注册/重载解析/向量化求值 | `builtin_functions_impl.cpp:98` | 函数是目录对象，注册与求值解耦 | [06](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/06-functions-expressions) |
| 公共设施 | 异常双轨/Status/分词器/SIMD | `exception_impl.cpp` | 全库 god node 所在地（2,444 处 UnrecoverableError） | [07](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/07-common-infrastructure) |
| 事务系统 | NewTxn/WAL/两半提交 | `new_txn_impl.cpp:2037` | 2025 重写后的正确性核心 | [08](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/08-transaction-wal) |
| 元数据目录 | RocksDB KV + Meta 句柄 | `new_catalog_static_impl.cpp` | "扁平 KV + 前缀编码"替代内存树 | [09](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/09-catalog) |
| 向量检索 | HNSW/IVF/EMVB/PLAID/SMVE | `physical_knn_scan_impl.cpp:643` | 索引族按算法独立成目录 | [10](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/10-knn-index) |
| 全文检索 | 倒排全栈/BM25/BMW | `memory_indexer_impl.cpp` | Lucene 风格独立子系统（1.9 万行） | [11](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/11-inverted-index) |
| 列存与存储管理 | ColumnVector/Buffer/IO/后台任务 | `column_vector_impl.cpp` | 向量化执行的地基（298 文件 import） | [12](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/12-columnar-storage) |

---

## 运行时行为

### 启动流程

```text
main()                                          src/bin/infinity_main.cpp:227
 ├─ CLI 解析（CLI11：-f 配置路径、-m 维护模式）
 ├─ InitPhase1(config_path)                     infinity_context_impl.cpp:42
 │   ├─ Config::Init（TOML → GlobalOptions 58 项）
 │   ├─ Logger / ResourceManager / SessionManager 装配
 │   └─ ChangeServerRole(kAdmin)                ★ 先拉到 admin 角色
 │       ├─ storage_ = make_unique<Storage>(config)
 │       │    └─ KVStore(RocksDB) 打开 → NewCatalog → WAL replay
 │       │       → AttachCatalog（树状递归预加载各层 LoadSet）
 │       │       → RecoverMemIndex → RestoreCatalogCache（MetaTree 物化 → SystemCache）
 │       ├─ cluster_manager_ → InitAsAdmin
 │       └─ StartThriftServers（thrift + peer 开始监听）
 ├─ pg_server.Run() + http_server.Start()
 ├─ RegisterSignal（SIGTERM/SIGINT/SEGV/... → PrintStacktrace + core）
 └─ InitPhase2(m_flag)                          infinity_context_impl.cpp:80
     ├─ maintenance → 短路（停驻 admin 只读）
     └─ standalone → ChangeServerRole(kStandalone)
         ├─ storage_->SetStorageMode(kWritable)
         └─ task_scheduler_ = make_unique<TaskScheduler>（角色定后才建）
```

对象装配要点：`InfinityContext` 是唯一 new 子系统的地方（六件套 + 四个 ctpl 线程池）；`QueryContext` 每语句新建，注入 7 个全局服务裸指针；事务绑定在 `BaseSession` 而非 QueryContext。两阶段初始化的动因：**follower 的角色切换要求 peer 端口先可被 leader 连上**——注册链路 `RegisterToLeader → AddNodeInfo → SyncLogsOnRegistration` 推 WAL 才能走通（v0.7.3 follower 侧的 `ContinueStartup` 回放入口是空壳，集群复制属半成品状态）。

### 核心运行流程

下面三条链路覆盖 Infinity 最重要的运行模式：读（混合检索）、写（INSERT 事务）、恢复/复制（WAL replay）。查询链路是理解这个系统的主线——一条 SQL 从协议到结果要穿越六层，每层的产出形态都不同（AST → bound → 逻辑树 → 物理树 → fragment → DataBlock）。

#### 查询链路：混合检索

业务流程：客户端提交 `SELECT ... SEARCH MATCH TEXT(...), MATCH VECTOR(...) FUSION('rrf') WHERE ...` → 事务开始 → 六阶段编译 → 并行执行 → 融合 → 提交 → 结果列式序列化返回。

![查询数据流](/vibe-reading/images/articles/infinity-internals/query-dataflow.svg)

文字解读：thrift 入口**直传 ParsedExpr AST 免 SQL 解析**（SQL 文本路径仅 PG 前端与显式 Query API）。QueryContext 的 `QueryStatementInternal` 固定七阶段（BeginTxn → LogicalPlanner → Optimizer → PhysicalPlanner → FragmentBuilder → BuildTask → Schedule），每阶段挂 profiler 钩子。Binder 阶段 16 步完成名字解析，全文查询串在此刻经第三套语法解析成 QueryNode 树；Optimizer 的 6 条规则做粗滤下推、索引改写、列裁剪。执行层的关键设计是 **push 模型 + fragment 切分**：MATCH 全文分支串行（BM25 需全局 doc 频）、KNN 分支按 `min(cpu_limit, block 数+索引 chunk 数)` 并行、FUSION 等各路 `input_complete_` 后一次性计算——RRF 公式 `Σ 1/(60 + rank_i)` 对齐 Elasticsearch。冲突时 `TxnConflict` 触发整条语句 do-while 重试。

#### 写入链路：INSERT 事务

业务流程：INSERT → 事务暂存 → 提交上半部（冲突检测 + 元数据）→ WAL 组提交 → 下半部并行写数据与内存索引 → 可见性有序发布。

![写事务提交管线](/vibe-reading/images/articles/infinity-internals/txn-commit.svg)

文字解读：这是 v0.6 重写后的核心。数据先暂存 `AppendTxnStore`（不动真身）；Commit 时 `prepare_commit_ts_ += 2` 取号（每写事务占 2 槽），表级乐观冲突检测（24 个重载只比较 db/table/index 名）；WAL 由暂存确定性生成、`wait_conflict_ck_` 闸门保证落盘顺序 = commit_ts 顺序（单写者线程）；`BottomExecutor` 按 `CRC32(table_id) % N` 分队列——同表串行、跨表并行地写 .col 列文件、BlockVersion、插内存索引（HNSW 边写边查的可见性靠 BlockVersion 时间戳在查询侧过滤）；最后 `bottom_txns_` 前缀连续才推进 `current_ts_`——可见性时间线永不乱序。

#### 恢复/复制链路：WAL replay 与集群

启动恢复三阶段（`wal_manager_impl.cpp:588`，源码有 ASCII 图）：从新到旧反向遍历 wal.log 找最近 CHECKPOINT_V2 → 反向收集 `commit_ts > max_checkpoint_ts` 的 entry → 正序逐条 `BeginReplayTxn → ReplayWalCmd → CommitReplay`（多数 Replay 复用 PrepareCommit，坏 entry 用 crc 截断）。集群复用同一日志格式：leader 在 WAL flush 时顺带 `PrepareLogs/SyncLogs`，follower 的 `FlushLogByReplication` 把日志写进本地 WAL（v0.7.3 follower 侧在线回放入口 `ContinueStartup` 是空壳，集群复制半成品）。catalog 的 checkpoint 就是 RocksDB `Flush()` 快照 + WAL 文件轮转。

### 状态流

事务状态机（`txn_state.cppm:23`，7 态）：

```text
kNotStarted → kStarted → kCommitting → kCommitted
                    └────→ kRollbacking → kRollbacked
kInvalid（终态哨兵；非法迁移 UnrecoverableError）
```

同一维度的状态机还有两个：`StorageMode`（kUnInitialized/kAdmin/kReadable/kWritable，与 NodeRole 原子联动——写路径只允许 leader/standalone，follower 物理只读）与 `SegmentStatus`（kUnsealed/kSealed/kCompacting/kNoDelete/kDeprecated，驱动索引 dump 与 compaction 的段生命周期）。`BufferObj` 有 kNew/kLoaded/kUnloaded/kFreed/kClean 五态 + ephemeral→temp→persistent 降级链。完整的事务提交状态迁移图见上文 txn-commit.svg。

---

## 典型修改场景

#### 场景 1：新增一种向量索引（如降量化变体）

从 parser 到执行器全链路约 10 处：`IndexType` 枚举（`create_index_info.h`）→ `definition/index_xxx.cppm`（Make/Validate/Serialize）+ `IndexBase::Deserialize` 工厂 → `mem_index.cppm` 加 variant 存取 → `new_txn_index_impl.cpp` **至少 7 处 case 散布**（create/append/dump/optimize）→ `chunk_index_meta_impl.cpp` 4 处 → `physical_knn_scan_impl.cpp:643` 搜索 switch。测试参照 `python/test_pysdk/test_index.py`。**switch 散布无注册表集中化是当前最大维护成本**。

#### 场景 2：新增一个后台任务

`BGTaskType` 枚举 → `bg_task.cppm` 任务 struct（继承 BGTask，async_ 决定 fire-and-forget）→ 4 个 processor 的 `Process()` switch 加 case（**default 抛 UnrecoverableError，漏加崩进程**）→ 触发侧 PeriodicTrigger 或业务 Submit。对应测试：`python/parallel_test/`、`run_snapshot_stress_test.py`。

#### 场景 3：新增一个 SQL 函数

`function/scalar/my_func.cppm/_impl.cpp`（运算 struct + 注册函数 + 模板入口选择）→ `builtin_functions_impl.cpp` 一行注册 → 可选 cast_table 补矩阵。**无需改 planner/executor**——binder 经 catalog 通用路径解析，executor 经 FunctionExpression 通用路径求值。对应测试：`src/unit_test/function/scalar/`。

---

## 测试体系

```text
src/unit_test/              # gtest 单元测试（12.7 万行，302 文件）——按模块镜像目录结构
test/sql/                   # sqllogictest 回归集（.slt：statement ok / query I + 期望结果）
python/
├── test_pysdk/             # 34 个端到端测试文件（test_basic/test_index/test_compact...）
├── parallel_test/          # 并行一致性
├── restart_test/           # 重启恢复（WAL replay 验证）
├── test_cluster/           # 集群（leader/follower/learner）
└── pytest.ini              # markers: slow / ubsan / complex
benchmark/                  # 性能基准
```

| 代码层 | 测试类型 | 位置 |
|---|---|---|
| parser/planner/function | Unit Test（gtest） | `src/unit_test/` |
| 执行器/存储回归 | sqllogictest | `test/sql/`（`.slt` 是可执行文档） |
| 全链路 | e2e（pysdk） | `python/test_pysdk/` |
| 事务/崩溃 | restart + parallel | `python/restart_test/`、`parallel_test/` |
| 集群 | cluster | `python/test_cluster/` |

理解某模块优先读对应测试：事务语义看 `restart_test`（崩溃恢复是事务正确性的试金石），混合检索语法看 `test_pysdk/test_hybrid_search*.py`，执行计划形态看 `test/sql/explain/explain_fusion.slt`。

---

## 阅读源码推荐路线

- **第一遍：主流程**（理解一次启动与一条查询的骨架）
  `src/bin/infinity_main.cpp` 的 `main()` → `src/main/infinity_context_impl.cpp` 的 `InitPhase1/InitPhase2` → `src/main/query_context_impl.cpp:123` 的 `QueryStatementInternal`（七阶段管线全貌）→ `src/main/infinity_impl.cpp:56` 的 `GetQueryContext`（门面与上下文装配）
- **第二遍：查询管线**（跟着一条混合检索 SQL 走）
  `src/parser/sql_parser.cpp` → `src/planner/query_binder_impl.cpp:83` 的 `BindSelect`（16 步）→ `src/planner/bound_select_statement_impl.cpp:92` 的 `BuildPlan`（LogicalFusion 树组装 + SearchDriver 二次解析）→ `src/executor/physical_planner_impl.cpp:151` → `src/executor/fragment_builder_impl.cpp:100` → `src/scheduler/fragment_context_impl.cpp:459` 的 `BuildTask` → `src/scheduler/fragment_task_impl.cpp:47` 的 `OnExecute`
- **第三遍：存储与事务**（v0.6 重写的核心）
  `src/storage/new_txn/new_txn.cppm`（39KB 接口，注释即步骤图）→ `new_txn_manager_impl.cpp` 的 `CommitBottom`（可见性发布）→ `wal_manager_impl.cpp:249` 的 `NewFlush` + `:588` 的 `GetReplayEntries`（三阶段恢复的 ASCII 图）→ `src/storage/catalog/kv_code.cppm`（key 布局唯一权威）→ `src/storage/storage_impl.cpp:232` 的 `Storage::AdminToWriter`（启动装配全链）
- **第四遍：选择模块深入**（本系列 12 篇模块文档按兴趣进入；推荐顺序：08 事务 → 05 执行器 → 11 全文检索 → 10 向量检索——前两篇是正确性骨架，后两篇是检索特色的精华）

---

## 附录

### 术语表

| 术语 | 解释 |
|---|---|
| NewTxn | 2025-05 重写的事务系统：RocksDB 目录 + KV 版本键 MVCC + txn store 冲突检测（旧系统是内存 catalog 树 + delta 序列化） |
| Top/Bottom 提交 | 上半部（冲突检测+元数据，多线程）与下半部（数据 Apply，按表分区并行）的两半提交 |
| Fragment / FragmentTask | 物理树的并行切片 / 每 fragment × 并行度一个的 worker 执行单元 |
| morsel | 并行任务的最小数据单元（TableScan 的 GlobalBlockID 列表） |
| MemIndex / chunk | 未 seal segment 的内存索引 / 一次 dump 的索引产物（.pos/.dic/.len） |
| fast_rough_filter | zone map + bloom 粗滤，带 build_time 安全阀（宁可漏剪不可误剪） |
| late interaction | ColBERT 式多向量检索：query token 与 doc token 的 MaxSim 逐对交互 |
| RRF | Reciprocal Rank Fusion，`Σ 1/(k + rank)` 的名次融合（k=60 对齐 ES） |
| BlockMax WAND | 块级分数上界驱动的 TopK 早停算法（posting 块携带 block_max_tf/percentage） |
| PGM | Piecewise Geometric Model learned index（二级索引用） |

### 参考资料

- [Infinity 官方文档](https://infiniflow.org/docs/dev/)（Quickstart / Python API / HTTP API / Benchmark）
- [Infinity Roadmap 2025](https://github.com/infiniflow/infinity/issues/2393)
- 源码内嵌文档：`wal_manager_impl.cpp:551-586`（WAL 恢复 ASCII 图）、`fragment_builder_impl.cpp:149-155`（聚合 fragment 结构注释）、`new_txn.cppm:170-177`（事务步骤注释）
- 算法论文：EMVB（SIGIR'24）、PLAID（微软 next-plaid）、HNSW（Malkov & Yashunin）、Block-Max WAND（Ding & Suel）
- 上游姊妹项目：[RAGFlow](https://github.com/infiniflow/ragflow)（RAG analyzer 的来源）
