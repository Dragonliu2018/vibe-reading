---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "算子库"
date: "2026-08-12T15:35:32+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "CUDA", "JIT 编译", "Op Builder", "FusedAdam"]
description: "DeepSpeed 算子库通过 OpBuilder 体系管理 C++/CUDA 算子的 JIT 编译与多硬件适配，覆盖 FusedAdam、CPUAdam、Transformer 训练/推理等高性能内核，是训练引擎和推理引擎的底层加速基座。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

`deepspeed.ops` 是 DeepSpeed 的 C++/CUDA 算子库——它将高性能内核（fused Adam、CPU Adam、Transformer 训练/推理 kernel 等）封装为 Python 可调用模块，通过 JIT 编译在运行时按需构建。算子库的存在让 DeepSpeed 的纯 Python 训练引擎能够在关键路径上调用 GPU fused kernel，将多个元素级操作合并为一次 kernel launch，或将 optimizer state offload 到 CPU 并用 AVX SIMD 加速。

算子库的核心挑战不是写 CUDA kernel（那在 `csrc/` 目录），而是**如何让同一份 Python 代码在不同硬件（NVIDIA GPU / AMD ROCm / Intel XPU / 华为 NPU 等）、不同 CUDA 版本、不同 compute capability 上正确编译并加载**。这由 `OpBuilder` 继承体系解决——每个算子对应一个 Builder 子类，Builder 负责声明源文件、编译参数、兼容性检查，并通过 `load()` 方法在三种路径（缓存命中 / 预编译加载 / JIT 编译）中选择最优路径。

## 调用链路

### JIT 编译流程

当训练引擎或推理引擎首次需要某个算子时，调用 `Builder().load()` 触发编译加载：

```
FusedAdamBuilder().load()                    builder.py L547
├── ① 查 _loaded_ops 缓存                    ← 同一进程内已加载过？直接返回
│   └── hit → return op_module
├── ② 查 installed_ops (预编译)              ← pip install --compile 时预编译的 .so？
│   ├── validate_torch_version()             ← 检查 torch 版本一致
│   ├── validate_torch_op_version()          ← 检查 CUDA/HIP 版本一致
│   ├── importlib.import_module(absolute_name)
│   └── return op_module
└── ③ jit_load()                             builder.py L566
    ├── is_compatible()                      ← 硬件/软件兼容性检查
    ├── verify_ninja_availability()          ← ninja 构建工具必须存在
    ├── [CUDAOpBuilder] build_for_cpu = !cuda.is_available()
    ├── 组装 sources / include_paths / nvcc_args / cxx_args
    ├── [ROCm] hipify_extension()            ← CUDA→HIP 自动转换
    ├── [CUDA] compute_capability_args()     ← 探测 GPU arch 或读 TORCH_CUDA_ARCH_LIST
    └── torch.utils.cpp_extension.load()     ← 实际编译，缓存到 /tmp/torch_extensions/
        └── return op_module
```

### 算子调用流程

编译加载完成后，Python 侧通过返回的 `op_module` 调用 C++/CUDA 函数：

```
FusedAdam.step()                             fused_adam.py L107
├── 按 dtype 分桶: g_16/p_16/m_16/v_16, g_bf/p_bf/m_bf/v_bf, g_32/...
├── multi_tensor_applier(                   ← MultiTensorApply.__call__
│       self.multi_tensor_adam,             ← C++ 函数: fused_adam_cuda.multi_tensor_adam
│       self._dummy_overflow_buf,
│       [g_16, p_16, m_16, v_16],
│       lr, beta1, beta2, eps, step, adam_w_mode, ...)
└── MultiTensorApply.__call__               multi_tensor_apply.py L16
    └── op(chunk_size, noop_flag_buffer, tensor_lists, *args)
        ← 单次 kernel launch 处理所有参数张量
```

<details>
<summary>Builder 速查表</summary>

