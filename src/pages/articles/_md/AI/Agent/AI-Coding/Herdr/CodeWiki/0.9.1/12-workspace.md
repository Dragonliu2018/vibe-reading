---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "工作区与布局"
date: "2026-09-17T10:57:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "BSP 布局", "git worktree"]
description: "herdr 工作区：workspace/tab/pane 三层容器、BSP 布局的值语义树编辑、git worktree 的 agent 并行隔离。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/workspace.rs`（约 1,600 行）+ `src/workspace/` + `src/worktree.rs`（约 900 行）+ `src/layout.rs`（1,167 行）是会话的骨架：**workspace 绑定 git 身份（一个 checkout 一个 workspace），tab 是"同 cwd 的独立 BSP 树"，pane 是 viewport**。为什么三层而不是两层：worktree 隔离粒度要对齐 workspace 而非 tab——多个 agent 并行时各自要有完整的布局（tab 集合）而非共享 tab；反过来同一个仓库里的日常多 tab 又不该被强行拆成多个 workspace。`Workspace` 是 degree-75 god node，`impl Deref for Workspace { type Target = Tab }` 让 `ws.focused_pane()` 这类调用直接作用于活跃 tab，减少一层样板。

## 模块架构

![workspace 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-12-workspace.svg)

容器层级自上而下：`Workspace`（git 身份缓存 + tabs + 公开编号表）→ `Tab`（`TileLayout` 布局树 + `panes: HashMap<PaneId, PaneState>`）→ `TileLayout` 的 `Node`（`Pane(PaneId)` 叶子或 `Split{direction, ratio, first, second}` 递归节点）。右侧是 workspace 层的两个关键机制：公开编号与 git 身份缓存。底部是 worktree 创建链（API 触发的异步流程）。

## 调用链路

**workspace 创建与 pane 归属**：

```
app/creation.rs::create_workspace_with_launch_env
└─ Workspace::new_with_extra_env in workspace.rs
   └─ Tab::new_with_runtime in workspace/tab.rs
      └─ TileLayout::new() 分配 root PaneId（layout.rs 全局 AtomicU32）
         └─ TerminalRuntime::spawn（runtime/terminal 由上层双注册）
split 时：Workspace::split_pane
└─ find_tab_index_for_pane 定位 tab → launch_env_for_new_pane
   注入 {workspace_id}:{tab_id}:{pane_id} 公开身份
   └─ Tab::split_pane_with_runtime：先 layout.split_pane 再 spawn，
      Err 时 layout.close_pane(new_id) 还原且不动 focus 历史
```

**tile 布局计算链**：

```
渲染侧：TileLayout::panes(area) → collect_panes in layout.rs
└─ 沿 BSP 树递归 split_rect 按 ratio（clamp 0.1–0.9）切 Rect
   → Vec<PaneInfo{rect, is_focused}>
鼠标拖拽：splits(area) 生成带 path: Vec<bool> 的 SplitBorder
└─ set_ratio_at(&self.root, &path, ratio) 按路径寻址改比例
键盘 resize：resize_focused → nearest_resize_split 几何匹配最近分界线
```

**worktree 创建链**（API 触发）：

```
Method::WorktreeCreate → start_api_worktree_create in app/api/worktrees/deferred.rs
├─ generated_branch_slug（worktree/brave-river-0000 风格默认分支名）
├─ default_checkout_path = ~/.herdr/worktrees/<repo>/<branch-slug>
├─ 登记 pending_api_worktree_creates 防重入
└─ std::thread::spawn 后台执行
   └─ run_worktree_add_command in worktree.rs（先 local_branch_exists 决定 add -b / checkout）
      → AppEvent::WorktreeAddFinished 回事件循环
         → handle_api_worktree_add_finished：
            ├─ 校验 operation_id 未被取代（stale_worktree_operation）
            ├─ create_workspace_with_options(result.path) 在新 checkout 上开 workspace
            ├─ mark_worktree_membership（is_linked_worktree=true 的 WorktreeSpaceMembership）
            └─ 发 worktree.created 事件
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Workspace::new_with_extra_env` in `workspace.rs` | 创建 | `reserve_workspace_ids` 前移计数器防 id 重用 |
| `TileLayout::panes(area)` in `layout.rs` | 几何计算 | 纯函数，渲染路径零文件系统访问 |
| `set_ratio_at(path, ratio)` in `layout.rs` | 路径寻址改比例 | `Vec<bool>` 地址 |
| `Tab::split_pane_with_runtime` in `tab.rs` | 分屏 | 失败回滚还原布局 |
| `run_worktree_add_command` in `worktree.rs` | git 命令执行 | 强制 `LC_ALL=C` 匹配英文错误分类 |
| `list_existing_worktrees` in `worktree.rs` | porcelain 解析 | UI/API 的 worktree 列表来源 |
| `discover_workspace_git_identity` in `workspace/git/discovery.rs` | git 身份 | 直接读 .git 文件免子进程 |

