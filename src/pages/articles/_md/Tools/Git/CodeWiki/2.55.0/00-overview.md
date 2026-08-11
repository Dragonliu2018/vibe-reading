---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "Overview"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "版本控制", "内容寻址存储", "分布式"]
description: "git 是 Linus Torvalds 创作的分布式版本控制系统。本文从分层架构、运行时行为到七大核心模块，全面解读 Git v2.55.0 的 C 语言内部实现。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v2.55.0 · **协议** GPLv2 · **语言** C (C99) · **代码量** ~368,000 行 · **仓库** [GitHub](https://github.com/git/git)

---

## 总览

### 项目简介

Git 是一个快速、可扩展、分布式的版本控制系统，由 Linus Torvalds 于 2005 年为管理 Linux 内核开发而创造，后交由 Junio C Hamano 长期维护。它的核心思想极其纯粹：**把一切内容（源码、目录树、提交、标签）都变成通过哈希寻址的对象**，再用引用（refs）和索引（index）在对象之上搭出版本历史与工作区。这一设计让 Git 既是"穷人数据库"又是内容分发系统——对象不可变、引用可变、索引是工作区与版本库之间的暂存层。

Git 的价值在于它把"版本控制"这件事拆成了可组合的底层原语（plumbing）与面向用户的高层命令（porcelain），同一套对象模型既支撑 `git commit` 这样的日常操作，也支撑 `git cat-file`、`git hash-object` 这样的直接操作。

**项目边界**：负责版本控制核心引擎——对象存储、引用管理、索引/工作树、diff/merge、传输协议与内置命令；不包含图形客户端（`git-gui`/`gitk` 在独立子目录单独维护）、托管平台功能（pull request / CI 属于 GitHub/GitLab 等平台）、 nor the server-side hosting workflow（`git daemon` 与 smart HTTP 后端只是传输层，不提供权限/协作）。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|----------|------|
| 内容寻址对象存储 | `object-file.c` · `odb/` · `packfile.c` | loose + packed 两级存储，哈希即地址 |
| 引用管理（多后端） | `refs.c` · `refs/files-backend.c` · `reftable/` | files / packed / reftable 三后端可切换 |
| 暂存区与工作树 | `read-cache.c` · `unpack-trees.c` · `dir.c` | index 二进制格式 + checkout/merge 统一解包 |
| 历史遍历 | `revision.c` · `commit.c` · `pretty.c` | 两阶段 prepare→walk + 访问者回调 |
| Diff 与合并 | `diff.c` · `xdiff/` · `merge-ort.c` · `sequencer.c` | diffcore 流水线 + 三 diff 算法 + ORT 合并 |
| 传输协议 | `transport.c` · `fetch-pack.c` · `send-pack.c` · `pkt-line.c` | git/ssh/http 多后端 + protocol v2 |
| 配置系统 | `config.c` · `environment.c` | 多级配置文件 + 环境变量覆盖 |
| 子进程执行 | `run-command.c` | `struct child_process` 统一起子进程 |
| 加速结构 | `commit-graph.c` · `midx.c` · `pack-bitmap.c` | 预计算二进制索引避免解压 |
| 追踪 | `trace2/` | 结构化性能与事件追踪 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C99 | 核心 | 实现语言，跨平台（POSIX + Windows compat 层） |
| zlib | 核心 | loose 对象与 pack delta 的压缩/解压 |
| SHA-1 / SHA-256 | 核心 | 对象内容寻址哈希（`struct git_hash_algo` 函数指针表抽象） |
| pthread | 可选 | `preload_index` 多线程 lstat 刷新 |
| libcurl | 可选 | HTTP/HTTPS 传输（`http.c`） |
| OpenSSL / Secure Transport | 可选 | TLS 加密 |
| gettext | 可选 | 消息国际化（`po/`） |
| Tcl/Tk | 可选 | `git-gui` / `gitk` 图形前端（独立子项目） |

### 版本历史

