---
title: "将 Checkpoint 搬到 Follower：调度与执行分离以减少 Leader 内存压力"
source:
  project: "StarRocks"
  type: "PR"
  id: "52103"
  url: "https://github.com/StarRocks/starrocks/pull/52103"
  prType: "enhancement"
date: "2026-07-04"
category: [Database, StarRocks, Internals]
tags: ["StarRocks", "FE", "Checkpoint", "高可用", "内存优化"]
description: "解读 StarRocks FE Checkpoint 的架构重构：将旧版 Checkpoint daemon 拆分为 Leader 专属的 CheckpointController（调度）与全节点运行的 CheckpointWorker（执行），把内存密集型工作卸载到内存余量最多的 Follower 节点。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **PR** [#52103](https://github.com/StarRocks/starrocks/pull/52103) · **Issue** `-` · **commit** [ae32803](https://github.com/StarRocks/starrocks/commit/ae328036ab8e865b1823a9e1fc027437bb3bb8d2) · **首发版本** 3.4.0 · **变更行数** +1173 行 · **合并时间** 2024-11-15

---

## 背景

StarRocks FE Leader 节点上原本跑着一个 `Checkpoint` daemon，每隔固定间隔（`checkpoint_interval_second`，默认 60 秒）执行一次完整的 checkpoint 流程：

1. 加载当前 image 文件，构建一个独立的 `GlobalStateMgr` 实例
2. 将 journal 回放到最新提交点
3. 调用 `saveImage()` 将该实例的全量元数据写回磁盘
4. 向所有其他 FE 节点发送通知，使其拉取新 image
5. 删除已不再需要的旧 journal

步骤 1-3 是**内存密集型操作**：为了回放 journal，需要在 Leader 进程内额外维护一份"孤立"的 `GlobalStateMgr`，其内存占用与线上元数据规模成正比。集群元数据越大，checkpoint 对 Leader 内存的冲击越明显，严重时会触发 GC 抖动甚至 OOM。

这个 PR 的目标是：**把步骤 1-3 的执行责任从 Leader 转移到内存最充裕的任意 FE 节点（通常是 Follower），Leader 只保留调度和后续流程的职责。**

---

## 前置知识

### FE 元数据架构

StarRocks FE 的元数据持久化分两层：
- **Journal（BDB JE）**：每次 DDL 变更 append-only 写入 BDB，Follower 回放 journal 跟上 Leader 状态。
- **Image 文件**：全量元数据快照（`image.XXXXXX`），使节点重启时只需从快照点开始回放，而非从头。

关于 image push 的重试机制，见 [FE Checkpoint Image Push 重试机制](/vibe-reading/articles/starrocks-pr-40939-checkpoint-push-retry)。

### Epoch 机制

`GlobalStateMgr.epoch` 是一个随 Leader 选举单调递增的版本号。每当 Leader 发生切换，epoch 加一。它是跨节点协调时防止"旧任务污染新 Leader"的关键屏障。

---

## 实现

### 架构拆分概览

核心改动是将旧版单一 `Checkpoint` daemon 拆分为职责完全分离的两个角色：**CheckpointController**（运行于 Leader，只做调度）和 **CheckpointWorker**（运行于所有 FE，只做执行）。内存高峰从固定在 Leader 变为可以转移到任意内存最低的 Follower。

```text title="新旧架构对比"
旧架构：
  Leader: [Checkpoint daemon]
    ├── 检测新 journal
    ├── 加载 image + 回放 journal + 写 image   ← 内存高峰（固定在 Leader）
    ├── push image 到其他 FE
    └── 删除旧 journal

新架构：
  Leader: [CheckpointController daemon]         ← 只做调度
    ├── 检测新 journal
    ├── 选择内存最低的 FE 节点（含自身）
    ├── 触发 worker 执行 checkpoint
    ├── 等待完成信号
    ├── 从 worker 下载 image（若 worker 不是自身）
    ├── push image 到其他 FE
    └── 删除旧 journal

  所有 FE: [CheckpointWorker daemon]            ← 只做执行
    ├── 等待 setNextCheckpoint() 调用
    ├── 加载 image + 回放 journal + 写 image   ← 内存高峰可转移到 Follower
    └── 通知 Leader 完成
```

