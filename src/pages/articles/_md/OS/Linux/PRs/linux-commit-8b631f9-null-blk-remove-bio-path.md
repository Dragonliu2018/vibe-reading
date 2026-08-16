---
title: "移除 null_blk 的 bio I/O 路径只留 blk-mq，删掉 get_tag/put_tag 位图分配"
source:
  project: "Linux"
  type: "commit"
  id: "8b631f9"
  url: "https://github.com/torvalds/linux/commit/8b631f9cf0b84ac59cd4f0c6dcd2d0cb80dd8a49"
  prType: "refactor"
date: "2026-08-16T17:21:21+08:00"
category: ["OS", "Linux", "PRs"]
tags: ["Linux Kernel", "null_blk", "Block Layer", "blk-mq", "bio", "get_tag", "Lockless Bitmap", "Refactor", "Christoph Hellwig", "v6.9"]
description: "Christoph Hellwig 删掉 null_blk 的 bio based I/O 路径（NULL_Q_BIO），只留 blk-mq（NULL_Q_MQ）：移除整条 bio 路径的 get_tag/put_tag（无锁位图 tag 分配，find_first_zero_bit + test_and_set_bit_lock）、__alloc_cmd/alloc_cmd/free_cmd、null_handle_bio/null_submit_bio、end_cmd 队列模式分流等，把 cmd->rq 改用 blk_mq_rq_from_pdu 取、end_cmd 内联成 blk_mq_end_request。简化驱动、缩小数据结构、方便日后 block 层 API 改动。queue_mode/NULL_Q_BIO 枚举保留用于错误报告。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **patch** [20240220](https://lore.kernel.org/all/20240220093248.3290292-2-hch@lst.de/) · **commit** [8b631f9](https://github.com/torvalds/linux/commit/8b631f9cf0b84ac59cd4f0c6dcd2d0cb80dd8a49) · **首发版本** v6.9-rc1 · **变更行数** +69 行 · **合并时间** 2024-03-11

---

## 背景

`drivers/block/null_blk/` 是内核里的「假块设备」测试驱动（内存当磁盘，测 block 层性能/接口）。它历史上同时维护**两条 I/O 路径**：

- **bio 路径**（`NULL_Q_BIO`）：直接吃 `struct bio`，自己用一套**无锁位图 tag 分配**（`get_tag()`/`put_tag()`：`find_first_zero_bit` 扫位 + `test_and_set_bit_lock` 占位 + `clear_bit_unlock` 释放）管理命令槽。
- **blk-mq 路径**（`NULL_Q_MQ`）：走 blk-mq 框架，tag 由 blk-mq tag set 管，命令是 `struct request`。

bio 路径给 null_blk 带来不小的复杂度：它得维护自己的 `nullb_queue`（`tag_map` 位图 + `cmds[]` 数组 + waitqueue）、自己的 submit/handle/complete，还让 `nullb_cmd` 等**每命令数据结构**为兼容两条路径而膨胀。而 bio 路径的主要用户是 stacking 驱动和简单内存驱动——后者已有 `brd` 这个好范例，没必要在 null_blk 里也养一条。

本 commit（Christoph Hellwig）**整条删掉 bio 路径，只留 blk-mq**：移除 `get_tag`/`put_tag`/`__alloc_cmd`/`alloc_cmd`/`free_cmd`/`end_cmd`/`null_handle_bio`/`null_submit_bio`/`nullb_to_queue`/`cleanup_queue(s)` 等，把 `cmd->rq` 改用 `blk_mq_rq_from_pdu()` 取、`end_cmd` 的队列模式分流内联成直接的 `blk_mq_end_request()`。简化驱动、缩数据结构、让日后 block 层 API 改动不必再迁就 null_blk 的双 API 设置。

> 这条 commit 顺带删掉的 `get_tag()`/`put_tag()`，正是 RTRS 客户端 `__rtrs_get_permit()` 注释里「Adapted from null_blk get_tag()」所指的那套无锁位图写法——RTRS 把它留了下来（后来还由 [0c5549](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-0c5549-rtrs-clt-find-next-zero-bit) 优化成 `find_next_zero_bit`），null_blk 自己却在 2024 年把整条 bio 路径连同它一起删了。

![null_blk I/O 路径：双路径 → 只留 blk-mq](/vibe-reading/images/articles/linux-commit-8b631f9-null-blk-remove-bio-path/io-paths.svg)

上图改动前 null_blk 有两条 I/O 路径：bio 路径（红，含 `get_tag`/`put_tag` 无锁位图 + 自己的 submit/handle/complete）和 blk-mq 路径（中性）。改动后（绿）只剩 blk-mq 一条，bio 路径 + `get_tag`/`put_tag` + `nullb_queue`/`tag_map`/`cmds[]` 整组结构、`end_cmd` 的队列模式分流一并删掉，`cmd->rq` 改用 `blk_mq_rq_from_pdu()` 取、`end_cmd` 内联成 `blk_mq_end_request()`。

