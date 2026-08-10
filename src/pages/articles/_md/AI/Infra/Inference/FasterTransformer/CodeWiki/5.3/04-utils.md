---
source:
  type: "源码解读"
  project: "fastertransformer"
  url: "https://github.com/NVIDIA/FasterTransformer"
title: "Utils"
date: "2026-08-10T14:00:00+08:00"
category: [AI, Infra, Inference, FasterTransformer, CodeWiki, "5.3"]
tags: ["FasterTransformer", "Tensor", "IAllocator", "cuBLAS", "NCCL", "GEMM 调优"]
description: "FasterTransformer 的基础设施层——Tensor 非拥有式描述符、IAllocator 多后端内存池、cublasMMWrapper GEMM 调优、NCCL 通信与 custom all-reduce。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Inference/FasterTransformer/CodeWiki/5.3/00-overview)

---

## 模块定位

`utils/` 是 FasterTransformer 的**运行时基础设施**——7,601 行 C++/CUDA，提供 Tensor 数据抽象、GPU 内存分配、cuBLAS GEMM 封装、NCCL 多 GPU 通信、GEMM 离线调优、日志等支撑能力。它是**扇入最高的模块**——被 `kernels/`、`layers/`、`models/`、`triton_backend/` 全部依赖，但自身不依赖任何上层。

这个模块独立存在的原因是：这些能力是跨模型、跨 layer 的通用基础设施，不应散落在各处。`IAllocator` 抽象让 FT 能复用 PyTorch/TF 的 caching allocator；`cublasMMWrapper` 封装 cuBLAS 的 descriptor 创建/算法选择/workspace 管理细节；`nccl_utils` 统一 TP/PP 通信原语；`Tensor` 提供类型安全的非拥有式数据传递。把它们集中在 `utils/`，上层只需通过接口使用，不感知底层 cuBLAS/NCCL/CUDA 的 API 复杂性。

## 模块架构

```
utils/
├── Tensor.h / .cc                 # 非拥有式数据描述符 + TensorMap 容器
├── allocator.h                    # IAllocator 接口 + CUDA/TF/TH 三实现
├── cublasMMWrapper.h / .cc        # cuBLAS GEMM 封装（algoMap + workspace）
├── cublasAlgoMap.h / .cc          # GEMM 算法映射表（加载 gemm_config.in）
├── nccl_utils.h / .cc            # NCCL 通信原语 + 初始化
├── custom_ar_comm.h / .cc        # 自定义 all-reduce（P2P 直访显存）
├── memory_utils.h / .cu          # deviceMalloc/deviceFree/cudaH2Dcpy 等
├── cuda_utils.h                   # CUDA 通用工具 + 类型映射
├── gemm.h                         # 高层 GEMM 抽象
├── gemm_test/                     # 离线 GEMM 调优工具
│   ├── gemm_func.h / .cc          # 通用调优逻辑（LtHgemmCustomFind）
│   ├── gpt_gemm_func.h            # GPT 专用调优入口
│   ├── encoder_gemm_func.h        # Encoder 调优
│   └── t5_gemm_func.h 等          # 各模型调优
├── logger.h / .cc                 # 日志（FT_LOG_LEVEL 环境变量）
├── nvtx_utils.h                   # NVTX profiling 标记
├── mpi_utils.h                    # MPI 封装
└── cuda_fp8_utils.h / cuda_bf16_wrapper.h  # 精度类型封装
```

四块核心：**数据与内存**（`Tensor` + `IAllocator` + `memory_utils`）、**GEMM 计算**（`cublasMMWrapper` + `cublasAlgoMap` + `gemm_test`）、**多 GPU 通信**（`nccl_utils` + `custom_ar_comm`）、**辅助**（`logger` + `nvtx` + `mpi`）。

## 调用链路

### cublasMMWrapper::Gemm（GEMM 执行 + 算法选择）

```
cublasMMWrapper::Gemm(transa, transb, m, n, k, A, lda, B, ldb, C, ldc, alpha, beta)   cublasMMWrapper.cc:154
├── mu_->lock()                                          # 线程安全
├── cublas_algo_map_->isExist(1, m, n, k, dataType)      # 查算法表
├── 决定 cublasLt vs cublasGemmEx
│   └── FP16 默认 cublasLt，FP32 默认 cublasGemmEx；有预调优算法则强制 cublasLt
├── [cublasLt 路径]
│   ├── 创建 cublasLtMatmulDesc + 3 个 MatrixLayout
│   ├── cublasLtMatmulAlgoInit + ConfigSetAttribute(tile, splitK, swizzle, stages)
│   └── cublasLtMatmul(... algo, workspace, stream)
└── [cublasGemmEx 路径]
    └── cublasGemmEx(... algo)
```

