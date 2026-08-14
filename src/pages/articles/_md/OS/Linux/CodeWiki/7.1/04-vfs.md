---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "虚拟文件系统"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "VFS", "文件系统", "inode", "dentry"]
description: "Linux VFS 四对象抽象（super_block/inode/dentry/file）——ops 策略模式、path resolution、page cache、mount namespace。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

## 模块定位

VFS（Virtual File System）是 Linux 内核"一切皆文件"抽象的根基。它不是一种具体的文件系统，而是一层**统一的接口框架**——向上为系统调用层提供 `open/read/write/close/stat` 等标准 API，向下通过 ops vtable 分派到 ext4、XFS、Btrfs、tmpfs 等具体文件系统的实现函数。

没有 VFS，每个文件系统都要自己实现完整的系统调用接口；有了 VFS，一个 `cp` 命令可以在 ext4 和 NFS 之间无差别地复制文件，因为上层看到的是统一的 `file` 对象和 `file_operations` 接口，底层差异被 ops 策略模式完全封装。

VFS 独立存在的意义在于**解耦**：用户态 API 稳定不变，文件系统实现可自由演化。新文件系统只需实现四组 ops 并 `register_filesystem`，即可被整个内核生态复用。

## 模块架构

VFS 的核心是**四大对象 + 五组 ops vtable**。四大对象各自承担不同生命周期与关注点，ops 则是每类对象的行为策略接口（虚函数表）。

### 四大对象

| 对象 | 定义位置 | 生命周期 | 核心职责 |
|---|---|---|---|
| `super_block` | `include/linux/fs/super_types.h:132` | mount→umount | 文件系统实例：管理设备、类型、s_op、根 dentry、per-sb LRU、shrinker、bdi |
| `inode` | `include/linux/fs.h:767` | 持久元数据 | 文件元数据：i_mode/i_size/i_nlink，内嵌 `address_space i_data`（page cache 入口），i_op/i_fop 策略 |
| `dentry` | `include/linux/dcache.h:93` | 路径缓存（临时） | 目录项/路径名缓存：d_name/d_parent/d_inode，RCU seqlock 无锁查找 |
| `file` | `include/linux/fs.h:1260` | open→close（运行时会话） | 打开的文件实例：f_op/f_pos/f_mapping/f_ra，每次 open 独立创建 |

**为什么分四层？** 分离关注点：

- `super_block` 是**FS 类的实例**，管理全局资源（LRU、shrinker、writeback bdi），一个挂载点一个。
- `inode` 是**持久元数据**，一个文件全局唯一（硬链接共享），多个 `file` 可同时引用同一个 inode。
- `dentry` 是**路径缓存**，避免每次路径解析都触发磁盘 IO，多级目录共享父 dentry。
- `file` 是**运行时会话状态**，`f_pos`（文件偏移）是 per-instance 的——两个进程同时读同一个文件各有独立的偏移量。

### 五组 ops vtable

| ops 结构体 | 定义位置 | 绑定对象 | 核心方法 |
|---|---|---|---|
| `super_operations` | `super_types.h:83-130` | super_block→s_op | `alloc_inode`/`destroy_inode`/`evict_inode`/`write_inode`/`put_super`/`sync_fs`/`statfs` |
| `inode_operations` | `fs.h:2001-2050` | inode→i_op | `lookup`（路径解析核心）/`create`/`link`/`unlink`/`mkdir`/`rename`/`get_link`/`permission`/`getattr`/`atomic_open` |
| `file_operations` | `fs.h:1926-1970` | file→f_op | `read_iter`（现代异步读）/`write_iter`/`iterate_shared`/`mmap`/`open`/`release`/`fsync`/`poll`/`splice_read` |
| `dentry_operations` | `dcache.h:163-181` | dentry→d_op | `d_revalidate`/`d_hash`/`d_compare`/`d_delete`/`d_automount` |
| `address_space_operations` | `fs.h:401-442` | address_space→a_ops | `read_folio`/`readahead`/`writepages`/`write_begin`/`write_end`/`direct_IO`——page cache 与块设备的桥梁 |

ops 的设计本质是 **C 语言版的虚函数表**：基类（VFS 框架）定义接口结构体，子类（具体 FS）填充实现函数指针。运行时通过 `f_op->read_iter()` 这样的间接调用实现策略分派。

## 调用链路

### open 调用链

从系统调用到 `file_operations` 装配的完整路径：

