---
source:
  type: "源码解读"
  project: "Faiss"
  url: "https://github.com/facebookresearch/faiss"
title: "GPU 后端"
date: "2026-09-21T22:21:40+08:00"
category: [Database, VectorSearch, Faiss, CodeWiki, "1.15.1"]
contentType: "CodeWiki"
tags: ["Faiss", "CUDA", "GPU", "CAGRA"]
description: "Faiss GPU 后端解读——GpuIndex 族与资源解耦、StackDeviceMemory 栈式临时内存、interleaved 布局与 warp shuffle 扫描、CAGRA 委托 cuVS 与多 GPU 建图、GpuCloner"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/00-overview)

---

## 模块定位

`faiss/gpu/`（~48K 行 CUDA）+ `faiss/gpu_metal/` 是 GPU 侧的完整重实现。核心架构决策：**GPU 不复用 CPU 的 scanner 抽象**——CPU `InvertedListScanner` 是"一 list 一循环、逐向量标量处理"，而 GPU 把并行单位改成 **(warp × 32 向量 × 交织位平面)**，数据布局本身为"一 load 全 warp、一 shuffle 换位"重排——这不是实现细节而是**存储格式级**的改变。所以 `GpuIndexIVF` 刻意不继承 `IndexIVF`（GpuIndexIVF.h:37-39 注释自述原因："many of the public data members... is not supported in the same manner on the GPU"），只共享 `IndexIVFInterface` 的参数语义。

## 模块架构

![GPU 后端分层](/vibe-reading/images/articles/faiss-internals/gpu-layers.svg)

