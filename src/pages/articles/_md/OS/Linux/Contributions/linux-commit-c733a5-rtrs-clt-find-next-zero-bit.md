---
title: "rtrs permit 分配改用 find_next_zero_bit 避免竞态后重扫"
source:
  project: "Linux"
  type: "commit"
  id: "c733a5"
  url: "https://lore.kernel.org/linux-rdma/20260816165935.90523-1-dragonliu2018@gmail.com/"
  prType: "perf"
date: "2026-08-19T00:00:21+08:00"
category: ["OS", "Linux", "Contributions"]
tags: ["Linux Kernel", "RDMA", "RTRS", "RNBD", "Permit", "Bitmap", "find_next_zero_bit", "Lockless", "Performance", "Contributions"]
description: "rtrs 客户端 __rtrs_get_permit() 从 permits_map 位图里无锁分配空闲 permit，原用 find_first_zero_bit() 每次从 bit 0 扫，竞态失败后回 0 重扫已置位低段。改用 find_next_zero_bit() 从上次位置续扫；扫到末尾后 fallback find_first_zero_bit 从头扫（wrap-around），确保 cursor 下方释放的 permit 也能找到、NULL 只在 map 真满时返回，匹配原始行为。扫描仍非原子、test_and_set_bit_lock 重试逻辑不变。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20260816](https://lore.kernel.org/linux-rdma/20260816165935.90523-1-dragonliu2018@gmail.com/) · **commit** [c733a5] · **首发版本** `-` · **变更行数** +14 行 · **合并时间** 2026-08-16

---

## 背景

`drivers/infiniband/ulp/rtrs/rtrs-clt.c` 是 RTRS（RDMA Transport，给 RNBD「block over RDMA」用的传输层）的客户端。它的 `__rtrs_get_permit()` 负责从一张位图 `clt->permits_map` 里**无锁**分配一个空闲 permit（RDMA 资源槽）：扫到一个 0 位、用 `test_and_set_bit_lock()` 原子地占住；占不到（别人抢先）就 do-while 重来。

原来的扫描用 `find_first_zero_bit(map, max_depth)`——**每次都从 bit 0 开始**。问题在于：RTRS/RNBD 数据路径下 queue_depth 很高，`permits_map` 的低位段被密集置位（in-use permits 多），空闲位往往在更靠后的位置。一旦 `test_and_set_bit_lock()` 输了竞态，do-while 回到顶部、`find_first_zero_bit` **又从 bit 0 重新扫**，把那一长串已置位的低段再走一遍才到空闲区——这次重扫的代价正比于 in-use permit 数。高负载下每次竞态失败都白走一段。

本 commit 把扫描换成 `find_next_zero_bit(map, max_depth, bit)`——**从上次的 `bit` 位置继续**，竞态失败后继续向前扫，而不是回 0。扫描仍非原子、`test_and_set_bit_lock()` 重试逻辑原封不动，只是去掉了冗余的重扫。

![rtrs permit 分配：bitmap 扫描的 rewind vs resume](/vibe-reading/images/articles/linux-commit-c733a5-rtrs-clt-find-next-zero-bit/bitmap-scan.svg)

上图把 `permits_map` 画成一条位图条：左段密集置位（in-use permits）、右段空闲。改动前（红）`find_first_zero_bit` 扫到空闲位、输竞态后**回 bit 0 重扫已置位低段**（浪费 ∝ in-use 数）；改动后（绿）`find_next_zero_bit` 输竞态后**从上次位置续扫**，不再回 0。差异只在「失败后的扫描方向」，原子占位与重试逻辑不变。

## 前置知识

### RTRS / permit

RTRS 是架在 RDMA 之上的传输层，给 RNBD（网络块设备）当数据通道。一次 RNBD IO 要发 RDMA 读写，得先拿到一个 **permit**——它是预分配好的 RDMA 资源槽（对应 `clt_path->reqs[mem_id]` 里那个请求结构 + RDMA buffer）。permit 数量 = `clt->queue_depth`，用一张 `permits_map` 位图管理占用。

### 无锁位图分配（lockless bitmap tag allocation）

`__rtrs_get_permit()` 的写法源自 null_blk 的 `get_tag()`：**不用自旋锁**，靠「非原子扫描 + 原子占位 + 失败重试」无锁分配。多个 CPU 可能同时扫到同一个 0 位，但 `test_and_set_bit_lock()` 是原子的、只有一个 CPU 能占成功，其余的 `test_and_set_bit_lock()` 返回失败、do-while 再扫一次。省了一把显式自旋锁，代价是竞态失败时要重扫。

