---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "SQL 解析器"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity SQL 解析器解读：三套 Flex/Bison 语法（SQL/表达式/Lucene 查询串）、18 个 statement 与 15 个 ParsedExpr 的双 AST、KnnExpr 解析期脱糖、parser/type 作为全库类型底座（36 种逻辑类型）"
readingTime: "24 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/parser/` 约 4.5 万行，是一个**自包含的前端子系统**：5 套语法（3 套 Flex/Bison + 各自 AST）+ 全引擎共享的类型系统 `type/`。它不只是"把 SQL 变成 AST"——`parser/type/` 下的 `LogicalType`（36 种）、`DataType`、`EmbeddingInfo` 等是整个引擎（storage/expression/function）的公共词汇表，被 import 数以千计（`data_type` 535 次、`internal_types` 622 次）。**类型底座放在 parser 里**，因为列类型必须能出现在 CREATE TABLE 语法与 HTTP API 的类型字符串中，解析器是第一个消费者。

历史沿革有据可查：项目 2022 年 7 月最初引入 hyrise/sql-parser 第三方库（commit `c347ca956`），后重写为现在的 Bison/Flex 方案——`src/unit_test/parser/sql_file_parsing_test_ut.cpp:86` 仍读取 `test_data/hyrise/good.sql|bad.sql` 回归集压测新解析器，`parser.y:55` 的 `SQL_LTYPE` 里还有未被使用的 hyrise 风格位置跟踪残留。

---

## 模块架构

三套语法各有分工，刻意用了两种 Bison 风格：

| 语法 | 文件 | 风格 | 产物 | 用途 |
|---|---|---|---|---|
| SQL 主语法 | `parser.y`(4,491 行) + `lexer.l` | C skeleton + `%union`，prefix `sql` | statement 列表 | SQL 文本协议（PG 前端、QueryContext::Query） |
| 表达式语法 | `expression_parser.y`(783 行) + `expression_lexer.l` | C skeleton，prefix `expression` | ParsedExpr | HTTP JSON 的 filter 字符串 |
| 搜索语法 | `search_parser.y`(199 行) + `search_lexer.l` | **C++ skeleton `lalr1.cc` + `api.value.type variant`** | **QueryNode 树** | MATCH TEXT 里的 Lucene/Elasticsearch 查询串 |

```text
src/parser/
├── statement/     18 个 statement AST 类（.h/.cpp/.cppm 三件套）
├── expr/           15 个 ParsedExpr 子类（含 knn/match/search 等 AI 检索表达式）
├── table_reference/  FROM 子句 AST：TableReference/JoinReference/CrossProduct/Subquery
├── type/           全库类型底座：logical_type(40 枚举)/data_type/complex/(Embedding/Sparse/Tensor/RowID...)
├── definition/     ColumnDef 列定义
└── stats/          GlobalResourceUsage 全局对象计数器
```

AST 类层次（两层解耦）：

- **`BaseStatement`**（18 个子类）：`SelectStatement/CreateStatement/InsertStatement/...`，`StatementType` 枚举 18 值。
- **`ParsedExpr`**（15 个子类）：标准 SQL 的 `ConstantExpr/ColumnExpr/FunctionExpr/BetweenExpr/CaseExpr/CastExpr/InExpr/SubqueryExpr/InsertRowExpr` + **6 个 AI 检索表达式**：`KnnExpr/MatchExpr/MatchTensorExpr/MatchSparseExpr/SearchExpr/FusionExpr`。

`SelectStatement` 最能体现"AI 检索优先"——比标准 SELECT 多出专属槽位：

```cpp
// src/parser/statement/select_statement.h
class SelectStatement final : public BaseStatement {
    BaseTableReference *table_ref_{nullptr};
    std::vector<ParsedExpr *> *select_list_{nullptr};
    std::vector<ParsedExpr *> *highlight_list_{nullptr};   // 全文检索高亮列
    ParsedExpr *search_expr_{nullptr};                     // SEARCH 子句（多路 MATCH + FUSION）
    ...
};
```

---

## 调用链路

### SQL 文本 → statement 列表

