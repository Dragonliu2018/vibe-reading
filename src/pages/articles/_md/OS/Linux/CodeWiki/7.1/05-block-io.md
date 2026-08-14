---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "块 I/O 子系统"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "块设备", "blk-mq", "bio", "I/O调度"]
description: "Linux 块 I/O 子系统——bio 请求表示、blk-mq 多队列（per-CPU 软队列+per-IRQ 硬件队列）、I/O 调度器、tag 管理。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`block/`（约 4 万行）是 Linux 内核中独立于 VFS 和设备驱动的 I/O 路径层。它存在的根本原因：文件系统产生的 I/O 请求与硬件设备能处理的命令之间存在**速率、粒度、顺序三重不匹配**——上层可能随机产生零散的小 bio，而 NVMe 设备拥有数万个并行队列、需要批量提交命令以发挥 DMA 效率。block 层负责将上层的 bio 请求转换为硬件队列上的 request，在此过程中执行合并（merge）、排序（sort）、调度（schedule）和排队（queue），充当生产者（fs/mm）与消费者（设备驱动）之间的缓冲与调度中枢。

I/O 路径的调度策略是 block 层独立存在的核心理由。不同负载对延迟、吞吐、公平性的需求不同——数据库优先低延迟、桌面需要交互响应、大文件拷贝追求吞吐。这些策略通过可插拔的 I/O 调度器（elevator）实现，与具体文件系统和设备解耦。block 层还管理 tag 资源池（限制在途 request 数量）、处理 I/O 完成路径的 CPU 亲和性（同 CPU 本地完成 vs IPI 跨 CPU 完成）、以及 plug 机制（批量提交增合并率），这些都是独立于上层和下层的横切关注点。

## 模块架构

block 层由四个核心抽象构成，各司其职：

| 子系统 | 核心结构 | 定义位置 | 职责 |
|--------|---------|---------|------|
| bio | `bio` / `bio_vec` / `bvec_iter` | `include/linux/blk_types.h:210` / `include/linux/bvec.h:28` | I/O 请求的载体表示——描述"读写哪些页的哪些部分" |
| request_queue + blk-mq | `request_queue` / `blk_mq_ctx` / `blk_mq_hw_ctx` | `include/linux/blkdev.h:484` / `block/blk-mq.h:19` / `include/linux/blk-mq.h:322` | 多队列管理——per-CPU 软队列接收、per-IRQ 硬件队列派发 |
| elevator | `elevator_type` / `elevator_mq_ops` | `include/linux/elevator.h:97` / `:57` | I/O 调度策略——合并、排序、派发决策，可运行时切换 |
| gendisk | `gendisk` / `block_device_operations` | `include/linux/blkdev.h:146` / `:1656` | 块设备注册——设备名、分区表、ops 函数表，对接设备模型 |

**bio** 是 I/O 请求的数据载体，独立于具体设备和调度策略。一个 bio 描述一段逻辑连续的 I/O：起始扇区（`bi_iter.bi_sector`）、数据长度（`bi_iter.bi_size`）、以及一个 `bio_vec` 数组（`bi_io_vec[]`），每个 `bio_vec` 指向一个物理页的某个区间（`bv_page`/`bv_len`/`bv_offset`），支持 scatter-gather DMA。bio 通过 `bi_next` 串成链表，`bio_chain()` 实现级联完成。

**request_queue + blk-mq** 是请求管理和派发的引擎。`request_queue` 是每个块设备的 I/O 队列，持有调度器（`elevator`）、多队列操作表（`mq_ops`）、per-CPU 软队列集合（`queue_ctx`）和硬件队列列表（`queue_hw_ctx`）。blk-mq 的核心设计是**两层队列**：软队列 `blk_mq_ctx`（per-CPU，`____cacheline_aligned_in_smp`）在提交侧无锁地收集 request；硬件队列 `blk_mq_hw_ctx`（per-IRQ）持有 dispatch list 和 tag 集合，对接具体设备的中断完成路径。CPU 到硬件队列的映射由 `blk_mq_map_queues()` 建立，一个硬件队列可服务多个 CPU。

