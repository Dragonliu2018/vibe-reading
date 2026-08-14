---
source:
  type: "源码解读"
  project: "Linux"
  url: "https://github.com/torvalds/linux"
title: "内存管理"
date: "2026-08-14T21:30:28+08:00"
category: [OS, Linux, CodeWiki, "7.1"]
tags: ["Linux", "内核", "内存管理", "buddy", "slub", "page cache"]
description: "Linux 内存管理——buddy 分配器、slub sheaves、缺页处理与 COW、mmap/VMA maple tree、vmscan LRU 回收。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/00-overview)

---

## 模块定位

内存是所有子系统的基础资源——进程的 `task_struct` 需要分配（slub）、文件读写需要缓冲（page cache）、页表本身占用物理页、网络 `sk_buff` 从 kmalloc 分配。`mm/` 子系统独立管理这套物理-虚拟内存映射体系，向上为进程提供隔离的虚拟地址空间，向下管理物理页的生命周期。

`mm/` 的职责边界明确：它管理**物理页分配**（buddy）、**内核对象分配**（slub）、**文件页缓存**（page cache）、**虚拟内存映射**（mmap/VMA）和**内存回收**（vmscan）五个领域。它不负责 I/O 调度（交由 `block/`）、不负责文件系统语义（交由 `fs/`），但通过 `vm_ops->fault` 回调和 `address_space->a_ops->writepage` 回调与这两个子系统协作。v7.1 的关键变化：slub 引入 sheaves 三层缓存替代 cmpxchg、VMA 管理迁移到 Maple Tree 取代红黑树，这两项改动显著降低了锁竞争。

---

## 模块架构

![mm/ 五大组件架构](/vibe-reading/images/articles/linux-kernel-internals/mm-architecture.svg)

`mm/` 内部按职责划分为五大组件，自上而下形成"虚拟→物理→回收"的闭环：

**mmap/VMA 层**管理进程的虚拟地址空间布局。每个 `vm_area_struct`（VMA）描述一段连续的虚拟地址区间（`vm_start`/`vm_end`），记录权限标志（`vm_flags`）、匿名页的 `anon_vma`、文件映射的 `vm_ops`/`vm_file`。v7.1 用 Maple Tree（`mm_struct.mm_mt`）取代红黑树作为 VMA 唯一索引结构，提供 O(log n) 范围查询和 RCU 无锁读。`do_mmap` 创建新 VMA 时优先尝试 `vma_merge_new_range` 与相邻 VMA 合并，减少碎片。`munmap` 采用两阶段提交（gather → point of no return → complete），保证可回退的安全性。

**Page Cache** 是文件数据的缓冲层，以 `address_space` 为核心——每个文件的 inode 持有一个 `address_space`，其内部用 xarray 按 folio index 索引所有缓存页。`filemap_fault` 在缺页时从 page cache 取页，`do_fault_around` 预读相邻页面，`filemap_map_pages` 批量建立 PTE 映射。Page cache 的页最终从 buddy 分配。

**Slub 分配器**处理内核对象的细粒度分配（`kmalloc`/`kmem_cache_alloc`）。v7.1 引入 sheaves 机制：per-CPU 的 `slub_percpu_sheaves` 维护 `main`/`spare` 两个 `slab_sheaf` 数组，fast path 直接 pop/push 对象，完全不涉及 slab freelist 或 cmpxchg 操作。三层缓存架构（per-CPU sheaves → per-NUMA-node barn → partial list）逐级降级，从无锁到 `local_trylock` 到 `spinlock`。

**Buddy 分配器**是物理页管理的基石，管理 zone（DMA/DMA32/NORMAL/MOVABLE）内的连续物理页。每个 zone 维护 `free_area[MAX_PAGE_ORDER=11]` 数组，每个 order 的 free_list 按 migratetype（UNMOVABLE/MOVABLE/RECLAIMABLE/HIGHATOMIC/CMA）分区。watermark 三级（WMARK_MIN/LOW/HIGH）控制分配准入和 kswapd 唤醒。`__rmqueue` 状态机按 NORMAL→CMA→CLAIM→STEAL 顺序尝试分配，在减少碎片和满足请求间平衡。

