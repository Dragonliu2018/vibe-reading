---
source:
  type: "源码解读"
  project: "Cube"
  url: "https://github.com/cube-js/cube"
title: "查询编排器"
date: "2026-08-17T22:20:51+08:00"
category: [Database, Ecosystems, Cube, CodeWiki, "1.7.20"]
tags: ["Cube", "TypeScript", "预聚合", "缓存", "查询队列"]
description: "预聚合匹配、三层缓存与查询并发控制"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Cube/CodeWiki/1.7.20/00-overview)

---

## 模块定位

`cubejs-query-orchestrator` 是 Cube.js 架构的**执行层**——当上游的 `schema-compiler` 已经把语义查询编译成 SQL、`api-gateway` 已经完成鉴权与归一化后，真正决定"这条查询走预聚合还是原始表、命中哪层缓存、何时排入并发队列、何时让客户端继续等待"的，就是这个模块。

它对外只暴露一个编排入口 `QueryOrchestrator`，对内协调三条职责主线：

- **预聚合匹配与刷新**——判断查询能否被预聚合表加速，命中则替换表名，未命中则后台构建；
- **三层缓存**——进程内 LRU、跨进程 cacheDriver（Local / CubeStore）、预聚合表，逐层兜底；
- **查询队列与并发控制**——按 dataSource 分队列、优先级排序、去重、心跳、孤儿清理，并通过 `ContinueWaitError` 把长查询从同步 HTTP 中解放出来。

模块规模 6,152 行 TS、19 文件，全部集中在 `packages/cubejs-query-orchestrator/src/orchestrator/`。它**不直接 import** `schema-compiler`——编译器产出的 `PreAggregationDescription` / `QueryBody` 由 `server-core` 的 `OrchestratorApi` 作为参数传入，保持了"语义定义"与"执行策略"的单向依赖。

---

## 模块架构

内部围绕 `QueryOrchestrator` 的三个协作者展开，各司其职又相互回调：

```
                        QueryOrchestrator  (编排入口)
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
   PreAggregations       QueryCache              (driverFactory)
   (预聚合构建/匹配)      (结果缓存+队列调度)        BaseDriver 实例
        │                     │
        ▼                     ▼
   PreAggregationLoader   QueryQueue  ◄── createQueue 工厂
   PreAggregationPartition  │
   RangeLoader             ├─ BaseQueueDriver (抽象)
        │                  │    └─ LocalQueueDriver
        ▼                  │        └─ LocalQueueDriverConnection
   PreAggregationLoadCache ├─ CacheDriverInterface
   (version entries 索引)  │    └─ LocalCacheDriver / CubeStoreCacheDriver
                           │
                           └─ memoryCache (LRU, max 10000)
```

**组件协作关系**：

- `QueryOrchestrator.fetchQuery` 是主入口，先调 `PreAggregations.loadAllPreAggregationsIfNeeded` 确保预聚合表就绪，再调 `QueryCache.cachedQueryResult` 走缓存/查询。
- `PreAggregations` 持有**两个独立队列**：构建队列（concurrency=1，避免同一预聚合并发构建）和 loadCache 队列（concurrency=4，并行加载表元数据）。
- `QueryCache` 持有查询队列（concurrency 默认 2），并通过 `createQueue` 静态工厂把执行回调注入队列，让 `QueryQueue` 不感知业务语义。
- `DriverFactory` 是函数式工厂 `() => BaseDriver`，按 dataSource 创建不同驱动；`factoryQueueDriver` 按 `cacheAndQueueDriver` 字符串决定队列/缓存的底层实现（`memory` 或 `cubestore`）。

这种划分让"匹配策略""缓存策略""并发策略"三者可独立演进——例如换 Redis 队列只需新增 `QueueDriver` 实现，不动匹配逻辑。

---

## 调用链路

一次 REST `/load` 请求进入 `OrchestratorApi.executeQuery` 后的完整链路：

