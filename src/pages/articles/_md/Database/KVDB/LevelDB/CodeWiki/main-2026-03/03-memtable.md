---
source:
  type: "源码解读"
  project: "leveldb"
  url: "https://github.com/google/leveldb"
title: "MemTable"
date: "2026-10-02T14:56:59+08:00"
category: [Database, KVDB, LevelDB, CodeWiki, "main-2026-03"]
contentType: "CodeWiki"
tags: ["LevelDB", "SkipList", "Arena", "内存数据结构"]
description: "MemTable 与其内核 SkipList：单写多读的 acquire/release 无锁并发、Arena 池化分配、四条不变量、以及 1/4 分支概率的层数几何分布。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/00-overview)

---

## 模块定位

MemTable 是 LSM 的"热数据层"：写入的终点（`db/db/memtable.cc` 的 `Add`）、点查的第一站（`Get`）、全库迭代器的第一路输入（`NewIterator`）。它的内核不是 `std::map` 也不是 B 树，而是一个**手工实现的跳表**（`db/skiplist.h`）+ **手工实现的内存池**（`util/arena.h`）——两个选择都为了同一个目标：**单写多读并发下零锁**。

`db/skiplist.h` 开头 25 行的并发注释是全库最精彩的一段文档，值得整段读。该模块三文件合计不到 700 行，却是 RocksDB 里长出三种 memtable（skiplist/hashskiplist/ucmmemtable）的原始起点。

## 模块架构

```
MemTable（db/memtable.h）                SkipList<const char*, KeyComparator>
├─ KeyComparator  ──包装──▶ InternalKeyComparator   ├─ head_（哨兵，kMaxHeight=12 层）
├─ refs_（引用计数：mem_/imm_ 双槽切换）              ├─ max_height_（atomic，relaxed）
├─ Arena arena_  ──分配节点与条目──▶  blocks_[]        ├─ rnd_（层数随机源）
└─ Table table_  ──────────────────────┴─ Node{key, next_[height]（atomic）}

条目布局（Arena 一次分配）：
 [key_size varint32][user_key bytes][tag uint64 (seq<<8|type)][val_size varint32][value bytes]
```

MemTable 是跳表的薄封装：比较器把 `InternalKeyComparator`（user key 升序、seq 降序）适配到裸字节指针比较（`KeyComparator::operator()` in `db/memtable.cc`）；条目自包含（长度前缀编码），所以跳表节点只存一个 `const char*`。Arena 只出现在 MemTable 的构造参数里——**跳表从不 free**，这与它的并发设计强绑定（见下）。

## 调用链路

```
写:  MemTable::Add(seq, type, key, value)          memtable.cc:113
      ├─ 计算编码长度（Arena Allocate 一次到位）
      ├─ 写 [klen][user_key][tag][vlen][value]
      └─ table_.Insert(buf)                        skiplist.h:335
          ├─ FindGreaterOrEqual(key, prev[])       从高层向低层找前驱
          ├─ RandomHeight()                        1/4 概率逐层加高（≤12）
          └─ NewNode（Arena::AllocateAligned）+ 逐层 release-store 挂链

读:  MemTable::Get(LookupKey, &value, &s)          memtable.cc:133
      ├─ iter.Seek(memtable_key)                   一次定位
      └─ 校验同 user_key → 按 tag 低 8 位分派 kTypeValue/kTypeDeletion

迭代: MemTable::NewIterator() → MemTableIterator   memtable.cc:76
      └─ 包装 SkipList::Iterator（key/value 按前缀解出）
```

