---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "分布式训练"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "DDP", "NCCL", "ProcessGroup", "分布式"]
description: "ProcessGroup 通信抽象 + DDP bucket 梯度同步 + Reducer autograd hook 异步 overlap + NCCL/gloo backend 策略 + comm_hook 扩展。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

PyTorch 分布式训练模块（`torch.distributed` Python + `torch/csrc/distributed/c10d` C++）提供多机多卡训练基础设施：`ProcessGroup` 通信抽象、DDP（`DistributedDataParallel`）梯度同步、collective 通信原语、c10d store 协调。它让"多卡训练像单卡一样简单"——DDP 包裹 `nn.Module` 后，用户照常写 `model(x)`/`loss.backward()`，梯度同步在反向期间自动异步完成。

它横跨 Python API 层（DDP 模块）和 C++ 绑定层（c10d 通信），依赖 `nn.Module`（DDP 是 `Module` 子类，复用 forward hook）、autograd（`Reducer` 把 hook 挂到 `grad_accumulator_`）、ATen Dispatcher（collective op 经 `c10d::allreduce_` 派发）。核心设计是 **bucket-based gradient 同步 + backward 期间异步 overlap**：梯度按 25MB bucket 聚合，一旦桶内梯度 ready 立即启动 all-reduce，与剩余 backward 计算重叠。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  init_process_group (distributed_c10d.py:1666)                │
│  rendezvous → Store (TCPStore/PrefixStore)                     │
│  → ProcessGroup (per device backend: NCCL/Gloo)                │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  ProcessGroup (ProcessGroup.hpp:67)  C++ 通信抽象               │
│  allreduce/broadcast/send/recv/allgather → Work (异步)          │
│  backendTypeToBackend_ map: device → Backend                    │
└──────────┬───────────────────────────────────────────────────┘
           │ getBackend(deviceType)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Backend (Backend.hpp:60)  per-device 实现                      │
│  ProcessGroupNCCL → ncclAllReduce (ProcessGroupNCCL.cpp:4526)  │
│  ProcessGroupGloo → gloo collective                            │
└──────────┬───────────────────────────────────────────────────┘
           │ DDP 包裹
           ▼
┌──────────────────────────────────────────────────────────────┐
│  DistributedDataParallel (distributed.py:466)                  │
│  class DDP(Module, Joinable)                                   │
│  self.reducer = dist.Reducer(...)  ← 同步引擎                   │
│  forward: prepare_for_forward → module.forward → prepare_for_backward│
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Reducer (reducer.hpp:100)  DDP 同步引擎                        │
│  autograd_hook(index) → mark_bucket_ready → all_reduce_bucket   │
│  kDefaultBucketBytesCap = 25MB                                  │
│  构造时对每个 param 注册 grad_acc post_accumulation_hook          │
└──────────┬───────────────────────────────────────────────────┘
           │ run_comm_hook
           ▼
┌──────────────────────────────────────────────────────────────┐
│  CommHookInterface (comm.hpp)                                  │
│  AllReduceCommHook / FP16CompressCommHook (C++ 内置)            │
│  PythonCommHook (用户自定义)                                    │
│  runHook(GradBucket) → Future                                  │
└──────────────────────────────────────────────────────────────┘
```

`init_process_group` 用 Store 协调 rendezvous，构造 `ProcessGroup`（按 device 路由到 NCCL/Gloo backend）。DDP 包裹 Module，构造 `Reducer` 把 hook 挂到每个 param 的 `grad_accumulator_`。反向时 autograd engine 累积完梯度自动触发 `autograd_hook` → bucket ready → `all_reduce_bucket` → `comm_hook` → NCCL all-reduce。

## 调用链路

```text
init_process_group(backend, device_id)          # distributed_c10d.py:1666
  |  backend = Backend.default_device_backend_map[device]  # :1826
  |  store = rendezvous(init_method) / PrefixStore("default_pg", store)  # :1890
  v
_new_process_group_helper(...)                  # :1984
  |  pg = ProcessGroup(prefix_store, rank, size)
  |  for device,backend_str in BackendConfig:
  |    if nccl: backend_class = ProcessGroupNCCL(...)    # :2207
  |    if gloo: backend_class = ProcessGroupGloo(...)    # :2169
  |    pg.setBackend(device, backend_type, backend_class)
  v
DDP = DistributedDataParallel(model, ...)       # distributed.py:816
  |  _ddp_init_helper → _compute_bucket_assignment_by_size
  |  self.reducer = dist.Reducer(params, bucket_indices, pg, ...)  # :1443
  |    注册 autograd_hook 到每个 param.grad_acc
  v
DDP.forward(inputs)                             # :1884
  |  reducer.prepare_for_forward()
  |  module.forward(...)
  |  reducer.prepare_for_backward(output_tensors)
  v  (backward 自动触发)
