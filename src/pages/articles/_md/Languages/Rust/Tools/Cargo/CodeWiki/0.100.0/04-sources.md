---
source:
  type: "源码解读"
  project: "Cargo"
  url: "https://github.com/rust-lang/cargo"
title: "源管理"
date: "2026-08-19T12:13:38+08:00"
category: [Languages, Rust, Tools, Cargo, CodeWiki, "0.100.0"]
tags: ["Cargo", "Rust", "Source", "registry", "git"]
description: "Cargo 源管理层解读：Source trait 抽象（query/download/fingerprint）、五种内置源实现（RegistrySource/GitSource/PathSource/DirectorySource/ReplacedSource）、SourceConfigMap 与 [source.*] 配置。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Rust/Tools/Cargo/CodeWiki/0.100.0/00-overview)

---

## 模块定位

这一层负责"包从哪来、怎么拿"。它把 registry（crates.io sparse 索引 + HTTP 下载）、git 仓库、本地路径、`cargo vendor` 归档这些**差异极大的来源**藏在统一的 `Source` trait 后面，让 resolver 只用 `query`（查元数据）和 `download`（取包）两个动作，完全不感知具体源类型。这是 Cargo 能支持私有 registry、git 依赖、离线 vendor 的架构基础。代码量 ~10,000 行，在 `src/sources/`。

## 模块架构

```
src/sources/
├── source.rs        # Source trait + SourceMap + MaybePackage + QueryKind
├── config.rs        # SourceConfigMap：[source.*] 配置的运行时表示，懒加载各源
├── registry/        # RegistrySource：sparse/git 索引 + HTTP 下载（主体）
├── git/             # GitSource：gix 实现，索引/checkout/缓存
├── path.rs          # PathSource / RecursivePathSource：本地路径
├── directory.rs     # DirectorySource：cargo vendor 产物
├── replaced.rs     # ReplacedSource：[source-replacement] 装饰器
└── overlay.rs       # OverlaySource
```

一个 trait + 五个实现 + 一个配置聚合器。`SourceMap` 把多个 `Source` 装进一个可 `query`/`download` 的集合，这就是 resolver 眼中的"世界"。

## 调用链路

```
ops::resolve_ws_with_opts
  └─ SourceConfigMap::new(gctx)            # 解析 [source.*]，但懒加载具体 Source
       └─ sources: SourceMap                # 聚合所有源
            ├─ source.query(&dep, QueryKind, f)   # resolver 查候选版本 → IndexSummary
            └─ source.download(pkg_id)            # ops 取包
                 ├─ MaybePackage::Ready           # 已在本地（PathSource）
                 └─ MaybePackage::Download{url}    # 需下载（RegistrySource）
                      └─ source.finish_download(pkg_id, bytes) → Package
```

<details><summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Source::query` | 按依赖查候选版本 | async + 回调流式返回，不等全部就绪 |
| `Source::download` | 取一个包 | 返回 `MaybePackage`，区分本地已有/需下载 |
| `Source::finish_download` | 收下载完的 .crate 并落盘 | 由下载器回调，源负责校验+解包 |
| `Source::fingerprint` | 源状态指纹 | 给 compiler 的 fingerprint 判增量 |
| `Source::supports_checksums`/`requires_precise` | 能力声明 | registry 支持校验和、git 需 precise |
| `SourceConfigMap::load` | 按需加载某 Source | 不预加载全部源，省启动开销 |

</details>

## 核心实现

### Source trait 契约

`Source` trait（`src/sources/source.rs`）是本层的契约。它的方法刻意分成"查询元数据"和"取包"两组，且 `download` 返回 `MaybePackage` 而非直接 `Package`：

```rust title="src/sources/source.rs"
#[async_trait::async_trait(?Send)]
pub trait Source {
    fn source_id(&self) -> SourceId;
    fn supports_checksums(&self) -> bool;
    fn requires_precise(&self) -> bool;
    async fn query(&self, dep: &Dependency, kind: QueryKind,
                   f: &mut dyn FnMut(IndexSummary)) -> CargoResult<()>;
    async fn download(&self, package: PackageId) -> CargoResult<MaybePackage>;
    async fn finish_download(&self, pkg_id: PackageId, contents: Vec<u8>) -> CargoResult<Package>;
    fn fingerprint(&self, pkg: &Package) -> CargoResult<String>;
    fn invalidate_cache(&self);
    fn set_quiet(&mut self, quiet: bool);
    fn verify(&self, _pkg: PackageId) -> CargoResult<()> { Ok(()) }
    fn describe(&self) -> String;
}
```

设计决策有三处值得讲：① `query` 用**回调**而非返回 `Vec`——registry 索引可能命中大量候选，流式避免全量收集的内存峰值；② `download` 返回 `MaybePackage`——本地源（`PathSource`）立刻 `Ready`，远程源返回 `Download{url}` 让统一的下载器去取，再回调 `finish_download`，把"是否需要网络"的分支藏在 trait 内；③ `source_id()` 是 trait 方法——源用 `SourceId` 自证身份，这是防 [dependency confusion attack] 的根基（包必须从其声明的源来，不能被同名异源顶替）。

### RegistrySource：crates.io 与私有 registry

`src/sources/registry/` 是主体实现，覆盖 crates.io 与所有私有 registry。它内部又分索引协议（sparse HTTP——现代默认；或 git 索引——老协议）与下载（HTTP 取 `.crate` 文件）。`query` 走索引（按 crate 名查所有版本+特性+校验和），`download` 从 `https://.../{name}-{version}.crate` 取压缩包，`finish_download` 校验 SHA256、解包到 `~/.cargo/registry/src/`。`IndexSummary` 携带校验和与 yank 状态——resolver 据此跳过 yanked 版本。

