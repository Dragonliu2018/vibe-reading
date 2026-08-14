---
source:
  type: "源码解读"
  project: "fish-shell"
  url: "https://github.com/fish-shell/fish-shell"
title: "历史记录"
date: "2026-08-14T11:44:53+08:00"
category: ["Tools", "fish-shell", "CodeWiki", "4.8.1"]
tags: ["fish-shell", "Rust", "History", "Persistence", "Mmap"]
description: "fish 的历史记录模块：HistoryItem/HistoryImpl 门面、fish 2.0 YAML 格式、去重与会话隔离、后台 vacuum 压缩、mmap 懒加载。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/fish-shell/CodeWiki/4.8.1/00-overview)

---

## 模块定位

命令历史持久化——去重、时间戳、会话标记、增量追加、后台压缩合并。是交互式 shell 核心体验之一（↑回溯历史）。覆盖 `src/history/`（history.rs 2,548 行/file.rs/yaml_backend.rs/mod.rs），约 3,200 行。god node：`History`（42 度）、`HistoryImpl`（42 度）、`HistoryItem`（25 度）。

## 模块架构

```
   ┌──────────────────────────────────────┐
   │  History (门面)                       │  history.rs:1186
   │  History(Mutex<HistoryImpl>) newtype  │  Arc<History> 共享
   └──────────────┬───────────────────────┘
                  │ imp() 加锁委托
                  ▼
   ┌──────────────────────────────────────┐
   │  HistoryImpl                          │  history.rs:317
   │  new_items (未 vacuum 的新增)          │
   │  file_contents: Option<HistoryFile>   │  (mmap 懒加载)
   │  deleted_items / countdown_to_vacuum  │
   │  thread_pool (后台路径检测)            │
   └──────────────┬───────────────────────┘
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   HistoryFile (file.rs)    yaml_backend.rs
   mmap 读取 + offset 索引   fish 2.0 YAML 编解码
```

## 调用链路

```
[执行命令后] ReaderData::add_to_history()     reader.rs:6478
 ├─ 判断 PersistenceMode:
 │   should_add_to_history()? → Ephemeral (空格开头)
 │   in_private_mode()?       → Memory
 │   otherwise                → Disk
 └─ History::add_pending_with_file_detection()  history.rs:1260
     ├─ 解析 AST 提取路径 (string_could_be_path)
     ├─ HistoryImpl::add (try merge 最后一个 item)
     │   └─ save_unless_disabled()            history.rs:748
     │       └─ save(vacuum)                  history.rs:701
     │           ├─ [无删除+非vacuum] save_internal_via_appending  (增量)
     │           └─ [否则] save_internal_via_rewrite (全量重写)
     └─ [有路径] 后台线程 expand_and_detect_paths → set_valid_file_paths

[↑回溯] HistorySearch::new_with()            history.rs:1512
 └─ go_to_next_match(Backward)
     └─ item_at_index(idx)                   history.rs:1020
         ├─ 先查 new_items (内存快速)
         └─ 再查 file_contents (mmap 懒加载 load_old_if_needed)
```

## 核心实现

### HistoryItem 与三种持久化模式

`HistoryItem`（`history.rs:159`）含 `contents`（命令文本）、`Timestamps`（`first_added`+`last_added`，支持同命令多次合并）、`required_paths`（引用的文件路径，用于 autosuggestion hinting）、`persist_mode`。`PersistenceMode`（`history.rs:79`）三策略：`Disk`（正常写盘）、`Memory`（private mode 不写盘）、`Ephemeral`（空格开头命令，下一条命令添加时 `remove_ephemeral_items` 清除）。

### 去重策略

相同命令只保留最新版本。内存去重：`add` 尝试 `merge` 最后一个 item（`history.rs:402`），相同命令更新时间戳而非新增。`compact_new_items`（`history.rs:484`）从后向前 HashSet 去重。Vacuum 去重：`LruCache`（max 256K）的 key 是命令文本，`add_item` 命中则更新时间戳。

### Session id 与 boundary timestamp

`fish_history` 环境变量决定 session_id 进而决定文件名（`{session_id}_history`），不同 session 历史完全隔离。`HistoryId::Memory(PrivateMode)` 对应 `name=""`，save 跳过写盘实现隐私模式。`boundary_timestamp`（`history.rs:341`）分界线机制：shell 启动时记录当前时间，只读旧于该时间戳的历史项，避免"看到"其他 shell 在本 session 启动后写入的命令——直到 `incorporate_external_changes` 显式合并。

### 后台 vacuum 不阻塞交互

`(1)` 倒计时触发：`countdown_to_vacuum` 初始随机（`history.rs:758`），每条命令递减，到 0 触发 vacuum 重置为 `VACUUM_FREQUENCY=25`，随机起始确保少于 25 条命令也会最终 vacuum。`(2)` 追加优先：多数情况 `save_internal_via_appending`（`history.rs:638`）只追加新项，O(新项数) 极快。`(3)` 全量重写仅在有删除项或达 vacuum 频率时，临时文件 + 原子 rename。`(4)` 后台路径检测在 `thread_pool` 执行。`(5)` mmap 懒加载：`load_old_if_needed`（`history.rs:454`）首次访问才 mmap，`item_at_index` 按需解码单个 item（只存 offset），内存 O(usize/item) 而非 O(full string/item)。

### Private mode

`start_private_mode`（`history.rs:1778`）设 `fish_history=""` + `fish_private_mode=1` → `history_id_from_var` 返回 `HistoryId::Memory(PrivateMode)` → `save` 中 `name.is_empty()` 假装已保存不碰磁盘。一旦进入无法退出（L1777 注释）。

### Pending 机制

命令以 `pending=true` 添加（`add` in `history.rs:394`），`item_at_index` 跳过 pending 项——用户按↑看不到当前正在输入的命令。执行下一条命令时 `reader_push` 调 `resolve_pending`（`history.rs:856`）使其可见。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 门面 | `History(Mutex<HistoryImpl>)` `history.rs:1186` | 隐藏持久化/去重/mmap 细节 |
| 策略 | `PersistenceMode` `history.rs:79` | Disk/Memory/Ephemeral 三种持久化 |
| 懒加载 | `file_contents: Option<HistoryFile>` `history.rs:337` | 首次访问才 mmap |
| 全局注册表 | `HISTORIES: Mutex<BTreeMap<...>>` `history.rs:308` | 按 session id 单例缓存 |

## 模块间交互

被 `reader.rs`（↑回溯 `HistorySearch::new_with` + 执行后 `add_pending` + autosuggestion 后台搜索）、`builtins/history.rs`（search/delete/clear/merge/save/append）、`builtins/set.rs`、`env/impl/var.rs`（`$history` getter）、`env_dispatch.rs`（`fish_history` 变更切会话）、`bin/fish.rs`（`start_private_mode`/`save_all`）调用。依赖 `wutil`（FileId/wstat/wrealpath）、`fs`（`LockedFile`/`rewrite_via_temporary_file`）、`env`（历史文件路径）、`threads`（后台检测）、`ast/expand`（解析路径参数）、`highlight`（`--show-time` 高亮）。

## 扩展方式

- **新增历史字段**：`HistoryItem`（`history.rs:160`）加字段 + `new`/`merge` + `yaml_backend.rs:145` decode + `file.rs` `write_to` + `LruCacheExt::add_item`
- **修改去重策略**：`LruCacheExt::add_item`（`history.rs:138`）+ `compact_new_items`（`history.rs:484`）
- **修改文件格式**：`file.rs` `HistoryFileType`（`history.rs:26`）加变体 + `infer_file_type` + 新 backend 模块
