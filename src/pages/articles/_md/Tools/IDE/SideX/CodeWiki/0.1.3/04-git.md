---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "Git 集成"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "git", "porcelain", "gix"]
description: "SideX Git 集成——实际走系统 git CLI（gix 预留未用），porcelain v2 解析与安全加固"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

Git 集成是 README 列为 "Solid" 的核心特性，支持 status/diff/log/stage/commit/branch/push/pull/fetch/stash/reset/blame/cherry-pick。**关键事实修正**：README/ARCHITECTURE.md 声称用 `gix` crate（纯 Rust Git），但实际代码**全部通过系统 git CLI**（`std::process::Command`）。工作区 `Cargo.toml:86` 声明了 `gix = { version = "0.68", default-features = false }`，但全局搜索 `use gix` / `gix::` 零结果——它是**预留未用的依赖**。`crates/sidex-git/src/lib.rs:3` 明确写道 "All operations shell out to the git CLI via std::process::Command."

## 模块架构

```
src-tauri/src/commands/git.rs   Tauri 命令层（544 行，38+ #[tauri::command]）
        ↓ 直接函数调用
crates/sidex-git/src/
  ├─ cmd.rs          git_command() / run_git()  唯一 CLI 访问点
  ├─ status.rs       porcelain v2 解析
  ├─ diff.rs         双轨：CLI diff + 内存 LCS diff
  ├─ log.rs          log / graph / decorations 解析
  ├─ blame.rs        --porcelain 解析
  ├─ operations.rs   stage/commit/push/pull/branch/stash/merge/rebase/clone/run（~1049 行）
  ├─ repo.rs         find_repo_root / current_branch / remotes
  └─ error.rs        GitError thiserror 枚举
        ↓ std::process::Command
系统 git CLI
```

无状态设计——无 `Repo` wrapper 结构体，每个函数接收 `repo_root: &Path` + 参数，返回 `GitResult<T>`。Tauri 命令层有 DTO 重复（`GitBranch`/`GitRemote` 在 git.rs 与 crate 各定义一份，字段一致但独立）。

## 调用链路

```
前端 invoke('git_status', { path })  in git.contribution.ts:801
  → validate_path(&path)?          in validation.rs:4  拒空/NUL/..遍历
  → sidex_git::current_branch(repo)  → run_git(["rev-parse","--abbrev-ref","HEAD"])
  → sidex_git::status::get_status(repo)
      → run_git(["status","--porcelain=v2","-uall"])
      → 逐行按首字节分类：1 普通 / 2 重命名 / u 冲突 / ? untracked / ! ignored
      → char_to_status 映射 XY 状态码
  → Vec<StatusEntry> 映射为 Vec<GitChange>（FileStatus enum → &str）
  → Ok(GitStatus { branch, changes }) → serde JSON → 前端
```

`git_status` 标记 `pub async fn` 但**无 `.await`**——同步阻塞 `Command::output()` 等 git 子进程，占 tokio worker 线程，多个并发 git 命令可能阻塞 runtime（未用 `spawn_blocking`）。push/pull/fetch 也全部直接调系统 git CLI 处理网络，**不经 sidex-remote crate**。

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `run_git` in `cmd.rs:23` | 执行 git 命令 | Windows 设 `CREATE_NO_WINDOW` 不弹控制台 |
| `get_status` in `status.rs:32` | porcelain v2 解析 | XY 双字符码分 staged/worktree 状态 |
| `compute_hunks` in `diff.rs` | 内存 LCS diff | 不依赖 git，用于未存修改对比 |
| `clone` in `operations.rs:639` | 安全克隆 | URL scheme 白名单 + `--no-checkout` + `core.hooksPath=/dev/null` 禁 hook |
| `run` in `operations.rs:934` | 通用 git 命令 | `validate_git_args` 白名单 + 阻止危险 flag |
| `collect_conflict_paths` | 收集冲突文件 | merge 失败后 `git diff --name-only --diff-filter=U` |

## 核心实现

### 双轨 diff

