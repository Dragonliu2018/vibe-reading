---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "Python 解析器"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "Parser", "递归下降", "Pratt", "Error Recovery"]
description: "ruff 自研的 Python 解析器——递归下降 + Pratt 表达式 + error recovery，在语法错误的代码上仍能产出可用 AST。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_python_parser/` 是 ruff 自研的 Python 解析器。它**不依赖 CPython 的 parser**，从零用 Rust 实现了词法分析（Lexer）和递归下降语法分析（Parser）。这个模块独立存在的根本原因：**ruff 作为 linter/formatter 必须能在语法不完美的代码上运行**——用户正在编辑的文件、CI 中有语法错误的代码都要能产出可用 AST。CPython 的 parser 遇到语法错误会停止并抛异常，不产出部分 AST；ruff 的 parser 内置 error recovery，即使有错误也返回 `Parsed<T>`（AST + 错误列表），让调用者自行决定是否拒绝。

## 模块架构

解析器采用**三层架构**：`Lexer`（字符→token，职责单一，不关心 parser 状态）→ `TokenSource`（缓冲、peek、checkpoint/rewind、trivia 过滤）→ `Parser`（递归下降，只与 TokenSource 交互）。分层使 Lexer 可独立测试，TokenSource 的 checkpoint 机制让 `peek()` 成为可能而无需重新 lex 整个文件。Parser 内部按语法构造拆分：`statement.rs`（语句递归下降）、`expression.rs`（表达式 Pratt）、`mod.rs`（核心循环 + error recovery + RecoveryContext）。

## 调用链路

```
parse_module(source)                          [lib.rs:112]
  └─ Parser::new(source, ParseOptions::from(Mode::Module))
       └─ TokenSource::from_source() → Lexer::new() + 首次 next_token()
  └─ Parser::parse()                          [parser/mod.rs:193]
       ├─ Mode::Module → parse_module()       [mod.rs:248]
       │    └─ parse_list_into_thin_vec(parse_statement)
       │         └─ parse_list()              [mod.rs:733]  ← error recovery 核心
       │              └─ loop { parse_statement() }  → statement.rs
       │                   └─ expression.rs: parse_binary_expression_or_higher()  Pratt
       │                        └─ parse_lhs_expression() → parse_atom()
       │    └─ bump(EndOfFile) → 返回 ModModule
       └─ finish(syntax)                      [mod.rs:262]
            └─ tokens.finish() → 合并 parse_errors + lex_errors
            └─ 返回 Parsed<Mod>
  └─ try_into_module().into_result()          → Result<Parsed<ModModule>, ParseError>
```

每步输入/输出：`parse_module(&str)` → `Parsed<ModModule>`；`Parser::parse()` 消费 `TokenSource` 产出 `Mod`；`parse_list()` 是错误恢复的汇聚点。

## 核心实现

### Parsed<T>：AST 与错误同时返回

```rust title="lib.rs"
pub struct Parsed<T> {
    syntax: T,                          // AST 根节点
    tokens: Tokens,                     // 全部 token（含 trivia）
    errors: Vec<ParseError>,            // 语法错误
    unsupported_syntax_errors: Vec<UnsupportedSyntaxError>, // 版本相关错误
}
```

`parse_unchecked()`（`lib.rs:289`）始终返回 `Parsed<T>` 而非 `Result`——这是核心 API 设计。`parse()` 只是它的 `into_result()` 薄包装。linter/formatter 调 `parse_unchecked_source()` 拿到 AST + errors，用 `has_valid_syntax()` 决定是否跳过 AST 规则。版本相关错误（如 `match` 在 3.9 不支持，但结构合法）与结构性语法错误分开存储，让 formatter 能忽略 version error 但不能忽略 parse error。

### Error Recovery：RecoveryContext bitmask

```rust title="parser/mod.rs"
pub(crate) fn parse_list<E>(...) {
    loop {
        self.progress.assert_progressing();        // 防死循环
        if self.is_list_element(...) { self.parse_element(); continue; }
        if self.is_regular_list_terminator() { break; }
        // 错误恢复：当前 token 是否属于外层列表？
        if self.is_enclosing_list_element_or_terminator() {
            self.tokens.re_lex_logical_token();
            break;   // 把控制权交还外层
        }
        self.add_error(...);
        self.bump_any();   // 跳过一个 token，继续循环
    }
}
```

`RecoveryContext`（`mod.rs:1010`）是一个 bitmask，通过 `RecoveryContextKind` 枚举描述当前所处的所有列表上下文（ModuleStatements、BlockStatements、Slices、Arguments 等），内层列表 union 外层上下文。遇到无法识别的 token 时，先检查它是否属于外层列表——是则 `re_lex` 后 `break` 交还外层，否则记录错误并 `bump_any` 跳过。这保证语法错误时仍能产出尽可能完整的 AST。

`ParserProgress`（`progress.rs:35`）用 `TokenId` 的 `wrapping_add` 检测 parser 是否在同一 token 上卡住——若 token ID 未变则 panic，这是防死循环的硬保护。

### Pratt 表达式解析

```rust title="parser/expression.rs"
// parse_binary_expression_or_higher() [expression.rs:246]
// 使用 OperatorPrecedence 做优先级攀爬，注释明确引用 Pratt parsing algorithm
// parse_binary_expression_or_higher_recursive() 内部递归实现
```

