---
title: "将 xLLM Worker 绑定到正确的 NUMA 节点"
source:
  project: "xLLM"
  type: "PR"
  id: "1014"
  url: "https://github.com/jd-opensource/xllm/pull/1014"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, XLLM, Contributions]
tags: ["NUMA", "CPU Affinity", "性能优化", "多GPU", "sysfs", "Linux"]
description: "为 xLLM 实现 NUMA 节点感知的进程/线程绑定：通过 sysfs 查询 GPU 的 NUMA 归属，驱动引擎进程绑定、跨 NUMA worker 强制 spawn、以及内存分配策略锁定，消除多 GPU 服务器上的跨 NUMA 内存访问开销。"
readingTime: "14 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1014](https://github.com/jd-opensource/xllm/pull/1014) · **Issue** [#462](https://github.com/jd-opensource/xllm/issues/462) · **commit** [4a5c92e](https://github.com/jd-opensource/xllm/commit/4a5c92e) · **首发版本** v0.9.0 · **变更行数** +350 行 · **合并时间** 2026-03-18

---

## 背景

典型的多 GPU 推理服务器（如 8×A800）通常拥有两个 CPU socket，每个 socket 对应一个 NUMA（Non-Uniform Memory Access）节点。每个 GPU 通过 PCIe 连接到某个 socket，也就是说它在物理上"属于"某个 NUMA 节点。

问题在于操作系统默认不感知这层关系：xLLM 的 engine 进程可能运行在 NUMA 0 的某颗 CPU 上，但它拉起的 GPU 1 worker（物理上属于 NUMA 1）所产生的内存流量却要跨越 NUMA 0→1 的互联总线。跨 NUMA 的内存访问延迟通常是本地访问的 1.5~2 倍，在推理场景的大量小 tensor 操作中，这是显著的吞吐损耗。

Issue #462 提出了这个需求。本 PR 的目标：让每个 xLLM worker 进程/线程运行在与其 GPU 同属一个 NUMA 节点的 CPU 上，并把内存分配策略也锁定在本地。

---

## 前置知识

### NUMA 拓扑与 GPU 亲和性

在双路服务器上，CPU 0~47 和 GPU 0~3 通常属于 NUMA 0，CPU 48~95 和 GPU 4~7 属于 NUMA 1。Linux 内核通过 sysfs 暴露每块 GPU 的 NUMA 归属：

```
/sys/bus/pci/devices/<PCI_BUS_ID>/numa_node
```

文件内容是一个整数，如 `0` 或 `1`，表示该 PCIe 设备所连接的 NUMA 节点。读到 `-1` 表示硬件/内核未提供有效 NUMA 信息（常见于虚拟机或单 socket 机器）。

### CPU 亲和性的两个层面

Linux 提供两套 API 来限制代码运行的 CPU：

| API | 作用范围 | 系统调用 |
|---|---|---|
| `sched_setaffinity(pid, ...)` | 整个进程（含所有线程）| `sched.h` |
| `pthread_setaffinity_np(thread, ...)` | 单个线程 | `pthread.h` |

两者都接受 `cpu_set_t`，内核确保该进程/线程只在指定的 CPU 集合上调度。

### NUMA 内存策略

CPU 亲和性只解决"代码在哪跑"的问题，还要解决"内存从哪分配"：

- `numa_set_membind(nodemask)`：将后续 `malloc`/`mmap` 的内存来源限制在指定 NUMA 节点
- `numa_set_strict(1)`：如果本地 NUMA 内存不足，不回退到远端节点，而是触发 OOM（推理场景下通常不会触发，但能暴露内存规划问题）
- `numa_migrate_pages(pid, old_mask, new_mask)`：将进程现有的已分配内存页面迁移到新 NUMA 节点

---

## 实现

### 一、`numa_utils`：底层工具库

新增 `xllm/core/platform/numa_utils.{h,cpp}`，提供 `xllm::numa` 命名空间下的六个函数：

```
is_numa_available()         → 探测系统 NUMA 支持（结果缓存）
get_num_numa_nodes()        → 查询节点数量
get_device_numa_node(idx)   → GPU 索引 → NUMA 节点 ID
bind_process_to_numa_node() → 绑定当前进程
bind_thread_to_numa_node()  → 绑定当前线程
get_numa_node_cpus(node)    → 查询节点内的 CPU 列表
```

#### sysfs 查询路径