Git 的版本号 `v2.55.0` 遵循 `v<major>.<minor>.<patch>` 语义，主版本号自 2.0 起长期稳定，小版本号持续演进。v2.55.0 这一时间点的关键演进脉络：(1) **对象存储算法无关化**——`sha1_file.c` 重命名为 `object-file.c`，并进一步将 `raw_object_store` 重构为 `struct object_database` + `odb_source` 抽象层（`odb/`），为 SHA-256 迁移铺路；(2) **引用后端演进**——引入 reftable 二进制后端（`reftable/`）替代散碎 loose ref 文件，Git 3.0（`WITH_BREAKING_CHANGES`）计划默认切 reftable；(3) **合并策略换代**——默认 merge 策略从 `merge-recursive` 切换到 ORT（Ostensibly Recursive's Twin，`merge-ort.c`），在内存中操作 tree 避免写出中间对象；(4) **协议升级**——引入 protocol v2，capability 协商独立化并支持部分 fetch。

---

## 快速上手

```bash title="从源码构建并验证"
# 构建（依赖 zlib、libcurl、msgfmt 等；make 自动探测）
make prefix=/usr/local all
make prefix=/usr/local install

# 端到端验证：初始化仓库并提交一个对象
git init demo && cd demo
echo "hello git" > README
git add README && git commit -m "first commit"

# 看到内容寻址存储的真实样子
git cat-file -p HEAD^{tree}      # 打印 tree 对象内容
git cat-file -t HEAD            # 输出 commit
git rev-parse HEAD               # 输出完整 SHA
```

预期：`git cat-file -t HEAD` 输出 `commit`，`git rev-parse HEAD` 输出一个 40 字符（SHA-1）或 64 字符（SHA-256）的哈希——这就是对象数据库的内容寻址凭证。

---

## 架构设计解析

### 系统架构

Git 的架构思想是**以不可变的内容寻址对象为地基，用可变引用和暂存索引在其上组织版本历史**。整套系统按职责分层：上层只依赖下层的接口契约，下层不反向感知上层。这样 `git log` 的遍历逻辑可以独立于对象存储的 loose/packed 实现细节，transport 层可以替换 SSH/HTTP 而不影响 fetch 语义。

![Git v2.55.0 分层架构](/vibe-reading/images/articles/git-2.55.0/architecture.svg)

系统自上而下分为四层：命令与进程层负责进程启动、命令表分发与仓库发现；操作层在数据模型上执行版本控制操作（遍历历史、比较合并、传输）；核心数据层承载三大持久化数据结构——对象数据库、引用、索引/工作树；基础设施层提供配置、子进程、哈希、压缩、追踪等可替换的横切能力。层间依赖单向向下，但所有层都通过全局 `the_repository` 枢纽访问核心数据，这是 Git 最显著的架构特征——单仓库进程模型，多仓库支持仍在渐进迁移中。

| 架构层 | 包含目录/文件 | 层职责（为什么这层存在） |
|--------|-------------|------------------------|
| 命令与进程层 | `git.c` · `common-main.c` · `setup.c` · `parse-options.c` · `builtin/` | 隔离进程启动与用户命令，保护核心逻辑不感知 CLI 形态 |
| 操作层 | `revision.c` · `diff.c` · `xdiff/` · `merge-ort.c` · `sequencer.c` · `transport.c` | 在数据模型上编排版本控制用例，不持有持久状态 |
| 核心数据层 | `object-file.c` · `odb/` · `packfile.c` · `refs.c` · `reftable/` · `read-cache.c` · `unpack-trees.c` | 承载对象/引用/索引三大不可变+可变数据结构 |
| 基础设施层 | `config.c` · `run-command.c` · `sha256/` · `trace2/` · `compat/` | 适配外部资源与平台差异，可替换 |

### 设计模式

