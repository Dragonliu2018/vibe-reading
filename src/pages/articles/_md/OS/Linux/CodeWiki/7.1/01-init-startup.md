---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "启动与初始化"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "启动", "初始化"]
description: "Linux 内核启动流程——从汇编 entry 到 start_kernel 装配各子系统、挂载根文件系统、启动 init 进程。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`init/` 目录是整个内核的装配点（assembly point）。架构相关的汇编入口代码（如 x86 的 `head_64.S`）完成最低级别的 CPU 初始化后，跳转到 C 语言入口 `start_kernel()`——从这一刻起，内核进入架构无关的通用初始化流程。`init/` 之所以独立存在，是因为它不包含任何单一子系统的实现逻辑，而是按严格的依赖顺序逐一调用各子系统的初始化入口（`sched_init`、`mm_init`、`vfs_caches_init` 等），将它们组装成一个可运行的内核。

`init/` 的核心职责边界：

- **不实现子系统**：调度器、内存管理、VFS 等子系统的初始化函数定义在各自目录（`kernel/sched/`、`mm/`、`fs/`），`init/` 只负责按正确顺序调用它们。
- **实现启动编排**：`start_kernel` 的调用序列、`rest_init` 的进程分叉、initcall 分级机制、根文件系统挂载策略，这些编排逻辑才是 `init/` 的真正内容。
- **桥接内核态与用户态**：从 `rest_init` 创建 1 号进程到 `run_init_process` 执行 `/sbin/init`，`init/` 完成内核态到用户态的最后一次跨越。

## 模块架构

`init/` 模块内部按职责可分为四个层次：启动序列编排、进程分叉与 idle、根文件系统挂载、用户空间 init exec。它们并非平行关系，而是严格的串行依赖——后一层的执行以前一层完成为前提。

```
┌─────────────────────────────────────────────────────────────┐
│                    init/ 模块内部结构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ① 启动序列编排 (init/main.c)                                │
│     start_kernel() ── 70+ 个子系统初始化调用                  │
│     │   按: arch → trap → mm → percpu → IRQ → RCU →         │
│     │       timer → sched → workqueue → vfs → ...           │
│     ▼                                                       │
│  ② 进程分叉 (init/main.c)                                    │
│     rest_init()                                              │
│     ├── kernel_thread(kernel_init)  → pid 1 (init 进程)      │
│     ├── kernel_thread(kthreadd)     → pid 2 (内核线程守护)    │
│     └── 0号进程 → cpu_startup_entry(CPU idle)                │
│     ▼                                                       │
│  ③ 根文件系统 (init/do_mounts.c, init/initramfs.c)           │
│     kernel_init_freeable()                                   │
│     ├── do_pre_smp_initcalls()                               │
│     ├── smp_init()                                           │
│     ├── do_basic_setup() ── do_initcalls()                  │
│     ├── wait_for_initramfs()  ← initramfs 异步解包完成        │
│     └── prepare_namespace() ── mount_root()                  │
│     ▼                                                       │
│  ④ 用户空间 init (init/main.c)                               │
│     kernel_init()                                            │
│     ├── free_initmem()  ── 释放 __init 段                    │
│     └── run_init_process("/sbin/init") ── exec              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

第一层 `start_kernel` 是最长的线性序列，它解决"内核各子系统需要按什么顺序初始化"的问题——例如 `trap_init` 必须在 `mm_core_init` 之前（缺页异常依赖陷阱门），`sched_init` 必须在 `rcu_init` 之后（RCU 是调度器的依赖）。第二层 `rest_init` 是整个启动流程的分叉点：0 号进程退入 idle，1 号和 2 号进程被创建出来分别接管用户空间和内核线程管理。第三层和第四层都在 1 号进程的上下文中执行，完成根文件系统挂载和最终 exec 到用户空间 init。

辅助文件各司其职：`init/init_task.c` 静态定义 0 号进程的 `task_struct` 模板（编译期常量，非运行时分配），`init/calibrate.c` 负责校准 BogoMIPS（为忙等待延时提供基准），`init/do_mounts_initrd.c` 支持传统 initrd（已 deprecated，被 initramfs 取代）。

## 调用链路

启动主链路从 `start_kernel` 到 `run_init_process`，跨越四个函数，每一步的输入是前一步建立的运行环境（而非数据结构传递）：

```
start_kernel()           [init/main.c:1017]
  │  输入: boot_params (arch 传递的启动参数)
  │  产出: 可用的内核运行环境 (mm/sched/IRQ/RCU/timer 全部就绪)
  │
  ▼