**elevator** 是可插拔的调度策略接口。`elevator_mq_ops` 定义了 `init_sched`/`allow_merge`/`bio_merge`/`request_merge`/`insert_requests`/`dispatch_request`/`has_work` 等回调，内置四种策略：`none`（无调度，直接派发）、`mq-deadline`（红黑树按 sector 排序 + FIFO 超时）、`bfq`（权重公平分配）、`kyber`（令牌桶限流）。

**gendisk** 是块设备在内核中的注册实体。它持有 major/minor 号、设备名（`disk_name`）、分区表（`part_tbl`）、`block_device_operations` 函数表和关联的 `request_queue`。`device_add_disk()` 将 gendisk 注册到设备模型，用户态通过 `/dev/sdX` 访问。

## 调用链路

一条 bio 从提交到完成的完整路径，数据载体沿链变换：`bio` → `request` → `tag`（硬件命令标识）→ 完成回调。

```
[提交链]
submit_bio(bio)                                    blk-core.c:728
  └─ submit_bio_noacct_nocheck()                   blk-core.c:728
      └─ __submit_bio()                            blk-core.c:627
          ├─ BD_HAS_SUBMIT_BIO? → disk->fops->submit_bio()   堆叠设备(dm/md)重映射递归
          └─ 否则 → blk_mq_submit_bio()            blk-mq.c:3124
              1. blk_mq_get_cached_request()       :3138   plug 缓存的预分配 request
              2. 对齐/轮询检查                       :3167
              3. __bio_split_to_limits()           :3178   超出设备限制则拆分
              4. blk_mq_attempt_bio_merge()        :3187   尝试与已有 request 合并
              5. blk_mq_get_new_requests()         :3202   分配新 request
              6. blk_mq_bio_to_request()           :3214   bio → request 转换
              7. 路径选择:
                 ├─ plug 活跃 → blk_add_rq_to_plug()          本地批量积累
                 ├─ 有调度器 → blk_mq_sched_insert_request()  插入调度器+run
                 └─ 直接 → blk_mq_try_issue_directly()        直接派发硬件队列

[派发链]
blk_mq_run_hw_queue()                              blk-mq.c:2352
  └─ blk_mq_sched_dispatch_requests()              blk-mq-sched.c:317
      └─ blk_mq_dispatch_rq_list()                 blk-mq.c:2116
          └─ for each rq: mq_ops->queue_rq(hctx, &bd)   :2148   驱动 DMA 提交

[完成链]
磁盘中断完成
  └─ blk_mq_complete_request()                     blk-mq.c:1353
      └─ blk_mq_complete_request_remote()          blk-mq.c:1319
          ├─ 同 CPU → 本地完成 (cache 局部性)
          ├─ 跨 CPU → blk_mq_complete_send_ipi()   IPI 到提交 CPU
          └─ 单队列 → BLOCK_SOFTIRQ                softirq 批量
              └─ mq_ops->complete()
                  └─ blk_mq_end_request()
                      └─ blk_update_request()      更新 sector/size
                          └─ bio_endio()           bio.c:1755
                              └─ bi_end_io() 回调   唤醒等待进程
```

<details>
<summary>方法速查</summary>