`get_device_numa_node()` 的实现：先通过硬件 API 获取 GPU 的 PCI Bus ID，再查询 sysfs：

```cpp title="xllm/core/platform/numa_utils.cpp — get_device_numa_node（CUDA 路径）"
#if defined(USE_CUDA)
  char pci_bus_id[32] = {0};
  cudaError_t ret =
      cudaDeviceGetPCIBusId(pci_bus_id, sizeof(pci_bus_id), device_index);
  if (ret == cudaSuccess) {
    return get_numa_node_from_sysfs("CUDA", device_index, pci_bus_id);
  }
#elif defined(USE_MLU)
  // cnrtDeviceGetPCIBusId ...
#elif defined(USE_DCU)
  // hipDeviceGetPCIBusId ...
#endif
```

`get_numa_node_from_sysfs()` 拼出路径 `/sys/bus/pci/devices/<pci_bus_id>/numa_node`，直接读文件：

```cpp title="get_numa_node_from_sysfs"
std::string numa_path = "/sys/bus/pci/devices/" + pci_bus_id + "/numa_node";
int32_t numa_node = -1;
if (read_numa_node(numa_path, &numa_node)) {
  if (numa_node < 0) {
    // sysfs 里写了 -1，表示硬件未暴露 NUMA 信息
    return -1;
  }
  return numa_node;
}
```

这个路径是 Linux PCIe 子系统的标准接口，不依赖任何 GPU 厂商的私有 API，三种硬件后端（CUDA/MLU/DCU）共用同一套读取逻辑。

#### CPU Set 构建：与现有亲和性取交集

`build_cpu_set_for_numa_node()` 构造目标 NUMA 节点的 `cpu_set_t` 时，有一个关键细节——它不是直接取该 NUMA 节点的所有 CPU，而是与进程当前的 CPU 亲和性取**交集**：

```cpp title="build_cpu_set_for_numa_node — 交集逻辑"
cpu_set_t current_affinity;
CPU_ZERO(&current_affinity);
const bool has_affinity_constraint =
    (sched_getaffinity(0, sizeof(cpu_set_t), &current_affinity) == 0);

for (int32_t cpu = 0; cpu < nr_possible_cpus; ++cpu) {
  if (!numa_bitmask_isbitset(node_cpu_mask, cpu)) continue;  // 不在目标 NUMA 节点
  if (cpu >= CPU_SETSIZE) continue;
  // 若进程已有限制（如容器环境），只取双方都允许的 CPU
  if (has_affinity_constraint && !CPU_ISSET(cpu, &current_affinity)) continue;

  CPU_SET(cpu, cpu_set);
  ++(*nr_cpus);
}
```

这个设计在**容器化部署**中尤为重要：Kubernetes/Docker 通常会限制 Pod 可用的 CPU 集合（CPU Request/Limit），如果 xLLM 强行覆盖为整个 NUMA 节点的 CPU，会违反容器调度约定。取交集后，绑定结果既满足 NUMA 亲和性，又不超出容器分配的 CPU 范围。

#### `is_numa_available()` 的线程安全缓存

```cpp title="is_numa_available — 利用 C++11 静态局部初始化保证"
bool is_numa_available() {
  static const bool available = []() {
    bool is_avail = (numa_available() >= 0);
    if (!is_avail) {
      LOG(WARNING) << "NUMA is not available on this system";
    }
    return is_avail;
  }();
  return available;
}
```

C++11 保证函数局部静态变量的初始化是线程安全的（只运行一次）。`numa_available()` 的探测只在第一次调用时发生，后续调用直接返回缓存值——既避免了重复探测，也避免了加锁。

#### `bind_process_to_numa_node()`：CPU 亲和性 + 内存策略双绑

进程绑定分两步：

```cpp title="bind_process_to_numa_node"
// 步骤一：限制进程只能在目标 NUMA 节点的 CPU 上调度
pid_t pid = getpid();
if (sched_setaffinity(pid, sizeof(cpu_set_t), &cpu_set) != 0) {
  LOG(ERROR) << "Failed to bind process to NUMA node " << numa_node
             << ": " << strerror(errno);
  return -1;
}

// 步骤二：设置内存分配策略，并迁移现有页面
apply_process_memory_policy(numa_node);
```

`apply_process_memory_policy()` 内部：

