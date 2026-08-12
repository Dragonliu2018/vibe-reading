---
source:
  type: "源码解读"
  project: "FlashInfer"
  url: "https://github.com/flashinfer-ai/flashinfer"
title: "Trace 系统"
date: "2026-08-12T15:50:29+08:00"
category: [AI, Infra, Inference, FlashInfer, CodeWiki, "0.6.17"]
tags: ["FlashInfer", "torch.compile", "Trace", "PlanCapture", "Solution"]
description: "FlashInfer Trace 系统解读：TraceTemplate/Solution 模板-解决方案模式、plan_capture 捕获-重放、enable_apply monkey-patch、torch.compile 兼容。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FlashInfer/CodeWiki/0.6.17/00-overview)

---

## 模块定位

Trace 系统是 FlashInfer 为兼容 `torch.compile` 而设计的**桥接层**。核心矛盾：FlashInfer 的 attention API 是 plan/run 两阶段——`plan()` 做 host-side 规划和 JIT 编译，不能被 CUDA Graph / `torch.compile` 捕获；`run()` 依赖 plan 阶段缓存的索引数据和 `plan_info`，这些在 `torch.compile` 图中不可见。Trace 系统通过 `plan_capture`（在 plan 时 stash 状态、run 时恢复）+ `Solution`（可替换的 kernel 实现，绕过两阶段限制）解决这一矛盾。它还支持运行时 kernel 替换——通过环境变量加载外部 Solution 替换默认实现，用于实验新 kernel。

模块边界：trace 管"让 plan/run API 与 torch.compile 协调 + kernel 运行时替换"，不管 kernel 编译（在 jit）、不管调优（在 autotuner）。`trace/` 定义 schema（Template/Solution），`trace_apply/` 实现 apply（monkey-patch + plan_capture）。

## 模块架构

Trace 系统分三个抽象层：**TraceTemplate**（`trace/template.py:486`）描述操作的 schema（op_type、axes、inputs/outputs），独立于具体 Python 函数；**Solution**（`trace/solution.py:167`）是某 Definition 的具体实现（源码 + BuildSpec）；**Definition**（`trace_apply/config.py:71`）是 `definition_name`（由 Template 的 const axes 生成）关联两者的纽带。`trace_apply/apply.py` 的 `enable_apply` monkey-patch FlashInfer API，将调用路由到注册的 Solution；`plan_capture.py` 处理有状态 API 的 plan 阶段状态捕获。

`definition_name`（`template.py:638`）是 trace 收集和 apply 路由的**单一事实来源**——由 `name_prefix` + 每个 Const axis 的 abbrev + 值组成（如 `rmsnorm_h1536`、`gqa_paged_decode_h128_d128`）。trace 收集时用此名命名 JSON 文件，apply 时用此名查找 Solution。

## 调用链路

### Trace 收集（trace 阶段）

```
用户调用 API (如 BatchDecodeWithPagedKVCacheWrapper.run)
  ├── @flashinfer_api(trace=gqa_paged_decode_trace)  [decode.py:1809]
  │   └── _attach_fi_trace(wrapper, original, trace_template)  [api_logging.py:2190]
  │       ├── TraceTemplate.build_fi_trace_fn(fi_api)  [template.py:662]
  │       │   └── 返回 fi_trace(save_dir, name, **kwargs) 闭包
  │       ├── _TRACE_REGISTRY.append((original, template, label))  [api_logging.py:2234]
  │       └── wrapped.fi_trace = fi_trace_fn
  └── 用户调用 func.fi_trace(**kwargs)
      └── fi_trace 闭包  [template.py:674]
          ├── axis_extractors 提取 axis 值  [template.py:680]
          ├── 构建 axes/inputs/outputs JSON  [template.py:690]
          ├── definition_name(axis_values)  [template.py:781]
          ├── 嵌入 reference/check/init 源码  [template.py:796]
          └── 写入 JSON 文件  [template.py:812]
```

### Trace Apply（apply 阶段）

