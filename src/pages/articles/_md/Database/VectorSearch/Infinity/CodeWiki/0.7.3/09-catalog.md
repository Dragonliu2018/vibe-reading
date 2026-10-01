---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "元数据目录"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 元数据目录解读：NewCatalog 不是内存树而是 RocksDB 扁平 KV 服务、版本化 key 前缀编码与 tombstone、Meta 句柄类、SystemCache/MetaCache 双层缓存、segment/block 两级与 RowID 位绑定"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/storage/catalog/`（约 1.3 万行）管理所有元数据：db/table/index/segment/block/column 的层级目录、函数注册表、内存索引挂载点、块级锁。

先修正一个普遍预期偏差：**NewCatalog 不是常驻的内存 entry 树**。它是轻量"目录服务"对象，只持 `KVStore*` + 四张运行时注册表；**所有目录数据以扁平 KV 形式持久化在 RocksDB，层级关系完全由 key 前缀编码表达**。`DBMeta/TableMeta/...` 是每次操作临时构造的"句柄对象"（构造参数是 ID 路径 + `KVInstance&`），不是长生命周期节点。`MetaTree` 只在两个场景物化：启动恢复（`RestoreCatalogCache`）和 `SHOW CATALOG`/`CHECK` 语句。历史脉络：v0.6 及之前是 JSON 文件 + 内存树，v0.7 已整体迁移到 RocksDB（`UsageFlag::kTransform` 注释 "Used by catalog transformation from old json style to rocksdb"）。

---

## 模块架构

```text
src/storage/catalog/
├── new_catalog.cppm/_impl (1.4K+1.6K)  NewCatalog：目录服务 + 四张运行时注册表
├── new_catalog_static_impl.cpp (1.6K)  AddNewXxx/CleanXxx/GetBlockVisibleRange 等 static
├── kv_store.cppm/_impl                 KVStore(TransactionDB) + KVInstance(事务)
├── kv_code.cppm                        KeyEncode：key 布局的唯一权威（在 storage/common/）
├── meta/
│   ├── meta_key.cppm/_impl            22 个 MetaKey 子类 + MetaParse
│   ├── meta_tree.cppm/_impl           启动时物化的树 + RestoreSystemCache
│   ├── db_meta / table_meta / segment_meta / block_meta / column_meta
│   ├── table_index_meta / segment_index_meta / chunk_index_meta
│   ├── block_version.cppm/_impl       行级 MVCC 版本文件
│   └── meta_type.cppm                 22 值枚举（顺序决定 Cleanup 删除顺序）
├── mem_index.cppm/_impl                MemIndex：9 种内存索引的 variant 聚合
├── catalog_cache.cppm                  SystemCache（写路径热缓存）
├── meta_cache.cppm                     MetaCache（读路径缓存）
└── kv_utility.cppm
```

NewCatalog 的真实形态（`new_catalog.cppm:143`）：

```cpp
export struct NewCatalog {
    explicit NewCatalog(KVStore *kv_store);
    static Status Init(KVStore *);                    // 幂等初始化 NEXT_DATABASE_ID
    std::shared_ptr<MetaTree> MakeMetaTree() const;  // RocksDB 全量 KV → 内存树（仅恢复/SHOW）
    std::unique_ptr<SystemCache> RestoreCatalogCache(Storage *);
    KVStore *kv_store_{};
    std::unordered_map<std::string, std::shared_ptr<BlockLock>> block_lock_map_;     // 块级锁
    std::unordered_map<std::string, std::shared_ptr<MemIndex>> mem_index_map_;      // 内存索引
    std::unordered_map<std::string, std::shared_ptr<TableIndexReaderCache>> ft_index_cache_map_;
    std::unordered_map<std::string, std::shared_ptr<SegmentUpdateTS>> segment_update_ts_map_;
};
// AddNewDB / AddNewTable / AddNewSegmentWithID / CleanXxx ... 全是 static，由 NewTxn 调
```

---

## 调用链路

### CREATE TABLE 的 catalog 写路径

