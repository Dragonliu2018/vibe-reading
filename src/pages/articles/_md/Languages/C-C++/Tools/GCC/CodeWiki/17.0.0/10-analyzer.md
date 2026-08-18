---
source:
  type: "源码解读"
  project: "GCC"
  url: "https://gcc.gnu.org/git.html"
title: "静态分析器（-fanalyzer）"
date: "2026-08-18T14:16:25+08:00"
category: ["Languages", "C/C++", "Tools", "GCC", "CodeWiki", "17.0.0"]
tags: ["GCC", "analyzer", "static analysis", "path-sensitive", "state machine", "region model", "exploded graph"]
description: "GCC -fanalyzer 是 path-sensitive 静态分析引擎：supergraph 跨函数 CFG、program_state（region model + 约束 + SM state）、exploded graph worklist、可插拔 state-machine checker，检测 double-free/use-after-free/taint/资源泄漏。"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/00-overview)

---

## 模块定位

`-fanalyzer`（`gcc/analyzer/`，约 4 万行）是 GCC 自带的 path-sensitive 静态分析引擎，检测 double-free、use-after-free、null 解引用、资源泄漏、taint 传播、越界、信号处理缺陷等。它**不是编译管线的一环**——不改变生成的代码，而是作为一个 IPA pass（`pass_analyzer`，`passes.def` 的 `all_regular_ipa_passes` 首位）在 IPA 阶段独立运行，复用已编译好的 GIMPLE body 与调用图。与单函数数据流分析（如 [GIMPLE/SSA pass](/vibe-reading/articles/Languages/C-C++/Tools/GCC/CodeWiki/17.0.0/04-gimple-ssa-passes) 的 CCP/DCE）不同，analyzer 跟踪**每条执行路径的精确状态**，代价是路径爆炸——它用 state merging、enode 上限、call summaries 等机制缓解。

> 与 Clang Static Analyzer 思路同源：两者都用 `ExplodedGraph`（`ProgramPoint` + `ProgramState`）、都建模内存（Clang 的 `Store`/`SVal`/`MemRegion` 三元组对应 GCC 的 region/svalue/store）。GCC 的可插拔 checker 用 `state_machine` 子类 + `make_checkers()` 注册，对应 Clang 的 `CheckerManager`。

## 模块架构

```
入口（analyzer-pass.cc）
  pass_analyzer : ipa_opt_pass_d ── gate() 检 flag_analyzer，execute() 调 ana::run_checkers()

引擎（engine.cc）
  impl_run_checkers() ── 核心流程
    ├─ region_model_manager mgr ── region/svalue 的工厂+去重池
    ├─ supergraph sg ── 合并所有函数 CFG 为单一有向图
    ├─ make_checkers() ── 创建所有 state machine（checker）
    ├─ extrinsic_state ext_state(checkers, &eng)
    ├─ exploded_graph eg(sg, ext_state, purge_map, plan)
    │    └─ process_worklist() ── 核心：探索所有可达 (point, state)
    └─ diagnostic_manager.emit_saved_diagnostics(eg)

数据结构
  program_point = (supernode, call_string)         ── 执行路径中的一个位置
  program_state  = region_model + sm_state_map[]   ── 该位置的抽象状态
  exploded_node  = (program_point, program_state)   ── 图的节点（去重）
  region         ── 内存区域层级（frame/globals/heap/stack/field/element）
  svalue         ── 值（常量/指针/未知/poisoned/widening）
  store          ── 按 cluster 组织的内存内容（binding_cluster）
  constraint_manager ── 等价类 + 约束（tristate 求值）
```

`engine` 类（`region-model.h:1315`）很轻量，仅持 `region_model_manager &` 与 `const supergraph *`。真正分析逻辑全在 `exploded_graph`——这与单函数 pass 把逻辑放 `execute()` 不同，analyzer 的核心是**图的构建与遍历**。

## 调用链路