```
OrchestratorApi.executeQuery(query)              [OrchestratorApi.ts:73]
  │  pt.timeout(fetchQuery, continueWaitTimeout*1000)   ← 10s 超时闸门
  ▼
QueryOrchestrator.fetchQuery(queryBody)          [QueryOrchestrator.ts:212]
  │
  ├─► PreAggregations.loadAllPreAggregationsIfNeeded(queryBody)  [PreAggregations.ts:509]
  │     │  对每个 preAggregation 顺序执行 (reduce 链):
  │     ├─► PreAggregationPartitionRangeLoader.loadPreAggregations()  [:224]
  │     │     ├─ [有 partitionGranularity] → partitionRanges() → 每分区独立 loader
  │     │     └─ [无] → new PreAggregationLoader(...).loadPreAggregation()
  │     │           ├─► getVersionEntries() → byStructure 命中?
  │     │           │    ├─ 命中 → 返回 targetTableName + 后台异步 renew
  │     │           │    └─ 未命中 → loadPreAggregationWithKeys()  [PreAggregationLoader.ts:211]
  │     │           │         ├─► byContent 命中 && !forceBuild → 返回已有 ★最优
  │     │           │         ├─► byStructure 命中 && !waitForRenew → 返回旧 + scheduleRefresh()
  │     │           │         └─► 需构建 → executeInQueue() → refresh() 三策略之一
  │     │           └─► 多分区 → UNION ALL 合并 → 返回 baseTargetTableName
  │     └─ 返回 { preAggregationsTablesToTempTables, values }
  │
  ├─► [rollupOnlyMode] 无预聚合 → 抛错
  │
  └─► QueryCache.cachedQueryResult(queryBody, preAggTablesToTempTables)  [QueryCache.ts:205]
        │
        ├─► replacePreAggregationTableNames(query, mappings)   [QueryCache.ts:209]
        │    (单遍 longest-first 正则替换，避免名称互为前缀时被破坏)
        │
        ├─ [must-revalidate]           → renewQuery() 同步刷新
        ├─ [默认]                      → renewQuery() + startRenewCycle() 后台续期
        ├─ [stale-while-revalidate]    → cacheQueryResult() + startRenewCycle()
        │
        └─► cacheQueryResult()  [QueryCache.ts:892]
             ├─► memoryCache.get(redisKey)      ← LRU 进程内缓存
             ├─► cacheDriver.get(redisKey)      ← Local / CubeStore
             ├─ [命中且未过期] → 返回 (+ 可选后台刷新)
             └─ [未命中/过期] → fetchNew()
                  └─► queryWithRetryAndRelease()  [QueryCache.ts:453]
                       └─► QueryQueue.executeInQueue('query', cacheKey, _query, priority)  [QueryQueue.ts:185]
                            ├─► queueConnection.getResult(queryKey)        ← 先查已有结果(去重)
                            ├─► queueConnection.addToQueue(keyScore, ...)  ← keyScore=time+(10000-priority)*1E14
                            ├─► reconcileQueue()  [QueryQueue.ts:543]
                            │    └─► processQuery() → client.query(sql)    ← driver 实际执行
                            │         ├─► queryTimeout() 包装 ─超时─► ⚡ TimeoutError  [QueryQueue.ts:614]
                            │         └─► setResultAndRemoveQuery()
                            └─► queueConnection.getResultBlocking(queryKeyHash)  [LocalQueueDriverConnection.ts:119]
                                 └─► Promise.race([result, continueWaitTimeout])
                                      ├─ [结果到达] → 返回
                                      └─ [10s 超时] → result=null
                                           └─► ⚡ throw ContinueWaitError()  [QueryQueue.ts:364]

  [⚡ ContinueWaitError / promise-timeout]      [OrchestratorApi.ts:123]
     ├─► resultFromCacheIfExists(query)         ← 尝试过期缓存兜底
     │    └─ [stale-if-slow + 有缓存] → 返回 { ...fromCache, slowQuery: true }
     └─► throw { error: 'Continue wait', stage: orchestrator.queryStage(query) }
          │                                     [QueryOrchestrator.ts:295]
          │  queryStage 检查:
          │  ├─ 预聚合队列 pending → 'Building pre-aggregation N/M: #index in queue'
          │  └─ 查询队列 pending   → '#index in queue' / 'Executing query'
          └─► 客户端轮询重试
```