**vmscan 内存回收**在内存不足时回收冷页。`shrink_lruvec` 遍历 4 个 LRU（INACTIVE_ANON/ACTIVE_ANON/INACTIVE_FILE/ACTIVE_FILE），`shrink_folio_list` 是回收决策树——加锁、检查引用、解除映射（`try_to_unmap`）、写回（`pageout`）、释放。kswapd 后台线程在 watermark 低于 LOW 时自动唤醒，direct reclaim 在分配 slowpath 中同步执行。MGLRU（Multi-Gen LRU）用代际老化替代传统 active/inactive 二列表，减少误回收。

---

## 调用链路

![mm/ 核心调用链路](/vibe-reading/images/articles/linux-kernel-internals/mm-callchain.svg)

### 物理页分配：`__alloc_pages` fast→slowpath

分配入口 `__alloc_pages_noprof`（`page_alloc.c:5250`）接收 GFP 标志、order、preferred nid，返回 `struct page *`。调用 `prepare_alloc_pages` 填充 `alloc_context`（zonelist、preferred zone、migratetype），然后进入 fast path `get_page_from_freelist`（`:3786`），以 WMARK_LOW 为准遍历 zonelist——`zone_watermark_fast`（`:3885`）检查水位，通过后 `rmqueue`（`:3389`）分配：order-0 走 `rmqueue_pcplist` 从 per-CPU pageset 无锁获取，高阶走 `__rmqueue`（`:3218`）状态机。

fast path 失败则进入 `__alloc_pages_slowpath`（`:5234`），按代价递增顺序尝试六步：(1) `wake_all_kswapds`（`:4771`）唤醒所有 node 的 kswapd；(2) `get_page_from_freelist` 以 WMARK_MIN 再试（`:4777`，允许动用 reserve）；(3) `__alloc_pages_direct_reclaim`（`:4818`）同步回收；(4) `__alloc_pages_direct_compact`（`:4825`）内存整理碎片；(5) `should_reclaim_retry`（`:4878`）评估是否值得重试；(6) `__alloc_pages_may_oom`（`:4909`）触发 `out_of_memory` 杀进程。若 GFP 含 `__GFP_NOFAIL`，nopne 后循环重试永不返回 NULL。

### 缺页处理：`handle_mm_fault` 4 级页表

缺页入口 `handle_mm_fault`（`memory.c:6699`）接收 VMA、地址、fault flags，返回 `vm_fault_t`。经 `sanitize_fault_flags` 清理标志后调用 `__handle_mm_fault`（`:6465`），沿 4 级页表逐级分配：`pgd_offset` → `p4d_alloc` → `pud_alloc` → `pmd_alloc`。在 PUD/PMD 级别检查 Transparent Huge Page（THP）：有 `create_huge_pud`/`wp_huge_pud`/`create_huge_pmd`/`wp_huge_pmd` 快捷路径。

最终到达 `handle_pte_fault`（`:6383`），按 PTE 状态四路分发：
- **PTE 不存在**（`do_pte_missing` `:6427`）：匿名 VMA 走 `do_anonymous_page`——读错误映射 zero_pfn 零页（零拷贝优化），写错误 `alloc_anon_folio` 分配新 folio 并 `map_anon_folio_pte_pf` 建立映射；文件 VMA 走 `do_fault`——非写走 `do_read_fault`（`do_fault_around` 预读 → `__do_fault` 调 `vm_ops->fault` → `finish_fault`），写且非共享走 `do_cow_fault`，写且共享走 `do_shared_fault`。
- **页不在内存**（`do_swap_page` `:6430`）：从 swap 设备读回页。
- **protnone 但可访问**（`do_numa_page` `:6433`）：NUMA 跨 node 迁移。
- **写且只读**（`do_wp_page` `:6443`）：COW 写时复制。

