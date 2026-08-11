---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "对象数据库"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "内容寻址", "packfile", "commit-graph"]
description: "解读 Git 内容寻址对象存储——loose/packed 两级、odb_source 后端抽象、commit-graph 与 midx 加速结构、对象名解析。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

对象数据库是 Git 的一切的地基——版本库里所有的源码、目录树、提交、标签最终都变成通过哈希寻址的不可变对象。本模块负责对象的读写、存储格式（loose 单文件 vs pack 打包）、以及让"读一个对象"在不同存储后端间透明切换的抽象层。它独立存在是因为"内容寻址存储"是一个自包含的子系统：引用、索引、遍历、传输都建立在它之上，但它不反向依赖任何业务逻辑。核心职责边界：负责"给定一个 `object_id`，把对象内容取出来或写进去"，不负责对象之间的语义关系（那是 refs/revision 的事）。

## 模块架构

```
struct repository
   └─ objects: struct object_database *   (odb.h:39, 旧名 raw_object_store)
        ├─ sources: struct odb_source * 链表   (odb/source.h:44, vtable)
        │    ┌─ source: FILES (主) ─── files_read_object_info  先 packed 后 loose
        │    │      ├─ packed backend ── find_pack_entry → unpack_entry (zlib+delta)
        │    │      └─ loose  backend ── read_object_info_from_path (zlib)
        │    ├─ source: INMEMORY
        │    └─ alternates (其他 source)
        ├─ commit_graph: struct commit_graph *  预计算加速
        ├─ replace_map: struct oidmap           git-replace 映射
        └─ object_count
```

v2.55.0 的关键演进是把旧的 `raw_object_store` 重构为 `struct object_database` + `struct odb_source` 抽象层（`odb/` 目录）。`odb_source` 是带 12 个函数指针的 vtable，`FILES`/`LOOSE`/`PACKED`/`INMEMORY` 四种实现——这让对象存储可以按 source 粒度组合（主 source 是 `FILES`，它内部又组合 loose + packed 两个子 source），也为未来新增存储后端（如云端冷存储）留了扩展点。

## 调用链路

**读对象链路**（`odb.c` → `odb/source-files.c` → `packfile.c`/`source-loose.c`）：

```
odb_read_object_info_extended()        odb.c:699   加锁 + 算法转换
→ do_oid_object_info_extended()        odb.c:550   先查 inmemory_objects
  → 遍历 odb->sources 链表
    → odb_source_files_read_object_info()  odb/source-files.c:52
        ├─ 先 packed: odb_source_packed_read_object_info()  odb/source-packed.c:37
        │     → find_pack_entry() → packed_object_info() packfile.c:1455
        │     → cache_or_unpack_entry() / unpack_entry() packfile.c:1523  (zlib 解压 + delta 递归)
        └─ 再 loose: odb_source_loose_read_object_info()  odb/source-loose.c:206
              → read_object_info_from_path()  source-loose.c:63  (xmmap + zlib 解压)
  → [未找到且非 QUICK] 二次重试 (SECOND_READ flag)
  → [仍未找到且有 promisor remote] promisor_remote_get_direct()  按需拉取
```

**写对象链路**（`odb.c` → `odb/source-files.c` → `object-file.c`）：

