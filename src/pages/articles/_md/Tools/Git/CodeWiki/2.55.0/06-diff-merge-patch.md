---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "Diff、合并与补丁"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "diff", "xdiff", "merge-ort", "sequencer"]
description: "解读 Git 内容变换——diff.c 高层编排与 xdiff 底层算法两层、diffcore 流水线、ORT 合并策略、apply 补丁应用、sequencer commit 重放。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

Git 的"内容变换"操作——比较差异、合并分支、应用补丁、重放 commit——构成一组独立的算法密集型子系统。本模块涵盖 diff 引擎（`diff.c` 高层编排 + `xdiff/` 底层算法库两层）、diffcore 流水线（rename/copy/break/pickaxe 等可插拔 stage）、合并策略（ORT/recursive）、补丁应用（`apply.c`）与 commit 重放（`sequencer.c`）。它独立成模块是因为这些内容变换算法本就独立于 git 对象模型——`xdiff/` 甚至原本是独立的 LibXDiff 库，可脱离 git 单独测试。核心职责边界：负责"比较/合并/重放内容"，不负责对象存储与引用（那是对象数据库与引用管理的事）。

## 模块架构

```
diff.c (高层, 7881 行)          xdiff/ (底层, 纯算法)
┌─────────────────────────┐     ┌──────────────────────┐
│ struct diff_options      │     │ xdl_diff()  xdiffi.c  │  入口
│ diff_setup/diff_opt_parse│     │ xdl_do_diff()         │  分派算法
│ diff_addremove/diff_change│→喂→│  ├─ Myers (xdl_recs_cmp)  默认
│ diff_queue (filepair)    │     │  ├─ patience            标志位
│ diffcore_std() ──────────│──→  │  └─ histogram           标志位
│ diff_flush()              │     │ xdl_change_compact     │  压紧
└─────────────────────────┘     │ xdl_emit_diff          │  输出
                                 └──────────────────────┘
        ↓ diffcore 流水线（每个 stage 独立文件，变换 diff_queued_diff）
        skip_stat_unmatch → break → rename → merge_broken → pickaxe → order → rotate
```

分层的关键：`diff.c` 处理 git 语义（tree 遍历、pathspec 过滤、输出格式 patch/raw/stat），`xdiff/` 是纯文本 diff 算法库，只接收 `mmfile_t`（内存缓冲区）输入，不依赖 git object model。接口在 `xdl_diff()` (`xdiff/xdiff.h:130`)。

## 调用链路

**Diff 流水线**：`repo_diff_setup` → `diff_opt_parse` → `diff_setup_done` (`diff.h:606`) → `diff_addremove`/`diff_change` 喂入 filepair → `diffcore_std` (`diff.c:7484`) → `diff_flush` (`diff.h:669`)。`diffcore_std` 内部按序：

```
diffcore_std()  diff.c:7484
→ diffcore_skip_stat_unmatch   stat 不同才继续
→ diffcore_break              diffcore-break.c:131    -B 重写拆分
→ diffcore_rename             diffcore-rename.c:1721 -M/-C rename/copy 检测
→ diffcore_merge_broken       diffcore-break.c:274
→ diffcore_pickaxe            diffcore-pickaxe.c:231 -S 内容搜索
→ diffcore_order              diffcore-order.c:112   -O 排序
→ diffcore_rotate             diffcore-rotate.c:11   --rotate-to
→ diff_resolve_rename_copy
→ diffcore_apply_filter
```

**merge**：`merge_incore_nonrecursive` (`merge-ort.c:5403`) → `merge_start` (`:5028`) → `merge_ort_nonrecursive_internal` (`:5245`) 三阶段——`collect_merge_info` (`:1738` 遍历三棵树收集路径) → `detect_and_process_renames` → `process_entries`（三方合并 + 冲突处理）。

