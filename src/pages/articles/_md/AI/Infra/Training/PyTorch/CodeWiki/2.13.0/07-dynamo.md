---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "TorchDynamo 图捕获"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "TorchDynamo", "torch.compile", "PEP 523", "guard"]
description: "torch.compile 前端：PEP 523 frame evaluation hook 捕获 Python 字节码，InstructionTranslator 转 FX Node，guard 缓存复用，graph break 换覆盖率。"
readingTime: "13 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

TorchDynamo（`torch/_dynamo`）是 `torch.compile` 的前端——通过 CPython frame evaluation hook（PEP 523）捕获 Python 字节码执行，构建 FX `Graph`，用 guard 决定是否复用缓存图。它是 PyTorch 2.x 编译栈的入口，取代了 TorchScript 前端对"Python 子集"语法的限制，对任意 Python 代码透明。

Dynamo 位于编译栈层（粉框），产出 FX `GraphModule` 经 `compile_and_call_fx_graph` 交给后端（默认 `AOTAutograd → Inductor`）。与 fx 的 `symbolic_trace` 不同，Dynamo 不靠 Proxy 拦截——它直接挂在 CPython 解释器的 frame eval 回调上，逐条解释字节码，用 `VariableTracker` 维护符号化栈/locals，把 side-effect 化的 op 转成 FX Node。这让它能处理 Proxy trace 无法跨越的 data-dependent 控制流（通过 graph break）。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  装饰层                                                        │
│  torch.compile(fn) → OptimizeContext → catch_errors_wrapper    │
│  → ConvertFrame.__call__                                       │
└──────────┬───────────────────────────────────────────────────┘
           │ __enter__ → set_eval_frame(callback)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  CPython Frame Hook (eval_frame.c:244)                        │
│  enable_eval_frame_shim → _PyInterpreterState_SetEvalFrameFunc│
│  (PEP 523)                                                     │
│  首次调用 fn(input) → shim → dynamo__custom_eval_frame         │
└──────────┬───────────────────────────────────────────────────┘
           │ 有 cache? → guard 检查
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Guard 快路径 (guards.py)                                     │
│  GuardManagerWrapper.root.check_nopybind (C++)                │
│  guard 全命中 → 跑 cached_code  ← 快路径                        │
│  未命中 → callback                                              │
└──────────┬───────────────────────────────────────────────────┘
           │ ConvertFrameAssert._compile
           ▼
┌──────────────────────────────────────────────────────────────┐
│  InstructionTranslator (symbolic_convert.py:5298)              │
│  step() 逐条取指 → dispatch_table[opcode](self, inst)          │
│  VariableTracker 维护符号化栈/locals                            │
│  CALL_FUNCTION → TensorVariable.call_function                  │
│    → output.create_node("call_function", fn, args)             │
└──────────┬───────────────────────────────────────────────────┘
           │ graph break / 完成
           ▼
┌──────────────────────────────────────────────────────────────┐
│  OutputGraph (output_graph.py:640)                            │
│  compile_subgraph → compile_and_call_fx_graph → backend(gm)    │
│  build_guards → 生成 guard                                     │
│  resume 函数 (graph break 后继续)                               │
│  → create_cache_entry 存入 extra_state                          │
└──────────────────────────────────────────────────────────────┘
```

装饰阶段只组装 `compile_fn`，真正编译发生在首次调用 `fn(input)` 时——CPython 调 shim → 检查 cache → guard 命中走快路径，未命中走 `InstructionTranslator` 逐条解释字节码生成 FX Node → `OutputGraph` 编译子图交后端 → 生成 guard 缓存。

## 调用链路

```text
torch.compile(fn) → _optimize_catch_errors (eval_frame.py:1476)
  → OptimizeContext.__enter__ → set_eval_frame(callback)
      → eval_frame_callback_set (eval_frame.c:43, TSS slot)
      → enable_eval_frame_shim (eval_frame.c:244)
          → _PyInterpreterState_SetEvalFrameFunc(dynamo_custom_eval_frame_shim)  # PEP 523
