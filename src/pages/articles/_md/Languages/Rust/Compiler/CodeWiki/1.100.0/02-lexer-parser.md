---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "词法与语法分析"
date: "2026-08-19T14:57:00+08:00"
category: [Languages, Rust, Compiler, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "解析器", "CodeWiki"]
description: "rustc 的纯词法层、手写递归下降解析器与 AST 定义。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Compiler/CodeWiki/1.100.0/00-overview)

---

## 模块定位

这一层负责把源码文本翻译成结构化的抽象语法树（AST）。它分三步：纯词法（`rustc_lexer`，char→Token）、词法桥接（`rustc_parse::lexer`，Token→`rustc_ast::TokenKind`，做 interning/Span/转义校验）、手写递归下降解析（`rustc_parse::parser`，Token→AST）。`rustc_ast` 定义所有 AST 节点。这是编译器最"前端"的一层，其产物 `ast::Crate` 喂给宏展开。

## 模块架构

三层职责清晰分离：

- **`Cursor<'a>`**（`rustc_lexer/src/lib.rs:418`）：char 级 peekable 迭代器，提供 `first()/second()/third()` 前瞻与 `bump()` 消费。
- **`Lexer<'psess,'src>`**（`rustc_parse/src/lexer/mod.rs:123`）：在 `Cursor` 之上加 `ParseSess`、`Span`、转义校验，做"cook"——把 `rustc_lexer::TokenKind` 转为 `rustc_ast::TokenKind`。
- **`Parser<'a>`**（`rustc_parse/src/parser/mod.rs:187`）：手写递归下降解析器，核心字段 `token`/`prev_token`/`token_cursor`/`restrictions`/`recovery`，`static_assert_size!(Parser, 288)`。

AST 根节点（`rustc_ast/src/ast.rs`）：`Expr{id, kind: ExprKind, span, attrs, tokens}`（`:1397`）、`Item{attrs, id, span, vis, kind, tokens}`（`:3715`）、`Ty{id, kind: TyKind, span}`（`:2449`）、`Pat{id, kind: PatKind, span}`（`:625`）、`Stmt{id, kind: StmtKind, span}`（`:1195`）。每个 `*Kind` 枚举穷举该语法类的所有变体（`ExprKind` 30+ 变体，`ItemKind` 14 变体）。

## 调用链路