### GEMM 离线调优

```
generate_gpt_gemm_config(...)   gemm_test/gpt_gemm_func.cc
└── LtHgemmCustomFind(...)      gemm_test/gemm_func.cc:234
    ├── 创建 descriptor + layout（按数据类型）
    ├── cublasLtMatmulAlgoGetIds → 获取所有算法 ID（最多 100 个）
    └── for each algo_id:
        ├── cublasLtMatmulAlgoInit
        ├── 查询支持的 tile/stages/customOption/swizzling/splitK/reductionScheme
        └── 嵌套循环遍历所有组合 × 100 次执行 + CUDA event 计时
    → 排序选优 → 写入 gemm_config.in
```

### NCCL 通信初始化

```
ftNcclInitialize(tensor_para, pipeline_para, tp_size, pp_size)   nccl_utils.cc:308
├── MPI_Initialized 检查
├── MPI_Comm_rank / MPI_Comm_size
├── MPI_Cart_create(COMM_WORLD, 2, {pp_size, tp_size})    # 2D 拓扑
├── MPI_Cart_sub × 2                                       # 分裂 TP/PP 子通信器
├── 各 group root: ncclGetUniqueId → MPI_Bcast 广播 uid
├── ncclCommInitRank(tp_comm, tp_size, uid, tp_rank)
└── 填充 NcclParam{rank, world_size, uid, comm}
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Tensor::getPtr<T>()` | 类型安全的裸指针访问 | 非拥有式，不负责释放 |
| `Tensor::slice(shape, offset)` | 零拷贝切片 | 返回同内存偏移视图 |
| `IAllocator::reMalloc` | REUSE/INCREASE/DECREASE 重分配 | 模板方法，32 字节对齐 |
| `cublasMMWrapper::Gemm` | cuBLAS GEMM + 算法选择 | 查 algoMap 取预调优算法 |
| `cublasAlgoMap::loadGemmConfig` | 加载 gemm_config.in | 按 "batch_m_n_k_type" 建 map |
| `ftNcclAllReduceSum` | TP all-reduce | 异步提交 stream |
| `ftNcclSend/Recv` | PP 层间通信 | 点对点 |
| `ftNcclStreamSynchronize` | NCCL 异步错误轮询检查 | PP 同步屏障 |
| `CustomAllReduceComm::customAllReduce` | P2P all-reduce | 跳过 NCCL 协议栈 |
| `swapInternalBuffer` | 指针交换避免拷贝 | 输出 tensor 直接用通信 buffer |
| `deviceMalloc/deviceFree` | 直接 cudaMalloc/cudaFree | 用于权重和 I/O（非 buffer） |
| `loadWeightFromBin` | .bin 文件 → GPU | ifstream → cudaH2Dcpy |

</details>

## 核心实现

### Tensor——非拥有式数据描述符

`Tensor` 是一个轻量 struct（非 class），所有字段 `const`，只记录数据元信息不持有内存：

```cpp title="Tensor.h"
struct Tensor {
    const MemoryType          where;      // MEMORY_CPU | MEMORY_CPU_PINNED | MEMORY_GPU
    const DataType            type;       // TYPE_FP32 | TYPE_FP16 | TYPE_BF16 | TYPE_FP8_E4M3 | TYPE_INT8 ...
    const std::vector<size_t> shape;
    const void*               data;       // 裸指针（不拥有所有权）
    const std::vector<size_t> offsets = {};
    // getVal<T> / getPtr<T> / slice / saveNpy / loadNpy ...
};
```

`TensorMap` 是 `unordered_map<string, Tensor>` 的包装器，用作模型 forward 的输入输出容器。它**删除了 `at(int)` / `at(size_t)` 重载**（`Tensor.h:353-354`）以防止隐式类型转换——避免 `"hidden"` 字符串 key 被意外转成 int 索引导致难查的 bug。`insert` 方法校验 `!isExist(key)`（防重复键）和 `isValid(value)`（`tensor.size() > 0 && tensor.data != nullptr`，防空 tensor）。`getVal<T>(index)` 有三个前置检查：`where == MEMORY_CPU`、`data != nullptr`、`index < size()`，任一不满足则报错。`max<T>()` / `min<T>()` 仅支持 `MEMORY_CPU` 或 `MEMORY_CPU_PINNED`，遍历所有元素比较。

