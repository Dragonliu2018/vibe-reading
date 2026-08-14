---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "Overview"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "C", "内核", "操作系统", "调度", "内存管理", "VFS", "网络栈"]
description: "Linux 7.1 内核源码架构解读——从系统调用入口到进程调度、内存管理、VFS、网络栈、块 I/O、io_uring、LSM 安全框架的 12 个核心子系统 internals。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v7.1 · **协议** GPL-2.0 WITH Linux-syscall-note · **语言** C（少量 Rust/汇编）· **代码量** ~30M 行（63K 源文件）· **仓库** [GitHub](https://github.com/torvalds/linux)

---

## 总览

### 项目简介

Linux kernel 是一个**宏内核**（monolithic kernel）操作系统内核——所有内核服务（进程管理、内存管理、文件系统、网络栈、设备驱动）运行在同一个内核地址空间中，通过函数调用而非消息传递协作。它管理硬件资源、为上层软件提供系统调用接口（syscall ABI），是任何 Linux 操作系统的核心。

它解决的核心问题：在多用户、多进程、多硬件架构的环境下，公平高效地调度 CPU、分配内存、隔离进程、抽象文件与设备、收发网络包、保障安全。核心价值在于**一套源码支撑从嵌入式设备到超级计算机的数十种架构**，通过分层抽象和可插拔子系统实现这一可移植性。

核心使用场景：服务器/云主机操作系统内核、Android/嵌入式设备内核、容器与虚拟化宿主机内核。**项目边界**：内核本身不包含用户态工具（shell、库、实用程序）——那些属于 GNU coreutils、glibc、systemd 等用户态项目；内核只定义 syscall ABI 并实现其语义。

### 功能矩阵

| 特性 | 实现目录 | 说明 |
|------|---------|------|
| 进程管理与调度 | `kernel/sched/` | EEVDF 调度器、fork/exec/exit 生命周期 |
| 内存管理 | `mm/` | buddy 分配器、slub、page cache、mmap、vmscan 回收 |
| 虚拟文件系统 | `fs/` | VFS 四对象抽象、path resolution、mount namespace |
| 块 I/O | `block/` | blk-mq 多队列、I/O 调度器、bio 请求 |
| 网络协议栈 | `net/` | socket/sk_buff、L2-L4 分层、NAPI 收发 |
| 进程间通信 | `ipc/` | SysV sem/shm/msg + POSIX mqueue |
| 异步 I/O | `io_uring/` | 共享内存 SQ/CQ ring、SQPOLL、53 种 op |
| 加密框架 | `crypto/` | 算法注册表、模板组合、异步 transform |
| 安全框架 | `security/` | LSM static call hooks、可叠加安全模块 |
| 架构层 | `arch/x86/` | 启动汇编、syscall 入口、页表、中断 |
| 驱动模型 | `drivers/base/` | device/bus/driver 中介者模型、platform bus |
| 通用库 | `lib/` | 红黑树、maple tree、xarray、kobject/sysfs |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C | 核心 | 主实现语言 |
| 汇编（x86/ARM/RISC-V…） | 核心 | 启动、syscall 入口、上下文切换、原子操作 |
| Rust | 可选 | 驱动实验性支持（`rust/`） |
| Kbuild/Makefile | 核心 | 构建系统 |
| Kconfig | 核心 | 编译配置系统 |

### 版本历史

Linux 7.1（2025 年 stable）是 7.x 系列的首个稳定版。相较 6.x，关键演进：**EEVDF 调度器**取代 CFS（`kernel/sched/fair.c` 的 `pick_eevdf`）、**LSM 框架从 hlist 链表迁移到 static call**（性能 + Spectre 防护）、**SLUB 引入 sheaves 机制**（per-CPU 对象数组替代 cmpxchg）、**VMA 管理迁移到 Maple Tree**（取代红黑树）、**io_uring 持续扩展至 53 种 opcode**。本文基于 v7.1 stable tag 解读。

## 快速上手

Linux kernel 不能"跑起来"看效果——它本身就是运行环境。代码阅读者最快验证理解的方式是**构建并启动一个自定义内核**：

