---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "向量化执行引擎"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "向量化执行", "分布式查询"]
description: "MatrixOne 执行层解读：Plan → Scope 树编译、push 模型向量化算子、ants 并行、remoterun 跨 CN 执行与 MessageBoard 消息。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/sql/compile/`（约 2.6 万行）+ `pkg/sql/colexec/`（约 7.3 万行）+ `pkg/vm/`（pipeline/process/message，约 3.9k 行）构成执行引擎：把 pb Plan 编译成 Scope 树（含分布式 shuffle 拓扑），以 push 模型向量化算子执行。它独立于 plan 层是因为**吞吐与并行度是独立的性能域**——算子实现、内存限额、跨 CN 传输策略的演化不应影响计划语义；而独立于 disttae 是因为执行器面向 `engine.Reader` 抽象，不关心数据来自缓存还是 S3。

## 模块架构

```go title="pkg/sql/compile/types.go / pkg/vm/types.go"
type Compile struct {              // compile/types.go:248
    scopes []*Scope; pn *plan.Plan; e engine.Engine    // disttae engine
    proc *process.Process; MessageBoard *message.MessageBoard
    cnList engine.Nodes; fill func(*batch.Batch, ...) error   // 结果回调
}
type Scope struct {                // compile/types.go:159
    Magic magicType                // Normal / Merge / MergeInsert / Remote / DDL…
    DataSource *Source             // 扫描源（engine.Reader + RecvMsgList）
    PreScopes []*Scope              // 子 scope 树（多 CN / 多并行度）
    RootOp vm.Operator             // 算子树根（v4 已取代旧 Instruction 列表）
    NodeInfo engine.Node           // 目标 CN 地址 + Mcpu 并行度
}
type Operator interface {          // vm/types.go:210
    Free(proc, pipelineFailed bool, err error); Reset(...)
    Prepare(proc *process.Process) error
    Call(proc *process.Process) (CallResult, error)   // push 模型单步
}
type CallResult struct { Status ExecStatus; Batch *batch.Batch }  // ExecStop/ExecNext/ExecHasMore
```

`pkg/sql/colexec/` 下 60+ 个算子目录（hashjoin/group/insert/dispatch/fuzzyfilter/table_function/…）全部实现 `vm.Operator` 接口，嵌入 `OperatorBase`（vm/types.go:241）获得 Children/Analyzer/ID。`pkg/vm/process` 的 `Process` 携带 mpool 与 `WaitRegister.Ch2`（pipeline 间 channel）。

## 调用链路

![执行引擎调用链](/vibe-reading/images/articles/matrixone-internals/exec-pipeline.svg)

编译期（构造 `Compile` 时）：`compileScope`（compile.go:635）→ `compileQuery`（890）→ `compilePlanScope`（1029）对 plan.Node 大 switch，每个 node 经 `constructXxx` 工厂（operator.go，如 `constructHashJoin`:1165）生成算子；多 CN 时 `newMergeScopeByCN` / `newShuffleJoinScopeList` 拼出跨 CN 的 Scope 树。执行期：`Compile.run(s *Scope)`（compile.go:328）按 Magic 分派——`MergeRun`（scope.go:266）先 ants 并发跑所有 PreScopes，再 `ParallelRun`（441）用 `newParallelScope`（scope.go:746）把算子树深拷贝 Mcpu 份；`pipeline.Run`（pkg/vm/pipeline/pipeline.go:55）= 两步准备（`vm.Prepare` 对全算子树调 Prepare + `vm.ModifyOutputOpNodeIdx` 调整输出算子索引）+ 循环 `vm.Exec`（vm/types.go:349：CancelCheck → analyzer 计时 → `op.Call` → 投影）直到 `result.Status == vm.ExecStop || result.Batch == nil`。`Scope.Run`（scope.go:142）中 DataSource 有值但 `DataSource.R` 为 nil 时先调 `s.buildReaders(c)` 构造 reader 取 `readers[0]`。

跨 CN：`Scope.RemoteRun` → `fillPipeline`/`generatePipeline`（remoterun.go:142/161）把整棵 Scope 树编码为 protobuf 发到远端 CN，`CnServerMessageHandler`（remoterunServer.go:68）`decodeScope` → `newCompile` 本地重建执行，batch 与错误经 `sendBatch` 回传。

错误处理与重试在 `runOnce`（compile.go:496）：TP 查询且单 scope 走同步 `c.run(c.scopes[0])`；否则 `ants.Submit` 并发跑每个 scope，结果进容量为 scope 数的 `errC` channel——**首个错误**触发对所有 scope 的 `Proc.Cancel(e)` 取消整棵树；收集完所有结果后，若任一错误是可重试错误（`isRetryErr`：ErrTxnNeedRetry 且 RC 隔离，compile.go:424），**最终抛出该可重试错误**驱动上层重试（compile.go:550-570）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `Compile.Run`（compile2.go:151） | 执行入口（含重试循环） | 加锁 `lockMeta.doLock` |
| `compilePlanScope`（compile.go:1029） | plan.Node → 算子 | `constructXxx` 工厂 switch |
| `Scope.MergeRun`（scope.go:266） | 汇聚执行 | ants 并发 PreScopes |
| `Scope.ParallelRun`（scope.go:441） | 多核扫描 | `dupOperatorRecursively` 深拷贝 |
| `pipeline.Run`（pipeline/pipeline.go:55） | 算子循环 | Prepare + Exec 循环 |
| `vm.Exec`（vm/types.go:349） | 单步执行 | 统一 CancelCheck + analyzer 计时 |
| `Scope.remoteRun`（remoterunClient.go） | 跨 CN 执行 | Scope 整树 proto 化 |
</details>