**ContinueWaitError / TimeoutError 传播表**：

| 错误 | 抛出点 | 是否传播 | 客户端行为 |
|------|--------|---------|-----------|
| `ContinueWaitError` | `QueryQueue.executeInQueue:364`（getResultBlocking 超时） | 传播至 `OrchestratorApi` catch | 返回 `{error:'Continue wait', stage}`，客户端轮询 |
| `ContinueWaitError` | `startRenewCycle` / `scheduleRefresh` 中抛出 | **被 catch 并 log，不传播** | 后台静默重试 |
| `TimeoutError` | `QueryQueue.queryTimeout:614`（执行超时） | 传播，写入 `result.error` | 查询失败 |

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 职责 | 关键设计 |
|------|------|------|---------|
| `fetchQuery` | `QueryOrchestrator.ts:212` | 查询主入口 | 先预聚合后缓存，顺序不可颠倒 |
| `streamQuery` | `QueryOrchestrator.ts:192` | 流式查询 | 复用队列但走 stream 分支 |
| `queryStage` | `QueryOrchestrator.ts:295` | 查询队列阶段状态 | 区分预聚合/查询两种 pending |
| `loadAllPreAggregationsIfNeeded` | `PreAggregations.ts:509` | 预聚合加载编排 | reduce 链顺序执行，保证依赖 |
| `loadPreAggregationWithKeys` | `PreAggregationLoader.ts:211` | 三级匹配核心 | byContent→byStructure→从零构建 |
| `refresh` | `PreAggregationLoader.ts:465` | 预聚合刷新分发 | 三策略：StoreInSource/Write/ReadOnlyExternal |
| `cachedQueryResult` | `QueryCache.ts:205` | 缓存+查询主逻辑 | 按 cacheMode 分支选同步/异步刷新 |
| `cacheQueryResult` | `QueryCache.ts:892` | 底层缓存读写 | 三层逐级查找，过期+key 变更判断 |
| `replacePreAggregationTableNames` | `QueryCache.ts:417` | SQL 表名替换 | 单遍 longest-first 正则 |
| `executeInQueue` | `QueryQueue.ts:185` | 入队执行 | 去重+优先级+心跳+孤儿清理 |
| `reconcileQueueImpl` | `QueryQueue.ts:543` | 队列调度 | toProcessLimit 集群防竞争 |
| `dropOrphanedTables` | `PreAggregationLoader.ts:1021` | 孤立表清理 | withDropLock + 保留策略 |

</details>

---

## 核心实现

### 预聚合双层版本号匹配

预聚合表名编码三个版本号 `{table_name}_{content_version}_{structure_version}_{timestamp}`（`PreAggregations.ts:791` 的 `targetTableName`），这套命名是整个匹配机制的基石。

两个版本号的输入差异（`PreAggregationLoader.ts:375-388`）：

```typescript title="PreAggregationLoader.ts (content_version 计算)"
// content_version 含 invalidationKeys —— 数据变更时改变
contentVersion = version([
  loadSql, indexesSql, streamOffset, outputColumnTypes, invalidationKeys
]);
// structure_version 不含 invalidationKeys —— 仅结构定义变更时改变
structureVersion = version([
  loadSql, indexesSql, streamOffset, outputColumnTypes
]);
```

**为什么分两层**：预聚合的本质是"提前算好的聚合结果"。结构（用哪些维度、哪些聚合函数）变化频率低，而底层数据变化频率高。如果把数据和结构混在一个版本号里，每次数据刷新都得重建整张表，用户必须等待。分层后，`structure_version` 不变但 `content_version` 变化时，可以立即返回旧数据并后台刷新——这是 stale-while-revalidate 策略在预聚合层面的落地。

匹配在 `loadPreAggregationWithKeys`（`PreAggregationLoader.ts:211-365`）中按三级优先级进行：