```bash title="快速构建（Ubuntu/Debian）"
# 安装构建依赖
sudo apt install build-essential libncurses-dev bison flex libssl-dev libelf-dev

# 配置（沿用当前系统的 config，最小改动）
cp /boot/config-$(uname -r) .config
make olddefconfig

# 构建（-j 按核数并行）
make -j$(nproc) bzImage modules

# 安装到本机（可选，重启生效）
sudo make modules_install install
sudo reboot
```

验证：重启后 `uname -r` 显示新版本号即构建成功。**注意**：在不理解配置的情况下安装自建内核可能导致系统无法启动，建议在虚拟机中验证。

## 架构设计解析

### 系统架构

Linux 内核的架构思想是**宏内核 + 分层抽象 + 可插拔子系统**。宏内核意味着所有服务共享地址空间、通过直接函数调用协作（性能优先，避免微内核的消息传递开销）；分层抽象让核心代码跨架构复用（arch 层提供 `setup_arch`/`copy_thread`/`switch_to` 等函数指针接口）；可插拔子系统让文件系统、网络协议、安全模块、I/O 调度器在运行时注册和切换。

![分层架构](/vibe-reading/images/articles/linux-kernel-internals/architecture.svg)

系统自上而下分七层：用户态进程通过 `syscall` 指令陷入**系统调用接口层**（`arch/x86/entry/` 的 `entry_SYSCALL_64` → `do_syscall_64` switch-case 分发）；请求进入**VFS/IPC/网络接口层**（`fs/`、`net/`、`ipc/` 提供 syscall 语义实现）；这些接口层依赖**内存管理层**（`mm/` 的 page cache、buddy、slub）管理数据缓冲；数据落盘走**块 I/O 与设备驱动层**（`block/` 的 blk-mq、`drivers/` 的具体驱动）；**安全框架**（`security/` LSM）以 hook 形式横切各层做权限检查；最底层的**架构层**（`arch/x86/`）提供启动、页表、中断、上下文切换的硬件相关实现。层间依赖方向自上而下，arch 层是最底层依赖。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|------------------------|
| 系统调用接口 | `arch/x86/entry/` | 隔离用户态/内核态边界，保存 pt_regs，分发到 syscall 实现 |
| VFS/IPC/网络接口 | `fs/`、`net/`、`ipc/` | 把 syscall 语义翻译为子系统能理解的请求，抽象文件/socket/IPC |
| 内存管理 | `mm/` | 管理物理/虚拟内存，提供 page cache、buddy、slub、mmap、回收 |
| 块 I/O / 设备驱动 | `block/`、`drivers/` | 把 I/O 请求转为硬件命令，抽象设备驱动模型 |
| 安全框架 | `security/` | 在关键路径插入可叠加的安全检查 hook，不侵入业务逻辑 |
| 架构层 | `arch/x86/`、`lib/` | 硬件相关实现（页表/中断/启动/切换）+ 通用数据结构库 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略模式（vtable） | `sched_class`、`file_operations`、`inode_operations`、`proto_ops`、`elevator_mq_ops`、`crypto_type`、`net_device_ops` | C 无继承，用函数指针表实现多态；新增类型不改核心分发代码（开闭原则） |
| 注册表模式 | `net_families[]`、`inetsw[]`、`inet_protos[]`、`ptype_base[]`、`crypto_alg_list`、`file_systems` 链表 | 运行时注册/查找可插拔实现（文件系统/协议/算法） |
| 中介者模式 | `bus_type`（device 与 driver 的中介）、`ipcget`（IPC 对象统一入口） | 解耦交互双方，支持热插拔与自动匹配 |
| 责任链模式 | `call_int_hook`（LSM 多模块顺序检查）、`pick_next_task`（调度类优先级遍历） | 多个处理者顺序处理，任一可短路决定结果 |
| 装饰器/组合模式 | `crypto_template`（gcm(aes) 组合）、`shm_file_operations`（包装底层 vm_ops） | 正交组合避免 O(M×N) 实现 |
| 生产者-消费者 | blk-mq 软/硬件队列、io_uring SQ/CQ ring、NAPI poll | 解耦生产与消费速率，支持批量与背压 |
| 对象池 | slub sheaves、bio_set、bio_alloc_cache | 减少高频分配的锁竞争 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `task_struct` | 进程/线程控制块 | fork 创建，exit 释放 | 持有 `mm_struct`、`files`、`signal` |
| `mm_struct` | 进程地址空间 | fork 时 `copy_mm`，exit 时 `exit_mm` | 持有 VMA maple tree、pgd |
| `vm_area_struct` | 虚拟内存区域 | `do_mmap` 创建，`munmap` 释放 | 挂入 `mm_struct->mm_mt` |
| `inode` | 文件元数据 | `iget5_locked` 创建，`iput` 释放，LRU | 属 `super_block`，含 `address_space` |
| `dentry` | 目录项/路径缓存 | `d_alloc` 创建，`dput` 释放，LRU | 指向 `inode`，dcache 哈希 |
| `file` | 打开的文件实例 | open 创建，close 释放 | 指向 `dentry`+`inode`，持 `f_op` |
| `bio` | 块 I/O 请求 | `bio_alloc` 创建，`bio_endio` 完成 | 含 `bio_vec[]`，提交给 `request_queue` |
| `sk_buff` | 网络数据包 | `alloc_skb` 创建，`kfree_skb` 释放 | 贯穿 L2-L4，属 `sock` |
| `io_ring_ctx` | io_uring 实例 | `io_uring_setup` 创建 | 持有 SQ/CQ ring、`io_kiocb` 池 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `struct sched_class` | `include/linux/sched.h:878` | `fair_sched_class`/`rt`/`dl`/`ext`/`idle`/`stop` | `DEFINE_SCHED_CLASS()` 静态实例 |
| `struct file_operations` | `include/linux/fs.h:1926` | 各文件系统的 `*_fops` | `inode->i_fop` → `file->f_op` 装配 |
| `struct blk_mq_ops` | `include/linux/blk-mq.h:576` | 各块设备驱动的 `queue_rq`/`complete` | `blk_mq_tag_set.ops` |
| `struct proto_ops` | `include/linux/net.h:181` | `inet_stream_ops`/`inet_dgram_ops` | `socket->ops` 在 `inet_create` 装配 |
| `struct crypto_type` | `crypto/internal.h:36` | `crypto_skcipher_type`/`crypto_aead_type` 等 | `cra_type` 指针 |
| `struct security_hook_list` | `include/linux/lsm_hooks.h:95` | 各 LSM 的 hook 数组 | `security_add_hooks` → static call slot |

