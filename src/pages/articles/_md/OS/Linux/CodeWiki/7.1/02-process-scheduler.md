---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "进程管理与调度"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "调度", "EEVDF", "进程管理"]
description: "Linux 进程生命周期（fork/exec/exit）与 EEVDF 调度器——sched_class 多态、__schedule 上下文切换、vruntime 虚拟时间。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`kernel/` 目录是 Linux 内核中进程管理、调度、信号、定时器、RCU、cgroup、BPF 等核心机制的实现所在。其中**进程管理与调度**是内核最核心的职责——操作系统之所以是"操作系统"，本质上就是管理 CPU 时间和进程生命周期的机器。

进程管理回答"进程怎么生、怎么死"：`fork` 创建进程（`copy_process`）、`exec` 加载新程序（`do_execve`）、`exit` 终止进程（`do_exit`）。调度回答"谁在 CPU 上跑"：在 N 个就绪进程和 M 个 CPU 之间，调度器按公平性和优先级决定下一个运行的进程，并通过上下文切换完成实际切换。

这一模块的边界很明确：进程控制块（`task_struct`）的生命周期管理、调度策略的多态分发、上下文切换的硬件相关部分委托给 `arch/`——`kernel/sched/core.c` 的 `context_switch` 调用 `switch_mm`（切页表）和 `switch_to`（切内核栈/寄存器），后者由 `arch/x86/include/asm/switch_to.h` 等架构代码实现。

## 模块架构

进程管理与调度模块内部围绕三条主线组织：**调度类策略链**、**进程生命周期子系统**、**信号机制**。

调度类（`sched_class`）是整个调度器的骨架。Linux 不用单一调度算法处理所有进程，而是按进程类型分为六个调度类，按固定优先级链排列：

```
stop > dl > rt > fair > ext > idle
```

每个调度类是一个 `const struct sched_class` 实例，实现统一的函数指针接口（`pick_next_task`/`enqueue_task`/`dequeue_task`/`put_prev_task` 等）。`pick_next_task` 遍历这条优先级链，第一个返回非空的类即获得 CPU。`stop_sched_class` 用于 CPU 间任务迁移等内核停止场景，`dl_sched_class` 处理 deadline 任务（实时保证），`rt_sched_class` 处理 POSIX 实时进程（SCHED_FIFO/SCHED_RR），`fair_sched_class` 处理普通进程（SCHED_NORMAL/SCHED_BATCH，使用 EEVDF 算法），`ext_sched_class` 是 v6.12 引入的可编程 BPF 调度器（sched_ext），`idle_sched_class` 是最终兜底。

进程生命周期子系统分布在 `kernel/fork.c`（创建）、`kernel/exit.c`（退出）、`kernel/exec.c`（执行新程序）。`fork.c` 的 `copy_process` 是创建流程的主函数，它按严格顺序调用 `dup_task_struct`→`sched_fork`→`copy_files`→`copy_fs`→`copy_sighand`→`copy_mm`→`copy_namespaces`→`copy_thread`→`alloc_pid`，每一步复制或共享父进程的一个子资源。`exit.c` 的 `do_exit` 是逆过程：`exit_mm`→`exit_files`→`exit_fs`→`exit_thread`→`exit_notify`→`schedule`。

信号机制（`kernel/signal.c`）是进程间异步通知的通道，与调度器紧密关联——信号投递在进程返回用户态时检查，可中断进程的阻塞等待。

## 调用链路

#### 进程创建：copy_process

```c title="kernel/fork.c"
kernel_clone(clone_flags, ...)
  └─ copy_process(clone_flags, ...)
       ├─ dup_task_struct(current, node)    → task_struct*
       ├─ sched_fork(clone_flags, p)         → 初始化 se/rt/dl 调度实体
       ├─ copy_files(clone_flags, p)         → files_struct*
       ├─ copy_fs(clone_flags, p)            → fs_struct*
       ├─ copy_sighand(clone_flags, p)       → sighand_struct*
       ├─ copy_mm(clone_flags, p)            → mm_struct*
       ├─ copy_namespaces(clone_flags, p)    → nsproxy*
       ├─ copy_thread(p, args)               → arch 相关: 寄存器/栈
       └─ alloc_pid(p->nsproxy->pid_ns)      → pid*
```