| Builder | 父类 | 源文件 | 用途 |
|---------|------|--------|------|
| `OpBuilder` | ABC | `builder.py` L137 | 抽象基类，定义 load/jit_load/builder 接口 |
| `CUDAOpBuilder` | OpBuilder | `builder.py` L636 | CUDA 算子基类，compute_capability_args + hipify |
| `TorchCPUOpBuilder` | CUDAOpBuilder | `builder.py` L919 | CPU+CUDA 混合算子（CPUAdam 等），AVX SIMD |
| `FusedAdamBuilder` | CUDAOpBuilder | `fused_adam.py` L11 | FusedAdam CUDA kernel |
| `CPUAdamBuilder` | TorchCPUOpBuilder | `cpu_adam.py` L9 | DeepSpeedCPUAdam CPU kernel |
| `TransformerBuilder` | CUDAOpBuilder | `transformer.py` L9 | 训练用 Transformer kernel |
| `InferenceBuilder` | CUDAOpBuilder | `transformer_inference.py` L10 | v1 推理 Transformer kernel |
| `InferenceCoreBuilder` | CUDAOpBuilder | `inference_core_ops.py` L11 | v2 推理核心 kernel (layer_norm/rms_norm/linear 等) |
| `CPUOpBuilder` | OpBuilder | `op_builder/cpu/builder.py` L17 | 纯 CPU 算子基类（无 CUDA 依赖） |
| `NPUOpBuilder` | OpBuilder | `op_builder/npu/builder.py` L22 | 华为 NPU 算子基类 |
| `SYCLOpBuilder` | OpBuilder | `op_builder/xpu/builder.py` L19 | Intel XPU (SYCL) 算子基类 |
| `SDAAOpBuilder` | OpBuilder | `op_builder/sdaa/builder.py` L41 | SDAA 算子基类 |
| `SUPAOpBuilder` | OpBuilder | `op_builder/supa/builder.py` L11 | SUPA 算子基类 |

</details>

## 核心实现

### OpBuilder JIT 编译机制

`OpBuilder.load()` 是算子库的入口方法，实现了三级查找策略：

```python title="builder.py L547 — OpBuilder.load()"
def load(self, verbose=False):
    # ① 进程内缓存：同一 op 只编译一次
    if self.name in __class__._loaded_ops:
        return __class__._loaded_ops[self.name]

    from deepspeed.git_version_info import installed_ops, torch_info, accelerator_name
    from deepspeed.accelerator import get_accelerator
    # ② 预编译加载：pip install 时已编译为 .so
    if installed_ops.get(self.name, False) and accelerator_name == get_accelerator()._name:
        self.validate_torch_version(torch_info)
        if torch.cuda.is_available() and isinstance(self, CUDAOpBuilder):
            self.validate_torch_op_version(torch_info)
        op_module = importlib.import_module(self.absolute_name())
        __class__._loaded_ops[self.name] = op_module
        return op_module
    else:
        # ③ JIT 编译：运行时用 torch.utils.cpp_extension.load() 编译
        return self.jit_load(verbose)
```

**why 三级查找**：第一级避免同一进程重复编译；第二级让用户可以通过 `DS_BUILD_OPS=1 pip install .` 预编译所有算子，避免训练时编译延迟；第三级是默认路径——按需 JIT 编译，编译产物缓存在 `/tmp/torch_extensions/` 下，后续进程可复用。

**why 默认不预编译**：DeepSpeed 的 pip 包不预编译 CUDA 算子，原因有三：

1. **Compute capability 多样性**：NVIDIA GPU 从 Pascal (6.0) 到 Hopper (10.0)，每个架构需要不同的 `-gencode` 参数。预编译所有架构会让包体积膨胀数倍，而用户实际只需自己 GPU 对应的架构。`get_default_compute_capabilities()` 函数（`builder.py` L83）根据 CUDA 版本动态生成默认架构列表，CUDA 12 最高覆盖到 `10.0;12.0`。

2. **CUDA 版本兼容**：PyTorch 可能用 CUDA 11.8 编译，用户系统可能是 CUDA 12.4。`assert_no_cuda_mismatch()`（`builder.py` L111）允许同一大版本内的 minor 差异（如 12.0 vs 12.4），但预编译时无法预知用户的 CUDA 版本组合。

3. **按需编译减少体积**：大多数用户只用到 FusedAdam 和 InferenceBuilder，不需要 TransformerBuilder、SparseAttnBuilder 等。JIT 模式下只编译实际用到的算子。

`jit_load()` 方法的核心是调用 `torch.utils.cpp_extension.load()`，但在此之前做了大量准备工作——探测 compute capability、处理 ROCm hipify、设置 BF16 编译宏等：