```
pass_analyzer::execute (analyzer-pass.cc:48)
  └─ ana::run_checkers (engine.cc:4924)
     └─ impl_run_checkers(logger) (engine.cc:4762)
        ├─ 构建 region_model_manager mgr
        ├─ supergraph sg (supergraph.cc:141) ── 合并所有函数 CFG
        │    └─ populate_for_basic_block() (supergraph.cc:225) ── BB→supernode
        ├─ sg.fixup_locations() / sg.simplify() / sg.sort_nodes()
        ├─ make_checkers() (sm.cc:193) ── 实例化所有 state machine
        ├─ register_known_functions() ── kf.cc 的函数语义模型
        ├─ extrinsic_state ext_state(checkers, &eng) (program-state.h:30)
        ├─ analysis_plan plan(sg) (analysis-plan.cc)
        ├─ exploded_graph eg(sg, ext_state, purge_map, plan) (exploded-graph.h:789)
        ├─ eg.build_initial_worklist() (engine.cc:2959) ── 每个顶层函数加入口 enode
        ├─ eg.process_worklist() (engine.cc:3001) ── ★ 核心：探索 (point,state) 空间
        │    └─ process_node() (engine.cc:3393)
        │         └─ for each 后继 superedge: op->execute(op_ctxt)
        │              └─ add_outcome() (ops.cc:146) → get_or_create_node(dst) ── 去重/加边
        ├─ eg.detect_infinite_loops() (infinite-loop.cc)
        └─ eg.get_diagnostic_manager().emit_saved_diagnostics(eg) (diagnostic-manager.cc:1484)
```

`process_node`（`engine.cc:3393`）处理一个 enode 时：遍历 supernode 的所有后继 superedge，对有 `operation` 的边调 `op->execute()` 修改 `program_state` 并通过 `add_outcome()` 产生后继 `<point, state>` 对，`get_or_create_node()`（`engine.cc:2460`，含路径爆炸 mitigation）创建或复用后继 enode 并 `add_edge()`，新 enode 自动入队。

## 核心实现

### Supergraph：跨函数 CFG 合并

supergraph（`supergraph.h:95`）是 `digraph<supergraph_traits>`，把所有函数的 CFG 合到同一有向图。注释说明这是历史名称——现在所有边都是**过程内**（intraprocedural）的，不再含 callgraph 边。

构造分两遍（`supergraph.cc:141`）：

```cpp title="supergraph.cc — 两遍构造"
// 第一遍：每个 BB → supernode 序列
populate_for_basic_block(bb)  (supergraph.cc:225)
  为 BB 中每条语句创建一个 supernode，语句间用 superedge 连接
  BB 最后一条控制流语句（cond/goto/switch/call）不放在 node，而放在出边
  每个 BB 产生一个 initial snode（m_state_merger_node = true，用于 state merging）
  和一个 final snode
  m_bb_to_initial_node / m_bb_to_final_node 映射 BB → snode

// 第二遍：CFG 边 → superedge
add_sedges_for_cfg_edge()  (supergraph.cc:657)
  按 CFG edge 类型（true/false/switch/EH）创建对应 superedge
  edge 携带 operation 对象（gassign_op / gcall_op / control_flow_op）
```

函数调用**不**在 supergraph 显式建模为边，而是通过 `call_and_return_op`（`ops.h:432`）在 `operation::execute()` 中动态处理：它可产生 `interprocedural_call` 类型的 `custom_edge_info`，创建跨函数的 exploded edge。`call_string`（`call-string.h:43`）记录调用栈，确保返回到正确的 callsite——这是 path-sensitive 引擎处理跨函数的核心。

### program_state 与 program_point

`program_point`（`program-point.h:56`）= `(supernode, call_string)`，表示执行路径中的一个位置。`program_state`（`program-state.h:266`）是该位置的抽象状态：

```cpp title="program-state.h — program_state 组成"
class program_state {
  region_model *m_region_model;                          // (a) 内存区域模型
  auto_delete_vec<sm_state_map> m_checker_states;         // (b) 每 SM 一个 state map
  bool m_valid;
};
// (a) region_model (region-model.h:293) 含：
//     (a.1) region 层级（frame/globals/heap/stack/...）
//     (a.2) 每个 region 的 svalue（值）
//     (a.3) constraint_manager（等价类、约束）
// (b) sm_state_map (program-state.h:82)：
//     hash_map<const svalue *, entry_t> m_map;  // svalue → (state, origin)
//     state_machine::state_t m_global_state;    // 全局状态（如 taint 的 control-flow taint）
```