| 模式 | 位置 | 说明 |
|------|------|------|
| 表驱动命令分发 | `commands[]` in `git.c:529`，`get_builtin()` in `git.c:687` | 静态数组注册命令，新增命令只加一行 |
| 内容寻址 | `hash_object_file()` in `object-file.c:472` | 内容哈希即存储地址，对象不可变 |
| 后端策略（对象 DB） | `struct odb_source` vtable in `odb/source.h:44` | loose/packed/files/inmemory 可插拔 |
| 后端策略（引用） | `struct ref_storage_be` in `refs/refs-internal.h:567` | files/packed/reftable 三后端 |
| 后端策略（传输） | `struct transport_vtable` in `transport-internal.h:11` | local/ssh/http/bundle/helper 可插拔 |
| 事务模式 | `ref_transaction` in `refs/refs-internal.h:232` | 批量原子提交 refs，OPEN→PREPARED→CLOSED |
| 流水线模式 | `diffcore_std()` in `diff.c:7484` | diffcore 各 stage 正交可组合 |
| 算法策略 | `xdl_do_diff()` in `xdiff/xdiffi.c:314` | Myers/patience/histogram 三 diff 算法 |
| 访问者模式 | `traverse_commit_list()` in `list-objects.c:426` | 遍历用回调访问每个 commit |
| 两阶段遍历 | `prepare_revision_walk()` / `get_revision()` in `revision.c` | 参数解析与遍历解耦 |
| 全局单例 | `the_repository` in `repository.c:32` | 全局仓库枢纽贯穿各层 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `struct object_id` | 对象哈希标识（SHA-1/256） | 值/指针传递 | 标识所有对象与引用目标 |
| `struct object` | 解析后对象的基类 | 进程内池化 | 派生 commit/tree/blob/tag |
| `struct commit` | 提交对象 | 解析缓存 | `parents` 链 + `maybe_tree` |
| `struct index_state` | 暂存区 | 进程内 | 持有 `cache_entry[]` + cache-tree |
| `struct ref_store` | 引用存储后端 | 仓库级 | `the_repository->refs_private` |
| `struct rev_info` | 历史遍历状态 | 命令级 | `pending` + `commits` 队列 |
| `struct transport` | 传输连接 | 命令级 | `remote` + vtable |
| `struct child_process` | 子进程描述符 | 命令级 | args/env + stdio 管道 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|-----------|---------|--------|---------|
| `struct odb_source` | `odb/source.h:44` | loose/packed/files/inmemory | `odb` source 链表 |
| `struct ref_storage_be` | `refs/refs-internal.h:567` | files/packed/reftable | `refs_backends[]` in `refs.c:38` |
| `struct transport_vtable` | `transport-internal.h:11` | builtin_smart/bundle/helper | `transport_get()` 按 URL scheme |
| `merge_fn_t` | `unpack-trees.h:16` | oneway/twoway/threeway | `unpack_trees_options.fn` |
| `struct fetch_negotiator` | `fetch-negotiator.h:20` | consecutive/skipping/noop | `fetch_negotiator_init()` switch |

---

## 代码目录

```
git/
├── git.c                  # 命令分发主入口（commands[] 表 + handle_builtin）
├── common-main.c          # main() → init_git() → cmd_main()
├── common-init.c          # 进程级初始化（locale/gettext/trace2/repository）
├── setup.c                # 仓库发现（setup_git_directory / is_git_directory）
├── repository.c/.h        # struct repository + the_repository 全局单例
├── parse-options.c/.h     # 声明式选项解析框架
├── config.c               # 多级配置解析
├── run-command.c/.h       # struct child_process 子进程 API
│
├── object*.c              # 对象模型与内容寻址（object-file.c 即旧 sha1_file.c）
├── odb/                   # 对象存储抽象层（odb_source vtable）
├── packfile.c             # pack 读取
├── pack-objects.c         # pack 写入（打包）
├── commit-graph.c         # commit-graph 加速结构
├── midx.c / midx-write.c  # multi-pack-index
│
├── refs.c                 # 引用 API + 事务
├── refs/                  # 引用后端（files-backend/packed-backend/reftable-backend/iterator）
├── reftable/             # reftable 二进制格式实现
│
├── read-cache.c           # index 读写（struct index_state）
├── read-cache-ll.h        # cache_entry / index_state 定义（v2.55 从 cache.h 迁出）
├── unpack-trees.c         # checkout/merge 统一解包
├── dir.c                  # 目录遍历 + pathspec 匹配
├── wt-status.c            # git status
├── cache-tree.c           # cache-tree 加速 write-tree
│
├── revision.c/.h          # 历史遍历引擎（struct rev_info）
├── commit.c/.h            # struct commit + parse_commit
├── pretty.c               # log 格式化（%H %an %s 占位符）
├── blame.c                # git blame（scoreboard 逐行归因）
├── commit-reach.c         # 可达性与 merge-base
│
├── diff.c                 # diff 引擎高层编排
├── diffcore-*.c           # diffcore 流水线各 stage
├── xdiff/                 # 底层 diff 算法库（Myers/patience/histogram）
├── merge-ort.c            # ORT 合并策略（默认）
├── apply.c                # git apply / am 补丁应用
├── sequencer.c            # cherry-pick/revert/rebase -i 状态机
│
├── transport.c/.h         # 传输抽象
├── fetch-pack.c           # fetch 客户端
├── send-pack.c            # push 客户端
├── connect.c              # 连接建立
├── pkt-line.c             # 4 字节长度前缀帧协议
├── http.c                 # HTTP 传输
├── remote.c/.h            # 远程仓库配置 + refspec
│
├── builtin/               # 130 个内置命令实现（每个命令一个 .c）
├── trace2/                # 结构化追踪
├── compat/                # 平台兼容层（Windows/macOS 等）
├── t/                     # 测试框架（shell 脚本 + test-lib）
├── Documentation/         # 文档源（asciidoc）
└── Makefile               # 构建（探测依赖 + 编译规则）
```

