---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "数据导入"
date: "2026-08-23T19:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Stream Load", "事务", "DeltaWriter", "MoW"]
description: "Doris 3.1.4 数据导入：Stream/Broker/Routine Load + GlobalTransactionMgr 两阶段事务（PREPARE→COMMITTED→VISIBLE）。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

数据导入模块由 `load/`（~2.1 万行）+ `transaction/`（~7.7k 行）+ `httpv2/rest/`（导入入口）组成。它是 Doris 的写路径，与查询读路径分离编排：负责开事务、把数据转发到 BE 写 MemTable 刷成 Rowset、提交事务、发布版本使数据可见。独立成文是因为写路径有独立的事务语义（两阶段提交）与一致性约束（MoW 的 Delete Bitmap 更新），且导入形态多样（Stream/Routine/Broker/Insert），需统一的事务管理。

## 模块架构

```
HTTP REST (httpv2/rest/UploadAction/LoadAction)
   │  或 Routine Load (Kafka)、Broker Load、INSERT
   ▼
FE: GlobalTransactionMgr (transaction/GlobalTransactionMgr.java:80)
   ├─ beginTransaction (:142)          ── 开事务，状态 PREPARE
   ├─ (数据转发到选定 BE)
   │
BE: DeltaWriterV2 (olap/delta_writer_v2.cpp)
   ├─ write(Block) (:73)               ── 写 MemTable
   ├─ MemTableWriter flush             ── MemTable → BetaRowsetWriterV2 → Segment
   └─ 生成不可变 Rowset
   │
FE: GlobalTransactionMgr
   ├─ commitTransaction (:277)         ── 提交，状态 COMMITTED
   └─ finishTransaction (:537)         ── 发布版本，状态 VISIBLE
```

## 调用链路

```
UploadAction/LoadAction (httpv2/rest/)
  └─ GlobalTransactionMgr.beginTransaction (GlobalTransactionMgr.java:142)
       └─ dbTransactionMgr.beginTransaction  ── 状态=PREPARE
  └─ 选定 BE，HTTP 转发数据 (或 Routine Load 拉 Kafka)
  └─ BE: DeltaWriterV2.write(block) (delta_writer_v2.h:73)
       └─ MemTableWriter.write  ── 写 MemTable
       └─ flush  ── MemTable 排序+刷盘成 Segment → BetaRowsetWriterV2
       └─ close_wait  ── 等 flush 完成，产出 Rowset
  └─ GlobalTransactionMgr.commitTransaction (:277/226)
       └─ 状态=COMMITTED
  └─ GlobalTransactionMgr.finishTransaction (:537)
       └─ dbTransactionMgr.finishTransaction  ── 写版本号
       └─ 状态=VISIBLE  ── 数据对查询可见
  └─ [Unique MoW] update_delete_bitmap  ── 更新 Delete Bitmap
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `beginTransaction` (`:142`) | 开事务 | label 去重，PREPARE 起 |
| `commitTransaction` (`:277`) | 提交 | COMMITTED 但未可见 |
| `finishTransaction` (`:537`) | 发布版本 | 写 partitionVisibleVersion，转 VISIBLE |
| `abortTransaction` (`:382`) | 中止 | 任一阶段可 abort→ABORTED |
| `DeltaWriterV2.write` (`:73`) | 写 Block 到 MemTable | 异步 flush，写路径与查询读路径解耦 |

</details>

## 核心实现

### 两阶段事务：COMMITTED 与 VISIBLE 分离

导入事务的精髓是 `commitTransaction`（COMMITTED）与 `finishTransaction`（VISIBLE）分离——见状态流图。`commitTransactionWithoutLock`（`:226`）只把事务状态改为 COMMITTED 并记录参与表，**此时数据已落 Rowset 但查询还看不见**；`finishTransaction`（`:537`）才把 partitionVisibleVersion 推进，让新版本对后续 scan 可见。

设计决策：**为何分两步而非一步可见**——多 BE 并发导入时，各 BE 的 Rowset 写入完成时间不一。先统一 COMMITTED（快，只改状态）让客户端尽早收到"导入成功"应答，再异步批量 finish 推进版本号——避免长事务阻塞、降低发布版本对查询的可见性抖动。

### DeltaWriterV2 与 MemTable

BE 侧 `DeltaWriterV2`（`olap/delta_writer_v2.cpp`）是写入核心：`write(Block)`（`:73`）把 `vectorized::Block` 追加到 `MemTableWriter` 管理的 `MemTable`。MemTable 在内存中按 key 排序，满后 flush 刷盘——由 `BetaRowsetWriterV2` 写成 Segment（列式 Page）。`close_wait` 等所有待 flush 的 MemTable 销毁，产出最终 `Rowset`。

设计决策：**为何 MemTable 排序**——Unique/Aggregate 表需按 key 合并，MemTable 排序后刷盘使 Segment 内有序，减少读时合并开销；Duplicate 表无需合并但仍排序以对齐 flush 语义。

### MoW 与 Delete Bitmap

Unique 模型启用 MoW（Merge-on-Write）时，导入不仅要写新 Rowset，还要经 `update_delete_bitmap` 标记旧版本中被新数据覆盖的行——Delete Bitmap 记录"哪个 version 的哪行已被覆盖"。3.1.x 这一步在事务提交流程中完成，使 MoW 在读时无需 merge 旧版本（查询快），代价是写时算 bitmap。云模式此步经 `MetaServiceImpl.update_delete_bitmap` 走 FoundationDB。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 两阶段提交 | `GlobalTransactionMgr` | COMMITTED 与 VISIBLE 分离，解耦应答与可见 |
| 异步刷盘 | `MemTableWriter` flush 队列 | 写路径不阻塞，吞吐优先 |
| 策略 | Stream/Routine/Broker/Insert 各 LoadAction | 不同数据源适配统一事务语义 |

## 模块间交互

`load/` **依赖** `catalog/Env`（`GlobalTransactionMgr` 在 Env 内）、`qe/Coordinator`（部分导入走查询执行）、`httpv2/`（REST 入口）。BE 侧 `DeltaWriterV2` **依赖** `olap/`（Tablet/Rowset）、`vec/`（Block）、`runtime/`（MemTracker）。云模式导入经 `cloud/` 走 MetaService。事务状态在 [03-catalog-metadata](03-catalog-metadata) 的 Env 与本模块的 `GlobalTransactionMgr` 共管。

## 扩展方式

新增一种导入形态：在 `httpv2/rest/` 加 Action（如 `XxxAction`）→ 在 `load/` 加对应 `LoadJob`/Executor → 复用 `GlobalTransactionMgr.beginTransaction/commitTransaction/finishTransaction` 三段。BE 侧若需新写入入口，扩展 `DeltaWriterV2` 或加新 Writer。对应测试：`regression-test/suites/load_p0/`。
