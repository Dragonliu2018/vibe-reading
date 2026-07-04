---
title: "FE Checkpoint Image Push 重试机制"
source:
  project: "StarRocks"
  type: "PR"
  id: "40939"
  url: "https://github.com/StarRocks/starrocks/pull/40939"
  prType: "enhancement"
date: "2026-07-04"
category: [Database, StarRocks, Internals]
tags: ["StarRocks", "FE", "Checkpoint", "高可用", "元数据"]
description: "解读 StarRocks FE Checkpoint 的 image push 重试机制：引入 nodesToPushImage 集合跨周期追踪未同步节点，解决 follower 临时下线时推送失败不重试、journal 持续积压的问题。"
readingTime: "10 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#40939](https://github.com/StarRocks/starrocks/pull/40939) · **Issue** `-` · **commit** [10b324f](https://github.com/StarRocks/starrocks/commit/10b324ff9883fad80a4c7118d6370e592cc218dc) · **首发版本** 3.3.0 · **变更行数** +152 行 · **合并时间** 2024-03-27

---

## 背景

StarRocks FE 采用 Leader/Follower 架构实现元数据高可用。Leader 定期将内存中的全量元数据序列化为一个 **image 文件**（即 checkpoint），然后向所有其他 FE 节点的 `/put` 端点发送 HTTP GET 通知，Follower 收到通知后主动从 Leader 拉取该文件，使 Follower 得以截断并丢弃已持久化到 image 的旧 BDB journal，减少重启回放时间。

问题出在"推送"这一步的可靠性上。

**旧实现的行为**：每次生成新 image 后，Leader 对所有 Follower **仅尝试一次推送**，失败不重试。下一个 checkpoint 周期开始时，代码第一步就比较 `imageVersion` 与 `checkpointVersion`：

```java title="旧实现 — 周期入口"
if (imageVersion >= checkpointVersion) {
    return;  // 无新 journal，直接返回，不推送
}
```

若自上次 checkpoint 以来没有新的 journal 提交，这里直接 `return`，**连推送都不会尝试**。于是失败的推送要等到下一次有新 journal 积累、触发新 image 生成时，才有机会重新发给那个节点。这个等待窗口可能相当长。

与此同时，旧版 journal 删除逻辑让问题更显眼：

```java title="旧实现 — journal 删除条件"
// 只有全部节点推送成功，才删 journal
if (successPushed == otherNodesCount) {
    journal.deleteJournals(deleteVersion + 1);
}
```

只要有一个节点推送失败，journal 就一直不删，BDB 存储持续积压。

这个 PR 的目标很直接：**每个 checkpoint 周期都尝试把 image 推送给尚未同步的节点，直到全部成功为止**，而不是等待下一次 image 生成才有机会重试。

---

## 前置知识

### FE 元数据持久化模型

StarRocks FE 的元数据持久化分两层：

- **Journal（BDB JE）**：每次 DDL / 元数据变更以 append-only 日志写入 BDB，Follower 通过回放 journal 追上 Leader 状态。
- **Image 文件**：Leader 定期将当前全量元数据快照序列化到磁盘（`image.XXXXXX`，其中 `XXXXXX` 是对应的 journal ID）。Image 是一个"存档点"，节点重启时加载最新 image，再从 image 对应的 journal ID 开始回放，不必从头回放所有历史 journal。

两者的关系：image 的存在使旧 journal 可以安全删除；但删除前必须确认所有节点都已拿到该 image，否则落后节点重启后找不到需要的 journal，无法完成回放。

### Checkpoint 触发时机

`Checkpoint`（PR 合并后演化为 `CheckpointController`）是运行在 Leader FE 上的一个后台 daemon，继承自 `FrontendDaemon`，以固定间隔（`checkpoint_interval_second`，默认 60 秒）循环执行。每轮检查当前 image 版本与最新已提交 journal ID，若后者更大则触发一次 checkpoint。

---

## 实现

### 核心数据结构：`nodesToPushImage`

PR 的核心改动是在 `Checkpoint` 类中引入一个 `Set<String>`：

```java title="Checkpoint.java（PR 后）"
private final Set<String> nodesToPushImage;

public Checkpoint(String name, Journal journal, String subDir, boolean belongToGlobalStateMgr) {
    // ...
    nodesToPushImage = new HashSet<>();
}
```

`nodesToPushImage` 存放**尚未成功接收当前最新 image 的节点名**。它是类成员变量，生命周期与 daemon 相同，因此可以**跨 checkpoint 周期持久追踪**未同步节点。

这是与旧实现最本质的区别：旧版的推送状态（`successPushed`、`otherNodesCount`）都是局部变量，每轮结束即销毁；新版将"谁还没拿到 image"这一状态提升为持久化的集合。

---

### 四阶段工作流

`runAfterCatalogReady()` 被重构为清晰的四个步骤：

