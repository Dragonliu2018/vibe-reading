---
source:
  type: "源码解读"
  project: "PyTorch"
  url: "https://github.com/pytorch/pytorch"
title: "Autograd 引擎"
date: "2026-08-19T12:09:21+08:00"
category: [AI, Infra, Training, PyTorch, CodeWiki, "2.13.0"]
tags: ["PyTorch", "Autograd", "反向传播", "DAG", "Engine"]
description: "tape-based 反向自动微分引擎：AutogradMeta 挂 TensorImpl、Node DAG 多线程拓扑执行、ReadyQueue per-device 并行、弱引用破环。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Training/PyTorch/CodeWiki/2.13.0/00-overview)

---

## 模块定位

Autograd 是 PyTorch 的反向自动微分引擎，实现 tape-based 反向模式 AD。前向计算时，它通过挂在 `TensorImpl` 上的 `AutogradMeta` 记录计算图（每个 op 生成一个 `Node`，通过 `next_edges_` 链成 DAG）；反向 `loss.backward()` 时，`Engine` 多线程拓扑遍历这个 DAG，逐节点执行 `apply` 计算梯度，最终累积到叶 tensor 的 `.grad`。

它横跨 C++（`torch/csrc/autograd`，引擎核心与 `Node` 体系）和 Python（`torch/autograd`，`Function` 自定义反向、`grad_mode`）。Autograd 的特殊之处在于它**既是 c10 的消费者**（`AutogradMeta` 挂在 `TensorImpl` 上），**又是 ATen Dispatcher 的一层**（`Autograd` DispatchKey 在 backend kernel 之前拦截，构建反向图）——这种双重身份让自动微分对用户透明：用户写 `y = x + 1`，Dispatcher 自动在 CPU kernel 执行前后插入 tape 记录。

## 模块架构

```text
┌──────────────────────────────────────────────────────────────┐
│  前向：Dispatcher Autograd key 拦截                            │
│  VariableType::add → create_gradient_edge → 写 AutogradMeta   │
└──────────────────────────┬───────────────────────────────────┘
                           │ grad_fn 链
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  AutogradMeta (variable.h:225)  挂在 TensorImpl::autograd_meta_│
│  grad_ (累积梯度) · grad_fn_ (非叶, 强引用)                    │
│  grad_accumulator_ (叶, 弱引用) · requires_grad_ · is_view_   │
└──────────┬───────────────────────────────────────────────────┘
           │ next_edges_
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Node (node.h)  反向图节点，继承 intrusive_ptr_target           │
│  sequence_nr_ · next_edges_ (edge_list) · input_metadata_     │
│  virtual apply(inputs) = 0  ← 子类实现反向公式                  │
└──────────┬───────────────────────────────────────────────────┘
           │ backward() 触发
           ▼
┌──────────────────────────────────────────────────────────────┐
│  Engine (engine.h)  单例                                       │
│  device_ready_queues_ (每设备一个 ReadyQueue)                  │
│  execute() → compute_dependencies(反向BFS) → thread_main       │
└──────────┬───────────────────────────────────────────────────┘
           │ 多线程拓扑执行
           ▼
┌──────────────────────────────────┐    ┌─────────────────────┐
│  ReadyQueue (priority_queue)      │    │ AccumulateGrad       │
│  按 sequence_nr 堆排序保序         │───▶│ (叶节点 sink,         │
│  device 线程 pin 在自己 queue     │    │  写 param.grad)       │
└──────────────────────────────────┘    └─────────────────────┘
```

四组件协作：前向时 Dispatcher 的 Autograd kernel 调 `create_gradient_edge`（`function.h:53`）把 `grad_fn_` 写入 `AutogradMeta`，收集输入 Variable 的 `gradient_edge` 作为 `next_edges_`，逐步链成反向 DAG；反向时 `Engine::execute` 做 `compute_dependencies`（反向 BFS 标记可执行 Node + 依赖计数），然后 `thread_main` 循环从 `ReadyQueue` 取任务、`evaluate_function` 执行 `Node::apply`、把输出累加进下游 `InputBuffer`、依赖归零时入队下游。

## 调用链路

`loss.backward()` 的完整执行链：