1. **`byContent` 完全匹配** → 直接返回（数据最新）★最优覆盖
2. **`byStructure` 匹配但数据过期** → 返回旧数据 + 后台 `scheduleRefresh()`
3. **都不匹配** → 从零构建

第 2 级是关键：`versionEntryByStructureVersion` 命中时触发**异步** `loadPreAggregationWithKeys().catch()`（`:189-197`），不阻塞主请求。用户拿到的是结构正确但可能稍旧的数据，后台同时刷新到最新——对分析查询而言，这种"最终一致"的延迟完全可接受，却避免了同步等待构建的秒级延迟。

### 三层缓存架构

`QueryCache.cacheQueryResult`（`QueryCache.ts:892-1060`）实现了三层逐级兜底：

```
memoryCache (LRU, max 10000)   ← 进程内，最快
      │ 未命中
      ▼
cacheDriver (Local / CubeStore) ← 跨进程持久，TTL=expireSecs 默认 24h
      │ 未命中
      ▼
pre-aggregation 表              ← 物化在 CubeStore / 数据源的物理表
      │
      ▼
fetchNew() → QueryQueue → driver.query(sql)  ← 真正查源数据库
```

**inMemoryCacheDisablePeriod 竞态防护**（`QueryCache.ts:965`）：内存缓存有效期 = `5 * 60 * 1000`（5 分钟），但若 `renewalThreshold`（续期阈值）快到期，则**跳过内存缓存**直接查 cacheDriver。原因是：refreshKey 在执行过程中可能发生变化，如果临界点用了内存缓存，同一请求的不同 span 可能看到不同的 refreshKey 值，导致数据不一致。宁可慢一点走持久层，也要保证一致性。

**缓存失效判断**（`QueryCache.ts:1021-1049`）有三个维度：

- `isExpired` = 缓存时间超过 `renewalThreshold`
- `isKeyMismatch` = refreshKey 值变化（说明源数据变了）
- `isSameRequest` = 同一 requestId 的不同 span（`extractRequestUUID` 提取 uuid 部分）

**同请求 + 过期/key 变更**的处理最能体现一致性优先（`:1029-1035`）：返回旧缓存 + 后台 `fetchNew().catch()`，**不**同步 fetchNew。因为 refreshKey 正在变化说明数据正在更新，此刻 fetchNew 可能读到半新半旧的数据，不如返回完整的旧缓存。而**不同请求 + 过期 + waitForRenew** 才同步阻塞等待新数据——这是对"用户主动刷新"场景的响应。

**cacheMode 三策略**（`QueryCache.ts:285-378`）映射到不同的缓存行为：

| cacheMode | 行为 | 适用场景 |
|-----------|------|---------|
| `must-revalidate` | 同步 `renewQuery()`，总是取最新 | 对实时性要求高的查询 |
| 默认 | 同步刷新 + `startRenewCycle()` 后台续期 | 平衡实时性与性能 |
| `stale-while-revalidate` | 返回旧 + 后台异步刷新 | 容忍稍旧数据的高并发场景 |
| `stale-if-slow` | 仅在 ContinueWait 时兜底返回旧 | 慢查询降级 |

### 查询队列与并发控制

`QueryQueue`（`QueryQueue.ts:71`）是并发控制的枢纽，每个 dataSource 一个独立实例：

```typescript title="QueryQueue.ts"
protected concurrency: number = 2;           // 同时执行数
protected continueWaitTimeout: number = 10;  // 同步等待秒数
protected executionTimeout: number;          // = dbQueryTimeout
protected orphanedTimeout: number = 120;     // 孤儿超时
protected heartBeatInterval: number = 30;    // 心跳间隔
```

**优先级排序**用 `keyScore`（`QueryQueue.ts:255`）：

```typescript
keyScore = time + (10000 - priority) * 1E14;
```

priority 范围 -10000~10000，越高 score 越小越早处理。乘以 `1E14` 让优先级差异远大于时间戳差异，保证高优先级查询几乎总是先执行，而同优先级时按 FIFO（time）排序。

**去重**在 `LocalQueueDriverConnection`（`:178`）：相同 `queryKey` 只入队一次，后续请求共享同一结果 Promise。这天然解决了"多个用户同时查同一张报表"的并发放大问题。

