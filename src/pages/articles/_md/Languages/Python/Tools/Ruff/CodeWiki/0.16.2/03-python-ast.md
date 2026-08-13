---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "Python AST"
date: "2026-08-13T20:14:13+08:00"
category: ["Languages", "Python", "Tools", "Ruff", "CodeWiki", "0.16.2"]
tags: ["ruff", "Rust", "AST", "Visitor", "代码生成"]
description: "ruff 的 Python AST 模块——代码生成的节点定义 + TextRange 位置 + 三层 Visitor，所有消费者的共享地基。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_python_ast/` 定义了 Python 的抽象语法树。它是整个 ruff/ty 工具链的**共享地基**——parser 构造它，linter/formatter/semantic 消费它。这个模块独立存在的核心价值是**解耦构造与消费**：AST 必须能脱离 parser 独立传递给多个消费者，且每个节点携带精确位置信息（`TextRange`），让 linter 能报告诊断、formatter 能定位格式化、semantic 能构建作用域。

## 模块架构

模块采用**代码生成 + 手写逻辑**分层：节点类型定义（`generated.rs`，1.1 万行）由 Python 脚本 `generate.py` 自动生成，保证一致性与完整性；visitor 遍历逻辑和辅助方法（`visitor.rs`/`node.rs`/`nodes.rs`）手写，保证语义正确性。顶层枚举 `Mod`/`Stmt`/`Expr` 采用 **Rust-style enum + 透明包装 struct** 设计——每个枚举变体包装一个具体 struct，子节点用 `Box`/`ThinVec` owned。

## 调用链路

AST 本身是数据，没有"调用链"。关键流程是**遍历**——三层 Visitor 提供不同遍历策略：

```
Visitor<'a>           (visitor.rs:23)        求值顺序遍历，只读 &          ← Checker 用这个
  walk_stmt(stmt)
    Stmt::Assign { value, targets } → visit_expr(value) → visit_expr(targets)

SourceOrderVisitor<'a> (visitor/source_order.rs)  源码顺序遍历，带 TraversalSignal 控制流
  ExprCompare::visit_source_order → left → op → comparator

Transformer           (visitor/transformer.rs)  求值顺序，可变 &mut            ← 修改 AST
  visit_stmt(&self, stmt: &mut Stmt)
```

关键点：`Visitor` 的 `walk_stmt` 按**求值顺序**而非源码顺序——`Assign` 先访问 `value` 再访问 `targets`，因为 Python 运行时先求值右侧。如需源码顺序（如 formatter），用 `SourceOrderVisitor`。

## 核心实现

### 代码生成的节点定义

```rust title="generated.rs（自动生成，勿手改）"
pub enum Stmt {
    FunctionDef(crate::StmtFunctionDef),
    ClassDef(crate::StmtClassDef),
    Assign(crate::StmtAssign),
    // ... 共 24 个变体
}

pub struct StmtFunctionDef {
    pub node_index: crate::AtomicNodeIndex,
    pub range: ruff_text_size::TextRange,
    pub is_async: bool,                              // async/sync 合并
    pub decorator_list: thin_vec::ThinVec<crate::Decorator>,
    pub name: crate::Identifier,
    pub parameters: Box<crate::Parameters>,
    pub returns: Option<Box<Expr>>,
    pub body: thin_vec::ThinVec<Stmt>,
}
```

每个节点 struct 都有 `range: TextRange` 和 `node_index: AtomicNodeIndex` 字段，并自动生成 `impl Ranged`（`range()` 方法）。枚举也实现 `Ranged`，通过 match 委托给内部 struct。`generate.py` 是**唯一需要手动修改**的源——改后重新生成 `generated.rs`，包含 enum/struct/From/Ranged/HasNodeIndex/访问方法全套。

### 三层 Visitor

```rust title="visitor.rs"
pub trait Visitor<'a> {
    fn visit_stmt(&mut self, stmt: &'a Stmt) { walk_stmt(self, stmt); }
    fn visit_expr(&mut self, expr: &'a Expr) { walk_expr(self, expr); }
    // ... 30+ visit 方法，默认委托 walk_*
}
```