数据载体沿链变换：`clone_flags`（创建参数）→ `task_struct*`（进程控制块）→ 各子系统资源的独立副本或共享引用。`copy_thread` 设置子进程的内核栈和 `ip`/`sp` 寄存器，使其从 `ret_from_fork` 汇编入口开始执行——子进程"醒来"时仿佛刚从一次系统调用返回。

#### 调度核心：__schedule

```c title="kernel/sched/core.c"
__schedule(sched_mode)
  ├─ pick_next_task(rq, prev, rf)
  │    └─ 遍历 sched_class 链: stop→dl→rt→fair→ext→idle
  │         每个类调 class->pick_next_task(rq, prev)
  │         fair_sched_class → pick_eevdf(rq)  → sched_entity*
  │         第一个返回非 NULL 的 next 即获选
  ├─ context_switch(rq, prev, next, rf)
  │    ├─ switch_mm_irqs_off(prev->mm, next->mm, next)  → 切页表/地址空间
  │    └─ switch_to(prev, next, prev)                    → 切内核栈 + 寄存器
  └─ barrier()  → 编译器屏障，保证切换后 prev 指向"上一个"进程
```

`pick_next_task`（core.c:6100）是策略分发的核心——它遍历 `sched_class` 优先级链，每个类调用自己的 `pick_next_task` 方法。对于普通进程（绝大多数），命中 `fair_sched_class`，进入 EEVDF 选任务逻辑。`context_switch`（core.c:5329）完成两件事：`switch_mm` 切换地址空间（页表 CR3），`switch_to` 切换内核栈和 CPU 寄存器——后者是架构相关代码，x86 上操作 `task_struct->thread.sp` 和 TSS 的 `sp0` 字段。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 |
|------|------|---------|
| `copy_process` | `kernel/fork.c:~2090` | 进程创建主函数，按序复制各子资源 |
| `dup_task_struct` | `kernel/fork.c:911` | 分配 task_struct + 内核栈，复制父进程模板 |
| `sched_fork` | `kernel/sched/core.c` | 初始化调度实体，设置 sched_class，加入调度器 |
| `copy_mm` | `kernel/fork.c:1559` | 复制或共享地址空间（CLONE_VM 则共享 mm_struct） |
| `copy_thread` | `kernel/fork.c:2273` | 架构相关：设置子进程内核栈/寄存器，从 ret_from_fork 开始 |
| `alloc_pid` | `kernel/pid.c` | 从 PID 命名空间分配 PID 号 |
| `wake_up_new_task` | `kernel/sched/core.c` | 唤醒新进程，放入运行队列 |
| `__schedule` | `kernel/sched/core.c:~5916` | 调度核心：禁抢占→选下一个→上下文切换 |
| `pick_next_task` | `kernel/sched/core.c:6100` | 遍历 sched_class 链按优先级选任务 |
| `context_switch` | `kernel/sched/core.c:5329` | switch_mm（切页表）+ switch_to（切栈/寄存器） |
| `pick_eevdf` | `kernel/sched/fair.c:1136` | EEVDF 选任务：eligible + 最早虚拟截止时间 |
| `calc_delta_fair` | `kernel/sched/fair.c:297` | 虚拟时间计算：delta_exec 按权重归一化 |
| `do_exit` | `kernel/exit.c` | 进程退出：释放各子资源，设 EXIT_ZOMBIE |
| `do_group_exit` | `kernel/exit.c` | 进程组退出：给同线程组所有线程发 SIGKILL |

</details>

## 核心实现

### 进程创建 copy_process

