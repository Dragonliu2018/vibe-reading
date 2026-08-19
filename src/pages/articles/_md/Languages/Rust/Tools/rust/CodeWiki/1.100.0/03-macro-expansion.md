---
source:
  type: "源码解读"
  project: "Rust"
  url: "https://github.com/rust-lang/rust"
title: "宏展开"
date: "2026-08-19T14:58:00+08:00"
category: [Languages, Rust, Tools, rust, CodeWiki, "1.100.0"]
tags: ["Rust", "rustc", "宏", "CodeWiki"]
description: "rustc 的宏展开引擎：固定点迭代、placeholder、hygiene 与内建宏注册。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/rust/CodeWiki/1.100.0/00-overview)

---

## 模块定位

Rust 的宏系统（`macro_rules!`、proc_macro、derive、属性宏）在编译早期介入：它把 AST 中的宏调用展开为真实 AST 片段。这一层特殊之处在于——宏展开与**名称解析互相依赖**（宏路径需先解析才能展开，展开又产出新导入），因此不能简单一遍跑完，而要用**固定点迭代**反复展开直到不再有新宏调用。涉及 crate：`rustc_expand`（展开引擎）、`rustc_builtin_macros`（内建宏如 `format!`/`println!`/`asm!`）、`rustc_feature`（feature gate）。

## 模块架构

- **`SyntaxExtension`**（`rustc_expand/src/base.rs:775`）：宏定义的"已编译"形态，持有 `SyntaxExtensionKind`、`span`、`allow_internal_unstable`、`edition`、`builtin_name` 等。`SyntaxExtensionKind`（`:683`）是枚举，区分八种宏：`MacroRules`、`Bang`（proc_macro 函数式）、`LegacyBang`、`Attr`/`LegacyAttr`、`Derive`/`LegacyDerive`、`NonMacroAttr`、`GlobDelegation`。
- **`ExtCtxt`**（`base.rs:1190`）：展开上下文，贯穿整个展开过程，持有 `Session`、`ExpansionConfig`、`resolver: &mut dyn ResolverExpand`、`current_expansion: ExpansionData`（含 `depth`、`id: LocalExpnId`）。
- **`MacroExpander`**（`expand.rs:440`）：固定点迭代器，核心字段仅 `cx` 和 `monotonic`。
- **`AstFragment`**（`expand.rs:67`）：宏展开的产物，有 `Expr`/`Items`/`Stmts`/`Arms` 等 18 种 fragment kind。
- **`BangProcMacro` trait**（`base.rs:314`）：proc_macro 函数式宏的接入点，`fn expand(&self, ecx, span, ts: TokenStream) -> Result<TokenStream, ErrorGuaranteed>`。

## 调用链路

