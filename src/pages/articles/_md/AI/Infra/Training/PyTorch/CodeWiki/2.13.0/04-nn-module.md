---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "nn.Module 模块系统"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "nn.Module", "Parameter", "组合模式", "hook"]
description: "nn.Module 组合模式管理参数/子模块，__setattr__ 自动注册、_call_impl hook 编排、state_dict 序列化，PyTorch Pythonic 体验的核心。"
readingTime: "11 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

`torch.nn` 是 PyTorch 的神经网络模块系统，定义 `Module`/`Parameter`/`Layer` 容器体系，管理可训练参数、子模块、前向调用与 hooks。它是用户构建模型的主要接口——`nn.Linear`、`nn.Conv2d`、`nn.Sequential`、`nn.BatchNorm` 全部基于 `Module` 基类。

`nn.Module` 位于 Python API 层（蓝框），向下依赖 `Parameter`（`Tensor` 子类，参与 autograd）和 `Tensor` 操作（经 Dispatcher 执行），向上面向用户和 optimizer（`model.parameters()` → `torch.optim`）。它的核心设计是**组合模式 + 自动注册**：用户写 `self.conv1 = nn.Conv2d(...)` 即自动注册参数和子模块，无需手动声明——这是 PyTorch "Pythonic" 体验的关键。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  Module (module.py:407)                                       │
│  _parameters: dict[str, Parameter]    ← 可训练参数注册表       │
│  _buffers: dict[str, Tensor]          ← 非参数状态(BN running) │
│  _modules: dict[str, Module]          ← 子模块(组合树)         │
│  _forward_hooks / _forward_pre_hooks ← 观察者                  │
│  forward: Callable = _forward_unimplemented  ← 模板方法占位    │
└──────┬───────────────────────────────────┬───────────────────┘
       │ __setattr__ 自动注册              │ _call_impl 编排
       ▼                                   ▼
┌───────────────┐    ┌──────────────────┐  ┌─────────────────────┐
│ Parameter     │    │ Sequential /     │  │ hook 链              │
│ (Tensor 子类) │    │ ModuleList /     │  │ pre → forward → post │
│ requires_grad │    │ ModuleDict       │  │ backward hook        │
│ = True 默认   │    │ (组合容器)        │  │ state_dict hook      │
└───────────────┘    └──────────────────┘  └─────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  state_dict / load_state_dict                                 │
│  OrderedDict + key 前缀(prefix+name+".")编码模块树路径          │
│  _save_to_state_dict → _load_from_state_dict (递归)            │
└──────────────────────────────────────────────────────────────┘
```

`Module` 通过三个 dict（`_parameters`/`_buffers`/`_modules`）作为命名注册表管理全部状态，`__setattr__` 检测赋值类型自动路由到对应 dict。`Parameter`（`parameter.py:30`）是 `Tensor` 子类，默认 `requires_grad=True`。组合容器 `Sequential`/`ModuleList`/`ModuleDict`（`container.py`）继承 `Module`，用 `_modules` 存储子模块。

## 调用链路

### 前向调用 `model(x)`

```text
model(x)
  │
  ▼
__call__ = _wrapped_call_impl          # module.py:1917, 1774
  │  优先用 _compiled_call_impl (torch.compile 产物)
  ▼
_call_impl                             # module.py:1782
  ├─ 无任何 hook？ → 直接 forward_call(*args) 快速路径  # :1786-1789
  ├─ forward_call = _slow_forward if tracing else self.forward  # :1783
  ├─ inner() 闭包：
  │    ├─ 收集 backward_pre_hooks / backward_hooks
  │    ├─ 遍历 _global_forward_pre_hooks + _forward_pre_hooks  ← 可改 args
  │    ├─ 若有 backward hook → BackwardHook.setup_input_hook
  │    ├─ result = forward_call(*args, **kwargs)                ← 实际计算
  │    ├─ 遍历 _global_forward_hooks + _forward_hooks           ← 可改 result
  │    └─ BackwardHook.setup_output_hook (若有)
  └─ except: always_call=True 的 forward hook 仍执行  # :1889-1912
