---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "Workspace 与配置"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "配置", "层级配置", "monorepo", "Resolver"]
description: "ruff 的配置系统——三级表示、层级级联发现、matchit Router 路由、extend 链合并，monorepo 友好。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_workspace/` 负责 ruff 的配置文件发现、层级级联、文件遍历。这个模块独立存在的核心价值是**monorepo 友好**——不同子项目可能需要不同配置（`target-version`/`line-length`/规则集），层级配置让每个子目录有自己的 `ruff.toml`，无需在根配置用复杂的 `per-file-ignores` 模拟。它还解耦了配置解析与 CLI——通过 `ConfigurationTransformer` trait 让 CLI 覆盖注入到配置解析流程，`ruff_workspace` 不依赖 `ruff` crate 的 CLI 定义。

## 模块架构

模块采用**三级配置表示**设计：`Options`（TOML 反序列化层，serde 注解，schema 生成）→ `Configuration`（中间表示，支持 `combine()` 合并）→ `Settings`（最终确定值，无 Option，被 linter/formatter 消费）。分三层是因为各层职责不同：Options 只管反序列化，Configuration 管合并逻辑，Settings 是最终消费。`resolver.rs` 是文件发现 + 级联解析 + Router 路由的核心。

## 调用链路

```
配置发现 (ruff::resolve::resolve())                [resolve.rs:20]
  四级优先级: --isolated > --config=file > 向上查找 > 用户级 > 默认
       │
       ▼
文件发现 + 级联解析 (project_files_in_path())       [resolver.rs:429]
  ├─ 规范化路径为绝对路径
  ├─ Hierarchical: 沿 ancestors() 搜索 settings_toml() → resolve_scoped_settings()
  ├─ 构建 WalkBuilder (ignore crate 并行遍历, ≤12 线程)
  ├─ WalkParallel + PythonFilesVisitor
  │    ├─ 每目录: 检查有无配置文件 → resolver.add() (级联覆盖)
  │    └─ 每文件: resolver.resolve(path) → &Settings (Router 最长前缀匹配)
  │              检查 exclude/include → 接受/跳过
  └─ deduplicate_files() (Root 优先于 Nested)
       │
       ▼
配置合并 (resolve_configuration())                  [resolver.rs:310]
  ├─ 循环解析 extend 链 (检测循环引用)
  ├─ combine() 逐层合并: self(子)优先, None 时取 other(父)
  ├─ apply_fallbacks(): target-version 回退到 requires-python
  └─ transformer.transform() (CLI 覆盖注入)
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `resolve()` in `ruff/resolve.rs:20` | 配置发现（四级优先级） | `--isolated`→Fixed, 其他→Hierarchical |
| `project_files_in_path()` in `resolver.rs:429` | 文件发现 + 级联配置 | ignore crate 并行 + matchit Router |
| `Resolver::resolve(path)` in `resolver.rs:97` | 每文件获取生效 Settings | Router 最长前缀匹配 |
| `resolve_configuration()` in `resolver.rs:310` | extend 链合并 + CLI 注入 | 循环检测 + combine 语义 |
| `Configuration::combine()` in `configuration.rs:652` | 合并两个配置 | self（子）优先，None 取 other |

## 核心实现

### 三级配置表示

```rust title="settings.rs / configuration.rs / options.rs"
// 1. Options (options.rs) — TOML 反序列化层，全 Option<T> 字段，serde 注解
//    #[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))] → ruff.schema.json

// 2. Configuration (configuration.rs) — 中间表示，Option<T> + combine() 合并逻辑

// 3. Settings (settings.rs) — 最终确定值，无 Option
pub struct Settings {
    pub cache_dir: PathBuf,
    pub fix: bool,
    pub file_resolver: FileResolverSettings,
    pub linter: LinterSettings,        // 来自 ruff_linter
    pub formatter: FormatterSettings,
    // ...
}
```

**为什么分三层？** Options 只管反序列化（`Option<T>` 字段，serde 处理）；Configuration 管合并（`Option<T>` + `combine` 语义：self 优先，None 取 other）；Settings 是最终确定值（无 `Option`，被消费）。职责清晰，避免在消费层处理"未设置"状态。

### 层级配置 + Router 路由

```rust title="resolver.rs"
pub enum PyprojectDiscoveryStrategy { Fixed, Hierarchical }

// Resolver 内部用 matchit::Router<usize> 做路径→settings 索引路由
resolver.add("/project/subdir", settings, config_path)
  → router.insert("/project/subdir/{*filepath}", index)

resolver.resolve(path)
  → Fixed: 直接返回 pyproject_config.settings
  → Hierarchical: router.at(path) 匹配最长前缀 → 返回对应 settings
