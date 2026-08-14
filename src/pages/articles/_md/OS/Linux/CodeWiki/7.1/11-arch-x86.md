---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "架构层与系统入口"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "x86", "系统调用", "页表", "中断", "汇编"]
description: "Linux arch/x86 架构层——启动汇编 startup_64、syscall 入口 entry_SYSCALL_64、do_syscall_64 switch-case 分发、中断异常、页表初始化。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

`arch/x86/` 是 Linux 内核中与 x86-64 硬件直接对话的架构适配层。内核核心代码（`init/`、`kernel/`、`mm/`）在设计上是架构无关的——它定义了"做什么"的策略接口，而 `arch/x86/` 提供了"在 x86 上怎么做"的具体实现。这种分层使得同一个内核核心可以运行在 x86、ARM、RISC-V、LoongArch 等多种架构上，只需替换 `arch/` 目录下的实现即可。

arch 层之所以必须独立存在，原因在于三类无法跨架构复用的代码：

- **硬件指令差异**：页表加载 `load_cr3`、上下文切换 `__switch_to`、系统调用指令 `syscall`/`sysret`、MSR 读写——这些指令是 x86 独有的，无法用 C 语言抽象掩盖。
- **CPU 初始化序列**：从 `startup_64` 汇编入口到 `identify_cpu` 的 CPUID 检测，每一步都紧密绑定 x86 的 CR0/CR3/CR4/EFER 寄存器和 GDT/IDT 数据结构。
- **内存模型差异**：x86-64 的 4 级/5 级页表结构（PGD→PUD→PMD→PTE）、物理地址扩展（PAE）、TLB 刷新方式，都与其他架构不同。

arch 层是整个内核的最底层依赖——向上提供系统调用入口、中断异常入口、页表操作、上下文切换、CPU 检测等基础能力，向下直接操作 MSR/CR0/CR3/CR4/CPUID/APIC 等硬件寄存器。

## 模块架构

`arch/x86/` 内部按职责划分为五大组件。它们并非平行关系，而是按执行时序构成从底层硬件初始化到上层入口分发的层次结构。arch 层本质上是策略模式（Strategy Pattern）的具体实现——内核核心通过函数指针多态调用各架构提供的实现，`arch/x86/` 就是 x86 架构填入这些函数指针的具体代码。

```
┌──────────────────────────────────────────────────────────────────┐
│                   arch/x86/ 模块内部结构                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① 启动汇编 (kernel/head_64.S, kernel/head64.c)                   │
│     startup_64 ── 早期栈/GDT/IDT/页表/CR3                         │
│     │   → common_startup_64 ── CR4/EFER/per-CPU                  │
│     │   → x86_64_start_kernel ── KASAN/microcode                 │
│     │   → start_kernel()  (交接到 init/ 通用流程)                  │
│     ▼                                                            │
│  ② 系统调用入口 (entry/entry_64.S)                                 │
│     entry_SYSCALL_64 ── swapgs/CR3切换/构造pt_regs               │
│     │   → do_syscall_64 ── 分发到具体 __x64_sys_xxx              │
│     │   → syscall_return_via_sysret  (快速路径)                   │
│     │   → swapgs_restore_regs_and_return_to_usermode  (慢路径)     │
│     ▼                                                            │
│  ③ 中断与异常 (kernel/traps.c, mm/fault.c)                        │
│     idtentry宏 ── 生成IDT入口stub                                │
│     │   → exc_divide_error / exc_general_protection /             │
│     │   → exc_page_fault → handle_page_fault                     │
│     ▼                                                            │
│  ④ 页表初始化 (kernel/setup.c, mm/init.c)                         │
│     setup_arch ── e820内存探测                                    │
│     │   → init_mem_mapping ── 建立直接映射                        │
│     │   → load_cr3(swapper_pg_dir) ── 切换到正式页表              │
│     ▼                                                            │
│  ⑤ CPU检测与拓扑 (cpu/common.c, cpu/topology_common.c)            │
│     identify_cpu ── CPUID vendor/model/features                   │
│     │   → cpu_parse_topology ── SMT/core/package                 │
│     │   → 厂商特定 c_init (Intel/AMD/Hygon)                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

组件①启动汇编是系统执行的第一个内核代码——BIOS/EFI 引导器将内核镜像加载到内存后，CPU 从 `startup_64` 开始执行，此时分页尚未开启，没有栈，没有 C 运行时环境。组件②系统调用入口是用户态与内核态之间的桥梁，`entry_SYSCALL_64` 是用户程序进入内核的 fastest path。组件③中断与异常处理外部硬件中断和 CPU 异常（缺页、除零、通用保护故障）。组件④页表初始化在启动早期建立虚拟内存映射。组件⑤CPU 检测通过 CPUID 指令识别处理器型号、特性和拓扑结构，为后续调度和内存管理提供依据。

五大组件之间是严格的串行依赖：启动汇编初始化 CPU 和早期页表后，才能执行 C 代码；CPU 检测在 `setup_arch` 中完成，为页表初始化提供处理器能力信息（如是否支持 1GB 大页、5 级页表）；页表初始化完成后，系统调用入口和中断异常入口才能在正确的虚拟地址空间中运行。

## 调用链路

arch 层有两条核心调用链：启动链从硬件上电到 `start_kernel`，系统调用链从用户态 `syscall` 指令到具体系统调用实现。

### 启动链

```
startup_64()              [arch/x86/kernel/head_64.S:59]
  │  输入: R15 = boot_params (bootloader 传递的启动参数)
  │  产出: 分页开启, __KERNEL_CS 加载, CR3 指向 early_top_pgt
  │  操作: 保存boot_params → 设早期栈 → 清零GSBASE
  │        → 加载GDT/IDT → lretq切__KERNEL_CS
  │        → SEV/SME加密 → verify_cpu → 页表修正
  │        → 加载CR3 → jmp common_startup_64
  │
  ▼