```

### state_dict 收集

```text
state_dict()                           # module.py:2194
  ├─ destination = OrderedDict() + _metadata
  ├─ _save_to_state_dict(destination, prefix, keep_vars)  # :2143
  │    ├─ for param in _parameters: destination[prefix+name] = param.detach()
  │    └─ for buf in _buffers (非 non_persistent): destination[prefix+name] = buf.detach()
  ├─ for name, module in _modules:    # :2267
  │    module.state_dict(destination, prefix + name + ".", keep_vars)  ← 递归
  └─ 遍历 _state_dict_hooks → return destination
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `__call__`/`_wrapped_call_impl` | `module.py:1917` | 前向调用入口 | 优先 `_compiled_call_impl`（torch.compile） |
| `_call_impl` | `module.py:1782` | 编排 hook + forward | 无 hook 走快速路径，tracing 用 `_slow_forward` |
| `__setattr__` | `module.py:1971` | 自动注册 Parameter/Module/Buffer | 类型检测路由到对应 dict |
| `__getattr__` | `module.py:1954` | 从 dict 取回属性 | 配合 `__setattr__` 实现透明注册 |
| `parameters` | `module.py:2665` | 递归收集参数 | 经 `_named_members` 遍历 `named_modules` |
| `state_dict` | `module.py:2194` | 序列化状态 | OrderedDict + key 前缀编码树路径 |
| `_save_to_state_dict` | `module.py:2143` | 单模块状态提取 | detach 参数，跳过 non_persistent buffer |
| `load_state_dict` | `module.py:2530` | 恢复状态 | 递归 `_load_from_state_dict`，shape 校验 |
| `_apply` | `module.py:930` | device/dtype 转换 | 递归对子模块+参数+buffer 施加 fn |
| `register_parameter` | `module.py:628` | 注册参数 | 拒绝非 leaf Tensor（grad_fn 非空报错） |

</details>

## 核心实现

### `__setattr__` 自动注册

`__setattr__`（`module.py:1971`）检测赋值 value 类型自动路由：

```python title="torch/nn/modules/module.py"
def __setattr__(self, name, value):
    if isinstance(value, Parameter):
        self.register_parameter(name, value)      # → _parameters
    elif isinstance(value, Module):
        modules = self.__dict__.get("_modules")
        modules[name] = value                      # → _modules
    elif params := self.__dict__.get("_parameters"):
        if name in params:                         # 已注册参数被覆盖
            ...
    else:
        super().__setattr__(name, value)           # 普通属性
```

设计决策（`module.py:1971`）：收益是用户写 `self.conv1 = nn.Conv2d(...)` 即自动注册，符合直觉、减少样板代码。代价是每次属性赋值都走类型判断——性能敏感路径（如 `__init__` 内部）用 `super().__setattr__()` 绕过（`:505` 注释）。`__getattr__`（`:1954`）配合实现从 dict 取回属性，`__delattr__`（`:2076`）从对应 dict 删除。

### `_call_impl` 与 hook 编排

`_call_impl`（`module.py:1782`）的核心是 hook 编排：

```python title="torch/nn/modules/module.py"
def _call_impl(self, *args, **kwargs):
    forward_call = self._slow_forward if torch._C._get_tracing_state() else self.forward
    # 无任何 hook → 快速路径直接调 forward_call
    if not (self._backward_hooks or self._forward_hooks or ...):
        return forward_call(*args, **kwargs)
    # 有 hook → inner() 闭包编排 pre → forward → post
    ...
```

设计决策：hooks 分 forward pre/post——pre-hook（`:1624`）可修改输入（如 quantization 插 observer），post-hook（`:1687`）可修改输出（如 profiler 采集 activation），分离使关注点正交。`always_call`（`:1694`）使 hook 在 forward 抛异常时仍执行（profiler 清理）。全局 hook（`register_module_forward_hook`，`:249`）存 `_global_forward_hooks`，`_call_impl` 中先遍历 global 再遍历实例（`:1833`）。

### state_dict 与序列化

`state_dict` 用 OrderedDict + key 前缀编码模块树路径：

