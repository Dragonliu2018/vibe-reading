---
source:
  type: "源码解读"
  project: "uv"
  url: "https://github.com/astral-sh/uv"
title: "分发获取与安装"
date: "2026-08-13T20:07:12+08:00"
category: ["Languages", "Python", "Tools", "uv", "CodeWiki", "0.12.3"]
tags: ["uv", "Rust", "wheel", "PEP 517"]
description: "uv 分发获取与安装链：DistributionDatabase 下载构建、Preparer 并行准备、Installer rayon 并行安装到 venv。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/uv/CodeWiki/0.12.3/00-overview)

---

## 模块定位

这一组 crate（`uv-distribution` + `uv-installer` + `uv-install-wheel` + `uv-extract`）负责把解析器选出的 `Dist` 变成 venv 里真正可用的包——下载 wheel、必要时从 sdist 构建、解压、硬链接到 site-packages。它独立成模块是因为这是 uv 的 IO 重灾区：网络下载、磁盘解压、文件链接各有不同的并发模型与缓存策略，与纯算法的 resolver 必须分开。`DistributionDatabase` 是统一的获取入口，`Preparer`+`Installer` 是安装流水线的两阶段。

## 模块架构

获取与安装是三级流水线：`DistributionDatabase` 负责单个分发的下载/构建（返回 `LocalWheel`）；`Preparer` 并行准备一批分发（`FuturesUnordered`）；`Installer` 用 rayon 并行把 wheel 链接到 venv。`uv-extract` 提供流式/同步两种解压，`uv-install-wheel` 是底层 wheel 安装器（RECORD 校验、入口脚本、data 目录）。

```
uv-distribution/
├── distribution_database.rs  # DistributionDatabase · ManagedClient · 下载/构建
├── download.rs               # LocalWheel 数据结构
├── index/                    # RegistryWheelIndex · BuiltWheelIndex（缓存索引）
├── source/                   # SourceDistributionBuilder（sdist PEP 517 构建）
└── reporter.rs               # Reporter trait（进度回调）
uv-installer/
├── preparer.rs               # Preparer 并行准备 + InFlight 去重
├── installer.rs              # Installer rayon 并行安装
└── plan.rs                   # Planner 分区（cached/remote/reinstalls/extraneous）
uv-install-wheel/             # 底层 install_wheel · RECORD · 入口脚本
uv-extract/                   # stream::unzip · sync::unzip · hash
```

## 调用链路

从"获取一个包"到"安装到 venv"的完整链：

