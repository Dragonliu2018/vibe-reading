---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "代码生成"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "final", "varasm", "DWARF", "代码生成", "retargetability"]
description: "GCC 代码生成把 RTL 指令经 .md 输出模板发射为汇编（final），管理静态数据汇编（varasm），生成 DWARF 调试信息（dwarf2out）。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

代码生成是 GCC 编译管线的终点：寄存器分配后，把 RTL 指令发射为汇编文本（**final**）、管理变量/静态数据的汇编（**varasm**）、生成 DWARF 调试信息（**dwarf2out**）。这三者都通过全局 `asm_out_file` 写入，但发射时机与约束不同——代码段逐指令流式输出（final pass 运行时），数据段全局符号表遍历输出（`wrapup_global_declarations`），DWARF 自建 DIE 树再序列化。本模块的核心设计是 **retargetability**：同一份 `final.cc` 适配所有架构，靠 `.md` 输出模板而非 C 硬编码。

## 模块架构

```
final（final.cc）── RTL 指令 → 汇编文本
  pass_final（final.cc:4340）── execute 调 rest_of_handle_final（:4259）
  final_scan_insn_1（:2159）── 模板方法：按 GET_CODE(insn) 分派
  get_insn_template（:2024）── 从 insn_data[code] 取输出模板（3 种格式）
  output_asm_insn（:3428）── 逐字符扫描模板，%0/%1 占位符替换为汇编
  模块级全局状态：current_output_insn/app_on/insn_counter/last_filename...

varasm（varasm.cc / output.h）── 变量/静态数据汇编
  assemble_variable（:2517）── 入口
  get_variable_section（:1269）── targetm.asm_out.select_section 选段
  assemble_variable_contents（:2452）── 输出 label + 初始值
  output_constant（:5442）── 递归输出常量（int/string/CONSTRUCTOR）
  output_constant_pool（:4777）── RTL 常量池
  section 抽象（output.h）：union section（:517）= named/unnamed/noswitch
  asm_out_file（output.h:321）── 全局输出 FILE*

dwarf2out（dwarf2out.cc / dwarf2out.h）── DWARF 调试信息
  die_struct（:3146）── Debugging Information Entry，children 循环链表
  dw_attr_node（dwarf2out.h:514）── DIE 属性
  dw_val_node（dwarf2out.h:277）── 属性值 tagged union
  dw_loc_descr_node（:341）── 位置描述符（stack machine）
  dwarf2out_finish（:32832）── DIE 树 → .debug_* 段
  output_die（:10830）── visitor 递归输出
  debug_hooks（debug.h:28）── 调试后端接口（dwarf2_debug_hooks @2893）
```

三组件通过共享 `asm_out_file` 和 `switch_to_section` 写入。机器描述的输出模板经 `gen*` 编译为 `insn_data[]`（`recog.h:526`），`final` 通过 `insn_data[code].output` 取用。

## 调用链路

```
# final：RTL → 汇编
pass_final::execute（final.cc:4348）
  └─ rest_of_handle_final（:4259）
      ├─ assemble_start_function（:4268）── 函数头（label/对齐/prologue）
      ├─ final_start_function_1 ── prologue 前 debug notes
      ├─ final_1（:1930）── 遍历 insn 链
      │   └─ final_scan_insn（:2888）→ final_scan_insn_1（:2159）
      │       └─ switch(GET_CODE(insn)):
      │           NOTE → NOTE_INSN_PROLOGUE_END / CFI / BLOCK_BEG
      │           INSN/JUMP_INSN/CALL_INSN:
      │             → get_insn_template（:2024）── insn_data[code].output 模板
      │             → output_asm_insn（:3428）── %0/%1 替换 → 写 asm_out_file
      ├─ final_end_function / assemble_end_function
      └─ debug_hooks->function_decl ── 函数级调试信息

# dwarf2out：DIE 树 → .debug_* 段
dwarf2out_finish（dwarf2out.cc:32832）
  ├─ flush_limbo_die_list / verify_die / resolve_addr（:32924）── 裁剪未用 DIE
  ├─ add_sibling_attributes
  ├─ output_comp_unit（:11270）
  │   ├─ build_abbrev_table ── 去重属性模式
  │   ├─ calc_die_sizes ── 预计算偏移（DW_FORM_ref4 回填）
  │   └─ output_die（:10830）── 递归输出（abbreviation 编号 + 属性值 + 子节点）
  └─ output_abbrev_section / output_aranges / .debug_pubnames ...
```

`output_asm_insn`（`final.cc:3428`）逐字符扫描模板字符串：`%0`/`%1` 替换为 `recog_data.operand` 中 RTL 表达式的汇编表示，`%c` 调 `output_operand` → `targetm.asm_out.print_operand`，`{...|...}` 处理 assembler dialect 选择，最终 `fprintf(asm_out_file,...)` 写出。

## 核心实现

### `final_scan_insn_1`：模板方法 + .md 输出模板

`final_scan_insn_1`（`final.cc:2159`）是模板方法骨架：按 `GET_CODE(insn)` 分派（`NOTE`/`JUMP_TABLE_DATA`/`INSN`/`JUMP_INSN`/`CALL_INSN`），对普通 `INSN` 统一走"取模板→替换操作数→输出"流程。具体指令的汇编格式由机器描述 `.md` 的 `define_insn` 的 output 模板决定，`final.cc` 本身不含任何架构特定代码。`get_insn_template`（`final.cc:2024`）根据 `insn_data[code].output_format`（`recog.h:521`）三选一：`INSN_OUTPUT_FORMAT_SINGLE`（单一模板）、`MULTI`（按 `which_alternative` 选）、`FUNCTION`（调 C 函数动态生成）。`insn_data[]`（`recog.h:526`）由 `gen*` 工具从 `.md` 自动生成。

