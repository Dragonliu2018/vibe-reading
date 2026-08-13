---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "Linter 核心管线"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "Linter", "Checker", "Visitor", "Fix"]
description: "ruff linter 的核心编排——多源 checker 分发、Checker AST 遍历、deferred 延迟分析、noqa 抑制、fix 收敛循环。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_linter/src/`（核心：`linter.rs` + `checkers/`）是 ruff 的 lint 编排核心。它**不实现具体规则**（那是 `rules/` 的事），而是负责：解析后对单个文件运行多类 checker、收集诊断、noqa 抑制、自动修复（fix）收敛循环。这个模块独立存在是因为**编排逻辑与规则实现必须解耦**——`check_path()` 按 `lint_source()` 把规则分发到不同 checker，fix 引擎的"应用-重解析-再检查"循环需要独立于任何具体规则。它是所有 lint 行为的汇聚点。

## 模块架构

核心组件呈"一个编排器 + 多类 checker + 一个 fix 引擎"结构：`check_path()`（`linter.rs:119`）是编排器，按 `lint_source()` 分发到 `check_tokens`/`check_ast`/`check_imports`/`check_physical_lines`/`check_file_path`/`check_noqa`；`Checker`（`checkers/ast/mod.rs`）是最重的组件——实现 `Visitor` 遍历 AST，驱动 `SemanticModel` 并分发规则；`lint_fix()`（`linter.rs:544`）是 fix 收敛循环；`LintContext` 是诊断收集器。`Checker` 持有 `SemanticModel` + 两个 deferred 队列 + 对 `LintContext` 的引用。

## 调用链路

### check_path：多源 checker 分发

```
check_path(path, locator, stylist, indexer, directives, settings, noqa, source_kind, source_type, parsed, target_version, suppressions)
                                              [linter.rs:119]
  ├─ 创建 LintContext (new: 初始化 RuleTable, 应用 per_file_ignores)
  ├─ [1] check_tokens()        — 若任一启用规则 lint_source().is_tokens()
  ├─ [2] check_file_path()     — 若任一启用规则 lint_source().is_filesystem()
  ├─ [3] check_logical_lines() — 若任一启用规则 lint_source().is_logical_lines()
  ├─ [4] check_ast()           — 仅当 parsed.has_valid_syntax()
  │     └─ [4a] check_imports() — 若启用 isort 且未 skip_file
  ├─ [5] check_physical_lines()— 若任一启用规则 lint_source().is_physical_lines()
  ├─ [6] check_noqa()          — 若 noqa.is_enabled()
  └─ diagnostics_to_messages() — 合并 parse_errors + diagnostics
```

**分发策略**：每类 checker 执行前都通过 `context.iter_enabled_rules().any(|r| r.lint_source().is_Xxx())` 快速跳过。`lint_source()` 是 `const fn`，编译器可内联优化。AST checker 仅在 `has_valid_syntax()` 时运行，但 token/physical-line checker 即使语法错误也运行——容错设计。

### lint_fix：fix 收敛循环