```text
QueryContext::Query (query_context_impl.cpp:85)
  └─ SQLParser::Parse(query, result)              sql_parser.cpp
       ├─ sqllex_init / sql_scan_string            flex reentrant scanner
       ├─ result->Reset()                          防上次 Parse 污染
       └─ sqlparse(scanner_, result)               bison 入口
            每 reduce 一个 statement → result->statements_ptr_
  └─ statements_ptr_->at(0) → BaseStatement* → LogicalPlanner
```

### SEARCH/MATCH 的两段式解析（关键设计）

`SEARCH` 子句在主语法中把多路 MATCH 与 FUSION 收进 `SearchExpr`（`parser.y:1645`）。但 **MATCH TEXT 里的 Lucene 查询串是"迟到"的二次解析**——`MatchExpr` 在解析期只是三段字符串（`fields_`/`matching_text_`/`options_text_`），直到 binder 阶段才由第三套语法解析：

```text
BoundSelectStatement（bound_select_statement_impl.cpp:279）
  └─ SearchDriver search_driver(column2analyzer, default_field, operator_option);
  └─ search_driver.ParseSingleWithFields(fields_, matching_text_)
       └─ SearchDriver::ParseSingle (search_driver_impl.cpp:173)
            ├─ AnalyzerPool::GetAnalyzer(...)        按列的 analyzer 分词
            └─ SearchParser::parse() → QueryNode 树    （OrQueryNode/AndQueryNode/TermQueryNode...）
  └─ match_node->query_tree_ = std::move(query_tree)   挂到 MatchScan 逻辑节点
```

为什么要独立 search_parser？它解析的不是 SQL，而是 `field:term^2~3` 这种 Lucene 查询串（`search_parser.y` 首行注释直引 Lucene `StandardSyntaxParser.jj` 与 ES query-string 文档）。这种语言含 `:`、`~`、`^`、裸词、正则 `/star./`，与 SQL 词法根本冲突；且产物 `QueryNode` 属于存储倒排层，生命周期与 SQL AST 不同。所以选择 C++ skeleton + variant 语义值（`std::unique_ptr<QueryNode>` 直接在栈上传递，无需手写 union），并**在执行前的 binder 阶段**才解析——那时才拿得到列 → analyzer 映射去分词。

### 语法动作里的语义校验

`select_clause` 的产生式在 reduce 时做三类前置校验（错误即 `yyerror` + `YYERROR`，先 delete 各子句节点防泄漏）：**SEARCH 表达式与 ORDER BY 互斥**（"Result modifier(ORDER BY) is conflict with SEARCH expression."）、**OFFSET 必须搭配 LIMIT**（"Offset expression isn't valid without Limit expression"）、**HAVING 必须跟在 GROUP BY 后**。Lucene 查询串侧的语义在 `search_parser.y`：相邻子查询无连接词时默认按 `OrQueryNode` 组合（`kInfinitySyntax` 模式下有断言保护）；`~N` 后缀作为 slop 参数传给 `SearchDriver::AnalyzeAndBuildQueryNode`（短语检索的词距容差）；`^W` 后缀调 `QueryNode::MultiplyWeight` 做权重提升——这就是 `MATCH TEXT('body^5', ...)` 字段加权的解析落点。

### KnnExpr 的解析期脱糖

`MATCH VECTOR` 规则（`parser.y:3067`）的语法动作里**就地校验与转换**：`InitDistanceType` 失败即 `YYERROR`（接受 `l2`/`ip`/`cosine`/`cos`/`hamming` 五个别名）；`InitEmbedding()`（`expr/knn_expr.cpp:161`）把 SQL 字面量数组（`ConstantExpr::double_array_`/`long_array_`）直接转成按 `EmbeddingDataType` 定型的 C 数组（float/float16/bfloat16/int8/uint8/int16/int32/int64），析构按类型分支 `delete[]`——向量在解析期就已脱糖为机器格式，而非延迟到执行期。非 `ConstantExpr` 的查询向量（如 FDE 函数）保留为 `query_embedding_expr_` 延迟求值（同时 `embedding_data_type_str_` 记录类型字符串供执行期解析）。规则还有 `USING INDEX (name)` 与 `IGNORE INDEX` 两个变体，分别填 `index_name_` 与置 `ignore_index_`。