```
Preparer::prepare() (preparer.rs:88)            # 按 size 降序，大文件先下载
  └─ prepare_stream() → FuturesUnordered        # 并行
       └─ get_wheel(dist, in_flight) (preparer.rs:111)
            ├─ in_flight.register_or_wait()     # 去重：同 dist 只下载一次
            └─ database.get_or_build_wheel(dist, tags, hashes) (distribution_database.rs:117)
                 ├─ Dist::Built → get_wheel() (L179)
                 │    ├─ Registry/DirectUrl wheel:
                 │    │    ├─ stream_wheel() (L218)    ← 优先流式
                 │    │    │    ├─ HTTP GET (CachedClient)
                 │    │    │    ├─ uv_extract::stream::unzip()  边下载边解压
                 │    │    │    ├─ validate_and_heal_record()
                 │    │    │    └─ cache.persist() → Archive
                 │    │    └─ download_wheel() (L256)  ← 流式失败兜底
                 │    │         下载到磁盘 → uv_extract::unzip() (rayon 并行)
                 │    ├─ GitPath wheel → git fetch → load_wheel()
                 │    └─ Path wheel → load_wheel()
                 └─ Dist::Source → build_wheel() (L433)
                      └─ builder.download_and_build() (source/mod.rs:260)
                           ├─ 下载/解压 sdist → build_distribution() (L2994)
                           │    ├─ direct_build (uv build backend 快速路径)
                           │    └─ setup_build() → PEP 517 builder.wheel()
                           └─ unzip_wheel()
  → Vec<CachedDist>
Installer::install(wheels) (installer.rs:87)
  └─ rayon::spawn → install() (L159)
       └─ wheels.par_iter() → uv_install_wheel::install_wheel() (L172)
            ├─ wheel_destination() (purelib/platlib)
            ├─ link_wheel_files()               # 硬链接/拷贝到 site-packages
            ├─ parse_scripts()                  # 入口脚本
            ├─ install_data() · write_record()
            └─ write_installer_metadata()
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `DistributionDatabase::get_or_build_wheel()` in `distribution_database.rs:117` | 获取/构建一个 wheel | 区分 Built（下载）/Source（构建） |
| `stream_wheel()` in `distribution_database.rs:218` | 流式下载并解压 | 边下载边解压，省磁盘 I/O |
| `build_wheel()` in `distribution_database.rs:433` | sdist 构建 | direct_build 快速路径 + PEP 517 标准路径 |
| `Preparer::prepare()` in `preparer.rs:88` | 并行准备一批分发 | FuturesUnordered + 按大小降序 |
| `Installer::install_blocking()` in `installer.rs:135` | 并行安装 | rayon par_iter，非 tokio |
| `Planner::build()` in `plan.rs:236` | 分区安装计划 | cached/remote/reinstalls/extraneous |

</details>

## 核心实现

### wheel 优先于 sdist + 流式优先

`get_or_build_wheel()` (`distribution_database.rs:117`) 按 `Dist` 枚举分发：`Dist::Built` 直接下载 wheel，`Dist::Source` 构建 sdist。**为什么 wheel 优先**——resolver 阶段就优先选有兼容 wheel 的版本，只有找不到才 fallback 到 sdist，因为构建 sdist 需要 PEP 517 子进程开销大。对 Registry/DirectUrl wheel，先试 `stream_wheel()` (`L218`) 流式下载同时解压（`uv_extract::stream::unzip` 用 `async_zip`，不需要 Seek）；若 HTTP 流式不支持或失败（`is_http_streaming_unsupported()`），fallback 到 `download_wheel()` (`L256`) 先下载到磁盘再用 rayon 并行解压。**为什么流式优先**——省磁盘 I/O 和时间，但部分 CDN 不支持 streaming 需兜底。

### ManagedClient 并发控制

`DistributionDatabase` 不直接持有 `RegistryClient`，而是通过 `ManagedClient` 包装：

```rust title="distribution_database.rs:1278"
pub struct ManagedClient<'a> {
    pub unmanaged: &'a RegistryClient,
    control: Arc<Semaphore>,   // 并发控制信号量
}
```

`managed()` 方法在执行 HTTP 请求前 acquire permit。semaphore 由上层 `Concurrency` 创建（默认 50 个下载 permit），多个 wheel 的下载并行执行（`FuturesUnordered`）但总并发受 semaphore 限制。解压用 `tokio::task::spawn_blocking` 避免 blocking I/O 阻塞 async runtime。

### 缓存复用与 InFlight 去重

多层缓存避免重复工作：(1) **HTTP 缓存层**——`CachedClient.get_serde_with_retry()` 检查 `.http` pointer，遵循 `CacheControl::from(cache.freshness())`；(2) **Archive 缓存层**——下载解压后 `cache.persist()` 持久化，后续通过 `HttpArchivePointer`/`PathArchivePointer` 定位；(3) **RegistryWheelIndex 惰性索引**——按需扫描缓存目录，`FxHashMap` 的 `Entry` API 保证每包只索引一次；(4) **BuiltWheelIndex**——sdist 构建结果按 revision ID + build settings hash 分 shard 缓存，避免重复构建；(5) **InFlight 去重**——`Preparer::get_wheel()` (`preparer.rs:136`) 通过 `in_flight.downloads.register_or_wait(&id)` 让同 dist 的并发请求只执行一次下载，其余等结果。

### sdist 构建：PEP 517 + direct_build 快速路径

`build_distribution()` (`source/mod.rs:2994`) 在 resolver 找不到兼容 wheel、`--no-binary` 强制 sdist、或从 Git/本地目录安装时触发。两条路径：(1) **direct_build 快速路径**——若用 uv 自带 build backend，跳过 PEP 517 直接构建 (`L3030`)；(2) **标准路径**——`setup_build()` 创建隔离构建环境，`builder.wheel()` 调用 PEP 517 backend (`L3096`)。构建环境通过 `BuildKey` 缓存复用（相同 source + interpreter + config 复用 `build_arena`），`build_stack` 跟踪构建依赖链防止循环构建。

### RECORD 校验与安装

wheel 解压后、持久化前，调用 `uv_install_wheel::validate_and_heal_record()` (`distribution_database.rs:763`) 校验 RECORD 文件完整性——确保解压内容与 RECORD 一致，防止损坏/篡改的 wheel 进缓存。`Installer::install()` 用 rayon `par_iter` 并行调用 `install_wheel()`，确定 purelib/platlib 目标目录后 `link_wheel_files()` 硬链接到 site-packages（`LinkMode` 控制 hardlink/copy/clone），生成入口脚本、处理 data 目录、写 RECORD 与 installer metadata。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| trait 泛型 | `DistributionDatabase<Context: BuildContext>` in `distribution_database.rs:54` | 数据库代码与构建实现解耦 |
| 装饰器 | `ManagedClient` 包装 `RegistryClient` | 透传并发控制，不侵入 client |
| Observer（进度回调） | `Reporter` trait in `reporter.rs:7` + Facade 适配 | 三层 Reporter 逐层转发下载/构建/安装进度 |
| Builder | `Installer::new().with_link_mode().with_cache().install()` | 链式配置安装参数 |
| 去重注册 | `InFlight.register_or_wait()` in `preparer.rs:136` | 同 dist 并发请求只下载一次 |

## 模块间交互

`uv-installer` 的 `Preparer` 依赖 `uv-distribution`（`DistributionDatabase`），后者依赖 `uv-client`（`RegistryClient`/`CachedClient`，经 `ManagedClient` 包装 + Semaphore 限流）、`uv-cache`（缓存存储）、`uv-extract`（解压）、`uv-install-wheel`（RECORD 校验）、`uv-git`（Git 源）、`uv-fs`（原子写入）。`uv` crate 的 commands 创建 `Preparer` 和 `Installer`，把 `DistributionDatabase` 注入 `Preparer`。`DistributionDatabase` 与 `RegistryClient` 经 `ManagedClient.managed(|client| client.cached_client().get_serde_with_retry(...))` 协作——先 acquire semaphore 再委托 CachedClient 执行带缓存 HTTP。

## 扩展方式

新增归档格式（如 `.tar.gz` wheel）：在 `WheelExtension` 枚举加变体，在 `stream_wheel()`/`download_wheel()` 的 `match extension` 加分支 (`L722`/`L961`)，在 `uv-extract/src/stream.rs` 加流式解压函数，在 `download.rs:WheelTarget::try_from` 识别新扩展名。修改下载并发策略：改 `ManagedClient::managed()` (`L1296`) 的 semaphore 逻辑，或改 `prepare_stream()` (`L65`) 为有界 `buffer_unordered(N)`；默认并发数在 uv crate 的 `Concurrency::default()`（downloads=50）。