`program_state` 的 `hash()`（`program-state.cc:1034`）= `region_model::hash() ^ 各 sm_state_map::hash()`，`operator==` 要求 region_model 与所有 sm_state_map 都相等——用于 `exploded_graph` 的 `m_point_and_state_to_node` hashmap 节点去重：相同 `(point, state)` 复用同一 enode，这是缓解路径爆炸的关键。

### State Machine：可插拔 checker

`state_machine` 基类（`sm.h:67`）是 checker 的抽象。每个 checker 是一个子类，定义状态（不可变对象，SM 拥有）并 override 关键虚函数：

```cpp title="sm.h — state_machine 核心接口"
class state_machine : public log_user {
  class state { const char *m_name; unsigned m_id; };
  typedef const state *state_t;
  state_t m_start;                                          // 起始状态
  virtual bool on_stmt(sm_context&, const gimple*) const = 0;   // 模式匹配入口
  virtual void on_condition(sm_context&, const svalue*, tree_code, const svalue*) const;
  virtual bool can_purge_p(state_t) const = 0;             // 该状态可否被丢弃
  virtual std::unique_ptr<pending_diagnostic> on_leak(tree, ...) const;
};
class sm_context {                                          // sm 与引擎交互的桥梁
  virtual state_t get_state(tree var) = 0;
  virtual void set_next_state(tree var, state_t to, tree origin = NULL) = 0;
  void on_transition(tree var, state_t from, state_t to, ...);  // 便捷：if(cur==from) set(to)
  virtual void warn(tree var, std::unique_ptr<pending_diagnostic> d) = 0;
  virtual void on_custom_transition(custom_transition*) = 0;
};
```

注册在 `make_checkers()`（`sm.cc:193`）：

```cpp title="sm.cc — make_checkers 注册所有 checker"
std::vector<std::unique_ptr<state_machine>> make_checkers(logger *logger) {
  out.push_back(make_malloc_state_machine(logger));     // sm-malloc.cc — double-free/UAF/leak
  out.push_back(make_fileptr_state_machine(logger));    // sm-file.cc — FILE*
  out.push_back(make_fd_state_machine(logger));         // sm-fd.cc — fd
  out.push_back(make_taint_state_machine(logger));      // sm-taint.cc — taint
  out.push_back(make_sensitive_state_machine(logger));  // sm-sensitive.cc — 敏感数据
  out.push_back(make_signal_state_machine(logger));     // sm-signal.cc — 信号处理
  out.push_back(make_va_list_state_machine(logger));   // varargs.cc — va_list
  if (flag_analyzer_checker)
    out.push_back(make_pattern_test_state_machine(logger));  // sm-pattern-test.cc
}
```

### sm-malloc：double-free 检测示例

`sm-malloc.cc` 定义 malloc 的状态机（`sm-malloc.cc:67-88, 1849`）：`start → unchecked → nonnull → freed → stop`（还含 `null`/`non_heap`），状态携带 `deallocator_set` 支持 malloc/free、new/delete、fopen/fclose 等不同配对。

```cpp title="sm-malloc.cc — double-free 检测逻辑"
void malloc_state_machine::on_deallocator_call(sm_context &sm_ctxt,
                                                const gcall &call,
                                                const deallocator *d,
                                                unsigned argno) const {  // sm-malloc.cc:2423
  tree arg = gimple_call_arg(&call, argno);
  state_t state = sm_ctxt.get_state(arg);
  if (state == m_start || assumed_non_null_p(state))
    sm_ctxt.set_next_state(arg, d->m_freed);         // start → freed
  else if (unchecked_p(state) || nonnull_p(state))
    sm_ctxt.set_next_state(arg, d->m_freed);         // unchecked/nonnull → freed
  else if (state == d->m_freed) {                    // freed → 报告 double-free！
    sm_ctxt.warn(arg, std::make_unique<double_free>(*this, diag_arg, d->m_name));
    sm_ctxt.set_next_state(arg, m_stop);             // → stop
  }
}
```