四层：**GpuIndex 族**（与 CPU Index 同 API 的门面）、**GpuResources**（资源与调度解耦）、**impl/ kernel 层**、**utils/**（Tensor 抽象与 top-k 网络）。三个硬件后端：CUDA（主）、ROCm（`hipify.sh` 源码级转换，先 sed 预替换 `__nv_bfloat16` 因"转换器不准"）、Metal（Apple Silicon，复用 `index_cpu_to_gpu` 同名 API）。

## 核心实现

### GpuIndex 与资源管理

`GpuIndex`（GpuIndex.h:52）直接继承 `faiss::Index`，模板方法模式：`add/search` 在基类做**分页与跨设备搬运**（x 可驻留在 CPU 或任一 GPU，超过 256MiB 才分页，GpuIndex.cu:29），子类只实现 `addImpl_/searchImpl_`。`GpuIndexConfig` 的 `use_cuvs` 默认 **false（opt-in）**——v1.15 的改动（"Make cuVS dispatch opt-in rather than build-implied"）：cuVS "selects a different implementation with its own numerical behaviour"（GpuIndex.h:42-45），不能因二进制怎么链接就悄悄换实现；`should_use_cuvs`（GpuIndex.cu:46）对 compute capability < 7 强制 false。

`StandardGpuResourcesImpl::initializeForDevice`（StandardGpuResources.cpp:337-451）一次创建默认流、异步拷贝流、备流、cuBLAS handle（CUDA 11+ 设 `CUBLAS_MATH_DISALLOW_REDUCED_PRECISION_REDUCTION` 防 tensor core 降精度）。关键设计：**AllocInfo 携带 cudaStream_t**（GpuResources.h:119-133）——缓存内存上次在 stream 3 用、本次请求在 stream 4 时，内存管理器要用 event 同步，保证返回内存无数据竞争。临时内存上限按显存分级（≤4GiB 卡 512MiB、≤8GiB 卡 1GiB、封顶 1.5 GiB，`getDefaultTempMemForGPU`，StandardGpuResources.cpp:180-207）；pinned host memory 默认分配 256MiB（kDefaultPinnedMemoryAllocation）。

**StackDeviceMemory**（utils/StackDeviceMemory.h:22）——栈式临时内存：`getAlloc` 就地 bump 指针，`returnAlloc` 就是 `head_ = p`（注释断言 "Allocations should be freed in reverse order"）。**why 栈式**：Faiss GPU 调用里临时张量的生命周期严格嵌套（= C++ scope），LIFO 与作用域天然同构；bump 分配 O(1)、零碎片、零 cudaMalloc 抖动。跨流安全：`lastUsers_` 链表记录刚释放区间的最后使用流，下次分配重叠区间时插 event（StackDeviceMemory.cpp:99-101）；装不下的请求溢出到 cudaMalloc（AllocType::TemporaryMemoryOverflow）。

### GPU Flat：L2 两步法 + 双缓冲流水线

`runDistance`（impl/Distance.cu:121-406）：**L2 两步法** `d² = ‖c‖² − 2qc + ‖q‖²`——`‖c‖²` 加向量时预计算（FlatIndex.cu:281），`‖q‖²` 查询时现算，`-2qc` 交给 **cuBLAS GEMM**（`alpha=-2.0f`）。tile 化（目标 512MiB 工作集、双向 ≥512）；**双缓冲 × 双备流流水线**：`distanceBufs[2]` 在两条 alternate stream 上 ping-pong，GEMM 与上一 tile 的 k-selection 重叠（Distance.cu:212-240）。L2 时用**融合核** `runL2SelectMin`——"fused kernel that performs both adding ‖c‖² to -2qc and k-selection, so we only need two passes over the huge region of output memory"（Distance.cu:301-308 原注释）。

### GPU IVF：interleaved 布局与 warp shuffle 扫描

**存储格式**（impl/IVFInterleaved.cuh:39）：每 32（warp）个向量一组**逐维度交织**——`bytesPerVectorBlockDim = kEncodeBits × 32 / 8`，32 个向量的同一维度码元连续存放，一次 32-bit load 同时取到 warp 内 32 个向量的数据。这是**为 warp shuffle 换位设计的布局**（CPU FastScan 交织块的 GPU 对应物，但并行单位从 SIMD lane 换成 warp）。

`ivfInterleavedScan` kernel（IVFInterleaved.cuh:39-224）——**grid 二维 (nprobe, nq)，一个 block 处理一个 (query, probe) 对**（query 维走 grid-stride 循环）。block 内：每 warp 认领一个 32-向量块 → lane i 的向量就是块内第 i 个，读码解码 → **SHFL_SYNC 换位**：query 按 dim 存于 lane，`SHFL_SYNC(queryReg, d, 32)` 把"第 d 维的 query 值"广播到正持有"第 d 维数据"的 lane（:174），`dist.handle(q, dec)` 累加——**一个 warp 协作算 32 个距离，每 lane 独立持有一个向量的距离累积器** → 喂给 BlockSelect（shared memory 的 block 级 top-k 堆）。

**两趟结构**：pass 1 每 block 产 `[query][probe][k]` 候选（无需全局同步）；pass 2（`ivfInterleavedScan2`，IVFInterleaved.cu:19-131）一个 block 归并一个 query 的全部 nprobe×k 候选——妙处是值打包成 `uint32 = (probe<<16) | k`（:69-75），**BlockSelect 的 value 通道天然携带来源信息**，最后才查 `listIndices` 重映射回用户 ID。k 分档实例化（`runIVFInterleavedScan` :216：k==1 → `<128,1,1>`、k≤32 → `<128,32,2>`、k≤1024 → `<128,1024,8>` 选线程/warp/每 warp 查询组合）；scan/ 目录按编译单元切片（注释："cut down on compile time"）。

append 侧 `ivfInterleavedAppend`（IVFAppend.cu:347-453）：**一个 block 负责一个 list、一个 warp 一组 32 向量**，每 lane 的编码用 `WarpPackedBits<EncodeT, EncodeBits>::write` 按位交织写进 warp 级打包字——codec 无关的通用位宽 kernel。

### CAGRA：GPU 图索引（委托 cuVS）

CAGRA 是**单层近邻图**（无分层导航），CPU 对应物是 `IndexHNSWCagra`——`GpuIndexCagra::copyTo`（GpuIndexCagra.cu:667-858）把 CAGRA 图直接平铺进 HNSW 的 level-0（`M = graph_degree/2`，上层不重算；可选 `gpu_hnsw_upper_levels` 在 GPU 上建上层——实测快 10x 但 recall 反而不如 base_level_only，默认关）。**v1.15.1 的 GpuIndexCagra 已无自研图 kernel**：不支持增量添加（`addImpl_` 抛 "adding vectors is not supported"——构建即全量 train）；本体是 `variant<monostate, shared_ptr<CuvsCagra<float/half/int8>>>>`（GpuIndexCagra.h:391），`CuvsCagra`（impl/CuvsCagra.cu:44）薄委托 `cuvs::neighbors::cagra::build/search`。多 GPU：`trainAllNeighbors_`（GpuIndexCagra.cu:358-564，CHANGELOG "Fold multi-GPU CAGRA build into train()"）用 `raft::device_resources_snmg` 单机多卡 clique——数据切成**重叠聚类**（overlap_factor=2，每向量进 2 个簇，factor=1 时无跨簇边 recall 崩塌，AllNeighborsCagraConfig.h:187 注释警告）→ 簇内建 kNN 图合并 → intermediate degree 128 剪枝到 64。

### GpuCloner

`ToGpuCloner::clone_Index`（GpuCloner.cpp:139-256）是 dynamic_cast 梯子：IndexFlat→GpuIndexFlat、IndexIVFFlat/PQ/ScalarQuantizer→各自 GPU 版、IndexHNSWCagra→GpuIndexCagra，构造 GPU config（折入 `GpuClonerOptions` 的 float16/cuVS 标志）后 `copyFrom`。`IndicesOptions` 四值（INDICES_CPU/IVF/32_BIT/64_BIT）——CPU 模式下 GPU 只返回 (listId, offset)，扫描后 host 端查 `listOffsetToUserIndex_` 回填。多 GPU：shard_type 1=按 ID 取模 / 2=按 ID 区间 / 4=按 list 区间。

### utils 层

**blockselect/warpselect = GPU 上的 SIMD top-k**（Select.cuh）：共享同一核心算法——thread-local 寄存器小队列 + warp 级队列的两级堆，`addThreadQ` 先过剪枝门槛，`checkThreadQ` 用 `__any_sync` 探测任一 lane 满才触发 `mergeWarpQ`（warp 内寄存器排序 + 归并）——网络基元是 `__shfl_xor_sync`（对应 CPU SIMD 的排序网络，只是 lane 间通信换成 shuffle）；blockSelect 最后做跨 warp 的 FinalBlockMerge。**Tensor/DeviceTensor**（Tensor.cuh:41 起，源自 fbcunn 的多维张量）：`__host__ __device__` 双端、strided/narrow/slice 视图；DeviceTensor 是拥有所有权的子类——构造经 `GpuResources::allocMemory`，AllocInfo 作构造参数。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 模板方法 | GpuIndex::add/search 分页 + addImpl_ 纯虚（GpuIndex.h:165） | 跨设备搬运统一，子类只见设备数据 |
| 栈式分配 | StackDeviceMemory（utils/StackDeviceMemory.h:22） | 临时张量生命周期 = scope |
| 双轨 | 自研 kernel vs cuVS（use_cuvs opt-in，GpuIndex.h:42） | 数值行为不同的实现必须显式选 |
| 值打包 | (probe<<16)|k 复用 BlockSelect value 通道（IVFInterleaved.cu:69） | 免第二套归并结构 |

## 模块间交互

向上共享 CPU `Index` 基类与 `IndexIVFInterface`；`GpuCloner` 消费 [CPU 索引](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/01-index-abstraction)；CAGRA 经 `IndexHNSWCagra` 与 [HNSW](/vibe-reading/articles/Database/VectorSearch/Faiss/CodeWiki/1.15.1/05-graph-indexes) 互转；Metal 后端（gpu_metal/）覆盖 Flat/IVFFlat/IVFPQ 三族，`MetalPythonBridge.h` 刻意纯 C++ 头无 ObjC 类型以便 SWIG 解析（:7-9 注释），Python 用户用同一套 `index_cpu_to_gpu()` 跨 CUDA/Metal。

## 扩展方式

**新增 GPU 索引变体**（参照 Flat/PQ/SQ 三胞胎）：impl/ 加 `Codec` 特化（仿 GpuScalarQuantizer.cuh 的 `Codec<QT, DimMultiple>`）→ ivfInterleavedAppend 已 codec 无关可复用 → scan/ 的 `IVFINT_CODECS` 加 case + 实例化单元 → 顶层仿 GpuIndexIVFScalarQuantizer 写门面 → GpuCloner 加分支 → cuVS 路径加委托类。最重的是 kernel 实例化矩阵（metric × codec × k 档）——scan/ 按编译单元切片的原因。
