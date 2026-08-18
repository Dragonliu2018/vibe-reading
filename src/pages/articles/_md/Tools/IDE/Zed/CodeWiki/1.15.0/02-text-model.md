---
source:
  type: "源码解读"
  project: "zed"
  url: "https://github.com/zed-industries/zed"
title: "文本模型"
date: "2026-08-18T11:06:09+08:00"
category: [Tools, IDE, Zed, CodeWiki, "1.15.0"]
tags: ["zed", "Rust", "code editor", "GPUI", "CRDT"]
description: "Zed 文本数据结构：SumTree 可聚合 B-tree、Rope 文本存储、Buffer CRDT 协作"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/00-overview)

---

## 模块定位

文本是代码编辑器操作的根本对象。Zed 没有使用简单的字符串或数组来存储文本，而是自底向上构建了一套三层文本数据结构：`sum_tree`（可聚合 B-tree）→ `rope`（基于 SumTree 的 Rope 文本结构）→ `text`（可协作的 Buffer）。这套结构同时解决了两个难题：**大文件的高效编辑**（O(log n) 而非 O(n)）和**多人协作的无冲突合并**（CRDT）。

这三个 crate 是纯数据层——不依赖 GPUI、不涉及 UI，只负责文本的存储、修改、查询和同步。它们的正确性是 Zed 编辑体验和协作能力的基石。

---

## 模块架构

```
sum_tree/                    # 可聚合 B-tree（最底层，零依赖 GPUI）
├── sum_tree.rs              # SumTree<T: Item> + Item / Summary / Dimension traits
├── cursor.rs                # 树游标（seek / next / prev）
└── tree_map.rs              # TreeMap（SumTree 的有序 map 变体）

rope/                        # Rope 文本结构（依赖 sum_tree）
├── rope.rs                  # Rope（基于 SumTree<Chunk> 的文本）
├── chunk.rs                 # 文本块（叶子节点，存储实际字节）
├── point.rs                 # Point（行/列坐标）
└── offset_utf16.rs          # UTF-16 偏移（LSP 交互用）

text/                        # CRDT 缓冲区（依赖 rope + sum_tree）
├── text.rs                  # Buffer / BufferSnapshot / Operation / History
├── anchor.rs                # Anchor（位置引用，编辑后仍有效）
├── selection.rs             # Selection（选择区域）
├── operation_queue.rs       # 操作队列（暂存乱序到达的远端操作）
├── undo_map.rs              # UndoMap（撤销追踪）
└── patch.rs                 # Patch（文本变更补丁）
```

三层的依赖关系是严格单向的：`text` → `rope` → `sum_tree`。`SumTree` 是通用可聚合数据结构（不只用于文本），`Rope` 把 `SumTree` 特化为文本存储，`Buffer` 在 `Rope` 之上叠加 CRDT 协作能力。

---

## 调用链路

**编辑主链路**（一次文本插入如何穿越三层）：

```
Buffer::edit(ranges, new_text, cx)          (text/src/text.rs)
  │
  ├─ 为每个 range 构造 EditOperation {
  │      timestamp: lamport_clock.tick(),    # Lamport 逻辑时钟递增
  │      version: self.version.clone(),       # 当前全局版本快照
  │      ranges, new_text
  │  }
  │
  ├─ self.apply_operation(Operation::Edit(op))
  │    │
  │    ├─ History::push(op)                   # 记入操作历史
  │    │
  │    └─ BufferSnapshot::apply_edit(op)
  │         │
  │         ├─ Rope::replace(range, text)     (rope/src/rope.rs:124)
  │         │    │
  │         │    └─ SumTree<Chunk> 更新        # O(log n) 拆分/合并块
  │         │         └─ summary 重新聚合（TextSummary: 行数/字符数/最大点）
  │         │
  │         ├─ fragments SumTree 更新          # Fragment 追踪插入来源
  │         └─ version.merge(op.timestamp)     # 合并版本向量
  │
  ├─ self.subscriptions.publish(op)            # 通知订阅者（collab/编辑器）
  └─ cx.notify()                               # 触发 UI 重渲染
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Buffer::edit()` | 应用文本编辑 | 生成带 Lamport 时间戳的 `EditOperation`，同时改本地与通知远端 |
| `Rope::replace()` (`rope.rs:124`) | 替换文本区间 | 委托 `SumTree<Chunk>` 在 O(log n) 内拆分/合并块 |
| `SumTree::cursor()` (`sum_tree.rs:597`) | 定位到目标偏移 | 沿树下沉，用 `Summary` 跳过整棵子树（不遍历叶子） |
| `BufferSnapshot::apply_edit` | 不可变快照上应用编辑 | COW——快照克隆零成本，编辑创建新版本 |

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `SumTree::from_iter()` | `sum_tree.rs:249` | 从迭代器构建树 |
| `SumTree::find()` | `sum_tree.rs:426` | 按目标查找节点 |
| `Rope::new()` | `rope.rs:31` | 创建空 Rope |
| `Rope::push()` | `rope.rs:147` | 追加文本 |
| `Rope::slice()` | `rope.rs:134` | 切片（返回新 Rope） |
| `Rope::offset_to_point()` | `rope.rs:397` | 偏移转行/列 |
| `Buffer::undo()` / `redo()` | `text.rs` | 撤销/重做（生成 `UndoOperation`） |
| `Buffer::snapshot()` | `text.rs` | 克隆当前快照（COW） |
| `Buffer::add_listener()` | `text.rs` | 订阅操作流 |

