---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "FORK 快照与 Change Stream"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "Copy-on-Write", "redo 解析", "Agent 沙箱", "异步索引"]
description: "FORK DATABASE/TABLE 的内核级 COW（SSTable 元数据克隆 + 宏块零拷贝共享）、MERGE TABLE 三策略、Change Stream 的 redo 零拷贝行插件框架与 async 向量索引——Agent 沙箱与写路径解耦的两大特色机制"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

这两个机制是 seekdb 区别于通用向量数据库的招牌能力，服务于同一类用户——Agent。**FORK** 回答「Agent 需要试探性修改数据，怎么给一个秒级创建、可丢弃、可合并的沙箱」：内核级 Copy-on-Write，`FORK DATABASE agent_state TO sandbox_42` 亚秒完成不复制数据，Agent 在沙箱里随便折腾，成功则 `MERGE TABLE ... STRATEGY THEIRS` 合回主线，失败 `DROP DATABASE` 扔掉。**Change Stream** 回答「写路径怎么不被索引构建拖垮」：独立管道在后台异步消费 redo log，把向量写进内存 delta 索引——写入和索引构建物理上完全解耦（官方博客：v1.2.0 旧架构 69 QPS / P99 410ms，重写后 QPS ×22、P99 降至 1/19）。代码分布在 `src/rootserver/fork_table/`（服务与任务）、`src/storage/ddl/ob_tablet_fork_task.{h,cpp}`（tablet 级 DAG）、`src/observer/change_stream/`（10 文件的 redo 消费框架）。

## 模块架构

```shell
FORK 侧：
├── src/sql/parser/sql_parser_mysql_mode.y
│   ├── fork_table_stmt (:4400)     FORK TABLE r1 TO r2        → T_FORK_TABLE
│   ├── fork_database_stmt (:4407)  FORK DATABASE d1 TO d2    → T_FORK_DATABASE
│   ├── diff_table_stmt (:4420)      DIFF TABLE r1 AGAINST r2  → T_DIFF_TABLE
│   └── merge_table_stmt (:4433)     MERGE TABLE src INTO dst STRATEGY FAIL(0)/THEIRS/OURS → T_MERGE_TABLE
├── src/rootserver/fork_table/
│   ├── ob_fork_table_task.h         ObForkTableTask : ObDDLTask（:35）
│   ├── ob_fork_table_helper.{h,cpp} ObForkTableHelper——注释自白"reduce intrusion into create_tables_in_trans"
│   ├── ob_fork_database_service.cpp（23.3K）/ ob_fork_table_service.cpp / ob_fork_table_util.cpp
│   └── ob_fork_table_info_builder.h
└── src/storage/ddl/
    ├── ob_table_fork_info.h         ObTableForkInfo（OB_UNIS 序列化：fork_snapshot_version/源与目标 tablet ids）
    └── ob_tablet_fork_task.h        ObTabletForkPrepareTask + ObTabletForkReuseTask : share::ObITask（:217）

Change Stream 侧（src/observer/change_stream/）：
├── ob_change_stream_plugin.h       ObCSPlugin（init/process/commit 三虚方法）+ ObCSPluginRegistry
│                                    CS_PLUGIN_TYPE { CS_PLUGIN_ASYNC_INDEX = 0, MAX_TYPE }（扩展开位）
├── ob_change_stream_fetcher.{h,cpp} 从 redo（palf 迭代器）拉取事务日志；min_dep_lsn/refresh_scn 推进；
│                                    IDLE 态（无 async 索引表）10s 睡眠兜底，schema version 变化唤醒
├── ob_change_stream_dispatcher.h    ObCSRow（零拷贝行事件）+ 分发；ObCSTxInfo 环形缓冲
├── ob_change_stream_worker / mgr     消费工作线程与管理器
└── ob_cs_plugin_async_index.{h,cpp}  唯一插件：向量索引异步维护（ObASyncIndexEvent/ObCSAsyncIndexProcessor）
```

## 调用链路

### FORK：一次 `FORK DATABASE a TO b` 的旅程

