---
title: "为线程池添加 CPU Core 绑定接口"
source:
  project: "xLLM"
  type: "PR"
  id: "1112"
  url: "https://github.com/jd-opensource/xllm/pull/1112"
  prType: "feat"
date: "2026-07-06"
category: [AI, 推理, xLLM, Contributions]
tags: ["ThreadPool", "CPU Affinity", "NUMA", "性能优化", "pthread", "Linux"]
description: "为 xLLM 的 ThreadPool 和 MPMCThreadPool 添加显式 cpu_cores 向量构造函数，支持调用方按线程下标精确指定绑定的 CPU 核心，并解析 initial_process_cpu_set 快照机制如何规避子线程亲和性继承问题。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#1112](https://github.com/jd-opensource/xllm/pull/1112) · **Issue** [#461](https://github.com/jd-opensource/xllm/issues/461) · **commit** [d59ea7a](https://github.com/jd-opensource/xllm/commit/d59ea7a) · **首发版本** v0.10.0 · **变更行数** +163 行 · **合并时间** 2026-03-30

---

## 背景

线程如果不绑定 CPU 核心，OS 调度器可以随时把它迁移到其他核心——这会带来 TLB 刷新、L1/L2 cache 失效，以及跨 NUMA 节点时的远端内存访问。对于 LLM 推理中的 worker 线程，这类开销尤其敏感：推理循环对同一批 tensor 反复操作，线程局部性对命中率影响显著。

PR #1014 已经为 xLLM worker **进程/线程**实现了 NUMA 节点级别的绑定（精度：整个 NUMA 域）。本 PR 实现了更细粒度的控制：调用方可以向线程池传入 `std::vector<int32_t> cpu_cores`，精确指定每个 worker 线程绑定到哪颗 CPU 核心（精度：单核）。

xLLM 有两种线程池实现：

| 类 | 队列结构 | 适用场景 |
|---|---|---|
| `ThreadPool` | 每线程一个私有 FIFO 队列 | 需要严格 per-tid 顺序的场景（如 `AsyncResponseProcessor`）|
| `MPMCThreadPool` | 全局无锁 MPMC 队列 + work stealing | 任务分发均匀、不需要固定 tid 的场景 |

两个类在本 PR 中均新增了 `cpu_cores` 构造函数。

---

## 前置知识

### 两种 CPU 绑定模式

PR 之前，线程池已有 `bool cpu_binding` 参数，依赖全局单例 `CpuAffinity` 轮询分配核心：

```cpp title="旧接口：全局轮询"
int32_t cpu_core = cpu_binding
    ? CpuAffinity::get_instance().next_cpu_core()  // 全局状态，round-robin
    : -1;
```

新接口：

```cpp title="新接口：显式向量"
int32_t cpu_core = cpu_cores.empty()
    ? -1
    : cpu_cores[i % cpu_cores.size()];  // 按线程下标取模
```

两者在 `threadpool.cpp` 中共存，提供不同的使用场景：

- `bool cpu_binding`：适合"我有一个全局 CPU 列表，线程池按顺序取"
- `std::vector<int32_t> cpu_cores`：适合"我明确知道线程 0 要跑在 core 4，线程 1 要跑在 core 12"

### `initial_process_cpu_set()` 的必要性

`bind_thread_to_cpu_core()` 在绑定前需要检查目标核心是否在进程可用的 CPU 集合里。直觉上，直接调用 `sched_getaffinity(0, ...)` 即可。但有一个陷阱：

> Linux CPU affinity 是**线程级别**的——一旦某个 worker 线程被绑定到单核，它自己的 `sched_getaffinity(0)` 返回的就是那个单核的 mask。该 worker 线程如果再创建子线程，子线程继承这个窄 mask，导致 `bind_thread_to_cpu_core` 拒绝任何不是那个核的 ID。

`cpu_affinity.cpp` 用一次性快照解决这个问题：

