---
title: "Apache Doris 4.1 Spill to Disk：避免运行内存密集型查询发生 OOM"
source:
  type: "article"
  project: "Doris"
  url: "https://mp.weixin.qq.com/s?__biz=Mzg3Njc2NDAwOA==&mid=2247541017&idx=1&sn=4dbd72d9fd66f0479ca2f2961382aed2"
  author: "衣国垒"
  site: "公众号 SelectDB"
date: "2026-08-12T15:12:50+08:00"
category: [Database, OLAP, "Apache Doris", Official]
tags: ["Apache Doris", "Spill to Disk", "OOM", "查询优化", "内存管理", "Hash Join", "Aggregation", "Sort"]
description: "Apache Doris 4.1 对 Spill to Disk 能力全面重构：核心算子全覆盖、递归重分区应对数据倾斜、主动内存压力感知，单 BE 16G 内存挑战 10TB TPC-DS 基准测试。"
readingTime: "10 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [Apache Doris 4.1 Spill to Disk：避免运行内存密集型查询发生 OOM](https://mp.weixin.qq.com/s?__biz=Mzg3Njc2NDAwOA==&mid=2247541017&idx=1&sn=4dbd72d9fd66f0479ca2f2961382aed2) · **作者** 衣国垒 · **来源** 公众号 SelectDB · **原文发布** 2026-08-12 · **转载** 2026-08-12

---

作者｜衣国垒，Apache Doris PMC 成员

在数据分析与数仓建设中，大规模数据关联（Join）、聚合（Aggregation）和排序（Sort）往往需要消耗海量的内存资源。随着业务数据量的激增、数据基数的膨胀或偶发的数据倾斜，查询的实际内存需求常常会远超系统预估。

一旦可用内存耗尽，系统就会触发 OOM（Out of Memory，内存溢出）错误。这意味着，一个可能已经运行了数小时的重度 ETL 任务会瞬间终止。以季度财务结算为例：一项任务需要关联过去 3 年的交易流水、客户维表和产品层级，再按大区进行聚合运算。如果由于内存耗尽导致任务失败，数据团队往往需要连夜排查、缩小查询范围、拆分作业并重跑，原定次日早晨交付管理层的报表将面临严重的延期风险。

为了从根本上解决这一痛点，Spill to Disk（数据落盘） 技术应运而生。当查询面临内存瓶颈时，该技术能够将部分暂时不用的中间数据"溢出"并写入磁盘，腾出宝贵的内存空间让查询继续执行；待需要时，再从磁盘中按需读取恢复。这不仅极大降低了 OOM 导致的任务中断风险，更为企业节省了拆分任务和重复计算带来的高昂运维成本。

在 Apache Doris 4.1 版本中，我们对 Spill to Disk 能力进行了全面重构与升级。在核心算子覆盖率、数据倾斜处理机制以及主动内存控制上实现了质的飞跃，使其能够真正稳定支撑超大规模的分析型查询。

## 01 Apache Doris 4.1 的三大核心跃升

在最新版本中，Apache Doris 针对 Spill to Disk 进行了三项关键增强：

**核心内存消耗算子全覆盖**：Hash Join（哈希关联）、Aggregation（聚合）和 Sort（排序）均已支持 Spill。这三类操作是分析型数据库中最主要的内存压力来源，实现全覆盖意味着绝大多数内存密集型查询都能获得监管把控。

**支持递归重分区（应对数据倾斜）**：在真实业务中，常会出现某些特定维度数据过度集中的现象（数据倾斜）。如果某批落盘的数据在恢复时依然庞大到无法载入内存，Doris 的执行引擎会对其进行"递归重分区"。这一机制确保了即使在极端倾斜场景下，任务依然能平稳运行。

**支持主动内存压力感知与触发**：区别于"不到最后一刻不落盘"的被动策略，Doris 4.1 引入了预判机制。系统会实时监控内存压力，在触及系统内存硬性红线之前，主动将数据落盘，彻底避免了因内存分配彻底失败而导致的进程崩溃。

## 02 为什么内存密集型算子必须支持落盘？

在 Apache Doris 的执行引擎中，以下三类核心算子在输出最终结果前，必须在内存中持续维护庞大的中间状态：

