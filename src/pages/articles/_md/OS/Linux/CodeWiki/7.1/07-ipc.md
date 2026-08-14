---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "进程间通信"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "IPC", "信号量", "共享内存", "消息队列"]
description: "Linux System V IPC（sem/shm/msg）与 POSIX mqueue——kern_ipc_perm 基类复用、ipcget 模板方法、IPC namespace 隔离。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`ipc/` 目录承载 Linux 内核中所有**进程间通信**（Inter-Process Communication）机制。进程之间天然隔离——各自有独立的地址空间、文件描述符表、信号处理表。当多个进程需要共享数据或协调执行顺序时，内核必须提供受控的"通道"让进程跨越隔离边界交换信息。`ipc/` 就是这些通道的实现。

它独立成模块的原因：IPC 机制在内核中是**自洽的子系统**——有自己的对象管理体系（ID 分配、权限检查、生命周期管理）、独立的系统调用入口（`semget`/`shmget`/`msgget` 等）、独立的 namespace 隔离。虽然共享内存会复用 `mm/` 的 VMA 基础设施、POSIX mqueue 会复用 `fs/` 的 VFS 层，但这些复用是"借用"而非"嵌入"——IPC 的核心逻辑（对象查找、权限、同步原语）完全在 `ipc/` 内闭环。

`ipc/` 同时实现两套标准：**System V IPC**（sem/shm/msg，基于整数 ID + key）和 **POSIX 消息队列**（mqueue，基于路径名 + fd）。两者解决相似问题但 API 和内部实现差异显著——SysV IPC 自建对象管理基础设施，POSIX mqueue 则复用 VFS 文件系统抽象。

## 模块架构

`ipc/` 的内部结构围绕一个核心设计思想展开：**用 C 的结构体嵌入 + `container_of` 模拟面向对象继承**，让三种 SysV IPC 子系统（sem/shm/msg）共享同一套通用基础设施，各自只实现差异化的逻辑。

```c title="include/linux/ipc.h"
struct kern_ipc_perm {           /* 基类——三种 SysV IPC 对象的第一字段 */
    spinlock_t    lock;
    bool          deleted;
    int           id;
    key_t         key;
    kuid_t        cuid;
    kgid_t        cgid;
    kuid_t        uid;
    kgid_t        gid;
    umode_t       mode;
    unsigned long seq;
    struct ipc_security_struct *security;
    struct rhash_head khtnode;   /* 挂入 key_ht rhashtable */
    struct rcu_head rcu;         /* RCU 延迟释放 */
    refcount_t    refcount;
} ____cacheline_aligned_in_smp;  /* SMP 缓存行对齐减少锁竞争 */
```

三个 SysV 子系统各自定义"子类"结构体，将 `kern_ipc_perm` 作为第一个字段嵌入：

| 子系统 | 子类结构体 | 定义位置 | 附加字段职责 |
|--------|-----------|---------|-------------|
| 信号量 | `sem_array` | `ipc/sem.c:114` | `sems[]` 柔性数组、pending 队列、`use_global_lock` |
| 共享内存 | `shmid_kernel` | `ipc/shm.c:54` | `shm_file`、`shm_nattch`、`shm_segsz` |
| 消息队列 | `msg_queue` | `ipc/msg.c:49` | `q_messages` 链表、`q_cbytes`、`q_senders`/`q_receivers` |

通用基础设施由 `ipc/util.c` 提供，核心组件包括：

- **`ipc_ids`**（`include/linux/ipc_namespace.h:18`）：每个 IPC namespace 持有 3 个 `ipc_ids`（sem/msg/shm 各一），包含 `ipcs_idr`（IDR 树，index→perm* 映射）、`key_ht`（rhashtable，key→perm* 映射）、`rwsem`（增删遍历锁）、`seq`（序列号计数器）。
- **`ipcget`**（`ipc/util.c:670`）：模板方法入口，按 key 是否为 `IPC_PRIVATE` 分派到 `ipcget_new`（调 `ops->getnew`）或 `ipcget_public`（查找已有或创建新的）。
- **`ipc_ops`**（`ipc/util.h:105`）：虚函数表，含 `getnew`/`associate`/`more_checks` 三个回调，三子系统各提供实现。