fn(input) → CPython 调 shim → dynamo__custom_eval_frame (eval_frame_cpp.cpp:343)
  ├─ extra_state 有 cache_entry? → GuardManagerWrapper.root.check (C++)
  │    ├─ guard 全命中 → 跑 cached_code (compiled graph)              ← 快路径
  │    └─ guard 未命中 → 落到 callback
  └─ callback = ConvertFrameAssert.__call__ (convert_frame.py:601)
       → _compile (convert_frame.py:1633) → compile_frame
           → trace_frame (convert_frame.py:888)
               → InstructionTranslator(...) (symbolic_convert.py:5298)
               → tracer.run() → step() 循环 (symbolic_convert.py:1556)
                   dispatch_table[opcode](self, inst)
                     CALL_FUNCTION → TensorVariable.call_function
                                    → output.create_node("call_function", fn, args)
                     遇 unsupported → step_graph_break (1580)
                       → compile_subgraph (output_graph.py:1925)
                           → compile_and_call_fx_graph (2704)
                               → backend(gm) [AOTAutograd → Inductor]
                           → 生成 guard (guards.py:4707 build_guards)
                           → 生成 resume 函数 (resume_execution.py)
                           → add_output_instructions (3379)
                       → 下一子图继续 trace
               → 返回 modified bytecode + CacheEntry
       → create_cache_entry (eval_frame_cpp.cpp:679) 存入 extra_state
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `enable_eval_frame_shim` | `eval_frame.c:244` | 注册 PEP 523 hook | 替换 interpreter eval func |
| `dynamo__custom_eval_frame` | `eval_frame_cpp.cpp:343` | frame 入口 | 先查 cache guard |
| `ConvertFrameAssert.__call__` | `convert_frame.py:601` | 编译回调 | catch errors 包装 |
| `_compile` | `convert_frame.py:1633` | 编译 frame | RestartAnalysis 最多 100 次 |
| `InstructionTranslator.step` | `symbolic_convert.py:1556` | 逐条解释字节码 | dispatch_table 派发 |
| `OutputGraph.compile_subgraph` | `output_graph.py:1925` | 编译子图 | graph break 切分 |
| `compile_and_call_fx_graph` | `output_graph.py:2704` | 交后端 | `compiler_fn(gm)` 跨边界 |
| `build_guards` | `guards.py:4707` | 生成 guard | 按 source 分派 handler |
| `GuardManagerWrapper.check` | `guards.py:266` | C++ guard 检查 | `root.check_nopybind` |
| `step_graph_break` | `symbolic_convert.py:1580` | graph break | 切子图 + resume |

</details>

## 核心实现

### PEP 523 Frame Evaluation Hook

`enable_eval_frame_shim`（`eval_frame.c:244`）替换 CPython 解释器的 `_PyInterpreterState_GetEvalFrameFunc`：

```c title="torch/csrc/dynamo/eval_frame.c"
// PEP 523: 替换 frame evaluator
_PyInterpreterState_SetEvalFrameFunc(dynamo_custom_eval_frame_shim);
```

设计决策（`eval_frame.c:244` 注释）：AST 静态分析无法获知运行时类型/shape；trace（如 fx `symbolic_trace`）无法处理 data-dependent 控制流且对非 pure 函数会重复执行。Frame hook 在真实执行时介入，能拿到 frame 的 `f_locals/f_globals/closure`，且对任意 Python 代码透明。代价：CPython 版本强耦合（`cpython_defs.c`、`IS_PYTHON_3_11_PLUS` 分支），每个 CPython 小版本可能需适配。

### InstructionTranslator 字节码解释器

`InstructionTranslator`（`symbolic_convert.py:5298`）是 tree-walking 字节码解释器：

```python title="torch/_dynamo/symbolic_convert.py"
class InstructionTranslator(InstructionTranslatorBase):  # :5298
    def step(self, inst):                        # :1556
        self.dispatch_table[inst.opcode](self, inst)
    # CALL_FUNCTION → TensorVariable.call_function
    #   → output.create_node("call_function", fn, args)
```

`dispatch_table` 按 opcode 索引 handler，`BytecodeDispatchTableMeta`（`:1213`）metaclass 自动注册 `def OPNAME(self, inst)` 方法到 table。`VariableTracker`（`variables/base.py:320`）维护符号化栈/locals，`TensorVariable.as_proxy()`（`variables/tensor.py:314`）把 tensor 变量转成 FX `Proxy`。这不是 JIT——它不生成机器码，而是把字节码"翻译"成 FX Node，后端再编译。

### Guard 缓存机制

`Guard`（`torch/_guards.py:253`）绑定一个 `create_fn`（如 `TYPE_MATCH`/`ID_MATCH`），`GuardBuilder`（`guards.py:1180`）遍历 sorted guards 分派到 handler 构建 `GuardManager` 树：

```python title="torch/_dynamo/guards.py"
class Guard:
    originating_source: Source
    create_fn: Callable[[GuardBuilderBase, Guard], None]  # 如 TYPE_MATCH
# GuardBuilder handlers:
#   ID_MATCH (2408)      — 对象身份
#   TYPE_MATCH (2201)    — 类型不变
#   TENSOR_MATCH (3458)  — dtype/shape/stride
#   DICT_VERSION (2267)  — dict mutation
#   SHAPE_ENV (3186)     — symbolic shape
```

