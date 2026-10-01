---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "引擎抽象与实现"
date: "2026-10-01T21:15:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "engine_traits", "RocksDB", "RaftEngine", "泛型"]
description: "TiKV 存储引擎抽象层：KvEngine supertrait 组合、泛型静态分发的 why、RocksEngine 适配器与 raft-engine 专用共识日志引擎。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

engine_traits 是引擎的**可替换性契约**：raftstore 全链路只认 `KvEngine`/`RaftEngine` trait，不直接 import RocksDB。lib.rs 开头明言 "This crate **must not have any transitive dependencies on RocksDB**"。为什么这层值钱：TiKV 正在做引擎迁移（C++ rocksdb → Rust tirocks）、正在加内存引擎（IME）、还有测试占位 engine_panic——没有抽象层这些都是重写级工程。

## 模块架构

```text
components/engine_traits/src/    纯 trait crate
├── engine.rs        KvEngine（:13，supertrait 组合）
├── snapshot.rs      Snapshot trait（:11）
├── write_batch.rs   WriteBatch + WriteBatchExt（:78/:6）
├── raft_engine.rs   RaftEngine（:84）+ RaftEngineReadOnly（:15）
├── cf_defs.rs       CF_DEFAULT/CF_LOCK/CF_WRITE 常量
├── engines.rs       Engines<K, R>（:9）kv+raft 成对
└── region_cache_engine.rs  RegionCacheEngine（:110，IME 契约）
components/engine_rocks/src/     RocksDB 适配（RocksEngine/RocksWriteBatchVec）
components/raft_log_engine/src/  raft-engine crate 适配（RaftLogEngine）
components/engine_tirocks/src/   Rust 原生绑定重写中（过渡 crate）
components/engine_panic/src/     panic 占位（测试）
components/codec/src/byte.rs     memcomparable 编码
```

## 调用链路

### 写路径（KvEngine）

```text
raftstore ApplyFsm
└─ kv_wb: WriteBatch（engine_rocks/src/write_batch.rs:16，RocksWriteBatchVec）
   ├─ put_cf → check_switch_batch（:88）  # 单批超 16 keys 切新 RawWriteBatch
   └─ write_impl（:101）
      ├─ multi_batch_write_callback 或 db.write_callback   # 回调带回 seqno
      └─ 返回 sequence number（供 IME/raftstore 对账）
```

### RaftEngine 写路径