```cpp title="apply_process_memory_policy"
// 迁移现有已分配内存到新 NUMA 节点
struct bitmask* old_mask = numa_get_membind();
if (old_mask != nullptr) {
  numa_migrate_pages(getpid(), old_mask, node_mask);  // 尽力迁移，失败只警告
  numa_free_nodemask(old_mask);
}

// 后续分配全部来自本 NUMA 节点
numa_set_membind(node_mask);
numa_set_strict(1);  // 不回退到远端节点
```

线程绑定 `bind_thread_to_numa_node()` 只做 CPU 亲和性（`pthread_setaffinity_np`），不做内存策略——因为内存策略是进程级别的，由父进程或 spawn 子进程统一设置。

---

### 二、`dist_manager`：决策中心

`setup_numa_affinity_and_isolation()` 是整个 NUMA 策略的决策入口，在 `DistManager::setup_multi_node_workers()` 最开始调用：

```cpp title="dist_manager.cpp — setup_numa_affinity_and_isolation"
// 1. 查询每个设备的 NUMA 节点
std::set<int32_t> unique_numa_nodes;
for (size_t i = 0; i < devices.size(); ++i) {
  device_numa_nodes[i] = numa::get_device_numa_node(devices[i].index());
  if (device_numa_nodes[i] >= 0) {
    unique_numa_nodes.insert(device_numa_nodes[i]);
  }
}

// 2. 将引擎进程绑定到第一个有效 NUMA 节点
int32_t engine_numa_node = -1;
for (auto numa_node : device_numa_nodes) {
  if (numa_node >= 0) { engine_numa_node = numa_node; break; }
}
if (engine_numa_node >= 0) {
  numa::bind_process_to_numa_node(engine_numa_node);

  // 3. 若检测到跨 NUMA 设备，标记需要 force spawn
  if (unique_numa_nodes.size() > 1) {
    for (size_t i = 0; i < devices.size(); ++i) {
      force_spawn_for_numa_isolation[i] =
          (device_numa_nodes[i] >= 0 &&
           device_numa_nodes[i] != engine_numa_node);
    }
  }
}
```

**关键设计**：引擎进程只绑定到**第一个**有效 NUMA 节点（即 device 0 的 NUMA 节点）。这是一个有意为之的选择：引擎进程负责调度和协调，让它在自己的 NUMA 节点上分配内存最合理；而跨 NUMA 的 worker 则必须以独立进程运行，不能复用引擎进程的内存空间。

#### 强制 spawn 逻辑

worker 的启动方式由以下表达式决定：

```cpp title="dist_manager.cpp — use_spawn_worker 决策"
bool use_spawn_worker =
    (options.enable_offline_inference() && i > 0) ||
    force_spawn_for_numa_isolation[i];   // ← PR 新增的条件
```

原来只有离线推理的第 2 个及以后的 GPU 才使用 spawn 进程，现在**跨 NUMA 的 GPU 也强制走 spawn 路径**。这不是可选的——如果跨 NUMA worker 以线程方式运行在引擎进程内，它会继承引擎进程的 CPU 亲和性（NUMA 0 的 CPU），即使我们之后调用 `bind_thread_to_numa_node` 也只能改变线程的调度，但无法改变已经分配在 NUMA 0 上的进程内存的访问路径。spawn 成独立进程后，子进程的整个虚拟地址空间都可以被锁定到正确的 NUMA 节点。

---

### 三、Worker 集成：各司其职

**spawn 子进程** (`spawn_worker_server.cpp`)：子进程启动后立即绑定进程：

```cpp title="spawn_worker_server.cpp — 子进程 NUMA 绑定"
int32_t numa_node = numa::get_device_numa_node(device_idx);
if (numa_node >= 0) {
  int32_t ret = numa::bind_process_to_numa_node(numa_node);
  if (ret != 0) {
    LOG(WARNING) << "Failed to bind worker process to NUMA node "
                 << numa_node << ", continuing without NUMA binding";
  }
}
```

失败时只打警告继续运行——NUMA 绑定失败不应中断服务，只是性能次优。

**线程 worker** (`worker_server.cpp`)：在 worker 线程创建时绑定线程（同 NUMA 设备走这条路径）：

```cpp title="worker_server.cpp — 线程 NUMA 绑定"
// Bind worker thread to the same NUMA node as the device
int32_t numa_node = numa::get_device_numa_node(device.index());
if (numa_node >= 0) {
  int32_t ret = numa::bind_thread_to_numa_node(numa_node);
  if (ret != 0) {
    LOG(WARNING) << "Failed to bind worker thread to NUMA node "
                 << numa_node << ", continuing without NUMA binding";
  }
}
```