POSIX mqueue（`ipc/mqueue.c`）不走这套基类——它复用 VFS 文件系统抽象，每个消息队列是一个 inode，通过路径名和 fd 访问。但它仍复用 `msg_msg` 结构体存储消息体，并用红黑树按优先级组织消息（SysV msg 用链表）。

IPC namespace（`ipc/namespace.c`）提供隔离：每个 namespace 拥有独立的 `ids[3]`、独立的控制参数（`sem_ctls`/`msg_ctl*`/`shm_ctl*`）、独立的 mqueue 挂载点。`copy_ipcs` 在 `clone(CLONE_NEWIPC)` 时创建新 namespace。

## 调用链路

### ipcget 统一入口

三子系统的 `*get` 系统调用（`semget`/`shmget`/`msgget`）共用 `ipcget` 模板方法，分派逻辑一致：

```
ksys_semget / ksys_shmget / ksys_msgget  (各子系统入口)
        │
        ▼
    ipcget(ns, &ids, key, flg, &ipc_ops)   (util.c:670)
        │
        ├── key == IPC_PRIVATE ?
        │       │
        │       ├── YES → ipcget_new()
        │       │           │
        │       │           └── ops->getnew()  → newary / newseg / newque
        │       │                   │
        │       │                   └── ipc_addid()  (分配 ID + 插入 key_ht)
        │       │
        │       └── NO → ipcget_public()
        │                   │
        │                   ├── ipc_findkey()  (rhashtable 查找)
        │                   │       │
        │                   │       └── 找到 → ops->associate() + ops->more_checks()
        │                   │
        │                   └── 未找到 + IPC_CREAT → ipcget_new() → ops->getnew()
```

### 各子系统操作调用链

获取 IPC 对象后，各子系统通过 ID 进行操作：

**信号量 semop**：
```
__do_semtimedop(sem.c:1983)
  → sem_obtain_object_check()  /* ID → sem_array* */
  → ipcperms() + security_sem_semop()
  → sem_lock()                 /* 细粒度锁策略 */
  → perform_atomic_semop()     /* 尝试原子操作: 0=成功 / 1=阻塞 / <0=错误 */
  → [阻塞] pending 队列 + schedule_hrtimeout()
  → [唤醒] update_queue() → wake_q lockless wakeup
```

**共享内存 shmat/shmdt**：
```
do_shmat(shm.c:1521)
  → shm_obtain_object_check()
  → ipcperms() + security_shm_shmat()
  → get_file() + shm_nattch++
  → alloc_file_clone(f_op=shm_file_operations)  /* 装饰器 */
  → do_mmap()                                    /* 复用 mm/ VMA 基础设施 */

ksys_shmdt(shm.c:1730)
  → 遍历 VMA 找 shm_vm_ops
  → do_vmi_align_munmap()
  → shm_close() → shm_may_destroy()
```

**消息队列 msgsnd/msgrcv**：
```
do_msgsnd(msg.c:848)
  → load_msg()  /* 分配 msg_msg + 数据段 */
  → msg_fits_inqueue()? 否 → ss_add() 阻塞 schedule
  → pipelined_send()  /* 直接交给等待的 receiver */
  → 或 list_add_tail()  /* 加入队列尾 */

do_msgrcv(msg.c:1098)
  → convert_mode()  /* ANY/EQUAL/NOTEQUAL/LESSEQUAL/NUMBER */
  → find_msg()
  → 无消息 → msg_receiver 阻塞
  → [被 pipelined_send 唤醒] lockless receive (READ_ONCE + MSG_BARRIER)
```

