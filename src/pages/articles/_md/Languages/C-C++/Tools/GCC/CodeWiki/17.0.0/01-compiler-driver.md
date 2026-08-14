---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "编译驱动器"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "spec", "pass 管线", "toplev", "驱动器"]
description: "GCC 驱动器用 spec 语言编排 cc1/as/ld 子进程；编译器主体 main→toplev::main→do_compile 驱动声明式 pass 管线。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

本模块包含两个看似无关但由"决定编译什么"职责统一的部分：**`gcc` 驱动器**（`gcc.cc`）负责把命令行翻译成子进程编排（用 spec 语言拼装 cc1/as/ld 命令并用 `pex` spawn），**编译器主体**（`main.cc`/`toplev.cc`）是 `cc1` 被_spawn 后的入口，负责初始化全局上下文、构建 pass 管理器、按 `passes.def` 调度整个优化与代码生成管线。两者是不同二进制，驱动器通过子进程抽象连接它们。本模块还涵盖 pass 管理器（`passes.cc`/`pass_manager.h`）——它不属于任何单一语言或架构层，是贯穿中后端的调度基础设施。

## 模块架构

```
gcc 驱动器（gcc.cc / gcc.h）
  driver::main ── driver 类有序列方法（set_progname→decode_argv→...→final_actions）
     │
     ├─ spec 注册表 static_specs[]（~40 条：cc1/asm/link/...）
     ├─ spec 函数 static_spec_functions[]（20 个：getenv/if-exists/...）
     └─ spec 解释器 do_spec_1（%{}/%:func/\n→execute）

cc1 编译器主体（main.cc / toplev.cc / toplev.h）
  main ── toplev 类（生命周期封装，libgccjit 可复用）
     └─ toplev::main
         ├─ gcc::context 单例（全局，持有 pass_manager/symtab）
         └─ pass_manager（passes.cc）── 五条 pass 链：
             all_lowering / all_small_ipa / all_regular_ipa / all_late_ipa / all_passes
             每个 opt_pass（gate/execute 虚函数 + next/sub 链）
```

驱动器是 spec DSL 解释器 + pex 子进程抽象；编译器主体是 pass 管理器的容器，`gcc::context` 单例（`toplev.cc:1160`）把两者在 `cc1` 内粘合。`pass_manager` 持有五条 pass 链（`pass_manager.h:47`），`passes.def` 用 X-macro 声明链结构。

## 调用链路

### 驱动器链：`gcc` 命令 → 子进程

```
driver::main (gcc.cc:8401)
  ├─ set_up_specs (gcc.cc:8592)
  │   └─ process_command (gcc.cc:4849) ── 解析开关、建立 switches/infiles 表
  │   └─ read_specs / init_spec (gcc.cc:1906) ── 运行时加载 specs 覆盖内置
  ├─ prepare_infiles (gcc.cc:9100) ── lookup_compiler (gcc.cc:9498) 按后缀匹配
  ├─ do_spec_on_infiles (gcc.cc:9171)
  │   └─ do_spec (gcc.cc:5950) → do_spec_2 (gcc.cc:5977) → do_spec_1 (gcc.cc:6259)
  │       │  spec 解释器：逐字符解析（%{}/%:func/变量展开）
  │       └─ execute (gcc.cc:3323)
  │           ├─ pex_init (gcc.cc:3493) ── PEX_USE_PIPES 创建进程抽象
  │           ├─ pex_run (gcc.cc:3505)  ── spawn cc1/as/ld 子进程
  │           └─ pex_get_status (gcc.cc:3533) ── 等待并取退出码
  └─ maybe_run_linker (gcc.cc:9318) ── LINK_COMMAND_SPEC (gcc.cc:1192)
```

### 编译器主体链：`cc1` → pass 管线

