---
source:
  type: "源码解读"
  project: "fish-shell"
  url: "https://github.com/fish-shell/fish-shell"
title: "环境变量"
date: "2026-08-14T11:44:53+08:00"
category: ["Tools", "Shell", "fish-shell", "CodeWiki", "4.8.1"]
tags: ["fish-shell", "Rust", "Environment", "UniversalVariables", "Scope"]
description: "fish 的环境变量模块：Environment trait + EnvStack 五层作用域、env_dispatch 观察者、universal variables 文件+信号跨会话同步。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Shell/fish-shell/CodeWiki/4.8.1/00-overview)

---

## 模块定位

环境变量模块是 shell 运行时状态的核心，被 parser/reader/exec/complete/history 等几乎所有子系统依赖（29 处 `use`，高扇入）。它管理变量存储与作用域、universal variables（跨会话共享）、配置路径定位。god node：`EnvStack`（69 度）、`Environment`（57 度）、`EnvVar`（49 度）。

覆盖 `src/env/`（environment.rs/var.rs/config_paths.rs/mod.rs/impl/）、`src/env_universal_common.rs`、`src/env_dispatch.rs`，约 4,400 行。

## 模块架构

```
   ┌──────────────────────────────────────────┐
   │  Environment trait (只读接口)             │  env/environment.rs:72
   │  getf / get_names / get_pwd_slash        │
   └──────────────────────────────────────────┘
                       ▲ 实现
   ┌───────────────────┴──────────────────────┐
   │  EnvStack (可变环境栈)                    │  env/environment.rs:174
   │  inner: EnvMutex<EnvStackImpl>           │  (全局锁保护)
   │  can_push_pop / dispatches_var_changes   │
   └───────────────┬──────────────────────────┘
                   │ set/remove/push/pop
                   ▼
   ┌──────────────────────────────────────────┐
   │  EnvStackImpl (impl/environment.rs)       │
   │  五层作用域查找:                          │
   │  Electric → Local → Function → Global → Universal │
   │  EnvNode 链表 (VarTable + new_scope + next)│
   └──────────────────────────────────────────┘
                   │ set 触发
                   ▼
   env_dispatch_var_change  →  VarDispatchTable  (observer)
                   │ universal 变更
                   ▼
   EnvUniversal::sync  →  fish_variables 文件 + 跨进程通知
```

## 调用链路

```
EnvStack::set(name, value, mode)           in env/environment.rs:221
 ├─ 规范化 PWD/HOME/PATH 等特殊变量
 ├─ EnvStackImpl::set                       in env/impl/environment.rs:657
 │   ├─ try_set_electric (read-only 拦截)
 │   ├─ 解析 scope (universal/global/local/function)
 │   └─ set_in_node / set_universal
 └─ env_dispatch_var_change                in env_dispatch.rs:187
     ├─ 查 VAR_DISPATCH_TABLE 执行回调
     │   locale 变量 → init_locale
     │   TERM → init_terminal
     │   fish_color_* → schedule_prompt_repaint
     │   fish_complete_path → complete_invalidate_path
     └─ 非 suppress_repaint → prompt 重绘
 [universal]
 ├─ UVARS_LOCALLY_MODIFIED.store(true)
 └─ Parser::sync_uvars_and_fire             in parser.rs:999
     └─ EnvStack::universal_sync            in env/environment.rs:366
         └─ EnvUniversal::sync              in env_universal_common.rs:162
             ├─ rewrite_via_temporary_file (原子写)
             └─ default_notifier().post_notification()  (跨进程)
```

## 核心实现

### Environment trait 与快照隔离

`Environment` trait（`env/environment.rs:72`）只暴露读操作。`EnvDyn`（`environment.rs:133`）= `Box<dyn Environment + Send + Sync>` 类型擦除。`EnvStack::snapshot`（`environment.rs:357`）返回 `EnvDyn`——local 深拷贝、global 共享（`copy_node_chain` in `impl/environment.rs:290`），保证异步执行中读取一致性，且支持测试注入 mock。三个实现：`EnvStack`（完整可变）、`EnvScoped`（快照只读）、`EnvNull`（测试空环境）。

### 五层作用域

`EnvScopedImpl::getf`（`env/impl/environment.rs:394`）查找优先级：**Electric（计算型）→ Local（链表从内到外）→ Function（跳到 new_scope 节点）→ Global → Universal**。底层 `EnvNode`（`impl/environment.rs:172`）是链表，`VarTable` + `new_scope`（是否引入新作用域 shadowing）+ `next`（父作用域）。`push_shadowing` 创建函数 scope（传播已导出变量），`push_nonshadowing` 创建 for/if 块内层 scope。`EnvStackImpl::set`（`impl/environment.rs:657`）的 scope 解析：用户显式指定直接写对应层；未指定按 local→global→universal 查找已有变量就地更新；都不存在时 `resolve_unspecified_scope` 默认写最近 function scope 或 global。

