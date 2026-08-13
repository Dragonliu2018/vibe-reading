---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "格式化器"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "Formatter", "IR", "Wadler-Leijen", "Black"]
description: "ruff 的格式化器——AST→FormatElement IR→Printer 两阶段，基于 Wadler-Leijen group/break 算法，对标 Black。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_formatter/`（语言无关的 IR 框架）+ `crates/ruff_python_formatter/`（Python 实现）是 ruff 的代码格式化器，对标 Black。这个模块独立存在的核心决策是**采用 IR 中间表示而非直接生成文本**（Black 是直接生成）。IR（`FormatElement`）是语言无关的——`ruff_formatter` 完全不知道 Python。两阶段设计（AST→IR→output）把"格式化逻辑"与"换行决策"解耦：第一阶段各 AST 节点生成 IR，第二阶段 `Printer` 用 Wadler-Leijen group 算法决定实际换行。

## 模块架构

格式化器分为通用框架（`ruff_formatter`）与 Python 实现（`ruff_python_formatter`）两层。通用框架核心组件：`FormatElement`（IR 枚举）、`Format` trait（类似 `Display`，输出到 IR buffer）、`Formatter`（IR 写入器）、`Printer` + `FitsMeasurer`（IR→output，执行 group 算法）。Python 侧核心：`FormatNodeRule<N>` trait（每个 AST 节点一规则）、`comments/`（注释放置）、`expression/`+`statement/`（节点格式化规则）。`format_module_source()` 是顶层入口。

## 调用链路

