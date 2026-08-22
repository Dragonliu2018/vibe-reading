---
source:
  type: "源码解读"
  project: "FoundationDB"
  url: "https://github.com/apple/foundationdb"
title: "模拟测试体系"
date: "2026-08-22T15:19:30+08:00"
category: [Database, KVDB, FoundationDB, CodeWiki, "main-2026-08"]
tags: ["FoundationDB", "C++", "Simulation", "DeterministicRandom", "Buggify", "FaultInjection", "Workload"]
description: "模拟测试体系——Sim2 单进程确定性模拟整个集群 + Workload 框架 + FaultInjection/Buggify/SimBugInjector 故障注入，FDB 可靠性的根本保障。"
readingTime: "38 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/FoundationDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

`workloads/`（~54k 行）+ `SimulatedCluster.cpp` + `core/FDBSimulationPolicy.cpp` + `fdbrpc/sim2.cpp` + flow 的模拟原语，构成 FDB 的杀手锏——**确定性模拟（deterministic simulation）**。通过模拟的机器、网络、文件系统、确定性随机数和故障注入，在一个进程内模拟整个集群，跑数千个并发 workload，复现并发 bug。这是 FDB 可靠性的根本保障——每个 PR 都跑模拟回归。FDB 测试哲学认为分布式 bug 大多源于并发交互，单元测试难以覆盖，确定性模拟是核心策略。

## 模块架构

模拟体系由模拟器、workload 框架、故障注入三层组成：

- **Sim2**（`fdbrpc/sim2.cpp:1021`）——模拟器核心，`ISimulator` + `INetworkConnections`，替代 `Net2` 作 `g_network`。`now()` 返回虚拟时钟、`delay()` 模拟延迟、`connect/listen` 返回 `Sim2Conn`/`Sim2Listener`。`newProcess()` 创建模拟进程、`killProcess/killMachine/killZone/killDataCenter` 精确故障注入、`runLoop()`（`:1371`）单线程事件循环。
- **Sim2Conn**（`:293`）——模拟连接，`std::deque<uint8_t> recvBuf` 模拟 TCP 缓冲，sender/receiver actor 模拟双向传输+延迟，`rollRandomClose()` 0.001% 随机断连。
- **SimClogging**（`:189`）——模拟网络延迟/丢包/重排：`getSendDelay/getRecvDelay`、`clogPairFor/disconnectPairFor`、`halfLatency()` 提供 99.9% 快速 + 0.1% 长尾。
- **TestWorkload**（`tester/include/fdbserver/tester/workloads.h:66`）——所有 workload 抽象基类，四阶段接口 `setup/start/check/getMetrics`，`WorkloadPhase` 枚举（SETUP/EXECUTION/CHECK/METRICS）。`WorkloadContext` 携 `clientId/clientCount/sharedRandomNumber/dbInfo/options`。
- **WorkloadFactory<T>**（`:252`）——工厂模式自动注册，全局 `IWorkloadFactory::factories()` map，每 cpp 文件末尾 `WorkloadFactory<CycleWorkload> CycleWorkloadFactory;` 全局对象注册。`REGISTER_WORKLOAD` 宏。
- **CompoundWorkload**（`:153`）——组合模式，`add()` 子 workload 并发执行，`addFailureInjection()` 按概率注入故障 workload。
- **FailureInjectionWorkload**（`:122`）——故障注入基类，`initFailureInjectionMode/shouldInject`。具体有 `MachineAttrition`、`RandomClogging`、`Rollback`、`DiskFailureInjection`、`RandomMoveKeys`。
- **FDBSimulationPolicy**（`core/FDBSimulationPolicy.cpp:58`）——安全策略，`canKillProcesses`（`:131`）根据复制策略判断杀一批进程后集群能否存活，不能则自动降级 KillType（`KillInstantly`→`Reboot`）。
- **DeterministicRandom**（`flow/DeterministicRandom.cpp:36`）——`boost::mt19937_64` 跨平台一致，全局 `deterministicRandom()`。
- **SimBugInjector**（`flow/SimBugInjector.h:41`）——负面测试 bug 注入框架。
- **FaultInjection**（`flow/FaultInjection.h:26`）——`INJECT_FAULT` 宏，全局函数指针 `should_inject_fault` 模拟模式下设为 `simulator_should_inject_fault`（`sim2.cpp:75`）。
- **Buggify**（`flow/Buggify.h:92`）——概率性代码路径变异。

## 调用链路

一次模拟测试完整执行：