## 前置知识

### null_blk 与两条队列模式

null_blk 是测试/基准驱动（内存后端 + 可选 zoned/throttling/irqmode 等）。它有个 `queue_mode` 模块参数，旧值 `NULL_Q_BIO`(0) / `NULL_Q_RQ`(1) / `NULL_Q_MQ`(2)——本 commit 后**实际只支持 `NULL_Q_MQ`**，但枚举 + `queue_mode` 字段保留（设了 bio 也按 MQ 走 / 报错），省得拆 debugfs。

### 无锁位图 tag 分配（bio 路径的 `get_tag`/`put_tag`）

bio 路径不依赖 blk-mq tag set，自己用 `nullb_queue.tag_map` 位图管命令槽：`get_tag()` 用 `find_first_zero_bit` 扫一个 0 位、`test_and_set_bit_lock` 原子占位（失败重扫，无显式自旋锁）；`put_tag()` 用 `clear_bit_unlock` 释放。这套写法后被 RTRS `__rtrs_get_permit()` 借鉴（见 [0c5549](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-0c5549-rtrs-clt-find-next-zero-bit)）。

### blk-mq 请求路径

blk-mq 路径里命令 `nullb_cmd` 挂在 `struct request` 的 pdu 上，用 `blk_mq_rq_to_pdu(rq)`/`blk_mq_rq_from_pdu(cmd)` 在 cmd 与 rq 间互转，完成用 `blk_mq_end_request()`、批量完成用 `blk_mq_complete_request()`/`blk_mq_end_request_batch()`。

## 涉及的函数与调用链

### 移除的函数（bio 路径整组）

| 函数 | 原位置（main.c） | 作用 |
|------|------|------|
| `get_tag` | ~:760 | `find_first_zero_bit` 扫 + `test_and_set_bit_lock` 占位（无锁分配 tag） |
| `put_tag` | ~:757 | `clear_bit_unlock` 释放 + 唤醒 waitqueue |
| `__alloc_cmd` / `alloc_cmd` | ~:786 / ~:812 | 从 `get_tag` 拿 tag、取 `cmds[tag]`、（bio 路径）绑 bio；`alloc_cmd` 带等待重试 |
| `free_cmd` | ~:783 | `put_tag(cmd->nq, cmd->tag)` |
| `end_cmd` | ~:831 | 按 `queue_mode` 分流：MQ 走 `blk_mq_end_request`、BIO 走 `bio_endio` + `free_cmd` |
| `null_handle_bio` | ~:1304 | `bio_for_each_segment` 逐段 `null_transfer` |
| `null_submit_bio` | ~:1392 | bio 路径入口：`nullb_to_queue` 选队 → `alloc_cmd` → `null_handle_cmd` |
| `nullb_to_queue` | ~:1387 | 按 CPU 选 `nullb->queues[index]`（bio 路径用） |
| `null_stop_queue` / `null_restart_queue_async` | ~:1326 / ~:1336 | 按 `queue_mode` 判断才 `blk_mq_stop/start_stopped_hw_queues`（MQ 专用包装） |
| `cleanup_queue` / `cleanup_queues` | ~:1622 / ~:1631 | `bitmap_free(tag_map)` + `kfree(cmds)`（bio 路径队列清理） |

### 修改的函数（去 `queue_mode` 分流 + `cmd->rq` 改 `blk_mq_rq_from_pdu`）

| 函数 | 位置 | 改动 |
|------|------|------|
| `null_cmd_timer_expired` | main.c | 原 `end_cmd(container_of(...))` → 直接 `blk_mq_end_request(blk_mq_rq_from_pdu(cmd), cmd->error)` |
| `null_complete_rq` | main.c | 原 `end_cmd(blk_mq_rq_to_pdu(rq))` → 直接 `blk_mq_end_request(rq, cmd->error)` |
| `null_handle_rq` / `null_handle_throttled` / `nullb_zero_read_cmd_buffer` / `nullb_complete_cmd` | main.c | `cmd->rq` → `blk_mq_rq_from_pdu(cmd)`；去掉 `NULL_Q_BIO` 分支 |
| `null_handle_memory_backed` | main.c | 删 `dev->queue_mode==NULL_Q_BIO ? null_handle_bio : null_handle_rq` 分支，只留 `null_handle_rq` |
| `nullb_complete_cmd` | main.c | 删 `NULL_Q_BIO → end_cmd` 分支，`NULL_IRQ_NONE` 也直接 `blk_mq_end_request` |
| `null_queue_rq` | main.c | 删 `cmd->rq = rq`（不再缓存 rq 指针，靠 pdu 取） |
| `null_poll` | main.c | `end_cmd(cmd)` → `blk_mq_end_request(req, cmd->error)` |