<details>
<summary>方法速查表</summary>

| 方法 | 文件 | 职责 | 关键设计决策 |
|------|------|------|-------------|
| `__alloc_pages_noprof` | page_alloc.c:5250 | 物理页分配总入口 | fast→slow→OOM 三级降级 |
| `get_page_from_freelist` | page_alloc.c:3786 | 遍历 zonelist 分配 | watermark 准入控制 |
| `rmqueue` | page_alloc.c:3389 | 从 zone 取页 | order-0 PCP / 高阶 buddy |
| `__rmqueue` | page_alloc.c:3218 | buddy 分配状态机 | NORMAL→CMA→CLAIM→STEAL |
| `__rmqueue_smallest` | page_alloc.c:1883 | 从 free_list 取最小块 | 向上遍历 split |
| `__free_one_page` | page_alloc.c:934 | 释放并合并伙伴 | `buddy_merge_likely` tail 优化 |
| `handle_mm_fault` | memory.c:6699 | 缺页处理总入口 | 4 级页表遍历 |
| `handle_pte_fault` | memory.c:6383 | PTE 级别分发 | 按 PTE 状态 4 路分发 |
| `do_anonymous_page` | memory.c:5337 | 匿名页缺页 | zero_pfn 零页优化 |
| `do_wp_page` | memory.c:4244 | COW 写时复制 | `wp_can_reuse_anon_folio` 独占复用 |
| `wp_page_copy` | memory.c:3853 | COW 复制页 | TLB flush 顺序保证安全 |
| `kmem_cache_alloc_noprof` | slub.c:4904 | slub 对象分配 | sheaves fast path |
| `alloc_from_pcs` | slub.c:4705 | per-CPU sheaf pop | 数组 pop，无 cmpxchg |
| `___slab_alloc` | slub.c:4406 | slub slow path | partial→new_slab |
| `do_mmap` | mmap.c:336 | 创建虚拟映射 | `vma_merge` 合并优先 |
| `shrink_lruvec` | vmscan.c:5920 | LRU 回收入口 | MGLRU 分支 |
| `shrink_folio_list` | vmscan.c:1058 | 回收决策树 | lock→ref→unmap→writeout→free |

</details>

---

## 核心实现

### Buddy 分配器

Buddy 分配器以 zone 为管理单位。`struct zone`（`mmzone.h:967`）包含 `_watermark[NR_WMK]`（三级水位线）、`lowmem_reserve`（跨 zone 保护）、`free_area[NR_PAGE_ORDERS=11]`（11 个 order 的空闲链表）和 `per_cpu_pageset`（per-CPU 热页缓存）。`MAX_PAGE_ORDER=10` 限定最大分配 2^10=1024 页（4MB），`PAGE_ALLOC_COSTLY_ORDER=3` 标记 8 页以上为"昂贵"分配。

```c title="mm/page_alloc.c — zone 与 free_area 结构关系"
// zone->free_area[order].free_list[migratetype] 链表头
// 每个 free_area 管理 2^order 大小的空闲页块
struct free_area {
    struct free_list free_list[MIGRATE_TYPES];
    unsigned long nr_free;
};

// watermark 控制分配准入和 kswapd 唤醒
enum zone_watermarks {
    WMARK_MIN,   // 仅 __GFP_HIGH/OOM 可用
    WMARK_LOW,   // kswapd 唤醒阈值，fast path 检查
    WMARK_HIGH,  // kswapd 停止回收阈值
    WMARK_PROMO, // NUMA promote 用
};
```

分配核心 `__rmqueue`（`:2442`）实现四状态机：`RMQUEUE_NORMAL` 从目标 migratetype 的 free_list 直接取（`__rmqueue_smallest` `:2472`，从指定 order 向上遍历 split）；失败转 `RMQUEUE_CMA` 尝试 CMA 区域（仅 `__GFP_MOVABLE` 可用）；再失败转 `RMQUEUE_CLAIM` 占据整个 pageblock 并转换 migratetype；最后转 `RMQUEUE_STEAL` 从其他 migratetype 盗取。这个状态机在减少外部碎片（优先同类型）和满足分配请求间做平衡——`fallbacks` 数组（`:1916`）定义了每种 migratetype 可盗取的类型顺序。