common_startup_64()       [arch/x86/kernel/head_64.S:198]
  │  输入: early_top_pgt 已加载, GDT/IDT 已设
  │  产出: CR4(PAE/LA57/PSE/PGE), EFER(SCE+NX), per-CPU偏移, 正式栈
  │  操作: CR4设置 → APIC ID检测per-CPU偏移
  │        → 设栈(current_task thread.sp) → 加载新GDT/IDT
  │        → 设EFER(SCE+NX) → CR0 → callq initial_code
  │
  ▼
x86_64_start_kernel()     [arch/x86/kernel/head64.c:222]
  │  输入: CR3/CR4/EFER 已配置, per-CPU 区已映射
  │  产出: init_top_pgt清零, KASAN早期init, 早期IDT, boot data拷贝
  │  操作: 清零init_top_pgt → KASAN早期init → 早期IDT
  │        → 拷boot data → microcode → 高端映射
  │
  ▼
start_kernel()            [init/main.c:1017]
  │  输入: 可用的 C 运行时环境 (栈/GDT/IDT/页表/CR3 就绪)
  │  产出: 交接到 init/ 通用初始化流程
  │  数据: void *boot_params (传递给 setup_arch)
```

### 系统调用链

```
用户态: syscall 指令 (RAX=调用号, RDI=arg0, ...)
  │  硬件自动: RIP→RCX, RFLAGS→R11, 从MSR加载CS/SS/RIP
  │
  ▼
entry_SYSCALL_64()        [arch/x86/entry/entry_64.S:87]
  │  输入: RAX=nr, RDI=arg0..R9=arg5, RCX=user RIP, R11=user RFLAGS
  │  产出: 内核栈上构造完整的 struct pt_regs
  │  数据: struct pt_regs *regs (内核栈顶)
  │  操作: swapgs → 存用户RSP到TSS.sp2
  │        → SWITCH_TO_KERNEL_CR3 (KPTI防Meltdown)
  │        → 加载内核栈 → push pt_regs
  │        → PUSH_AND_CLEAR_REGS (rax=-ENOSYS防越界)
  │        → IBRS_ENTER/CLEAR_BRANCH_HISTORY (推测防护)
  │        → call do_syscall_64
  │
  ▼
do_syscall_64()           [arch/x86/entry/syscall_64.c:87]
  │  输入: struct pt_regs *regs, unsigned long nr
  │  产出: regs->ax = 返回值
  │  操作: syscall_enter_from_user_mode (RCU/ptrace/seccomp/audit)
  │        → do_syscall_x64 (检查nr < NR_syscalls)
  │        → x64_sys_call (switch-case分发)
  │        → syscall_exit_to_user_mode
  │
  ▼
x64_sys_call()            [arch/x86/entry/syscall_64.c:63]
  │  输入: struct pt_regs *regs, unsigned int unr (符号扩展后的调用号)
  │  产出: 调用 __x64_sys_xxx(regs)
  │  操作: switch(unr) { case 0: return __x64_sys_read(regs); ... }
  │        → array_index_nospec (Spectre v1防护)
  │
  ▼
__x64_sys_read()          [由 syscall_64.tbl 自动生成的 stub]
  │  输入: const struct pt_regs *regs
  │  产出: 返回值存入 regs->ax
  │  操作: 提取参数 → 调用 ksys_read(fd, buf, count)