> null_blk 的 `get_tag()`（带 `find_first_zero_bit` 的 bio 路径）后来随 `8b631f9cf0b8`「null_blk: remove the bio based I/O path」移除，null_blk 现在走 blk-mq tag set；RTRS 仍保留这套无锁位图写法。

### `find_first_zero_bit` vs `find_next_zero_bit`

- `find_first_zero_bit(map, n)`：从 bit 0 起找第一个 0 位。
- `find_next_zero_bit(map, n, offset)`：从 `offset` 起找下一个 0 位。

差别只在「起点」：前者恒从 0，后者从传入的 `offset`。把 do-while 里上次找到的 `bit` 当 `offset` 传回去，就实现了「失败后从上次位置续扫」。

## 涉及的函数与调用链

### 函数清单（文件 : 行号）

| 函数 | 位置 | 角色 |
|------|------|------|
| `__rtrs_get_permit` | `drivers/infiniband/ulp/rtrs/rtrs-clt.c:69` | 核心：从 `permits_map` 无锁分配 permit（本 commit 改的就是这里的扫描） |
| `rtrs_clt_get_permit` | `rtrs-clt.c:117`（`EXPORT_SYMBOL` :142） | 公开 API：调 `__rtrs_get_permit`，拿不到且 `can_wait` 时 `prepare_to_wait`+`io_schedule` 等待重试 |
| `__rtrs_put_permit` | `rtrs-clt.c:96` | 释放：`clear_bit_unlock(permit->mem_id, clt->permits_map)` |
| `rtrs_clt_put_permit` | `rtrs-clt.c:152`（`EXPORT_SYMBOL` :170） | 公开 API：校验后调 `__rtrs_put_permit` |
| `rtrs_clt_request` | `rtrs-clt.c:~2986`（`EXPORT_SYMBOL`） | 公开 API：拿着 permit 发 RDMA（用 `permit->mem_id` 索引 `reqs` + buffer） |
| `rtrs_clt_create`（permit 初始化） | `rtrs-clt.c:~1416` | `bitmap_zalloc(clt->queue_depth, ...)` 建 `permits_map` |

### 数据结构

```c title="drivers/infiniband/ulp/rtrs/rtrs-clt.h (rtrs_permit + 会话字段)"
struct rtrs_permit {
	enum rtrs_clt_con_type con_type;
	unsigned int cpu_id;
	unsigned int mem_id;   /* 即 permits_map 的位号，也索引 clt_path->reqs[] */
	unsigned int mem_off;
};
/* rtrs_clt_sess 里： */
size_t          queue_depth;   /* = max_depth，permit 总数 */
void            *permits;       /* permit 数组（permit_size(clt) * idx 索引） */
unsigned long   *permits_map;   /* 占用位图，本 commit 扫的就是它 */
```

### 调用链

```text title="permit 分配/释放调用链（RTRS 客户端数据路径）"
RTRS 客户端（如 RNBD block-over-RDMA）要发 IO
  └─ rtrs_clt_get_permit(clt, con_type, can_wait)   # 公开 API（:117）
       ├─ permit = __rtrs_get_permit(clt, con_type)  # 无锁分配（:69）★本 commit
       │    ├─ bit = find_next_zero_bit(permits_map, max_depth, bit)  # 改动后：续扫
       │    └─ test_and_set_bit_lock(bit, permits_map)  # 原子占位，失败则 do-while 重扫
       └─（拿不到 + can_wait → prepare_to_wait + io_schedule 重试）
  ── 拿到 permit 后 ──
  └─ rtrs_clt_request(dir, ops, sess, permit, ...)   # 用 permit->mem_id 发 RDMA（:2986）
       └─ reqs[permit->mem_id] / buf_id = permit->mem_id  # 索引预分配请求与 buffer
  ── IO 完成回调 ──
  └─ rtrs_clt_put_permit(clt, permit)               # 公开 API（:152）
       └─ __rtrs_put_permit(clt, permit)             # clear_bit_unlock(mem_id)（:96）
```

`__rtrs_get_permit` 产出的 `bit` 写进 `permit->mem_id`（rtrs-clt.c:90），既是 `permits_map` 的位号、又拿来索引 `clt_path->reqs[mem_id]`（:993）和 RDMA buffer（`buf_id = permit->mem_id`，:1118）。get 占位、put 清位，配对完整。

## 实现

改动只在一个函数、+14/-9 行：`__rtrs_get_permit` 里把 `find_first_zero_bit` 换成 `find_next_zero_bit`（从上次位置续扫），并加了 **wrap-around**——扫到末尾后 fallback 回 `find_first_zero_bit` 从头扫，确保 cursor 下方释放的 permit 也能找到：

