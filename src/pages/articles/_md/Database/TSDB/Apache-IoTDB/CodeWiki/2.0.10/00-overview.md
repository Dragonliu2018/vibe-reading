---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "Overview"
date: "2026-10-01T21:40:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Java", "时序数据库", "物联网", "TsFile", "MPP", "Apache"]
description: "Apache IoTDB 2.0.10 源码解读概览：ConfigNode/Datanode/AINode 三节点存算分离架构、树/表双数据模型、IoTConsensus 异步共识、一套 pipe 引擎三用、Trino 化 MPP 查询引擎。"
readingTime: "45 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** 2.0.10（tag v2.0.10，2026-07-03 发布）· **协议** Apache-2.0 · **语言** Java（源码兼容 1.8，运行需 ≥ 17）+ Python（AINode）· **主源码量** ~99 万行 Java + ~2.3 万行 Python · **文件格式** TsFile（外部 repo [apache/tsfile](https://github.com/apache/tsfile) 2.3.1）· **仓库** [GitHub](https://github.com/apache/iotdb)

---

## 总览

### 项目简介

Apache IoTDB 是一款**物联网时序数据库**——清华大学发起、现为 Apache 顶级项目，专为"海量设备、高频写入、时间窗口分析"的场景设计：一台设备每秒产生多条 (时间戳, 测点值) 记录，数百万设备持续汇入，查询以时间对齐、聚合降采样、异常检测为主。它的核心价值主张是：**轻量可嵌入亦可集群化部署、高写入吞吐、高压缩比、与 Hadoop/Spark/Grafana 生态无缝集成**，并且原生支持在库内做时序 AI 推理（2.x 新增 AINode 与内置时序模型）。

2.x 是当前主线大版本：**存算分离三节点架构**（ConfigNode 管元数据协调、DataNode 管存算、AINode 管推理）+ **树/表双数据模型**（传统 `root.sg.device.measurement` 层级路径与新式标准 SQL 表语义并存于同一存储）。项目边界：IoTDB 不做通用 OLAP/事务数据库——没有 ACID 事务与多表 JOIN 的强一致保证（表模型 JOIN 是查询语义层面）；TsFile 文件格式的编码与 chunk 结构在外部独立 repo 维护。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
| --- | --- | --- |
| 树模型 SQL（路径语义） | `iotdb-core/antlr` + `queryengine/plan/parser` | IoTDBSqlParser.g4，`root.sg.device.*` 通配 |
| 表模型 SQL（关系语义） | `iotdb-core/relational-grammar` + `queryengine/plan/relational` | RelationalSql.g4（Trino 文法），SELECT/JOIN/CTE/UNION |
| 高吞吐写入 | `storageengine/dataregion` | seq/unseq 双队列、TVList memtable、三级内存反压 |
| WAL 与恢复 | `storageengine/dataregion/wal` | WALNode + CheckpointManager；IoT 共识下即共识日志 |
| Compaction | `dataregion/compaction` | inner/cross 两类、三重 RateLimiter 保写入 SLA |
| MPP 分布式查询 | `queryengine` + `execution/exchange` | FragmentInstance/Driver/Operator、Trino 化调度 |
| UDF / Trigger | `iotdb-api` + calc-commons + `db/trigger` | COW 类加载器热替换 |
| 数据同步 Pipe | `db/pipe` | source→processor→sink 插件流水线，跨集群/外部系统 |
| 订阅 Subscription | `db/subscription` | pipe 之上的 poll/ack 消费模型（Kafka 式） |
| 共识可插拔 | `iotdb-core/consensus` | Simple/Ratis/IoTConsensus(V2) 三实现 |
| AI 推理 | `iotdb-core/ainode`（Python） | 14 内置模型（sktime + HuggingFace），多进程池 + 连续批处理 |
| 多语言客户端 | `iotdb-client` | Java Session/JDBC/CLI + py/cpp/go |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| Java 17+（源码 1.8 兼容） | 核心 | 全部 JVM 侧模块 |
| Apache Thrift 0.14.1 | 核心 | 全部节点间/客户端 RPC（五套 IDL 单一真源） |
| Apache Ratis 3.2.2 | 核心 | Raft 共识实现（SchemaRegion/ConfigNode） |
| TsFile 2.3.1（外部 repo） | 核心 | 列式文件格式、TsBlock/Column 内存结构 |
| ANTLR 4 | 核心 | 两套 SQL 文法 |
| freemarker + fmpp（Drill 方案） | 核心 | calc-commons 生成 180 个类型特化算术 Transformer |
| Guava / commons-pool2 | 核心 | RateLimiter、连接池 |
| Python + torch/transformers | 核心（AINode） | 推理进程，PyInstaller 打包免环境 |
| LMAX Disruptor（vendored） | 核心 | pipe 事件捕获 ring buffer |
| sktime / HuggingFace | 可选（AINode） | 8 统计模型 + 6 深度模型 |