```
odb_write_object_ext()        odb.c:988   委托给 primary source
→ odb_source_files_write_object()  odb/source-files.c:162  委托 loose
  → write_loose_object()      object-file.c:722
    · format_object_header()  生成 "blob 1234\0" 头
    · git_hash_init/update    边写边算 hash
    · git_deflate()           zlib 压缩
    · finalize_object_file()  原子 rename 到 objects/xx/yyyy...
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `odb_read_object_info_extended()` in `odb.c:699` | 读对象元信息 | 加锁 + 跨算法转换，先内存后 source 链表 |
| `do_oid_object_info_extended()` in `odb.c:550` | 遍历 source 链表查找 | 支持 SECOND_READ 二次重试刷新缓存 |
| `odb_source_files_read_object_info()` in `odb/source-files.c:52` | files source 读 | 先 packed 后 loose（packed 命中免 zlib 解压 loose） |
| `unpack_entry()` in `packfile.c:1523` | pack 对象解压 | zlib + delta 递归解包 |
| `odb_write_object_ext()` in `odb.c:988` | 写对象入口 | 委托 primary source |
| `write_loose_object()` in `object-file.c:722` | loose 写入 | 边写边算 hash，原子 rename |
| `hash_object_file()` in `object-file.c:472` | 仅算 hash 不落盘 | 内容寻址凭证计算 |
| `parse_commit_in_graph()` in `commit-graph.c:1067` | 从 commit-graph 读 | 免解压，O(log n) 二分 |
| `get_short_oid()` in `object-name.c:456` | 短前缀对象名解析 | 前缀过滤收集候选判断唯一性 |

</details>

## 核心实现

### 内容寻址与对象写入

Git 的对象 ID 不是随机分配的，而是内容的哈希——这就是"内容寻址"：`hash_object_file()` (`object-file.c:472`) 把 `"<type> <size>\0<content>"` 整体喂给哈希算法（SHA-1 或 SHA-256），结果既是对象的唯一 ID 也是存储路径（`odb_loose_path()` in `object-file.h:45` 把 oid 映射到 `objects/xx/yyyy...` 两级目录）。写入用 `write_loose_object()` (`object-file.c:722`)：生成对象头 → 边写边算 hash → zlib 压缩 → 写临时文件 → `finalize_object_file()` 原子 rename。原子 rename 保证读者永远只看到完整或不存在两种状态，不会读到半写对象。`struct object` (`object.h:159`) 用 3 bit 的 `type` 字段编码 `OBJ_COMMIT/TREE/BLOB/TAG`，是所有解析后对象的基类。

### odb_source 后端抽象

`struct odb_source` (`odb/source.h:44`) 定义 12 个函数指针（`read_object_info`/`write_object`/`for_each_object` 等），是对象存储的后端契约。主 source 是 `FILES` 类型，由 `odb_source_files` 组合：读时 `odb_source_files_read_object_info()` (`odb/source-files.c:52`) 先查 packed、未命中再查 loose——packed 命中可避免为 loose 单独 zlib 解压；写时委托给 loose backend。`sources` 是链表，`odb_prepare_alternates()` 惰性加载 `objects/info/alternates`，让一个仓库的对象可来自多个 object store（这是 submodules 与共享对象库的基础）。对象存储的 `inmemory_objects` source 支持进程内临时对象，不必落盘即可被引用。`object_database` (`odb.h:39`) 还持有 `commit_graph`（加速结构）和 `replace_map`（`git-replace` 映射），挂载在 `the_repository->objects`。

### commit-graph 加速结构

遍历历史需要读大量 commit 对象，而每个 commit 对象都要 zlib 解压再 parse parent list——`git log` 在大仓库极慢。`commit-graph` 用预计算的 mmap 二进制格式解决：`struct commit_graph` (`commit-graph.h:84`) 持有各 chunk 指针（`chunk_oid_fanout` 256 桶 + `chunk_commit_data` + `chunk_generation_data` + bloom filter 等）。`parse_commit_in_graph()` (`commit-graph.c:1067`) → `find_commit_pos_in_graph()` (`:1000`) 先查 `commit_graph_position()` slab 缓存，再 `bsearch_graph()` (`:834`) 二分查找，命中则 `fill_commit_in_graph()` (`:928`) 直接从内存读 tree/parent/date，无需 I/O。`fill_commit_graph_info()` (`:879`) 取 generation number——它用于 `commit-reach.c` 的可达性剪枝（`can_all_from_reach_with_flag()` at `commit-reach.c:894`），跳过不可能到达的子树。commit-graph 支持 chain（`base_graph` 指针）做增量更新。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 内容寻址 | `hash_object_file()` in `object-file.c:472` | 哈希即地址，对象不可变可去重 |
| 后端抽象（vtable） | `struct odb_source` in `odb/source.h:44` | loose/packed/inmemory 可组合，未来可加冷存储 |
| 多源链表 + alternates | `object_database.sources` in `odb.h:39` | 跨仓库共享对象，submodule 基础 |
| 缓存层（预计算索引） | `commit_graph` + `commit_graph_data_slab` in `commit-graph.c:108` | 免解压遍历，generation number 加速可达性 |
| 算法无关化 | `struct git_hash_algo` + `object_id.algo` | sha1_file→object-file 重命名，SHA-256 迁移铺路 |

## 模块间交互

对象数据库是 Git 的**枢纽模块**——被几乎所有上层模块依赖：refs 读 commit 验证 ref 目标（`parse_object`）、revision 遍历读 commit 并用 generation number 排序、index/checkout 写 tree 读 blob、transport 判断 `odb_has_object` 决定是否需要 fetch。它只依赖底层基础设施：哈希算法（`struct git_hash_algo`，SHA-1/SHA-256 函数指针表）、zlib（`git_zstream`/`git_deflate`/`git_inflate`）、trace2（读写 trace 点）、promisor remote（partial clone 按需拉取，`odb.c:601`）。`the_repository->objects` 是全局访问入口。

## 扩展方式

**新增对象类型**（如 type 5）：`object.h:98` `enum object_type` 加值 → `object.c` 的 `type_name()`/`type_from_string_gently()` 加映射 → `object-file.c:327` `write_object_file_prepare` 头格式适配 → `packfile.c:1523` `unpack_entry` 的 type switch 加分支。

**切换 SHA-256**（`repo_set_hash_algo` in `repository.h:248`）：核心无需改（`struct object_id` 已有 `algo` 字段）；`odb.c:619` `oid_object_info_convert()` 处理跨算法转换；`loose.c:9` 维护 SHA-1↔SHA-256 映射；需更新 pack format v2 支持 32 字节 oid。对应测试 `t0013-sha1-repository.sh`。

**新增 pack 加速结构**（类似 commit-graph）：仿 `commit-graph.c` 的 mmap + chunk 模式新建 `xxx-graph.c/.h` → `odb.h:76` 在 `struct object_database` 加指针字段 → 新增 write 命令（仿 `write_commit_graph` in `commit-graph.h:178`）。
