---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "索引与工作树"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "index", "unpack-trees", "pathspec"]
description: "解读 Git 暂存区——index 二进制格式与 cache_entry 扁平数组、unpack_trees 统一解包、pathspec 魔术前缀、git status 三态比较。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

Git 有三个"版本状态"同时存在：HEAD（上次提交）、index（暂存区）、worktree（工作区文件）。本模块管理中间的 index 与工作树——index 是 HEAD 与 worktree 之间的暂存中介，工作树是 Git 唯一与文件系统耦合的模块。它独立存在是因为 index 是一个自包含的二进制数据结构，checkout/merge/add/status 都建立在它的读写之上。核心职责边界：负责"index 的格式、checkout 如何把 tree 落到工作区、pathspec 如何匹配路径"，不负责对象存储（tree/blob 来自对象数据库）。

## 模块架构

```
struct repository
   └─ index: struct index_state *   (read-cache-ll.h:166)
        ├─ cache: struct cache_entry **  扁平排序数组（二分查找 O(log n)）
        ├─ cache_tree: struct cache_tree *  预计算树扩展（加速 write-tree）
        ├─ name_hash / dir_hash: struct hashmap  路径→ce 快速查找
        ├─ timestamp: struct cache_time   索引新鲜度校验
        └─ sparse_index: enum sparse_index_mode
```

v2.55.0 把 `struct cache_entry`/`index_state` 从 `cache.h` 迁到 `read-cache-ll.h`，并移除了全局 `the_index`——每个 `struct repository` 持有自己的 `index_state`（`INDEX_STATE_INIT(repo)` 初始化），消除多仓库全局状态冲突。`cache_entry`（`read-cache-ll.h:22`）含 `stat_data`（mtime/size/ino）、`ce_mode`/`ce_flags`、`object_id`（blob SHA）、`name[FLEX_ARRAY]`（路径）。`CE_*` flag 分磁盘位（`CE_STAGEMASK`/`CE_VALID`）与内存位（`CE_UPDATE`/`CE_REMOVE`/`CE_UPTODATE`）。

## 调用链路

**读 index**：`read_index_from()` (`read-cache.c:2349`) → `do_read_index()` (`read-cache.c:2199`) → `xmmap` 映射整个 index → 校验 `cache_header`（签名 `"DIRC"`+版本+条目数，`read-cache-ll.h:13`）→ `load_all_cache_entries()` (`read-cache.c:2053`) 或多线程 `load_cache_entries_threaded()` (`read-cache.c:2112`) 逐条从 mmap 解析 `ondisk_cache_entry` 填充 `cache_entry` → `post_read_index_from()` (`read-cache.c:1949`) 加载 cache-tree 等扩展。

**checkout**（`unpack-trees.c`）：

```
unpack_trees()                unpack-trees.c:1885
→ 用 tree_desc 遍历多棵树
→ unpack_single_entry()      unpack-trees.c:1165   取各树同路径 ce
→ call_unpack_fn()           unpack-trees.c:604    调 options->fn (oneway/twoway/threeway_merge)
→ do_add_entry()             unpack-trees.c:217    写入 internal.result
→ check_updates()            unpack-trees.c:424
  → checkout_entry_ca()      entry.c:481
    → write_entry()          entry.c:283   open(O_CREAT|O_EXCL) + write() 或 symlink()
```

**git status**：`wt_status_collect()` (`wt-status.c:863`) 三步——`wt_status_collect_changes_worktree()` (`:639`) 调 `run_diff_files()` 比较 index vs worktree；`wt_status_collect_changes_index()` (`:666`) 调 `run_diff_index(CACHED)` 比较 HEAD vs index；`wt_status_collect_untracked()` (`:806`) 调 `fill_directory()` 枚举未跟踪文件。两 diff 独立运行，按路径合并到同一个 `wt_status_change_data` (`wt-status.h:58`)，故一文件可同时出现在 "staged" 和 "not staged"。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `do_read_index()` in `read-cache.c:2199` | 读 index | `xmmap` 零拷贝，v4 路径名前缀压缩 |
| `load_cache_entries_threaded()` in `read-cache.c:2112` | 多线程解析 | 大 index 并行加速 |
| `index_name_pos()` in `read-cache-ll.h:345` | 按路径查 ce | 二分 O(log n) |
| `unpack_trees()` in `unpack-trees.c:1885` | 解包树到工作区 | 统一 checkout/merge/switch |
| `checkout_entry_ca()` in `entry.c:481` | 写单个文件 | O_EXCL 防覆盖 |
| `cache_tree_update()` in `cache-tree.c:517` | 写 tree 对象 | 命中缓存短路整棵子树 |
| `cache_tree_invalidate_path()` in `cache-tree.c:159` | 失效受影响路径 | 只标祖先链 invalid |
| `match_pathspec()` in `dir.c:601` | pathspec 匹配 | positive 后 negative(exclude) |
| `wt_status_collect()` in `wt-status.c:863` | git status | 三步比较 HEAD/index/worktree |
| `fill_directory()` in `dir.c` | 枚举未跟踪文件 | 层叠 .gitignore 规则 |

</details>

## 核心实现

### index 二进制格式与扁平数组