```c
// title="fs/open.c"
SYSCALL_DEFINE3(open)          // open.c:1374
→ do_sys_open                  // open.c:1367
  → do_sys_openat2             // open.c:1355  build_open_flags 构造 open_flags
  → do_file_open               // namei.c:4877  set_nameidata + path_openat
    → path_openat              // namei.c:4838  三级重试: RCU→ref→REVAL
      → alloc_empty_file       // 分配 file 结构体
      → path_init              // 初始化路径起点（root/cwd）
      → link_path_walk         // namei.c:2574  逐级解析路径分量
      → open_last_lookups      // namei.c:4563  lookup_fast_for_open + lookup_open
      → do_open                // namei.c:4655  may_open 权限检查 + vfs_open
        → vfs_open             // open.c:1074
          → do_dentry_open     // open.c:885  装配 file 对象
```

`do_dentry_open` 是装配 `file` 对象的关键函数：

```c
// title="fs/open.c"
static int do_dentry_open(struct file *f, struct inode *inode, int (*open)(struct inode *, struct file *))
{
    f->f_inode = inode;                              // :889  绑定 inode
    f->f_mapping = inode->i_mapping;                 // :894  page cache 入口
    f->f_op = fops_get(inode->i_fop);                // :918  从 i_fop 装配 f_op（增模块引用计数防卸载）
    security_file_open(f);                           // :924  LSM 安全钩子
    fsnotify(f);                                     // fsnotify 事件
    break_lease(inode, f->f_flags);                  // 租约检查
    f->f_op->open(inode, f);                         // :944  调用 FS 特定 open（可选）
    // 设置 FMODE_CAN_READ / FMODE_CAN_WRITE         // :952
}
```

**关键点**：`file->f_op` 从 `inode->i_fop` 装配。`fops_get()` 内部调用 `try_module_get()` 增加文件系统模块的引用计数，防止文件打开期间模块被卸载。

### read 调用链

```c
// title="fs/read_write.c"
vfs_read                        // read_write.c:554
→ rw_verify_area                // :565  security_file_permission (LSM) + :475 锁检查
→ f_op->read (旧式) 或 new_sync_read  // :483-493
  → init_sync_kiocb             // 构造 kiocb
  → iov_iter_ubuf               // 构造 iov_iter（用户缓冲区）
  → f_op->read_iter             // :493  现代异步读主路径
```

```c
// title="mm/filemap.c"
generic_file_read_iter          // filemap.c:2957  ext4 等通用实现
→ IOCB_DIRECT ? a_ops->direct_IO  // Direct IO 绕过 page cache
             : filemap_read       // filemap.c:2769  走 page cache
  → filemap_read                // :2769  循环读取
    → filemap_get_pages         // :2668  xarray 查找页
      → 未命中: page_cache_sync_ra  // 预读（触发 a_ops->readahead）
    → copy_folio_to_iter        // :2857  拷贝到用户缓冲区（copy_to_user）
```

### 方法速查表

<details>
<summary>VFS 核心方法速查（点击展开）</summary>

| 方法 | 所属 ops | 文件:行号 | 功能 |
|---|---|---|---|
| `do_sys_open` | — | open.c:1367 | open 系统调用入口 |
| `path_openat` | — | namei.c:4838 | 路径打开主逻辑（三级重试） |
| `link_path_walk` | — | namei.c:2574 | 逐级路径解析 |
| `do_dentry_open` | — | open.c:885 | file 对象装配 |
| `vfs_read` | — | read_write.c:554 | 读系统调用入口 |
| `new_sync_read` | — | read_write.c:483 | 旧接口适配 read_iter |
| `generic_file_read_iter` | f_op | filemap.c:2957 | 通用读实现 |
| `filemap_read` | — | filemap.c:2769 | page cache 读循环 |
| `filemap_get_pages` | — | filemap.c:2668 | xarray 页查找 |
| `vfs_write` | — | read_write.c:668 | 写系统调用入口 |
| `generic_file_write_iter` | f_op | filemap.c:4459 | 通用写实现 |
| `generic_perform_write` | — | filemap.c:4297 | 写循环（write_begin/end） |
| `lookup_fast` | — | namei.c:1838 | dcache 快速查找 |
| `lookup_slow` | — | namei.c:1925 | dcache 未命中→FS lookup |
| `do_mount` | — | namespace.c:4161 | 挂载入口 |
| `do_new_mount_fc` | — | namespace.c:3757 | 创建挂载 |
| `alloc_inode` | s_op | — | 分配 inode（FS 特定） |
| `evict_inode` | s_op | — | 驱逐 inode（释放页缓存） |
| `iget5_locked` | — | inode.c:1375 | 查找/创建 inode |
| `iput` | — | inode.c:1972 | 释放 inode 引用 |
| `register_filesystem` | — | filesystems.c:72 | 注册文件系统类型 |

