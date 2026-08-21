---
source:
  type: "源码解读"
  project: "ByConity"
  url: "https://github.com/ByConity/ByConity"
title: "存储抽象"
date: "2026-08-21T15:08:54+08:00"
category: [Database, OLAP, ByConity, CodeWiki, "1.0.0"]
tags: ["ByConity", "C++", "S3", "HDFS", "缓存", "存储"]
description: "ByConity 共享存储抽象：DiskByteS3/HDFS 无本地元数据、DiskCacheWrapper 本地 SSD 缓存、StoragePolicy 卷管理。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ByConity/CodeWiki/1.0.0/00-overview)

---

## 模块定位

存算分离的"存储"必须满足两点：worker 无状态（不能在本地维护文件元数据），且访问远端对象存储要快（网络延迟需缓存掩盖）。**Disks**（`src/Disks/`，约 12k 行）就是把本地盘、远端 HDFS/S3 抽象成统一 `IDisk` 接口，并在其上叠加本地 SSD 缓存（`DiskCacheWrapper`）与卷策略（`StoragePolicy`/`IVolume`）。它是 worker 读写共享 part 数据的入口。

---

## 模块架构

```text
                     IDisk (抽象接口)
                    /     |        \
        IDiskRemote        DiskByteS3    DiskByteHDFS   ← ByConity 自研(无本地元数据)
       (CH 原版基类)        (直接继承 IDisk)              (1.0.0 启用)
        /     \
    DiskS3   DiskHDFS     ← CH 原版(维护本地 metadata, 有状态)
   (communitys3)

  装饰器叠加(注册时层层包装):
    DiskByteS3 → DiskCacheWrapper(本地SSD缓存) → DiskRestartProxy(重启代理)

  StoragePolicy → IVolume 列表
    ├─ SingleDiskVolume (单盘)
    ├─ VolumeJBOD (round-robin 选盘)
    └─ VolumeRAID1 (多盘副本, 1.0.0 未启用)
```

关键区分：`DiskByteS3`/`DiskByteHDFS` 直接继承 `IDisk`、**无本地 metadata 层**（S3 路径即文件路径），是存算分离下 worker 无状态的关键；ClickHouse 原版 `DiskS3`/`DiskHDFS`（经 `IDiskRemote`）在本地维护 metadata 文件记录对象列表，是有状态的单机设计。1.0.0 中 `bytes3`/`s3` 两个 type 名都指向 `DiskByteS3`，原版注册为 `communitys3`。

> `CloudFS` 在 1.0.0 不是独立类/目录，而是 `DiskByteS3.cpp:320` 注释 `// initialize cfs` 所指的 ByConity 云文件系统概念——即 `DiskByteS3`/`DiskByteHDFS` 这组无本地元数据的 Disk 实现集合。

---

## 调用链路

### 读 part

```text
worker → StoragePolicy::reserve(bytes)
  → VolumeJBOD::reserve round-robin 选 disk  [VolumeJBOD.cpp:88]
  → DiskCacheWrapper::readFile               [DiskCacheWrapper.cpp:107]
       ├─ cache_file_predicate(path) 过滤(只缓存 idx/mrk/txt/dat)
       ├─ cache_disk->exists(path) 命中 → cache_disk->readFile 返回
       └─ miss → acquireDownloadMetadata:
            首线程 DiskDecorator::readFile 回源(→ DiskByteS3::readFile)
            其他线程 condition.wait 等待
            下载完 cache_disk->readFile 返回 ReadBuffer
  → DiskByteS3::readFile                       [DiskByteS3.cpp:207]
       └─ 启用 IO Scheduler: WSReadBufferFromFS; 否则 ReadBufferFromS3(可选 prefetch)
```

### 写 part

```text
CnchDataWriter → storage.getStoragePolicy(MAIN)->getAnyDisk()  [CnchDataWriter.cpp:224]
  → DiskCacheWrapper::writeFile               [DiskCacheWrapper.cpp:181]
       ├─ 先写 cache_disk(CompletionAwareWriteBuffer 包装)
       └─ finalize 时回调: 从 cache 读回 → DiskDecorator::writeFile 写远端
  → DiskByteS3::writeFile → WriteBufferFromByteS3 (multipart upload)
```

### 缓存命中/回填