```python title="builder.py L566 — jit_load 核心逻辑"
def jit_load(self, verbose=True):
    if not self.is_compatible(verbose):
        raise RuntimeError(...)
    # ninja 是 JIT 编译的构建工具，必须存在
    from torch.utils.cpp_extension import verify_ninja_availability
    verify_ninja_availability()

    if isinstance(self, CUDAOpBuilder) and not self.is_rocm_pytorch():
        self.build_for_cpu = not torch.cuda.is_available()

    # 保存环境变量，编译完成后恢复
    torch_arch_list_present = "TORCH_CUDA_ARCH_LIST" in os.environ
    torch_arch_list = os.environ.get("TORCH_CUDA_ARCH_LIST")

    sources = [os.path.abspath(self.deepspeed_src_path(path)) for path in self.sources()]
    # ... 组装 cxx_args / nvcc_args ...

    # ROCm: 自动将 CUDA 代码转 HIP
    if self.is_rocm_pytorch():
        cxx_args.append("-D__HIP_PLATFORM_AMD__=1")
        os.environ["PYTORCH_ROCM_ARCH"] = self.get_rocm_gpu_arch()

    op_module = load(name=self.name, sources=..., extra_cuda_cflags=nvcc_args, ...)
    __class__._loaded_ops[self.name] = op_module
    return op_module
```

`CUDAOpBuilder.compute_capability_args()` 是 JIT 编译中最精巧的部分——它在 JIT 模式下自动探测运行时 GPU 的 compute capability，而非依赖用户手动设置：

```python title="builder.py L656 — compute_capability_args 优先级链"
def compute_capability_args(self, cross_compile_archs=None):
    ccs = []
    if self.jit_mode:
        # 优先级 1: jit_load() 捕获的 TORCH_CUDA_ARCH_LIST
        arch_string = getattr(self, '_jit_arch_list', None)
        if arch_string:
            ccs = [cc.strip() for cc in arch_string.replace(' ', ';').split(';') ...]
        else:
            # 优先级 2: 当前环境变量 TORCH_CUDA_ARCH_LIST
            arch_string = os.environ.get('TORCH_CUDA_ARCH_LIST', '').strip()
            if arch_string:
                ccs = ...
            else:
                # 优先级 3: 探测运行时 GPU
                if hasattr(torch.cuda, '_is_in_bad_fork') and torch.cuda._is_in_bad_fork():
                    raise RuntimeError(...)  # fork 子进程不能探测
                for i in range(torch.cuda.device_count()):
                    CC_MAJOR, CC_MINOR = torch.cuda.get_device_capability(i)
                    cc = f"{CC_MAJOR}.{CC_MINOR}"
                    if cc not in ccs:
                        ccs.append(cc)
        # 自动为最高架构添加 +PTX（向前兼容未来 GPU）
        ccs = sorted(ccs, ...)
        if not any('+PTX' in cc for cc in ccs):
            ccs[-1] += '+PTX'
    # ...
    # JIT 模式下返回空列表——让 PyTorch 从 TORCH_CUDA_ARCH_LIST 自动生成 -gencode
    if self.jit_mode:
        return []
```

**why JIT 模式返回空列表**：JIT 模式下 `compute_capability_args()` 将架构列表写入 `os.environ["TORCH_CUDA_ARCH_LIST"]`，然后返回空列表。这是因为 `torch.utils.cpp_extension.load()` 内部会读取该环境变量自动生成 `-gencode` 参数，如果 Builder 同时也返回参数，会造成重复。非 JIT 模式（预编译）则直接返回 `-gencode=...` 参数列表，因为预编译走 `setup.py` 路径，不经过 `load()`。

**why `cuda_capability_major()` 谨慎探测**：`torch.cuda.get_device_properties()` 会调用 `_lazy_init()` 创建 CUDA context。在 `fork()` 子进程中，父进程的 context 无法复用（issue #7918）。因此 `cuda_capability_major()` 只在 CUDA 已初始化且不在 bad fork 中时才探测，否则返回 `None`，让调用方跳过检查。

### 多硬件适配与反射注册

#### ROCm 适配

DeepSpeed 通过 `is_rocm_pytorch()` + `hipify_extension()` 机制，让同一份 `CUDAOpBuilder` 子类同时支持 NVIDIA CUDA 和 AMD ROCm：

```python title="builder.py L206 — is_rocm_pytorch 检测"
@staticmethod
def is_rocm_pytorch():
    if OpBuilder._is_rocm_pytorch is not None:
        return OpBuilder._is_rocm_pytorch  # 缓存结果
    _is_rocm_pytorch = hasattr(torch.version, 'hip') and torch.version.hip is not None
    if _is_rocm_pytorch:
        from torch.utils.cpp_extension import ROCM_HOME
        _is_rocm_pytorch = ROCM_HOME is not None
    OpBuilder._is_rocm_pytorch = _is_rocm_pytorch
    return OpBuilder._is_rocm_pytorch
```