```
format_module_source(source, options)          [ruff_python_formatter/lib.rs:137]
  ├─ parse(source, ...) → Parsed<Mod>          (ruff_python_parser)
  ├─ TriviaRanges::from(parsed.tokens())       提取注释/空白
  ├─ format_module_ast()                       [lib.rs:148]
  │   └─ format_node()                         [lib.rs:157]
  │       ├─ Comments::from_ast()              构建注释映射 (node→leading/dangling/trailing)
  │       ├─ format!(PyFormatContext, [parsed.syntax().format()])
  │       │   └─ AST 节点递归 FormatNodeRule::fmt → fmt_fields
  │       │      每节点生成 FormatElement 写入 buffer
  │       └─ assert_all_formatted()            debug 断言所有注释已处理
  └─ formatted.print()                         [lib.rs:324]
      └─ Printer::print(document)              [ruff_formatter/printer/mod.rs:51]
          └─ print_with_indent()               [mod.rs:58]
              └─ loop: print_element()         遇 group → fits()? → flat/expanded
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `format_module_source()` in `lib.rs:137` | 顶层入口：parse→IR→print | 两阶段，IR 是契约 |
| `FormatNodeRule::fmt()` in `lib.rs:53` | 节点格式化统一入口 | 自动处理 leading/trailing comments + source_position |
| `Printer::print_with_indent()` in `printer/mod.rs:58` | IR→output | 遍历 IR，group 用 FitsMeasurer 决定 flat/expanded |
| `flat_group_print_mode()` in `printer/mod.rs:402` | group 模式决策 | FitsMeasurer 预测量宽度 |
| `format_range()` in `range.rs:52` | 范围格式化（LSP 用） | 格式化最小包围节点 + source map 切片 |

## 核心实现

### FormatElement：语言无关的 IR

```rust title="ruff_formatter/src/format_element.rs"
/// Language agnostic IR for formatting source code.
pub enum FormatElement {
    Space,
    Line(LineMode),          // Soft/SoftOrSpace/Hard/Empty
    ExpandParent,            // 强制父 group 展开
    Token { text: &'static str },
    Text { text: Box<str>, text_width: TextWidth },
    SourceCodeSlice { slice: SourceCodeSlice, text_width: TextWidth },
    BestFitting { variants, mode },   // 多变体择优
    Tag(Tag),                // start/end: group/indent/align/conditional/fill/...
    // ...
}

pub enum LineMode {
    SoftOrSpace, // flat→空格, expanded→换行
    Soft,        // flat→省略, expanded→换行
    Hard,        // 总是换行
    Empty,       // 总是换行 + 空行
}
```

`FormatElement` 枚举没有任何 Python 概念（文件头注释 "Language agnostic IR"）。`Line(Soft)` 不立即决定是否换行，留给 Printer 根据实际行宽决定。`Tag` 包含 `StartGroup`/`StartIndent`/`StartAlign`/`StartConditionalContent`/`StartFill`/`StartLineSuffix`/`StartVerbatim` 等结构化标记。`Group` 用 `Cell<GroupMode>` 实现内部可变模式（Flat/Expand/Propagated）。

### group 的 soft line breaking 算法

核心在 `flat_group_print_mode()`（`printer/mod.rs:402`）：

1. 遇 `StartGroup`，先检查 `measured_group_fits`（父 group 是否已确认 fits），若是则直接 Flat
2. 否则调 `fits()` → `FitsMeasurer::fits()`（`mod.rs:1099`）——以 Flat 模式模拟遍历，累积 `line_width`：
   - `Line(Soft)` in Flat → 跳过（不换行）
   - `Line(Hard/Empty)` → 硬换行，`must_be_flat` 时返回 `Fits::No`
   - `Text` → 累加 `text_width`，超 `line_width` → `Fits::No`
3. fits → Flat（soft lines 省略/变空格）；不 fits → Expanded（soft lines 变换行）
4. 换行传播：`ExpandParent` 元素或子 group 的 `Propagated` 模式强制父 group 展开

`FitsMeasurer`（`mod.rs:1044`）是轻量只读遍历器，模拟打印但不写 buffer，只追踪宽度。`measured_group_fits` 优化：若父 group 已 fits，子 group 不需重新测量。

### FormatNodeRule：Python 节点格式化

```rust title="ruff_python_formatter/src/lib.rs"
pub(crate) trait FormatNodeRule<N>
where N: Ranged, for<'a> AnyNodeRef<'a>: From<&'a N> {
    fn fmt(&self, node: &N, f: &mut PyFormatter) -> FormatResult<()> {
        // 自动处理: leading comments → source_position → fmt_fields → trailing comments
    }
    fn fmt_fields(&self, item: &N, f: &mut PyFormatter) -> FormatResult<()>;
}
```

每个 Python AST 节点类型有对应 rule 实现（如 `statement/if_.rs`、`expression/call.rs`），在 `fmt_fields` 中递归格式化子节点生成 IR。`fmt` 方法自动处理前后注释和 source map，子类只需实现 `fmt_fields`。这是 trait dispatch + 递归下降，非经典 visitor。

### Comments 独立处理

```rust title="ruff_python_formatter/src/comments/mod.rs"
// Comments::from_ast() 遍历 AST + trivia，为每个注释确定归属节点
// CommentsMap<'a> = MultiMap<NodeRefEqualityKey<'a>, SourceComment>
// FormatNodeRule::fmt() 自动调用 leading_comments()/trailing_comments()
// assert_all_formatted() 确保每个注释标记为 formatted
```

**为什么注释要单独处理？** 注释可出现在几乎任何位置，但 AST 不含注释节点。若让每节点自行处理注释，组合爆炸不可管理。解决方案：将注释关联到最近 AST 节点（leading/dangling/trailing），在 `FormatNodeRule::fmt()` 统一处理——节点格式化代码只关注 `fmt_fields`，注释由框架自动放置。Python 不支持真正 inline 注释（注释总从 `#` 到行尾），大大简化问题。幂等性保证：按节点关联 + leading/trailing 分类使重新格式化不改变注释位置。

