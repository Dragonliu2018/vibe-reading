---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "存储引擎"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "7.4.6"]
tags: ["FoundationDB", "C++", "StorageServer", "MVCC", "Redwood", "VersionedBTree", "DWALPager"]
description: "存储引擎——StorageServer MVCC 内存 + pull TLog + Redwood(VersionedBTree) 持久化，FDB 数据最终落盘与读写服务的地方。"
readingTime: "40 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/7.4.6/00-overview)

---

## 模块定位

`fdbserver/storageserver.actor.cpp` + `fdbserver/VersionedBTree.actor.cpp` 是 FDB 数据最终落盘与读取服务的地方。StorageServer 从 TLog 主动 pull mutation 应用到本地引擎、提供 key range 读写服务、维护版本可见性（MVCC）。底层 KVStore 可插拔，主要有 Redwood（自研 VersionedBTree）、Memory、RocksDB。**关键**：Redwood 引擎本身不保留多版本——只存最新 committed version；MVCC 完全由 StorageServer 内存层的 `versionedData`（`VersionedMap`）处理。

## 模块架构

- **StorageServer**（`storageserver.actor.cpp:1026`）——存储层数据中心，struct 由 Flow actor 驱动。`using VersionedData = VersionedMap<KeyRef, ValueOrClearToRef>`。版本管理（`lastTLogVersion`/`version`/`prevVersion`/`oldestVersion`/`durableVersion`/`knownCommittedVersion`，多为 `NotifiedVersion`）、内存 MVCC（`versionedData` `:1057`、`mutationLog` `:1058`）、TLog 拉取（`tag`/`history`/`logSystem`/`logCursor`）、存储引擎（`StorageServerDisk storage`）、分片（`KeyRangeMap<Reference<ShardInfo>> shards`）。
- **IKeyValueStore**（`fdbclient/include/fdbclient/IKeyValueStore.actor.h:57`）——存储引擎抽象接口：`set/clear/commit/readValue/readValuePrefix/readRange/getStorageBytes`。工厂 `fdbserver/include/fdbserver/IKeyValueStore.h:30`（`keyValueStoreRedwoodV1`/`Memory`/`RocksDB`/`openKVStore` `:72`）。
- **VersionedBTree**（`VersionedBTree.actor.cpp:4883`）——Redwood 引擎：`IPager2* m_pager`、`MutationBuffer m_pBuffer`、`BTreeCommitHeader m_header`（`:4954`，含 root/height/lazyDeleteQueue）。`commit(Version v)`、`set/clear`、`setOldestReadableVersion`。
- **KeyValueStoreRedwood**（`:8017`）——`IKeyValueStore` 适配器，`commit()` 调 `m_tree->commit(m_nextCommitVersion)` 后立即 `setOldestReadableVersion(next)`——只存单版本。
- **StorageServerDisk**（`storageserver.actor.cpp:592`）——引擎包装器：`makeVersionMutationsDurable`（`:14043`）/`makeVersionDurable`/`readValue`/`readRange`。
- **IPager2 / DWALPager**（`fdbserver/include/fdbserver/IPager.h:754` 接口 + `VersionedBTree.actor.cpp:1912` 实现）——pager 层，`atomicUpdatePage`/`getReadSnapshot`/`commit`/`freePage`。DWALPager 通过页 ID 重映射实现原子页更新。
- **VersionedMap**（`fdbclient/include/fdbclient/VersionedMap.h:664`）——基于 PTree（treap 部分持久化树）的 MVCC，三指针机制（`child(which, at)` `:54`）实现 O(1) 空间节点插入。

## 调用链路

客户端 get(key) → StorageServer 查询：

```text
getValueQ(data, req)  [storageserver.actor.cpp:2524]
  ├─ co_await getQueryDelay()  降优先级
  ├─ co_await getReadLock(req.options)
  ├─ version = co_await waitForVersion(data, ..., req.version)  等 version 推进
  │   ├─ req.version < oldestVersion? → throw transaction_too_old()
  │   └─ else co_await version.whenAtLeast(req.version)
  ├─ !shards[req.key]->isReadable()? → throw wrong_shard_server()
  └─ 读数据:
      i = data().at(version).lastLessOrEqual(req.key)  # versionedData MVCC 快照
      path 1: i->isValue() && i.key()==key → 直接从内存返回
      path 2: 未命中/clear → storage.readValue(key) 从引擎读
              验证 version >= storageVersion() + shardChangeCounter 未变
      组合: storage[k] @ storageVersion + versionedData.at(v)[k] = database[k] @ v
```