`copy_process`（`kernel/fork.c:~2090`）是 `fork`/`vfork`/`clone` 系统调用的共同核心。`kernel_clone`（fork.c）做参数校验和信号处理准备后，进入 `copy_process`。

创建流程的关键设计是**按资源独立性排序的复制序列**——先分配进程控制块，再初始化调度，然后逐个复制子资源，最后分配 PID。这个顺序保证每一步都能依赖前面已初始化的状态：

1. **`dup_task_struct(current, node)`**（fork.c:911）——分配新的 `task_struct` 和内核栈。这是最底层的分配：用 `kmem_cache_alloc` 从 `task_struct` 的 slab cache 分配控制块，用 `vmalloc` 或 `kmalloc` 分配内核栈（`thread_stack`）。复制父进程的 `task_struct` 作为模板，然后清零关键字段（如 `pi_state`、`cpu_context`）。`node` 参数实现 NUMA 感知——在 fork 进程运行的 CPU 所属 NUMA 节点上分配内存，减少跨节点访问延迟。

2. **`sched_fork(clone_flags, p)`**（fork.c:2234）——初始化调度实体。这是新进程加入调度器的入口：根据 `clone_flags` 中是否含 `CLONE_VM` 刌定是否为线程，设置 `p->sched_class`（普通进程指向 `fair_sched_class`），初始化 `sched_entity` 的 `vruntime`（继承父进程的 vruntime，保证 fork 后不抢占 CPU），将进程状态设为 `TASK_NEW`（暂时不可运行）。

3. **`copy_files`/`copy_fs`/`copy_sighand`/`copy_mm`/`copy_namespaces`**（fork.c:2252-2267）——逐个复制或共享资源。每个 `copy_*` 函数检查 `clone_flags` 中的对应标志位：`CLONE_FILES` 共享文件描述符表、`CLONE_FS` 共享文件系统根、`CLONE_SIGHAND` 共享信号处理表、`CLONE_VM` 共享地址空间、`CLONE_NEWNS` 创建新 mount 命名空间。共享时只增加引用计数，复制时创建独立副本——这是 `clone` 系统调用实现线程、进程、容器隔离的基础。

4. **`copy_thread(p, args)`**（fork.c:2273）——架构相关：设置子进程的寄存器和内核栈。x86 上（`arch/x86/kernel/process_64.c` 的 `copy_thread`），设置 `p->thread.sp` 指向新内核栈顶，`p->thread.ip` 指向 `ret_from_fork` 汇编入口。子进程第一次被调度运行时，`switch_to` 切换到它的内核栈，CPU 从 `ret_from_fork` 开始执行——模拟一次系统调用返回，使子进程"诞生"在用户态 fork 调用点。对于 `kernel_thread`，则设置 `ip` 为内核线程函数入口。

5. **`alloc_pid`**（fork.c:2280）——从 PID 命名空间分配 PID。`struct pid` 是一个多层结构（每层对应一个 PID 命名空间），支持 `fork` 在不同命名空间中有不同的 PID 号。

`copy_process` 完成后，`kernel_clone` 调用 `wake_up_new_task(p)`（`kernel/sched/core.c`）将新进程状态从 `TASK_NEW` 改为 `TASK_RUNNING`，放入运行队列。此时新进程可以被 `pick_next_task` 选中。

### 调度器核心 __schedule

`__schedule`（`kernel/sched/core.c:~5916`）是内核中调用最频繁的函数之一——每次时钟中断、进程阻塞、唤醒抢占都可能触发。它的职责是"选一个进程并切换到它"。

```c title="kernel/sched/core.c"
static void __sched notrace __schedule(unsigned int sched_mode)
{
    struct task_struct *prev, *next;
    struct rq *rq;
    // 1. 禁抢占，锁定当前运行队列 rq
    rq = cpu_rq(cpu);
    prev = rq->curr;
    // 2. 选下一个进程
    next = pick_next_task(rq, prev, &rf);
    // 3. 如果不是同一个进程，做上下文切换
    if (likely(prev != next)) {
        context_switch(rq, prev, next, &rf);
    }
    // 4. 重新开抢占
}
```

