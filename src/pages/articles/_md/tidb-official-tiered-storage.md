---
title: "TiDB 新一代架构冷热数据存储技术解读"
source:
  type: "article"
  project: "TiDB"
  url: "https://mp.weixin.qq.com/s?__biz=MzI3NDIxNTQyOQ==&mid=2247533120&idx=1&sn=597bdce8eac34cab1c1b9d21c2a5555b"
  author: "TiDB-平凯数据库"
  site: "TiDB-平凯数据库 微信公众号"
date: "2026-08-13T19:30:00+08:00"
category: [Database, TiDB, Official]
tags: ["TiDB", "分层存储", "Tiered Storage", "冷热数据分离", "对象存储", "S3", "LSM-Tree", "Segment", "平凯数据库", "存算分离"]
description: "平凯数据库云服务 Tiered Storage 分层存储功能深度解读：基于 TiDB 新一代架构的多树并行 + S3 持久化设计，通过 Segment 分段缓存、IA Manager 智能缓存管理、Region 对齐隔离，实现冷热数据分离存储，用可接受的延迟换取约 50% 的存储成本下降。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [TiDB 新一代架构冷热数据存储技术解读](https://mp.weixin.qq.com/s?__biz=MzI3NDIxNTQyOQ==&mid=2247533120&idx=1&sn=597bdce8eac34cab1c1b9d21c2a5555b) · **作者** TiDB-平凯数据库 · **来源** TiDB-平凯数据库 微信公众号 · **原文发布** 2026-08-12 · **转载** 2026-08-13

---

## 导语

当数据量爆炸式增长，存储成本成为企业不可忽视的开销。平凯数据库云服务推出的 Tiered Storage 分层存储功能，如何实现冷热数据智能分离？本文从架构原理到落地实践，为你深度拆解。

## 为什么需要分层存储？

在数据库领域，长期存在一组矛盾：性能与成本的权衡。

业务数据中，往往只有 20% 的"热数据"被频繁访问，剩下 80% 的"冷数据"静静躺在磁盘上，一年到头也未必被查询几次。但它们却占据着同样昂贵的 SSD 存储空间，这无疑是巨大的浪费。

平凯数据库云服务推出的 **Tiered Storage（分层存储）** 功能，正是为了解决这个问题——让热数据留在本地 SSD 享受极速访问，冷数据下沉到对象存储（S3/OSS）大幅降低成本。

![分层存储概念示意图](/vibe-reading/images/articles/tidb-official-tiered-storage/01-tiered-storage-concept.jpg)

> **💡 一句话理解**：冷热数据分离存储，用可接受的延迟换取 50% 的存储成本下降。

### 先搞清楚几个基本概念

在深入技术细节之前，我们先对齐几个核心概念：

- **IA 表**：开启了分层存储功能的表，IA = Infrequent Access
- **热数据**：保留在本地 SSD，访问延迟微秒级
- **冷数据**：存储在远端对象存储（S3/OSS）
- **Segment**：TiKV 从对象存储读取的最小单位，约 1MB 大小
- **Tiered Storage（分层存储）**：基于 TiDB 新一代内核，平凯数据库云服务提供表级或分区级冷热数据分离存储能力。

关于平凯数据库云服务：

平凯数据库云服务（简称：平凯云 DB ），是与 TiDB Cloud 同源演进的新一代分布式云数据库，继承了 TiDB Cloud 在全球市场验证的产品能力与技术实践，在敏感型核心应用、AI Agent 数据底座、实时分析等场景积累了丰富的生产实践，为海量业务提供稳定、高可用、弹性伸缩的数据底座。

## 架构演进：从"单树"到"多树 + 存算分离"

要理解分层存储，首先得理解 TiDB 新一代内核的演进。
![经典 TiKV 单棵 LSM-Tree 架构](/vibe-reading/images/articles/tidb-official-tiered-storage/02-classic-tikv-lsm.png)

### 经典 TiKV："一棵 LSM 树打天下"

熟悉 TiDB 的朋友都知道，经典架构下每个 TiKV 节点内部就是一套 RocksDB + 一棵 LSM-Tree：

- 单 TiKV 节点 = 单棵 LSM-Tree
- 所有数据都存在本地磁盘
- 没有远端存储依赖

这种架构简单直接，但也带来了资源隔离差、扩缩容不灵活等问题。

### TiDB 新一代架构：多树并行 + S3 持久化
![多树并行架构](/vibe-reading/images/articles/tidb-official-tiered-storage/03-multi-tree.jpg)

作为平凯数据库云服务技术底座的 TiDB 新一代架构，做了两个非常关键的改变：

**变化一：单节点下的"LSM 树林"**

不再是一个节点一棵树，而是一个节点内有多棵 LSM 树并行运行。

好处显而易见：

- 锁冲突率大幅降低——操作 A 树不影响 B 树
- 物理资源隔离——不同表/租户的数据互不干扰

**变化二：引入 S3 作为持久化层**