rest_init()              [init/main.c:716]
  │  输入: start_kernel 建立的环境
  │  产出: 三个进程 (pid 0 idle, pid 1 init, pid 2 kthreadd)
  │  数据: struct task_struct *kernel_init_thread (pid 1)
  │
  ▼
kernel_init()            [init/main.c]
  │  输入: pid 1 的 task_struct (由 rest_init 通过 kernel_thread 创建)
  │  产出: system_state = SYSTEM_RUNNING, __init 段已释放
  │
  ▼
kernel_init_freeable()   [init/main.c]
  │  输入: SMP 尚未完成, initcalls 未执行
  │  产出: 根文件系统已挂载, initcalls 全部执行完毕
  │  数据: do_initcalls() 遍历 initcall_levels[] → 调用各级别回调
  │
  ▼
run_init_process()       [init/main.c:1517-1529]
  │  输入: const char *init_filename (如 "/sbin/init")
  │  产出: exec 替换当前进程映像 → 进入用户空间
  │  数据: kernel_execve(init_filename, ...) → 不可返回
```

`rest_init` 是关键分叉点：它创建 pid 1 和 pid 2 两个内核线程后，0 号进程自身调用 `cpu_startup_entry` 进入 idle 循环。从 `kernel_init` 开始，代码运行在 pid 1 的上下文中。`kernel_init_freeable` 之所以从 `kernel_init` 中拆分出来（函数名带 `_freeable`），是因为 `free_initmem` 必须在 `kernel_init_freeable` 返回后才执行——而 `free_initmem` 本身的代码位于 `__init` 段，所以调用链被设计为先执行所有可释放的初始化逻辑，再释放 `__init` 段本身。

<details>
<summary>方法速查表</summary>

| 方法名 | 文件:行号 | 一行职责 | 关键设计决策 |
|--------|-----------|---------|-------------|
| `start_kernel` | init/main.c:1017 | 按 70+ 步顺序初始化全部子系统 | IRQ 分两阶段：先 `local_irq_disable` 再 `local_irq_enable` |
| `rest_init` | init/main.c:716 | 创建 pid 1/2，0 号进程退入 idle | init 进程钉在 boot CPU (`PF_NO_SETAFFINITY`) |
| `kernel_init` | init/main.c | 设置 `SYSTEM_RUNNING`，释放 `__init` 段 | 先 `free_initmem` 再 exec init |
| `kernel_init_freeable` | init/main.c | pre_smp_initcalls → SMP → initcalls → 根文件系统 | initramfs 异步解包与 initcalls 并行 |
| `do_initcalls` | init/main.c | 按级别遍历 initcall_levels 执行回调 | 分 7 个级别，严格有序 |
| `run_init_process` | init/main.c:1517-1529 | exec 用户空间 init | 用 exec 而非 fork+exec |
| `try_to_run_init_process` | init/main.c | 尝试单个 init 路径，-ENOENT 才回退 | 回退链设计 |
| `prepare_namespace` | init/do_mounts.c | 解析 root device 参数，挂载根文件系统 | 支持 root=/dev/xxx 和 root=PARTUUID= |
| `mount_root_generic` | init/do_mounts.c | 通用根挂载逻辑 | 处理多种块设备类型 |
| `populate_rootfs` | init/initramfs.c | 异步解包 initramfs 到 rootfs | `async_schedule_domain` 实现 I/O 并行 |
| `unpack_to_rootfs` | init/initramfs.c | cpio FSM 解包 | 状态机驱动，支持压缩格式 |
| `calibrate_delay` | init/calibrate.c | 校准 BogoMIPS | 为忙等待延时提供基准 |
| `initrd_load` | init/do_mounts_initrd.c | 传统 initrd 加载 | deprecated，被 initramfs 取代 |

</details>

## 核心实现

### start_kernel 装配序列

`start_kernel` 是内核中最长的单函数之一，包含 70 多个子系统初始化调用。这些调用不是随意排列的——每一步的顺序都由子系统间的依赖关系决定。按源码实际顺序（init/main.c:1017 起），可以划分为以下几个阶段：

**架构与早期基础设施阶段**：从 `set_task_stack_end_magic`（标记内核栈末尾以检测栈溢出）开始，经过 `smp_setup_processor_id`（识别 boot CPU）、`boot_cpu_init`（标记 boot CPU 为 active），到 `setup_arch`（架构特定初始化，如 x86 的 e820 内存映射解析、ACPI 表解析）。这一阶段 IRQ 保持禁用（`early_boot_irqs_disabled = true`，init/main.c:1030），因为中断控制器尚未初始化。`trap_init` 建立异常处理入口（缺页、除零等），是后续内存管理的前提。

**中断与时间子系统阶段**：`early_irq_init` 和 `init_IRQ` 完成中断控制器初始化后，依次调用 `tick_init`（时钟事件设备注册）、`rcu_init`（Read-Copy-Update 机制）、`init_timers`（低分辨率定时器）、`hrtimers_init`（高分辨率定时器）、`softirq_init`（软中断）、`timekeeping_init` 和 `time_init`（墙上时钟和硬件时钟）。这一顺序体现了依赖链：RCU 需要时钟驱动来推进宽限期（grace period），定时器需要时钟事件设备。此后 `sched_clock_init` 初始化调度时钟，为下一步的 `sched_init` 做准备。

**核心子系统阶段**：`mm_init`（完整内存管理：buddy allocator、slab/slub 分配器初始化）、`sched_init`（调度器：runqueue、CFS 初始化）、`preempt_dynamic_init`（动态抢占模式选择）、`workqueue_init_early`（工作队列早期初始化）。这一阶段的关键设计是 `early_boot_irqs_disabled` 在此处变为 `false` 并调用 `local_irq_enable()`（init/main.c:1147）——中断在此刻才正式开启。之后 `vfs_caches_init`（VFS 缓存：dentry/inode hash 表）和 `signals_init`（信号处理）完成用户空间接口的基础设施。

```c title="init/main.c (简化)"
asmlinkage __visible void __init __no_sanitize_address start_kernel(void)
{
    set_task_stack_end_magic(&init_task);      // 栈溢出检测
    smp_setup_processor_id();
    debug_objects_early_init();
    boot_cpu_init();
    page_address_init();
    pr_notice("%s", linux_banner);

    setup_arch(&command_line);                 // 架构初始化
    trap_init();                               // 异常入口
    mm_core_init();                            // 早期内存管理
    setup_per_cpu_areas();                     // per-CPU 变量区
    boot_init_stack_canary();                  // 栈金丝雀

    early_irq_init();
    init_IRQ();
    tick_init();
    rcu_init();
    init_timers();
    hrtimers_init_init();
    softirq_init();
    timekeeping_init();
    time_init();
    sched_clock_init();

    mm_init();                                 // 完整内存管理
    sched_init();                              // 调度器
    preempt_dynamic_init();
    workqueue_init_early();

    local_irq_enable();                        // 中断正式开启

    vfs_caches_init();
    signals_init();

    rest_init();                               // → 进程分叉
}
```

`early_boot_irqs_disabled` 标记（init/main.c:131）是这一序列中重要的安全机制：在中断子系统完全初始化之前，所有中断必须保持禁用状态。该标记在 `start_kernel` 开头设为 `true`，在 IRQ 和定时器初始化完成后设为 `false`——这不仅是布尔标志，还配合 `WARN_ON` 在错误时机开中断时发出警告。

### rest_init 与 0/1/2 号进程

`rest_init`（init/main.c:716）是启动流程的分叉点。执行到这里时，系统中只有一个进程——0 号进程（init_task），它就是 `start_kernel` 的执行上下文。`rest_init` 的工作是创建另外两个核心进程，然后让 0 号进程退入 idle：

```c title="init/main.c:716 (简化)"
noinline void __ref rest_init(void)
{
    struct task_struct *tsk;
    int pid;

    rcu_scheduler_starting();
    pid = kernel_thread(kernel_init, NULL, CLONE_FS);    // 创建 pid 1
    numa_default_policy();
    pid = kernel_thread(kthreadd, NULL, CLONE_FS);       // 创建 pid 2
    kthreadd_task = find_task_by_pid_ns(pid, &init_pid_ns);

    rcu_read_lock();
    tsk = find_task_by_pid_ns(1, &init_pid_ns);          // 获取 pid 1
    // 将 init 进程钉在 boot CPU 上
    tsk->flags |= PF_NO_SETAFFINITY;
    set_cpus_allowed_ptr(tsk, cpumask_of(boot_cpu));
    rcu_read_unlock();

    cpu_startup_entry(CPUHP_ONLINE);                     // 0 号进程进入 idle
}
```

**0 号进程（idle/Swapper）**：`init/init_task.c` 中通过 `INIT_TASK` 宏静态定义了 0 号进程的 `task_struct`。这是编译期常量——在系统启动的第一个瞬间，0 号进程就已经"存在"了，不需要通过 `fork` 创建。`start_kernel` 就运行在 0 号进程的上下文中。`rest_init` 结束后，0 号进程调用 `cpu_startup_entry` → `do_idle` 进入无限循环，在无其他可运行进程时执行 `hlt` 指令降低功耗。每个 CPU 都有自己的 idle 进程（通过 `fork_idle` 创建），但它们共享 0 号进程的 `task_struct` 作为模板。

**1 号进程（init）**：通过 `kernel_thread(kernel_init, ...)` 创建。kernel_init 先执行 `kernel_init_freeable` 完成子系统初始化和根文件系统挂载，然后调用 `run_init_process` exec 到用户空间 init。设计上选择 `exec` 而非 `fork+exec`——因为 kernel_init 线程本身就是 pid 1，exec 只替换进程映像而不改变 PID，这保证了用户空间 init 的 PID 始终为 1。

**2 号进程（kthreadd）**：内核线程守护进程。所有后续内核线程（如 kworker、ksoftirqd、migration）都由 kthreadd 统一创建和管理。kthreadd 维护一个 `kthread_create_list` 链表，其他模块通过 `kthread_create` 接口将创建请求加入链表，kthreadd 负责实际调用 `kernel_thread` 创建线程。

**init 进程钉在 boot CPU 的设计**（init/main.c:733-737）：`rest_init` 设置 `PF_NO_SETAFFINITY` 标志并通过 `set_cpus_allowed_ptr` 将 init 进程限制在 boot CPU 上。原因是在 `sched_init_smp` 完成之前，调度器的 SMP 支持尚未就绪，任务跨 CPU 迁移可能引发问题。这一限制在 `kernel_init_freeable` 调用 `sched_init_smp` 后被解除。

**`rest_init` 标注 `__ref` 而非 `__init`**：这是一个关键的安全设计。`__init` 段在 `free_initmem` 后会被释放，如果 `rest_init` 被标记为 `__init`，而它调用的 `cpu_startup_entry`（非 `__init`）在其返回后仍可能引用 `rest_init` 的代码地址，就会触发 use-after-free。`__ref` 告诉链接器"此函数虽然调用了 `__init` 段的代码，但自身不放在 `__init` 段"——避免潜在的段释放后引用问题（init/main.c 中的 `free_initmem` 调用在 init/main.c:1602 附近）。

### 根文件系统挂载与 initramfs

根文件系统挂载是启动流程中最复杂的环节之一，涉及两个文件的协作：`init/initramfs.c` 负责 initramfs 解包，`init/do_mounts.c` 负责块设备根文件系统挂载。

**initramfs 异步解包**（init/initramfs.c:777-778）：`populate_rootfs` 通过 `async_schedule_domain` 将 cpio 解包工作调度为异步任务。这是一个精妙的设计——initramfs 解包是 I/O 密集型操作（可能包含大量文件），将其异步化后可以与后续的 `do_initcalls` 并行执行，缩短启动时间。`kernel_init_freeable` 在 `do_basic_setup`（包含 initcalls）之后调用 `wait_for_initramfs`，确保在访问根文件系统内容之前解包完成：

```c title="init/main.c (kernel_init_freeable 简化)"
static noinline void __init kernel_init_freeable(void)
{
    do_pre_smp_initcalls();            // early initcalls
    smp_init();                        // 启动 secondary CPU
    sched_init_smp();                  // SMP 调度器就绪

    do_basic_setup();                  // → do_initcalls() 所有级别
                                      //   此时 initramfs 异步解包正在并行进行

    console_on_rootfs();               // 控制台切换到 /dev/console

    /* 等待 initramfs 异步解包完成 */
    wait_for_initramfs();
    ...
    prepare_namespace();               // 解析 root= 参数, 挂载根文件系统
}
```

**cpio FSM 解包**（`unpack_to_rootfs` in init/initramfs.c）：initramfs 是一个 cpio 归档，可能经过 gzip/xz/zstd 压缩。`unpack_to_rootfs` 实现了一个状态机（FSM）来逐个处理 cpio 条目：读取 header → 解析文件名和权限 → 创建文件/目录/符号链接 → 读取文件数据 → 下一个条目。状态机设计使得解包可以处理流式输入，不需要将整个归档加载到内存。

**prepare_namespace 与 mount_root**（init/do_mounts.c）：如果内核使用传统根文件系统（非 initramfs 作为最终根），`prepare_namespace` 负责解析 `root=` 内核参数，确定根设备，然后调用 `mount_root` → `mount_root_generic` 挂载。`parse_root_device` 支持多种格式：`/dev/sda1`、`PARTUUID=xxx`、`PARTNROFF=xxx` 等。挂载完成后，`mount_root_generic` 执行 `mount` 系统调用将块设备挂载到 `/`。

**initramfs 与传统 root 的关系**：现代 Linux 通常使用 initramfs 作为早期根文件系统。initramfs 解包到 rootfs（一个 tmpfs）后，如果 `root=` 参数指定了块设备，`prepare_namespace` 会将该块设备挂载到 `/root`，然后 `init` 进程通过 `switch_root` 将根从 initramfs 切换到块设备。如果没有 `root=` 参数（如某些嵌入式系统），initramfs 本身就是最终根文件系统。

**init exec 回退链**（init/main.c:1618-1656）：`kernel_init` 在完成所有初始化后，按优先级依次尝试多个 init 路径：

```c title="init/main.c (init 回退链简化)"
if (!run_init_process("/sbin/init") ||
    !run_init_process("/etc/init") ||
    !run_init_process("/bin/init") ||
    !run_init_process("/bin/sh"))
    panic("No init found.  Try passing init= option to kernel.");
