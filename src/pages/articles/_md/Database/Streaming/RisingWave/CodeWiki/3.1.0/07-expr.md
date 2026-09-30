---
source:
  type: "源码解读"
  project: "risingwave"
  url: "https://github.com/risingwavelabs/risingwave"
title: "Expr 表达式"
date: "2026-09-30T15:54:07+08:00"
category: [Database, Streaming, RisingWave, CodeWiki, "3.1.0"]
contentType: "CodeWiki"
tags: ["RisingWave", "Rust", "向量化", "UDF", "函数注册"]
description: "Expr 模块解读：#[function] 宏签名驱动代码生成、FUNCTION_REGISTRY 前后端单一真源、SIMD 向量求值、retractable 聚合与四种 UDF runtime"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Streaming/RisingWave/CodeWiki/3.1.0/00-overview)

---

## 模块定位

Expr 是表达式与函数的统一框架：~90 个文件的内建函数（标量/聚合/表函数/窗口）、外部 UDF（Arrow Flight 的 Python/Java/JS server）、嵌入式 UDF（Python/Wasm/QuickJS）、AI 函数（OpenAI embedding）全部走同一套 trait 与注册表。它的核心价值是**签名单一真源**——frontend 的类型推断和 backend 的求值构建查的是同一份 `FUNCTION_REGISTRY`。

注意一个版本事实：v3.1.0 不存在独立的 `eval.rs`——向量式求值已内联为 trait 的 `eval/eval_v2/eval_row` 方法，重构为 Sync/Async 双轨。

## 模块架构

```text
src/expr/
├── macro/     # proc-macro crate：#[function] #[aggregate] #[build_function]
├── core/      # risingwave_expr：trait + FUNCTION_REGISTRY + 构建 + UDF 抽象
│   └── src/{expr/ aggregate/ table_function/ window_function/ sig/ expr_context.rs}
└── impl/      # risingwave_expr_impl：~90 文件函数实现 + udf/{external,python,wasm,quickjs}
```

核心 trait 三件套（core/src/expr/mod.rs）：

```rust
// mod.rs:73 —— 同步表达式（绝大多数内建函数）
pub trait SyncExpression: ExpressionInfo {
    fn eval_v2(&self, input: &DataChunk) -> Result<ValueImpl>;  // 返回数组或"全同标量"
    fn eval_row(&self, input: &OwnedRow) -> Result<Datum>;       // 行式求值
}
// mod.rs:255 —— 异步表达式（UDF/AI 函数）
pub enum BoxedExpression {
    Sync(Arc<dyn SyncExpression>),
    Async(Arc<dyn AsyncDynExpression>),  // async trait 的 object-safe 适配器
}
```

## 调用链路

plan → build → eval：

```text
SQL → frontend ExprNode (prost)
 ├ 类型推断：infer_type_with_sigmap(func_name, inputs, &FUNCTION_REGISTRY)   frontend/expr/type_inference/func.rs:90
 │  （frontend 与 backend 查同一份注册表！）
 ▼ plan 下发到 compute
build_from_prost(prost) → BoxedExpression                core/src/expr/build.rs:39
 └ ExprBuilder::build_inner 按 RexNode 分派：
    InputRef/Constant/Udf/FuncCall
    └ FuncCallBuilder → FUNCTION_REGISTRY.get(func, &args, &ret_type)
       → desc.build_scalar(ret_type, children)   // #[function] 宏生成的闭包
 └ 每节点 wrap：Checked → [NonStrict if 非严格模式]    build.rs:102
 ▼ executor 求值（向量式，整 chunk 一次）
batch: batch/executors/src/executor/project.rs:58
stream: stream/src/from_proto/project.rs 等 20+ 处
```

用户函数本体只需一个普通 Rust 函数（`impl/src/scalar/arithmetic_op.rs:23`）：

```rust
#[function("add(*int, *int) -> auto")]
#[function("add(decimal, decimal) -> auto")]
pub fn general_add<T1, T2, T3>(l: T1, r: T2) -> Result<T3> where ... { ... }
```

`#[function]` 宏为它生成 `SyncExpression` 实现 struct、build 闭包、以及 `#[linkme::distributed_slice(FUNCTIONS)]` 注册项——**注册零手工步骤**，impl crate 被链接进二进制，linkme 就把签名收进 FUNCTIONS 切片。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
|------|---------|---------|
| `build_from_prost` in build.rs:39 | proto→表达式树 | Checked/NonStrict 包装 |
| `FUNCTION_REGISTRY.get` in sig/mod.rs | 签名精确匹配 | backend 查不到 = frontend bug |
| `eval_v2` in expr/mod.rs:73 | 向量求值 | ValueImpl 数组/标量二象性 |
| `AggregateFunction::update` in aggregate/mod.rs:39 | 聚合更新 | StreamChunk 批量 |
| `encode_state/decode_state` in aggregate/mod.rs | 状态序列化 | 进 state table |
| `find_udf_impl` in sig/udf.rs | UDF runtime 分发 | distributed_slice 注册 |

</details>

## 核心实现

### 宏自动 SIMD：null 处理与计算分离