---

## 模块地图

![Git 模块依赖关系](/vibe-reading/images/articles/git-2.55.0/module-dependencies.svg)

Git 的七大模块以**对象数据库为枢纽**——几乎所有操作最终都要读写对象存储。引用管理与索引是另外两个核心数据模块；版本遍历、Diff/合并/补丁、传输与协议是构建在核心数据之上的操作模块；命令分发是进程入口与调度中枢。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 进程与命令分发 | 进程启动、命令表分发、仓库发现、选项解析 | `main()` in `common-main.c` | 它是唯一与进程边界和 CLI 形态耦合的模块，隔离它才能让核心逻辑可被 daemon/http-backend 等复用 | [命令分发](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/01-command-dispatch) |
| 对象数据库 | 内容寻址对象存储（loose + packed + 加速结构） | `odb_read_object_info_extended()` in `odb.c:699` | 对象是不可变、可哈希寻址的地基，引用/索引/遍历都建立在它之上 | [对象数据库](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/02-object-database) |
| 引用管理 | 分支/标签/HEAD 的存储与事务 | `ref_transaction_commit()` in `refs.c:2760` | 引用是对象之上唯一的可变层，独立成模块才能支持多后端与原子事务 | [引用管理](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/03-references) |
| 索引与工作树 | 暂存区、checkout、目录遍历、status | `unpack_trees()` in `unpack-trees.c:1885` | 索引是 HEAD 与工作树之间的暂存中介，工作树是唯一与文件系统耦合的模块 | [索引与工作树](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/04-index-worktree) |
| 版本遍历与历史 | commit 历史遍历、log 格式化、blame | `traverse_commit_list()` in `list-objects.c:426` | 历史遍历是只读的算法密集操作，独立模块才能支持 log/blame/rev-list 等多命令复用 | [版本遍历](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/05-revision-walking) |
| Diff、合并与补丁 | 差异比较、合并、补丁应用、commit 重放 | `diffcore_std()` in `diff.c:7484` | 内容变换是一类独立的算法问题（diff 算法/合并策略），且 xdiff 库本就独立于 git 对象模型 | [Diff/合并/补丁](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/06-diff-merge-patch) |
| 传输与协议 | 网络传输抽象、wire protocol、HTTP smart | `transport_get()` in `transport.c:1177` | 传输是唯一与网络/外部进程耦合的模块，抽象它才能让 fetch/push/clone 不感知协议 | [传输与协议](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/07-transport-protocol) |

---

## 运行时行为

### 启动流程

Git 的启动是一条从进程入口到命令函数的线性装配链。以 `git commit` 为例，从 `main()` 到实际命令函数的调用链如下（每步标注文件与职责）：

