---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "MVCC 与 Percolator 数据层"
date: "2026-10-01T20:55:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "MVCC", "Percolator", "Lock", "Write"]
description: "TiKV MVCC 编码与 Percolator 数据语义：三 CF 布局、commit_ts 取反后缀、TLV 锁编码、MvccTxn/MvccReader 与 GC 状态机。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

这一层定义 TiKV 在 RocksDB 上的**数据格式与事务语义**：user key 怎么编码进三个 CF、prewrite/commit 各写什么、读怎么过滤版本、GC 删什么。它不关心谁调度（02 篇）、怎么复制（03 篇）——纯数据层，可用 FixtureStore 单测。Percolator 2PC 的数据面全在这里（协调面在客户端 TiDB 与 05 篇的 GC/锁管理）。

## 模块架构

```text
components/txn_types/src/
├── types.rs       Key（memcomparable + append_ts 编码）
├── timestamp.rs   TimeStamp（TSO 混合时间戳，物理左移 18 位 + logical）
├── lock.rs        Lock（TLV 前缀编码）
├── write.rs       Write / WriteRef（零拷贝视图）
└── value.rs / old_value.rs
src/storage/mvcc/
├── txn.rs         MvccTxn（写缓冲，1717 行）
├── reader/        MvccReader / PointGetter / ForwardScanner
├── actions/       prewrite.rs / commit.rs / gc.rs / check_txn_status.rs ...
└── consistency_check.rs   （CF 写入量对账 observer）
src/storage/txn/store.rs   SnapshotStore（读侧事务入口，1556 行）
```

编码（txn_types）与操作（mvcc/actions）分离：actions 是无状态函数库，每个文件对应一种 Percolator 动作。

## 调用链路

### prewrite 一个 key

```text
actions::prewrite::prewrite_with_generation（prewrite.rs:57）
├─ reader.load_lock（reader.rs:233）           # 查 lock CF（含内存悲观锁）
├─ check_for_newer_version                     # 扫 write CF 查冲突
└─ write_lock（prewrite.rs:573）
   ├─ 短值（≤255B）→ Lock.short_value 内嵌
   └─ txn.put_value → Modify::Put(CF_DEFAULT, key.append_ts(start_ts), v)
      txn.put_lock  → Modify::Put(CF_LOCK, key, lock.to_bytes())   # lock CF 不带 ts！
```

### commit 与读