命中：`cache_disk->exists(path)` → 直接读本地 SSD。Miss 回填：先写 `.tmp` 文件，`copyData` 完成后 `moveFile` 原子替换，避免部分写入被读到。并发控制：`file_downloads` map + `FileDownloadMetadata`（NONE/DOWNLOADING/DOWNLOADED/ERROR 状态机），同一文件只下载一次。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `IDisk::readFile/writeFile` | 读写文件 | 抽象接口 |
| `DiskCacheWrapper::readFile` | 缓存回源 | 命中直读/miss 单线程下载 |
| `DiskCacheWrapper::writeFile` | 先缓存后远端 | CompletionAwareWriteBuffer 回调 |
| `DiskByteS3::readFile` | S3 读取 | 可选 IO Scheduler/prefetch |
| `StoragePolicy::reserve` | 遍历 volume 预留 | move_factor 冷热迁移 |
| `VolumeJBOD::reserve` | round-robin 选盘 | atomic last_used.fetch_add |
| `DiskRestartProxy::restart` | 运行时换配置 | shared_timed_mutex 等待 IO |

</details>

---

## 核心实现

### 为什么用 DiskCacheWrapper 而非全远端

共享存储（S3/HDFS）每次访问有网络延迟（典型 10-50ms），本地 SSD 缓存把索引文件（idx/mrk）读取降到微秒级。`cache_file_predicate`（`registerDiskS3.cpp:239`）只缓存小文件（idx/mrk2/mrk3/txt/dat），避免缓存大 data 文件浪费 SSD 空间。当前无 LRU 淘汰逻辑——缓存靠 part 删除时级联清理。

### DiskByteS3 vs DiskS3

`DiskS3`（`S3/DiskS3.h`）继承 `IDiskRemote`，在本地维护 `Metadata`（`remote_fs_objects` 列表 + `ref_count` + `read_only`），每次读写先读本地 metadata 再访问 S3——适合单机。`DiskByteS3`（`DiskByteS3.h`）直接继承 `IDisk`，S3 路径即文件路径，无中间 metadata 层，原生支持 `IOScheduler`（`DiskByteS3.cpp:210`）做 IO 调度——适合存算分离下 worker 无状态的要求。`supportRenameTo` 返回 false（S3 不支持 rename）。

### StoragePolicy / Volume 决定 part 分布

`StoragePolicy`（`StoragePolicy.h`）管理按优先级排序的 `Volumes`，`reserve` 遍历 volume 依次尝试，`move_factor` 控制冷热数据跨 volume 迁移。`VolumeJBOD` 用 atomic round-robin（`last_used.fetch_add(1)`）在多盘间均匀分布，`max_data_part_size` 限制单 part 大小防倾斜。`VolumeRAID1` 在所有盘写副本返回 `MultiDiskReservation`，但 1.0.0 头部标注 "doesn't used in codebase"。

### DiskRestartProxy

运行时需更改磁盘配置（如 S3 endpoint 切换）时，`restart`（`DiskRestartProxy.cpp:301`）获取写锁等待所有正在进行的读写完成（ReadBuffer/WriteBuffer 持有读锁），然后 shutdown+startup 重建 disk。用 10ms `try_lock_for` 轮询避免长时间阻塞新请求。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 装饰器 | `DiskDecorator`/`DiskCacheWrapper`/`DiskRestartProxy` | 叠加缓存/重启能力，可组合 |
| 工厂 | `DiskFactory`（registerDisks.cpp:47） | type→creator 分发 |
| 策略 | `StoragePolicy::reserve` 遍历 volume | 冷热迁移 |
| 组合 | `IVolume` 持 `Disks` 列表 | 卷含多盘 |

---

## 模块间交互

被 `Storages`/`StorageCnchMergeTree`（读写 part）、`CloudServices`/`CnchDataWriter`（写）、`WorkerTasks`（merge 读写）、`CloudServices`/`CnchManifestCheckpointThread`（checkpoint 取 disk）调用。依赖 IO 模块（`ReadBufferFromS3`/`WriteBufferFromByteS3`/`AsynchronousBoundedReadBuffer`/`IOScheduler`）。

---

## 扩展方式

**新增存储后端**：继承 `IDisk`（参考 `DiskByteS3`），实现 `readFile`/`writeFile`/`removeRecursive` 等纯方法；写 `registerDiskXxx` 注册到 `DiskFactory`，在 `registerDisks.cpp` 调用。

**调整缓存策略**：修改 `registerDiskS3.cpp:239` 的 `cache_file_predicate` 谓词（如加入 data 文件缓存），或扩展 `DiskCacheWrapper` 加 LRU 淘汰。

**新增 Volume 类型**：继承 `IVolume` 实现 `reserve`，在 `createVolume.cpp:57` 的 `createVolumeFromConfig` 加 raid_type 分支。
