---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "逻辑优化器"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "Analyzer（语义合法）+ Optimizer（性能等价）两阶段 trait 注册表，ApplyOrder 递归控制与 fixpoint 收敛。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/optimizer` 对 `LogicalPlan` 做两阶段重写：**Analyzer**（`AnalyzerRule`，让计划合法，可改语义如类型 coercion）与 **Optimizer**（`OptimizerRule`，等价变换提升性能，不改结果集）。两阶段分离解决"先确保语义正确再优化"的依赖——Optimizer 的不变量校验依赖 Analyzer 已规整计划。规则以 trait object 注册，框架与规则解耦，新规则只需 `impl` 不改 Optimizer。

## 模块架构

```text
optimizer/
├── analyzer/                # Analyzer 阶段
│   ├── mod.rs              # AnalyzerRule trait + Analyzer struct（固定顺序单次执行）
│   └── rules/              # ResolveGroupingFunction、TypeCoercion 等
├── optimizer.rs            # OptimizerRule trait + Optimizer struct（多轮 fixpoint）
├── push_down_filter.rs     # 代表性规则：谓词下推
├── common_subexpr_eliminate.rs   # CSE（自主递归，apply_order=None）
├── eliminate_*.rs          # 一系列消除规则（join/filter/limit/outer_join/...）
├── simplify_expressions/   # 常量折叠/化简
└── plan_signature.rs       # LogicalPlanSignature（哈希签名，fixpoint 提前终止）
```

## 调用链路

由 `SessionState::optimize`（`session_state.rs:566`）编排，顺序固定：

```text
analyzer.execute_and_check(plan, config, callback)     # analyzer/mod.rs:126
  ├─ 校验 InvariantLevel::Always
  ├─ 若有 function_rewrites，插 ApplyFunctionRewrites 于所有规则前（先于 TypeCoercion）
  ├─ for rule in rules { new = rule.analyze(new, config)? }   # 固定顺序，失败即返回
  └─ 校验 InvariantLevel::Executable

optimizer.optimize(analyzed, config, callback)         # optimizer.rs:309
  ├─ 校验 InvariantLevel::Executable
  ├─ while pass < max_passes (默认 3):                  # 多轮 fixpoint
  │     for rule in rules:
  │       match rule.apply_order():
  │         Some(order) → new.rewrite_with_subqueries(&mut Rewriter{order,rule})  # 框架代递归
  │         None → rule.rewrite(new, config)             # 规则自递归
  │       assert_valid_optimization(new)                # schema 不变量校验
  │     若 LogicalPlanSignature 已出现过 → break        # 收敛提前终止
  └─ 校验 schema + Executable
```

## 核心实现

### OptimizerRule trait 与 ApplyOrder

```rust title="datafusion/optimizer/src/optimizer.rs:72"
pub trait OptimizerRule: Debug {
    fn name(&self) -> &str;
    fn apply_order(&self) -> Option<ApplyOrder> { None }
    fn rewrite(&self, plan: LogicalPlan, config: &dyn OptimizerConfig) -> Result<Transformed<LogicalPlan>> { … }
}
pub enum ApplyOrder { TopDown, BottomUp }
```

`apply_order` 决定递归方式：`Some(order)` 让框架用 `Rewriter`（impl `TreeNodeRewriter`）在 `f_down`/`f_up` 按 TopDown/BottomUp 自动遍历整棵 plan；`None` 让规则自递归。`rewrite` 返回 `Transformed<LogicalPlan>`（`transformed: bool` 标记是否改写）。`AnalyzerRule`（`analyzer/mod.rs:64`）对比：返回 `Result<LogicalPlan>` 不带"是否改写"标志，无 `apply_order`，固定顺序单次不迭代。

### PushDownFilter：框架代递归的 TopDown 规则

`PushDownFilter` 选 `Some(ApplyOrder::TopDown)`（`push_down_filter.rs:758`）——父 Filter 谓词要往子节点推，必须先处理父节点。`rewrite`（`:766`）遇到 `Filter` 节点时：`Filter→Filter` 合并谓词（`IndexSet` 去重）；`Filter→Join` 调 `push_down_all_join()` 把谓词分到 left_push/right_push/join_conditions/keep_predicates 四类（`:418`）。列归属判断由 `ColumnChecker`（`:200`）的 `is_left_only`/`is_right_only` 完成。

### CommonSubexprEliminate：自主递归（apply_order=None）

`CommonSubexprEliminate`（`common_subexpr_eliminate.rs:527`）返回 `None`，因 CSE 需将相邻 Window 节点成组处理，不适合框架简单 TopDown/BottomUp。`rewrite` 内用 `plan.map_children(|c| self.rewrite(c, config))` 手动递归（`:570`）。

### fixpoint 与签名去重

规则间存在交互——`PushDownFilter` 下推后 `EliminateOuterJoin` 可能因此把外连接转内连接，触发新下推机会。多轮 `max_passes`（默认 3，`ConfigOptions.optimizer.max_passes`）收敛。`LogicalPlanSignature`（`plan_signature.rs`，plan 哈希+节点数）检测一轮后 plan 是否变化，未变立即 break，避免无谓迭代。`skip_failed_rules` 支持容错：规则报错且开启跳过时用 clone 的 prev_plan 回退继续下一条。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Strategy | 每条 `OptimizerRule` impl，`Optimizer.rules: Vec<Arc<dyn OptimizerRule>>`（`:199`） | 规则独立可插拔 |
| Visitor/TreeNode | `Rewriter` impl `TreeNodeRewriter`（`:262`） | 框架代递归，减规则样板 |
| Registry | `Optimizer::new()`（`:222`）+ `SessionState::append_optimizer_rule` | 运行时动态注入 |
| Chain of Responsibility | `optimize` 内层 for 循环（`:335`） | 规则按序作用，上步输出喂下步 |

## 模块间交互

依赖 `expr`（LogicalPlan/Expr 重写）、`common`（TreeNode/Transformed/ConfigOptions/DFSchema）。被 `core` 调用——`SessionState` 持 `analyzer`/`optimizer` 字段（`session_state.rs:131`/`:137`），`SessionState::optimize`（`:566`）先 analyzer 后 optimizer；`SessionState` 自身 impl `OptimizerConfig` 传查询开始时间/配置/FunctionRegistry 给规则。与物理优化器区分：后者作用于 `ExecutionPlan`，在逻辑优化之后。

## 扩展方式

- **新增 OptimizerRule**：新建文件 impl `OptimizerRule`（`name`/`apply_order`/`rewrite`），`lib.rs` 加 `pub mod`，在 `Optimizer::new()`（`optimizer.rs:222`）按依赖顺序插入——顺序关键，注释标了大量约束（如 `PushDownFilter` 必须在 `PushDownLimit` 之后，`:241`）。
- **调整规则顺序**：改 `Optimizer::new()` 的 `rules` vec 顺序，检查注释中的依赖约束。
- **禁用规则**：全局在 `new()` 注释对应行；运行时用 `ConfigOptions` 配置项（如 `optimizer.filter_null_join_keys`，`:135`）在规则内检查 `config.options()` 决定是否执行，或用 `Optimizer::with_rules` 传入自定义子集。