```

<details>
<summary>方法速查表</summary>

| 方法名 | 文件:行号 | 一行职责 | 关键设计决策 |
|--------|-----------|---------|-------------|
| `startup_64` | arch/x86/kernel/head_64.S:59 | 早期 CPU 初始化，开启分页 | identity 页表：启动初期 CPU 在物理地址执行，需虚拟=物理映射 |
| `common_startup_64` | arch/x86/kernel/head_64.S:198 | CR4/EFER/per-CPU/栈设置 | 设 EFER.SCE 启用 syscall 指令 |
| `x86_64_start_kernel` | arch/x86/kernel/head64.c:222 | C 运行时环境准备 | KASAN 早期 init 先于其他内存操作 |
| `entry_SYSCALL_64` | arch/x86/entry/entry_64.S:87 | 系统调用汇编入口 | swapgs+KPTI 双重隔离用户/内核地址空间 |
| `do_syscall_64` | arch/x86/entry/syscall_64.c:87 | 系统调用 C 层入口 | KEY: 在 syscall_64.c 不在 common.c |
| `do_syscall_x64` | arch/x86/entry/syscall_64.c:53 | 检查调用号范围 | nr < NR_syscalls 越界检查 |
| `x64_sys_call` | arch/x86/entry/syscall_64.c:63 | switch-case 分发系统调用 | 不用 sys_call_table[]，改 switch-case + array_index_nospec |
| `exc_page_fault` | arch/x86/mm/fault.c:1483 | 缺页异常处理 | 读 cr2 → handle_page_fault 分流内核/用户地址 |
| `exc_general_protection` | arch/x86/kernel/traps.c:914 | #GP 异常处理 | 用户态: ENQCMD/IOP/vDSO/UMIP 仿真 → SIGSEGV |
| `exc_divide_error` | arch/x86/kernel/traps.c:380 | 除零异常 | 发送 SIGFPE |
| `identify_cpu` | arch/x86/kernel/cpu/common.c:2004 | CPU 特性检测 | this_cpu 指针: Intel/AMD/Hygon 各独立 cpu_dev |
| `cpu_parse_topology` | arch/x86/kernel/cpu/topology_common.c:200 | CPU 拓扑检测 | CPUID 叶子 0xB/0x1F 检测 SMT/core/package |
| `setup_arch` | arch/x86/kernel/setup.c:884 | 架构特定初始化总入口 | e820 内存探测 → init_mem_mapping |
| `init_mem_mapping` | arch/x86/mm/init.c:758 | 建立直接映射并切换页表 | load_cr3(swapper_pg_dir) + __flush_tlb_all |
| `idtentry` | arch/x86/entry/entry_64.S:329 | 宏生成 IDT 异常入口 | push 假 error_code → error_entry → call cfunc |

</details>

## 核心实现

### 启动汇编 startup_64

`startup_64`（arch/x86/kernel/head_64.S:59）是内核在 x86-64 上的第一条指令入口。此时 CPU 处于保护模式或长模式初期，分页可能尚未开启或仅有 bootloader 建立的临时映射。这段汇编代码的任务是在没有 C 运行时环境（无栈、无全局变量可用）的情况下，逐步建立可执行 C 代码的最小环境。

执行序列分为以下步骤：

1. **保存 boot_params**：R15 寄存器在进入 `startup_64` 时由 bootloader 传递，指向 `boot_params` 结构体（包含内存映射、命令行参数等）。汇编代码将 R15 保存到安全位置，供后续 C 代码使用。

2. **设置早期栈**：在 BSS 段中预留一块区域作为早期栈（`initial_stack`），使后续可以执行 `call` 指令调用函数。

3. **清零 GSBASE**：GSBASE 在早期可能包含垃圾值，清零避免后续 `__read_msr` 等操作读到错误数据。

4. **加载 GDT/IDT**：调用 `__pi_startup_64_ipl_setup_gdt_idt` 加载早期 GDT（定义 `__KERNEL_CS`/`__KERNEL_DS` 段描述符）和早期 IDT。然后通过 `lretq` 指令从当前代码段切换到 `__KERNEL_CS`——这是从 bootloader 的段描述符过渡到内核自己的段描述符的关键步骤。

5. **SEV/SME 加密**：如果运行在 AMD SEV/SME 加密虚拟机中，需要在此阶段处理加密激活。

6. **verify_cpu**：检查 CPU 是否支持 x86-64 所需的长模式特性（如 SSE、SSE2）。如果不支持，CPU 停机。

7. **页表修正**：调用 `__pi___startup_64` 修正早期页表中的物理地址偏移。内核镜像可能被加载到非编译时预设的物理地址（如 KASLR 随机化加载地址），页表中的地址需要相应修正。

8. **加载 CR3**：将 `early_top_pgt` 的物理地址加载到 CR3，开启分页。`early_top_pgt` 包含 identity 映射（虚拟地址 = 物理地址）和内核镜像映射两部分。

```asm title="arch/x86/kernel/head_64.S (startup_64 简化)"
SYM_CODE_START_LOCAL(startup_64)
    /*
     * 保存 boot_params (R15), 设早期栈, 清零 GSBASE
     */
    leaq    (__end_init_task - SIZEOF_pt_regs)(%rip), %rsp
    ...

    /* 加载早期 GDT/IDT */
    call    __pi_startup_64_setup_gdt_idt

    /* 切换到 __KERNEL_CS */
    pushq   $__KERNEL_CS
    leaq    .Lon_kernel_cs(%rip), %rax
    pushq   %rax
    lretq

    /* SEV/SME 加密处理 */
    ...

    /* verify CPU 特性 */
    verify_cpu

    /* 修正页表地址 + 加载 CR3 */
    call    __pi___startup_64

    /* 跳转到 common_startup_64 */
    jmp     common_startup_64
