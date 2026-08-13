---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "规则系统"
date: "2026-08-13T20:14:13+08:00"
category: ["Languages", "Python", "Tools", "Ruff", "CodeWiki", "0.16.2"]
tags: ["ruff", "Rust", "Lint Rules", "宏", "Preview"]
description: "ruff 的 900+ 规则系统——宏驱动定义、按来源家族组织、map_codes 注册、LintSource 分发、preview 渐进上线。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_linter/src/rules/` 是 ruff 的 900+ 内置 lint 规则实现，按来源家族组织（pyflakes/pyupgrade/isort/flake8_bugbear 等 60 族）。这个模块独立存在是因为**规则是 ruff 的核心资产，且需要与 linter 管线解耦**——规则作者只需写 struct + `impl Violation` + 检查函数，宏自动处理注册、noqa code、文档、preview 状态等元数据。按来源家族而非功能类别组织，让从 flake8 迁移的用户按前缀映射（F=Pyflakes, UP=Pyupgrade）即可一键启用整个家族。

## 模块架构

规则系统由三层构成：**规则定义**（每条规则一个 struct + `Violation` impl + 检查函数）、**规则注册**（`codes.rs` 的 `code_to_rule` + `map_codes` 宏生成 `Rule` enum）、**规则选择**（`rule_selector.rs` 按前缀/精确码选择 + preview 过滤）。每个家族是 `rules/` 下独立目录，含 `mod.rs`（模块声明 + `#[test_case]` 测试）、`rules/`（每规则一文件）、`settings.rs`（家族配置）、`fixes.rs`（fix 逻辑）。

## 调用链路

规则从定义到被 Checker 调用的完整路径：

```
规则作者编写:
  struct RaiseNotImplemented; + impl Violation + fn raise_not_implemented(checker, expr)
       │
       ▼
codes.rs: code_to_rule() 中一行映射
  (Pyflakes, "901") => rules::pyflakes::rules::raise_not_implemented::RaiseNotImplemented
       │
       ▼
#[ruff_macros::map_codes] 宏自动生成:
  pub enum Rule { RaiseNotImplemented, ... }  (900+ 变体, #[repr(u16)] 仅 2 字节)
  Rule::noqa_code() → NoqaCode("F", "901")
  Rule::explanation() → doc comment 文本
  Rule::group() → RuleGroup::Stable/Preview/Deprecated/Removed
       │
       ▼
registry.rs: Rule::lint_source() const fn
  RaiseNotImplemented → LintSource::Ast  (大多数 fallback 到 Ast)
       │
       ▼
checkers/ast/mod.rs: visit_expr 遇 Expr::Call:
  if checker.is_rule_enabled(Rule::RaiseNotImplemented) {
      rules::pyflakes::rules::raise_not_implemented::raise_not_implemented(checker, expr);
  }
```

| 概念 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Violation` trait | 规则接口（message/fix_title/FIX_AVAILABILITY） | `AlwaysFixableViolation` blanket impl 自动设 Always |
| `#[derive(ViolationMetadata)]` | 自动实现元数据 + 提取 stable_since/preview_since | 用 `file!()`/`line!()` 记录声明位置 |
| `#[derive_message_formats]` | 提取 message format 字面量供 noqa 匹配 | 自动生成 `message_formats()` |
| `Rule` enum | 900+ 规则索引 | `map_codes` 宏从 `code_to_rule` 生成，`#[repr(u16)]` |
| `RuleSelector` | 按前缀/精确码选择规则 | `specificity()` 排序解决 select/ignore 冲突 |

## 核心实现

### 规则定义：真实代码示例

```rust title="rules/pyflakes/rules/raise_not_implemented.rs"
#[derive(ViolationMetadata)]
#[violation_metadata(stable_since = "v0.0.18")]
pub(crate) struct RaiseNotImplemented;

impl Violation for RaiseNotImplemented {
    const FIX_AVAILABILITY: FixAvailability = FixAvailability::Sometimes;
    #[derive_message_formats]
    fn message(&self) -> String {
        "`raise NotImplemented` should be `raise NotImplementedError`".to_string()
    }
    fn fix_title(&self) -> Option<String> {
        Some("Use `raise NotImplementedError`".to_string())
    }
}

/// F901
pub(crate) fn raise_not_implemented(checker: &Checker, expr: &Expr) {
    let Some(expr) = match_not_implemented(expr) else { return; };
    let mut diagnostic = checker.report_diagnostic(RaiseNotImplemented, expr.range());
    diagnostic.try_set_fix(|| {
        let (import_edit, binding) = checker.importer().get_or_import_builtin_symbol(
            "NotImplementedError", expr.start(), checker.semantic(),
        )?;
        Ok(Fix::safe_edits(
            Edit::range_replacement(binding, expr.range()),
            import_edit,
        ))
    });
}
```

一条规则由三部分组成：**struct（携带诊断数据，无字段则无数据）** + **`Violation` impl（消息 + fix 声明）** + **检查函数（对 AST/Tokens 检测，触发诊断，可选设置 fix）**。规则通过 `checker.report_diagnostic(Type, range)` 创建诊断，返回 guard 后 `try_set_fix` 设置修复。fix 由 `Edit`（文本替换）组成，`Fix::safe_edits` 或 `Fix::unsafe_edit` 创建。

### 宏驱动的规则注册

```rust title="codes.rs"
#[ruff_macros::map_codes]
pub fn code_to_rule(linter: Linter, code: &str) -> Option<(RuleGroup, Rule)> {
    use Linter::*;
    Some(match (linter, code) {
        (Pycodestyle, "E101") => rules::pycodestyle::rules::MixedSpacesAndTabs,
        (Pyflakes, "F706")   => rules::pyflakes::rules::ReturnOutsideFunction,
        // ... 900+ 条映射
    })
}
```

