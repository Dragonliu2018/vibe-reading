---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "缓存系统"
date: "2026-08-13T20:14:13+08:00"
category: [Tools, Ruff, CodeWiki, "0.16.2"]
tags: ["ruff", "Rust", "缓存", "rkyv", "增量"]
description: "ruff 的文件级缓存——mtime+权限 key，rkyv 零拷贝序列化，只缓存通过标志，是极速的关键之一。"
readingTime: "9 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_cache/`（底层基础设施）+ `crates/ruff/src/cache.rs`（缓存逻辑）是 ruff 的文件级缓存系统。这个模块独立存在是因为**它是 ruff 极速的关键之一**——增量场景下（重复 lint 同一项目），缓存让 ruff 几乎零开销跳过未变更文件。设计极为精简：key 是 mtime+权限 hash，value 只有两个 bool（linted/formatted），不缓存诊断结果。缓存系统与 lint 逻辑解耦，作为横切能力被 `commands/check.rs`/`format.rs` 调用。

## 模块架构

两层结构：`ruff_cache` 提供底层 `CacheKey` trait、`CacheKeyHasher`（基于 SeaHasher）及第三方类型的 `CacheKey` 实现；`crates/ruff/src/cache.rs` 定义 `Cache`/`PackageCache`/`FileCacheKey`/`PackageCacheMap` 等运行时结构，负责读写、序列化、失效。采用 Read-Through + Write-Behind 模式：`lint_path()` 分析前查缓存命中则跳过，分析结果不立即写盘而暂存 `changes`，`persist()` 时批量写入。

## 调用链路

```
check 命令缓存流程:
  commands/check.rs:76  PackageCacheMap::init()  并行打开所有 package 缓存
       │
       ▼
  diagnostics.rs:192  lint_path() 内:
    ├─ FileCacheKey::from_path(path)           构建 key (mtime + permissions)
    ├─ cache.get(relative_path, &cache_key)    命中判断
    │    └─ 重新计算 FileCacheKey hash, 与存储 key 比对 → 不同则失效
    ├─ 命中 (linted==true) → return Ok(Diagnostics::default())  跳过分析
    └─ 未命中 → check_path() 完整 lint
       └─ cache.set_linted(path, &key, linted)  linted = diagnostics.is_empty()
            └─ 暂存到 Cache::changes
       │
       ▼
  commands/check.rs:185  caches.persist()  并行写入磁盘
    └─ 清除超过 30 天未访问的条目 (MAX_LAST_SEEN)
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `FileCacheKey::from_path()` | 从文件元数据构建 key | mtime + permissions，非内容 hash |
| `Cache::get()` in `cache.rs:260` | 缓存命中判断 | 重算 key hash 与存储比对 |
| `Cache::set_linted()` | 标记文件已通过检查 | 仅无诊断文件标记 true |
| `Cache::persist()` | 批量写盘 + 30 天过期清理 | NamedTempFile 原子写入 |

## 核心实现

### FileCacheKey：mtime + permissions

```rust title="crates/ruff/src/cache.rs"
#[derive(CacheKey)]
pub(crate) struct FileCacheKey {
    file_last_modified: FileTime,      // mtime
    file_permissions_mode: u32,        // 文件权限模式
}

pub(crate) struct FileCache {
    key: u64,                   // FileCacheKey hash 得来的 64 位 key
    last_seen: AtomicU64,       // 最后访问时间（毫秒）
    data: FileCacheData,
}

