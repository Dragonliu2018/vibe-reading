---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "Overview"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "C++", "Python", "深度学习框架", "编译栈", "自动微分"]
description: "PyTorch v2.13.0 源码架构解读：从 c10 核心库、ATen Dispatcher、Autograd 引擎、nn.Module、TorchScript JIT、torch.fx 到 TorchDynamo+TorchInductor 编译栈与分布式训练的全面 internals 拆解。"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v2.13.0 · **协议** BSD-3-Clause · **语言** C++17 / Python · **代码量** ~2.4M 行 · **仓库** [GitHub](https://github.com/pytorch/pytorch)

---

## 总览

### 项目简介

PyTorch 是一个 Python 优先的深度学习框架，提供两大核心能力：**GPU 加速张量计算**（类似 NumPy 但带强 GPU 后端）和**基于 tape 的动态自动微分**。v2.x 时代又叠加了 `torch.compile` 编译栈——通过 TorchDynamo 捕获 Python 字节码、TorchInductor 生成 Triton/C++ kernel，在不牺牲 eager 模式易用性的前提下获得编译优化收益。

PyTorch 的核心价值是"**eager first**"：张量运算即时执行、计算图动态构建、可随时 print/pdb 调试，这让它成为研究领域的事实标准。v2.13.0 是 2.x 系列的稳定版本，编译栈（Dynamo+Inductor）已成熟为默认加速路径，同时保留 TorchScript JIT 的序列化部署能力。

**项目边界**：PyTorch 负责张量计算、自动微分、模型构建、编译加速、分布式训练。不负责数据加载（`torchvision`/`torchdata`）、训练编排（`lightning`/`huggingface trainer`）、部署 serving（`torchserve`/`Triton`）——这些是生态库的职责。

### 功能矩阵

| 特性 | 实现文件 | 说明 |
|------|---------|------|
| 张量表示 | `c10/core/TensorImpl.h` | TensorImpl/Storage/intrusive_ptr 底层表示 |
| 算子分发 | `aten/src/ATen/core/dispatch/Dispatcher.h` | DispatchKey 位集 O(1) 分发 |
| 算子实现 | `aten/src/ATen/native/` | CPU/CUDA native kernel |
| 自动微分 | `torch/csrc/autograd/engine.cpp` | tape-based 反向 AD，多线程引擎 |
| 模型构建 | `torch/nn/modules/module.py` | Module/Parameter 组合系统 |
| 图变换 | `torch/fx/` | Python 级符号追踪与 transform |
| JIT 编译 | `torch/csrc/jit/` | TorchScript SSA IR + pass pipeline |
| 编译前端 | `torch/_dynamo/eval_frame.py` | PEP 523 frame hook 捕获 |
| 代码生成 | `torch/_inductor/` | Triton/C++ kernel codegen + fusion |
| 分布式 | `torch/distributed/` | ProcessGroup/DDP/c10d |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| C++17 | 核心 | c10/ATen/torch.csrc 底层实现 |
| Python | 核心 | 用户 API、fx、dynamo、inductor |
| CPython PEP 523 | 核心 | Dynamo frame evaluation hook |
| CUDA / ROCm / MPS | 可选 | GPU 后端 |
| NCCL | 可选 | 分布式 GPU 通信 |
| Triton | 核心 | Inductor GPU kernel 生成 |
| gloo | 可选 | 分布式 CPU 通信 |
| MKL / AVX | 可选 | CPU 算子加速 |
| CMake | 构建 | 跨平台编译系统 |
| codegen | 核心 | `native_functions.yaml` → ops 代码生成 |

### 版本历史

PyTorch 版本演进的关键里程碑：

- **v0.4**（2018）：Variable 与 Tensor 合并——`AutogradMeta` 挂到 `TensorImpl` 上，消除双层封装，这是当前架构的起点。
- **v1.0**（2018）：引入 TorchScript JIT（`torch.jit.script`/`trace`），SSA IR + GraphExecutor，支持序列化部署。
- **v1.10+**：functorch（vmap/grad 变换）合并入主仓，为后续编译栈铺路。
- **v2.0**（2022）：引入 `torch.compile`——TorchDynamo（PEP 523 frame hook）+ TorchInductor（Triton codegen），取代 TorchScript 前端成为默认加速路径。
- **v2.13.0**（2025）：编译栈成熟，AOTI（Ahead-of-Time Inductor）支持编译产物持久化部署；NVFuser 从主仓剥离为独立包；SymInt 符号化形状支持 dynamic shapes tracing。

## 快速上手

PyTorch 是 pip 安装的 Python 包，最简验证：

```bash title="安装与验证"
pip install torch --index-url https://download.pytorch.org/whl/cpu  # CPU 版
python -c "import torch; x = torch.randn(3,3); print(x @ x.T)"      # 矩阵乘法
```

`torch.compile` 加速验证：

```python title="torch.compile 示例"
import torch
model = torch.nn.Sequential(torch.nn.Linear(128, 64), torch.nn.ReLU(), torch.nn.Linear(64, 10))
compiled = torch.compile(model)                     # 默认 inductor 后端
x = torch.randn(32, 128)
out = compiled(x)                                    # 首次调用触发编译
print(out.shape)                                     # torch.Size([32, 10])
```

从源码构建（开发场景）：`git clone` 后 `pip install -e .`（需 CMake + ninja + CUDA toolkit，见 `pyproject.toml` 的 `[build-system]`）。

## 架构设计解析

### 系统架构

PyTorch 采用**五层分层架构**，从底层 C++ 基础到上层编译栈，依赖方向严格自顶向下：

![PyTorch 分层架构](/vibe-reading/images/articles/pytorch-internals/architecture.svg)

架构思想是**关注点分离 + 零开销抽象**：每层只依赖下层，下层不知道上层存在。c10 提供最基础的数据结构与抽象（张量是什么），ATen 提供算子与分发机制（张量怎么算），C++ 绑定层提供 autograd/JIT/distributed 的引擎实现，Python API 层提供用户友好的 Module/optimizer 接口，编译栈在顶层提供 `torch.compile` 加速。这种分层让用户可以选择在任意层级工作——研究者在 Python API 层写模型，性能工程师在编译栈调优，后端开发者在 ATen/c10 加新设备。

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|---------|----------------------|
| 编译栈/分布式 | `torch/_dynamo` `_inductor` `_functorch` `distributed` | 把 Python 模型编译成高效 kernel，多卡并行——v2.x 核心增值 |
| Python API | `torch/nn` `autograd`(PY) `fx` `optim` | 用户友好接口，Module 组合、optimizer、图变换 |
| C++ 绑定 | `torch/csrc/autograd` `jit` `distributed` `profiler` | autograd 引擎、JIT 编译器、分布式 C++ 实现 |
| ATen 算子库 | `aten/src/ATen` | Tensor 类型、native ops、Dispatcher 分发机制 |
| C++ 核心库 | `c10/` | TensorImpl/Storage/intrusive_ptr/DispatchKeySet 基础抽象 |

### 设计模式

PyTorch 在不同层使用不同设计模式，核心是**正交分发**与**分层解耦**：

| 模式 | 层 | 位置 | 为什么用 |
|------|----|------|----------|
| DispatchKey 位集分发 | ATen | `Dispatcher.h`/`DispatchKeySet.h` | 正交维度（设备×处理层）不类爆炸，O(1) 分发 |
| Intrusive refcounting | c10 | `intrusive_ptr.h` | 零分配引用计数，跨 C++/Python 语言边界 |
| Tape-based AD | autograd | `engine.cpp` | 前向透明记录，多线程反向 |
| 组合模式 | nn | `module.py` | Module 树形组合，自动注册 |
| PEP 523 frame hook | dynamo | `eval_frame.c` | 对任意 Python 代码透明捕获 |
| Scheduler-based codegen | inductor | `scheduler.py` | fusion + codegen 统一调度 |
| Backend 策略 | distributed | `ProcessGroup.hpp` | 同一 API 多 backend（NCCL/gloo） |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `TensorImpl` | 张量元数据（shape/stride/dtype/device） | intrusive_ptr 管理 | 持有 Storage、挂 AutogradMeta |
| `Storage` | 数据载体（DataPtr+size） | 跟随 TensorImpl | 多个 view 共享一个 Storage |
| `DispatchKeySet` | 张量身份位集（backend×functionality） | 跟随 TensorImpl | Dispatcher 据此寻址 kernel |
| `Node`（autograd） | 反向图节点，含反向公式 | 跟随反向图 | `next_edges_` 链成 DAG |
| `Module` | 神经网络模块容器 | 用户管理 | `_modules` 组合树 |
| `Graph`（JIT/fx） | 计算 IR | 编译期 | Node/Value 双向链表 |
| `SchedulerNode`（inductor） | fusion 调度单元 | 编译期 | 聚合成 FusedSchedulerNode |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|------------|---------|--------|---------|
| `AutogradMetaInterface` | `c10/core/TensorImpl.h:163` | `AutogradMeta`（libtorch） | `ConcreteAutogradMetaFactory`（`variable.cpp:151`） |
| `Allocator` | `c10/core/Allocator.h:180` | `CPUAllocator`/`NativeCachingAllocator` | `REGISTER_ALLOCATOR` 宏 |
| `Node`（autograd） | `torch/csrc/autograd/node.h` | `AddBackward`/`AccumulateGrad`/`PyNode` | codegen + `create_gradient_edge` |
| `Backend`（distributed） | `Backend.hpp:60` | `ProcessGroupNCCL`/`ProcessGroupGloo` | `Backend.register_backend` |
| `CommHookInterface` | `comm.hpp` | `AllReduceCommHook`/`PythonCommHook` | `register_comm_hook` |

## 代码目录

```text
pytorch/
├── c10/                    # C++ 核心库（86K 行）
│   ├── core/               #   TensorImpl/Storage/Device/DispatchKeySet/SymInt/Allocator
│   ├── cuda/               #   CUDACachingAllocator
│   └── util/               #   intrusive_ptr/ArrayRef/small_vector
├── aten/                   # ATen 算子库（656K 行）
│   └── src/ATen/
│       ├── core/           #   Tensor/TensorBase + Dispatcher/OperatorEntry/KernelFunction
│       ├── native/         #   native ops 实现（CPU/CUDA kernel）
│       └── templates/      #   codegen 模板
├── torch/
│   ├── csrc/               # C++ 绑定（1.7M 行 C++）
│   │   ├── autograd/       #   Autograd Engine + Node 体系
│   │   ├── jit/            #   TorchScript JIT（IR + GraphExecutor + passes）
│   │   ├── distributed/    #   c10d 通信（ProcessGroup/Reducer/NCCL）
│   │   └── dynamo/         #   PEP 523 frame hook C 实现
│   ├── nn/                 # Python API: Module/Parameter/Layer
│   ├── autograd/           # Python autograd（Function/grad_mode）
│   ├── fx/                 # torch.fx 图变换
│   ├── _dynamo/            # TorchDynamo 图捕获（122K 行）
│   ├── _inductor/          # TorchInductor 代码生成（250K 行）
│   ├── _functorch/         # AOTAutograd 分解与函数化
│   ├── distributed/        # 分布式 Python（DDP/ProcessGroup wrapper）
│   └── optim/              # optimizer
├── torchgen/               # codegen 工具
├── tools/                  # 构建脚本
└── test/                   # 测试
```

`torch/__init__.py`（3087 行）是 Python 入口，导入并组装全部子模块。`aten/src/ATen/native/native_functions.yaml` 是算子 schema 源——codegen 据此生成 `ops/*.h`、`RegisterCPU.cpp`、`RegisterCUDA.cpp`、`VariableType.cpp`。

## 模块地图

![PyTorch 模块依赖关系](/vibe-reading/images/articles/pytorch-internals/module-dependencies.svg)

模块间依赖方向：编译栈（dynamo→AOTAutograd→inductor）是一条水平管线，产出 kernel 供运行时调用；Python API 层（nn/autograd/fx）依赖 C++ 绑定层（autograd engine/JIT）；C++ 绑定层依赖 ATen Dispatcher；ATen 依赖 c10。分布式（DDP）横跨 Python API（包裹 Module）和 C++ 绑定（Reducer hook autograd）。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| c10 核心库 | 张量基础抽象 | `TensorImpl.h` | 定义"张量是什么"，零依赖底层 | [01-c10-core](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/01-c10-core) |
| ATen 算子库与 Dispatcher | 算子实现与分发 | `Dispatcher.h` | 定义"张量怎么算"，正交分发机制 | [02-aten-dispatcher](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/02-aten-dispatcher) · [Dispatcher 详解](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/02b-aten-dispatcher-key-dispatch) |
| Autograd 引擎 | 反向自动微分 | `engine.cpp` | tape-based AD，多线程 DAG 执行 | [03-autograd-engine](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/03-autograd-engine) |
| nn.Module 模块系统 | 模型构建 | `module.py:407` | 组合模式管理参数/子模块 | [04-nn-module](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/04-nn-module) |
| TorchScript JIT | 图编译与序列化 | `graph_executor.cpp` | SSA IR + pass pipeline，部署能力 | [05-torchscript-jit](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/05-torchscript-jit) |
| torch.fx 图变换 | Python 级 IR | `_symbolic_trace.py` | Proxy 追踪 + Python codegen | [06-fx-graph](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/06-fx-graph) |
| TorchDynamo 图捕获 | 编译前端 | `eval_frame.py` | PEP 523 hook 对任意代码透明 | [07-dynamo](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/07-dynamo) |
| TorchInductor 代码生成 | 编译后端 | `compile_fx.py:2685` | Triton/C++ kernel codegen + fusion | [08-inductor](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/08-inductor) |
| 分布式训练 | 多卡并行 | `distributed_c10d.py` | bucket 同步 + backend 抽象 | [09-distributed](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/09-distributed) |

> 模块间的动态调用顺序见运行时行为 > 核心运行流程。

## 运行时行为

### 启动流程

PyTorch 作为库被 `import torch` 加载，初始化发生在 `torch/__init__.py`：

```text
import torch
  → torch/__init__.py:3087 行
  → torch._C 初始化（libtorch.so 加载）
  → 注册 CPU/CUDA Allocator 到全局 allocator_array（REGISTER_ALLOCATOR）
  → Dispatcher 单例初始化，注册全部 aten op schema + backend kernel
  → VariableType_* kernel 注册到 Autograd dispatch key
  → c10d collective op 注册到 c10d::* dispatcher schema
```

对象装配：`torch.empty(3,3)` 触发 `GetAllocator(CPU)` 取 `CPUAllocator` → `allocate()` 返回 `DataPtr` → 构造 `StorageImpl` → `Storage` → `TensorImpl`（设 `key_set_=CPU|Dense`）→ `at::Tensor` 包装。用户 `nn.Linear` 构造时 `__setattr__` 自动注册 `Parameter`（Tensor 子类，`requires_grad=True`，`AutogradMeta` 懒加载）。

### 核心运行流程

PyTorch 运行时有三条核心链路：算子分发（eager 模式每次 tensor 运算）、编译管线（`torch.compile`）、反向传播（`backward`）。编译管线是 v2.x 的核心增值，它把 eager 模式的逐 op 解释执行转化为融合 kernel 批量执行。

![PyTorch 两条核心数据流](/vibe-reading/images/articles/pytorch-internals/data-flow.svg)

#### 算子分发：torch.add(a, b)

业务流程：Python 调用 → C++ binding → Dispatcher 按 DispatchKey 分发 → Autograd 记录反向图 → redispatch 到 backend kernel → 向量化计算。

文字描述：`torch.add` 经 codegen 生成的 `at::_ops::add_Tensor::call` 进入 `Dispatcher::call`（`Dispatcher.h:770`）。`DispatchKeyExtractor.getDispatchKeySetUnboxed` 从 tensor 参数的 `key_set_` OR 出 DispatchKeySet，`OperatorEntry::lookup` 用 `dispatchTable_[idx]` O(1) 取 `KernelFunction`。对 requires_grad 的 CPU tensor，先命中 `AutogradCPU` key——`VariableType::add` 构造 `AddBackward` Node 写入 `AutogradMeta`，再 `redispatch` 去掉 Autograd 位下钻到 `CPU` kernel。`TORCH_IMPL_FUNC(add_out)` 构造 `TensorIterator`（处理广播/类型提升），调 `add_stub`（`DispatchStub`）按 CPUID 选 AVX2/AVX512 向量化 kernel。

#### 编译管线：torch.compile(model)(x)

业务流程：装饰（注册 frame hook）→ 首次调用触发捕获 → 字节码转 FX Graph → guard 缓存 → AOTAutograd 分解 → Inductor 调度+codegen → 返回编译 callable。

文字描述：`torch.compile(fn)`（`__init__.py:2595`）→ `OptimizeContext.__enter__` 调 `enable_eval_frame_shim`（`eval_frame.c:244`）替换 CPython frame evaluator（PEP 523）。首次调用 `fn(input)` 时 shim 触发 `dynamo__custom_eval_frame`（`eval_frame_cpp.cpp:343`）——有 cache 则 C++ guard 检查，命中走快路径；未命中走 `ConvertFrameAssert._compile`（`convert_frame.py:1633`）。`InstructionTranslator`（`symbolic_convert.py:5298`）逐条解释字节码，`CALL_FUNCTION` 转 `output.create_node("call_function")` 生成 FX Node。遇不可捕获指令 `step_graph_break`（`:1580`）切子图 + 生成 resume 函数。`OutputGraph.compile_and_call_fx_graph`（`output_graph.py:2704`）把 FX GraphModule 交后端：`compile_fx`（`compile_fx.py:2685`）→ `aot_module_simplified`（joint graph 分解切 fw/bw）→ `GraphLowering`（FX Interpreter → IR）→ `Scheduler`（fusion 划分，`group_fn` 按 `(numel, rnumel)` 分类）→ `TritonKernel` codegen → `PythonWrapperCodegen` + `MemoryPlanner` → `CompiledModule`。编译产物存入 `CacheEntry`，后续同 shape 调用 guard 命中直接跑编译 kernel。

#### 反向传播：loss.backward()

业务流程：Engine 构造 GraphTask → 反向 BFS 标记依赖 → 多线程 ReadyQueue 拓扑执行 Node::apply → 梯度累积到 param.grad。

文字描述：`Engine::execute`（`engine.cpp:1294`）构造 `GraphTask`，`compute_dependencies`（`:1256`）反向 BFS 在 `exec_info_` 记录每个 Node 入边计数。`execute_with_graph_task`（`:1418`）push root 到 `ReadyQueue`，`thread_main`（`:518`）循环 pop（按 `sequence_nr` 堆排序保序）→ `evaluate_function`（`:1064`）执行 `Node::apply`（反向公式）→ 输出累加进下游 `InputBuffer`，依赖归零时 push 下游。叶节点命中 `AccumulateGrad`（`accumulate_grad.cpp:96`）写入 `variable.mutable_grad()`。per-device `ReadyQueue` 让多 GPU 反向并行，stream 亲和。

## 典型修改场景

#### 场景 1：新增一个 native 算子

在 `aten/src/ATen/native/native_functions.yaml` 加 schema（structured op 声明 `out`/`functional` 变体）；`native/MyOp.cpp` 写 `TORCH_META_FUNC`（构 TensorIterator）+ `TORCH_IMPL_FUNC`（调 `xxx_stub`）；`DECLARE_DISPATCH`/`REGISTER_DISPATCH` 接 backend kernel；codegen 自动生成 `ops/my_op.h`、`RegisterCPU.cpp` 并经 `TORCH_LIBRARY_IMPL(aten, CPU)` 注册到 `DispatchKey::CPU`。对应测试：`test/test_cuda.py` 等。

#### 场景 2：新增一个后端设备

在 `c10/core/DispatchKey.h` 的 `BackendComponent` enum 加 `NewBackendBit`，更新 `num_runtime_entries`/`EndOfRuntimeBackendKeys`；`DeviceType` 加枚举值；为新 key 注册所有算子的 fallthrough（否则 `lookup` `reportError`）；实现 `Allocator` 子类并 `REGISTER_ALLOCATOR`；为关键 op 实现该 backend 的 native kernel（`TORCH_LIBRARY_IMPL(aten, NewBackend, m)`）。对应测试：`test/test_newbackend.py`。

#### 场景 3：自定义编译 pass（Inductor fusion）

在 `torch/_inductor/scheduler.py` 的 `Scheduler._can_fuse`（`:7396`）或 `simd.py:2002 can_fuse` 加条件；特殊 reduction 组合参考 `MixOrderReduction`（`scheduler.py:204`）创建新 `FusedXxxReduction` 类实现 `can_fuse`+`can_fuse_with`；在 `Scheduler.codegen_node` 分发路径（`:9842`）加 `codegen_xxx` 方法。对应测试：`test/inductor/test_fusion.py`。

## 测试体系

```
test/
├── test_torch.py          # 核心张量 op 测试
├── test_autograd.py       # autograd 反向测试
├── test_nn.py             # nn.Module 测试
├── test_jit.py            # TorchScript JIT 测试
├── test_dynamo.py         # TorchDynamo 测试
├── inductor/              # Inductor 编译测试
│   ├── test_fusion.py
│   └── test_codegen.py
├── distributed/           # 分布式测试
│   ├── test_nccl.py
│   └── test_c10d_gloo.py
└── expect/                # expecttest 期望输出
```

| 代码层 | 测试类型 |
|--------|----------|
| c10/ATen native op | `test_torch.py` / `test_cuda.py` |
| autograd | `test_autograd.py` |
| nn.Module | `test_nn.py` |
| JIT | `test_jit.py` |
| Dynamo/Inductor | `test_dynamo.py` / `inductor/` |
| distributed | `distributed/` |

PyTorch 测试用 `expecttest`（期望输出比对）+ `hypothesis`（属性测试）。修改某层代码时，参照上表找对应测试优先阅读——很多 op 的 test 实际上是最好的"可执行文档"。

## 阅读源码推荐路线

- **第一遍：理解张量表示与算子分发**
  `c10/core/TensorImpl.h`（TensorImpl 字段）→ `c10/util/intrusive_ptr.h`（refcount 机制）→ `aten/src/ATen/core/dispatch/Dispatcher.h`（`Dispatcher::call`）→ `aten/src/ATen/core/dispatch/OperatorEntry.h`（dispatch table）→ `aten/src/ATen/native/BinaryOps.cpp`（`add` 的 meta+impl）

- **第二遍：理解自动微分**
  `torch/csrc/autograd/variable.h`（`AutogradMeta` 挂载）→ `torch/csrc/autograd/node.h`（`Node` 基类）→ `torch/csrc/autograd/engine.cpp`（`Engine::execute` → `thread_main` → `evaluate_function`）→ `torch/csrc/autograd/functions/accumulate_grad.h`（叶节点 sink）

- **第三遍：理解编译栈（v2.x 核心）**
  `torch/_dynamo/eval_frame.py`（`OptimizeContext` → `set_eval_frame`）→ `torch/_dynamo/symbolic_convert.py`（`InstructionTranslator.step`）→ `torch/_inductor/compile_fx.py`（`compile_fx` → `compile_fx_inner`）→ `torch/_inductor/graph.py`（`GraphLowering.run`）→ `torch/_inductor/scheduler.py`（`Scheduler.fuse_nodes`）→ `torch/_inductor/codegen/triton.py`（`TritonKernel`）

- **第四遍：选择重点子模块深入阅读**（模块文档；若有深度解读附件，从模块文件的对应章节链接进附件）。推荐先读 [Dispatcher 详解](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/02b-aten-dispatcher-key-dispatch)——它是 PyTorch 的心脏。

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| DispatchKey | 算子分发的身份标识，由 (functionality, backend) 二维坐标编码 |
| DispatchKeySet | 64 位位集，编码 tensor 的全部身份 |
| eager 模式 | 逐 op 立即执行，动态构建计算图（PyTorch 默认） |
| graph break | Dynamo 遇不可捕获指令时切分子图，牺牲完整性换覆盖率 |
| guard | Dynamo 缓存的复用条件（类型/shape/shape_env 检查） |
| fusion | Inductor 把多个 pointwise/reduction op 融合成一个 kernel |
| AOTI | Ahead-of-Time Inductor，编译产物持久化部署 |
| structured op | ATen 算子的 meta+impl 分离模式，复用 TensorIterator |
| bucket | DDP 梯度聚合单元（默认 25MB），合并小 tensor all-reduce |
| SymInt | 符号化整数，支持 dynamic shapes tracing |

### 参考资料

- [PyTorch 官方文档](https://docs.pytorch.org/)
- [torch.compile 教程](https://pytorch.org/tutorials/intermediate/torch_compile_tutorial.html)
- [PyTorch internals: How Autograd works](https://blog.ezyang.com/2019/05/pytorch-internals-how-autograd-works/)
- [PEP 523 — Adding a frame evaluation API to CPython](https://peps.python.org/pep-0523/)
- [Triton 语言文档](https://triton-lang.org/)
