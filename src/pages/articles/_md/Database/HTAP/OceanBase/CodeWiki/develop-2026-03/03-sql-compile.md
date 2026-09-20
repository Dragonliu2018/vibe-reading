---
source:
  type: "源码解读"
  project: "OceanBase"
  url: "https://github.com/oceanbase/oceanbase"
title: "SQL 编译前端"
date: "2026-09-20T11:14:46+08:00"
category: [Database, HTAP, OceanBase, CodeWiki, "develop-2026-03"]
contentType: "CodeWiki"
tags: ["OceanBase", "SQL 优化器", "plan cache", "查询改写"]
description: "OceanBase SQL 编译前端：fast parser 两级解析、38 种改写规则、IDP join order 枚举与 16 趟计划树遍历——非 Cascades 的自研优化器体系。"
readingTime: "35 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/00-overview)

---

## 模块定位

`src/sql/` 的编译前端把 SQL 文本变成可缓存的物理计划，规模约 84 万行（parser ~45K / resolver ~268K / rewrite ~149K / optimizer ~194K / plan_cache ~26K，加上 `ob_sql.cpp` 310KB、`ob_spi.cpp` 等顶层文件）。核心命题是**高并发 OLTP 下的编译延迟与内存预算**——这也是理解它所有设计取舍的钥匙。边界：执行端（engine/das/code_generator）由 [SQL 执行引擎](/vibe-reading/articles/Database/HTAP/OceanBase/CodeWiki/develop-2026-03/04-sql-engine) 负责。

## 模块架构

编译流水线六阶段，每阶段有独立的缓存与干预通道：

| 阶段 | 组件 | 关键类 |
| --- | --- | --- |
| 1. 参数化查找 | `parser/ob_fast_parser.h` | `ObFastParserMysql/Oracle`（手写 lexer） |
| 2. 语法分析 | `parser/`（bison 2.4.1 锁版本） | `ObParser`、`ParseResult` |
| 3. 语义解析 | `resolver/` | `ObResolver` → `ObSelectResolver` 等（REGISTER_STMT_RESOLVER 分发） |
| 4. 改写 | `rewrite/` | `ObTransformerImpl`，38 种规则 |
| 5. 逻辑+物理计划 | `optimizer/` | `ObOptimizer`、`ObLogPlan`、join order IDP |
| 6. 计划生成 | `code_generator/` | `ObStaticEngineCG` |
| 缓存 | `plan_cache/`、`spm/`、`udr/` | `ObPlanCache`、`ObPlanBaselineItem`、`ObUDRItemMgr` |

## 调用链路

一条文本 SQL 的完整编译链（COM_QUERY）：

```
ObSql::stmt_query                              ob_sql.cpp:155
└─ handle_text_query                           ob_sql.cpp:2957
   ├─ trim SQL（'select..' 与 ' select..' 同一 cache key）
   ├─ 栈上 new ObPlanCacheCtx（4KB，static_assert 限大小）
   ├─ begin/commit 纯字符串比较短路（不走 cache）
   ├─【软路径】pc_get_plan → ObPlanCache::get_plan
   │    └─ construct_fast_parser_result         手写 lexer 参数化出模板 SQL 作 key
   │       └─ ObPlanCacheValue::choose_plan     plan_cache_value.cpp:477
   │          ├─ check_value_version_for_get    schema version 比对，过期→重编译
   │          └─ ObPlanSet::match_params_info   参数类型/常量约束逐条匹配
   └─【硬路径】handle_physical_plan             ob_sql.cpp:5505
      ├─ ObUDRUtils::match_udr_and_refill_ctx  用户改写规则先替换 SQL
      ├─ handle_parser → ObParser::parse       bison 全量语法分析
      ├─ generate_sql_id / get_outline_data    outline/SPM 绑定第二棵 parse tree
      └─ generate_physical_plan                ob_sql.cpp:3493
         ├─ generate_stmt                      :3184
         │    └─ ObResolver::resolve           resolver/ob_resolver.cpp:215
         │       → ParseNode → ObDMLStmt + ObRawExpr 树
         ├─ ObPrivilegeCheck::check_privilege_new
         ├─ transform_stmt（改写）              ob_sql.cpp:4038
         │    └─ ObTransformerImpl::transform   迭代至收敛（默认 10 轮上限）
         ├─ optimize_stmt                      ob_sql.cpp:4137
         │    └─ ObOptimizer::optimize → ObLogPlan::generate_plan
         │       ├─ generate_join_orders       ObJoinOrderEnumIDP::enumerate
         │       ├─ generate_plan_tree         AccessPath → JoinPath 组合
         │       ├─ allocate_plan_top          逐层加 Sort/Limit/SubplanFilter...
         │       └─ plan_traverse_loop(PX_RESCAN, ALLOC_GI, ALLOC_OP,
         │            ALLOC_EXPR, PROJECT_PRUNING, GEN_SIGNATURE, ...)  16 趟遍历
         └─ code_generate（表达式 frame 布局 + 算子生成）→ pc_add_plan 入缓存
```

