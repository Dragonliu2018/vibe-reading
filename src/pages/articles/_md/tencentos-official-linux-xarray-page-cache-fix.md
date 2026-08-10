---
title: "Linux之父都“不明觉赞”的一个内核优化与修复历程"
source:
  type: "article"
  project: "TencentOS"
  url: "https://mp.weixin.qq.com/s/9ptzzWuBYwO4HbYVqs9vQA"
  author: "腾讯技术工程"
  site: "腾讯技术工程 微信公众号"
date: "2026-08-10T21:55:39+08:00"
category: ["OS", "Linux", "Blogs"]
tags: ["Linux Kernel", "Xarray", "Page Cache", "Race Condition", "Large Folio", "TencentOS", "Linus Torvalds", "内核优化", "LTS"]
description: "TencentOS 内核团队 4 月提交的 2 个 commit，在社区正式重视 Page Cache 数据损毁 Bug 前默默完成修复并优化了性能，被 Linus Torvalds 评价为“不明觉赞，祝顺利”。本文由浅入深解析 Xarray、Page Cache 底层原理与问题来龙去脉。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Linux之父都“不明觉赞”的一个内核优化与修复历程](https://mp.weixin.qq.com/s/9ptzzWuBYwO4HbYVqs9vQA) · **作者** 腾讯技术工程 · **来源** 腾讯技术工程 微信公众号 · **原文发布** 2024-12-09 · **转载** 2026-08-10

---

导语 随风潜入夜，润物细无声，TencentOS内核团队今年4月在Linux社区提交的2个commit，在社区正式重视 Page Cache 问题前的几个月前，默默完成了 Bug 的修复并优化了性能。TencentOS内核团队的 Patch 被公认为最佳修复， Linus Torvalds 更评价其“不明觉赞，祝顺利” 。本文将由浅入深解析底层原理，厘清问题的来龙去脉。

## 一、“悄然消失的内核问题”

大概两个月前，一封名为《Known and unfixed active data loss bug in MM + XFS with large folios since Dec 2021 (any kernel from 6.1 upwards)》在社区引起了一定的关注，其内容也在笔者的朋友圈以有点过度反应刷了一小波屏：自 2021 年起（6.1 内核发布起），Linux 内核中启用了 Large folio 特性的 XFS 文件系统（但不仅限于 XFS）有概率遭遇数据损毁问题。这乍看上去是一个颇为严重的 Bug，也确实引得了多个顶级 Maintainer 的关注和排查。实际上该 Bug 较难触发，但也确实让社区和各大一线厂家很是头痛，Meta，Cloudflare 都表示自己遇到过该问题，并已经 Revert XFS 的 Large Folio 特性，这才能保证内部系统的稳定性。

一个多星期的讨论中，社区并没有得出明确结论或有效的重现方法，几位顶级 Maintainer，包括 Matthew Wilcox（Folio，Xarray 等一系列核心组件作者），Jens Axboe（IO_uring，CFQ 调度器等作者），以及 Linus Torvalds 本人也参与进入讨论，目光都聚焦在了 Xarray 部分。不过大家都迟迟没有捕捉到 Bug 所引发的具体位置或线索，只是确认 Bug 确实存在而且亟需修复。

在社区排查过程中，Jens Axboe 却发现这个问题已经在最新的 Linux 内核上悄悄消失了。而相关的改动基本只有两个 commit，这两个 commit 是TencentOS内核团队在今年 4 月份提交的。这也让后续讨论基本就开始围绕这两个 commit 展开，遇到过该问题的厂商与社区活跃开发者也开始以这两个 commit 为基础进行讨论，验证与复现。不过社区的大佬们也还是花了不少时间，才最终搞清楚问题的来龙去脉，以及这两个 commit 到底修了什么。

![TencentOS 内核团队提交的两个 commit](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/commits.png)

有趣的是这两个 commit 的作者对问题和讨论并未注意到。在约一星期后，在 LPC 参会时现场遇到了参与和关注该问题的一些 Maintainer 与开发人员。闲谈之余才回过神来，TencentOS内核团队确实发现过并已修复了这个问题。

我们在优化 Page Cache 时想到过的一个潜在 Race Condition，但由于比较繁忙，并没有特别去做 reproduce 来验证，而是直接在一个优化中修复了，并添加了相关 comment。在讨论中社区也注意到了当时留下的 comment，并猜测这是问题的根源：

![代码中留下的 Race Condition 注释](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/race-condition-comment.png)

（在非持锁阶段 XArray 的内容可能会发生变化，因此如果发现变化，需要撤销上次的分配，稍后详解）：

![XArray 非持锁阶段内容可能变化的注释](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/xarray-change-comment.png)

