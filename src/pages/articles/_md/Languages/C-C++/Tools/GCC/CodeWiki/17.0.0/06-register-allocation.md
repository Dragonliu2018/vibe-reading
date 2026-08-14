---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "寄存器分配"
date: "2026-08-14T10:26:00+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "寄存器分配", "IRA", "LRA", "reload", "图着色"]
description: "GCC 寄存器分配分两阶段：IRA 全局分配（循环树区域 + 冲突图着色），LRA 局部修正（迭代式约束求解），传统 reload 为后备。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

寄存器分配把 RTL 中的伪寄存器/操作数映射到实际硬件寄存器或栈槽，处理寄存器约束、溢出（spill）。这是经典的 NP 完全问题（图着色）。GCC 用**两阶段**策略：**IRA**（Integrated Register Allocator）在循环树区域层面做全局分配，**LRA**（Local Register Allocator）逐指令修正不满足约束的地方，传统 **reload** 是 LRA 未启用时的后备。两阶段分工让全局视野（IRA）与逐指令约束精确性（LRA）兼得。

## 模块架构

```
IRA 全局分配（ira.cc / ira-*.cc / ira-int.h）
  ira_loop_tree_node（ira-int.h:81）── 循环树区域节点（bb/loop + parent/subloops）
  ira_allocno（ira-int.h:291）── 核心分配对象（每伪寄存器每区域一个）
  ira_object（ira-int.h:226）── 冲突图节点（多字寄存器拆多 object）
  live_range（ira-int.h:198）── 存活程序点区间
  ira()（ira.cc:5671）── 入口
   ├─ ira_build（ira-build.cc:3503）── 建循环树/allocno/代价/live range/cap
   ├─ ira_costs（ira-costs.cc:2648）── 各 register class 代价
   ├─ ira_build_conflicts（ira-conflicts.cc:860）── 冲突图（位图或向量）
   └─ ira_color（ira-color.cc:5421）── 着色（assign_hard_reg @2008）

LRA 局部修正（lra.cc / lra-*.cc / lra-int.h）
  lra_reg（lra-int.h:87）── 每寄存器信息（conflict_hard_regs/preferred/val/...）
  lra_live_range（lra-int.h:57）── LRA 的 live range
  lra_elim_table ── 寄存器消除表
  lra()（lra.cc:2424）── 迭代收敛主循环
   ├─ lra_constraints（lra-constraints.cc:5939）── 逐指令约束求解
   ├─ lra_assign / assign_by_spills（lra-assigns.cc:1647/1417）── 分配+溢出
   ├─ lra_inheritance / lra_undo_inheritance ── 试探-回退
   └─ lra_spill（lra-spills.cc:659）── 栈槽分配

传统 reload（reload1.cc / reload.cc / reload.h）── LRA 未启用时后备
  reload 结构（reload.h:75）── 描述一个 reload 操作
  reload()（reload1.cc:750）── 全局 rld[] 一次性求解
```

IRA 和 LRA 是两套独立数据结构（`ira_allocno` vs `lra_reg`），由 `targetm.lra_p()`（`ira.cc:1663`）二选一。pass 顺序：`pass_ira`（`passes.def:518`）→ `pass_reload`（:519）→ `pass_final`（:571）。

## 调用链路

