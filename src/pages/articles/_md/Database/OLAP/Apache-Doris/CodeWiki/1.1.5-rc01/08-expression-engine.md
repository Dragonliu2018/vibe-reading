---
source:
  type: "源码解读"
  project: "Doris"
  url: "https://github.com/apache/doris"
title: "表达式引擎"
date: "2026-08-24T11:00:00+08:00"
category: [Database, OLAP, "Apache Doris", CodeWiki, "1.1.5-rc01"]
tags: ["Apache Doris", "exprs", "Expr", "AnyVal", "SlotRef", "AggFnEvaluator", "dlsym"]
description: "Doris 1.1.5 表达式引擎 exprs（legacy 行式）：Expr 树 get_*_val(TupleRow→AnyVal) 求值、SlotRef 快速路径、BinaryPredicate 宏展开 66 类、AggFnEvaluator UDA 五阶段、dlsym 函数加载。与 vec/exprs 向量化双轨。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/Apache-Doris/CodeWiki/1.1.5-rc01/00-overview)

---

## 模块定位

`be/src/exprs/`（~2.6 万行）是 1.1.5 的 **legacy 行式表达式引擎**（Impala 血统）：`Expr` 表达式树 + 标量函数 + 聚合函数求值器。与 `vec/exprs/`+`vec/functions/` 的向量化版本并存（双轨）。legacy 路径按 `TupleRow` 行求值返回 `AnyVal`（单值），向量化路径按 `Block` 列求值返回列索引——这是 1.x 双轨的核心差异。

## 模块架构

```
Expr (exprs/expr.h:60) ── 抽象基类
   ├─ ComputeFn = void*(*)(Expr*, TupleRow*) (:?) ── 行求值函数指针
   ├─ 12 个 get_*_val virtual: get_boolean_val(:100)/get_tiny_int_val(:101)/get_int_val(:103)/
   │   get_big_int_val(:104)/get_double_val(:107)/get_string_val(:108)/get_datetime_val(:111)/
   │   get_decimalv2_val(:112)/get_array_val(:113)... ── 默认全返 null, 子类 override
   ├─ prepare(:312)/open(:325)/close(:337) ── 生命周期
   ├─ _children (:363) / add_child(:122)/get_child(:123) ── 树结构
   ├─ _is_slotref(:359) / _node_type(:353) / _fn(:368) / _fn_context_index(:373)
   ├─ _vector_compute_fn(:380) ── 向量化尝试(未完成)
   └─ create_expr_tree(:168)/create(:180) static ── 从 TExpr 建树
       │
       ▼  子类
   SlotRef final (slot_ref.h:30) extends Expr ── 列引用
   ├─ get_value(:47) static ── 快速路径: offset 直接取 slot, 绕虚函数
   ├─ 12 get_*_val override ── 从 slot 读取转 AnyVal
   └─ _tuple_idx(:75)/_slot_offset(:76)/_null_indicator_offset(:77)/_slot_id(:78)
   │
   BinaryPredicate (binary_predicate.h:43) ── 宏展开 6 ops×11 types=66 类 +11 ForNull
   └─ from_thrift (:21) factory ── opcode(EQ/NE/LT/LE/GT/GE)×child_type 分派
   │
   ScalarFnCall (scalar_fn_call.h) ── 标量函数调用
   ├─ _scalar_fn (:110) void* ── dlsym 加载的函数指针
   └─ interpret_eval (:213) ── evaluate_children→AnyVal→reinterpret_cast<ScalarFnN> 按 arity 调
   │
   AggFnEvaluator (agg_fn_evaluator.h:46) ── UDA 五阶段
   ├─ AggregationOp: COUNT/MIN/MAX/SUM/AVG/NDV/SUM_DISTINCT/COUNT_DISTINCT/HLL_UNION_AGG/OTHER (:50)
   ├─ init(:119)/update(:120)/merge(:121)/serialize(:126)/finalize(:127)/get_value(:116)
   ├─ add static (:157) ── 批量
   ├─ _fn(:179)/_is_merge(:182)/_input_exprs_ctxs(:187)/_agg_op(:198)
   └─ _init_fn/_update_fn/_merge_fn/_serialize_fn/_finalize_fn (:226-232) ── dlsym 指针
        + _staging_input_vals(:217)/_staging_intermediate_val(:218) ── TupleRow↔AnyVal glue
```