整体调用链：

```
dist_manager::setup_multi_node_workers()
  └── setup_numa_affinity_and_isolation()        # 查询所有 GPU 的 NUMA，绑定引擎进程
       ├── bind_process_to_numa_node(engine_numa) # 引擎进程绑定
       └── force_spawn_for_numa_isolation[i]      # 标记哪些 GPU 需要 spawn
  └── WorkerServer (per GPU)
       ├── use_spawn_worker=true → SpawnWorkerServer
       │     └── bind_process_to_numa_node()      # 子进程绑定
       └── use_spawn_worker=false → 线程 worker
             └── bind_thread_to_numa_node()       # 线程绑定
```

---

## Review

**关于 NPU（910C）**（Clement-Wang26）：

reviewer 问 NPU 超节点场景下 NUMA 亲和性是否有意义。作者回复：NPU 超节点跨多个物理主机，CPU-NUMA 亲和性对跨主机的内存访问几乎没有帮助——那属于 PCIe-over-fabric 或 NVLink/HCCS 等互联层面的问题，NUMA 绑定解决不了。因此本 PR 在 `setup_numa_affinity_and_isolation` 上加了 `#if defined(USE_CUDA) || defined(USE_MLU) || defined(USE_DCU)` 条件编译，NPU 路径跳过整个函数。

**关于 MLU**（phantomlei3）：

reviewer 请求支持 MLU（寒武纪 GPU）的 NUMA 绑定。最终合并的代码中，`get_device_numa_node()` 有完整的 `#elif defined(USE_MLU)` 分支（通过 `cnrtDeviceGetPCIBusId` 查询 PCI Bus ID），`setup_numa_affinity_and_isolation`、`spawn_worker_server`、`worker_server` 的条件编译也都包含了 `USE_CUDA || USE_MLU || USE_DCU`——MLU 在代码层面已经支持。作者在 review 中的回应是"暂无 MLU 硬件做实测验证"，因此对 MLU 路径的正确性只能依赖代码逻辑推断，未经端到端验证。

**关于容器 CPU affinity 的交集设计**（gemini-code-assist）：

bot 最初指出 `build_cpu_set_for_numa_node` 可能与容器的 cpuset 冲突。这正是交集逻辑的设计动机——代码里的 `has_affinity_constraint` 检测 + 交集计算就是对这个 review 的回应。

---

## 意义与影响

NUMA 亲和性绑定是推理服务性能调优的一块标准拼图，vLLM、TensorRT-LLM 等主流框架都有类似机制。本 PR 为 xLLM 补上了这块。

几个值得关注的设计细节：

**sysfs 路径的通用性**：不依赖 NVIDIA/AMD/Cambricon 的私有 API 查询 NUMA 归属，而是通过 Linux 标准的 PCIe sysfs 接口。只要 GPU 通过 PCIe 连接到 CPU，这条路径就是可靠的，和硬件厂商无关。

**CPU Set 与容器亲和性取交集**：这个细节使得 NUMA 绑定在 Kubernetes 环境下也是安全的，不会因为 Pod 的 CPU 限制导致 `sched_setaffinity` 失败或绕过资源隔离。

**spawn 作为 NUMA 隔离的手段**：NUMA 域之间最干净的隔离边界是**进程**，而不是线程——因为虚拟地址空间、TLB、以及 glibc 的内存分配器状态都是进程级别的。强制 cross-NUMA worker 走 spawn 路径，确保了每个进程的内存系统完整地运行在一个 NUMA 域内。这和 NUMA-aware 数据库（如 PostgreSQL、MySQL）的多进程架构思路一脉相承。

**渐进式失败策略**：每个绑定步骤失败都只打 `LOG(WARNING)` 然后继续，不中止启动。NUMA 绑定是性能优化，不是正确性保障——服务在没有绑定的情况下仍然正常工作，只是有性能损耗。这种"尽力而为"的策略对生产环境是合理的。

---

## 参考

- [Linux NUMA API (`libnuma`)](https://linux.die.net/man/3/numa)
- [Linux `sched_setaffinity` 手册](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html)
- [Linux `pthread_setaffinity_np` 手册](https://man7.org/linux/man-pages/man3/pthread_setaffinity_np.3.html)
- [Linux PCIe sysfs 接口](https://www.kernel.org/doc/html/latest/PCI/sysfs-pci.html)
