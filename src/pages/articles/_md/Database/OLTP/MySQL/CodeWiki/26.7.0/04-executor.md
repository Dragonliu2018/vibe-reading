---
source:
  type: "源码解读"
  project: "mysql-server"
  url: "https://github.com/mysql/mysql-server"
title: "执行器"
date: "2026-09-20T15:47:40+08:00"
category: [Database, OLTP, MySQL, CodeWiki, "26.7.0"]
contentType: "CodeWiki"
tags: ["MySQL", "C++", "火山模型", "RowIterator", "拉取执行"]
description: "RowIterator 火山执行器、CreateIteratorFromAccessPath 转换、Init/Read 拉取循环、算子族与执行反馈的源码解读"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview)

---

## 模块定位

执行器把优化器产出的 `AccessPath` 树翻译成可拉取的 `RowIterator` 算子树，并用统一的 Init/Read 循环驱动所有查询形态（SELECT/UNION/DML/窗口/递归 CTE）。它独立成模块的理由：**计划搜索与计划执行的关注点彻底分离**——规划期要在 MEM_ROOT 上廉价地创建/丢弃海量候选路径（轻对象 AccessPath），执行期需要重得多的算子（缓冲、锁、PFS 计时），两个生命周期不同就不该是同一类对象。同一棵 AccessPath 树还服务 EXPLAIN 与 EXPLAIN ANALYZE（`AccessPath::iterator` 回填指针），计划与执行双向可追溯。

涉及文件：`sql/iterators/`（全部算子）、`sql/join_optimizer/access_path.cc`（转换器）、`sql/sql_union.cc`（执行循环）、`sql/query_result.*`（结果汇）、`sql/sql_executor.cc`（老执行路径辅助）。

## 模块架构

```text
AccessPath 树（优化器产出，45 种类型）
  │ CreateIteratorFromAccessPath (access_path.cc:686)   # 迭代式栈展开，非递归
  ▼
RowIterator 算子树（火山模型）
  ├── 基表算子:  TableScan / IndexScan / Ref / IndexRange / DynamicRange
  ├── 连接算子:  NestedLoop / HashJoin / BKA_JOIN
  ├── 复合算子:  Filter / LimitOffset / Aggregate / Weedout / Append /
  │              Materialize / Sorting / Window / StreamingWindow
  └── 修改算子:  UpdateRows / DeleteRows（封装在 DML 语句的写路径）
  │
  ▼ ExecuteIteratorQuery (sql_union.cc:1068): Init 一次 + Read 循环
  ▼ Query_result::send_data（每行）→ Protocol 编码 → 客户端
```

## 调用链路

一条 SELECT 的执行数据流（与[概览的 query-flow.svg](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/00-overview) 对照）：

```text
Query_expression::execute (sql_union.cc:1211)
└─ ExecuteIteratorQuery (sql_union.cc:1068)
   ├─ query_result->start_execution(...) → send_result_set_metadata(...)  # 列定义先行
   ├─ m_root_iterator->Init()                            # 递归初始化整棵树
   ├─ PFSBatchMode pfs_batch_mode(m_root_iterator.get()) # 批模式降低插桩开销
   ├─ for (;;) { int error = m_root_iterator->Read();    # 拉一行
   │    error>0 → 致命错误;  error<0 → EOF;  thd->killed → 终止
   │    query_result->send_data(thd, *fields); }         # 行编码发送
   ├─ join_cleanup scope guard：逐 Query_block 调 join->join_free() 并把
   │    join->examined_rows 累入 thd->inc_examined_row_count（先于 send_eof）
   └─ query_result->send_eof(...)
```

一个历史包袱的细节：`send_records_ptr` 的取值分三种情况——`is_simple()` 时取 `&first_query_block()->join->send_records`（`LimitOffsetIterator` 会把 OFFSET 跳过的行也写进 JOIN 的 send_records）、物化 set operation 时取 `query_term()->query_block()->join->send_records`、否则取 `Query_expression::send_records`。循环结束后 `thd->current_found_rows = *send_records_ptr`——这是 `SQL_CALC_FOUND_ROWS` 兼容逻辑仍在执行的证据（注释明言"当我们移除 SQL_CALC_FOUND_ROWS 后可换局部变量"）。

最底层的基表算子（以全表扫描为例）：

```text
TableScanIterator::DoInit (sql/iterators/basic_row_iterators.cc:252)
├─ empty_record(table()) + table()->file->ha_rnd_init(true)
└─ 仅 first_init（!file->inited）时 set_record_buffer(table(), m_expected_rows)   # 按预期行数预分配

TableScanIterator::DoRead (basic_row_iterators.cc:276)
├─ table()->file->ha_rnd_next(m_record)      # handler 包装（sql/handler.cc:3111）
│    ├─ MYSQL_TABLE_IO_WAIT(PSI_TABLE_FETCH_ROW, ...)   # PFS 表 IO 插桩
│    ├─ rnd_next(buf)                        # 引擎虚方法
│    │    └─ ha_innobase::rnd_next (ha_innodb.cc:11104) → general_fetch → row_search_mvcc
│    └─ update_generated_read_fields(...)    # 生成列求值
├─ HA_ERR_RECORD_DELETED 且 !thd()->killed 时 continue 重试     # MyISAM 无锁读写场景
└─ INTERSECT/EXCEPT 的集合算术：table()->set_counter()->val_int() 过滤
     （EXCEPT DISTINCT cnt>=1 出一行 / INTERSECT DISTINCT cnt==0 跳过 / ALL 用计数器取 min）
```

