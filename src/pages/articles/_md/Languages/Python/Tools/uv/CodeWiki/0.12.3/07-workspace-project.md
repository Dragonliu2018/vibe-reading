---
source:
  type: "源码解读"
  project: "uv"
  url: "https://github.com/astral-sh/uv"
title: "工作区与项目管理"
date: "2026-08-13T20:07:12+08:00"
category: ["Languages", "Python", "Tools", "uv", "CodeWiki", "0.12.3"]
tags: ["uv", "Rust", "workspace", "pyproject"]
description: "uv-workspace 与 uv-settings：Cargo-style workspace 多成员模型、tool.uv.sources 依赖来源映射与三层配置合并。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/uv/CodeWiki/0.12.3/00-overview)

---

## 模块定位

`uv-workspace` + `uv-settings` 回答两个前置问题："当前在哪个项目里、有哪些成员"（workspace 模型）和"用户要 uv 怎么表现"（配置解析）。它们独立成模块是因为这两件事的输出（`Workspace`/`FilesystemOptions`）是命令编排与 lockfile 生成的数据基础——没有 workspace 模型就无法收集成员依赖、无法决定 editable 安装；没有配置合并就无法确定 index/prerelease/link-mode 等解析行为。这组模块是纯解析层（解析 TOML），不含 IO 与算法。

## 模块架构

`uv-workspace` 负责 workspace 发现与 `pyproject.toml` 解析（`Workspace`/`WorkspaceMember`/`PyProjectToml`/`Source` enum）；`uv-settings` 负责配置文件加载与合并（`Options`/`FilesystemOptions`/`Combine` trait）。`pyproject.rs` 是核心——解析 PEP 621 `[project]`、PEP 735 `[dependency-groups]` 与 `[tool.uv]`（含 `sources`/`index`/`workspace`）。

```
uv-workspace/src/
├── workspace.rs       # Workspace · WorkspaceMember · ProjectWorkspace · VirtualProject · 发现
├── pyproject.rs       # PyProjectToml · Project · ToolUv · Source enum · 反序列化
├── pyproject_mut.rs   # PyProjectTomlMut (uv add/remove 修改)
├── dependency_groups.rs  # FlatDependencyGroups (PEP 735 展平 + 环检测)
uv-settings/src/
├── settings.rs        # Options struct
├── combine.rs         # Combine trait (Cargo 风格合并)
└── lib.rs             # FilesystemOptions · validate_uv_toml
```

## 调用链路

发现并解析一个 workspace 的完整链：

