---
source:
  type: "源码解读"
  project: "mariadb-server"
  url: "https://github.com/MariaDB/server"
title: "向量搜索"
date: "2026-09-22T22:47:00+08:00"
category: [Database, OLTP, MariaDB, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["MariaDB", "C++", "VECTOR", "HNSW", "MHNSW", "近似最近邻", "hlindex", "VIDEX"]
description: "MariaDB 向量搜索模块解读——VECTOR 类型本质、MHNSW 图索引（int16 量化+SIMD）、hlindex 隐藏子表法让全部引擎免改获得向量能力、transaction_participant 保证事务、VIDEX What-If 虚拟索引引擎全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

向量搜索是 MariaDB 11.8 起内置的原生能力（MySQL 至今没有对应物）——`VECTOR(n)` 数据类型 + HNSW 近似最近邻索引 + `VEC_DISTANCE` 函数族，共 ~4.4k 行核心代码。这个模块最值得读的不是 HNSW 算法本身，而是**架构决策**：向量索引放在 **sql 层而非 storage engine 层**（"hlindex 子表法"），让 MyISAM/Aria/InnoDB **全部免改**获得向量索引；算法本体 hardcode 在 sql/，plugin 框架只借来做 sysvar/事务参与者的管道。模块构成：

| 文件 | 行数 | 职责 |
|---|---|---|
| `sql/sql_type_vector.{h,cc}` | 151+361 | `Type_handler_vector` / `Field_vector` |
| `sql/item_vectorfunc.{h,cc}` | 119+280 | VEC_DISTANCE 族 |
| `sql/vector_mhnsw.{h,cc}` | 39+1805 | MHNSW 索引算法 + "mhnsw" daemon plugin |
| `storage/videx/` | ~1600 | VIDEX：What-If 虚拟索引引擎（字节贡献，**与向量无关**） |

## 模块架构

- **VECTOR 类型**：`Type_handler_vector` 直接**继承 `Type_handler_varchar`**（`sql_type_vector.cc:21`）——本质是强制 binary、长度 `n*4` 字节的 VARCHAR，磁盘格式 = `Field_varstring`（1-2 字节长度前缀 + IEEE 754 float 数组），**上限 16383 维**（`MAX_FIELD_VARCHARLENGTH/4`）
- **VEC_ 函数族**（`item_vectorfunc.cc`，5 个原生函数）：`VEC_DISTANCE_EUCLIDEAN`/`VEC_DISTANCE_COSINE`/`VEC_DISTANCE`（AUTO——从索引自动推断度量，MDEV-35450）+ `VEC_ToText`/`VEC_FromText`。`distance_kind` 枚举 `{EUCLIDEAN, COSINE, AUTO}`（item_vectorfunc.h:43）
- **MHNSW 索引**：`FVector`（内存量化向量——坐标存 **int16**，`scale = max|coord|/32767`）+ `FVectorNode`（图节点）+ `MHNSW_Share`（共享图上下文）+ `MHNSW_Trx`（事务本地图副本）

## 调用链路

**建图**（`mhnsw_insert`，vector_mhnsw.cc:1407）：

```
MHNSW_Share::acquire(ctx, table, true) (:861)   事务引擎取/建 MHNSW_Trx
├─ 首行: ha_index_last(IDX_LAYER) 找最高层任一节点做入口 + 从 vec blob 反推 vec_len
├─ 随机分层: target_layer = floor(-ln(rand)/ln(M))   ← HNSW 论文的指数层生成器
├─ 从 max_layer 贪心下降到 target_layer+1 (search_layer result_size=1)
├─ 每层 search_layer(construction=true, ef≥ef_construction=10)
│    + select_neighbors (:1150)   ← 论文 Algorithm 4 的简化版
├─ FVectorNode::save (:1202): 序列化为图表行——layer + tref(主表行位置, NULL 即墓碑)
│    + vec blob(scale + int16 维度) + neighbors blob → ha_write_row 写入
└─ update_second_degree_neighbors (:1254): 逐层给邻居加反向链接, ha_update_row
```

**搜索**（优化器选中向量索引后经 `TABLE::hlindex_read_first` 进入）：

```
mhnsw_read_first (:1520)
├─ limit = min(LIMIT, max_ef=10000); 查询向量取 Item_func_vec_distance::get_const_arg()
├─ FVector::create 量化查询向量 → 层>0 贪心下降 → 层0 search_layer(result_size=limit)
│    ├─ 双堆: candidates(全量) + best(ef 界)；ef = max(THDVAR(ef_search), limit) 默认 20
│    ├─ VisitedSet 用 PatternedSimdBloomFilter 一次查 8 个邻居指针
│    ├─ subdist 早退 (:362): vec_len ≥ 384 时只算前 192 维外推全距，超界直接跳过
│    └─ lenient_furthest (:1275): sigmoid 软化剪枝界（"make the search less greedy"）
└─ 结果装进 Search_context 挂到 table->hlindex->context

mhnsw_read_next (:1592): 逐个把 found[pos++]->tref() 经主表 ha_rnd_pos 取回
  ★流式扩展 (MDEV-35032): 初始结果耗尽后以最后距离为新 threshold 再跑一次 search_layer
  中途发现共享 ctx version 变了 → 切换到 MHNSW_Trx 事务本地图
```

<details>
<summary>函数速查表</summary>

| 函数 | 职责 | 关键设计 |
|---|---|---|
| `mhnsw_insert` | INSERT 时建图 | vector_mhnsw.cc:1407 |
| `mhnsw_read_first/next` | k-NN 搜索 | :1520/:1592；流式扩展越过初始 LIMIT |
| `mhnsw_invalidate` | UPDATE/DELETE 软删 | :1662；tref 置 NULL 打墓碑，节点缓存 `deleted=true` |
| `mhnsw_delete_all` | TRUNCATE | :1704；清空图表 + ctx 整体丢弃缓存图 |
| `mhnsw_uses_distance` | 读索引 distance= 选项 | AUTO VEC_DISTANCE 的度量推断 |
| `Type_handler_vector::is_valid` | 拒绝 NaN/Inf 向量 | sql_type_vector.h:96 |

</details>

## 核心实现

### hlindex 子表法：为什么向量索引在 sql 层

首个 commit（`d6add9a03d4`，2024-01）的说明是权威依据：high level index **对存储引擎不可见**，实现在 sql 层——**每建一个向量索引，server 隐式在同库同引擎下建第二张表**，命名如 `t1#i#05`（模板 `HLINDEX_TEMPLATE "#i#%02u"`，table.h:106）。机制三件套：

1. FRM 里 vector 索引带 `HA_KEY_ALG_VECTOR`（include/my_base.h:120，=7），读 FRM 时 `if (keyinfo->algorithm != HA_KEY_ALG_VECTOR) share->keys++`（sql/table.cc:932）——**引擎可见键数不含它**，`hlindexes() = total_keys − keys`
2. server 用 `mhnsw_hlindex_table_def`（vector_mhnsw.cc:1727）的固定 DDL 建图表，图表走标准 handler API（`ha_write_row`/`ha_index_read_idx_map`/`ha_rnd_pos`）
3. tref 存主表行位置（InnoDB 即主键值）——主键超 256 字节报错

**Why**：HNSW 只需要"按位置取行/写行"的 KV 式访问，普通表 + handler API 足以表达；持久化、事务、binlog、崩溃恢复由所在引擎免费继承。**代价**：图表走完整 handler 路径较慢，用大内存缓存（`MHNSW_Share::root` + `node_cache`，上限 `mhnsw_max_cache_size` 默认 16MB，超限整体 reset）弥补。

### SQL 层接线

| 钩子 | 位置 | 触发 |
|---|---|---|
| `hlindexes_on_insert` → `mhnsw_insert` | sql/sql_base.cc:10235（从 handler.cc:8566 进） | INSERT |
| `hlindexes_on_update` → invalidate + insert | sql_base.cc:10242 | UPDATE（旧值打墓碑+新值重插） |
| `hlindexes_on_delete` → `mhnsw_invalidate` | handler.cc:8705 | DELETE |
| `join_read_first` → `hlindex_read_first` → `mhnsw_read_first` | sql/sql_select.cc:25909 | `ORDER BY vec_distance(v, 常量) LIMIT N` 免 filesort |

优化器闭环：`Item_func_vec_distance::part_of_sortkey()`（item_vectorfunc.cc:85）对每个 vector 索引检查度量匹配并在 key_map 置位；`join_read_first` 发现 `tab->index >= table->s->keys`（越过引擎可见键区）即走 hlindex 读路径。

### transaction_participant 保证事务正确性

图的一部分状态活在 sql 层的 TABLE_SHARE 里，引擎的事务机制罩不住它。因此 mhnsw 以 **daemon plugin 身份**调 `setup_transaction_participant`（vector_mhnsw.cc:1773，实现于 handler.cc:672——占用 hton2plugin 槽位），注册 `MHNSW_Trx::tp`：事务内用 `MHNSW_Trx` 本地图（`thd->ha_data[]` 链表按 MDL ticket 匹配表）；`do_commit`（:761）对共享 ctx 加写锁、`version++`、把已加载节点 `vec=nullptr`（下次从图表惰性重读已提交数据）——**不拷贝节点**（注释：bench 场景下不划算）；`do_rollback` 区分语句级（savepoint 式 reset）与事务级；并发搜索中途看到 version 变化自行切换到 trx ctx（:1607）。

### int16 量化 + 单一 dot-product 内核

`FVector`（:134，`#pragma pack(1)`）：每向量算出 `scale = max|coord|/32767`，坐标四舍五入为 int16（commit `fa2078ddff0`："store coordinates in 16 bits, not 32"——内存减半 + `_mm256_madd_epi16` 一条指令 16 个乘加）。距离统一为一个内核：

```
distance_to(other) = abs2 + other->abs2 - scale · other->scale · dot_product(dims, ...)
```

欧氏度量下 `abs2 = |v|²/2`，返回值 = **平方欧氏距离/2**（单调一致，排序正确）；余弦度量下 `FVector::create` 归一化到 `abs2=0.5`，同一公式即 `1−cos_sim`。`dot_product` 四套 SIMD：AVX2/AVX512/NEON（MDEV-34699，1.7×）/POWER + 回退。

### 插件化现状：hardcode + 借框架管道

`sql/vector_mhnsw.h:24-27` 头注释："This will become a vector index plugin API... When we'll have more than one implementation"。**现状完全 hardcode**：`mhnsw_insert/read_first` 等是普通自由函数被 sql_base.cc/handler.cc 直接调用；`maria_declare_plugin(mhnsw)`（:1797）声明的是 **MYSQL_DAEMON_PLUGIN**，只干三件事——承载 4 个 sysvar（`mhnsw_ef_search` 默认 20、`mhnsw_default_m` 默认 6 等）、注册 transaction participant、承载索引选项描述符 `mhnsw_index_options`（`m=5 distance=cosine` 的解析）。等出现第二种实现才会升格成真正的插件 API。

### VIDEX：不是向量引擎（澄清）

`storage/videx/`（字节贡献，版权 Bytedance）是 **What-If 虚拟索引引擎**——一个不存任何数据的存储引擎，把优化器的统计请求经 HTTP POST 转发给外部 AI 服务器（`ha_videx.cc:190` 的 `ask_from_videx_http`，curl），用返回值喂饱 cost model：`info_low`（:805）问 `rec_per_key`（外部服务器做基数估计）、`records_in_range`（:663）问范围行数。**用途**：不建真索引、不导真数据，让优化器按外部模型选计划。`videx_server_ip` 默认 `127.0.0.1:5001`。它在向量模块被提及纯粹因为目录名容易误导。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 隐藏子表 | `t1#i#NN` 图表（table.h:106 模板） | 持久化/事务由所在引擎免费继承 |
| 事务本地副本 | `MHNSW_Trx : MHNSW_Share`（:681） | sql 层状态的事务正确性 |
| 统计驱动自适应 | `stats_collector`（:46，Welford 在线算法）→ subdist 启停/ef_power 更新 | recall/速度权衡按实测数据调整 |
| 类型继承 | `Type_handler_vector : Type_handler_varchar` | 90% 行为复用，最小改动面 |

## 模块间交互

- **与 handler 层**：图表经标准 handler API 读写；`MHNSW_Trx::tp` 走 transaction_participant（见[存储引擎抽象层](/vibe-reading/articles/Database/OLTP/MariaDB/CodeWiki/main-2026-08/03-handler-api)——13.x 的 2PC 参与者不只是存储引擎）
- **与优化器**：`part_of_sortkey` + `test_if_order_by_key`（sql_select.cc:27263）让 `ORDER BY vec_distance(...) LIMIT N` 免 filesort
- **与类型系统**：VECTOR 列不能进普通索引（`type_can_have_key_part() { return false; }`）、禁 EITS 统计（`update_min/max` 返回 false）、聚合/CAST 大多拒绝

## 扩展方式

**新增一种距离度量**：`calc_distance_*` 内核（item_vectorfunc.cc:27/38）+ `MHNSW_param` 的 metric 枚举 + `FVector::create` 的归一化分支 + `mhnsw_index_options` 注册。注意 `LOGREC` 不涉及——图表格式与度量无关。

**hlindex API 化**（未来方向）：把 `vector_mhnsw.h` 的自由函数组升格为 handlerton 式分发表——`TABLE::hlindexes_on_insert` 的 hardcode 调用点（sql_base.cc:10235）改为查表分发。这将是第二种向量索引出现时的必经改造。
