---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "安全框架 LSM"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "LSM", "安全", "SELinux", "Landlock", "static call"]
description: "Linux Security Module 框架——v7.1 从 hlist 迁移到 static call、可叠加 LSM、责任链 call_int_hook、机制与策略分离。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

## 模块定位

`security/` 是 Linux 内核的安全子系统层，但它的定位与大多数子系统不同——它不管理任何硬件资源，也不对应任何系统调用族。它是一层**横切（cross-cutting）关注点**，以 hook 机制将安全检查注入到几乎所有其他子系统的关键路径中：VFS 的 `inode_permission`、网络的 `socket_create`、进程的 `ptrace_access_check`、凭证的 `cred_prepare`、内存的 `mmap_file`……`security/security.c` 中有 200+ 个 `security_*` 包装函数，覆盖从 binder 到 BPF 的全内核关键路径。

LSM 的核心设计哲学是**机制与策略分离**：

- **机制**由框架提供——hook 注册、hook 调用、责任链短路、blob 共享内存管理。框架本身不定义任何安全策略。
- **策略**由各安全模块实现——SELinux 的类型强制、AppArmor 的路径 profile、Landlock 的用户规则，这些安全模型截然不同、无法统一表达，LSM 让它们都能以同一套 hook 接口接入内核。

这种分离的历史根源在于：内核社区有多个竞争性安全项目（SELinux、AppArmor、SMACK、Tomoyo 等），LSM 的出现不是为了选择某一个，而是提供一个中立的接入框架，让它们都能与内核协作。

## 模块架构

### v7.1 架构变化：从 hlist 到 static call

> **KEY FINDING**：v7.1 对 LSM hook 机制做了根本性重构，从链表遍历迁移到 static call + static_branch，消除了 Spectre v2 侧信道风险并大幅提升性能。

**旧方案（hlist 链表）**：`security_hook_heads` 包含若干 `hlist_head`，每个 hook 点对应一个链表头。模块通过 `hlist_add_head` 将自己的回调挂到链表上，运行时用 `hlist_for_each_entry` 遍历。这是一个**间接分支**——CPU 无法在编译期预测跳转目标，既存在 Spectre v2 侧信道风险，也因分支预测失败导致性能损耗。

**新方案（static call + static_branch）**：每个 hook 点预分配 `MAX_LSM_COUNT` 个 static call slot，存放在 `lsm_static_calls_table` 中。模块注册时填充自己的 slot（`__static_call_update`），运行时 `static_call()` 直接跳转到目标地址——这是一个**直接调用**，CPU 分支预测器可以精确预测。对于未使用的空 slot，`static_branch_unlikely` 在运行时跳过，零开销。整个遍历过程在编译期由 `LSM_LOOP_UNROLL` 宏展开，无循环开销。

### Hook 机制组件

| 组件 | 位置 | 作用 |
|------|------|------|
| `lsm_hook_defs.h` | X-macro 定义 | 每行 `LSM_HOOK(RET, DEFAULT, NAME, args)` 声明一个 hook 点 |
| `union security_list_options` | `lsm_hooks.h:38-43` | X-macro 展开为函数指针成员的联合体 |
| `lsm_static_calls_table` | `lsm_hooks.h:67-72` | 每 hook 点 `MAX_LSM_COUNT` 个 `lsm_static_call` slot |
| `security_hook_list` | `lsm_hooks.h:95-99` | `scalls`(指向 slot) / `hook`(回调) / `lsmid` |
| `MAX_LSM_COUNT` | `lsm_count.h:112-127` | 编译期统计 `CONFIG_SECURITY_*` 数量（最多约 14） |

### 可叠加 LSM

框架支持多个安全模块同时激活。每个 hook 点有 `MAX_LSM_COUNT` 个 slot，每个模块占一个。`call_int_hook` 责任链遍历所有 active slot，`call_void_hook` 广播到所有 active slot。互斥由 `LSM_FLAG_EXCLUSIVE` 控制——SELinux/AppArmor/SMACK 标记为 exclusive，三者只能选其一，但它们可以与非 exclusive 模块（Landlock/Yama/BPF LSM）叠加。