点查为什么只需一次 Seek：`LookupKey` 构造的 memtable_key 打的是 `(seq, kValueTypeForSeek)`，而比较器 seq 降序——Seek 落在同 user_key 的**最新条目**上，一次命中。`Get` 里只比较 user_key 不比 seq，注释明说 "We do not check the sequence number since the Seek() call above should have skipped all entries with overly large sequence numbers"——比较器的排序语义替查询做了过滤。返回契约（`memtable.h` 的声明注释）：命中值 → 填 `*value` 返回 `true`；命中删除标记 → `*s = Status::NotFound()` 且返回 `true`（"该表已含此键"，**调用方不用再下沉**）；表中没有该键 → 返回 `false`（继续查 imm_/磁盘）。`kTypeDeletion` 之外未识别的 tag（损坏数据）同样落回 `false`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `MemTable::Add` in `db/memtable.cc:113` | 编码并插入 | 条目一次 Arena 分配，无碎块 |
| `MemTable::Get` in `db/memtable.cc:133` | 点查 | 借排序语义免 seq 过滤 |
| `MemTable::ApproximateMemoryUsage` in `db/memtable.cc` | 报内存量 | 直接 `arena_.MemoryUsage()`——Arena 顺带当了计量器 |
| `SkipList::Insert` in `db/skiplist.h:335` | 单写插入 | release-store 发布节点 |
| `SkipList::RandomHeight` in `db/skiplist.h:240` | 掷层数 | kBranching=4 → 每层期望 4 个节点 |
| `SkipList::FindGreaterOrEqual` in `db/skiplist.h:264` | 查找+记前驱 | 供 Insert 与 Contains 复用 |
| `Arena::Allocate` in `util/arena.h` | 快路径分配 | 线性指针碰撞，不足走 Fallback |
</details>

## 核心实现

### 无锁并发的四条不变量

`db/skiplist.h:15-30` 的注释列出整个设计的安全论证，可以提炼成四条：

1. **节点永不删除**——Arena 里的节点活到跳表销毁。这砍掉了并发结构最难的部分（删除的内存回收），代价由 Arena 的"只进不出"承担；MemTable 整表抛弃（切 `imm_` 落盘后 `Unref` 销毁）反而是更粗粒度也更简单的回收。
2. **节点内容（除 next_ 外）链接后不可变**——`Node::key` 从不修改。
3. **单写者**——`Insert` 由外部串行化（写入路径的队首身份，见 [01 篇](/vibe-reading/articles/Database/KVDB/LevelDB/CodeWiki/main-2026-03/01-write-path)），跳表自己不加写锁。
4. **发布用 release-store**——`SetNext`（`skiplist.h:157`）`store(x, memory_order_release)` 保证读者 acquire-load 到新指针时看到完整初始化的节点；挂链次序自底向上无所谓，因为**每层的发布各自完整**。

`Insert`（`skiplist.h:335`）里最微妙的一段是 `max_height_` 的无同步增长（注释原文 "It is ok to mutate max_height_ without any synchronization with concurrent readers"）：读者可能看到新高度但 head_ 的该层还是 nullptr——`KeyIsAfterNode` 把 nullptr 视为无穷大，读者会立即下探一层，安全；或看到已挂好的新节点，也安全。**两种交错都正确**，这是依赖排序语义而非锁的经典无锁论证。高度超过现有 `GetMaxHeight()` 时的衔接（`skiplist.h:344-349`）：`prev[i]` 数组从旧高度到新高度的槽位**统一填 `head_`**——新层还没有任何真实节点，前驱只能是哨兵；然后 `max_height_.store(height, relaxed)` 生效。

发布与挂链用**两种内存序分工**（`skiplist.h:153-171`）：对外的 `SetNext` 用 release-store、`Next` 用 acquire-load（发布-获取配对，读者见到指针即见完整节点）；内部装配用 `NoBarrier_SetNext`/`NoBarrier_Next`（relaxed）——`Insert` 里新节点先 relaxed 挂好各层 next、再由 `prev[i]->SetNext(i, x)` 这一步 release 把整条链发布出去，**一次 release 覆盖之前所有 relaxed 写**（happens-before 传递）。

`Node` 本身是个**弹性数组技巧**：`next_[1]` 声明为长度 1 的 `std::atomic<Node*>` 数组，实际长度等于节点高度；`NewNode`（`skiplist.h:180`）按 `sizeof(Node) + sizeof(std::atomic<Node*>)*(height-1)` 从 Arena `AllocateAligned` 一次分配——变长节点一个头搞定，免 vector 免二次分配。

### RandomHeight：1/4 分支概率的几何分布

```cpp title="db/skiplist.h"
int SkipList<Key, Comparator>::RandomHeight() {
  static const unsigned int kBranching = 4;
  int height = 1;
  while (height < kMaxHeight && rnd_.OneIn(kBranching)) height++;
  return height;
}
```