### bio 路径调用链（改动前 → 整条删除）

```text title="bio 路径（改动前，NULL_Q_BIO）"
null_submit_bio(bio)                              # bio 入口
  └─ nullb_to_queue(nullb) → nq                   # 按 CPU 选队列
  └─ alloc_cmd(nq, bio)                           # 分配命令（带等待重试）
       └─ __alloc_cmd(nq)
            └─ get_tag(nq)                         # 无锁位图：find_first_zero_bit + test_and_set_bit_lock
            └─ cmd = &nq->cmds[tag]; cmd->bio = bio
  └─ null_handle_cmd → null_handle_bio(cmd)        # bio_for_each_segment → null_transfer
  └─ end_cmd(cmd)                                  # queue_mode 分流
       └─ (BIO) bio_endio(cmd->bio) → free_cmd → put_tag (clear_bit_unlock + wake_up)
```

改动后这条链整条消失，I/O 只剩 blk-mq 路径（`null_queue_rq → blk_mq → null_handle_rq → blk_mq_end_request`），命令槽由 blk-mq tag set 管。

## 实现

### 删 `get_tag`/`put_tag`/`__alloc_cmd`/`alloc_cmd`/`free_cmd`/`end_cmd`（无锁位图整组）

```diff title="drivers/block/null_blk/main.c（移除无锁位图 tag 分配 + bio 命令分配/释放/完成）"
-static void put_tag(struct nullb_queue *nq, unsigned int tag)
-{
-	clear_bit_unlock(tag, nq->tag_map);
-	if (waitqueue_active(&nq->wait))
-		wake_up(&nq->wait);
-}
-
-static unsigned int get_tag(struct nullb_queue *nq)
-{
-	unsigned int tag;
-	do {
-		tag = find_first_zero_bit(nq->tag_map, nq->queue_depth);
-		if (tag >= nq->queue_depth)
-			return -1U;
-	} while (test_and_set_bit_lock(tag, nq->tag_map));
-	return tag;
-}
-... __alloc_cmd / alloc_cmd / free_cmd / end_cmd（queue_mode 分流）...
```

`get_tag` 就是那套「`find_first_zero_bit` + `test_and_set_bit_lock`」无锁位图——RTRS `__rtrs_get_permit` 借鉴的原型，本 commit 连同 `put_tag`、命令分配/释放、`end_cmd` 一起删。

### `end_cmd` 分流 → 直接 `blk_mq_end_request`

```diff title="drivers/block/null_blk/main.c（去掉 queue_mode 分流，内联 MQ 完成）"
 static enum hrtimer_restart null_cmd_timer_expired(struct hrtimer *timer)
 {
-	end_cmd(container_of(timer, struct nullb_cmd, timer));
+	struct nullb_cmd *cmd = container_of(timer, struct nullb_cmd, timer);
+	blk_mq_end_request(blk_mq_rq_from_pdu(cmd), cmd->error);
 	return HRTIMER_NORESTART;
 }
...
 static void null_complete_rq(struct request *rq)
 {
-	end_cmd(blk_mq_rq_to_pdu(rq));
+	struct nullb_cmd *cmd = blk_mq_rq_to_pdu(rq);
+	blk_mq_end_request(rq, cmd->error);
 }
```

`end_cmd` 那个 `switch (queue_mode)` 整个没用了——只剩 MQ，直接 `blk_mq_end_request`。

### `cmd->rq` → `blk_mq_rq_from_pdu(cmd)`

```diff title="drivers/block/null_blk/main.c（不再缓存 rq 指针，靠 pdu 取）"
 static int null_handle_rq(struct nullb_cmd *cmd)
 {
-	struct request *rq = cmd->rq;
+	struct request *rq = blk_mq_rq_from_pdu(cmd);
 ...
-static void null_queue_rq(...) {
 ...
-	cmd->rq = rq;            # 不再赋值
```

bio 路径在 `cmd` 里缓存了 `cmd->bio` 和 `cmd->rq`（两种来源）；删 bio 路径后 cmd 永远从 blk-mq request 来，`rq` 直接用 `blk_mq_rq_from_pdu(cmd)` 取，`nullb_cmd` 里省掉 `rq`/`bio` 字段。

### `NULL_Q_BIO` 枚举 + `queue_mode` 保留

```diff title="drivers/block/null_blk/main.c（枚举保留，仅用于错误报告/debugfs）"
+/*
+ * Historic queue modes.
+ * These days nothing but NULL_Q_MQ is actually supported, but we keep
+ * the enum for error reporting.
+ */
+enum {
+	NULL_Q_BIO	= 0,
+	NULL_Q_RQ	= 1,
+	NULL_Q_MQ	= 2,
+};
```