SYM_CODE_END(startup_64)
```

**为什么需要 identity 页表**：head_64.S:31-34 的注释解释了这一设计。启动初期 CPU 在物理地址执行指令，当开启分页（加载 CR3）后，CPU 的取指地址从物理地址变为虚拟地址。如果此时没有 identity 映射（虚拟地址 = 物理地址），CPU 将无法取到下一条指令，导致系统立即崩溃。无法一步从物理地址执行切换到最终的内核虚拟地址空间——因为切换本身需要执行指令，而执行指令又需要分页后的地址映射有效。identity 页表就是这个过渡桥梁。

`common_startup_64`（head_64.S:198）在 `startup_64` 建立的分页基础上，配置 CR4（启用 PAE/LA57/PSE/PGE）、通过 APIC ID 检测 per-CPU 偏移、设置正式栈（`current_task` 的 `thread.sp`）、加载新的 GDT/IDT、设置 EFER 寄存器（启用 SCE 系统调用扩展和 NX 不可执行位），设置 CR0，最后 `callq initial_code`——`initial_code` 指向 `x86_64_start_kernel`。

`x86_64_start_kernel`（head64.c:222）是第一个 C 函数入口：清零 `init_top_pgt`、KASAN 早期 init、设置早期 IDT、拷贝 boot data、加载 microcode、建立高端内存映射，最终调用 `start_kernel`（head64.c:310），将控制权交给 `init/` 的通用初始化流程。

### 系统调用入口 entry_SYSCALL_64

`entry_SYSCALL_64`（arch/x86/entry/entry_64.S:87）是 x86-64 上所有系统调用的汇编入口。当用户态执行 `syscall` 指令时，CPU 硬件自动将 RIP 保存到 RCX、RFLAGS 保存到 R11，并从 MSR（`LSTAR`/`STAR`）加载 CS/SS/RIP，跳转到 `entry_SYSCALL_64`。整个过程不压栈、不改 RSP、不查 IDT——这是 `syscall` 比 `int 0x80` 快得多的根本原因。

入口代码的执行序列：

1. **swapgs**：将 GSBASE 从用户态的 TLS 基址切换到内核态的 per-CPU 数据基址。`swapgs` 是一条特权指令，交换 GSBASE 和 KernelGSbase（MSR `SWAP_GS`）的值。

2. **保存用户 RSP**：将用户态栈指针 RSP 存入 TSS 的 `sp2` 字段（`TSS.sp2`），这是每 CPU 的 `cpu_tss_rw` 结构体中的备用栈指针位置。

3. **SWITCH_TO_KERNEL_CR3**：加载内核 CR3（页表根）。这是 KPTI（Kernel Page Table Isolation）的核心——用户态进程的页表不映射内核地址空间，防止 Meltdown 侧信道攻击。每次系统调用/中断都需要切换 CR3。

4. **加载内核栈**：从 per-CPU 数据读取 `cpu_current_top_of_stack` 作为内核栈顶。

5. **构造 pt_regs**：在内核栈上 push 用户态上下文——`__USER_DS`、用户 RSP、R11（用户 RFLAGS）、`__USER_CS`、RCX（用户 RIP）、RAX（调用号），构成 `struct pt_regs` 的用户态部分。然后 `PUSH_AND_CLEAR_REGS` 保存所有通用寄存器，并将 RAX 设为 `-ENOSYS`——如果后续分发逻辑未修改 RAX，系统调用将返回 `-ENOSYS`（函数不存在），防止越界调用号返回垃圾数据。

6. **推测执行防护**：`IBRS_ENTER`（Indirect Branch Restricted Speculation）、`UNTRAIN_RET`、`CLEAR_BRANCH_HISTORY`——这些是针对 Spectre v2 / Retbleed 等推测执行攻击的缓解措施。

7. **调用 do_syscall_64**：RDI 设为 `&pt_regs`（内核栈上的寄存器快照），RSI 设为符号扩展后的调用号 `nr`。

```asm title="arch/x86/entry/entry_64.S (entry_SYSCALL_64 简化)"
SYM_INNER_LABEL(entry_SYSCALL_64, SYM_L_GLOBAL)
    swapgs                          /* GS: 用户→内核 per-CPU */

    /* 保存用户 RSP 到 TSS.sp2 */
    movq    %rsp, PER_CPU_VAR(cpu_tss_rw + TSS_sp2)

    /* KPTI: 切换到内核 CR3 */
    SWITCH_TO_KERNEL_CR3 scratch_reg=%rsp

    /* 加载内核栈 */
    movq    PER_CPU_VAR(pcpu_hot + X86_top_of_stack), %rsp

    /* 构造 pt_regs: 用户态上下文 */
    pushq   $__USER_DS              /* SS */
    pushq    PER_CPU_VAR(cpu_tss_rw + TSS_sp2)  /* RSP */
    pushq   %r11                    /* RFLAGS (硬件保存) */
    pushq   $__USER_CS              /* CS */
    pushq   %rcx                    /* RIP (硬件保存) */
    pushq   %rax                    /* 系统调用号 */

    /* 保存所有通用寄存器, RAX 设为 -ENOSYS */
    PUSH_AND_CLEAR_REGS rax=$-ENOSYS

    /* 推测执行防护 */
    IBRS_ENTER
    UNTRAIN_RET
    CLEAR_BRANCH_HISTORY

    /* RDI = &pt_regs, RSI = nr (符号扩展) */
    movq    %rsp, %rdi
    movl    %eax, %esi

    call    do_syscall_64