PR 描述中的 whiteboard 图直观呈现了旧版单体与新版分离架构的差异，以及内存高峰的转移路径：

![旧版与新版 Checkpoint 架构对比](/vibe-reading/images/articles/starrocks-pr-52103/checkpoint-architecture.png)

图中有三个关键设计决策值得关注：

1. **内存高峰转移**：旧版 `Checkpoint` daemon 的加载 image + 回放 journal + 写 image 三步全在 Leader 进程内完成，内存峰值固定叠加在 serving 流量之上；新版将这三步完整移到 `CheckpointWorker`，由 Leader 按堆内存使用率选出最空闲的 Follower 执行，Leader 本身只承担轻量的调度工作。
2. **image 回传路径**：若 worker 是 Follower，image 生成后需先从 Follower 传回 Leader（HTTP GET `/image`），Leader 再通过 `/put` 通知其他 FE 拉取。这引入了一次额外的文件传输，是内存收益的直接代价。
3. **Leader 自身也是候选**：当所有 Follower 内存都比 Leader 紧张，或配置 `checkpoint_only_on_leader=true` 时，Leader 仍可作为 worker 本地执行，退化为旧行为，保证了向下兼容。

三个关键新类文件：

| 类 | 位置 | 职责 |
|---|---|---|
| `CheckpointController` | `leader/` | Leader 专属调度 daemon |
| `CheckpointWorker` | `journal/` | 抽象执行 daemon（每个 FE 都有） |
| `GlobalStateCheckpointWorker` | `journal/` | 主元数据 checkpoint 实现 |
| `StarMgrCheckpointWorker` | `journal/` | StarMgr 模块 checkpoint 实现 |
| `CheckpointException` | `journal/` | checkpoint 协调异常 |

---

### CheckpointWorker：执行侧抽象

`CheckpointWorker` 是一个抽象的 `FrontendDaemon`，每个 FE 节点（Leader 和 Follower）在启动后均持有一个实例。

```java title="CheckpointWorker.java — 核心字段与 runAfterCatalogReady"
public abstract class CheckpointWorker extends FrontendDaemon {

    protected final Journal journal;

    // 下一个待执行的 checkpoint 任务（epoch + journalId）
    private NextPoint nextPoint;
    protected GlobalStateMgr servingGlobalState;
    private String subDir;

    public CheckpointWorker(String name, Journal journal, String subDir) {
        super(name, FeConstants.checkpoint_interval_second * 1000L);
        this.journal = journal;
        this.subDir = subDir;
    }

    abstract void doCheckpoint(long epoch, long journalId) throws Exception;
    abstract CheckpointController getCheckpointController();
    abstract boolean isBelongToGlobalStateMgr();

    @Override
    protected void runAfterCatalogReady() {
        init();

        if (nextPoint == null) {
            return;                                   // 无任务，本轮空转
        }
        if (nextPoint.journalId <= getImageJournalId()) {
            return;                                   // 已有更新的 image，跳过
        }
        if (nextPoint.epoch != servingGlobalState.getEpoch()) {
            return;                                   // epoch 已过期
        }

        createImage(nextPoint.epoch, nextPoint.journalId);
    }
}
```

**空转设计**：worker 以 `checkpoint_interval_second`（默认 60 秒）为周期循环检查 `nextPoint`，无任务直接返回，几乎没有额外开销。只有 Controller 通过 `setNextCheckpoint()` 写入任务后，下一轮才真正执行。

**`setNextCheckpoint()` 的三重前置校验**：

```java title="CheckpointWorker.java — setNextCheckpoint"
public void setNextCheckpoint(long epoch, long journalId) throws CheckpointException {
    if (servingGlobalState == null) {
        throw new CheckpointException("worker not initialize");
    }
    // 1. epoch 必须与当前 Leader epoch 一致
    if (epoch != servingGlobalState.getEpoch()) {
        throw new CheckpointException(
            String.format("epoch: %d is not equal to current epoch: %d",
                epoch, servingGlobalState.getEpoch()));
    }
    // 2. 请求的 journal 必须已经存在于本地 BDB
    if (journalId > journal.getMaxJournalId()) {
        throw new CheckpointException(
            String.format("can not find journal id: %d, current max is: %d",
                journalId, journal.getMaxJournalId()));
    }
    nextPoint = new NextPoint(epoch, journalId);
}
```

