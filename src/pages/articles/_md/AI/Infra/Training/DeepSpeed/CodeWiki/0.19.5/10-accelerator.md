---
source:
  type: "源码解读"
  project: "DeepSpeed"
  url: "https://github.com/deepspeedai/DeepSpeed"
title: "加速器抽象"
date: "2026-08-12T15:53:22+08:00"
category: [AI, Infra, Training, DeepSpeed, CodeWiki, "0.19.5"]
tags: ["DeepSpeed", "硬件抽象", "CUDA", "ROCm", "多硬件"]
description: "DeepSpeedAccelerator 通过 50+ 抽象方法统一 9 种硬件后端（CUDA/ROCm/CPU/XPU/NPU/HPU/MLU/SDAA/SUPA），get_accelerator() 单例工厂被全框架 316 处调用，是 DeepSpeed 多硬件适配的基础设施。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/DeepSpeed/CodeWiki/0.19.5/00-overview)

---

## 模块定位

`accelerator/` 模块是 DeepSpeed 多硬件适配的基础设施层。它通过 `DeepSpeedAccelerator` 抽象基类定义 50+ 个抽象方法，覆盖 device/stream/event/memory/datatype/tensor/graph/op_builder/comm 全生命周期，再由 9 种具体实现（CUDA、CPU、XPU、NPU、HPU、MLU、SDAA、SUPA、MPS）各自委托对应的 PyTorch 扩展包。全框架 316 处调用 `get_accelerator()` 获取当前硬件后端实例，面向抽象编程——上层代码写 `get_accelerator().synchronize()` 而非 `torch.cuda.synchronize()`，实现"一套代码跑在 9 种芯片上"。

这个模块的独立价值在于**隔离硬件差异**。DeepSpeed 的训练引擎、ZeRO 优化器、通信层、算子库都需要直接操作设备（设 device、创建 stream、管理显存、JIT 编译算子），但每种硬件的 PyTorch 扩展 API 命名和语义不同（`torch.cuda.synchronize()` vs `torch.npu.synchronize()` vs `torch.xpu.synchronize()`）。如果没有抽象层，每个调用点都需 if-else 分支判断硬件类型，代码爆炸且不可扩展。`DeepSpeedAccelerator` 把这些差异收敛到一组统一接口，新增硬件只需添加一个实现类。

## 调用链路

`get_accelerator()` 的硬件探测与后端选择流程——两级探测（环境变量覆盖 > 自动探测），探测到名称后按名称创建对应实现类实例：

```text
get_accelerator()                              real_accelerator.py L51
├── ds_accelerator 已初始化? → 直接返回单例
│
├── [第 1 级] DS_ACCELERATOR 环境变量覆盖
│   ├── "DS_ACCELERATOR" in os.environ?
│   │   ├── 值为 "xpu"/"npu"/"sdaa"/"mps"/"hpu"/"mlu"/"supa"
│   │   │   → 验证对应扩展包已安装（import 失败则 raise ValueError）
│   │   ├── 值为 "cpu" → 直接通过
│   │   ├── 值为 "cuda" → 隐含通过（走到第 3 步创建 CUDA_Accelerator）
│   │   └── 值不在 SUPPORTED_ACCELERATOR_LIST → raise ValueError
│   └── ds_set_method = "override"
│
├── [第 2 级] 自动探测（无环境变量时，按优先级依次尝试）
│   ├── try import torch → hasattr(torch, 'xpu')?       → "xpu"
│   ├── try import torch_npu                              → "npu"
│   ├── try import torch_sdaa                             → "sdaa"
│   ├── try import torch.mps                              → "mps"
│   ├── try import habana_frameworks.torch.hpu            → "hpu"
│   ├── try import torch_mlu                              → "mlu"
│   ├── try import torch_supa  ← 必须在 CUDA 前！          → "supa"
│   │   └── torch_supa spoofs torch.cuda，先检测 CUDA 会被误判
│   ├── try torch.cuda.device_count() > 0                 → "cuda"
│   └── 全部失败 → "cpu"（catch-all fallback）
│       └── ds_set_method = "auto detect"
│
├── [第 3 步] 按 accelerator_name 创建实现类实例
│   ├── "cuda"  → CUDA_Accelerator()
│   ├── "cpu"   → CPU_Accelerator()
│   ├── "xpu"   → XPU_Accelerator()
│   ├── "npu"   → NPU_Accelerator()
│   ├── ...（其余同理）
│   └── _validate_accelerator(ds_accelerator)  ← 校验是 DeepSpeedAccelerator 子类
│
└── return ds_accelerator  ← 全局单例已设置
```