### 版本历史

- **1.3.x（2024-2025）**：ConfigNode/Datanode 分离的集群新架构成熟期，data_region/schema_region 共识组体系定型。
- **2.0.1-beta（2026 初）**：里程碑式引入**表模型**——标准 SQL（SELECT/WHERE/JOIN/GROUP BY/子查询），树/表两模型的 database 互相不可见；Session 接口支持自动元数据创建。
- **2.0.2–2.0.9**：表模型持续补齐（函数、JOIN 语义、导入导出）、IoTConsensusV2（pipe 化复制）、AINode 能力扩展。
- **2.0.10（2026-07，本次解读基线）**：UNION/INTERSECT/EXCEPT 与 CTE、APPROX_PERCENTILE、show configuration、remove datanode 进度查询、AINode 内置 Moirai2/Toto 模型与多模型管理。

### 顶层上下文图

IoTDB 的外部交互方：时序数据生产方（设备/网关，经 Session/JDBC/ thrift 多语言客户端写入）；查询消费方（BI/Grafana 看板、CLI、订阅 consumer 的 pull 流）；数据下游（另一个 IoTDB 集群、OPC-UA/WebSocket 系统等 pipe sink 目标）；运维方（ConfigNode 的集群管理 SQL、JMX）。三节点对外全部经 thrift（客户端 6667、各内部端口见协议层篇）。

## 快速上手

最快看到项目跑起来的方式（来自 README，产物经 `mvn clean package -pl distribution -am -DskipTests` 或官网下载）：

```bash title="standalone 启动（1 ConfigNode + 1 DataNode 两个进程）"
> sbin/start-standalone.sh     # 脚本内部：先起 ConfigNode，sleep 3s，再起 DataNode
> sbin/start-cli.sh -h 127.0.0.1 -p 6667 -u root -pw root
```

端到端验证（CLI 内）：

```sql title="树模型最小验证"
CREATE DATABASE root.demo;
INSERT INTO root.demo.d1(time, temperature) VALUES (now(), 25.5);
SELECT * FROM root.demo.d1;   -- 预期：返回一行 25.5
```

需要 Java ≥ 17（README 验证到 25）与 Maven ≥ 3.6（源码编译）。集成测试需 `-P with-integration-tests` profile（见仓库 AGENTS.md，其中有完整的单测/IT 命令速查）。

## 架构设计解析

### 系统架构

IoTDB 2.x 的架构思想是**存算分离 + 元数据集中 + 数据分片共识**：ConfigNode 用单一 Raft 组维护全局元数据（节点表、分区表、集群 schema），不存任何时序数据；DataNode 持有 DataRegion（数据分片）与 SchemaRegion（元数据分片）两类共识组做存算；AINode 是独立的 Python 推理进程，崩溃隔离于 JVM。数据面与元数据面走**不同的默认共识协议**——这是全仓库最值得理解的一个决策：数据 Region 默认 IoTConsensus（本地写成功即返回 + WAL 异步分发，高吞吐最终一致），元数据 Region 默认 Ratis（Raft 多数派强一致）——因为物联网场景对写入可用性的要求高于 RPO=0，而 schema 错一个即全局错。