`pick_next_task`（core.c:6100）的遍历策略是**优先级链短路**：从最高优先级的 `stop_sched_class` 开始，每个类调 `class->pick_next_task(rq, prev)`，第一个返回非 `NULL` 的类即获得 CPU。这意味着 `stop`/`dl`/`rt` 类只要有就绪进程就一定优先于 `fair` 类——实时进程无条件抢占普通进程。对于绝大多数系统负载，就绪队列里只有 `fair` 类进程，所以 v7.1 保留了快速路径：如果运行队列中没有 RT/DL 进程，直接调 `fair_sched_class.pick_next_task`（即 `pick_eevdf`），跳过链遍历。

`context_switch`（core.c:5329）分两步完成物理切换：

- **`switch_mm_irqs_off(prev->mm, next->mm, next)`**——切换地址空间。加载 `next->mm->pgd` 到 CR3（x86），刷新 TLB（如果 `prev` 和 `next` 的 mm 不同）。内核线程没有 `mm`（`next->mm == NULL`），使用前一个进程的 `active_mm`（lazy TLB 优化——内核线程不切换页表，避免无谓的 TLB flush）。

- **`switch_to(prev, next, prev)`**——切换内核栈和寄存器。x86 上通过 `__switch_to_asm`（`arch/x86/entry/entry_64.S`）保存 `prev` 的 `rsp`/`rbp`/`rip` 到 `prev->thread`，加载 `next->thread.sp` 到 RSP，CPU 自动从 `next->thread.ip` 继续执行。第三个参数 `prev` 是输出参数——`switch_to` 返回后，`prev` 指向"被切出的那个进程"（而非调用时的 `prev`），因为 `__schedule` 可能在另一次 `__schedule` 中被切回，此时局部变量 `prev` 已失效，需通过这个参数恢复。

### EEVDF 调度类

`fair_sched_class`（`kernel/sched/fair.c:14207`）处理 SCHED_NORMAL/SCHED_BATCH 进程——即系统中 99% 的进程。**v7.1 的关键变化：Linux 从 CFS（Completely Fair Scheduler）切换到 EEVDF（Earliest Eligible Virtual Deadline First）**。CFS 自 2.6.23（2007 年）统治了 Linux 调度器近 18 年，EEVDF 在 6.6 合入主线，7.x 完成过渡。

EEVDF 的核心思想是结合**公平性**和**延迟保证**：

- **公平性**：通过 `vruntime`（虚拟运行时间）衡量每个进程"已消耗的 CPU 公平份额"。权重越高的进程（nice 值越低），vruntime 增长越慢，从而获得更多 CPU 时间。
- **延迟保证**：每个调度实体有一个 `deadline`（虚拟截止时间），表示"这轮时间片内应该被调度执行的最后期限"。EEVDF 优先选择**eligible**（有资格运行，即 vruntime 不超前于队列平均）且 **deadline 最早**的进程。

```c title="kernel/sched/fair.c"
// 虚拟时间计算：将实际运行时间 delta_exec 按权重归一化
static inline u64 calc_delta_fair(u64 delta, struct sched_entity *se)
{
    // delta_exec * (NICE_0_LOAD / se->load.weight)
    // 权重高的进程，delta 缩小更多，vruntime 增长更慢
}

// vruntime 更新：当前运行进程每运行 delta_exec 时间，vruntime 增长
curr->vruntime += calc_delta_fair(delta_exec, curr);

// deadline 计算：vruntime + 本轮时间片的虚拟时间
se->deadline = se->vruntime + calc_delta_fair(se->slice, se);
// vd_i = ve_i + r_i / w_i （r_i 为实际时间片，w_i 为权重）
```

