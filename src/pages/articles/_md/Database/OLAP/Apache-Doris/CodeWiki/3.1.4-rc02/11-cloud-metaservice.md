---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "Cloud MetaService"
date: "2026-08-23T19:06:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "3.1.4-rc02"]
tags: ["Apache Doris", "Cloud", "MetaService", "FoundationDB", "存算分离", "Recycler"]
description: "Doris 3.1.4 Cloud 存算分离：MetaServiceImpl(FoundationDB) + TxnLazyCommitter + Recycler，元数据移出 FE 进程。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/3.1.4-rc02/00-overview)

---

## 模块定位

Cloud MetaService 是 `cloud/src/`（~8.8 万行），核心是 `MetaServiceImpl`（`cloud/src/meta-service/meta_service.h:70`，`public cloud::MetaService`）+ FoundationDB 后端 + `Recycler`/`TxnLazyCommitter`。它是 Doris 云原生存算分离的元数据服务：当 `Config.isCloudMode()`（`cloud_unique_id` 非空）时，元数据从 FE 进程内嵌的 BDB JE 移到独立的 MetaService 进程（FoundationDB 持久化），segment 数据移到对象存储。独立成文是因为云模式架构与本地模式本质不同——存算彻底分离、元数据集中服务、计算无状态可弹性，是 3.x/4.x 的重点演进方向。

## 模块架构

```
MetaServiceImpl (meta_service.h:70) : public cloud::MetaService
   ├─ 事务: precommit_txn (:89) / commit_txn (:93) / doris_txn.cpp
   ├─ Tablet: create_tablets (:141)
   ├─ Delete Bitmap: update_delete_bitmap (:293) / get_delete_bitmap (:297)
   │              get_delete_bitmap_update_lock (:301) / remove_delete_bitmap (:306)
   ├─ 元数据: meta_service_schema / partition / tablet_stats / resource
   └─ MetaServiceProxy (:397) : public MetaService ── 代理转发 call_impl
   │
TxnLazyCommitter (txn_lazy_committer.h:53) ── 延迟提交降低云小事务开销
   │
Recycler (recycler/) ── 回收已删/过期 segment 的对象存储空间
   │
FoundationDB ── KV 持久化后端（meta-store/, resource-manager/, rate-limiter）
```

## 调用链路

云模式元数据访问：

```
[云模式 BE] CloudStorageEngine (be/src/cloud/)
  └─ 元数据操作 → gRPC → MetaServiceImpl
       ├─ create_tablets (meta_service.h:141) ── 建 tablet 元数据 → FDB
       ├─ commit_txn (:93) ── 提交事务 → FDB
       └─ update_delete_bitmap (:293) ── MoW bitmap → FDB
  └─ segment 数据读写 → 对象存储 (S3/OSS)

[云模式 FE] (fe/.../cloud/)
  └─ CloudSystemInfoService / ComputeGroupException ── 计算组管理
  └─ 经 MetaService 查 tablet 位置、资源

[后台]
  └─ TxnLazyCommitter ── 批量延迟提交小事务
  └─ Recycler ── 扫描 FDB 标记可回收对象 → 删对象存储
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MetaServiceImpl.create_tablets` (`:141`) | 建 tablet 元数据 | 经 FDB 持久化，替代本地磁盘 |
| `precommit_txn` (`:89`) / `commit_txn` (`:93`) | 事务管理 | 云事务两阶段，与本地 GTM 对应 |
| `update_delete_bitmap` (`:293`) | MoW bitmap | 云上 Unique 表更新，FDB 存 bitmap |
| `get_delete_bitmap_update_lock` (`:301`) | bitmap 锁 | 多 BE 并发更新互斥 |

</details>

## 核心实现

### 存算分离与 FoundationDB

云模式的本质是把元数据（tablet 元信息、事务状态、delete bitmap）从 FE 的 BDB JE 迁到独立的 FoundationDB——`MetaServiceImpl` 各方法以 FDB 为后端。`MetaServiceProxy`（`:397`，`final : public MetaService`）用 `call_impl`（`:420`）转发，是代理/路由层。数据本身在对象存储，BE 无本地元数据磁盘依赖，可弹性扩缩容。

设计决策：**为何用 FoundationDB 而非 BDB JE**——FDB 是分布式、高吞吐、支持严格 ACID 事务的 KV 存储，适合云上多计算组共享元数据；BDB JE 嵌入 FE 进程、难独立扩展。这是"元数据即服务"的关键——把元数据从进程内嵌变为独立可扩展服务。

### Delete Bitmap 上云

云模式 Unique MoW 表的 delete bitmap 不在本地而在 FDB：`update_delete_bitmap`（`:293`）经 gRPC 写 FDB，`get_delete_bitmap`（`:297`）读 FDB，`get_delete_bitmap_update_lock`（`:301`）/ `remove_delete_bitmap_update_lock`（`:311`）做并发更新互斥。有 v1/v2 两版锁接口（`:360-382`），`get_delete_bitmap_lock_version`（`:347`）按实例选版本。

设计决策：**为何 bitmap 上云**——本地模式 bitmap 在 tablet 本地磁盘，云模式 tablet 数据在对象存储、BE 无状态，bitmap 必须也独立于 BE 存 FDB，保证任意 BE 都能读到一致 bitmap。锁机制处理多 BE 并发导入同一 tablet 的 bitmap 更新竞争。

### TxnLazyCommitter 延迟提交

`TxnLazyCommitter`（`txn_lazy_committer.h:53`）批量延迟提交小事务——云上小事务的 FDB 写入有固定开销，攒批提交降单事务成本。`doris_txn.cpp` 实现云事务语义，`meta_service_txn.cpp` 是事务 RPC 层。

### Recycler 资源回收

`recycler/` 扫描 FDB 找已删/过期的 segment，删除对象存储上的对应对象——云存储按量计费，不回收会持续烧钱。`resource-manager/` 管计算组资源，`rate-limiter/` 限流防打爆 FDB/对象存储，`meta-store/` 是 FDB 存储层封装。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 服务化（元数据即服务） | `MetaServiceImpl` + FDB | 元数据独立扩展，BE 无状态 |
| 代理 | `MetaServiceProxy.call_impl` | 转发/路由，可插中间层 |
| 延迟批量 | `TxnLazyCommitter` | 攒批降云小事务固定开销 |
| 版本双轨 | bitmap lock v1/v2 | 灰度升级锁协议 |

## 模块间交互

Cloud MetaService **被** BE 的 `be/src/cloud/`（`CloudStorageEngine`、`cloud_delta_writer`、`cloud_compaction`）经 gRPC 调用、FE 的 `fe/.../cloud/`（`CloudSystemInfoService`）调用。它替代了本地模式中 `Env`+BDB JE 的元数据职责（见 [03-catalog-metadata](03-catalog-metadata)）与 `olap/` 的部分存储元数据职责（见 [07-storage-engine](07-storage-engine)）。`BaseStorageEngine` 抽象使 `StorageEngine`（本地）与 `CloudStorageEngine`（云）可经 `ExecEnv` 切换。

## 扩展方式

新增一种元数据操作：在 `MetaServiceImpl` 加方法（gRPC `cloud.proto` 定义），在 `meta-store/` 实现 FDB KV 读写，在 BE `be/src/cloud/` 加调用方。新增资源回收策略：在 `recycler/` 加回收规则。对应测试：`cloud/test/`、`regression-test/suites/cloud/`。
