---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "高层中间表示 HIR"
date: "2026-08-19T14:59:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "HIR", "CodeWiki"]
description: "AST 到 HIR 的降低、owner-based 嵌套结构与大量语法去糖。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

HIR（High-level IR）是 AST 降低（lowering）后的中间表示，是类型检查的工作集。它把 AST 的高层语法糖展开为核心原语，并用一个**owner-based 嵌套所有权模型**重新组织节点——这使得增量编译时移动一个 item 不影响其内部节点的 ID，只需重算该 owner。`rustc_ast_lowering` 是 HIR 的唯一生产者，`rustc_hir` 定义节点，`rustc_hir_id` 定义核心 `HirId`。

## 模块架构

- **`HirId`**（`rustc_hir_id/src/lib.rs:92`）：两级结构 `{owner: OwnerId, local_id: ItemLocalId}`。`OwnerId` 持 `LocalDefId`，标识最近的"item-like"父节点；`ItemLocalId`（`:164`）在该 owner 内局部唯一。
- **HIR 节点**（`rustc_hir/src/hir.rs`）：`Item<'hir>{owner_id, kind: ItemKind, span, vis_span, eii}`（`:4239`）、`Expr<'hir>{hir_id, kind: ExprKind, span}`（`:2215`）、`Pat<'hir>{hir_id, kind, span, default_binding_modes}`（`:1518`）、`Body<'hir>{params, value: &Expr}`（`:1954`）、`Block<'hir>{stmts, expr, hir_id, rules, span}`（`:1475`）。
- **Owner 存储**：`OwnerNodes<'tcx>{opt_hash, nodes: IndexVec<ItemLocalId, ParentedNode>, bodies: SortedMap<ItemLocalId, &Body>}`（`:1322`）——用 `IndexVec` 而非 HashMap，因 `ItemLocalId` 密集连续。`ParentedNode{parent: ItemLocalId, node: Node}`（`:1291`）。`OwnerInfo<'hir>{nodes, parenting, attrs, trait_map, children, delayed_lints, opt_hash}`（`:1379`）。`MaybeOwner::Owner(&OwnerInfo) | NonOwner(HirId)`（`:1411`）。

## 调用链路

整个 AST→HIR 流程由两个 query 驱动：

```
index_ast(())                        // rustc_ast_lowering/src/lib.rs:498
  └→ Indexer::visit_crate            // :517  遍历 AST 建 IndexVec<LocalDefId, (Resolver, AstOwner)>

lower_to_hir(def_id)                  // lib.rs:659  per-owner query（惰性）
  ├→ tcx.index_ast(()) → 获取 (resolver, AstOwner)   // Steal 消费
  ├→ ItemLowerer { tcx, resolver }
  │   └→ match AstOwner:
  │       ├─ Crate → lower_crate()      // item.rs:72
  │       └─ Item → lower_item()       // item.rs:82
  │           └→ with_lctx(owner, f)   // item.rs:56
  │               ├→ LoweringContext::new(tcx, resolver, owner)  // lib.rs:225
  │               ├→ f(&mut lctx)      // 实际 lowering 回调
  │               └→ lctx.make_owner_info(item)  // lib.rs:893
  │                   └→ index::index_hir(...)   // index.rs:30  NodeCollector 遍历 HIR 建 ParentedNode
  └→ 返回 MaybeOwner::Owner(&OwnerInfo)
```

具体 lowering 分发：`lower_item`（`item.rs:207`）→ `lower_item_kind`（`:232`）match AST `ItemKind`；`lower_expr_mut`（`expr.rs:163`）match `ExprKind`，特殊处理 `Paren`（透明穿透）、`ForLoop`（去糖）、`Closure`；`lower_node_id`（`lib.rs:950`）做 AST NodeId→HirId 映射；`next_id`（`:976`）为合成节点（去糖产物）生成新 HirId。

## 核心实现

### 为什么 owner-based 而非扁平 AST

