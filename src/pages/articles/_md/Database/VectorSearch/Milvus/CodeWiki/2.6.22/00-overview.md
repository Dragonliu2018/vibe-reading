---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "Overview"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "C++", "向量数据库"]
description: "Milvus v2.6.22 源码架构解读——分布式向量数据库：Proxy 接入层、三大协调者（DDL 广播/checker 对账/compaction 调度）、StreamingNode WAL、delegator MVCC、C++ segcore 段引擎与 knowhere 的完整内幕"
readingTime: "32 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 2.6.22 · **协议** Apache-2.0 · **语言** Go（~1.49M 行，含测试）+ C++ core（~334K 行）· **仓库** [GitHub](https://github.com/milvus-io/milvus)
>
> **解读基线** commit [`830fdd6806`](https://github.com/milvus-io/milvus/commit/830fdd6806a057dd7d1ffd1b7b470df7e2af9186)（2026-08-20，v2.6.22 release commit；master 已领先 2100+ commit 开发 v3.x）

---

## 总览

### 项目简介

Milvus 是 LF AI & Data 基金会孵化的**云原生分布式向量数据库**——向量检索领域事实上的开源标杆（GitHub 30k+ star，Zilliz 商业化支撑）。它解决的问题是：把 embedding 模型产生的海量向量与标量数据组织起来，支撑"向量相似度检索 + 元数据过滤 + 全文检索"的混合查询，同时提供数据库级别的保障——分布式横向扩展、多副本容错、一致性等级、RBAC 权限。README 的定位："powers AI applications by efficiently organizing and searching vast amounts of unstructured data"，支撑场景从 RAG、图文检索到推荐系统。

核心价值三层：**规模**——存算分离架构（对象存储 + 无状态计算节点）横向扩展到十亿级向量，K8s 上万 QPS；**功能全**——稀疏向量（BM25/SPLADE）、全文检索、JSON 索引、空间索引、混合检索多路重排、多租户（database/partition/resource group 隔离）；**实时性**——growing segment + TSafe 水线让写入立即可查（对标"数据库"而非"搜索引擎"的批处理模式）。

**与引擎层的关系**（本系列 VectorSearch 组的递进）：Milvus 是"数据库"层——C++ segcore 之下是 **knowhere**（独立仓库，向量索引抽象与调度），knowhere 之下才是 [Faiss](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview) 与 [USearch](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/00-overview) 这类引擎内核。读完 Milvus 再回头看那两篇，"数据库 vs 库"的分工就完整了。

**项目当前边界**：Milvus 是数据库服务而非嵌入式库（嵌入式形态是独立的 Milvus Lite）；依赖外部基础设施——etcd（元数据）、对象存储（数据）、WAL 存储（woodpecker 自研或 pulsar/kafka）；不负责 embedding 计算（Function 机制可挂外部模型但主推用户侧生成）。

### 版本历史

- **2019.10** Milvus 1.0 开源（Zilliz）
- **2021.6** 2.0 重写：云原生 + 存算分离（growing/sealed 段、Parquet 列存、消息队列解耦）
- **2022.6** 捐赠 LF AI & Data 基金会
- **2023** 2.3：QueryCoord v2 重写（checker 对账架构）
- **2024-2025** 2.4/2.5：全文检索（Tantivy）、稀疏向量、CAGRA GPU 索引
- **2025-2026** **v2.6（本篇基线）**：流式架构改造——StreamingNode 统一 WAL、DDL 走广播 + Ack 回调、woodpecker 自研日志存储、DataNode 职责收缩
- master 已领先 2100+ commit 开发 v3.0（pkg/v3.0.0 tag 已打）

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| 统一接入 | `internal/proxy/`（127 个 RPC 方法） | gRPC + RESTful（复用同 handler）+ 认证/RBAC/限流 |
| 混合检索 | `proxy/search_pipeline.go`（7 条内置管线） | 向量 + 过滤 + rerank + requery 的算子 DAG |
| 实时可见 | QueryNode delegator + TSafe | growing 段 + MVCC 水线，写入立即可查 |
| 一致性等级 | guarantee_ts + waitTSafe | Strong/Bounded/Session/Eventually 四级 |
| DDL 广播 | `rootcoord/ddl_callbacks_*.go`（17 个文件） | v2.6：WAL 广播 + Ack 回调的幂等分布式事务 |
| Compaction | `datacoord/compaction_*` | L0 删除合并 / clustering 聚类重写 / 混合 |
| 全文检索 | C++ `index/TextMatchIndex` + Tantivy | BM25 + FM-Index + highlight |
| 索引族 | C++ `index/`（~70 文件） | 向量（knowhere）/ 标量 / JSON / 空间自研 |
| 流式 WAL | `streamingnode/` + woodpecker | v2.6 核心改造：统一 WAL 承载 |
| Bulk Import | `datanode/importv2/` | binlog/json/numpy/parquet/csv 五格式 |
| 多租户 | database / partition / resource group | 三层隔离粒度 |
| RBAC | `rootcoord/` + proxy privilege | 角色/权限组/备份恢复 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Go | 服务层 | 协调者 + 工作节点（~1.49M 行含测试） |
| C++（core） | 引擎层 | segcore/index/storage（~334K 行，独立构建经 cgo 链接） |
| knowhere | 子库（独立仓库） | 向量索引引擎（HNSW/IVF/DiskANN/CAGRA） |
| Tantivy | 子库（Rust） | 全文倒排索引 |
| etcd / TiKV | 元数据 | DDL 元数据、session、TSO |
| S3/MinIO/GCS/Azure | 对象存储 | binlog、索引、Parquet 列组 |
| woodpecker | 自研 WAL | v2.6 默认：对象存储上的共享日志 |
| Pulsar/Kafka/RocksMQ | 可选 WAL | 流式架构前的多后端 |
| cgo + loon FFI | 桥 | Go↔C++（segcore 入口 / Parquet packed reader） |

## 快速上手

Docker Compose 一键起 standalone（自带 etcd + MinIO + woodpecker）：

```bash
curl -sfL https://raw.githubusercontent.com/milvus-io/milvus/master/scripts/standalone_embed.sh -o standalone_embed.sh
bash standalone_embed.sh start
```

端到端验证（Python SDK）：

```python
from pymilvus import MilvusClient
import numpy as np

client = MilvusClient(uri="http://localhost:19530")
client.create_collection("demo", dimension=8)          # 自动 id + cos 度量

vectors = np.random.rand(10, 8).tolist()
client.insert("demo", [{"id": i, "vector": v} for i, v in enumerate(vectors)])
res = client.search("demo", [vectors[0]], limit=3,
                    filter="id >= 0")                    # 向量 + 标量过滤
assert len(res[0]) == 3
```

源码构建：`make`（拉子模块 + CMake 编 core + go build）——见 `DEVELOPMENT.md`。

## 架构设计解析

### 系统架构

Milvus 的设计哲学一句话：**数据面与控制面彻底分离，控制面内部再按"声明式对账"组织**。数据面（Proxy ↔ QueryNode 直连、WAL 写入）不走任何协调者——查询热路径零协调者开销；控制面（三大协调者）不直接执行而靠"期望状态 vs 实际状态"的周期 diff 收敛。v2.6 又叠加一层：**控制面自身的 DDL 也从同步 RPC 改走 WAL 广播**，把副作用顺序交给日志全序保证。

![Milvus 整体架构](/vibe-reading/images/articles/milvus-internals/architecture.svg)

![模块依赖与数据流](/vibe-reading/images/articles/milvus-internals/module-map.svg)

七类进程角色（`cmd/roles/roles.go` 的 MilvusRoles 环境变量开关，`runComponent` 泛型并发拉起）：Proxy（无状态接入）、RootCoord（元数据 + TSO）、DataCoord（数据调度）、QueryCoord（查询调度）、StreamingCoord（流式调度）、StreamingNode（WAL 承载）、QueryNode（查询执行）、DataNode（离线 worker）。**mixcoord** 把 Root/Data/Query/Streaming 四个协调者合体进单进程（standalone 形态）——关键设计：合体后组件间通信仍走 MixCoord gRPC 接口（`internal/coordinator/mix_coord.go:155`），代码路径与独立部署完全一致。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ---- | ------------- | ------------------------- |
| 接入层 | `internal/proxy/`（56K 行） | 无状态水平扩展的 API 网关：协议、鉴权、限流、路由、归并 |
| 协调层 | `rootcoord/`（24K）+ `datacoord/`（58K）+ `querycoordv2/`（34K）+ `streamingcoord/` | 全局决策：DDL、segment 生命周期、负载均衡、channel 分配 |
| 流式层 | `streamingnode/`（21K） | v2.6 新：WAL 统一承载，取代散布三处的 MQ 消费 |
| 执行层 | `querynodev2/`（36K）+ `datanode/`（21K） | 数据的在线服务与离线加工 |
| 引擎层 | C++ `internal/core/src`（334K） | 段引擎、算子执行、索引族——性能敏感的全部 |
| 基础设施 | `pkg/`（197K） | proto/kv/mq/对象存储/类型等公共库 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Reconcile 循环 | QueryCoord 的 checker 体系（`checkers/controller.go:68`） | 期望/实际状态 diff 收敛——幂等、抗事件丢失、v2 重写的核心思想 |
| WAL 广播 + Ack 回调 | `rootcoord/ddl_callbacks.go:35` | DDL 变幂等分布式事务：顺序由日志保证、回调可无限重试 |
| Delegator（分片代表） | `querynodev2/delegator/delegator.go:135` | shard 统一查询入口：TSafe 等待、growing/sealed 协调 |
| 拦截器链 | `internal/distributed/proxy/service.go:296`（10 层） | 认证→权限→限流的横切关注点有序组合 |
| 黑板数据流管线 | `proxy/search_pipeline.go`（11 种算子 + `opMsg map[string]any`） | 搜索后处理的组合式 DAG 替代巨型 if-else |
| 模板方法 | task 四段（OnEnqueue/Pre/Execute/Post） | 127 种 API 的统一生命周期 |
| 策略 + 工厂 | `balance.Balance` 5 实现 + AssignPolicy 3 实现 | 均衡算法运行时热切换 |
| COW 不可变元数据 | `meta.Replica` copy-on-write | 读写无锁竞争 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| Collection | 表（schema + 分区 + 索引定义） | DDL 广播创建 | 拥有 partition/channel |
| vchannel | 虚拟通道 = shard（数据分布最小水平单位） | 建表时 streaming balancer 分配 | insert 按 PK hash 路由 |
| Segment | 数据段（查询/加载的最小单位） | growing→sealed→flushed→indexed | 详见状态流 |
| Replica | collection 的一个完整服务副本组 | load 时按 resource group 创建 | 绑定 RG 与节点集 |
| delegator | shard 的 leader 查询入口（QueryNode 内） | watch channel 时确立 | 持 TSafe/distribution/delete buffer |
| Target vs Dist | 期望分布 vs 实际分布（QueryCoord） | 持续对账 | checker 的 diff 两端 |
| Timestamp | 混合逻辑时钟（46bit 物理 + 18bit 逻辑） | TSO 全局分配 | MVCC 的一致性锚 |
| binlog | 数据日志（insert/delta/stats/bm25 四类） | flush 产生 | 对象存储上的列式编码 |

#### 核心抽象

| 抽象 | 定义位置 | 实现 | 扩展点 |
|------|---------|------|--------|
| `task` 四段接口 | `proxy/task.go:46` | 127 种 API 任务 | 新 RPC |
| `ShardDelegator` | `delegator/delegator.go:72` | shardDelegator | 新查询类型 |
| `Balance` / `AssignPolicy` | `balance/balance.go:41` / `assign/` | 5 + 3 实现 | 新均衡策略 |
| `Checker` | `checkers/checker.go` | 5 类 | 新对账维度 |
| `Compactor` | `datanode/compactor/compactor.go` | mix/L0/clustering/sort | 新压缩类型 |
| `WAL` | `streamingnode/server/wal/` | woodpecker/pulsar/kafka/rocksmq | 新 WAL 后端 |
| C++ `Operator` | `exec/operator/Operator.h` | 9+ 算子 | 新物理算子 |
| `IndexFactory`（C++） | `index/IndexFactory.h` | knowhere + 自研索引族 | 新索引类型 |

## 代码目录

```shell
milvus/
├── cmd/roles/                 # 角色组合入口（MilvusRoles 环境变量开关）
├── internal/
│   ├── proxy/                 # 接入层（112 文件 56K 行）
│   ├── rootcoord/             # 元数据 + TSO（61 文件 24K）
│   ├── datacoord/              # 数据调度（118 文件 58K，最大 Go 模块）
│   ├── querycoordv2/           # 查询调度（99 文件 34K）
│   ├── streamingcoord/        # 流式调度（50 文件 7.4K）
│   ├── streamingnode/         # WAL 承载（141 文件 21K）
│   ├── querynodev2/           # 查询执行（99 文件 36K）
│   ├── datanode/              # 离线 worker（54 文件 21K）
│   ├── flushcommon/           # 共享 flush 逻辑（streamingnode/datanode 复用）
│   ├── compaction/             # compaction 共享工具
│   ├── metastore/              # etcd 元数据层（model + kv catalog）
│   ├── storage/ storagev2/    # Go 侧对象存储 + Parquet FFI
│   ├── tso/                    # 时间戳 Oracle（移植自 TiKV PD）
│   └── core/src（C++，334K 行） # segcore + exec + index + storage + mmap
├── pkg/                        # 公共库（proto/kv/mq/197K 行）
└── deployments/ scripts/ ci/  # 部署与 CI
```

## 模块地图

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| Proxy 接入层 | API/鉴权/限流/路由/归并 | `search()` in `proxy/impl.go:2990` | 无状态水平扩展的唯一流量入口 | [Proxy 接入层](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/01-proxy) |
| RootCoord 元数据 | DDL 广播 + TSO | `CreateCollection` in `rootcoord/root_coord.go:892` | 全局强一致决策的唯一源 | [RootCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/02-rootcoord) |
| DataCoord 数据调度 | segment/compaction/索引调度 | `compaction_inspector.go` | 写放大 vs 读放大 vs 空间三角的仲裁者 | [DataCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/03-datacoord) |
| QueryCoord 查询调度 | checker 对账 + 均衡 | `CheckersController` in `checkers/controller.go:68` | 期望/实际分离的声明式收敛 | [QueryCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/04-querycoord) |
| QueryNode 查询执行 | delegator + 段管理 + cgo | `shardDelegator.search` in `delegator/delegator.go:368` | 在线执行 + MVCC 语义 | [QueryNode](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/05-querynode) |
| Streaming 流式层 | WAL + flusher | `server/wal/` 接口族 | v2.6 核心改造：统一日志承载 | [Streaming](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/06-streaming) |
| Segcore 段引擎 | C++ 段/算子/执行 | `ChunkedSegmentSealedImpl` | 性能敏感的全部在这 | [Segcore](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/07-segcore) |
| 索引与存储 | 索引族 + binlog + 对象存储 | `IndexFactory`（C++） | 冷热分层与 mmap 的地基 | [索引与存储](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/08-index-storage) |
| DataNode 与公共库 | compaction 执行 + import + pkg | `compactor/executor.go` | 离线 worker + 基础设施 | [DataNode](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/09-datanode) |

## 运行时行为

### 启动流程

角色由 `cmd/roles/roles.go` 的环境变量组合（`runComponent` 泛型并发拉起全部组件，Prepare 完成后各自 Run）。以 cluster 模式的 QueryNode 为例（`querynodev2/server.go:314` Init）：etcd session → chunkManager → scheduler → cluster/delegators/Manager → dispClient → `initcore.InitQueryNode`（初始化 C++ segcore 与三级线程池）→ segcore 配置热更新 watcher。`WatchDmChannels`（`services.go:198`）是装配核心：建 delegator → pipelineManager.Add → loadL0/Growing → 消费 WAL 流 → delegator.Start。

### 核心运行流程

#### 读路径：Search 全链路

![Search 数据流](/vibe-reading/images/articles/milvus-internals/search-dataflow.svg)

文字描述：Proxy 的 interceptor 链（认证→权限→限流）后进 `search_pipeline` 的预处理（plan 解析、placeholder 精度转换、embedding function），对 collection 的**全部 vchannel 并行广播**（注意与写路径不同——insert 才按 PK hash 选 channel）经 LB 选每 channel 的 leader 副本**直连 delegator**（不经任何协调者）。delegator 是一致性核心：`waitTSafe`（`delegator/delegator.go:1052`——ContextCond 条件变量等待水线，含 stall 检测 failover）保证 guarantee_ts 之前的 WAL 数据已应用，MVCC 时间戳传给 C++ 段内过滤插入可见性。sealed 段按 worker 分组并行（knowhere 索引），growing 段固定本地（临时索引/暴力），两层归并后 Proxy 跨 shard 堆合并（`search_reduce_util.go:392` 的多指针 k 路归并，同分按 PK 破平局保确定性）。

#### 写路径：Insert → WAL → 对象存储

![写路径数据流](/vibe-reading/images/articles/milvus-internals/write-dataflow.svg)

文字描述：v2.6 的写路径核心是 StreamingNode——Proxy 按 PK hash 选 vchannel 后 `WAL().AppendMessages` 写入（`task_insert_streaming.go:23`）；flusher 消费 WAL 维护 growing segment 与 time tick（水线推进），增量 flush 策略（六种 SyncPolicy：满/陈旧带 10% 随机抖动防雪崩/封存/水位）落 binlog 到对象存储；DataCoord 登记 flushed segment 触发 QueryCoord load 与索引构建。DataNode 已收缩为离线 worker（旧 `FlushSegments`/`WatchDmChannels` 标记 Deprecated）。

#### DDL 路径：WAL 广播 + Ack 回调

![DDL 广播机制](/vibe-reading/images/articles/milvus-internals/ddl-broadcast.svg)

文字描述：v2.6 的 DDL 不再走内存任务队列——`CreateCollection` 构造消息广播到 streaming WAL 的控制 channel + 全部 vchannel，broadcaster 持久化 broadcast task 跟踪 ack 位图，**全部 ack 后才触发回调**（`ddl_callbacks_create_collection.go:95`：WatchChannels → meta 持久化 → ExpireCaches）。副作用顺序 = WAL 全序，故障恢复重放，ack 回调可无限重试——幂等是正确性前提（三防线：前置 `errIgnored` 检查、meta 层幂等、etcd 分批写序）。

### 状态流

![Segment 状态机](/vibe-reading/images/articles/milvus-internals/segment-lifecycle.svg)

Segment 生命周期是全系统最重要的状态机（DataCoord 元数据视角）：growing（内存可写）→ sealed（停止写入）→ flushed（binlog 持久化）→ indexed（索引构建完成）→ clustering 重写产物 / dropped。旁路有 L0 段（只存删除 delta，不可查询，由 L0 compaction 注入数据段）。查询侧的 TargetVersion 门控：LoadSegments 加载的 sealed 初始 `unreadableTargetVersion(-2)`，SyncTargetVersion 后才进可读集合——保证查询视图与 QueryCoord target 原子对齐。

## 典型修改场景

#### 场景 1：新增一种 DDL（如 v2.6 的 TruncateCollection 范式）

消息定义（streaming/util/message 的 BuilderV2）→ registry 槽位（`specialized_callback.go`）→ `ddl_callbacks_xxx.go`（广播函数 + ack 回调）→ `RegisterDDLCallbacks` 注册 → RPC 入口（`root_coord.go`）→ metastore 三层（model/catalog/kv_catalog）→ 幂等哨兵。新 DDL 天然获得 WAL 顺序、资源键互斥、故障重放、缓存失效。

#### 场景 2：新增一种均衡策略

实现 `balance.Balance` 接口（`BalanceReplica` + `GetAssignPolicy`）→ 常量注册 → `BalancerFactory.GetBalancer()` switch 加分支（`balance/balancer_factory.go`）——运行时改 `queryCoord.balancer` 参数即可热切换。评分函数在 `assign/` 包正交扩展（2.6.22 把 assign 从 balance 拆出的目的）。

#### 场景 3：新增一种查询类型

proto 加 RPC → delegator 接口加方法（复用 `speedupGuranteeTS` + `waitTSafe` + `organizeSubTask` 三件套，照 `Query` in `delegator.go:667` 骨架）→ Worker 抽象（`cluster/worker.go`）双实现 → `tasks/` 新 Task 实现 scheduler.Task → C++ 需要则加 cgo 封装。

## 测试体系

```
tests/            # e2e（Python，gtest 框架按功能分目录）
internal/**/*_test.go   # Go 单测（mock 完整——.mockery.yaml 驱动生成）
internal/core/unittest/ # C++ 单测（segcore/index/exec 逐模块）
internal/core/src/**/*Test.cpp  # 就地测试（与实现同目录）
```

特点：**mock 体系工程化**（`.mockery.yaml` 声明式生成全部接口 mock）；QueryCoord 的 balance 测试用 56K 行表格驱动；`tests/` 的 e2e 覆盖部署形态组合。想理解某模块，`*_test.go` 的测试用例即"可执行文档"。

## 阅读源码推荐路线

- 第一遍：理解一次查询
  `internal/proxy/impl.go` 的 `search()`（2990）→ `task_search.go` 的三阶段 → `shardclient/lb_policy.go` 的路由 → `querynodev2/services.go:827` → `delegator/delegator.go:447`（waitTSafe）
- 第二遍：理解数据组织
  `datacoord/segment_meta.go` 的状态机 → `flushcommon/writebuffer/sync_policy.go`（六种刷盘策略）→ `datanode/compactor/mix_compactor.go:328`（压缩主流程）
- 第三遍：理解分布式机制
  `rootcoord/ddl_callbacks.go:35`（注册面）+ `ddl_callbacks_create_collection.go`（一个完整 DDL）→ `querycoordv2/checkers/controller.go:68` → `internal/tso/tso.go:66`（时间戳 Oracle）
- 第四遍：进入 C++ 引擎
  `internal/core/src/segcore/SegmentInterface.h`（段契约）→ `exec/operator/VectorSearchNode.cpp` → `index/IndexFactory.h`（索引族注册）→ 对照 [Faiss](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview) 读 knowhere 之下的世界

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| vchannel / pchannel | 虚拟/物理通道——shard 的逻辑名与 MQ 物理名 |
| growing / sealed / flushed | 段三态：内存可写 / 停写待刷 / 已持久化 |
| L0 segment | 只存删除 delta 的段（未持久化删除的落盘形态） |
| delegator | shard leader 上的查询入口（TSafe/distribution/delete buffer） |
| TSafe | 分片水线时间戳：≤ 它的 WAL 消息保证已应用（MVCC 锚） |
| guarantee_ts | 查询一致性目标时间戳（四级一致性只影响这一处） |
| target / dist | QueryCoord 的期望分布 / 实际分布（checker 的 diff 两端） |
| compaction | 段合并重组：L0 删除注入 / clustering 聚类重写 |
| mixcoord | Root+Data+Query+Streaming 协调者合体的单进程形态 |
| binlog / deltalog / statslog | 插入日志 / 删除日志 / PK 统计日志 |
| knowhere | Milvus 的向量索引引擎（独立仓库，委托 faiss 等） |
| woodpecker | v2.6 自研的面向对象存储 WAL |
| broadcast task | DDL 广播任务（broadcaster 持久化跟踪 ack） |
| TSO | Timestamp Oracle（移植自 TiKV PD） |

### 参考资料

- [Milvus 官方架构文档](https://milvus.io/docs/architecture_overview.md)
- [Wang et al., Milvus: A Purpose-Built Vector Data Management System (SIGMOD 2021)](https://dl.acm.org/doi/10.1145/3448016.3457550)——2.0 架构论文
- [Milvus GitHub Discussions](https://github.com/milvus-io/milvus/discussions)（v2.6 streaming 改造的设计讨论）
- [knowhere](https://github.com/zilliztech/knowhere)（索引引擎）、[woodpecker](https://github.com/zilliztech/woodpecker)（WAL）
- 本系列前作：[Faiss CodeWiki](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)、[USearch CodeWiki](/vibe-reading/articles/Database/VectorSearch/USearch/CodeWiki/2.26.2/00-overview)
