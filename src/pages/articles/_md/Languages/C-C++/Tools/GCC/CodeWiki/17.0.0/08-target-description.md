---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "目标描述机制"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "机器描述", "retargetability", "targetm", "gen", "define_insn"]
description: "GCC 用机器描述 .md（声明式 DSL）+ targetm 钩子表 + gen* 代码生成器实现可重定向——新增架构不改编译器主体。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

目标描述机制是 GCC **可重定向（retargetability）**的根基：一份编译器主体 + N 套目标后端。它由三部分组成：**机器描述 `.md` 文件**（`config/`，462 个，声明式 DSL 描述指令模式/属性/流水线）、**`targetm` 钩子结构**（`target.h`/`target.def`，函数指针表描述架构特有行为）、**`gen*` 代码生成器**（构建期从 `.md` 生成特化 C 代码编译进 cc1）。本模块不在编译管线主路径上，而是跨层基底——被 RTL 展开（`expr.cc`）、指令识别（`recog.cc`）、最终输出（`final.cc`）随时查询。新增架构只写 `.md` + `config/` 子目录，编译器主体不动。

## 模块架构

```
机器描述 .md（config/，462 个，S-表达式 DSL）
  define_insn ── 单条指令模式（RTL pattern + 约束 + 输出模板）
  define_insn_and_split ── 模式 + 编译时分拆
  define_expand ── GIMPLE→RTL 展开入口（嵌入 C 代码）
  define_peephole2 ── RTL 窥孔优化
  define_attr ── 指令属性（length/is_call/predicated...）
  define_automaton/cpu_unit/insn_reservation/bypass ── 流水线建模

targetm 钩子结构（target.h / target.def / target-def.h）
  struct gcc_target（target.h:330）── DEFHOOK/DEFHOOKPOD 宏展开 target.def
  extern gcc_target targetm（target.h:338）── 全局实例
  HOOK_VECTOR 分区（target.def:29-7696）：
    asm_out（:33-929）/ sched（:935-1620）/ calls（:4893-5730）
    vectorize（:1788-2116）/ target_option_hooks（:6884-7082）/ addr_space（:3445-3589）

gen* 代码生成器（gen*.cc，构建期运行）
  gencodes（:50）→ insn-codes.h（enum insn_code）
  genemit（:896）→ insn-emit-N.cc（gen_xxx() 构造函数）
  genrecog（:5415）→ insn-recog-N.cc（模式匹配决策树）
  genattrtab（:5240）→ insn-attrtab.cc/insn-dfatab.cc/insn-latencytab.cc
  genautomata（:9572）→ insn-automata.cc（流水线 FSA）
  genextract（:407）→ insn-extract.cc（操作数提取）
```

构建期 `.md` → `gen*` → `insn-*.cc/.h` → 编译进 cc1；运行期编译器调 `targetm.xxx` 钩子 + 生成的 `insn-xxx` 函数。`.md` 描述可枚举的指令模式，`targetm` 描述需 C 逻辑的架构行为，两者经 `insn_data[]`（`recog.h:526`）关联。

## 调用链路

```
# 构建期：.md → gen* → C 代码
Makefile.in
  ├─ 构建 gen* 工具（用 build compiler，bconfig.h）：genemit/gencodes/genextract/genautomata/genrecog...
  └─ 运行 gen*（输入 $(md_file)）→ 生成：
      insn-codes.h（enum insn_code：CODE_FOR_xxx）
      insn-emit-N.cc（每模式的 gen_xxx()）
      insn-recog-N.cc（模式匹配决策树）
      insn-automata.cc（流水线 FSA 表）
      insn-attrtab.cc/insn-output.cc/insn-extract.cc ...
      （move-if-change 仅在内容变时更新，支持增量编译）

# 运行期：编译器主体查询 targetm + insn-*
expand 阶段（expr.cc）：targetm.hard_regno_mode_ok（:157）/targetm.calls.function_arg（:2214）/targetm.legitimate_constant_p（:2876）
                  + gen_xxx()（genemit 生成，构造 RTL）
recog 阶段（recog.cc）：recog_memoized（recog.h:336）── 调 genrecog 生成的决策树，RTL pattern → insn_code
final 阶段（final.cc）：get_insn_template（:2024）── insn_data[code].output 取输出模板
                      + targetm.asm_out.function_prologue/unwind_emit/final_postscan_insn
```

