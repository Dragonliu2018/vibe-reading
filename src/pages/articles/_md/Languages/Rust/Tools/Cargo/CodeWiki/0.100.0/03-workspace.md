---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "工作区与清单"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "Manifest", "Workspace", "PackageId"]
description: "Cargo 工作区与清单层解读：Workspace 装配、Cargo.toml 解析为 Manifest、Package/PackageId/SourceId 三件套领域模型、Profile 与 feature 表。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/00-overview)

---

## 模块定位

这一层承载 Cargo 的"名词"：`Workspace`（一个 workspace 的全部 package）、`Manifest`（解析后的 `Cargo.toml`）、`Package`（文件系统上的一个包）、`PackageId`/`SourceId`（包与源的身份证）。它独立成层是因为这些领域对象被解析器、编译器、`cargo metadata` 等只读命令**共享**——它们必须无副作用、可独立构造与测试。代码量 ~20,300 行，是 src 里第二大的目录。

## 模块架构

```
src/workspace/
├── workspace.rs        # Workspace 结构 + find_workspace_root + 装配
├── manifest.rs         # Manifest/VirtualManifest + Target
├── package.rs          # Package (Rc<PackageInner>) + PackageSet
├── package_id.rs       # PackageId（name+version+SourceId）
├── source_id.rs        # SourceId（源的唯一标识 + SourceKind）
├── summary.rs          # Summary（包的元数据摘要）+ FeatureMap
├── dependency.rs       # Dependency/Patch + DepKind/Artifact
├── features.rs         # Feature/CliUnstable/Edition
├── profiles.rs         # Profile/Profiles（编译配置预设）
├── registry.rs         # Registry trait（resolver 视角的源聚合）
├── parser/             # Cargo.toml 解析（schema 来自 cargo-util-schemas）
└── package_id_spec.rs  # PackageIdSpec（命令行包标识 "serde:1.0"）
```

核心三件套是 `Workspace` → `Package` → `Manifest`：`Workspace` 装配多个 `Package`，每个 `Package` 持有一个 `Manifest`，而 `PackageId`/`SourceId` 是它们的索引键。

## 调用链路

```
commands/build.rs::exec → args.workspace(gctx)?
  └─ Workspace::new(gctx, manifest_path) in workspace.rs
       ├─ find_workspace_root_with_membership_check   # 向上找 [workspace] 根
       ├─ read_manifest() for each member              # 读 Cargo.toml
       │    └─ parser → TomlManifest → Manifest
       ├─ Package::new(manifest, manifest_path)        # Rc<PackageInner>
       └─ Packages 聚合（成员/依赖/patch）
```

<details><summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Workspace::new` | 装配整个 workspace | 支持虚拟 manifest（无 `[package]` 的根） |
| `find_workspace_root` | 从当前目录向上找 `[workspace]` | 避免误把父目录当根（membership check） |
| `read_manifest` | 读+解析 `Cargo.toml` | `original_toml`/`normalized_toml` 双份保留 |
| `Package::new` | 构造包对象 | `Rc<PackageInner>` 共享，克隆零成本 |
| `members_with_features` | 枚举成员+激活 feature | 给 resolver 算 dev-units 用 |
| `WorkspaceRootConfig` | workspace 级共享配置 | `[workspace]` 表的解析结果 |

</details>

## 核心实现

### Workspace 装配

`Workspace` 是带生命周期的引用聚合体（`pub struct Workspace<'gctx>`，`src/workspace/workspace.rs:50`）：

```rust title="src/workspace/workspace.rs"
pub struct Workspace<'gctx> {
    gctx: &'gctx GlobalContext,
    current_manifest: PathBuf,        // --manifest-path 或 cwd/Cargo.toml
    packages: Packages<'gctx>,       // 所有发现的 package（成员+路径依赖+patch）
    root_manifest: Option<PathBuf>,  // [workspace] 根；None=单包无 workspace
    target_dir: Option<Filesystem>,
    build_dir: Option<Filesystem>,
    // members / target_dir / config ...
}
```

`find_workspace_root_with_membership_check` 的关键逻辑：从 `current_manifest` 向上找含 `[workspace]` 的 `Cargo.toml`，但还要确认 `current_manifest` 确实是该 workspace 的成员（`members`/`default-members`/`exclude`/glob）——否则会把无关的祖先目录误当根。这是 workspace 边界判定的核心，决定了 `target/` 与 lock 共享范围。

### Manifest 解析