```
new_parser_from_file                // rustc_parse/src/lib.rs:111
  └→ new_parser_from_source_file    // :226
       └→ source_file_to_stream    // :260
            └→ lexer::lex_token_trees  // lexer/mod.rs:65
                 ├→ Cursor::new(src)   // rustc_lexer lib.rs:430
                 └→ Lexer.lex_token_trees() // lexer/mod.rs:100 递归构建 TokenTree
                      └→ next_token_from_cursor() // :160
                           ├→ cursor.advance_token() // rustc_lexer lib.rs:533  ← 纯词法
                           └→ "cook" TokenKind: intern Symbol、校验转义
            └→ Parser::new(stream)   // parser/mod.rs:343  ← bump 第一个 token

parse_crate_mod → parse_mod → parse_item → parse_item_common → parse_item_kind
                                                              ↓ 分发
                              parse_fn (function.rs) / parse_ty (ty.rs:105) / parse_expr (expr.rs:55)

parse_expr (expr.rs:55)
  └→ parse_expr_res → parse_expr_assoc_after_attrs (:145)  ← Pratt 解析入口
       ├→ parse_expr_prefix            // if/while/match/closure…
       └→ parse_expr_assoc_rest (:161) // 中缀运算符循环
            └→ check_assoc_op → while: bump → parse_expr_prefix (递归)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `advance_token` (`rustc_lexer lib.rs:533`) | 纯词法识别一个 token | `Token` 刻意不含 Span，仅 `len` |
| `next_token_from_cursor` (`lexer/mod.rs:160`) | cook 词法 token | intern Symbol + 转义校验 |
| `Parser::new` (`parser/mod.rs:343`) | 构造解析器 | bump 首个 token |
| `parse_expr` (`expr.rs:55`) | 解析表达式 | Pratt climbing 处理优先级 |
| `bump` (`mod.rs:1125`) | 消费当前 token | 更新 `prev_token` |
| `look_ahead` (`mod.rs:1148`) | 不消费地前瞻 | `dist==1` 快速路径覆盖 98% |

</details>

## 核心实现

### 为什么 lexer 和 parser 分开但 parser 里也有 lexer

`rustc_lexer` 是**纯词法层**（char→Token，无 Span、无 rustc 依赖，`lib.rs:3-7` 注释明确），可被 rust-analyzer、cargo 复用。`rustc_parse::lexer` 是**桥接层**，负责 "cook"——将 `rustc_lexer::TokenKind` 转为 `rustc_ast::TokenKind`，关键差异：interning Symbol（字符串→全局符号表）、转义校验（`rustc_literal_escaper`）、构建 `TokenTree`（保留分隔符结构）、附加 Span（`lexer/mod.rs:167-168`）。分离是因为词法逻辑可复用且无依赖，而 cook 需要 `ParseSess` 和 `source_map`。

### 手写递归下降 + Pratt 而非生成器

Item/Stmt/Ty 用手写递归下降（`parse_item_kind` 大 match 分发），表达式用 Pratt climbing（`parse_expr_assoc_rest`，`expr.rs:161`）。rustc 需要复杂的错误恢复（`maybe_consume_incorrect_semicolon`）、多 token lookahead（`check_inline_const` 看 dist 2-3）、token 捕获（`collect_tokens`/`break_last_token`）、宏卫生——这些在 yacc/LR 中极难表达。手写代码量大但控制力强，`parse_item_kind` 的大 match 分发清晰可维护。

### Token 拆分（unglue）

`break_last_token`（`mod.rs:219`）处理 `>>` → `>`+`>`（泛型嵌套如 `Option<Vec<u8>>`）和 `>>=` 三路拆分。拆分不通过正常 cursor，需 `LazyAttrTokenStream` 回填，以保留宏展开所需的原始 token 流。

### 错误恢复

分层恢复：token 级（`eat` 失败不 panic 而是 `false`）、产生式级（`parse_item_common` 失败返回 `None` 继续循环，`item.rs:193`）、全局级（`Recovery::Allowed` 门控 `maybe_recover_from_*` 系列）。恢复时用 `create_snapshot_for_diagnostic` 快照尝试解析，失败回滚——这实现了 Rust 顶级的错误诊断（一处错误后继续解析，一次报多个错误）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 手写递归下降 + Pratt | `parser/` 全部 | 复杂 lookahead/恢复/捕获，生成器难表达 |
| Lookahead/Bump | `bump`/`look_ahead` (`mod.rs:1125/1148`) | 高效消费与前瞻 |
| Token 拆分（unglue） | `break_last_token` (`mod.rs:219`) | 处理 `>>` 泛型嵌套 |
| 错误恢复 | `Recovery`/`maybe_recover_from_*` | 一处错误后继续，一次报多错 |
| Token 捕获 | `collect_tokens` + `CaptureState` (`mod.rs:273`) | 为宏展开保留原始 token 流 |

## 模块间交互

`rustc_lexer`（零 rustc 依赖）→ `rustc_parse::lexer`（cook + Span）→ `rustc_parse::parser`（递归下降→AST）→ `rustc_ast`（定义节点）。下游：`rustc_expand` 通过 `Parser` 解析宏输入产生新 AST 片段注入回 AST；`rustc_ast_lowering` 把最终 AST 降为 HIR。`rustc_ast` re-export `rustc_ast_ir`（IR trait）供多消费者复用。

## 扩展方式

新增语法特性（如 `gen` 块已在 `ExprKind::Gen`）：关键字在 cook 层识别（`rustc_span/src/symbol.rs` 的 `kw` 模块加符号），`parser/expr.rs` 加解析方法并在 `parse_expr_prefix` 分发。新增 token（如 `<=>`）：`rustc_lexer/src/lib.rs::advance_token` 加分支 → `rustc_ast/src/token.rs` 的 `TokenKind` 加变体 → `parser/expr.rs` 的 `check_assoc_op`/`BinOpKind` 加变体 → cook 层 `lexer/mod.rs` 可能需处理。