**格式化跟踪与 `Rc`**：每个 `SourceComment` 用 `Cell<bool>` 跟踪 `formatted` 状态（`is_formatted()` 查询）。`FormatNodeRule::fmt` 自动处理 leading/trailing，但 **dangling comments 必须在 `fmt_fields` 中手动处理**——否则 `assert_all_formatted()` debug 断言会失败（它遍历所有注释检查 `is_formatted`）。`Comments` 用 `Rc` 包装使生命周期独立于 `Formatter`——注释映射可在格式化器之间共享，无需重复构建。`CommentsMap` 是 `MultiMap<NodeRefEqualityKey, SourceComment>`，按节点身份键关联三类注释。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| IR 模式（两阶段） | `Format` trait + `Printer` | AST→IR→output，格式化逻辑与换行决策解耦 |
| Wadler-Leijen group/break | `Printer` + `FitsMeasurer` in `printer/mod.rs` | 经典 group fitting，soft line 按行宽决定 |
| trait dispatch | `FormatNodeRule<N>` in `lib.rs:53` | 按节点类型分发格式化规则 |
| BestFitting | `FormatElement::BestFitting` | 多变体（flat→expanded）择优，比 group 更灵活 |
| Fill 模式 | `Tag::StartFill` in `printer/mod.rs:640` | 尽量填满一行（类似 Prettier fill） |

## 模块间交互

```
ruff crate (commands/format.rs)
    ↓ format_module_source()
ruff_python_formatter
    ↓ 消费
ruff_python_parser::parse() → Parsed<Mod>
ruff_python_ast::*  (AST 节点)
ruff_python_trivia::TriviaRanges  (注释位置)
    ↓ 生成
ruff_formatter::FormatElement[] (IR document)
    ↓ 打印
ruff_formatter::Printer → Printed (String)
```

`ruff` crate 的 `commands/format.rs` 调 `format_module_source()` 或 `format_range()`。`formatted_file()`（`lib.rs:181`）提供基于 `ruff_db` 的接口，供 language server 场景使用。

## 重要设计决策

**为什么用 IR 而非直接生成文本（Black 是直接生成）？** (1) **关注点分离**——`ruff_formatter` 是通用框架，`ruff_python_formatter` 是 Python 特定逻辑，IR 是两者契约；(2) **延迟决策**——IR 中 `Line(Soft)` 不立即决定换行，留给 Printer 根据实际行宽决定，允许换行决策向上传播（`ExpandParent`/`Propagated`），直接生成文本很难做到；(3) **可测试性**——IR 可独立调试（`dbg!(formatted.document().display(...))`）；(4) **复用性**——同一 IR 框架可为其他语言复用。

**如何保证与 Black 兼容？** 不通过算法等价，而是**测试驱动**——大量 snapshot 测试，每个 `FormatNodeRule` 实现对标 Black 具体行为；`magic_trailing_comma` 选项对标 Black；`verbatim`（`VerbatimKind::Suppressed`）处理 `# fmt: skip`/`# fmt: off` 区域原样保留；`preview` 模式承载实验性行为。

**Range formatting 如何实现？** `format_range()`（`range.rs:52`）：`find_enclosing_node()` 找完全包含 range 的最深节点（限制为"逻辑行起始节点"保证一致性）→ `narrow_range()` 缩小 → 启用 `SourceMapGeneration::Enabled` → 格式化包围节点 → `Printed::slice_range()` 用 source map 从结果提取对应片段并修复缩进。不支持子表达式格式化（添加括号可能改变可分割性）。

## 扩展方式

**为某个 Python AST 节点定制格式化**（如修改 `Call` 的格式化）：
1. `crates/ruff_python_formatter/src/expression/call.rs`——修改 `FormatNodeRule<Call>` 的 `fmt_fields`，调整 group/line/indent 组合
2. 如有特殊注释需求（dangling comments），在 `fmt_fields` 手动处理
3. `resources/test/fixtures/`——添加测试用例
4. 如需通用 IR 扩展——改 `ruff_formatter/src/format_element.rs` 的 `FormatElement` + `tag.rs` 的 `Tag` + `printer/mod.rs` 的 `print_element` 和 `FitsMeasurer::fits_element`