任何一个校验失败，`CheckpointException` 会被捕获并通过 `finishCheckpoint()` 回报给 Controller，标记本次 checkpoint 失败。

---

### GlobalStateCheckpointWorker：实际执行

```java title="GlobalStateCheckpointWorker.java — doCheckpoint"
@Override
void doCheckpoint(long epoch, long journalId) throws Exception {
    GlobalStateMgr globalStateMgr = GlobalStateMgr.getCurrentState();
    globalStateMgr.setEditLog(new EditLog(null));
    globalStateMgr.setJournal(journal);

    try {
        globalStateMgr.loadImage(imageDir);
        globalStateMgr.initDefaultWarehouse();

        checkEpoch(epoch);               // ← 第一次 epoch 检查（加载完成后）

        globalStateMgr.replayJournal(journalId);
        globalStateMgr.clearExpiredJobs();

        checkEpoch(epoch);               // ← 第二次 epoch 检查（回放完成后）

        globalStateMgr.saveImage();
        servingGlobalState.setImageJournalId(journalId);
    } finally {
        GlobalStateMgr.destroyCheckpoint();  // 无论成功失败都释放内存
    }
}

private void checkEpoch(long epoch) throws CheckpointException {
    if (epoch != servingGlobalState.getEpoch()) {
        throw new CheckpointException("epoch outdated");
    }
}
```

**两次 `checkEpoch()` 的必要性**：加载 image 和回放 journal 各自耗时较长。如果在中途发生 Leader 切换（epoch 变化），继续执行会产生一份基于旧 Leader 元数据的 image，不应被新 Leader 采用。两次检查分别覆盖"加载阶段"和"回放阶段"的 Leader 变更场景。

---

### CheckpointController：调度侧

Controller 是 Leader 上运行的 daemon，保留了旧 `Checkpoint` daemon 的 push/delete 职责，并增加了 worker 选择与等待逻辑。

#### Worker 选择策略

```java title="CheckpointController.java — getWorkers 排序逻辑"
protected List<Frontend> getWorkers(boolean needClusterSnapshotInfo) {
    List<Frontend> workers;
    if (Config.checkpoint_only_on_leader || needClusterSnapshotInfo) {
        // 强制使用 Leader 自身
        workers = Lists.newArrayList(
            GlobalStateMgr.getServingState().getNodeMgr().getMySelf());
    } else {
        workers = GlobalStateMgr.getServingState().getNodeMgr().getAllFrontends();
        String leaderNode = GlobalStateMgr.getServingState()
                .getNodeMgr().getMySelf().getNodeName();

        workers.sort((fe1, fe2) -> {
            // 优先级 1：最近失败时间越晚，排越后
            long failedTime1 = lastFailedTime.getOrDefault(fe1.getNodeName(), -1L);
            long failedTime2 = lastFailedTime.getOrDefault(fe2.getNodeName(), -1L);
            if (failedTime1 != failedTime2) {
                return Long.compare(failedTime1, failedTime2);
            }
            // 优先级 2：堆内存使用率越低，排越前；Leader 视为无限大
            float used1 = fe1.getNodeName().equals(leaderNode)
                    ? Float.MAX_VALUE : fe1.getHeapUsedPercent();
            float used2 = fe2.getNodeName().equals(leaderNode)
                    ? Float.MAX_VALUE : fe2.getHeapUsedPercent();
            return Float.compare(used1, used2);
        });
    }
    return workers;
}
```

排序优先级：

1. **上次失败时间**：最近刚失败的节点排在后面，避免反复选到不稳定的节点
2. **JVM 堆使用率**：内存越空闲越优先；Leader 节点被人为设为 `Float.MAX_VALUE`，只有在所有 Follower 都不可用时才兜底选 Leader

