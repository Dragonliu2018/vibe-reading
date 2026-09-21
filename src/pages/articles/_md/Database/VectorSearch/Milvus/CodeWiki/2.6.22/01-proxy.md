---
source:
  type: "源码解读"
  project: "Milvus"
  url: "https://github.com/milvus-io/milvus"
title: "Proxy 接入层"
date: "2026-09-21T23:07:27+08:00"
category: [Database, VectorSearch, Milvus, CodeWiki, "2.6.22"]
contentType: "CodeWiki"
tags: ["Milvus", "Go", "gRPC", "负载均衡"]
description: "Milvus Proxy 解读——127 个 RPC 的统一接入、十层 interceptor 链、search_pipeline 黑板 DAG、k 路归并算法、MetaCache 失效广播与无状态水平扩展设计"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/00-overview)

---

## 模块定位

`internal/proxy/`（112 文件 56K 行）是系统的统一接入层：127 个 RPC 方法实现 `milvuspb.MilvusServiceServer`（DDL/DML/DQL/RBAC/运维）+ `proxypb.ProxyServer`（内部通知），外加 gin 实现的 RESTful v2。Proxy 的存在让系统其余部分不必关心协议、鉴权、限流、路由——**这些横切关注点全部收敛在一个无状态层**，因此可以前置 LB 任意扩容。

## 模块架构

`Proxy` struct（`proxy.go:80`）的关键字段体现 v2.6 的变化：不再是五个独立协调者客户端，而是一个 **`mixCoord types.MixCoordClient`**（四合一接口，`internal/types/types.go:279`）——Root/Data/Query 协调者进程合并的 mixcoord 部署形态下位置透明。其余：`chMgr`（channel 管理）、`sched`（四队列任务调度器）、`rowIDAllocator/tsoAllocator`（向 mixcoord 预取全局 ID 与时间戳——**insert 的 PK 由 Proxy 生成**）、`shardMgr + lbPolicy`（QueryNode 分片客户端 + 负载均衡，数据面直连不经协调者）、`simpleLimiter`（限流执行点）。

RESTful 层（`internal/distributed/proxy/httpserver/handler_v2.go`，147KB）**不是转发 gRPC，而是进程内直接复用同一组 Go handler**：HTTP JSON → 解析成 milvuspb proto → 直接调 impl.go 的方法（`handler_v2.go:594` 的 `h.proxy.HasCollection(...)`）；interceptor 语义经 `forwardHandler`（:551）手动重放——避免双轨维护漂移。

## 核心实现

### 十层 interceptor 链

`startExternalGrpc`（`internal/distributed/proxy/service.go:296`）用 `grpc_middleware.ChainUnaryServer` 组合：legacy 兼容 → DatabaseInterceptor（补默认 DB）→ 请求统计 → 访问日志 → **认证**（`authentication_interceptor.go`：base64 token，支持 API Key 与 username:password）→ **可插拔 hook**（`hook_interceptor.go`：Before/After/Mock 三钩子——企业审计/加密的扩展点）→ **授权**（`privilege_interceptor.go`：反射取 db/collection 名查权限缓存）→ trace logger → **限流**（`rate_limit_interceptor.go`：按 (dbID, collection, RateType, n) 检查令牌）→ 日志补全。顺序的 why：认证在授权与限流之前（先知道"你是谁"）；限流贴 handler（失败请求不计入配额，且已完成鉴权可按用户/集合维度限）。

**限流的决策与执行分离**：配额决策在 RootCoord 的 quota center，`SimpleLimiter.SetRates`（`simple_rate_limiter.go:194`）接收 coordinator 下发的多级 limiter 树（cluster→db→collection→partition），Proxy 只做本地令牌检查——规则全局一致而执行无中心瓶颈。

### task 体系：四队列调度

`task` 接口（`task.go:143`）生命周期 `OnEnqueue → PreExecute → Execute → PostExecute`，经 `TaskCondition`（sync.Cond）阻塞同步。调度器（`task_scheduler.go:449`）四条队列各一个 loop goroutine：ddQueue（DDL）/ dmQueue（DML，附带 pChan 统计）/ dqQueue（DQL）/ dcQueue（控制类）。**不是显式状态机**——同步语义由 Condition 提供。

### Search 链路：三阶段 + 黑板管线

`searchTask` 的 PreExecute 是"查询改写"发生地（`initSearchRequest` in `task_search.go:724`）：planparserv2 把 DSL/expr 解析成 `planpb.PlanNode`、抽 QueryInfo；partition key isolation 场景改写 queryInfo（设 Hints/`MaterializedViewInvolved=true`）；requery 策略（`HybridSearchRequeryPolicy`：always/outputfields/outputvector 三值）决定管线形态；结果集估算超过 `requeryThreshold = 0.5 * 1024 * 1024`（task_search.go:56）则发起第二次 query 取 output fields；placeholder 的 fp32→fp16/bf16 精度转换；非 BM25 的 embedding function（sparse UDF）在 Proxy 侧执行改写。