| 方法 | 文件:行号 | 一行职责 | 关键决策 |
|------|----------|----------|----------|
| `submit_bio` | `blk-core.c:728` | bio 提交入口 | 区分堆叠设备 vs 标准设备 |
| `blk_mq_submit_bio` | `blk-mq.c:3124` | bio→request 转换核心 | plug/合并/调度器三条路径选择 |
| `blk_mq_get_cached_request` | `blk-mq.c:3138` | 从 plug 缓存取预分配 request | 避免热路径重复分配 |
| `blk_mq_attempt_bio_merge` | `blk-mq.c:3187` | 尝试 bio 合并到已有 request | FRONT/BACK/DISCARD_MERGE |
| `blk_mq_bio_to_request` | `blk-mq.c:3214` | bio 转换为 request | 数据载体变换关键点 |
| `blk_mq_run_hw_queue` | `blk-mq.c:2352` | 运行硬件队列 | 从调度器或 dispatch list 取 request |
| `blk_mq_sched_dispatch_requests` | `blk-mq-sched.c:317` | 调度器派发 | 调度器→dispatch list→queue_rq |
| `blk_mq_dispatch_rq_list` | `blk-mq.c:2116` | 遍历派发 request 到驱动 | 调 `mq_ops->queue_rq` |
| `blk_mq_complete_request` | `blk-mq.c:1353` | 请求完成入口 | 本地 vs IPI vs softirq 策略 |
| `blk_mq_complete_request_remote` | `blk-mq.c:1319` | 远程完成决策 | 同 CPU/IPI/softirq 三选一 |
| `blk_mq_end_request` | `blk-mq.c` | 结束 request | 调 `blk_update_request` + `bio_endio` |
| `bio_endio` | `bio.c:1755` | 结束 bio | 级联完成 + 调 `bi_end_io` |
| `blk_mq_get_tag` | `blk-mq.c` | 分配 tag | `sbitmap_queue` 无锁分配 |
| `blk_mq_tag_to_rq` | `blk-mq.h:794` | tag→request 映射 | `rqs[tag]` 数组直接定位 |

</details>

## 核心实现

### bio 结构与分配

bio 是 block 层最基本的数据载体。其核心字段定义在 `include/linux/blk_types.h:210-287`：

```c title="include/linux/blk_types.h"
struct bio {
    struct bio          *bi_next;       // bio 链表
    struct block_device *bi_bdev;       // 目标块设备
    unsigned int         bi_opf;        // 低 8 位 REQ_OP + 高 24 位标志
    blk_status_t         bi_status;     // 完成状态
    struct bio_vec      *bi_io_vec;     // bio_vec 数组
    struct bvec_iter     bi_iter;       // 当前迭代位置(sector/size/idx)
    bio_end_io_t        *bi_end_io;     // 完成回调
    void                *bi_private;    // 调用者私有数据
    unsigned short       bi_vcnt;       // bio_vec 数量
    unsigned short       bi_max_vecs;   // 最大 bio_vec 容量
    atomic_t             __bi_cnt;      // 引用计数
    struct bio_set      *bi_pool;       // 来源 bio_set(回收用)
    // ...
};
```

`bio_vec`（`include/linux/bvec.h:28-32`）描述一个连续物理内存段：`bv_page`（物理页）、`bv_len`（长度）、`bv_offset`（页内偏移）。一个 bio 可包含最多 `BIO_MAX_VECS=256`（`bio.h:13`）个 bio_vec，天然支持 scatter-gather DMA——硬件可一次传输多个不连续物理页。`bvec_iter`（`bvec.h:77`）跟踪 bio 的迭代位置：`bi_sector`（当前扇区）、`bi_size`（剩余字节）、`bi_idx`（当前 bio_vec 索引），使 bio 可以被部分消费后继续推进。

bio 的分配走 `bio_alloc`（`bio.h:364`）→ `bio_alloc_bioset`（`bio.c:535-608`），采用三级缓存策略：优先从 per-CPU 缓存（`bio_alloc_cache`）取——这是热路径，无需加锁；per-CPU 缓存耗尽则从 `mempool` 取（预分配的 bio 池）；mempool 也空则从 rescue workqueue 补充。bio_vec 的分配按预期 vec 数量分档：16/64/128/256 对应不同的 slab cache，减少内存碎片。`bio_set`（`bi_pool`）是对象池抽象，per-CPU 缓存 + mempool + rescue workqueue 三级保障，兼顾性能（热路径无锁）与可靠性（内存压力下不失败）。