```
main (main.cc:34) ── 仅为让前端能定义不同 main 而独立成文件
  └─ toplev::main (toplev.cc:2303)
     ├─ general_init (toplev.cc:1048) ── 诊断/GGC/line_table
     │   └─ g = new gcc::context() (toplev.cc:1160)
     │   └─ g->set_passes(new pass_manager(g)) (toplev.cc:1167) ── 构建 pass 树
     └─ do_compile (toplev.cc:2150)
         └─ compile_file (toplev.cc:449)
             ├─ lang_hooks.parse_file (toplev.cc:455) ── 前端产出 GENERIC
             └─ symtab->finalize_compilation_unit (toplev.cc:482) ── 触发中后端
                 └─ execute_pass_list(cfun, all_passes) (cgraphunit.cc:1874)
                     └─ execute_pass_list_1 (passes.cc:2748) ── 沿 next/sub 递归
                         └─ execute_one_pass (passes.cc:2569)
                             ├─ pass->gate(cfun) ── 门控
                             ├─ execute_todo(pass->todo_flags_start)
                             └─ pass->execute(cfun) ── ★ 虚函数，执行 pass 逻辑
```

`pass_expand`（`passes.def:459`）是 GIMPLE→RTL 的转折点；此前 pass 操作 GIMPLE（`PROP_gimple`），此后 `pass_rest_of_compilation`（`passes.def:461`）全为 RTL pass。`pass_final`（`passes.def:571`）输出汇编。

## 核心实现

### `class driver`：千行 main 的方法化拆分

`gcc.h:26-28` 注释明确说明："The top-level main within the driver would be ~1000 lines long. This class breaks it up into smaller functions and contains some state shared by them." `driver` 类（`gcc.h:30`）把原本巨型 `main` 拆为 `set_progname` → `expand_at_files` → `decode_argv` → `global_initializations` → `build_multilib_strings` → `set_up_specs` → `handle_unrecognized_options` → `prepare_infiles` → `do_spec_on_infiles` → `maybe_run_linker` → `final_actions` → `get_exit_code`（`gcc.cc:8401` 起的 `driver::main`）。共享状态（`decoded_options`、`explicit_link_files`）作成员而非全局变量。同时 `driver` 被 `libgccjit.so` 复用——`main` 放单独文件（`main.cc:29-31` 注释）正是让 `gcc.o` 能被 libgccjit 链接而不冲突。

### spec 语言：DSL 解释器 + spec 函数

spec 语言（`do_spec_1`，`gcc.cc:6259`）是一个逐字符解释器，用巨型 `switch` 处理：`%b`/`%i`/`%o`/`%S`/`%D` 变量展开（输入/输出文件名、startfile spec 等）；`%{switch:body}` 条件分支（`handle_braces` 检查命令行开关是否存在）；`%:func(args)` spec 函数调用（`handle_spec_function`，`gcc.cc:7237` → `eval_spec_function`，`gcc.cc:7142`）；`'\n'` 命令分隔触发 `execute()`；`'|'` 管道串联。spec 函数注册在 `static_spec_functions[]`（`gcc.cc:1813`），是 `const char *(*func)(int, const char **)` 的 C 函数指针（`gcc.h:66` 的 `struct spec_function`），共 20 个（`getenv`/`if-exists`/`sanitize`/`include` 等）。`eval_spec_function` 保存当前 spec 处理上下文（`gcc.cc:7167`），调用 C 函数，把返回字符串再递归喂回 `do_spec_1`——这样 spec 函数可用 C 实现复杂逻辑而不必在 DSL 里嵌入完整编程语言。

### `opt_pass` / `pass_manager`：声明式 pass 管线

`pass_data`（`tree-pass.h:40`）是 pass 的不可变元数据：`type`（`GIMPLE_PASS`/`RTL_PASS`/`IPA_PASS`/`SIMPLE_IPA_PASS`）、`name`、`tv_id`、`properties_required`/`provided`/`destroyed`（`PROP_ssa`/`PROP_cfg` 等）、`todo_flags_start`/`finish`。`opt_pass`（`tree-pass.h:73`）继承 `pass_data` 并加虚函数 `gate`/`execute`/`clone` 和 `sub`/`next` 链指针。派生类 `gimple_opt_pass`（:116）、`rtl_opt_pass`（:126）、`ipa_opt_pass_d`（:141，含 `generate_summary`/`write_summary`/`read_summary` 等 IPA hook）。