<details>
<summary>方法速查表</summary>

| 方法名 | 一行职责 | 关键设计决策 |
|--------|---------|-------------|
| `ipcget` | 统一 IPC 对象获取入口 | 模板方法分派，key==IPC_PRIVATE 走新建路径 |
| `ipc_addid` | 分配 ID 并插入索引结构 | IDR 分配 index，key_ht 插入 rhashtable |
| `ipc_findkey` | 按 key 查找 IPC 对象 | rhashtable O(1) 查找 |
| `ipc_obtain_object_idr` | 按 ID 获取对象指针 | IDR 树查找 |
| `ipc_obtain_object_check` | 按 ID 获取并校验 seq | seq 防止 ID 复用攻击 |
| `ipc_rcu_putref` | 引用计数减到 0 延迟释放 | `call_rcu` 保证读端完成 |
| `newary` | 创建信号量集 | `use_global_lock` 初始化为 HYSTERESIS |
| `newseg` | 创建共享内存段 | `shmem_kernel_file_setup` 创建 tmpfs 文件 |
| `newque` | 创建消息队列 | `q_qbytes` 设为 namespace 上限 |
| `sem_lock` | 信号量操作加锁 | 单操作锁 per-sem spinlock，多操作锁全局 |
| `perform_atomic_semop` | 原子执行信号量操作 | 全部成功或全部不执行 |
| `update_queue` | 检查 pending 队列并唤醒 | `wake_q` lockless 唤醒 |
| `do_shmat` | 共享内存挂载 | `alloc_file_clone` 装饰器 + `do_mmap` |
| `shm_mmap` | shm VMA mmap 回调 | 替换 `vm_ops` 为 `shm_vm_ops` |
| `do_msgsnd` | 发送消息 | `pipelined_send` 直接交付 receiver |
| `do_msgrcv` | 接收消息 | `convert_mode` 多种匹配模式 |
| `pipelined_send` | 直接将消息交给等待的 receiver | 避免入队再出队的开销 |
| `msg_insert` | 消息插入红黑树（mqueue） | 按优先级排序，缓存 rightmost |

</details>

## 核心实现

### IPC 通用基础设施

**ID 编码与防复用**。IPC 标识符（id）由 index 和 seq 两部分编码（`ipc/util.h:20`）。默认配置下，bits 0-14 为 index（最多 32K 个对象），bits 15-30 为 seq（64K 轮次）。每次对象销毁后 seq 递增，使得同一个 index 被重用时产生新的 id 值——`ipc_checkid` 通过比较 seq 判断 id 是否属于当前对象实例，防止进程持有过期的 id 后误操作新分配的对象。`ipcid_to_idx` 和 `ipcid_to_seqx` 分别提取两部分。

**双索引结构**。`ipc_ids` 维护两套索引（`include/linux/ipc_namespace.h:18`）：`ipcs_idr`（IDR 树）用于按 id→index 快速查找对象指针；`key_ht`（rhashtable）用于按 key 快速查找。key 是用户通过 `ftok` 或 `IPC_PRIVATE` 指定的命名标识，id 是内核返回的句柄。`ipc_findkey`（`util.c:172`）走 rhashtable 做 O(1) 查找，`ipc_obtain_object_idr`（`util.c:626`）走 IDR 树做 O(log n) 查找，`ipc_obtain_object_check`（`util.c:647`）额外校验 seq。

**三层锁体系**（`util.c:20-45`）：

| 层 | 锁 | 保护范围 | 典型场景 |
|----|-----|---------|---------|
| L1 | `rcu_read_lock` | 对象指针本身不被释放 | 查找对象（无锁读） |
| L2 | `kern_ipc_perm.lock` | 对象数据字段 | 操作对象（读写数据） |
| L3 | `ipc_ids.rwsem` | 对象集合（增删遍历） | 创建/删除对象 |