**sequencer**：`sequencer_pick_revisions` (`sequencer.h:165`) → 解析 todo → `pick_commits` (`sequencer.c:5020`) 循环 → `do_pick_commit` (`:2263`) 计算 base/head/next 三棵树 → `merge_incore_nonrecursive` (`:782`) → `merge_switch_to_result` (`:792` 写 index+worktree) → 冲突则停等。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `diffcore_std()` in `diff.c:7484` | diffcore 流水线编排 | 各 stage 独立文件，顺序有全局约束 |
| `diffcore_rename()` in `diffcore-rename.c:1721` | rename/copy 检测 | 相似度评分，O(n²) 可限流 |
| `diffcore_pickaxe()` in `diffcore-pickaxe.c:231` | `-S` 内容搜索 | 正交于其他 stage |
| `xdl_diff()` in `xdiff/xdiffi.c:1088` | 底层 diff 入口 | 纯算法，接收 mmfile_t |
| `xdl_do_diff()` in `xdiff/xdiffi.c:314` | 分派 diff 算法 | Myers/patience/histogram 三选一 |
| `merge_incore_nonrecursive()` in `merge-ort.c:5403` | ORT 合并入口 | 内存中操作，不触碰 worktree/index |
| `apply_all_patches()` in `apply.c` | 补丁应用入口 | 支持 3-way fallback |
| `pick_commits()` in `sequencer.c:5020` | todo 循环执行 | 持久化 todo，支持断点续传 |

</details>

## 核心实现

### diff 两层架构与 diffcore 流水线

`diff.c` 高层处理 git 语义，`xdiff/` 底层是纯算法。`diffcore_std()` (`diff.c:7484`) 是流水线编排器：每个 stage（`diffcore-rename.c`/`diffcore-pickaxe.c`/`diffcore-break.c`/`diffcore-order.c`/`diffcore-rotate.c`）接收并变换全局 `diff_queued_diff` 队列。stage 顺序固定但每步可选（通过 options 标志位控制是否执行）。为什么用流水线？rename 检测（`-M`）、copy 检测（`-C`）、break 重写检测（`-B`）、pickaxe 搜索（`-S`）、文件排序（`-O`）、旋转（`--rotate-to`）等功能正交且可任意组合，流水线让每个 stage 单一职责、可独立开关、可按需插入。`diffcore_std` 的注释 `/* NOTE please keep the following in sync with diff_tree_combined() */` 说明流水线顺序有全局约束。

### xdiff 三种 diff 算法策略

`xdl_do_diff()` (`xdiff/xdiffi.c:314`) 通过 `XDF_DIFF_ALG(xpp->flags)` 检测 `XDF_PATIENCE_DIFF`/`XDF_HISTOGRAM_DIFF` 标志分派算法：Myers 是默认（无标志位走 `xdl_recs_cmp` `:265`，分治 + snake 启发式），patience 走 `xdl_do_patience_diff`，histogram 走 `xdl_do_histogram_diff`。标志位定义在 `xdiff/xdiff.h:44-47`。`xdl_change_compact` (`:793`) 压紧相邻变更块，`xdl_emit_diff` 输出。策略模式让算法可切换而不影响高层。

### ORT 合并策略

ORT（Ostensibly Recursive's Twin，`merge-ort.c`）是 v2.55 的默认合并策略，替代了旧的 `merge-recursive`。关键区别：ORT 在内存中操作 tree 而不写中间 object——`merge_incore_nonrecursive` (`merge-ort.c:5403`) 明确标注 "working tree and index are untouched"（`merge-ort.h:120-127`）。recursive 在处理多个 merge base 时需递归合并并写出中间 commit object 到对象库，性能差。ORT 通过 `collect_merge_info`→`detect_and_process_renames`→`process_entries` 三阶段一次遍历完成，rename 检测结果可缓存复用（`cache_new_pair` at `merge-ort.c:3359`）。`builtin/merge.c:833` 直接调用 `merge_ort_recursive`。`struct merge_options` (`merge-ort.h:49-92`) 的 `priv` 指针指向 `merge_options_internal`（`merge-ort.c:318`，内含 rename 缓存、冲突映射）。