## 代码目录

```
linux/
├── init/              # 启动与初始化（start_kernel 装配各子系统）
├── kernel/            # 进程管理、调度（EEVDF）、信号、RCU、cgroup、bpf
├── mm/                # 内存管理（buddy/slub/page cache/mmap/vmscan）
├── fs/                # VFS 通用层 + 具体文件系统（ext4/xfs/tmpfs…）
├── block/             # 块 I/O 子系统（blk-mq/调度器/bio）
├── net/               # 网络协议栈（socket/core/ipv4/ipv6…）
├── ipc/               # System V IPC + POSIX mqueue
├── io_uring/          # 异步 I/O 框架
├── crypto/            # 加密算法框架
├── security/          # LSM 安全框架 + SELinux/AppArmor/Landlock
├── arch/              # 架构相关代码（x86/arm64/riscv…）
├── drivers/           # 设备驱动（占代码量最大，base/ 是驱动模型核心）
├── lib/               # 通用数据结构与算法库（rbtree/maple_tree/xarray…）
├── include/           # 内核头文件
├── Documentation/     # 文档
└── Makefile, Kbuild   # 构建系统
```

`drivers/` 是代码量最大的目录（33K 文件），但本文聚焦内核**核心子系统**的 internals，不展开具体设备驱动——驱动模型的核心抽象见[驱动模型与基础设施](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)。

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/linux-kernel-internals/module-dependencies.svg)