`double_free` 诊断类（`sm-malloc.cc:920`）emit 时调 `ctxt.add_cwe(415)`（CWE-415: Double Free）并 `ctxt.warn("double-%qs of %qE", ...)`。

### Region Model：内存区域建模

基于论文 "A Memory Model for Static Analysis of C Programs"（`region-model.h:26`）。Region 层级（`region.h:88`）按内存空间组织：

```
region (symbol)
  space_region
    frame_region (RK_FRAME)        ── 函数栈帧
    globals_region (RK_GLOBALS)    ── 全局变量
    code_region (RK_CODE)           ── 代码段
    stack_region (RK_STACK) / heap_region (RK_HEAP)
  decl_region (RK_DECL)             ── 变量/SSA name
  field_region (RK_FIELD)           ── 结构体字段
  element_region (RK_ELEMENT)        ── 数组元素
  offset_region (RK_OFFSET)         ── 偏移（指针算术）
  heap_allocated_region / alloca_region / string_region ...
```

`svalue` 层级（`svalue.h`）建模值：`region_svalue`（指向 region 的指针）、`constant_svalue`、`unknown_svalue`、`poisoned_svalue`（use-after-free 的值为 "poisoned"）、`initial_svalue`、`unaryop_svalue`/`binop_svalue`、`conjured_svalue`（调用产生的符号值）、`widening_svalue`（widening 不动点）。

`store`（`store.h:922`）按 **cluster** 组织内存内容，每个 cluster 对应一个 base region，含 `binding_map`（concrete bit-range → svalue，或 symbolic key → svalue）。

### 诊断路径生成

`diagnostic_manager`（`diagnostic-manager.h:160`）的流程（`diagnostic-manager.cc:1484`）：

1. **保存**：分析中 checker 经 `sm_context::warn()` → `add_diagnostic()` 保存 `saved_diagnostic`（含 enode、SM、var、state、`pending_diagnostic`）。
2. **选最短路径**：`emit_saved_diagnostics()` 创建 `epath_finder`（基于 `shortest_paths`），对每个 saved_diagnostic 调 `calc_best_epath()` 在 exploded graph 上找从 origin 到诊断点的**最短路径**。
3. **构建 emission path**：`build_emission_path()` 遍历每条 edge，`add_events_for_eedge()` 生成 `checker_event` 序列（start/function_entry/call/return/state_change/warning）。
4. **剪枝**：`prune_path()` 去除与诊断无关的事件，只保留与 `sval`/`state` 相关的状态变化。
5. **发射**：`pending_diagnostic::emit()` 经 `diagnostic_emission_context` 调 GCC diagnostic 子系统（`warning_at` / `gcc_rich_location` 携带 `checker_path`），输出带可读路径的诊断。`pending_diagnostic_metadata` 添加 SARIF 属性（CWE）。

## 设计模式

| 模式 | 位置（文件:方法名） | 为什么用 |
|------|---------------------|----------|
| worklist 图探索 | `process_worklist` in `engine.cc:3001` | path-sensitive 分析天然是"扩展 (point,state) 空间"，worklist 是图遍历的标准载体 |
| 节点去重（hash & operator==） | `program_state::hash` in `program-state.cc:1034` | 相同 (point,state) 复用 enode，是缓解路径爆炸的第一道防线 |
| 策略模式（可插拔 checker） | `state_machine` + `make_checkers` in `sm.cc:193` | 加新 checker 不改引擎核心，经 `sm_context` 统一交互 |
| 模板方法（operation::execute） | `operation` in `ops.h:112`；`add_outcome` in `ops.cc:146` | 不同 gimple 语句的语义建模为 operation 子类，引擎统一调 execute |
| 不可变值对象（region/svalue） | `region`/`svalue` + `region_model_manager` | region/svalue 不可变且去重，hash 复用安全，状态复制即指针复制 |
| 访问者（pending_diagnostic::emit） | `pending_diagnostic` in sm-*.cc | 诊断文本与判定逻辑封装在各诊断子类，引擎只调 emit |

