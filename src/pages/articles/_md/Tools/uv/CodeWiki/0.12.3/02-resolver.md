---
source:
  type: "源码解读"
  project: "uv"
  url: "https://github.com/astral-sh/uv"
title: "依赖解析器"
date: "2026-08-13T20:07:12+08:00"
category: [Tools, uv, CodeWiki, "0.12.3"]
tags: ["uv", "Rust", "PubGrub", "依赖解析"]
description: "uv-resolver 基于 PubGrub 算法的依赖解析器：双线程求解架构、fork 分叉机制、候选选择与 batch prefetch 优化。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/uv/CodeWiki/0.12.3/00-overview)

---

## 模块定位

`uv-resolver`（40K 行）是 uv 最复杂的算法模块——它要回答"给定一组 requirements，从 PyPI 海量版本中选出一组互相兼容的包版本"。这是 uv 正确性的核心：选错版本会导致运行时 ImportError，漏选会导致缺包。模块独立存在是因为依赖求解是一个自包含的算法问题——输入 `Manifest`（requirements/constraints/overrides），输出 `ResolverOutput`（petgraph），不直接碰网络和磁盘，而是通过 `ResolverProvider` trait 把元数据获取委托给 `uv-distribution`/`uv-client`。这种解耦让 resolver 可注入 mock 测试，也把"算法正确性"和"IO 性能"分到两个线程。

## 模块架构

resolver 内部分为四块：`resolver/mod.rs` 是求解主循环（PubGrub `State` 驱动）；`resolver/provider.rs` 定义 `ResolverProvider` trait 与 `DefaultResolverProvider`（对接 `DistributionDatabase`）；`candidate_selector.rs` 负责从 `VersionMap` 选最佳版本；`pubgrub/` 把 uv 的包模型适配为 PubGrub 的 `PubGrubPackage`。`Manifest` 是输入、`ResolverOutput` 是输出，两者都是纯数据结构。

```
resolver/
├── mod.rs              # Resolver<Provider, InstalledPackages> 求解主循环
├── provider.rs         # ResolverProvider trait + DefaultResolverProvider
├── candidate_selector.rs  # 版本选择（prerelease/index 策略）
├── batch_prefetch.rs   # 批量预取优化
├── manifest.rs         # Manifest 输入
├── resolution/         # Resolution + ResolverOutput 输出
├── pubgrub/            # PubGrub 适配（package.rs · range.rs · report.rs）
├── fork_strategy.rs    # Fewest / RequiresPython
├── prerelease.rs       # PrereleaseMode 策略
└── graph_ops.rs        # marker_reachability + simplify
```

## 调用链路

从 `Resolver::resolve()` 出发的完整求解链：

```
Resolver::resolve() (mod.rs:280)
  ├─ mpsc::channel(300)                     # 有界 channel
  ├─ thread::spawn("uv-resolver")           # solver 线程（CPU-bound PubGrub）
  │    └─ state.solve(&request_sink) (mod.rs:317)
  ├─ state.fetch(provider, request_stream)  # async fetcher（IO-bound）
  └─ tokio::try_join!(fetch, solve)
       │
       └─ solve() 的 PubGrub 循环:
            ├─ state.pubgrub.unit_propagation(state.next)   # 单元传播 + 冲突
            ├─ pre_visit() → Request::Prefetch              # 提前批量取版本列表
            ├─ pick_highest_priority_pkg()                  # 选最高优先级包
            ├─ request_package() → Request::Package/Dist    # 经 channel 发请求
            ├─ choose_version() (mod.rs:1137)
            │    ├─ choose_version_registry() (mod.rs:1319)
            │    │    ├─ index.implicit/explicit().wait_blocking()  # 等版本列表
            │    │    ├─ selector.select() (candidate_selector.rs:79)
            │    │    └─ fork_version_registry()             # local 版本平台分叉
            │    └─ choose_version_url() (mod.rs:1200)       # URL 包
            ├─ get_dependencies_forking() (mod.rs:1801)      # 依赖 marker 分叉
            │    └─ get_dependencies() → index.distributions().wait_blocking()
            │         └─ flatten_requirements() 过滤 marker/extras/constraints
            ├─ ForkedDependencies::Forked → forks_to_fork_states()  # 新 fork
            └─ add_package_version_dependencies()             # 加入 incompatibilities
```