KV 数据文件（如 SST）以对象存储为持久层，数据会同步写入 S3；而 Raft Log 与 WAL 首先持久化在本地磁盘，上传对象存储属于可选的轻量备份（默认关闭）。本地磁盘对 Raft 持久化仍是主持久路径，但对 KV 数据更像一个"缓存层"。

这种存算分离设计带来的收益：

- 节点挂了？直接从 S3 恢复数据，大幅降低副本重建的数据搬运量
- 存储计算独立扩缩容，资源利用率更高
- 为分层存储打下了基础

> **📝 划重点**：即便不开分层存储，数据本来就在 S3 上有一份。分层存储的本质只是——把本地的副本删掉，只留 S3 上的冷数据。所以开通分层存储几乎没有"上传数据"的开销，这个后面会详细讲。

![LSM 树层级分布与 Segment 结构](/vibe-reading/images/articles/tidb-official-tiered-storage/04-lsm-segment-structure.png)

## 存储结构：Segment 分段是"点睛之笔"

### LSM 树的层级分布

熟悉 LSM 树的朋友都知道，数据从内存 MemTable 开始，经过 compaction 一层层下沉，最终落到更底层的 SST 文件中。

开启分层存储后的变化：
![Segment 缓存机制](/vibe-reading/images/articles/tidb-official-tiered-storage/05-segment-cache.webp)

![读写路径一览](/vibe-reading/images/articles/tidb-official-tiered-storage/06-read-write-path.webp)

### Segment 缓存机制：解决大量小请求的冷读浪费

在 KV Engine 架构中：

- **S3 上**：还是完整的 SST 文件（兼容原有格式）
- **下载时**：按需缓存 Segment，每个 `.seg` 大小约 1MB

层级关系是这样的：SST 文件 → Segment（1MB） → Block（默认 64 KiB，可配置） → 单条 KV 记录


### Meta 文件：Segment 的索引

那怎么知道要下载哪一段呢？靠 Meta 元信息文件。

每个 SST 文件对应一个 Meta 文件，里面记录了各个 Segment 的索引信息。Meta 文件本身很小，常驻本地。冷读时先查 Meta，精准定位到需要的 Segment，再去 S3 下载。

这就像查字典先看目录，然后直接翻到目标页码，而不是从头读到尾。

### 读写路径一览

- **写路径**：和经典 LSM 树基本一致，内存 → L0 → compaction 下沉，冷数据最终落到 S3。
- **读路径**：从 MemTable 开始逐层往下找，命中就返回；如果查到冷数据层且本地没有缓存，就触发 S3 下载对应 Segment。

## 怎么用：普通表 vs 分区表

### 方式一：整张表设置为 IA

最简单的方式，建表时直接指定：

```sql
CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    amount DECIMAL(10,2),
    created_at DATETIME
) STORAGE_CLASS IA;
```

已有表也可以在线修改：

```sql
ALTER TABLE orders STORAGE_CLASS IA;
```

> **💡 注意坑**：`STORAGE_CLASS IA` 和 `ATTRIBUTE` 两种语法不能混用，否则会报错。

### 方式二：分区表按时间冷热分离（强烈推荐）

这是我个人最推荐的用法——按时间分区，历史分区放冷存储，最新分区保热存储。

```sql
CREATE TABLE orders (
    id BIGINT,
    order_date DATE,
    amount DECIMAL(10,2),
    ...
)
PARTITION BY RANGE (order_date) (
    PARTITION p2023 VALUES LESS THAN ('2024-01-01') STORAGE_CLASS IA,
    PARTITION p2024 VALUES LESS THAN ('2025-01-01') STORAGE_CLASS IA,
    PARTITION p2025 VALUES LESS THAN ('2026-01-01') STORAGE_CLASS STANDARD,
    PARTITION p_future VALUES LESS THAN MAXVALUE STORAGE_CLASS STANDARD
);
```

这种方式的好处是：

- **成本精准**：只给真正的历史数据打折，不浪费
- **性能可控**：当年数据全在本地，完全不影响在线业务
- **隔离性好**：冷分区的扫描不会挤出热分区的缓存
- **运维简单**：新的一年加个分区就行，自动化程度高

除了 Range 分区，List 分区（VALUES IN）也支持。但 Hash 分区和 Key 分区目前不支持 IA。

## 功能限制与冷读约束

### 这些限制项要注意

- **索引跟随表**：表设为 IA，所有索引自动变 IA，不支持单独设置
- **Hash / Key 分区不支持设置 IA**
- **仅行存生效**：IA 只针对 TiKV 行存引擎，TiFlash/TiSearch 不跟随 IA，数据始终在本地

### 冷读带宽限制

IA 冷读会带来 500ms ~ 2s/次的额外延迟，这是因为系统做了严格约束，防止冷读把带宽吃光影响正常业务：

| 约束维度 | 上限 | 说明 |
| --- | --- | --- |
| 单 SQL 冷读吞吐 | ≤ 100 MiB/s | 保护单条查询不占用过多带宽 |
| 并发冷读总量 | ≤ 1 GiB/s（≤ 10 并发） | 保护集群内其他租户 |
| TiKV 单次 miss 加载量 | ≤ ~3 MiB（预估值） | 3 个 LSM level 的 segment |

