---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "io_uring 异步 I/O"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "io_uring", "异步IO", "SQPOLL"]
description: "Linux io_uring 异步 I/O 框架——共享内存 SQ/CQ ring、SQPOLL 零系统调用、53 种 opcode、deferred completion 批量完成。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`io_uring/` 是 Linux 5.1 引入的异步 I/O 框架，从根本上重新设计了内核与用户空间之间的 I/O 交互模型。传统的 `read`/`write`/`epoll`+`read` 模型中，每次 I/O 操作都需要一次系统调用陷入内核——系统调用的开销（上下文切换、参数拷贝、权限检查）在高 IOPS 场景下成为瓶颈。`io_uring` 的核心思路是：用户和内核共享一块内存中的环形队列（SQ/CQ ring），用户直接写 SQE（Submission Queue Entry）到共享内存，一次 `io_uring_enter` 系统调用批量提交所有请求；内核完成后将 CQE（Completion Queue Entry）写入共享内存，用户直接读取——元数据全程零拷贝。

`io_uring/` 之所以独立成子系统而非走传统 syscall 路径，原因在于它不只是一个新系统调用，而是一套完整的异步执行框架：它拥有自己的实例上下文（`io_ring_ctx`）、内核 I/O 控制块（`io_kiocb`）、操作分发表（`io_issue_defs[]`）、异步工作队列（io-wq）、SQPOLL 内核轮询线程，以及 53 种覆盖文件/网络/定时器/取消等操作类型的 opcode。它像一个"迷你运行时"嵌入内核中，将 VFS、网络栈、块 I/O 等子系统统一在异步提交/完成的框架下。

## 模块架构

`io_uring/` 模块内部围绕四个核心组件构建：实例上下文、共享内存 ring、内核控制块、操作分发表。它们的关系是：用户通过 `io_uring_setup` 创建一个 `io_ring_ctx` 实例，该实例持有一对共享内存 ring（SQ + CQ）；用户提交的 SQE 被内核读取后转化为 `io_kiocb` 控制块，通过 `opdef` 表查到对应的 `prep`/`issue` 函数执行；完成后结果写回 CQ ring 的 CQE。

```
┌──────────────────────────────────────────────────────────────────┐
│                    io_uring 模块内部结构                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  用户空间                      内核空间                            │
│  ┌─────────────┐              ┌───────────────────────────────┐  │
│  │ SQ ring     │◄──共享内存──►│ io_ring_ctx (实例上下文)       │  │
│  │ (用户写tail)│              │  ├─ rings (io_rings)          │  │
│  │             │              │  │   ├─ SQ head/tail/mask     │  │
│  └─────────────┘              │  │   ├─ CQ head/tail/mask     │  │
│  ┌─────────────┐              │  │   └─ cqes[]                │  │
│  │ CQ ring     │◄──共享内存──►│  ├─ sq_sqes (SQE数组)         │  │
│  │ (用户读head)│              │  ├─ cached_sq_head            │  │
│  └─────────────┘              │  ├─ cached_cq_tail            │  │
│                               │  ├─ file_table / buf_table    │  │
│                               │  ├─ submit_state              │  │
│                               │  ├─ sq_data (SQPOLL)          │  │
│                               │  └─ uring_lock / compl_lock   │  │
│                               │                               │  │
│  SQE ──读取──► io_get_sqe ──► io_kiocb (内核控制块)            │  │
│                    │              ├─ opcode / flags             │  │
│                    │              ├─ cqe (内嵌结果)             │  │
│                    │              ├─ ctx / file / async_data    │  │
│                    │              └─ link / refs                │  │
│                    ▼              ┌─────────────────────────┐   │  │
│               io_init_req ──查表──► opdef: io_issue_defs[]  │   │  │
│                    │              │  [opcode].prep / issue   │   │  │
│                    │              │  53 种 opcode 分发        │   │  │
│                    ▼              └─────────────────────────┘   │  │
│               io_issue_sqe ──► def->issue(req, flags)           │  │
│                    │              IOU_COMPLETE     → 立即完成    │  │
│                    │              IOU_ISSUE_SKIP_COMPLETE → 异步 │  │
│                    ▼                                            │  │
│               io_fill_cqe_req ──► CQE 写入 CQ ring             │  │
│               io_commit_cqring ──► smp_store_release(cq.tail)  │  │
│               io_cqring_wake ──► 唤醒等待的用户                │  │
│                               └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**io_ring_ctx**（include/linux/io_uring_types.h:293-492）是每个 io_uring 实例的中心上下文，持有一切状态：`rings` 指向共享内存中的 `io_rings` 结构（包含 SQ/CQ 的 head/tail/mask 和 CQE 数组），`sq_sqes` 指向共享内存中的 SQE 数组，`cached_sq_head`/`cached_cq_tail` 是内核侧的缓存游标（避免每次操作都读写共享内存），`file_table`/`buf_table` 管理注册的文件描述符和缓冲区，`submit_state` 跟踪批量提交状态，`sq_data` 指向 SQPOLL 线程的数据。两把锁分工明确：`uring_lock` 保护提交侧（SQ ring 操作），`completion_lock`（spinlock）保护完成侧（CQ ring 操作）。

**io_rings**（include/linux/io_uring_types.h:156-225）是真正映射到用户空间的共享内存结构。它打包了 SQ 和 CQ 的 head/tail/ring_mask/ring_entries 以及 `cqes[]` 数组，通过 `mmap` 映射后用户和内核直接读写同一块内存。head/tail 的生产者-消费者约定是：SQ ring 中用户是生产者（写 tail）、内核是消费者（读 head）；CQ ring 中内核是生产者（写 tail）、用户是消费者（读 head）。

**io_kiocb**（include/linux/io_uring_types.h:707-789）是内核 I/O 控制块，代表一个正在处理的请求。从 SQE 转化而来，内嵌 `cqe` 字段（完成时直接填充写回 CQ ring），`async_data` 保存异步执行所需的上下文（如 iovec 副本），`link` 指向链式请求的下一个，`refs` 引用计数管理生命周期。

**opdef 表**（io_uring/opdef.c:54-592，`io_issue_defs[]`）是 53 种 opcode 的分发表，每个条目包含 `prep`（预处理校验）和 `issue`（执行操作）两个函数指针。`io_init_req` 查表调用 `def->prep`，`io_issue_sqe` 查表调用 `def->issue`——新增操作只需在表中添加条目，无需修改分发逻辑。

## 调用链路

io_uring 有两条核心链路：submit 链（用户提交请求到内核执行）和 complete 链（内核完成请求到通知用户）。两条链路通过 `io_kiocb` 控制块衔接，数据流为 SQE → io_kiocb → CQE。

```
=== Submit 链 ===

