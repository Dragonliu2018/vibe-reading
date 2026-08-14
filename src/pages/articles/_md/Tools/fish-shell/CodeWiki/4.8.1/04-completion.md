---
source:
  type: "源码解读"
  project: "fish-shell"
  url: "https://github.com/fish-shell/fish-shell"
title: "补全引擎"
date: "2026-08-14T11:44:53+08:00"
category: ["Tools", "fish-shell", "CodeWiki", "4.8.1"]
tags: ["fish-shell", "Rust", "Completion", "FuzzyMatch", "Wildcard"]
description: "fish 的补全引擎：CompleteEntryOpt 规则注册表、7 级 StringFuzzyMatch 模糊匹配、双用途 wildcard、懒加载补全脚本。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/fish-shell/CodeWiki/4.8.1/00-overview)

---

## 模块定位

Tab 补全是 fish 的旗舰特性——"just work"无需配置即有命令/文件补全。本模块从命令/参数上下文生成补全候选，做多级模糊匹配与排序，交给 pager 展示。覆盖 `src/complete.rs`（3,421 行）、`src/wildcard.rs`（1,235 行），关联 `crates/wcstringutil/`（`StringFuzzyMatch`）。god node：`Completion`（38 度）、`CompletionReceiver`（36 度）、`Pager`（38 度，跨社区桥梁）。

## 模块架构

```
   用户按 Tab → reader.rs:6901 compute_and_apply_completions
                        │
                        ▼
   ┌─────────────────────────────────────┐
   │  complete()  complete.rs:2350        │
   │  → Completer::new(ctx, flags)         │
   │  → perform_for_commandline_impl       │  complete.rs:638
   │     ├─ 命令位置 → complete_cmd         │  (PATH+functions+builtins)
   │     └─ 参数位置 → walk_wrap_chain     │  complete.rs:1981
   │         └─ complete_param_for_command │  complete.rs:1258
   │             ├─ complete_load (autoload)│
   │             ├─ 查 COMPLETION_MAP 规则  │
   │             ├─ condition_test (缓存)   │
   │             └─ complete_param_expand  │  complete.rs:1573
   │                 └─ wildcard_expand_string  (文件展开)
   └──────────────┬──────────────────────┘
                  ▼
   sort_and_prioritize  complete.rs:518  (保留最佳 rank + 去重 + 排序)
                  │
                  ▼
   唯一补全→插入 / 多补全→Pager.set_completions  pager.rs:664
```

`Completer`（`complete.rs:588`）是一次补全请求的计算主体，持有 `OperationContext`、输出 `CompletionReceiver`、`needs_load`（待 autoload 命令名）与 `condition_cache`（条件脚本结果缓存）。

## 调用链路

```
Reader::compute_and_apply_completions()        reader.rs:6901
 ├─ try_expand_wildcard (token 含通配符先展开)
 └─ complete(cmd, flags, ctx)                  complete.rs:2350
     └─ Completer::perform_for_commandline_impl  complete.rs:638
         ├─ get_process_extent 解析 tokens
         ├─ [命令位置] complete_cmd            complete.rs:1107
         │   ├─ expand_to_receiver(EXECUTABLES_ONLY)  (PATH 搜索)
         │   ├─ expand_to_receiver(DIRECTORIES_ONLY)
         │   ├─ function::get_names → complete_strings
         │   └─ builtin_get_names → complete_strings
         └─ [参数位置] walk_wrap_chain        complete.rs:1981
             └─ complete_param_for_command    complete.rs:1258
                 ├─ complete_load (autoload 规则脚本)
                 ├─ 查 COMPLETION_MAP 匹配规则
                 ├─ condition_test (exec_subshell 求值+缓存)
                 ├─ complete_from_args        complete.rs:1213
                 └─ 选项补全 (-s/-o/-l)
     └─ sort_and_prioritize                   complete.rs:518
         └─ Reader::handle_completions        reader.rs:6993
```

数据类型：`WString`（命令行）→ tokens → `Completion { completion, description, match, flags }` 列表 → `CompletionReceiver` → `Pager` 渲染。

## 核心实现

### 规则引擎与 COMPLETION_MAP

补全规则以 `CompleteEntryOpt`（`complete.rs:369`）存储——option 为空时是命令通用参数。`COMPLETION_MAP`（`complete.rs:399`）是 `BTreeMap<CompletionEntryIndex, CompletionEntry>`，key 为 `(name, is_path)`，区分命令名补全 vs 路径补全。`COMPLETION_TOMBSTONES`（`complete.rs:443`）记录"确认无补全脚本的命令"，避免反复磁盘查找。规则支持**条件守卫**（`conditions` 字段存 shell 脚本，`condition_test` 执行 `exec_subshell` 求值）、**选项类型分派**（`CompleteOptionType` 区分 Short/SingleLong/DoubleLong/ArgsOnly）、**结果模式**（`CompletionMode` 的 `no_files`/`force_files`/`requires_param` 控制后续文件补全）。

### 7 级模糊匹配

