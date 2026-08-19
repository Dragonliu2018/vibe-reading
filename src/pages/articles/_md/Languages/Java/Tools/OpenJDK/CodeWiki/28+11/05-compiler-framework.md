---
source:
  type: "源码解读"
  project: "OpenJDK"
  url: "https://github.com/openjdk/jdk"
title: "JIT 编译框架"
date: "2026-08-19T23:29:36+08:00"
category: ["Languages", "Java", "Tools", "OpenJDK", "CodeWiki", "28+11"]
tags: ["OpenJDK", "HotSpot", "CompileBroker", "CompilationPolicy", "CodeCache", "nmethod", "ci", "Dependencies", "tiered"]
description: "HotSpot JIT 编译框架——CompileBroker 调度、分层编译策略、ci 适配层、CodeCache 分区、nmethod 三态与依赖失效"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Java/Tools/OpenJDK/CodeWiki/28+11/00-overview)

---

## 模块定位

JIT 编译框架模块（`share/compiler/` + `share/ci/` + `share/code/`，共 ~70k 行）是分层编译的"大脑与基础设施"：它调度何时编译、用哪个编译器、把产物装到哪、以及当假设被打破时如何失效。它不包含具体编译器实现（C1 在 `c1/`、C2 在 `opto/`），而是编排它们。职责边界是"编译调度 + 产物管理 + 依赖失效"，不含 IR 构造与优化（C1/C2 各自负责）。

## 模块架构

![JIT 编译框架](/vibe-reading/images/articles/openjdk-hotspot/compiler-framework-arch.svg)

应用线程计数超阈值 → `CompilationPolicy::event` 决定 tier → `CompileBroker` 把 `CompileTask` 入 `CompileQueue`（C1/C2 双队列）→ `CompilerThread` 取任务，经 `ci` 层适配 VM 读类型/方法/字段 → 调 C1 或 C2 编译 → 产物 `nmethod` 装入 `CodeCache` → `Method::set_code` 改写入口。编译期收集的 `Dependencies`（推测优化假设）注册到 `InstanceKlass`，类加载变化时检查，违反则触发 `Deoptimization`。`ci` 层隔离 JIT 与 VM 内部，规避 GC 移动对象的安全问题。

## 调用链路

### 分层编译触发与执行

```
计数器溢出
  → CompilationPolicy::event(method, inlinee, bci, level, nm)   (compilationPolicy.cpp:787)
     ├─ handle_counter_overflow → set_carry_on_overflow
     ├─ method_invocation_event → call_event → common<CallPredicate> → standard_transition
     │    transition_from_none (0→2/3) / transition_from_full_profile (3→4)
     └─ compile(mh, bci, next_level) → CompileBroker::compile_method  (compileBroker.cpp:1206)
         → compile_method_base (:1064): 查重 → create_compile_task 入队 → notify CompilerThread
              [CompilerThread] compiler_thread_loop (:1670)
         → queue->get → invoke_compiler_on_method (:1950)
            → ciEnv ci_env(task) → ciMethod* target = get_method_from_handle
            → comp->compile_method(&ci_env, target, osr_bci, install_code, directive)
            → ciEnv::register_method (:977) → nmethod::new_nmethod (nmethod.cpp:1090)
               → CodeCache::allocate (codeCache.cpp:604) → ik->add_dependent_nmethod (nmethod.cpp:1160)
            → nm->make_in_use() + method->set_code (ciEnv.cpp:1110)
```

### nmethod 失效

依赖违反（新类加载打破"final 无子类"等假设）→ `CodeCache::mark_dependents_on`（`codeCache.cpp:1494`）创建 `DepChange` → `DependencyContext::mark_dependent_nmethods`（`dependencyContext.cpp:69`）遍历 `nmethodBucket` 链表 → `nmethod::check_dependency_on`（`nmethod.cpp:3098`）`spot_check_dependency_at` 返回 witness 即失效 → `make_not_entrant` + `make_deoptimized` → `Deoptimization` pack/unpack 回退解释器。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
| --- | --- | --- |
| `CompilationPolicy::event` (`compilationPolicy.cpp:787`) | 触发决策 | 按 tier 阈值+队列反馈 |
| `CompileBroker::compile_method` (`compileBroker.cpp:1206`) | 提交编译 | 入队不阻塞应用 |
| `compiler_thread_loop` (`compileBroker.cpp:1670`) | CompilerThread 主循环 | queue.get 阻塞等待 |
| `select_task` (`compilationPolicy.cpp:690`) | 选最热方法 | event rate 排序+清理 stale |
| `nmethod::new_nmethod` (`nmethod.cpp:1090`) | 创建产物 | CodeCache 分配+注册依赖 |
| `Method::set_code` (`method.cpp:1441`) | 改写入口 | _from_interpreted_entry→i2c |

</details>

## 核心实现

### 分层编译与 CompilationPolicy

5 层 tier（`compilerDefinitions.hpp:54`）：`0` 解释器（profiling 由 MDO 收集）、`1` C1 纯优化无 profile、`2` C1+counter、`3` C1+完整 MDO、`4` C2 profile-guided 全优化。`CompilationPolicy`（`compilationPolicy.hpp:242`）用 `transition_from_none`/`transition_from_limited_profile`/`transition_from_full_profile` 决策转换，`CallPredicate`/`LoopPredicate` 模板参数区分调用与回边阈值。常见 `0→3→4`，C2 队列拥塞时 `0→2→3→4`，trivial 方法直接 `0→1`。分层的原因：C2 编译慢（大方法数百毫秒），只用 C2 启动延迟大；C1 是局部优化无 EA/全局调度，峰值远低于 C2；分层取启动快（C1）+峰值高（C2），C1 的 profile 为 C2 提供精确 type feedback。