```cpp title="xllm/core/util/cpu_affinity.cpp — 初始亲和性快照"
const cpu_set_t& initial_process_cpu_set() {
  // C++11 保证 function-local static 的线程安全初始化，仅运行一次
  static const cpu_set_t mask = []() {
    cpu_set_t m;
    CPU_ZERO(&m);
    if (sched_getaffinity(0, sizeof(cpu_set_t), &m) != 0) {
      // 读取失败时假设所有 CPU 都可用
      for (int32_t i = 0; i < CPU_SETSIZE; ++i) CPU_SET(i, &m);
    }
    return m;
  }();
  return mask;
}
```

注释里明确说明：必须在主线程（且在任何 worker 线程缩窄自己亲和性之前）调用一次，将结果缓存。`CpuAffinity::set_cpu_affinity()` 在程序初始化时通过 `(void)initial_process_cpu_set()` 完成这次热身。

---

## 实现

### 新构造函数：`cpu_cores` 向量

**`ThreadPool`**（`threadpool.cpp:71`）：

```cpp title="xllm/core/util/threadpool.cpp — ThreadPool cpu_cores 构造函数"
ThreadPool::ThreadPool(size_t num_threads,
                       Runnable init_func,
                       std::vector<int32_t> cpu_cores,
                       const std::string& pool_name)
    : queues_(num_threads), pool_name_(pool_name) {
  log_threadpool_creation(
      num_threads, pool_name,
      ", cpu_cores " + std::to_string(cpu_cores.size()));

  std::shared_ptr<Runnable> shared_init;
  if (init_func) {
    shared_init = std::make_shared<Runnable>(std::move(init_func));
  }
  auto counter =
      std::make_shared<BlockingCounter>(static_cast<int32_t>(num_threads));

  for (size_t i = 0; i < num_threads; ++i) {
    // 取模索引：cpu_cores 长度不必等于线程数
    int32_t cpu_core = cpu_cores.empty() ? -1 : cpu_cores[i % cpu_cores.size()];
    threads_.emplace_back([this, i, cpu_core, shared_init, counter]() {
      internal_loop(i, shared_init, counter, cpu_core);
    });
  }
  counter->wait();  // 等所有线程完成初始化（含绑定）后才返回
}
```

**`MPMCThreadPool`** 有相同结构，但 `init_func` 和 `counter` 的生命周期管理略有不同（见下文 Review 节）。

### 取模索引的实际意义

`cpu_cores[i % cpu_cores.size()]` 允许核心数和线程数不必相等：

| 场景 | 行为 |
|---|---|
| `cpu_cores.size() == num_threads` | 一一对应，每线程绑定专属核心 |
| `cpu_cores.size() < num_threads` | 循环复用，多个线程共享同一核心（绑在同一个物理核的不同超线程）|
| `cpu_cores.size() > num_threads` | 只用前 N 个核心 |
| `cpu_cores.empty()` | 不绑定，行为和原来一样 |

> 代码中有一段注释掉的"不匹配时跳过绑定"逻辑——这是 PR 描述中提到的行为，但最终合并的代码选择了更灵活的取模方案，不做硬性匹配检查。

### `internal_loop`：绑定发生在线程启动时

`internal_loop` 接收 `cpu_core` 作为值参数，是线程函数的入口：

```cpp title="ThreadPool::internal_loop — 绑定时机"
void ThreadPool::internal_loop(size_t index,
                               std::shared_ptr<Runnable> init_func,
                               std::shared_ptr<BlockingCounter> block_counter,
                               int32_t cpu_core) {
  // 1. CPU 绑定（在 init_func 之前）
  if (cpu_core >= 0 && bind_thread_to_cpu_core(cpu_core) != 0) {
    LOG(WARNING) << "Thread " << index << " CPU binding to core " << cpu_core
                 << " failed, running unbound";
  }
  // 2. 用户自定义初始化（模型加载、设备初始化等）
  if (init_func && *init_func) {
    (*init_func)();
  }
  // 3. 通知构造函数：初始化完成
  block_counter->decrement_count();

  // 4. 任务循环
  while (true) {
    Runnable runnable = queues_[index].pop();
    if (runnable == nullptr) break;
    runnable();
  }
}
```