## 核心实现

### `struct gcc_target`：DEFHOOK 宏生成的函数指针表

`target.h:331-334` 定义展开宏：`DEFHOOKPOD(NAME,DOC,TYPE,INIT)` → `TYPE NAME;`（数据成员），`DEFHOOK(NAME,DOC,TYPE,PARAMS,INIT)` → `TYPE (*NAME) PARAMS;`（函数指针），`HOOKSTRUCT(FRAGMENT)` → `FRAGMENT`。`target.h:336` 执行 `#include "target.def"`，`target.def`（7697 行）用 `HOOK_VECTOR`/`HOOK_VECTOR_END` 划分子结构（如 `struct calls {...} calls;`）。全局实例 `extern struct gcc_target targetm`（`target.h:338`）。

各架构通过 `target-def.h` 提供默认初始化值（如 `#define TARGET_ASM_ALIGNED_HI_OP "\t.short\t"`），架构后端 `.h` 用 `#undef`+`#define` 覆盖特定钩子，在 `config/<arch>/<arch>.cc` 中 `struct gcc_target targetm = TARGET_INITIALIZER;`（`target.h:39`）实例化。`target.def` 被多次 include（`target.h:336` 声明成员、`target-def.h` 末尾生成初始化器），宏机制确保两处一致。

### `.md` 声明式 DSL

`.md` 用 S-表达式语法（Lisp 风格括号嵌套）。以 `gcc/config/aarch64/aarch64.md` 为例：`define_insn`（:727）声明单条指令模式（RTL pattern + 条件 + 约束 + 输出模板，如输出 `"mrs\t%x0, %1"`）；`define_insn_and_split`（:1034）模式 + 分拆（编译时匹配后用 C 代码分拆为更基础指令，输出占位 `"#"`）；`define_expand`（:1059）GIMPLE→RTL 展开入口（嵌入 C 代码手动构造 RTL）；`define_peephole2`（:2747）RTL 窥孔；`define_attr`（:513）指令属性。流水线建模（如 `thunderx2t99.md`）：`define_automaton`/`define_cpu_unit`（物理资源单元）/`define_insn_reservation`（指令→资源+延迟）/`define_bypass`（旁路）。一套 `.md` 描述，多个 `gen*` 各取所需——关注点分离的声明式设计。

### `gen*` 代码生成器

`gen*` 工具用 C++ 编写（`#include "bconfig.h"`，用 build compiler 编译），读取 `.md` 的 RTL 构造输出特化 C 代码——将声明式模式编译为高效运行时代码：

- **gencodes**（`gencodes.cc:50`）：读 `DEFINE_INSN`/`DEFINE_EXPAND` 生成 `insn-codes.h`（`enum insn_code { CODE_FOR_nothing, CODE_FOR_xxx, ... }`），每条 .md 模式获唯一编号，是其他生成代码的基础。
- **genemit**（`genemit.cc:896`）：读 `DEFINE_INSN`→`gen_insn()`（:950）、`DEFINE_EXPAND`→`gen_expand()`（:954）、`DEFINE_SPLIT`/`DEFINE_PEEPHOLE2`→`gen_split()`（:958），生成 `insn-emit-N.cc` 含每模式的 `gen_xxx()` 构造函数。
- **genrecog**（`genrecog.cc:5415`）：生成 `insn-recog-N.cc` + `insn-recog.h`，含模式匹配决策树代码（将 .md pattern 编译为决策树，运行时 O(1) 匹配）。
- **genautomata**（`genautomata.cc:9572`）：读 `DEFINE_CPU_UNIT`/`DEFINE_AUTOMATON`/`DEFINE_INSN_RESERVATION`/`DEFINE_BYPASS`，经 `expand_automata()`（:9641）+`write_automata()`（:9670）生成 `insn-automata.cc`——流水线 FSA 表。需链接 `-lm`（`Makefile.in:3399`）。
- **genattrtab**（`genattrtab.cc:5240`）：生成 `insn-attrtab.cc`/`insn-dfatab.cc`/`insn-latencytab.cc`。

大型架构（i386/aarch64）模式数千条，生成的单文件可达数十万行超编译器单文件限制，故 `genemit`/`genrecog` 用 `-O` 分片输出 `insn-emit-N.cc`/`insn-recog-N.cc`（`Makefile.in:231-242` 的 `INSNEMIT_SEQ_SRC`/`INSNRECOG_SEQ_SRC`），支持并行编译，`move-if-change` 仅内容变才触发重编译。