**探测优先级的设计考量**：专属扩展包（torch_npu/torch_mlu/torch_sdaa 等）优先于 CUDA 检测，因为它们是"显式安装的专用包"，语义明确。`torch_supa` 必须排在 `torch.cuda` 之前——`torch_supa` 会 spoof（劫持）`torch.cuda` 命名空间，如果先检测 CUDA 会把 SUPA 设备误判为 CUDA。CPU 作为 catch-all fallback，确保即使没有任何加速器，DeepSpeed 也能在纯 CPU 环境运行（如 CI 测试、登录节点安装）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `get_accelerator` in `real_accelerator.py` L51 | 获取全局加速器单例 | 两级探测：环境变量 > 自动探测 |
| `set_accelerator` in `real_accelerator.py` L249 | 外部注入加速器实例 | 允许测试/引擎覆盖自动探测结果 |
| `_validate_accelerator` in `real_accelerator.py` L28 | 校验是 DeepSpeedAccelerator 子类 | 检查两种 import 路径（符号链接兼容） |
| `is_current_accelerator_supported` in `real_accelerator.py` L47 | 检查当前后端在支持列表中 | 用 `device_name()` 匹配 `SUPPORTED_ACCELERATOR_LIST` |
| `DeepSpeedAccelerator.__init__` in `abstract_accelerator.py` L13 | 初始化三个名称字段 | `_name`/`_communication_backend_name`/`_compile_backend` |
| `CUDA_Accelerator._lazy_init_class_dict` in `cuda_accelerator.py` L353 | 反射扫描 op_builder 目录 | 延迟初始化 class_dict，避免 import 开销 |
| `CPU_Accelerator.pin_memory` in `cpu_accelerator.py` L281 | 直接 override 绕过 tracking | CPU 无真实 page-lock，计数会误导 OOM 诊断 |

</details>

## 核心实现

### DeepSpeedAccelerator 抽象接口

`DeepSpeedAccelerator` 是整个模块的契约核心。它继承 `abc.ABC`，定义 50+ 个 `@abc.abstractmethod`，按功能域分为 9 组：

```python title="abstract_accelerator.py"
class DeepSpeedAccelerator(ABC):
    supports_nvtx_domain = False  # 类属性，仅 CUDA_Accelerator 设为 True

    def __init__(self):
        self._name = None
        self._communication_backend_name = None
        self._compile_backend = None

    # ── 功能域分组 ──────────────────────────────
    # 1. 设备行为标识：is_synchronized_device / use_host_timers /
    #    resolves_data_dependency / handles_memory_backpressure
    # 2. Device API：device_name / device / set_device / current_device /
    #    device_count / synchronize
    # 3. RNG：random / set_rng_state / get_rng_state / manual_seed /
    #    manual_seed_all / initial_seed / default_generator
    # 4. Stream/Event：Stream / stream / current_stream / default_stream / Event
    # 5. Memory：empty_cache / memory_allocated / max_memory_allocated /
    #    memory_stats / memory_reserved / total_memory / available_memory
    # 6. DataType：is_bf16_supported / is_fp16_supported / supported_dtypes
    # 7. Graph：create_graph / capture_to_graph / replay_graph
    # 8. Tensor：BFloat16Tensor / FloatTensor / HalfTensor / IntTensor / ...
    # 9. OpBuilder + Comm：op_builder_dir / create_op_builder / get_op_builder /
    #    build_extension / communication_backend_name / visible_devices_envs
```