**集群防竞争**（`QueryQueue.ts:570-576`）是生产环境的关键设计：

```typescript
toProcessLimit = active.length >= concurrency ? 1 : concurrency - active.length;
```

多节点共享队列（CubeStore 作为队列驱动）时，每个节点都会尝试拾取任务。如果每个节点都按 `concurrency` 拾取，N 个节点会同时抢走 N×concurrency 个查询，远超实际并发能力。限制每次 reconcile 只拾取 `concurrency - active` 个（已满时只取 1 个），最小化竞争浪费。

**心跳与孤儿清理**（`QueryQueue.ts:796-849`）：执行中的查询每 30s 更新心跳，`heartBeatTimeout = heartBeatInterval * 4`（120s）无心跳视为 stalled，自动恢复。心跳中还检查外部取消（`:819-846`），让 `cancelQueryByRequestId` 能及时生效。`orphanedTimeout`（120s）后彻底取消，防止僵尸查询占满队列。

**双层队列分离**是另一个关键设计：查询队列（`QueryCache.queue`，concurrency=2）和预聚合构建队列（`PreAggregations.queue`，concurrency=1）独立。构建是重操作，concurrency=1 避免同一预聚合并发构建（浪费且可能冲突）；查询是相对轻的操作，concurrency=2 允许一定并行。两者不互相阻塞——用户查询不必等待后台预聚合构建占满并发。

### 分区预聚合增量刷新

带 `partitionGranularity` 的预聚合（如按天分区）由 `PreAggregationPartitionRangeLoader`（`PreAggregationPartitionRangeLoader.ts:224`）处理，支持只刷新有新数据的分区而非整表重建。

```
loadPreAggregations()  [:224]
  │
  ├─► partitionRanges()  [:424]
  │     ├─► loadBuildRange()  [:459]   → 查数据源已有数据 [start, end]
  │     └─► intersectDateRanges(buildRange, matchedDateRange)  ← 取交集
  │
  ├─► timeSeries(partitionGranularity, dateRange, timestampPrecision)
  │     将范围切分为多个分区（day → 多个日期分区）
  │
  └─► 对每个 partitionRange 创建独立 PreAggregationLoader
        └─► 多分区结果 UNION ALL 合并  [:296-300]
              SELECT * FROM t1 UNION ALL SELECT * FROM t2 ...
```

**分区表命名**（`:556-576`）按时间粒度截断：`partitionTableName = tableName + dateRange[0].substring(0, dateLenCut).replace(/[-T:]/g, '')`。`hour`/`minute`/`day` 不同粒度截断长度不同，保证同分区文件名稳定可复用。

**`maxPartitions` 限制**（`:450-454`）：超过默认 10000 个分区直接抛错。这是防呆设计——配置错误（如把 `year` 误写成 `minute`）会指数级放大分区数，拖垮系统，早期 fail 比运行时崩溃友好。

**updateWindowSeconds 增量窗口**（`:160-186`）：`incremental` 预聚合在 `updateWindowToBoundary` 刚过时，使用更短的 `renewalThresholdOutsideUpdateWindow`。原因是服务器和 DB 时钟可能有微小偏差，update window 边界刚过的瞬间，DB 侧可能还没提交最新数据，缩短 renewal threshold 确保尽快感知并刷新到最新。

### ContinueWaitError 驱动轮询

Cube.js 把"长时间运行的查询"从同步 HTTP 请求中解放出来的核心机制，是 `ContinueWaitError` + `queryStage` 进度反馈的组合。

完整轮询流程：

1. `OrchestratorApi.executeQuery` 用 `pt.timeout(fetchQueryPromise, continueWaitTimeout * 1000)` 包装（`OrchestratorApi.ts:96`）
2. `QueryQueue.executeInQueue` 中 `getResultBlocking` 也用 `continueWaitTimeout` 做 `Promise.race`（`LocalQueueDriverConnection.ts:119-135`）
3. 超时后 `result = null` → `throw new ContinueWaitError()`（`QueryQueue.ts:364`）
4. `OrchestratorApi` catch 后（`:123`）两个分支：
   - `cacheMode = stale-if-slow` 且有过期缓存 → 返回 `{ ...fromCache, slowQuery: true }`
   - 否则 `throw { error: 'Continue wait', stage: await queryStage(query) }`