设计决策（`guards.py:1180`）：运行时 C++ `GuardManagerWrapper.root.check_nopybind` 线性求值 guard 树；任一失败 → 重新走 callback 生成新 `CacheEntry`，挂在 `extra_state.cache_entry_map`（`eval_frame_cpp.cpp:618`）。`recompile_limit` 控制重编译上限避免爆炸。guard 检查在 C++ 侧做（`check_nopybind`）避免 Python 开销——这是 Dynamo 热路径（每次调用都查 guard）的关键优化。

### Graph Break 与 Resume

`step_graph_break`（`symbolic_convert.py:1580`）在遇到不可捕获指令时切子图：

```text
不可捕获指令 (Unsupported)
  → compile_subgraph (output_graph.py:1925)  编译当前子图
  → 生成 torch_dynamo_resume_in_* 函数 (resume_execution.py:61)
  → 下一子图继续 trace
```

设计决策（`:1580`）：牺牲单图完整性换取对任意代码（print、不支持的 builtin、data-dependent 分支）的覆盖率——用户无需重写代码即可享受部分加速。`fullgraph=False` 默认；`error_on_graph_break`/`fullgraph=True` 时改为抛错（`:1079`）。`ReenterWith`（`resume_execution.py:146`）重建 `with` 上下文，`ContinueExecutionCache`（`:328`）缓存 resume 字节码。

### Dynamic Shapes 支持

`ShapesSpec`（`eval_frame.py:829`）、`output_graph.shape_env`（`SymInt`/`ShapeEnv`）支持动态形状：

设计决策：guard 改为 symbolic（`SHAPE_ENV` guard 而非具体数值 `TENSOR_MATCH`），让同一编译图覆盖一个 shape 族，避免每个 batch size 重编译。代价：Inductor 生成更通用（更慢）的 kernel。`dynamic=None` 时由后端自动推断。这与 c10 的 `SymInt` 符号化形状底层对接。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| PEP 523 frame hook | `enable_eval_frame_shim`（`eval_frame.c:244`） | 真实执行时介入，对任意代码透明 |
| Tree-walking 解释器 | `InstructionTranslator.step`（`:1556`） | 逐条字节码→FX Node，dispatch_table 派发 |
| Guard-based caching | `GuardManager` 树 + C++ check（`guards.py:266`） | O(n) guard 检查复用编译图 |
| Graph break + resume | `step_graph_break`（`:1580`） | 牺牲完整性换覆盖率 |
| 符号化形状 | `shape_env` + `SymInt` | dynamic shapes 不重编译 |

## 模块间交互

- **Dynamo → fx**：产出的 `torch.fx.GraphModule` 经 `compile_and_call_fx_graph`（`output_graph.py:2704`）交给 `compiler_fn`，默认链路 `AOTAutograd → Inductor`。
- **Dynamo ↔ autograd dispatch**：tracing 时通过 `ProxyTorchDispatchMode`（`torch/fx/experimental/proxy_tensor.py`）把 `__torch_dispatch__` 重定向到 FX proxy；`GuardBuilder.FUNCTORCH_STACK_MATCH`（`guards.py:2502`）guard functorch 状态。
- **Dynamo ↔ nn.Module**：`Module.__call__` 优先用 `_compiled_call_impl`（`module.py:1774`，torch.compile 产物），Dynamo 捕获 `Module.__call__` 时走编译路径。
- **TorchFunctionMode**：被 guard（`TorchFunctionModeStackSource`，`guards.py:1657`）保证编译图运行时 function mode 一致。

## 扩展方式

**支持新字节码指令**：在 `InstructionTranslatorBase` 加 `def OPNAME(self, inst)` 方法；`BytecodeDispatchTableMeta`（`symbolic_convert.py:1213`）metaclass 自动注册到 `dispatch_table`。参考 `call_function`（`:1467`）。

**加 guard**：在 `GuardBuilder` 加 `def NEW_MATCH(self, guard)` 方法（仿 `ID_MATCH` `guards.py:2408`），在变量追踪处调 `self.output.guards.add(Guard(source, GuardBuilder.NEW_MATCH))`；`register_guard_check_spec`（`guards.py:1136`）注册 C++ 检查 spec。

**改 graph break 策略**：在 `break_graph_if_unsupported`（`symbolic_convert.py:1055`）或 `jump_graph_break`（`:764`）调整触发条件；`config.nested_graph_breaks` 控制嵌套子图。