`checkpoint_only_on_leader` 是一个兜底配置（默认 `false`），用于在新机制出现问题时回退到旧行为。

#### 心跳扩展：堆内存上报

为了让 Leader 能看到各节点实时的 JVM 内存状态，这个 PR 在心跳响应中新增了 `heapUsedPercent` 字段：

```java title="FrontendHbResponse.java — 新增字段"
private float heapUsedPercent;
```

```java title="Frontend.java — 心跳处理时更新"
heapUsedPercent = hbResponse.getHeapUsedPercent();
```

每次心跳回包时，Follower 将当前 JVM 堆使用率一并上报，Leader 在下次选 worker 时即可使用最新数据。

---

### 触发协议：两条 Thrift RPC

#### Leader → Worker：`startCheckpoint`

```thrift title="FrontendService.thrift — 新增 RPC 定义"
struct TStartCheckpointRequest {
    1: optional i64 epoch;
    2: optional i64 journal_id;
    3: optional bool is_global_state_mgr;
}

TStartCheckpointResponse startCheckpoint(1: TStartCheckpointRequest request)
```

Controller 在 `doCheckpoint()` 中根据 worker 是否是自身走两条路径：

```java title="CheckpointController.java — doCheckpoint 分支"
private boolean doCheckpoint(Frontend frontend, boolean needClusterSnapshotInfo) {
    String selfName = GlobalStateMgr.getServingState().getNodeMgr().getNodeName();

    if (selfName.equals(frontend.getNodeName())) {
        // Worker 是自身：直接调用本地 worker
        CheckpointWorker worker = getCheckpointWorker();
        worker.setNextCheckpoint(epoch, journalId);
        return true;
    } else {
        // Worker 是 Follower：发 Thrift RPC
        TStartCheckpointRequest request = new TStartCheckpointRequest();
        request.setEpoch(epoch);
        request.setJournal_id(journalId);
        request.setIs_global_state_mgr(belongToGlobalStateMgr);
        TStartCheckpointResponse response = ThriftRPCRequestExecutor.call(...,
            client -> client.startCheckpoint(request));
        return response.getStatus().getStatus_code() == TStatusCode.OK;
    }
}
```

`startCheckpoint` RPC 是**触发信号**，不等待执行完成——它只是把 `NextPoint` 写入 worker 的 `AtomicReference`，立即返回。

#### Worker → Leader：`finishCheckpoint`

```thrift title="FrontendService.thrift — 完成回报 RPC"
struct TFinishCheckpointRequest {
    1: optional i64 journal_id;
    2: optional string node_name;
    3: optional bool is_success;
    4: optional string message;
    5: optional bool is_global_state_mgr;
}

TFinishCheckpointResponse finishCheckpoint(1: TFinishCheckpointRequest request)
```

Worker 完成（或失败）后调用 `finishCheckpoint`，同样区分本地调用和 RPC 两种路径：

```java title="CheckpointWorker.java — finishCheckpoint 分支"
private void finishCheckpoint(long epoch, long journalId,
                               boolean isSuccess, String message) {
    if (epoch != servingGlobalState.getEpoch()) {
        LOG.warn("epoch outdated, do not finish checkpoint");
        return;  // Leader 已切换，结果作废
    }

    String nodeName = servingGlobalState.getNodeMgr().getNodeName();
    if (servingGlobalState.isLeader()) {
        // 自身就是 Leader：直接调用 controller 方法
        CheckpointController controller = getCheckpointController();
        if (isSuccess) {
            controller.finishCheckpoint(journalId, nodeName, clusterSnapshotInfo);
        } else {
            controller.cancelCheckpoint(nodeName, message);
        }
    } else {
        // Follower worker：通过 Thrift 回报 Leader
        TFinishCheckpointRequest request = new TFinishCheckpointRequest();
        request.setJournal_id(journalId);
        request.setNode_name(nodeName);
        request.setIs_success(isSuccess);
        request.setMessage(message);
        request.setIs_global_state_mgr(isBelongToGlobalStateMgr());
        ThriftRPCRequestExecutor.call(...leaderEndpoint...,
            client -> client.finishCheckpoint(request));
    }
}
```