```

每个 `try_to_run_init_process` 调用只有在返回 `-ENOENT`（文件不存在）时才继续尝试下一个路径。如果文件存在但 exec 失败（如权限不足、格式错误），不会回退而是直接 panic——因为找到一个无法执行的 init 比找不到更严重。用户也可以通过内核参数 `init=/path/to/custom_init` 指定自定义 init 路径，该路径优先级最高。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法（Template Method） | `do_initcalls` in init/main.c | 定义 initcall 执行框架（遍历级别数组），具体初始化逻辑由各子系统的 initcall 回调实现，解耦编排与实现 |
| 策略（Strategy） | `try_to_run_init_process` 回退链 in init/main.c:1618-1656 | init 路径作为可替换策略，按优先级链式尝试，支持 `init=` 参数注入自定义策略 |
| 生产者-消费者 | `kthreadd` (pid 2) + `kthread_create` | kthreadd 消费 `kthread_create_list` 链表中的创建请求，各子系统作为生产者通过 `kthread_create` 提交请求 |

initcall 分级装配是模板方法模式的典型应用。内核定义了 7 个 initcall 级别（`early`、`pure`、`core`、`postcore`、`arch`、`subsys`、`fs`、`device`、`late`），每个级别对应一个函数指针数组段。`do_initcalls` 的框架代码不变——它只是按级别顺序遍历数组并调用每个函数指针。具体哪些初始化函数被注册到哪个级别，由各子系统通过 `early_initcall()`、`subsys_initcall()`、`module_init()` 等宏在编译期决定。这种设计让新增子系统初始化无需修改 `start_kernel` 或 `do_initcalls` 的代码，只需用合适的宏注册即可。

## 模块间交互

`init/` 作为装配点，与几乎所有的内核子系统都有单向调用关系——它调用各子系统的初始化入口，但不被子系统反向调用（除了通过 initcall 机制间接注册）。

```
被 arch 调用:
  arch/x86/kernel/head_64.S ──跳转──→ init/main.c:start_kernel()