查找路径只需 L1 RCU 读锁 + IDR/rhashtable 查找；操作路径在 L1 基础上加 L2 spinlock 保护数据；创建和删除需要 L3 rwsem 写锁保护集合结构。`ipc_rcu_putref`（`util.c:533`）在引用计数归零时通过 `call_rcu` 延迟释放，确保所有 RCU 读端完成后才回收内存。

**ipcget 模板方法**（`util.c:670`）是三子系统共享的获取入口。`key == IPC_PRIVATE` 时走 `ipcget_new` 调用 `ops->getnew` 创建新对象；否则走 `ipcget_public` 先 `ipc_findkey` 查找，找到则调 `ops->associate`（安全关联检查）+ `ops->more_checks`（子系统特定校验），未找到且带 `IPC_CREAT` 标志则创建。三子系统的 `ipc_ops` 实现差异仅在 `getnew`/`associate`/`more_checks` 三个回调：

```c title="ipc/util.h"
struct ipc_ops {
    int (*getnew)(struct ipc_namespace *, struct ipc_params *);
    int (*associate)(struct ipc_namespace *, struct kern_ipc_perm *, int);
    int (*more_checks)(struct kern_ipc_perm *, struct ipc_params *);
};
```

### 信号量 sem

信号量是实现进程同步的核心原语。`sem_array`（`sem.c:114`）是信号量集容器，内嵌 `sem_perm` 基类，持有 `sems[]` 柔性数组（每个元素是一个 `sem` 结构体）。`sem`（`sem.c:95`）记录当前值（`semval`）、最后操作 PID（`sempid`）、独立 spinlock（`lock`）和两个 pending 队列（`pending_alter` 需修改值的操作 / `pending_const` 只读探测操作）。每个 `sem` 结构体 `____cacheline_aligned_in_smp`，避免多核操作不同信号量时的缓存行竞争。

**细粒度锁策略**是 sem 子系统最精妙的设计（`sem_lock`，`sem.c:389`）。信号量集上的操作分两种情况：

- **单操作且仅涉及一个信号量**（fast path）：只锁该 `sem->lock`（per-sem spinlock），不影响其他信号量上的并发操作。
- **多操作跨多个信号量**（slow path）：锁 `sem_perm.lock`（全局锁）+ `complexmode_enter`。多操作必须原子执行，需要全局锁保证一致性。

`use_global_lock` 是一个**滞滞计数器**（hysteresis counter）——初始化为 `HYSTERESIS`（=10）。当多操作发生时设为 `HYSTERESIS`，此后即使只有单操作也走全局锁路径，每次单操作递减计数器，减到 0 才恢复 per-sem 锁。这避免了单操作和多操作频繁交替时反复切换锁粒度的抖动开销。

**`perform_atomic_semop`**（`sem.c:1028`）尝试原子执行所有操作：遍历 `sops` 数组，逐个检查并修改 `semval`。如果全部可以满足返回 0（成功）；如果某个操作会阻塞（如 `P` 操作遇到 `semval < 0`）返回 1（需阻塞）；如果操作非法（如值溢出）返回负值（错误）。返回 1 时将操作挂入对应 `sem` 的 pending 队列，调用 `schedule_hrtimeout` 睡眠。

**唤醒**通过 `update_queue`（`sem.c:949`）实现。当信号量值被修改后，`do_smart_update` 只检查值增大的信号量的 pending 队列。`wake_up_sem_queue_prepare` 将可满足的等待者加入 `wake_q`，随后 `wake_up_q` 做无锁唤醒——唤醒过程不持有任何 spinlock，避免唤醒时的锁竞争和优先级反转。

### 共享内存 shm

共享内存是最高效的 IPC 机制——多进程映射同一物理内存段，直接读写共享数据，零拷贝。`shmid_kernel`（`shm.c:54`）内嵌 `shm_perm` 基类，持有 `shm_file`（底层 tmpfs 文件）、`shm_nattch`（挂载计数）、`shm_segsz`（段大小）。