`cache_header`（`read-cache-ll.h:13`）签名 `"DIRC"` + 版本 + 条目数。`do_read_index()` 用 `xmmap` 零拷贝映射，`load_cache_entry_block()` 直接从 mmap 内存解析，v4 支持路径名前缀压缩。`cache_entry **cache` 是扁平排序数组——`index_name_pos()` (`read-cache-ll.h:345`) 二分查找 O(log n)，插入/删除 `memmove` 保序，线性遍历做 status/diff 高效。为什么不用树结构？git index 需要高效的全量遍历（status/diff 要扫所有条目）和按路径查找，扁平数组对两者都友好；树结构需逐级遍历路径组件，全量遍历反而不便。

### cache-tree 预计算加速

`struct cache_tree` (`cache-tree.h:16`) 持有 `entry_count` + `oid`，是 index 的树形扩展——把 index 的扁平条目按目录结构组织成树，加速 `write-tree`。`update_one()` (`cache-tree.c:299`) 在 `:336-339` 检查 `entry_count>=0` 且 oid 在 ODB → 直接短路返回，跳过整棵子树的重算。修改文件时 `cache_tree_invalidate_path()` (`cache-tree.c:159`) 只标记受影响路径的祖先链 invalid，精确失效。这让 `git commit` 的 `cache_tree_update()` 从 O(n) 退化到 O(改动量)。

### unpack_trees 统一解包

`unpack_trees()` (`unpack-trees.c:1885`) 用 `struct unpack_trees_options`（`unpack-trees.h:57`）的 `merge_fn_t` 回调（`unpack-trees.h:16`）统一处理 checkout（`oneway_merge`）、switch（`twoway_merge`）、merge（`threeway_merge`）。共用 `unpack_single_entry()` 多树遍历 + `verify_uptodate()`/`verify_absent()` 冲突检测。这是关键设计：checkout/merge/pull 的"把树落到工作区"逻辑高度重叠，统一到一个函数避免三份实现。`check_updates()` (`unpack-trees.c:424`) 负责实际写文件，`checkout_entry_ca()` (`entry.c:481`) → `write_entry()` (`entry.c:283`) 用 `open(O_CREAT|O_EXCL)` 防止覆盖未跟踪文件。

### pathspec 魔术前缀 DSL

`struct pathspec`（`pathspec.h:30`）支持 `:(top)`/`:(icase)`/`:(glob)`/`:(exclude)`/`:(attr)` 魔术前缀，定义在 `pathspec_magic[]` (`pathspec.c:101`)。`match_pathspec()` (`dir.c:601`) → `do_match_pathspec()` (`dir.c:513`) → `match_pathspec_item()` (`dir.c:387`)：prefix 精确比较 → `ps_strncmp` 主体比较 → `git_fnmatch` 通配匹配，返回 `MATCHED_EXACTLY`/`RECURSIVELY`/`FNMATCH`。表驱动 magic 设计使新增前缀只需加一行 + 在 `match_pathspec_item()` 加逻辑。`GUARD_PATHSPEC()` (`pathspec.h:58`) 在不支持某 magic 的函数入口 fail-fast。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 三态模型 | `wt_status_change_data` in `wt-status.h:58` | index 居中作 HEAD 与 worktree 的 diff 中介 |
| 二进制格式 + mmap | `cache_header` in `read-cache-ll.h:13`，`do_read_index` in `read-cache.c:2199` | 零拷贝，大仓库性能可接受 |
| 扁平数组 + 二分 | `cache_entry **cache` in `read-cache-ll.h:167`，`index_name_pos` | 全量遍历与按路径查找都高效 |
| cache-tree 预计算 | `struct cache_tree` in `cache-tree.h:16`，`update_one` in `cache-tree.c:299` | write-tree 从 O(n) 到 O(改动量) |
| 模板方法（merge_fn_t） | `unpack_trees` + `oneway/twoway/threeway_merge` | checkout/merge/switch 共用解包逻辑 |
| pathspec DSL | `pathspec_magic[]` in `pathspec.c:101` | 魔术前缀表驱动，可扩展 |

## 模块间交互

索引模块被 commit（`write_index_as_tree`）、checkout/merge/pull（`unpack_trees`）、add（`add_to_index`）、status/diff/clean（`wt_status_collect`/`match_pathspec`）、ls-files/rm/mv 等广泛调用。它依赖对象数据库读 blob（`odb_read_object()` in `entry.c:340`）、config 读 `core.excludesfile` 加载 ignore 规则、convert（checkout 时 `convert_to_working_tree_ca()` 做 CRLF/smudge）、hashmap（`name_hash` 加速按路径查找 ce）。

## 扩展方式

**扩展 index 格式**：改 `cache_header` (`read-cache-ll.h:13`) 增版本 → `do_read_index()` (`read-cache.c:2199`) `verify_hdr()` 分支 → `do_write_index()` (`read-cache.c:2807`) 序列化 → 加 `CE_*` flag (`read-cache-ll.h:34`) 并更新 `CE_EXTENDED_FLAGS`。对应测试 `t2104-update-index-sparse.sh`。

**新增 pathspec magic**：加 `PATHSPEC_*` 宏 (`pathspec.h:7`) → `pathspec_magic[]` (`pathspec.c:101`) 加条目 → `match_pathspec_item()` (`dir.c:387`) 加匹配逻辑。

**修改 checkout 冲突处理**：改 `enum unpack_trees_error_types` (`unpack-trees.h:19`) → `verify_uptodate()`/`verify_absent()` (`unpack-trees.h:126`) → `setup_unpack_trees_porcelain()` (`unpack-trees.h:42`) 错误消息。