### CompileBroker 与 CompilerThread

`CompileBroker`（`compileBroker.hpp:162`，`AllStatic`）持 `_compilers[2]`（C1/C2）与双 `CompileQueue`。编译异步：应用线程 `compile_method_base`（`:1064`）入队后立即返回（除非 blocking），`CompilerThread` 在 `compiler_thread_loop`（`:1670`）循环 `queue->get`（`MethodCompileQueue_lock.wait(5*1000)` 阻塞）。`select_task`（`:690`）按 event rate 选最热方法，`threshold_scale`（`:340`）按队列长度动态调阈值——C2 拥塞时提高阈值并先走 tier 2。`UseDynamicNumberOfCompilerThreads` 运行期增减线程。不阻塞应用线程是关键：CPU 密集的编译若同步执行会造成 STW 式停顿。

### ci 适配层

`ciEnv`（`ciEnv.hpp:47`，`StackObj`）持 `ciObjectFactory`(保证 ci 对象唯一)、`OopRecorder`、`Dependencies`、`CompileTask`。`ciMethod`（`ciMethod.hpp:60`）封装 `Method*` 的编译器视角，`ciInstanceKlass`（`:40`）缓存 `has_subklass`/`init_state` 等查询。ci 层存在的原因：**隔离 JIT 与 VM 内部**——VM 的 `Klass*`/`Method*` 在 GC/class loading 中可能移动或变化，`ciObjectFactory` 保证编译期内引用稳定，编译器无需处理 GC 安全；`cache_jvmti_state`（`:355`）编译开始时快照状态；C1/C2/Graal 都通过 `ci*` 接口访问 VM，抽象了查询类层级/方法/profile，使编译器不关心 VM 实现；ci 可表示未加载类（`get_unloaded_klass`）支持推测优化。

### CodeCache、nmethod 与 Dependencies

`CodeCache`（`codeCache.hpp:88`）管理多个 `CodeHeap`，分区（`codeBlob.hpp:45`）：`MethodNonProfiled`(tier 1/4)、`MethodProfiled`(tier 2/3)、`MethodHot`、`NonNMethod`(buffer/adapter/stub)。分区的原因：GC 扫描效率（NonNMethod 无 oop 不扫）、内存碎片控制（C2 产物远大于 C1）、I-Cache 局部性；`allocate`（`:604`）目标 heap 满时按链降级。`nmethod`（`nmethod.hpp:160`，继承 `CodeBlob`）三态生命周期 `not_installed(-1)→in_use(0)→not_entrant(1)`（`try_transition` 单调转换，`:2166`）：`make_in_use` 时 `set_code` 让调用点跳转；`make_not_entrant` patch 入口使新调用不进入但**已执行帧仍可执行完毕**，等栈无活动帧才 `do_unloading`/`purge` 回收——不能直接释放否则正在执行的线程会 crash。`Dependencies`（`dependencies.hpp:67`）编译期收集推测假设（`leaf_type`/`unique_concrete_method`/`unique_implementor` 等），注册到 `InstanceKlass._dep_context`，运行时 `check_*` 返回 witness 即失效。例如 C2 把接口单实现虚调用直接编译为直接调用并记 `unique_implementor`，新加载子类时失效回退。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 生产者-消费者 | `CompileQueue`+`CompilerThread` (`compileBroker.cpp`) | 编译异步不阻塞应用 |
| 策略 | `CompilationPolicy` transition 函数族 (`compilationPolicy.hpp:266`) | 阈值决策可替换，按队列反馈动态调 |
| 适配器 | `ciEnv`/`ciMethod` (`ci/`) | 隔离 JIT 与 VM，规避 GC 安全，支持多前端 |
| 观察者 | `Dependencies`+`DependencyContext` (`code/dependencies.cpp`) | 推测假设注册观察，变化通知失效 |
| 三态生命周期 | `nmethod` state (`nmethod.hpp:690`) | "先禁入口→等旧帧退出→回收"安全序列 |

## 模块间交互

`compiler` 调度 `c1`/`opto`(编译器) 与 `code`(产物)；`ci` 读 `oops`/`classfile`/`runtime` 给编译器只读视图；`code` 被 `interpreter`(调用点入口替换)、`runtime`(deopt 栈解释恢复)、`gc`(扫描 nmethod 内 oop) 三方使用。被 `interpreter`（计数器溢出触发）与 `runtime`（deopt）调用。

## 扩展方式

调整分层阈值：改 `compilationPolicy.cpp:1282` `standard_transition` 与 `transition_from_none`/`transition_from_full_profile` 的阈值比较，或调 `compiler_globals.hpp` 的 `Tier3InvocationThreshold`/`Tier4InvocationThreshold` flag。新增依赖类型：`dependencies.hpp:105` `DepType` 枚举加值，更新 `max_arg_count`/bitmask，加 `assert_xxx` 与 `check_xxx`，`dependencies.cpp` 的 switch 加 case，并在 C1/C2 适当位置调用。调 CodeCache 分区：改 `codeCache.cpp:203` `initialize_heaps` 各 heap size 公式或 `get_code_blob_type` 的 tier 映射。