## 调用链路

### 模块注册链

```
DEFINE_LSM(selinux)                          // 编译期: lsm_info 放入 .lsm_info.init section
  → lsm_info.init = selinux_init            // lsm_hooks.h:187-190
      → security_add_hooks(selinux_hooks, ...) // lsm_init.c:369-380
          → lsm_static_call_init(hook, lsmid)  // lsm_init.c:341-359
              → __static_call_update(slot, callback)  // 填充 slot
              → static_branch_enable(slot->branch)     // 激活 branch
```

启动流程由 `security_init`（`lsm_init.c:407-494`）驱动：

1. 解析 LSM 顺序——`lsm=` 启动参数优先，否则用 `CONFIG_LSM` 编译默认值
2. `lsm_prepare`（`:285-319`）计算 `lsm_blob_sizes`，为各模块在共享 blob 中分配独立区域
3. 创建 `kmem_cache`（file/inode/backing_file），分配 cred/task blob
4. `lsm_init_single` 依次初始化每个非 early LSM

早期 LSM（如 lockdown）由 `early_security_init`（`lsm_init.c:385-400`）在更早阶段初始化，使用 `DEFINE_EARLY_LSM` 放入 `.early_lsm_info.init` section。

### Hook 调用链

以 `security_inode_permission`（`security.c:1838`）为例：

```
fs/namei.c:656  security_inode_permission()       // VFS 调用点
  → call_int_hook(inode_permission, 0, ...)        // security.c:488-496
      → LSM_LOOP_UNROLL 展开 MAX_LSM_COUNT 个 __CALL_STATIC_INT
          → static_branch_unlikely(&slot->branch)  // 检查 slot 是否 active
          → static_call(slot->call)(args)          // 直接调用模块回调
          → if (rc != default) goto OUT            // 责任链短路
```

<details>
<summary>方法速查表</summary>

| 包装函数 | 位置 | 作用 |
|----------|------|------|
| `security_inode_permission` | `security.c:1838` | inode 访问权限检查 |
| `security_file_open` | `security.c:2737` | 文件打开检查 |
| `security_task_kill` | `security.c:3297` | 进程信号发送检查 |
| `security_mmap_file` | `security.c` | 内存映射检查 |
| `security_socket_create` | `security.c` | socket 创建检查 |
| `security_ptrace_access_check` | `security.c` | ptrace 访问检查 |
| `security_prepare_creds` | `security.c` | 凭证准备检查 |
| `call_void_hook` | `security.c:473-476` | 广播所有 active slot |
| `call_int_hook` | `security.c:488-496` | 责任链短路 |
| `lsm_for_each_hook` | `security.c:498-501` | 手动遍历，聚合场景 |

</details>

## 核心实现

### v7.1 static call 架构

旧 hlist 方案的根本问题是**间接分支**。`hlist_for_each_entry` 通过指针遍历链表，CPU 无法在编译期确定跳转目标，间接分支（indirect call）正是 Spectre v2 攻击的目标。此外，链表遍历的循环开销和 cache miss 也影响性能。

v7.1 的新架构通过三个层次解决：

**1. static call 直接跳转**：`lsm_static_calls_table` 为每个 hook 点预分配 `MAX_LSM_COUNT` 个 `lsm_static_call` slot。模块注册时 `lsm_static_call_init`（`lsm_init.c:341-359`）找到第一个空 slot，用 `__static_call_update` 填入回调地址。运行时 `static_call()` 编译为一条直接 `call` 指令——CPU 分支预测器可以精确预测，无 Spectre 风险。