关键点：**版本选择与依赖获取都不经过 pubgrub crate 的 `DependencyProvider` 回调**——uv 直接调用 `CandidateSelector::select()` 选版本、从 wheel metadata 的 `requires_dist` 提依赖，手动操作 PubGrub `State` 的 `partial_solution`/`incompatibilities`。`UvDependencyProvider` (`dependency_provider.rs:13`) 是占位实现，所有方法 `unimplemented!()`。这让 uv 能控制 prerelease 策略、index 策略、installed package 优先等 Python 特有逻辑。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `Resolver::resolve()` in `mod.rs:280` | 求解入口，spawn solver + fetcher | 双线程，mpsc channel 300 容量 |
| `solve()` in `mod.rs:317` | PubGrub 主循环 | 'FORK 循环 + 多 fork 状态栈 |
| `choose_version()` in `mod.rs:1137` | 选下一个版本 | 区分 root/URL/registry 三路径 |
| `CandidateSelector::select()` in `candidate_selector.rs:79` | 从 VersionMap 选最佳 | preferences > installed > specifiers |
| `get_dependencies_forking()` in `mod.rs:1801` | 取依赖 + marker 分叉 | universal 模式检查 fork |
| `BatchPrefetcher::prefetch_batches()` in `batch_prefetch.rs:81` | 批量预取后续版本元数据 | Compatible/InOrder 两策略 |
| `convert_no_solution_err()` in `mod.rs:371` | 无解转用户友好报告 | PubGrub incompatibility 树 → DerivationChain |

</details>

## 核心实现

### PubGrub 双线程求解架构

uv 没有简单地把 PubGrub 跑在 async 里，而是用一个 **OS 线程跑 solver + async 跑 fetcher** 的双线程架构。solver 线程 (`mod.rs:317`) 跑 CPU-bound 的 PubGrub 算法（单元传播、冲突回溯），当需要元数据时通过 `mpsc::channel(300)` 发 `Request`；fetcher 是 async 任务，`buffer_unordered(usize::MAX)` 并发处理请求，调用 `DefaultResolverProvider` → `DistributionDatabase` → `RegistryClient` 获取 PyPI 元数据，结果写入 `InMemoryIndex`（papaya 无锁 HashMap）。solver 用 `wait_blocking()` 阻塞等待结果。

**为什么这样设计**：PubGrub 是同步的递归算法，强行 async 化会污染整个调用链；而元数据获取是 IO-bound 的，必须并发。两个线程各司其职，channel 解耦。`InMemoryIndex` 用 papaya 无锁 map 让两线程无锁读写。`shutdown_background()` 不等 pending HTTP 的设计在此也呼应——solver 可能发了多余请求。

### PubGrubPackage：extra 与 marker 建模为代理包

uv 把 Python 的 extra 依赖（`black[colorama]`）和 marker 条件建模为 **proxy package**，让 PubGrub 统一处理：

```rust title="pubgrub/package.rs"
pub enum PubGrubPackageInner {
    Root(Option<PackageName>),
    Python(PubGrubPython),
    Package { name, extra, group, marker },
    Extra { name, extra, marker },   // 代理包：依赖 base + base[extra]
    Group { name, group, marker },   // 代理包
    Marker { name, marker },          // 代理包
}
```

**为什么这样设计**：`black[colorama]` 创建一个 `Extra` 代理包，它依赖 `black`（base）和 `black` + `colorama` extra。PubGrub 的 incompatibility 机制会自动把两者锁定到同一版本——若 base 选 2.0，extra 也必须是 2.0。这比在 resolver 外部手动同步版本更可靠。

### Fork 机制：universal resolution 的分叉

universal resolution 要生成覆盖所有目标平台的单一 lockfile，但不同平台/Python 版本可能需要不同包版本。resolver 通过 **fork** 处理：当检测到不兼容时，clone 当前 PubGrub `State`，为每个 fork 设独立的 `ResolverEnvironment`（marker 子集），各自求解，最后合并 `ResolverOutput` 用 `UniversalMarker` 区分生效环境。