高度服从 P(h ≥ k) = (1/4)^(k-1) 的几何分布：每层期望 4 个节点，12 层封顶可容纳 4^11 ≈ 4M 条目而期望查找仍 O(log n)。`rnd_` 是跳表私有的 `Random`（`util/random.h`，TAOCP 线性同余），刻意**不与全局共享**——写者独享随机源，免竞争。RocksDB 后来把 kMaxHeight 提到 16，但概率模型原封未动。

### Arena：指针碰撞 + 大块回落

`util/arena.h` 的 `Allocate` 是 5 行快路径：当前块剩余够就直接指针前移。不够则 `AllocateFallback`——大于 1/4 块的请求独享整块（防大条目浪费），否则开新 4KB 块；`AllocateAligned`（跳表节点用，对齐 `std::atomic<Node*>`）补齐到指针对齐。`memory_usage_` 是 `atomic<size_t>`（relaxed）——**Arena 顺带就是 MemTable 的内存计费器**，`MakeRoomForWrite` 的 4MB 判定直接读它。注释里那条 TODO（"This member is accessed via atomics, but the others are not... Is this OK?"）泄露了答案：写者单线程持有 Arena 的分配状态，唯一的多读者访问就是计费读数，一个原子量足矣。

### 比较器与迭代器适配

`KeyComparator::operator()`（`memtable.cc:38`）把两条裸指针解成 `Slice` 再交给 `InternalKeyComparator`——跳表模板参数是 `const char*` 而非 `Slice`，避免每节点存长度字段。`MemTableIterator`（`memtable.cc:76`）的 `key()/value()` 按前缀协议现场解出：key 是首个 length-prefixed 段，value 是紧随 key 段的第二个——**迭代零拷贝**，返回的 Slice 直接指进 Arena 内存。

**Prev 是"搜"出来的不是"链"出来的**：`SkipList::Iterator::Prev`（`skiplist.h:224`）直接调 `FindLessThan(node_->key)`——从最高层向下找严格小于当前键的最后一个节点；走到头（返回 `head_`）时把 `node_` 置 nullptr（迭代器失效）。没有后向指针的代价换来的是节点结构更小、插入路径更短，且 MemTable 的 Prev 场景（DBIter 反向回扫）本就稀疏。

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
| --- | --- | --- |
| 适配器 | `db/memtable.cc` `KeyComparator` | 裸指针模板参数 ↔ 值语义比较器 |
| 引用计数 | `db/memtable.h` `Ref/Unref`（析构私有化） | 双槽（mem_/imm_）切换时保护活读 |
| 对象池 | `util/arena.h` `Arena` | 分配 O(1) 且天然并发计费 |
| 包装迭代器 | `db/memtable.cc` `MemTableIterator` | 把内存条目协议翻译成统一 `Iterator` 接口 |

## 模块间交互

上游：写入路径（`InsertInto` 批量进表）、恢复（`RecoverLogFile` 重放进表）。下游：读取路径（`Get` 第一站、`NewInternalIterator` 第一路）、compaction（`imm_` 经 `WriteLevel0Table` 转成 SSTable，即 `db/builder.cc` 的 `BuildTable` 直接迭代 MemTable）。跳表与 Arena 是纯库依赖（只 include `util/arena.h` 与 `util/random.h`）；MemTable 对外只暴露 `dbformat.h` 类型——**模块无反向依赖**，graphify 建图显示 `skiplist.h` 所在社区（C1，63 节点）无任何跨模块桥梁。

## 扩展方式

- **换内核**（如哈希 + 有序双索引）：`MemTable::Table` typedef 换实现（`db/memtable.h`）——RocksDB `HashSkipListRep` 的路线，需保证 `NewIterator` 仍产有序流
- **加内存上限策略**：`Arena::MemoryUsage` 已有读数，在 `MemTable::Add` 前检查即可（LevelDB 靠 `DBImpl` 的 `write_buffer_size` 判定，粒度是整表）
- **并发跳表**：打破不变量 3 需给 `Insert` 加写锁或 CAS 链表——`db/skiplist_test.cc` 的 `ConcurrentTest` 已备好正确性框架
- 对应测试：`db/skiplist_test.cc`（9.6K，含并发压力测试）、`db/db_test.cc` 的 memtable 系列