`#[ruff_macros::map_codes]` 宏（`ruff_macros/src/map_codes.rs`）解析每个 match arm 的 `(Linter, "code") => path::ToRule` 三元组，自动生成：`pub enum Rule`（900+ 变体，`#[repr(u16)]` 仅 2 字节）、`Rule::noqa_code()`（返回 `NoqaCode("F", "706")`）、`Rule::explanation()`（doc comment 文本）、`Rule::group()`（Stable/Preview/Deprecated/Removed）、`RuleCodePrefix` 枚举、`Linter::rules()`。规则作者**无需手动修改 `Rule` 枚举**——加一行映射即可。

`#[derive(ViolationMetadata)]`（proc macro）从 `#[violation_metadata(stable_since="...")]` 提取 `RuleGroup`，从 doc comments 提取 `explain()` 内容，用 `file!()`/`line!()` 记录声明位置。`#[derive_message_formats]` 从 `message()` 函数体提取 `format!` 字面量，生成 `message_formats()` 供 noqa 匹配。

### Linter 枚举与前缀

```rust title="registry.rs"
#[derive(EnumIter, RuleNamespace)]
pub enum Linter {
    #[prefix = "F"]  Pyflakes,
    #[prefix = "UP"] Pyupgrade,
    #[prefix = "E"]
    #[prefix = "W"]  Pycodestyle,   // 支持多前缀
    // ... 60 个家族
}
```

`RuleNamespace` trait（derive 宏）提供 `common_prefix()` 和 `parse_code(code)`——将 `"F706"` 解析为 `(Linter::Pyflakes, "706")`。每个家族对应一个外部 linter 及其 noqa 前缀，用户可 `--select F` 一键启用整个 Pyflakes 家族，与原 linter 行为一致。

### Preview 渐进上线

```rust title="codes.rs"
pub enum RuleGroup {
    Stable { since: &'static str },
    Preview { since: &'static str },
    Deprecated { since: &'static str },
    Removed { since: &'static str },
}
```

规则通过 `#[violation_metadata(preview_since = "0.5.0")]` 声明 preview 状态。`rule_selector.rs:281` 的 `rules()` 方法按 `PreviewOptions` 过滤：Stable 始终包含；Preview 仅在 `preview_enabled` 时包含（若 `require_explicit` 则必须精确选择，不能用前缀）；Deprecated/Removed 仅精确选择时包含。`preview.rs` 为每个 preview 行为提供命名函数（如 `is_human_readable_names_enabled`），方便从 preview 提升为 stable 时定位代码。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 插件式规则架构 | 每家族一个 mod in `rules/` | 家族独立，对应外部 linter 文档 |
| 宏驱动定义 | `#[derive(ViolationMetadata)]` + `#[map_codes]` in `ruff_macros` | 作者只写 struct+impl，注册全自动 |
| LintSource 分发 | `Rule::lint_source()` const fn in `registry.rs:247` | 规则声明数据源，短路跳过未启用类型 |
| 策略选择 | `RuleSelector` + `specificity()` in `rule_selector.rs:418` | 解决 select/ignore 冲突，All→Linter→Prefix→Rule |

## 模块间交互

规则检查函数接收 `&Checker`（如 `fn raise_not_implemented(checker: &Checker, expr: &Expr)`），通过 `checker.semantic()` 访问 `SemanticModel`（作用域/绑定/类型信息），通过 `checker.importer()` 获取 import 工具，通过 `checker.report_diagnostic()` 发射诊断。`linter.rs` 的 `run_linter` 是调度器——通过 `context.iter_enabled_rules().any(|r| r.lint_source().is_tokens())` 检查是否有规则需要某 source，然后调对应 checker。

## 重要设计决策

**为什么按来源家族组织而非按类别？** 每个家族对应一个外部 linter 及其 noqa 前缀（F=Pyflakes, UP=Pyupgrade）——用户可 `--select F` 一键启用整个家族，与原 linter 行为一致；从 flake8 迁移的用户按前缀映射，规则文件组织与外部 linter 文档一一对应，降低迁移成本。

**规则声明 LintSource 类型**：大多数规则 fallback 到 `Ast`，只有需要特殊输入（tokens/物理行/文件系统）的规则显式列出。这是性能优化——`linter.rs` 通过 `.any(|r| r.lint_source().is_tokens())` 短路，若无 token 规则启用就跳过整个 token 检查阶段。

## 扩展方式

**新增一条 lint 规则**（以 Pyflakes `F999` 为例）：
1. `rules/pyflakes/rules/my_rule.rs`——定义 `#[derive(ViolationMetadata)]` struct + `#[violation_metadata(preview_since = "0.16.2")]` + `impl Violation` + 检查函数 `fn my_rule(checker: &Checker, ...)`
2. `rules/pyflakes/rules/mod.rs`——`pub(crate) mod my_rule;`
3. `codes.rs` 的 `code_to_rule` 加一行：`(Pyflakes, "999") => rules::pyflakes::rules::my_rule::MyRule`
4. `registry.rs:lint_source()`——若走非 AST 的 LintSource，在 match 添加映射
5. `checkers/ast/mod.rs` 的相关 visitor 方法——加 `if checker.is_rule_enabled(Rule::MyRule) { my_rule::my_rule(checker, ...) }`
6. `resources/test/fixtures/pyflakes/F999.py`——测试 fixture
7. `rules/pyflakes/mod.rs` 测试模块——`#[test_case(Rule::MyRule, Path::new("F999.py"))]`
8. （可选）`cargo codegen rules`——生成文档和规则列表

`#[map_codes]` 宏自动将新规则加入 `Rule` enum、生成 `noqa_code()`/`explanation()` 等方法，无需手动修改 `Rule` 枚举定义。