```python title="torch/nn/modules/module.py"
# :2267  递归子模块时拼接前缀
for name, module in self._modules.items():
    module.state_dict(destination, prefix + name + ".", keep_vars)
```

设计决策（`:2256`）：前缀 `prefix + name + "."` 生成如 `layer1.0.conv1.weight` 的 key，保证全局唯一且与 `load_state_dict` 的 `get_submodule(target)` 路径一致。OrderedDict 保证序列化顺序稳定（模型结构不变时 state_dict 逐字节一致），对 checkpoint diff 和分布式加载至关重要。`_metadata`（`:2258`）携带 `_version` 支持跨版本 BC 加载。`load_state_dict`（`:2530`）内部 `load()` 闭包（`:2584`）递归调 `_load_from_state_dict`（`:2345`），逐 key 做 shape 校验后 `param.copy_(input_param)`。

### Parameter 作为 Tensor 子类

`Parameter`（`parameter.py:30`）继承 `torch.Tensor`，metaclass `_ParameterMeta` 重写 `__instancecheck__`：

```python title="torch/nn/parameter.py"
class Parameter(torch.Tensor, metaclass=_ParameterMeta):
    def __new__(cls, data=None, requires_grad=True):
        return torch.Tensor._make_subclass(cls, data, requires_grad)
```

设计决策：`Parameter` 是 Tensor 子类而非包装器——它直接参与 autograd 图（默认 `requires_grad=True`），可像 Tensor 一样运算，同时被 `Module.__setattr__` 识别注册。`register_parameter`（`module.py:628`）拒绝非 leaf Tensor（`param.grad_fn` 非空报错），保证参数是梯度源头。`UninitializedParameter`（`:204`）用于 LazyModule，shape 未知时禁止访问。`Buffer`（`:249`）同样继承 Tensor，带 `persistent` 属性控制是否序列化。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 组合模式 | `_modules` dict 树（`module.py:455`） | Module 树形组合，`parameters()`/`train()` 递归 |
| 注册表 | `_parameters`/`_buffers`/`_modules` dict | 命名注册，自动收集 |
| 模板方法 | `forward = _forward_unimplemented`（`:526`） | 子类必须 override forward |
| 观察者 | forward/backward/state_dict hooks | 可插拔扩展，RemovableHandle 管理生命周期 |
| 元类 | `_ParameterMeta`（`parameter.py`） | `isinstance` 识别自定义 Tensor 子类为 Parameter |

## 模块间交互

- **Parameter → autograd**：Parameter 是 Tensor 子类，默认 `requires_grad=True`，`grad_fn` 参与 autograd 图。
- **Module → optimizer**：`parameters()`（`:2665`）递归收集所有 `_parameters`，直接传 `torch.optim.Optimizer(model.parameters(), lr=...)`。
- **Module → torch.save/load**：`torch.save(model.state_dict())` 序列化 OrderedDict；`torch.load` 后 `model.load_state_dict(sd)` 恢复。Parameter 的 `__reduce_ex__`（`parameter.py:88`）用 `_rebuild_parameter` 重建。
- **Module → device/dtype**：`_apply`（`:930`）递归对子模块+参数+buffer 施加 `fn`（`.cuda()`/`.float()`/`.to()`）。
- **Module → fx/dynamo**：fx 追踪 `Module`，`GraphModule` 是 `Module` 子类；dynamo 捕获 `Module.__call__`。

## 扩展方式

**新增 Layer**：继承 `Module`，`__init__` 中 `super().__init__()` + 注册 Parameter/子模块，override `forward`：

```python title="自定义 Layer 示例"
class MyLayer(nn.Module):
    def __init__(self, in_f, out_f):
        super().__init__()
        self.weight = nn.Parameter(torch.randn(out_f, in_f))  # __setattr__ 自动注册
    def forward(self, x): return x @ self.weight.T
```

**自定义 state_dict 序列化**：override `_save_to_state_dict`（`:2143`）或注册 `_state_dict_pre_hook`（`:2264`），如跳过特定参数或添加 extra state。

**加全局 hook**：`register_module_forward_hook(hook)`（`:249`）注册全局 forward hook，对所有 Module 实例生效。
