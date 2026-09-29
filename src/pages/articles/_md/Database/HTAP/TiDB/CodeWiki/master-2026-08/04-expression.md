---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "表达式与向量化求值"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "向量化"]
description: "TiDB 表达式模块解读：VecExpr 按返回类型拆接口、functionClass/sig 两级函数注册、PbCode 下推协议与常量折叠"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/expression/` 定义表达式树（`Column`/`Constant`/`ScalarFunction`）并负责向量化求值。它被 planner（构建表达式、推断下推）与 executor（运行时求值）两方共用，还要能整体序列化成 `tipb.Expr` 下推到 TiKV/TiFlash——**同一份表达式代码在三个执行位置生效**是本模块一切设计的出发点。本快照的结构变化：聚合函数已从 `aggfuncs` 迁移为 `pkg/expression/aggregation/` 子包；求值上下文拆到 `exprctx`（BuildContext 与 EvalContext 分离）。

## 模块架构

```
pkg/expression/
├── expression.go          # Expression / VecExpr 接口定义
├── column.go constant.go scalar_function.go   # 三种叶子/组合节点
├── builtin.go             # funcs 注册表 + baseBuiltinFunc/builtinFunc 签名层次
├── builtin_*.go            # 每个函数族一个文件（math/string/time/...），行式 eval
├── builtin_*_vec.go        # 对应向量化实现 vecEvalXxx
├── builtin_vectorized.go   # vecEvalIntByRows 回退 + 列缓冲池
├── evaluator.go           # EvaluatorSuite：整列求值入口
├── constant_fold.go        # 常量折叠（unFoldableFunctions 排除非确定函数）
├── expr_to_pb.go           # PbConverter：表达式 → tipb.Expr（下推序列化）
├── infer_pushdown.go      # 下推黑名单（对应 mysql.expr_pushdown_blacklist）
├── exprctx/                # BuildContext / EvalContext 接口（解耦求值与构建）
└── aggregation/            # 聚合函数描述与实现（NewAggFuncDesc 等）
```

## 调用链路

构建链（AST → Expression）：

```
planner expressionRewriter.rewriteExprNode      pkg/planner/core/expression_rewriter.go:288
└─ rewriteFuncCall (:2845) → funcCallToExpression (:3002)
    └─ expression.NewFunction → newFunctionImpl   scalar_function.go:207
        ├─ funcs map 查 functionClass              builtin.go:659
        ├─ noopFuncs / typeInferForNull 检查
        ├─ fc.getFunction(ctx, args)               # 按参数类型分发 sig
        ├─ 构造 ScalarFunction{FuncName, RetType, Function: builtinFunc}
        └─ 可选 FoldConstant                      constant_fold.go:162
```

求值链（以 Int 为例）：

```
EvaluatorSuite.Run (evaluator.go)         # vecEnabled && expr.Vectorized() 逐列降级
└─ evalOneVec (chunk_executor.go:109)      # 按 FieldType.EvalType() dispatch
    └─ (*ScalarFunction).VecEvalInt        scalar_function.go:56
        └─ sf.Function.vecEvalInt(...)      # 具体签名实现，如
            (*builtinAbsIntSig).vecEvalInt  builtin_math_vec.go:609
            # 未实现向量化的 sig → vecEvalIntByRows (builtin_vectorized.go:86) 逐行回退
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `newFunctionImpl` in `scalar_function.go:207` | 查表构造函数 | 查不到先查 `extensionFuncs` 再报错 |
| `Vectorized()` | 声明是否可批处理 | 未实现的 sig 由框架行式回退，增量迁移友好 |
| `PbCode()` | 每个签名的下推协议号 | sig ↔ TiKV coprocessor 协议一一对应 |
| `HashCode` in `scalar_function.go:589` | 语义指纹 | plan cache 参数化识别依赖它 |

## 核心实现

### VecExpr：为什么按返回类型拆八个接口

`VecExpr`（`expression.go:129`）定义 `VecEvalInt/VecEvalReal/VecEvalString/VecEvalDecimal/VecEvalTime/VecEvalDuration/VecEvalJSON/VecEvalVectorFloat32`，签名统一为 `(ctx, input *chunk.Chunk, result *chunk.Column) error`。按返回类型拆分而不是统一 `Eval(interface{})` 的原因在 `chunk.Column` 的内部表示：**列式内存按类型存原生 Go slice**（`Int64s()`/`Float64s()`），拆开后求值直接写原生 slice——零装箱、无反射、SIMD 可用。行式 `Eval`（`expression.go:189` 中的 `Eval(ctx, row)`）仍保留用于常量折叠、PointGet 等单行场景。`EvaluatorSuite` 在 `Run` 里逐表达式判断：向量化可用走 `evalOneVec`，否则 `evalOneColumn`/`evalOneCell` 行式兜底——这让 600+ 个内置函数可以渐进式补向量化实现而不必一次性重写。