**为什么非拥有式**：FT 的内存由 `IAllocator` 统一管理（支持 PyTorch/TF caching allocator 复用）。若 Tensor 拥有内存，会与框架 allocator 双重管理冲突。引用语义使 Tensor 可零拷贝包装外部 buffer（如 PyTorch tensor 的 `data_ptr`），也可通过 `slice()` 共享同 buffer 的不同视图。代价是调用方需保证生命周期安全——layer 通过 `is_allocate_buffer_` 标志和 `freeBuffer()` 显式管理。

### IAllocator——多后端内存池抽象

```cpp title="allocator.h"
class IAllocator {
public:
    virtual void* malloc(size_t size, const bool is_set_zero = true) = 0;
    virtual void  free(void** ptr) const = 0;
    // 模板方法：REUSE/INCREASE/DECREASE 三种重分配策略
    template<typename T> void* reMalloc(T* ptr, size_t size, const bool is_set_zero = true);
protected:
    virtual bool isExist(std::string address) const = 0;
    virtual ReallocType isReMalloc(std::string address, size_t size) const = 0;
};
```

三个实现通过模板特化提供：

- `Allocator<AllocatorType::CUDA>`（`allocator.h:126-262`）——独立 CUDA 内存池，CUDA 11.2+ 用 `cudaMallocAsync`/`cudaFreeAsync`，设 `cudaMemPoolAttrReleaseThreshold = UINT64_MAX` 防内存池收缩，支持跨设备 P2P 访问，内部 `pointer_mapping_` 跟踪已分配指针
- `Allocator<AllocatorType::TF>`（`:267-355`）——复用 TF `OpKernelContext` 的 `allocate_temp`
- `Allocator<AllocatorType::TH>`（`:360-443`）——复用 PyTorch `torch::empty` 创建 tensor 并持引用防 GC

所有实现以 32 字节对齐分配（`((size + 31) / 32) * 32`），满足 cuBLAS 对齐要求。

**为什么抽象**：FT 需同时支持三种部署模式——独立部署用 CUDA 内存池、TF 集成复用 TF allocator、PyTorch 集成复用 PyTorch caching allocator。`reMalloc` 模板方法实现统一的 REUSE（指针存在且大小够，直接复用）/INCREASE（不够，free+malloc）/DECREASE（过大，缩）策略，上层代码通过 `IAllocator*` 接口使用，不感知底层内存来源。`reMalloc` 是 layer 的 `allocateBuffer` 的底层支撑——它让 `is_free_buffer_after_forward_=false` 时 buffer 在 forward 间保持（REUSE 命中），避免反复分配。

### cublasMMWrapper——GEMM 封装与算法选择

```cpp title="cublasMMWrapper.h"
class cublasMMWrapper {
protected:
    cublasHandle_t   cublas_handle_;
    cublasLtHandle_t cublaslt_handle_;
    cudaDataType_t   Atype_, Btype_, Ctype_, computeType_;
    cublasAlgoMap*   cublas_algo_map_;   // 算法映射表
    std::mutex*      mu_;                // 线程安全锁
    IAllocator*      allocator_;
    void*            cublas_workspace_;  // 32MB workspace
public:
    void Gemm(...);                      // 自动选 cublasLt 或 cublasGemmEx
    void stridedBatchedGemm(...);
    void SpGemm(...);                    // 稀疏 GEMM（条件编译）
    void setFP32GemmConfig() / setFP16GemmConfig() / setBF16GemmConfig();
};
```

`Gemm` 的核心逻辑（`cublasMMWrapper.cc:154-328`）：加锁 → 按 `"batchCount_m_n_k_dataType"` 查 `cublas_algo_map_` 是否有预调优算法 → 决定用 cublasLt（支持算法配置）还是 cublasGemmEx（简单） → 若 cublasLt 且有预调优算法，用 `cublasLtMatmulAlgoInit` + `ConfigSetAttribute` 配置 tile/splitK/swizzle/stages → 调 `cublasLtMatmul`。`setFP16GemmConfig` / `setBF16GemmConfig` 的 `computeType` 均为 `CUDA_R_32F`（FP16/BF16 数据但 FP32 累加计算），保证数值精度。`cublasAlgoMap::getAlgo` 找不到匹配算法时返回默认值——`CUBLAS_GEMM_DEFAULT`（FP32）或 `CUBLAS_GEMM_DEFAULT_TENSOR_OP`（其他精度），`customOption`/`tile`/`splitK_val` 等全设 -1。`isUseSparse` 先检查 `m%8!=0 || n%8!=0 || k%8!=0`（cusparselt 要求 8 对齐），不满足返回 false，否则查 `sp_algo_map_`。

