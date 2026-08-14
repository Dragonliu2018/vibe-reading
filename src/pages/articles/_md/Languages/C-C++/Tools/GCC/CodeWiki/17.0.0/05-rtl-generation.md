---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "RTL 生成与优化"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "RTL", "rtx", "cfgexpand", "指令调度", "recog"]
description: "GCC 把 GIMPLE 展开为接近机器的 RTL（rtx_def），运行 CSE/combine/指令调度等低层优化遍，并经 recog 做指令识别。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

本模块是 GCC 后端的第一层：把 GIMPLE/SSA 展开为 **RTL**（Register Transfer Language，`rtx_def` 联合体）——一种接近目标机器指令的低层 IR，并在 RTL 上运行低层优化遍（公共子表达式消除 CSE、指令合并 combine、指令调度 sched）。RTL 比 GIMPLE 更贴近机器：它直接描述寄存器/内存操作与指令模式，配合机器描述（`.md`）做指令识别（`recog`）。本模块是高层优化（GIMPLE/SSA）与寄存器分配/代码生成之间的桥梁。

## 模块架构

```
RTL 数据结构（rtl.h / rtl.def / rtl.cc）
  rtx_def（rtl.h:312）── GTY 联合体，code（rtx_code，:319）+ mode（:316）+ 变体 u
  enum rtx_code（rtl.h:48）── rtl.def 的 DEF_RTL_EXPR X-macro 展开
  rtx_insn（rtl.h:550）── 指令子类（INSN/JUMP_INSN/CALL_INSN/NOTE/...），全局链表 get_insns()
  rtx_expr_list / rtx_sequence / ...（各 rtx 子类）
  全局表：rtx_length/rtx_name/rtx_format/rtx_class/rtx_code_size/rtx_next（rtl.h:108-125）

GIMPLE → RTL（cfgexpand.cc / expr.cc）
  pass_expand（cfgexpand.cc:7045）── 展开 pass，IR 转折点
  rewrite_out_of_ssa ── SSA 退出 → 伪寄存器
  gimple_expand_cfg ── 遍历 GIMPLE stmt 生成 RTL insn
  expand_expr_real / expand_expr_real_1（expr.cc:11510）── tree 表达式 → RTX

RTL 优化遍（passes.def 的 RTL 段）
  pass_cse / pass_cse2（cse.cc:8096）── 公共子表达式消除
  pass_combine（combine.cc）── 指令合并
  pass_rtl_pre / pass_rtl_dse1 ── 部分冗余/死存储
  pass_sched / pass_sched2（haifa-sched.cc / sched-rgn.cc）── 指令调度
  simplify_context（simplify-rtx.cc）── RTX 代数化简

指令识别（recog.cc / recog.h / genrecog.cc）
  recog_memoized（recog.h:336）── RTL pattern 匹配到 insn_code（缓存到 INSN_CODE）
  extract_insn / constrain_operands ── 提取操作数、校验约束
  insn_data_d（recog.h:526）── 机器描述生成的指令元数据表
```

RTL 用与 tree 类似的 C 联合体 + `rtl.def` X-macro（历史与 GGC 友好）。GIMPLE→RTL 是 IR 的第二次大转换（`pass_expand`），此后所有 pass 操作 RTL。

## 调用链路

```
pass_expand::execute (cfgexpand.cc:7058)       ── GIMPLE → RTL 转折点
  ├─ rewrite_out_of_ssa(&SA) (cfgexpand.cc:7067)  ── SSA 退出，SSA_NAME → 伪寄存器
  ├─ expand_used_vars (cfgexpand.cc:7130)         ── 局部变量栈分配
  ├─ expand_function_start (cfgexpand.cc:7171)    ── 函数 prologue
  └─ gimple_expand_cfg                            ── 遍历基本块
      └─ expand_gimple_basic_block (cfgexpand.cc:6202)
          └─ expand_gimple_stmt (cfgexpand.cc:4410)
              └─ expand_gimple_stmt_1 (cfgexpand.cc:4244)  ── 按 gimple_code 分发
                  └─ expand_expr_real_1 (expr.cc:11510)    ── tree 表达式 → RTX
                      └─ emit_insn（emit-rtl.cc）            ── 加入指令流

# RTL 优化遍（pass_rest_of_compilation 子链，passes.def:461 起）
pass_instantiate_virtual_regs → pass_cse (cse.cc) → pass_rtl_fwprop
  → pass_rtl_pre / pass_rtl_hoist / pass_rtl_dse1
  → pass_combine (combine.cc) → pass_if_after_combine
  → pass_split_all_insns → pass_sched (haifa-sched.cc:9294)
  [→ pass_ira / pass_reload（见寄存器分配模块）]
  → pass_postreload（cse2 / peephole2 / sched2）
```