Execute 走 `lb.Execute`（`shardclient/lb_policy.go:333`）：从 shardMgr 缓存（来自 QueryCoord）拿 vchannel→leader 列表 → **每 channel 一个 goroutine** → balancer（look-aside/round-robin）在多个 replica leader 中选节点，失败 excludeNodes + 重试 → `searchShard`（`task_search.go:1153`）直接 `qn.Search` 打到该 channel 的 delegator。`NotShardLeader` 时 `DeprecateShardCache` 失效缓存重选。

**search_pipeline.go（1,860 行）是结果后处理 DAG 框架**：`operator` 接口 + `Node`（按声明的 inputs/outputs 名字在 `opMsg map[string]any` 黑板上传值）+ 11 种算子注册表（search_reduce/rerank/requery/organize/element_best_collapse/…）。**7 条内置管线**按 `(IsAdvanced, needRequery, functionScore)` 声明式选择——例如普通搜索是 `reduce → pick`，hybrid 搜索是 `reduce → element_best_collapse → rerank → element_key_restore → assemble`（最长 12 节点）。lambda 算子让粘合逻辑以内联闭包表达——**用组合式小算子替代以前巨型 if-else 的 PostExecute**。

### 结果归并：多指针 k 路归并

`reduceSearchResultDataNoGroupBy`（`search_reduce_util.go:392`）：预计算各子结果的 `subSearchNqOffset`（各分片 Topks 可不同）→ 对每个 query 维护 `cursors[subSearchNum]` → 每次在所有子结果的当前 cursor 处取 score 最大者（`selectHighestScoreIndex`，`search_reduce_util.go:649`）——**同分时用 `typeutil.ComparePK` 按 PK 更小者打破平局**，保证跨副本确定性。Search 场景各 channel 数据不相交（PK hash 分片）故无需显式去重；Query 场景的去重在 `reduceRetrieveResults`。GroupBy 变体（:218）多一层分组桶——offset 按"组"跳过、每组封顶 groupSize。Delegator 侧还有**预解码优化**：QueryNode 的 delegator 直接填 ResultData，Proxy 跳过 proto.Unmarshal（`decodeSearchResults`，大结果集下省一次反序列化）。

### DML 链路与水桶式 tick

v2.6 默认走 streaming WAL（`task_insert_streaming.go:23`）：`chMgr.getVChannels`（`DescribeCollection` + 本地缓存）→ `assignChannelsByPK`（`util.go:2496` 的 `HashPK2Channels` 按行选 channel）→ `repackInsertDataForStreamingService`（每 channel 构建带 `PartitionSegmentAssignment` header 的 InsertMessage；partition-key 模式再做第二级 `HashKey2Partitions`）→ `streaming.WAL().AppendMessages`，MaxTimeTick 作为 session 一致性返回时间戳。segment ID 由 streaming node 分配（注释明确）。

`channels_time_ticker.go:93 tick()`：每 interval 从 TSO 取 now，拉各 pchan 的 minTs/maxTs 统计，**只有当 `stat.minTs > current` 才推进到 `min(now+interval, stat.maxTs)`**（并记 `minTsStatistics[pchan] = stat.minTs - 1`——-1 保证边界包含；pchan 消失时 delete 两条 map、minTs 为零时 Warn 跳过）——水桶式推进：一个 channel 落后就拖住全局 tick，用于 Bounded Staleness 的 guarantee ts 计算。

### MetaCache：singleflight + 版本号失效

`globalMetaCache`（`meta_cache.go:55`）的读路径全部走 singleflight 防击穿；失效靠 RootCoord DDL 后经内部 gRPC 广播 `InvalidateCollectionMetaCache`（`impl.go:113`）——带 `collectionCacheVersion` 版本号守卫（**旧版本失效请求不会误删新版本缓存**——乱序 DDL 通知安全），Load/Release 后 shard leader 缓存同步失效。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 拦截器链 | `service.go:296`（10 层） | 横切关注点有序组合，HTTP 侧手动重放 |
| 黑板数据流 | `search_pipeline.go` 的 opMsg | 组合式后处理替代巨型 if-else |
| 模板方法 | task 四段（`task.go:143`） | 127 API 统一生命周期 |
| 策略 | `createMilvusReducer`（`reducer.go:16`：count 求和 vs limit 归并）+ LB balancer | 归并与选节点的多态 |
| singleflight + 版本失效 | `meta_cache.go` | 防击穿 + 乱序安全 |

## 模块间交互

向上服务 SDK（gRPC/RESTful）；向下经 `mixCoord` 接口访问协调者（位置透明）、经 `shardMgr/lbPolicy` **数据面直连 QueryNode**（查询热路径零协调者开销——QueryCoord 只在订阅路由元数据时参与）；WAL 写入经 streaming 层。MetaCache 的失效广播来自 RootCoord 的 ddl_callbacks（见 [RootCoord](/vibe-reading/articles/Database/VectorSearch/Milvus/CodeWiki/2.6.22/02-rootcoord)）。

## 扩展方式

**新增一种 API**：proto 仓库加 RPC → impl.go 入口方法（构造 task → 对应 queue Enqueue → WaitToFinish）→ `task_xxx.go` 实现四段 → 校验/限流映射/RBAC 权限项 → RESTful 的 request_v2/handler_v2。搜索类后处理优先在 search_pipeline 以 lambdaOp + nodeDef 组合而非改 PostExecute。