```
import flashinfer  [__init__.py:253]
  └── if FLASHINFER_TRACE_APPLY=1:
      └── trace_apply._enable_apply_from_env()  [apply.py:713]
          └── enable_apply(solutions=None)  [apply.py:569]
              ├── _solutions_from_env()  扫描 solutions/**/*.json → Solution.from_dict()
              ├── _registry_by_fi_api()  读 _TRACE_REGISTRY → {fi_api: (original, [templates])}
              └── 对每个匹配 API:
                  ├── if plan_capture.is_stateful(fi_api):  [apply.py:625]
                  │   ├── adapter = plan_capture.adapter_for(fi_api)
                  │   └── _make_plan_wrapper(plan_original)  [apply.py:379]
                  │       └── plan_capture.stash_plan_kwargs()  [plan_capture.py:108]
                  └── wrapper = _make_wrapper(...)  [apply.py:233]
                      setattr(owner, attr, wrapper)  ← monkey-patch

用户调用被 patch 的 API (如 wrapper.run(q, kv_cache))
  └── wrapper(*args, **kwargs)  [apply.py:256]
      ├── namespace = build_namespace(args, kwargs)
      │   ├── stateless: bind_namespace(original, args, kwargs)
      │   └── stateful: + plan_capture.augment_namespace()  [plan_capture.py:130]
      │       ├── 读 self_attrs (实例属性)  ← 优先路径
      │       └── 读 stashed plan kwargs
      ├── axes = extract_axes(extractor_maps, namespace)
      ├── name = template.definition_name(axes)
      ├── 查找 by_name[name]:
      │   ├── cache miss + CUDA stream capturing? → fallback to original  [apply.py:268]
      │   └── cache miss (normal): _resolve_name() → load_solution()  [apply.py:312]
      │       ├── python.load() → materialize + import
      │       └── cpp.load() → gen_jit_spec + build_and_load
      └── adapt.adapt_and_call(template, fn, namespace, ...)  [adapt.py:174]
          ├── build_candidate_kwargs() or ordered_input_values()
          ├── fn(**kwargs) or fn(*values)
          └── 输出适配: 复制到 dest buffer / 返回值
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `enable_apply` (`apply.py:569`) | 主入口，monkey-patch API | 幂等，返回包装数量 |
| `_make_wrapper` (`apply.py:233`) | wrapper 工厂 | 按 definition_name 路由 Solution |
| `adapt_and_call` (`adapt.py:174`) | 输入解析 + 输出适配 | 处理 value-returning / DPS / in-place |
| `stash_plan_kwargs` (`plan_capture.py:108`) | plan 时记录绑定参数 | WeakKeyDictionary |
| `augment_namespace` (`plan_capture.py:130`) | run 时合并 plan 状态 | self_attrs 优先于 stashed |
| `definition_name` (`template.py:638`) | 生成 Definition 名 | const axis abbrev+值，单一事实来源 |
| `load` (`loaders/__init__.py:32`) | 加载 Solution | 按 is_python_family 分发 python/cpp |

</details>

## 核心实现

### Template-Solution 模式

`TraceTemplate`（`template.py:486`）定义操作 schema：`op_type`、`axes`（`Var` 运行时可变 / `Const` 编译时常量）、`inputs`/`outputs`（`Tensor`/`Scalar` 描述符）。`_build_axis_extractors`（`template.py:577`）从 Tensor 的 `dim_names` 自动推导 axis 提取器。`Solution`（`solution.py:167`）是某 Definition 的具体实现，含 `BuildSpec`（语言/目标硬件/entry_point/binding）和 `SourceFile` 列表。`BuildSpec.is_python_family`（`solution.py:134`）区分 Python 族（import 加载，keyword 调用）与 C++/CUDA 族（编译加载，positional 调用）。两者通过 `definition_name` 关联——Template 生成名称，Solution 的 `definition` 字段匹配。这种分离使同一操作可有多个实现（Triton/CUDA/Python reference）。

### plan_capture 捕获-重放

Wrapper 的 `plan()`/`run()` 分离是核心设计，但与 torch.compile/CUDA graph 冲突。`plan_capture` 通过两种方式恢复 plan 阶段状态（`plan_capture.py:108-153`）：(1) **stash_plan_kwargs**（行 108）包装 `plan()` 方法，用 `WeakKeyDictionary` 记录每次 plan 调用的绑定参数（`indptr`/`indices`/`sm_scale`）；(2) **self_attrs**（行 143）直接从 wrapper 实例属性读取（如 `_paged_kv_indptr_buf`/`_sm_scale`），更健壮，能应对 SGLang 的 `fast_decode_plan` 等绕过公开 `plan()` 的快路径。`augment_namespace`（行 130）在 run() 时合并两种来源，优先用实例属性。`STATEFUL_ADAPTERS`（行 48-87）为每个有状态 API 定义 `plan_inputs`（plan 参数名→template input key）和 `self_attrs`（实例属性名→key）映射。

### enable_apply monkey-patch

`enable_apply`（`apply.py:569`）接收 `{definition_name: callable_or_Solution}` 映射，monkey-patch 所有匹配的 FlashInfer API。从 `_TRACE_REGISTRY`（`api_logging.py:2187`，`@flashinfer_api(trace=template)` 装饰器导入时注册）构建 `{fi_api: (original, [templates])}` 索引，对每个 API 包装。运行时 wrapper（`_make_wrapper`，`apply.py:233`）构建 namespace → 提取 const axes → 算 definition name → 查 Solution → `adapt_and_call`。**严格错误策略**（`apply.py:284`）：匹配的 Solution 若加载/运行失败**重新抛出**（非静默 fallback），只有真正未匹配或 CUDA graph 捕获期间未预热才回退原始 API——确保"注册了但坏了"的 Solution 不静默失效。

### 加载器分发

`load()`（`loaders/__init__.py:32`）按 `BuildSpec.is_python_family` 分发：`python.load`（`loaders/python.py:90`）materialize 源码到哈希命名缓存目录后 import；`cpp.load`（`loaders/cpp.py:35`）调 `flashinfer.jit.gen_jit_spec` + `build_and_load` 编译，通过 `TVM_FFI_DLL_EXPORT_TYPED_FUNC` 导出符号，`getattr(module, symbol)` 获取 callable。C++/CUDA 族 Solution 的源码经 JIT 编译，复用 jit 模块的 ninja/tvm_ffi 基础设施。

### 与 torch.compile 的关系

FlashInfer 的 plan/run 两阶段中，只有 `run()` 被 `@register_custom_op`（如 `decode.py:299`）注册为 torch custom op，可被 `torch.compile` 捕获；`plan()` 不注册（`decode.py:380` 注释明确说明）。trace_apply 是 Python 层 monkey-patch，在 custom op 之上运行时替换——不改变 torch.compile 图捕获行为，而是拦截 Python 调用路由到 Solution。当 `torch.cuda.is_current_stream_capturing()` 为真时（`apply.py:268`），wrapper 只走缓存路径不做首次解析，确保 CUDA graph 兼容性。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板-解决方案 | `TraceTemplate` + `Solution` in `template.py:486` / `solution.py:167` | schema 与实现分离，一操作多实现 |
| 捕获-重放 | `stash_plan_kwargs`/`augment_namespace` in `plan_capture.py:108/130` | 弥合 plan/run 两阶段与 torch.compile 矛盾 |
| 注册表-分发 | `_TRACE_REGISTRY` + `_registry_by_fi_api` in `api_logging.py:2187` / `apply.py:481` | 导入时注册，apply 时按 definition_name 分发 |
| 策略（加载器） | `load()` 按 is_python_family 分发 in `loaders/__init__.py:32` | Python 族 import vs C++ 族 JIT 编译 |
| Monkey-patch | `enable_apply` setattr in `apply.py:569` | 运行时替换 API，不改源码 |

## 模块间交互

trace 与 attention：`BatchAttention.run`（`_core.py:215`）标记 `@flashinfer_api(trace=batch_attention_run_trace)`，template 定义在 `trace/templates/attention.py:3204`，`op_type="gqa_paged"`。但 BatchAttention 的 run 未出现在 `STATEFUL_ADAPTERS`（`plan_capture.py:48`，注册的有 Decode/Prefill/Ragged/MLA 的 run）——其 trace_apply 可能走 stateless 路径，或 stateful 支持待核实。

trace 与 jit：C++/CUDA 族 Solution 通过 `flashinfer.jit.gen_jit_spec` 编译（`loaders/cpp.py:35`），复用 jit 的 ninja/tvm_ffi 基础设施。Solution 源码 materialize 到哈希命名缓存目录。FlashInfer 原生 API（如 `BatchDecodeWithPagedKVCacheWrapper`）也用 jit（`gen_batch_decode_module`），但通过 `@register_custom_op` 注册 torch custom op；trace_apply 是在 custom op 之上的 Python 层拦截。

## 扩展方式

让一个新算子支持 trace_apply：(1) 在 `flashinfer/trace/templates/` 新建文件定义 `TraceTemplate`（参考 `trace/templates/__init__.py:15` 指南），声明 axes（Var/Const）和 inputs/outputs（Tensor/Scalar）；(2) 算子定义文件用 `@flashinfer_api(trace=my_op_trace)` 装饰挂载；(3) 若是 plan/run 两阶段 API，在 `plan_capture.py:48` `STATEFUL_ADAPTERS` 加 `StatefulAdapter(plan_inputs, self_attrs)` 条目；(4) 若需 torch.compile 支持，用 `@register_custom_op` 注册 run()（注意 plan 不注册）；(5) 可选编写 reference/check 函数用于正确性验证；(6) 编写 Solution JSON（源码 + BuildSpec）放 `solutions/` 目录，通过 `FLASHINFER_TRACE_APPLY_PATH` 指定。