当检测到 ROCm 时，`jit_load()` 中会自动调用 `hipify_extension()`（`builder.py` L849），使用 PyTorch 的 `hipify_python` 工具将 CUDA 源文件中的 `cuda*` API 调用转换为 HIP 等价物。同一份 `.cu` 源文件在 NVIDIA 平台编译为 CUDA kernel，在 AMD 平台编译为 HIP kernel，Builder 子类无需感知差异。

`nvcc_args()` 方法中也有 ROCm 分支——ROCm 使用 `hipcc` 编译器，需要不同的编译参数（如 `-DROCM_VERSION_MAJOR`、`-U__HIP_NO_HALF_OPERATORS__`）。

#### 反射注册

`op_builder/__init__.py` 使用 Python 反射机制自动发现所有 Builder 类，无需手动维护注册表：

```python title="op_builder/__init__.py L46 — 反射扫描"
for _, module_name, _ in pkgutil.iter_modules([os.path.dirname(this_module.__file__)]):
    if module_name != 'all_ops' and module_name != 'builder':
        module = importlib.import_module(f".{module_name}", package=op_builder_dir)
        for member_name in module.__dir__():
            if member_name.endswith('Builder') \
               and member_name != "OpBuilder" \
               and member_name != "CUDAOpBuilder":
                # 将 Builder 名字绑定到 builder_closure
                this_module.__dict__[member_name] = builder_closure(member_name)
```

`builder_closure` 是一个延迟工厂——它在运行时通过 `get_accelerator().get_op_builder(member_name)` 获取当前加速器对应的 Builder 类：

```python title="op_builder/__init__.py L28 — builder_closure 延迟绑定"
def builder_closure(member_name):
    if op_builder_dir == "op_builder":
        # 安装时 torch 可能未安装，返回闭包延迟执行
        def _builder():
            from deepspeed.accelerator import get_accelerator
            return get_accelerator().create_op_builder(member_name)
        return _builder
    else:
        # 运行时直接返回 Builder 类
        from deepspeed.accelerator import get_accelerator
        return get_accelerator().get_op_builder(member_name)
```

**why 延迟绑定**：`__init__.py` 在 `import deepspeed` 时执行，此时加速器可能尚未初始化。通过 `builder_closure` 将实际的 Builder 类查找推迟到 `FusedAdamBuilder().load()` 被调用时，确保 `get_accelerator()` 已经就绪。

#### 加速器工厂 _lazy_init_class_dict

每个加速器实现自己的 `_lazy_init_class_dict()`，扫描对应的 `op_builder/` 子目录：

```python title="cuda_accelerator.py L353 — CUDA 加速器的延迟扫描"
def _lazy_init_class_dict(self):
    if self.class_dict is not None:
        return  # 已初始化，跳过
    self.class_dict = {}
    op_builder_dir = self.op_builder_dir()  # "deepspeed.ops.op_builder"
    op_builder_module = importlib.import_module(op_builder_dir)
    op_builder_absolute_path = os.path.dirname(op_builder_module.__file__)
    for _, module_name, _ in pkgutil.iter_modules([op_builder_absolute_path]):
        # 跳过子目录（cpu/ hpu/ npu/ 等其他后端的 Builder）
        if module_name != 'all_ops' and module_name != 'builder' \
           and not os.path.isdir(os.path.join(op_builder_absolute_path, module_name)):
            module = importlib.import_module("{}.{}".format(op_builder_dir, module_name))
            for member_name in module.__dir__():
                if member_name.endswith('Builder') \
                   and member_name not in ("OpBuilder", "CUDAOpBuilder", "TorchCPUOpBuilder"):
                    if member_name not in self.class_dict:
                        self.class_dict[member_name] = getattr(module, member_name)
```

**why 跳过子目录**：`op_builder/` 下有 `cpu/`、`hpu/`、`npu/`、`xpu/`、`sdaa/`、`supa/` 等子目录，每个目录包含对应后端的 Builder 实现。CUDA 加速器只扫描顶层 `.py` 文件（这些是 CUDA Builder），跳过子目录避免加载不相关的后端代码。NPU 加速器的 `op_builder_dir()` 返回 `"deepspeed.ops.op_builder.npu"`，自然只扫描 `npu/` 子目录。