io_uring_enter(2)              [io_uring/io_uring.c:2600]
  │  输入: fd (io_uring fd), to_submit (SQE数量), flags
  │  SQPOLL? → wake_up(sq_data->wait) 唤醒轮询线程
  │  非 SQPOLL? → 获取 uring_lock
  │
  ▼
io_submit_sqes                 [io_uring/io_uring.c:2026]
  │  __io_sqring_entries() 算可用 SQE 数
  │  循环: io_alloc_req → io_get_sqe → io_submit_sqe
  │  数据: SQE(io_uring_sqe) → io_kiocb (从缓存池分配)
  │
  ▼
io_get_sqe                     [io_uring/io_uring.c:1994]
  │  cached_sq_head 读索引, sq_array 间接索引
  │  READ_ONCE 保证读到稳定的 SQE
  │
  ▼
io_init_req                    [io_uring/io_uring.c:1734]
  │  从 SQE 填充 io_kiocb (opcode/flags/user_data/fd)
  │  def = &io_issue_defs[opcode] 查 opdef 表
  │  def->prep(req, sqe) 预处理校验
  │
  ▼
io_issue_sqe                   [io_uring/io_uring.c:1414]
  │  → __io_issue_sqe           [io_uring/io_uring.c:1381]
  │  def->issue(req, issue_flags) 执行实际操作
  │  返回 IOU_COMPLETE(0)      → 立即完成
  │  返回 IOU_ISSUE_SKIP_COMPLETE (-EIOCBQUEUED) → 异步发出


=== Complete 链 ===

[Inline/Deferred 路径]
io_req_complete_defer          [io_uring/io_uring.h:488]
  │  加入 ctx->submit_state.compl_reqs 链表
  │
  ▼
__io_submit_flush_completions  [io_uring/io_uring.c:1140]
  │  遍历 compl_reqs 链表
  │  io_fill_cqe_req → 写 CQE
  │  io_cq_unlock_post → 一次提交 + 唤醒 (批量优化)
  │  数据: io_kiocb → CQE(io_uring_cqe) 写入 CQ ring

[异步 io-wq 路径]
io_req_complete_post           [io_uring/io_uring.c:918]
  │  io_fill_cqe_req           [io_uring/io_uring.h:295]
  │  │  cqe_cached 取槽, 拷 req->cqe (user_data/res/flags)
  │  │
  │  ▼
  │  io_commit_cqring          [io_uring/io_uring.h:412]
  │  │  smp_store_release(rings->cq.tail, cached_cq_tail)
  │  │  内存屏障: 保证 CQE 内容在 tail 更新前对用户可见
  │  │
  │  ▼
  │  io_cqring_wake            [io_uring/io_uring.h:436]
  │     唤醒 cq_wait 等待队列上的用户
