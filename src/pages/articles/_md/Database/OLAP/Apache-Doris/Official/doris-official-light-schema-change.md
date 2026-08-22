---
title: "DDL 毫秒级同步，Light Schema Change 的设计与实现｜新版本揭秘"
source:
  type: "article"
  project: "Doris"
  url: "https://zhuanlan.zhihu.com/p/582470360"
  author: "刘常良、吴迪"
  site: "知乎 SelectDB"
date: "2026-07-27"
category: [Database, OLAP, Apache Doris, Official]
tags: ["SelectDB", "Apache Doris", "Schema Change", "Light Schema Change", "Flink CDC"]
description: "Apache Doris 1.2.0 Light Schema Change 设计与实现：加减列只改 FE 元数据实现毫秒级同步，替代 Hard Linked Schema Change，结合 Flink CDC 自动同步 DDL。"
readingTime: "10 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **原文** [DDL 毫秒级同步，Light Schema Change 的设计与实现｜新版本揭秘](https://zhuanlan.zhihu.com/p/582470360) · **作者** 刘常良、吴迪 · **来源** 知乎 SelectDB · **原文发布** 2024-01-29 · **转载** 2026-07-27

---

> **作者介绍：**
> 刘常良：Apache Doris Contributor，SelectDB 存储层研发工程师。
> 吴迪：Apache Doris Committer，SelectDB 生态研发工程师。

在 OLAP 的业务场景中，Schema Change 是一个相对常见的业务需求，当上游数据源维度发生变化时，通常需要将数仓中的表结构进行相应的变更。相对于业界其他 OLAP 数据库，Apache Doris 对于 Schema Change 的支持非常友好，可支持 Online Schema Change，进行加减列或修改列类型时无须停服，保证了系统的高可用和业务的平稳运转。但在部分场景下，Schema Change 也存在一定的瓶颈，例如：在面对大数据量宽表场景下，Schema Change 执行效率相对较低、耗费时间较长；另外基于 Flink 和 Doris 构建实时数仓时，因 Schema Change 是异步作业，一旦上游表发生维度变化，需要自己维护 Schema Change 的执行状态，并在完成后重启 Flink Job，无法做到自动化变更，冗长复杂的操作流程无疑增加了许多开发和运维的成本，且可能会带来消费数据的积压。

基于此，Apache Doris 将在 1.2.0 版本推出新功能 Light Schema Change，我们将通过本文为大家揭秘 Light Schema Change 的设计与实现，并分享其如何提升表结构变更的执行效率、以及如何在 Flink + Doris 实时数仓场景中实现 DDL 操作的自动同步。

---

## 需求背景

在正式介绍之前，需要认识一下 Apache Doris 1.2.0 版本之前支持的 3 种 Schema Change 方式，这三种方式都是异步的：

- Hard Linked Schema Change 主要作用于加减 value 列，不需要对数据文件有修改。
- Direct Schema Change 主要作用于改变 value 列的类型，需要对数据进行重写，但不涉及到 key 列，无需重新排序。
- Sort Schema Change 主要是作用于对 key 列进行的 Schema Change，由于对 key 列进行加/减/修改类型等操作都会影响到已有数据的排序，所以需要把数据重新读出来，修改后，然后再进行排序。

而值得注意的是，**1.2.0 版本新增的 Light Schema Change 新特性正是替换了加减列操作的 Hard Linked Schema Change 流程**。在了解 Light Schema Change 的优势之前，我们需要先知道 Hard Linked Schema Change 的技术原理。

Hard Linked Schema Change 在作用于加减 Value 列时，当接收到加减 Value 列的 DDL，Doris FE（下文简称 FE）会发起一个异步的作业，并立刻返回。作业主要做以下事情：

1. 创建新的 Tablet。
2. 等待已经开始的导入完成。
3. 将当前已有的数据文件 Hard Link 到新 Tablet 对应的数据目录下。

在使用过程中，我们发现 Hard Linked Schema Change **存在几个明显的问题：**

1. 当集群规模和表数据量达到一定数量时，Hard Linked Schema Change 等待时间就会明显增加。
2. 在 Hard Linked Schema Change 过程中，如果有导入任务，为保证 Schema Change 的事务性，会对新/旧 Tablet 进行双写，Schema Change 则需要等待导入任务完成之后才可以进行。在遇到这种情况时，用户往往只有 2 个选择：一个是等待 Schema Change 完成再进行导入；一个是接受双写的代价。而这两种选择对用户都不太友好。
3. Hard Linked Schema Change 无法处理 Delete Predicate。如果用户在 Schema Change 之前调用过 Delete 语句，Doris 不会立刻删除数据，而是记一个 Rowset，并把 Delete Predicate 和此 Rowset 进行关联；如果在做 Hard Linked Schema Change 过程中，发现 Delete Predicate，则会转化为 Sort/Direct Schema Change，对数据进行重写。