`pick_eevdf`（fair.c:1136）从运行队列的红黑树（按 `deadline` 排序）中选择第一个 eligible 的进程。它先找 deadline 最早的节点，检查其是否 eligible（`vruntime` 不小于运行队列的 `min_vruntime` 减去一个容差）；如果不 eligible，沿树搜索下一个。这比 CFS 简单的"选 vruntime 最小"多了一层 deadline 约束，使调度器能在保证公平的同时为短任务提供更好的延迟。

EEVDF 相对 CFS 的改进：CFS 只按 vruntime 排序，长任务和短任务获得相同的时间片，短任务可能被延迟。EEVDF 通过 deadline 让短时间片的任务优先执行，减少了交互式和短批处理任务的尾延迟。同时 EEVDF 简化了代码——去除了 CFS 的 `min_vruntime` 复杂调整逻辑和 `nr_running` 相关的启发式。

### 进程退出 do_exit

`do_exit`（`kernel/exit.c`）是进程生命周期的终点。它与 `copy_process` 对称——`copy_process` 按序构建资源，`do_exit` 按逆序释放：

```c title="kernel/exit.c"
void __noreturn do_exit(long code)
{
    // 1. exit_signals(tsk)     — 退出信号处理，不再接收信号
    // 2. exit_mm(tsk)          — 释放地址空间 mm_struct（mmput → __mmput）
    // 3. exit_files(tsk)       — 关闭所有文件描述符（files_struct 引用计数--）
    // 4. exit_fs(tsk)          — 释放 fs_struct（根目录/当前目录引用）
    // 5. exit_thread(tsk)      — 释放架构相关线程数据（FPU/TLS 等）
    // 6. exit_notify(tsk, group_dead) — 通知父进程 SIGCHLD，设 EXIT_ZOMBIE
    // 7. do_task_dead()        — 最终调度切换，不再返回
}
```

`exit_mm` 是最关键的一步：`mmput` 递减 `mm_struct` 的引用计数，当计数归零时 `__mmput` 释放所有 VMA、解除所有内存映射、释放页表。如果进程有子进程，`exit_notify` 将它们 `reparent` 给 init 进程（pid 1）。

进程退出后进入 `EXIT_ZOMBIE` 状态——`task_struct` 仍然保留（存储退出码和资源使用统计），等待父进程 `wait`/`waitpid` 回收。父进程调用 `sys_wait4` → `do_wait` → `wait_task_zombie` → `release_task` 最终释放 `task_struct`。如果父进程不回收，僵尸进程会泄漏内核内存。如果父进程先于子进程退出，`exit_notify` 的 `forget_original_parent` 会把孤儿进程过继给 init。

`do_exit` 的最后一步是 `do_task_dead()`——设置进程状态为 `TASK_DEAD`，调用 `__schedule` 切换到其他进程。这是进程最后一次被调度：切出后永远不会被切回。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略模式（vtable） | `struct sched_class`（`include/linux/sched.h:878`）；实例：`fair_sched_class`（fair.c:14207）、`dl_sched_class`（deadline.c:3428）、`idle_sched_class`（idle.c:569）、`ext_sched_class`（ext.c:4546）；遍历点：`pick_next_task`（core.c:6100） | C 无继承，用 `const struct sched_class` 函数指针表实现多态。新增调度算法（如 sched_ext）只需定义新实例并插入优先级链，不改 `__schedule`/`pick_next_task` 核心代码——开闭原则。`task_struct->sched_class` 指针在 `sched_fork` 时根据进程类型设定，运行时通过这个指针动态分发到对应策略的实现。 |

`sched_class` 是 Linux 内核中最典型的策略模式实现。它定义了一组统一的接口（`enqueue_task`/`dequeue_task`/`pick_next_task`/`put_prev_task`/`set_next_task`/`task_tick`/`yield`/`check_preempt_curr` 等），六个调度类各自实现这些接口。`__schedule` 不关心具体调度算法，只通过 `class->pick_next_task` 获取下一个进程——这是面向对象多态在 C 中的经典实现：vtable 模式。