```

`Hierarchical` 策略下，遍历时对每个目录检查 `settings_toml()`，找到就 `resolve_scoped_settings()` 并 `resolver.add()` 注册到 Router。这是一个**最长前缀匹配**路由，确保每个文件拿到其最近祖先目录的配置——monorepo 中 `services/api/` 和 `services/worker/` 可有不同 `target-version`/规则集。

### Configuration::combine 合并语义

```rust title="configuration.rs"
// 核心原则：self（子配置）优先，None 时取 other（父配置）
exclude: self.exclude.or(config.exclude)              // 子配置完全覆盖
extend_exclude: config.extend_exclude.chain(self.extend_exclude)  // 累加合并
lint: self.lint.combine(config.lint)                  // 递归合并
```

合并按"子配置优先"——第一个（最具体的子配置）与后续父配置逐层 `combine`，`self` 非 None 则保留，None 则取 `other`。`exclude` 完全覆盖，`extend_exclude` 累加。

### Exclusion/Glob 机制

```rust title="resolver.rs"
// is_file_exclusion() / match_candidate_exclusion()
// FilePatternSet 底层是 globset::GlobSet
// 排除检查同时匹配完整路径和文件名 (Candidate::new(path) + Candidate::new(basename))
// exclusion 向上遍历祖先目录，但在 project_root 处停止（避免项目根之上被误排）
// force_exclude 控制是否对 CLI 直接传入的文件也应用排除
```

默认 `exclude` 含 `.git`/`.venv`/`__pycache__` 等 24 个内置模式（`EXCLUDE` 常量，`settings.rs:118`）；默认 `include` 含 `*.py`/`*.pyi`/`*.ipynb`/`**/pyproject.toml`（`settings.rs:146`）。`ResolvedFile::Root`（CLI 直接传入）vs `Nested`（目录遍历发现）——`Root` 即使匹配 exclude 也保留（除非 `force_exclude`），用于去重和 exclusion 判断。

### extend 链 vs 层级配置

两者**正交**：`extend`（`pyproject.rs:69`，`resolver.rs:318`）是显式继承（`extend = "../parent.toml"`，循环解析检测循环引用）；层级配置是隐式继承（基于目录结构自动发现）。一个子目录的配置可 `extend` 另一文件，同时该子目录下文件也自动使用该配置。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Hierarchical Config | `PyprojectDiscoveryStrategy` in `resolver.rs:59` | monorepo per-directory 配置 |
| Resolver + Router 路由 | `Resolver` + `matchit::Router` in `resolver.rs:97` | 最长前缀匹配，O(1) 查找 |
| Builder 模式 | `ignore::WalkBuilder` in `resolver.rs:480` | 并行文件遍历器 |
| Transformer（CLI 覆盖） | `ConfigurationTransformer` trait in `resolver.rs:300` | 解耦 CLI 注入与配置解析 |
| 三层表示 | Options→Configuration→Settings | 反序列化/合并/消费职责分离 |

## 模块间交互

被 `ruff` crate 的 `commands/check.rs`/`format.rs`/`check_stdin.rs`/`format_stdin.rs`/`showSettings.rs` 调用——都通过 `project_files_in_path()` 返回 `(Vec<ResolvedFile>, Resolver)`，遍历时 `resolver.resolve(path)` 获取每文件 `LinterSettings`/`FormatterSettings`。消费 `ruff_linter::settings::LinterSettings`、`ruff_python_formatter::PyFormatOptions`（通过 `FormatterSettings::to_format_options()` 转换）、`ruff_graph::AnalyzeSettings`、`ruff_python_ast::PythonVersion`。

## 重要设计决策

**为什么支持层级配置？** monorepo 中不同子项目可能需要不同 `target-version`/`line-length`/规则集。层级配置让每个子目录有自己的 `ruff.toml`，无需在根配置用复杂 `per-file-ignores` 模拟。实现：`Hierarchical` 策略下遍历时对每目录检查配置文件，找到就注册到 Router。

**配置 schema 如何生成？** `Options` 通过 `#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]` 派生 JSON Schema，`ruff_dev/src/generate_json_schema.rs:22` 用 `schemars::generate::SchemaSettings::draft07()` 生成到仓库根 `ruff.schema.json`。`OptionsMetadata` 宏生成文档元数据，供 `--show-settings` 和文档生成。`DeprecatedTopLevelLintOptions`（`options.rs:620`）是 newtype wrapper，自定义 schema 将废弃顶层 lint 选项标记为 `deprecated`。

**target-version 回退**：若配置文件无 `target-version`，从最近 `pyproject.toml` 的 `[project].requires-python` 推导最小支持版本（`pyproject.rs:149` `find_fallback_target_version`，`configuration.rs:698` `apply_fallbacks`）——用户通常已在 `requires-python` 声明版本，避免重复配置。

## 扩展方式

**新增一个配置项**（如 `lint.dummy-new-option`）：
1. `options.rs`——在 `LintOptions` struct 加字段，`#[option(...)]`（文档/示例）+ `#[serde]` 注解 + `OptionsMetadata` 派生
2. `configuration.rs`——`LintConfiguration` 加 `Option<T>` 字段 + `from_options()` 映射 + `combine()` 合并逻辑
3. `ruff_linter/src/settings.rs` 或 `ruff_workspace/src/settings.rs`——最终 `LinterSettings` 加字段
4. `configuration.rs::into_settings()`——转换
5. `cargo dev generate-json-schema --mode write`——重新生成 `ruff.schema.json`
6. 测试——`pyproject.rs` 或 `configuration.rs` 添加反序列化/合并测试