```text
actions::commit::commit（commit.rs:15）
├─ 校验 lock.ts == start_ts && commit_ts >= min_commit_ts
├─ txn.put_write → Modify::Put(CF_WRITE, key.append_ts(commit_ts), write)  # value 记 start_ts
└─ txn.unlock_key → Modify::Delete(CF_LOCK, key)

MvccReader::get（reader.rs:501）
└─ get_write_with_commit_ts（:540）
   ├─ seek_write：commit_ts 取反编码 → 一次 seek 到 ≤ts 最新版本
   ├─ Lock/Rollback 记录按 last_change 跳过（≥8 版本直接点查跳转）
   ├─ gc_fence 检查防读到 GC 后复活的版本
   └─ load_data：short_value 直返，否则查 CF_DEFAULT key.append_ts(start_ts)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `Key::from_raw` in types.rs:51 | memcomparable 编码 | 保字典序可范围扫 |
| `Key::append_ts` in types.rs | 追加取反 ts | 版本序即字节倒序 |
| `Lock::to_bytes` in lock.rs | TLV 前缀编码 | 字段可缺省向后兼容 |
| `MvccTxn::put_lock` in txn.rs:122 | 写锁 | lock CF 无 ts 后缀 |
| `MvccTxn::put_write` in txn.rs:175 | 写提交记录 | write CF 以 commit_ts 为后缀 |
| `gc` in gc.rs:13 | 三态状态机 GC | 32KB 分批防大事务 |
| `PointGetter::get` in point_getter.rs:170 | 点读 | 锁检查→版本选择→取值 |

</details>

## 核心实现

### 三 CF 编码：Percolator 的物理布局

| CF | key 形态 | value | 谁写 |
|----|----------|-------|------|
| CF_DEFAULT | `{memcomparable(user_key)}{!commit→start_ts 取反}` | 原始 value | prewrite（长值） |
| CF_LOCK | `{memcomparable(user_key)}`（无 ts） | Lock TLV 编码 | prewrite / 悲锁 |
| CF_WRITE | `{memcomparable(user_key)}{commit_ts 取反}` | Write（记 start_ts） | commit |

三个 why：**lock 不带 ts**——检查锁只需一次点查，且天然一 key 一锁（同 key 新 prewrite 覆盖旧锁）；**write 与 default 分离**——读路径只扫 write CF（short_value 内嵌时完全不碰 default），GC 时 default 按 start_ts 批删；**commit_ts 大端取反**（`encode_u64_desc` types.rs:120）——"找 ≤ts 的最新版本"退化为单次 seek（倒序排列的第一个就是），无需回溯。memcomparable 编码（codec/byte.rs `MemComparableByteCodec::encode_all`）保证任意字节串编码后仍保字典序，这是在 RocksDB 有序 key 空间上做范围扫描的前提。

### TimeStamp：TSO 混合时间戳

```rust
// components/txn_types/src/timestamp.rs:14
#[repr(transparent)]
pub struct TimeStamp(u64);   // 物理毫秒左移 18 位 + 18 位 logical
```

PD 的 TSO 发号；`TsSet`（Empty/Vec/Set 三态，阈值 8）承载 bypass_locks——async commit 场景绕过指定事务集合的锁。

### Lock 的 TLV 前缀编码

```rust
// components/txn_types/src/lock.rs:76（字段）
pub struct Lock {
    lock_type, primary, ts, ttl, short_value, for_update_ts, txn_size,
    min_commit_ts, secondaries, rollback_ts, last_change, generation,
}
```

`to_bytes`/`parse` 用单字节前缀标记字段（`FLAG_PUT=b'P'`、`SHORT_VALUE_PREFIX=b'v'`、`GENERATION_PREFIX`...），字段可缺省——**新增字段天然向后兼容**（旧数据缺省、新数据解析），v9 的 `generation`（pipelined DML）就是这么加的。固定头部是 lock_type 标志 + primary + ts + ttl，其余字段（for_update_ts/txn_size/min_commit_ts/secondaries/rollback_ts/last_change/txn_source/is_locked_with_conflict/generation）仅在前缀字节出现时序列化；`use_one_pc` 等派生字段不持久化。悲观锁的判定用 `Lock::is_pessimistic_lock`（lock_type 为 Pessimistic），悲观事务则看 `for_update_ts` 是否非零。短值上限 `SHORT_VALUE_MAX_LEN=255`：单字节长度前缀，省一次 default CF 读。

### Write 记录的编码

`WriteRef::to_bytes`（write.rs）与 Lock 同构：头部 `write_type.to_u8()`（`b'P'`/`b'D'`/`b'L'`/`b'R'` 对应 Put/Delete/Lock/Rollback）+ var_u64 start_ts；可选前缀字段 short_value=`b'v'`、overlapped rollback=`b'R'`、gc_fence=`b'F'`（u64 定长）、last_change=`b'l'`、txn_source=`b'S'`。**解析遇未知前缀直接 break 停止**——新旧版本混布时旧节点跳过不认识的字段，前向兼容。受保护的 Rollback（`Write::new_rollback` 的 protected 变体）用 short_value=`b"p"` 标记（`WriteRef::is_protected`）。`WriteRef<'a>` 是 value 的零拷贝借用视图，`Write::as_ref()` 转换。

### MvccTxn：命令模式的写缓冲

```rust
// src/storage/mvcc/txn.rs:60
pub struct MvccTxn {
    // modifies: Vec<Modify> + locks_for_1pc + guards（内存锁 KeyHandleGuard）
}
```

只积累不落盘，`into_modifies()` 输出给 scheduler 原子提交——数据层与 raft 提交解耦。`locks_for_1pc`（:67）：1PC 的锁先缓存在内存，成功转 write、失败整体丢弃，避免落盘中间态。

### GC 三态状态机

```rust
// src/storage/txn/actions/gc.rs:87
enum State { Rewind, RemoveIdempotent, RemoveAll }
```