</details>

## 核心实现

### 公开编号与内部 id 双轨

raw `PaneId` 是全局原子计数，跨 workspace 无意义；用户可见编号（`public_pane_numbers` + `encode_public_number`）**稳定且关闭后不回收**（测试 `pane_public_numbers_are_stable_and_not_reused_after_close`）。为什么：API 目标和快捷键不能指错对象——如果编号复用，"关掉 3 号再开新 pane 变成 3 号"会让脚本化操作打错目标。恢复会话时 `reserve_workspace_ids` 前移计数器防 id 重用是同一原则的另一半。

### 值语义树编辑与失败回滚

`split_at`/`remove_pane` 以值语义重建 `Node`（`std::mem::replace` + placeholder 临时根）；`Tab::split_pane_with_runtime` 先改布局再 spawn，`Err` 时 `layout.close_pane(new_id)` 还原且**不动 focus 历史**（测试 `failed_split_rollback_preserves_focus_history`）。`TileLayout::prev_focus` 只在真实 focus 移动时写入——防止内部树操作污染"关闭后回到来源 pane"语义（`layout.rs` 字段注释）。布局树与进程生命周期解耦但保持一致，这是"spawn 失败必须回滚布局"军规的实现现场。

### git 身份：渲染路径之外

`discover_workspace_git_identity` 在 workspace 创建时算一次（直接读 `.git` 文件/ref，免子进程，供渲染期标签）；`cached_auto_label`/`cached_git_branch`/`cached_git_ahead_behind` 只在 `app/git_refresh.rs` 定期任务里更新——**tab 栏渲染零文件系统访问**（测试 `display_name_reads_cached_identity_without_rechecking_filesystem`）。git 状态走 `GitStatusCacheEntry`/`GitStatusRefreshDemand` 按 cache key 去重批量刷。`worktree.rs` 走另一条腿：`build_worktree_add_new_branch_command` 等只产 `WorktreeCommand`（纯数据），与执行 `run_worktree_command` 分离——命令构造可测，执行时强制 `LC_ALL=C` 以匹配 `is_dirty_worktree_remove_error` 的英文错误分类。

### worktree 删除的防御性

脏 checkout 需显式 `--force`；force 遇 "is not a working tree" 时 `run_worktree_remove_command_with_recovery` 校验残留目录的 `.git` gitdir 确属本 repo 的 `worktrees/` 才 `remove_dir_all`——**绝不误删无关替换目录**。Windows 上删除前须先关 terminal runtime（`app/worktrees.rs::should_shutdown_workspace_terminal_runtimes_for_worktree_remove`，文件占用），失败还要能恢复 pane。关闭带 worktree 组的 primary workspace 需要显式 group intent（0.9.0 起，#2874）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 + Deref 转发 | `Workspace: Deref<Target = Tab>` in `workspace.rs` | 活跃 tab 操作免样板 |
| 命令对象 + 纯函数构造 | `WorktreeCommand` in `worktree.rs` | 构造与执行分离，可测 |
| 路径寻址的不可变树编辑 | `set_ratio_at(path)` in `layout.rs` | 值语义重建 + placeholder 根 |
| 挂起操作表 + 幂等事件 | `pending_api_worktree_creates` in `deferred.rs` | operation_id 核对，过期即拒绝 |
| 缓存 + 需求驱动刷新 | `git_refresh.rs` | 渲染热路径零 IO |

## 模块间交互