```text
fdbserver -r simulation  [fdbserver.cpp:1661]
  ├─ startNewSimulator()  [sim2.cpp:2614]  g_network = g_simulator = new Sim2()
  ├─ installFDBSimulationPolicy()  [FDBSimulationPolicy.cpp:348]
  ├─ resetServerKnobs(Randomize::True, IsSimulated::True)  随机化 knobs
  ├─ simulationSetupAndRun()  [SimulatedCluster.cpp:2744]
  │   ├─ TestConfig::readFromConfig(testFile)  解析 TOML
  │   ├─ newProcess("TestSystem") + Sim2FileSystem + FlowTransport::createInstance
  │   ├─ setupSimulatedSystem()  [:2233]
  │   │   ├─ SimulationConfig 随机生成集群配置（datacenters/machineCount/processes/coordinators）
  │   │   ├─ 随机: SSL(10%)/IPv6(25%)/hostname(25%)/assignClasses(50%)
  │   │   └─ for each machine: simulatedMachine → simulatedFDBDRebooter → fdbd()  [:714]
  │   │       ↑ 调用真实 fdbd 代码！storage/tlog/dd/proxy 全部真实运行
  │   ├─ delay(1.0) 等机器启动
  │   └─ runTests()  [tester/test.cpp:878]
  │       └─ runTests7() 编排器  [:518]
  │           ├─ changeConfiguration 设集群初始配置
  │           ├─ quietDatabase 等集群静默
  │           └─ for each TestSpec: runTest()  [:205]
  │               └─ runWorkload()  [:68]
  │                   ├─ 生成 sharedRandom
  │                   ├─ 给每个 tester 发 WorkloadRequest → 返回 WorkloadInterface
  │                   ├─ [SETUP] workload.setup
  │                   ├─ [EXECUTION] workload.start
  │                   ├─ [CHECK] workload.check（收集 success/failure）
  │                   └─ [METRICS] workload.getMetrics
  │               ├─ checkConsistency 一致性检查
  │               ├─ auditStorageCorrectness 存储审计
  │               └─ clearData 清理
  │           quietDatabase("End")
  └─ g_simulator->run()  Sim2::runLoop
```

Tester 工作进程侧 workload 创建：`getWorkloadIface`（`TesterServer.cpp:57`）按名查 `IWorkloadFactory::create` → `WorkloadFactory<T>::create` → `CompoundWorkload` 组合 + `addFailureInjection`（`WorkloadUtils.cpp:364`）遍历 `IFailureInjectorFactory` 按概率注入。

<details>
<summary>方法速查表</summary>

| 方法 | 文件:行 | 职责 |
| --- | --- | --- |
| `startNewSimulator` | `sim2.cpp:2614` | 创建 Sim2 实例 |
| `Sim2::runLoop` | `:1371` | 模拟器主事件循环 |
| `Sim2::newProcess` | `:1409` | 创建模拟进程 |
| `Sim2::killProcess/Machine` | — | 故障注入 |
| `canKillProcesses` | `FDBSimulationPolicy.cpp:131` | 安全策略判断 |
| `simulationSetupAndRun` | `SimulatedCluster.cpp:2744` | 模拟集群搭建+跑测试 |
| `setupSimulatedSystem` | `:2233` | 随机生成集群配置 |
| `simulatedFDBDRebooter` | `:714` | 调真实 fdbd() |
| `runTests7` | `test.cpp:518` | 测试编排器 |
| `runWorkload` | `:68` | 跑单个 workload 四阶段 |
| `WorkloadFactory::create` | `workloads.h:252` | 工厂创建 workload |
| `CompoundWorkload::addFailureInjection` | `WorkloadUtils.cpp:364` | 按概率注入故障 |
| `simulator_should_inject_fault` | `sim2.cpp:75` | 确定性故障注入决策 |
</details>

## 核心实现

### Test Double（非 mock）

FDB 的模拟不是 mock，而是 **Test Double**：每个模拟进程运行真实 `fdbd()` 代码（`SimulatedCluster.cpp:821`），只是底层 I/O 换模拟实现。模拟网络：`Sim2` 实现 `INetworkConnections`，`Sim2Conn`/`Sim2Listener` 实现 `IConnection`/`IListener`，有随机延迟（`SimClogging`）、随机断连（`rollRandomClose`）。模拟文件系统：`Sim2FileSystem`（`simulator.h:427`），`SimpleFile`（`sim2.cpp:620`）经 `INJECT_FAULT` 注入 I/O 故障，`AsyncFileNonDurable` 模拟非持久化文件。模拟进程：`Sim2::newProcess` 创建 `ProcessInfo` 独立地址/locality/全局变量空间，`runLoop` 单线程事件循环经 `onProcess/onMachine` 切换上下文。

### FaultInjection

全局函数指针 `should_inject_fault`（`FaultInjection.cpp:23`）模拟模式下设为 `simulator_should_inject_fault`（`sim2.cpp:75-112`），用确定性随机 + 进程的 `fault_injection_p1/p2` 决定是否注入。`INJECT_FAULT(io_timeout, "SimpleFile::read")` 宏在文件 I/O 抛模拟错误。故障注入在 `killProcess_internal`（`:1573`）通过设 `fault_injection_p1=0.1; fault_injection_p2=random01()` 激活。

### Buggify（概率性代码路径变异）