## 如何看待"读放大"问题？

### 什么是读放大？

举个例子：用户只想查一条 100 字节的记录，但如果没命中内存缓存，TiKV 会从 S3 加载 3 个 LSM Level 的 Segment，也就是说实际下载了 3MB——读放大了 30,000 倍。

### 区别两类读放大

**良性读放大：冷读转热读，后续可复用**

这次冷读下载的 Segment 保留在 IA Cache 中，后续访问命中即转为热读，前期放大成本被均摊。

**恶性读放大：一次性扫描，热数据被挤出**

本地热缓存的容量是有限的。如果跑一个大范围的冷数据查询，且后续数据不再复用，加载的新数据会把原来缓存的热数据挤出，触发新的 cache miss 进而对性能造成连锁影响。

因此，Tiered Storage（分层存储）不适合频繁的大范围扫描。

> **ℹ️ IA 不推荐场景**：大范围的 AP 分析查询、强延迟敏感的热点 OLTP 表、查询模式极度分散的数据。
>
> 若业务中存在持续访问大量冷存数据的场景，应将表调整为 Standard 存储，通过慢日志查询页面确定。

## IA Manager：让缓存管理更智能

冷数据不一定意味着"永远从 S3 读"。TiDB 的 IaManager 支持自动识别热点，科学管理冷热数据的生命周期。

![IA Manager 两层缓存设计](/vibe-reading/images/articles/tidb-official-tiered-storage/07-ia-manager-cache.png)

### 两层缓存设计

| 缓存层 | 介质 | 作用 |
| --- | --- | --- |
| Small Queue 内存观察区 | 内存 | 拦截偶发查询，避免不必要的磁盘 IO |
| Main Queue 主缓存层 | 本地磁盘 | 存放真正的热点 Segment |

### 缓存淘汰算法

缓存满了怎么办？淘汰规则是：

- **基础策略**：基于 S3-FIFO
- **优化因子**：访问频率（freq 记数）越高，越不容易被淘汰
- **缓存大小**：系统自动控制

有个点需要明确——用户不能手动配置缓存大小，完全由系统自动管理。

大致经验值：本地缓存约为 S3 冷数据量的 20%~30%。不是所有冷数据都会缓存，只留最热的那部分。

## 切换流程：来去成本大不同

### Standard → IA：轻量级操作

从标准存储切到分层存储，异常轻松。还记得前面说的吗？数据本来就在 S3 上了。

切换只用三步：

1. Region 类型切换，触发 Region Split（IA 表的 Region 必须独立）
2. 生成 Meta 元信息文件
3. 本地 SST 文件后台 GC 逐步删除

没有上传动作，没有数据搬迁，仅清理本地磁盘副本。

参考实测数据，可以说几乎是"无感切换"了：

| 指标 | 数值 |
| --- | --- |
| 逻辑数据量（含索引） | 1.31 TB |
| 切换耗时 | 5 分钟内 |
| QPS 影响 | 几乎无影响 |
| 延迟影响 | 几乎无影响 |

### IA → Standard：回切成本较高

切回标准存储需要把数据从 S3 全部下载回本地。

实测数据参考：

| 指标 | 数值 |
| --- | --- |
| 逻辑数据量（含索引） | 2.09 TB |
| 切换耗时 | 约 3 小时 10 分钟 |
| Standard 分区 QPS 影响 | 下降约 3.78% |
| P99 延迟影响 | 增加约 18.63% |

> **💡 划重点**：S3 上的数据永远不会删。即使切回 Standard，S3 副本依然保留，用于备份恢复、非 Leader 节点 Compaction 等场景。所以切回去只是"本地多了一份副本"，不是"把数据从 S3 搬走"。

## Region 对齐：IA 的隔离保障
![Region 对齐与 Split](/vibe-reading/images/articles/tidb-official-tiered-storage/08-region-alignment.png)

分层存储要求 Region 对齐，简单说就是：一个 Region 要么全是 IA 数据，要么全是非 IA 数据，没有中间态。

为什么要这么设计？因为 IA 和非 IA 的数据管理策略完全不同——缓存策略、compaction 策略、资源配额都不一样，混在一起没法管。

所以当你把一张混杂在普通 Region 里的表改成 IA 时，会触发 **Region Split**：IA 数据分裂成独立的新 Region，和非 IA 数据彻底分开。

反之，切回 Standard 后，独立的 IA Region 后续会找机会自动 Merge 回去。

## 怎么观察冷读情况？

### EXPLAIN ANALYZE 看冷读统计

执行计划里新增了三个字段：

- **总字节数**：冷数据加载了多少字节
- **加载次数**：触发了几次 Segment 下载
- **等待时间**：冷读等待了多久

```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE id = 12345;
```

### 慢日志 & 监控面板

- 触发冷数据下载的慢查询会在慢日志中体现
- Tap 监控面板已增加 IA 相关指标
- CBG 前端页面还在逐步接入，部分区域可能暂不可见