**`is_synchronized_device` 是最关键的行为标识**。它是一个布尔属性，决定设备是否需要显式同步来保证数据依赖和内存反压。CUDA/NPU/XPU 等异步设备返回 `False`——它们的计算在独立 stream 上异步执行，host 不需要等待；CPU 返回 `True`——CPU 计算天然同步。三个关联方法 `use_host_timers()`、`resolves_data_dependency()`、`handles_memory_backpressure()` 默认委托给它，子类可按需覆写。

**`pin_memory` 的模板方法设计**：基类提供了 `pin_memory()` 的默认实现，先调 `track_pinned_memory()` 记录 pinned 内存量（供 OOM 诊断），再委托 `_pin_memory()` 做实际的 page-lock：

```python title="abstract_accelerator.py L263"
def pin_memory(self, tensor, align_bytes=1):
    from deepspeed.utils.pin_memory_tracker import track_pinned_memory
    track_pinned_memory(tensor.nbytes)
    return self._pin_memory(tensor, align_bytes)

def _pin_memory(self, tensor, align_bytes=1):
    """Device-specific pinning hook. Accelerators that need custom pinning
    behavior should override this method rather than pin_memory so that
    the pinned-memory accounting in pin_memory is preserved."""
    return tensor.pin_memory()
```

这里用**模板方法模式**把"内存计数"和"实际 pin"分离——子类只需覆写 `_pin_memory()` 就能自定义 pin 行为，同时保留基类的计数逻辑。唯一的例外是 `CPU_Accelerator`，它直接覆写 `pin_memory()` 本身（见下文 CPU 小节）。

**`prefer_triton_grouped_mm` 是唯一的非抽象可选方法**，基类默认返回 `False`，只有 `CUDA_Accelerator` 覆写为有条件返回 `True`（见 CUDA+ROCm 小节）。

### real_accelerator 自动探测

`real_accelerator.py` 是模块的入口点，导出三个核心函数：`get_accelerator()`、`set_accelerator()`、`is_current_accelerator_supported()`。

**单例模式**：全局变量 `ds_accelerator` 初始为 `None`，`get_accelerator()` 首次调用时执行探测逻辑创建实例，后续调用直接返回缓存的实例。`set_accelerator()` 允许外部注入（如测试场景或引擎主动指定），也会设置全局单例：

```python title="real_accelerator.py L249"
def set_accelerator(accel_obj):
    global ds_accelerator
    _validate_accelerator(accel_obj)
    if accel_logger is not None and accel_obj is not None:
        accel_logger.info(f"Setting ds_accelerator to {accel_obj._name} (model specified)")
    ds_accelerator = accel_obj
```

**`_validate_accelerator` 的双路径校验**：因为 `deepspeed/accelerator` 是指向 `../accelerator/` 的符号链接，构建时 import 路径是 `accelerator.abstract_accelerator`，运行时是 `deepspeed.accelerator.abstract_accelerator`。编译时的 C++ 扩展模块会 import 运行时路径作为基类，导致同一个抽象类有两个不同的 `id`。验证函数必须检查两条路径：

```python title="real_accelerator.py L28"
try:
    from accelerator.abstract_accelerator import DeepSpeedAccelerator as dsa1
except ImportError:
    dsa1 = None
try:
    from deepspeed.accelerator.abstract_accelerator import DeepSpeedAccelerator as dsa2
except ImportError:
    dsa2 = None

def _validate_accelerator(accel_obj):
    if not ((dsa1 is not None and isinstance(accel_obj, dsa1))
            or (dsa2 is not None and isinstance(accel_obj, dsa2))):
        raise AssertionError(
            f"{accel_obj.__class__.__name__} accelerator is not subclass of DeepSpeedAccelerator")
```

**`SUPPORTED_ACCELERATOR_LIST`** 定义了 9 种合法后端名称：`['cuda', 'cpu', 'xpu', 'npu', 'mps', 'hpu', 'mlu', 'sdaa', 'supa']`。`is_current_accelerator_supported()` 通过 `get_accelerator().device_name()` 匹配此列表。