经过再三的讨论与验证，TencentOS内核团队的 Patch 被公认为最佳修复，全程参与了讨论的 Linus Torvalds 也给出了“不明觉赞，祝顺利”的评价：

![Linus Torvalds 的“不明觉赞”回复](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/linus-reply.png)

几个 commit 也被建议合入 Linux LTS。笔者提交了经过简易修改的三个 Commit 供 LTS 版本使用，现修复并已经一并合入 6.1 LTS，6.6 LTS，以及 TencentOS Kernel。TencentOS Kernel 4 不受影响，TencentOS Kernel 5 则已合入了该补丁，为业务提供稳定的基石。

随风潜入夜，润物细无声。这并不是我们第一次解决内核中的隐藏问题或疑难问题。随着 Tencent OS “悟净” 内存节省技术对 Linux 内核内存管理领域的深究与不断保持与社区的紧密合作，在 Swap，Memory Cgroup，页面与热度管理等领域，我们一直有着长期的上游贡献，也有更多的未来规划。这不仅让我们对 Linux 内核内存管理的应用与落地不断深入，同时也回馈了社区。

借此机会，让我们深入了解下 Page Cache，Xarray，和这个问题的底层细节。

## 二、从Xarry的基础讲起

这次出现的问题其实是一个并不罕见的内存安全问题。出现问题的组件是 Linux 内核的 Page Cache 机制，也是内核最核心的功能之一。

Linux 内核的 Page Cache 是由 Radix Tree 管理的，Radix Tree 在内核中通过 Xarray 机制进行了很好的包装，Xarray 提供了简单易用的仿数组 API，让大部分内核组件可以像使用数组一样使用 Radix Tree。用户可以简单通俗的可以将 Xarray 抽象理解为一个很灵活而巨大 long / void * 数组，其 Index 范围为 unsigned long。

Xarray 也提供了更复杂的高级 API，从而实现了诸如 Multi Index 复用树节点，避免重复走树等高性能特性，来更好利用 Radix Tree 的一些天生特性。Linux 内核的 Page Cache 机制便是对 Xarray 的高级 API 利用最充分的地方之一。特别是在 Large Folio 引入后，Xarray 可以在一些场景中大幅度降低树的高度，降低内存使用，提升性能，不过这也是这次出现问题的地方。要了解这次问题的来龙去脉，让我们从 Xarray 的基础讲起。

### Xarray介绍

Xarray 基础概念并不复杂，正如上文提到，可以将其抽象理解为一个灵活的数组。这里我们将数组中存储的元素称之为 Entry，数组元素由 Index 索引。故 Xarray 便是维护了 Index 为 Key，Entry 为 Value 的 Radix Tree 关系，且有一些基本 API 与约定：

它的 Index 可以是 unsigned long 表达的任意整数，我们这里约定为 64 位环境，即 Index 必须为 64 位整数。而数组元素 Entry 的存储类型为 void *，即 Entry 也必须是 64 位，Entry 默认值为 NULL（0）。

Xarray 的基本 API 所暴露的基本只有 Index 和 Entry 的概念。为了更深入了解，这里 Xarray 中可以存储一个 Entry 的基本单位可称之为 Slot ，一个 Slot 中存储的 Entry 可以是一定范围内的整数值 Value（ 0 - LONG_MAX），或 Byte 对齐的指针 Pointer（Byte 对齐的 Pointer 末尾 3 位必为 0），或空缺值默认为 NULL（0），或 Xarray 内部值。注意到存储的 Entry 数据有一定限制，是因为 Xarray 会利用存储值的最后几位 Bit 记录额外的信息，用于辨别 Entry 的类型。这也让 Xarray 有能力告知调用者一个 Index 所对应的 Slot 中的 Entry 是什么类型的（Value，Pointer 或 NULL）。同时 Xarray 还可以利用数据最后的 Bit 实现 Tag 等特性，也有一些特殊保留值，我们暂时跳过。

Xarray 最基本的 API 如下：

```c
void xa_init(struct xarray *xa)
void xa_store(struct xarray *xa, unsigned long index, void *entry, gfp_t gfp)
void *xa_load(struct xarray *xa, unsigned long index)
```

很容易理解，使用这几个函数即可在一个 Xarray 中完成以 64 位整数为 Index 的 long / void * 数据（Entry）存储和读取，若要删除一个 Index 中的数据，存入 NULL 即可。注意存储整数值 Value 的时候需要用 xa_mk_value(value) 进行包装和 Cast 到 void *。

### Xarray 的内部实现

Xarray 的顶层包装为一个 struct xarray。其内部最基本的结构为 struct xa_node。一个 xa_node 有 XA_CHUNK_SIZE（默认 64，2 ^ 6）个 Slot，即一个 64 元素的 void * 数组，每个 Slot 可以存入一个实际的 Entry 或指向下一级 xa_node（或特殊值，暂时忽略）。

