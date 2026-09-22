---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "优化器与执行器"
date: "2026-09-22T22:30:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "优化器", "执行器", "JOIN_TAB", "Range 优化", "Join Buffer", "Hash Join"]
description: "MariaDB 13.x 优化器与执行器解读——JOIN_TAB 函数指针执行模型（与 MySQL 8 RowIterator 路线分叉）、greedy_search 计划搜索、三段式 range 优化器、BNL/BNLH/BKA 八级 join buffer 体系、五策略半连接变换全解"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

优化器与执行器是 MariaDB SQL 层的核心引擎——把语义分析后的 `Item` 表达式树变成物理执行计划并驱动其运行。理解这个模块的第一件事是一个**路线事实**：MariaDB 13.1 的执行器**不是** MySQL 8.0+ 那套 `RowIterator` 迭代器树——`sql/` 下没有 `iter/` 目录，全代码库无 `RowIterator` 类。MariaDB 选择了在老执行器上持续投资：hash join、rowid filter、split materialization 都是**嫁接在 JOIN_TAB 结构上的**，而不是靠执行器重写获得。god node 数据也印证了这个模块的分量：`Item` degree 615（全库第 2）、`JOIN` degree 293、`st_join_table` degree 203。

## 模块架构

核心组件的关系是「一套数据结构（JOIN/JOIN_TAB/POSITION）贯穿优化与执行两个阶段」——JOIN_TAB 既是计划节点也是执行节点，`optimize` 阶段填成本与访问方式，`make_join_readinfo` 再把它编译成函数指针程序：

- **JOIN**（`sql/sql_select.h:1456`）：一次查询的优化上下文，持有 `join_tab`/`best_ref` 计划数组、`positions` 搜索态
- **JOIN_TAB**（`st_join_table`，`sql/sql_select.h:492`）：单表访问单元——`keyuse` 候选键、`quick` 范围计划、`read_first_record`/`next_select` 函数指针、`cache` join buffer
- **Item**（`sql/item.h:825`）：表达式树节点（110 个类），同时是取值虚接口、常量容器、优化器回调宿主
- **QUICK_ 族**（`sql/opt_range.h`）：range 优化器的执行对象
- **JOIN_CACHE 族**（`sql/sql_join_cache.h`）：join buffer 的类层次

## 调用链路

一条 SELECT 从进入优化到返回行的主干：

```
mysql_select (sql/sql_select.cc:5349)
├─ new JOIN(thd, fields, options, result)
├─ JOIN::prepare (:1427)                    AST → 语义树（fix_fields 绑定 Field）
└─ JOIN::optimize (:1989) → optimize_inner (:2215)
    ├─ simplify_joins (:2363)               外连接展平
    ├─ convert_join_subqueries_to_semijoins (:2298)   ← sql/opt_subselect.cc:1180
    ├─ optimize_cond → cond_equal 等式传播 (:2479)
    ├─ make_join_statistics (:5650)
    │    ├─ update_ref_and_keys (:5853)     生成 KEYUSE 数组
    │    └─ choose_plan (:10283)
    │         └─ greedy_search (:10855)
    │              └─ best_extension_by_limited_search   深度受 search_depth 限制的 DFS
    │                   └─ best_access_path (:8787)      评估 ref/range/index/full scan 成本
    └─ JOIN::optimize_stage2 (:2810)
         ├─ make_join_readinfo (:16384)     ★计划→"程序"：设 read_first_record/next_select
         ├─ check_join_cache_usage_for_tables (:16213)   建 JOIN_CACHE
         └─ make_aggr_tables_info (:3763)  规划 tmp 表/filesort/窗口步骤

执行: JOIN::exec (:4903) → do_select (:24131)
└─ sub_select (:24654)                       递归函数指针链
     ├─ (*read_first_record)(join_tab)      join_read_first / join_read_key
     ├─ evaluate_join_record (:24824)        算 select_cond（WHERE/ON 片段）
     └─ (*next_select)(join, join_tab+1)     通过→下一表；终点 end_send (:26092)
```

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计 |
|---|---|---|
| `JOIN::optimize_inner` | 优化主入口 | 变换→统计→计划搜索三段式 |
| `greedy_search` | join order 搜索 | 只提交 search_depth 深度内最优前缀的第一个表，O(N×depth!) |
| `best_access_path` | 单表访问方式比价 | ref/range/index scan/full scan/join buffer 统一估价 |
| `make_join_readinfo` | 计划编译成函数指针 | 按 `tab->type` 设 `read_first_record`/`next_select` |
| `sub_select` | 嵌套循环核心 | `join->return_tab` 充当控制流"栈"（FirstMatch 提前终止） |
| `test_quick_select` | range 计划入口 | `opt_range.cc:2727`，产出 QUICK 对象挂到 JOIN_TAB |
| `evaluate_join_record` | 行过滤与下传 | 通过则 `next_select` 推进，否则跳过 |

