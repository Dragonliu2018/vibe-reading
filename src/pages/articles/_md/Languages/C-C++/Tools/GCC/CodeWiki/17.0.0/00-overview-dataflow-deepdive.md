---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "编译数据流深读：源码→汇编的 IR 演变"
date: "2026-08-18T14:16:25+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "data flow", "IR", "GENERIC", "GIMPLE", "SSA", "RTL", "cgraph", "LTO"]
description: "深读 GCC 一次完整编译的数据流：源码文本→GENERIC→GIMPLE→GIMPLE SSA→RTL→汇编五次 IR 形态演变的边界跨越函数、cgraph_node 生命周期与 LTO 三阶段。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview) · 本文是概览「运行时行为 > 核心运行流程」的深度附件，展开 IR 演变细节、cgraph 生命周期与 LTO 分阶段。

---

## 五次 IR 形态演变

GCC 把源码编译为汇编，数据形态经过五次转换。每次转换都由一个明确的"边界跨越函数"完成，且承载 IR 的全局载体随之切换：

```
┌──────────────┐
│ Source Text  │  .c 字符流
└──────┬───────┘
       │  c_parser_translation_unit → c_parser_external_declaration
       │  词法/语法分析，build_* 构造 AST
       ▼
┌──────────────┐  存于 DECL_SAVED_TREE(fndecl)
│ GENERIC Tree │  union tree_node：BIND_EXPR/COND_EXPR/MODIFY_EXPR...
│ (tree_node)  │  嵌套树，可任意深度；语言相关但中端可消费
└──────┬───────┘
       │  ① gimplify_body (gimplify.cc:21782)
       │     gimplify_stmt(&DECL_SAVED_TREE, &seq)
       │     DECL_SAVED_TREE = NULL_TREE；fn->gimple_body = seq
       ▼
┌──────────────┐  存于 cfun->gimple_body（gimple_seq）
│ GIMPLE       │  gimple_statement_base：三地址码，每条 ≤3 操作数，扁平序列
│ (gimple_seq) │  gassign*/gcond*/gcall*/greturn*/gbind*
└──────┬───────┘
       │  ② pass_build_cfg (tree-cfg.cc:329) → execute_build_cfg → build_gimple_cfg
       │     make_blocks(seq)：gimple_seq 按 leader stmt 拆分为 basic_block 链
       │     cfun->gimple_body = NULL（body 已分散到 BB）
       ▼
┌──────────────┐  存于 basic_block->il.gimple.{seq, phi_nodes}
│ GIMPLE + CFG │  cfun->cfg->x_entry_block_ptr / x_exit_block_ptr
│ (bb 链)      │  bb->preds / bb->succs 为 edge 向量
└──────┬───────┘
       │  ③ rewrite_blocks (tree-into-ssa.cc:2285)
       │     计算 dominance frontier → 插入 PHI → 支配树重命名
       │     每个 variable → SSA_NAME (version + var)
       ▼
┌──────────────┐  存于 bb->il.gimple.seq（SSA 形式）+ cfun->gimple_df
│ GIMPLE SSA   │  操作数改为 SSA_NAME；含 virtual operands (VDEF/VUSE)
└──────┬───────┘
       │  ④ pass_expand::execute (cfgexpand.cc:7058)
       │     rewrite_out_of_ssa(&SA)：SSA_NAME→partition→pseudo reg
       │     expand_gimple_basic_block(bb)：逐 stmt → emit rtx_insn
       │     bb->flags |= BB_RTL；bb->il 从 gimple 切到 x.{head_, rtl->end_}
       ▼
┌──────────────┐  存于 get_insns() 全局线性链 + bb->il.x（按 BB）
│ RTL          │  rtx_def/rtx_insn：INSN/JUMP_INSN/CALL_INSN/NOTE/BARRIER
│ (insn 链)    │  PATTERN(insn) = SET/CALL/PARALLEL...
└──────┬───────┘
       │  ⑤ pass_final (final.cc:4340) → rest_of_handle_final (final.cc:4259)
       │     final_1 → final_scan_insn (final.cc:2888) → output_asm_insn (:3428)
       │     get_insn_template → fprintf(asm_out_file, templ)
       ▼
┌──────────────┐
│ Assembly     │  文本写入 asm_out_file (FILE*) → .s
└──────────────┘
```

**五个边界跨越函数**（带文件行号，可追溯到源码）：