三种 fork 触发场景：(1) **Python 版本分叉**——包的 `Requires-Python` 与目标不完全覆盖时按版本范围分叉 (`mod.rs:755`)；(2) **平台分叉**——local 版本（如 `torch==2.5.2+cpu`）平台覆盖不同时分叉 (`mod.rs:1501`)；(3) **依赖 marker 分叉**——universal 模式下依赖 marker 分支不兼容时分叉 (`mod.rs:1801`)。`ForkStrategy` (`fork_strategy.rs:5`) 控制排序：`Fewest` 优先兼容最广（可能选旧版本），`RequiresPython` 按不同 Python 版本分别选最新（默认）。fork 间通过 `preferences` 共享已选版本，减少跨 fork 选不同版本的情况 (`mod.rs:444`)。

### 候选选择与 Prerelease 策略

`CandidateSelector::select()` (`candidate_selector.rs:79`) 从 `VersionMap` 选版本，优先级：`get_preferred()`（lockfile 偏好）→ `get_installed()`（已安装包）→ `select_no_preference_with()`（按 specifier/marker/tags 过滤）。`PrereleaseMode` (`prerelease.rs:17`) 四种策略——`Disallow`/`Allow`/`IfNecessary`（默认，优先 stable 必要时 fallback）/`Explicit`（仅显式 specifier 允许），由 `PrereleaseStrategy::from_prerelease()` 生成 per-package 选择规则。

### Batch Prefetch 优化

冷缓存场景下（如 boto3/botocore 这种深层依赖链），PubGrub 连续尝试多版本都失败时要逐个等元数据。`BatchPrefetcher` (`batch_prefetch.rs:44`) 在 `should_prefetch()` 判断已尝试版本超阈值时，提前批量请求后续版本元数据——`Compatible` 策略基于当前约束预测下个候选，`InOrder` 按版本递减预取（回退）。这把串行的"试一个等一个"变成"试一个预取一批"，显著降低冷缓存延迟。

### ExcludeNewer 与冲突阈值

`ExcludeNewer` (`exclude_newer.rs`) 支持三级粒度——Global/Per-package/Per-index 截止时间，在 `DefaultResolverProvider::effective_exclude_newer()` (`provider.rs:163`) 计算生效值，过滤掉截止时间后发布的版本，支持相对时间（`30 days ago`）和绝对时间戳。`CONFLICT_THRESHOLD = 5` (`mod.rs:100`)——某包积累超 5 次冲突时触发 `reprioritize_conflicts()` 降低其优先级，避免在死胡同反复回溯。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| trait 泛型抽象 | `ResolverProvider`/`InstalledPackagesProvider` in `provider.rs:85` | resolver 与 IO 解耦，可注入 mock 测试 |
| 双线程求解 | `resolve()` in `mod.rs:280` | CPU-bound solver 与 IO-bound fetcher 分离 |
| 代理包（proxy） | `PubGrubPackageInner::Extra/Group/Marker` | extra/marker 统一为 PubGrub 包，自动版本同步 |
| 无锁并发 | `InMemoryIndex` 用 papaya HashMap | solver 与 fetcher 无锁读写元数据缓存 |
| 策略模式 | `ForkStrategy`/`PrereleaseMode`/`ResolutionMode` | 不同解析策略可配置 |

## 模块间交互

resolver 依赖 `uv-distribution-types`（`Dist`/`Requirement`/`IndexUrl`）、`uv-distribution`（`DistributionDatabase`）、`uv-client`（`RegistryClient` 经 provider 间接调用）、`uv-pep440`/`uv-pep508`（版本/marker）、`uv-platform-tags`（`Tags` 判 wheel 兼容）、`pubgrub`（求解引擎）、`petgraph`（结果图）。被 `uv` crate 的 `commands::pip::operations::resolve()` (`operations.rs:373`)、`commands::project::lock.rs`、`commands::project::add.rs` 调用。`DefaultResolverProvider::get_package_versions()` (`provider.rs:177`) 调 `client.simple_detail()` 发 Simple API 请求转 `VersionMap`。

## 扩展方式

新增解析模式（如 `ResolutionMode::HighestMinor`）：改 `resolution_mode.rs` 加 variant + `ResolutionStrategy` 逻辑，改 `candidate_selector.rs:select_no_preference_with()` 调整排序，改 `options.rs` 确保 `Options` 传递。修改 fork 触发条件（如按 CPython/PyPy 分叉）：改 `resolver/environment.rs` fork 生成，改 `get_dependencies_forking()`/`choose_version_registry()` 插入判断，改 `forks_to_fork_states()` 处理新状态，可能改 `ForkStrategy` 排序。