![三节点分层架构](/vibe-reading/images/articles/iotdb-2.0.10/architecture.svg)

| 架构层 | 包含模块 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 客户端层 | `iotdb-client` | 屏蔽集群拓扑：节点发现、重试、leader 重定向全在客户端 |
| 协调节点 | `iotdb-core/confignode` | 集群元数据单一真源，分区分配与再平衡的唯一决策者 |
| 存算节点 | `iotdb-core/datanode`（存储/元数据/查询/pipe/订阅/共识适配） | 全部数据面工作，region 粒度水平扩展 |
| 推理节点 | `iotdb-core/ainode` | Python 生态隔离，模型管理与推理 |
| 公共基础层 | `node-commons`、`calc-commons`、`iotdb-protocol`、`iotdb-api` | 跨节点共享类型与序列化格式，钉死 wire 兼容 |
| 存储格式 | 外部 repo `apache/tsfile` | 列式编码与文件结构独立演进 |

### 设计模式

| 模式 | 代表位置 | 为什么用 |
| --- | --- | --- |
| 注册表 + 倒序销毁 | `RegisterManager`（node-commons） | 20+ 生命周期服务顺序敏感 |
| Visitor（全仓重灾区） | `StatementVisitor`/`PlanVisitor`/`DataExecutionVisitor`/`SchemaExecutionVisitor`/`AstBuilder` | 节点种类 × 处理逻辑多对多正交扩展 |
| 工厂 + 反射 | `ConsensusFactory`、`SchemaRegionLoader`（注解扫描） | 协议/引擎实现可插拔 |
| 状态机 | `QueryStateMachine`、`StateMachineProcedure`、TsFile 状态 | 分布式过程与资源生命周期 |
| 装饰器 | `EnrichedEvent`（pipe） | 引用计数/位点透明附加 |
| 声明式调和 | `PipeTaskAgent` meta diff | 控制面期望态 vs 本地态 |
| COW 换代 | UDF/Trigger ClassLoader | jar 热替换 vs 长查询 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `DataRegion` / `SchemaRegion` | 数据/元数据共识组的状态机载体（database 的一个分片） | 随分区分配创建，可迁移 | 持有 TsFileManager / MTree，被共识层驱动 |
| `TsFileProcessor` | 未封口 TsFile + work memtable + flushing 队列 | 一个 (timePartition, seq) 组合一个 | 持有 IMemTable、RestorableTsFileIOWriter、IWALNode |
| `TsFileResource` | 每个 TsFile 的内存索引 + 状态 | UNCLOSED→…→DELETED（见状态流） | 侵入式双链表 TsFileResourceList 成员 |
| `FragmentInstance` | MPP 查询的执行单元（并行克隆） | 单查询内 | 由 PlanNode 树生成，产出 TsBlock |
| `EnrichedEvent` | pipe 事件的装饰器 | 引用计数归零即提交 | 多 pipe 共享一次捕获 |
| `PlanNode` | 查询/写入计划的统一节点 | 语句级 | 自序列化跨节点传输（IConsensusRequest） |
| `PartialPath` | 树模型路径的模式表示 | 语句级 | 全仓最高扇入类型 |

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `IConsensus` / `IStateMachine` | `iotdb-core/consensus` | Simple/Ratis/IoTConsensus(V2) + 三类状态机 | `ConsensusFactory` 反射 + `IStateMachine.Registry` |
| `IPlanner` | datanode queryengine | `TreeModelPlanner` / `TableModelPlanner` | Coordinator 按 statement 类型构造 |
| `Operator` | calc-commons | source/process/sink 三族 | `OperatorTreeGenerator`/`DataNodeTableOperatorGenerator` |
| `ISchemaRegion` | datanode schemaengine | Memory / PBTree 两实现 | `@SchemaRegion(mode)` 注解反射 |
| `PipeSource`/`PipeProcessor`/`PipeConnector` | `iotdb-api/pipe-api` | 内置 + 用户 jar | CREATE PIPEPLUGIN + 独立 ClassLoader |
| `UDF`/`UDTF`/`Trigger` | `iotdb-api` | 用户 jar + library-udf 示例 | CREATE FUNCTION/TRIGGER + COW loader |
| `IService` | node-commons | 18+ 后台服务 | `RegisterManager.register` |