```
pass_ira::execute → ira()（ira.cc:5671）
  ├─ targetm.lra_p()（ira.cc:1663）── 决定是否用 LRA（存 ira_use_lra_p）
  ├─ df_analyze ── 数据流分析（liveness）
  ├─ update_equiv_regs ── 建立等价关系
  ├─ ira_build（ira-build.cc:3503）
  │   ├─ create_loop_tree_nodes / form_loop_tree ── 循环树
  │   ├─ create_allocnos ── 为伪寄存器建 allocno
  │   ├─ ira_costs（ira-costs.cc:2648）── 各 class 代价
  │   ├─ ira_create_allocno_live_ranges ── live range
  │   ├─ create_caps ── 区域间传播 cap 机制
  │   └─ ira_tune_allocno_costs ── 调整跨调用 allocno 代价
  ├─ ira_build_conflicts（ira-conflicts.cc:860）
  │   ├─ build_conflict_bit_table（:91）── 冲突位图（超限则降级）
  │   └─ build_conflicts（:701）── 遍历 live range 建冲突边
  └─ ira_color（ira-color.cc:5421）
      └─ color()（:5294）→ do_coloring()（:3891）→ color_pass()（:3721）
          → color_allocnos()（:3537）→ assign_hard_reg()（:2008）── 选代价最低硬件寄存器

pass_reload::execute → do_reload()（ira.cc:6065）
  ├─ [ira_use_lra_p=true]  lra()（lra.cc:2424）
  │   └─ for(;;) 迭代收敛：
  │       ├─ lra_constraints（lra-constraints.cc:5939）── 逐指令检查，不满足则 reload 伪寄存器 + live range splitting
  │       ├─ lra_eliminate（lra-eliminations.cc:1516）── 寄存器消除（fp→sp）
  │       ├─ lra_inheritance / lra_undo_inheritance ── 复用已有分配，失败回退
  │       ├─ lra_assign（lra-assigns.cc:1647）→ assign_by_spills（:1417）── 分配+溢出
  │       └─ lra_spill（lra-spills.cc:659）── 栈槽，需 spill 则继续外层循环
  └─ [false] reload()（reload1.cc:750）── 传统 reload
```

## 核心实现

### IRA：循环树区域 + 冲突图着色

`ira_allocno`（`ira-int.h:291`）是核心分配对象：每个伪寄存器在每个循环区域有一个 allocno，字段含 `regno`/`mode`/`aclass`（分配 class，`NO_REGS` 表示用内存）/`hard_regno`（负值=溢出栈）/`nrefs`/`freq`/`class_cost`/`memory_cost`/`calls_crossed_num`/`loop_tree_node`/`cap`/`cap_member`（区域间传播）。`ira_object`（:226）是冲突图节点——多字寄存器的 allocno 拆为多个 object，`conflicts_array` 存冲突（位图或向量）。`live_range`（:198）描述存活区间，两个 allocno 的 live range 相交即冲突。

着色：`build_conflict_bit_table`（`ira-conflicts.cc:91`）用位图存冲突关系（超 `param_ira_max_conflict_table_size` 则降级），`build_conflicts`（:701）遍历 live range 找同时活跃的 allocno 建冲突边，`assign_hard_reg`（`ira-color.cc:2008`）遍历候选硬件寄存器选代价最低的（综合冲突集合、register class、callee-save 跨调用代价）。函数过大或编译速度优先时 `ira_conflicts_p=false`，改用 `fast_allocation`（`ira-color.cc:5315`）不建冲突图，接近 Chow priority coloring，快但质量稍低。

**循环树区域分配**：`ira_loop_tree_node`（`ira-int.h:81`）构建函数循环层次，不同区域寄存器压力不同（热内循环压力高）。区域分配允许不同区域用不同策略，边界插 spill/restore。`cap` 机制（`ira_allocno.cap`/`cap_member`）让子区域结果传播到父区域。`flag_ira_region=IRA_REGION_ONE` 时退化为全函数单一区域。

### LRA：迭代式约束求解

LRA 取代传统 reload 的关键在**迭代收敛**而非一次性求解。`lra()`（`lra.cc:2424`）的 `for(;;)` 主循环（:2507）：每次只处理当前不满足约束的指令，生成少量 reload 伪寄存器，立即分配，再检查是否引入新约束。`lra_reg`（`lra-int.h:87`）记录每寄存器信息：`conflict_hard_regs`（冲突硬件寄存器集）、`preferred_hard_regno1/2`（偏好+收益）、`val`（持有值，相同值的伪寄存器不冲突）、`restore_rtx`（撤销 inheritance 用）、`live_ranges`、`copies`。