模块间的依赖方向：`init/` 在 `start_kernel` 中装配所有子系统（调用 `sched_init`/`mm_init`/`vfs_caches_init`/`security_init` 等）；`kernel/`（调度/进程）依赖 `mm/`（`copy_mm`）和 `arch/`（`copy_thread`/`switch_to`）；`fs/` 依赖 `mm/`（page cache）和 `block/`（`submit_bio`）；`net/` 依赖 `mm/`（skb 分配）；`security/` 以 hook 横切 `fs`/`net`/`kernel`；`block/` 依赖 `drivers/`（驱动实现 `blk_mq_ops`）；所有子系统最终依赖 `arch/`（页表/中断/系统调用入口）和 `lib/`（通用数据结构）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 启动与初始化 | 从汇编跳转到 C，装配子系统，启动 init | `start_kernel` | 唯一的启动序列，各子系统的装配点 | [01](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/01-init-startup) |
| 进程管理与调度 | 进程生命周期 + EEVDF 调度 | `copy_process`/`__schedule` | 调度是内核最核心的职责 | [02](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/02-process-scheduler) |
| 内存管理 | 物理页分配、虚拟内存、回收 | `__alloc_pages`/`handle_mm_fault` | 内存是所有子系统的基础资源 | [03](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/03-memory-management) |
| 虚拟文件系统 | 统一文件操作接口、路径解析 | `do_sys_open`/`vfs_read` | VFS 是"一切皆文件"的抽象根基 | [04](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/04-vfs) |
| 块 I/O 子系统 | bio 请求、多队列、调度器 | `blk_mq_submit_bio` | 独立的 I/O 路径与调度策略 | [05](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/05-block-io) |
| 网络协议栈 | socket/sk_buff、分层收发 | `__dev_queue_xmit`/`net_rx_action` | 网络有独立的分层模型与收发路径 | [06](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/06-network-stack) |
| 进程间通信 | SysV sem/shm/msg + POSIX mqueue | `ipcget`/`do_shmat` | 独立的进程间数据共享/同步机制 | [07](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/07-ipc) |
| io_uring 异步 I/O | 共享内存 ring、SQPOLL、53 种 op | `io_uring_setup`/`io_submit_sqes` | 独立的异步 I/O 框架，不走传统 syscall 路径 | [08](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/08-io-uring) |
| 加密框架 | 算法注册表、模板组合、异步 transform | `crypto_alloc_tfm` | 独立的算法可替换框架，硬件加速透明 | [09](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/09-crypto-framework) |
| 安全框架 LSM | static call hooks、可叠加安全模块 | `security_init`/`call_int_hook` | 横切各层的安全检查，机制与策略分离 | [10](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/10-security-lsm) |
| 架构层与系统入口 | 启动汇编、syscall 入口、页表、中断 | `entry_SYSCALL_64`/`setup_arch` | 硬件相关，是跨架构复用的关键抽象 | [11](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/11-arch-x86) |
| 驱动模型与基础设施 | device/bus/driver 中介者、kobject、lib | `device_register`/`driver_attach` | 统一的设备驱动抽象与通用库 | [12](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model) |

> 模块间的动态调用顺序见下方「核心运行流程」的 read() 数据流链路。

## 运行时行为

### 启动流程

启动从 `arch/x86/kernel/head_64.S` 的 `startup_64` 开始（此时已在 64 位模式，bootloader 建立了早期 identity 页表）。汇编阶段修正页表物理地址、加载 CR3/GDT/IDT、设置 EFER（启用 SCE/NX），跳转到 C 代码 `x86_64_start_kernel`（`head64.c:222`），最终调用架构无关的 `start_kernel()`（`init/main.c:1017`）。

`start_kernel` 是各子系统的**装配点**——按严格顺序初始化：`setup_arch`（架构/e820 内存探测）→ `mm_core_init`/`mm_init`（内存管理）→ `sched_init`（调度器）→ `init_IRQ`/`rcu_init`（中断/RCU）→ `vfs_caches_init`（VFS）→ `cgroup_init`/`security_init`（cgroup/安全）→ `rest_init`。对象装配的关键：`init_task`（`init/init_task.c`）是静态定义的 0 号进程 `task_struct` 模板；`rest_init`（`init/main.c:716`）用 `kernel_thread` 创建 `kernel_init` 线程（pid 1）和 `kthreadd`（pid 2，内核线程守护者），0 号进程进入 `cpu_startup_entry` idle。`kernel_init` 完成剩余 initcall、挂载根文件系统（`do_mounts.c` 的 `prepare_namespace` → `mount_root`）、`run_init_process` exec `/sbin/init` 进入用户空间。配置来自内核命令行（`boot_command_line`）+ 编译默认；`__init` 段在 `free_initmem` 后释放。

### 核心运行流程