</details>

## 核心实现

### 四大对象与 ops 策略模式

VFS 的对象模型采用 C 语言结构体模拟面向对象的多态。每类对象内嵌一个 ops 函数指针表，具体文件系统在 `fill_super` 阶段填充这些函数指针，实现策略绑定。

**策略分派链**：

```text
register_filesystem (filesystems.c:72)
  → file_system_type.init_fs_context
    → fs_context.ops->get_tree (super.c:1743)
      → fill_super: 设置 sb->s_op
        → 创建 inode 时设 i_op / i_fop
          → open 时 f_op = fops_get(i_fop) (open.c:918)
            → 运行时 f_op->read_iter() 分派到具体 FS 实现
```

**对象字段与 ops 绑定关系**：

| 对象 | ops 字段 | 来源 | 装配时机 |
|---|---|---|---|
| super_block | `s_op` (super_operations) | FS `fill_super` 设置 | mount 时 |
| inode | `i_op` (inode_operations) | FS `alloc_inode` / `create` 时设置 | inode 创建时 |
| inode | `i_fop` (file_operations) | FS 创建 inode 时设置默认值 | inode 创建时 |
| file | `f_op` (file_operations) | `fops_get(inode->i_fop)` | open 时从 i_fop 装配 |
| dentry | `d_op` (dentry_operations) | FS `d_alloc` 时设置（可选） | dentry 创建时 |
| address_space | `a_ops` (address_space_operations) | FS 创建 inode 时设置 | inode 创建时 |

`inode_init_always_gfp`（`inode.c:227`）为新 inode 设置默认策略：`i_op = empty_iops`、`i_fop = no_open_fops`、`i_mapping = &i_data`。具体 FS 随后覆盖这些默认值。

### Path Resolution

路径解析是 VFS 最复杂的路径之一。`link_path_walk`（`namei.c:2574`）逐级解析路径分量，将字符串路径转化为 dentry/inode 序列。

**解析流程**：

```text
link_path_walk("foo/bar/baz")
  │
  ├─ 跳过 '/'
  ├─ hash_name()           // word-at-a-time 快速哈希
  ├─ 分类: LAST_DOT / LAST_DOTDOT / LAST_NORM
  │
  └─ walk_component()      // namei.c:2261
       │
       ├─ lookup_fast()    // namei.c:1838  先查 dcache
       │    ├─ RCU 模式: __d_lookup_rcu()  // 无锁，seqlock 校验
       │    ├─ ref 模式: __d_lookup()      // d_lock
       │    └─ 命中: d_revalidate()         // NFS 等需重新校验
       │
       ├─ lookup_slow()    // namei.c:1925  dcache 未命中
       │    └─ __lookup_slow()
       │         ├─ d_alloc_parallel()     // 占位 dentry
       │         └─ i_op->lookup()          // :1915  FS 特定钩子，读磁盘
       │
       └─ step_into()      // namei.c:2126
            └─ handle_mounts()              // 挂载点穿越
```

**挂载点穿越**：当解析到 dentry 标记了 `DCACHE_MOUNTED`，`__follow_mount_rcu`（`namei.c:1682`）通过 `__lookup_mnt` 查找挂载在该路径上的 `vfsmount`，切换到新 mount 的 `mnt_root` dentry。多层挂载（如 A 挂在 B 上，B 挂在 C 上）会循环穿越直到最顶层。

**RCU-walk 三级降级**：

| 级别 | 模式 | 触发降级条件 | 性能 |
|---|---|---|---|
| 1 | `LOOKUP_RCU` | 需睡眠操作（如 `i_op->lookup` 读磁盘）→ 返回 `-ECHILD` | 无锁最快 |
| 2 | ref-walk | 需重新验证（如 NFS `d_revalidate` 失败）→ 返回 `-ESTALE` | 加 d_lock |
| 3 | `LOOKUP_REVAL` | 强制重验证，不信任缓存 | 最慢但最安全 |