```text
loss.backward()
  │  THPVariable_backward (Python→C++)
  ▼
Engine::execute(root_edges, inputs, keep_graph, accumulate_grad)   # engine.cpp:1294
  ├─ init_local_ready_queue()              # 复用/创建 CPU ReadyQueue
  ├─ 构造 GraphTask (keep_graph, owner, cpu_ready_queue)
  ├─ graph_root = (单根直接用 / 多根 GraphRoot)   # basic_ops.h:91
  ├─ compute_dependencies(root, task, min_topo_nr)  # 反向 BFS 标记+依赖计数
  └─ execute_with_graph_task(graph_task, graph_root, input_buffer)  # :1418
       ├─ queue = ready_queue(cpu_ready_queue, graph_root->device())
       ├─ queue->push(NodeTask{graph_task, graph_root, input_buffer})
       └─ thread_main(graph_task)       # engine.cpp:518
            │  while (!graph_task->future_result_->completed()):
            │    task = local_ready_queue->pop()          # 按 seq_nr 堆排序
            │    evaluate_function(graph_task, task.fn, task.inputs, ...)  # :1064
            │      ├─ 跨 stream/device 同步 (wait event)
            │      ├─ func->operator()(inputs) → Node::apply()  # 执行反向公式
            │      └─ 遍历 next_edges_:
            │           InputBuffer.add(next.input_nr, output)  # 多入边隐式求和
            │           if 依赖归零 (is_ready):
            │             ready_queue(next.device)->push(NodeTask{next})  # :1218
            │    --graph_task->outstanding_tasks_
            ▼
  AccumulateGrad::apply(grads) → variable.mutable_grad() += grad  # accumulate_grad.cpp:96
  ▼
  fut->wait() → 返回 grad 列表
```

`compute_dependencies`（`engine.cpp:1256`）反向遍历图，在 `GraphTask::exec_info_` 记录每个 Node 的入边计数；`evaluate_function` 中每条 `next_edge` 的输出累加进对应 `InputBuffer`，当某下游 Node 的所有输入就绪（`is_ready`）才 `push` 进 `ReadyQueue`——天然实现拓扑序。`AccumulateGrad` 的 `sequence_nr=UINT64_MAX`（`accumulate_grad.h:43`）使其优先调度。

<details>
<summary>方法速查表</summary>

| 方法 | 位置 | 一行职责 | 关键设计决策 |
|------|------|----------|-------------|
| `Engine::execute` | `engine.cpp:1294` | 反向执行主入口 | 构造 GraphTask + compute_dependencies |
| `compute_dependencies` | `engine.cpp:1256` | 反向 BFS 标记可执行 Node | 依赖计数实现拓扑序 |
| `thread_main` | `engine.cpp:518` | worker 线程主循环 | 从 ReadyQueue pop → evaluate_function |
| `evaluate_function` | `engine.cpp:1064` | 执行单 Node | 跨 stream 同步 + apply + 下游入队 |
| `Node::apply` | `node.h` | 子类实现反向公式 | 纯虚函数，每个 op 一个子类 |
| `create_gradient_edge` | `function.h:53` | 前向时记录反向图 | 写 AutogradMeta + 收集 next_edges_ |
| `gradient_edge` | `variable.cpp:315` | 取"下一跳" | 非叶返 grad_fn，叶返 grad_accumulator |
| `AccumulateGrad::apply` | `accumulate_grad.cpp:96` | 叶节点梯度累积 | sequence_nr=MAX 优先，弱引用避免循环 |

</details>

## 核心实现

### Node 与 AutogradMeta

`Node`（`torch/csrc/autograd/node.h`）是反向图节点基类，继承 `c10::intrusive_ptr_target`：

```cpp title="torch/csrc/autograd/node.h"
struct TORCH_API Node : c10::intrusive_ptr_target {
  uint64_t sequence_nr_;          // 线程本地单调递增，ReadyQueue 据此保序
  edge_list next_edges_;          // 出边（指向下游 grad_fn）
  small_vector<InputMetadata> input_metadata_;  // 前向输出的 dtype/shape
  virtual variable_list apply(variable_list&& inputs) = 0;  // 子类实现反向公式
  variable_list operator()(variable_list&& inputs) { /* RecordFunction + apply */ }
};
```

`Edge`（`edge.h`）= `(intrusive_ptr<Node> function, uint32_t input_nr)`，标识"指向某 Node 的第几个输入"。`AutogradMeta`（`variable.h:225`）挂在 `TensorImpl` 上：

```cpp title="torch/csrc/autograd/variable.h"
struct AutogradMeta : public c10::AutogradMetaInterface {
  Variable grad_;                                  // 累积梯度
  c10::intrusive_ptr<Node> grad_fn_;               // 非叶节点的反向函数（强引用）
  c10::weak_intrusive_ptr<Node> grad_accumulator_; // 叶节点的 AccumulateGrad（弱引用）
  bool requires_grad_{false};
  bool is_view_{false};
  uint32_t output_nr_;                             // 作为父 Node 第几个输出
};
```

### Engine 多线程拓扑执行

`Engine`（`engine.h`）是单例，核心是 per-device `ReadyQueue`：