## 代码目录

```shell
iotdb/
├── iotdb-core/
│   ├── datanode/          # 存算节点主体（~83 万行）：storageengine/queryengine/schemaengine/pipe/subscription/trigger
│   ├── confignode/        # 元数据协调（~13 万行）：manager/procedure/consensus/persistence
│   ├── consensus/         # 共识协议（~2 万行）：iot/ratis/simple/pipe(V2)
│   ├── node-commons/      # 跨节点共享底座（~15 万行）：path/PlanNode/分区/连接池
│   ├── calc-commons/      # Trino 血统计算公共层（~7 万行）+ freemarker codegen
│   ├── ainode/            # Python 推理进程（~2.3 万行）
│   ├── antlr/             # 树模型 SQL 文法
│   ├── relational-grammar/# 表模型 SQL 文法（Trino 风格）
│   └── metrics/           # 指标框架（core/interface）
├── iotdb-protocol/        # 五套 thrift IDL（thrift-commons/confignode/datanode/consensus/ainode）
├── iotdb-client/          # session/isession/jdbc/cli/service-rpc/subscription/client-py/cpp/go
├── iotdb-api/             # udf-api/trigger-api/pipe-api/external-api
├── library-udf/           # 官方 UDF 库（anomaly/dquality/dmatch/drepair/frequency/series）
├── integration-test/      # IT（with-integration-tests profile 才参与构建）
└── distribution/          # 装配与启动脚本（sbin/start-*.sh）
```

## 模块地图

![模块依赖图](/vibe-reading/images/articles/iotdb-2.0.10/module-dependencies.svg)

依赖主线：datanode 的四大引擎（存储/元数据/查询/pipe）都向下经共识层落 region，共识层向下依赖 node-commons 的 PlanNode 序列化；公共层（node-commons/calc-commons）被四个 JVM 模块共享且永不反向依赖。模块间的动态调用顺序见运行时行为。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 存储引擎 | 写入/flush/compaction/WAL/TsFile 管理 | `StorageEngine.getInstance()` | LSM 式存算核心，DataRegion 即状态机 | [01-storage](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/01-storage) |
| 查询引擎 | 双模型 MPP 计划与执行 | `Coordinator.getInstance()` | 全仓最大子系统，Trino 化执行层 | [02-query](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/02-query) |
| 元数据引擎 | 树/表统一 schema | `SchemaEngine.getInstance()` | 百万级设备元数据的专门引擎 | [03-metadata](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/03-metadata) |
| 共识层 | 多副本一致性 | `ConsensusFactory` | 协议可插拔，数据/元数据分野 | [04-consensus](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/04-consensus) |
| ConfigNode | 集群元数据与协调 | `ConfigManager` | 独立进程，元数据单一真源 | [05-confignode](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/05-confignode) |
| Pipe 引擎 | 数据流转 | `PipeDataNodeAgent` | 一套引擎三用（同步/订阅/复制） | [06-pipe](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/06-pipe) |
| 订阅与协议 | poll/ack 消费 + thrift 底座 | `SubscriptionAgent` | 客户端拉模型与 RPC 单一真源 | [07-subscription-protocol](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/07-subscription-protocol) |
| 客户端 | 接入与集群路由 | `Session` / `IoTDBDriver` | 三层 failover 逻辑独立演进 | [08-client](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/08-client) |
| AINode | 时序推理 | `AINode.start()`（Python） | 进程级依赖栈与崩溃隔离 | [09-ainode](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/09-ainode) |
| calc-commons | Trino 血统计算基座 | `Operator` / `Pattern` | 与数据面无关可共享 | [10-calc-commons](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/10-calc-commons) |
| node-commons | 跨节点共享类型 | `PartialPath` / `PlanNode` | 防 consensus→datanode 循环依赖 | [11-node-commons](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/11-node-commons) |
| 服务装配 | 进程生命周期 + UDF/Trigger | `DataNode.main` | 装配与扩展体系正交于业务引擎 | [12-service-assembly](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/12-service-assembly) |