RCU-walk 模式下整个遍历**零锁操作**，依赖 `dentry->d_seq`（seqlock）校验一致性。当遇到无法在 RCU 下完成的操作时，调用 `try_to_unlazy` 惰性化——将 RCU 引用转为真实引用计数，降级到 ref-walk。

### Dentry/Inode Cache

#### Dentry Cache

Dentry cache 是路径名到 inode 的映射缓存，避免每次路径解析都触发磁盘 IO。

- **全局哈希表**：`dentry_hashtable`（`dcache.c:3374`），`d_lookup`（`:2454`）通过 `rename_lock` seqlock 保护，防止 rename 竞态下遍历到不一致状态。
- **per-sb LRU**：`super_block.s_dentry_lru`，未被引用的 dentry 进入 LRU 等待回收。
- **创建**：`__d_alloc`（`:1801`）从 `dentry_cache` slab 分配，短名（≤40B）内联在 `d_shortname` 中避免一次间接寻址。
- **释放**：`dput`（`:966`）→ `fast_dput`（lockless 引用计数递减）→ `finish_dput`（加入 LRU 或释放）。
- **回收**：`dentry_lru_isolate`（`:1227`），`DCACHE_REFERENCED` 标志给予二次机会算法，被访问过的 dentry 不会被立即回收。
- **缓存行布局**：RCU 相关字段打包在 64 字节缓存行内，`d_flags` 的 bits 19-21 编码 dentry 类型（正/负/挂载点），查找时无需解引用 `d_inode` 即可判断。

#### Inode Cache

- **全局哈希表**：`inode_hashtable`（`inode.c:2612`），`find_inode` 可在 RCU 下无锁遍历。
- **per-sb LRU**：`super_block.s_inode_lru`。
- **创建**：`alloc_inode`（`:339`）→ FS 的 `s_op->alloc_inode` 或通用 `inode_cachep` slab → `inode_init_always_gfp`（`:227`）初始化默认 ops → `iget5_locked`（`:1375`）先查哈希表（RCU），未命中则分配并 `inode_insert5` 标记 `I_NEW`。
- **释放**：`iput`（`:1972`）→ 引用计数原子递减 → `iput_final`（`:1916`）→ `drop_inode` 决定丢弃或入 LRU → `evict`（`:818`）调用 `s_op->evict_inode` → `destroy_inode` 通过 `call_rcu` **延迟释放**。
- **RCU 延迟释放**：inode 释放后不立即回收内存，而是通过 RCU 延迟到所有读者退出 grace period。这允许 `find_inode` 在 RCU 下无锁遍历哈希表而不持锁。
- **test/set 回调**：NFS 等文件系统需要复杂匹配条件（如文件句柄而非 inode 号），通过 `iget5_locked` 的 test/set 回调自定义查找和初始化逻辑。
- **i_mapping 双向链接**：`inode->i_mapping` 指向 `&i_data`（内嵌的 `address_space`），`address_space.host` 反向指向 inode，形成双向链接。

### Page Cache 与 address_space

Page cache 是文件数据的内存缓存层，挂在 `address_space` 上而非直接挂在 inode 上。

**数据结构**：

```c
// title="include/linux/fs.h"
struct address_space {           // fs.h:473
    struct inode    *host;       // 反向指向所属 inode
    struct xarray    i_pages;    // 页缓存树（页偏移→page 映射）
    struct rb_root   i_mmap;     // 反向映射（page→vma，用于 unmmap/fork/COW）
    unsigned long    nrpages;    // 缓存页数
    const struct address_space_operations *a_ops;  // 策略
};
```

**filemap_read 读流程**（`filemap.c:2769`）：

```text
filemap_read()
  循环:
    ├─ filemap_get_pages()          // :2668  在 i_pages xarray 中查找
    │    ├─ 命中: 直接获取 page
    │    └─ 未命中: page_cache_sync_ra()  // 触发预读
    │         └─ a_ops->readahead()      // FS 构建读请求
    │
    └─ copy_folio_to_iter()        // :2857  copy_to_user 拷贝到用户缓冲区
```

**为什么 page cache 挂在 address_space 而非 inode？**