```
lint_fix(...)                                  [linter.rs:544]
  ├─ transformed = Cow::Borrowed(source_kind)
  ├─ MAX_ITERATIONS = 100
  └─ loop {
       ├─ parse_unchecked_source(&transformed)   // 重新解析
       ├─ check_path(...)                         // 完整 lint
       ├─ 语法安全检查：若 fix 引入语法错误 → 回滚返回 Err
       ├─ fix_file(&diagnostics, &locator, unsafe_fixes)  // 应用不重叠 fix
       ├─ 有修复 && iterations < 100 → transformed = 修复后源码; continue
       ├─ 有修复 && iterations >= 100 → report_failed_to_converge_error()
       └─ 无修复（收敛）→ return Ok(FixerResult)
     }
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `check_path()` in `linter.rs:119` | 多源 checker 编排 | `lint_source()` const fn 分发，AST 仅在有效语法时运行 |
| `check_ast()` in `ast/mod.rs:3332` | AST 遍历 + 规则触发 | Checker 实现 Visitor，deferred 延迟分析 |
| `lint_fix()` in `linter.rs:544` | fix 收敛循环 | 应用-重解析-再检查，≤100 轮，语法错误回滚 |
| `apply_fixes()` in `fix/mod.rs:54` | 单轮 fix 应用 | 按位置排序，跳过重叠，IsolationLevel 防删空 block |

## 核心实现

### Checker：AST 遍历器 + 规则分发器

```rust title="checkers/ast/mod.rs"
pub(crate) struct Checker<'a> {
    pub(crate) module: Module<'a>,
    semantic: SemanticModel<'a>,          // 语义模型，遍历中逐步构建
    visit: deferred::Visit<'a>,           // 延迟访问节点（函数体等）
    analyze: deferred::Analyze,           // 延迟分析节点（for 循环等）
    importer: Importer<'a>,
    context: &'a LintContext<'a>,         // 引用而非拥有诊断收集器
    semantic_checker: SemanticSyntaxChecker,
    // ...
}
```

`Checker` 实现 `Visitor<'a>`，每个 `visit_*` 方法遵循四步模式（`mod.rs:6-22` 文件头注释明确描述）：**Binding**（绑定当前节点引入的名称）→ **Traversal**（递归子节点）→ **Clean-up**（节点完成后清理）→ **Analysis**（在当前节点运行 lint 规则）。例如 `visit_stmt`（`mod.rs:970`）先 `push_node` 更新语义模型、设置 flags（`IMPORT_BOUNDARY`/`MODULE_DOCSTRING_BOUNDARY`），snapshot flags，然后按 stmt 类型分发——遇 `Stmt::FunctionDef` 时创建 Function scope + 绑定 + 将 body 推入 `visit.functions`（deferred!），并内联调用各规则函数（`pyflakes::rules::late_future_import` 等，每次前 `is_rule_enabled` 快速跳过）。

### deferred 延迟分析

```rust title="checkers/ast/deferred.rs"
pub(crate) struct Visit<'a> {
    pub functions: Vec<Snapshot>,              // 函数体延迟
    pub lambdas: Vec<Snapshot>,
    pub class_bases: Vec<(&'a Expr, Snapshot)>,
    pub string_type_definitions: Vec<(&'a ExprStringLiteral, Snapshot)>,
    pub future_type_definitions: Vec<(&'a Expr, Snapshot)>,
}
pub(crate) struct Analyze {
    pub scopes: Vec<ScopeId>, pub for_loops: Vec<Snapshot>,
    pub with_statements: Vec<Snapshot>, pub comprehensions: Vec<Snapshot>,
}
```

**为什么需要延迟？** Python 的前向引用语义要求函数体在模块级所有定义完成后才执行分析。若立即遍历函数体，`SemanticModel` 中全局绑定信息不完整会误报——如函数内引用后面定义的全局变量。`visit_deferred()`（`mod.rs:3190`）按特定顺序二次处理：class_bases → functions → type_params → lambdas → future_type_definitions → string_type_definitions，每次 `semantic.snapshot()` → `restore()` 恢复定义时的作用域/flags 上下文。

### noqa 三层抑制

```rust title="checkers/noqa.rs"
// 三层抑制（优先级从高到低）：
// 1. File-level: # ruff: noqa: F401  → FileNoqaDirectives::extract()
// 2. Range-based: # pyright: ignore  → Suppressions::from_tokens()
// 3. End-of-line: # noqa: F401       → NoqaDirectives::from_commented_ranges()
//    通过 noqa_line_for.resolve(offset) 映射到正确行（处理多行语句）
```

流程（`checkers/noqa.rs:59`）：遍历所有 diagnostic 依次尝试三层抑制，被抑制的记录到 `ignored_diagnostics`，在 `check_path()` 中 `swap_remove`。同时检查 unused noqa（RUF100）、redirected noqa（RUF101）、invalid code（RUF102）。

### fix 收敛循环

```rust title="fix/mod.rs"
// apply_fixes() 单轮修复：
// - 按 fix 的 min_start() 位置排序
// - 维护 last_pos 和 applied: BTreeSet<&Edit> 去重
// - last_pos >= first.start() → 跳过重叠 fix
// - 支持 IsolationLevel::Group(id) 防止同 block 删多个语句致语法错误
// - 特殊排序：RedefinedWhileUnused 优先于 UnusedImport
```