| # | 边界 | 函数 | 载体切换 |
|---|------|------|---------|
| ① | GENERIC → GIMPLE | `gimplify_body` (`gimplify.cc:21782`) | `DECL_SAVED_TREE` → `cfun->gimple_body` |
| ② | GIMPLE 扁平 → GIMPLE CFG | `execute_build_cfg` (`tree-cfg.cc:329`) | `gimple_body` → `cfun->cfg` 的 BB 链 |
| ③ | GIMPLE → GIMPLE SSA | `rewrite_blocks` (`tree-into-ssa.cc:2285`) | 变量 → `SSA_NAME`，BB 加 `phi_nodes` |
| ④ | GIMPLE SSA → RTL | `pass_expand::execute` (`cfgexpand.cc:7058`) | `bb->il.gimple` → `bb->il.x`（`BB_RTL` flag） |
| ⑤ | RTL → 汇编 | `rest_of_handle_final` (`final.cc:4259`) | `get_insns()` → `asm_out_file` |

## cgraph_node 生命周期

全程序编排由 `analyze_functions`（`cgraphunit.cc:1176`）与 `symbol_table::compile`（`cgraphunit.cc:2343`）驱动，每个函数经历：

```
finalize_function (cgraphunit.cc:452)     前端解析完调用
  definition=true，注册到 callgraph，body 仍是 GENERIC tree (DECL_SAVED_TREE)
       │
       ▼ analyze() (cgraphunit.cc:628)  ← analyze_functions 调
  push_cfun → gimplify_function_tree (gimplify.cc:22004)
  execute_pass_list(cfun, all_lowering_passes) (cgraphunit.cc:701)
    pass_lower_cf / pass_lower_eh / pass_build_cfg / pass_build_cgraph_edges
  lowered=true, analyzed=true
       │
       │  ── IPA 阶段（全程序层面，不逐函数）──
       │  symbol_table::compile → ipa_passes (cgraphunit.cc:2253)
       │  execute_ipa_pass_list(all_small_ipa / all_regular_ipa)
       │
       ▼ expand() (cgraphunit.cc:1827)  ← expand_all_functions 调（RPO 逆序）
  get_untransformed_body()（非 LTO: 已在内存; LTO: 从流恢复）
  push_cfun → init_function_start → execute_pass_list(cfun, all_passes) (cgraphunit.cc:1874)
    GIMPLE SSA 优化 → ④ pass_expand (GIMPLE→RTL) → pass_rest_of_compilation
      (RTL 优化 + ⑤ IRA/LRA 寄存器分配 + combine/peephole2 + pass_free_cfg + pass_final)
  pop_cfun / free
```

`symtab_state` 状态机（`cgraph.h:2510`）追踪全局阶段：`PARSING → CONSTRUCTION → LTO_STREAMING → IPA → IPA_SSA → IPA_SSA_AFTER_INLINING → EXPANSION → FINISHED`。`cgraph_node::add_new_function`（`cgraphunit.cc:518`）按当前 `symtab_state` 处理中途加入的函数——IPA/EXPANSION 阶段加入的会立即 `all_lowering_passes` + `execute_early_local_passes` 再 expand，FINISHED 阶段直接 analyze+expand 补救。

## 关键全局状态

IR 跨阶段不靠显式传递，而靠一组全局载体，按"当前函数"上下文隐式流转：

```cpp title="function.h / basic-block.h — 全局状态"
extern GTY(()) struct function *cfun;            // function.h:480，当前编译的函数
struct function {                                  // function.h
  tree decl;                        // = current_function_decl
  struct control_flow_graph *cfg;   // CFG：BB 链 + entry/exit
  gimple_seq gimple_body;           // pass_build_cfg 前有效，之后 NULL
  struct gimple_df *gimple_df;      // SSA 信息（SSA_NAMEs、renamer 数据）
  struct loops *x_current_loops;    // 循环信息
};
struct basic_block_def {                           // basic-block.h:117
  vec<edge, va_gc> *preds, *succs;  // 前驱/后继边
  basic_block prev_bb, next_bb;     // 双向链表
  union { gimple_bb_info gimple;    // GIMPLE: {seq, phi_nodes}
          struct { rtx_insn *head_; struct rtl_bb_info *rtl; } x; } il;  // RTL
  int flags;                        // BB_RTL 等
};
// BB 访问：BB_HEAD(B)=B->il.x.head_  BB_END(B)=B->il.x.rtl->end_ (basic-block.h:254)
// RTL 链：get_insns() → NEXT_INSN/PREV_INSN 双向链
```