![xa_node 结构：64 个 Slot](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/xa-node-structure.png)

在存储一个 Index -> Entry 时，可以想像，将 64 位的 Key 分割为 6 bit 一级的 offset，每一级 offset 便可以使用一个 xa_node 进行记录。每 6 bit offset 对应的 slot 指向下一级 xa_node，便可以使用该结构以树状组织多个 Index 到 Value 的关系，提供快速查找。

我们不妨利用一个实际的例子来理解：比如，我们要存储一个 Pointer（0xffff1234deadbeef），使用的 Index 为 8772，则其对应的 Xarray 拓扑结构展开如下：

![Index 8772 的 Xarray 拓扑结构](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/xarray-topology-8772.png)

首先将 8772 对应的二进制表达分割为 6 bit 一级，高位全部为 0 ，最后有效的三组为 000010 001001 000100。

对于重复的 0，不需要分配 xa_node，这只需要在顶层的 xa_node 中记录 shift 即可表达（这也就可以理解，为什么 Xarray 对于 Index 比较小的值性能会更好），该例子中 shift = 12，即表示该 xa_node 对应的 64 bit 中从第 13 bit 到 18 bit 这一段的 offset（000010）。也可以理解为该 xa_node 覆盖了 0 - 262143（2 ^ (12 + 6) - 1） 这一范围；而其中每一个 Slot 又分别对应了对应的子范围：offset 为 2 的 Slot 对应范围为 8192 (0 + 4096 * 2) 至 12287 ( 0 + 4096 * 3 - 1) 这一范围；8192 至 12287 这一 Node 中又有第 9 个 Slot 对应了 8768（8192 + 64 * 9）至 8831（8192 + 64 * 10 - 1）这一范围，当一个范围有数据时才有必要分配下一级 xa_node 或存入 Entry。

每个 node 都会记录 shift 和其在 parent 中的 offset 等等信息，以实现各种复杂操作，这里不做赘述。

上面例子可见，存储 Index 8772 到 Pointer 0xffff1234deadbeef 这一数据一共需要三个 xa_node 结构进行表示。

### Xarray 读取

Xarray 的读取是一个查找的过程，从顶向下逐级走树。Xarray 会循环使用 6 bit 作为 offset 查询当前级别对应的 Slot 便可一路走到对应的 Slot。

![Xarray 读取过程](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/xarray-read.png)

Xarray 使用 xa_state 这一结构维持走树查询的中间状态。xa_load 函数包装了整个读取走树过程。在调用 xa_load 时会在栈上生成一个 xa_state，并重复调用 xas_start，xas_decend 等内部函数来一层层向下查找，如上图所示。在每一层 Node 上使用对应的 offset 向下读取 slot 中记录的下一级 xa_node，直到读到 slot 为一个值而非 node 或走到最底层时即完成了查找过程。

同时为了照顾一些特殊调用者，避免重复的走树操作，Xarray 允许将 xa_state 暴露出来，让用户手动使用如 xas_load 这样的 API 手动维护 xa_state：

```c
XA_STATE(xas, xa, index);
void *entry;

rcu_read_lock();
do {
	entry = xas_load(&xas);
} while (xas_retry(&xas, entry));
rcu_read_unlock();
```

在 xas_load 后，xas 会保持指向 xa_node，可以通过 xas_reload 等操作，在一些特殊场景避免重复的从向上下走树这一过程。另外 Xarray 中的数据是被 RCU 保护的，因此读取时只需要获取 RCU 锁即可（这里 xas_retry 就是为了防止撞上正在被释放的 node）。

### Xarray 存入

Xarray 的存入是个类似的过程，不过比较特殊的是查找需要处理 xa_node 的分配，其他过程雷同：

![Xarray 存入过程](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/xarray-store.png)

由于存入会修改 Xarray，因此必须使用锁进行保护（xa_lock & xa_unlock）。这一点和 xa_node 的分配有一定的冲突，因为在锁临界区中进行内存分配可能会失败。不过 Xarray 在存入时依旧维护了 xa_state 这一结构来记录当前存入的层级，这就让 Xarray 可以解锁后重新尝试分配内存，再上锁后继续使用当前的 xa_state 进行存入，从而提高存入成功率。

xa_state 这个暂存结构留有相关字段用于传递错误信息和分配信息：这里用 xa_store 所对应的高级 API xas_store 可以很好的说明它在存入时处理内存分配的用途和用法：xas_store 会在内部使用 xas_alloc 尝试进行内存分配，分配失败时会通过 xa_state 向调用者返回 ENOMEM。此时用户需要手动管理 xa_state，并使用 Xarray 提供的 xas_nomem 这个函数，即可方便实现在释放锁后再次重试分配内存，并再次调用 xas_store 这样的操作：