**为什么维护 algo map**：cuBLASLt 提供数十种 GEMM 算法（不同 tile/stages/splitK/swizzling 组合），不同 shape 的最优算法不同。运行时自动搜索太慢（遍历上百种组合各执行 100 次）。FT 的方案是**离线**用 `LtHgemmCustomFind`（`gemm_test/gemm_func.cc:234`）遍历所有算法组合，将最优结果写入 `gemm_config.in`；运行时 `cublasAlgoMap::loadGemmConfig` 加载，`Gemm` 查表取算法。查找 key 为 `"batchCount_m_n_k_dataType"`（`cublasAlgoMap.cc:101`）。

### NCCL 通信与 2D 拓扑

```cpp title="nccl_utils.h"
struct NcclParam {
    int rank_{0};
    int world_size_{1};
    ncclUniqueId nccl_uid_;
    ncclComm_t   nccl_comm_ = nullptr;
};
// 通信原语（模板，支持 float/half/bf16/int/char/bool）
ftNcclAllReduceSum(send, recv, size, nccl_param, stream);
ftNcclAllGather(send, recv, size, rank, nccl_param, stream);
ftNcclSend(send, size, peer, nccl_param, stream);
ftNcclRecv(recv, size, peer, nccl_param, stream);
```

`ftNcclInitialize` 用 MPI 建立 2D 拓扑（`nccl_utils.cc:308-418`）：`MPI_Cart_create` 将 WORLD 划分为 `{pipeline_para_size, tensor_para_size}` 的 2D grid → `MPI_Cart_sub` 分裂出 TP 行通信器和 PP 列通信器 → 各 group root `ncclGetUniqueId` + `MPI_Bcast` 广播 → `ncclCommInitRank` 建立各自 NCCL communicator。`ftNcclStreamSynchronize`（`:215-273`）轮询检查 NCCL 异步错误——当 TP/PP 的 world_size 均为 1 时直接 `cudaStreamSynchronize` 返回；否则进入 `while` 循环用 `cudaStreamQuery` 轮询（`cudaSuccess` 返回、`cudaErrorNotReady` 继续、其他错误抛异常），循环中对 `tensor_comm` 和 `pipeline_comm` 调 `ncclCommGetAsyncError` 检查异步错误，非 `ncclSuccess` 则抛异常并 `ncclCommAbort` 中止通信器。

### Custom All-Reduce——绕过 NCCL

```cpp title="custom_ar_comm.h"
class AbstractCustomComm {
    virtual void customAllReduce(size_t elts, cudaStream_t stream) = 0;
    virtual bool swapInternalBuffer(std::vector<Tensor>* tensor_buffer, size_t elts) = 0;
};
template<typename T>
class CustomAllReduceComm: public AbstractCustomComm {
    AllReduceParams<T> param_;  // peer_comm_buffer_ptrs, barrier 等
};
```

通过 `cudaDeviceEnablePeerAccess` 建立 P2P 显存访问（`custom_ar_comm.cc:91-106`），每个 GPU 在其他 GPU 显存上分配通信 buffer（`:66-81`），自定义 CUDA kernel（`invokeOneOrTwoShotAllReduceKernel`）直接读写 peer 显存完成 all-reduce。`swapInternalBuffer`（`:108-122`）当 `rank_size_ > 1` 且 `elts * sizeof(T) <= CUSTOM_AR_SIZE_THRESHOLD`（48MB）时返回 true——将 `tensor_buffer->at(0).data` 保存到 `tmp_tensor_data_`，用 `param_.peer_comm_buffer_ptrs[rank_]` 替换 tensor 的 data 指针，`param_.local_output_buffer_ptr` 设为原始数据指针，通过指针交换避免额外拷贝。

`initCustomAllReduceComm` 在三种情况回退 NCCL：(1) 传入 `custom_all_reduce_comms` 为 nullptr（即 `enable_custom_all_reduce=0`）；(2) `rank_size != RANKS_PER_NODE`（非 8-GPU 节点，`BUILD_MULTI_GPU` 时打 warning，否则 `FT_CHECK` 报错）；(3) `CUDART_VERSION < 11020`（CUDA 11.2 以下无 async memory pool，打 warning）。满足条件时为每个 rank 创建 `CustomAllReduceComm<T>`，然后调 rank 0 的 `allocateAndExchangePeerAccessPointer` 完成跨 rank 的 buffer 共享。限制：仅支持 DGX A100 的 8-GPU 节点内（`RANKS_PER_NODE=8` 检查）。