bio 链与级联完成：多个 bio 通过 `bi_next` 串成链表（`bio_list` 结构，`bio.h:538-652`）。`bio_chain()`（`bio.c:1755-1798`）设置 `BIO_CHAIN` 标志并操作 `__bi_remaining` 计数——父 bio 的 `bi_end_io` 只在所有子 bio 完成后才被调用，实现级联完成语义。`bio_endio`（`bio.c:1755-1799`）负责结束 bio：更新状态、检查级联计数、最终调用 `bi_end_io` 回调通知上层。

### blk-mq 多队列模型

blk-mq（Block Multi-Queue）是 Linux 3.16 引入、在 7.1 中已是唯一路径的多队列 I/O 框架。它解决 legacy 单队列在多核 + 多队列 SSD 上的锁竞争问题——传统 `request_queue` 的单队列锁在 32+ 核系统上成为瓶颈。

**两层队列架构**：

- **软队列** `blk_mq_ctx`（`block/blk-mq.h:19-32`）：per-CPU 分配，`____cacheline_aligned_in_smp` 确保 SMP 下 cache line 对齐避免 false sharing。每个 ctx 持有 `rq_lists[HCTX_MAX_TYPES]`（按 default/read/poll 分类）。提交侧通过 `blk_mq_get_ctx()` 取 `current` 所在 CPU 的 ctx——热路径完全无锁。

- **硬件队列** `blk_mq_hw_ctx`（`include/linux/blk-mq.h:322-463`）：per-IRQ 分配（一个硬件队列对应一个或多个 MSI-X 中断），持有 dispatch list（待派发 request 链表）、`tags`（tag 集合）、`cpumask`（绑定的 CPU 集合）和 `state`（ACTIVE/STOPPED 等）。

- **CPU→hctx 映射**：`blk_mq_queue_map`（`blk-mq.h:475-479`）记录 CPU 到硬件队列的映射表，`blk_mq_map_queues()` 在初始化时按 CPU 拓扑分配——同一 NUMA 节点的 CPU 优先映射到同一硬件队列，减少跨 NUMA DMA。

**tag_set 与 tag 管理**：`blk_mq_tag_set`（`blk-mq.h:534-557`）封装多队列共享配置——`ops`（`blk_mq_ops`）、`nr_hw_queues`、`queue_depth`、`tags[]`（每个硬件队列一个 `blk_mq_tags`）。tag_set 可被多个 `request_queue` 共享（如 NVMe 多命名空间）。`blk_mq_tags`（`blk-mq.h:774-792`）用 `sbitmap_queue` 实现 tag 分配——tag 是 request 在硬件队列中的唯一标识，也是 `rqs[]` 数组的索引。`blk_mq_get_tag()` 从 sbitmap 无锁分配 tag，`blk_mq_tag_to_rq()`（`blk-mq.h:794`）通过 `tags->rqs[tag]` 直接定位 request——O(1) 的 tag→request 映射，驱动完成中断时只需报告 tag 号。

**blk_mq_submit_bio 流程**（`blk-mq.c:3124-3250`）：

```c title="block/blk-mq.c (简化)"
blk_mq_submit_bio(bio) {
    // 1. 尝试从 plug 缓存取预分配 request
    rq = blk_mq_get_cached_request(plug, bio);     // :3138

    // 2. 检查对齐和轮询（REQ_POLLED 强制本地完成）
    if (!blk_validate_atomic_write(bio))            // :3167

    // 3. 超出设备限制则拆分
    if (bio_too_big) __bio_split_to_limits(bio);    // :3178

    // 4. 尝试合并到已有 request（调度器或 plug 中的）
    if (!blk_mq_attempt_bio_merge(q, bio))          // :3187
        // 5. 分配新 request
        rq = blk_mq_get_new_requests(q, bio);       // :3202

    // 6. bio → request 数据转换
    blk_mq_bio_to_request(rq, bio);                 // :3214

    // 7. 三条路径选择
    if (plug)          → blk_add_rq_to_plug()       // 本地批量积累
    else if (has_sched) → insert + run              // 插入调度器队列
    else               → blk_mq_try_issue_directly  // 直接派发
}
```