```

返回路径有两条：**快速路径** `syscall_return_via_sysret` 使用 `sysretq` 指令返回——硬件自动从 RCX 恢复 RIP、从 R11 恢复 RFLAGS，不需压栈/弹栈。**慢路径** `swapgs_restore_regs_and_return_to_usermode` 使用 `IRET` 指令返回——当 SYSRET 安全性检查不通过时（见下文），必须走 IRET。

**寄存器约定**（entry_64.S:68-78）：

| 寄存器 | 系统调用时用途 | 硬件/软件保存 |
|--------|-------------|-------------|
| RAX | 系统调用号 / 返回值 | 软件（push 到 pt_regs） |
| RCX | 用户 RIP | 硬件自动保存 |
| R11 | 用户 RFLAGS | 硬件自动保存 |
| RDI | arg0 | 软件（pt_regs） |
| RSI | arg1 | 软件（pt_regs） |
| RDX | arg2 | 软件（pt_regs） |
| R10 | arg3（非 RCX） | 软件（pt_regs） |
| R8 | arg4 | 软件（pt_regs） |
| R9 | arg5 | 软件（pt_regs） |

**为什么用 syscall 而非 int 0x80**：`syscall` 指令硬件自动保存 RIP→RCX、RFLAGS→R11，从 MSR 加载 CS/SS/RIP，不压栈、不改 RSP、避免 IDT 查找。`int 0x80` 需要查 IDT 表找到中断门、压栈 5 项（SS/RSP/RFLAGS/CS/RIP）、切换特权级。syscall 的延迟约 10-20 个时钟周期，int 0x80 约 50-100 个周期。EFER.SCE（系统调用扩展）在 `head_64.S:391` 的 `common_startup_64` 中通过设置 EFER 寄存器启用。

### 系统调用分发 do_syscall_64

**关键发现：`do_syscall_64` 定义在 `arch/x86/entry/syscall_64.c`，而非 `common.c`**。在 v7.1 中，x86-64 的系统调用分发逻辑从 `entry/common.c` 移到了 `syscall_64.c`，这是一个重要的代码组织变化。

`do_syscall_64`（arch/x86/entry/syscall_64.c:87）的执行流程：

```c title="arch/x86/entry/syscall_64.c:87 (简化)"
__visible noinstr void do_syscall_64(struct pt_regs *regs, int nr)
{
    nr = syscall_enter_from_user_mode(regs, nr);    // :89

    instrumentation_begin();

    if (!do_syscall_x64(regs, nr) && !do_syscall_x32(regs, nr) && nr != -1) {
        /* 未找到系统调用, 返回 -ENOSYS */
        regs->ax = __x64_sys_ni_syscall(regs);
    }

    instrumentation_end();
    syscall_exit_to_user_mode(regs);                // :100
}
```

`syscall_enter_from_user_mode`（entry-common.h:170）完成进入内核态的准备工作：RCU 进入、context tracking、ptrace/seccomp/audit 检查。seccomp 可以在此拦截或修改系统调用号，ptrace 可以修改参数。

**核心分发逻辑 `x64_sys_call`**（syscall_64.c:63）：

```c title="arch/x86/entry/syscall_64.c:35-63 (简化)"
/* sys_call_table[] 仅用于 tracing, 不用于分发 */
extern sys_call_ptr_t sys_call_ptr_t sys_call_table[];

static noinline bool __do_syscall_x64(struct pt_regs *regs, int nr)
{
    if (likely(nr < NR_syscalls)) {
        nr = array_index_nospec(nr, NR_syscalls);   // :62 Spectre v1 防护
        regs->ax = x64_sys_call(regs, nr);
        return true;
    }
    return false;
}