**2. static_branch_unlikely 空 slot 零开销**：每个 slot 关联一个 `static_key`。未使用的 slot 的 branch 默认关闭，`static_branch_unlikely` 编译为一条 `nop`（x86）或跳过指令。只有当 slot 被填充后 `static_branch_enable` 才将其激活。这意味着如果系统只启用 2 个 LSM，剩余的 `MAX_LSM_COUNT - 2` 个 slot 在运行时完全无开销。

**3. LSM_LOOP_UNROLL 编译期展开**：`call_void_hook` 和 `call_int_hook` 不是循环，而是宏展开。`LSM_LOOP_UNROLL` 在编译期生成 `MAX_LSM_COUNT` 个 `__CALL_STATIC_VOID` / `__CALL_STATIC_INT` 实例，每个实例检查一个 slot。无循环、无跳转表、无间接调用。

```c title="include/linux/lsm_hooks.h (概念)"
/* 每 hook 点 MAX_LSM_COUNT 个 slot */
struct lsm_static_calls_table {
    #define LSM_HOOK(RET, DEFAULT, NAME, ...) \
        lsm_static_call NAME[MAX_LSM_COUNT];
    #include <linux/lsm_hook_defs.h>
    #undef LSM_HOOK
};
```

`MAX_LSM_COUNT` 由 `lsm_count.h:112-127` 在编译期统计所有 `CONFIG_SECURITY_*` 选项的数量得出，典型配置下约 14。slot 耗尽会触发 `panic`（`lsm_static_call_init` 中检查）。

### Hook 调用宏

三个宏覆盖了所有调用场景：

**`call_void_hook`**（`security.c:473-476`）——**广播语义**。展开所有 `MAX_LSM_COUNT` 个 slot，每个 active slot 都被调用，无返回值检查。用于无决策意义的 hook（如 `inode_free_security`、`file_free_security`），所有模块都需要执行清理。

```c title="security/security.c:473-476 (概念)"
#define __CALL_STATIC_VOID(NUM, H, ...)                  \
    do {                                                 \
        if (static_branch_unlikely(&H.scalls[NUM].active)) \
            static_call(H.scalls[NUM].call)(__VA_ARGS__); \
    } while (0);

#define call_void_hook(HOOK, ...)                        \
    do {                                                 \
        LSM_LOOP_UNROLL(__CALL_STATIC_VOID, HOOK, __VA_ARGS__); \
    } while (0)
```

**`call_int_hook`**（`security.c:488-496`）——**责任链短路语义**。`__CALL_STATIC_INT`（`:479-486`）调用每个 active slot，若返回值不等于默认值则 `goto OUT` 短路退出。第一个"有意见"的模块决定最终结果——"任一拒绝则拒绝"。

```c title="security/security.c:488-496 (概念)"
#define __CALL_STATIC_INT(NUM, H, RET, DEFAULT, ...)      \
    do {                                                  \
        if (static_branch_unlikely(&H.scalls[NUM].active)) { \
            RET = static_call(H.scalls[NUM].call)(__VA_ARGS__); \
            if (RET != DEFAULT) goto OUT;                 \
        }                                                 \
    } while (0);

#define call_int_hook(HOOK, DEFAULT, ...)                 \
    ({                                                    \
        int RC = DEFAULT;                                 \
        do {                                              \
            LSM_LOOP_UNROLL(__CALL_STATIC_INT, HOOK, RC, DEFAULT, __VA_ARGS__); \
        } while (0);                                      \
    OUT:                                                  \
        RC;                                               \
    })
```

**`lsm_for_each_hook`**（`:498-501`）——**手动遍历语义**。用于需要聚合多个模块结果的场景，如 `security_vm_enough_memory_mm`（`:747`）需要累加所有模块的内存承诺判断。

### Hook 点清单

Hook 点定义集中在 `lsm_hook_defs.h`，使用 X-macro 技巧——每行 `LSM_HOOK(RET, DEFAULT, NAME, args)` 在不同的 `#include` 上下文中展开为不同内容（函数指针成员、static call slot、包装函数等）。以下是按子系统分类的 hook 点：