```
main(argc, argv)                         common-main.c:4
  → init_git(argv)                       common-init.c:53   进程级初始化
    · sanitize_stdfds / restore_sigpipe
    · git_resolve_executable_dir         定位可执行文件
    · setlocale / git_setup_gettext      国际化
    · initialize_repository(the_repository)  repository.c:65  仓库对象装配
    · setup_environment                   处理 replace refs / lazy fetch env
    · trace2_initialize / trace2_cmd_start  追踪启动
  → cmd_main(argc, argv)                 git.c:918
    · skip_prefix("git-")                处理 dashed 形式 git-commit
    · handle_options()                   git.c:157  解析 --git-dir/-C/-p 等全局 flag
    → handle_builtin(args)               git.c:750
      · get_builtin(cmd)                 git.c:687  线性扫描 commands[]
      · run_builtin(p, argc, argv, repo) git.c:466
        · setup_git_directory(the_repository)  setup.c  RUN_SETUP 触发仓库发现
          · repo_discovery_find_dir       从 cwd 逐级向上找 .git
          · is_git_directory              验证 HEAD/objects/refs 三签名
        · check_pager_config / commit_pager_choice  分页器
        · p->fn(argc, argv, prefix, repo)  即 cmd_commit in builtin/commit.c
```

**对象装配**回答"这个对象是谁 new 出来的"：`the_repository` 全局单例在 `initialize_repository()` (`repository.c:65`) 创建，它内含 `objects`（对象数据库）、`refs_private`（引用存储）、`index`（暂存区）三个子系统的指针，均在仓库发现阶段（`setup_git_directory` → `repo_set_gitdir`）按需懒初始化。配置来自多级文件（system/global/system-config/repo/local）+ 命令行 `--git-dir`/`-c` 覆盖，优先级由 `config.c` 的 `git_config_source` 控制。命令注册是编译期静态表 `commands[]`（`git.c:529`），无运行时注册机制。

### 核心运行流程

下面三条链路覆盖 Git 的核心运行模式：写路径（commit）、读路径（log/遍历）、网络路径（fetch/clone）。

#### 写路径：`git commit`

业务流程：读 index → 刷新文件状态 → 写 tree 对象 → 写 commit 对象 → 原子更新 HEAD 引用。

![git commit 数据流](/vibe-reading/images/articles/git-2.55.0/data-flow.svg)

文字描述：从 `cmd_commit()` (`builtin/commit.c:1698`) 出发，先 `repo_read_index_preload()` 读 index 并用 `preload_index()` (`preload-index.c:106`) 多线程 `lstat` 刷新文件 mtime/size；`prepare_to_commit()` 调 `cache_tree_update()` (`cache-tree.c:517`) 把 index 的目录结构序列化为 tree 对象，经 `odb_write_object_ext()` (`odb.c:988`) 写入对象库（内容寻址、zlib 压缩、原子 rename）；随后 `commit_tree_extended()` (`commit.c:1729`) 组装 commit 对象（tree OID + parents + author/committer + message）再写一次对象库；最后 `update_head_with_reflog()` (`sequencer.c:1259`) 通过 `ref_transaction_begin/update/commit()` (`refs.c`) 原子更新 HEAD 并写 reflog。数据沿 `struct index_state *` → `struct object_id tree_oid` → `struct object_id commit_oid` 流转，全程以 `the_repository` 全局为枢纽。失败时 `rollback_index_files()` 恢复 index；ref 事务失败时 `ref_transaction_abort()` 释放锁回滚。

#### 读路径：`git log` 历史遍历

业务流程：解析 rev 参数 → 预处理排序 → 逐 commit 访问 → 格式化输出。

文字描述：`git log` 经 `repo_init_revisions()` (`revision.c:1940`) 初始化 `struct rev_info`，`setup_revisions()` (`revision.c:3013`) 调 `handle_revision_arg()` 把 `HEAD`/`--all` 等参数解析为 `pending` 数组中的 object。`prepare_revision_walk()` (`revision.c:3981`) 做两阶段预处理：将 pending 转 commit 构建 `commits` 队列，按 `sort_order` 排序，若 `limited` 调 `limit_list()` 过滤，若 `topo_order` 调 `init_topo_walk()` 初始化三队列拓扑遍历。随后 `traverse_commit_list()` (`list-objects.c:426`) 在循环中 `get_revision()` 逐个弹出 commit，调 `show_commit` 回调，由 `pretty.c` 的 `pp_commit_easy()` (`pretty.c:2380`) 按格式占位符（`%H`/`%an`/`%s` 等）输出。commit 解析优先走 `parse_commit_in_graph()` (`commit-graph.c:1067`) 从预计算二进制图直接取 parent 链与 generation number，免解压对象。

#### 网络路径：`git fetch`