下面三条链路覆盖了内核最核心的运行模式：系统调用处理、缺页与内存分配、网络收包。

#### 系统调用：read() 端到端数据流

业务流程：用户调 `read(fd, buf, n)` → 陷入内核 → VFS 查文件 → page cache 命中则拷贝返回 / 未命中则提交 bio 读盘 → 完成回调唤醒 → 拷贝到用户 buf → 返回。

![read 数据流](/vibe-reading/images/articles/linux-kernel-internals/data-flow.svg)

文字描述：从 `entry_SYSCALL_64`（`entry_64.S:87`）保存 pt_regs、切内核 CR3（KPTI）开始，`do_syscall_64`（`syscall_64.c:87`）经 `x64_sys_call` switch-case 分发到 `__x64_sys_read`（v7.1 关键变化：`sys_call_table[]` 不再用于分发，改为编译器优化的 switch-case + `array_index_nospec` 防 Spectre）。`ksys_read` → `vfs_read`（`read_write.c:554`）经 `rw_verify_area` 做 LSM 安全检查（`security_file_permission`），调 `file->f_op->read_iter`（open 时从 `inode->i_fop` 装配的策略指针）。`generic_file_read_iter` → `filemap_read`（`filemap.c:2769`）查 page cache（xarray）；命中则 `copy_folio_to_iter` 拷贝到用户 buf；未命中触发 `page_cache_sync_ra` 预读，`ext4_mpage_readpages` 把逻辑块映射为物理块、构造 `bio` 提交给 block 层。`blk_mq_submit_bio`（`blk-mq.c:3124`）把 bio 转为 request、经调度器或直接派发到 `mq_ops->queue_rq`（驱动 DMA）。磁盘中断完成后 `blk_mq_complete_request` → `bio_endio` → `mpage_end_io` → `folio_end_read` 标记页 uptodate 并 `folio_wake_bit` 唤醒等待的 `filemap_read`，后者拷贝数据返回，返回值写入 `regs->ax`，`sysretq` 回用户态。数据载体沿链变换：`pt_regs` → `fd` → `file*`+`iov_iter` → `folio` → `bio` → `request` → DMA 命令。

#### 内存管理：缺页与分配

进程访问未映射地址触发缺页：`exc_page_fault`（`arch/x86/mm/fault.c:1483`）→ `handle_mm_fault`（`memory.c:6699`）4 级页表遍历（pgd→p4d→pud→pmd→pte）。`handle_pte_fault`（`:6383`）按 PTE 状态分发：PTE 不存在则匿名页走 `do_anonymous_page`（零页优化或分配新 folio）、文件页走 `do_fault` → `filemap_fault`；PTE 存在但只读且写入则 `do_wp_page` COW（`wp_can_reuse_anon_folio` 独占页直接复用，否则 `wp_page_copy` 复制，TLB flush 顺序保证安全）。物理页分配走 buddy：`__alloc_pages` fast path（`get_page_from_freelist` 查 zone watermark）失败则 slowpath（唤醒 kswapd → 直接回收 → compaction → OOM）。

#### 网络收包：NAPI 路径

网卡硬中断 → 驱动 `napi_schedule` → `____napi_schedule` 挂 poll_list + raise `NET_RX_SOFTIRQ` → `net_rx_action`（`dev.c:7914`，budget=300 + time_limit=2 jiffies）→ `napi_poll` 调驱动 `poll` 函数 → `netif_receive_skb` → `__netif_receive_skb_core` 按 `skb->protocol` 查 `ptype_base` 哈希分派 → `ip_rcv` → `tcp_v4_rcv` → 放入 `sock->sk_receive_queue` 唤醒等待进程。NAPI 的中断+轮询混合在高负载时避免中断风暴。

## 典型修改场景

#### 场景 1：新增一个系统调用

需修改 `arch/x86/entry/syscalls/syscall_64.tbl`（加一行 `nr common name sys_xxx`）+ 在 `fs/`/`kernel/` 等对应子系统用 `SYSCALL_DEFINEn` 宏定义实现。`x64_sys_call` 的 switch-case 由 `syscalls_64.h` 自动生成，无需手改分发逻辑。

#### 场景 2：新增一个文件系统