```diff title="drivers/infiniband/ulp/rtrs/rtrs-clt.c (__rtrs_get_permit)"
 {
 	size_t max_depth = clt->queue_depth;
 	struct rtrs_permit *permit;
-	int bit;
+	unsigned long bit = 0;
 
 	/*
-	 * Adapted from null_blk get_tag(). Callers from different cpus may
-	 * grab the same bit, since find_first_zero_bit is not atomic.
-	 * But then the test_and_set_bit_lock will fail for all the
-	 * callers but one, so that they will loop again.
-	 * This way an explicit spinlock is not required.
+	 * Callers from different CPUs may grab the same bit, since the bitmap
+	 * scan is not atomic. But then the test_and_set_bit_lock() will fail
+	 * for all the callers but one, so that they loop again. This way an
+	 * explicit spinlock is not required. find_next_zero_bit() resumes
+	 * from the last position so that a lost race does not rescan the
+	 * already-set low bits; if it reaches the end, wrap to the beginning
+	 * to exhaust the map and still find a permit freed below the cursor.
 	 */
 	do {
-		bit = find_first_zero_bit(clt->permits_map, max_depth);
-		if (bit >= max_depth)
-			return NULL;
+		bit = find_next_zero_bit(clt->permits_map, max_depth, bit);
+		if (bit >= max_depth) {
+			bit = find_first_zero_bit(clt->permits_map, max_depth);
+			if (bit >= max_depth)
+				return NULL;
+		}
 	} while (test_and_set_bit_lock(bit, clt->permits_map));
```

四处实质改动：
1. `find_first_zero_bit(map, max_depth)` → `find_next_zero_bit(map, max_depth, bit)`：扫描从「恒从 0」变成「从上次的 `bit` 续扫」。
2. `int bit;` → `unsigned long bit = 0;`：初始化为 0（首次进入 do-while 的起点），类型对齐 `find_next_zero_bit` 的 `offset` 形参。
3. **wrap-around**：`find_next_zero_bit` 扫到末尾（`bit >= max_depth`）后 fallback 到 `find_first_zero_bit` 从头扫——确保 cursor 下方（bit 0 到上次位置之间）被释放的 permit 也能找到，`NULL` 只在两次扫描都空（map 真满）时才返回。这匹配原始 `find_first_zero_bit` 的行为。注意这里**不加 `unlikely()`**——和 4693d6b 的「全删 likely/unlikely」一致（见 [4693d6](/vibe-reading/articles/OS/Linux/PRs/linux-commit-4693d6-rtrs-remove-likely-unlikely)）。
4. 注释更新：删了「Adapted from null_blk get_tag()」前缀（渊源已在正文讲过），点明续扫 + wrap-around + 失败不重扫已置位低段。

`do { ... } while (test_and_set_bit_lock(bit, clt->permits_map));` 的重试逻辑**一字未动**——扫描仍非原子、`test_and_set_bit_lock()` 仍是唯一的原子占位、输了竞态仍 do-while 重来。wrap-around 只改「续扫到末尾后的回退策略」，不加 `unlikely()`，不改竞态处理。

## Review

- 本 commit 由本人（Liu Zhenlong）提交，属 `Contributions`，`prType: perf`（纯性能优化，非 bugfix）。commit message 写清了「原 `find_first_zero_bit` 失败后回 0 重扫、高 queue_depth 下浪费 ∝ in-use 数」+「`find_next_zero_bit` 续扫、扫描仍非原子、`test_and_set_bit_lock` 重试不变」。
- `Compile-tested: arm64 defconfig + INFINIBAND_RTRS_CLIENT=m, rtrs-clt.o`——编译验证。
- trailer `Assisted-by: Claude:claude-opus-5` 标注 AI 协助（与本文 `aiModel` 一致）。
- 尚未进上游/lore（本地 commit，`首发版本` 暂 `-`）；待提交到 linux-rdma 邮件列表后会补 lore patch 链接。

## 问题

### 为什么 `find_first_zero_bit` 在高负载下浪费

无锁位图分配的失败重试是设计内代价（换省一把自旋锁），但 `find_first_zero_bit` 让这个代价**正比于 in-use 数**：每次输竞态都回 bit 0，把已置位的低段再走一遍。RTRS/RNBD 数据路径 queue_depth 大、低段密集置位，一次竞态失败就白扫一大截；高并发下多个 CPU 抢同一片空闲区，竞态失败频繁，重扫的累积开销可观。

### 为什么 `find_next_zero_bit` 能省

`find_next_zero_bit(map, max, bit)` 从上次的 `bit` 续扫，输竞态后**继续向前**找下一个 0 位，不再回 0。已置位的低段只走一遍（首次），之后每次重试都从上次位置往后，跳过已扫区域。代价从「每次失败 ∝ in-use 数」降到「摊还到首次扫描」。