## 核心实现

### push 模型与 mpool 记账

每个算子是一次 `Call` 吐一个 `batch.Batch` 的状态机（如 `HashJoin.Call` 按 `ctr.state` Build→Probe→SyncBitmap→End 转移，hashjoin/join.go:102）。所有内存从 `proc.Mp()` 拿（join.go:182 `UnionBatch(..., proc.Mp())`），`Pipeline.Cleanup` 保证错误路径也归还——配合 hashjoin 的 spill（hashjoin/spill.go，2.6 万行）实现超限落盘。`vm.Exec`（vm/types.go:349）在每次 Call 前做 `CancelCheck`（ctx.Done 返回 CancelResult），前后经 `analyzer.Start/Stop` 计时，Call 成功后执行 `op.ExecProjection` 投影并记 `analyzer.Output`——取消与观测零侵入算子。

### MergeRun 的 Magic 分派与并行展开

`MergeRun`（scope.go:266）对 PreScopes 按 Magic 递归分派：`Normal → scope.Run`、`Merge/MergeInsert → scope.MergeRun`、`Remote → scope.RemoteRun`（scope.go:33-39 的 switch）；TP 查询且无 merge 算子的特例先递归各 PreScopes 的 MergeRun 再 `s.ParallelRun(c)`。`ParallelRun`（scope.go:441）再按 scope 特征分四类：`IsLoad`/`IsTbFunc → buildLoadParallelRun`、`isTableScan() → buildScanParallelRun`（remote scope 带 OrderBy 的 scan 直接报错 "ordered scan cannot run in remote."）、default 直接 Run。`newParallelScope`（scope.go:746）：**Mcpu=1 原样返回**；>1 时根算子是带 RemoteRegs 的 Dispatch 会直接 panic（"pipeline end with dispatch should have been merged in multi CN!"——这类 scope 本该在多 CN 合并阶段被消化），否则建 fake rs + Mcpu 个子 scope 各自 `dupOperatorRecursively` 深拷贝。

### 传"执行计划"而非传数据

RemoteRun 直接把整棵 Scope 树 proto 化发到目标 CN 重建执行——数据本地性优先，避免中间 batch 跨网搬运。配套的 dispatch/receive 算子只传 shuffle 分桶后的数据流。

### 混合通信：channel 走数据，message 走控制

大流量 batch 用本地 `WaitRegister.Ch2` channel 与 dispatch morpc 流；构建侧哈希表压缩为 `JoinMapMsg` 经 `MessageBoard`（每 Compile 一个）+ `MessageAddress{CnAddr, OperatorID, ParallelID}` 寻址传给 `ReceiveJoinMap`（hashjoin/join.go:267），支撑 shuffle join 分桶并行。消息共五种（MsgTopValue / RuntimeFilter / JoinMap 等），跨 CN 走 `MessageCenter`。

### 并行度决策与算子构造解耦

`newParallelScope` 在执行前才按 NodeInfo.Mcpu 复制算子树——并行度是执行期决策，`constructXxx` 只管单份构造。TP 查询走 `IsTpQuery` 快路径免 MergeRun 开销；分布式阈值是常量 `DistributedThreshold`（compile.go:94，>10MB 才分布式）。

### CTE 与递归的环路处理

`pipeline.IsCtePipelineAtLoop` 识别 dispatch.RecCTE 环；`Scope.holdAnyCannotRemoteOperator`（compile/types.go:222）禁止环状 CTE 远程执行；`cleanupLoopPipeline` 用特殊清理顺序防死锁。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 算子接口 + 工厂注册 | `vm.Operator` + `OpType` 枚举 + `constructXxx`（compile/operator.go） | 60+ 算子统一生命周期（Prepare/Call/Free/Reset） |
| 状态机算子 | `HashJoin.Call`（hashjoin/join.go:102） | build/probe 分阶段免反复判断 |
| 树形遍历工具 | `vm.HandleAllOp/GetLeafOp`（vm/types.go:442-474） | 后序遍历算子树，清理与改写复用 |
| 对象池 | ants goroutine 池 + 算子复用 | 抑制高并发下的调度开销 |

## 模块间交互

消费 plan 的 `*plan.Plan`（Runtime Filter 在 `Scope.waitForRuntimeFilters`（scope.go:651）执行期注入）；经 `Scope.getRelData`/`buildReaders`（scope.go:1047）从 disttae 的 `engine.Relation` 取 Reader 灌入 `table_scan` 算子；`process.Process` 是 mpool 与 channel 的载体；`message` 模块支撑跨算子通信。被 frontend 的 `TxnComputationWrapper` 驱动。

## 扩展方式

- **新增算子**：`pkg/sql/colexec/<name>/` 实现 Operator 接口（参照 `hashjoin/types.go` 的 `NewArgument`）→ `pkg/vm/types.go` 注册 `OpType` → `compile/operator.go` 加 `constructXxx` → `compile.go` switch 加 case → 需远程执行则补 `remoterun.go` 的 `convertToPipelineInstruction`（418）/`convertToVmOperator`（848）编解码。
- **新增 pipeline message**：`pkg/vm/message/message.go` 加 `MsgType` → 实现 `Message` 接口（Serialize/Deserialize/GetReceiverAddr）→ 生产/消费算子处 `SendMessage`/`NewMessageReceiver` → 跨 CN 在 MessageCenter 与 remoterunServer 转发。
- **调整分布式策略**：改 `compileShuffleJoinV2`（compile.go:3232）/`mergeShuffleScopesIfNeeded`（4777）与 `DistributedThreshold` 常量。

> 待核实：`compileShuffleJoinV2` 与旧 `compileShuffleJoin` 双轨并存的具体启用条件未逐行核实。