### 运行期查询

`recog_memoized`（`recog.h:336-341`）是内联函数，调 `recog()`（genrecog 生成）匹配 RTL pattern 到 `insn_code`，缓存到 `INSN_CODE(insn)`。`get_insn_template`（`final.cc:2024`）据 `insn_code` 从 `insn_data[code]` 取输出模板（支持 single/multi/function 三种格式）。`gen_xxx()`（genemit 生成）在 expand 阶段被 `expr.cc` 调用构造 RTL（如 `emit_insn(gen_aarch64_bcond(...))`，`aarch64.md:1050`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 钩子结构（函数指针表多态） | `target.h:330-338` / `target.def` / `target-hooks-macros.h:30` | 后端多态，默认值 + override，`-mcpu` 运行时切换 targetm |
| 代码生成 | `genemit.cc:gen_insn` / `genrecog.cc` / `genautomata.cc:expand_automata` | 构建期把声明式 .md 编译为特化高效 C（决策树、FSA 表、构造函数） |
| 声明式 DSL | `define_insn` in `*.md`；`define_insn_reservation` in `thunderx2t99.md` | S-表达式，一套描述多个 gen* 各取所需，关注点分离 |

## 模块间交互

`targetm` 被 RTL expand（`expr.cc:157`/`2183`/`2876`）、recog（`recog.cc:1900`/`3841`/`773`）、final（`final.cc:1781`/`2186`/`2659`）调用——expand 查约束（`hard_regno_mode_ok`/`legitimate_constant_p`）、recog 验操作数（`legitimate_address_p`/`hard_regno_mode_ok`）、final 调架构特定输出（`function_prologue`/`unwind_emit`/`final_postscan_insn`）。`gen*` 生成器被 `Makefile.in` 调用（:2790-2863 生成、:3283-3399 编译 gen* 工具）。`.md` 与 `targetm` 互补：`.md` 描述**可枚举的指令模式**（声明式），`targetm` 描述**需 C 逻辑的架构行为**（命令式，ABI/寄存器/合法地址/汇编语法）。两者经 `insn_data[]`（`recog.h:526`）关联——`get_insn_template`（`final.cc:2024`）同时访问生成的 `insn_data[code].output` 和 `recog_data.operand`（后者填充依赖 `targetm` 约束检查）。

## 扩展方式

- **为全新架构新增后端**：创建 `gcc/config/<arch>/` 子目录（参考 `config/aarch64/`）：`<arch>.md`（核心机器描述：寄存器/属性/基本指令模式，可拆多个 .md）、`<arch>.h`（寄存器布局 `FIXED_REGISTERS`/`CALL_USED_REGISTERS`/数据类型大小/栈布局，覆盖 `target-def.h` 默认值）、`<arch>.cc`（targetm 钩子函数实现 + 初始化）、`<arch>-cores.def`（CPU 微架构，用于 `-mcpu`）、可选流水线 .md（`define_automaton`/`define_cpu_unit`/`define_insn_reservation`）、`config.gcc`/`config.sub` 注册三元组、`t-<arch>` Makefile 片段。
- **新增指令模式**：在架构 `.md` 加 `define_insn`（名称→`gen_xxx` 函数名 + `CODE_FOR_xxx` 枚举、RTL pattern、条件如 `"TARGET_SVE"`、约束字符串、输出模板）——genemit/genrecog/genattrtab 自动生成对应代码，无需手改 gen*。在 C 代码用 `emit_insn(gen_xxx(operands))` 调用。GIMPLE→RTL 用则在 `define_expand` 中调 `gen_xxx`。
- **新增 targetm 钩子**：在 `gcc/target.def` 的适当 `HOOK_VECTOR` 内加 `DEFHOOK(NAME,DOC,TYPE,PARAMS,INIT)` → 在 `gcc/target-def.h` 加默认 `#define TARGET_XXX default_xxx` → 在 `gcc/targhooks.cc`/`targhooks.h` 实现 `default_xxx()` → 需覆盖时在 `config/<arch>/<arch>.h` `#undef TARGET_XXX`+`#define TARGET_XXX <arch>_xxx`。`target.def` 多次 include 机制保证声明与初始化器一致。