| 分类 | 代表 hook 点 | 说明 |
|------|-------------|------|
| **Binder** | `binder_set_context_mgr` / `binder_transaction` / `binder_transfer_file` | Android IPC 安全 |
| **Ptrace** | `ptrace_access_check` / `ptrace_traceme` | 进程调试附加 |
| **Capabilities** | `capget` / `capset` / `capable` | POSIX 权限基础 |
| **Superblock** | `sb_alloc_security` / `sb_mount` / `sb_statfs` / `sb_pivotroot` / `sb_umount` | 文件系统挂载 |
| **Path** (`CONFIG_SECURITY_PATH`) | `path_mknod` / `path_mkdir` / `path_unlink` / `path_truncate` / `path_chmod` | 路径操作 |
| **Inode** | `inode_alloc_security` / `inode_create` / `inode_permission` / `inode_setattr` / `inode_setxattr` / `inode_getsecurity` | inode 级别 |
| **File** | `file_permission` / `file_alloc_security` / `file_open` / `file_ioctl` / `file_lock` / `file_fcntl` | 文件操作 |
| **Task** | `task_alloc` / `task_free` / `task_kill` / `task_setpgid` / `task_setscheduler` | 进程管理 |
| **Cred** | `cred_alloc_blank` / `cred_free` / `cred_prepare` / `cred_transfer` / `cred_getsecid` | 凭证管理 |
| **IPC** | `ipc_permission` / `msg_queue_msgsnd` / `shm_shmat` / `sem_semop` | System V IPC |
| **Socket** (`CONFIG_SECURITY_NETWORK`) | `socket_create` / `socket_bind` / `socket_connect` / `socket_listen` / `socket_accept` / `socket_sendmsg` / `socket_recvmsg` | 网络套接字 |
| **Network** | `unix_stream_connect` / `unix_may_send` / `sk_alloc_security` / `inet_conn_request` | 底层网络 |
| **XFRM** | `xfrm_policy_alloc_security` / `xfrm_state_alloc` | IPsec |
| **Keys** | `key_alloc` / `key_permission` | 密钥管理 |
| **BPF** | `bpf` / `bpf_map` / `bpf_prog` / `bpf_map_create` / `bpf_prog_load` | BPF 安全 |
| **Perf** | `perf_event_open` / `perf_event_alloc` | 性能监控 |
| **IO_URING** | `uring_override_creds` / `uring_sqpoll` / `uring_cmd` / `uring_allowed` | io_uring |
| **Block Device** | `bdev_alloc_security` / `bdev_setintegrity` | 块设备 |
| **Lockdown** | `locked_down` | 内核锁定 |
| **Audit** | `audit_rule_init` / `audit_rule_match` | 审计规则 |

### 安全模块注册与叠加

**注册机制**：`DEFINE_LSM(lsm)` 宏（`lsm_hooks.h:187-190`）将 `lsm_info` 结构放入 `.lsm_info.init` section。`security_init` 遍历该 section，依次调用每个模块的 `init` 函数。模块在 init 中调用 `security_add_hooks`（`lsm_init.c:369-380`）注册自己的 hook 数组。

```c title="include/linux/lsm_hooks.h:137-141"
#define LSMHOOK_INIT(NAME, HOOK) {        \
    .scalls = static_calls_table.NAME,    \
    .hook  = { .NAME = HOOK },           \
}
```

`LSMHOOK_INIT` 将 `security_hook_list` 的 `scalls` 指向 `lsm_static_calls_table` 中对应 hook 点的 slot 数组，`hook` 填入回调函数指针。`security_add_hooks` 遍历数组，对每个 hook 调用 `lsm_static_call_init` 填充 slot。

**互斥与叠加**：