`lra_constraints`（`lra-constraints.cc:5939`）逐指令检查操作数约束（来自机器描述的 constraint 字符串，经 `ira_setup_alts`（`ira.cc:1770`）解析 alternatives），不满足时生成 reload 伪寄存器、做 live range splitting。`lra_inheritance`（:7922）尝试用已有硬寄存器分配替代 reload 伪寄存器，`lra_undo_inheritance`（:8385）撤销失败的——试探-回退。`lra_assign`（`lra-assigns.cc:1647`）/`assign_by_spills`（:1417）分配 reload 伪寄存器，必要时溢出。`flag_checking` 下有 `LRA_MAX_ASSIGNMENT_ITERATION_NUMBER`（:1733）防死循环。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 两阶段分配 | `ira()`→`ira_color` vs `lra()` | IRA 全局视野（循环树）+ LRA 局部精确（逐指令约束），IRA 故意忽略 early clobber 等 |
| 图着色 | `ira_build_conflicts` in `ira-conflicts.cc:860`；`assign_hard_reg` in `ira-color.cc:2008` | NP 问题的经典近似；冲突图 + 代价最小化，超限降级 fast_allocation |
| 约束传播 | `ira_setup_alts` in `ira.cc:1770`；`lra_constraints` in `lra-constraints.cc:5939` | 解析 .md 约束字符串算 alternatives；逐指令求解 |
| 迭代收敛 | LRA 主循环 in `lra.cc:2507`；inheritance/undo | 修正一条指令约束可能引入新约束，增量迭代比一次性求解更健壮 |

## 模块间交互

寄存器分配直接操作 RTL（`rtl.h`）：IRA 用 `df_analyze` 获取 liveness、`extract_insn`/`recog_data` 解析操作数、allocno 的 `regno` 对应 `regno_reg_rtx`；LRA 的 `lra_reg.insn_bitmap` 记录引用该寄存器的指令 UID。查询机器描述：`reg_class_contents`/`ira_class_hard_regs`（register class 硬件寄存器集）、`targetm.lra_p`（决定用 LRA）、`targetm.secondary_reload`（二级 reload，`reload.cc:358`）、`targetm.frame_allocation_cost`/`callee_save_cost`（溢出/恢复代价，`ira-color.cc:2052/2268`）。LRA 的 `lra_operand_data.constraint`（`lra-int.h:152`）直接来自机器描述。分配后衔接 `final`：`reload_completed=1`（`lra.cc:2675`），`final.cc:3660` 断言所有伪寄存器已替换为硬件寄存器（`REGNO(x) < FIRST_PSEUDO_REGISTER`），再调 `targetm.asm_out.print_operand` 输出汇编。`ira_use_lra_p`（`ira.cc:1663`）由 `targetm.lra_p()` 决定，多数现代架构默认启用 LRA。

## 扩展方式

- **为架构新增寄存器约束类**：在 `.md` 用新约束字符 → 在 `config/<arch>/<arch>.h` 或 `constraints.md` 定义匹配逻辑 → 在 `REG_CLASS_CONTENTS` 宏定义新 class 的硬件寄存器。IRA 的 `ira_setup_alts`（`ira.cc:1770`）自动解析，LRA 的 `constraint_satisfied_p`（`lra-constraints.cc:431`）自动读，可能需在 `process_alt_operands` 加新约束类处理。
- **调整寄存器优先级/代价**：IRA 代价在 `ira_costs`（`ira-costs.cc:2648`）的 `find_costs_and_classes`，callee-save 代价在 `assign_hard_reg`（`ira-color.cc:2052`）的 `targetm.callee_save_cost`；着色优先级在 `setup_allocno_priorities`（:5335）和 `IRA_ALGORITHM_PRIORITY` 分支；LRA 偏好在 `lra_reg.preferred_hard_regno1`（`lra-int.h:105`），在 `assign_by_spills` 的 `reload_pseudo_compare_func` 排序用。
- **为新架构接入 LRA**：在 `config/<arch>/*.h` 设 `TARGET_LRA_P` 返回 true → 定义 `ELIMINABLE_REGS` 宏（可消除寄存器对，`reload1.cc:291`/`lra-eliminations.cc` 读）→ 确保 `.md` 约束字符串可被 LRA 解析 → 有 secondary reload 需求时实现 `TARGET_SECONDARY_RELOAD` → 定义 `REG_CLASS_CONTENTS`/`CLASS_LIKELY_SPILLED_P`。