### CUDA+ROCm 共用

`CUDA_Accelerator` 是最复杂的实现，因为它同时服务 **NVIDIA CUDA** 和 **AMD ROCm/HIP** 两种硬件。PyTorch 的 ROCm 版本将 HIP API 映射到 `torch.cuda.*` 命名空间，所以从 Python 层看，ROCm 和 CUDA 的接口完全一致——`torch.cuda.synchronize()`、`torch.cuda.Stream`、`torch.cuda.memory_allocated()` 在两种硬件上都能正常工作。

这种设计的 **why** 是：PyTorch 社区已经做了 CUDA-ROCm API 统一的工作，DeepSpeed 无需重复造轮子。`CUDA_Accelerator` 只需委托 `torch.cuda.*`，自然支持两种硬件。

**唯一的区分点在 `prefer_triton_grouped_mm`**：

```python title="cuda_accelerator.py L273"
def prefer_triton_grouped_mm(self):
    # torch._grouped_mm only has a fused grouped-GEMM kernel on Hopper (sm90)
    # and newer; on sm8x it falls back to a slow per-group loop, so a Triton
    # grouped-GEMM kernel is preferred there when Triton is available.
    from deepspeed.moe.group_gemm_triton import is_available as triton_grouped_mm_is_available
    # not verified on AMD GPU
    if torch.version.hip is not None or not triton_grouped_mm_is_available():
        return False
    if not hasattr(torch, "_grouped_mm"):
        return True
    major, _ = torch.cuda.get_device_capability()
    if major < 7:
        return False
    return major < 9
```

`torch.version.hip` 不为 `None` 时表示当前是 ROCm 环境——Triton grouped-GEMM 在 AMD GPU 上未经验证，直接返回 `False`。NVIDIA GPU 上则按 compute capability 判断：sm90+（Hopper）有原生 `torch._grouped_mm` 不需要 Triton，sm7x-sm8x（Ampere/A100）的 `torch._grouped_mm` 会退化为慢速 per-group 循环，此时优先用 Triton kernel。

**`_lazy_init_class_dict` 的反射注册**：`CUDA_Accelerator` 用反射扫描 `op_builder` 目录下所有 `*Builder` 类，延迟初始化 `class_dict` 字典，避免模块加载时的 import 开销：

```python title="cuda_accelerator.py L353"
def _lazy_init_class_dict(self):
    if self.class_dict is not None:
        return
    self.class_dict = {}
    op_builder_dir = self.op_builder_dir()
    op_builder_module = importlib.import_module(op_builder_dir)
    op_builder_absolute_path = os.path.dirname(op_builder_module.__file__)
    for _, module_name, _ in pkgutil.iter_modules([op_builder_absolute_path]):
        # 跳过子目录（cpu/npu 等其他后端的 op_builder）和抽象类
        if module_name != 'all_ops' and module_name != 'builder' \
           and not os.path.isdir(os.path.join(op_builder_absolute_path, module_name)):
            module = importlib.import_module("{}.{}".format(op_builder_dir, module_name))
            for member_name in module.__dir__():
                if member_name.endswith('Builder') \
                   and member_name != "OpBuilder" \
                   and member_name != "CUDAOpBuilder" \
                   and member_name != "TorchCPUOpBuilder":
                    if member_name not in self.class_dict:
                        self.class_dict[member_name] = getattr(module, member_name)
```

**why 延迟初始化**：`op_builder` 目录下有数十个 Builder 类，每个都可能 import CUDA 相关的 C++ 扩展。如果在 `CUDA_Accelerator.__init__()` 时全部 import，会显著拖慢启动速度。延迟到首次调用 `create_op_builder()` / `get_op_builder()` 时才扫描，把 import 开销分摊到实际使用时。

**`op_builder_dir()` 的双路径检测**：与 `_validate_accelerator` 类似，检测 `op_builder` 是本地安装（`op_builder` 顶层包，有 `__deepspeed__` 标记）还是 pip 安装（`deepspeed.ops.op_builder`）：