这种设计让**同一个 Builder 名字（如 `FusedAdamBuilder`）在不同加速器下指向不同的类**——CUDA 下是 `op_builder/fused_adam.py:FusedAdamBuilder`，NPU 下是 `op_builder/npu/fused_adam.py:FusedAdamBuilder`，XPU 下是 `op_builder/xpu/fused_adam.py:FusedAdamBuilder`。调用方只需 `from deepspeed.ops.op_builder import FusedAdamBuilder`，由加速器自动路由到正确实现。

### v1 BaseOp vs v2 DSKernelBase

DeepSpeed 推理引擎有两代实现，它们对算子的封装方式截然不同。

**v1 推理（`ops/transformer/inference/op_binding/base.py`）**：

```python title="op_binding/base.py L12 — BaseOp (v1)"
class BaseOp(torch.nn.Module):
    inference_module = None  # 类变量，所有 Op 共享一个编译模块

    def __init__(self, config: DeepSpeedInferenceConfig):
        super(BaseOp, self).__init__()
        self.config = config
        if BaseOp.inference_module is None:
            builder = InferenceBuilder()
            BaseOp.inference_module = builder.load()
```

v1 的所有推理算子（softmax、gelu、layer_norm、qkv_gemm 等）都继承 `BaseOp`，共享同一个 `inference_module`（即 `InferenceBuilder` 编译出的 `.so`）。每个 Op 在 `forward()` 中直接调用 `self.inference_module.xxx(...)`。

**v2 推理（`inference/v2/kernels/ds_kernel.py`）**：

```python title="ds_kernel.py L9 — DSKernelBase (v2)"
class DSKernelBase(ABC):

    @abstractmethod
    def __init__(self, *args, **kwargs):
        """
        If necessary trigger compilation and warmup
        Autotuning of the kernel would happen at this stage to
        eliminate any potential hangs that might occur mid-deployment
        Validate that the desired run configuration is compatible.
        """

    @abstractmethod
    def __call__(self, *args, **kwargs):
        """
        However the kernel needs to be called, it can be called here. Auto-tuning
        should never be performed here.

        All inputs/outputs should be passed as arguments to this function. No allocations
        should be performed here.
        """
```

v2 的 `DSKernelBase` 是 ABC，强制子类将 `__init__`（编译 + autotune + 验证）和 `__call__`（零开销执行）分离。实际实现如 `CUDARMSNormBase`：

```python title="rms_norm_base.py L13 — DSKernelBase 的具体实现"
class CUDARMSNormBase(DSKernelBase):
    supported_dtypes = [torch.float16, torch.bfloat16, torch.float32]

    def __init__(self, channels: int, fp_dtype: torch.dtype, epsilon: float = 1e-5):
        # 验证参数
        if fp_dtype not in CUDARMSNormBase.supported_dtypes:
            raise ValueError(...)
        if elem_size(fp_dtype) * channels % 16 != 0:
            raise ValueError(...)
        # 编译加载
        self.inf_module = InferenceCoreBuilder().load()
        self.epsilon = epsilon
    # __call__ 在子类中实现，直接调用 self.inf_module.xxx(...)
```

**why v2 强制分离**：v1 的 `BaseOp` 是 `nn.Module`，每次 `forward()` 调用时可能包含条件判断、参数验证等开销。v2 的设计哲学是**构造时做所有重活（编译、autotune、验证），执行时零开销**——`__call__` 只做纯粹的 kernel 调用，不做任何分配或检查。这对推理场景至关重要，因为推理时延迟敏感，每一点 Python 侧开销都会累积。

另一个区别是**编译模块的粒度**：v1 所有 Op 共享一个 `inference_module`（由 `InferenceBuilder` 一次性编译所有推理 kernel）；v2 的每个 kernel 类可以独立加载 `InferenceCoreBuilder().load()`，但底层共享 `_loaded_ops` 缓存，实际只编译一次。

## 设计模式