```
expand_crate()                              // expand.rs:450 入口
  └→ fully_expand_fragment(Crate)           // expand.rs:471 核心固定点循环
       ├→ collect_invocations()             // expand.rs:626  InvocationCollector(MutVisitor) 遍历 AST
       │    └→ 遇 ExprKind::MacCall/attribute → collect() → 生成 placeholder(NodeId)
       ├→ resolve_imports()                 // 先解析 import，尽快解析已导入宏
       └→ loop {                            // 固定点迭代
            ├→ resolve_macro_invocation()   // base.rs:1055  ResolverExpand::resolve_macro_invocation
            │    └→ Ok(ext) → 展开；Err(Indeterminate) → 推入 undetermined
            ├→ expand_invoc(invoc, &ext.kind)  // expand.rs:700 分发
            │    ├─ Bang + SyntaxExtensionKind::Bang → expander.expand(cx, span, ts)
            │    ├─ Bang + as_legacy_bang() → TTMacroExpander::expand → expand_macro()
            │    │    └→ try_match_macro → transcribe() → ParserAnyMacro::make() → parse_ast_fragment()
            │    ├─ Attr → AttrProcMacro::expand_with_safety()
            │    └─ Derive → MultiItemModifier::expand() / expand_derive()
            ├→ ExpandResult::Ready(fragment) → collect_invocations(fragment) // 递归
            └→ ExpandResult::Retry(invoc) → 推入 undetermined  // 等下一轮
       }
       // 循环结束后，PlaceholderExpander 把展开结果填回 AST  // placeholders.rs:206
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `fully_expand_fragment` (`expand.rs:471`) | 固定点展开循环 | ORN 机制 + undetermined 重试 |
| `collect_invocations` (`expand.rs:626`) | 收集宏调用并插 placeholder | 保留 AST 结构完整 |
| `expand_invoc` (`expand.rs:700`) | 按 kind 分发到不同 expander | 策略模式 |
| `resolve_macro_invocation` (`base.rs:1055`) | 解析宏路径返回 extension | `Indeterminate` 表示暂不可定 |
| `register_builtin_macros` (`builtin_macros lib.rs:61`) | 注册内建宏 | 注册表模式 |

</details>

## 核心实现

### ORN（Once-Recurse-Noop）机制

`fully_expand_fragment` 在 `expand_invoc` 展开单个宏后，立即对产物调用 `collect_invocations` 递归收集新宏（Once-Recurse）。无法解析的宏推入 `undetermined_invocations`，等下一轮 `resolve_imports` 后重试。当无进展时进入 `force_mode`（Noop——用 `DummyResult` 填充），避免死循环（`expand.rs:499`）。深度超过 `recursion_limit` 时折半降低限制并返回 dummy（`:710-719`）。

### Placeholder 机制

宏调用出现在 AST 的各种位置（表达式、语句、item、match arm），但展开是异步的。`collect_invocations` 把宏调用替换为 placeholder（`placeholders.rs:12`，带 `NodeId` 的 dummy `MacCall`），AST 结构保持完整，resolver 可基于 placeholder 构建 reduced graph。展开完成后 `PlaceholderExpander`（`:227`）用 `is_placeholder` 标志识别并替换回真实展开结果。这避免了在展开过程中维护不完整 AST 的复杂性。

### Hygiene

`MacroRulesMacroExpander` 持有 `transparency: Transparency`（`macro_rules.rs:199`），在 `transcribe` 时据此决定 identifier 的 `SyntaxContext`。`ExtCtxt` 提供 `with_def_site_ctxt`/`with_call_site_ctxt`/`with_mixed_site_ctxt`（`base.rs:1282-1296`）三种 span 混合策略，分别对应 proc_macro API 的 `def_site`/`call_site`/`mixed_site`。`SyntaxExtension::expn_data`（`:994`）为每个展开点生成 `ExpnData`，记录 `call_site`/`def_site`/`allow_internal_unstable`。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 固定点迭代 | `fully_expand_fragment` (`expand.rs:471`) | 宏展开与 name resolution 交错 |
| Visitor | `InvocationCollector` (`expand.rs:2096`) / `PlaceholderExpander` (`placeholders.rs:227`) | 遍历 AST 收集/回填 |
| 注册表 | `register_builtin_macros` (`builtin_macros lib.rs:61`) | 统一注册 `asm!`/`format!`/`derive` 等 |
| 策略 | `SyntaxExtensionKind` 分发到 `BangProcMacro`/`TTMacroExpander`/`MultiItemModifier` | 不同宏类型不同展开策略 |
| 模板方法 | `MacResult` trait (`base.rs:420`) | `MacEager`/`DummyResult` 具体实现 |

## 模块间交互

- **rustc_ast**：提供 `Expr`/`Item`/`MacCall`、`MutVisitor`/`Visitor`、`TokenStream`。
- **rustc_parse**：`Parser` 把宏产出的 TokenStream 重新解析为 AST fragment（`parse_ast_fragment` at `expand.rs:1079`）。
- **rustc_span (hygiene)**：`ExpnData`/`LocalExpnId`/`Transparency`/`SyntaxContext` 构成 hygiene 体系。
- **rustc_resolve**：通过 `ResolverExpand` trait（`base.rs:1033`）暴露给 expander——`resolve_macro_invocation`/`resolve_imports`/`visit_ast_fragment_with_placeholders`，这是宏展开与名称解析交错进行的关键接口。
- **rustc_builtin_macros**：独立 crate 注册 `asm!`/`assert!`/`cfg!`/`concat!`/`format_args!`/`stringify!` 等 bang 宏，`Clone`/`Copy`/`Debug`/`Default`/`Eq`/`Hash`/`Ord` 等 derive 宏。

## 核心实现：为什么 builtin macro 单独成 crate

`rustc_builtin_macros` 依赖 `rustc_expand` 的 trait（`BangProcMacro`/`MacroExpanderFn` 等），若放在 `rustc_expand` 内会造成循环依赖——`rustc_expand` 不能依赖自身。独立 crate 也便于编译并行化和关注点分离：`rustc_expand` 是引擎，`rustc_builtin_macros` 是插件。proc_macro 走 server/client 架构：`quote` 宏通过 `rustc_proc_macro::bridge::client::Client::expand1` 注册（`lib.rs:148`），编译器侧（server）通过 `BangProcMacro` trait 调用，用户 proc_macro 在独立上下文执行，token 序列化跨边界传递，保证用户代码 panic 不 crash 编译器。

## 扩展方式

新增 builtin bang 宏（如 `foo!`）：在 `rustc_builtin_macros/src/` 新建 `foo.rs` 实现 `expand_foo`，在 `lib.rs` 的 `register_bang!` 块加 `foo: foo::expand_foo`，如有 feature gate 在 `rustc_feature` 注册。修改 `macro_rules` 展开：匹配逻辑在 `rustc_expand/src/mbe/macro_parser.rs` 的 `TtParser`，转录在 `mbe/transcribe.rs` 的 `transcribe`，错误诊断在 `macro_rules.rs::expand_macro → try_match_macro → failed_to_match_macro` 链路。