```
ProjectWorkspace::discover(path, options, cache, workspace_cache) (workspace.rs:1532)
  ├─ ancestors().find(|p| p.join("pyproject.toml").is_file())  # 找最近 pyproject.toml
  └─ from_project_root() (workspace.rs:1564)
       ├─ from_cache()                          # 快速路径：WorkspaceCache 命中
       ├─ PyProjectToml::from_string(contents)  # 解析 TOML
       └─ from_project() (workspace.rs:1675)
            ├─ 检查 tool.uv.managed == Some(false) → NonWorkspace 错误
            ├─ 检查当前 pyproject 是否有 tool.uv.workspace (explicit root)
            ├─ 若否: find_workspace() (workspace.rs:1808)
            │    └─ 向上遍历 ancestors，检查每个 pyproject:
            │         有 tool.uv.workspace → 返回 (root, def, pyproject)
            │         有 [project] 但无 workspace → None (被另一项目阻断)
            │    → 隐式单项目 workspace
            └─ Workspace::build(root, def, ...) (workspace.rs:1033)
                 ├─ collect_members_only() (workspace.rs:1123)
                 │    ├─ 根 pyproject 有 [project] → 先加根成员
                 │    ├─ 遍历 workspace.members glob 模式
                 │    ├─ 每个匹配目录: 读 pyproject → 检查 managed → 提取 [project]
                 │    ├─ 检查 DuplicatePackage (同名报错)
                 │    └─ 检查 NestedWorkspace (成员不许有自己的 workspace)
                 ├─ 提取 workspace 级 sources 和 indexes
                 ├─ collect_required_members() (workspace.rs:593)
                 └─ 组装 Workspace { install_path, packages, required_members, sources, ... }
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `ProjectWorkspace::discover()` in `workspace.rs:1532` | 发现当前项目+workspace | 向上找 pyproject，WorkspaceCache 缓存 |
| `find_workspace()` in `workspace.rs:1808` | 找 explicit workspace root | 中间 project 阻断向上搜索 |
| `Workspace::build()` in `workspace.rs:1033` | 组装 workspace | glob 展开 members + 嵌套禁止 |
| `collect_required_members()` in `workspace.rs:593` | 找被引用的成员 | 扫 tool.uv.sources 的 Workspace 条目 |
| `FlatDependencyGroups::from_pyproject_toml()` in `dependency_groups.rs:30` | 展平 PEP 735 | 递归 + 环检测 + legacy 合并 |

</details>

## 核心实现

### Cargo-style Workspace 多成员模型

`Workspace` (`workspace.rs:279`) 类似 Cargo workspace——根 `pyproject.toml` 通过 `tool.uv.workspace.members`（glob 模式）声明子成员，根可以是项目自身（root package + helpers）或虚拟根（flat workspace）：

```rust title="workspace.rs:279"
pub struct Workspace {
    install_path: PathBuf,
    packages: WorkspaceMembers,                       // Arc<BTreeMap<PackageName, WorkspaceMember>>
    required_members: BTreeMap<PackageName, Editability>, // 被引用的成员
    sources: BTreeMap<PackageName, Sources>,          // workspace 级 tool.uv.sources
    indexes: Vec<Index>,                              // workspace 级 tool.uv.index
    pyproject_toml: PyProjectToml,
}
```

`collect_members_only()` (`workspace.rs:1123`) 用 `glob` crate 展开 members，每个成员目录必须有 `pyproject.toml` 且含 `[project]`，支持 `exclude` 排除。**嵌套禁止**——成员不许有自己的 `tool.uv.workspace`（`NestedWorkspace` 错误）。**缓存隔离**——过滤掉 uv cache 目录防止误识别为成员。`ProjectWorkspace` 是"当前项目 + 所属 workspace"的组合，是 `uv run`/`uv sync` 的入口模型；`VirtualProject` 统一处理有 `[project]` 的正常项目与无 `[project]` 的虚拟根。

### workspace 发现规则：向上找 + 中间 project 阻断

`find_workspace()` (`workspace.rs:1808`) 从当前路径沿 `ancestors()` 向上找含 `pyproject.toml` 的目录，若有 `tool.uv.workspace` 是 explicit root。**关键决策**：若向上遍历遇到另一个有 `[project]` 但无 `tool.uv.workspace` 的 pyproject，停止向上搜索——处理 `examples/` 子目录场景，example 项目自成独立 workspace。`has_intermediate_pyproject()` (`workspace.rs:154`) 检查 member 与 root 间是否有中间 pyproject，保证缓存映射正确性（修复 issue #19916）。

### tool.uv.sources：五种依赖来源映射

`Source` enum (`pyproject.rs:1138`) 是 `tool.uv.sources` 的核心，支持 Git/Url/Path/Registry/Workspace 五种来源：

```rust title="pyproject.rs:1138"
pub enum Source {
    Git { git, rev, tag, branch, subdirectory, lfs, marker, extra, group },
    Url { url, subdirectory, marker, extra, group },
    Path { path, editable, package, marker, extra, group },
    Registry { index, marker, extra, group },
    Workspace { workspace: WorkspaceReference, editable, marker, extra, group },
}
```

**自定义反序列化**——`Source` 的 `Deserialize` (`pyproject.rs:1255`) 用 `CatchAll` 先收集所有字段再互斥校验（git 与 url 不能共存），比 `#[serde(untagged)]` 提供更精确错误信息。`Sources` 是 `Vec<Source>`，支持多来源 + marker 条件，但要求 marker 两两不相交（`is_disjoint`），否则报 `OverlappingMarkers`。`WorkspaceReference` 可为 `Bool(true)`（当前 workspace）或 `Path`（外部 workspace）。`collect_required_members()` 扫描所有成员的 `Workspace { workspace: Bool(true) }` 条目确定哪些成员被依赖及 editable 偏好，影响 lockfile 中成员安装方式。