`cfun` 经 `push_cfun`/`pop_cfun`（`function.cc:4767/4793`）切换，`set_cfun`（`function.cc:4730`）同步设 `current_function_decl`。`bb->il` 是 union，GIMPLE 形态用 `.gimple.{seq, phi_nodes}`、RTL 形态用 `.x.{head_, rtl->end_}`，由 `BB_RTL` flag 区分——同一 basic_block 结构在两套 IR 间复用，是 GCC 的关键设计。

## CFG 的生命周期

CFG 不是全程存在，有明确建/拆点：

```
pass_build_cfg (tree-cfg.cc:329)         创建
  make_blocks(seq): gimple_seq → basic_block 链 + edge
  cleanup_tree_cfg；loop_optimizer_init 初始化 loop_father
       │  GIMPLE 优化遍历使用：FOR_EACH_BB_FN，可分裂/合并 BB
       ▼
pass_expand (cfgexpand.cc:7058)          转 RTL
  expand_gimple_basic_block(bb)：bb->flags |= BB_RTL，bb->il 切到 x.{head_, rtl->end_}
  CFG 结构保留（preds/succs 不变）
       │
       │  pass_into_cfg_layout_mode (cfgrtl.cc:3753)   切到 cfglayout mode
       │    BB_HEADER/BB_FOOTER 包裹 insn，允许 BB 间重排
       │  RTL 优化遍使用：FOR_EACH_BB: BB_HEAD→BB_END 遍历 rtx_insn
       │  pass_outof_cfg_layout_mode (cfgrtl.cc:3792)  退出 → 线性 insn 链
       ▼
pass_free_cfg (passes.def:562)           拆除
  销毁 basic_block 链和 edge，cfun->cfg 释放
  pass_final 不再需要 CFG，遍历 get_insns() 线性链输出
```

## LTO 三阶段：函数体的物化与回收

LTO 模式下编译分三阶段（`lto_main` in `lto/lto.cc:667` 驱动），核心是**控制函数体内存**：

```
WPA (Whole Program Analysis) — flag_wpa=true
  lto_main → do_whole_program_analysis (lto/lto.cc:709)
  ① read_cgraph_and_symbols：读所有 TU 的 cgraph
  ② 符号表合并（ODR 合并跨单元类型）
  ③ analyze_functions：gimplify + lower（但不 expand）
  ④ execute_ipa_pass_list：跨函数分析
  ⑤ 分区 (lto_balanced_map) → 流式输出多个 .o
  ★ 函数 body 不在内存 — 只有 cgraph + summary（jump functions / modref tree / fn summary）
        │
        ▼
LTRANS (Link-time Translation) — flag_ltrans=true，各 partition 独立（可 make -jN 并行）
  lto_main → materialize_cgraph → symtab->compile()
  ① 从流恢复函数 GIMPLE body (get_untransformed_body)  ← body 重新物化
  ② cgraph_node::expand → execute_pass_list(all_passes)
  ③ 正常 per-function 优化 + RTL + 汇编输出
  ★ 函数 body 重新在内存 — 走完整后端
```

**为什么必须分阶段**：链接时全程序优化需看所有编译单元 summary，但全程序函数体（可达数十 MB）无法同时驻留内存。WPA 阶段只加载 summary 数据结构（每个参数几字节、压缩的内存访问树、大小估计），分区后 LTRANS 各分区函数体独立加载编译并并行化。不分区则 LTO 链接大程序 OOM。`ipa_passes()`（`cgraphunit.cc:2253`）中 `if (!in_lto_p)` 控制 small IPA pass 只在编译时跑一次，`ipa_write_summaries()`（`:2285`）在 `flag_lto` 时把 summary 写入目标文件供 WPA 读回。

> 全程序 vs 逐函数的节奏切换：`analyze_functions` 对所有 reachable 函数做 gimplify + lower（逐函数，但批量调度）；`symbol_table::compile` 的 IPA pass 在全程序层面执行；`expand_all_functions`（`cgraphunit.cc:1990`）恢复逐函数执行，每个函数跑完整 `all_passes` pipeline。这条"逐函数→全程序→逐函数"的节奏是 GCC 编译编排的骨架。