`HirId` 文档（`rustc_hir_id/src/lib.rs:80-89`）明确解释："This two-level structure makes for more stable values: One can move an item around within the source code, or add or remove stuff before it, without the `local_id` part of the `HirId` changing." 增量编译时，移动一个 item 不影响其内部所有节点的 ID，只需重算该 owner。`OwnerNodes` 用 `IndexVec` 而非树/HashMap，因 `ItemLocalId` 保证密集连续（`lib.rs:153-160`）。

### HirId vs DefId

`DefId` 标识"定义"（函数、结构体等 owner 级实体），跨 crate 有效；`HirId` 标识当前 crate 内任意 HIR 节点（含表达式、模式、语句等非定义节点），仅本地有效。一个 owner 的 `HirId` 满足 `local_id == 0`，可通过 `expect_owner()` 取回 `OwnerId` 再转 `DefId`。`HirId` 刻意 `impl !Ord`（`lib.rs:100-101`），防止用排序做不稳定的比较导致增量编译 bug（issue #90317）。

### 大量 desugaring

HIR 在 lowering 阶段把语法糖展开为核心原语，简化下游分析。典型：

- `for pat in iter { body }` → `match IntoIterator::into_iter(iter) { mut iter => loop { match Iterator::next(&mut iter) { None => break, Some(pat) => body } } }`（`lower_expr_for` in `expr.rs:1707`）
- `while cond { body }` → `loop { if cond { body } else { break } }`（`lower_expr_while_in_loop_scope` in `expr.rs:641`），用 `DropTemps` 包裹条件以保留 drop 语义
- `async/await` → coroutine + `poll` 循环（`make_lowered_await` in `expr.rs:938`）

### Span lowering 与 Steal

`SpanLowerer`（`lib.rs:307`）在增量编译模式下把 span 标记为相对 owner 的 `def_id`（`span.with_parent(Some(def_id))`），使 span 也具备增量稳定性。`Steal<T>` 实现一次性消费——`resolver_and_node` 被 steal 后原引用失效（`lib.rs:661`），AST 在 lowering 完成后 `mem::drop(node)`（`:709`），避免 AST 驻留内存。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Owner-based 嵌套所有权 | `HirId` 两级结构 / `OwnerNodes` | 增量编译 ID 稳定性 |
| Builder | `LoweringContext` (`lib.rs:147`) | 累积 bodies/attrs/children 后一次性收集 |
| Visitor | `NodeCollector` (`index.rs:30`) | walk HIR 填 `ParentedNode` 数组 |
| Steal | `Steal<T>` (`lib.rs:661`) | 一次性所有权转移，AST 用后即 drop |

## 模块间交互

`rustc_ast_lowering` 消费 `rustc_ast`（AST 节点）和 `rustc_expand`（展开后的 AST），产出 `OwnerInfo`。下游通过 `rustc_middle/src/hir/map.rs` 访问——该文件注释说明原 `HirMap` 已消除，方法全部内联到 `TyCtxt`（`map.rs:1-3`）。`TyCtxt` 通过 query `hir_owner_nodes(def_id)` 获取 `&OwnerNodes`，通过 `hir_parent_iter` 向上遍历父链。下游消费链：`resolve`（补 `Res`）→ `typeck`（用 `HirId` 定位节点）→ `borrowck`（遍历 `Body`）→ `lint`（按 `Node` 枚举匹配）。

## 扩展方式

新增语法节点 lowering（如 `let-chain`）：在 `rustc_hir/src/hir.rs` 的 `ExprKind` 加 variant，在 `rustc_ast_lowering/src/expr.rs` 的 `lower_expr_mut` 加分支调 `lower_expr_let_chain`，确认 `index.rs` 的 `NodeCollector` 能遍历新节点（复用已有结构则无需改），若新增独立节点类型需更新 `rustc_hir/src/intravisit.rs` 的 `Visitor` walk 方法。