`Manifest`（`src/workspace/manifest.rs:64`）是 `Cargo.toml` 的强类型镜像。注意它**同时保留三份**：`original_toml`（原始，含注释与顺序，给 `cargo metadata` 输出）、`normalized_toml`（规范化后的）、`document`（带 span 的 `toml::Spanned`，给诊断报错定位）：

```rust title="src/workspace/manifest.rs"
pub struct Manifest {
    contents: Option<Rc<String>>,
    document: Option<Arc<toml::Spanned<toml::de::DeTable<'static>>>>,  // 带位置，诊断用
    original_toml: Option<Rc<TomlManifest>>,
    normalized_toml: Rc<TomlManifest>,
    summary: Summary,
    targets: Vec<Target>,            // lib/bin/example/test/bench
    links: Option<String>,           // 原生库链接声明
    edition: Edition,
    rust_version: Option<RustVersion>,
    workspace: WorkspaceConfig,
    // features/replace/patch/exclude/include/...
}
```

设计决策：保留 span 信息（`toml::Spanned`）是为了诊断——lint 能精确指到 `Cargo.toml` 的某一行。`VirtualManifest`（`:111`）是只有 `[workspace]` 没有 `[package]` 的根，两者用 `EitherManifest` 统一。schema（`TomlManifest`）定义在子 crate `cargo-util-schemas`，让外部工具能复用同一份 `Cargo.toml` 解析。

### Package / PackageId / SourceId 三件套

`Package`（`src/workspace/package.rs`）是 `Rc<PackageInner>`——克隆只是增引用，整个构建过程里同一包的 `Manifest` 只存一份：

```rust title="src/workspace/package.rs"
pub struct Package { inner: Rc<PackageInner> }
struct PackageInner {
    manifest: Manifest,
    manifest_path: PathBuf,
}
```

`PackageId`（`package_id.rs`）是包的唯一身份证：`name + Version + SourceId`，可序列化进 `Cargo.lock`。`SourceId`（`source_id.rs`）标识"这个包从哪来"——crates.io / 某 git url 某 commit / 某本地路径，`SourceKind` 枚举区分。三者的关系：`Package` 是内存中的运行对象，`PackageId` 是它的可序列化身份证，`SourceId` 是身份证里"出生地"那一栏。`PackageSet`（`package.rs`）聚合一次构建需要的所有 `Package`，由 `ops::resolve` 产出，传给 `compiler` 下载与编译。

### Profile 与 feature 表

`profiles.rs` 定义编译配置预设（`dev`/`release`/`test`/`bench`/自定义），含 `opt-level`/`debug`/`codegen-units`/`panic`/`lto` 等——这些最终在 compiler 层拼进 rustc 参数。`features.rs` 的 `Feature`/`Features`/`CliUnstable` 处理 feature 表与 nightly `-Z` 标志，是 resolver 做 feature 统一的输入。这两者都是纯数据，不碰 IO。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 不可变共享 | `Package = Rc<PackageInner>` | 全构建共享同一份 Manifest，克隆零成本 |
| 显式生命周期 | `Workspace<'gctx>` | 编译期保证 package 不逃逸出 gctx 生命周期 |
| 双份表示 | `original_toml`+`normalized_toml`+`document` | 兼顾"原样输出"与"规范化使用"与"诊断定位" |
| 值对象 | `PackageId`/`SourceId` | 可序列化、可哈希、作 lock 与图的键 |
| Schema 外置 | `cargo-util-schemas` | 外部工具复用同一解析，避免漂移 |

## 模块间交互

`workspace` 是领域中心：`ops` 用它装配 `Workspace` 与 `PackageSet`；`resolver` 用 `Dependency`/`Summary`/`PackageId` 作解析输入输出；`compiler` 用 `Package`/`Target`/`Profile` 拼 rustc 调用；`sources` 用 `SourceId` 区分来源。`PackageId`/`SourceId` 是跨模块的"通用语言"——resolver 产出的图以 `PackageId` 为节点，compiler 的 `Unit` 里也嵌 `PackageId`。这种共享名词层是分层能成立的前提。

## 扩展方式

新增一个 `Cargo.toml` 字段：在 `crates/cargo-util-schemas` 的 `TomlManifest` 加 serde 字段 → `Manifest` 加对应字段与 span → 在 `parser` 里把 toml 字段映射到 `Manifest` → 消费处（`ops`/`compiler`）读取。因 schema 外置，第三方工具（`cargo metadata` 消费者）可同步获得新字段，无需反向工程。