```c
XA_STATE(xas, xa, index);
void *old;
do {
	xas_lock_irq(&xas);
	old = xas_store(&xas, xa_mk_value(value));
	xas_unlock_irq(&xas);
} while (xas_nomem(&xas, GFP_KERNEL));
```

如上代码便会在 xas_store 因内存分配失败而通过 xa_state 返回 ENOMEM 时，释放锁并重试内存分配，直到成功存入 Index -> Value（实际上 xa_store 内部也基本上使用了一样的处理逻辑，以保证存入的成功）。

这里需要注意的一点是，xa_state 用于记录暂时分配的 xa_node 的是 .xa_alloc 这一字段，xas_store 则会优先使用 xa_state 中暂存的分配。如果由于发生了其他错误而不得不放弃存入，xas_nomem（隐式调用 xas_destroy）来释放 xa_state.xa_alloc 防止内存泄露。

### Xarray Multi Index

由于每个 xa_node 有 XA_CHUNK_SIZE （64）个 slot，也就是最多存储 64 个值，所以如果有 64 个连续的 Key，则 Xarray 可以不分配整个 xa_node，直接在 parent 的 slot 中标记整个 range 为一个值，如下：

![Multi Index Entry](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/multi-index-entry.png)

在存储一系列连续的 Index -> Entry 时，其中连续的大于 2 ^ 6 且对齐的部分可以直接跳过下一级 xa_node 的分配，直接在对应的 slot 中存入 entry 来表达这一系列的 slot 均为同一 entry。这样可以显著降低连续 Key 所占用的内存与搜索时间。这一特性称作 Multi Index Entry。值得一提的是在 Linux 内核实际使用中 Xarray 的Multi Index Entry 特性需要用户使用高级 API 来显式地存储一个 Order > 1 的 Entry 才能使能，并且 Index 必须对齐 2 的整数方倍。

Multi Index 的场景会有一个特殊问题：例如，若如果这个 Multi Index Entry 覆盖的范围的的值只有一个值需要修改的话，那整个Multi Index Entry 需要先分解为普通的由 xa_node 组成的扁平 slot 保存的普通 entry 才行，Xarray 也提供了相关函数和操作范式：

![Multi Index Entry 的 Split](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/multi-index-split.png)

其中又涉及了 xa_node 的分配问题。调用者需要首先获取 entry 的 order，随后在锁外使用 xas_split_alloc() 为其分配所需的 xa_node，再通过上锁后调用 xas_split 完成对这个 Multi Index Entry 对应的 slot 的 update，才可以再进一步修改子范围内的 Entry。

另外，对于小于 2 ^ 6 的范围的 Multi Index，其无法跳过整个 xa_node 的分配，Xarray 会使用 Sibling Slot 来让多个 Index 指向同一个 Entry：

![Sibling Slot](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/sibling-slot.png)

Xarray 会将多个 Slot 记录为 Sibling Slot 并指向最低位的 Slot，其中再保存 Entry。不过这种用法我们在此文章中将暂时忽略。

Xarray 自然可以存储混合的 Multi Index 和单一 Index。

在 Page Cache 中，很容易想到，基于 Xarray 的 Page Cache 可以利用 Multi Index 特性来避免为 order 6（256K）以上的大页面分配多余的 xa_node，从而降低树深度，降低内存消耗，提高性能。但需要注意的是，Page Cache 中的页面和信息都是是可以被拆碎的，所以 Page Cache 也会需要处理 Multi Index entry 被 Split，并为其分配内存这一过程。

Multi Index Entry 的分解和内存分配便是这次的问题出现的地方。

### Page Cache 对 Xarray 的使用

Page Cache 可以视为是一个以文件内部的 Offset 为 Index 的 Xarray，它会存储两种 Entry：页面（Folio / Page）或 Shadow（注：由于历史原因 Page / Folio 两个名字的使用在代码和注释中会略有混淆，其本质没有区别，并不影响理解）。

Page Cache 中的页面 Entry 即为保存文件数据的文件页，而 Shadow 是页面从 Page Cache 中被淘汰后所留下的一个标记：Shadow 用于在发生页面再入读入时计算页面热度和 Workingset 相关信息，辅助 LRU 进行 Page Cache 热度管理，从而在内存有限时优先存储更常用的数据，提高 Page Cache 的缓存命中率。其具体原理我们在此文章中不做赘述，可以参考内核代码 mm/workingset.c 文件中的长篇注释。

内存页面（Folio）或 ·