`expand_gimple_stmt_1`（`cfgexpand.cc:4244`）按 `gimple_code` 分发：`GIMPLE_ASSIGN` 调 `expand_expr_real_1`（`expr.cc:11510`）的 `switch (TREE_CODE(exp))` 把 tree 表达式翻译为 RTX，`emit_insn`（`emit-rtl.cc`）加入当前指令序列。`recog_memoized`（`recog.h:336`）在展开后匹配 RTL 到 `insn_code`，缓存到 `INSN_CODE(insn)`，供后续 `final` 取输出模板。

## 核心实现

### `rtx_def` 与 `rtl.def` X-macro

`struct rtx_def`（`rtl.h:312`）是 GTY 标注联合体：`code`（`rtx_code`，:319，8 位）+ `mode`（`machine_mode`，:316）+ 变体联合 `u`。`enum rtx_code`（`rtl.h:48`）由 `rtl.def` 的 `DEF_RTL_EXPR(枚举名,字符串名,格式串,类别)` X-macro 展开生成。同一份 `rtl.def` 驱动多处：`rtl.h:108-125` 的 6 张全局表（`rtx_length`/`rtx_name`/`rtx_format`/`rtx_class`/`rtx_code_size`/`rtx_next`）、`gengenrtl.cc:212-243` 构建期生成的 `gen_rtx_*` 便捷宏（如 `gen_rtx_PLUS(mode,a0,a1)` → `gen_rtx_fmt_ee(PLUS,mode,a0,a1)`）、GTY 的 GC 遍历逻辑。增删一种 RTX 类型只改 `rtl.def` 一处，编译器自动更新枚举/格式表/生成宏/GC 遍历——这是 C 预处理时代的元编程，在现代 C++ 代码库仍最务实。

`rtx_insn`（`rtl.h:550`）是指令子类（`INSN`/`JUMP_INSN`/`CALL_INSN`/`NOTE`/`BARRIER`/`CODE_LABEL`），指令通过全局链表管理，`get_insns()` 返回链头。`basic_block`（`basic-block.h`）含 `rtl_bb_info` 持有该块的 RTL 头尾指令。

### `pass_expand`：GIMPLE→RTL 的 IR 转折

`pass_expand::execute`（`cfgexpand.cc:7058`）是 `all_passes` 链中 GIMPLE→RTL 的转折点。流程：`rewrite_out_of_ssa(&SA)`（:7067）把 SSA_NAME 映射到分区/伪寄存器（`SA.partition_to_pseudo`，类型 `rtx`）→ `expand_used_vars`（:7130）局部变量栈分配 → `gimple_expand_cfg` 逐基本块 `expand_gimple_basic_block`（:6202）→ `expand_gimple_stmt_1`（:4244）按 `gimple_code` 分发翻译。`pass_expand` 的 `properties_destroyed = PROP_ssa | PROP_gimple`（`cfgexpand.cc:7040`），标记 IR 从 GIMPLE 切到 RTL——此后 pass 须声明 `PROP_rtl` 前置属性。

### `recog`：机器描述模式匹配