## 模块间交互

- **作为 IPA pass 接入**：`pass_analyzer`（`analyzer-pass.cc:48`）继承 `ipa_opt_pass_d`，注册在 `passes.def` 的 `all_regular_ipa_passes` 首位（`passes.def:165`）。`gate()` 检 `flag_analyzer`，`execute()` 调 `ana::run_checkers`。它**复用** IPA 阶段已编译好的 GIMPLE body（`cfun->gimple_body`/CFG）与调用图（`cgraph`），不修改它们。
- **与 GIMPLE**：analyzer 直接消费 GIMPLE 语句——`on_stmt_pre`（`region-model.cc:1698`）按 `GIMPLE_CODE` 分派（`GIMPLE_ASSIGN`→`on_assignment`、`GIMPLE_CALL`→`on_call_pre`、`GIMPLE_RETURN`→`on_return`，控制流语句 no-op）。它不跑 SSA 优化，但用 GIMPLE 的 SSA_NAME 作为 svalue 的来源之一。
- **与 diagnostic 子系统**：诊断经 `warning_at` / `gcc_rich_location`（携带 `checker_path`）输出，与 GCC 其他 warning 一致，可用 `-Wno-analyzer-*` 抑制。SARIF 属性（CWE）通过 `pending_diagnostic_metadata` 添加。
- **与调用图**：`call_and_return_op::execute`（`ops.cc:910`）处理跨函数调用，`call_string` 记录调用栈。`flag_analyzer_call_summaries`（`call-summary.cc`）启用 call summary 以避免对每个 callsite 都展开 callee——缓解路径爆炸。

## 扩展方式

- **加新 checker**：建 `gcc/analyzer/sm-xxx.cc`，实现 `class xxx_state_machine : public state_machine`——定义状态（`add_state`）、override `on_stmt()` 做模式匹配、定义诊断类（继承 `pending_diagnostic`）；末尾加 `make_xxx_state_machine(logger)` 工厂；在 `sm.cc:193` 的 `make_checkers()` 加 `out.push_back(make_xxx_state_machine(logger))`；在 `Makefile.in` 加规则。可参考 `sm-pattern-test.cc`（最简模板，3745 行）。
- **改 region model 建模**：新 region/svalue 子类在 `region.h`/`region.cc`/`svalue.h`/`svalue.cc` 加，更新 `region_model_manager`（`region-model-manager.h`）创建方法；改语句处理在 `region-model.cc` 的 `on_assignment`/`on_call_pre`/`on_stmt_pre` 加新 tree code 或调用模式；涉新内存布局改 `store.cc` 的 `binding_cluster`；涉新约束改 `constraint-manager.cc`。
- **加路径爆炸 mitigation**：调 state merging 改 `program_state::can_merge_with_p()`（`program-state.cc:1425`）与 `sm_state_map::can_merge_with_p()`，在 SM 实现 `maybe_get_merged_states_nonequal()` 允许非等状态合并；调 state purge 改 `state-purge.cc` 与 `program_state::prune_for_point()`（`program-state.cc:1274`）；调 enode 上限改 `analyzer.opt` 的 `param_analyzer_max_enodes_per_program_point`（默认 8）、`param_analyzer_supernode_explosion_factor`（默认 5）、`param_analyzer_max_recursion_depth`（默认 2）；加 call summary 改 `call-summary.cc` 在 `call_and_return_op::execute`（`ops.cc:910`）加 replay 逻辑。

> **为什么 path-sensitive 而非 path-insensitive**：double-free 只在特定路径上发生，path-insensitive 数据流合并不同路径状态后会丢失该信息，产生 false negative。代价是路径爆炸——GCC analyzer 用上述四类 mitigation（去重/合并/purge/summary）+ enode 硬上限把分析控制在可接受规模。