实现 `super_operations`/`inode_operations`/`file_operations`/`address_space_operations` 四组 ops，用 `register_filesystem` 注册 `file_system_type`，提供 `init_fs_context` + `fill_super`。对应测试：`fstests` 套件。

#### 场景 3：新增一个 LSM 安全模块

用 `DEFINE_LSM` 声明 `lsm_info`，用 `LSM_HOOK_INIT` 填充 `security_hook_list` 数组，在 `init` 回调中调 `security_add_hooks`。非 exclusive 模块（无 `LSM_FLAG_EXCLUSIVE`）可与 SELinux 叠加。对应测试：`security/*/tests/`。

## 测试体系

Linux kernel 的测试分散在各子系统，无统一 `tests/` 目录：

```
tools/testing/           # kselftest 框架
├── selftests/           # 各子系统用户态测试（sched/mmount/net…）
└── kunit/               # 内核内单元测试框架（lib/ 下大量 test_*.c）

# 其他测试基础设施
kernel/bpf/runqslower/   # BPF 验证
lib/test_*.c             # KUnit 单元测试（rbtree/xarray/klist…）
fstests（外部仓库）       # 文件系统回归测试
```

| 代码层 | 测试类型 |
|--------|---------|
| `lib/` 数据结构 | KUnit 单元测试（`lib/test_*.c`） |
| 子系统行为 | kselftest（`tools/testing/selftests/`） |
| 文件系统 | fstests（外部） |
| 整体内核 | CI 多架构 boot 测试（kernelci.org） |

想理解某子系统，优先读对应 selftest——它是"可执行文档"。

## 阅读源码推荐路线

- **第一遍：理解启动与系统调用主流程**
  `init/main.c` 的 `start_kernel()` → `arch/x86/entry/entry_64.S` 的 `entry_SYSCALL_64` → `arch/x86/entry/syscall_64.c` 的 `do_syscall_64` → `fs/read_write.c` 的 `ksys_read`/`vfs_read`
- **第二遍：理解进程与调度核心**
  `kernel/fork.c` 的 `copy_process()`（看 2090-2280 的 copy_mm/copy_thread 序列）→ `kernel/sched/core.c` 的 `__schedule`/`context_switch`（5329）→ `kernel/sched/fair.c` 的 `pick_eevdf`（1136，EEVDF 核心）
- **第三遍：理解内存管理**
  `mm/page_alloc.c` 的 `__alloc_pages` → `mm/memory.c` 的 `handle_mm_fault`/`do_wp_page`（COW）→ `mm/slub.c` 的 `alloc_from_pcs`（sheaves）→ `mm/vmscan.c` 的 `shrink_folio_list`
- **第四遍：理解 VFS 与块 I/O 协作**
  `fs/namei.c` 的 `link_path_walk`（路径解析）→ `fs/open.c` 的 `do_dentry_open`（f_op 装配）→ `mm/filemap.c` 的 `filemap_read`（page cache）→ `block/blk-mq.c` 的 `blk_mq_submit_bio`
- **第五遍：选择重点子系统深入阅读**（模块文档：[网络栈](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/06-network-stack)、[io_uring](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/08-io-uring)、[LSM 安全](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/10-security-lsm)）

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| EEVDF | Earliest Eligible Virtual Deadline First，v7.1 取代 CFS 的调度算法 |
| COW | Copy-On-Write，写时复制 |
| LSM | Linux Security Module，可插拔安全框架 |
| NAPI | New API，中断+轮询混合的网络收包机制 |
| blk-mq | Block Multi-Queue，多队列块 I/O 框架 |
| VFS | Virtual File System，虚拟文件系统抽象层 |
| TLB | Translation Lookaside Buffer，页表缓存 |
| KPTI | Kernel Page Table Isolation，防 Meltdown 的页表隔离 |
| SQPOLL | io_uring 的内核轮询线程模式 |

### 参考资料

- [Linux kernel.org 官方文档](https://www.kernel.org/doc/html/latest/)
- [Documentation/process/development-process.rst](https://www.kernel.org/doc/html/latest/process/development-process.html)
- [kernel-hacking guide](https://www.kernel.org/doc/html/latest/kernel-hacking/hacking.html)
- 仓库：[torvalds/linux](https://github.com/torvalds/linux)，本文基于 `v7.1` tag