`recog_memoized`（`recog.h:336-341`）是内联函数，调 `recog()`（由 `genrecog.cc` 从 `.md` 的 `define_insn` 模式生成的决策树代码，输出到 `insn-recog-N.cc`），把 RTL pattern 匹配到 `insn_code`，缓存到 `INSN_CODE(insn)`。`extract_insn`/`constrain_operands`（`recog.cc`）提取操作数并校验约束。`insn_data_d`（`recog.h:526`）是机器描述生成的指令元数据表，`insn_data[]` 数组由 `gen*` 工具从 `.md` 生成——`output` 字段是 union（`single` 字符串 / `multi` 数组按 `which_alternative` 选 / `function` 指针），`output_format` 标识用哪种，供 `final` 的 `get_insn_template`（`final.cc:2024`）取输出模板。

### RTL 优化遍

- **CSE**（`pass_cse`，`cse.cc`）：公共子表达式消除，识别重复计算的表达式并复用寄存器。
- **combine**（`pass_combine`，`combine.cc`）：指令合并，把相邻的 RTL 指令合并为更高效的单条（消除冗余、降寄存器压力）。
- **指令调度**（`pass_sched`/`pass_sched2`，`haifa-sched.cc:9294` 的 `schedule_block` / `sched-rgn.cc`）：按机器描述的流水线模型（`genautomata` 生成的 FSA）重排指令避免流水线停顿。调度在寄存器分配前后各一次（`pass_sched` 前置、`pass_sched2` 在 `pass_postreload` 内）。
- **simplify-rtx**（`simplify_context`，`simplify-rtx.cc`）：RTX 代数化简（如 `x+0→x`、`x*1→x`），被多处复用。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 变体类型（X-macro） | `rtx_def` in `rtl.h:312`；`rtl.def` | 与 tree 一致的 C 联合体；增删 RTX 类型改一处，表/宏/GC 自动同步 |
| 匹配识别 | `recog_memoized` in `recog.h:336`；`genrecog.cc` | `.md` 声明式 pattern → 构建期编译为决策树，运行时 O(1) 匹配 |
| pass 管线 | RTL 段 in `passes.def:461+` | 与 GIMPLE 一致的声明式链，`PROP_rtl` 前置约束 |

## 模块间交互

`pass_expand` 消费 GIMPLE（`gimple.h`，经 `cfun->gimple_body`）产出 RTL（`get_insns()` 链）。RTL 展开大量调用机器描述：`expand_expr_real_1`（`expr.cc`）调 `targetm.hard_regno_mode_ok`（:157）/`targetm.calls.function_arg`（:2214）/`targetm.legitimate_constant_p`（:2876）等钩子；`gen_xxx()` 函数（`genemit` 从 `.md` 生成）在 expand 阶段被调构造 RTL。`recog` 查询 `.md` 模式做识别，`final`（`final.cc:2024`）用 `insn_data[code].output` 取输出模板。寄存器分配（`pass_ira`/`pass_reload`）紧接 RTL 优化遍，消费 RTL 链并替换伪寄存器为硬件寄存器。`pass_postreload`（cse2/peephole2/sched2）是寄存器分配后的后置 RTL 优化。

## 扩展方式

- **新增 RTL pass**：新建 `gcc/my-pass.cc` 定义 `pass_data`（`type=RTL_PASS`）+ `class pass_my_pass:public rtl_opt_pass` override `execute`；`passes.def` 在合适位置加 `NEXT_PASS(pass_my_pass)`——位置依需求（需伪寄存器放 `pass_sched`（`passes.def:514`）前，需硬寄存器放 `pass_reload`（:519）后，需 DF 信息用 `df_analyze`）；`Makefile.in` 加目标。
- **为架构新增 expand 规则**：在 `config/<arch>/<arch>.md` 加 `define_expand`（展开阶段调）或 `define_insn`（识别阶段匹配），写 RTL pattern + 约束 + 输出模板；`genoutput.cc` 自动生成 `gen_xxx()` 函数，`genrecog` 自动重新生成 `recog` 匹配代码——无需手改 gen*。通用展开逻辑改 `expr.cc:11510` 的 `expand_expr_real_1` switch。调用链：`expand_expr_real_1` → 后端 `gen_<name>` → `gen_rtx_*` 构造 RTX → `emit_insn`。