### PEP 735 dependency groups 与环检测

`FlatDependencyGroups` (`dependency_groups.rs`) 将 PEP 735 `[dependency-groups]` 展平，解析 `include-group` 引用（递归 + 环检测，报 `DependencyGroupCycle`）。**向后兼容**——同时收集 legacy `tool.uv.dev-dependencies` 和标准 `[dependency-groups]`，前者合并到 `dev` 组，但 legacy 不支持被 `include-group` 引用。`include-group` 传递 `requires-python` 约束做交集，并作为 marker 附加到每个 requirement。

### uv.toml vs pyproject.toml 字段隔离

`Options` struct (`uv-settings/src/settings.rs:81`) 同时解析 `uv.toml` 和 `pyproject.toml` 的 `[tool.uv]`，用 `IgnoredAny` 标记 pyproject-only 字段（`workspace`/`sources`/`dependency-groups`/`managed`/`package`/`build-backend`/`environments` 等）。`validate_uv_toml` (`lib.rs:284`) 在加载 `uv.toml` 后检查这些字段是否出现，若出现报 `PyprojectOnlyField` 错误。**为什么这样设计**——避免维护两套 struct，用运行时校验实现字段隔离。

### Combine trait：Cargo 风格合并

`Combine` trait (`combine.rs:28`) 遵循 Cargo `config.toml` 合并语义——标量取高优先级值，数组高优先级项前置（与 Cargo 相反）。通过宏为基本类型和 `Option` 自动实现。层次：system → user → project → CLI flags 逐层 combine。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Cargo-style workspace | `Workspace::build()` in `workspace.rs:1033` | 多成员项目统一管理，glob 发现 |
| 自定义反序列化 | `Source::deserialize` in `pyproject.rs:1255` | 互斥校验 + 精确错误信息 |
| 并发安全缓存 | `WorkspaceCache` (OnceMap) in `workspace.rs:79` | 同一 root 只发现一次 |
| 字段隔离 | `IgnoredAny` + `validate_uv_toml` in `lib.rs:284` | 单 struct 服务两种配置文件 |
| 递归展平 + 环检测 | `FlatDependencyGroups` in `dependency_groups.rs` | PEP 735 include-group 解析 |

## 模块间交互

`uv-workspace` 依赖 `uv-pep508`（`Requirement`/`MarkerTree`）、`uv-pypi-types`（`VerbatimParsedUrl`/`DependencyGroups`/`SupportedEnvironments`）、`uv-distribution-types`（`Index`/`RequirementSource`）、`uv-configuration`、`uv-normalize`、`uv-pep440`、`uv-fs`、`uv-cache`。`uv-settings` 依赖 `uv-workspace`（直接引用类型）、`uv-resolver`（`ResolutionMode` 等）、`uv-python`。被 `uv` crate 调用——`FilesystemOptions::find/user/system` 加载配置链，`ProjectWorkspace::discover`/`VirtualProject::discover` 用于 `uv run/sync/lock/add/remove`，`Workspace` 的 `members_requirements`/`group_requirements`/`overrides`/`constraints` 在 resolver/lockfile 生成中被调用。

## 扩展方式

新增依赖来源类型（如 "remote archive with checksum"）：在 `Source` enum (`pyproject.rs:1138`) 加变体，`CatchAll` struct 加字段，`Source::deserialize` (`:1286`) 加识别+互斥校验，`Source::from_requirement` (`:1661`) 加映射，更新 `marker()`/`extra()`/`group()` 方法，`pyproject_mut.rs` 的 sources 操作支持新类型，可能改 `uv-distribution-types` 的 `RequirementSource`。修改 workspace 发现规则（如让中间 project 不阻断）：改 `find_workspace()` (`:1808`) 的 `pyproject_toml.project.is_some()` 分支 (`:1890`) 逻辑，同步 `has_intermediate_pyproject()` (`:154`)。