`#[function]` 对"纯函数"（非 async、无 writer、返回裸 T）且 primitive 类型生成 `raw_iter().zip().map()` + `from_iter_bitmap(..., a0.null_bitmap() & a1.null_bitmap())`——**null bitmap 按位与提前算好，循环体内零分支零 null 检查**。非纯函数回退到逐行 `value_at_unchecked` + builder.append。

### 签名注册表：前后端单一真源

`FuncSign`（sig/mod.rs:199）里 `type_infer` 函数指针给 frontend 推断返回类型，`FuncBuilder` 闭包给 backend 构建表达式——一份签名两处消费。backend 查不到签名时的报错注释直说"这应该是 frontend 类型推断的 bug"（sig/mod.rs:118）。`deprecated` 标志实现向后兼容：旧签名 backend 保留、frontend 不可见。

### retractable 聚合：增量计算与流式回撤的桥

流式聚合在回撤（UpdateDelete）场景必须能"减掉"已聚合的值，但 `string_agg/array_agg` 等不可逆聚合只能 append-only。注册时同签名两个 builder 合并存一条 `FuncSign`，executor 按上游是否有回撤选版本（`build(agg, prefer_append_only)`）。宏层面用户只写 `fn sum(state, input, retract: bool)`（general.rs:18）——**retract 是一个普通 bool 参数，有它即 retractable**。`AggregateState::{Datum, Any}` 区分：简单聚合（sum）状态直接是可编码 Datum 进 state table；复杂聚合（approx_count_distinct）用自定义 struct + downcast。

### Sync/Async 双轨 + 降级

async 函数（UDF、AI 函数）若统一走 async trait，纯算术树每行每层都要 poll Future。宏生成时优先构建 sync 版本（`try_into_sync_exprs` 成功就直接返回 sync struct），只有子树混入 async 节点才整体落回 async——`AsyncDynExpression` 解决 async trait 不 object-safe 的问题。

### Strict/NonStrict wrapper：一行 1/0 不崩整条流

chunk 级求值收集 `ExprError::Multiple(array, errors)`；NonStrict 包装器把它降级为"错误行置 NULL + LogSuppressor 限频上报"。用类型参数 `R: EvalErrorReport`（`!` 类型表示严格模式）实现零开销分派——batch 默认 strict、stream 恒 non-strict。

### UDF 与内建统一到 Arrow RecordBatch

所有 UDF runtime 只实现 `call(&RecordBatch) -> RecordBatch`（`trait UdfImpl` in sig/udf.rs:130），与内部 DataChunk 的转换集中在 `UdfArrowConvert`。`UdfImplDescriptor{match_fn, create_fn, build_fn}` 三段式：create_fn 在 frontend DDL 时连 server 验签名、build_fn 在 backend 构造 runtime、语言识别用 match_fn + distributed_slice 注册——**加语言零中心改动**。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| proc-macro 签名驱动 | `#[function]` in macro/src/lib.rs:424 | 一行签名 = SQL 元数据 + Rust 代码 |
| linkme 注册表 | `FUNCTIONS`/`UDF_IMPLS` distributed_slice in sig/mod.rs:505 | 无中心化 mod 注册 |
| trait object + enum 双态 | `BoxedExpression::{Sync,Async}` in expr/mod.rs:233 | 统一入口 + 尽量 sync |
| Decorator | `Checked`/`NonStrict`/`Strict` in expr/wrapper/ | 错误语义逐节点包裹 |
| ValueImpl 二象性 | expr/value.rs:24 | 全 chunk 同值免物化 |

## 模块间交互

**↔ frontend**：类型推断查同一注册表（func.rs:90）；`CREATE FUNCTION` 走 `find_udf_impl(...)?.create_fn`（create_function.rs:170）在 DDL 时连 UDF server 校验。**↔ stream/batch**：`build_from_prost` 构建，聚合 `encode_state/decode_state` 配合 state table。**↔ connector/UDF server**：外部 UDF 走 Arrow Flight（gRPC）+ ginepo 负载均衡，`get_or_create_flight_client` 复用连接含重试退避。**↔ 运行时**：`define_context!` 宏生成 TIME_ZONE/FRAGMENT_ID/STRICT_MODE/VNODE_COUNT 四个 task-local 变量，函数签名写 `ctx: &Context` 即可获取。

## 扩展方式

**新增内建标量函数**：proto `expr.proto` 加 `FOO = xxx` 枚举值（函数名与 proto 名对应）→ `impl/src/scalar/foo.rs` 写 `#[function("foo(varchar) -> int4")] fn foo(s: &str) -> i32`——同步/async、SIMD、null 传播、注册全部宏生成，**frontend 零改动**。带 HTTP 客户端的复杂函数改用 `#[build_function]`（参照 ai_model.rs:361 的 async + prebuild 范例）。

**新增聚合函数**：简单可逆聚合 `#[aggregate("foo(int4) -> int8")] fn foo(state: i64, input: i32, retract: bool)`；状态类型非返回类型时加 `state = "..."`。复杂聚合用 impl 风格（accumulate/retract/merge/finalize 多方法）。

**新增 UDF 语言后端**：`impl/src/udf/xxx.rs` 实现 `UdfImpl` trait → 文件内 `#[linkme::distributed_slice(UDF_IMPLS)] static XXX: UdfImplDescriptor = ...`（参照 python.rs:22）→ `udf/mod.rs` 挂 mod + Cargo.toml 加依赖。frontend/batch/stream 均零改动。