```text
NewTxn::CreateTable                        new_txn/new_txn_impl.cpp:388
 ├─ GetDBMeta(db_name) → GetTableID(name)  查重（读所有版本 + tombstone）
 ├─ db_meta->GetNextTableID()              "db|{db_id}|next_table_id" 自增
 └─ 暂存到 CreateTableTxnStore             ← 此刻不写任何 KV
        │ commit 时
        ▼
NewTxn::PrepareCommit → NewCatalog::AddNewTable    new_catalog_static_impl.cpp:538
 ├─ key = KeyEncode::CatalogTableKey(db_id, name, commit_ts)   // "catalog|tbl|{db}|{name}|{ts}"
 ├─ kv_instance->Put(key, table_id_str)            // 进 rocksdb::Transaction 缓冲
 └─ table_meta->InitSet(table_def)                 table_meta_impl.cpp:248
      ├─ SetNextColumnID / Put("tbl|{db}|{tbl}|next_segment_id", "0")
      └─ 每列 Put("tbl|col|{db}|{tbl}|{col}|{commit_ts}", columnDef JSON)
NewTxnManager::CommitKVInstance            new_txn_manager_impl.cpp:459
 ├─ meta_cache->EraseAndCommitKV(...)      失效并发读事务的 MetaCache
 └─ KVInstance::Commit() → rocksdb::Transaction::Commit   ★ 唯一原子发布点
```

**commit_ts 直接编码进 key**——"版本即键"的 MVCC 设计：create 不覆盖旧版本，drop 只写 tombstone（`drop|tbl|{db}/{name}/{create_ts}/{tbl_id}`，值为 drop 的 commit_ts）。RocksDB transaction 的 Commit 是目录变更的唯一原子发布点。

### 启动加载（没有 InitTree，实际链条）

```text
Storage::AdminToWriter (storage_impl.cpp:232)      admin → writable 角色迁移时装配
 1. kv_store_->Init(CatalogDir())           rocksdb::TransactionDB::Open (:278)
 2. new_catalog_ = make_unique<NewCatalog>(kv_store_.get())
 3. WAL replay：每条 cmd 走 NewTxn::ReplayCreateTable（先 Get 主键判幂等再重放）
 4. Storage::AttachCatalog(checkpoint_ts)   树状递归预加载各层 LoadSet()
 5. RecoverMemIndex()                       重建未 seal segment 的内存索引
 6. new_catalog_->RestoreCatalogCache(this)
    ├─ MakeMetaKeys()：GetAllKeyValue() 全量拉取 → MetaParse(key, value) 路由到 22 个 MetaKey 子类
    ├─ MetaTree::MakeMetaTree(metas)：多趟分层组装（第 1 趟建 DB、第 2 趟挂 Table/DBTag...），
    │   孤儿（父已被 drop 的残余 key）打 LOG_WARN 跳过
    └─ meta_tree->RestoreSystemCache → SystemCache 交给 NewTxnManager
```

### 查询时可见性判定

**表级**（目录对象）：`DBMeta::GetTableID`（`db_meta_impl.cpp:146-217`）前缀扫描该表名所有版本 → 选 `max(commit_ts) 且 commit_ts <= begin_ts` 的版本 → tombstone 检查（drop_ts/rename_ts <= begin_ts 则 TableNotExist）。**行级**（数据）：`NewCatalog::GetBlockVisibleRange` → `BlockVersion`（BufferObj 加载）→ `NewTxnGetVisibleRangeState::Init/Next` 按 begin_ts 裁剪可见行区间，本事务刚提交的尾部行通过 `GetCommitRowCount(commit_ts)` 补齐。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `NewCatalog::Init` | `new_catalog_static_impl.cpp:125` | InitCatalog 树状递归预加载 |
| `NewCatalog::AddNewTable` | `new_catalog_static_impl.cpp:538` | 写版本键 + InitSet |
| `NewCatalog::GetBlockVisibleRange` | `new_catalog_static_impl.cpp:1170` | 行级可见区间 |
| `NewCatalog::MemIndexRecover` | `new_catalog_static_impl.cpp:284` | 崩溃后重建内存索引 |
| `MetaTree::MakeMetaTree` | `meta_tree_impl.cpp:50` | 多趟分层组装 + 孤儿容忍 |
| `DBMeta::GetTableID` | `db_meta_impl.cpp:146` | 表级可见性判定 |
| `TableMeta::AddSegmentWithID` | `table_meta_impl.cpp:232` | 写 `catalog|seg|...` |
| `SegmentIndexMeta::GetMemIndex` | `segment_index_meta.cppm:65` | executor 统一入口 |
| `KVStore::Init` | `kv_store_impl.cpp:276` | TransactionDB 打开 + MergeOperator |