```

submit 链的设计要点是**批量处理**：`io_submit_sqes` 一次循环处理所有可用的 SQE，`COMPLETE_DEFER` 模式下不立即写 CQE，而是将完成的请求挂到 `compl_reqs` 链表，最后由 `__io_submit_flush_completions` 统一写入 CQ ring 并唤醒——N 次锁操作压缩为 1 次。complete 链的核心是 `smp_store_release` 内存屏障：内核先写 CQE 内容（user_data/res/flags），再通过 release 语义更新 `cq.tail`，用户侧用 `smp_load_acquire` 读 tail 后再读 CQE 内容——保证用户看到 tail 前进时 CQE 数据已就绪，无需额外同步。

<details>
<summary>方法速查表</summary>

| 方法名 | 文件:行号 | 一行职责 | 关键设计决策 |
|--------|-----------|---------|-------------|
| `io_uring_enter` | io_uring/io_uring.c:2600 | 提交 SQE / 等待 CQE 的系统调用入口 | SQPOLL 模式仅唤醒线程，非 SQPOLL 直接提交 |
| `io_submit_sqes` | io_uring/io_uring.c:2026 | 批量提交 SQ ring 中的所有 SQE | 循环 alloc→get→submit，deferred 完成批量 flush |
| `io_get_sqe` | io_uring/io_uring.c:1994 | 从 SQ ring 读取一个 SQE | `cached_sq_head` + `sq_array` 间接索引，READ_ONCE |
| `io_init_req` | io_uring/io_uring.c:1734 | 从 SQE 初始化 io_kiocb | 查 `io_issue_defs[opcode]` 表，调 `def->prep` 校验 |
| `io_issue_sqe` | io_uring/io_uring.c:1414 | 执行 io_kiocb 对应的操作 | 调 `def->issue`，返回值区分立即完成/异步 |
| `__io_issue_sqe` | io_uring/io_uring.c:1381 | 实际调用 `def->issue(req, flags)` | IOU_COMPLETE 立即完成，SKIP_COMPLETE 异步 |
| `io_queue_sqe` | io_uring/io_uring.c:1646 | 调度请求执行或 punt 到 io-wq | NONBLOCK+DEFER 直接 issue，-EAGAIN 走异步 |
| `io_req_complete_defer` | io_uring/io_uring.h:488 | 延迟完成：挂入 compl_reqs 链表 | 不立即写 CQE，等批量 flush |
| `__io_submit_flush_completions` | io_uring/io_uring.c:1140 | 批量写入 CQE 并唤醒 | 遍历 compl_reqs，一次锁+一次唤醒 |
| `io_req_complete_post` | io_uring/io_uring.c:918 | 异步完成：立即写 CQE | io-wq 回调路径，非 deferred |
| `io_fill_cqe_req` | io_uring/io_uring.h:295 | 填充一个 CQE 槽位 | `cqe_cached` 取槽，拷 req->cqe |
| `io_commit_cqring` | io_uring/io_uring.h:412 | 发布 CQ tail 到共享内存 | `smp_store_release` 保证 CQE 先于 tail 可见 |
| `io_cqring_wake` | io_uring/io_uring.h:436 | 唤醒等待 CQE 的用户 | `cq_wait` 等待队列 |
| `io_sq_thread` | io_uring/sqpoll.c:293 | SQPOLL 内核轮询线程主循环 | 空闲设 NEED_WAKEUP + schedule，多 ctx 共享 |
| `io_uring_setup` | io_uring/io_uring.c:3111 | 创建 io_uring 实例 | 分配 ctx/rings/SQEs，mmap 共享 |
| `io_allocate_scq_urings` | io_uring/io_uring.c:2731 | 分配 SQ/CQ ring 共享内存 | io_create_region，设 mask/entries |
| `io_ring_ctx_alloc` | io_uring/io_uring.c:225 | 分配 io_ring_ctx 实例 | percpu_ref/mutex/spinlock/waitqueue/alloc_cache |

</details>

## 核心实现

### 核心数据结构

io_uring 的数据结构分为三层：UAPI 层（用户可见的 SQE/CQE）、内核上下文层（io_ring_ctx）、请求控制层（io_kiocb）。

**SQE 与 CQE** 是用户和内核之间的契约，定义在 include/uapi/linux/io_uring.h 中：

```c title="include/uapi/linux/io_uring.h (简化)"
struct io_uring_sqe {           // 64 字节, 用户填写
    __u8  opcode;               // 操作类型 (IORING_OP_READV 等)
    __u8  flags;                // IOSQE_FIXED_FILE | IO_LINK | ASYNC 等
    __u16 ioprio;
    __s32 fd;                   // 目标文件描述符
    union { __u64 off; __u64 addr2; };
    union { __u64 addr; __u64 splice_off_in; };
    __u32 len;
    union { __kernel_rwf_t rw_flags; ... };
    __u64 user_data;            // 完成时原样回传, 关联请求
    union { __u16 buf_index; ... };
    ...
};

