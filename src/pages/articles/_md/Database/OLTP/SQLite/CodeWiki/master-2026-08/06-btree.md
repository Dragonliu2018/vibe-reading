---
source:
  type: "源码解读"
  project: "SQLite"
  url: "https://github.com/sqlite/sqlite"
title: "B-Tree 存储"
date: "2026-09-29T16:11:31+08:00"
category: [Database, OLTP, SQLite, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["SQLite", "C", "B-Tree", "存储引擎"]
description: "btree.c 11655 行：页面三段式布局、超额 cell 允许页暂时非法、balance 自叶向根传播、页号升序重排提速 25% 与 auto-vacuum ptrmap"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/SQLite/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`btree.c`（11655 行）是全库最大单文件，实现单数据库文件内的**所有** B-Tree（每张表一棵、每个索引一棵、sqlite_schema 一棵）。文件格式权威文档不在网上而在源码里：**btreeInt.h 第 1-215 行**（3.54 中已从 btree.c 迁出）。上层 vdbe 通过 `sqlite3BtreeXXX` C API 消费（全库约 741 处调用）；下层每个页经 pager 的 `DbPage` extra 区栖身。

## 模块架构

**数据库级共享 vs 连接级私有**是本模块最重要的结构分界：

| struct | 行号（btreeInt.h） | 级别 | 作用 |
| --- | --- | --- | --- |
| `BtShared` | :425 | **文件级**（多连接共享） | pPager、pageSize、溢出阈值四元组、游标链、mutex、pHasContent |
| `Btree` | :345 | 连接级 | db 回指针 + inTrans 三态 + wantToLock 嵌套计数 |
| `BtCursor` | :531 | 连接级（不可共享） | 显式页栈 `iPage+apPage[20]+aiIdx[19]` + eState 五态机（CURSOR_VALID/INVALID/SKIPNEXT/REQUIRESEEK/FAULT，:63-66 附近） |
| `MemPage` | :273 | 页级 | 存 pager extra 区；**xCellSize/xParseCell 函数指针**按页型多态 |

## 调用链路

```text title="一次查找（3.54 已拆为两个入口）"
sqlite3BtreeTableMoveto (btree.c:5837)      # 表：rowid 二分
├─ biasRight: append 场景先试右端
├─ 页内二分 (:5914-5954): lwr/upr/idx=(lwr+upr)>>1
│   只手写 varint 跳过 payload 字段读 rowid —— 无解码开销
├─ key 恰为上次+1 → 直接 BtreeNext 不回根 (:5868-5879)
└─ 内部页经 moveto_table_next_layer (:5964) 取子指针下沉

sqlite3BtreeIndexMoveto (btree.c:6068)      # 索引：record 比较
├─ indexCellCompare (:5996): 只看 cell 首 1-2 字节判断是否整页内
├─ 游标已在末页末 cell 且 key 更大 → 直接命中 (:6093)
└─ 溢出 cell 才 malloc 缓冲 + accessPayload (:5155) 拉全键
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `btreeInitPage` in btree.c:2248 | 页头解析 | 按页型给 xCellSize/xParseCell 装配实现（:2060-2110） |
| `allocateSpace` in btree.c:1846 | cell 空间分配 | 优先复用 freeblock；碎片率高走 defragmentPage |
| `insertCell` in btree.c:7363 | 插入 cell | **放不下不报错**——挂进 apOvfl[] 内存超额 |
| `balance_nonroot` in btree.c:8277 | 通用再平衡（~800 行） | 兄弟页页号升序重排提速 ~25% |
| `balance_quick` in btree.c:8039 | append 快路径 | 13 字节栈上 divider，零 malloc |
| `sqlite3BtreeInsert` in btree.c:9441 | 插入入口 | 同 rowid 同尺寸 → btreeOverwriteCell 原地覆写 |
| `relocatePage` in btree.c:3974 | auto-vacuum 页搬迁 | 靠 ptrmap 修正所有父指针 |

</details>

## 核心实现

### 页面格式（btreeInt.h:45-215）

**100 字节文件头**（仅页 1）：魔串 `"SQLite format 3\0"`、页大小、WAL 版本号、三个 payload fraction（**必须 64/32/32**，lockBtree 在 btree.c:3395 硬校验）、15 个 4 字节 meta 值（偏移 `36+idx*4`）。**页头** 8（leaf）/12（interior）字节：flags + 首 freeblock + cell 数 + content 起点 + **碎片字节数** + 右子指针。

**三段式布局**：页头 → cell pointer 数组（每 cell 2 字节偏移，**有序**，向下长）→ 未分配区 → cell 内容（**从页尾向页首长**）。这个"对向生长"布局的三个收益：(a) 插入只 memmove 便宜的 2 字节指针槽，**cell 体不动**——外部持有的 cell 指针跨操作稳定；(b) 空闲区连续，多数分配无需 defragment；(c) cell 体物理乱序无妨，有序性由指针数组维护。

**溢出判定**：`maxLocal=(usableSize-12)*64/255-23`、`minLocal=(usableSize-12)*32/255-23`（btree.c:3471-3474 计算）。超阈值时的本地保留量公式 `surplus = minLocal + (nPayload-minLocal)%(usableSize-4)` 的目标是**把最后一个溢出页尽量填满**——溢出链是纯顺序读，填满尾页比在主页留大 payload 划算。Why 有阈值：cell 若可占满整页，单页只装 1 个 cell，fanout 退化为 2，树高恶化到接近线性（btreeInt.h:90-99 注释保证 interior 页至少容 4 个 cell）。

### 超额 cell：允许页在内存中"暂时非法"

`insertCell()`（:7363）的招牌机制：页放不下新 cell 时**不报错也不立即分裂**，把 cell 挂进 `MemPage.apOvfl[]`（最多 3 个），cell pointer 数组照常插槽位——页在内存中虚拟超载，由后续 balance 落盘前解决。断言（:7404）证明超额 cell 必然有序且相邻（只来自 balance 向父页插 divider）。

这是"插入便宜、再平衡批量摊销"设计的支点：插入路径保持 O(1) 页内 memmove；批量 append 时 `balance_quick` 更是把分裂降为"开个新右兄弟页放这一条 cell"（divider 用 13 字节栈上缓冲）。

### balance 家族：自叶向根传播

`balance()`（:9162）是 do-while 循环，游标栈从当前页逐层弹向根。触发条件：`nOverflow>0`（超载）或 `nFree*3 > usableSize*2`（下溢）。根页超载 → `balance_deeper()` 新开子页树高+1；平衡后根空且唯一子页塞得下 → balance-shallower 树高-1。

通用路径 `balance_nonroot`（:8277，~800 行）的关键步骤：

1. 取**至多 NB=3 个兄弟页**（宏 :7551 注释："看似可调，实际从未测过其他值"）；
2. 全部 cell（含超额 + 剥掉子指针的 divider）装进 CellArray，计算切分点；
3. **反向再平衡**（:8647-8678）：把右侧过空页的 cell 左移——注释强调"这不是优化而是必需，否则最右兄弟可能完全空页而不合法"；
4. **页号重排**（:8742-8770）：O(N²)（N≤5）选择排序 + `sqlite3PagerRekey()` 把兄弟页号排成升序——注释："**仅此一项让大批量 insert/delete 快约 25%**"（范围扫描接近线性读盘，OS readahead 生效）；
5. 两遍 V 形顺序更新页面（:8944-981）：满足"cell 左移先更新左页"的数据依赖。

Why 自叶向根而非全局重平衡：一次插入只触碰 root→leaf 一条路径，B-tree 性质只要求局部修复；全局重平衡要 journal 大量无关页，与页级 rollback journal 事务模型冲突。

### 表 B-Tree vs 索引 B-Tree

表（`PTF_INTKEY|LEAFDATA`）：数据只存叶子，内部 cell 仅 `[子指针][rowid varint]`（`btreeParseCellPtrNoPayload` :1269）——内部节点极小、**fanout 极大、树极浅**；平衡时 divider 是右子页最大 rowid（现场合成，不占槽位）。索引（`PTF_ZERODATA`）：键全层复制——因为索引键本身就是内容；divider 是真实 cell 左移。

### deferred page 释放与 freelist

释放页进 freelist 时用 `sqlite3PagerDontWrite()` **不 journal**、复用时跳过读盘——两次省 I/O。但同事务内先释放再复用时若两步都不 journal，rollback 会丢原数据；`pHasContent` 位图（btree.c:640-695）记录"本事务进过 freelist 的页"，复用时命中则强制走 journal。freelist 本身是 trunk/leaf 两级：trunk 页 = next trunk(4B) + leaf 计数(4B) + N 个 leaf 页号。`freePage2()`（btree.c:6868）优先把释放页挂为首个 trunk 的 leaf（并调 `sqlite3PagerDontWrite()` 跳过 journal 该页）；trunk 满了才让释放页当新 trunk。

**auto-vacuum**：ptrmap 页每 5 字节一条（1 字节类型 + 4 字节父页号），任何页被移动时 O(1) 找到指向它的父页并改指针。auto-vacuum 库的新根页号必须 = meta[3]+1（根页集中在文件前部）；若该位置被占则 `relocatePage()` 搬迁原页。

### 锁协议（btmutex.c）

shared-cache 下 `sqlite3BtreeEnter/Leave`（:71/:143）对非递归 mutex 用 `wantToLock` 计数实现可重入；**多 Btree 按 BtShared 指针地址升序加锁**（pNext 链本身按地址有序），拿不到时 `btreeLockCarefully()`（:105）先释放地址更大的锁再等——全连接统一升序消除死锁。未启用 shared-cache 时全部编译为空宏（btree.h:405-411），单连接零开销。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 页型多态函数指针 | `MemPage.xCellSize/xParseCell` | 热路径（二分每步 parse cell）免去 switch |
| 游标状态机 + save/restore | BtCursor 五态；`saveAllCursors()` | 写操作移动他人游标时存 key 置 REQUIRESEEK |
| 双胞胎函数特化 | insertCell/insertCellFast、parseCell 四兄弟 | 手工内联换性能，注释要求"改一处必须同步另一处" |
| 乐观并发锁升级 | BtLock READ→WRITE + BTS_PENDING | pending 期间禁新读事务，防写者饿死 |

## 模块间交互

- **上层 vdbe**：OP_Seek/OP_Column/OP_Insert/OP_Next 全走本层 API；`sqlite3BtreeCursorHasMoved()`（:949）被刻意设计为读首字节即可判断（`offsetof(BtCursor,eState)==0` 断言），vdbe 高频轮询零成本。
- **下层 pager**：`getAndInitPage()`（:2409）经 `sqlite3PagerGet` 拿 DbPage；写前必须 `sqlite3PagerWrite()`（journal 挂钩点）；MemPage 借 pager extra 区——页缓存命中时 MemPage 零分配复用。
- **btmutex**：见上。

## 扩展方式

改页面格式要动的地方（注意：SQLite **无版本迁移机制**，任何磁盘格式改动意味着旧库不可读）：

- 格式文档与常量：`btreeInt.h` 头 1-215、`PTF_*`(:256)、`MX_CELL`(:229)；
- 页头解析：`btreeInitPage()`(:2248)、`lockBtree()`(:3312 读文件头)、`newDatabase()`；
- cell 编解码：`btreeParseCellPtr*` 四兄弟（:1269-1413）、溢出策略 `btreeParseCellAdjustSizeForOverflow`(:1205，注释警告"改动即不兼容")；
- 空间管理：`allocateSpace`(:1846)/`freeSpace`(:1945)/`defragmentPage`(:1640)；
- 平衡与搬迁：`balance_nonroot`(:8277 含页号重排)、`relocatePage`(:3974)、ptrmap 全部；
- 校验：integrity_check 全家（`IntegrityCk` btreeInt.h:703）。
