---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "torch.fx 图变换"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "torch.fx", "Proxy", "IR", "codegen"]
description: "Python 级符号追踪：Proxy 拦截捕获运行时语义、Node 五种 op 类型、GraphModule 生成真实 Python 代码，被量化/Dynamo/Inductor 复用。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

`torch.fx` 是 PyTorch 的 Python 级符号追踪与图变换框架。它把 `nn.Module` 转成可分析的 IR（`Node`/`Graph`/`GraphModule`），支持子图替换、算子融合、量化等 transform。与 TorchScript JIT 的 C++ IR 不同，fx 的 IR 全在 Python 层——节点是 Python 对象，codegen 产出真实 Python 源码——这让 transform 可以用纯 Python 编写和调试。

fx 位于 Python API 层（蓝框），依赖 `nn.Module` 作追踪对象（`GraphModule` 本身是 `Module` 子类），被量化栈（`torch.ao.quantization`）、Dynamo、Inductor 消费——`torch.compile` 产出的中间表示之一就是 fx `GraphModule`。它的核心价值是**Proxy 拦截**：用户代码"原样跑"，但所有 `torch.*`/`Tensor.*` 调用被 Proxy 拦截记录成 `Node`，无需 AST 解析即可捕获运行时语义。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  Tracer (_symbolic_trace.py:769)                              │
│  trace(root) → 用 Proxy 换占位参数 → root.forward(*proxies)   │
└──────────┬───────────────────────────────────────────────────┘
           │ 拦截 __call__/__torch_function__/__getattr__
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Proxy (proxy.py:600)                                         │
│  __getattr__ → Attribute (懒记 get_attr)                       │
│  __call__ → 记 call_method/__call__                            │
│  __torch_function__ → 拦截 torch.* / Tensor.*                  │
└──────────┬───────────────────────────────────────────────────┘
           │ Tracer.create_proxy → create_node
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Graph (graph.py:1311)  双向链表 + _Namespace                  │
│  create_node(op, target, args, kwargs) → Node 插入链表          │
│  python_code(root_module) → AST codegen                        │
│  lint() / eliminate_dead_code()                                │
└──────────┬───────────────────────────────────────────────────┘
           │ Node
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Node (node.py:238)  继承 C++ _NodeBase                         │
│  op: placeholder|call_function|call_module|call_method|        │
│      get_attr|output                                           │
│  target · args · kwargs · users · _input_nodes                 │
└──────────┬───────────────────────────────────────────────────┘
           │ GraphModule(root, graph)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  GraphModule (graph_module.py:511)  继承 nn.Module              │
│  graph.setter → recompile() → python_code → exec → forward     │
│  生成真实 Python 代码（可读/可 pdb/可二次编译）                  │
└──────────────────────────────────────────────────────────────┘
```

`Tracer` 用 `Proxy` 替换 Module 的输入参数，跑 `forward` 时 Proxy 拦截每次调用，经 `create_proxy`/`create_node` 把调用记录成 `Node` 插入 `Graph` 双向链表。追踪完成后 `GraphModule` 把 `Graph` codegen 成真实 Python 源码（`exec` 装到 `forward`），同时从原 Module 拷贝 `get_attr`/`call_module` 涉及的参数和子模块。

## 调用链路

```text
symbolic_trace(root)                      # _symbolic_trace.py:1361
  └─ Tracer().trace(root)                 # :769
       ├─ Graph(tracer_cls=Tracer)        # 建 IR 容器
       ├─ proxy_placeholder 用 Proxy 换占位参数
       └─ root.forward(*proxies)          # 真正跑用户代码
            │  每次 Proxy.__call__/__torch_function__/__getattr__
            ▼
       Tracer.create_proxy(kind,target,args,kwargs)  # proxy.py:340
         ├─ create_arg(args)  递归把 Proxy→Node、list→immutable_list  # :411
         ├─ create_node(...)  graph.create_node → Node 插入链表        # :215
         └─ return Proxy(node, self)
       └─ graph.output(return_val)        # 收尾 output 节点
  └─ GraphModule(root, graph)             # graph_module.py:545
       ├─ _copy_attr: 把 get_attr/call_module target 从 root 拷进 gm
       └─ graph.setter → recompile()      # :918
            └─ Graph.python_code("self")  # graph.py:2375  生成 Python 源码
            └─ exec → 装到 GraphModuleImpl.forward
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `Tracer.trace` | `_symbolic_trace.py:769` | 追踪入口 | Proxy 替换参数后跑 forward |
| `Tracer.create_proxy` | `proxy.py:340` | 创建 Proxy+Node | create_arg 递归解包 |
| `Tracer.create_node` | `proxy.py:215` | 插入 Node 到链表 | Graph 双向链表 |
| `Proxy.__torch_function__` | `proxy.py:757` | 拦截 torch.*/Tensor.* | 运行时语义捕获 |
| `Graph.python_code` | `graph.py:2375` | AST codegen | `_Namespace` 保名唯一 |
| `GraphModule.recompile` | `graph_module.py:918` | 生成可执行 forward | exec 真实 Python 代码 |
| `Node.replace_all_uses_with` | `node.py:693` | 替换节点 | 遍历 users 拷贝列表改 dict |
| `Graph.eliminate_dead_code` | `graph.py:2604` | 死节点消除 | 拓扑校验 |
| `Interpreter.run` | `interpreter.py:52` | 解释执行 Graph | 按 op 派发，可子类化 |

</details>

## 核心实现

### Node 的五种 op 类型

`Node`（`node.py:238`）的 `op` 字段五种类型对应 Python 的五种"取值/调用"形式：