```cpp
// src/parser/expr/knn_expr.h
class KnnExpr : public ParsedExpr {
    ParsedExpr *column_expr_{};                 // 检索目标列
    void *embedding_data_ptr_{};                // 查询向量裸内存（按类型 reinterpret_cast）
    int64_t dimension_{};
    EmbeddingDataType embedding_data_type_{};
    KnnDistanceType distance_type_{};           // l2 / cosine / ip / hamming
    int64_t topn_{DEFAULT_MATCH_VECTOR_TOP_N};  // 默认 10
    std::unique_ptr<ParsedExpr> filter_expr_;   // 子检索内 WHERE（过滤式向量检索）
    std::unique_ptr<ParsedExpr> query_embedding_expr_;  // 查询向量可为函数表达式
    bool ignore_index_{false};
};
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `SQLParser::Parse` | `sql_parser.cpp` | flex reentrant + bison 主入口 |
| `ExprParser::Parse` | `expr_parser.cpp` | 独立表达式语法（HTTP filter） |
| `SearchDriver::ParseSingle` | `search_driver_impl.cpp:173` | Lucene 查询串 → QueryNode 树 |
| `SearchDriver::AnalyzeAndBuildQueryNode` | `search_driver_impl.cpp:227` | analyzer 分词 + 建 TermQueryNode |
| `KnnExpr::InitEmbedding` | `expr/knn_expr.cpp:161` | 字面量数组 → 定型 C 数组 |
| `SearchExpr::SetExprs` | `expr/search_expr.cpp` | 多路 MATCH 收纳 + Validate（多路必须配 FUSION） |
| `generate_parser.sh` | `parser/` | 6 条 flex/bison 再生成命令 |

</details>

---

## 核心实现

### statement 与 expr 双 AST 的分工

`BaseStatement`（语句骨架：子句槽位、表引用、set 操作）与 `ParsedExpr`（值/谓词计算单元）解耦。收益是三套语法可共享同一 expr 层——`expression_parser.y` 只重写 expr 子集即可服务 HTTP filter；`SEARCH` 子句把"多检索表达式 + 融合"收敛为 `SearchExpr` 一个 expr 节点，避免 statement 层为检索开新槽位。代价是 783 行表达式语法与主语法重复维护（两处 `match_expr` 规则：`parser.y:3377` 与 `expression_parser.y:253`）。

### AST 无 Visitor——消费侧分派

AST 基类只有 `type_` 枚举 + 纯虚 `ToString()`，没有 `accept()`。多态分派移到消费者：`ExpressionBinder::BuildExpression`（`expression_binder_impl.cpp:111`）对 `ParsedExprType` switch，再转入虚函数重载族 `BuildKnnExpr/BuildMatchTextExpr/...`，9 个子 binder（WhereBinder/ProjectBinder/...）按需 override。`ToString()` 双用途：既是 `EXPLAIN AST` 的数据源，也是错误信息拼接素材。

### .h/.cpp 与 .cppm 混合的桥接

为什么 parser 保留传统头文件而其他模块全是 .cppm？Bison/Flex 生成器只能产 C/C++ 头文件 + 翻译单元，无法产 module interface。团队的选择是"AST 定义留在 .h（被生成器与全引擎 include），再为每个 .h 写 10 行 .cppm re-export 垫片"（如 `statement/select_statement.cppm`：`export using infinity::SelectStatement;`）——把"生成器世界"与"C++20 modules 世界"隔离在每个目录内的三件套里。遍布各文件的 `#ifndef PARESER_USE_STD_MODULE` 守卫（宏名 PARESER 拼错）也是 hyrise 时代拷贝来的化石。

`generate_parser.sh` 的 6 条命令从 `.l/.y` 再生成产物，**生成代码直接 check-in**（`parser.cpp` 414.6K、`lexer.cpp` 117.9K 都在仓库里），构建直接 glob `.cpp`——"生成一次、入库、手工触发再生"的模型，免去构建机对 flex/bison 版本的依赖。注意脚本与入库产物已漂移：脚本写 `-Psql expression_lexer.l`，但入库代码实际用 `expression` 前缀，且 `expr_parser.cpp` 构造函数调用主 scanner 的 `sqllex_init`——依赖 flex reentrant scanner 结构布局一致的隐式行为，属历史包袱。