1. **生命周期解耦**：`tmpfs`/`shmem` 是纯内存文件系统，page cache 就是其数据本体，不属于磁盘 inode；swap cache 的页不属于原文件；块设备自身也有 page cache 但不是普通文件。
2. **反向映射**：`i_mmap` 红黑树维护 page→VMA 的反向映射，支持 `munmap`/`fork`/COW 时高效找到所有映射该文件的进程。
3. **间接寻址优化**：`file->f_mapping = inode->i_mapping`（`open.c:894`），file 通过一次间接寻址即可到达 page cache，比每次通过 `inode->i_data.i_pages` 少一层解引用。
4. **双向链接**：`inode->i_mapping = &i_data`，`address_space.host = inode`，形成闭环，任意一方可快速找到对方。

### Mount Namespace

挂载是 VFS 将文件系统实例接入全局目录树的机制。Linux 通过 mount namespace 实现容器化隔离。

**挂载流程**：

```c
// title="fs/namespace.c"
do_mount                        // namespace.c:4161  用户态 mount() 系统调用
→ user_path_at                  // 解析挂载点路径
→ path_mount
→ do_new_mount                  // :3790
  → get_fs_type                 // 从 file_systems 链表查找 FS 类型
  → fs_context_for_mount        // 创建 fs_context
  → vfs_parse                    // 解析挂载选项
  → do_new_mount_fc             // :3757
    → fc_mount
      → vfs_get_tree             // super.c:1743
        → fc->ops->get_tree      // FS 特定（如 ext4_get_tree）
          → fill_super           // 读磁盘超级块，设置 s_op、创建根 inode/dentry
    → security_sb_kern_mount     // LSM 安全钩子
    → do_add_mount               // 挂入 namespace 树
```

**Namespace 数据结构**：

| 结构体 | 定义位置 | 核心字段 | 职责 |
|---|---|---|---|
| `mnt_namespace` | `mount.h:11` | `root`/`mounts`(rb_root)/`user_ns`/`nr_mounts` | 挂载命名空间，隔离可见的挂载树 |
| `mount` | `mount.h:45` | `mnt_parent`/`mnt_mountpoint`/`mnt`(vfsmount)/`mnt_child`/`mnt_ns` | 挂载点关系，组织父子兄弟拓扑 |
| `vfsmount` | `mount.h:58` | `mnt_root`/`mnt_sb`/`mnt_flags`/`mnt_idmap` | 挂载的文件系统实例根 |

`clone(CLONE_NEWNS)` 触发 `copy_mnt_ns` 复制整个挂载树，为容器创建独立的 mount namespace 视图。

## 设计模式

### 策略模式（ops vtable）

VFS 的 ops 结构体是经典策略模式的 C 语言实现。每类对象内嵌一个 ops 函数指针表，具体文件系统填充实现函数，VFS 框架通过 `f_op->read_iter()` 这样的间接调用实现运行时多态。

```c
// title="策略分链示意"
// ext4 在 fill_super 时:
sb->s_op = &ext4_sops;
// 创建 inode 时:
inode->i_op = &ext4_file_inode_operations;
inode->i_fop = &ext4_file_operations;
// open 装配:
file->f_op = fops_get(inode->i_fop);  // → &ext4_file_operations
// 运行时分派:
file->f_op->read_iter(kiocb, iov_iter);  // → ext4_file_read_iter
```

`register_filesystem`（`filesystems.c:72`）校验 `file_system_type` 并链入全局 `file_systems` 单链表。`file_system_type`（`fs.h:2272`）包含 `name`/`init_fs_context`/`kill_sb`/`owner`/`fs_supers`，是文件系统的"类型对象"。

### 对象模型（四层分离关注点）

四大对象构成一个有层次的类型系统，每层管理不同关注点：

| 层次 | 对象 | 关注点 | 生命周期 |
|---|---|---|---|
| FS 实例 | super_block | 全局资源管理（LRU/shrinker/writeback bdi） | mount↔umount |
| 持久元数据 | inode | 文件属性（i_mode/i_size/i_nlink） | 缓存驻留 |
| 路径缓存 | dentry | 路径名→inode 映射（避免磁盘 IO） | 缓存驻留 |
| 运行时会话 | file | 每次打开的独立状态（f_pos/f_ra） | open↔close |

这种分层使得 `file` 的运行时状态（`f_pos` per-instance）与 `inode` 的持久状态（`i_size` 全局唯一）彻底解耦——多个进程同时打开同一个文件各有独立的偏移量，但共享同一份元数据。

## 模块间交互

### VFS ↔ MM（内存管理子系统）

`address_space`（`fs.h:473`）是 VFS 与 MM 子系统的桥梁：