```
T_FORK_DATABASE → resolver → ObForkTableTask : ObDDLTask（rootserver/fork_table/）
├─ 取 fork_snapshot_version（一致性时间点）
└─ 每对 tablet 提交 DAG：
   ObTabletForkPrepareTask
   ├─ ObTabletForkUtil::get_participants(table_store_iterator_, fork_snapshot_version, sstables)
   │    （ob_tablet_fork_task.cpp:485/587——只挑 end_scn/upper_trans_version ≤ 快照版本的 SSTable）
   └─ ObTabletForkReuseTask（每个参与 SSTable 一个）
      └─ process_reuse_sstable()（ob_tablet_fork_task.cpp:841）
         ├─ ObSSTableCloneParam（blocksstable/ob_sstable_meta.h:328）：
         │    basic_meta_ + column_checksums_ + root_block_addr_ + data_block_macro_meta_addr_ + is_meta_root_
         ├─ ObTabletCreateSstableParam::init_for_fork(clone_param, dst_tablet_id, src_table_key, ...) 
         │    （tablet/ob_tablet_create_sstable_param.h:119——目标 tablet 重建 SSTable 元数据）
         └─ ★ 数据宏块不复制——两个表共享同一批物理宏块；此后 memtable/merge 各自独立演进（COW 生效）
MERGE TABLE sandbox.t INTO main.t STRATEGY THEIRS   # 试探成功合回
DROP DATABASE sandbox                                  # 试探失败丢弃（宏块引用计数回收）
```

物理机制的核心是 `ObSSTableCloneParam` 携带 `root_block_addr_`/`data_block_macro_meta_addr_`（索引块地址与数据块元地址）与列校验和——目标 tablet 只重建**SSTable 元数据**，`init_for_fork` 的两个重载（基本元数据版与 clone 参数版）都不触碰数据块。`ObTablet::inc_macro_ref_cnt()` 的宏块引用计数保证一方 DROP 后另一方数据仍存活。fork 出的表带原表的全部索引形态（向量/FTS 隐藏表一并 fork），`check_has_async_vector_index()`（`ob_fork_table_helper.h`）专门处理带 async 向量索引的表——async 索引的内存态在 fork 后需要特殊初始化。

### Change Stream：redo 行 → 向量索引

```
ObChangeStreamFetcher（palf 迭代器拉事务日志，ObCSTxInfo 环形缓冲）
└─ ObChangeStreamDispatcher → ObCSRow（零拷贝：new_row_/old_row_ 直接指向 redo 缓冲，"pointers
     into the redo buffer, valid until release_batch pops the ring buffer entry"）
   struct ObCSRow { tablet_id_, commit_version_, dml_flag_, heap_pk_（__pk_increment 提取）,
                    new_row_, old_row_, seq_no_, column_cnt_ }   # heap 表隐藏 PK 即行号
└─ ObCSPluginRegistry 分发 → ObCSPluginAsyncIndex（thin plugin，只实现基类三接口）
   └─ ObCSAsyncIndexProcessor
      ├─ resolve_vector_index_info_(table_id, ...)     # ObCSVecIndexInfo：per-table 索引元数据缓存
      ├─ extract_vector_data_(new_row, ...)            # 从行提取向量
      ├─ 事件: ObASyncIndexEvent{ tablet_id_, table_id_, commit_version_, scn_, vid_, type_('I'/'D'),
      │         vec_data_, vec_data_len_, part_key_datums_ }   # 解析一行 redo 产出一个增量事件
      └─ insert_vector_index_log_batch_(events, ...)   # 批量灌进向量索引（delta HNSW）
```

fetcher 的节流常量族（`ob_change_stream_fetcher.h:49-68`）：min_dep_lsn/refresh_scn 向 global_stat 推进的间隔、schema version 检查间隔（**只在 DDL 版本变化时才调 `check_has_async_index_tables_()`，10ms 检查近乎免费**）、IDLE 态条件等待 10s 兜底、追上后（`OB_ITER_END`）的睡眠。`ObCSPlugin` 的扩展契约极小：`init()/process(rows, ctx)/commit()` 三个方法 + `CS_PLUGIN_TYPE` 注册——目前唯一插件是 `CS_PLUGIN_ASYNC_INDEX`，`CS_PLUGIN_MAX_TYPE` 就是给未来插件（如 CDC 导出）留的扩展位。

## 核心实现

### FORK 为什么能「秒级、不复制数据」

LSM 的不可变 SSTable 天生适合 COW：fork 只需在目标 tablet 复制**元数据**（SSTable 头 + 索引块地址 + 校验和），数据宏块物理共享。写入分歧由 LSM 免费提供——双方各自的新写入进各自 memtable → 各自 minor/major merge，merge 只重写自己产生的新宏块，共享宏块在引用计数归零前不动。这正是「内核级 COW vs 应用层 snapshot/restore」的差距：应用层要么全量拷贝（分钟级），要么逻辑 diff 重放（复杂且慢）；内核层 fork 的成本 = 每个 tablet 复制几百字节元数据。`DIFF TABLE r1 AGAINST r2`（`T_DIFF_TABLE`）配合 MERGE 提供沙箱与主线的差异检查。`ObForkTableHelper` 的存在理由写在注释里——"encapsulates fork table logic to **reduce intrusion into create_tables_in_trans**"：fork 复用建表事务路径，helper 把 fork 特有逻辑收拢避免污染通用代码。