`handler::ha_rnd_next` 包装的三个前置动作（`sql/handler.cc:3111`）：断言 `inited == RND`、按 `table->has_gcol()` 置 `m_update_generated_read_fields` 标志、结果写回前 `set_row_status_from_handler(result)`——引擎实现里因此不会有重复的计时代码。

方法速查：

<details>
<summary>执行器方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `CreateIteratorFromAccessPath` in `access_path.cc:686` | AccessPath→iterator 树 | 显式 MEM_ROOT 栈替代递归，防深计划炸栈 |
| `ExecuteIteratorQuery` in `sql_union.cc:1068` | 顶层拉取循环 | `send_records` 兼容 SQL_CALC_FOUND_ROWS |
| `RowIterator::Init/Read` in `row_iterator.h:82` | 算子契约 | `DoInit/DoRead` 模板方法：Init 幂等可重放 |
| `TimingIterator` in `timing_iterator.h:159` | EXPLAIN ANALYZE 计时包装 | debug 编译下自动包裹算子 |
| `Query_result::send_data` in `query_result.h:60` | 行汇抽象 | send 流/写文件/物化临时表同一接口 |

</details>

## 核心实现

### RowIterator 契约与"重放"语义

```cpp
class RowIterator {                       // sql/iterators/row_iterator.h:82
 public:
  virtual bool Init() = 0;                // 定位到起点（可反复调用）
  virtual int Read() = 0;                 // 0=一行就绪 / -1=EOF / >0=错误
  ...
};
```

`Init` 必须幂等——嵌套循环的内表算子每轮外层行都要重新 Init，物化/窗口等有状态的算子靠"Init 重放"而非重建来复用。这让同一棵树可以出现在多种计划形态里而不泄漏状态。基类还自动维护三个计数器（`Read()` 中 `++m_num_rows`、`--1` 时 `++m_num_full_reads`，`Init()` 中 `++m_num_init_calls`——EXPLAIN ANALYZE 的统计底座），并提供 `SetNullRowFlag`（外连接 NULL 补行）——它设计为**可以在未 Init 的算子上调用**：嵌套循环外层立即 EOF 时内侧算子从未 Init，但外层仍需要给内侧打 NULL 行标志。`TimingIterator`（`timing_iterator.h:159`）在 EXPLAIN ANALYZE 下用模板自动包裹所有算子做逐算子计时，是 EXPLAIN ANALYZE 数据的来源——**计划树上每个节点的真实耗时**由此可回填到对应 AccessPath。

### CreateIteratorFromAccessPath：迭代式展开

```cpp
unique_ptr_destroy_only<RowIterator> CreateIteratorFromAccessPath(...) {
  Mem_root_array<IteratorToBeCreated> todo(mem_root);
  todo.push_back({top_path, top_join, ...});
  while (!todo.empty()) {                 // access_path.cc:686 起的主循环
    IteratorToBeCreated job = todo.back(); todo.pop_back();
    switch (path->type) {
      case AccessPath::TABLE_SCAN:
        iterator = NewIterator<TableScanIterator>(...); break;
      case AccessPath::INDEX_SCAN:
        iterator = param.reverse ? NewIterator<IndexScanIterator<true>>(...)
                                  : NewIterator<IndexScanIterator<false>>(...); break;
      ...
```

头注释解释了为什么不用递归：access path 树可以很深、某些编译器栈帧很大，显式 MEM_ROOT 栈用少量内存换大幅降低栈占用。子节点先入栈、父节点 re-push 自己等子节点实例化后再构造（经典的延迟求值模式）；**子迭代器的输出指针写进父任务预先在 MEM_ROOT 上分配的 `job.children` 数组**——因为 todo 数组扩容会移动元素，children 必须直接分配在 MEM_ROOT 上才能保证指针不失效（头注释专门解释这一点）。

`NewIterator<T>` 工厂同时决定是否包计时装饰器：`thd->lex->is_explain_analyze` 为真时返回 `TimingIterator<T>` 而非裸 `T`（`sql/iterators/timing_iterator.h`）。`TimingIterator::DoInit/DoRead` 分别累计 Init 调用次数（`m_num_init_calls`）、首行时间（`m_elapsed_first_row`）与其余行时间（`m_elapsed_other_rows`）——这正是 EXPLAIN ANALYZE 输出里每个算子的 actual time/rows 数据来源。

### 算子族速览

