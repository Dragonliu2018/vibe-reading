---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "诊断系统"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "diagnostics", "lint", "passes"]
description: "Cargo 诊断系统解读：数据驱动的 pass + rule 模型、Lint 与 lint level（allow/warn/deny/forbids）、parse pass 与编译集成、报告渲染。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/00-overview)

---

## 模块定位

这一层负责 Cargo 的用户消息——warnings/errors/lints。它独立成层是因为诊断是**横切关注点**：清单解析、lockfile、构建前后都要报诊断，但具体规则与执行框架应当分离。Cargo 近期把"散落的 warn 调用"重构为**数据驱动的 pass + rule 模型**——框架稳定，加 lint 只改数据表不动框架。代码量 ~4,600 行，在 `src/diagnostics/`。

## 模块架构

```
src/diagnostics/
├── mod.rs          # PassOutput / GlobalDiagnosticStats / ScopedDiagnosticStats
├── lint.rs         # Lint / LintGroup / LintLevel / LintLevelSource / LintLevelProduct
├── passes.rs       # emit_parse_diagnostics + ParsePassRule（pass 执行框架）
├── report.rs       # 渲染辅助：cwd_rel_path / get_key_value / workspace_rel_path
└── rules/           # 数据驱动的规则表（LINTS / LINT_GROUPS / PARSE_PASS_RULES）
```

三角色清晰：`passes.rs` 是执行框架（"怎么跑诊断"），`rules/` 是数据（"检查什么"），`lint.rs` 是 lint 元数据（"叫什么、默认级别、谁能改"）。

## 调用链路

```
ops::cargo_compile::compile_with_exec
  └─ diagnostics::passes::emit_parse_diagnostics(ws, rules::PARSE_PASS_RULES)
       ├─ 对每个 member 的 Manifest/Package 跑匹配的 rule
       │    ├─ FnDiagnosticManifest / FnLintManifest（整个清单级）
       │    ├─ FnDiagnosticPackage / FnLintPackage（包级）
       │    └─ FnDiagnosticWorkspace / FnLintWorkspace（workspace 级）
       ├─ 查 LintLevel（manifest [lints] / build.warnings / 默认）
       └─ 生成 Report（cargo_util_terminal::report）→ Shell 输出
  → 返回 PassOutput{lint_warning_count}
  → compile_ws 用 warning_count 判 build.warnings=deny 是否失败
```

<details><summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `emit_parse_diagnostics` | 跑 parse pass | 数据驱动：吃 `&[ParsePassRule]` |
| `Lint::emitted_source` | 标记首条 lint | 只首个包发 emitted_source，避免冗余 |
| `LintLevelSource` | lint 级别来源 | 区分默认/manifest [lints]/build.warnings |
| `ScopedDiagnosticStats::report_summary` | pass 末尾汇总 | 给用户一个总览 |
| `rules::LINTS` | 全部 lint 注册表 | `ensure_parse_passed_in_lints` 校验一致性 |

</details>

## 核心实现

### 数据驱动模型：框架与规则分离

`src/diagnostics/mod.rs` 顶部文档与 `passes.rs` 的 `ParsePassRule` 枚举体现核心设计——执行框架不写死规则，而是消费一个规则表：

```rust title="src/diagnostics/passes.rs"
pub enum ParsePassRule<'r> {
    DiagnosticManifest { rule: FnDiagnosticManifest },
    LintManifest { rule: FnLintManifest, lint: &'r Lint },
    DiagnosticWorkspace { rule: FnDiagnosticWorkspace },
    LintWorkspace { rule: FnLintWorkspace, lint: &'r Lint },
    DiagnosticPackage { rule: FnDiagnosticPackage },
    LintPackage { rule: FnLintPackage, lint: &'r Lint },
}
```

