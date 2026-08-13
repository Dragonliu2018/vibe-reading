---
source:
  type: "源码解读"
  project: "uv"
  url: "https://github.com/astral-sh/uv"
title: "缓存层"
date: "2026-08-13T20:07:12+08:00"
category: ["Languages", "Python", "Tools", "uv", "CodeWiki", "0.12.3"]
tags: ["uv", "Rust", "缓存", "去重"]
description: "uv-cache 全局去重缓存：12 桶分类、archive 硬链接去重、Freshness/Refresh 语义与版本化桶升级。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/uv/CodeWiki/0.12.3/00-overview)

---

## 模块定位

`uv-cache` 是 uv 速度的基石。uv 比 pip 快 10-100 倍的核心原因之一就是**全局去重缓存**：同一 wheel 被多个项目依赖时只需下载、解压一次，后续安装直接从缓存硬链接。这个模块独立存在，是因为缓存是被几乎所有模块共享的横切关注点——client 缓存 HTTP 响应、distribution 缓存 wheel、python 缓存解释器信息、installer 从缓存链接——需要一个统一的存储与去重抽象。它的设计哲学是"用空间换时间，用间接引用换原子性"。

## 模块架构

`Cache` 是入口，`CacheBucket` 枚举定义 12 种数据桶，`CacheEntry`/`CacheShard` 是路径抽象，`WheelCache` 区分 wheel 来源。`Freshness`/`Refresh` 分离"运行时判定"与"策略配置"，`archive` 桶通过 symlink/Link 文件实现去重。

```
uv-cache/src/
├── lib.rs            # Cache · CacheEntry · CacheShard · CacheBucket · Freshness · Refresh
├── wheel.rs          # WheelCache (Index/Url/Path/Editable/Git)
├── by_timestamp.rs   # CachedByTimestamp
├── archive.rs        # ArchiveId
└── removal.rs        # Removal · RemovalMode (prune 统计)
```

## 调用链路

写入与读取一个缓存项的核心链：