---

## Light Schema Change 的设计与实现

相较于 Hard Linked Schema Change 的作业流程，Apache Doris 1.2.0 新版本的 Light Schema Change 的实现原理就要简单的多，只需要在加减 Value 列的时候，对 FE 中表的元数据进行修改并持久化。在设计过程中，需要考虑到以下实现细节：

---

## 解决 Schema 不一致问题

由于 Light Schema Change 只修改了 FE 的元数据，没有同步给 BE，而 BE 对读写操作依赖于自身的 Schema，这时候就会出现 Schema 不一致的问题。为了解决此问题，我们对 BE 读写流程进行了修改。主要包含以下方面：

1. 读取数据的时候下发 Schema。Schema 每一列都有相应的 Unique ID，该 Unique ID 由 BE 的每个 Tablet 负责产生和赋值，但对于所有的 Tablet，其 Schema 列的 Unique ID 都是一致的，因此将此过程移在 FE 上去实现。FE 在生成查询计划时，会把最新的 Schema 附在其中，并一起发给 BE，BE 会拿最新的 Schema 读取数据，以此来解决**读过程**中 Schema 的不一致。
2. 将 Schema 持久化到 Rowset 的元数据中。FE 在发起导入任务的时候，会把最新的 Schema 一起下发给 BE，BE 会根据最新的 Schema 对数据进行写入并与 Rowset 绑定，将该 Schema 持久化到 Rowset 的元数据之中，实现了 Rowset 数据的自解析，解决了**写过程**中 Schema 的不一致。
3. 在进行 Compaction 的时候，选取需要进行 Compaction 的 Rowset 中最新的 Schema，作为 Compaction 之后 Rowset 所对应的 Schema，以此来解决拥有不同 Schema 的 Rowset 合并问题。

---

## 全局 Schema Cache

由于 Rowset 的元数据一直存储在内存中，如果每个 RowsetMeta 都存储一份 Schema，会对内存造成较大的压力。为了解决这个问题，实现了一个全局的 Schema Cache 管理相同的 Schema，这样就算有成千上万个 Rowset，只要 Schema 相同，内存中只会存在一份 Schema。

---

## 支持物化视图

Light Schema Change 也实现了对物化视图的支持。对读写流程修改之后，物化视图也可以正常读写。同时，如果要删除的列在物化视图中是 Value 列，则会与主表一起触发 Light Schema Change；如果主表的 Value 列是物化视图中的 Key 列，则需要发起异步任务，对物化视图进行 Sort/Direct Schema Change。

---

## 解决数据重写问题

由于 Delete Predicate 绑定了 Rowset，且每个 Rowset 都绑定了 Schema，当 Delete Predicate 所涉及的列被删除后，可以通过寻找到对应的 Rowset，Merge 该列的信息进当前的 Schema 中，这样对 Delete Predicate 之前的数据也可以正常过滤。解决了数据中有 Delete Predicate 需要重写数据的问题。

以上就是 Light Schema Change 功能实现过程中对 Doris 进行的修改，在使用的时候只需在建表的时候指定参数即可打开 Light Schema Change 功能，如下所示：

```sql title="建表开启 Light Schema Change"
CREATE TABLE IF NOT EXISTS `customer` (
  `c_custkey` int(11) NOT NULL COMMENT "",
  `c_name` varchar(26) NOT NULL COMMENT "",
  `c_address` varchar(41) NOT NULL COMMENT "",
  `c_city` varchar(11) NOT NULL COMMENT "",
  `c_nation` varchar(16) NOT NULL COMMENT "",
  `c_region` varchar(13) NOT NULL COMMENT "",
  `c_phone` varchar(16) NOT NULL COMMENT "",
  `c_mktsegment` varchar(11) NOT NULL COMMENT ""
)
DUPLICATE KEY(`c_custkey`)
DISTRIBUTED BY HASH(`c_custkey`) BUCKETS 32
PROPERTIES (
"replication_num" = "1",
"light_schema_change" = "true"
);
```

---

## 性能对比

为进一步体验 Light Schema Change 的执行效率，我们在 1 FE 1 BE 的集群上对加减列操作分别在有导入任务时和无导入任务时进行了对比。硬件配置为 16C 64G，数据均在 SSD 盘，使用了 TPC-H SF100 的 lineitem 表，数据量约 74G，具体测试对比如下：

### 无导入任务时

**加列：**

1. **Hard Link Schema Change：** 耗时 1s 310ms。

![加列 Hard Linked Schema Change 耗时 1s310ms](/vibe-reading/images/articles/doris-official-light-schema-change/fig-1-add-col-hard-link.jpg)

2. **Light Schema Change：** 耗时 7ms。