## 运行时行为

### 启动流程

DataNode 进程启动（ConfigNode 类似，见其模块篇）：

```
main (DataNode.java:213)
 ├─ DataNodeStartWatcher daemon（每 10s 打印 main 栈，诊断卡启动）
 ├─ ExitUtils.disableSystemExit()（禁 Ratis 的 System.exit）
 └─ run(args) → start() (L252)
     ├─ prepareDataNode()：StartupCheck + 判首启
     ├─ pullAndCheckSystemConfigurations()：全局配置以 ConfigNode 为真源（防脑裂）
     ├─ 首启：sendRegisterRequestToConfigNode → storeRuntimeConfigurations
     │        （UDF/Trigger/Pipe 元数据 + jar 的"冷启动灌浆"）
     ├─ active()：setUp()（RegisterManager 注册即启动 18 个服务，
     │   顺序即依赖序：JMX → SchemaEngine → FlushManager → WALManager
     │   → CompactionScheduleTaskManager → StorageEngine → MPPDataExchange
     │   → DriverScheduler → UDF → 轮询 ready → RegionManager → Pipe/订阅）
     │   + SchemaRegion/DataRegion 共识启动
     └─ setUpMetricService + setUpRPCService（6667 对外）
```

对象装配要点：全部服务是静态 Holder 单例（DataNode 构造器刻意不初始化，供集成测试 `reinitializeStatics()` 重建）；配置三级合流（本地 properties + ConfigNode 全局配置 + 注册响应运行时配置）；UDF/Trigger 的 jar 从 ConfigNode 分批拉取。

### 核心运行流程

以下两条链路覆盖了 IoTDB 运行时的主干——一条读一条写，其余（DDL、pipe、订阅）都寄生在这两条之上。

#### 查询链路：树模型 SELECT

![端到端数据流](/vibe-reading/images/articles/iotdb-2.0.10/data-flow.svg)

从客户端 `Session.executeQueryStatement`（或 CLI 的 JDBC）出发：thrift 6667 → `ClientRPCServiceImpl.executeStatementV2`（:1154，权限与配额检查）→ `StatementGenerator.createStatement`（SLL→LL 两阶段 ANTLR 解析）→ `Coordinator.executeForTreeModel` 构造 `QueryExecution`，五段执行：Analyzer 语义分析（schema fetch、分区映射）→ LogicalPlanner 产 PlanNode 树 → DistributionPlanner 四步（rewriteSource 按分区改写扫描节点 → 插 Exchange/Sink 对 → 切分 FragmentInstance 并并行克隆）→ ClusterScheduler 经内部 RPC 派发到目标 DataNode → 远端 `FragmentInstanceManager` 幂等接收，`LocalExecutionPlanner` 生成 Driver 流水线，`DriverScheduler` 时间片执行 Operator 产出 TsBlock，经 SinkChannel/SourceHandle（同节点零拷贝队列）回流协调节点，客户端按 fetchSize 拉取。失败沿 `FragmentInstanceStateMachine` → 状态轮询 → `QueryStateMachine.transitionToFailed` 传播，`retry()` 最多 3 次并强刷分区缓存。