struct io_uring_cqe {           // 16 字节, 内核填写
    __u64 user_data;            // 从 SQE 原样拷贝
    __s32 res;                  // 操作结果 (字节数或 -errno)
    __u32 flags;                // IORING_CQE_F_* 标志
};
```

`user_data` 是关联请求与完成的关键——用户提交时填入唯一标识，内核完成时原样拷贝到 CQE，用户据此匹配请求和完成。`flags` 字段中的 `IOSQE_FIXED_FILE` 表示使用注册文件索引而非真实 fd（免 `fget`），`IO_LINK` 表示链接到下一个 SQE 形成链式提交。

**io_rings**（include/linux/io_uring_types.h:156-225）是映射到用户空间的共享内存结构，包含 SQ/CQ 的 head/tail 和 CQE 数组。head/tail 的生产者-消费者约定是其核心设计：

- **SQ ring**：用户是生产者，写 `sq_tail`（新提交的 SQE 位置）；内核是消费者，读 `sq_tail`、写 `sq_head`（已消费的 SQE 位置）。
- **CQ ring**：内核是生产者，写 `cq_tail`（新完成的 CQE 位置）；用户是消费者，读 `cq_tail`、写 `cq_head`（已消费的 CQE 位置）。

这种设计让生产者只需写自己的 tail、消费者只需写自己的 head，双方通过 `smp_store_release`/`smp_load_acquire` 无锁同步——不需要共享锁即可安全通信。

**io_ring_ctx**（include/linux/io_uring_types.h:293-492）是实例上下文，关键字段包括：`rings`（指向 io_rings 共享内存）、`sq_array`（SQ ring 的索引数组）、`sq_sqes`（SQE 数组共享内存）、`cached_sq_head`/`cached_cq_tail`（内核侧缓存游标，避免频繁读共享内存）、`file_table`/`buf_table`（注册资源表）、`submit_state`（批量提交状态，含 `compl_reqs` 延迟完成链表）、`sq_data`（SQPOLL 线程数据）、`uring_lock`（mutex，保护提交侧）、`completion_lock`（spinlock，保护完成侧）。

**io_kiocb**（include/linux/io_uring_types.h:707-789）是内核 I/O 控制块，从 SQE 转化而来。关键字段：`opcode`（操作类型）、`flags`（`REQ_F_*` 运行时标志，如 `REQ_F_FORCE_ASYNC`、`REQ_F_LINK`）、`cqe`（内嵌 `io_uring_cqe`，完成时直接填充写回 CQ ring，避免额外分配）、`ctx`（指向所属 io_ring_ctx）、`file`（目标文件）、`async_data`（异步上下文，如 iovec 副本）、`link`（链式请求的下一个）、`refs`（引用计数，io-wq 异步执行时多个回调可能并发访问）。

### Setup 与共享内存

`io_uring_setup` 系统调用（io_uring/io_uring.c:3150→3111→2978）创建一个 io_uring 实例，核心步骤是分配上下文和共享内存 ring：

```c title="io_uring/io_uring.c (io_uring_create 简化)"
static long io_uring_create(unsigned entries, struct io_uring_params *p)
{
    struct io_ring_ctx *ctx;

    ctx = io_ring_ctx_alloc();                    // 分配 io_ring_ctx
    io_prepare_config(ctx, &p);                   // 校验 entries/flags

    io_allocate_scq_urings(ctx, p);               // 分配 SQ/CQ ring 共享内存

    if (p->flags & IORING_SETUP_SQPOLL)
        io_sq_offload_create(ctx, p);             // 创建 SQPOLL 内核线程

    // anon_inode + 绑定 task context
    file = io_uring_get_file(ctx);
    __io_uring_add_tctx_node(ctx->task);          // tctx.c:139
    return io_uring_install_fd(file);             // 返回 fd 给用户
}
```

`io_allocate_scq_urings`（io_uring/io_uring.c:2731）通过 `io_create_region` 分配两块共享内存：`ring_region`（包含 `io_rings` 结构 + CQE 数组 + SQ 索引数组）和 `sq_region`（SQE 数组）。用户通过三个 mmap 偏移访问：

| mmap 偏移 | 宏 | 映射内容 |
|----------|-----|---------|
| 0x0 | `IORING_OFF_SQ_RING` | SQ ring（head/tail/mask + SQ 索引数组） |
| 0x8000000 | `IORING_OFF_CQ_RING` | CQ ring（head/tail/mask + CQE 数组）；单 mmap 模式下与 SQ ring 合并 |
| 0x10000000 | `IORING_OFF_SQES` | SQE 数组（独立的 64 字节条目数组） |

这三个偏移是 `io_uring` 零拷贝的基础——用户 `mmap` 后直接读写共享内存，提交 SQE 无需 `copy_from_user`，读取 CQE 无需 `copy_to_user`。`io_ring_ctx_alloc`（io_uring/io_uring.c:225）初始化 ctx 的 `percpu_ref`（引用计数）、`uring_lock`（mutex）、`completion_lock`（spinlock）、等待队列，以及多个 `alloc_cache`（apoll/netmsg/rw/cmd，用于复用异步上下文对象，避免频繁分配）。

每个任务关联一个 `io_uring_task`（tctx.c），持有 `io_wq`（异步工作队列引用）、`xa`（ctx xarray）、`task_list`/`inflight`（跟踪该任务的在途请求）。`__io_uring_add_tctx_node`（tctx.c:139）在 setup 时将 ctx 绑定到当前任务的 tctx，确保异步执行时能正确关联任务上下文。

### Submit 流程

提交流程从 `io_uring_enter` 系统调用入口开始，经过批量读取 SQE、初始化请求、查表分发执行：

```c title="io_uring/io_uring.c (io_submit_sqes 简化)"
static int io_submit_sqes(struct io_ring_ctx *ctx, unsigned int nr)
{
    unsigned int submitted = 0;
    int err;

    while (submitted < nr) {
        struct io_kiocb *req;

        req = io_alloc_req(ctx);              // 从缓存池分配 io_kiocb
        if (!req) break;

        err = io_get_sqe(ctx, req);           // 从 SQ ring 读 SQE 填入 req
        if (err) { io_req_failed(req); continue; }

        err = io_submit_sqe(ctx, req);        // 初始化 + 执行
        submitted++;
    }
    io_commit_sqring(ctx);                    // 更新 SQ head
    __io_submit_flush_completions(ctx);       // flush 延迟完成的 CQE
    return submitted;
}
```

`io_get_sqe`（io_uring/io_uring.c:1994）通过 `cached_sq_head` 读取 SQ ring 的索引，再通过 `sq_array` 间接索引到实际的 SQE 位置。`sq_array` 是一个独立的索引数组——用户在 SQ ring 中不是顺序填写 SQE，而是将 SQE 放在任意位置并在 `sq_array` 中写入其索引，这让用户可以无锁地重用已消费的 SQE 槽位。`READ_ONCE` 保证读到稳定的值。

`io_init_req`（io_uring/io_uring.c:1734）从 SQE 填充 `io_kiocb` 的基本字段（opcode/flags/user_data/fd），然后查 `io_issue_defs[opcode]` 表调用 `def->prep(req, sqe)` 进行操作特定的预处理和校验。如果 opcode 非法或 prep 失败，请求直接以错误完成。

`io_issue_sqe`（io_uring/io_uring.c:1414）→ `__io_issue_sqe`（io_uring/io_uring.c:1381）调用 `def->issue(req, issue_flags)` 执行实际操作。返回值决定完成路径：

- **IOU_COMPLETE（0）**：操作同步完成，立即写 CQE。
- **IOU_ISSUE_SKIP_COMPLETE（-EIOCBQUEUED）**：操作已异步发出（如提交到块层或网络栈），完成时通过回调写 CQE。

`io_queue_sqe`（io_uring/io_uring.c:1646）处理 issue 失败的情况：如果返回 `-EAGAIN`（非阻塞模式下无法立即完成），请求被 punt 到 io-wq 异步工作队列，由工作线程在进程上下文中重新执行。

### Complete 与 SQPOLL

完成流程有两条路径，取决于是否启用了 deferred completion。

**Deferred completion（延迟完成）** 是批量提交时的优化路径。当 `issue_flags` 包含 `IOU_ISSUE_SKIP_COMPLETE` 或 `COMPLETE_DEFER` 标志时，`io_req_complete_defer`（io_uring/io_uring.h:488）将完成的请求挂到 `ctx->submit_state.compl_reqs` 链表，不立即写 CQE。`io_submit_sqes` 循环结束后，`__io_submit_flush_completions`（io_uring/io_uring.c:1140）遍历整个链表，批量调用 `io_fill_cqe_req` 写入 CQE，然后 `io_cq_unlock_post` 一次性提交 CQ tail 并唤醒等待的用户——N 个完成请求的锁操作和唤醒压缩为 1 次，显著降低高并发下的锁竞争。

**Inline/异步完成** 是非 deferred 路径。`io_req_complete_post`（io_uring/io_uring.c:918）立即写 CQE：

```c title="io_uring/io_uring.h (io_commit_cqring 简化)"
static inline void io_commit_cqring(struct io_ring_ctx *ctx)
{
    /* 内存屏障: CQE 内容必须在 tail 更新前对用户可见 */
    smp_store_release(&ctx->rings->cq.tail, ctx->cached_cq_tail);
}
```

`smp_store_release` 是核心设计：它保证之前的 CQE 写入（user_data/res/flags）在 `cq.tail` 更新之前对用户可见。用户侧用 `smp_load_acquire` 读 `cq.tail`——如果看到 tail 前进，CQE 内容必然已就绪。这种 release-acquire 配对实现了无锁的内核→用户通信。`io_cqring_wake`（io_uring/io_uring.h:436）随后唤醒 `cq_wait` 等待队列上的用户（如正在 `io_uring_enter` 中等待 CQE 的用户）。

**SQPOLL（SQ Polling）** 模式下，一个内核线程 `io_sq_thread`（io_uring/sqpoll.c:293）持续轮询 SQ ring，用户提交 SQE 后甚至不需要调用 `io_uring_enter`——线程会自动发现并提交。线程名 `iou-sqp-%d`，主循环 `__io_sq_thread`（io_uring/sqpoll.c:204）检查 SQ 条目数，有请求时调 `io_submit_sqes`，空闲时设置 `IORING_SQ_NEED_WAKEUP` 标志并 `schedule` 睡眠——用户看到此标志后需调 `io_uring_enter` 唤醒线程。多个 io_uring 实例可共享同一个 SQPOLL 线程（通过 `sqd->ctx_list` 链表），减少线程数量。SQPOLL 的代价是占一个 CPU 核心持续轮询，适合高 IOPS 场景（数据库、存储后端）。与 IOPOLL 模式组合时，整个 I/O 路径完全无系统调用。

### 注册资源

`io_uring_register`（io_uring/register.c:1006，`__io_uring_register`:739）允许用户预先注册文件描述符和缓冲区，避免每次 I/O 操作的重复开销：

**IORING_REGISTER_FILES** → `io_sqe_files_register`（io_uring/rsrc.c:529）：对每个 fd 调 `fget` 获取 `struct file`，存入 `file_table.nodes[i]`。SQE 设置 `IOSQE_FIXED_FILE` 标志后，`fd` 字段变为注册表索引（而非真实 fd），内核直接用索引查表获取 file，跳过 `fget`/`fput`。注册上限 1<<20。这对于高频率 I/O 的场景（如数据库）可省去每次操作的 fd 查找开销。

**IORING_REGISTER_BUFFERS** → `io_sqe_buffers_register`（io_uring/rsrc.c:861）：对每个缓冲区调 `io_sqe_buffer_register`，用 `pin_user_pages` 锁定用户页，存入 `io_mapped_ubuf`（含 `bvec` 数组）。SQE 使用 `READ_FIXED`/`WRITE_FIXED` opcode + `buf_index` 字段直接引用注册缓冲区，内核无需每次操作 `copy iovec` + `pin/unpin_user_pages`。注册上限 1<<14。代价是锁定内存受 `RLIMIT_MEMLOCK` 限制。

### 53 种 opcode

`io_issue_defs[]`（io_uring/opdef.c:54-592）是 53 种 opcode 的注册表，每个条目包含 `prep`/`issue` 函数指针和审计类别。`io_uring_optable_init`（io_uring/opdef.c:867）在初始化时校验表完整性。另有 `io_cold_defs[]`（io_uring/opdef.c:594）存放 `name`/`cleanup`/`fail`/`sqe_copy` 等 cold-path 函数（分离 hot/cold path 优化 icache 局部性）。53 种 opcode 按功能分类：

| 分类 | opcode | 说明 |
|------|--------|------|
| 空操作 | `NOP`, `NOP128` | 测试/占位 |
| 文件读写 | `READV`, `WRITEV`, `READ`, `WRITE`, `READ_FIXED`, `WRITE_FIXED` | 向量/固定缓冲区读写 |
| 文件控制 | `FSYNC`, `SYNC_FILE_RANGE`, `FALLOCATE`, `FTRUNCATE`, `STATX` | 同步/空间管理/元数据 |
| 文件操作 | `OPENAT`, `OPENAT2`, `CLOSE`, `SPLICE`, `TEE`, `FIXED_FD_INSTALL` | 打开/关闭/管道 |
| 目录操作 | `RENAMEAT`, `UNLINKAT`, `MKDIRAT`, `SYMLINKAT`, `LINKAT` | 路径操作 |
| 扩展属性 | `SETXATTR`, `GETXATTR`, `FSETXATTR`, `FGETXATTR`, `REMOVEXATTR`, `FREMOVEXATTR` | xattr 系列 |
| 网络操作 | `SEND`, `RECV`, `SENDMSG`, `RECVMSG`, `SEND_ZC`, `SENDMSG_ZC`, `RECV_ZC` | 收发（含零拷贝） |
| 网络控制 | `ACCEPT`, `CONNECT`, `BIND`, `LISTEN`, `SHUTDOWN`, `SOCKET` | 连接管理 |
| 轮询/等待 | `POLL_ADD`, `POLL_REMOVE`, `EPOLL_CTL`, `EPOLL_WAIT` | 事件等待 |
| 定时器 | `TIMEOUT`, `TIMEOUT_REMOVE`, `LINK_TIMEOUT` | 超时控制 |
| 取消 | `ASYNC_CANCEL` | 取消在途请求 |
| 缓冲区管理 | `PROVIDE_BUFFERS`, `REMOVE_BUFFERS` | 内核缓冲区池 |
| 进程/信号 | `WAITID`, `MSG_RING` | 进程等待/实例间通信 |
| 命令直通 | `URING_CMD`, `URING_CMD128`, `PIPE` | 设备/驱动自定义命令 |
| 多发 | `READ_MULTISHOT`, `RECV_MULTISHOT` | 一次提交持续产生 CQE |
| futex | `FUTEX_WAIT`, `FUTEX_WAKE`, `FUTEX_WAITV` | 用户态 futex 异步化 |

分发流程：`io_init_req`（io_uring/io_uring.c:1759）取 `def = &io_issue_defs[opcode]`，调 `def->prep`；`__io_issue_sqe`（io_uring/io_uring.c:1399）调 `def->issue`。新增 opcode 只需在 `io_issue_defs[]` 和 `io_cold_defs[]` 中各加一个条目并实现 `prep`/`issue` 函数。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 生产者-消费者 | SQ/CQ ring（io_rings, io_uring_types.h:156-225） | 用户和内核各控一个 head/tail，共享内存 ring buffer 实现无系统调用的单向通信，`smp_store_release`/`smp_load_acquire` 无锁同步 |
| 注册表/策略 | `io_issue_defs[]`（io_uring/opdef.c:54-592） | 53 种 opcode 通过函数指针表分发，新增操作只加表条目不改分发逻辑，prep/issue 作为策略可独立替换 |
| 零拷贝 | mmap 共享 SQ/CQ ring + SQE 数组 | 元数据（SQE/CQE）直接在共享内存读写，无 `copy_from/to_user`；注册文件/缓冲区免每次 fget/pin_user_pages |
| 批量提交/完成 | `io_submit_sqes` + `__io_submit_flush_completions`（io_uring.c:2026/1140） | 一次 enter 提交 N 个 SQE，deferred completion 将 N 次锁+唤醒压缩为 1 次；`blk_start_plug` 合并块 I/O 请求 |

生产者-消费者模式是 io_uring 性能的核心。传统 I/O 每次操作需要系统调用（陷入内核、参数拷贝、返回用户），而 io_uring 的共享内存 ring 让用户可以直接写 SQE、读 CQE，仅在需要通知对方时才系统调用（`io_uring_enter` 唤醒内核、`io_cqring_wake` 唤醒用户）。SQPOLL 模式连这个通知也省了——内核线程主动轮询 SQ ring。head/tail 的 release-acquire 语义保证了无锁安全：生产者写 tail 时用 `smp_store_release`（确保内容先于 tail 可见），消费者读 tail 时用 `smp_load_acquire`（确保读到 tail 后内容已就绪）。

注册表模式让 io_uring 的扩展性极强——从最初的 10 余种 opcode 扩展到 53 种，每次新增只需在 `io_issue_defs[]` 表中添加一个条目（`prep` + `issue` 函数指针），分发表 `io_init_req` 和 `__io_issue_sqe` 的代码完全不变。`io_cold_defs[]` 将 cold-path 函数（cleanup/fail/name）分离到独立的表，避免 hot path 的 icache 被 cold code 污染。

## 模块间交互

`io_uring/` 作为一个统一的异步 I/O 框架，与内核多数子系统都有交互——它是上层应用和底层 I/O 子系统之间的中间层：

```
io_uring 提交/完成路径与各子系统的交互:

  io_uring_enter ──► io_submit_sqes
                      │
                      ├─► fs/ (文件操作)
                      │    READV/WRITEV → vfs_read_iter / vfs_write_iter
                      │    OPENAT/CLOSE/STATX/FSYNC → VFS 对应接口
                      │
                      ├─► net/ (网络操作)
                      │    SEND/RECV → sock_sendmsg / sock_recvmsg
                      │    ACCEPT/CONNECT/BIND/LISTEN → socket 层
                      │    SEND_ZC → socket zerocopy (zerocopy_callback)
                      │
                      ├─► mm/ (内存管理)
                      │    ring 内存: io_create_region + mmap 共享
                      │    缓冲区注册: pin_user_pages 锁定用户页
                      │    io_kiocb 分配: alloc_cache 复用
                      │
                      ├─► kernel/sched (调度)
                      │    SQPOLL: kthread_create → io_sq_thread 内核线程
                      │    io-wq: 独立工作队列, -EAGAIN 请求在此异步执行
                      │
                      └─► block/ (块 I/O)
                           IOPOLL: io_do_iopoll 主动轮询块设备
                           blk_start_plug / blk_finish_plug 合并 I/O 请求