具体落实到 Xarray 中，Shadow 使用 Value 表示，页面使用 Pointer 表示。因此通过让 Xarray 检测一个 Slot 中存储的是 NULL， Value，还是 Pointer，即可知道 Page Cache 中这一 Offset 对应的文件缓存目前是“未缓存”，“已被淘汰”，还是“被缓存”的状态。

有了以上这些背景知识，我们不妨直接从 v6.9 及以前版本的 Linux 内核 Page Cache 插入代码看起。Page Cache 在插入页面时，大量使用了 Xarray 的高级 API。我们这里提供一份删去统计计数与 Trace 相关逻辑的精简（伪）代码，其非常完好地概括了 Page Cache 的插入流程：

```c
int __filemap_add_folio(struct address_space *mapping,
		struct folio *folio, pgoff_t index, gfp_t gfp, void **shadowp)
{
	/*
	 * 设置 xa_state 中的 index，并让其指向文件对应的 Xarray。
	 * 每个文件的 inode 都有自己的 Xarray（&mapping->i_pages）来记录
	 * 文件中 offset 到 Page Cache 数据页或 Shadow 的关系。
	 */
	XA_STATE(xas, &mapping->i_pages, index);
	/*
	 * 如果是大页（high order folio），有 folio_order > 1，这里告知
	 * Xarray 使用 Multi-Index 模式进行存储。
	 */
	xas_set_order(&xas, index, folio_order(folio));
	do {
		/*
		 * （1）这里 xa_get_order 会进行一次完整无锁走树，获取 index 对应
		 * 的 entry 的 order。这里是为了下方可能需要的 split 做准备。< ①  >
		 */
		unsigned int order = xa_get_order(xas.xa, xas.xa_index);
		void *entry, *old = NULL;

		/*
		 * （2）如果当前 index 对应的 entry 为 multi-index 且 order 大于
		 * 新需要插入的 folio，则需要进行 split，故需要先在锁外使用
		 * xas_split_alloc 分配所需内存（分配 xa_node 放入 xas.xa_alloc）。
		 *
		 * 新分配 xa_node 中 slot 的默认值为当前 index
		 * 对应 entry 的值，由这里的 xa_load 获取 < ②  >。
		 *
		 * 这里对应的场景是：一个高 order folio 被淘汰时会留有一个
		 * 高 order shadow，此时如果被淘汰的 folio 只有部分子
		 * folio 被读入，则需要将高 order shadow entry 进行 split，
		 * 并在 Xarray 子范围内，存入读入的 folio，这样后续的其他子
		 * folio 被读入时仍旧能找到对应的 shadow 信息。
		 */
		if (order > folio_order(folio))
			xas_split_alloc(&xas, xa_load(xas.xa, xas.xa_index),
					order, gfp);
		/*
		 * （3）获得 Xarray 锁，防止并发修改，开始进行插入。
		 * 下方的所有操作都将是可靠无竞争的。
		 */
		xas_lock_irq(&xas);
		/*
		 * （4）再次走树遍历并检测要存入的 index -> folio 覆盖区域内有无现存
		 * 的任何 folio。< ③  >
		 * 若有 Pointer（xa_is_value == false），则说明已经有部分
		 * 数据被放入 Page Cache，返回 -EEXIST 让调用者处理这一情况。
		 * 如存在 Value（xa_is_value == true），则说明这里有 Shadow。
		 * 暂存到 old 变量中稍后并返回给调用者让其处理热度信息。
		 */
		xas_for_each_conflict(&xas, entry) {
			old = entry;
			if (!xa_is_value(entry)) {
				/*
				 * Xarray 内部错误会存储在 xa_state 上，
				 * 外部错误也可以通过 xas_set_err 存入，
				 * 并最后由 xas_error 获取和返回。
				 */
				xas_set_err(&xas, -EEXIST);
				goto unlock;
			}
		}

		/*
		 * 如果代码执行到此处，old 必然为一个 shadow。
		 */
		if (old) {
			/*
			 * 将 shadow 信息返回给调用者。
			 */
			if (shadowp)
				*shadowp = old;
			/*
			 * （5）这里再次检测现存 entry 的 order，因为 entry 可能在上面
			 * xa_get_order 走树之后，获取锁之前，已经被 split 或修改了。
			 * 这里需要再次使用 xa_get_order 走树查询当前 shadow 的 order。
			 * < ④  >
			 */
			/* entry may have been split before we acquired lock */
			order = xa_get_order(xas.xa, xas.xa_index);
			/*
			 * （6）如果 order 仍旧大于 folio，说明该 shadow entry 未被
			 * split，对其进行 split 。否则跳过 split。目前 split 必会分解为 order 0.
			 */
			if (order > folio_order(folio)) {
				/*
				 * 使用之前 xas_split_alloc 所分配的
				 * xa_node 填充和分解 Multi Index Entry。
				 */
				xas_split(&xas, old, order);
				xas_reset(&xas);
			}
		}

		/*
		 * （7）需要 split 的场景已经在上面处理，
		 * 这里则是一个普通的 Xarray 插入操作。< ⑤  >
		 */
		xas_store(&xas, folio);
		if (xas_error(&xas))
			goto unlock;
unlock:
		/*
		 * （8）释放锁。
		 */
		xas_unlock_irq(&xas);
		/*
		 * （9）如果上面的插入因为分配内存失败而在 xa_state
		 * 中标记了 ENOMEM，xas_nomem 会捕捉到这一问题
		 * 并重试申请，如果申请成功，会从循环开头重试。
		 * 如果发生了其他问题，xas_nomem 会释放可能存在
		 * 的 .xa_alloc 数据。
		 */
	} while (xas_nomem(&xas, gfp));

	if (xas_error(&xas))
		goto error;
	return 0;
error:
	return xas_error(&xas);
}
```