</details>

---

## 核心实现

### 为什么用 RocksDB 而不是自研文件格式

四个理由，每个都有代码证据：(1) **免费获得事务性多键原子变更**——`TransactionDB` + 每 txn 一个 `KVInstance`，commit/rollback 开箱即用，目录变更天然与数据事务对齐；(2) **有序 key + 迭代器 = 树查询**——层级前缀 key 让"列子节点/判存在"变成 Seek + prefix scan，免自研树结构；(3) **生态红利**——`BackupEngine` 备份、MergeOperator 计数器自增、EventListener 挂 S3 上传（MinIO 模式下 flush/compaction 完成时把 sst 增量上传，`kv_store_impl.cpp:188-275`）；(4) **耐久性策略自洽**——`write_options_.disableWAL = true`，RocksDB 自身 WAL 关闭，靠 Infinity WAL replay + checkpoint 时的显式 `Flush()` 兜底，**避免双 WAL 写放大**。

### meta key 编码：三类键

```text
实体版本键（catalog| 前缀 + 尾部 commit_ts）：
  catalog|db|{name}|{ts}          catalog|tbl|{db}|{name}|{ts}
  catalog|seg|{db}|{tbl}|{seg_id}  catalog|blk|{db}|{tbl}|{seg}|{blk}
  catalog|idx|{db}|{tbl}|{idx}|{ts}
tag/counter 键（短前缀、无版本，"可变属性"）：
  db|{db_id}|next_table_id        tbl|{db}|{tbl}|next_segment_id
  idx_seg|{db}|{tbl}|{idx}|{seg}|mem_index
tombstone 键（drop| 前缀，值为 drop 的 commit_ts）：
  drop|tbl|{db_id}/{tbl_name}/{create_ts}/{tbl_id}
```

一个容易踩的细节：segment/block 的版本键**不带** commit_ts（值存 commit_ts），而 db/table/index 版本键**带**——因为后三者支持 rename/recreate 同名对象，需要多版本共存。全字符串 `|` 分隔方案的代价：无法用二进制比较做数值序（seg_id "10" < "9"），但换 Scan 语义简单；`MetaParse` 按字段数歧义消除（`idx_seg` 6 字段=tag、5 字段=实体）。

### segment/block 两级：与 RowID 位绑定

`DEFAULT_SEGMENT_CAPACITY = 8M 行`、`DEFAULT_BLOCK_CAPACITY = 8192 行`、`DEFAULT_BLOCK_PER_SEGMENT = 1024`，且与 RowID 编码**硬绑定**：`BLOCK_OFFSET_SHIFT = 13`（8192）、`SEGMENT_OFFSET_IN_DOCID = 23`（8M）——**block offset 与 segment id 直接是 RowID 的位段**。两级各有分工：block（8K 行）是 **MVCC 版本边界**（每 block 一个 BlockVersion 文件）、buffer pin 与 compaction 拷贝单元；segment（8M 行）是**索引 dump/seal/mem_index 生命周期/compaction** 的单元（SegmentStatus 状态机 + unsealed_segment_id + chunk 索引按 segment 组织）。

### MemIndex 为什么挂在 catalog 上