**为什么不用 NCCL**：NCCL 处理跨节点网络通信，对节点内 NVLink/NVSwitch 拓扑不是最优。Custom all-reduce 跳过 NCCL 协议栈直接 P2P load/store，节点内延迟更低。TP layer 中优先用 custom、回退 NCCL（`TensorParallelGeluFfnLayer.cc:44-59`：检查 `enable_custom_all_reduce_ && custom_all_reduce_comm_ != nullptr`，`swapInternalBuffer` 成功则用 custom kernel，否则 NCCL）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 接口/实现分离 | `IAllocator` + `Allocator<CUDA/TF/TH>` | 运行时多态（虚函数）+ 编译时选择（模板特化），支持多框架后端 |
| 模板方法 | `IAllocator::reMalloc`（非虚模板方法，委托子类 `isExist`/`isReMalloc`/`malloc`/`free`） | 统一 REUSE/INCREASE/DECREASE 逻辑，子类只填底层操作 |
| Wrapper/Facade | `cublasMMWrapper` 封装 5 个资源（handle + ltHandle + algoMap + mutex + workspace） | 调用方不感知 descriptor 创建/算法选择/workspace 管理 |
| RAII | `Allocator<CUDA>` 构造初始化内存池 + P2P，析构释放；`cublasMMWrapper` 构造分配 32MB workspace，析构释放 | 资源生命周期与对象绑定 |
| Singleton | `Logger` 用 `thread_local` 单例 | 线程隔离的日志实例 |

## 模块间交互

`utils/` 被 `kernels/`（`memory_utils` 的 `deviceMalloc`/`deviceFree`、`cudaAutoCpy`）、`layers/`（`BaseLayer` 持有 `IAllocator*` + `cublasMMWrapper*`，所有 layer 调 `Gemm` 和 `reMalloc`，TP layer 调 `ftNcclAllReduceSum`）、`models/`（`ParallelGpt` 持 `NcclParam tensor_para_`/`pipeline_para_`，调 `ftNcclSend`/`ftNcclRecv`，`loadWeightFromBin` 加载权重）依赖。`Tensor`/`TensorMap` 作为所有 layer `forward` 的 I/O 容器。`triton_backend/` 和 `th_op/` 通过 `Allocator<TH>` / `Allocator<TF>` 复用框架内存。

`Tensor` 在数据流中的角色：它是非拥有式引用——layer 通过 `input_tensors->at("hidden_features").getPtr<T>()` 获取裸指针，通过 `allocator_->reMalloc` 分配输出 buffer，再构造 Tensor 包装返回。内存由 `IAllocator` 管理，Tensor 只传递引用。

## 扩展方式

**替换 allocator 为自定义内存池**：新增 `AllocatorType` enum 值 → 实现 `Allocator<AllocatorType::CUSTOM>` 模板特化（继承 `IAllocator`，实现 `malloc`/`free`/`isExist`/`isReMalloc`/`setStream`/`memSet`）→ 创建 engine 时传入。上层代码无需修改（通过 `IAllocator*` 接口使用）。参考 `allocator.h:126-262`。

**新增 GEMM 精度（如 FP8）**：在 `CublasDataType`/`FtCudaDataType`/`OperationType` enum 加类型（`cuda_utils.h:49-71`）→ 在 `getCublasDataType<T>()`/`getCudaDataType<T>()` 加特化（`:325-362`）→ 在 `cublasMMWrapper` 加 `setFP8GemmConfig()` → 在 `LtHgemmCustomFind` 加新类型的 Atype/Btype/Ctype 设置 → 运行 gemm_test 生成新的 `gemm_config.in` 条目。

**新增 NCCL 通信原语（如 ReduceScatter）**：在 `nccl_utils.h` 声明模板函数 → 在 `.cc` 实现（调 `ncclReduceScatter` + `NCCLCHECK`）→ 添加模板显式实例化（float/half/bf16/int）→ 在 `BUILD_MULTI_GPU` 条件编译块内实现（非多 GPU 构建为空函数）。

> 扩展点的契约（`IAllocator` 接口、`cudaDataType` 映射）见概览「架构设计解析 > 核心概念」。