**核心设计决策：用文件抽象挂接 VFS**。`newseg`（`shm.c:704`）创建共享内存段时调用 `shmem_kernel_file_setup`（tmpfs）或 `hugetlb_file_setup` 创建一个内核文件对象。这不是"真的在文件系统里建文件"，而是**复用 mm/ 的 VMA 基础设施**——共享内存段本质是一段被多个进程映射的内存区域，而 Linux 的 VMA（`vm_area_struct`）体系已经完善地处理了缺页、COW、mremap、swap 等所有内存映射场景。通过把 shm 段关联到一个文件，`do_shmat` 就能调用 `do_mmap`（`shm.c:1664`）创建 VMA，后续的内存管理完全复用 mm/ 的成熟路径。

```c title="ipc/shm.c (简化)"
/* do_shmat 关键流程 */
shm_file_data *sfd = kzalloc(sizeof(*sfd), GFP_KERNEL);
sfd->file = get_file(shp->shm_file);    /* 底层 tmpfs 文件 */
file = alloc_file_clone(sfd->file, O_RDWR, &shm_file_operations);  /* 装饰器 */
addr = do_mmap(file, addr, size, prot, flags, 0);  /* 复用 VMA */
```

**装饰器模式**：`shm_file_operations`（`shm.c:595`）包装底层 tmpfs 文件的 `vm_ops`。`shm_mmap` 回调先调 `__shm_open`（`shm_nattch++`），再 `vfs_mmap` 映射底层文件，最后将 VMA 的 `vm_ops` 替换为 `shm_vm_ops`（`shm.c:685`）。`shm_vm_ops` 的 `open`/`close`/`fault` 回调分别在 VMA 创建、销毁、缺页时被调用——`open` 增加挂载计数（支持 fork 继承），`close` 减少计数并在计数归零时通过 `shm_destroy` 释放段，`fault` 委托给底层 tmpfs 的缺页处理。

**shmdt**（`ksys_shmdt`，`shm.c:1730`）遍历进程的 VMA 树，查找 `vm_ops == &shm_vm_ops` 的区域，调用 `do_vmi_align_munmap` 解除映射。

### 消息队列 msg

消息队列提供进程间传递结构化消息的能力——每条消息有类型标签（`m_type`），接收方可按类型筛选。`msg_queue`（`msg.c:49`）内嵌 `q_perm` 基类，持有 `q_messages`（消息链表头）、`q_cbytes`（当前字节计数）、`q_qbytes`（字节上限）、`q_senders`（阻塞的发送者链表）、`q_receivers`（阻塞的接收者链表）。

**消息结构体** `msg_msg`（`include/linux/msg.h:9`）设计精巧：消息头（`m_list`/`m_type`/`m_ts`/`next`/`security`）后紧跟数据体。当数据超过一页时，`next` 指针链接后续的 `msg_msgseg` 段——分段存储避免单次大分配。

**msgsnd**（`do_msgsnd`，`msg.c:848`）：`load_msg` 分配 `msg_msg` 并拷贝用户数据；`msg_fits_inqueue` 检查队列是否超出 `q_qbytes` 上限，满则发送者通过 `ss_add` 挂入 `q_senders` 队列并 `schedule` 睡眠。队列未满时优先尝试 `pipelined_send`——如果有接收者正在阻塞等待，直接将消息交给接收者，避免"入队再出队"的双重开销。没有匹配的接收者则 `list_add_tail` 将消息加入队列尾。

**msgrcv**（`do_msgrcv`，`msg.c:1098`）：`convert_mode` 将用户指定的 `msgtyp` 转换为匹配模式——`ANY`（任意类型）、`EQUAL`（精确匹配类型）、`NOTEQUAL`（类型不等于）、`LESSEQUAL`（类型小于等于，取最小的）、`NUMBER`（取指定类型的第 N 条）。`find_msg` 按模式遍历链表查找。无匹配消息时接收者挂入 `q_receivers` 队列阻塞，被 `pipelined_send` 或 `expunge_all` 唤醒。