```java title="Checkpoint.java — runAfterCatalogReady()"
@Override
protected void runAfterCatalogReady() {
    long imageVersion = 0;
    long logVersion = 0;
    try {
        Storage storage = new Storage(imageDir);
        imageVersion = storage.getImageJournalId();
        logVersion = journal.getFinalizedJournalId();
        LOG.info("checkpoint imageVersion {}, logVersion {}", imageVersion, logVersion);
    } catch (IOException e) {
        LOG.error("Failed to get storage info", e);
        return;
    }

    // Step 1: 创建 image
    boolean newImageCreated = false;
    if (imageVersion < logVersion) {
        newImageCreated = createImage(logVersion);
    }
    if (newImageCreated) {
        // 将所有其他 FE 节点加入待推送集合
        for (Frontend frontend : GlobalStateMgr.getServingState()
                .getNodeMgr().getOtherFrontends()) {
            nodesToPushImage.add(frontend.getNodeName());
        }
    }

    // Step 2: 推送 image（包含重试逻辑）
    int needToPushCnt = nodesToPushImage.size();
    long newImageVersion = newImageCreated ? logVersion : imageVersion;
    if (needToPushCnt > 0) {
        pushImage(newImageVersion);
    }

    // Step 3: 安全删除旧 journal
    if ((newImageCreated && needToPushCnt == 0)
            || (needToPushCnt > 0 && nodesToPushImage.isEmpty())) {
        deleteOldJournals(newImageVersion);
    }

    // Step 4: 清理本地旧 image 文件
    if (newImageCreated) {
        MetaCleaner cleaner = new MetaCleaner(imageDir);
        try {
            cleaner.clean();
        } catch (IOException e) {
            LOG.error("Leader delete old image file fail.", e);
        }
    }
}
```

四个步骤相互独立，每个步骤都可以在当轮跳过（无新 image、无待推送节点等），下一轮仍能正确续接。

---

### Step 1：按需创建 image

```java title="Checkpoint.java — createImage()"
private boolean createImage(long logVersion) {
    if (belongToGlobalStateMgr) {
        return replayAndGenerateGlobalStateMgrImage(logVersion);
    } else {
        return replayAndGenerateStarMgrImage(logVersion);
    }
}
```

`createImage()` 仅是路由方法，实际工作由 `replayAndGenerateGlobalStateMgrImage()` 完成：加载旧 image → 回放 journal 到 `logVersion` → 序列化新 image 到磁盘。

**新 image 创建后立即把所有其他节点加入 `nodesToPushImage`**，这一步发生在 Step 1 的返回值为 `true` 时，而非在 `pushImage()` 内部。这样即使本轮 `pushImage()` 全部失败，下轮的 Step 1 也不会重新生成 image（`imageVersion` 已等于 `logVersion`），但 `nodesToPushImage` 中仍保留未成功的节点，Step 2 会继续推送。

注意这里用的是 `getOtherFrontends()`，这是 PR 同时在 `NodeMgr` 中新增的方法：

```java title="NodeMgr.java — getOtherFrontends()"
// All frontends except self
public List<Frontend> getOtherFrontends() {
    return frontends
            .values()
            .stream()
            .filter(frontend -> !frontend.getNodeName().equals(nodeName))
            .collect(Collectors.toList());
}
```

旧代码通过 `getFrontends(null)` 获取所有节点再手动过滤 Leader IP，逻辑分散且依赖 IP 比对；新方法直接按节点名排除自身，更清晰可靠。

---

### Step 2：`pushImage()` 重试逻辑

这是 PR 的核心实现，重点在于 **Iterator 安全删除**：

```java title="Checkpoint.java — pushImage()"
private void pushImage(long imageVersion) {
    Iterator<String> iterator = nodesToPushImage.iterator();
    int needToPushCnt = nodesToPushImage.size();
    int successPushedCnt = 0;

    while (iterator.hasNext()) {
        String nodeName = iterator.next();

        Frontend frontend = GlobalStateMgr.getServingState()
                .getNodeMgr().getFeByName(nodeName);
        if (frontend == null) {
            // 节点已从集群移除，直接清理
            iterator.remove();
            continue;
        }

        String url = "http://" + NetUtils.getHostPortInAccessibleFormat(
                frontend.getHost(), Config.http_port)
                + "/put?version=" + imageVersion
                + "&port=" + Config.http_port
                + "&subdir=" + subDir;
        try {
            MetaHelper.getRemoteFile(url, PUT_TIMEOUT_SECOND * 1000,
                    new NullOutputStream());
            successPushedCnt++;
            iterator.remove();   // ← 成功才移除
            LOG.info("push image successfully, url = {}", url);
            if (MetricRepo.hasInit) {
                MetricRepo.COUNTER_IMAGE_PUSH.increase(1L);
            }
        } catch (IOException e) {
            // 失败：保留在集合中，下次周期自动重试
            LOG.error("Exception when pushing image file. url = {}", url, e);
        }
    }

    LOG.info("push image.{} from subdir [{}] to other nodes. "
            + "totally {} nodes, push succeeded {} nodes",
            imageVersion, subDir, needToPushCnt, successPushedCnt);
}
```