TLog mutation → pull → apply → persist：

```text
storageServerCore()  [:15248]  choose(doUpdate/getValueQ/updateStorage/...)
  dbInfo 变化: logCursor = logSystem->peekSingle(thisServerID, version+1, tag, history)  [:15313]
  ▼
update(data)  [:12530]
  ├─ e-brake: queueSize >= STORAGE_HARD_LIMIT_BYTES 暂停拉取
  ├─ cursor->getMore() 从 TLog 拉 mutation 批次
  ├─ durableVersionLock.take()
  ├─ 第一遍: 收集 eager reads（原子操作需读旧值）→ doEagerReads
  ├─ 第二遍: StorageUpdater.applyMutation()  [:11927]
  │   currentVersion != ver? → mutableData().createNewVersion(ver)
  │   私有数据? → applyPrivateData()（分片分配/迁移）
  │   否则 splitMutation → applyMutation()  [:7938]
  │     SetValue → data.insert(key, value); ClearRange → data.insert(key, clearTo(end))
  │   同时 addMutationToMutationLogOrStorage() 追加到 mutationLog  [:14581]
  ├─ version.set(ver) 触发 waitForVersion 等待者
  │   desiredOldestVersion.set(version - MAX_READ_TRANSACTION_LIFE_VERSIONS)
  └─ logCursor->advanceTo(cursor->version())
  ▼
updateStorage(data)  [:13323]  与 update() 并行
  └─ loop: 分批落盘
      storage.makeVersionMutationsDurable()  [:14043]
        从 mutationLog 取 (prevStorageVersion, desiredVersion] mutations → writeMutations() [:14024] → storage->set/clear
      mutableData().forgetVersionsBeforeAsync(newOldestVersion)
      oldestVersion.set(newOldestVersion)
      storage.commit()  引擎提交
      storage.makeVersionDurable(newOldestVersion)  写 persistVersion key
      changeDurableVersion()  [:7734]  从 versionedData.latest 删已落盘 entry + 删 mutationLog 条目
      durableVersion.set(nextDurableVersion)
```

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `storageServerCore` | `storageserver.actor.cpp:15248` | 主循环 |
| `update` | `:12530` | 从 TLog pull + apply |
| `StorageUpdater::applyMutation` | `:11927` | 应用 mutation 到 VersionedMap |
| `applyMutation` | `:7938` | 写单条 mutation（set/clear） |
| `updateStorage` | `:13323` | 持续落盘 |
| `makeVersionMutationsDurable` | `:14043` | mutationLog → 引擎 set/clear |
| `writeMutations` | `:14024` | 遍历 mutation 调 storage set/clear |
| `changeDurableVersion` | `:7734` | 回收已落盘内存版本 |
| `getValueQ` | `:2524` | 读请求处理 |
| `readRange` | `:4270` | 范围读 |
| `VersionedBTree::commit` | `VersionedBTree.actor.cpp` | Redwood 提交 |
| `DWALPager::atomicUpdatePage` | `:1912` | 页重映射原子更新 |
| `VersionedMap::at` | `VersionedMap.h:664` | 版本快照视图 |
| `openKVStore` | `IKeyValueStore.h:72` | 引擎工厂 |
</details>

## 核心实现

### MVCC（多版本可见性）

`versionedData`（`:1057`）是基于 PTree 的 `VersionedMap`（`VersionedMap.h:664`）。PTree 是 treap 部分持久化平衡二叉树，每节点三指针——前两个左右子，第三（`pointer[2]`）指向更新版本的节点。`child(which, at)`（`:54`）检查 `updated && lastUpdateVersion <= at && which==replacedPointer` 则返回更新后指针，否则返回原始。`createNewVersion`（`:760`）在 `roots` deque 追加新根（共享前一根）；`insert`（`:772`）沿路径创建新节点或复用 aux pointer；`forgetVersionsBeforeAsync`（`:725`）异步释放旧版本。可见性：`versionedData` 含 `[storageVersion, version]` 区间 mutation；对 readable shard 中 key k 在版本 v：`storage[k] + versionedData.at(v)[k] = database[k] @ v`。存储引擎层不保留多版本——只存 `oldestVersion` 时刻快照。

### 存储引擎抽象