每条规则是一个函数指针 + 作用域（Manifest/Workspace/Package）+ 可选关联 `Lint`。`emit_parse_diagnostics` 遍历 `PARSE_PASS_RULES`（在 `rules/` 里定义的数据表），对每个 member 跑匹配规则的函数。加一条 lint 因此只需：在 `rules/` 写函数 + 注册进表，**不碰 passes.rs 框架**。文档明确鼓励"prefer data driven passes to simplify adding rules"。

### Lint 与 lint level

`lint.rs` 定义 lint 元数据与级别体系。`LintLevel` 有 `allow`/`warn`/`deny`/`forbid`（forbid 不可被下游覆盖，呼应 rustc 语义）。级别来源 `LintLevelSource` 区分三处：默认值、清单 `[lints]` 表、`build.warnings` 配置——这决定了"谁能改这个 lint 的行为"。`LintGroup` 把相关 lint 聚成组（如 `[lints] cargo = "warn"` 覆盖一组）。`mod.rs` 文档强调：**只对本地包发 lint**，除非是 future-incompat lint（那种需要提前警示依赖将来的不兼容）。

### parse pass 与编译集成

`mod.rs` 文档把诊断按"何时跑"分 pass：parse pass（清单 schema，最早）、lockfile、pre-build unit graph、post-build unit graph（`rules::unused_dependencies::lint_build_results`，慢但需构建结果）。`emit_parse_diagnostics` 是 parse pass 的入口，在 `ops::cargo_compile::compile_with_exec` 里、`compile_ws` 之前跑——清单解析完立刻检查写法问题，编译前报出。返回的 `PassOutput{lint_warning_count}` 被 `compile_ws` 用来执行 `build.warnings = "deny"` 语义：超阈值就 `bail!` 失败。这让 `build.warnings` 成为编译失败的正规门禁。

### 报告渲染

`report.rs` 提供渲染辅助（`cwd_rel_path`/`workspace_rel_path`/`get_key_value`），最终诊断走 `cargo_util_terminal::report::Report`（基于 `annotate-snippets`）输出带源码片段的彩色报告——与 rustc 的诊断风格一致（`mod.rs` 文档明确参考 rustc-dev-guide 的 Errors and Lints）。`GlobalDiagnosticStats`/`ScopedDiagnosticStats` 跨 pass 聚合计数，末尾 `report_summary` 给用户总览。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 数据驱动 | `passes` 框架 + `rules` 数据表 | 加 lint 不动框架 |
| Pass 模型 | 按"何时跑"分 pass | parse/lockfile/pre-build/post-build 各司其职 |
| 策略 | `LintLevelSource` | 级别来源分层，行为可配 |
| 门禁 | `build.warnings=deny` | 编译失败的正规阈值 |
| 渲染复用 | `cargo_util_terminal::report` | 与 rustc 诊断风格统一 |

## 模块间交互

`diagnostics` 被 `ops::cargo_compile::compile_with_exec` 调用（parse pass 前置），消费 `workspace`（`Manifest`/`Package`/`MaybePackage`）与 `context`（`GlobalContext`/`Shell` 输出、`build.warnings` 配置）。它不依赖 `compiler`/`resolver`——诊断主要针对清单与配置，构建结果诊断（unused_dependencies）例外，需 post-build 跑。这种"前置轻量、post-build 重"的分层让 parse pass 几乎零开销地融入编译流水线。

## 扩展方式

新增一条 lint（最常见场景）：在 `src/diagnostics/rules/` 下定义规则函数（`FnLintManifest`/`FnLintPackage` 等之一）+ 关联 `Lint` → 注册进 `rules::LINTS`（`mod.rs` 文档强调 `ensure_parse_passed_in_lints` 保证一致性）。如需新 pass，在 `passes.rs` 加并接入调用点（如 `compile_with_exec`），注意 cap lints（非本地包跳过）与 `build.warnings` 支持。新增的诊断优先做成 lint 而非硬编码 warn——`mod.rs` 文档明确"lints are generally preferred because of the level of control for users"。