- **读路径**：`filemap_read` → `filemap_get_pages` 在 `i_pages` xarray 中查找页，未命中触发预读（`a_ops->readahead`）。
- **缺页**：mmap 映射的文件区域发生缺页时，`filemap_fault`（`filemap.c:3513`）从 page cache 加载或触发读 IO。
- **写路径**：`generic_perform_write`（`filemap.c:4297`）通过 `a_ops->write_begin`/`write_end` 管理脏页标记，由 writeback 线程回写。
- **反向映射**：`i_mmap` 红黑树维护 page→VMA 映射，`fork`/`munmap`/COW 时高效查找所有映射进程。

### VFS ↔ Block（块设备子系统）

`address_space_operations` 是 page cache 与块设备的接口：

- `read_folio`/`readahead`：构建 bio 提交给 block 层，从磁盘读取数据填充 page cache。
- `writepages`：将脏页组织为 bio 提交回写。
- `direct_IO`：Direct IO 路径，绕过 page cache 直接在用户缓冲区与磁盘之间传输数据。

### VFS ↔ Security（安全子系统 / LSM）

VFS 在关键路径植入 LSM（Linux Security Module）钩子：

| 钩子 | 位置 | 作用 |
|---|---|---|
| `security_file_open` | open.c:924 | 打开文件时检查访问权限 |
| `security_file_post_open` | namei.c:4701 | 打开后二次检查（如 SELinux） |
| `security_inode_permission` | security.c:1838 | 路径解析权限检查 |
| `security_inode_create` | security.c:1625 | 创建文件检查 |
| `security_inode_unlink` | security.c:1676 | 删除文件检查 |
| `security_inode_follow_link` | — | 跟随符号链接检查 |
| `security_sb_kern_mount` | namespace.c:3768 | 挂载时检查 |

### VFS ↔ Init（初始化）

`vfs_caches_init`（`dcache.c:3401`）由 `init/main.c:1202` 调用，初始化所有 VFS 缓存基础设施：`filename_init` + `dcache_init` + `inode_init` + `files_init` + `mnt_init` + `bdev_cache_init` + `chrdev_init`。早期阶段 `vfs_caches_init_early`（`:3390`，`init/main.c:1076`）在 slab 就绪前初始化 boot 时所需的少量 inode/dentry。

## 扩展方式

新增一个文件系统的核心步骤是**实现四组 ops 并注册**：

1. **定义 `file_system_type`**：实现 `init_fs_context`（创建 fs_context 并设置 `fc->ops`）和 `kill_sb`（卸载时释放 super_block）。

2. **实现 `get_tree` → `fill_super`**：在 `fc->ops->get_tree` 中调用 `fill_super`，读磁盘超级块（或纯内存构造），设置 `sb->s_op = &my_sops`，创建根 inode 和根 dentry。

3. **实现 `super_operations`**：至少实现 `alloc_inode`/`destroy_inode`/`evict_inode`（释放 inode 及其 page cache）。

4. **实现 `inode_operations`**：为不同 inode 类型（目录/普通文件/符号链接）设置 `i_op`，至少实现 `lookup`（目录 inode 的路径解析钩子）和 `permission`。

5. **实现 `file_operations`**：为可打开的 inode 设置 `i_fop`，至少实现 `read_iter`/`write_iter`（或使用 `generic_file_read_iter`/`generic_file_write_iter` 通用实现）和 `iterate_shared`（目录）。

6. **实现 `address_space_operations`**：设置 `inode->i_mapping->a_ops`，实现 `read_folio`/`readahead`（读）/`writepages`/`write_begin`/`write_end`（写）。纯内存文件系统（如 tmpfs）可省略，直接在 page cache 中操作。

7. **调用 `register_filesystem`**（`filesystems.c:72`）：将 `file_system_type` 链入全局链表，此后 `mount -t myfs` 即可挂载。

```c
// title="注册文件系统示例"
static struct file_system_type my_fs_type = {
    .owner          = THIS_MODULE,
    .name           = "myfs",
    .init_fs_context = my_init_fs_context,
    .kill_sb        = kill_litter_super,
};

static int __init init_myfs(void)
{
    return register_filesystem(&my_fs_type);
}
module_init(init_myfs);
```

整个扩展过程中，VFS 框架的路径解析、page cache 管理、mount namespace 集成等机制均可直接复用，新文件系统只需关注自身特有的存储格式和元数据操作。