## 调用链路

```
FE 下发 TExpr (Thrift)
  → Expr::create_expr_tree (expr.cpp:244)
    → create_tree_from_thrift (:276) ── 深度优先递归建树
      → create_expr (:307) switch(node_type):
          SLOT_REF → new SlotRef
          BINARY_PRED → BinaryPredicate::from_thrift (:21)
          FUNCTION_CALL → new ScalarFnCall
          ARITHMETIC_EXPR → ArithmeticExpr::from_thrift
          CASE_EXPR → new CaseExpr
    → new ExprContext(root) (:293)

ExecNode::prepare → Expr::prepare (expr.cpp:509) → ExprContext::prepare
  → Expr::prepare (:517) 递归 children → 子类 override (ScalarFnCall::prepare)
    → register_function_context (:72) → UserFunctionCache::get_function_ptr ── dlsym 加载符号

ExecNode 逐行求值:
  for each TupleRow:
    ExprContext::get_value(row) (expr_context.h:191)
      ├─ if (_root->is_slotref()) → SlotRef::get_value() ── 快速路径, 直接取 slot
      └─ else → Expr::get_*_val(context, row) ── 虚函数分派
           → 子类 override:
             ScalarFnCall::get_int_val → interpret_eval<IntVal> (:213)
               → evaluate_children (递归子 Expr→AnyVal)
               → reinterpret_cast<ScalarFnN>(_scalar_fn)(fn_ctx, ...args) ── 函数指针调
             EqIntValPred::get_boolean_val ── 比较两子 Expr 的 IntVal
             SlotRef::get_int_val ── 从 Tuple slot 读

聚合: AggFnEvaluator::add (agg_fn_evaluator.h:271)
  → update(fn_ctx, row, dst, _is_merge?_merge_fn:_update_fn) (:120)
    → update_or_merge (agg_fn_evaluator.cpp:665)
      → input_exprs_ctxs[i]->get_value(row) ── 递归 Expr 树取行值
      → set_any_val ── 转 AnyVal* 入 _staging_input_vals
      → reinterpret_cast<UpdateFnN>(fn)(fn_ctx, ...input_vals, staging_intermediate_val) (:713)
  → finalize (agg_fn_evaluator.h:281) → serialize_or_finalize (:260)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
| --- | --- | --- |
| `Expr.create_expr_tree` | 从 TExpr 建树 | 深度优先递归 |
| `SlotRef.get_value` | 取 slot 值 | 静态快速路径，绕虚函数 |
| `Expr.get_*_val` | 按类型求值 | 12 虚函数，子类 override |
| `ScalarFnCall.interpret_eval` | 调标量函数 | dlsym 指针按 arity reinterpret_cast |
| `AggFnEvaluator.update_or_merge` | UDA update/merge | staging TupleRow→AnyVal glue |
| `AggFnEvaluator.finalize` | UDA 输出 | serialize_or_finalize |

</details>

## 核心实现

### 按行求值 AnyVal

`Expr::get_*_val(ExprContext*, TupleRow*)`（`expr.h:100-113`）返回单值 `AnyVal`（带 `is_null` 标记，`udf/udf.h`）。**为什么**：继承 Impala 行式存储（`TupleRow`→`Tuple`→slot），表达式直接消费行式数据无需转换；`AnyVal` 内联 null 处理简化每行逻辑；适配谓词短路（`CompoundPredicate` AND/OR 第一子表达式 false 即跳过）与 join probe 逐行匹配。**代价**：虚函数开销大（每行每 Expr 一次）、branch predictor 不友好、无法 SIMD。

### legacy vs 向量化区别

| 维度 | legacy（`exprs/`） | 向量化（`vec/exprs/`） |
| --- | --- | --- |
| 数据单元 | `TupleRow`（单行） | `Block`（整列） |
| 返回值 | `AnyVal`（单值+is_null） | `result_column_id`（列索引） |
| 求值粒度 | 逐行 | 批量（batch 2048/4096） |
| 函数接口 | `ScalarFnN(FunctionContext*, const AnyVal&...)` | `IFunction::execute(Block&, size_t)` |
| 虚函数开销 | 每行 N 次 | 每批 N 次 |
| SIMD | 不友好 | 列式连续内存，友好 |

1.1.5 双轨并存：`Expr` 基类有 `_vector_compute_fn`（`:380`）与 `evaluate(VectorizedRowBatch*)`（`:82`）试图支持向量化，但 `evaluate()` 的 SlotRef 分支被注释（`return false`，`expr.h:468`），说明 legacy 向量化尝试未完成，真正向量化走 `vec/exprs/VExpr` 体系。

### 函数注册：dlsym + name mangling

无运行时注册表。BE 内置函数经 **C++ name mangling + dlsym**：FE `FunctionSet` 维护函数元数据（名→symbol），经 `TFunction` 下发；BE `ScalarFnCall::prepare` 调 `UserFunctionCache::instance()->get_function_ptr(_fn.id, symbol)`（`scalar_fn_call.cpp:78`）dlsym 加载（内置函数符号在 BE 二进制，外部 UDF 从 `.so`）；`SymbolsUtil::is_mangled()`/`mangle_user_function()` 处理符号名；`Expr::init_builtins_dummy()`（`expr.cpp:65`）调 `AggregateFunctions::init_null` 防链接器 strip 内置符号。聚合同理从 `_fn.aggregate_fn.init_fn_symbol` 等加载（`agg_fn_evaluator.cpp:202`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合 | `_children` + `add_child/get_child` in `expr.h:122,363` | 表达式树，递归求值统一 `get_*_val` |
| 模板方法 | `Expr::prepare/open/close` 子类须调父类 in `expr.cpp:517-539` | 基类先递归 children，子类扩展 |
| 工厂方法 | `Expr::create_expr` switch in `expr.cpp:307`；`BinaryPredicate::from_thrift` in `:21` | 按 node_type/opcode×type 创建子类 |
| 策略 | `ScalarFnCall._scalar_fn` 函数指针 dlsym in `scalar_fn_call.h:110` | 不同函数实现可互换，树结构不变 |
| 原型 | `Expr::clone` pure in `expr.h:73` | 多线程求值安全的线程私有副本 |

## 模块间交互

被 `exec/` 各 Node 调用：`OlapScanNode` 持 `_conjunct_ctxs` 过滤行（`olap_scan_node.cpp:555`）、构建 key range 下推；`HashJoinNode` 持 `_probe_expr_ctxs`/`_build_expr_ctxs`/`_other_join_conjunct_ctxs`（`hash_join_node.h:79-87`）probe 提取 join key；`AnalyticEvalNode`/`PartitionedAggregationNode` 调 `AggFnEvaluator::add`/`finalize`。依赖 `runtime`（TupleRow/Tuple/AnyVal）、`udf`（FunctionContext/AnyVal）、`catalog`（TFunction 间接）。

## 扩展方式

**新增标量函数**（如 `greatest(a,b)`）：`math_functions.cpp` 加静态方法 `DoubleVal greatest(FunctionContext*, const DoubleVal&, const DoubleVal&)`；FE `FunctionSet` 注册 symbol 元数据；BE 无需改 `ScalarFnCall`（dlsym 自动加载），仅确保 `init_builtins_dummy`（`expr.cpp:65`）引用了 `MathFunctions` 防符号 strip。**新增表达式类型**（如 `JsonExtractExpr`）：建 `exprs/json_extract_expr.h/cpp` 继承 `Expr` 实现 `clone()`+所需 `get_*_val` override；`expr.cpp:307` `create_expr` switch 加分支；Thrift `TExprNodeType` 加枚举。**新增聚合函数**：`aggregate_functions.h:37` `AggregateFunctions` 加 `init/update/merge/serialize/finalize` 静态方法；`AggFnEvaluator` 构造函数设 `_agg_op`（如 OTHER）；FE 注册 init/update/merge/finalize 的 symbol 名。