![加列 Light Schema Change 耗时 7ms](/vibe-reading/images/articles/doris-official-light-schema-change/fig-2-add-col-light.jpg)

**减列：**

1. **Hard Link Schema Change：** 耗时 1s 438ms。

![减列 Hard Linked Schema Change 耗时 1s438ms](/vibe-reading/images/articles/doris-official-light-schema-change/fig-3-drop-col-hard-link.jpg)

2. **Light Schema Change：** 耗时 3ms。

![减列 Light Schema Change 耗时 3ms](/vibe-reading/images/articles/doris-official-light-schema-change/fig-4-drop-col-light.jpg)

由上面测试可以看出，Light Schema Change 加减列速度远快于 Hard Link Schema Change，并且随着 BE 节点和表数据量的增多，Hard Link Schema Change 的耗时是远高于 Light Schema Change 的，原因是 Light Schema Change 只需要和 FE Master 进行交互，并可以实现同步返回。

### 有导入任务时

**加列**

1. **Hard Link Schema Change：** 耗时 13 mins。

![有导入任务时加列 Hard Linked Schema Change 耗时 13mins](/vibe-reading/images/articles/doris-official-light-schema-change/fig-5-add-col-import-hard-link-1.jpg)

![有导入任务时加列 Hard Linked Schema Change（续）](/vibe-reading/images/articles/doris-official-light-schema-change/fig-6-add-col-import-hard-link-2.jpg)

2. **Light Schema Change：** 耗时 3 ms。

![有导入任务时加列 Light Schema Change 耗时 3ms](/vibe-reading/images/articles/doris-official-light-schema-change/fig-7-add-col-import-light.jpg)

从上面测试可以看出，同样的加列行为，如果有导入任务，Hard Link Schema Change 需要等待导入的完成，才可以做 Schema Change，而 Light Schema Change 无需等待毫秒内即可完成导入。

欢迎读者尝试上手做一下有导入任务时的减列对比测试，也可以做一下在 Schema Change 过程中进行导入的情况下，两种 Schema Change 的速度对比。

---

## Flink 结合 Light Schema Change 实现 DDL 同步

之前在基于 Apache Doris 和 Apache Flink 构建实时数仓时，当上游数据源发生表结构变更时，Doris 在同步 DDL 操作时主要有以下痛点：

1. 在发起 Schema Change 后为了避免双写对集群产生的压力，通常会选择阻塞上游数据，在等待 Schema Change 操作执行完成后再解除阻塞，这个时候如果遇到一些数据量特别大的表时，往往会造成 Flink 上游数据积压；
2. 需要自己处理解析 SQL 语句、发起 Schema Change 及维护执行状态等操作；
3. 修改 Schema 后，需要同步修改 Flink 中 Schema 相关的参数并重启 Job。

而在 1.2.0 新版本实现 Light Schema Change 后，DDL 的同步就变得非常简易。利用 Flink CDC 的 DataStream API，可获取到上游业务数据库的 DDL 变更记录，在 Doris 对应数据表中开启 Light Schema Change，即可实现 DDL 自动同步。核心步骤如下：

1. 在 CDC Source 中开启 DDL 变更同步；
2. 在 Doris Sink 中对上游数据进行判断，识别 DDL 操作（add/drop column）并解析；
3. 对 Table 进行校验，判断是否可以进行 Light Schema Change 操作；
4. 对 Table 发起 Schema Change 操作。

Light Schema Change 可以保证 DDL 在毫秒级执行完成，避免了双写以及阻塞数据的问题；

同时 Flink Doris Connector 封装了序列化类 JsonDebeziumSchemaSerializer，在作业启动的时候，只需指定序列化方式即可，无需关心 Schema Change 的底层逻辑，以及无需重启 Job。

---

## 总结

通过 Light Schema Change，使得 Apache Doris 在面对上游数据表维度变化时，可以更加快速稳定实现表结构同步，保证系统的高效且平稳运转，具体体现在：

1. 执行效率提升明显，且存在导入任务时效率提升更为显著。Light Schema Change 无需对 Tablet 双写，无需等待导入任务完成。在相同集群下，相较于过去版本，Schema Change 效率从数秒或数分钟提升至数毫秒，极大幅度提升了执行效率。
2. 作业流程更加简单，加减列只需修改 FE 元数据，不需要与 BE 进行交互，实现同步返回，避免较长等待时间，以及因异步长时间执行而可能导致的误操作行为，提升了系统容错性和稳健性。
3. Flink CDC 结合 Light Schema Change 快速实时同步 DDL，有效解决了双写以及阻塞数据等问题，避免了增删列需要修改程序且需要停服重启的操作，实现 DDL 毫秒级快速同步，进一步提升了实时数仓数据处理和分析链路的时效性与便捷性。

---

> 参考链接：[Apache Doris Discussions #12134](https://github.com/apache/doris/discussions/12134)