释放路径 `__free_one_page`（`:934`）是分配的逆过程：`find_buddy_page_pfn` 计算伙伴页 PFN，`__del_page_from_free_list` 从链表摘除伙伴，合并 PFN，`order++`，循环向上合并。`buddy_merge_likely`（`:882`）做 tail 优化——如果伙伴的下一个 order 也有空闲块，说明合并概率高，优先合并以形成更大的连续块。`free_pages`（`:5362`）→ `__free_pages` → `___free_pages` → `__free_frozen_pages` → `__free_pages_ok` → `free_one_page` → `__free_one_page` 是完整释放调用链。

### Slub 分配器与 sheaves

v7.1 对 slub 的最大改动是引入 sheaves 三层缓存，替代了传统的 per-CPU `slab` freelist + cmpxchg 机制。`kmem_cache`（`slab.h:198`）持有 `cpu_sheaves`（per-CPU sheaf 指针）和 `per_node[MAX_NUMNODES]` 的 `kmem_cache_node`。`slub_percpu_sheaves`（`slub.c:420`）包含 `main`（永不 NULL）、`spare`（备用）、`rcu_free`（RCU 延迟释放）三个 `slab_sheaf`，用 `local_trylock_t` 保护。

```c title="mm/slub.c — sheaves 三层缓存结构"
struct slub_percpu_sheaves {
    local_trylock_t lock;      // 轻量锁，非自旋
    struct slab_sheaf *main;   // 主缓存，永不 NULL
    struct slab_sheaf *spare;  // 备用，main 满时替换
    struct slab_sheaf *rcu_free; // RCU 延迟释放
};

struct slab_sheaf {
    struct slab *slab;         // 所属 slab
    unsigned int size;         // 当前对象数
    void *objects[];           // 柔性数组，实际对象指针
};
```

分配 fast path `alloc_from_pcs`（`:4705`）：`local_trylock(cpu_sheaves)` → 从 `pcs->main` 数组 pop（`objects[--size]` `:4755`）→ `local_unlock`。整个路径无 slab freelist 操作、无 cmpxchg、无 spinlock——这是 v7.1 最显著的性能优化。当 main 为空时 `__pcs_replace_full_main`（`:5815`）从 barn 或 partial list 补充。

slow path `__slab_alloc_node`（`:4485`）→ `___slab_alloc`（`:4406`）：先 `get_from_partial`（`:4441`）从 partial list 取 slab，再 `new_slab`（`:4445`）→ `allocate_slab`（`:3441`）→ `alloc_slab_page` 从 buddy 分配新 slab 页，最后 `alloc_from_new_slab`（`:4465`）。NUMA 分配三步策略：(1) `__GFP_THISNODE` 在目标 node partial 取；(2) `GFP_NOWAIT|__GFP_THISNODE` 在目标 node 分配新 slab；(3) 放宽原始 GFP 跨 node 分配。

释放 fast path `free_to_pcs`（`:5804`）：`local_trylock` → main 满则 `__pcs_replace_full_main` 移入 barn → 数组 push（`objects[size++]`）→ `local_unlock`。slow path `__slab_free`（`:5510`）用 CAS 循环：读 `old.freelist` → `set_freepointer` 链入 → `slab_update_freelist` CAS 更新。slab 完全空闲且 `nr_partial >= min_partial` 则 `discard_slab` 释放回 buddy。`SLAB_FREELIST_HARDENED` 配置下 freepointer 经 `ptr ^ random ^ swab` 混淆，并检测 double-free。

### 缺页与 COW

