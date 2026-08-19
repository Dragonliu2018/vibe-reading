---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "中间表示 MIR"
date: "2026-08-19T15:03:00+08:00"
category: [Languages, Rust, Tools, rust, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "MIR", "CodeWiki"]
description: "rustc 的 MIR 数据结构与从 HIR+THIR 构建 MIR 的控制流映射。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/rust/CodeWiki/1.100.0/00-overview)

---

## 模块定位

MIR（Mid-level IR）是 `rustc` 的核心中间表示——基于控制流图（CFG）+ basic block 的低级 IR。它在 HIR 与代码生成之间承担关键角色：把高层语法（if/match/loop/闭包）统一为少数低级操作（`Assign`/`SwitchInt`/`Call`/`Drop`），使借用检查与优化能在统一框架上做数据流分析。MIR 定义在 `rustc_middle/src/mir/`，构建在 `rustc_mir_build`。

## 模块架构

核心数据结构定义在 `rustc_middle/src/mir/mod.rs` 与 `syntax.rs`：

- **`Body<'tcx>`**（`mod.rs:206`）：一个函数的完整 MIR。字段 `basic_blocks: BasicBlocks`、`local_decls: IndexVec<Local, LocalDecl>`、`source_scopes`、`phase: MirPhase`、`coroutine: Option<Box<CoroutineInfo>>`。`Body::new()`（`:334`）组装，`finish()` 在 Builder 中调用完成。
- **`BasicBlock`**（`mod.rs:1300`）：newtype 索引，`START_BLOCK = 0`；实际数据在 `BasicBlockData`。
- **`BasicBlockData<'tcx>`**（`:1319`）：`statements: Vec<Statement> + terminator: Option<Terminator> + is_cleanup: bool`。
- **`Local`**（`:866`）：newtype 索引，`RETURN_PLACE = 0` 是返回值，`Local::arg(i) = Local(i+1)` 为参数。
- **`Place<'tcx>`**（`syntax.rs:1162`）：`local: Local + projection: &List<PlaceElem>`，表示内存位置。
- **`Operand<'tcx>`**（`syntax.rs:1282`）：`Copy(Place)`/`Move(Place)`/`Constant`/`RuntimeChecks`，表示值操作数。
- **`Rvalue<'tcx>`**（`syntax.rs:1342`）：右侧值，含 `Use`/`Ref`/`BinaryOp`/`Aggregate`/`Cast` 等。
- **`StatementKind`**（`syntax.rs:305`）：`Assign(Box<(Place, Rvalue)>)`/`StorageLive`/`StorageDead`/`FakeRead`/`SetDiscriminant`/`Nop` 等。
- **`TerminatorKind`**（`syntax.rs:683`）：`Goto`/`SwitchInt`/`Call`/`Return`/`Drop`/`Assert`/`Yield`/`Unreachable`/`FalseEdge`/`FalseUnwind`/`InlineAsm`/`TailCall` 等。

## 调用链路

MIR 构建入口在 `rustc_mir_build/src/builder/mod.rs`：

```
build_mir_inner_impl (mod.rs:67)
  → tcx.thir_body(def)                  // 获取 THIR（HIR + typeck 结果）
  → construct_fn (mod.rs:451) / construct_const (mod.rs:565)
    → Builder::new (mod.rs:749)         // 初始化 CFG/scopes/local_decls
    → args_and_body (mod.rs:930)        // 绑定参数 + 构建函数体
      → expr_into_dest(Place::return_place(), block, expr_id)  // expr/into.rs:26
        → 按 ExprKind 分派:
          ├─ Block → ast_block (block.rs:14) → ast_block_stmts (block.rs:34)
          │   ├─ StmtKind::Let → let 绑定 + 模式匹配 (place_into_pattern)
          │   ├─ StmtKind::Let with else_block → let-else 控制流 (block.rs:82-120)
          │   └─ 尾表达式 → expr_into_dest 递归
          ├─ Match → match_expr          // match/if-let desugaring
          │   → 每个 arm 创建新 BasicBlock → SwitchInt terminator 分支
          ├─ If → match_expr (if desugar 为 match)
          ├─ Loop → 循环创建回边 BasicBlock + Goto
          ├─ Call → push Assign + Call terminator
          └─ BinaryOp → as_rvalue → push Assign
        → push Statement (cfg.rs:32) / terminate with Terminator (cfg.rs:121)
    → builder.build_drop_trees()        // 构建 drop 控制流
    → builder.finish() (mod.rs:832)     // 组装 Body，检查所有块有 terminator
```