两个关键点：

1. **成功才 `iterator.remove()`**：推送失败的节点留在 `nodesToPushImage`，下一个 checkpoint 周期的 Step 2 会再次遍历并重试，直到成功为止。

2. **节点已不存在时直接清理**：`getFeByName()` 返回 `null` 说明节点已从集群移除，无需再推送，直接 `remove()` 防止集合无限增长。

---

### Step 3：Journal 安全删除

旧实现将"推送全部成功"作为删除 journal 的前置条件，逻辑在一个大方法中耦合。新版提取为独立方法，并明确了两种触发条件：

```java title="Checkpoint.java — 删除条件"
// 条件 1：新 image 刚创建，但没有其他节点（单 FE 集群）→ 立即删
// 条件 2：本轮推送前有待同步节点，推送后全部清空 → 所有节点已同步
if ((newImageCreated && needToPushCnt == 0)
        || (needToPushCnt > 0 && nodesToPushImage.isEmpty())) {
    deleteOldJournals(newImageVersion);
}
```

```java title="Checkpoint.java — deleteOldJournals()"
private void deleteOldJournals(long imageVersion) {
    long minReplayedJournalId = getMinReplayedJournalId();
    long deleteVersion = Math.min(imageVersion, minReplayedJournalId);
    journal.deleteJournals(deleteVersion + 1);
    LOG.info("journals <= {} with prefix [{}] are deleted. "
            + "image version {}, other nodes min version {}",
            deleteVersion, journal.getPrefix(), imageVersion, minReplayedJournalId);
}
```

`deleteVersion = min(imageVersion, minReplayedJournalId)` 是防止数据丢失的关键：即使所有节点都拿到了 image，仍需确保删除版本不超过**最慢节点当前的回放位点**。若某个节点 image 虽已到位但 journal 回放尚未跟上，删除过新的 journal 会导致该节点重启后无法完成回放。

`getMinReplayedJournalId()` 通过 HTTP 接口逐一查询各 Follower 的 `/journal_id` 端点获取其当前回放位点，取最小值。

---

### 代码结构对比

| 维度 | 旧实现 | 新实现 |
| --- | --- | --- |
| 推送状态 | 局部变量（每轮销毁） | 类成员 `Set`（跨轮持久） |
| 推送失败处理 | 不重试，依赖下次 image 生成 | 保留节点，下轮自动重试 |
| journal 删除条件 | `successPushed == otherNodesCount` | `nodesToPushImage.isEmpty()` |
| 方法结构 | 单一大方法（`runAfterCatalogReady` ~148 行） | 4 个独立子方法 |
| 自身节点过滤 | IP 地址比对 | 节点名比对（`getOtherFrontends()`） |

---

## 测试

PR 新增了一个 SQL 集成测试：

```sql title="test/sql/test_checkpoint/T/test_checkpoint"
-- name: test_checkpoint
alter system create image;
```

`ALTER SYSTEM CREATE IMAGE` 是 StarRocks 提供的手动触发 checkpoint 的 DDL 命令，可用于在测试/运维场景中强制生成新 image，验证 checkpoint 流程的完整性。

---

## 意义与影响

**直接收益**：消除了推送失败后"不重试、只能等下次 image 生成"的长等待窗口。Follower 临时离线恢复后，最多等一个 checkpoint 间隔（默认 60 秒）即可收到 image，不必等到新 journal 再次积累触发下一轮 checkpoint。

**Journal 管理收益**：旧版在任一节点推送失败时拒绝删 journal，BDB 存储随时间持续增长；新版只要所有节点最终都收到 image，即可正常清理旧 journal，积压问题随之解决。

**架构价值**：将"推送状态"从瞬态局部变量提升为持久类状态，是这类可靠性增强的通用范式——**把"已完成/待完成"的边界维护在内存集合中，配合周期性 daemon 循环重试**，在无需引入外部存储的前提下实现了幂等重试语义。

这一设计在后续的重构中得以保留：当前代码库中 `Checkpoint.java` 已演化为 `CheckpointController.java`，支持将 checkpoint 任务委派给任意 FE worker 节点执行。`nodesToPushImage` 的核心重试逻辑被继承，但随架构演进做了一处调整——执行 checkpoint 的 worker 节点自己会在完成后把 image 传回 Leader，因此不需要 Leader 再通过 `/put` 推送给它，加入 `nodesToPushImage` 时会跳过 worker 节点（见 `CheckpointController.java:171`）。