**lockless receive**：接收者阻塞时设置 `msg_receiver.r_msg` 为 `NULL`，被唤醒后通过 `READ_ONCE(r_msg)` + `smp_acquire__after_ctrl_dep`（`MSG_BARRIER`）读取消息指针——发送者通过 `smp_store_release` 写入指针。这种无锁交接避免了唤醒时获取队列 spinlock 的开销。`wake_q_add_safe` 确保唤醒操作本身不持锁。

### POSIX mqueue

POSIX 消息队列（`ipc/mqueue.c`）与 SysV msg 解决相似问题，但设计路径完全不同：

| 维度 | SysV msg | POSIX mqueue |
|------|---------|-------------|
| 标识方式 | int ID + key | 路径名 + fd |
| 对象管理 | `kern_ipc_perm` 基类 + IDR | VFS inode（`mqueue_inode_info` 嵌入 inode） |
| 消息组织 | 链表 | 红黑树（按优先级） |
| 权限检查 | `ipcperms` | VFS 权限（`inode_permission`） |
| 异步通知 | 无 | `SIGEV_SIGNAL`/`SIGEV_THREAD` |
| Namespace 隔离 | `ids[3]` | 独立 mq_mnt 挂载 |

**VFS 集成**：`mqueue_fs_type`（`mqueue.c:1613`）注册为 `"mqueue"` 文件系统，标记 `FS_USERNS_MOUNT`——每个 IPC namespace 拥有独立的 `mq_mnt` 挂载点。`mq_open` 走标准 VFS 路径（`do_mq_open` → `path_openat` → `dentry_open`），`mq_unlink` 调 `vfs_unlink`。这让 mqueue 天然复用了 VFS 的权限模型、poll 机制和 fd 生命周期管理。

**红黑树按优先级**：`mqueue_inode_info`（`mqueue.c:133`）持有 `msg_tree`（红黑树）和 `msg_tree_rightmost`（缓存最高优先级节点）。`msg_insert`（`mqueue.c:190`）按优先级插入红黑树，`msg_get` 从 `rightmost` 快速取出最高优先级消息——O(log n) 插入，O(1) 取最高优先级。

**异步通知**：mqueue 支持进程注册消息到达时的异步通知。`notify` 字段记录通知方式：`SIGEV_SIGNAL` 发送信号（携带 `sigval` 值），`SIGEV_THREAD` 通过 netlink socket 触发用户态线程执行回调。`notify_sock` 是一个 netlink socket，用于 `SIGEV_THREAD` 模式的异步回调通知。

**MQ_BARRIER**（`mqueue.c:78`）：与 SysV msg 的 `MSG_BARRIER` 类似，用 `smp_store_release` + `READ_ONCE` + `smp_acquire__after_ctrl_dep` + `wake_q_add_safe` 实现无锁的消息交接，避免唤醒时持锁。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | `ipcget`（`util.c:670`）+ `ipc_ops`（`util.h:105`） | 三子系统的 `*get` 流程结构一致（key 分派、查找、创建），仅创建/校验逻辑不同。统一入口避免代码重复，`ipc_ops` 回调隔离差异。 |
| 基类复用（C 模拟继承） | `kern_ipc_perm` 嵌入 `sem_array`/`shmid_kernel`/`msg_queue` + `container_of` | C 无继承语法，通过结构体嵌入 + `container_of` 宏实现"is-a"关系。统一权限检查（`ipcperms`）、ID 管理、RCU 生命周期，三子系统不重复实现。 |
| 装饰器 | `shm_file_operations`（`shm.c:595`）包装底层 tmpfs `vm_ops` | 共享内存需要复用 VMA 基础设施但又必须跟踪挂载计数（`shm_nattch`）。装饰器在底层 tmpfs 操作前后插入 IPC 管理逻辑，不修改 tmpfs 代码。 |
| 策略模式（vtable） | `ipc_ops` 函数指针表 | 同 `ipcget` 入口按不同 ops 分派到 `newary`/`newseg`/`newque`，新增 IPC 类型不改 `ipcget` 代码。 |

