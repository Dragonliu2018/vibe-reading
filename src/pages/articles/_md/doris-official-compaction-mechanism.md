---
title: "【Doris全面解析】Doris Compaction机制解析"
source:
  type: "article"
  project: "Doris"
  url: "https://mp.weixin.qq.com/s/5D1gAOEiFWM7N6KPwqHHdw"
  author: "魏祚"
  site: "公众号 ApacheDoris"
date: "2026-07-24"
category: [Database, Apache Doris, Official]
tags: ["Doris", "Compaction", "LSM", "Rowset", "Cumulative Compaction", "Base Compaction"]
description: "Doris 通过 compaction 机制将不同数据版本聚合、小文件合并为大文件以提升查询性能；本文剖析 producer-consumer 模式、permission 机制、cumulative size_based 策略与 base compaction 流程。"
readingTime: "12 min"
aiModel: "Claude Opus 4.8"
reviewed: false
---

> **原文** [【Doris全面解析】Doris Compaction机制解析](https://mp.weixin.qq.com/s/5D1gAOEiFWM7N6KPwqHHdw) · **作者** 魏祚 · **来源** 公众号 ApacheDoris · **原文发布** 2021-02-25 · **转载** 2026-07-24

---

## 作者简介

**魏祚**
小米分布式存储工程师，负责 Apache Doris 的开发和运维，专注于分布式存储引擎的研发和优化。

---

## 导读

本文详细地介绍了 Doris 的 compaction 机制。

首先，从 producer-consumer 模式以及 compaction 任务提交的 permission 机制对 compaction 的总体设计和架构原理进行了剖析；然后，针对 cumulative compaction 的 size_based 策略进行了详细地介绍；最后，对 base compaction 的流程进行了深入地讲解。

Doris 通过 compaction 机制将不同的数据版本进行聚合，将小文件合并成大文件，进而有效地提升了查询性能。

---

## 1 引言

Doris 的存储引擎通过类似 LSM 的数据结构提供快速的数据导入支持。对于单一的数据分片（Tablet），新的数据先写入内存结构，随后刷入磁盘，形成一个个不可变更的数据文件，这些数据文件保存在一个 rowset 中。而 Doris 的 Compaction 机制主要负责根据一定的策略对这些 Rowset 进行合并，将小文件合并成大文件，进而提升查询性能。

每一个 rowset 都对应一个版本信息，表示当前 rowset 的版本范围，版本信息中包含了两个字段 first 和 second，first 表示当前 rowset 的起始版本（start version），second 表示当前 rowset 的结束版本（end version），如图 1-1 所示。每一次数据导入都会生成一个新的数据版本，保存在一个 rowset 中。未发生过 compaction 的 rowset 的版本信息中 first 字段和 second 字段相等；执行 compaction 时，相邻的多个 rowset 会进行合并，生成一个版本范围更大的 rowset，合并生成的 rowset 的版本信息会包含合并前的所有 rowset 的版本信息。

![图1-1 rowset版本](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-1-1-rowset-version.png)

Compaction 分为两种类型：base compaction 和 cumulative compaction。其中 cumulative compaction 则主要负责将多个最新导入的 rowset 合并成较大的 rowset，而 base compaction 会将 cumulative compaction 产生的 rowset 合入到 start version 为 0 的基线数据版本（Base Rowset）中，是一种开销较大的 compaction 操作。这两种 compaction 的边界通过 cumulative point 来确定。base compaction 会将 cumulative point 之前的所有 rowset 进行合并，cumulative compaction 会在 cumulative point 之后选择相邻的数个 rowset 进行合并，如图 1-2 所示。

![图1-2 compaction示意图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-1-2-compaction-overview.png)

---

## 2 总体架构

### 2.1 "生产者-消费者"模式

Compaction 机制要解决的第一个问题，就是如何选取合适的 Tablet 进行 Compaction。Doris 的 compaction 机制采用"生产者-消费者"（producer-consumer）模式，由 producer 线程持续生产 compaction 任务，并将生产出的 compaction 任务提交给 compaction 线程池进行消费执行，如图 2-1 所示。

![图2-1 compaction机制的"生产者-消费者"模式示意图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-2-1-producer-consumer.png)

Doris BE 启动时，会在后台启动一个 compaction producer 线程，同时会创建一个 compaction 线程池。producer 线程持续地生产 compaction 任务。

在一轮任务生产过程中，会从每个磁盘各选择出一个 tablet 执行 compaction 任务。如果 compaction 线程池中某个磁盘的 compaction 任务数达到了上限（通过 `compaction_task_num_per_disk` 配置，默认值为 2），则这一轮任务生产会跳过该磁盘。如果某一轮生产过程从所有磁盘均没有生产出 compaction 任务（即 compaction 线程池中每个磁盘的任务数都已达到上限），则 producer 线程会进入休眠状态，直到 2 秒超时唤醒，或线程池中某个 compaction 任务执行完成被唤醒。

在一轮 compaction 任务生产过程中，进行单个磁盘的任务生产时，需要遍历 BE 节点上所有的 tablet，首先过滤掉不满足条件的 tablet，比如：其他磁盘上的 tablet、已经提交给 compaction 线程池的 tablet、正在执行 alter 操作的 tablet、初始化失败的 tablet、上次 compaction 任务失败距离当前时刻的时间间隔小于设定阈值（通过 `min_compaction_failure_interval_sec` 配置，默认值为 600 秒）的 tablet，然后从剩余的满足条件的 tablet 中选择 tablet score 最高的 tablet 执行 compaction 任务。

**tablet score 通过如下公式计算：**

```text title="tablet score 计算公式"
tablet_score = k1 * scan_frequency + k2 * compaction_score
```

其中，k1 和 k2 分别可以通过参数 `compaction_tablet_scan_frequency_factor`（默认值为 0）和参数 `compaction_tablet_compaction_score_factor`（默认值为 1）动态配置。scan_frequency 表示 tablet 当前一段时间的 scan 频率。compaction score 的计算方法会在本文的后面进行详细地介绍。

可以通过参数 `generate_compaction_tasks_min_interval_ms` 动态配置任务生产的频率，默认值为 10ms，即每生产一轮 compaction 任务，producer 线程会休眠 10ms。

可以通过参数 `cumulative_compaction_rounds_for_each_base_compaction_round` 动态配置 cumulative compaction 和 base compaction 的生产周期，默认值为 9，即每生产 9 轮 cumulative compaction 任务，然后会生产 1 轮 base compaction 任务。

可以通过参数 `disable_auto_compaction` 动态配置是否关闭 compaction producer 的任务生产，默认值为 false，即不关闭 producer 的任务生产。

### 2.2 permission 机制

producer 生产出的 compaction 任务需要提交给 compaction 线程池执行。为了调节 BE 节点 compaction 的内存使用量，Doris 增加了对 compaction 任务提交的 permission 机制，如图 2-2 所示。系统维持一定数量的 compaction permits（通过参数 `total_permits_for_compaction_score` 配置），每一个 compaction 任务提交给线程池之前都需要向系统申请 permits（permits request），只有获得系统分配的 permits 之后任务才能被提交给 compaction 线程池，compaction 任务在线程池中执行结束之后需要将自己持有 permits 归还给系统（permits release）。如果系统当前剩余的可分配的 compaction permits 数量小于本次 compaction 任务需要的 permits 数量，则本次任务提交会被阻塞（compaction 任务提交是串行执行的，其他需要提交的任务也会被阻塞），直到有其他 compaction 任务执行结束并释放 permits，使得系统有足够数量的 permits 分配给当前 compaction 任务。如果某一个 compaction 任务需要的 permits 数量超过系统维持的 permits 总数，则允许当线程池中所有的任务都执行结束之后，将该 compaction 任务提交给线程池执行。

![图2-2 compaction任务提交的permission机制](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-2-2-permission-mechanism.png)

Doris 中单个 compaction 任务执行过程中的内存使用量与本次 compaction 任务合并的 segment 文件数量有关。一个 rowset 会包含多个 segment 文件，而一个 compaction 任务可能包含多个 rowset。因此，使用 compaction 任务中需要合并的 segment 文件数量作为 compaction 任务的 permits。通过调整系统维持的 compaction permits 总量可以对 BE 节点 compaction 的内存使用量进行调节。

Compaction 任务可以概括为两个阶段：compaction preparation 和 compaction execution，如图 2-3 所示。compaction preparation 阶段主要是从 tablet 中选出需要进行版本合并的 rowsets，compaction execution 阶段主要进行 rowsets 的版本合并操作。

![图2-3 compaction任务的两阶段划分示意图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-2-3-two-phase.png)

在 Doris 中，compaction 任务的 preparation 阶段在 permits request 之前执行，从 tablet 中选出需要进行版本合并的 rowsets，通过需要合并的 segment 文件数量计算 compaction permits。compaction 任务的 execution 阶段会真正在线程池中执行，进行版本的合并，如图 2-4 所示。

![图2-4 compaction任务的提交执行示意图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-2-4-submit-execute.png)

Compaction 任务提交到线程池之后，可能会在线程池的等待队列中等待较长的时间都没有被调度，当前 tablet 在这期间可能发生过 clone 操作，导致 compaction preparation 阶段选出的需要进行版本合并的 rowset 发生了改变，因此，在 compaction execution 阶段一开始需要判断任务等待调度期间 tablet 是否发生过 clone 操作，如果发生过 clone 操作，则本次 compaction 任务退出，否则，正常执行 rowsets 的合并。

Doris 也提供了 http 接口，支持手动触发单个 tablet 的 cumulative compaction 或 base compaction。

---

## 3 Cumulative Compaction

Doris 的 cumulative compaction 每次会在 cumulative point 之后选择相邻的数个 rowset 进行合并，主要包含 5 个步骤，分别是计算 cumulative point、生成 candidate rowsets、选择 input rowsets、执行 rowsets 合并以及更新 cumulative point，如图 3-1。其中，前面三个步骤属于 compaction preparation 阶段，后面两个步骤属于 compaction execution 阶段。

![图3-1 cumulative compaction执行流程图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-3-1-cumulative-flow.png)

目前可供选择的 cumulative compaction 策略有两种：num_based cumulative compaction 和 size_based cumulative compaction。cumulative compaction 的策略选择可以通过参数 `cumulative_compaction_policy` 进行配置（默认为 size_based）。num_based cumulative compaction 是基于 rowset 的文件数量进行 compaction 的选择，该策略会在后面的版本中被丢弃。size_based cumulative compaction 策略通过计算每个 rowset 的大小来决定 compaction 的选择，可以显著地减少写放大的系数。

下面将详细地对 size_based cumulative compaction 策略进行介绍。

### 3.1 计算 cumulative point

版本号比 cumulative point 小的 rowset 仅会执行 base compaction，而版本号比 cumulative point 大的 rowset 仅会执行 cumulative compaction。将一个 rowset 从 cumulative 侧移动到 base 侧（即增大 cumulative point）的行为称为一次 Promotion。

如果 tablet 当前的 cumulative point 值为 -1（初始值），则本次计算的 cumulative point 值不变，仍为 -1；否则，执行以下操作进行 cumulative point 的计算：

（1）对 tablet 下所有的 rowset 按照版本先后进行排序；

（2）Doris 会通过计算 promotion size 来决定是否要对一个 rowset 执行 Promotion。根据 base rowset（start version 为 0）的大小计算 tablet 当前的 promotion_size：

```text title="promotion size 计算公式"
promotion_size = base_rowset_size * ratio
```

其中，ratio 值可以通过 `cumulative_size_based_promotion_ratio` 配置，默认值为 0.05。promotion_size 被限定在 `cumulative_size_based_promotion_size_mbytes`（默认值为 1024MB）与 `cumulative_size_based_promotion_min_size_mbytes`（默认值为 64MB）之间，promotion size 的计算流程如图 3-2 所示。

![图3-2 promotion size的计算流程图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-3-2-promotion-size-flow.png)

（3）从 base rowset 开始，依次遍历每一个 rowset，当遇到以下情况，则停止遍历，更新 tablet 的 cumulative point：

a. 当前 rowset 与前一个 rowset 之间出现版本缺失，则更新 cumulative point 为前一个 rowset 的 end_version+1；

b. 当前 rowset 不是数据删除版本，同时当前 rowset 没有发生过版本合并，或当前 rowset 中的 segment 文件之间存在 overlapping，则更新 cumulative point 为当前 rowset 的 start_version；

c. 当前 rowset 不是数据删除版本，同时当前 rowset 的大小小于 promotion_size，则更新 cumulative point 为当前 rowset 的 start_version。

### 3.2 生成 candidate rowsets

依次遍历 tablet 中按照版本先后排序好的每一个 rowset，如果某一个 rowset 的版本位于 cumulative point 之后；并且该 rowset 的创建时间距离当前时刻超过设定的时间间隔（可以通过 `cumulative_compaction_skip_window_seconds` 配置，默认值为 30 秒），或者该 rowset 参与过版本合并（rowset 的 start_version 与 end_version 不相等），则将该 rowset 作为一个候选 rowset。将所有候选 rowset 依次保存在向量 candidate rowsets 中。

### 3.3 选择 input rowsets

（1）寻找 candidate rowsets 中最大的连续版本序列。

遍历 candidate rowsets 中的每一个 rowset，如果某两个相邻的 rowset 之间出现版本缺失，则将 candidate rowsets 中第一个缺失版本之前的所有 rowset 作为新的 candidate rowsets；

（2）生成 input rowsets。

遍历 candidate rowsets 中的每一个 rowset，将访问完成的 rowset 保存在向量 input rowsets 中，当遇到以下情况，遍历结束：

a. 某一个 rowset 为数据删除版本（并使用 last_delete_version 记录当前数据删除版本，last_delete_version 初始值为 -1），并且 input rowsets 中的 rowset 数量不为 0（如果 input rowsets 中的 rowset 数量为 0，则跳过当前 rowset，继续访问下一个 rowset）；

b. input rowsets 中的 rowset score（表示 rowset 中的 segment 文件数目）之和达到上限阈值（通过 `max_cumulative_compaction_num_singleton_deltas` 配置，默认值为 1000）；

c. 遍历过程正常完成，input rowsets 中包含了 candidate rowsets 中所有的 rowset。

（3）调整 input rowsets。

a. 如果 input rowsets 中所有的 rowset 大小之和达到 promotion_size，则不需要调整 input rowsets。

b. 如果存在数据删除版本的记录（last_delete_version 不为 -1，即生成 input rowsets 的遍历过程因为存在删除数据版本而结束），并且 input rowsets 中的 rowset 数量不为 1，则不需要调整 input rowsets；如果存在数据删除版本的记录，并且 input rowsets 中的 rowset 数量为 1，同时该 rowset 中的 segment 文件之间存在 overlapping，则不需要调整 input rowsets；如果存在数据删除版本的记录，并且 input rowsets 中的 rowset 数量为 1，同时该 rowset 中的 segment 文件之间不存在 overlapping，则清空 input rowsets。

c. 如果不存在数据删除版本的记录（last_delete_version 为 -1），则遍历 input rowsets 中的 rowset。从第一个 rowset 开始，计算当前 rowset 的大小等级（current_level），同时计算 input rowsets 中除当前 rowset 之外的其他 rowset 大小之和的等级（remain_level），如果 current_level > remain_level，则从 input rowsets 中删除当前 rowset，否则，停止遍历。

**【注】** level 等级划分由参数 `cumulative_size_based_promotion_size_mbytes`（默认值为 1024MB）和 `cumulative_size_based_compaction_lower_size_mbytes`（默认值为 64MB）确定。最高的 level 值为 `cumulative_size_based_promotion_size_mbytes` / 2，下一级 level 值为上一级 level 值的 1/2，直到 level 值小于 `cumulative_size_based_compaction_lower_size_mbytes`，则设置该级 level 值为 0，level 等级划分流程如图 3-3 所示。

![图3-3 level等级划分流程图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-3-3-level-division.png)

计算某一个 rowset 的 level 值时，如果 level[n-1] > rowset_size >= level[n]，则该 rowset 的 level 值为 level[n]。

### 3.4 执行 rowsets 合并

将 input rowsets 中的所有 rowset 进行合并，生成一个 output rowset。在执行 rowsets 合并时，会创建一个 Reader 和一个 Rowset Writer，Rowset Writer 与 output rowset 相对应。

在 Reader 底层逻辑中，input rowsets 中的每一个 rowset 都会对应一个 Rowset Reader。Reader 按照 key 的排序规则逐行读出 input rowsets 中的数据，然后通过 Rowset Writer 写入 output rowset。aggregation key 数据模型和 unique key 数据模型中，key 相同但分散在不同 Rowset 中的数据行会在 rowsets 合并后完成聚合。cumulative compaction 不会将 delete 操作删除的数据行进行真正地删除，这部分工作会在 base compaction 中进行。

### 3.5 更新 cumulative point

cumulative compaction 执行结束之后，需要更新 cumulative point。

（1）如果存在数据删除版本的记录（last_delete_version 不为 -1，即生成 input rowsets 的遍历过程因为存在删除数据版本而结束），则更新 cumulative point 为 output_rowset 的 end_version+1；

（2）如果不存在数据删除版本的记录（last_delete_version 为 -1），判断 output rowset 的大小是否超过 promotion_size，如果超过，则更新 cumulative point 为 output_rowset 的 end_version+1，否则，不更新 cumulative point。

**【注】** cumulative compaction 执行之前需要计算一次 cumulative point，因为上一次 cumulative compaction 之后可能发生过 base compaction，base rowset 发生了变化，因此，promotion size 发生了变化，cumulative point 也会变化。cumulative compaction 执行之前计算 cumulative point，是为了确定本次 cumulative compaction 的边界；cumulative compaction 执行之后更新 cumulative point，是为了确定下一次可能发生的 base compaction 的边界。

### 3.6 计算 cumulative compaction score

在 compaction producer 线程中，需要依据 cumulative compaction score 生产 cumulative compaction 任务。依次遍历 tablet 中的所有 rowset，如果某一个 rowset 的版本位于 cumulative point 之后，则将该 rowset 添加到向量 rowset_to_compact。

（1）如果 rowset_to_compact 中所有 rowset 的大小之和超过 promotion_size，则 rowset_to_compact 中所有 rowset 的 score 之和为当前 tablet 的 cumulative compaction score，即 rowset_to_compact 中所有 rowset 的 segment 文件数目之和。

（2）如果 rowset_to_compact 中所有 rowset 的大小之和小于 promotion_size，则按照版本先后对 rowset_to_compact 中的 rowset 进行排序，然后遍历 rowset_to_compact 中的每一个 rowset。计算当前 rowset 的大小等级（current_level），同时计算 rowset_to_compact 中除当前 rowset 之外的其他 rowset 大小之和的等级（remain_level），如果 current_level > remain_level，则从向量 rowset_to_compact 中删除当前 rowset，否则，停止遍历。rowset_to_compact 中所有 rowset 的 score 之和为当前 tablet 的 cumulative compaction score。

---

## 4 Base Compaction

Doris 的 base compaction 会将 cumulative point 之前的所有 rowset 进行合并，主要包含 3 个步骤，分别是选择 input rowsets、检查 base compaction 的执行条件以及执行 rowsets 合并，如图 4-1 所示。其中，前面两个步骤属于 compaction preparation 阶段，最后一个步骤属于 compaction execution 阶段。

![图4-1 base compaction执行流程图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-4-1-base-flow.png)

### 4.1 选择 input rowsets

（1）选择 input rowsets。依次遍历 tablet 中的每一个 rowset，获取所有版本位于 cumulative point 之前的 rowset 作为 input rowsets。

（2）对 input rowsets 中的所有 rowset 按照版本先后进行排序。

### 4.2 检查 base compaction 的执行条件

依次检查以下条件（如图 4-2 所示）：

（1）版本连续性条件

遍历 input rowsets，判断是否有相邻的两个 rowset 之间存在版本缺失，如果存在版本缺失，则当前 tablet 不满足 base compaction 的执行条件，本次 base compaction 任务结束；否则，检查下一个条件。

（2）rowset overlapping 条件

遍历 input rowsets，如果有 rowset 中不同 segment 文件之间存在 overlapping，则当前 tablet 不满足 base compaction 的执行条件，本次 base compaction 任务结束；否则，检查下一个条件。

（3）base rowset 条件

如果 input rowsets 中只有两个 rowset，并且 base rowset（start version 为 0）的 end version 为 1，则当前 tablet 不满足 base compaction 的执行条件，本次 base compaction 任务结束；否则，检查下一个条件。

（4）rowset 的数量条件

如果 input rowsets 中 rowset 的数量超过设定的阈值（通过 `base_compaction_num_cumulative_deltas` 配置，默认值为 5），则当前 tablet 满足 base compaction 的执行条件；否则，检查下一个条件。

（5）rowset size 条件

如果 input rowsets 中除 base rowset（start version 为 0）之外的其他 rowset 大小之和与 base rowset 大小之比超过设定的阈值（通过 `base_cumulative_delta_ratio` 配置，默认值为 0.3），则当前 tablet 满足 base compaction 的执行条件；否则，检查下一个条件。

（6）时间条件

如果当前 tablet 上一次成功执行 base compaction 的时间距离当前时刻超过指定的时间间隔（通过 `base_compaction_interval_seconds_since_last_operation` 配置，默认值为 86400 秒，即 1 天），则当前 tablet 满足 base compaction 的执行条件；否则，当前 tablet 不满足 base compaction 的执行条件，本次 base compaction 任务结束。

![图4-2 检查base compaction执行条件的流程图](/vibe-reading/images/articles/doris-official-compaction-mechanism/fig-4-2-check-conditions.png)

### 4.3 执行 rowsets 合并

将 input rowsets 中的所有 rowset 进行合并，生成一个 output rowset。与 cumulative compaction 过程中执行 rowsets 合并的流程相同，不再赘述。值得一提的是，base compaction 过程中会将 delete 操作删除的数据行真正地删除。

### 4.4 计算 base compaction score

在 compaction producer 线程中，需要依据 base compaction score 生产 base compaction 任务。依次遍历 tablet 中的每一个 rowset，所有位于 cumulative point 之前的 rowset 的 score 之和为 tablet 当前的 base compaction score，即 cumulative point 之前的 rowset 中的 segment 文件数目之和。

---

## 5 总结

本文详细地介绍了 Doris 的 compaction 机制。

首先，从 producer-consumer 模式以及 compaction 任务提交的 permission 机制对 compaction 的总体设计和架构原理进行了剖析；然后，针对 cumulative compaction 的 size_based 策略进行了详细地介绍；最后，对 base compaction 的流程进行了深入地讲解。

Doris 通过 compaction 机制将不同的数据版本进行聚合，将小文件合并成大文件，进而有效地提升了查询性能。

---

## 【TODO】

目前在 compaction 的 producer 逻辑中，每次都会遍历所有的 tablet 来选取合适的 compaction 对象，这会带来一些不必要的系统开销。因为大多数 tablet 的版本信息并不会频繁变化，没有必要每次都重新计算。后续我们也会针对这一问题进行优化。