## 模块间交互

进程管理与调度模块在创建和退出时需要与多个子系统协作：

- **`mm/`（内存管理）**：`copy_mm`（fork.c:1559）在 fork 时复制或共享父进程的 `mm_struct`——`CLONE_VM` 时只增加 `mm_count` 引用计数（线程场景），否则调用 `dup_mm` 创建完整副本（`copy_mm_range` 逐 VMA 复制页表，COW 标记只读 PTE）。`exit_mm` 在退出时通过 `mmput` 递减引用计数，归零时释放所有 VMA 和页表。调度器的 `context_switch` 调用 `switch_mm` 切换 CR3 页表寄存器，依赖 `mm/` 提供的 `mm_struct->pgd`。

- **`fs/`（文件系统）**：`copy_files`（fork.c:1617）复制文件描述符表 `files_struct`——`CLONE_FILES` 时共享（线程共享打开文件），否则 `dup_fd` 创建副本。`copy_fs`（fork.c:1596）复制文件系统根 `fs_struct`（根目录/当前工作目录）。`exit_files`/`exit_fs` 在退出时递减引用计数。

- **`arch/`（架构层）**：`copy_thread`（fork.c:2273 调用架构实现）设置子进程的寄存器和内核栈初始状态，x86 上设置 `thread.ip` 指向 `ret_from_fork`。`switch_to`（`arch/x86/include/asm/switch_to.h`）完成内核栈和寄存器的物理切换——这是调度器中唯一与硬件强耦合的部分。`switch_mm` 加载新页表到 CR3 也是架构相关操作。这种分层让 `kernel/sched/core.c` 的 `__schedule`/`context_switch` 保持架构无关，所有硬件细节委托给 `arch/`。

- **`init/`（启动）**：`start_kernel` 调用 `sched_init`（`kernel/sched/core.c`）初始化调度器——为每个 CPU 创建 `struct rq` 运行队列、初始化 `cfs_rq`/`rt_rq`/`dl_rq`、注册时钟中断回调 `scheduler_tick`。`init_task`（`init/init_task.c`）是静态定义的 0 号进程 `task_struct`，是所有进程的祖先。

交互方式以**直接函数调用**为主（`copy_process` 调 `copy_mm`/`copy_files`/`copy_thread`），无消息传递或异步通信。调度器与 `mm/`/`arch/` 的协作发生在 `context_switch` 的热路径上，性能要求极高——`switch_mm`/`switch_to` 的指令数直接影响调度延迟。

## 扩展方式

Linux v6.12 引入了 `sched_ext`（`kernel/sched/ext.c`），允许用 **BPF 程序实现自定义调度策略**。这是调度器扩展的革命性变化——此前新增调度算法需要修改内核源码并重新编译。

`sched_ext` 的扩展点是一个 BPF 调度器程序（`struct sched_ext_ops`），实现以下关键回调：

- `select_cpu`——为新唤醒的进程选择 CPU
- `enqueue`——将进程加入 BPF 调度器管理的队列
- `dispatch`——从 BPF 队列中选进程派发到 CPU 运行队列
- `running`/`stopping`——进程开始/停止运行的通知
- `init`/`exit`——调度器加载/卸载时的初始化/清理

`ext_sched_class`（ext.c:4546）在优先级链中位于 `fair` 之后、`idle` 之前。当 `sched_ext` 被启用时（`echo scx > /sys/kernel/sched_ext/state`），`fair_sched_class` 的进程被转移到 `ext_sched_class` 管理，由 BPF 程序完全决定调度策略。禁用时自动回退到 EEVDF。

用户通过 `scx_simple`、`scx_qmap`、`scx_rusty` 等现成 BPF 调度器加载即可切换调度策略，无需重编译内核。这种"调度器即 BPF 程序"的设计使调度策略可热加载、可安全实验（BPF verifier 保证不会 panic 内核），是 `sched_class` 策略模式扩展能力的终极体现。