```python title="cuda_accelerator.py L339"
def op_builder_dir(self):
    try:
        from op_builder import __deepspeed__  # 本地安装
        return "op_builder"
    except ImportError:
        return "deepspeed.ops.op_builder"     # pip 安装
```

**CPU_Accelerator 的特殊性**：

CPU 是唯一 `is_synchronized_device = True` 的后端。因为 CPU 计算天然同步，不需要 stream/event 机制——`Stream` 和 `Event` 属性返回 `None`，`synchronize()` 是空操作。`stream()` 返回 `noop_context()`（无操作上下文管理器），让上层代码的 `with accelerator.stream(s):` 语句在 CPU 上不报错。

CPU 的 `pin_memory` 直接覆写基类方法（不是 `_pin_memory`），返回 tensor 原样——CPU 内存天然就是"pinned"的（不存在 unpinned 状态），page-lock 操作无意义。如果走基类的 `pin_memory()` → `track_pinned_memory()` 路径，会记录虚假的 pinned 内存量，误导 OOM 诊断：

```python title="cpu_accelerator.py L281"
def pin_memory(self, tensor, align_bytes=1):
    # Overrides pin_memory directly (not _pin_memory) to bypass the ABC's
    # pinned-memory accounting: this is a no-op, nothing is page-locked, so
    # counting would mislead OOM diagnostics. Do not rename to _pin_memory.
    return tensor
```

CPU 的内存统计用 `psutil` 的 RSS（Resident Set Size）替代 GPU 的 `memory_allocated()`——`get_rss()` 读取进程 RSS，`max_mem` 记录峰值，`reset_rss()` 重置。`device_count()` 通过 NUMA 节点数估算可用 CPU "设备"数（用 `get_numa_cores()` 获取 NUMA 拓扑），跳过没有核心的 NUMA 节点（HBM flat 模式下 HBM 所在 NUMA 节点无核心）。

**通信后端映射**：

| 后端 | communication_backend_name | 条件 |
|------|---------------------------|------|
| CUDA | `nccl` | Linux；Windows 退回 `gloo` |
| CPU | `ccl` / `gloo` | 安装 `oneccl_bindings_for_pytorch` 用 `ccl`，否则 `gloo` |
| XPU | `ccl` / `xccl` | 安装 oneccl 用 `ccl`，否则 `xccl` |
| NPU | `hccl` | 华为 Ascend 集合通信库 |
| HPU | `hccl` | Intel Habana 集合通信库 |
| MLU | `cncl` | 寒武纪 MLU 集合通信库 |
| SDAA | `tccl` | Tecorigin 集合通信库 |
| SUPA | `bccl` / `gloo` | Biren GPU；Windows 退回 `gloo` |
| MPS | `None` | Apple Metal 无分布式通信后端 |

## 设计模式

| 模式 | 位置（文件名+方法名） | 为什么用 |
|------|----------------------|---------|
| 抽象工厂 | `real_accelerator.py` `get_accelerator` L51 | 按硬件探测结果创建对应 Accelerator 实例，上层代码面向 `DeepSpeedAccelerator` 抽象编程，不关心具体子类 |
| 单例 | `real_accelerator.py` `ds_accelerator` 全局变量 L25 | 加速器实例全局唯一，避免重复探测和多次创建；`get_accelerator()` 首次创建后缓存，`set_accelerator()` 允许外部注入 |
| 模板方法 | `abstract_accelerator.py` `pin_memory` L263 | 基类 `pin_memory()` 固化"计数 + pin"流程骨架，子类只覆写 `_pin_memory()` 自定义 pin 行为；CPU 例外直接覆写 `pin_memory` 绕过计数 |
| 策略 | 各 `*_accelerator.py` 的 `is_synchronized_device` 等 | 每种硬件对"是否同步设备"有不同策略，通过子类覆写实现策略切换，影响 host timer / 数据依赖 / 内存反压行为 |

