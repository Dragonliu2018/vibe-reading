---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "依赖解析"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "resolver", "依赖解析", "回溯算法"]
description: "Cargo 依赖解析器解读：NP-hard semver 约束满足的 DFS + 回溯算法、ResolverContext 用 im_rc 持久化结构实现 O(1) 回退、ConflictCache 剪枝、两遍解析与新 feature resolver。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/00-overview)

---

## 模块定位

这一层实现 Cargo 最具智力密度的算法：给定一组根依赖与版本约束，求一个满足所有 semver 兼容关系、`links` 互斥、feature 统一的版本图。它本身是 NP-hard（约束满足），Cargo 用"DFS + 最高版本优先 + 回溯"的启发式近似。它独立成层是因为算法可独立测试、与 IO/编译解耦——resolver 只通过 `Registry` trait 查候选版本，不碰文件系统。代码量 ~6,300 行，在 `src/resolver/`。

## 模块架构

```
src/resolver/
├── mod.rs           # resolve() 入口 + activate_deps_loop DFS 主循环
├── context.rs       # ResolverContext：回溯状态（im_rc 持久化结构）
├── dep_cache.rs     # RegistryQueryer：包装 Source 查询 + 缓存候选
├── conflict_cache.rs # ConflictCache：记录失败激活组合，剪枝
├── features.rs      # 新 feature resolver（CliFeatures/HasDevUnits/activated_features）
├── resolve.rs       # Resolve：解析结果图（不可变，序列化进 Cargo.lock）
├── types.rs         # ConflictMap/ConflictReason/ResolveOpts/ActivationsKey
├── version_prefs.rs # VersionPreferences：最低版本/发布年龄策略
├── encode.rs        # Resolve 序列化（Cargo.lock 格式）
└── errors.rs        # ActivateError/ResolveError
```

核心三件套：`activate_deps_loop`（算法骨架）、`ResolverContext`（可回退状态）、`ConflictCache`（剪枝加速）。

## 调用链路

```
ops::resolve_ws_with_opts
  └─ resolver::resolve(summaries, replacements, registry, ..) in mod.rs:125
       ├─ RegistryQueryer::new(registry, ..)          # 包装 Source，缓存 query
       ├─ loop { activate_deps_loop(..)? ; if registry.wait()? { break } }
       │    └─ activate_deps_loop in mod.rs           # DFS
       │         ├─ 对每个待激活依赖 → registry.query_candidates
       │         ├─ 按版本降序尝试 → activate(idx, summary, ..)
       │         │    └─ ResolverContext::activate    # 写入 activations/parents/links
       │         ├─ 冲突 → past_conflicting_activations 记录 → backtrack
       │         └─ 成功 → 递归下层依赖
       └─ Resolve::new(graph, replacements, features, cksums, ..)
```

<details><summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `resolve` in `mod.rs:125` | 解析入口 | 外层 `loop` + `registry.wait()` 处理异步 query 未就绪 |
| `activate_deps_loop` | DFS 递归激活 | 遇冲突回溯，成功才返回 |
| `ResolverContext::activate` | 把一个版本写进图 | 记录 `parent` 边与 `ContextAge` |
| `find_candidate` | 选下一个候选 | 用 `ContextAge` 决定回退到哪 |
| `ConflictCache` | 记失败组合 | 命中即跳过，避免重蹈覆辙 |
| `features::resolve` | 新 feature resolver | 与依赖解析分离，只管 feature 统一 |

</details>

## 核心实现

### 算法骨架：DFS + 最高版本优先 + 回溯

`src/resolver/mod.rs` 顶部文档把算法讲得很直白：解析是 NP-hard，Cargo 用朴素回溯。两条启发式：

1. **从不激活不兼容版本**——只尝试能真正满足某依赖的版本，且不激活与已激活 semver 兼容的第二个版本（同名同源只允许一个），也不激活与已激活 `links` 重复的包（同一原生库只能被一个 crate 链接）。
2. **总是先激活最高版本**——默认 `serde = "1"` 是 semver 兼容约束，选最高版本最可能同时满足下游。

`activate_deps_loop`（`src/resolver/mod.rs`）做深度优先：激活一个依赖的最高候选 → 递归激活它的依赖 → 冲突则回溯到上一个决策点换次高候选。第一个全成功的组合立刻返回，只有"全失败"才报错。这是"先要最快得到一个可行解"而非"求最优解"的策略，匹配包管理的实际需求。

### ResolverContext：im_rc 持久化结构实现 O(1) 回退

