---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "raftstore-v2"
date: "2026-10-01T21:20:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "raftstore-v2", "Tablet", "partitioned-raft-kv"]
description: "TiKV 下一代 raftstore：per-region tablet 独立 RocksDB、operation 按命令分文件、禁用 WAL 靠 ApplyTrace flush 恢复、SimpleWrite 二进制编码。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

v1 raftstore 的根本痛点：**所有 region 共享一个 RocksDB**——raft 日志、region 元数据、用户数据混在一个 key 空间，region 销毁要逐 key 清理（`delete_files_in_range` + tombstone），split/merge 的 IO 代价高，compaction 互相干扰。v2（配置名 `partitioned-raft-kv`）把每个 region 变成**独立 RocksDB（tablet）**，raft 日志全放全局 raft-engine，region 生灭变成目录级操作。v9 状态：可选引擎（`EngineType::RaftKv2`，默认仍是 `RaftKv`，storage/config.rs:71），与 v1 平行演进。

## 模块架构

```text
components/raftstore-v2/src/
├── batch/      StoreBatchSystem（create_store_batch_system）
├── fsm/        peer.rs / store.rs（薄 FSM 层）
├── raft/       peer.rs / storage.rs / apply.rs（不依赖 batch 细节的核心）
│               —— 复用 v1 的 Peer 状态机思想
├── operation/  命令分发（v2 的灵魂）
│   ├── command/  admin/（split/merge/conf_change/transfer_leader...）+ write/
│   ├── query/    local.rs（本地读）/ lease.rs / capture.rs / replica.rs
│   ├── ready/    mod.rs（ready 处理）/ apply_trace.rs / async_writer.rs / snapshot.rs
│   ├── life.rs   （1276 行：region 生命周期）
│   └── txn_ext.rs / bucket.rs / pd.rs / misc.rs
├── router/     StoreRouter
└── worker/     tablet.rs / pd.rs / cleanup.rs
src/server/raftkv2/   RaftKv2（Engine trait 适配）
```

分层原则写在 lib.rs 注释：**不依赖 batch system 细节的字段放 `raft/peer.rs`，依赖的放 `fsm/`**——换并发方案只动 fsm 层。v1 只复用了 batch-system 与 raft-rs 库，Peer/apply 全部重写。

## 调用链路

### 写路径（SimpleWrite 编码）

```text
RaftKv2::async_write
└─ SimpleWriteReqEncoder（raftstore/src/store/simple_write.rs:55）
   # MAGIC_PREFIX 0x00 起头的自定义二进制（非 protobuf！）
   # 批量合并多个写请求（amend）→ SimpleWriteBinary
└─ on_simple_write（operation/command/write/mod.rs）→ propose
   【quorum 提交】
   └─ apply：SimpleWriteBinary 解码（SimpleWriteReqDecoder）
      → apply_put(cf, index, key, value)（write/mod.rs）逐条入 WriteBatch
      → flush（write/mod.rs:428）→ tablet 落盘
```

### ready 与 async 写