`app/state.rs` 持 `workspaces: Vec<Workspace>`；`app/worktrees.rs` 负责 worktree 删除的善后（关 workspace、切回父 workspace）；`app/creation.rs`、`app/api/panes.rs`（`Workspace::from_existing_pane` 移动 pane 建 workspace）是三个创建入口。Workspace 不直接管理 PTY——spawn 出的 `(TerminalState, TerminalRuntime)` 上抛给 App 统一入注册表；pane 身份经 `PaneLaunchEnv::with_identity`（`pane.rs`）写入子进程环境。`Workspace::test_new()` + `Workspace::assert_invariants_for_test()` + `Workspace::test_adversarial_identity_state()` 支撑身份类重构的特征测试（`AGENTS.md` 指定的三个测试入口之一）。

## 扩展方式

- **新增布局操作（如整行 swap/重排）**：`layout.rs` 加 `Node` 级纯函数 + `TileLayout` 方法——走 placeholder-root 值语义重建并保持 `prev_focus` 不被污染；需 spawn 则上移到 `Tab::split_pane_with_runtime` 风格的回滚包装
- **给 worktree 增加新操作（如 prune）**：`worktree.rs` 加 `build_*_command` 纯构造 + 错误分类；`deferred.rs` 加 pending 表登记、后台线程发 `AppEvent`，finish handler 里核对 operation_id 后改 workspace 状态
- **改 workspace 状态栏展示**：`workspace/git/status.rs` 快照字段 → `workspace.rs` 的 `cached_*` 缓存结构 → `app/git_refresh.rs` 批量刷新与去重键三处保持一致，勿在渲染路径直读 git

---

## 边缘机制速查

闭卷验证补充：

### ID 与编号

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `generate_workspace_id / PUBLIC_ID_ALPHABET` | `workspace.rs` | NEXT_WORKSPACE_ID 原子计数从 PUBLIC_ID_ALPHABET（排除易混字符）生成 w1/wZ 类可读 id；reserve_workspace_ids 在恢复后前移计数器——新 ID 不与恢复的 ID 冲突
| `register_new_pane_with_number / unregister_pane` | `workspace.rs` | public_pane_numbers 的登记/注销路径；next_public_pane_number / next_public_tab_number 单调递增（编号大的 pane 先关也不回退）——public_pane_numbers_are_stable_and_not_reused_after_close 测试守护

### 显示名与焦点

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `automatic_display_name_for_cwd / cached_identity_cwd` | `workspace.rs` | cwd 等于 cached_identity_cwd 时直接返回 cached_auto_label 不访问文件系统（display_name_reads_cached_identity_without_rechecking_filesystem 测试）；resolved_identity_cwd_from 优先 root pane 的 cwd；设置 custom_name 后自动标签停止更新
| `prev_focus 写入纪律` | `layout.rs` | 只在 set_focus 的真实焦点移动写入；close_focused 后焦点回 prev_focus 存在者，否则按树序邻居；split_pane 和未聚焦的 insert_pane_near 特意不写——防内部树操作污染'关闭后回到来源 pane'语义；Tab.zoomed 在会改变拓扑的操作后强制清除

### git 与 worktree 防御

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `read_ref_oid / RefFileRead` | `workspace/git/discovery.rs` | loose ref 读取区分 Absent（空 ref/悬空符号链接）与 Unavailable（超 MAX_GIT_REF_FILE_BYTES=64KB/权限错误）；Absent 才允许回退 packed-refs，Unavailable 拒绝——防 stale packed OID 复活状态指纹
| `git_status_snapshot_for_cwd_with_demand` | `workspace/git/status.rs` | 非 Git 目录负结果缓存（带 retry_after）；指纹匹配时 ahead_behind 复用旧值；GitStatusRefreshDemand 只请求 branch 时跳过 ahead_behind 计算（git_ahead_behind_between 不调用）；repo_context（文件戳）过期则指纹作废重算
| `run_worktree_remove_command_with_recovery` | `worktree.rs` | force 遇 'is not a working tree' 时三步恢复：校验 leftover 目录 .git gitdir 指向本 repo 的 worktrees/ 管理目录（leftover_worktree_checkout_matches_repo）→ 确属才 remove_dir_all；is_not_working_tree_remove_error 分类错误；run_worktree_command 设 LC_ALL=C 匹配英文错误文本
| `GitSpaceMetadata / discover_workspace_git_identity` | `workspace/git/discovery.rs` | 直接从 .git 文件推断 key/checkout_key/repo_name/is_linked_worktree——渲染期免子进程