`IKeyValueStore`（`IKeyValueStore.actor.h:57`）统一接口，实现有 `KeyValueStoreRedwood`（自研 B-tree via DWALPager）、`KeyValueStoreMemory`（`KeyValueStoreMemory.actor.cpp:44`，RadixTree + DiskQueue）、`KeyValueStoreRocksDB`/`SQLite`。`openKVStore(storeType)`（`IKeyValueStore.h:72`）工厂选择，`StorageServerDisk` 统一包装对 StorageServer 透明。新引擎无需实现 MVCC，只需满足因果一致性契约（commit 后的 read 能看到、commit 前看不到）。

### Pull 模型

StorageServer 不被动接收，而是主动 `peekSingle`（`:15313`）TLog。`ILogSystem::IPeekCursor` 的 `getMore()` 拉取指定 tag 的 mutation，`update()` 在主循环反复调用。原因：**背压控制**——`queueSize >= STORAGE_HARD_LIMIT_BYTES` 时 e-brake 暂停拉取防 OOM；**持久化节奏解耦**——pull 与 commit 解耦；**故障恢复简化**——只记 `version`+`history`，故障后从 `version+1` 重新 peek；**故障隔离**——SS 故障只影响自身不阻塞 TLog 向其他 SS 推送。`popVersion()` 通知 TLog 释放已持久化版本。

### VersionedBTree（Redwood）+ DWALPager

`VersionedBTree`（`:4883`）的 MVCC 在 pager 层：`DWALPager`（`:1912`）经 `atomicUpdatePage(reason, level, pageID, data, v)` 不直接覆盖原页，而是分配新页并建立 `LogicalPageID → newPageID` 重映射（`RemappedPage` `:1962`），按版本管理（`PageToVersionedMapT`）。`getReadSnapshot(v)` 返回版本快照，旧页经 `LazyClearQueue` 延迟释放。但当前使用（`KeyValueStoreRedwood::commit()` at `:8017`）每次 commit 后立即 `setOldestReadableVersion(next)`——只留单版本。`MutationBuffer` 按 key 组织 mutation，commit 时整体 flush。`BTreePage`（`:4595`）内嵌 `DeltaTree2`（增量压缩二叉树），`RedwoodRecordRef`（`:4135`）内部节点 value 存子页 PageID。ArenaPage 格式原生支持 AES-256-CTR 加密（`AESEncryptionEncoder`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| MVCC 版本可见性 | `versionedData` `:1057`、`VersionedMap.h:664` | PTree 三指针 O(1) 空间插入，无阻塞读 |
| 存储引擎抽象 | `IKeyValueStore.actor.h:57` | 接口+多实现，工厂选择 |
| Pull 模型 | `peekSingle` `:15313` | 背压、节奏解耦、恢复简化、故障隔离 |
| Versioned B-tree + DWALPager | `VersionedBTree.actor.cpp:4883`/`:1912` | 页重映射原子更新 + lazy clear + 加密原生 |

## 模块间交互

依赖 fdbrpc/flow。被 fdbclient（直接读写 via loadBalance）、TLog（消费 mutation）、DataDistributor（分片迁移）。StorageServer 经 `addStorageServer` 注册获分配 `Tag`，决定 TLog 中哪些 mutation 归本 SS 消费；`peekSingle(thisServerID, version+1, tag, history)` 用 tag + history 从 TLog 拉取。`dbInfo` 变化（recovery）时重建 `logSystem` 重新 peek。DataDistributor 经系统 key（`serverKeysPrefixFor(ssID)`）通知 SS 负责新 range，作为"私有 mutation"经 TLog 传递触发 `applyPrivateData`/`fetchKeys`。`update()` ↔ `updateStorage()` 经 `NotifiedVersion`（`version`/`desiredOldestVersion`）协调；`durableVersionLock` 隔离 update 的 eager reads 与 updateStorage 的 changeDurableVersion。

## 扩展方式

新增存储引擎：实现 `IKeyValueStore`（`:57`）所有纯虚方法，在 `IKeyValueStore.h` 加工厂声明、`openKVStore`（`:72`）加分支，可选 `addRange/removeRange`。**无需实现 MVCC**——但必须满足因果一致性契约。修改 MVCC 回收：改 `VersionedMap.h` 的 `compact`（`:789`）/`forgetVersionsBeforeAsync`（`:725`）或 `storageserver.actor.cpp:13023` 的 `maxVersionsInMemory`。新增 mutation 类型：在 `applyMutation`（`:7938`）加分支 + `writeMutations`（`:14024`）加磁盘逻辑 + `changeDurableVersion`（`:7734`）加清理。调整存储提交批次：改 `ServerKnobs` 的 `STORAGE_COMMIT_BYTES`/`STORAGE_HARD_LIMIT_BYTES`/`STORAGE_DURABILITY_LAG_*`。