- `LSM_FLAG_EXCLUSIVE`（`lsm_hooks.h:147`）标记的模块互斥。SELinux、AppArmor、SMACK 都带此标志，只能选其一。
- 非 exclusive 模块可自由叠加。Landlock、Yama、BPF LSM、LoadPin 等无此标志。
- `lsm_order_append`（`lsm_init.c:153-191`）在解析顺序时检查 exclusive（`:173-184`），若已有 exclusive 模块则拒绝再添加。

**Blob 共享**：`lsm_blob_sizes`（`lsm_hooks.h:104-123`）累加各模块对 inode/file/task/cred 等安全数据的需求，计算总尺寸和每模块偏移。`lsm_prepare`（`:285-319`）为每模块在共享 blob 中分配独立区域。例如 inode 的 `i_security` 指针指向的 blob 中，SELinux 的数据在偏移 0，Landlock 的数据在偏移 N，各模块通过 `lsm_blob_sizes` 记录的偏移访问自己的区域。

### LSM 顺序与具体模块

**顺序控制**：

- `lsm=` 启动参数（`lsm_init.c:78-83`）优先；`security=` 旧版单选参数（`:67-72`）；`CONFIG_LSM`（`:25`）编译默认值。
- `enum lsm_order`（`lsm_hooks.h:149-153`）：`LSM_ORDER_FIRST`（-1，仅 capabilities）、`LSM_ORDER_MUTABLE`（0，按 `lsm=` 排列）、`LSM_ORDER_LAST`（1，仅 IMA/EVM）。
- 最终顺序：capabilities 第一 → MUTABLE 按 `lsm=` → legacy major → IMA/EVM 最后。
- 原因：capabilities 是 POSIX 权限基础，其他 LSM 假设它先执行；IMA/EVM 完整性校验在访问决策之后做最后防线。

**initcall 分级**：7 个级别（`lsm_hooks.h:177-184`）——pure/early/core/subsys/fs/device/late，分散在不同启动阶段。

**具体安全模块概要**：

| 模块 | 功能 | flags | order |
|------|------|-------|-------|
| **Capabilities** (`commoncap.c`) | POSIX capabilities 基础层 | — | FIRST |
| **SELinux** | 类型强制 MAC，安全上下文标签 + 策略文件，AVC 缓存 | `LEGACY_MAJOR \| EXCLUSIVE` | MUTABLE |
| **AppArmor** | 路径 profile MAC | `LEGACY_MAJOR \| EXCLUSIVE` | MUTABLE |
| **SMACK** | 简短文本标签 MAC | `LEGACY_MAJOR \| EXCLUSIVE` | MUTABLE |
| **Tomoyo** | 路径 MAC，学习模式自动生成策略 | `LEGACY_MAJOR` | MUTABLE |
| **Landlock** | 非特权用户沙箱，普通进程创建规则限制自身（文件/网络） | 无 exclusive | MUTABLE |
| **Yama** | ptrace 限制 | 无 exclusive | MUTABLE |
| **LoadPin** | 限制内核模块/固件加载来源 | 无 exclusive | MUTABLE |
| **Lockdown** | 内核锁定（`/dev/mem`/kexec/hibernation） | — | early |
| **SafeSetID** | setuid/setgid 白名单 | 无 exclusive | MUTABLE |
| **BPF LSM** | BPF 程序实现安全策略，动态加载/卸载 | 无 exclusive | MUTABLE |
| **IMA** | 完整性度量 + 远程证明 | — | LAST |
| **EVM** | 扩展属性验证（HMAC/签名） | — | LAST |
| **IPE** | 基于文件来源（dm-verity）完整性策略 | — | MUTABLE |

SELinux 注册范例（`selinux/hooks.c`）：

```c title="security/selinux/hooks.c:7898"
DEFINE_LSM(selinux) = {
    .name = "selinux",
    .flags = LSM_FLAG_LEGACY_MAJOR | LSM_FLAG_EXCLUSIVE,
};
```

Landlock 注册范例（`landlock/setup.c`）——无 exclusive 标志，可叠加：