三层 visitor 覆盖不同消费者需求：`Visitor`（求值序，只读，linter 的 Checker 用）、`SourceOrderVisitor`（源码序，带 `enter_node`/`leave_node` 钩子和 `TraversalSignal` 控制流，formatter 用）、`Transformer`（求值序，可变 `&mut`，修改 AST 用）。每个都有配套 `walk_*` 自由函数做默认遍历，用户只 override 感兴趣的 `visit_*`。

### AST 节点关联位置

每个节点 struct 含 `pub range: ruff_text_size::TextRange`，并自动生成 `impl Ranged`。Parser 构造时设置 range，linter/formatter 通过 `Ranged::range()` 获取位置报告诊断或定位格式化。`find_node.rs` 基于 `Ranged` 实现"给定字节偏移找对应 AST 节点"。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor 模式（三层） | `visitor.rs:23` / `source_order.rs:13` / `transformer.rs:10` | 求值序/源码序/可变换覆盖不同消费者 |
| Rust-style enum + Boxed children | `generated.rs` | 枚举区分节点类型，Box/ThinVec 持有子节点 |
| 代码生成 | `generate.py` → `generated.rs` | 节点定义集中维护，生成保证一致 |
| owned AST | 所有子节点 `Box`/`ThinVec` | AST 可脱离 parser 独立传递，无生命周期传染 |

## 模块间交互

```
ruff_text_size ──provide──> TextRange, Ranged trait
       │
       ▼
ruff_python_ast (本模块)
       │
       ├── constructed by ──> ruff_python_parser (解析 → AST)
       ├── consumed by ────> ruff_python_semantic (构建 scope/binding)
       ├── consumed by ────> ruff_linter (Checker 遍历 + 规则)
       └── consumed by ────> ruff_python_formatter (按节点格式化)
```

`lib.rs:4-9` 通过 `pub use` 将 `generated::*`/`nodes::*`/`expression::*` 全部 re-export，外部 crate 只需 `use ruff_python_ast::*`。`ruff_python_ast` 仅依赖 `ruff_text_size`，依赖极轻，可独立快速编译。

## 重要设计决策

**为什么 AST 节点用 owned（Box）而非引用？** AST 必须能脱离 parser 独立传递给多个消费者——若用 `&'a Expr`，所有消费者都要携带 parser 生命周期参数，导致生命周期传染整个代码库。且 `Transformer` 需 `&mut` 修改 AST，引用无法原地修改。owned 设计使 clone 朴素、传递自由。

**为什么用 ThinVec 而非 Vec？** `ThinVec` 在空时不分配堆内存（栈上仅一个指针/null），`Vec` 即使为空也占 3 个机器字。AST 中大量节点有 body 字段，很多语句（`pass`/`break`）无子语句，`ThinVec` 显著减少内存占用。

**为什么 async/sync 合并为单一节点？** CPython AST 将 `FunctionDef` 和 `AsyncFunctionDef` 分为两节点，ruff 用 `is_async: bool` 合并——减少 enum 变体数量，避免 visitor 中重复处理逻辑，字段访问成本极低。`StmtFor`/`StmtWith` 同理。

**为什么 NodeIndex 用 AtomicNodeIndex？** 用 `AtomicU32`（内部可变性）而非不可变 `NonZeroU32`——parser 构造 AST 时可能无法立即确定索引，`AtomicNodeIndex` 允许构造后通过 `set()` 赋值，且只需 `&self`（无需 `&mut AST`）。32 位编码中高 2 位表示 sub-AST 层级，低 30 位是索引，每节点预留 256 个 sub-AST 空间。

## 扩展方式

**新增一个 AST 节点类型支持新语法**：
1. `crates/ruff_python_ast/generate.py`——添加节点定义（唯一手改源）
2. 运行 `python generate.py` 重新生成 `generated.rs`
3. `visitor.rs` + `visitor/source_order.rs` + `visitor/transformer.rs`——添加遍历逻辑（遍历顺序需语义判断，手写）
4. `node.rs`——添加 `visit_source_order` 方法和 `AnyNodeRef` 变体
5. `ruff_python_parser/src/`——添加语法解析规则构造新节点
6. `comparable.rs`——添加可比较表示（快照测试用）