业务流程：建立连接 → 协商版本与 capability → 广告 refs → negotiation 找 common → 传输 pack → 写入对象库。

文字描述：`transport_get()` (`transport.c:1177`) 按 URL scheme 选 vtable（git/ssh/file 走 `builtin_smart_vtable`，http 走 helper），`handshake()` 调 `git_connect()` (`connect.c:1410`) 起 ssh/daemon 子进程。`discover_version()` (`connect.c:143`) 协商 protocol v0/v1/v2，v2 走独立 capability 段。`get_remote_refs()` 取远程 ref 广告后，`fetch_pack()` (`fetch-pack.c:2168`) 驱动协商：v0/v1 的 `find_common()` (`fetch-pack.c:350`) 发 `have` 行、收 `ack` 找 common commits；v2 的 `do_fetch_pack_v2()` (`fetch-pack.c:1704`) 走 `FETCH_SEND_REQUEST→PROCESS_ACKS→DONE` 状态机。`fetch_negotiator`（`consecutive`/`skipping`/`noop` 可插拔）决定发哪些 have 以最小化传输。服务端发 pack 流，客户端 `index-pack`/`unpack-objects` 写入对象库，再更新本地 refs。所有通信以 `pkt-line.c` 的 4 字节 hex 长度前缀自定帧。

### 状态流

Git 内部最值得关注的状态机是**引用事务**（ref transaction），它保证多个 ref 更新的原子性：

![ref 事务状态机](/vibe-reading/images/articles/git-2.55.0/state-flow.svg)

`ref_transaction_begin()` 创建事务进入 **OPEN** 态；`ref_transaction_prepare()` (`refs.c:2682`) 对所有 ref 依次加锁、校验 old value，进入 **PREPARED** 态；`transaction_finish()` 后端落盘进入 **CLOSED** 态；任一阶段失败调 `transaction_abort()` (`refs.c:2733`) 释放锁回滚进入 **ABORTED** 态。`reference-transaction` hook 在 preparing/prepared/committed/aborted 四个阶段均可介入（`refs.c:2664`）。状态枚举定义在 `refs/refs-internal.h:209`，后端实现 `struct ref_storage_be` 的 `transaction_prepare_fn`/`transaction_finish_fn`（`refs/refs-internal.h:435`）。

---

## 典型修改场景

#### 场景 1：新增 `git foo` 子命令

- 在 `builtin/foo.c` 实现 `cmd_foo(int argc, const char **argv, const char *prefix, struct repository *repo)`
- 在 `builtin.h` 声明函数
- 在 `git.c:529` 的 `commands[]` 加 `{ "foo", cmd_foo, RUN_SETUP }`（按需选 `RUN_SETUP`/`NEED_WORK_TREE` flag）
- 在 `Makefile` 的 `BUILTIN_OBJS` 加 `builtin/foo.o`

#### 场景 2：新增 diff 算法

- 在 `xdiff/xdiff.h` 加 `XDF_XXX_DIFF` 标志位（参照 `xdiff.h:44`）
- 实现 `xdl_do_xxx_diff()`（参照 `xdl_do_patience_diff`）
- 在 `xdl_do_diff()` (`xdiff/xdiffi.c:314`) 增分派分支
- 在 `diff.c` 的 `parse_algorithm_value`/`diff_opt_parse` 注册算法名

#### 场景 3：切换默认哈希算法为 SHA-256

- 仓库初始化设 `repo_set_hash_algo`（`repository.h:248`）选 SHA-256
- 核心无需改：`struct object_id` 已有 `algo` 字段，`struct git_hash_algo` 函数指针表适配
- `oid_object_info_convert()` (`odb.c:619`) 处理跨算法转换，`loose.c:9` 维护 SHA-1↔SHA-256 映射
- 对应测试：`t0013-sha1-repository.sh`、`t1400-update-ref.sh`

---

## 测试体系

Git 的测试套件位于 `t/` 目录，是 shell 脚本驱动的自研框架（`t/test-lib.sh`），极具特色：