### functionClass / sig 两级注册

```go
// pkg/expression/builtin.go
var funcs = map[string]functionClass{...}   // :659 函数名 → functionClass
type baseBuiltinFunc struct {                // :51 模板方法基座
    args []Expression; tp *types.FieldType
    pbCode tipb.ScalarFuncSig                // 下推协议号
    childrenVectorized ...; bufAllocator columnBufferAllocator
}
// 一个函数名按参数类型分发多个 sig：
absFunctionClass.getFunction (builtin_math.go:119)
  → builtinAbsIntSig / builtinAbsUIntSig / builtinAbsDecSig / builtinAbsRealSig
```

两级结构让全局注册表只有一行/函数（控制表大小），类型重载分发下沉到 `getFunction`；每个 sig 内嵌 `baseBuiltinFunc` 复用参数获取、类型修正、clone。`pbCode` 使 sig 与 `tipb.ScalarFuncSig` 枚举一一对应——`expr_to_pb.go` 的 `PbConverter.scalarFuncToPBExpr`（:263）据此把整个表达式树序列化下推；TiKV 端按同样枚举实现求值。**改表达式语义必须两侧同步**，这也是下推黑名单（`DefaultExprPushDownBlacklist` in `infer_pushdown.go:41`，对应系统表 `mysql.expr_pushdown_blacklist`）存在的运维价值：出问题时可在线禁某函数下推而不改代码。

### 常量折叠与 DeferredExpr

`foldConstant` in `constant_fold.go:162` 在构建期把 `abs(3)` 直接折叠为 3；非确定函数（`now()` 等，见 `unFoldableFunctions`）不折叠。Plan cache 场景的微妙之处：`now()` 的求值时机必须是**执行时**而非缓存构建时，因此把这类表达式包成 `Constant.DeferredExpr`——`Constant` 表面仍是常量（保证 hash 稳定），求值时才触发真实计算。折叠失败时按 warning 数判断回退（`scalar_function.go:280` 附近，plan cache 需保守）。

### Collation 与 HashCode

每个节点内嵌 `collationInfo`（`Constant.Coercibility` in `constant.go:653`），字符串函数的 collation 推断在构建期完成（`collation.go`）。`HashCode`/`CanonicalHashCode`（`scalar_function.go:589`、`ExpressionsSemanticEqual`）用于两处：plan cache 判断"参数化后表达式是否等价"，binding/normalize 生成 SQL digest。`SafeToShareAcrossSession` 机制（`builtin.go:68` 注释）标记哪些表达式能进**跨会话共享**的缓存——`CorrelatedColumn` 因绑定外表行数据（`col.Data`）天然不可共享。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 注册表 | `funcs` map in `builtin.go:659` + `extensionFuncs` in `extension.go` | 内置函数与扩展函数（UDF/plugin）统一挂载点 |
| 模板方法 | `baseBuiltinFunc` in `builtin.go:51` | 公共行为（参数获取/类型修正）上提，sig 只写差异 |
| 批处理 | `EvaluatorSuite` + `localColumnPool`（sync.Pool 列缓冲） | 摊薄求值开销，列内存复用 |
| 组合 | `ScalarFunction` 持 `builtinFunc`、树形组合 | 接口稳定，实现可整体替换 |

## 模块间交互

被 planner 消费：`expressionRewriter`（构建）、`infer_pushdown.go`（下推推断）。被 executor 消费：`projection.go:81` 的 `EvaluatorSuite`、`expand.go` 等。与 types 模块的交接集中在 `types.Datum`（`Constant.Value`）与 `*types.MyDecimal`/Time 等具体类型。与 statistics 无直接依赖。**函数指针仍是解环工具**：statistics 与 planner 双向依赖的破解见 [02-planner](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/02-planner)，expression 自身无此问题（独立于上层）。

## 扩展方式

新增内置标量函数（概览场景 2）五步：函数名常量（`pkg/parser/ast/functions.go`）→ `funcs` 注册 → `builtin_xxx.go` 行式 sig → `builtin_xxx_vec.go` 向量化 + `vectorized()` → `setPbCode` 对接下推（需 tipb 仓库加枚举）。聚合函数改走 `aggregation/`：`NewAggFuncDesc` in `aggregation/descriptor.go:47`，实现 `baseAggFunc`。测试要点：`typeinfer_test.go`（类型推导黄金文件）、`builtin_xxx_vec_test.go`（行/向量一致性）。