![Hash Join、Aggregation、Sort 三类核心算子的中间状态](/vibe-reading/images/articles/doris-official-spill-to-disk/operators-intermediate-state.png)

由于这些中间状态在逻辑上可以被序列化（转为连续的字节流），因此它们无需时刻驻留内存。Spill to Disk 的核心逻辑，就是用相对廉价的磁盘 I/O 时间，换取宝贵的内存空间，从而显著压低查询的峰值内存。

## 03 全局视角的 Spill to Disk 架构设计

在架构实现上，Apache Doris 并没有让各个算子独自去盲目落盘，而是设计了一套**统一的控制机制**。它由上至下分为四个层次，协调处理内存预留、任务调度和文件读写：

- **控制层**：负责全局调控。`PipelineTask` 负责执行前的内存预留与压力探测；`WorkloadGroupMgr` 统筹处理因内存不足而暂停的查询，决策是否需要落盘；`QueryTaskController` 则精准挑选出最适合落盘的算子。

- **算子层**：各类物理算子（如 Partitioned Hash Join、Aggregation 等）接收到指令后，调用统一接口执行自身状态的磁盘写入和后续的读取恢复。

- **基础设施层**：提供标准化的磁盘文件读写能力（`SpillFileManager` 等），自动处理文件分片、垃圾回收以及多级重分区逻辑，减轻算子层的负担。

- **内存管理层**：构建了"查询级 -> 负载分组（WG）级 -> 进程级"三道内存水位防线，实时校验查询能否继续进行。

![Spill to Disk 四层架构：控制层、算子层、基础设施层、内存管理层](/vibe-reading/images/articles/doris-official-spill-to-disk/architecture.png)

## 04 核心触发流程：从预留、暂停到恢复

Spill 并不是在查询已经发生 OOM 后才启动。Apache Doris 会在执行过程中持续检查内存状态，发现风险时及时暂停查询，将部分可回收的中间状态写入磁盘。释放出足够的内存后，查询再从暂停位置继续执行。

完整流程可以概括为 4 个阶段：

- **预留（Reserve）**：算子在进行下一步计算前，先检查可用内存。

- **暂停（Pause）**：一旦发现内存不足或压力过高，立即暂停当前查询。

- **落盘（Spill）**：选择具有较多可回收内存的算子，将其中间状态写入磁盘。

- **恢复（Resume）**： 内存腾出后，重新调度暂停的任务，完成计算。

![Spill to Disk 核心触发流程：预留 → 暂停 → 落盘 → 恢复](/vibe-reading/images/articles/doris-official-spill-to-disk/trigger-flow.png)

### 4.1 智能的主动触发机制

除了在 Reserve 失败后被动触发 Spill，Doris 的预判机制是保障稳定性的关键。当以下三个条件同时满足时，系统将主动出击触发落盘：

- **大额内存请求预判**：预计当前算子下一步需要的内存量极大：`reserve_size × parallelism > query_limit / 5`

- **系统处于高压状态**：当前查询的内存使用率已突破 90%，或其所属的资源组（Workload Group）触及了预设的内存高水位线。

- **具备落盘价值**：算子当前持有的可回收内存足够多，落盘行为能释放出有效空间：`revocable_mem × parallelism ≥ query_limit × 20%`

这样智能、主动的触发机制，无需等到内存分配失败后再进行处理，能更大程度的保障查询的性能和系统的稳定性。

### 4.2 精准挑选落盘目标

当确定要执行 Spill（落盘）时，系统并不会让所有算子一拥而上。

`QueryTaskController` 会按照可回收内存的规模进行降序排列，精准挑选出一批算子，其目标是释放当前实际内存消耗的 20%。

例如，当前查询消耗了 1GB 内存，系统只会让约占用 200MB 的算子状态落盘。这种克制的策略最大程度减少了不必要的磁盘 I/O，保障了查询性能。

## 05 各核心算子是如何落盘的？

底层算子的 Spill 逻辑极为精巧，不同算子的处理方式因其计算特征而异：

**Hash Join（化大为小，逐个击破）**：

当用于匹配的内存哈希表过大时，Doris 会将数据按 Join Key 进行哈希分区并写入磁盘。为了确保匹配逻辑的正确性，左右两表（Build 端与 Probe 端）会采用相同的规则进行分区落盘。在恢复阶段，系统只需将落在同一分区的两表小文件读回内存进行局部 Join。一个极其庞大、可能撑爆内存的 Join，就这样被拆解成了若干个安全、可控的微型 Join。