### async HNSW：写路径解耦的另一半

同步路径（默认）：DML 事务内同步插内存 inc 索引（读己之写），落盘 delta buffer 行置 null（见[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)）。**声明了 async 索引的表把增量维护整体搬到 Change Stream**：写入事务只保证数据表行 + redo 落盘即返回，向量进索引的时延由 fetcher 的拉取节奏决定——这就是官方博客「写入路径不碰索引」的字面实现。两条路径的选择由 DDL 的 async 参数与 `check_has_async_vector_index()` 判定；查询侧无需感知（delta buffer 兜底 + SCN 检查保证正确性不依赖刷新时序）。设计上的对称美：**同步路径保读己之写（适合交互），async 路径保写吞吐（适合 streaming workload）**——Agent 记忆这种「持续写入 + 毫秒后检索」的负载正是后者的目标场景。

### ObCSRow 的零拷贝契约

`ObCSRow` 的 `new_row_/old_row_` 是**指向 redo 缓冲的指针**，生命周期注释明确："valid until release_batch pops the ring buffer entry"——插件在 `process()` 批处理内消费完，`commit()` 后环形缓冲槽位才可复用。`heap_pk_`（`__pk_increment`）在 mut_row 尚存活时提取——heap 表的隐藏 PK 在这里成为 Change Stream 的行标识，与域索引的 rowid 锚点形成闭环（heap 表三重价值的第三重）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 元数据级 COW | `ObSSTableCloneParam` + 宏块引用计数 | fork 成本与数据量解耦（亚秒 vs 分钟）；LSM 不可变性是免费基础 |
| 插件 + 注册表 | `ObCSPlugin`/`ObCSPluginRegistry` + `CS_PLUGIN_TYPE` | redo 消费逻辑可插拔（async index 只是第一个），框架不知道消费者是谁 |
| 零拷贝 + 环形缓冲 | `ObCSRow` → `ObCSTxInfo` ring buffer | redo 消费不复制行数据，背压由槽位复用天然提供 |
| helper 收拢（防侵入） | `ObForkTableHelper` | fork 复用建表事务路径而不污染通用建表代码 |
| 门控唤醒 | fetcher 的 IDLE 态 + schema version 检查 | 无 async 表时框架几乎零开销；DDL 变化即时唤醒 |

## 模块间交互

FORK 依赖：rootserver 的 `ObDDLScheduler`（fork 是 DDL 任务）、storage 的 tablet/table_store（参与者选择与 SSTable 克隆）、schema 服务（目标表 schema 构建 `ob_fork_table_info_builder`）。Change Stream 依赖：logservice 的 palf 迭代器（`ObILogStorage`/`palf_iterator`）、tx 的 `ObTxSEQ`/`ObTransDefine`（事务号与 DML 语义）、memtable 的 `ObRowData`（行表示）；其唯一插件消费[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)的运行时接口（`ObDASInsertOp` 写 log 批）。两机制互相独立但场景互补：Agent 在 fork 沙箱里的写入同样产生 redo，async 索引消费照常工作——沙箱是完整可写的数据库。

## 扩展方式

新增一个 Change Stream 插件（如「CDC 导出」）：① `ob_change_stream_dispatcher.h` 的 `CS_PLUGIN_TYPE` 加类型（同步更新 `ob_change_stream_plugin.h` 的 `CS_PLUGIN_MAX_TYPE` 与 dispatcher 的 `CS_MAX_PLUGIN_COUNT`——两处常量必须相等，注释明示）；② 新建 `ob_cs_plugin_xxx.{h,cpp}` 实现 `ObCSPlugin` 的 `init/process/commit` 三方法；③ `ObCSPluginRegistry` 注册（构造时 `plugin_type_`）；④ fetcher 侧无需改动——它按表元数据判断有无可消费插件（`check_has_async_index_tables_()` 的模式可扩为按插件类型检查）。给 MERGE 加第四种策略：`merge_table_stmt` 产生式加分支 → `T_MERGE_TABLE` 的 strategy value_ 扩号 → rootserver 的 fork_table merge 实现加冲突解决分支（现有 FAIL/THEIRS/OURS 的 value 0/1/2 顺延）。