绑定放在 `init_func` 之前是正确的顺序：`init_func` 通常做模型加载等操作，这些操作已经在绑定的核心上运行，内存分配和访问从一开始就是 CPU-local 的。

### `bind_thread_to_cpu_core`：实际绑定逻辑

该函数位于 `cpu_affinity.cpp`，两个线程池共用：

```cpp title="xllm/core/util/cpu_affinity.cpp — bind_thread_to_cpu_core"
int32_t bind_thread_to_cpu_core(int32_t cpu_core) {
  // 范围检查
  if (cpu_core < 0 || cpu_core >= CPU_SETSIZE) {
    LOG(ERROR) << "Invalid CPU core " << cpu_core;
    return -1;
  }

  // 检查目标核心是否在初始进程亲和性集合里（使用快照，避免继承问题）
  const cpu_set_t& allowed = initial_process_cpu_set();
  if (!CPU_ISSET(cpu_core, &allowed)) {
    LOG(ERROR) << "CPU core " << cpu_core
               << " is not in the initial process affinity set";
    return -1;
  }

  // 构造只含目标核心的 cpu_set_t
  cpu_set_t cpu_set;
  CPU_ZERO(&cpu_set);
  CPU_SET(cpu_core, &cpu_set);

  // 绑定当前线程
  if (pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpu_set) != 0) {
    LOG(ERROR) << "Failed to bind thread to CPU core " << cpu_core << ": "
               << strerror(errno);
    return -1;
  }

  LOG(INFO) << "=== Successfully bound thread to CPU core " << cpu_core;
  return 0;
}
```

失败全部走 `LOG(ERROR)` 后返回 -1，调用方收到 -1 才打 `LOG(WARNING)`——双层错误处理，不抛异常，不中止线程。

### `MPMCThreadPool`：原始指针与生命周期

`MPMCThreadPool` 使用栈上对象而非 `shared_ptr`：

```cpp title="MPMCThreadPool cpu_cores 构造函数片段"
BlockingCounter counter(num_threads);  // 栈上对象

for (size_t i = 0; i < num_threads; ++i) {
  int32_t cpu_core = cpu_cores.empty() ? -1 : cpu_cores[i % cpu_cores.size()];
  threads_.emplace_back([this, i, cpu_core,
                         init_func_ptr = &init_func,  // 捕获局部变量地址
                         counter_ptr = &counter]() mutable {
    internal_loop(i, init_func_ptr, counter_ptr, cpu_core);
  });
}
counter.wait();  // 阻塞直到所有线程完成初始化，此后指针不再被访问
```

Gemini bot 将此标记为"悬空指针风险"——但这里是安全的：`counter.wait()` 保证在构造函数返回（即 `counter` 和 `init_func` 离开作用域）之前，所有 `internal_loop` 已完成对这两个指针的访问（`decrement_count()` 之后不再访问它们）。`ThreadPool` 用 `shared_ptr` 的原因是它的线程在析构时才退出，生命周期更长，无法用栈对象安全地共享。

---

## 测试

新增四个测试用例（`tests/core/util/threadpool_test.cpp`）：

### `CpuCoreBindingConstructor`

最基本的验证：构造不崩溃，任务正常执行。用两个线程都绑 core 0，规避了容器环境中 core 1 可能不可用的问题：

```cpp title="tests/core/util/threadpool_test.cpp — CpuCoreBindingConstructor"
std::vector<int32_t> cpu_cores = {0, 0};  // 两个线程都绑 core 0
ThreadPool threadpool(2, nullptr, cpu_cores);
EXPECT_EQ(threadpool.size(), 2);
// 发两个任务，等待全部完成
```

### `CpuCoreBindingWithInitFunc`

验证 `init_func` 在绑定后被调用（用 `absl::Notification` 等待初始化完成信号）：

```cpp title="CpuCoreBindingWithInitFunc"
ThreadPool threadpool(
    1,
    [&init_called, &init_done]() {
      init_called = true;
      init_done.Notify();
    },
    cpu_cores);
EXPECT_TRUE(init_done.WaitForNotificationWithTimeout(absl::Milliseconds(500)));
EXPECT_TRUE(init_called);
```