`StringFuzzyMatch::try_create`（`crates/wcstringutil/src/lib.rs:216`）按优先级逐级尝试：Exact→Prefix→icase Exact→icase Prefix→Substr→icase Substr→Subseq。`rank()`（`lib.rs:306`）计算 `(from_separator << 4) + (effective_type << 2) + effective_case`。关键设计：**Exact ≈ Prefix** 同级（对用户体验一致）、**Smart ≈ Sensitive** 同级（鼓励小写输入）、**from_separator 惩罚**（`=`/`:` 后的匹配降级）。`sort_and_prioritize`（`complete.rs:518`）只保留最佳 rank——存在精确/前缀匹配时子串/子序列匹配就不出现。Smart case（`get_case_fold` in `lib.rs:224`）：输入含大写则全不敏感，否则小写可匹配大写但大写必须精确。

### "just work" 无需配置

fish 不需用户写配置即有命令/文件补全，因为：(1) `complete_cmd`（`complete.rs:1107`）默认搜 PATH 所有可执行文件 + 列 functions/builtins；(2) `complete_param_expand`（`complete.rs:1573`）无匹配规则时 `do_file` 默认 true 自动展开文件；(3) 数百常用命令补全脚本通过 `rust_embed` 编译进二进制（`autoload.rs:40`），无需安装额外文件；(4) 内置 `$VAR`/`~user` 补全（`try_complete_variable`/`try_complete_user`）。设计哲学：合理默认值 + 内置规则库，补全对用户透明。

### 双用途 wildcard

`wildcard.rs` 同时服务补全（`ExpandFlags::FOR_COMPLETIONS` 设置，接受不完整前缀匹配、生成描述、支持模糊）与执行期展开（未设置，要求完全匹配、不做模糊）。`wildcard_complete`（`wildcard.rs:256`）内部委托 `wildcard_complete_internal`（`wildcard.rs:88`）递归处理 `*`（遍历子串位置，有 prefix 时提前终止——"最小匹配"原则）与 `**`（补全时直接 NoMatch——historic behavior，不支持 Tab 补全 `**`）。隐藏文件：通配符不以 `.` 开头时不匹配 `.` 开头文件（除非 `ALLOW_NONLITERAL_LEADING_DOT`）。`wildcard_match`（`wildcard.rs:1109`）是纯匹配测试（不做 I/O），近线性算法（参考 research.swtch.com/glob），用于命令名匹配 COMPLETION_MAP key。

### Autoload 懒加载

`complete_load`（`complete.rs:2453`）先调 `function::load`（可能定义 `--wraps`），再通过 `COMPLETION_AUTOLOADER` 查找并 source 补全脚本。`Autoload`（`autoload.rs`）惰性加载核心是 `resolve_command_impl`（`autoload.rs:203`）——它返回四种 `AutoloadResult`：命令正在被 autoload 时返回 `Pending`（防递归，`current_autoloading` HashSet 记录在途命令）、文件已加载且 `file_id` 未更改时返回 `Cached`、找到新文件返回 `Path`、无文件返回 `NotFound`。找到路径后 `perform_autoload`（`autoload.rs:125`）执行脚本：`OnDisk` 路径用 `parser.eval("source path")`，`Embedded` 嵌入资源用 `parser.eval_file_wstr`（编译期 `#[derive(RustEmbed)]` 嵌入 `share/`）。`AutoloadFileCache` 维护 hits/misses（LRU 1024，15 秒新鲜期 `AUTOLOAD_STALENESS_INTERVALL`）；锁只在 resolve 时持有，source 时不持锁（避免死锁，因 eval fish 脚本不能持锁）。**为什么惰性**：fish 有数百补全脚本，全 source 会导致启动延迟数秒。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 规则引擎 | `CompleteEntryOpt`/`COMPLETION_MAP` `complete.rs:399` | 声明式补全规则，运行时查表 |
| 策略 | `perform_for_commandline_impl` 按光标位置分派 | 命令/参数/变量/用户名不同补全源 |
| 备忘录 | `condition_test` + `condition_cache` `complete.rs:862` | 同一请求内条件脚本只求值一次 |
| 递归链 | `walk_wrap_chain` `complete.rs:1981` | `--wraps` 机制，`visited` 防环，深度 24 |

## 模块间交互

上游：被 `reader.rs` 的 `compute_and_apply_completions`（`reader.rs:6901`）调用。下游：`wildcard.rs`（文件匹配）、`expand.rs`（`expand_to_receiver`）、`autoload.rs`（source `share/completions/*.fish`）、`function.rs`（函数名补全 + 加载）、`builtins/`（`builtin_get_names`/`builtin_exists`）、`env.rs`（PATH/变量查询）、`pager.rs`（结果展示）、`exec.rs`（`exec_subshell` 条件求值）。`needs_load` 机制：无 parser 时（autosuggestion 后台线程）收集命令名返回 reader 异步触发加载。

## 扩展方式

- **新增补全规则（推荐脚本）**：`share/completions/mytool.fish` 写 `complete -c mytool -s f -l format -a "json yaml" -d "format"`，autoload 自动加载调 `complete_add`（`complete.rs:2277`）注册到 `COMPLETION_MAP`，无需改 Rust
- **修改模糊匹配优先级**：`crates/wcstringutil/src/lib.rs:306` `rank()` 位运算，或 `try_create`（`lib.rs:216`）尝试顺序，或 `get_case_fold`（`lib.rs:224`）
- **修改通配符行为**：`wildcard.rs:1077` `wildcard_expand_string`（`**` 补全）/`wildcard.rs:99` leading dot 策略/`WildCardExpander::expand`（`wildcard.rs:509`）目录遍历