述代码可以大致总结为如下步骤：

1、获取当前 Page Cache 中 Index 所对应的 Entry Order（ ① ）。

2、如果 Entry Order 大于要新插入的 Folio Order，在锁外分配 split 所需的 xa_node，用当前 entry 填充并暂存入 xas.xa_alloc（ ② ）。

3、锁住 Xarray。

4、（上锁后）检查要新插入的 Index -> Folio 所覆盖的范围内有无现存 Folio，若有跳至步骤 8 （ ③ ）。

5、（上锁后）再次检查当前 Index 对应的 Entry Order，防止上锁前发生变更（ ④ ）。

6、（上锁后）如果 Entry Order 仍旧大于 Folio Order，Split，使用步骤 2 分配的 xa_node。

7、（上锁后）已经处理可能需要 Split 的场景，直接存储 Index -> Folio（ ⑤ ）。

8、解锁 Xarray。

9、如果步骤 7 在锁内分配 xa_node 失败了，重试分配，存入 xas.xa_alloc 并从头再开始。如果步骤 4 或 7 因为其他原因失败了，释放可能存在的 xas.xa_alloc 并返回错误。

以上便是 6.9 以前内核的 Page Cache 插入逻辑，虽然是 Linux 内核热度很高的一个核心路径，但其中潜藏了一个 Bug 和性能问题。

## 三、问题发生

不知读者是否注意到，在上文代码中介绍的 6.9 和以前版本的 Linux Kenel Page Cache 插入流程中，每次插入至少有三次 Tree Walk。即使是不需要 Split 的场景，① ③ ④ 都是独立发生的 Tree Walk，因为其不共享 xa_state。如果发生了 split，② 也会进行走树，同时 xas_reset 重置 xa_state 导致 ⑤ 也会是独立的走树：一共有 5 次独立的 Tree Walk。这其实是都不必要的，也是我们最开始注意到的问题。

在审阅 Linux 内核核心路径代码时，我们注意到了这一冗余的 Tree Walk，并认为这一点作为内核最核心的路径之一，是非常值得优化的，因此经过几个迭代和测试，对插入逻辑进行了如下重构（已经合入 v6.10）：