**CLI diff**（依赖 git）：`get_diff` / `get_line_diffs`（`--unified=0` 解析 `@@ -old +new @@` hunk header，给编辑器 gutter 装饰）。
**内存 diff**（纯 Rust，不依赖 git）：`compute_hunks(original, modified)` 基于 LCS——`lcs_table()` DP 表 O(m*n) → `build_raw_diff()` 回溯 → `find_change_ranges()` 按 context 行数（默认 3）分组 → `group_into_hunks()`。还有 `format_unified_diff` / `apply_hunks` / `revert_hunk`（排除指定 hunk 后应用其余，实现单 hunk 回退）。用于编辑器内存中未存修改 vs 已存版本的差异。

### Porcelain 输出解析

每个模块解析 git 的 machine-readable 格式：status `--porcelain=v2`、blame `--porcelain`、log `--format=%H%n%h%n%an%n%aI%n%s`（`%n` 换行分隔字段）、branches `--format=...` 用 `|` 分隔、stash `--format=%gd%n%gs%n%aI`。graph log 用 `split_graph_prefix()` 从行首分离 graph 字符（`*|/\_`），`parse_decorations()` 解析 ref（`refs/heads/`→Branch, `remotes/`→RemoteBranch, `tag:`→Tag, `HEAD`→Head）。

### 安全三道防线

1. **路径验证**（`validation.rs`）：拒空路径、NUL 字节、`..` 目录遍历。
2. **命令白名单**（`operations.rs:864`）：`ALLOWED_GIT_SUBCOMMANDS` 约 42 个允许子命令，`BLOCKED_GIT_FLAGS` 阻止 `-c`/`--exec`/`--upload-pack`/`--receive-pack`（防 `git config` 注入、hook 执行）。
3. **clone 加固**（`operations.rs:639`）：`reqwest::Url::parse` 验证 scheme 只允许 https/http/ssh/git；拒绝含 `..` 的目标路径；`git clone --no-checkout` + `git -c core.hooksPath=/dev/null checkout` 禁用 hook，防克隆恶意仓库触发 hook。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 薄 CLI 包装器 | `cmd.rs` 唯一 `run_git()` | 所有 CLI 访问集中一处，便于加固与 Windows 适配 |
| 命令模式 | git.rs 38+ `#[tauri::command]` | 每个 git 操作一等公民 Tauri 命令 |
| 无状态函数式 | 无 Repo wrapper | 简单，无生命周期问题；代价是每次重新发现 repo root |
| 策略 | diff.rs 双轨 CLI/内存 | 内存 diff 不依赖 git，用于编辑器实时对比 |

## 模块间交互

`sidex-git` 的 `Cargo.toml` 只有 `tokio/serde/anyhow/thiserror/log`——**无 gix、无 sidex-remote**。git 与 remote 完全独立：push/pull/fetch 全部直接调系统 git CLI 处理网络，即使远程开发场景 git 仍走本地系统 git。`sidex-remote`（russh/bollard）处理 SSH/Docker 连接，与 git 操作无关。Tauri 命令层 `git.rs` 的 `GitBranch`/`GitRemote` 与 crate 层同名结构体独立定义（DTO 重复）。

## 扩展方式

**新增一个 git 子命令（如 `git revert`，实际已在白名单）**：`operations.rs` 加 `pub fn revert(repo, commit) -> GitResult<()> { run_git(repo, &["revert", commit])?; Ok(()) }` → `lib.rs` re-export → `git.rs` 加 `#[tauri::command] pub async fn git_revert` → `lib.rs` `generate_handler!` 注册。

**修改 diff 算法**：CLI diff 改 `diff.rs:27` 的 git 参数（如加 `--word-diff` 字符级）；内存 diff 把 `myers_diff`（标准 O(m*n) DP，trace 占 O((n+m)²) 空间）换成 Myers/Hirschberg 线性空间，`group_into_hunks` 的 context 行数可参数化。

**新增 merge --squash**：`operations.rs::merge()` 加 squash 参数，`MergeResult` 可能扩展字段（squash 后临时 commit hash），`git.rs::git_merge` 命令签名加 `squash: bool`。

> 对应测试：`crates/sidex-git/src/` 各模块 `#[cfg(test)]` 含 porcelain 解析测试。