```text
Peer::handle_raft_ready
└─ AsyncWriter::write（operation/ready/async_writer.rs:52）
   ├─ has_data → send（:83）经 WriteRouter 投写任务（与 apply 解耦）
   └─ 无数据 → merge（:104）：无前序未持久化 ready 时立即视为 persisted
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `on_simple_write` in operation/mod.rs | 写命令入口 | 二进制编码免 protobuf 开销 |
| `AsyncWriter::write` in async_writer.rs:52 | ready 异步落盘 | 写与 FSM 轮转解耦 |
| `AsyncWriter::merge` in async_writer.rs:104 | 空 ready 合并 | 纯内存 ready 零 IO |
| `apply_put` in command/write/mod.rs | entry 应用 | 直写 tablet |
| `flush` in command/write/mod.rs:428 | 批落盘 | 见 ApplyTrace |
| `on_admin_modify` in command/mod.rs:422 | admin 后 tablet 变更 | flush 前置保安全 |

</details>

## 核心实现

### ApplyTrace：禁用 WAL 后的恢复机制

```text
// components/raftstore-v2/src/operation/ready/apply_trace.rs:3（模块注释）
//! In raftstore v2, WAL is always disabled for tablet.
//! We trace the persist progress by recording flushed event.
//! The minimum flushed apply index + 1 of all data CFs is the recovery start point.
```

tablet 禁用 WAL 后，重启恢复靠 flush 跟踪：每个 data CF 记录已 flush 的 apply index，最小值+1 是恢复起点；特殊的 raft cf index（仅借用名字，CF 已废）记录 admin 命令的 flush 点——**admin 命令执行前必须 flush 全部数据**（`on_admin_modify` command/mod.rs:422），这既为恢复也为 split init/log gc 的安全。正确性依赖两条（注释原文）：apply 顺序执行（index 更新即之前全部处理过）+ raft cf index 前的数据必已落盘。

### SimpleWrite：protobuf 之外的快编码

`RaftCmdRequest` 的 protobuf 编解码对简单写不够快（分配多、序列化贵）。`SimpleWriteReqEncoder`（raftstore/src/store/simple_write.rs:55，v1/v2 共用定义）用 `MAGIC_PREFIX: u8 = 0x00` 起头的自定义二进制格式（protobuf 字段 tag 不可能为 0，天然区分），支持 `amend`（:83）把后续写合并进同一 binary、`freeze` 禁止再合并——写热路径的 codec 级优化。

### per-region tablet 的连锁简化

Region 生灭 = tablet 目录创建/删除（`life.rs` 1276 行集中管理）：split 的新 region 用独立目录（`temp_split_path`）、merge 直接搬 tablet、destroy 删目录——对比 v1 的逐 key 清理是数量级改善。`TabletRegistry`（engine_traits）管理全部 tablet 句柄，`CachedTablet` 缓存热 region 的引擎引用。副作用（config/mod.rs:1519 注释）：每 tablet 独立 RocksDB 后台线程与内存开销，`get_background_job_limits_impl` 对 v2 用不同的 max_background_jobs 预算。

### 本地读与 lease

`operation/query/local.rs`（1079 行）：v2 的本地读在 store 层 FSM 内直接执行（`ReadDelegate` 等价物），lease 维护在 query/lease.rs——读不进 apply 队列，与 v1 的 LocalReader worker 思路不同但目标一致。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 按命令分文件 | operation/{command,query,ready}/ | 每命令独立演进（v1 的 god-file 反面） |
| 复用分层 | raft/（纯核心）+ fsm/（batch 绑定） | 换并发框架不动核心 |
| 状态跟踪恢复 | `ApplyTrace` apply_trace.rs | WAL 禁用的正确性根基 |
| 编码策略 | SimpleWrite vs RaftCmdRequest | 热路径专用快编码 |

## 模块间交互

复用 v1 的 batch-system、raft-rs、SimpleWrite（raftstore crate）、Config；依赖 engine_traits 的 `TabletRegistry`/`FlushState`；server 侧走 `raftkv2/`（RaftKv2）与 `server2.rs`（`components/server/src/server2.rs` 独立 run_tikv）。CDC/IME 等观察者生态在 v9 尚未完全接入 v2（IME 的 `prepare_for_apply` 只接了 v1 observable write batch 路径，待核实——backup/snap_recovery 有 v2 适配）。

## 扩展方式

- **新增 admin 命令**：operation/command/admin/ 新文件（参考 flashback.rs 4.7K 的最小样例）→ 需改 tablet 元数据的命令必须走 `on_admin_modify` 保证 flush 前置
- **新增查询类型**：operation/query/ 加文件实现 `Query` 分发（参考 replica.rs 的 follower 读 5.8K）
- **tablet 生命周期调整**：operation/life.rs 集中处理（split/merge/destroy 全在此）