```c
int __filemap_add_folio(struct address_space *mapping,
		struct folio *folio, pgoff_t index, gfp_t gfp, void **shadowp)
{
	/*
	 * 设置 xa_state 中的 index，并让其指向 Xarray 的顶部节点。
	 * 每个文件的 inode 都有自己的 Xarray（&mapping->i_pages）来记录
	 * 文件 offset 到 Page Cache 数据页或 Shadow 的关系。
	 */
	XA_STATE(xas, &mapping->i_pages, index);
	/*
	 * 一些稍后会用到的中间变量，表示由 xas_split_alloc 所分配
	 * 的 xa_node 所对应的 order 和内部填充的 entry（必为 Shadow）。
	 */
	void *alloced_shadow = NULL;
	int alloced_order = 0;
	/*
	 * 如果是大页（high order folio），有 folio_order > 1，这里告知
	 * Xarray 使用 Multi-Index 模式进行存储。
	 */
	xas_set_order(&xas, index, folio_order(folio));
	/*
	 * 循环开始，直到插入成功或发生内存分配失败以外的错误。
	 */
	for (;;) {
		int order = -1, split_order = 0;
		void *entry, *old = NULL;
		/*
		 * （1）这里直接锁住 Xarray。随后走树遍历（2），检测要存入的
		 * index -> folio 覆盖区域内有无现存的任何 folio。< ①  >
		 */
		xas_lock_irq(&xas);
		xas_for_each_conflict(&xas, entry) {
			/*
			 * 若有 Pointer（xa_is_value == false），则说明已经有部分
			 * 数据被放入 Page Cache，返回 -EEXIST 让调用者处理这一情况。
			 */
			old = entry;
			if (!xa_is_value(entry)) {
				xas_set_err(&xas, -EEXIST);
				goto unlock;
			}
			/*
			 * 如存在 Value（xa_is_value == true），则说明这里有
			 * Shadow。暂存到 old 变量中稍后并返回给调用者让其处理
			 * 热度信息。
			 *
			 * 注意此时 xas_for_each_conflict 所暴露和维护的 xa_state
			 * 必然是指向 shadow 所在的 xa_node 的，所以我们可以直接
			 * 通过 xa_state 拿到 shadow entry 的 order。
			 *
			 * 这里引入了一个新的 helper：xas_get_order 直接利用
			 * xa_state 获取该 entry 的 order，避免还需重新走树。
			 */
			if (order == -1)
				order = xas_get_order(&xas);
		}

		/*
		 * （3）这里是针对第二次和之后的循环的一个步骤。
		 * 第一次循环这里 alloced_order 必为 0，什么都不会发生。
		 *
		 * 对于需要 split 的情况，必然需要 xas_split_alloc 进行
		 * 内存分配，这个分配会发生在更下方，并会记录当时分配
		 * 所对应的 order 到 alloced_order 中表示已经分配。
		 *
		 * 由于 xas_split_alloc 分配发生在锁外，其分配的 xa_node
		 * 对应的 shadow order 或 shadow value 可能都已经发生变化，
		 * 这里检测是否发生了变化，如果发生了，则清理分配数据。
		 * 并标记 alloced_order 为 0 表示没有可用 split 使用的内存。
		 */
		if (alloced_order && (old != alloced_shadow || order != alloced_order)) {
			/* xas_destroy 会清理和释放无效的 xa_node */
			xas_destroy(&xas);
			alloced_order = 0;
		}
		/*
		 * （4）如果代码执行到此处，old 若有值则必然为一个 shadow，
		 * 也是可能需要 split 的情况。
		 */
		if (old) {
			/*
			 * 这里的 order 是在获取 Xarray 锁后获得的所以是可靠的，
			 * 不需要重新检查 entry。所以只要 order 大于新插入 folio
			 * 的 order 就肯定是需要 split。
			 *
			 * order > 0 检查是一个优化，可以减少对页面信息的读取。
			 */
			if (order > 0 && order > folio_order(folio)) {
				/*
				 * 对于需要 split 的情况，第一次循环这里 alloced_order
				 * 必为 0，也就是没有可供 split 使用的内存。跳到解锁处
				 * 进行分配。
				 * 第二次以及往后的循环这里 alloced_order 若有值，
				 * 则必然等于 entry 的 order （不等于的场景已经被
				 * 步骤 3 处理)，可以安全进行 split。
				 * 若 alloced_order 为 0，说明 xas_split_alloc 从未执行
				 * 或者其分配的内存已经因为过期被步骤 3 释放，申请
				 * 分配对应 order 的内存，跳至步骤（6）。
				 */
				if (!alloced_order) {
					split_order = order;
					goto unlock;
				}
				/*
				 * 使用下方 xas_split_alloc 所分配的 xa_node 填充
				 * 和分解 Multi Index Entry。
				 */
				xas_split(&xas, old, order);
				xas_reset(&xas);
			}
			/*
			 * 将 shadow 信息返回给调用者。
			 */
			if (shadowp)
				*shadowp = old;
		}

		/*
		 * （5）需要 split 的场景已经在上面处理，
		 * 这里则是一个普通的 Xarray 插入操作。< ⑤  >
		 */
		xas_store(&xas, folio);
		if (xas_error(&xas))
			goto unlock;
unlock:
		/* （6）释放锁 */
		xas_unlock_irq(&xas);

		/*
		 * （7）在步骤 4 split 需要 xas_split_alloc 进行分配的
		 * 时候会在这里看到 split_order != 0。
		 * （第一次循环，或上次分配的内存被步骤 3 释放了）
		 *
		 * 尝试使用持锁时获取的 entry order (split_order)
		 * 分配所需的内存，并使用持锁时所记录的 entry 值填
		 * 充新分配的 xa_node。
		 */
		if (split_order) {
			xas_split_alloc(&xas, old, split_order, gfp);
			/*
			 * 在锁外内存分配也失败了，无法处理，返回错误。
			 */
			if (xas_error(&xas))
				goto error;
			/*
			 * 记录此时已分配的 xa_node 对应的 order 和 entry。
			 */
			alloced_shadow = old;
			alloced_order = split_order;
			/*
			 * 重开始循环。
			 */
			xas_reset(&xas);
			continue;
		}
		/*
		 * （8）如果上面的 xas_store 分配内存失败，则 split_order
		 * 必然为 0 且会走到这里，并且在 xas 中标记了 ENOMEM，
		 * xas_nomem 会捕捉这一问题并重试申请，如果申请成功，
		 * 会从循环开头重试，否则 break。
		 */
		if (!xas_nomem(&xas, gfp))
			break;
	}

	if (xas_error(&xas))
		goto error;

	return 0;
error:
	return xas_error(&xas);
}
```