</details>

## 核心实现

### JOIN_TAB：计划节点与执行节点合一

`st_join_table`（`sql/sql_select.h:492`）是理解 MariaDB 执行器的钥匙。它同时承载优化产物（`keyuse`、`type`、`quick`）与执行机制（函数指针对）：

```cpp
// sql/sql_select.h:492
typedef struct st_join_table {
  TABLE *table;  KEYUSE *keyuse;  KEY *hj_key;      // hash join 专用"虚拟索引"
  QUICK_SELECT_I *quick;  Item *select_cond;         // 范围计划 + 附加条件
  READ_RECORD::Setup_func read_first_record;         // 取第一行
  Next_select_func next_select;                      // 接受一行后干嘛
  READ_RECORD read_record;                          // 取后续行
  enum join_type type;  TABLE_REF ref;
  bool use_join_cache;  JOIN_CACHE *cache;          // join buffer
  AGGR_OP *aggr;  Window_funcs_computation *window_funcs_step;
  enum sj_strategy_enum sj_strategy;                 // FirstMatch/LooseScan/...
  Rowid_filter *rowid_filter;
} JOIN_TAB;
```

执行循环 `sub_select`（`sql/sql_select.cc:24654`）就是沿这个结构的递归：读行 → `evaluate_join_record` 算条件 → 通过则 `(*next_select)` 推进到下一表。最内层 tab 的 `next_select` 由 `setup_end_select_func`（:24099）决定——`end_send`（直接发客户端）、`end_write`（写 tmp 表）或 `end_send_group`。tmp 表步骤串成 AGGR_OP 链（`sql_select.h:1426`），由 `sub_select_postjoin_aggr` 接管第二段。`join->return_tab` 充当"返回地址"——FirstMatch/LooseScan 跳过整个内层时把它设回外层 tab，这是 tab-based 执行器里最接近迭代器提前终止的机制。

### 三段式 range 优化器

range 优化（`sql/opt_range.cc`，17.8k 行）把 WHERE 条件从 `Item` 树直接变成区间计划，三段流水线：

1. **区间代数**：`Item_cond_and::get_mm_tree`（:8909）做区间交、`Item_cond::get_mm_tree`（:8935）做并——产物是 `SEL_ARG` 红黑树节点（`opt_range.h:323`，描述某 key part 上的 `[min,max]`）按索引组织成 `SEL_TREE`（:247），OR 分支合并为 `SEL_IMERGE`（:486，index merge 的 DNF 表示）
2. **候选比价**：`test_quick_select`（:2727）经 `get_key_scans_params`（:354）评估各 TRP（TABLE_READ_PLAN）成本——`TRP_RANGE`/`TRP_ROR_INTERSECT`/`TRP_ROR_UNION`/`TRP_INDEX_MERGE`/`TRP_GROUP_MIN_MAX`
3. **实例化**：`make_quick_select()` 产出执行对象 `QUICK_RANGE_SELECT`（:1344，degree 75）、`QUICK_INDEX_MERGE_SELECT`、`QUICK_ROR_INTERSECT_SELECT`、`QUICK_GROUP_MIN_MAX_SELECT` 等

13.x 在这套框架上叠加了 `Rowid_filter`（`make_range_rowid_filters`，`sql_select.cc:2076`）：对被 join 的表先用 range 扫出 rowid 集合下推给引擎（`table->file->rowid_filter_push`），执行时引擎层先过滤。

### 八级 join buffer：BNL/BNLH/BKA/BKAH

`sql/sql_join_cache.cc`（4.8k 行）是 MariaDB join 执行的招牌。`join_cache_level` 1-8 分别映射 {非增量，增量} × {BNL, BNLH, BKA, BKAH}：

```
JOIN_CACHE (sql/sql_join_cache.h:90)          基类：buffer 打包/解包记录
├── JOIN_CACHE_BNL (h:1106)                    Block Nested Loop
├── JOIN_CACHE_HASHED (h:775)
│   └── JOIN_CACHE_BNLH (h:1159)               ★MariaDB 的"hash join"本体（JT_HASH）
└── JOIN_CACHE_BKA (h:1273)                     Batched Key Access（配 MRR 批量下发键）
    └── JOIN_CACHE_BKAH (h:1369)               BKA + Hash
```