param.grad_acc → Reducer.autograd_hook(index)  # reducer.cpp:668
  |  mark_variable_ready → mark_bucket_ready(bucket_index)
  |    all_reduce_bucket(bucket)  # :978
  |      GradBucket grad_bucket(...); bucket.future_work = run_comm_hook(grad_bucket)
  v
run_comm_hook → AllReduceCommHook.runHook      # default_comm_hooks.cpp:11
  |  state_->allreduce(tensors)->getFuture()
  v
ProcessGroupNCCL::allreduce_impl                # ProcessGroupNCCL.cpp:4526
  |  collective(..., [&](input,output,comm,stream){
  |      ncclAllReduce(input.data_ptr(), output.data_ptr(),
  |                    numel, ncclDataType, ncclReduceOp, comm, stream.stream())
  |  }, OpType::ALLREDUCE, asyncOp, ...)
  v  Work → getFuture() → ivalue::Future
bucket.future_work.wait() → copy grads to param.grad
```

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `init_process_group` | `distributed_c10d.py:1666` | 初始化进程组 | Store rendezvous + PrefixStore 隔离 |
| `_new_process_group_helper` | `distributed_c10d.py:1984` | 构造 PG | per-device backend 路由 |
| `DDP.forward` | `distributed.py:1884` | DDP 前向 | prepare_for_forward/backward 包裹 |
| `Reducer.autograd_hook` | `reducer.cpp:668` | 梯度 ready 回调 | mark_bucket_ready 触发 all-reduce |
| `all_reduce_bucket` | `reducer.cpp:978` | bucket 通信 | 拼接 bucket.gradients 整块通信 |
| `run_comm_hook` | `reducer.cpp` | 执行 comm hook | 返回 Future 不阻塞 |
| `AllReduceCommHook.runHook` | `default_comm_hooks.cpp:11` | 默认 hook | `/= world_size; allreduce` |
| `ProcessGroupNCCL::allreduce_impl` | `ProcessGroupNCCL.cpp:4526` | NCCL all-reduce | 调 `ncclAllReduce` |
| `ProcessGroup::allreduce` | `ProcessGroup.hpp:215` | 通信抽象 | 默认经 Dispatcher 派发 `c10d::allreduce_` |
| `Backend.register_backend` | `distributed_c10d.py:341` | 注册第三方 backend | 存入 `_plugins` |

</details>

## 核心实现

### ProcessGroup 与 Backend 策略

`ProcessGroup`（`ProcessGroup.hpp:67`）是 C++ 通信抽象基类，每个方法返回 `c10::intrusive_ptr<Work>`（异步句柄）：

```cpp title="torch/csrc/distributed/c10d/ProcessGroup.hpp"
class ProcessGroup : public torch::CustomClassHolder {
  virtual c10::intrusive_ptr<Work> allreduce(
      std::vector<at::Tensor>& tensors, const AllreduceOptions& opts) {
    static auto op = c10::Dispatcher::singleton()
        .findSchemaOrThrow("c10d::allreduce_", "")...;
    auto work = std::get<1>(op.call(tensors, ..., opts.asyncOp, ...));
    return work;
  }
  // broadcast / reduce / send / recv / allgather / reduce_scatter / barrier
};
```

`Backend`（`Backend.hpp:60`）是 per-device 真正实现基类。`ProcessGroup` 内部 `backendTypeToBackend_` map 按 `c10::DeviceType` 路由到 `ProcessGroupNCCL`/`ProcessGroupGloo`——同一 PG 可挂多 backend，实现 `"cpu:gloo,cuda:nccl"` 多设备混用。`ProcessGroup::allreduce` 默认实现经 `c10::Dispatcher` 派发到 `c10d::allreduce_` op（functional collective 路径），`ProcessGroupNCCL` override 走原生 `ncclAllReduce`。

### Reducer：bucket 聚合与异步 overlap

`Reducer`（`reducer.hpp:100`）是 DDP 同步引擎：

```cpp title="torch/csrc/distributed/c10d/reducer.hpp"
class Reducer {
  void autograd_hook(int64_t index);    // :668  grad 累积完触发
  void all_reduce_bucket(BufferBucket& bucket);  // :978
  static constexpr size_t kDefaultBucketBytesCap = 25MB;  // :18
  static constexpr size_t kDefaultFirstBucketBytes = 1MB;  // :17
};
```

设计决策（`reducer.hpp:18`）：bucket 聚合而非逐 tensor all-reduce——NCCL kernel launch 与 latency overhead 在小 tensor 上占主导；25MB bucket 接近带宽饱和点，把 N 次 all-reduce 合并成 1 次，大幅提升吞吐。首桶 1MB（`kDefaultFirstBucketBytes`）减小早期梯度等待延迟。bucket 按参数逆序分配（近似 backward 产生顺序，`_compute_bucket_assignment_by_size` `distributed.py:1427`）。

异步 overlap 设计（`reducer.cpp:668`）：`autograd_hook` 在 grad 累积完成后立刻 `mark_bucket_ready`→`all_reduce_bucket`，返回 `future_work` 不阻塞 autograd 线程；剩余 backward 计算与 all-reduce 通信重叠。`finalize_backward` 等所有 future。依赖默认流隐式排序（`reducer.cpp:985` 注释）。

### CommHook 扩展点

`CommHookInterface`（`comm.hpp`）抽象成 `runHook(GradBucket) -> Future`：

```cpp title="torch/csrc/distributed/c10d/default_comm_hooks.cpp"
class AllReduceCommHook {  // :11  默认 hook
  Future runHook(GradBucket& bucket) {
    tensors[0] /= world_size;
    return state_->allreduce(tensors)->getFuture();
  }
};
class FP16CompressCommHook {  // FP16 压缩：encode→allreduce→decode 链式
  Future runHook(GradBucket& bucket) {
    return encode(bucket).then(allreduce).then(decompress);
  }
};
```

设计决策：返回 `Future` 而非同步结果，允许压缩/编码/多轮通信等组合。Python hook（`python_comm_hook.cpp`）与 C++ hook 共用接口，前者灵活后者高效。用户调 `ddp.register_comm_hook(state, hook)`（`distributed.py:2178`）注入，用于 GossipGrad、梯度压缩等研究。

### Store 与 rendezvous

`Store`（`Store.hpp:48`）是 KV 存储抽象：`set/get/add/compareSet/wait/check/deleteKey`。子类 TCPStore/FileStore/HashStore/FakeStore。`PrefixStore`（`PrefixStore.cpp:10`）通过 `joinKey = prefix + "/" + key` 做命名空间隔离，`init_process_group` 用 `"default_pg/"` 前缀避免多租户键冲突。`init_process_group` 用 Store 在 rank 间交换 NCCL communicator 握手信息；`_store_based_barrier`（`distributed_c10d.py:1027`）用 `Store::add` + `wait` 实现集合同步。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Backend 策略 | `ProcessGroup` → `backendTypeToBackend_`（`ProcessGroup.hpp`） | 同一 API 挂多 backend，`cpu:gloo,cuda:nccl` 混用 |
| 异步 Work future | `Work`/`getFuture()`（`Work.hpp:67`） | CUDA 流 enqueue 立即返回，overlap 计算 |
| Bucket 聚合 | `Reducer`/`kDefaultBucketBytesCap`（`reducer.hpp:18`） | 合并小 tensor all-reduce，提升带宽利用 |
| Hook 注入 | `grad_acc` post_accumulation_hook（`reducer.cpp:202`） | autograd 累积完自动触发，DDP 不改 backward |
| 插件注册 | `Backend.register_backend`（`distributed_c10d.py:341`） | 第三方 backend 不改内核 |

## 模块间交互

- **DDP ⊃ nn.Module**：DDP 不改 module，在 `forward` 前后插 `_pre_forward`/`_post_forward`（`distributed.py:1744/1815`），复用 `module.forward`。
- **Reducer ↔ autograd**：Reducer 把 hook 挂到 `Variable::grad_accumulator_`（`reducer.cpp:202`），autograd 反向时自动调用，无需 DDP 参与。
- **ProcessGroup → NCCL/gloo**：`allreduce` 默认经 `c10::Dispatcher` 派发到 `c10d::allreduce_` op，`ProcessGroupNCCL` override 调 `ncclAllReduce`（`ProcessGroupNCCL.cpp:4540`）。
- **ProcessGroup → Dispatcher**：functional collective 路径与 `torch.compile`/PT2 eager 路径统一，`ProcessGroup::allreduce` 用 `c10::Dispatcher::findSchemaOrThrow("c10d::allreduce_")`（`ProcessGroup.hpp:224`）。

## 扩展方式

**新增 collective op**：`ProcessGroup.hpp` 加 `virtual c10::intrusive_ptr<Work> newOp(...)`；`Ops.cpp`/`Functional.cpp` register `c10d::newOp_` dispatcher schema；各 backend（`ProcessGroupNCCL.cpp`/`ProcessGroupGloo.cpp`）实现 override 调对应 nccl/gloo 原语；`distributed_c10d.py` 暴露 Python wrapper。

**自定义 comm_hook**：实现 `hook(state, bucket: GradBucket) -> torch.futures.Future[Tensor]`，调 `ddp.register_comm_hook(state, hook)`（`distributed.py:2178`）。参考 `default_comm_hooks.cpp:11`。

**加 backend**：实现 `ProcessGroupXxx` C++ 类（继承 `Backend`），Python 调 `Backend.register_backend("xxx", creator_fn, devices=["cuda"])`（`distributed_c10d.py:341`）；`BackendType::CUSTOM` 自动赋值。