plug 机制是 blk-mq 的关键优化：`current->plug` 是 per-task 的 request 积累列表，`blk_add_rq_to_plug()` 把新 request 加入其中而不立即提交。当 plug 列表积累到一定数量（或 task 主动 flush、或调度时退出），`blk_mq_flush_plug_list()` 批量提交——这增加了 bio 合并的机会（同方向的 bio 可合并为一个 request），减少了硬件队列的提交次数。plug 中还缓存了预分配的 request（`blk_mq_get_cached_request`），避免热路径每次都分配新 request。

### I/O 调度器

I/O 调度器（elevator）是 block 层的策略可插拔点。`elevator_mq_ops`（`include/linux/elevator.h:57-84`）定义了调度器必须实现的回调：

| 回调 | 职责 | 调用时机 |
|------|------|----------|
| `init_sched` | 初始化调度器私有数据 | 队列创建时 |
| `allow_merge` | 判断是否允许 bio 合并到 request | 合并检查时 |
| `bio_merge` | 尝试将 bio 合并到调度器中的 request | `blk_mq_attempt_bio_merge` |
| `request_merge` | 尝试将 request 合并到另一个 request | 派发前 |
| `insert_requests` | 将 request 插入调度器内部数据结构 | `blk_mq_sched_insert_request` |
| `dispatch_request` | 从调度器取出下一个待派发 request | `blk_mq_sched_dispatch_requests` |
| `has_work` | 调度器中是否有待派发 request | 队列运行检查 |

内置四种调度策略：

- **none**：不调度，request 直接进入 dispatch list。适用于 NVMe 等多队列设备——硬件自身有队列调度能力，软件层再排序反而增加延迟。单队列设备默认不挂调度器（`BLK_MQ_F_NO_SCHED_BY_DEFAULT`）。

- **mq-deadline**（`mq-deadline.c:985`）：为每个 I/O 方向（read/write）维护红黑树按 sector 排序（利于磁盘顺序访问）+ FIFO 超时队列（防止饥饿）。当某 request 超时或 FIFO 队头到期时强制派发，在顺序性和公平性间平衡。

- **bfq**（`bfq-iosched.c:7593`）：Budget Fair Queueing，按进程/组分配 I/O 预算（时间片），权重公平调度。适合桌面和交互场景——保证高优先级进程的 I/O 延迟。

- **kyber**（`kyber-iosched.c:990`）：基于令牌桶限流，为 read/write 分别设令牌数，限制在途 request 数量以控制延迟。适合低延迟 SSD 场景。

合并机制是调度器的核心优化之一。`elv_rqhash_find`（`elevator.c:194`）通过哈希表（key = `request sector + sectors`）快速查找可合并的 request。合并方向有三种（`elevator.h:16-21`）：`FRONT_MERGE`（bio 合并到 request 前部）、`BACK_MERGE`（合并到后部）、`DISCARD_MERGE`（discard 请求合并）。排序则用红黑树（`elv_rb_add`/`elv_rb_del`/`elv_rb_find`，`elevator.h:199-201`），保证 `dispatch_request` 能按 sector 顺序取出 request。

调度器通过 `elv_register`（`elevator.c:498`）注册 `elevator_type`，运行时可用 `elevator_switch`（`elevator.c:562-607`）切换——先 drain 所有在途 request，再替换 ops 并重新初始化。

### 请求完成

I/O 完成路径的设计核心是**CPU 亲和性决策**——在哪个 CPU 上执行完成回调影响 cache 局部性和延迟。`blk_mq_complete_request`（`blk-mq.c:1353`）首先检查 `mq_ops->complete` 是否需要远程执行：