```
写入（以 persist 为例）:
Cache::persist(temp_dir, path) (lib.rs:404)
  ├─ ArchiveId::new()                          # uv_fastid 生成唯一 ID (archive.rs:22)
  ├─ Cache::entry(CacheBucket::Archive, "", &id) (lib.rs:415)
  │    └─ Cache::bucket(Archive) → root.join("archive-v0")
  ├─ uv_fs::rename_with_retry(temp_dir, archive_entry.path())  # 原子移动
  └─ Cache::create_link(&id, path) (lib.rs:873 unix / 815 windows)
       ├─ Unix: 计算相对路径 → fs_err::symlink(src, dst)
       └─ Win:  序列化 Link{id, version} 写入文件

读取:
Cache::entry(bucket, dir, file) (lib.rs:315)   # 计算路径
Cache::freshness(entry, package, path) (lib.rs:365)
  ├─ match Refresh 策略:
  │    Refresh::None → return Fresh (零 I/O 快速路径)
  │    Refresh::All(t) → t 作 cutoff
  │    Refresh::Packages(...) → 检查 package/path 匹配
  ├─ fs_err::metadata(entry.path())
  │    Timestamp::from_metadata >= cutoff → Fresh
  │    < cutoff → Stale, NotFound → Missing
  └─ 返回 Freshness
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `Cache::persist()` in `lib.rs:404` | 持久化解压 wheel 到 archive 并建链接 | 原子移动 + 间接引用 |
| `Cache::freshness()` in `lib.rs:365` | 判定缓存新鲜度 | `Refresh::None` 零 I/O 快速路径 |
| `Cache::prune()` in `lib.rs:616` | 清理悬空缓存 | 四步：过期桶/environments/CI wheel/零引用 archive |
| `Cache::init()` in `lib.rs:494` | 初始化缓存目录 | 获取共享锁 |
| `create_link()` in `lib.rs:873/815` | 创建 archive 引用 | Unix symlink / Windows Link 文件 |

</details>

## 核心实现

### 12 桶分类与版本化

`CacheBucket` enum (`lib.rs:981`) 将不同数据隔离到不同子目录，桶名带版本号：

```rust title="lib.rs:981"
pub enum CacheBucket {
    Wheels,              // wheels-v6: wheel 文件 + 元数据 + 解压 wheel
    SourceDistributions, // sdists-v9: 源码包 + 构建产物 + metadata
    FlatIndex,           // flat-index-v4: 扁平索引响应
    Git,                 // git-v0: Git 仓库
    Interpreter,         // interpreter-v4: 解释器元信息
    Simple,              // simple-v24: Simple API 响应 (.rkyv)
    Archive,             // archive-v0: 去重的解压 wheel 目录
    Builds,              // builds-v0: PEP 517 构建临时 venv
    Environments,        // environments-v2: 可复用 venv
    Python,              // python-v0: Python 下载
    Binaries,            // binaries-v0: 工具二进制
    Osv,                 // osv-v0: 漏洞数据
}
```

**为什么这样设计**：格式变更时 bump 版本号，新版本 uv 不会读旧格式数据（无兼容代码），旧桶在 `prune` 第 1 步自动清理（不在 `CacheBucket::iter()` 中的目录被视为 dangling）。`to_str()` (`lib.rs:1232`) 映射版本化目录名，`ARCHIVE_VERSION` 与 Link 的 version 字段配合，Windows 上可检测并忽略 stale link。

### Archive 去重：间接引用 + 平台差异

`Cache::persist()` (`lib.rs:404`) 是核心去重机制——把解压 wheel 原子移动到 `archive-v0/<ArchiveId>`，在目标位置创建指向 archive 的链接。**为什么用间接引用**——解压 wheel 是目录，不能原子替换；通过 symlink → archive，条目可原子创建/删除。多个缓存条目可引用同一 archive（如不同 Python 版本共享 `py3-none-any` wheel），实现去重。平台差异：Unix 用 symlink（相对路径），`resolve_link` 直接 `canonicalize`；Windows 不支持目录 symlink，用结构化 `Link` 文件（`archive-v{version}/{id}` 格式）+ 版本号，`resolve_link` 解析后重建路径。prune 时 `find_archive_references()` (`lib.rs:758`) 扫描所有引用，仅删除零引用 archive。

### Freshness vs Refresh：判定结果 vs 策略配置

`Freshness` (`lib.rs:1398`) 是**运行时判定结果**（Fresh/Stale/Missing），`Refresh` (`lib.rs:1416`) 是**策略配置**：

```rust title="lib.rs:1416"
pub enum Refresh {
    None(Timestamp),                                        // 信任缓存，freshness() 直接返回 Fresh（零 I/O）
    Packages(Vec<PackageName>, Vec<Box<Path>>, Timestamp),  // 只刷新指定包/路径
    All(Timestamp),                                         // 全部重新验证
}
```

**为什么这样设计**：`Refresh::None` 直接返回 Fresh 跳过 metadata 查询——零 I/O 快速路径，这是 uv 二次安装几乎瞬时的关键。`Refresh::combine()` 取"更激进"的策略，允许多层（workspace 级 + 子项目级）合并。

### 并发安全：共享锁与独占锁

`Cache::init()` (`lib.rs:494`) 获取**共享锁**（`LockedFileMode::Shared`），多个 uv 进程可同时读缓存；`prune`/`clear` 需**独占锁**（`with_exclusive_lock`）防止删除正在使用的条目。不支持共享锁的文件系统降级为无锁（发出警告）。

### --no-cache 与全局缓存决策

`--no-cache` 不是跳过缓存逻辑，而是 `Cache::temp()` (`lib.rs:194`) 创建临时目录作缓存根——保持代码路径一致，所有模块的缓存读写逻辑不变，只是底层目录不同，临时目录在 `Cache` drop 时自动清理。**为什么用全局缓存而非 per-project**——同一 wheel 跨项目只需下载/解压一次，archive 桶通过 symlink 共享解压目录，磁盘占用最小化；resolve 后的 install 直接从本地缓存硬链接，无需网络。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 桶分桶 | `CacheBucket` enum in `lib.rs:981` | 数据类型隔离 + 版本化升级无兼容代码 |
| 间接引用 | `persist()` + `create_link()` in `lib.rs:404/873` | archive 去重 + 条目原子替换 |
| 策略 vs 判定 | `Refresh`(策略) vs `Freshness`(结果) | `Refresh::None` 零 I/O 快速路径 |
| 文件锁分级 | 共享锁 `init()` / 独占锁 `prune` | 多进程并发读，独占写 |
| 透明降级 | `--no-cache` → 临时目录 | 代码路径一致，仅换根目录 |

## 模块间交互

Cache 被几乎所有上层模块依赖：`uv-client` 用 `Simple`/`FlatIndex` 桶缓存 HTTP 响应；`uv-distribution` 用 `Wheels`/`SourceDistributions`/`Archive`/`Git` 桶；`uv-installer` 用 `Wheels`/`Archive` 桶（经 `resolve_link` 取解压目录）；`uv-python` 用 `Interpreter`/`Python` 桶；`uv-build` 用 `Builds`/`Environments` 桶。12 桶覆盖 wheel/sdist/git/http/解释器/venv/Python 下载/漏洞数据等全部缓存需求。

## 扩展方式

新增缓存桶：(1) `CacheBucket` enum (`lib.rs:981`) 加变体；(2) `to_str()` (`:1232`) 加版本化目录名；(3) `iter()` (`:1372`) 注册（否则 prune 误删）；(4) 如需按包删除在 `CacheBucket::remove()` (`:1262`) 加分支；(5) 若用 archive 引用在 `find_archive_references()` (`:760`) 加桶。升级桶格式（`wheels-v6` → `v7`）：改 `to_str()` 版本号，若是 Archive 桶同步 `ARCHIVE_VERSION`，旧目录被 prune 第 1 步自动清理，更新测试硬编码版本号。