commit message 明说：`queue_mode` 字段留着比拆掉简单（拆了得两处查值 + 给 debugfs helpers 全 open-code，因为现有 helper 要 named struct member）。

## Review

- 作者 **Christoph Hellwig**（`hch@lst.de`）—— block 层核心维护者、常年大扫除式重构主力。`Reviewed-by: Damien Le Moal / Hannes Reinecke / Johannes Thumshirn`，`Tested-by: Damien Le Moal`——block 侧审查齐全。
- `Link: https://lore.kernel.org/r/20240220093248.3290292-2-hch@lst.de`（见 meta 行 patch 链接）。
- 由 **Jens Axboe**（block 维护者）`Signed-off-by` 收口，经 `Merge tag 'for-6.9/block-20240310' of git://git.kernel.dk/linux`（2024-03-11）进 Linus 主线，首见于 v6.9-rc1。

## 问题

### 为什么要删 bio 路径

null_blk 同时养两条 I/O 路径，复杂度都花在「让数据结构兼容两套」上：`nullb_cmd` 得同时容纳 `bio` 和 `rq` 两种来源、`end_cmd`/`nullb_complete_cmd`/`null_handle_memory_backed` 处处 `switch (queue_mode)` 分流、还多一套 `nullb_queue`（位图 + cmds + waitqueue）。而 bio 路径的典型用户是 stacking 驱动和简单内存驱动——后者 `brd` 已是现成范例，没必要在 null_blk 里再存一份。删掉既简化驱动、缩每命令结构，又让日后 block 层 API 改动不必再迁就 null_blk 这套双 API。

### 为什么留 `NULL_Q_BIO` 枚举和 `queue_mode` 字段

纯为省事：`queue_mode` 是个带 debugfs helper 的 named 字段，拆了得在两处查值 + 把 debugfs helper 全 open-code（现有 helper 依赖 named member）。留着枚举做错误报告（设了 bio 也能礼貌地报，而不是直接 build break），代价小于拆。

## 意义与影响

- **简化 null_blk**：从双 I/O 路径收敛到单一 blk-mq，删掉 ~260 行 bio 路径代码 + `nullb_queue`/`tag_map`/`cmds[]`/`cmd->bio`/`cmd->rq` 等结构，每命令数据结构显著瘦身。
- **顺带删掉无锁位图 tag 分配**：`get_tag()`/`put_tag()` 这套「`find_first_zero_bit` + `test_and_set_bit_lock`」写法从 null_blk 消失——但它已被 RTRS `__rtrs_get_permit()` 带走并在那边存活（[0c5549](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-0c5549-rtrs-clt-find-next-zero-bit) 还把它从 `find_first` 优化成 `find_next`）。同一种 lockless bitmap 模式，在 null_blk 这头被删、在 RTRS 那头被改。
- **为 block 层 API 演进扫障**：null_blk 是 block 层接口的「试验田」，去掉双 API 后，日后改 block 层接口不必再为 null_blk 的 bio 路径单独适配。

## 参考

- **patch 线程** [lore.kernel.org/all/20240220093248.3290292-2-hch@lst.de](https://lore.kernel.org/all/20240220093248.3290292-2-hch@lst.de/)（Christoph Hellwig, 2024-02-20）：本 commit 的来路。
- **brd 驱动** `drivers/block/brd.c`：commit message 点名的「简单内存驱动范例」——bio 路径删了之后，这类用例由 brd 承担。

## 相关阅读

- **rtrs permit 分配改用 find_next_zero_bit 避免竞态后重扫** —— [Linux commit-0c5549](/vibe-reading/articles/OS/Linux/Contributions/linux-commit-0c5549-rtrs-clt-find-next-zero-bit)：本 commit 删掉的 `get_tag()`/`put_tag()` 的「幸存者」。RTRS `__rtrs_get_permit()` 借鉴了 null_blk `get_tag` 的无锁位图写法，并在 0c5549 里把 `find_first_zero_bit` 优化成 `find_next_zero_bit`——同一种模式在 null_blk 这头被删、在 RTRS 那头被改，两篇对照可见 lockless bitmap tag 分配的来龙去脉。
- **Block I/O 子系统** —— [Linux CodeWiki 7.1 · 05-block-io](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/05-block-io)：block 层（blk-mq、request/bio、tag 分配）的 CodeWiki 解读，null_blk 的双路径与 tag 分配模式正处其中。
- **驱动模型与基础设施** —— [Linux CodeWiki 7.1 · 12-driver-model](/vibe-reading/articles/OS/Linux/CodeWiki/7.1/12-driver-model)：platform/块驱动注册模型，null_blk 的 probe/queue setup 框架可对照。