表达式不走递归下降而走 Pratt parsing（优先级攀爬）：每个运算符有左右结合优先级，parser 用 `OperatorPrecedence` 决定是否继续折叠。这避免了递归下降为每个优先级层级写一个方法（`parse_or`/`parse_and`/`parse_comparison`...）的样板代码，且天然支持任意优先级组合。`parse_atom()` 处理字面量、名字、括号等基础单元。

**结合性处理**：`parse_binary_expression_or_higher_recursive` 根据 `OperatorPrecedence::is_right_associative` 决定递归调用方式——左结合运算符（如 `+`）在同一层左折叠，右结合运算符（如 `**`）递归向下构造右倾 AST。每次递归通过 `with_recursion` 消耗一个深度配额，深度耗尽时不再展开子表达式（返回已解析部分），从而把递归深度限制与 Pratt 解析耦合在一起。

### Token 模型：trivia 与 non-trivia 混合存储

```rust title="token_source.rs"
// do_bump() 跳过 trivia 但仍将其存入 tokens vector
// finish() 一并返回完整 token 流（含注释、non-logical newline）
```

formatter 和某些 linter 规则需要访问注释（trivia token），但 parser 递归下降时不想处理它们。`TokenSource::do_bump()`（`token_source.rs:170`）跳过 trivia 但仍存入 `tokens` vector，`finish()` 一并返回。这样 parser 只看到 non-trivia token，消费者能拿到完整 token 流——一举两得。

### 递归深度限制对齐 CPython

```rust title="parser/options.rs"
const DEFAULT_MAX_RECURSION_DEPTH: u16 = 202; // CPython MAXSTACK(200) + 2
```

防止恶意/机器生成的深度嵌套代码栈溢出。默认值 202 = CPython `MAXSTACK`(200) + 2（外层 statement + 内层 atom 各一次调用），与 CPython 行为对齐。

**深度配额机制**：`Parser` 持有 `max_nesting_depth`（总上限）和 `depth_remaining`（剩余配额）两个字段。进入需计深的语法构造（如嵌套表达式、`parse_postfix_expression`）时调 `with_recursion`——它先检查 `depth_remaining`，耗尽时调 `report_recursion_limit_exceeded()` 记录一个 `ParseError` 并返回已解析部分（而非 panic），同时该函数会做必要的栈展开帮助外层快速退出递归。未耗尽时 `depth_remaining -= 1` 进入子解析，返回时恢复。这让深度限制成为贯穿解析全过程的可组合机制，而非单一硬检查。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 递归下降 | `parse_statement` in `statement.rs` | 每语法规则一方法，手动递归，可读性强 |
| Pratt Parsing | `parse_binary_expression_or_higher` in `expression.rs:246` | 避免每优先级层一方法的样板，天然支持任意优先级 |
| Error Recovery | `parse_list` in `mod.rs:733`，`RecoveryContext` in `mod.rs:1010` | bitmask 上下文栈 + re-lex + skip，保证错误时产出 AST |
| Progress Guard | `ParserProgress` in `progress.rs:17` | TokenId 检测卡死，防死循环 |
| Checkpoint/Rewind | `TokenSource::checkpoint/rewind` in `token_source.rs:194` | 投机 peek 无需重 lex 整文件 |
| Scratch Buffer | `ScratchBuffer<T>` in `parser/scratch_buffer.rs` | 复用 Vec 避免递归分配 |
| Strategy | `Mode` enum in `lib.rs:559` | Module/Expression/IPython 决定不同 parse 入口 |

## 模块间交互

**依赖**：`ruff_python_ast`（AST 节点定义）、`ruff_text_size`（TextRange）、`ruff_python_trivia`（whitespace 判断）、`unicode-ident`（标识符）、`unicode-normalization`（NFKC 名称归一化）。

**被依赖**：被 19 个 crate 依赖——`ruff_linter`、`ruff_python_formatter`、`ruff_python_semantic`、`ruff_db`、`ruff_python_index`、`ruff_server`、`ruff_wasm`、`ty_python_semantic` 等。是整个 ruff/ty 工具链的共享地基之一。

`SemanticSyntaxChecker`（`semantic_errors.rs:19`）作为独立后处理阶段存在——某些语法约束（如 `__future__` import 必须在文件开头、irrefutable match pattern）无法在递归下降中检测，需遍历完整 AST 后判断。由调用者在 AST visitor 中调用。

## 扩展方式

**支持新的 Python 语法特性**（如 PEP 引入新语法）：
1. `lexer.rs`——识别新 token（必要时在 `ruff_python_ast::token::TokenKind` 加 TokenKind）
2. `parser/statement.rs` 或 `expression.rs`——加递归下降分支（新运算符优先级则改 `OperatorPrecedence`）
3. `parser/mod.rs`——若新语法引入新列表上下文，在 `RecoveryContextKind`（`mod.rs:1157`）加变体并更新 `is_list_element`/`is_regular_list_terminator`/`create_error`
4. `ruff_python_ast`——加对应 AST 节点类型
5. `parser/options.rs`——若版本相关，更新 `PythonVersion` 检测
6. `semantic_errors.rs`——若有语义约束，在 `SemanticSyntaxChecker` 加检查
7. `parser/tests.rs` + `snapshots/`——测试与快照