`handle_pte_fault`（`:6383`）是缺页处理的分发中心，按 PTE 状态决定处理路径。PTE 不存在时 `do_pte_missing`（`:6427`）进一步按 VMA 类型分发：匿名页走 `do_anonymous_page`（`:5337`），文件页走 `do_fault`（`:6013`）。

匿名页缺页 `do_anonymous_page` 有两个优化路径：`VM_SHARED` 匿名映射直接 SIGBUS（共享匿名实际走 shmem）；读错误映射 `zero_pfn` 零页（全局只读零页，避免物理页分配）；写错误才真正 `alloc_anon_folio` 分配新 folio 并 `map_anon_folio_pte_pf` 建立 PTE 映射。

文件页缺页 `do_fault` 按写入意图和共享属性三路分发：

```c title="mm/memory.c — do_fault 分发逻辑"
// 非写入：读 fault，预读 + 建立映射
do_read_fault(:5889)
  → do_fault_around  // 预读相邻页
  → __do_fault       // vm_ops->fault(vmf) 如 filemap_fault
  → finish_fault     // 建立 PTE

// 写入 + 非共享：COW fault，复制页后映射
do_cow_fault
  → __do_fault → copy_user_highpage → finish_fault

// 写入 + 共享：共享 fault，直接映射可写
do_shared_fault
  → __do_fault → do_page_mkwrite → finish_fault
```

COW 写时复制 `do_wp_page`（`:4244`）是 fork 后写匿名页的核心路径。它先检查 userfaultfd 写保护（走 uffd-wp 路径），再判断 `VM_SHARED`（走 `wp_page_shared` 不复制），然后检查 `PageAnonExclusive` 或 `wp_can_reuse_anon_folio`（`:4181`）——如果页的 refcount==1 且非 KSM，说明只有一个进程引用，直接 `wp_page_reuse` 复用（修改 PTE 权限即可，不复制）。这是 fork 后子进程写独占页的关键优化。不满足复用条件则 `wp_page_copy`（`:3853`）真正复制。

`wp_page_copy` 的 TLB flush 顺序是安全性的关键——必须先 `ptep_clear_flush` 清除旧 PTE 并刷 TLB，再 `set_pte_at` 设置新 PTE。如果顺序反了，在多核环境下另一个 CPU 可能通过旧 TLB entry 继续写入旧页，导致数据不一致。`folio_add_new_anon_rmap` 将新 folio 加入 reverse mapping，建立物理页到 VMA 的反向索引。

页表分配 `__pte_alloc`（`:451`）/`__pud_alloc`（`:6794`）/`__pmd_alloc`（`:6817`）采用经典的"分配→加锁→检查并发→smp_wmb→populate→竞争失败释放"模式，处理多核同时触发同一级页表分配的竞争。

### mmap 与 Maple Tree

`do_mmap`（`mmap.c:336`）是 mmap 系统调用的核心实现。参数校验后计算 `vm_flags`，调用 `__get_unmapped_area`（`:408`）找到空闲虚拟地址区间——文件映射优先 `f_op->get_unmapped_area`，匿名共享走 shmem，默认 `mm_get_unmapped_area_vmflags`（`:802`）根据 `MMF_TOPDOWN` 标志选择 top-down 或 bottom-up 策略。

`mmap_region`（`vma.c:2830`）→ `__mmap_region`（`:2732`）完成实际映射：`__mmap_setup` 查找并移除重叠 VMA；`vma_merge_new_range`（`:2762`）尝试与左/右邻居合并（条件：`is_mergeable_vma` + `is_mergeable_anon_vma` + `can_vma_merge_before/after`）；合并失败则 `__mmap_new_vma`（`:2769`）调用 `vm_area_alloc` 分配新 VMA 并 `vma_iter_store_new` 插入 maple tree；最后 `__mmap_complete` 完成 file->f_mode 更新等收尾。