### GitSource / PathSource / DirectorySource / ReplacedSource

- **`GitSource`**（`src/sources/git/`）：用 `gix` 克隆/checkout 指定 rev（branch/tag/commit/tag），缓存进 `~/.cargo/git/`。`fingerprint` 用 commit OID——源变了 commit 就是 dirty。
- **`PathSource`**（`path.rs`）：本地路径依赖，直接读目录里的 `Cargo.toml`，`RecursivePathSource` 递归读子目录。`download` 直接返回 `Ready`（无需网络）。
- **`DirectorySource`**（`directory.rs`）：为 `cargo vendor` 设计——包已预下载到本地目录，只读不解压，用于离线/受控环境。
- **`ReplacedSource`**（`replaced.rs`）：装饰器，实现 `[source-replacement]`——把对源 A 的操作透明重定向到源 B（如把 crates.io 换成内部镜像）。它持有原源与替换源，所有 trait 方法转调替换源。

### SourceConfigMap 与 [source.*] 配置

`SourceConfigMap`（`src/sources/config.rs`）是配置 `~/.cargo/config` 里 `[source.*]` 表的运行时表示。它**懒加载**：只有 resolver 真正 `query` 某个 `SourceId` 时，才去构造对应的 `Source` 实例（拉索引/开 git 仓库是有开销的，预加载全部源会拖慢 `cargo --version`）。它还处理 `[source-replacement]` 链——把替换关系解析清楚，resolver 看到的是最终的源。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略族 | `Source` trait + 5 实现 | 把来源差异藏在统一接口后 |
| 状态机 | `MaybePackage` (Ready/Download) | 区分本地/远程，统一下载器复用 |
| 装饰器 | `ReplacedSource` | source-replacement 透明重定向，不改 resolver |
| 懒加载 | `SourceConfigMap` | 不预加载全部源，只读命令零开销 |
| 回调流 | `query` 的 `FnMut` | 避免大候选集内存峰值 |
| 防混淆 | `source_id()` 自证 | 依赖必须从其声明的源来 |

## 模块间交互

`sources` 是 `resolver` 的数据提供方（`query`）与 `ops` 的包提供方（`download`）。resolver 通过 `SourceMap` 聚合的 `Registry` trait 查询；`ops` 通过 `PackageSet` 持有下载结果，交给 `compiler`。它依赖 `workspace` 的 `SourceId`/`Package`/`Dependency` 作输入输出类型，依赖 `context` 的配置与网络栈（`util::network`）。注意 `compiler` 也调 `Source::fingerprint`——增量判定需要源的 commit OID/索引时间戳。

## 扩展方式

新增一种源类型（如新的私有 registry 协议）：实现 `src/sources/<name>.rs` 完成 `Source` trait → 在 `SourceConfigMap`（`config.rs`）注册加载逻辑 → 在 `SourceKind`（`workspace/source_id.rs`）加变体与解析 → 加对应的 `fingerprint` 策略。因 resolver 只用 trait，加源不需要动 resolver/编译器，这是 trait 抽象的直接收益。