## 核心实现

### 优化器架构：非 Cascades 的自研体系（已核实）

全 `src/sql/` grep "cascades" 零命中。实际架构分两层：**rewrite 阶段**启发式规则迭代到收敛 + 9 种 cost-based transform（`ALL_COST_BASED_RULES`：OR_EXPANSION、WIN_MAGIC、GROUPBY_PUSHDOWN/PULLUP、SUBQUERY_COALESCE、MV_REWRITE、LATE_MATERIALIZATION…，位图枚举见 `ob_transform_rule.h:237`，static_assert 校验三组并集等于全集）；**optimizer 阶段** join order 用 IDP（Iterative DP，`ob_join_order_enum_idp.cpp`），表数超阈值且 4.6.0+ 兼容版本改用 Permutation 枚举；物理后处理不是变换-搜索而是 **16 趟固定顺序的计划树遍历**（`plan_traverse_loop`，op 枚举在 `ob_optimizer.h:34`，含 ALLOC_EXPR 两阶段表达式分配、runtime filter 分配）。为什么：面向高并发 OLTP，编译延迟与内存预算比穷尽搜索的 plan 质量更重要，System-R 风格候选集裁剪可控性好。

### fast parser 两级解析

soft parse 不走 bison：`ObFastParserBase` 手写 lexer 直接产出参数化模板 SQL（literal 替换为 `?`）作 plan cache key（`construct_fast_parser_result` in `ob_plan_cache.cpp`）。注释明说 "For performance reasons, virtual functions are not used"——用成员函数指针回调代替虚函数。硬解析时另有第二套基于语法树的参数化 `ObSqlParameterization::parameterize_syntax_tree`（`ob_sql_parameterization.cpp:1132`），区分 `not_param_index_/neg_param_index_/must_be_positive_index_` 精细类别——负数/字符集边界（gbk 转义）是工程难点。典型 soft parse 是纯 lexer 活，bison 树构建成本高一个量级。

### 多版本 schema 与三级缓存失配保护

plan 失效靠 **schema version 比对**而非主动失效：resolver 产出的 `global_dependency_tables_`（`ObQueryCtx`）→ `ObPlanCacheValue::stored_schema_objs_`（含 schema_version），每次命中在 `check_value_version_for_get`（`plan_cache_value.cpp:1667`）比对。另有 `switchover_epoch_`（主备切换）独立失效维度。cache 命中的错误码一律被 `pc_get_plan` 吞掉转 hard parse——plan cache 的错误不影响正常执行路径。

**入缓存的内存准入**（`ObPlanCache::add_plan`，`ob_plan_cache.cpp`）：租户级内存超限（`is_reach_memory_limit`）拒绝入库返回 `OB_REACH_MEMORY_LIMIT`；单个 plan 超过 `get_mem_high()`（mem_limit 的 mem_high_pct_ 百分比）静默跳过——巨型计划不驱逐大量小计划。add 失败返回 `OB_OLD_SCHEMA_VERSION` 时按 `need_retry_add_plan` 重试，坏状态节点先 `remove_cache_node` 清掉。参数匹配失败的 plan set 遍历会把 param store 回滚到进入前计数——失败重试时参数个数一致（`choose_plan` 的 `org_param_count`）。

