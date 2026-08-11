---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "版本遍历与历史"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "revision-walking", "rev_info", "blame"]
description: "解读 Git 历史遍历——rev_info 巨对象、两阶段 prepare→walk、commit 解析与 commit-graph 加速、log 格式化、blame 逐行归因。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

历史遍历是 Git 的只读算法核心——`git log`/`git rev-list`/`git blame`/`git shortlog` 都建立在同一套 commit 遍历引擎之上。本模块负责把"HEAD 之前的提交历史"按各种顺序、各种限制条件遍历出来，并格式化输出。它独立成模块是因为历史遍历是纯算法、无副作用的操作，集中实现可被多个命令复用，且 `rev_info` 这个"巨对象"承载了所有遍历状态，是跨命令共享遍历配置的载体。核心职责边界：负责"按什么顺序遍历哪些 commit、怎么格式化输出"，不负责对象存储（commit 对象来自对象数据库）。

## 模块架构

```
struct rev_info  (revision.h:126, ~100 字段)
   ├─ pending: object 数组        用户指定的起始端点
   ├─ commits / commit_queue      待遍历链表 或 优先队列（互斥）
   ├─ cmdline: rev_cmdline_info   命令行参数解析结果
   ├─ repo: struct repository *   挂载仓库
   ├─ diffopt: struct diff_options diff 配置
   ├─ sort_order: enum rev_sort_order  遍历排序
   └─ 位域标志：topo_order / limited / prune / first_parent_only ...
```

`struct rev_info`（`revision.h:126-397`）是 Git 遍历的中心对象，约 100 个字段覆盖遍历、diff、格式化、过滤、graph 等所有状态。它是"巨对象"——把所有遍历相关状态集中一处，避免函数间传递大量参数，也让 `setup_revisions()` 能统一解析所有选项。

## 调用链路

**历史遍历链路**（`git log` 为例）：

```
repo_init_revisions()      revision.c:1940   用 REV_INFO_INIT 宏初始化 rev_info
→ setup_revisions()        revision.c:3013   解析参数
  → handle_revision_arg()  revision.c:2253   逐个解析 rev (HEAD~3/--all) 填入 pending
→ prepare_revision_walk()  revision.c:3981   两阶段预处理
  · pending → commits 队列（handle_commit）
  · 按 sort_order 排序
  · [limited] limit_list()   revision.c:1440  过滤
  · [topo_order] init_topo_walk()  三队列拓扑遍历
→ traverse_commit_list()   list-objects.c:426  循环
  · while ((commit = get_revision(ctx->revs)))
  · 调 show_commit / show_object 回调
→ get_revision()           revision.c:4667   逐个弹出 commit（处理 skip/max_count）
```

**commit 解析**：`lookup_commit()` (`commit.c:101`) → `repo_parse_commit_internal()` (`commit.c:600`) 先尝试 `parse_commit_in_graph()` (`commit.c:625`) 从 commit-graph 读，否则 `odb_read_object_info_extended()` 读原始 buffer → `parse_commit_buffer()` (`commit.c:516`) 解析 `"tree "` 行 → `lookup_tree`，循环 `"parent "` 行构建父链。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `repo_init_revisions()` in `revision.c:1940` | 初始化 rev_info | 用 `REV_INFO_INIT` 宏 + 挂 repo |
| `setup_revisions()` in `revision.c:3013` | 解析 rev 参数 | 把命令行参数转为内部表示 |
| `handle_revision_arg()` in `revision.c:2253` | 解析单个 rev | 支持 `HEAD~3`/`--all`/区间 |
| `prepare_revision_walk()` in `revision.c:3981` | 两阶段预处理 | 排序 + limit + topo 初始化 |
| `get_revision()` in `revision.c:4667` | 弹出下一个 commit | 处理 skip_count/max_count |
| `traverse_commit_list()` in `list-objects.c:426` | 遍历+回调 | 访问者模式，回调由调用方提供 |
| `parse_commit_in_graph()` in `commit-graph.c:1067` | 从 graph 读 commit | 免解压，O(log n) 二分 |
| `pp_commit_easy()` in `pretty.c:2380` | log 格式化 | 按格式占位符输出 |
| `assign_blame()` in `blame.c:2588` | blame 归因 | prio_queue 按日期逐 commit 推 |

</details>

## 核心实现

### rev_info 巨对象与两阶段遍历

`rev_info` 先在 `setup_revisions()` 阶段把所有参数解析为内部表示（pending 数组 + 标志位），再在 `prepare_revision_walk()` 阶段预处理（排序、limit、simplify），最后 `get_revision()` 阶段逐个产出。这个两阶段设计是关键：拓扑排序（`--topo-order`）、`--ancestry-path` 等需要全局视角的限制无法边遍历边解析参数——必须先收集所有起点和限制条件，再统一规划遍历。`sort_order`（`enum rev_sort_order`，`commit.h:225`）控制排序；`commit_queue` 是 `prio_queue`，`REV_INFO_INIT` 设 `.compare = compare_commits_by_commit_date` (`revision.h:417`) 按日期排序；拓扑排序时 `topo_walk_info` (`revision.c:3704`) 用三个队列（`explore_queue`/`indegree_queue`/`topo_queue`）分别管理探索、入度计算、输出。