### AI 类型下沉 parser/type

`LogicalType` 枚举 40 值中 5 个 AI 类型：`kEmbedding`（定长向量）、`kTensor`（2D）、`kTensorArray`（3D）、`kSparse`（稀疏）、`kMultiVector`（多向量），另加低精度 `kFloat16/kBFloat16`。`EmbeddingDataType`（`complex/embedding_type.h:33`）10 种元素类型（bit/int8..int64/float/double/uint8/float16/bfloat16）。变长类型的行内 POD 句柄（`Varchar` 16 字节、`TensorType` 8 字节）也定义在此——向量化列存的地基从 parser 就开始铺。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 消费侧分派（interpreter 变体） | `ExpressionBinder::BuildExpression` switch + 9 个子 binder override | 同一表达式在不同子句（WHERE/GROUP/ORDER）有不同名字解析规则 |
| 延迟构造/两段式初始化 | `MatchTensorExpr::SetSearchColumn/SetQueryTensor/...`；`SearchExpr::SetExprs → Validate` | 语法动作分多步填充；构造后校验（多路 MATCH 必须配 FUSION） |
| 依赖注入 | `SearchParser` 经 `%parse-param` 注入 SearchScanner/SearchDriver/analyzer | 语法产物直接挂存储层 QueryNode |
| 裸指针 AST + 集中所有权 | `ParserResult::Reset()` 统一 delete；`own_memory_` 标志 | SDK/嵌入式借用内存不释放的所有权转移 |

---

## 模块间交互

- **下游 planner**：`LogicalPlanner` 的 `BuildXxxStatement` 按 `StatementType` 分派；binder 把 parser AST 翻译成 bound 表达式（`KnnExpr → KnnExpression`）。全文检索串在 binder 经 `SearchDriver` 二次解析成 QueryNode。
- **全库类型底座**：`import data_type`（535 处）、`import internal_types`（622 处）、`import logical_type`（380 处）——storage/expression/function 全部以 `TinyIntT...TensorT` 为模板参数做向量化实例化，改此目录即全库重编译。
- **上游 network**：HTTP JSON 检索的 filter 走 `ExprParser`（`http_search_impl.cpp:601`）。
- **反向依赖**：`search_parser.y` `import infinity_core; import search_scanner;`——物理上放在 parser 目录，却依赖 storage 的 `QueryNode`，是三套语法中唯一编入 `infinity_core` 的（CMake 中被注释的 glob 印证迁移痕迹）。

---

## 扩展方式

**新增一个 SQL 语句类型**：`base_statement.h` 的 `StatementType` 加枚举 → `parser.y` 加 `%union` 成员/`%type`/`%token`（`lexer.l` 加关键字，注意放 keyword 表避免与 IDENTIFIER 冲突）+ 规则 → `statement/xxx_statement.{h,cpp,cppm}` 三件套 → 跑 `generate_parser.sh` 再生成入库 → 下游 `logical_planner_impl.cpp:140` switch 加 case。参考最近一次同类改动 `CheckStatement`（kCheck）的完整足迹。

**新增一个表达式类型**（如 `MATCH GRAPH`）：`parsed_expr.h` 加 `ParsedExprType` → `expr/match_graph_expr.{h,cpp,cppm}` → `parser.y` 写规则并挂入 `operand` 分支与 `sub_search` 分支 → `expression_parser.y` 同步 → binder 的 `BuildExpression` switch 加 case + 新虚方法 → `src/expression` 建 bound 类 → executor 实现算子。`KnnExpr` 是最佳参照（其 `query_embedding_expr_` 延迟求值与 `own_memory_` 所有权模式都是为 SDK 复用设计的）。

**给 MATCH VECTOR 加新 option**：只需动 `parser.y` 的 `with_index_param_list` 消费端（`KnnExpr::opt_params_` 是开放的 `InitParameter` 名值对）+ binder/executor 侧识别参数名——语法层零改动，这是 `InitParameter` 透传设计的意图。