## 模块间交互

`ipc/` 虽然是自洽子系统，但在关键路径上与其他子系统深度协作：

**与 `mm/`（内存管理）**：共享内存是交互最深的子系统。`do_shmat`→`do_mmap`（`shm.c:1664`）创建 VMA，需要 `mmap_write_lock_killable` 获取进程地址空间写锁。`ksys_shmdt`→`do_vmi_align_munmap` 解除映射走 mm/ 的 munmap 路径。`newseg`→`shmem_kernel_file_setup` 创建 tmpfs 文件作为共享内存后端，复用 tmpfs 的 swap 机制；大页场景调 `hugetlb_file_setup`。shm 段的缺页、COW、mremap 全部委托给 mm/ 的标准 VMA 处理路径。

**与 `kernel/`（进程/namespace）**：IPC namespace 通过 `nsproxy` 关联到 `task_struct`。`copy_ipcs`（`namespace.c:39`）在 `clone(CLONE_NEWIPC)` 时创建新 namespace——`inc_ipc_namespaces` 检查 ucounts 配额，`kzalloc` 分配 `ipc_namespace`，依次调用 `mq_init_ns`（挂载 mqueue FS）、`sem_init_ns`/`msg_init_ns`/`shm_init_ns`（初始化控制参数）。销毁走 `put_ipc_ns`→`free_ipc_lists`→`schedule_work(free_ipc_work)` 异步释放，避免 `kern_unmount` 中 `synchronize_rcu` 的同步代价。`ipcns_operations` 注册了 namespace 的 install/owner 回调，`ipcns_install` 需 `CAP_SYS_ADMIN` 权限。

**与 `fs/`（VFS）**：POSIX mqueue 完全走 VFS 路径。`mqueue_fs_type` 注册文件系统类型，`mq_open`→`do_mq_open`→`path_openat`→`dentry_open` 走标准 VFS open 路径，`mq_unlink`→`vfs_unlink` 走标准 VFS unlink 路径。mqueue 复用 VFS 的 `inode_permission` 权限检查、`poll` 机制和 fd 生命周期管理。

初始化时机：`pure_initcall(ipc_ns_init)` 初始化 IPC namespace 基础设施；`device_initcall` 阶段 `ipc_init` 注册 sem/msg/shm 系统调用、`init_mqueue_fs` 注册 mqueue 文件系统。

## 扩展方式

IPC 子系统已经高度稳定，扩展场景较少。可能的扩展方向：

**新增 IPC 机制类型**：在 SysV 框架内新增类型需要实现 `ipc_ops` 的三个回调（`getnew`/`associate`/`more_checks`），定义嵌入 `kern_ipc_perm` 的子类结构体，添加对应的 `ipc_ids` 数组槽位和 namespace 初始化逻辑，注册系统调用。但实践中极少新增 SysV IPC 类型——现代 Linux 更倾向通过 `memfd`、`eventfd`、`io_uring` 等机制解决进程间通信需求。

**调整 IPC 控制参数**：每个 namespace 持有 `sem_ctls`/`msg_ctl*`/`shm_ctl*` 控制参数（最大值、最大段数等），通过 `/proc/sys/kernel/` 下的 sysctl 可调。修改 `ipc/namespace.c` 中的 `*_init_ns` 可调整默认值。

**POSIX mqueue 扩展**：mqueue 走 VFS 路径，扩展方式与文件系统类似——修改 `mqueue_inode_info` 的消息组织结构（如替换红黑树为其他数据结构）、扩展异步通知机制（`mqueue.c` 的 `notify` 路径）。