5. `queryStage`（`QueryOrchestrator.ts:295-341`）返回人可读的进度：
   - 预聚合正在构建 → `{ stage: 'Building pre-aggregation N/M: #index in queue' }`
   - 查询在队列中 → `{ stage: '#index in queue' }` 或 `{ stage: 'Executing query', timeElapsed }`

**为什么这么设计**：分析查询动辄几十秒甚至几分钟，同步占用 HTTP 连接会耗尽服务器资源、触发网关超时。`ContinueWaitError` 让 HTTP 请求在 10 秒内返回（带进度），查询在后台队列继续执行，客户端通过轮询获取最终结果和实时进度。这把"长查询"变成"短请求 + 后台执行 + 轮询"三段式，既不阻塞连接，又给用户透明的等待体验。

**`isJob` 标志**（`QueryQueue.ts:363`）跳过 `ContinueWaitError`——job 模式（如后台刷新调度）立即返回不等待，因为 job 自己有重试机制，不需要轮询。

**stale-if-slow 兜底**（`OrchestratorApi.ts:142-155`）：当缓存策略配置为 `stale-if-slow` 且查询超时时，返回过期缓存而非让用户干等。这对仪表盘场景极友好——宁可显示稍旧数据，也不让面板空白。

### 孤立表清理

每次构建新预聚合表后，`dropOrphanedTables`（`PreAggregationLoader.ts:1021-1088`）负责清理失败构建留下的半成品表，防止存储被占满。

**保留策略**（`:1067-1076`）：

- `dropPreAggregationsWithoutTouch && refreshEndReached` → 只保留 `tablesUsed + tablesTouched + justCreatedTable`
- 否则 → 保留 `tablesUsed + structureVersionsToSave + versionEntriesToSave + justCreatedTable`

**`structureVersionPersistTime`（默认 30 天）** 保留旧结构版本的表，是为了支持**回滚**：如果新版本预聚合有问题，可以回退到旧结构版本继续服务，而不必从零重建。这是用存储空间换可用性的权衡。

**`withDropLock`**（`:1021`）防止多节点并发 drop 导致的竞态——两个节点同时清理可能 drop 正在被另一个节点使用的表。加锁后差集计算与 drop 是原子的。

---

## 设计模式

| 模式 | 代码位置 | 为什么用 |
|------|---------|---------|
| **工厂模式** | `DriverFactory.ts:3` `DriverFactory` 函数式工厂；`QueryCache.createQueue` (`:607`) 静态工厂；`factoryQueueDriver` (`QueryQueue.ts:53`) | 按 dataSource/cacheAndQueueDriver 创建不同实现，创建逻辑与使用逻辑解耦 |
| **策略模式** | `PreAggregationLoader.refresh` (`:465`) 三策略：`refreshStoreInSourceStrategy`/`refreshWriteStrategy`/`refreshReadOnlyExternalStrategy` | 按 external/readOnly 选择刷新路径，避免 if-else 堆叠 |
| **队列/限流** | `QueryQueue` (`:71`) 优先级排序+去重+心跳+孤儿清理；双层队列分离 | 保护数据源不被并发打满，区分查询与构建的并发特征 |
| **多层缓存** | `QueryCache` (`:892`) memoryCache → cacheDriver → 预聚合表 | 逐级兜底，进程内最快、跨进程持久、物化表兜底 |
| **模板方法** | `PreAggregationLoader.runWriteStrategy` (`:608`) `prepare→download→upload→cleanup` 骨架；`loadPreAggregations` 有无 partition 两条路径 | 固化执行骨架，子步骤可变 |
| **观察者** | `QueryQueue.streamEvents` (`:108`) EventEmitter，`createQueryStream` emit `streamStarted` | 流式查询的生命周期事件解耦 |

---