## 模块间交互

`accelerator/` 是被依赖最多的基础设施模块——全框架 316 处调用 `get_accelerator()`，几乎每个核心模块都直接使用它：

- **`runtime/engine.py`**（核心引擎）：`DeepSpeedEngine.__init__()` 中 `get_accelerator().device_name()` 确定设备类型，`get_accelerator().synchronize()` 在训练循环中同步设备。引擎不直接 import `torch.cuda`，全部通过 accelerator 抽象。
- **`runtime/zero/`**（ZeRO 优化器）：`get_accelerator().Stream()` 创建 allgather_stream 和 reduce_stream，`get_accelerator().empty_cache()` 在显存紧张时清理缓存，`get_accelerator().memory_allocated()` 监控显存水位。
- **`comm/`**（通信层）：`get_accelerator().communication_backend_name()` 决定用 nccl/ccl/hccl 等通信后端，`get_accelerator().current_device()` 获取当前 rank 的设备 ID。
- **`ops/op_builder/`**（算子库）：`get_accelerator().create_op_builder(class_name)` 按 class_name 创建算子 Builder 实例，`get_accelerator().build_extension()` 获取 `torch.utils.cpp_extension.BuildExtension` 用于 JIT 编译。
- **`compile/`**（DeepCompile）：`get_accelerator().get_compile_backend()` 获取编译后端（如 `inductor`），`get_accelerator().set_compile_backend()` 允许动态切换。

**无循环依赖**：`accelerator/` 模块只 import `torch` 和自身文件，不依赖 DeepSpeed 的其他模块（`pin_memory` 中的 `track_pinned_memory` 是 `deepspeed.utils` 的轻量工具，通过函数内 import 避免模块级依赖）。这种"零依赖基础设施"定位是正确的——被所有人依赖的模块不能依赖任何人。

## 扩展方式

新增一种硬件后端的步骤（以假设的 "XPU2" 为例）：

1. **创建实现类**：在 `accelerator/` 目录新建 `xpu2_accelerator.py`，定义 `XPU2_Accelerator(DeepSpeedAccelerator)` 类，实现全部 50+ 个抽象方法。每个方法委托对应的 PyTorch 扩展 API（如 `torch.xpu2.synchronize()`）。

2. **注册到探测列表**：在 `real_accelerator.py` 的 `SUPPORTED_ACCELERATOR_LIST` 添加 `'xpu2'`。

3. **添加探测逻辑**：在 `get_accelerator()` 的自动探测段添加 `try import torch_xpu2` 分支，放在 `torch.cuda` 检测之前（如果 torch_xpu2 可能 spoof torch.cuda）或之后（如果不会）。

4. **添加环境变量验证**：在 `get_accelerator()` 的 DS_ACCELERATOR 环境变量处理段，添加 `elif accelerator_name == "xpu2"` 分支验证 `torch_xpu2` 可 import。

5. **添加实例化分支**：在 `get_accelerator()` 的第 3 步添加 `elif accelerator_name == 'xpu2': from .xpu2_accelerator import XPU2_Accelerator; ds_accelerator = XPU2_Accelerator()`。

6. **创建 op_builder 子目录**：在 `ops/op_builder/` 下新建 `xpu2/` 目录，放该硬件专用的 CUDA/C++ 算子 Builder 类。实现 `_lazy_init_class_dict()` 扫描此目录。

7. **设置通信后端**：在 `__init__()` 中设置 `self._communication_backend_name` 为该硬件的集合通信库（如 `xccl2`）。

8. **设置环境变量**：实现 `visible_devices_envs()` 返回该硬件的可见设备环境变量（如 `['XPU2_VISIBLE_DEVICES']`），实现 `export_envs()` 返回需要导出的环境变量前缀。

整个扩展过程**不修改任何上层代码**——engine/zero/comm/ops 通过 `get_accelerator()` 面向抽象编程，新后端自动被所有模块支持。这就是抽象工厂模式的核心价值：扩展开放，修改封闭。