```

交互方式以函数调用为主——io_uring 直接调用 VFS、socket、块层的接口函数，而非通过事件或消息。与 mm 的交互是基础性的：共享内存 ring 的映射（mmap）、缓冲区注册时的 `pin_user_pages`、控制块分配的 `alloc_cache` 都依赖内存管理子系统。SQPOLL 线程和 io-wq 工作线程的创建和调度依赖 `kernel/sched`，但 io_uring 对调度器没有特殊要求——它只是普通的内核线程和内核工作队列。

`io_uring_init`（io_uring/io_uring.c:3162）通过 `__init` 在内核启动时注册系统调用，不依赖 initcall 分级机制——它是独立的子系统，不在 `init/` 的装配序列中展开。这使得 io_uring 的初始化极其轻量（仅注册 syscall 入口），真正的实例创建发生在用户调用 `io_uring_setup` 时。

## 扩展方式

**新增一个 opcode**：io_uring 的扩展几乎完全通过添加 opcode 实现。以添加一个 hypothetical `IORING_OP_MY_OP` 为例：

1. 在 include/uapi/linux/io_uring.h 中定义 opcode 常量：

```c title="include/uapi/linux/io_uring.h"
enum {
    ...
    IORING_OP_MY_OP,
};
```

2. 在 io_uring/opdef.c 的 `io_issue_defs[]` 数组中添加条目，实现 `prep` 和 `issue` 函数：

```c title="io_uring/opdef.c (io_issue_defs[] 新增条目)"
static int io_prep_my_op(struct io_kiocb *req, const struct io_uring_sqe *sqe)
{
    /* 校验 SQE 字段, 准备请求参数 */
    if (sqe->len == 0)
        return -EINVAL;
    req->cqe.res = 0;
    return 0;
}