/* 由 __SYSCALL 宏展开为 switch-case */
long x64_sys_call(const struct pt_regs *regs, unsigned int nr)
{
    switch (nr) {
    case 0:  return __x64_sys_read(regs);
    case 1:  return __x64_sys_write(regs);
    case 9:  return __x64_sys_mmap(regs);
    ...
    case 60: return __x64_sys_exit(regs);
    ...
    }
    return __x64_sys_ni_syscall(regs);
}
```

**KEY：`sys_call_table[]` 不再用于分发改用 switch-case**。在 v7.1 中，`sys_call_table[]`（syscall_64.c:29）仅被 `trace_syscalls.c` 的 tracing 代码使用。实际系统调用分发由 `x64_sys_call()` 函数的 switch-case 实现，该函数由 `__SYSCALL(nr, sym)` 宏展开生成。这一改变的原因有两方面：

- **性能**：switch-case 允许编译器进行优化（如跳转表、分支预测提示），比通过函数指针表的间接调用更快。编译器可以根据调用号的统计分布优化分支顺序。
- **安全**：`array_index_nospec`（syscall_64.c:62）在调用号用作索引前进行 Spectre v1 防护——防止推测执行用越界调用号读取 `sys_call_table` 中的敏感函数指针。switch-case 本身也比间接函数指针表更难被推测攻击利用。

**系统调用表生成**：`arch/x86/entry/syscalls/syscall_64.tbl` 是系统调用号的权威定义文件，格式为 `<number> <abi> <name> <entry> [compat] [noreturn]`。`abi` 分为 `common`（64 位和 x32 共用）、`64`（仅 64 位）、`x32`（仅 x32 ABI）。代表号：0=read、1=write、9=mmap、56=clone、57=fork、60=exit（noreturn）、39=getpid。当前最大号 464（getxattrat）。`scripts/syscalltbl.sh` 生成 `syscalls_64.h`（用于 switch-case 展开），`scripts/syscallhdr.sh --emit-nr` 生成 `unistd_64.h`（含 `__NR_syscalls` 总数）。

**SYSRET 安全性检查**（syscall_64.c:112-137）：`sysretq` 指令比 `IRET` 快，但有严格的使用条件。返回前必须验证：RCX == 用户 RIP（syscall 时硬件保存的返回地址）、R11 == 用户 RFLAGS、CS/SS 匹配用户段、RIP < `TASK_SIZE_MAX`。最后一项防止 Intel SYSRET 的 non-canonical 地址 #GP bug——如果返回地址是非规范形式（canonical form）的地址，`sysretq` 会触发 #GP 而非返回用户态，内核会错误地以 ring 0 执行用户控制的 RIP。不满足任一条件时走 IRET 慢路径。Xen PV 始终走 IRET（不支持 SYSRET）。

### 中断与异常

中断与异常入口由 `idtentry` 宏（entry_64.S:329）生成。该宏为每个异常向量生成一个 IDT 入口 stub：push 假 error_code（如果该异常硬件不自动产生 error_code）→ `idtentry_body` → `error_entry`（切换到 task 栈 + 保存 pt_regs）→ `call cfunc`（C 处理函数）→ `error_return`。外部中断使用 `idtentry_irq` 宏（:376），额外 push vector 号并进行 cache 对齐。

**陷阱处理**（arch/x86/kernel/traps.c）：

- `exc_divide_error`（:380）：除零异常，向用户态发送 SIGFPE。
- `exc_overflow`（:386）：溢出陷阱，发送 SIGSEGV。
- `exc_general_protection`（:914）：#GP 通用保护故障。用户态触发时可能来自 ENQCMD 指令、I/O 端口访问（IOP）、vDSO 仿真、UMIP（User Mode Instruction Prevention）违规——内核会尝试修正这些情况，修正失败才发送 SIGSEGV。内核态触发时调用 `gp_try_fixup_and_notify` 尝试修复，失败则 `die_addr` 触发 panic 或 oops。
- `exc_double_fault`（:597）：双重错误，通常是栈溢出或递归异常导致，触发 panic。
- `exc_debug`（:1369）：调试陷阱（断点、单步），处理调试器交互。

`do_trap`（:335）是陷阱处理的通用框架：先尝试 `do_trap_no_signal`（vm86 修正、`fixup_exception` 异常表查找、vDSO 修正），失败则 `show_signal` + `force_sig_fault` 向用户态发送信号。

**缺页异常** `exc_page_fault`（arch/x86/mm/fault.c:1483）是最高频的异常入口：

```c title="arch/x86/mm/fault.c:1483 (简化)"
DEFINE_IDTENTRY_RAW_ERRORCODE(exc_page_fault)
{
    unsigned long address = read_cr2();     /* 缺页的虚拟地址 */

    irqentry_enter(regs);
    handle_page_fault(regs, error_code, address);
    irqentry_exit(regs);
}