从 `TimeStamp::max()` 倒序扫 write CF：保留 safe point 前最新 Put/Delete，删 Rollback/Lock 记录与更旧版本；删除时 `MvccTxn::delete_write` 删 write CF 记录、同时 `delete_value` 按 write 里的 start_ts 删 CF_DEFAULT 对应版本（default 按 start_ts 批删），删除数经 `GcInfo.deleted_versions` 上报指标；单批 `MAX_TXN_WRITE_SIZE=32KB` 超限返回未完成由 GcWorker 换 reader 续扫（分批防大 key 阻塞）；safe point 推进触发 Rewind 回卷重扫。`gc_fence`（write.rs:75-155 长注释）三种取值：`None`（无 fence，正常接受）、`Some(0)`（显式标记"此版本之后被 GC 过"，读侧拒绝其为最新版本）、`Some(ts)`（fence 时间戳）——解决 overlapped rollback 重写 commit 记录在 GC 后"复活"的竞态，读路径 `check_gc_fence_as_latest_version` 拒绝越过 fence 的版本。

### 读侧跳版本优化

`Write.last_change` 记录到上一个有效版本的距离——读遇 Lock/Rollback 记录时若 `estimated_versions_to_last_change >= SEEK_BOUND=8`（tikv_kv/src/lib.rs:73）直接点查跳转而非逐版本 seek，MVCC 链长时省大量迭代。

### 点读遇锁的分支（SI 语义）

`Lock::check_ts_conflict_si`（lock.rs）决定读到锁怎么办：`lock.ts > read_ts`（未来事务的锁）或 lock_type 为 `Lock`/`Pessimistic`（非数据写入意图）→ **忽略**继续找版本；`min_commit_ts > ts` → 锁可能稍后提交出更新的版本，返回 `KeyIsLocked` 让客户端等待；`ts == u64::MAX` 且该 key 是 primary → 已在 resolving（GC worker 正在清理），按锁处理；`bypass_locks`（TsSet）命中的事务锁直接绕过——async commit 的 resolve 机制。`MvccReader::load_lock`（reader.rs:233）同时读 CF_LOCK 持久锁与 raftstore 内存悲观锁（`load_in_memory_pessimistic_lock` 经 `TxnExt`），两者合并后统一判定。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 编码模式（三 CF 复用） | txn_types types.rs | 同一 user key 三种形态 |
| 命令缓冲 | `MvccTxn` modifies | 写原子性上移到 scheduler |
| 零拷贝 Ref 视图 | `WriteRef<'a>` write.rs | 解析免复制 |
| 状态机 | `gc::State` gc.rs:87 | 回卷/清理两阶段显式化 |
| TLV 前缀编码 | `Lock::to_bytes` lock.rs | 字段级向后兼容 |
| trait 抽象 | `Store`/`TxnEntryStore` store.rs:16 | FixtureStore 可测 |

## 模块间交互

输出 `Vec<Modify>` 喂给 tikv_kv/raftstore；读侧通过 `snapshot.ext().get_txn_ext()`（reader.rs:429）读 raftstore 的内存悲观锁表（`TxnExt` store/txn_ext.rs:17），`check_term_version_status`（reader.rs:258）比对 term/epoch 防 leader 切换后读陈旧锁；`TxnExtra`（old_values/one_pc）经 `TxnExtraScheduler` 交给 CDC（写路径顺带取 old value）；GcWorker 调 actions/gc（见 05 篇）；`MvccConsistencyCheckObserver`（consistency_check.rs）挂 raftstore 用 CF 写入量对账快照一致性。

## 扩展方式

- **新增 Lock 字段**：仿 `generation`（lock.rs:43）加 TLV 前缀字节 + `pre_allocate_size` + `parse` 分支，旧数据自动缺省
- **改编码格式**：`Key::append_ts`/`split_on_ts_for` + `Write::to_bytes` 同改 + 存量迁移（v9 已有 `is_encoded_from` 校验思路），影响面贯穿三 CF
- **调整 GC 策略**：改 `Gc::State::step`（gc.rs:99）与 `MAX_TXN_WRITE_SIZE`，同步 compaction filter（gc_worker）等价逻辑