```c title="block/blk-mq.c (简化)"
blk_mq_complete_request(rq) {
    if (!blk_mq_complete_need_ipi(rq))
        mq_ops->complete(rq);              // 本地直接完成
    else
        blk_mq_complete_request_remote(rq);
}

blk_mq_complete_request_remote(rq) {       // :1319-1343
    if (same_cpu)       → 本地完成         // cache 局部性最优
    else if (multi_hwq) → blk_mq_complete_send_ipi()  // IPI 到提交 CPU
    else                → raise BLOCK_SOFTIRQ  // softirq 批量处理
}
```

三策略的选择依据：如果完成中断在提交 bio 的同一 CPU 上（`same_cpu`），直接本地完成——数据还在 cache 中，延迟最低；如果是多硬件队列设备（`multi_hwq`），发 IPI（Inter-Processor Interrupt）到提交 CPU 执行完成回调——保证 `bi_end_io` 在提交 CPU 运行，上层数据结构（如 page cache 的 folio lock）在该 CPU 上；如果是单硬件队列设备，raise `BLOCK_SOFTIRQ` 在任意 CPU 批量处理——减少 IPI 开销。

轮询模式（`REQ_POLLED`）强制本地完成——轮询路径下没有中断，完成由 `blk_rq_poll`（`blk-mq.c:5277`）→ `mq_ops->poll` 主动检查，完成后直接在调用者 CPU 上执行回调。

完成链从驱动中断开始：`mq_ops->complete` → `blk_mq_end_request` → `blk_update_request`（更新 request 的已完成 sector/size）→ `bio_endio` → `bi_end_io` 回调（如 `mpage_end_io` → `folio_end_read` 唤醒等待 page cache 的进程）。`blk_mq_free_request` 释放 request 和 tag 回到 `sbitmap_queue`。

### 块设备注册

块设备通过 `gendisk` 结构注册到内核。`gendisk`（`include/linux/blkdev.h:146-231`）持有：`major`/`first_minor`（设备号）、`disk_name`（如 "sda"）、`part_tbl`（分区表，`part0` 是整个磁盘）、`fops`（`block_device_operations`）、`queue`（关联的 `request_queue`）、`bio_split`（bio 拆分回调）。

`block_device_operations`（`blkdev.h:1656-1690`）是块设备的 ops 函数表，类似字符设备的 `file_operations`，但面向块设备语义：

```c title="include/linux/blkdev.h"
struct block_device_operations {
    int (*open)(struct block_device *, fmode_t);
    void (*release)(struct gendisk *, fmode_t);
    int (*ioctl)(struct block_device *, fmode_t, unsigned, unsigned long);
    void (*submit_bio)(struct bio *);       // 堆叠设备重映射入口
    int (*poll_bio)(struct block_device *, struct bio *, unsigned int);
    void (*free_disk)(struct gendisk *);    // 磁盘释放回调
    // ...
};
```

注册流程：`register_blkdev`（`genhd.c:234`）注册 major 号 → `blk_alloc_disk` / `blk_mq_alloc_disk` 分配 gendisk 和 request_queue（`blk_mq_alloc_disk` 同时初始化 blk-mq 队列） → 填充 `fops`/`queue` 等字段 → `device_add_disk`（`genhd.c:624`）将 gendisk 加入设备模型（sysfs、udev 可见） → 使用完毕 `del_gendisk` 注销。`genhd_device_init`（`genhd.c:995`）在 `subsys_initcall` 中初始化块设备子系统。