未 seal segment 的索引无法落盘成 chunk（ChunkIndexMeta 是已 dump 索引的元数据），必须驻留内存持续接受 append；其**生命周期跨事务**（多个 append txn 累积 → dump txn 换出），因此挂在进程级单例 `NewCatalog::mem_index_map_`（key 由 `SegmentIndexMeta::GetMemIndex` 生成）。dump 时 `PopMemIndex + ClearMemIndex`；崩溃后由 `MemIndexRecover` 从块数据重建；`is_dumping_/UpdateBegin/UpdateEnd + cv_` 协调 dump 与 append 并发；`BGMemIndexTracer` 按内存配额触发强制 dump。

### 双层缓存

- **SystemCache**（写路径热缓存，`catalog_cache.cppm`）：启动时由 `RestoreSystemCache` 生成、NewTxnManager 持有，承载 append 的 `PrepareAppend`（segment/block 分配）、next_xxx_id 自增器——**避免高频 ID 分配走 RocksDB**。
- **MetaCache**（读路径缓存，`meta_cache.cppm`）：只读事务按 `(db_id, table_name, begin_ts)` 缓存可见性判定结果，commit 时 `EraseAndCommitKV` 精确失效。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 扁平 KV + 前缀编码（替代内存树） | `KeyEncode`（`kv_code.cppm:96`） | 层级查询 = iterator 前缀扫描 |
| 版本化键 + tombstone 的 MVCC | `catalog|tbl|...|{commit_ts}` + `drop|...` | 无 in-place update，GC 按水位 |
| 句柄/游标（Meta handle） | `DBMeta/TableMeta/...` 临时构造绑定 KVInstance | 与 PG Relation、DuckDB 常驻 CatalogEntry 相反的取舍 |
| 事务缓冲 + 单点原子发布 | `CommitKVInstance` | RocksDB 事务 Commit 即发布点 |
| 注册表模式 | NewCatalog 四张 map（Add/Get/Drop 三件套） | 进程级运行时状态集中 |
| 多趟组装 + 孤儿容忍 | `MakeMetaTree` | drop 残余 key 不炸启动 |

---

## 模块间交互

- **new_txn（主消费者）**：写路径 `NewTxn::CreateXxx` 只做校验 + 暂存 → `PrepareCommitXxx` 调 `NewCatalog::AddNewXxx` static 写 KV → `CommitKVInstance` 发布；读路径构造 Meta 句柄。
- **buffer manager**：`ColumnMeta` 的 `column_buffer_/outline_buffer_`、`BlockMeta::version_buffer_`、`ChunkIndexMeta::index_buffer_` 都是 `BufferObj*`，在 LoadSet 阶段注册——目录存元数据、BufferManager 存数据页，经 Meta 句柄桥接。
- **io/持久化**：列数据文件路径由 key 中的 ID 路径推导；PersistenceManager 的 local_path→ObjAddr 映射也在同一 KVStore（`pm|object|` 前缀）。
- **executor**：`SHOW CATALOG`/`CHECK` 走 `MakeMetaTree()`。

---

## 扩展方式

**新增一种 entry 类型**（8 处，以 TableIndex 为参照）：`kv_code` 加 `CatalogXKey/PREFIX/XTagKey/DropXKey` 四个格式化函数（注意 drop 键用 `/` 分隔、其余用 `|`）→ `meta_type.cppm` 的 `MetaType` 枚举加值——**位置决定 Cleanup 删除顺序**（降序删，子类型必须排在父类型之后）→ `meta_key` 加 `XMetaKey/XTagMetaKey` + `MetaParse` 分支 → 新建 `x_meta.cppm/_impl.cpp` 句柄类 → 父句柄加子枚举（前缀扫描 + 惰性 optional 缓存）→ `new_catalog` 的 static `AddNewX/CleanX` + `GetCleanedMetaImpl`/`GetEncodeKeys` case → `meta_tree` 加节点 + MakeMetaTree pass → new_txn 侧 `CreateX/PrepareCommitCreateX/ReplayCreateX` + WAL cmd + txn store。交叉验证点：`GetAllMemIndexInfo` 的类型枚举 switch、`PhysicalCheck` 的路径校验、S3 FlushListener 的前缀过滤——新增类型容易漏。