回溯算法要频繁"撤销决策"。Cargo 的解法是**持久化数据结构**——`ResolverContext`（`src/resolver/context.rs:19`）的所有可变字段用 `im_rc::HashMap`：

```rust title="src/resolver/context.rs"
#[derive(Clone)]
pub struct ResolverContext {
    pub age: ContextAge,                    // 单调递增决策计数器
    pub activations: Activations,          // im_rc::HashMap<ActivationsKey, (Summary, age)>
    pub resolve_features: im_rc::HashMap<PackageId, FeaturesSet, _>,
    pub links: im_rc::HashMap<InternedString, PackageId, _>,  // links 互斥
    pub parents: Graph<PackageId, im_rc::HashSet<Dependency, _>>,
}
```

文档点明：`ResolverContext` 要被**大量克隆**（每个 `BacktrackFrame` 都存一份快照），所以必须便宜。`im_rc` 的持久化结构让 clone 是 O(1)（结构共享），回退只需丢弃当前引用、回到旧快照，无需"逐条撤销"。`ContextAge` 是单调计数器，记录"走到第几步决策"，`find_candidate` 用它判断回退到哪个决策点——这是回溯的导航坐标。

### ConflictCache：避免重蹈覆辙

`conflict_cache.rs` 的 `ConflictCache` 记录每次回溯的"冲突组合"——哪几个激活放一起会冲突、为什么（`ConflictReason`）。下次 DFS 走到相似局面时先查缓存，命中就剪枝跳过，不重复尝试已知必败的路径。这在依赖图大时（如 Servo，文档点名）省掉指数级的重复搜索。`types.rs` 的 `ConflictMap` 是冲突的精确记录（哪些包互相排斥），`DepsFrame`/`RemainingDeps` 跟踪当前还有多少依赖待满足。

### 两遍解析与新 feature resolver

`mod.rs` 文档明确：解析跑两遍。第一遍**全 feature 开启**（结果写进 `Cargo.lock`，保证 lock 与具体编译无关）；第二遍**只用用户命令行选的 feature**（实际编译用）。这是因为老的依赖 resolver 仍做 feature 统一（把所有可选依赖都算上以缩小搜索空间），但 feature 是否真启用要靠 2020 年加入的**新 feature resolver**（`src/resolver/features.rs`，`CliFeatures`/`HasDevUnits`/`activated_features`）。查某 feature 是否启用必须走新 resolver，两者协作：老 resolver 出版本图，新 resolver 出 feature 集。

### 性能考量

文档专辟"Performance"节：这是性能关键路径，数据量正比于依赖图大小，而 DFS + 回溯天生低效、不该到处分配。所以 resolver 大量用 `InternedString`（字符串驻留，`util::interning`，比较/哈希 O(1)）、`FxHashMap`（`rustc-hash`，比默认 SipHash 快）、`im_rc`（回退零拷贝）——这些不是装饰，是回溯在大型依赖图上能跑完的生存条件。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 回溯搜索 | `activate_deps_loop` | NP-hard 近似，求可行解不求最优 |
| 持久化数据结构 | `ResolverContext` 用 `im_rc` | 回退 O(1)，回溯算法的命脉 |
| 剪枝缓存 | `ConflictCache` | 避免重复尝试必败组合 |
| 启发式排序 | 最高版本优先 | 默认约束是 semver 兼容，选最高最可能一次满足 |
| 驻留 | `InternedString`/`FxHashMap` | 热路径性能 |
| 两遍解析 | 全 feature / 用户 feature 分离 | lock 与编译解耦 |

## 模块间交互

`resolver` 消费 `sources`（通过 `Registry`/`SourceMap` 的 `query` 查候选）与 `workspace`（`Dependency`/`Summary`/`PackageId`/`links` 声明），产出 `Resolve` 图交给 `ops`，`ops` 再喂给 `compiler` 的 `create_bcx`。它不直接调 `compiler`。`version_prefs.rs` 的 `VersionPreferences` 支持反向策略（`-Z minimal-versions` 选最低兼容版本），是 CI 复现老版本行为的扩展点。

## 扩展方式

调解析行为而非加算法：`VersionPreferences`（`version_prefs.rs`）已抽象版本选择策略，加新策略（如"偏好发布最久的稳定版"）在这里加。加新约束类型（如平台特定依赖的 cfg 求值）则改 `dep_cache.rs` 的候选过滤。改算法本身风险极高（影响所有用户），通常只在 `features.rs` 的新 feature resolver 里演进——老 resolver 基本冻结，feature 解析才是活跃演进区。