### 为什么不破坏竞态处理

`find_next_zero_bit` 本身仍非原子（它只是换个起点扫位图），多个 CPU 仍可能扫到同一位；占位仍由 `test_and_set_bit_lock()` 原子保证、只成功一个，输的 do-while 重来。**race handling 一字未改**，本 commit 只改「失败后扫描的起点 + 末尾回退策略」，不改竞态处理。

### 为什么 `find_next_zero_bit` 还需要 wrap-around

光用 `find_next_zero_bit(map, max, bit)` 从 cursor 续扫有一个隐患：如果扫到 `max_depth`（末尾）——cursor 下方（bit 0 到 cursor 之间）可能有刚释放的 permit，但 `find_next_zero_bit` 只向前扫、看不到——它会直接返回 `NULL`（误判 map 满），即使实际有空闲位。原始 `find_first_zero_bit` 每次从 0 扫，不会漏掉低段释放的位。

wrap-around 就是修这个：`find_next_zero_bit` 扫到末尾后，fallback 到 `find_first_zero_bit` 从头扫一遍，覆盖 cursor 下方。两次扫描都空才返回 `NULL`——这跟原始行为一致、也跟 sbitmap 分配的惯例一致。

## 意义与影响

- **去掉数据路径里的冗余重扫**：RTRS/RNBD 高 queue_depth 下，permit 分配是每次 IO 都走的快路径；把「竞态失败 ∝ in-use 重扫」改成「续扫」，直接削掉高并发场景下的一大块无谓扫描。
- **保留无锁位图模式**：`test_and_set_bit_lock` 的原子占位 + 失败重试不动，仍省自旋锁；只优化扫描策略，最小侵入。
- **wrap-around 保证正确性**：纯 `find_next_zero_bit` 会漏掉 cursor 下方释放的位（误判满）；wrap 到 `find_first_zero_bit` 兜底，确保 `NULL` 只在 map 真满时返回，匹配原始行为。
- **模式可复用**：任何「非原子扫位图 + `test_and_set_bit_lock` 占位 + 失败重试」的无锁分配器（null_blk 的 `get_tag` 这类），只要重试时能携带上次的 offset，都能套这个 `find_first → find_next` + wrap-around 的优化。

## 参考

- **无锁位图 tag 分配的渊源**：commit `8b631f9cf0b8`（"null_blk: remove the bio based I/O path"）移除的 null_blk bio 路径里的 `get_tag()`——RTRS `__rtrs_get_permit` 原注释里曾提 "Adapted from null_blk get_tag()"（c733a5 已删此行），指的就是它（带 `find_first_zero_bit` 的 bio 路径已删，null_blk 现走 blk-mq tag set）。
- **位图 API**：`find_first_zero_bit` / `find_next_zero_bit` / `test_and_set_bit_lock` / `clear_bit_unlock`，见 `include/linux/asm-generic/bitops/` 与 `include/linux/find.h`、`include/linux/bitops.h`。

## 相关阅读

- **rtrs 移除全部 likely/unlikely 注解，benchmark 证明无性能差异** —— [Linux commit-4693d6](/vibe-reading/articles/OS/Linux/PRs/linux-commit-4693d6-rtrs-remove-likely-unlikely)：同一函数 `__rtrs_get_permit` 的前序。4693d6b（2021）删了 `unlikely(bit >= max_depth)`（benchmark 证明无益）；本篇（c733a5）的 wrap-around fallback **也没有加回 `unlikely()`**——与「全删」保持一致。
- **移除 null_blk 的 bio I/O 路径只留 blk-mq，删掉 get_tag/put_tag 位图分配** —— [Linux commit-8b631f9](/vibe-reading/articles/OS/Linux/PRs/linux-commit-8b631f9-null-blk-remove-bio-path)：本 commit 的「渊源」。8b631f9（2024）删掉了 null_blk 的 `get_tag`/`put_tag`（RTRS `__rtrs_get_permit` 借鉴的那套无锁位图）连同整条 bio 路径——同一种 lockless bitmap 模式在 null_blk 这头被删、在本篇（c733a5，RTRS）那头被优化，两篇对照可见模式的来龙去脉。
- **Block I/O 子系统** —— [Linux CodeWiki 7.1 · 05-block-io](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/05-block-io)：block 层（blk-mq tag、null_blk 等）的 CodeWiki 解读，无锁位图 tag 分配模式的出处（null_blk `get_tag`）与 RNBD「block over RDMA」都在 block I/O 这条线上，可对照看 tag/permit 分配的共通形态。