### `CpuCoreBindingMismatchFallback`

传 2 个核心给 4 个线程——测试名叫"MismatchFallback"，但实际行为是取模循环分配：线程 0/2 绑 core 0，线程 1/3 绑 core 1。测试验证 4 个任务都能正常执行：

```cpp title="CpuCoreBindingMismatchFallback"
std::vector<int32_t> cpu_cores = {0, 1};  // 2 cores, 4 threads → modular
ThreadPool threadpool(4, nullptr, cpu_cores);
```

### `CpuCoreBindingVerifyAffinity` ★

这是最有意义的一个——用 `pthread_getaffinity_np` **实际读取**线程的 CPU 亲和性，验证绑定是否生效：

```cpp title="CpuCoreBindingVerifyAffinity — 真实验证"
const int32_t target_core = 0;
ThreadPool threadpool(1, nullptr, {target_core});
threadpool.schedule([&done, &affinity_ok, target_core]() {
  cpu_set_t cpu_set;
  CPU_ZERO(&cpu_set);
  // 在 worker 线程内部读取自己的亲和性
  if (pthread_getaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpu_set) == 0) {
    affinity_ok = CPU_ISSET(target_core, &cpu_set);
  }
  done.Notify();
});
EXPECT_TRUE(done.WaitForNotificationWithTimeout(absl::Milliseconds(500)));
EXPECT_TRUE(affinity_ok);
```

这个测试不满足于"没崩溃就算通过"，而是通过系统调用验证操作系统层面的绑定状态，是正确性测试而不只是冒烟测试。

---

## Review

**Gemini bot 的"悬空指针"误判**：

bot 指出 `MPMCThreadPool` 构造函数中 lambda 捕获了 `init_func` 和 `counter` 的地址，"当构造函数返回后指针将悬空"。这是一个有条件正确的分析——悬空确实会发生，但在悬空之前，`counter.wait()` 已经确保所有线程完成了对这两个指针的访问。bot 的分析忽略了等待语义，在这个特定的构造函数模式中属于误报。

**对比 `ThreadPool` 的 `shared_ptr` 方案**：

`ThreadPool` 用 `shared_ptr<Runnable>` 和 `shared_ptr<BlockingCounter>` 是更防御性的写法，代价是两次堆分配和引用计数操作。`MPMCThreadPool` 用原始指针更高效但更脆弱。两种选择都是有意识的权衡，不是疏漏。

---

## 意义与影响

这个 PR 和 PR #1014（NUMA 节点绑定）构成了 xLLM CPU 亲和性控制的两个层次：

| PR | 精度 | 接口 |
|---|---|---|
| #1014 | NUMA 节点（数十颗核） | 自动：按 GPU 归属 NUMA 检测 |
| #1112 | 单 CPU 核心 | 显式：调用方传 `cpu_cores` 向量 |

两者配合使用：#1014 确保 worker 进程运行在正确的 NUMA 域，#1112 进一步让线程池内每个线程锁定到特定核心——在多租户或 CPU 隔离要求严格的部署场景下（如 Kubernetes CPU Manager 的 `static` 策略），这是细粒度资源控制的基础。

`initial_process_cpu_set()` 的快照设计是一个值得记住的 Linux 亲和性编程模式：子线程继承父线程的窄亲和性，而 `sched_getaffinity(0)` 返回的是调用线程自己的 mask——在 worker 线程内用这个函数检查 "哪些 CPU 可用" 会得到错误答案。正确做法是在主线程早期（所有 worker 启动前）快照一次，然后在整个程序生命周期内复用这个快照。

---

## 参考

- [Linux `pthread_setaffinity_np` 手册](https://man7.org/linux/man-pages/man3/pthread_setaffinity_np.3.html)
- [Linux `sched_getaffinity` 手册](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html)
- [Kubernetes CPU Manager 静态策略](https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/)