</details>

---

## 核心实现

### `SumTree`：可聚合 B-tree

`SumTree`（`sum_tree.rs:213`）是 Zed 数据结构的通用底座——一个每个内部节点缓存子树聚合摘要的 B-tree。它不只是存数据，还能在 O(log n) 内回答"前 N 个元素的聚合值是多少"这类查询。

```rust title="crates/sum_tree/src/sum_tree.rs"
pub struct SumTree<T: Item>(Arc<Node<T>>);

pub trait Item: Clone {
    type Summary: Summary;
    fn summary(&self, cx: &Self::Summary::Context<'_>) -> Self::Summary;
}

pub trait Summary: Clone {
    type Context<'a>: Clone;
    fn add_summary(&mut self, summary: &Self, cx: &Self::Context<'_>);
}
```

核心机制：每个 `Item` 能产生一个 `Summary`（如文本块的 `TextSummary` 含行数、字符数、最大坐标）。内部节点缓存子树所有叶子 `Summary` 的聚合。当需要"找到第 1000 行对应的偏移"时，从根节点开始，用缓存的 `Summary` 跳过整棵子树（如果子树总行数 < 1000），直达目标叶子——无需遍历所有块。

**为什么用 SumTree 而非普通 B-tree**：文本编辑器高频需要的是聚合查询（"第 N 行在哪""这个选择区间有多少字符""可见区域的总宽度"），而非按键查找。SumTree 把聚合摘要内置到树结构里，让这些查询变成 O(log n)。`Rope`（文本）、`SelectionsCollection`（选择）、GPUI 的 `bounds_tree`（元素边界）都建立在 SumTree 之上。

### `Rope`：文本的树状存储

`Rope`（`rope.rs:26`）是 `SumTree<Chunk>` 的特化——把大文本拆成固定大小的块（`Chunk`，约 2KB），用 SumTree 组织。这避免了 `String` 的 O(n) 插入/删除：编辑只在受影响的块上操作，树结构保证 O(log n) 定位。

```rust title="crates/rope/src/rope.rs"
pub struct Rope {
    chunks: SumTree<Chunk>,   // 文本块树
    // summary 缓存在 SumTree 根节点：TextSummary { lines, bytes, max_point }
}
```

`Rope::replace()`（`rope.rs:124`）是编辑的核心——替换一个区间：先 `cursor` 定位到区间起点，拆分跨越边界的块，移除区间内的块，插入新块。所有操作在 SumTree 上是 O(log n)。

Rope 还维护多种坐标系统的转换：`Point`（行/列）、`Offset`（字节偏移）、`OffsetUtf16`（UTF-16 偏移，用于 LSP 协议）。`offset_to_point()` / `offset_to_offset_utf16()` 在 O(log n) 内完成转换——这是编辑器频繁需要的操作（LSP 用 UTF-16，显示用行/列，内部用字节偏移）。

### `Buffer`：CRDT 协作缓冲区

`Buffer`（`text.rs:59`）在 `Rope` 之上叠加协作能力。它是一个 CRDT 副本——每个客户端独立编辑，操作通过 Lamport 时钟排序，可交换合并，最终所有副本收敛到相同状态。

```rust title="crates/text/src/text.rs"
pub struct Buffer {
    snapshot: BufferSnapshot,
    history: History,
    deferred_ops: OperationQueue<Operation>,   # 暂存乱序到达的远端操作
    deferred_replicas: HashSet<ReplicaId>,
    pub lamport_clock: clock::Lamport,          # 逻辑时钟
    subscriptions: Topic<usize>,
    // ...
}

pub enum Operation {
    Edit(EditOperation),
    Undo(UndoOperation),
}

pub struct EditOperation {
    pub timestamp: clock::Lamport,        # 操作的唯一标识 + 排序依据
    pub version: clock::Global,            # 操作基于的版本向量
    pub ranges: Vec<Range<FullOffset>>,
    pub new_text: Vec<Arc<str>>,
}
```