v7.1 的重大变化是 Maple Tree 取代红黑树成为 VMA 唯一数据结构。`mm_struct.mm_mt`（`mm_types.h:1189`）是 `struct maple_tree`，`find_vma`（`mmap.c:903`）用 `mt_find` 做 O(log n) 查找。Maple Tree 的优势：(1) 内置区间查询（`mas_range_walk`），VMA 天然是区间数据；(2) RCU 安全读——读者无需 `mmap_lock`，配合 per-VMA lock（`vm_refcnt`）实现无锁 VMA 访问；(3) 减少树节点数量——B-tree 结构比红黑树更紧凑。

`munmap` 采用两阶段提交模式：`do_vmi_align_munmap`（`:1583`）先 `vms_gather_munmap_vmas` 收集待删除 VMA（可回退），到达 point of no return（`:1603`）后 `vms_complete_munmap_vmas` 清除 PTE、释放页表、`remove_vma` 释放 VMA 结构。两阶段设计确保 gather 阶段失败时可以完全回退，不产生部分删除的不一致状态。

### 内存回收 vmscan

`shrink_lruvec`（`vmscan.c:5920`）是回收入口。如果 `lru_gen_enabled()` 则走 MGLRU 路径 `lru_gen_shrink_lruvec`（`:5931`），否则走传统路径 `get_scan_count`（`:5939`）计算各 LRU 扫描比例后遍历 4 个 LRU 调用 `shrink_list`。

`get_scan_count`（`:2493`）决定扫描哪些 LRU 及比例：无 swap 只扫 file（`SCAN_FILE`）；file cache 太小优先扫 anon（`SCAN_ANON`）；cache trim mode 只扫 file；priority=0 全量扫描（`SCAN_EQUAL`）；默认按 swappiness 和 recent refault 比例分摊（`SCAN_FRACT`）。

`shrink_folio_list`（`:1058`）是回收决策树，对每个隔离的 folio 依次检查：

```c title="mm/vmscan.c — shrink_folio_list 回收决策树"
folio_trylock          // 加 folio 锁，失败跳过
→ hwpoisoned?          // 硬件中毒，直接释放
→ !evictable?          // 不可回收，保留
→ !may_unmap && mapped? // 不允许 unmap 但有映射，保留
→ writeback?           // 正在回写，保留等待
→ folio_check_references  // 引用计数决策: ACTIVATE/KEEP/RECLAIM
→ try_to_unmap         // 解除所有 PTE 映射
→ folio_maybe_dma_pinned? // DMA pin，保留
→ pageout               // 脏页写回: writepage / swap_writeout
→ __remove_mapping      // 从 address_space/swap 移除，folio_ref_freeze
→ free_it               // 释放回 buddy
```

`folio_check_references` 实现二次机会算法：最近被访问的 folio（`folio_referenced` 返回非零）且 VM_EXEC 优先保留在 active list，否则从 active 降到 inactive。active list 的 folio 需要先经 `shrink_active_list`（`:2068`）降级到 inactive 才能被回收。

kswapd（`:7438`）是后台回收守护进程，设 `PF_MEMALLOC|PF_KSWAPD` 标志，`kswapd_try_to_sleep`（`:7341`）中 100ms 短睡眠 + `schedule` 等待唤醒。`balance_pgdat`（`:7108`）检查 `pgdat_balanced` 决定是否继续回收，调用 `kswapd_shrink_node` → `shrink_node` 执行。`wakeup_kswapd`（`:7519`）在 `__alloc_pages_slowpath` 中被调用，更新 `kswapd_order`/`highest_zoneidx` 后 `wake_up_interruptible(kswapd_wait)`。