static void handle_page_fault(struct pt_regs *regs, unsigned long error_code,
                              unsigned long address)
{
    if (unlikely(fault_in_kernel_space(address)))
        do_kern_addr_fault(regs, error_code, address);    /* 内核地址: vmalloc/fixup */
    else
        do_user_addr_fault(regs, error_code, address);    /* 用户地址: 缺页/COW/swap */
}
```

`do_user_addr_fault` 处理用户态缺页：查找 VMA → 权限检查 → 调用 `handle_mm_fault` 进行缺页调度（匿名页零填充、文件页读取、CoW 写时复制、swap 换入）。`do_kern_addr_fault` 处理内核态缺页：vmalloc 惰性映射、`fixup_exception` 异常表查找（如 `copy_from_user` 的合法缺页）。

**中断控制器**：APIC 相关代码在 `arch/x86/kernel/apic/`，`setup.c:984` 的 `apic_setup_apic_calls` 注册 APIC 驱动，`:1233` 的 `init_apic_mappings` 建立 APIC 内存映射，`:1053` 的 `check_x2apic` 检测 x2APIC 模式。

### 页表初始化与CPU检测

**页表初始化**从 `setup_arch`（arch/x86/kernel/setup.c:884）开始：

```c title="arch/x86/kernel/setup.c:884 (setup_arch 简化)"
void __init setup_arch(char **cmdline_p)
{
    ...
    e820__memory_setup();               // :963 BIOS/EFI 内存布局
    ...
    max_pfn = e820__get_max_pfn();      // :1034 最大物理页帧号
    mtrr_trim_uncached_memory();        // :1038 MTRR 修剪
    ...
    max_low_pfn = ...;                  // :1057 区分 4GB 上下
    ...
    init_mem_mapping();                 // :1126 建立直接映射
    ...
}
```

`e820__memory_setup`（:963）从 BIOS/EFI 获取物理内存布局（哪些地址范围是可用 RAM、哪些是 reserved）。`max_pfn`（:1034）计算最大物理页帧号，决定内核需要管理多少物理内存。`mtrr_trim_uncached_memory`（:1038）根据 MTRR（Memory Type Range Register）修剪不可缓存的内存区域。

`init_mem_mapping`（arch/x86/mm/init.c:758）建立物理内存到虚拟地址的直接映射（direct mapping，即 `__va(0)` 到 `__va(max_pfn*PAGE_SIZE)` 的线性映射区）：

```c title="arch/x86/mm/init.c:758 (init_mem_mapping 简化)"
void __init init_mem_mapping(void)
{
    probe_page_size_mask();             // 检测大页支持

    init_memory_mapping(0, ISA_END_ADDRESS);   // ISA 区域 (0-16MB) 用小页

    /* 建立直接映射: top-down 或 bottom_up */
    if (can_brute_force())
        memory_map_top_down(...);       // 从高地址向低地址映射
    else
        memory_map_bottom_up(...);      // 从低地址向高地址映射

    load_cr3(swapper_pg_dir);           // :807 切换到正式页表
    __flush_tlb_all();                  // :808 刷新所有 TLB

    cpu_init_replace_early_idt();       // :1133 替换早期 IDT
    pagetable_init();                   // :1203 x86_init.paging.pagetable_init
}
```

`load_cr3(swapper_pg_dir)`（:807）是关键的页表切换点——从启动早期的 `early_top_pgt`（含 identity 映射）切换到 `swapper_pg_dir`（正式的内核页表，只含内核映射不含 identity 映射）。切换后立即 `__flush_tlb_all` 刷新所有 TLB，确保陈旧的映射缓存不会导致错误。

**CPU 检测** `identify_cpu`（arch/x86/kernel/cpu/common.c:2004）在 `setup_arch` 的早期阶段执行：

```c title="arch/x86/kernel/cpu/common.c:2004 (identify_cpu 简化)"
static void identify_cpu(struct cpuinfo_x86 *c)
{
    /* 默认值 */
    c->x86_virt_bits = 48;
    ...

    generic_identify(c);                // CPUID: vendor/model/features
    cpu_parse_topology(c);              // :2032 SMT/core/package 拓扑

    /* 厂商特定初始化 */
    if (this_cpu->c_init)
        this_cpu->c_init(c);            // Intel/AMD/Hygon 各自的 c_init

    /* 安全特性 */
    setup_smep(c);                      // Supervisor Mode Execution Prevention
    setup_smap(c);                      // Supervisor Mode Access Prevention
    setup_umip(c);                      // User Mode Instruction Prevention

    filter_cpuid_features(c, ...);      // 过滤可疑特性

    /* 扩展特性 */
    x86_init_rdrand(c);
    setup_pku(c);                       // Protection Keys
    setup_cet(c);                       // Shadow Stack (CET)
}
```

`cpu_parse_topology`（topology_common.c:200）通过 CPUID 叶子 0xB（x86 拓扑枚举）或 0x1F（扩展拓扑枚举）检测 SMT 线程数、每包核心数、封装数，为调度器的 NUMA 感知和 load balancing 提供依据。

`this_cpu` 指针（common.c:2034）是厂商策略模式的实现——`struct cpu_dev` 包含 `c_identify` 和 `c_init` 函数指针，Intel、AMD、Hygon 各有独立的 `cpu_dev` 实现。`this_cpu` 在 `early_cpu_init`（setup.c:937）→ `early_identify_cpu` 中根据 CPUID vendor 字符串设置为对应厂商的 `cpu_dev`。SMP 系统中所有 CPU 的特性取交集存入 `boot_cpu_data`，确保只用所有 CPU 都支持的特性。

per-CPU 数据的访问通过 `__per_cpu_offset`（head_64.S:314 获取偏移）和 `current_task`（head_64.S:325 通过 `%rdx` 访问 GS base 偏移）实现，这是 `common_startup_64` 中 APIC ID 检测 per-CPU 偏移后建立的机制。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 策略（Strategy） | `setup_arch`/`copy_thread`/`switch_to` 函数指针多态 | 内核核心定义架构无关接口，`arch/x86/` 提供 x86 实现，支持多架构共存不改核心代码 |
| 策略（Strategy） | `struct x86_init_ops` (x86_init.h:174) | x86 内部进一步抽象平台差异：paging/irqs/timers/oem/pci/iommu/acpi/mpparse 函数指针 |
| 策略（Strategy） | `this_cpu` → `struct cpu_dev` (cpu/common.c:2034) | 厂商特定 CPU 初始化：Intel/AMD/Hygon 各独立 `cpu_dev`，运行时按 vendor 选择 |
| 安全防护 | `array_index_nospec` (syscall_64.c:62) | Spectre v1 防护：调用号作索引前插入屏障，防止推测执行越界读取 |

arch 层是策略模式在 Linux 内核中最典型的应用。内核核心通过 `setup_arch`、`copy_thread`、`switch_to` 等函数指针调用架构特定实现——`start_kernel` 调用 `setup_arch`（而非直接调用 x86 初始化函数），`fork.c` 调用 `copy_thread`（而非直接调用 x86 的 `copy_thread`），`sched/core.c` 调用 `switch_to` 宏（在 x86 上展开为 `__switch_to_asm`→`__switch_to`）。这种设计使得 ARM 或 RISC-V 只需实现自己的 `arch/` 目录，内核核心代码无需任何修改。

x86 内部通过 `struct x86_init_ops`（x86_init.h:174）进一步抽象平台差异—— paging/irqs/timers/oem/pci/iommu/acpi/mpparse 各有一组函数指针，不同 x86 平台（标准 PC、Xen Dom0、Hyper-V 等）可以覆盖特定操作。`this_cpu` 指针则是 CPU 厂商层面的策略模式——Intel/AMD/Hygon 各有独立的 `struct cpu_dev`，包含 `c_identify` 和 `c_init` 函数指针，运行时根据 CPUID vendor 字符串选择。

## 模块间交互

`arch/x86/` 是整个内核的最底层，几乎所有子系统都依赖它提供的基础能力。

```
arch/x86/ 向上提供的接口:
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │  init/      start_kernel ← x86_64_start_kernel          │
  │             setup_arch() ← start_kernel 调用             │
  │                                                         │
  │  kernel/    copy_thread() ← fork.c:2273 调用             │
  │             switch_to ← sched/core.c:5388 调用           │
  │             __switch_to_asm → __switch_to                │
  │                                                         │
  │  mm/        exc_page_fault ← 缺页异常入口                │
  │             load_cr3 / __flush_tlb_all ← 页表操作        │
  │             swapper_pg_dir ← 内核页表                    │
  │                                                         │
  │  所有用户态  entry_SYSCALL_64 ← syscall 指令入口         │
  │             do_syscall_64 → __x64_sys_xxx ← 系统调用分发 │
  │                                                         │
  │  中断       APIC ← 硬件中断控制器                        │
  │             idtentry ← IDT 异常入口                      │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
            │
            ▼  向下直接操作
  ┌─────────────────────────────────────────────────────────┐
  │  硬件寄存器: CR0/CR3/CR4/EFER/MSR/CPUID/APIC            │
  └─────────────────────────────────────────────────────────┘