![Hash Join 落盘机制：按 Join Key 哈希分区写入磁盘，恢复时逐分区局部 Join](/vibe-reading/images/articles/doris-official-spill-to-disk/hash-join-spill.png)

**Aggregation（状态暂存，延后合并）**：

聚合算子落盘时，写入磁盘的不是最终结果，是中间状态（例如 SUM 操作当前的局部累计值）。系统根据分组键（Group Key）将这些中间状态分区落盘，待内存宽裕时重新读出，将相同分组的状态进行二次合并，最终输出准确结果。

![Aggregation 落盘机制：按 Group Key 分区落盘中间状态，恢复时二次合并](/vibe-reading/images/articles/doris-official-spill-to-disk/aggregation-spill.png)

**Sort（分批排序，多路归并）**：

排序算子采用经典的外部归并排序（External Merge Sort）。数据在内存中完成局部排序后，化作一个个有序的数据块（Run）写入磁盘；所有数据处理完毕后，系统再对磁盘上的多份有序数据进行多路归并，输出全局有序的结果。

![Sort 落盘机制：内存局部排序生成有序 Run 写入磁盘，多路归并输出全局有序结果](/vibe-reading/images/articles/doris-official-spill-to-disk/sort-spill.png)

## 06 基准测试：单 BE 16G 内存挑战 10TB 数据量

为了验证 Apache Doris 4.1 Spill to Disk 的极限能力，我们使用 **1 台 16GB 内存** 的 BE（计算节点）上，进行了 **TPC-DS (10 TB 规模)** 基准测试。

测试结果明[^err]，开启 Spill to Disk 后，查询和系统稳定性均有较强的表现：

[^err]: 原文如此，疑为"测试结果表明"。

- 所有涉及复杂 Join、聚合的重量级查询（如 `Query14`、`Query23`、`Query78` 等）均顺利执行完毕，无一因 OOM 中断。

- 在部分极端用例中（如 `Query78`），单节点内存消耗被严格控制在 8GB 红线以内，而其读写本地存储（Spill 临时文件）的数据量高达 1000GB+，是典型的以空间换内存运行机制。

- CPU 利用率在数据落盘与计算恢复之间平滑切换，避免了因内存变化导致的系统卡死。

(注：当前版本中 Intersect/Except 集合算子暂不支持 Spill，测试中通过语义等价的 Join 改写顺利完成。)

➡️ 完整测试结果可见附件：Spill to Disk_Doris单 BE 16G 内存挑战 10TB 数据量.xlsx

## 07 结束语

Apache Doris 4.1 的 Spill to Disk 是一套深度融合了内存预留、智能调度、压力感知的现代化查询生命周期管理机制。对于重度数据分析用户而言，提供了一种在有限硬件资源下，安全、可靠进行超大规模分析任务的绝对保障。随着算子覆盖范围和执行机制的持续完善，Spill to Disk 将进一步提升 Apache Doris 在复杂分析场景下的稳定性和可扩展性。

本文着重解析了核心架构与设计思想。如果您希望在生产环境中开启 Spill to Disk 功能，或了解更为详尽的系统级参数配置，欢迎查阅 Apache Doris 官方文档：https://doris.apache.org/docs/dev/key-features/spill-to-disk 。如果希望进一步体验稳定的、云原生托管版本，也可以了解 SelectDB 提供的相关服务：selectdb.com

## 相关阅读

- [Pipeline 执行引擎](/vibe-reading/articles/doris-official-pipeline-execution-engine) — **底层基座**·Spill to Disk 运行于 Pipeline 执行引擎之上，Pipeline 的内存预留与压力探测是落盘触发的起点
- [Runtime Filter](/vibe-reading/articles/doris-official-runtime-filter) — **查询优化**·与 Spill 互补的查询加速机制，Runtime Filter 减少 Join 数据量，Spill 兜底内存溢出
- [【Doris全面解析】Doris Compaction机制解析](/vibe-reading/articles/doris-official-compaction-mechanism) — **同系列**·同属 Apache Doris 核心机制解析，Compaction 管理存储层版本合并，Spill 管理查询层内存溢出