### `dwarf2out`：DIE 树 + visitor 序列化

`die_struct`（`dwarf2out.cc:3146`）是 DIE 核心：`die_attr`（属性向量）、`die_parent`、`die_offset`、`die_abbrev`、`die_tag`（如 `DW_TAG_compile_unit`），children 用**循环链表**（`die_sib`，`die_child` 指向最后子节点）。`dw_attr_node`（`dwarf2out.h:514`）含 `dw_val_node`（:277，tagged union，十余种 `val_class`）。

`output_die`（`dwarf2out.cc:10830`）是 visitor：递归遍历整棵树，对每个 DIE 输出 abbreviation 编号 + 属性值 + 递归子节点（:11199）。自建树再序列化是为做这些优化：`resolve_addr`（:32924）裁剪未用 DIE、`build_abbrev_table` 去重属性模式、`calc_die_sizes` 预计算偏移使交叉引用（`DW_FORM_ref4`）可回填、`add_sibling_attributes` 加 `DW_AT_sibling`。流式输出无法做这些，也无法支持 `-gsplit-dwarf`（DWO 需 checksum + skeleton CU）。

### `varasm`：数据段汇编

`assemble_variable`（`varasm.cc:2517`）：取 `DECL_RTL(decl)` 的 `SYMBOL_REF` → `get_variable_section`（:1269）调 `targetm.asm_out.select_section` 选段 → `align_variable`（:2611）对齐 → `switch_to_section` → `assemble_variable_contents`（:2452）输 label + `output_constant`（:5442，递归：`assemble_integer`/`assemble_string`/`CONSTRUCTOR` 递归）。section 抽象（`output.h:517`）：`union section` = `named_section`（:467，命名段如 `.data`）/`unnamed_section`（:483，回调切换）/`noswitch_section`（:509，回调组装），由 `SECTION_STYLE()` 判别。常量池 `crtl->varasm.pool`（`force_const_mem` 注册，`output_constant_pool` :4777 统一输出）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 模板方法 | `final_scan_insn_1` in `final.cc:2159` | 逐 insn 调 `.md` output 模板，final.cc 完全架构无关 |
| 策略 | `get_insn_template` in `final.cc:2024` | `output_format` 三选一（single/multi/function） |
| 组合 + 访问者 | `die_struct` in `dwarf2out.cc:3146`；`output_die` in `:10830` | DIE 树组合模式，`output_die` 递归 visitor |
| 依赖注入/Hooks | `targetm.asm_out.*` in `output.h`；`debug_hooks` in `debug.h:28` | 架构/调试格式隔离，final 只调通用接口 |

## 模块间交互

final 用机器描述发射汇编：`final_scan_insn_1` 调 `get_insn_template`（`final.cc:2789`）从 `insn_data[code]` 取 `.md` 的 output 模板，`output_asm_insn` 替换操作数，`%c` 调 `targetm.asm_out.print_operand`，还调 `targetm.asm_out.unwind_emit`（:2838）发 CFI、`targetm.asm_out.final_postscan_insn`（:2861）。varasm 从 tree 层 `VAR_DECL` 经 `DECL_RTL` 取 RTL，`select_section`/`encode_section_info`（:1521）委托目标后端。dwarf2out 经 `gcc_debug_hooks` 接口（`debug.h:28`）从前端/symtab 取信息——`dwarf2out_early_global_decl`（:32922）、`dwarf2out_function_decl`（:2920，从 `rest_of_handle_final` :4306 调）、`dwarf2out_begin_prologue`（:1071）。dwarf2out 与 varasm 共享 `asm_out_file` 和 section 抽象：`switch_to_section`（`output.h`）切到 `debug_info_section` 等，`ASM_OUTPUT_LABEL` 发段 label，`dw2_asm_output_data` 写二进制。

## 扩展方式

- **新增指令汇编输出模板**：在架构 `.md`（如 `config/aarch64/aarch64.md`）加 `define_insn`，output 模板写字符串；`gen*` 自动编译为 `insn_data[]` 条目并判 `output_format`。复杂逻辑用 `define_insn` 的 output 为 C 代码表达式（`FUNCTION` 格式，在 `config/<arch>/<arch>.cc` 实现）。一般不需改 `final.cc`。对应测试：`gcc/testsuite/<arch>/`。
- **新增 DWARF 节点/属性**：在 `enum dwarf_attribute` 加新 attribute → `dw_val_node`（:277）加值类型（若需）→ 加 `add_AT_xxx` 函数（参照 `add_AT_flag`/`add_AT_int`，:3747+）→ `output_die`（:10830）的 `switch(AT_class(a))` 加 case → `build_abbrev_table` 确保可入 abbreviation → 若引用其他 DIE 在 `resolve_addr`（:32924）处理。
- **新增数据 section 布局策略**：在 `config/<arch>/<arch>.cc` 实现 `select_section` hook 变体或 `ASM_OUTPUT_*` 宏 → 若 section 无法用 switch 进入，实现 `noswitch_section_callback`（`output.h:504`）→ 在 `get_variable_section`（`varasm.cc:1269`）或 `select_section` 路由 → 特殊布局改 `align_variable`（:2611）或 `assemble_variable_contents`（:2452）。