| 模式 | 实现 | 解决的问题 |
|------|------|-----------|
| **Builder** | `OpBuilder` → `CUDAOpBuilder` → `FusedAdamBuilder` 等 | 将算子的编译配置（源文件、编译参数、兼容性检查）与算子的使用逻辑解耦。每个 Builder 子类声明 `sources()`、`absolute_name()`、`nvcc_args()`，`load()` 方法统一处理编译流程 |
| **工厂方法** | `get_accelerator().create_op_builder(name)` | 根据当前加速器类型（CUDA/NPU/XPU/...）创建对应的 Builder 实例。同一接口，不同后端 |
| **模板方法** | `OpBuilder.load()` 定义编译流程骨架，`jit_load()`/`is_compatible()`/`sources()` 等由子类实现 | 统一三级查找策略（缓存→预编译→JIT），子类只覆盖配置部分 |
| **策略** | `compute_capability_args()` 中 JIT 模式 vs 非 JIT 模式走不同分支 | JIT 时探测运行时 GPU，预编译时用默认架构列表或环境变量 |
| **ABC** | `OpBuilder(ABC)` 强制 `absolute_name()`/`sources()` 抽象方法；`DSKernelBase(ABC)` 强制 `__init__`/`__call__` 抽象方法 | 确保所有算子 Builder 和 v2 kernel 实现必需的接口 |
| **反射注册** | `__init__.py` 遍历目录，按 `*Builder` 后缀自动发现 | 新增算子只需添加 `.py` 文件，无需修改注册表 |
| **延迟初始化** | `_lazy_init_class_dict()` 首次调用时扫描目录，后续直接用缓存 | 避免 `import deepspeed` 时加载所有 Builder，按需初始化 |

## 模块间交互

算子库是 DeepSpeed 的底层基座，被多个上层模块调用：

- **训练引擎**（`engine.py`）：`_configure_basic_optimizer()` 根据 `optimizer.type` 配置项创建 `FusedAdam` 或 `DeepSpeedCPUAdam`，引擎不直接调用 Builder
- **ZeRO 优化器**（`zero/`）：ZeRO-1/2 包装 `FusedAdam`，在 `step()` 中先做梯度规约再调用 `FusedAdam.step()`；ZeRO-Offload 使用 `DeepSpeedCPUAdam` 将 optimizer state 放在 CPU
- **v1 推理引擎**（`ops/transformer/inference/`）：所有 `op_binding/` 下的算子（`bias_add.py`、`gelu_gemm.py`、`softmax.py` 等）继承 `BaseOp`，通过 `InferenceBuilder().load()` 加载编译模块
- **v2 推理引擎**（`inference/v2/`）：所有 kernel 类继承 `DSKernelBase`，通过 `InferenceCoreBuilder().load()` 加载编译模块
- **模块注入**（`module_inject/`）：`DeepSpeedTransformerLayer` 在 `__init__` 中调用 `TransformerBuilder().load()` 加载训练用 Transformer kernel

依赖方向：算子库 → `deepspeed.accelerator`（获取当前加速器、op_builder 路由）→ `torch.utils.cpp_extension`（实际编译工具链）。算子库不依赖训练引擎或推理引擎，是纯底层模块。

## 扩展方式

新增一个 CUDA 算子的步骤：

1. **编写 C++/CUDA 源文件**：在 `csrc/` 下创建 `.cpp`（PyTorch 绑定）和 `.cu`（CUDA kernel）文件，使用 `PYBIND11_MODULE` 导出 Python 可调用函数

2. **创建 Builder 子类**：在 `op_builder/` 下新建 `my_op.py`，继承 `CUDAOpBuilder`：

```python
from .builder import CUDAOpBuilder

class MyOpBuilder(CUDAOpBuilder):
    BUILD_VAR = "DS_BUILD_MY_OP"   # 预编译开关环境变量
    NAME = "my_op"

    def __init__(self, name=None):
        name = self.NAME if name is None else name
        super().__init__(name=name)

    def absolute_name(self):
        return f'deepspeed.ops.my_module.{self.NAME}_op'

    def sources(self):
        return ['csrc/my_op/my_op_frontend.cpp', 'csrc/my_op/my_op_kernel.cu']

    def include_paths(self):
        return ['csrc/includes', 'csrc/my_op']
```

3. **自动注册**：无需修改 `__init__.py`——反射扫描会自动发现 `MyOpBuilder`（以 `Builder` 结尾），绑定到模块属性。用户即可 `from deepspeed.ops.op_builder import MyOpBuilder`

4. **使用算子**：在 Python 代码中调用 `MyOpBuilder().load()` 获取编译模块，调用导出的函数

5. **多硬件适配**（可选）：如果算子需要支持 NPU/XPU 等，在 `op_builder/npu/my_op.py`、`op_builder/xpu/my_op.py` 下创建对应后端的 `MyOpBuilder`，继承 `NPUOpBuilder` 或 `SYCLOpBuilder`。加速器的 `_lazy_init_class_dict()` 会自动路由到正确实现