## 模块间交互

**import 的 cubejs 包**：

| 包 | 用途 | 关键导入 |
|----|------|---------|
| `@cubejs-backend/base-driver` | 驱动/队列接口定义 | `BaseDriver`, `DriverInterface`, `CacheDriverInterface`, `QueueDriverInterface`, `QueueDriverConnectionInterface`, `QueryKey`, `QueryKeyHash` |
| `@cubejs-backend/cubestore-driver` | CubeStore 实现 | `CubeStoreDriver`, `CubeStoreCacheDriver`, `CubeStoreQueueDriver` |
| `@cubejs-backend/shared` | 共享工具 | `getEnv`, `LoggerFn`, `CacheMode`, `AsyncDebounce`, `getProcessUid`, `timeSeries` |

**被谁调用**：主要调用方是 `server-core` 的 `OrchestratorApi`（`packages/cubejs-server-core/src/core/OrchestratorApi.ts`），通过 `new QueryOrchestrator(...)` 构造，调用 `fetchQuery`/`streamQuery`/`queryStage`/`resultFromCacheIfExists`/`cancelQueryByRequestId`。`RefreshScheduler` 通过 `getQueryOrchestrator().getPreAggregations()` 直接访问预聚合队列调度刷新。

**关键边界**：本模块**不直接 import** `schema-compiler`。编译器产出的 `PreAggregationDescription` / `QueryBody` 由 `server-core` 作为参数传入，保持了"语义定义"与"执行策略"的单向依赖——编译器不知道执行细节，执行器不关心语义编译。

---

## 扩展方式

#### 新增队列驱动（如 Redis）

需改文件和函数：

1. **`QueryQueue.ts`** — `factoryQueueDriver` (`:53-69`)：添加 `case 'redis': return new RedisQueueDriver(...)`
2. **`QueryOrchestrator.ts`** — `detectQueueAndCacheDriver` (`:41-60`)：添加 Redis 探测；构造函数校验 (`:80-84`) 加入合法值
3. **新建 `RedisQueueDriver.ts`** — 继承 `BaseQueueDriver`，实现 `createConnection`/`release`
4. **新建 `RedisQueueDriverConnection.ts`** — 实现 `QueueDriverConnectionInterface`（参照 `LocalQueueDriverConnection.ts`），用 Redis 操作替代内存 Record
5. **`QueryCache.ts`** — 构造函数 (`:164-179`)：添加 `case 'redis'` 创建对应 CacheDriver

> 注意：`QueryOrchestrator.ts:80` 注释中 `'redis'` 标记为 `removed, used for exception`，说明 Redis 驱动曾存在但已移除，改用 CubeStore。重新引入需评估当初移除的原因。

#### 修改预聚合匹配策略

需改文件和函数：

1. **`PreAggregationLoader.ts`** — `loadPreAggregationWithKeys` (`:211-365`)：修改 `byContent`→`byStructure`→从零构建的三级逻辑，如新增 `byApproximate` 近似匹配
2. **`PreAggregations.ts`** — `getStructureVersion`/`version` (`:74-87`, `:28-60`)：修改版本号计算输入
3. **`PreAggregationLoader.ts`** — `contentVersion` (`:375-388`)：修改 content version 计算输入
4. **`PreAggregationLoadCache.ts`** — `calculateVersionEntries` (`:142-177`)：修改 version entry 索引方式

#### 新增流式结果处理

需改文件和函数：

1. **`QueryStream.ts`** — `_transform` (`:42-61`)：添加行级转换或 filter/aggregate
2. **`QueryQueue.ts`** — `processQuery` 中 `stream` case (`:853-868`)：修改 stream 创建和 pipe
3. **`QueryCache.ts`** — `createQueue` 中 `streamHandler` (`:660-710`)：修改源 stream 到目标 stream 的管道
4. **`QueryOrchestrator.ts`** — `streamQuery` (`:192-203`)：修改流式查询入口
5. **`StreamObjectsCounter.ts`** — 可扩展 `LargeStreamWarning`（超 100,000 行警告）或新增其他流监控 Transform