#### 写入链路：insertTablet 到 TsFile 落盘

同图右侧：`Session.insertTablet` 生成 thrift 请求（可能收到 RedirectException 更新 leader 缓存）→ **写入也经 Coordinator**（`ClientRPCServiceImpl.insertTablet`:2752 明确调用，生成 InsertTabletNode 并走 WriteFragmentParallelPlanner 派发到 region 所在节点）→ 共识 `write()`（默认 IoTConsensus：WAL 节流检查 → 本地状态机写入 → **成功即返回客户端**，复制异步）→ `DataExecutionVisitor.visitInsertTablet` → `DataRegion.insertTablet`：三级内存反压自旋 → 写锁 → TTL → `split()` 切时间分区并按 lastFlushTime 判 seq/unseq → `TsFileProcessor.insertTablet`：类型检查 → 内存记账 → **WAL 先于 memtable**（SYNC 模式同步等待，失败回滚内存记账）→ pipe 捕获点 → TVList append → `shouldFlush()` 触发异步封口。之后全部异步：FlushManager 三阶段流水线（sort→encode→IO）→ 封口 TsFile 注册入 TsFileManager → WAL checkpoint 推进水位 → compaction 后台合并。`WRITE_PROCESS_REJECT` 逐级重试：状态机 5 次 → dispatcher 换副本 → 客户端。

### 状态流

![三个核心状态机](/vibe-reading/images/articles/iotdb-2.0.10/state-flow.svg)

三个最值得记住的状态机：**TsFileResourceStatus**（UNCLOSED → 封口写 .resource → NORMAL ⇄ COMPACTION_CANDIDATE → COMPACTING（CAS 防并发）→ 成功 DELETED / 失败回滚 NORMAL，定义于 `TsFileResourceStatus.java`，转换方法是 `TsFileResource.transformStatus()` :963）；**QueryStateMachine**（QUEUED→PLANNED→DISPATCHING→RUNNING→FINISHED/FAILED/ABORTED/CANCELED，终态监听器统一 `releaseResource()`）；**PipeTask**（STOPPED→RUNNING→STOPPED→DROPPED——新 pipe 初始即 STOPPED 以统一迁移逻辑，见 `PipeTaskAgent` 类头 javadoc）。

## 典型修改场景

#### 场景 1：新增树模型查询算子

三步：calc-commons 或 datanode 加 Operator 类（hasNext/next/isFinished/close + `calculateMaxPeekMemory()` 四件套）→ 新 PlanNode（node-commons `PlanVisitor` 加抽象方法——**波及全部 ~5 个实现类**，最大机械成本）→ `OperatorTreeGenerator.visitXxx()` 构造。对应测试：`iotdb-core/datanode/src/test` 的 queryengine 相关 UT。

#### 场景 2：新增 UDF（用户侧，零代码改动）

实现 `UDTF`（udf-api）打 jar → `CREATE FUNCTION ... AS 'ClassName' USING URI '.../xxx.jar'` → 查询里直接 `SELECT udf(x) FROM ...`。服务端走 `UDFManagementService.doRegister()`（COW 类加载器换代）+ `UDTFExecutor`（每查询 newInstance）。对应测试：`integration-test` 的 libudf 目录。

#### 场景 3：新增共识协议

新包实现 `IConsensus`（构造器签名固定 `(ConsensusConfig, IStateMachine.Registry)`）→ `ConsensusFactory` 加常量 → 配置 `data_region_consensus_protocol_class` 指向新类。DataRegion/SchemaRegion 侧零改动（反射加载）。对应测试：`iotdb-core/consensus/src/test`。

## 测试体系

```shell
iotdb-core/datanode/src/test/          # 单元测试（auth/conf/consensus/metadata/pipe/framework…）
iotdb-core/*/src/test/                 # 各模块自带 UT
integration-test/src/test/java/org/apache/iotdb/it/
  ├── db/ ... / pipe/ subscription/ ainode/ relational/ tools/ ...
```