Direct reclaim 在 `try_to_free_pages`（`:6720`）中同步执行：`throttle_direct_reclaim` 限制并发回收线程数，`do_try_to_free_pages`（`:6498`）以递减 priority 遍历所有 zone 调用 `shrink_zones`。`scan_control`（`:74`）结构体控制回收行为：`nr_to_reclaim` 目标页数、`may_writepage`/`may_unmap`/`may_swap` 开关、`priority` 扫描比例（0=全量，每轮翻倍）、`anon_cost`/`file_cost` 权重。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 伙伴系统 | `__free_one_page`(page_alloc.c:934) + `__rmqueue_smallest`(:1883) | 2 幂次合并/分裂消除外部碎片，O(1) 查找伙伴 |
| 对象池 | `alloc_from_pcs`(slub.c:4705) / `free_to_pcs`(:5804) | per-CPU 数组 pop/push 零开销，避免每次操作 slab freelist |
| 策略/分发 | `handle_pte_fault`(memory.c:6383) / `do_fault`(:6013) | 按 PTE 状态/VMA 属性分发，避免巨型 if-else 链 |
| 状态机 | `__rmqueue`(page_alloc.c:2442) NORMAL→CMA→CLAIM→STEAL | 有序降级尝试，在碎片控制和分配成功率间平衡 |
| CAS 无锁 | `__slab_free`(slub.c:5510) `slab_update_freelist` / `buddy_merge_likely`(:882) | 避免自旋锁竞争，多核并发释放不阻塞 |
| 两阶段提交 | `do_vmi_align_munmap`(mmap.c:1583) gather→point of no return→complete | gather 可回退保证一致性，PONR 后不可逆确保完成 |

---

## 模块间交互

`mm/` 与其他子系统的协作主要通过回调函数和共享数据结构实现：

**mm ↔ fs**：文件映射缺页时 `__do_fault`（`memory.c:5447`）调用 `vma->vm_ops->fault(vmf)`，最常见的实现是 `filemap_fault`（`filemap.c:3513`）从 page cache 取页。`do_fault_around` 预读后调 `map_pages` → `filemap_map_pages` 批量建立 PTE。回收时 `pageout` 调用 `mapping->a_ops->writepage` 将脏页写回文件系统。VMA 插入文件 inode 的 `address_space->i_mmap`（优先搜索树），建立反向映射。

**mm ↔ block**：swap I/O 通过 `swap_iocb` + `blk_start_plug`/`blk_finish_plug` 批量提交到块设备层。`pageout` 调用 `swap_writeout`/`shmem_writeout` 最终走 `submit_bio` 到 `block/` 子系统。buddy 分配的页也可能来自 `block/` 的 `bio_alloc`。

**mm ↔ sched**：kswapd 通过 `kthread_create_on_node`（`vmscan.c:7632`）在 `module_init(kswapd_init)`（`:7703`）中创建。kswapd 在 `kswapd_try_to_sleep` 中调用 `schedule_timeout`/`schedule` 让出 CPU，被 `wakeup_kswapd` 唤醒后重新调度执行。direct reclaim 路径中 `throttle_direct_reclaim` 限制并发回收线程。

**mm ↔ arch**：页表操作依赖架构层宏——`pgd_offset`/`p4d_alloc`/`pud_alloc`/`pmd_alloc` 是 arch 相关的页表遍历。TLB flush 通过 `flush_cache_page`/`update_mmu_cache`/`ptep_clear_flush` 调用 arch-specific 实现。`arch_mmap_check` 在 `do_mmap` 中做架构相关地址校验。

---

## 扩展方式

**新增 migratetype**：在 `mmzone.h` 的 `enum migratetype` 中添加类型，更新 `MIGRATE_TYPES` 计数，在 `page_alloc.c` 的 `fallbacks` 数组（`:1916`）中定义该类型可盗取的类型顺序。`__rmqueue` 状态机会自动处理新类型的 `RMQUEUE_NORMAL` 路径。注意 `free_area` 的 `free_list` 数组大小随之增长，每个 zone 的内存开销增加。

**新增 zone**：在 `mmzone.h` 的 `enum zone_type` 中添加 zone 类型，更新 `MAX_NR_ZONES`。需在 `build_all_zonelists`（`page_alloc.c`）中配置新 zone 的 fallback 顺序，在 `zone_watermark_ok` 中设置合适的水位线。`lowmem_reserve` 数组需配置新 zone 对低端 zone 的保护比例。通常新 zone 仅在特殊硬件场景下添加（如设备专属内存 zone）。