| 文件 | 算子 | 要点 |
| --- | --- | --- |
| `basic_row_iterators.cc` | `TableScanIterator`（`:58` in .h）、`IndexScanIterator`、`ZeroRowsIterator`、`FakeSingleRowIterator` | 直接调 `ha_rnd_next/ha_index_next`；record buffer（`set_record_buffer`）按预期行数预分配减少 handler 往返 |
| `ref_row_iterators.cc` | `RefIterator`（`:48`） | 索引等值/前缀查找，配合外层行参数化重定位 |
| `hash_join_iterator.cc` | `HashJoinIterator`（`:265`） | 8.0.18 起的默认等值连接；`hash_join_chunk.cc` 溢写磁盘分片 |
| `composite_iterators.cc` | `FilterIterator`（`:82`）、`LimitOffsetIterator`（`:111`）、`AggregateIterator`（`:208`）、`NestedLoopIterator`（`:332`）、`WeedoutIterator`（`:669`，semijoin 去重）、`AppendIterator`（`:865`，UNION 流式）、`MaterializeIterator`（`:1310` in .cc，物化含子查询/derived） | 组合算子大本营；`SortingIterator` 在 `sorting_iterator.cc:58` |
| `window_iterators.cc` | `WindowIterator`（`:94`）、`BufferingWindowIterator`（`:203`） | 窗口函数分 streaming（按序复用）与 buffering（全缓冲分区）两型 |
| `bka_iterator.cc` | `BkaIterator` | BKA JOIN 的批量 key 查找缓冲 |

**为什么 45 种 AccessPath 映射出约 20 个 iterator 类**：部分 AccessPath（如 `ZERO_ROWS` 系、`ALTERNATIVE`）在转换期就被折叠或共享实现；反向地 `IndexScanIterator<reverse>` 一个模板对应正反两个语义。

### 结果汇与 DML 执行

`Query_result`（`sql/query_result.h:60`）抽象"行送到哪"，三个纯虚函数是 `send_result_set_metadata/send_data/send_eof`。子类：`Query_result_send`（`:201`，网络流）、`Query_result_to_file`（SELECT INTO OUTFILE）、`Query_result_interceptor`（拦截转换行——其 `send_result_set_metadata` 直接返回 false 不向客户端发送）、物化目标（UNION 临时表、INSERT ... SELECT 的目的表）。DML 的执行也在 iterator 体系内：UPDATE/DELETE 把 SELECT 部分做成 iterator 树，行经 `UpdateRowsIterator`/`DeleteRowsIterator`（`sql/iterators/update_rows_iterator.h`）写回 handler，row 格式 binlog 的行镜像在写路径上采集（见[复制模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/08-replication)）。

### PFS 批模式

`PFSBatchMode`（`ExecuteIteratorQuery` 内的栈对象）：行数大时把逐行插桩切换为按"批"计（`pfs_batch_mode.h`），thread 私有的 switches 计数器被豁免——这是 Performance Schema 高吞吐查询场景的关键开关，也解释了为什么基表算子的 `ha_rnd_next` 包装里的 `MYSQL_TABLE_IO_WAIT` 在批模式下近似免费。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 火山/迭代器 | `RowIterator::Init/Read` | 拉模型让流式与物化统一组合，内存占用由算子自决 |
| 模板方法 | `DoInit/DoRead` + 基类缓存 | 公共状态（thd、table）下沉基类 |
| 装饰器 | `TimingIterator` | 计时不侵入算子逻辑，release 构建零开销 |
| 工厂 | `CreateIteratorFromAccessPath` 的 switch | 45 种计划类型到 20 个算子类的多对一收敛 |

## 模块间交互

- **上游**：优化器的 `root AccessPath`（见[优化器模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer)）；
- **下游**：基表算子经 `ha_rnd_next/ha_index_read_map`（`sql/handler.h:5080/5907` 一族包装）进入[存储引擎 API](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/05-storage-engine-api)；
- **横向**：物化算子依赖 temptable 引擎（`storage/temptable/`）与文件排序（`sql/filesort.cc`）；窗口/聚合依赖 Item 聚合（`item_sum.h`）；
- **反馈**：EXPLAIN ANALYZE 读取 `TimingIterator` 计时回填 AccessPath，供优化器研究。

## 扩展方式

- **新增算子**：`sql/iterators/` 新文件实现 `RowIterator` 子类 + `CreateIteratorFromAccessPath` 的 case + 对应 AccessPath 类型（完整步骤见[优化器模块](/vibe-reading/articles/Database/OLTP/MySQL/CodeWiki/26.7.0/03-optimizer)的扩展节）；
- **新增结果汇**：`query_result.h` 新 `Query_result` 子类（如新的 INTO 目标），语句入口处装配；
- **调优阅读路线**：EXPLAIN FORMAT=tree 的输出节点名与 `AccessPath::Type` 枚举一一对应，先对着输出读 `access_path.h:243` 的类型表，再进对应 iterator 文件。