MariaDB hash join 的实现路线很值得读——**不做执行器改造，而是"虚拟索引 + BNLH"**：无索引可 ref 时，`create_hj_key_for_table`（`sql_select.cc:13585`）在内存构造 `KEY`/`keyinfo` 描述符存进 `JOIN_TAB::hj_key`，`best_access_path` 给出 `JT_HASH`（:9706），执行时 BNLH cache 建哈希表探测。这样 hash join 与现有 ref 访问路径、条件附加、成本模型完全复用，不动执行器骨架。

### 子查询：semijoin 化优先，五策略在计划搜索内联合选型

`convert_join_subqueries_to_semijoins`（`sql/opt_subselect.cc:1180`，7.5k 行文件）把 IN 子查询改写成 semi-join 嵌套；五种去重策略（`sj_strategy_enum`，`sql_select.h:451`：DUPS_WEEDOUT / LOOSE_SCAN / FIRST_MATCH / MATERIALIZE / MATERIALIZE_SCAN）的选择**不是独立 pass，而是嵌进 POSITION**——每个候选前缀位置带 4 个 picker 对象（`sql_select.h:1345-1348`），随 `best_extension_by_limited_search` 一起定价。不能 semijoin 的 IN 走 `inject_in_to_exists_cond`（`sql/item_subselect.cc:2815`）注入相关谓词转 EXISTS，执行期发现可用新索引还能 `JOIN::reoptimize`（`opt_subselect.cc:6862`）。

### 独立 hint 体系

`sql/opt_hints*` 是 MariaDB 自研的四层 hint 树：`Opt_hints_global` → `Opt_hints_qb` → `Opt_hints_table` → `Opt_hints_key`（`opt_hints.h:469/520/747/859`），开关用 `Opt_hints_map` 位图；hint 种类枚举在 `opt_hints_structs.h`（BKA/BNL/SEMIJOIN/JOIN_ORDER/INDEX...）。**与 MySQL 8.0 的 hint 系统是两套独立实现**——语法相近（`/*+ BNL(t1) */`）但类树不同。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略模式（picker 族） | `Semi_join_strategy_picker` 四子类（sql_select.h:1040） | 五种半连接去重策略统一在计划搜索内比价 |
| 模板方法 | `JOIN_CACHE` 基类定义 put_record/join_records 骨架 | BNL/BNLH/BKA/BKAH 四算法共享 buffer 管理 |
| 工厂方法 | `get_key_scans_params` 产 TRP → `make_quick_select` 产 QUICK | 候选计划与执行对象分离，比价后再实例化 |
| 函数指针程序 | `JOIN_TAB::read_first_record`/`next_select`（make_join_readinfo 填充） | 把"计划"编译成无需解释器的执行路径 |

## 模块间交互

- **上游**：解析器产出 `Item` 表达式树与 `SELECT_LEX_UNIT` 查询块树（见[解析器](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/01-parser)），`JOIN::prepare` 做 fix_fields 语义绑定
- **下游**：`best_access_path` 估价要读 `handler::table_flags()`/`index_flags()` 与统计信息（`handler::info()`），执行通过 `ha_rnd_next`/`ha_index_read_map` 调用 handler 层（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)）
- **横切**：`optimizer_switch` 20+ 开关（`optimizer_flag(thd, ...)` 遍布 sql_select.cc）与 hint 树双轨控制优化行为；EXPLAIN 双轨输出——老路径 `select_describe()`（自称 legacy）与新结构 `Explain_select::print_explain`（`sql/sql_explain.cc:1017`，供 EXPLAIN/ANALYZE FORMAT=JSON）

## 扩展方式

**新增一个 join 算法**（如 grace hash join）：① `sql/sql_join_cache.h/cc` 新建 `JOIN_CACHE_XXX : public JOIN_CACHE`（参照 BNLH，h:1050-1370）；② `check_join_cache_usage_for_tables`（sql_select.cc:16213）扩 `join_cache_level` 档位（现 1-8）；③ 无索引算法走 `hj_key` 路线——`best_access_path` 加 JT 类型 + `make_join_readinfo` switch 加绑定；④ EXPLAIN 文案在 `sql/sql_explain.cc`。

**新增一个 hint**：① `sql/opt_hints_structs.h` 的 `opt_hints_enum` 加值 + `opt_hints.cc` 末尾 `hints_tbl[]` 注册；② 消费点用 `hint_table_state(thd, table, XXX_HINT_ENUM, ...)` 读取；③ `Opt_hints::print` 系列保证 EXPLAIN 可见。

**新增一种 QUICK 类型**：照 `QUICK_GROUP_MIN_MAX_SELECT` 模板——`opt_range.h` 加 `QS_TYPE_*` 枚举 → `opt_range.cc` 实现 init/reset/get_next + 对应 TRP → `best_access_path` 比价。