static int io_my_op(struct io_kiocb *req, unsigned int issue_flags)
{
    /* 执行实际操作 */
    int ret = do_my_operation(req);

    if (ret == -EAGAIN && !(issue_flags & IO_URING_F_NONBLOCK))
        return IOU_ISSUE_SKIP_COMPLETE;     /* punt 到 io-wq */

    io_req_set_res(req, ret, 0);
    return IOU_COMPLETE;                     /* 立即完成 */
}

const struct io_issue_def io_issue_defs[] = {
    ...
    [IORING_OP_MY_OP] = {
        .prep       = io_prep_my_op,
        .issue      = io_my_op,
        .audit_skip = 0,
    },
};
```

3. 在 `io_cold_defs[]` 中添加对应的 cold-path 条目（name/cleanup/fail/sqe_copy）：

```c title="io_uring/opdef.c (io_cold_defs[] 新增条目)"
const struct io_cold_def io_cold_defs[] = {
    ...
    [IORING_OP_MY_OP] = {
        .name       = "MY_OP",
        .cleanup    = io_my_op_cleanup,
        .fail       = io_my_op_fail,
    },
};
```

4. `io_uring_optable_init`（io_uring/opdef.c:867）在启动时校验表完整性——确保所有 opcode 都有有效的 `prep`/`issue` 条目。如果漏加条目，校验会 panic。

`issue` 函数的返回值约定是扩展的关键契约：返回 `IOU_COMPLETE`（0）表示同步完成、内核立即写 CQE；返回 `IOU_ISSUE_SKIP_COMPLETE`（-EIOCBQUEUED）表示异步发出、完成后通过回调写 CQE。操作遇到 `-EAGAIN` 时，如果当前是非阻塞模式（`IO_URING_F_NONBLOCK`），应返回 `-EAGAIN` 让 `io_queue_sqe` punt 到 io-wq；如果是阻塞模式则自行等待。