### outline / SPM / UDR 三种 SQL 干预通道

- **outline**：`get_outline_data`（`ob_sql.cpp:4584`）合并 hint 到第二棵 parse tree；
- **SPM**（`OB_BUILD_SPM` 条件编译）：`ObSpmSet/ObPlanBaselineItem` 复用 lib cache 基础设施，ACCEPTED 位控制计划可用，支持 `is_retry_for_spm_` 演进重试；
- **UDR**：`ObUDRItemMgr` 模板匹配在 parser **之前**替换 SQL 文本。

三者都以 hint 形式最终作用于 resolver 生成的 `ObQueryHint`（`resolver/dml/ob_hint.h`），含 `optimizer_features_enable_version_` 版本门控。反向通道 `ObTransformImpl::add_trans_happended_hints` 把改写事实写回 outline。

### 改写收敛防护

迭代上限 10 次（`DEFAULT_ITERATION_COUNT`）+ `PREDICATE_MOVE_AROUND` 振荡专项预算（`update_enable_types` in `ob_transformer_impl.cpp:558`）。还有 errsim 的随机改写顺序 `transform_random_order` 用于暴露改写顺序依赖 bug。

### ObRawExpr 表达式体系

`ObRawExpr`（`resolver/expr/ob_raw_expr.h:1959`）是编译期 IR，`ExprClass` 分 17 类；`ObRawExprVisitor`（:5571）17 个纯虚 `visit()` 支撑信息标注/打印/拷贝/类型推导。执行期是另一套 `ObExpr`（engine/expr）——CG 时经 `ObStaticEngineExprCG` friend 转换，三段分离是 OceanBase 向量化改造的骨架。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 泛型 placement-new 工厂 + arena | `ObStmtFactory::create_stmt<T>`（`ob_stmt.h:802`）、`ObRawExprFactory`（`ob_raw_expr.h:5614`） | 编译路径分配次数极高，arena 一次释放 |
| 访问者 | `ObRawExprVisitor`、`plan_traverse_loop` 变参模板 | 17 类表达式/计划树的统一遍历 |
| 模板方法 + 注册宏 | `REGISTER_STMT_RESOLVER`（`ob_resolver.cpp:215`）、`transform_one_rule<T>` | 新语句/新规则零侵入 |
| 策略 | join order 三算法（`ObJoinOrderEnum` 基类 + IDP/Permutation） | 表数不同规模换算法 |
| Guard 套件 | `FLTSpanGuard(parse/resolve/...)`、`ObMemPerfGuard` | 全链路 trace span 与内存统计模式化 |

## 模块间交互

依赖 share/schema（`ObSchemaGetterGuard` 一致性视图）、share/stat（`ObOptStatManager` 注入 `ObSql::init`，基数/代价估计；`ob_access_path_estimation.cpp` 还能走 RPC 到存储节点做实时行数估计）。产出 `ObPhysicalPlan` 交 executor 执行；分区裁剪结果（`rewrite/ob_query_range.cpp` + `optimizer/ob_table_location.h`）在 CG 结束写入 `das_ctx.add_candi_table_loc`——DAS 执行期按此路由。

## 扩展方式

- **新增一种 hint**：`resolver/dml/ob_hint.h` 加 `ObHint` 子类 + `ObHint::create_hint` switch + `ob_sql_hint.cpp` 解析 + `ObGlobalHint` 字段；很多行为开关走现成的 `ObOptParamHint`（opt_param 通道）而不必新 hint
- **新增改写规则**：见概览「典型修改场景 2」
- **新增 plan cache 驱逐策略**：`plan_cache/ob_plan_cache.h:144-221` 已有三套 `should_dump` 策略类 + `cache_evict*` 家族，扩 `EvictAttr` 判据即可
- **新增语句类型 resolver**：`resolver/` 对应子目录建 `ObXxxResolver`，`ob_resolver.cpp` switch 加 case，bison 语法 + `ObItemType`（`src/objit/common/ob_item_type.h`）同步