```c title="security/landlock/setup.c:77-81"
DEFINE_LSM(landlock) = {
    .name = "landlock",
    .init = landlock_init,
};
```

## 设计模式

### Hook / 观察者

`lsm_hook_defs.h` 定义 hook 点（观察目标），`security_*` 包装函数是触发器。各子系统调用 `security_inode_permission`（`security.c:1838`）、`security_file_open`（`:2737`）、`security_task_kill`（`:3297`）等包装函数时，不关心有多少个模块注册了该 hook、也不关心谁处理——框架负责广播。

### 策略（可插拔安全模块）

框架只提供机制——hook 注册、调用、短路、blob 管理。安全策略完全由各模块实现：SELinux 的类型强制、AppArmor 的路径匹配、Landlock 的用户规则，三者的安全模型截然不同。`DEFINE_LSM` 在编译期注册，`lsm=` 在运行时选择，实现可插拔。

### 责任链

`call_int_hook` 实现责任链语义——所有注册模块按 slot 顺序依次调用，第一个返回非默认值的模块短路退出。这意味着"任一拒绝则拒绝"，最严格的模块决定结果。对于需要聚合而非短路的场景（如累加内存承诺），使用 `lsm_for_each_hook` 手动遍历。

## 模块间交互

LSM hook 散布于几乎所有内核子系统，这是横切关注点架构的直接体现：

| 子系统 | 调用点 | hook |
|--------|--------|------|
| **fs (VFS)** | `fs/namei.c:656,693` | `security_inode_permission` |
| **fs (VFS)** | `fs/open.c:924` | `security_file_open` |
| **mm** | `mm/mmap.c:1143` | `security_mmap_file` |
| **net** | `net/socket.c:1459,1620` | `security_socket_create` |
| **kernel** | `kernel/ptrace.c:356` | `security_ptrace_access_check` |
| **kernel** | `kernel/cred.c:215,596` | `security_prepare_creds` |
| **init** | `init/main.c` → `security_init` (`lsm_init.c:407`) | 框架初始化 |

每个子系统只需调用 `security_*` 包装函数，完全不感知 LSM 框架内部实现。7 个 initcall 级别让不同 LSM 模块在不同启动阶段激活，适配各子系统初始化时序。

## 扩展方式

新增一个 LSM 模块的步骤：

**1. 定义 hook 回调函数**：

```c
static int my_lsm_inode_permission(struct inode *inode, int mask)
{
    /* 实现安全策略 */
    return 0;
}
```

**2. 构建 hook 数组**：

```c title="security/my_lsm/hooks.c"
static struct security_hook_list my_lsm_hooks[] __ro_after_init = {
    LSMHOOK_INIT(inode_permission, my_lsm_inode_permission),
    LSMHOOK_INIT(file_open,        my_lsm_file_open),
};
```

**3. 定义 init 函数和 LSM 模块**：

```c title="security/my_lsm/hooks.c"
static int __init my_lsm_init(void)
{
    security_add_hooks(my_lsm_hooks, ARRAY_SIZE(my_lsm_hooks), "my_lsm");
    return 0;
}

DEFINE_LSM(my_lsm) = {
    .name = "my_lsm",
    .init = my_lsm_init,
    /* 若不设 LSM_FLAG_EXCLUSIVE，则可与其他非 exclusive 模块叠加 */
};
```

**4. 配置 `Kconfig` 和 `Makefile`**：添加 `CONFIG_SECURITY_MY_LSM`，在 `lsm_count.h` 中被统计入 `MAX_LSM_COUNT`。

非 exclusive 模块可直接叠加到现有安全栈（如 SELinux + Landlock + 新模块），无需修改其他模块代码。`lsm_blob_sizes` 自动为新模块分配 blob 区域，`call_int_hook` 责任链自动将新模块纳入调用链。这正是 LSM 框架"机制与策略分离"设计带来的扩展性。