**CRDT 机制**：每次 `Buffer::edit` 生成 `EditOperation`，`timestamp` 是 `lamport_clock.tick()`（单调递增的逻辑时钟），`version` 是当前已知所有副本的版本向量（`clock::Global`）。操作通过 `subscriptions` 发布，`client` crate 序列化后发送到协作服务端转发给其他副本。

**乱序处理**：网络传输可能导致操作乱序到达。远端 `Buffer` 的 `deferred_ops: OperationQueue` 暂存 `version` 未对齐的操作——如果操作依赖的版本尚未全部收到，先排队。待依赖版本就绪后，按 Lamport 时钟顺序 `apply`。`deferred_replicas` 追踪哪些副本的操作在等待。这保证了操作以因果一致的顺序应用。

**撤销**：`UndoOperation`（`text.rs`）不是简单的"反向编辑"——它引用被撤销操作的 `Lamport` 计数（`counts: HashMap<clock::Lamport, u32>`），告知所有副本"撤销这些操作"。这让协作场景下的撤销正确工作：A 撤销 B 的编辑时，所有副本都执行该撤销。

### `BufferSnapshot`：COW 不可变快照

`BufferSnapshot`（`text.rs:113`）是 Buffer 当前状态的不可变快照：

```rust title="crates/text/src/text.rs"
pub struct BufferSnapshot {
    visible_text: Rope,
    deleted_text: Rope,                  # 被删除的文本（撤销需要）
    fragments: SumTree<Fragment>,        # 插入片段追踪（谁在何时插入）
    insertions: SumTree<InsertionFragment>,
    undo_map: UndoMap,
    pub version: clock::Global,
    remote_id: BufferId,
    replica_id: ReplicaId,
    // ...
}
```

快照采用 COW（Copy-on-Write）——`Buffer::snapshot()` 克隆是零成本的（`Rope` 和 `SumTree` 内部用 `Arc`，克隆只增加引用计数）。编辑器读取快照渲染时不阻塞写入，写入时创建新版本而非修改旧快照。这让渲染线程和编辑线程可以并发工作——渲染用旧快照，编辑创建新快照，下一帧渲染切换到新快照。

`Anchor`（`anchor.rs`）是基于快照的位置引用——它不存储绝对偏移（编辑后偏移会失效），而是存储相对于 `Fragment` 的相对位置。编辑发生后，`Anchor` 可以在新快照中重新定位到"语义上相同"的位置。这是协作编辑中"远端光标跟随"的基础——其他用户的光标位置用 `Anchor` 表示，本地编辑后光标位置自动更新。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 可聚合 B-tree | `sum_tree.rs` `SumTree<T: Item>` + `Summary` trait | 把聚合查询从 O(n) 降到 O(log n)，通用化为任何可聚合数据 |
| COW 快照 | `text.rs` `BufferSnapshot`（`Arc` 共享内部树） | 读写并发：渲染读旧快照，编辑写新版本，零拷贝克隆 |
| CRDT（Op-based） | `text.rs` `Operation` + `clock::Lamport` + `clock::Global` | 无主复制，操作可交换合并，无需中心锁 |
| 位置锚点 | `anchor.rs` `Anchor` | 编辑后位置自动迁移，解决协作场景下绝对偏移失效 |
| 延迟队列 | `operation_queue.rs` `OperationQueue` | 处理网络乱序到达，保证因果一致的应用顺序 |

---

## 模块间交互

- **被谁依赖**：`multi_buffer`（拼接多个 `Buffer` 的 excerpt）、`editor`（通过 `MultiBuffer` 间接消费）、`collab` / `client`（同步 `Operation`）、`project`（`BufferStore` 管理 `Buffer` 生命周期）、`lsp`（LSP 用 `BufferSnapshot` 获取文本和 UTF-16 偏移）。
- **依赖谁**：`rope`（`BufferSnapshot` 内含 `Rope`）、`sum_tree`（`Rope` 和 `Fragment` 都基于 `SumTree`）、`clock`（Lamport 时钟和版本向量）。
- **交互方式**：`Buffer` 通过 `subscriptions: Topic<usize>` 发布操作事件，`client` 订阅并序列化发送；远端 `Buffer` 通过 `handle_update` 接收并 `apply`。`Editor` 通过 `Buffer::snapshot()` 拿 COW 快照读取文本，不阻塞写入。无循环依赖——`text` 不反向依赖 `editor` 或 `client`。

---

## 扩展方式

**新增一种文本操作类型**（如"格式化操作"）：

1. 在 `Operation` 枚举（`text/src/text.rs:619`）添加新变体
2. 实现 `apply` 逻辑——如何修改 `BufferSnapshot` 的 `Rope` 和 `fragments`
3. 确保 `UndoOperation` 能引用和撤销新操作类型
4. 在 `client` crate 的 RPC 序列化（`proto`）添加新操作类型
5. 对应测试：`text/src/tests.rs`