**epoch 检查**：在调用 `finishCheckpoint` 前，再次核对 epoch。若 Leader 在 checkpoint 执行期间发生切换，worker 直接放弃回报，避免旧结果污染新 Leader。

---

### Controller 侧的同步等待

Controller 在触发 worker 后，通过 `BlockingQueue` 同步等待完成信号：

```java title="CheckpointController.java — 等待 worker 完成"
result = new ArrayBlockingQueue<>(1);
workerNodeName = selectWorker(needClusterSnapshotInfo);
// ...触发 worker...

long startNs = System.nanoTime();
CheckpointCompletionStatus ret = null;
while (ret == null
        && System.nanoTime() - startNs
           < TimeUnit.SECONDS.toNanos(Config.checkpoint_timeout_seconds)) {
    ret = result.poll(1, TimeUnit.SECONDS);  // 每秒轮询一次
}

if (ret == null) {
    LOG.warn("do checkpoint timeout on node: {}", workerNodeName);
    return Pair.create(false, workerNodeName);
}
```

`checkpoint_timeout_seconds` 默认 `24 * 3600`（24 小时），给超大元数据集群的慢速 checkpoint 留出足够的余量。

Worker 完成后，`finishCheckpoint()` 将 `CheckpointCompletionStatus` 放入队列，Controller 的 `poll()` 随即返回。

---

### 完成后的 Image 传输

若 worker 是 Follower，Controller 还需从 Follower 下载 image：

```java title="CheckpointController.java — downloadImage"
private void downloadImage() throws IOException {
    // worker 是自身则无需下载
    if (workerNodeName.equals(
            GlobalStateMgr.getCurrentState().getNodeMgr().getNodeName())) {
        return;
    }

    // 通过 HTTP GET /image?version=... 从 worker 拉取
    String url = "http://" + workerHost + ":" + Config.http_port
            + "/image?version=" + journalId
            + "&subdir=" + subDir
            + "&image_format_version=" + imageFormatVersion;
    MetaHelper.downloadImageFile(url, MetaService.DOWNLOAD_TIMEOUT_SECOND * 1000,
            String.valueOf(journalId), dir);
}
```

下载完成后，Controller 继续执行 PR #40939 引入的 `pushImage()` 流程，将 image 推送给**除 worker 以外**的所有其他 FE 节点。

---

### 节点重启保护

如果 worker 节点在 checkpoint 执行期间重启，新启动的节点会向 Leader 发送心跳，Leader 检测到 `startTime` 变化后调用：

```java title="CheckpointController.java — workerRestarted"
public void workerRestarted(String nodeName, long startTime) {
    if (startTime > workerSelectedTime) {
        cancelCheckpoint(nodeName, "worker restarted");
    }
}
```

`cancelCheckpoint()` 向 `result` 队列写入失败状态，解除 Controller 的阻塞等待，本轮 checkpoint 标记失败，等待下一个 checkpoint 间隔重试。

---

## 意义与影响

**内存压力转移**：checkpoint 的高峰内存消耗（加载 image + 回放 journal）从 Leader 转移到 Follower，Leader 的内存用于 serving 查询请求，Follower 的空闲内存得到复用，集群整体 GC 压力降低。

**新增配置项**：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `checkpoint_only_on_leader` | `false` | 兜底开关，`true` 时退回旧行为，仅在 Leader 做 checkpoint |
| `checkpoint_timeout_seconds` | `86400`（24h）| Worker 执行超时上限，适应大集群慢速 checkpoint |

**架构清晰化**：将"调度（什么时候做、谁来做、结果怎么处理）"和"执行（实际 replay + saveImage）"解耦为两个独立 daemon。后续扩展（如动态调整 worker 权重、多 worker 并发）无需修改 Controller 主流程。

**副作用与注意点**：当 worker 是 Follower 时，image 生成后需要从 Follower 传回 Leader 再分发。引入了额外一次 HTTP 文件传输，在大 image 场景下会增加 checkpoint 的端到端耗时。`checkpoint_timeout_seconds` 的默认值（24h）需要根据实际 image 大小合理评估。