```
t/
├── test-lib.sh           # 测试框架核心（断言、子夹具、trash dir）
├── t0000-basic.sh        # 最基础测试（框架自身）
├── t1xxx/                # 基础功能（init/add/commit/config）
├── t3xxx/                # refs / index / checkout
├── t4xxx/                # diff / apply / merge
├── t5xxx/                # transport / protocol / pack
├── t6xxx/                # revision walking / log / blame
├── t7xxx/                # porcelain（status/branch/merge）
├── t9xxx/                # 工具与导出（cvsserver/svn/fast-import）
└── perf/                 # 性能测试
```

| 代码层 | 测试类型 | 典型文件 |
|--------|----------|---------|
| 对象数据库 | `t1xxx`/`t5xxx` | `t1006-cat-file.sh`、`t5300-pack-object.sh` |
| 引用管理 | `t3xxx` | `t1400-update-ref.sh`、`t3210-ref-includes.sh` |
| 索引/工作树 | `t2xxx`/`t3xxx` | `t2104-update-index-sparse.sh` |
| Diff/合并 | `t4xxx` | `t4013-diff-various.sh`、`t6402-merge-rename.sh` |
| 传输协议 | `t5xxx` | `t5538-push-shallow.sh`、`t5702-protocol-v2.sh` |

Git 测试是极好的"可执行文档"——理解某个对象操作时，优先读对应 `t*.sh` 里的断言用例，它展示了命令在边界条件下的真实行为。

---

## 阅读源码推荐路线

- **第一遍：理解主流程与命令分发**
  `common-main.c` 的 `main()` → `common-init.c` 的 `init_git()` → `git.c` 的 `cmd_main()` / `handle_builtin()` (`git.c:750`) / `run_builtin()` (`git.c:466`) → 任选一个 builtin（如 `builtin/commit.c` 的 `cmd_commit`）看命令函数如何收尾
- **第二遍：理解内容寻址对象模型**
  `object.h` 的 `struct object` → `object-file.c` 的 `hash_object_file()` (`:472`) / `write_loose_object()` (`:722`) → `odb.c` 的 `odb_read_object_info_extended()` (`:699`) 与 `odb/source-files.c:52`（先 packed 后 loose）→ `commit-graph.c` 的 `parse_commit_in_graph()` (`:1067`) 看加速结构
- **第三遍：理解三大可插拔后端**
  `odb/source.h` 的 `struct odb_source` vtable → `refs/refs-internal.h` 的 `struct ref_storage_be` (`:567`) 与三后端注册 `refs.c:38` → `transport-internal.h` 的 `struct transport_vtable` 与 `transport.c:1177` 的 `transport_get()`
- **第四遍：选择重点模块深入**
  版本遍历看 `revision.c` 的 `prepare_revision_walk()` (`:3981`) + `list-objects.c` 的 `traverse_commit_list()`；Diff/合并看 `diff.c` 的 `diffcore_std()` (`:7484`) + `xdiff/xdiffi.c` 的 `xdl_do_diff()` (`:314`)；传输看 `fetch-pack.c:1704` 的 v2 状态机 + `pkt-line.c` 的 `format_packet()` (`:146`)

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| plumbing / porcelain | 底层原语命令（`cat-file`/`hash-object`）/ 面向用户命令（`commit`/`checkout`） |
| loose object | 单个 `.git/objects/xx/yyyy` 文件，zlib 压缩 |
| pack | 多对象打包文件 `.pack` + 索引 `.idx`，支持 delta |
| ref | 引用（分支/标签/HEAD），指向某个 commit 对象 |
| reftable | 二进制引用存储格式，替代散碎 loose ref 文件 |
| index | 暂存区（staging area），`.git/index` 二进制文件 |
| commit-graph | 预计算的 commit 元数据二进制索引，加速遍历 |
| ORT | Ostensibly Recursive's Twin，默认合并策略 |
| pkt-line | wire protocol 的 4 字节长度前缀帧格式 |
| generation number | commit 在拓扑序中的深度，用于可达性剪枝 |

### 参考资料

- Git 官方文档：<https://git-scm.com/doc>（`Documentation/git-*.adoc` 源）
- Pro Git 书：<https://git-scm.com/book/zh/v2>
- Git 内部原理（Git Internals）：<https://git-scm.com/book/zh/v2/ch00/Git-内部原理>
- Git 邮件列表归档：<https://lore.kernel.org/git/>
- 提交规范：`Documentation/SubmittingGuides`