```

交互方式以函数调用为主——`init/` 调用 `setup_arch`、`kernel/` 调用 `copy_thread`/`switch_to`、`mm/` 使用页表操作和 TLB 刷新接口。系统调用入口和中断异常入口是特殊的交互点：它们不是被其他子系统主动调用，而是由 CPU 硬件在特定事件（`syscall` 指令、中断、异常）触发时自动跳转。进程上下文切换是另一类特殊交互——`switch_to` 宏通过内联汇编直接操作寄存器（保存 RBP/RBX/R12-R15、切换 `thread.sp`），在两个进程的内核栈之间切换，这一操作必须在 arch 层完成因为它直接操作 CPU 栈指针。

## 扩展方式

**支持新架构**：要将 Linux 内核移植到新的 CPU 架构，需要在 `arch/` 下创建新目录（如 `arch/riscv/`），并实现以下核心接口集：

1. **启动汇编**：实现 `head.S`（或等价文件），从 bootloader 接管控制权，建立早期分页和栈，跳转到 C 入口。对应 x86 的 `startup_64` → `start_kernel`。

2. **系统调用入口**：实现架构特定的系统调用入口（使用该架构的 fast syscall 机制，如 ARM 的 `svc`、RISC-V 的 `ecall`），构造 `struct pt_regs`，调用 `do_syscall_64` 的等价函数。生成 `syscalls_xxx.h` 和 `unistd_xxx.h`。

3. **中断与异常**：实现 IDT/IVT 入口生成机制（类似 `idtentry` 宏），为每种异常实现 `exc_xxx` 处理函数，至少包括缺页异常和通用保护故障。

4. **页表操作**：实现 `pgd/pud/pmd/pte` 的分配/释放/映射函数，`load_cr3` 的等价（如 ARM 的 `TTBR` 写入），TLB 刷新函数。实现 `swapper_pg_dir` 的初始化。

5. **CPU 检测**：实现 `identify_cpu` 的等价，通过该架构的 CPU 特性寄存器检测处理器能力。

6. **上下文切换**：实现 `switch_to` 宏和 `__switch_to` 函数，保存/恢复 callee-saved 寄存器，切换内核栈指针。

7. **平台抽象**：实现 `x86_init_ops` 的等价结构体（如 `riscv_init_ops`），填充 paging/irqs/timers 等函数指针。

此外还需实现 `copy_thread`（进程创建时的上下文初始化）、`elf_hwcap`（能力位供用户态查询）、DMA 操作函数、原子操作原语（使用该架构的原子指令）等。内核核心代码无需修改——这正是策略模式架构设计的价值。