`pass_manager`（`pass_manager.h:47`）持有五条链（`all_lowering_passes`/`all_small_ipa_passes`/`all_regular_ipa_passes`/`all_late_ipa_passes`/`all_passes`）和 `passes_by_id` 索引表。`passes.def` 用 `INSERT_PASSES_AFTER`/`NEXT_PASS`/`PUSH_INSERT_PASSES_WITHIN`/`TERMINATE_PASS_LIST` 宏声明 pass 树——同一文件被 `#include` 三次（`pass_manager.h:129` 声明成员、`passes.cc:1586` 清零、`passes.cc:1602` 建链表），是 C 的 **X-macro** 惯用法。`pass-instances.def` 由 `gen-pass-instances.awk` 从 `passes.def` 自动生成，确保宏展开一致。

`execute_one_pass`（`passes.cc:2569`）是每个 pass 的统一执行点：`gate()` 门控 → `invoke_plugin_callbacks(PLUGIN_OVERRIDE_GATE)`（插件可覆盖门控）→ `pass_init_dump_file` → `timevar_push` → `execute_todo(todo_flags_start)` → `do_per_function(verify_curr_properties)` 校验前置属性 → `pass->execute(cfun)` → `update_properties_after_pass` → `execute_todo(todo_after)`。`execute_pass_list_1`（`passes.cc:2748`）沿 `next` 遍历，对每个 pass 执行后递归 `sub`——责任链模式，`properties_required` 是链上前置约束。

## 设计模式

| 模式 | 位置（文件:方法名） | 为什么用 |
|------|---------------------|----------|
| DSL 解释器（spec） | `do_spec_1` in `gcc.cc:6259` | 目标/发行版不改驱动源码即可定制命令；specs 运行时加载覆盖 |
| 模板方法（opt_pass） | `opt_pass` in `tree-pass.h:73`；`execute_one_pass` in `passes.cc:2569` | 框架统一 `gate`→`execute`→`todo`，子类只 override `execute` |
| 责任链（pass 链） | `execute_pass_list_1` in `passes.cc:2748` | `next`/`sub` 链按 `passes.def` 顺序处理 IR |
| 声明式代码生成 | `passes.def` X-macro；`gen-pass-instances.awk` | pass 顺序即声明顺序，成员/链表/dump 三处自动一致 |
| 进程抽象（pex） | `execute`/`pex_init`/`pex_run` in `gcc.cc:3323-3543` | 跨平台子进程创建、管道连接、状态收集 |

## 模块间交互

驱动器与编译器主体通过**子进程抽象**解耦：`gcc` 二进制不含编译器逻辑，只用 spec + pex spawn `cc1`/`as`/`ld`（`driver::do_spec_on_infiles`，`gcc.cc:9171`）。前端通过 `lang_specific_driver`（`gcc.cc:4937`）可在 spec 处理前修改命令行。编译器主体通过 `lang_hooks` 与前端交互（`lang_hooks.parse_file` 在 `toplev.cc:455` 被调），通过 `pass_manager` 与中后端衔接——`compile_file` 调 `symtab->finalize_compilation_unit`（`toplev.cc:482`）触发 `cgraphunit.cc` 的 `analyze_functions`，后者调 `execute_pass_list(all_lowering_passes)`/`all_small_ipa`/`all_regular_ipa`/`all_passes`（`cgraphunit.cc:701/2244/2302/1874`）。pass 管线与 RTL/代码生成的转折在 `pass_expand`（`passes.def:459`），`properties_destroyed = PROP_ssa | PROP_gimple`（`cfgexpand.cc:7040`）标记 IR 切换。

## 扩展方式

- **新增 spec 选项**：在 `gcc/config/<arch>/*.h` 定义 spec 宏 → 在 `gcc.cc:1745` 的 `static_specs[]` 加 `INIT_STATIC_SPEC("foo", &foo_spec)` → 在引用 spec（如 `cc1_spec`）加 `%{foo:...}` 条件分支。无需改 `do_spec_1`。
- **新增 pass**：见概览「典型修改场景 1」——`passes.def` 加 `NEXT_PASS` + 新 pass 类 override `execute`；或插件用 `pass_manager::register_pass`（`passes.cc:1499`）传 `reference_pass_name` + `PASS_POS_INSERT_AFTER`。
- **新增 spec 函数**：在 `gcc.cc` 实现 `static const char *my_func_spec_function(int, const char **)` → 在 `static_spec_functions[]`（`gcc.cc:1813`）加 `{ "my_func", my_func_spec_function }`。无需改 `do_spec_1`。