struct FileCacheData {
    linted: bool,     // 已 lint 且无诊断
    formatted: bool,  // 已 format
}
```

**缓存值非常精简**：只有两个 bool 标志，**不缓存诊断结果本身**，只缓存"这个文件上次已通过检查/已格式化"这一事实。key 是 mtime + permissions 的 hash——mtime 获取代价 O(1)，内容 hash 需 O(n) 读整个文件，对极速 linter 开销可能占 lint 本身相当比例。permissions 纳入 key 是为解决 issue #3086（权限变化可能影响 lint 结果）。

### rkyv 零拷贝序列化 + 原子写入

```rust title="crates/ruff/src/cache.rs"
#[derive(rkyv::Archive, Debug, rkyv::Deserialize, rkyv::Serialize)]
struct PackageCache {
    #[rkyv(with = rkyv::with::AsString)]
    package_root: PathBuf,
    #[rkyv(with = rkyv::with::MapKV<rkyv::with::AsString, rkyv::with::Identity>)]
    files: FxHashMap<RelativePathBuf, FileCache>,
}
// persist: 写入 NamedTempFile 再 rename（原子写入）
```

用 `rkyv`（zero-copy 序列化）而非 JSON/bincode，追求极致读写性能。缓存文件先写 `NamedTempFile` 再 rename，实现原子写入——崩溃不会留下损坏的缓存文件。

### CacheKey trait：自定义而非复用 Hash

```rust title="crates/ruff_cache/src/cache_key.rs"
// 自定义 CacheKey trait 而非复用 Hash 的原因：
// - Hash 需极快，Cache key 性能不敏感
// - Cache key 必须确定性（deterministic），Hash 不一定
// - Cache key 理想情况下跨平台可移植
```

### 缓存路径隔离

```rust title="crates/ruff/src/cache.rs"
// 路径: {cache_dir}/{VERSION}/{hash}
// VERSION 隔离不同 ruff 版本，避免升级后兼容性问题
// package 级 cache_key = hash(package_root + settings)，不同配置互不干扰
fn cache_key(package_root: &Path, settings: &Settings) -> u64 { ... }
```

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Read-Through + Write-Behind | `lint_path()` in `diagnostics.rs:192` | 命中跳过，结果暂存批量写 |
| 两级 Key | package 级（路径）+ file 级（mtime） | 增量检查，只重分析变更文件 |
| rkyv 零拷贝 | `PackageCache` derive in `cache.rs:322` | 极致读写性能 |
| 自定义 CacheKey | `CacheKey` trait in `ruff_cache/cache_key.rs:74` | 确定性 + 跨平台可移植 |

## 模块间交互

```
crates/ruff_cache/src/          (基础设施: CacheKey trait + SeaHasher)
         ↑ 使用
crates/ruff/src/cache.rs        (缓存逻辑: Cache/PackageCache/PackageCacheMap)
         ↑ 调用
crates/ruff/src/diagnostics.rs  (lint_path: 读缓存→跳过/分析→写缓存)
         ↑ 调用
crates/ruff/src/commands/check.rs   (PackageCacheMap::init → lint_path → persist)
crates/ruff/src/commands/format.rs  (同样模式: is_formatted/set_formatted)
```

## 重要设计决策

**用 mtime+permissions 而非内容 hash？** 性能 vs 正确性权衡，ruff 选性能优先。mtime 获取 O(1)，内容 hash O(n) 读整个文件——对极速 linter，读文件算 hash 的开销可能占 lint 本身相当比例。代价：mtime 不完全可靠（`touch` 改 mtime 内容不变、跨系统拷贝可能改 mtime），但 lint 幂等，误判风险可接受。permissions 纳入为解决 issue #3086。

**只缓存"通过"的文件，不缓存诊断结果？** 有诊断的文件下次需重新分析（诊断可能已修复）；无诊断文件若 mtime 未变可安全跳过；避免序列化诊断的复杂性与开销。`FileCacheData` 只两 bool。

**fix 模式下缓存处理？** `FixMode::Generate`（不实际改文件）正常用缓存；`FixMode::Apply`/`Diff`（有副作用）只有无 fix 被应用时才写缓存——应用 fix 后文件内容已变，缓存可能不一致（`diagnostics.rs:354`）。

**format 命令的缓存**：由 `cli.no_cache` 控制，默认开启。`is_formatted()` 跳过已格式化文件。但 range 格式化时不写缓存（`format.rs:284`：`let cache = cache.filter(|_| range.is_none())`）。

**30 天过期 + last_seen**：每条目记录最后访问时间，`persist()` 时清除超过 `MAX_LAST_SEEN = 720 小时`（30 天）未访问的条目（`cache.rs:204`），防缓存无限增长。

## 扩展方式

**调整缓存失效策略（mtime 改内容 hash）**：修改 `FileCacheKey`（`cache.rs:31`）——替换字段为内容 hash，`from_path()` 读文件算 hash，`Cache::get()`/`update()` 的 hash 计算逻辑不变。需权衡：内容 hash 更可靠但更慢，对以速度为核心的 ruff 影响显著。

**调整缓存过期时间**：修改 `cache.rs:204` 的 `MAX_LAST_SEEN` 常量即可。