init/ 调用的子系统初始化入口:
  start_kernel ──→ mm/       (mm_core_init, mm_init)
                ──→ kernel/sched/  (sched_init, sched_init_smp)
                ──→ kernel/irq/    (early_irq_init, init_IRQ)
                ──→ kernel/time/   (tick_init, time_init, hrtimers_init)
                ──→ kernel/rcu/    (rcu_init)
                ──→ kernel/workqueue.c (workqueue_init_early)
                ──→ fs/            (vfs_caches_init)
                ──→ kernel/signal.c (signals_init)
                ──→ arch/x86/      (setup_arch, trap_init)

init/ 调用的根文件系统组件:
  kernel_init_freeable ──→ init/initramfs.c (populate_rootfs, wait_for_initramfs)
                       ──→ init/do_mounts.c (prepare_namespace, mount_root)

init/ 创建的内核基础设施:
  rest_init ──→ kernel/kthread.c (kthreadd — 内核线程守护进程)
```

交互方式全部是函数调用，不存在事件或消息机制——这是启动阶段的特征：系统尚未完全运行，事件基础设施（如 netlink、uevent）尚未就绪，只能通过直接函数调用完成初始化。`kthreadd` 是唯一的间接交互通道：各子系统在运行时通过 `kthread_create` 向 kthreadd 发送创建内核线程的请求，但这发生在启动完成之后。

## 扩展方式

**新增一个 initcall**：如果需要在内核启动时执行自定义初始化代码，按以下步骤操作：

1. 在你的子系统代码中定义初始化函数：
```c title="my_subsystem/init.c"
static int __init my_subsystem_init(void)
{
    // 初始化逻辑
    return 0;
}
```

2. 选择正确的 initcall 级别并用对应宏注册：
```c
// 级别从早到晚:
early_initcall(my_subsystem_init);   // 最早, IRQ 未开, 仅用于关键早期设置
pure_initcall(my_subsystem_init);    // early 之后, 适合无依赖的基础设施
core_initcall(my_subsystem_init);    // 核心级别, 大多数子系统
postcore_initcall(my_subsystem_init);
arch_initcall(my_subsystem_init);    // 架构相关初始化
subsys_initcall(my_subsystem_init);  // 子系统级别
fs_initcall(my_subsystem_init);      // 文件系统相关
device_initcall(my_subsystem_init);  // 设备驱动, 最常用的级别
late_initcall(my_subsystem_init);    // 最后执行, 适合需要所有其他初始化完成的场景
```

级别选择原则：你的初始化函数依赖什么，就选择在它之后的级别。例如依赖 DMA 子系统的驱动应使用 `device_initcall`（DMA 在 `subsys_initcall` 级别初始化）。`module_init` 宏在编译进内核时等价于 `device_initcall`，在编译为模块时则注册为模块加载入口。

3. 如果初始化代码需要访问用户空间文件（如加载 firmware），必须在 `do_basic_setup` 之后执行——`wait_for_initramfs` 保证 rootfs 可用。使用 `fs_initcall` 或更晚级别即可满足此条件。