### Universal variables 跨会话同步

文件 + 信号双机制（`env_universal_common.rs:162` `sync`）：(1) `UVARS_LOCALLY_MODIFIED` 为 true 时序列化所有变量到 `fish_variables` 文件，`rewrite_via_temporary_file` 原子写入，读取用 `FileId` 比较检测外部修改避免无谓读取；(2) `default_notifier().post_notification()` 平台通知（macOS notifyd / Linux inotify / BSD kqueue）；(3) input loop 在 `select` 监听 notifier fd（`input/input.rs:783`），fd 可读返回 `UvarNotified` 触发 `Parser::sync_uvars_and_fire(true)` 重新读文件。**为什么文件+信号而非 IPC**：文件天然持久化、可调试、跨版本兼容；信号只通知"有变化"，内容由文件同步避免 IPC 状态不一致。

### env_dispatch 观察者

shell 许多子系统状态由变量驱动。`VarDispatchTable`（`env_dispatch.rs:108`）启动时注册变量名→回调映射：`LANG`→`init_locale`、`TERM`→`init_terminal`、`fish_complete_path`→`complete_invalidate_path`、`fish_color_*`→`schedule_prompt_repaint`、`COLUMNS`/`LINES`→更新终端大小。`env_dispatch_var_change`（`env_dispatch.rs:187`）在每次变量变更后查表执行回调。`VarChangeMilieu` 控制是否 suppress repaint——repainting 期间避免递归触发。

### Electric variables 计算型变量

`ElectricVar`（`env/impl/var.rs:20`）定义计算型变量——不存 VarTable 而由 getter 实时计算。`ELECTRIC_VARIABLES` 数组含 `$FISH_VERSION`、`$PWD`、`$status`、`$pipestatus`、`$umask`（`umask()` 系统调用）、`$history`。`try_set_electric`（`impl/environment.rs:870`）拦截 set：read-only 拒绝，`umask`/`PWD` 特殊处理。

### 五文件 import 循环

graphify 检出 `env/environment.rs → env/var.rs → signal.rs → reader/reader.rs → operation_context.rs → env/environment.rs`。验证：`environment.rs` 用 `var.rs` 的 `EnvMode`/`EnvVar`；`var.rs:2` `use crate::signal::RawSignal`（`Statuses` 含 `kill_signal`）；`signal.rs:3` `use crate::reader::{...}`（信号处理通知 reader）；`reader.rs:7228` `use crate::operation_context::{...}`；`operation_context.rs:2` `use crate::env::{EnvStack, Environment}`。**这是领域耦合非设计缺陷**——shell 的信号、变量、reader、执行上下文本就紧密关联。Rust 以 crate 为编译单元，crate 内循环 `use` 合法。若要解耦可将 `RawSignal` 提到独立基础类型模块。

### 全局锁策略

`ENV_LOCK`（`env/impl/environment.rs:1040`）是粗粒度 `Mutex<()>`，所有 `EnvMutex` 共享。注释（L1036-1039）：细粒度锁不可行因节点可能被多个栈共享，需同时锁住所有节点。性能与正确性的权衡。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| trait 抽象 | `Environment` trait `environment.rs:72` | 快照隔离 + 测试可替换 + 类型擦除 |
| 装饰器/代理 | `EnvStack` 包装 `EnvStackImpl` `environment.rs:174` | 分离并发控制（锁/dispatch）与业务逻辑 |
| 观察者 | `VarDispatchTable` `env_dispatch.rs:108` | 变量变更驱动事件，避免子系统轮询 |
| 单例 | `EnvStack::globals`/`GLOBAL_NODE`/`UVARS` `LazyLock` | 进程级共享状态 |

## 模块间交互

高扇入被依赖：parser/exec/reader/complete/history/builtins/locale/termsize/screen 等几乎所有模块。`fish_history` 变量变更触发 `handle_fish_history_change` 切历史会话（`env_dispatch.rs:233`）。`fish_complete_path` 变更失效补全缓存。依赖 `signal`/`universal_notifier`（跨进程）、`operation_context`、`reader`。上述五文件循环反映与 signal/reader 的领域耦合。

## 扩展方式

- **新增 electric variable**：`env/impl/var.rs` `ELECTRIC_VARIABLES` 加条目 + `electric_values` 模块定义 getter；可写则用 `writable_var` + `try_set_electric`（`impl/environment.rs:870`）加特殊处理
- **修改 universal 同步**：`env_universal_common.rs:162` `sync` 加 socket 增量推送 + 扩展 `UniversalNotifier` trait
- **新增作用域类型**：`env/var.rs` `EnvMode` 加位 + `impl/environment.rs` `EnvScopedImpl` 加字段 + `getf`/`set`/`snapshot` 加分支