```python title="torch/fx/node.py"
class Node(_NodeBase):          # node.py:238
    op: str   # placeholder|call_function|call_module|call_method|get_attr|output
    target: "Target"  # call_function→Callable；其余→str
    _input_nodes: dict["Node", None]  # 入边（ordered-set）
    users: dict["Node", None]         # 出边（谁用我）
    meta: dict[str, Any]              # pass 间元数据（如 shape）
```

设计决策（`node.py:247-264`）：五种 op 对应函数输入（placeholder）、属性取值（get_attr）、自由函数（call_function）、子模块调用（call_module）、方法调用（call_method）、返回（output）。每种 target 类型不同：`call_function` 是 `Callable`，其余是 `str`。这使 codegen 能直接 emit `self.linear(x)`/`torch.add(x, y)`/`x.relu()` 三种语法，且 `lint`（`graph.py:2524`）能按 op 校验 target 存在性。

### Proxy 拦截而非 AST 解析

`Proxy`（`proxy.py:600`）复刻 Tensor 接口：

```python title="torch/fx/proxy.py"
class Proxy:
    def __getattr__(self, k) -> "Attribute":      # :640  懒记 get_attr
    def __call__(self, *a, **k) -> "Proxy":       # :680  记 call_method/__call__
    def __torch_function__(cls, orig_method, ...):# :757  拦截 torch.* / Tensor.*
    # 运算符重载由 magic_methods 循环注入 (:921)
```

设计决策（`proxy.py:757`）：AST 只见语法不见语义——`nn.Module` 的 `__call__` 派发、`__torch_function__` 协议、`operator.add` 重载、`torch.nn.functional.linear` 难以从源码静态还原。Proxy 走真实 Python 调用链，捕获"运行时实际发生什么"。代价：数据依赖的控制流无法 trace（`to_bool`/`iter` 抛 `TraceError`，`proxy.py:492/503`）。

### GraphModule 生成真实 Python 代码

`GraphModule`（`graph_module.py:511`）继承 `nn.Module`，`recompile`（`:918`）生成可执行 forward：

```python title="torch/fx/graph_module.py"
@graph.setter
def graph(self, g): self._graph = g; g.owning_module=self; self.recompile()  # :669
def recompile(self): ... self._graph.python_code(root_module="self") ...     # :918
```

设计决策（`:918`）：生成真实 Python 代码而非解释执行，原因：(1) Python 解释器已是高性能 VM，免维护自己的执行器；(2) 生成的 `forward` 可读、可 `pdb`、可 `print(gm.code)`（`:906`）；(3) 可被 `torch.jit.script`/`torch.compile` 二次编译；(4) 改图后 `recompile()` 重生成，热路径零解释开销。`Interpreter`（`interpreter.py:52`）虽能跑但每节点一次 dict 查找+派发，慢于原生 Python，留作调试/部分求值。

### users 链表维护

`users` 与 `_input_nodes` 用 `dict[Node, None]` 作 ordered-set（`node.py:279/286`），在 C++ `_NodeBase.__update_args_kwargs`（`node.cpp:307`）维护：

每次 `node.args =`/`node.kwargs =` 赋值触发 `_update_args_kwargs(new_args, new_kwargs)`，先遍历旧 `_input_nodes` 从每个旧输入的 `users` dict 删自己，再单遍扫新 args/kwargs，对每个 Node x 执行 `self._input_nodes.setdefault(x)` + `x.users.setdefault(self)`（`node.cpp:337-339`）。`replace_all_uses_with`（`node.py:693`）遍历 `self.users` 拷贝列表调 `_replace_input_with`，避免迭代中改 dict。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Proxy / record-replay | `Proxy`（`proxy.py:600`） | 捕获运行时语义，AST 做不到 |
| Interpreter pattern | `Interpreter`（`interpreter.py:52`） | 按 op 派发，可子类化做 shape prop |
| AST codegen | `Graph.python_code`（`graph.py:2375`） | 生成可读可调试的真实 Python |
| Ordered-set dict | `users`/`_input_nodes`（`node.py:279`） | 去重且顺序稳定，C++ 维护 |

## 模块间交互

- **fx → nn.Module**：追踪对象是 `Module`，`GraphModule` 是 `Module` 子类，可被再次 trace / `torch.jit.script`。
- **fx ← 量化**：`torch.ao.quantization` 用 fx 图做 fusion/observer 插入。
- **fx ← dynamo/inductor**：dynamo 输出的 `GraphModule` 作为中间表示之一（`proxy_tensor.py` 传 `meta['val']`，`proxy.py:810`）。
- **C++ 加速**：`_fx_map_arg`/`_fx_map_aggregate`（`torch/_C`）做参数遍历；`_NodeBase`（`node.cpp`）把 `_update_args_kwargs`/链表指针下沉到 C++。

## 扩展方式

**写 fx pass 替换 op**：遍历 `gm.graph.nodes`，对目标 `call_function` 节点用 `node.replace_all_uses_with(new_node)`（`node.py:693`），再 `gm.graph.eliminate_dead_code()`（`graph.py:2604`），最后 `gm.recompile()`。子图替换用 `torch/fx/subgraph_rewriter.py` 的 `replace_pattern`。

**自定义 Tracer 支持新控制流**：子类 `Tracer`（`_symbolic_trace.py:263`），重写 `to_bool`/`iter`（`proxy.py:486/497`）返回具值而非抛错，或重写 `is_leaf_module`（`:476`）控制哪些子模块 inline；对不 traceable 的函数用 `torch.fx.wrap(fn)` 注册。