堆叠设备（dm/md）有特殊路径：它们设置 `BD_HAS_SUBMIT_BIO` 标志，`__submit_bio`（`blk-core.c:627`）检测到此标志后调 `disk->fops->submit_bio(bio)` 而非 `blk_mq_submit_bio`——驱动自定义的 `submit_bio` 将 bio 重映射到下层设备，递归调用 `submit_bio`。为防止递归导致的栈溢出，`__submit_bio_noacct` 使用 `current->bio_list` 迭代提交——bio 不直接递归，而是放入当前 task 的 bio_list，由循环逐个处理。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 生产者-消费者 | 上层 `submit_bio` 生产 bio，硬件队列 `queue_rq` 消费 request | 解耦 I/O 产生速率与硬件处理速率，plug 机制提供批量与背压 |
| 策略模式 | `elevator_mq_ops` 定义调度接口，none/mq-deadline/bfq/kyber 为具体策略 | 调度策略可运行时切换，不修改核心 I/O 路径代码（开闭原则） |
| 资源池 | `blk_mq_tags` 用 `sbitmap_queue` 管理 tag，tag 是 request 在 `rqs[]` 的索引 | 限制在途 request 数量（防止驱动过载），无锁分配 tag 避免 hot lock |
| 对象池 | `bio_set` per-CPU 缓存 + mempool + rescue workqueue 三级分配 | 高频 bio 分配走 per-CPU 无锁路径，内存压力下 mempool 保底不失败 |
| 两级队列 | per-CPU 软队列 → per-IRQ 硬件队列 | 提交侧无锁（per-CPU），消费侧匹配硬件中断亲和性（per-IRQ） |

## 模块间交互

- **fs/（文件系统）**：`submit_bio` 是 fs 回写 page cache 的入口——`generic_writepages` → `mpage_writepage_fn` → `submit_bio` 提交写请求；`filemap_read` 读未命中时经 `ext4_mpage_readpages` 构造 bio 提交读请求。完成回调 `bi_end_io`（如 `mpage_end_io`）唤醒 fs 层等待的 `folio_wait_bit`。
- **mm/（内存管理）**：swap I/O 直接调 `submit_bio`（`REQ_SWAP` 标志），把匿名页写回 swap 分区；`bio_release_pages` 在 bio 完成后释放引用的 page，与 mm 的 page refcount 交互。
- **drivers/（设备驱动）**：块设备驱动实现 `blk_mq_ops`（`queue_rq`/`complete`/`poll`/`timeout`/`init_hctx`/`map_queues`），block 层在 `blk_mq_dispatch_rq_list` 中调 `queue_rq` 将 request 交给驱动做 DMA；驱动中断完成后调 `blk_mq_complete_request` 通知 block 层。
- **堆叠设备 dm/md**：通过 `block_device_operations.submit_bio` 重映射 bio 到下层设备，递归调用 `submit_bio`，用 `current->bio_list` 迭代防栈溢出——dm 的 `dm_submit_bio` 按 mapping table 查目标设备、split bio、重新提交。

## 扩展方式

新增一个 I/O 调度器需要实现 `elevator_mq_ops` 并注册：

1. 在 `block/` 下新建调度器源文件（如 `block/my_sched.c`），定义 `elevator_mq_ops` 实例——实现 `init_sched`/`insert_requests`/`dispatch_request`/`has_work`/`allow_merge`/`bio_merge` 等回调。
2. 用 `elevator_type` 包装 ops，在 `module_init` 中调 `elv_register`（`elevator.c:498`）注册调度器类型。
3. 在 `Kconfig` 中添加 `CONFIG_MY_SCHED` 选项，在 `Makefile` 中添加编译规则。
4. 注册后可通过 sysfs（`/sys/block/sdX/queue/scheduler`）或 `elevator_switch`（`elevator.c:562-607`）运行时切换到新调度器。

新增块设备驱动则需要实现 `blk_mq_ops`（`queue_rq`/`complete` 等），用 `blk_mq_alloc_disk` 分配带 blk-mq 队列的 gendisk，填充 `block_device_operations`，最后 `device_add_disk` 注册。参考 `drivers/nvme/host/pci.c` 的 NVMe 驱动实现。