```cpp title="torch/csrc/autograd/engine.h"
class Engine {
  std::vector<std::shared_ptr<ReadyQueue>> device_ready_queues_;  // 每设备一个
  int max_recursion_depth_{MAX_DEPTH};
  virtual variable_list execute(...);
  virtual void thread_main(const std::shared_ptr<GraphTask>&);
  void evaluate_function(...);
  void compute_dependencies(Node* root, GraphTask&, uint64_t min_topo_nr);
};
```

`ReadyQueue`（`engine.cpp:448`）内部是 `std::priority_queue` 按 `sequence_nr` 排序，保证同线程构造序。设备线程 pin 在自己 queue 上，保证 stream 亲和——CUDA 反向计算落到 CUDA 设备线程，CPU 任务由调用线程自身驱动（`worker_device==NO_DEVICE` 分支）。`max_recursion_depth_`（`engine.h:246`）限制重入深度，超限启用 `reentrant_thread_init` 新线程，避免深图栈溢出。

### 引用计数与循环避免

PyTorch 精心设计引用方向以避免 `Tensor ↔ Node` 循环：

- 中间 Node 的 `next_edges_` 用**强** `intrusive_ptr<Node>`——前向图 root→leaf 强引用链完整，保证反向图存活到 backward。
- 叶 Tensor 的 `grad_accumulator_` 用**弱** `weak_intrusive_ptr<Node>`（`variable.h:230`）——Tensor 不强持有 `AccumulateGrad`，使其生命周期跟随反向图而非 Tensor。
- `AccumulateGrad::variable` 反向**强**引用 Tensor（`accumulate_grad.h:55` 注释"only a weak ref from the Tensor"）——保证 backward 时 Tensor 存活，但 Tensor 不反向持有 AccumulateGrad，环被打破。

`gradient_edge`（`variable.cpp:315`）的双语义统一了"下一跳"：非叶返回 `(grad_fn_, output_nr_)`，叶返回 `grad_accumulator_`。

### Python Function ↔ C++ Node 桥接

`torch.autograd.Function`（`function.py:369`）的 `apply` 经 `custom_function_call` 生成 `PyNode`（`python_function.cpp:592`）。反向时引擎调 `PyNode::apply`（`python_function.cpp:159`），获取 GIL，把 `variable_list` 转 Python tuple，回调用户定义的 `backward`/`vjp`。这让用户能用纯 Python 写自定义反向，同时复用 C++ 引擎的多线程调度。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| DAG 拓扑执行 + 依赖计数 | `compute_dependencies`（`engine.cpp:1256`） | 天然拓扑序，支持多线程并行 |
| 线程池 + 优先级队列 | `ReadyQueue` per-device（`engine.cpp:448`） | 多 GPU 并行反向，stream 亲和，保序 |
| Tape 记录 | `create_gradient_edge`（`function.h:53`） | 前向透明记录，无需用户标注 |
| 工厂跨 so | `AutogradMetaFactory`（`TensorImpl.h:188`） | TensorImpl(libc10) 不能直接 new AutogradMeta(libtorch)，用工厂解耦 |
| 弱引用破环 | `grad_accumulator_` weak（`variable.h:230`） | 打破 Tensor↔AccumulateGrad 循环 |

## 模块间交互

- **挂到 c10::TensorImpl**：`c10/core/TensorImpl.h:163` 定义抽象 `AutogradMetaInterface`，`AutogradMeta` 实现在 libtorch.so。跨 so 用 `ConcreteAutogradMetaFactory`（`variable.cpp:151`）注册到 `TensorImpl` 的工厂，`materialize_autograd_meta`（`variable.cpp:169`）懒加载——无梯度时零开销。
- **与 Dispatcher**：`AutogradCompositeImplicitAutograd` 等 dispatch key 的 kernel 在前向调用算子后通过 `create_gradient_edge`/`rebase_history` 记录图。`VariableType_*` kernel（`torch/csrc/autograd/VariableTypeManual.cpp`）注册到 `AutogradCPU` 等 key，在 backend kernel 前后插入 tape 记录。
- **与 DDP**：`Reducer`（`torch/csrc/distributed/c10d/reducer.hpp`）把 hook 挂到 `Variable::grad_accumulator_`，autograd 累积完梯度后自动触发 all-reduce。

## 扩展方式

**自定义带反向的 op**：继承 `torch.autograd.Function`（`function.py:369`），实现 `forward` + `backward`/`vjp` + `setup_context`，调用 `MyFn.apply(x)`；底层经 `custom_function_call` 生成 `PyNode`。C++ 侧继承 `Node` 实现 `apply`，前向用 `create_gradient_edge` 连边（参考 `basic_ops.cpp` 的 `Identity`）。

**修改并行策略**：设备线程数由 `device_ready_queues_.size()` 决定（=设备数，`start_device_threads`）；重入受 `max_recursion_depth_`（`engine.h:246`）控制；调整 `ReadyQueue` 堆比较函数可改变调度优先级。