### commit 解析与 commit-graph 加速

`parse_commit_in_graph()` (`commit-graph.c:1067`) 从预计算的二进制图直接读 parent 链和 generation number，免解压 commit 对象——这是 `git log` 大仓库性能的关键。`fill_commit_in_graph()` (`commit-graph.c:928`) 从 `chunk_commit_data` 取 tree/parent/date，`fill_commit_graph_info()` (`:879`) 取 generation number。`commit_graph_generation()` 用于可达性剪枝：`can_all_from_reach_with_flag()` (`commit-reach.c:894`) 和 `get_reachable_subset()` (`:1074`) 用 generation number 跳过不可能到达的子树。无 commit-graph 时退化到 `parse_commit_buffer()` (`commit.c:516`) 解析原始对象。

### log 格式化占位符

`pp_commit_easy()` (`pretty.c:2380`) → `pretty_print_commit()` (`:2298`) 调 `repo_logmsg_reencode()` 取消息 buffer → `pp_header()` 输出头 → `pp_remainder()` 输出正文。用户格式（`--pretty=format:"..."`）走 `repo_format_commit_message()` → `format_commit_item()` (`pretty.c:1906`) → `format_commit_one()` (`:1437`) 的大 switch 语句匹配占位符：`%H` commit hash (`:1567`)、`%T` tree、`%P` parent、`%an`/`%ad` author (`:1739`)、`%s` subject (`:1762`)、`%B` body (`:1751`)。新增占位符就是在这个 switch 加一个 case。

### blame 逐行归因

`struct blame_scoreboard` (`blame.h:105-159`) 持有 `final`（起始 commit）、`commits`（`prio_queue` 按日期排序的待处理 commit）、`ent`（已归因的 `blame_entry` 链表）。`assign_blame()` (`blame.c:2588`) 从 `prio_queue` 逐个取 commit → `get_blame_suspects()` 获取待归因 entry → `pass_blame()` (`:2416`) 通过 xdiff 对比 parent blob，把行组逐步"推"给 parent commit（`find_origin`/`find_rename`）。无法转移的 entry 标记 `guilty` 移入 `sb->ent`。`blame_entry` (`blame.h:73`) 表示连续行组——逐行归因需求决定了必须维护 scoreboard 状态而非简单遍历。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 访问者模式 | `traverse_commit_list()` in `list-objects.c:426`，`show_commit_fn` 回调 | 遍历逻辑与对 commit 的处理解耦，多命令复用 |
| 命令模式 + 两阶段 | `rev_info` in `revision.h:126`，`setup_revisions`→`prepare`→`get_revision` | 参数解析与遍历解耦，支持需全局视角的限制 |
| 优先队列 | `commit_queue`/`prio_queue`，`compare_commits_by_commit_date` | 按日期/拓扑序产出 commit |
| 预计算索引复用 | `commit_graph_generation()` + `commit-reach.c` 剪枝 | generation number 跳过不可能到达子树 |

## 模块间交互

本模块被 `builtin/log.c`（`git log`/`git show`）、`builtin/blame.c:1212`、`builtin/rev-list.c:985`、`builtin/pack-objects.c:4135`、`builtin/shortlog.c:426`、`builtin/describe.c:552` 等调用。依赖对象数据库读 commit buffer、refs 读 ref tips（`refs_resolve_ref_unsafe` in `revision.c:340`）、diff 比较 tree（`rev_info.diffopt`）、commit-graph 加速。`rev_info` 通过 `repo_init_revisions(repo)` 第一参数挂载 `the_repository`，但部分代码仍直接用 `the_repository` 全局（如 `list-objects.c:77`），多仓库迁移进行中。

## 扩展方式

**新增 log 格式占位符**（如 `%X`）：修改 `format_commit_one()` 的 switch（`pretty.c:1454`）加 `case 'X'` → 若需额外上下文扩展 `format_commit_context` struct → `Documentation/pretty-formats.txt` 补文档。对应测试 `t4205-log-pretty-formats.sh`。

**修改遍历排序**：`enum rev_sort_order` (`commit.h:225`) 加枚举 → 改 `sort_in_topological_order()` 或 `init_topo_walk()` (`revision.c:3841`) 的队列 compare 函数 → 改 `REV_INFO_INIT` 默认 `.sort_order` (`revision.h:422`)。

**新增可达性查询**：在 `commit-reach.c` 新增函数，复用 `prio_queue` + `commit_graph_generation()` 模式，参照 `get_reachable_subset()` (`commit-reach.c:1020`)。