| 代码层 | 测试类型 | 运行方式 |
| --- | --- | --- |
| 各模块内部逻辑 | UT | `mvn clean test -pl iotdb-core/datanode` |
| 集群行为（1C1D/1C3D、树/表模型） | IT | `-P with-integration-tests`（另有 ClusterIT/TableSimpleIT/TableClusterIT profile） |
| 共识容错 | 混沌测试 | KillPoint 注入体系（`DataNodeKillPoints`） |
| 排查格式问题 | 编译期 | `mvn spotless:check`（Google Format，编译时强制） |

理解某个类优先看它对应的 UT；验证新特性只跑相关 IT 类（AGENTS.md 明确要求不全量跑）。

## 阅读源码推荐路线

- **第一遍：主流程**
  `iotdb-core/datanode/.../service/DataNode.java` 的 `main()`/`start()`/`setUp()` → `storageengine/StorageEngine.java` → `queryengine/plan/Coordinator.java` 的 `executeForTreeModel()`——看懂进程怎么装配、读写怎么进来。
- **第二遍：写入落盘**
  `storageengine/dataregion/DataRegion.java` 的 `insertTablet()`（L1378）→ `memtable/TsFileProcessor.java` 的 `insertTablet()`（L569）→ `utils/datastructure/TVList.java` → `tsfile/TsFileResource.java` 的 `transformStatus()`——理解 seq/unseq、WAL 先于 memtable、文件状态机。
- **第三遍：查询执行**
  `queryengine/plan/parser/StatementGenerator.createStatement()` → `plan/execution/QueryExecution.start()` → `plan/planner/distribution/DistributionPlanner.planFragments()` → `execution/driver/Driver.processFor()` → `execution/operator/source/AbstractSeriesScanOperator`——理解 Exchange/Sink 切分与协作式调度。
- **第四遍：横向机制**
  `consensus/iot/IoTConsensusServerImpl.write()` + `iot/logdispatcher/LogDispatcher.java`（异步复制）→ `db/pipe/agent/task/builder/PipeDataNodeTaskBuilder.build()`（一套引擎三用）→ `confignode/manager/PartitionManager.getOrCreateSchemaPartition()`（分区分配）——然后按模块地图选读各模块文档。

## 附录

### 术语表

| 术语 | 解释 |
| --- | --- |
| Region（DataRegion/SchemaRegion） | 共识组的载体，database 按 (series slot × time slot) 的分片 |
| sequence / unsequence | 顺序/乱序文件双队列：`time > lastFlushTime` 的写入进 sequence，迟到数据进 unsequence |
| IoTConsensus | 单写多读异步复制协议：本地写成功即返回，WAL 即共识日志，leader 恒真（`isLeader()` return true） |
| TsFile | 列式时序文件格式（外部 repo），IoTDB 的持久化单元 |
| TsBlock / TVList | 查询期的列式数据块 / memtable 的列式内存结构（分段原生数组） |
| FragmentInstance / Driver | MPP 执行单元 / 时间片调度的算子流水线 |
| Pipe / Subscription | 推送到外部系统的数据管道 / 客户端 poll/ack 订阅（共用 pipe 引擎） |
| MLog | SchemaRegion 的操作日志（非 Ratis 模式下的恢复源） |
| 1C1D | 一个 ConfigNode + 一个 DataNode 的最小集群（"单机模式"的真身） |

### 参考资料

- 官方文档：<https://iotdb.apache.org/UserGuide/>
- TsFile 格式 repo：<https://github.com/apache/tsfile>
- Apache Ratis：<https://ratis.apache.org/>
- Trino（表模型查询引擎的血统来源）：<https://github.com/trinodb/trino>
- 仓库内 `AGENTS.md`（构建/测试/代码规范速查，含大量实战坑位说明）