### apply 与 sequencer

`apply.c` 实现 `git apply`/`git am`：`struct apply_state` (`apply.h:29-117`) 持有 `apply`/`cached`/`check`/`threeway`（3-way fallback）、`p_value`（路径前缀剥离层数）、`fn_table`。`struct patch` (`apply.h:124-151`) 含 `old_name`/`new_name`/`fragments` 链表。`sequencer.c` 是 cherry-pick/revert/rebase -i 的状态机：`struct replay_opts` (`sequencer.h:37-85`) 的 `action`（PICK/REVERT/INTERACTIVE_REBASE）+ `strategy` 字段持有策略名。关键设计：`save_todo` (`sequencer.c:3642`) 把 `todo_list->buf` 从 current offset 写入 `rebase-merge/git-rebase-todo`，已完成项追加到 `done` 文件——rebase -i 可能在任意 step 中断（冲突/`--quit`/崩溃），重读 todo 文件恢复游标实现断点续传。`write_basic_state` (`sequencer.h:265`) 持久化 head_name/onto/orig_head 上下文。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 流水线模式 | `diffcore_std()` in `diff.c:7484`，各 `diffcore-*.c` | stage 正交可组合，可插拔 |
| 策略模式（diff 算法） | `xdl_do_diff()` in `xdiff/xdiffi.c:314`，标志位 in `xdiff.h:44` | Myers/patience/histogram 可切换 |
| 策略模式（merge） | `merge_ort_recursive` vs `merge-recursive`，`replay_opts.strategy` | 合并策略可替换 |
| 两层架构 | `diff.c` 高层 + `xdiff/` 底层 | 算法与 git object model 解耦，可独立测试 |
| 持久化续传 | `save_todo`/`done` 文件 in `sequencer.c:3642` | rebase -i 中断后续传 |

## 模块间交互

本模块被 `builtin/diff.c`/`diff-files.c`/`diff-tree.c`/`diff-index.c`（直接）、`builtin/am.c`/`add.c`/`checkout.c`/`describe.c`（间接用 `run_diff_index`/`run_diff_files`）、`builtin/merge.c`/`cherry-pick.c`/`revert.c`/`rebase.c` 调用。依赖对象数据库读 tree/blob（`repo_parse_tree_indirect`/`read_object_file`）、index state（`write_locked_index`）、revision walker（`struct rev_info`/`traverse_commit_list`）、refs（`refs_delete_ref`/`update_head_with_reflog`）。merge 内部复用 diff 的 `diffcore_rename` 做 rename 检测（`merge-ort.c:3429` `detect_regular_renames`），sequencer 复用 merge 做 commit 重放（`sequencer.c:782`）。

## 扩展方式

**新增 diff 算法**：`xdiff/xdiff.h` 加 `XDF_XXX_DIFF` 标志位 → 实现 `xdl_do_xxx_diff()`（参照 `xdl_do_patience_diff`）→ `xdl_do_diff()` (`xdiffi.c:314`) 增分派分支 → `diff.c` 的 `parse_algorithm_value` 注册算法名。

**新增 merge 策略**：实现 `merge_xxx()` 签名参照 `merge_incore_nonrecursive` (`merge-ort.h:123`) → 在策略注册表注册 → 若需 diffcore rename 支持，参照 `merge-ort.c:3429` 集成。

**新增 diffcore stage**：新建 `diffcore-xxx.c` 实现 `void diffcore_xxx(struct diff_options *)`（参照 `diffcore-rotate.c:11`）→ `diffcore.h` 声明 → `diffcore_std` (`diff.c:7484`) 按需位置插入 → `diff_opt_parse` 加命令行选项。

**新增 rebase -i 指令**：`sequencer.h:100` `enum todo_command` 加枚举 → `todo_command_info` 表加元数据 → `pick_commits` (`sequencer.c:5020`) 加 `case`。对应测试 `t6402-merge-rename.sh`、`t3404-rebase-interactive.sh`。