```text
PeerFsm ready
└─ RaftLogEngine::consume（raft_log_engine/src/engine.rs:656）
   └─ self.0.write(&mut batch.0, sync)   # raft-engine 原生 write
      └─ 按需 sync()；GC 用 Command::Compact { index: to }（:694）标记截断
         过期文件由 manual_purge() → purge_expired_files()（:766）整文件回收
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `KvEngine::snapshot` in engine.rs | 取一致性视图 | 关联类型非 dyn |
| `check_switch_batch` in write_batch.rs:88 | 大批切分 | 防 write_thread 阻塞 |
| `write_impl` in write_batch.rs:101 | 落盘带 seqno | callback 回传序号 |
| `RaftLogEngine::consume` in engine.rs:656 | 日志写入 | log GC 标记式 |
| `RocksEngine::snapshot` in engine.rs:190 | Arc 克隆 | seqnum 快照语义 |

</details>

## 核心实现

### KvEngine：supertrait 组合

```rust
// components/engine_traits/src/engine.rs:13
pub trait KvEngine: Peekable + SyncMutable + Iterable + WriteBatchExt
    + DbOptionsExt + CfNamesExt + CfOptionsExt + ImportExt + SstExt
    + CompactExt + RangePropertiesExt + MvccPropertiesExt + ... + 'static {
    type Snapshot: Snapshot;
    fn snapshot(&self) -> Self::Snapshot;
    fn bad_downcast<T: 'static>(&self) -> &T;   // 重构期临时 hack
}
```

不是 god trait——每个能力一个 `XxxExt`（适配器/extension trait 模式），主 trait 只是组合。**泛型静态分发而非 dyn**：get/write/iterate 在 raftstore 每秒百万级调用，trait object 的间接跳转与无法内联不可接受；代价是代码膨胀与 `bad_downcast`（engine.rs:60 注释自认 "cannot be used forever"）这类过渡 hack。raftstore 全链路 `PeerStorage<EK, ER>` 泛型单态化。

### CF 布局

```rust
// components/engine_traits/src/cf_defs.rs
DATA_CFS = [CF_DEFAULT, CF_LOCK, CF_WRITE]
```

default 存 MVCC 数据行、lock 存 Percolator 锁、write 存 commit 记录（编码细节见 04 篇）。RocksDB RaftEngine 兼容后端把 raft state 放 CF_DEFAULT（engine_rocks/src/raft_engine.rs:24，供旧配置 raftdb）。

### 为什么 Raft log 独立引擎

raft log 是追加型、按 region 分段 GC 的 WAL 语义，与 KV 的 LSM 写放大模型冲突：RocksDB 后端的 `gc_impl`（engine_rocks/src/raft_engine.rs:182）得逐 key delete，写放大显著；raft-engine 用 log file + 内存 queue 索引，GC 只需 `Command::Compact` 标记截断点，过期文件整文件回收（`need_manual_purge()=true`）。两引擎由 `Engines<K, R>`（engines.rs:9）显式成对，还共享 raft state（`put_raft_state` 等）。

### Adapter 与注入点

engine_rocks 整个 crate 是 adapter：`RocksEngine { db: Arc<DB>, ingest_latch: Arc<RangeLatch> }`（engine.rs:147）包装 C++ FFI，`r2e` 统一错误转换；`raft_log_engine` 包装 `RawRaftEngine<ManagedFileSystem>`，后者经 `ManagedReader/ManagedWriter` 注入**加密**（DataKeyManager）与 **IO 限流**（IoRateLimiter）——横切能力在文件系统层注入而非引擎层。v6.x 起 raft-engine 默认启用（`config.raft_engine.enable`）。

### tirocks：进行中的 Rust 原生迁移

`components/engine_tirocks/src/lib.rs:3` 注明：用 Rust 原生 `tirocks` 绑定重写 engine_rocks，完成后删除 C++ rocksdb 依赖。两实现并存正靠 engine_traits 契约保证行为一致——`engine_traits_tests` 泛型测试框架对所有后端跑同一套用例。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| supertrait 组合 | `KvEngine` engine.rs:13 | 能力正交可单独实现 |
| Adapter | engine_rocks/raft_log_engine 全 crate | FFI 边界隔离 |
| 关联类型 | `type Snapshot: Snapshot` | 静态分发 |
| 成对泛型 | `Engines<K, R>` engines.rs:9 | kv/raft 生命周期同步 |
| 注册式测试 | `engine_traits_tests` | 多后端行为一致 |

## 模块间交互

被 raftstore/raftstore-v2/server 依赖（Cargo.toml 只 import engine_traits + engine_rocks_helper 便捷层）；tikv 主 crate 启动时选具体实现注入泛型；`RegionCacheEngine`（region_cache_engine.rs:110）支撑 IME/hybrid_engine 的混合读（见 11 篇）。

## 扩展方式

- **新增引擎后端**：实现 engine_traits 全套 trait（现成范例：engine_panic/in_memory_engine/hybrid_engine/tirocks）+ engine_traits_tests 注册
- **新增 CF 级功能**（如 write CF 新 table property collector）：engine_traits 的 `table_properties.rs`/`mvcc_properties.rs` 抽象 + engine_rocks impl + engine_traits_tests 三处
- **Raft state 编码变更**：`RaftLogBatch` 的 key 常量（RAFT_LOG_STATE_KEY 等 engine.rs:369）+ `encode_flushed_key`（:326），须兼容两后端