代码大致可以分为下述步骤：

1、首先直接锁 Xarray。

2、（上锁后）遍历所需插入的 Index -> Folio 所覆盖区域，若有 Folio，直接返回 -EEXIST，若有 Shadow，直接利用遍历所用的 xa_state 获取 shadow 的值与 order。

3、（上锁后）检查步骤 8 （xas_split_alloc） 中分配内存所用的 order 和 shadow 是否和步骤 2 刚看到的一致，若不一致，标记分配为无效并释放分配。（步骤 3 在第一次循环时，步骤 8 从未发生过）

4、（上锁后）如果 shadow order 大于 folio order，若步骤 8 未执行或分配已失效，申请分配，跳至步骤 6，否则使用进行 split。

5、（上锁后）已经处理可能需要 split 的场景，直接存储 Index -> Folio ⑤。

6、解锁 Xarray。

7、如果步骤 4 申请了为 split 分配内存，在此处使用步骤 2 所获取的 shadow 和 order 通过 xas_split_alloc 分配 xa_node，并从头开始循环。

8、如果步骤 5 在存储时内存分配失败了，重试分配内存，并从头再开始循环。

新的插入逻辑确实更绕一点，不过在乐观情况下（实际测试中乐观情况占比几乎是绝对性的压倒的，即便是高压力的并发场景），若不涉及 split，只需要步骤 2 这里进行一次走树即可，这基本上已经是理论上的最佳方式，大大节省了 Page Cache 插入时的开销。而在需要 split 的场景，我们也节省了走树的次数。

通过这一优化，我们极大提升了大文件在 Page Cache 中的读入性能，一个简单的 fio 测试便有了约 10% 的性能提升，这一组 Patch 也以性能优化为由合入了 6.10。

![fio 性能测试：约 10% 性能提升](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/fio-benchmark.png)

### 问题的根源

那么，问题出在哪里呢？答案就是 xas_split_alloc：xas_split_alloc 分配的数据因为发生在锁外，所以其可能是过期的，并且过期数据必须及时释放。

v6.9 之前的插入逻辑中，虽然会检查 shadow 是否有过被 split，但如果已经发生了 split，它仅仅是跳过了对 split 的调用，并未释放 xas_split_alloc 可能产生的过期数据（6.9 中的步骤（6））。

通常过期数据未清理，可能会导致 leak，而非 corruption。但 Xarray 使用 xa_state 暂存分配数据，而 xa_state 中，xas_alloc() 和 xas_split_alloc() 都是使用 .xa_alloc 这一字段来记录所分配的 xa_node。这就导致在 6.9 的代码中，步骤 2 中xas_split_alloc() 所分配的过期数据可能会被步骤 7 中的 xas_store() 所使用（见 Xarray 存入处的解析，xas_store 可能会需要分配内存，并会优先使用 xa_state 中的分配数据），而导致 Xarray 中数据错误。

而在我们在新版本中，步骤（3）会检查 xas_split_alloc 分配的数据是否依旧和当前的 entry 完全对得上，并及时进行释放，让后面的 xas_store 不会看到 xa_state 中的过期信息而错误使用它，并加以 comment 记录了这一疑点，并且对 entry 值与 order 的完全匹配检查也杜绝了其他可能的问题。

不过由于工作比较繁忙，我们并没有过于纠结这一问题是否值得复现，而是与社区合作将这一变更以性能优化的名义进行了合入。

## 四、社区报告与修复

到了今年 9 月份，社区终于有人正式 highlight 了这一潜藏了许久的 Bug：

![社区正式 highlight 该 Bug 的邮件](/vibe-reading/images/articles/tencentos-official-linux-xarray-page-cache-fix/community-bug-report.png)

这个 Bug 本身复现概率很低，虽不能说是什么惊天问题，但这类 race 问题确实总是令人非常头痛，有时也会成为上游开发的 Blocker。因为缺乏 reproducer，同时没有有效的 debug 信息，社区很大程度上也只能盲猜。就像开头我们已经介绍过的，这一问题让社区的几位 Maintainer 都颇为困惑。不过由于我们的优化和 Fix Patch 已经在几个月前就合入了，上游开发并未受阻，Fix 也很快就回合到 LTS，最终为这一问题画上了句号，并顺带让更多运行 Linux 的设备，都能快那么一点点。
