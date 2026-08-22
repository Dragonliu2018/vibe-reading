---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "存储引擎"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "StorageServer", "MVCC", "Redwood", "VersionedBTree", "FastAlloc"]
description: "存储引擎——StorageServer MVCC 内存 + pull TLog + Redwood(VersionedBTree) 持久化，FDB 数据最终落盘与读写服务的地方。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`storageserver/` + `kvstore/`（合计 ~48k 行）是 FDB 数据最终落盘与读取服务的地方。StorageServer 从 TLog 主动 pull mutation 应用到本地引擎、提供 key range 读写服务、维护版本可见性（MVCC）。底层 KVStore 是可插拔存储引擎，主要有 Redwood（自研 VersionedBTree）、Memory、RocksDB。**关键洞察**：Redwood 引擎本身不保留多版本——只存最新 committed version；MVCC 完全由 StorageServer 内存层的 `versionedData` 处理。

## 模块架构

- **StorageServer**（`storageserver.cpp:849`）——存储层数据中心，struct 由 Flow actor 驱动（非线程）。`using VersionedData = VersionedMap<KeyRef, ValueOrClearToRef>`。核心字段按职责分组：版本管理（`lastTLogVersion`/`version`/`prevVersion`/`oldestVersion`/`durableVersion`/`knownCommittedVersion`，多为 `NotifiedVersion`）、内存 MVCC（`versionedData` 基于 PTree 的 `VersionedMap`、`mutationLog`）、TLog 拉取（`tag`/`history`/`logSystem`/`logCursor`）、存储引擎（`StorageServerDisk storage`）、分片（`KeyRangeMap<Reference<ShardInfo>> shards`、`CoalescedKeyRangeMap<Version> newestAvailableVersion`）。
- **IKeyValueStore**（`kvstore/include/fdbserver/kvstore/IKeyValueStore.h:47`）——存储引擎抽象接口：`set/clear/commit/readValue/readValuePrefix/readRange/getStorageBytes/init`。注释（`:143-158`）定义**因果一致性并发契约**：commit 之后的 read 能看到、commit 前看不到——无锁 MVCC 基础。工厂 `openKVStore(storeType,...)`。
- **VersionedBTree**（`kvstore/VersionedBTree.cpp:4787`）——Redwood 引擎：`IPager2* m_pager`、`MutationBuffer m_pBuffer`（`std::map<KeyRef, RangeMutation>`，commit 前 buffer）、`BTreeCommitHeader`（root/height/lazyDeleteQueue）。`commit(Version v)`、`set/clear`、`setOldestReadableVersion`。
- **KeyValueStoreRedwood**（`:7610`）——`IKeyValueStore` 适配器，`commit()` 调 `m_tree->commit(m_nextCommitVersion)` 后立即 `setOldestReadableVersion(next)`——只存单版本。
- **KeyValueStoreMemory**（`KeyValueStoreMemory.cpp:40`）——内存 `RadixTree` + DiskQueue 持久化，单版本无 MVCC。
- **StorageServerDisk**（`:594`）——引擎包装器：`makeVersionMutationsDurable`/`makeVersionDurable`/`readValue`/`readRange`。
- **IPager2**（`kvstore/IPager.h:625`）——pager 接口：`newPageID`/`atomicUpdatePage(reason,level,pageID,data,v)`/`freePage(pageID,v)`/`commit(v,record)`/`getReadSnapshot(v)`/`getOldestReadableVersion`。`DWALPager` 是实现，提供 MVCC 页面管理，但 Redwood 用它时每次 commit 后立即推进 oldest readable，只留单版本。

## 调用链路

客户端 get(key) → StorageServer 查询：

```text
serveGetValueRequests()  [storageserver.cpp:11617]  从 ssi.getValue.getFuture() 取请求流
  └→ getValueQ(data, req)  [:2134]
      ├─ co_await getQueryDelay()  降优先级
      ├─ co_await getReadLock(req.options)  PriorityMultiLock 读锁
      ├─ version = co_await waitForVersion(data, commitVersion, req.version)  [:2030]
      │   ├─ req.version < oldestVersion? → throw transaction_too_old()
      │   ├─ req.version <= version? → 返回（版本已就绪）
      │   └─ else co_await version.whenAtLeast(req.version)  等版本推进
      ├─ !shards[req.key]->isReadable()? → throw wrong_shard_server()
      └─ 读数据（两路径）:
          Path 1: versionedData 有该 key mutation
            i = data().at(version).lastLessOrEqual(req.key) → 直接从内存 MVCC 读
          Path 2: versionedData 无 mutation
            storage.readValue(req.key) 从引擎读
            验证 version >= storageVersion() + shardChangeCounter 未变
          组合: storage[k] @ storageVersion + versionedData.at(v)[k] = database[k] @ v
```