FDB 独创测试技术。`buggify(probability)`（`Buggify.h:92`）激活时以指定概率返回 true 进入不常走路径。两层随机性：(1) 每调用点（file:line）首次执行以 `P_GENERAL_BUGGIFIED_SECTION_ACTIVATED`(25%) 被激活，结果缓存在 `General_SBVars` map；(2) 激活后每次执行以 25% 实际触发。保证同一次运行内同调用点行为一致，不同运行间路径组合不同。General Buggify 经 `enableGeneralBuggify()` 全局开关控制。

### 策略模式 Workload 框架

`TestWorkload` 定义 `setup/start/check/getMetrics` 四阶段策略接口；`WorkloadFactory<T>` 模板自动注册；`CompoundWorkload` 组合多 workload + 故障注入并发执行；`FailureInjectionWorkload` 子类实现不同故障策略。`CycleWorkload`（`workloads/Cycle.cpp:34`）是典型模板——`NAME="Cycle"`，`start` 启动多 `cycleClient` actor 并发执行事务，`check` 验证 cycle 数据完整性。

### 确定性随机

`DeterministicRandom`（`DeterministicRandom.cpp:36`）用 `boost::mt19937_64` 跨编译器/平台一致。全局 `deterministicRandom()`，种子在 `startNewSimulator` 由命令行参数设定。`randLog` 记录所有随机调用便于调试。`peek()` 不消耗地窥探下一值。`bindDeterministicRandomToOpenssl()`（`flow.cpp:354`）甚至替换 OpenSSL `RAND_bytes` 为确定性随机——让涉及加密的模拟也完全可复现。

### SimBugInjector（负面测试）

注释（`SimBugInjector.h:28-33`）明确区分：Buggify 注入 FDB **必须正确处理**的故障（磁盘错误、网络延迟），验证容错能力；SimBugInjector 注入**实际 bug**（数据损坏、错误计算），用于**负面测试**——验证测试套件能否发现它该发现的 bug。`ISimBug::hit()` 执行 bug 行为，`enable()` 前置条件 `g_network->isSimulated()`。解决"测试的测试"问题：写了一致性检查 workload，怎么知道它真能发现数据不一致？用 SimBugInjector 注入导致不一致的 bug 验证。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Test Double 模拟 | `Sim2` in `sim2.cpp:1021` | 跑真实 fdbd 代码，发现的 bug 是真 bug |
| 故障注入 FaultInjection | `FaultInjection.h:26` | 确定性可控注入 I/O 故障 |
| Buggify 路径变异 | `Buggify.h:92` | 概率性走不常路径，两层随机保证一致 |
| 策略模式 Workload | `workloads.h:66` + `:252` | 四阶段接口 + 工厂自动注册 |
| 确定性随机 | `DeterministicRandom.cpp:36` | 种子固定→bug 100% 可复现 |
| 负面测试 SimBugInjector | `SimBugInjector.h:41` | 验证测试能否发现它该发现的 bug |

## 模块间交互

依赖 flow（`DeterministicRandom`/确定性原语）、fdbrpc（`sim2` 模拟网络）。被 fdbserver（`-r simulation` 入口）调用。**关键**：模拟复用真实代码路径——模拟进程运行完全相同的 `fdbd()`（`SimulatedCluster.cpp:821`），区别仅在：网络层 `FlowTransport::createInstance(true)` 底层是 `Sim2` 非 `Net2`；文件系统 `Sim2FileSystem` 替换真实，所有文件操作经 `SimpleFile`/`AsyncFileNonDurable` 在 `INJECT_FAULT` 注入错误；时间 `Sim2::now()` 由 `runLoop` 推进与真实无关；随机 `deterministicRandom()` 全局确定性。storage/tlog/dd/proxy 的**全部业务逻辑**在模拟中与生产运行同一份代码，只是底层 I/O 换模拟实现。

## 扩展方式

新增 Workload：在 `fdbserver/workloads/` 新建 `MyWorkload.cpp`，实现 `TestWorkload` 子类提供 `static constexpr auto NAME = "MyWorkload"` 和 `setup/start/check/getMetrics`，文件末尾 `WorkloadFactory<MyWorkload> MyWorkloadFactory(UntrustedMode::False);` 自动注册，TOML 引用 `testName = "MyWorkload"`。参考 `Cycle.cpp`。新增故障注入：继承 `FailureInjectionWorkload`（`workloads.h:122`）实现 `initFailureInjectionMode`/`shouldInject`，注册 `FailureInjectorFactory<T>` 全局对象自动加入 `IFailureInjectorFactory::factories()`，`start` 中调 `killProcess/killMachine`。参考 `MachineAttrition.cpp:201`。新增 I/O 故障注入：在目标 I/O 操作加 `INJECT_FAULT(error_type, "context")`，支持 `io_timeout`/`io_error`/`platform_error`，参考 `sim2.cpp` 的 `SimpleFile::read_impl`（`:789`）。