**为什么"应用-重解析-再检查"循环？** (1) fix 之间有依赖——删未使用 import 后相关 F401 消失，只做一轮会留不存在的诊断；(2) fix 可能触发新问题——`super(Foo,self)`→`super()` 后 `Foo` 变未使用变量，重新检查捕获级联；(3) fix 冲突需避免——同轮重叠 edit 跳过，下轮重解析后可能不再冲突；(4) 语法安全——每轮检查 `parsed.errors()`，fix 引入语法错误立即回滚；(5) `MAX_ITERATIONS=100` 防规则间震荡。

### DiagnosticGuard：RAII 诊断提交

```rust title="checkers/ast/mod.rs"
// report_diagnostic 返回 DiagnosticGuard，Drop 时提交到 LintContext
// 此前可通过 DerefMut 修改 fix/parent range
// defuse() 可取消发射
// resolve_applicability() 按 unsafe_fixes 设置降级 unsafe fix
```

规则通过 `checker.report_diagnostic(ViolationType, range)` 创建诊断，返回 `&mut Diagnostic`（实为 guard），链式 `try_set_fix(|| { ... Fix::safe_edits(...) })` 设置修复。guard 在 Drop 时根据 `unsafe_fixes` 设置和 fix 的 `Applicability` 决定是否保留 fix——`UnsafeFixes::Disabled` 时 unsafe fix 降级为 None，集中管控安全性。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor 模式 | `Checker` impl `Visitor` in `mod.rs:969` | 四步遍历（Binding/Traversal/Cleanup/Analysis） |
| 策略分发 | `LintSource` + `Rule::lint_source()` in `registry.rs:247` | 规则声明数据源，`check_path` 按类型路由 |
| 命令模式 | `Violation` trait，每规则一类型 | 规则封装自己的 message/fix_title |
| 收敛循环 | `lint_fix()` in `linter.rs:544` | 应用-重解析-再检查直到无新 fix |
| RAII Guard | `DiagnosticGuard` in `mod.rs:3615` | Drop 提交诊断，链式修改，defuse 取消 |

## 模块间交互

**上游**：`ruff_python_parser`（Parsed/Tokens/ParseError）、`ruff_python_ast`（Stmt/Expr/Visitor）、`ruff_python_semantic`（SemanticModel/Scope/Binding）、`ruff_python_codegen`（Stylist）、`ruff_python_index`（Indexer）、`ruff_diagnostics`（Fix/Edit/Applicability）、`ruff_db::diagnostic`（Diagnostic）、`ruff_notebook`。

**下游**：`ruff` crate 的 `commands/check.rs` 调 `lint_only()`/`lint_fix()`。`check_path()` 被三者调用：`lint_only`、`lint_fix`、`add_suppressions_to_path`。

**规则挂载方式**：规则不是注册回调，而是**直接内联在 Checker 的 visit 方法中**——`visit_stmt` 遇 `Stmt::FunctionDef` 时直接调规则函数（`if checker.is_rule_enabled(Rule::X) { rules::xxx::yyy(checker, ...) }`）。避免回调注册开销，代价是 Checker 代码量巨大（3800+ 行）。

## 扩展方式

**新增一条 `LintSource` 类型**：
1. `registry.rs:230`——`LintSource` enum 加变体 + `is_xxx()` 方法（`is_macro::Is` 自动生成）
2. `registry.rs:247`——`Rule::lint_source()` match 映射相关规则
3. `linter.rs:check_path()`——加 `if context.iter_enabled_rules().any(|r| r.lint_source().is_xxx())` 分发块
4. `checkers/mod.rs` + 新建 `checkers/xxx.rs`——实现 `check_xxx()` 接收 `&mut LintContext` 报告诊断

**新增一种自动修复**：在规则检查函数中通过 `DiagnosticGuard` 的 `DerefMut` 调 `set_fix(Fix::safe_edit(edit))` 或 `Fix::unsafe_edit(edit)`；如需 isolation 防删空 block，用 `Checker::isolation(node_id)` 获取 `IsolationLevel`。`apply_fixes()` 自动处理任意 Fix，无需修改；若有排序依赖，在 `fix/mod.rs:cmp_fix()` 加特判。