TLog mutation → StorageServer pull → apply → persist：

```text
storageServerCore()  [storageserver.cpp:12128]  race(doUpdate/dbInfoChange/actors)
  dbInfo 变化: logSystem = makeLogSystemConsumerFromServerDBInfo
    logCursor = logSystem->peekSingle(thisServerID, version+1, tag, history)  [:12210]
  ▼
update(data)  [:9595]
  ├─ e-brake: queueSize >= STORAGE_HARD_LIMIT_BYTES 暂停拉取
  ├─ cursor->getMore() 从 TLog 拉 mutation 批次
  ├─ 第一遍: 收集 eager reads（原子操作需读旧值）→ doEagerReads
  ├─ 第二遍: StorageUpdater.applyMutation()  [:9294]
  │   currentVersion != ver? → mutableData().createNewVersion(ver)  在 VersionedMap 建新版本
  │   私有数据? → applyPrivateData()（分片分配/迁移）
  │   否则 splitMutation 按 shard 边界拆分 → applyMutation  [:6278]
  │     SetValue → data.insert(key, value); ClearRange → data.insert(key, clearTo(end))
  ├─ 推进版本: version.set(ver) 触发 waitForVersion 等待者
  │   desiredOldestVersion.set(version - MAX_READ_TRANSACTION_LIFE_VERSIONS)
  └─ logCursor->advanceTo(cursor->version())
  ▼
updateStorage(data)  [:10310]  与 update() 并行
  └─ while: 分批落盘
      storage.makeVersionMutationsDurable(...)  [:10891]
        从 mutationLog 取 (prevStorageVersion, newStorageVersion] mutations → storage->set/clear
      mutableData().forgetVersionsBeforeAsync(newOldestVersion)
      oldestVersion.set(newOldestVersion)
      changeDurableVersion  [:6097]  从 versionedData.latest 删已落盘 entry
      storage.makeVersionDurable + storage.commit()  引擎 commit
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `storageServerCore` | `storageserver.cpp:12128` | 主循环 |
| `update` | `:9595` | 从 TLog pull + apply |
| `applyMutation` | `:6278` | 应用单条 mutation 到 VersionedMap |
| `updateStorage` | `:10310` | 持续落盘 |
| `makeVersionMutationsDurable` | `:10891` | mutationLog → 引擎 set/clear |
| `changeDurableVersion` | `:6097` | 回收已落盘内存版本 |
| `getValueQ` | `:2134` | 读请求处理 |
| `waitForVersion` | `:2030` | 等版本就绪，判 too_old |
| `VersionedBTree::commit` | `VersionedBTree.cpp:4787` | Redwood 提交 |
| `incrementalLazyClear` | `:4971` | 异步释放旧页面 |
| `openKVStore` | `IKeyValueStore.h:180` | 引擎工厂 |
</details>

## 核心实现

### MVCC（多版本可见性）

`VersionedData versionedData`（`:880`）是基于 PTree（不可变持久化搜索树）的 `VersionedMap`（`fdbclient/include/fdbclient/VersionedMap.h:739`）。每次 `createNewVersion(ver)` 创建新根节点，旧版本经共享节点 O(log n) 空间。可见性规则（`:853-878` 注释）：`versionedData` 含 `[storageVersion, version]` 区间 mutation；对 readable shard 中 key k，在版本 v：`storage[k] + versionedData.at(v)[k] = database[k] @ v`。旧版本经 `forgetVersionsBefore()` 回收。存储引擎层不保留多版本——只存 `oldestVersion` 时刻快照，MVCC 完全在 StorageServer 内存层。

### 存储引擎抽象

`IKeyValueStore`（`IKeyValueStore.h:47`）统一接口，实现有 `KeyValueStoreRedwood`（自研 B-tree via DWALPager）、`KeyValueStoreMemory`（RadixTree + DiskQueue）、`KeyValueStoreRocksDB`、`KeyValueStoreSQLite`。`openKVStore(storeType)` 工厂选择，`StorageServerDisk` 统一包装对 StorageServer 透明。新引擎无需实现 MVCC，只需满足因果一致性契约。

### Pull 模型（主动拉取）

StorageServer 不被动接收，而是主动 `peekSingle`（`:12210`）TLog。`LogSystemConsumer` + `IReplayPeekCursor` 拉取指定 tag 的 mutation，`update()` 在主循环反复调用。原因：**背压控制**——`queueSize >= STORAGE_HARD_LIMIT_BYTES` 时 e-brake 暂停拉取防 OOM；**持久化节奏解耦**——pull 与 commit 解耦，可 pull 多批后统一 commit；**故障恢复简化**——只记 `version`+`history`，故障后从 `version+1` 重新 peek；**多 TLog 支持**——`LogSystemConsumer` 从多 TLog 按 tag 拉取。

### VersionedBTree（Redwood）

`VersionedBTree`（`:4787`）的 MVCC 在 pager 层：`DWALPager` 经 `atomicUpdatePage(reason, level, pageID, data, v)` 写新版本页面，`getReadSnapshot(v)` 返回版本 v 快照，旧页面 `oldestReadableVersion` 推进后经 `incrementalLazyClear`（`:4971`）异步释放。但当前使用（`KeyValueStoreRedwood::commit()` at `:7705`）每次 commit 后立即 `setOldestReadableVersion(next)`，只留单版本——pager 层 MVCC 能力主要用于 lazy clear 和 snapshot 读。`MutationBuffer`（`:5286`）按 key 组织 mutation，commit 时整体 flush。`BTreeCommitHeader` 含 root/height/lazyDeleteQueue。`RedwoodRecordRef::Delta`（`:4184`）用 4 种字段大小方案（3-8 字节）针对 FDB key/value 分布优化。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| MVCC 版本可见性 | `versionedData` in `:880`，`VersionedMap.h:739` | 无阻塞读，因果一致，快照隔离 |
| 存储引擎抽象 | `IKeyValueStore.h:47` | 接口+多实现，工厂选择 |
| Pull 模型 | `peekSingle` in `:12210` | 背压控制、节奏解耦、恢复简化 |
| Versioned B-tree | `VersionedBTree.cpp:4787`、`IPager2` | pager 层 MVCC + lazy clear |
| 对象池 | `FastAllocator` | 高频小对象无锁分配 |

## 模块间交互

依赖 fdbrpc/flow/kvstore。被 fdbclient（直接读写 via loadBalance）、TLog（消费 mutation）、DataDistributor（分片迁移）。StorageServer 经 `addStorageServer(cx, ssi)` 注册获分配 `Tag`，决定 TLog 中哪些 mutation 归本 SS 消费；`peekSingle(thisServerID, version+1, tag, history)` 用 tag + history（版本-tag 对，跨 recovery 连续性）从 TLog 拉取。`dbInfo` 变化（recovery）时重建 `logSystem` 重新 peek。DataDistributor 经系统 key（`serverKeysPrefixFor(ssID)`）通知 SS 负责新 range，作为"私有 mutation"经 TLog 传递触发 `changeServerKeys`/`fetchKeys`。

## 扩展方式

新增存储引擎：实现 `IKeyValueStore` 所有纯虚方法（`set/clear/commit/readValue/readValuePrefix/readRange/getStorageBytes/getType/init`），在 `IKeyValueStore.h` 加工厂声明、`openKVStore` 加分支，可选 `checkpoint/restore/shardAware/addRange/removeRange`。**无需实现 MVCC**——但必须满足因果一致性契约。修改 MVCC 可见性：改 `waitForVersion`（`:2008`）与 `getValueQ` 读取逻辑（`:2188`），但会影响 `newestAvailableVersion` 与 `changeDurableVersion` 回收逻辑。修改 Redwood lazy delete：改 `incrementalLazyClear`（`:4971`）循环条件/退出判断，注意不影响 commit 关键路径延迟与 `freeBTreePage`（`:5994`）正确性。