控制流映射：`if`/`match` → 多个 BasicBlock + `SwitchInt` terminator；`loop` → 回边 BasicBlock + `Goto`；`let-else` 失败 → 跳转 else 块。destructor 插入通过 `schedule_drop_value` 和 `build_drop_trees` 完成，生成 `Drop` terminator。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `build_mir_inner_impl` (`mod.rs:67`) | MIR 构建入口 | 先取 THIR 再 construct |
| `Builder::new` (`mod.rs:749`) | 初始化 CFG/scopes/local_decls | 封装构建状态 |
| `expr_into_dest` (`expr/into.rs:26`) | 按 ExprKind 构建到 dest Place | Category 分派 |
| `CFG::terminate` (`cfg.rs:121`) | 给 block 设 Terminator | 分支全在 Terminator |
| `build_drop_trees` | 构建 drop 控制流 | drop elaboration 基础 |

</details>

## 核心实现

### 为什么需要 MIR 层

HIR 保留高层语法（闭包、模式匹配、for 循环），直接 codegen 太复杂。MIR 将所有控制流统一为 CFG + basic block，把高级构造 desugar 为少数低级操作（`Assign`/`SwitchInt`/`Call`/`Drop`），大幅简化后续 pass。`syntax.rs` 文档注释明确定义 MIR 语义和 phase 约束。

### 为什么用 CFG + basic block

`BasicBlock`（`mod.rs:1273`）文档明确说"no branches within a basic block, which makes it easier to do data-flow analyses and optimizations"。basic block 内只有顺序 `Statement`，分支全在 `Terminator`，这是经典编译器设计——数据流分析（如 borrowck 的 NLL）依赖此结构。

### Place/Operand/Rvalue 抽象

`Place` 分离"位置"和"值"，`Operand` 区分 `Copy`/`Move`（move 语义在 MIR 层显式化），`Rvalue` 精确描述运算。这使 borrowck 能精确追踪 move 和 borrow（`syntax.rs:1092-1151` 详述 Place 语义）。`StatementKind::Assign` 不做 drop（"without the possibility of dropping the previous value"），drop 必须显式 `Drop` terminator——分离了赋值与析构语义。

### MirPhase 分层与 borrowck 专用 terminator

`MirPhase`（`syntax.rs:42`）分 `Built` → `Analysis` → `Runtime` 三 dialect。`FalseEdge`/`FalseUnwind`（`syntax.rs:910-934`）专为 borrowck 保守性设计——运行时是 `Goto`，但 borrowck 需考虑可能的 unwind 路径。`Drop` 在 analysis dialect 是条件的（dataflow 决定是否执行），runtime 变无条件；`FakeRead`/`AscribeUserType` 等仅存在于 analysis dialect，drop elaboration 后清除。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Builder | `Builder<'a,'tcx>` (`mod.rs:158`) + `CFG` (`mod.rs:389`) | 封装 CFG 构建状态 |
| BlockAnd 单子 | `BlockAnd<T>` + `unpack!` 宏 (`mod.rs:414/442`) | 强制使用返回值，`#[must_use]` |
| Category 分派 | `Category::of` (`expr/category.rs`) | 决定 `into`/`as_rvalue`/`as_operand`/`as_place` |
| Visitor | `rustc_middle/src/mir/visit.rs` | MIR 遍历框架 |

## 模块间交互

消费：HIR（经 typeck）→ THIR（`thir_body` query，`rustc_mir_build/src/thir/`）→ MIR 构建。`Builder` 直接引用 `Thir` 和 `TyCtxt`。产出：`Body<'tcx>` 经 `mir_built` query 产出，被 `rustc_mir_transform`（优化 pass）、`rustc_borrowck`、`rustc_const_eval`（CTFE）、`rustc_codegen_ssa`/`rustc_codegen_llvm` 消费。`MirPhase` 分层让不同消费者看到不同 dialect 的 MIR。

## 扩展方式

新增 `StatementKind`：改 `syntax.rs`（enum + `static_assert_size`）、`statement.rs`（`name()`）、`visit.rs`（Visitor）、`pretty.rs`（打印），若影响控制流还需改 `rustc_mir_transform` 相关 pass。新增 `TerminatorKind`：改 `syntax.rs`（enum）、`terminator.rs`（`successors`/`successors_mut`/`edges`/`unwind` 四个 match）、`visit.rs`/`pretty.rs`/`traversal.rs`，若新 terminator 有控制流还需改 `rustc_mir_transform` 的 CFG 操作 pass。
