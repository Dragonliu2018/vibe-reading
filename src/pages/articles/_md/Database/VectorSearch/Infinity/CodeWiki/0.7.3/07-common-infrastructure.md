---
source:
  type: "源码解读"
  project: "Infinity"
  url: "https://github.com/infiniflow/infinity"
title: "公共设施"
date: "2026-10-01T22:25:50+08:00"
category: [Database, VectorSearch, Infinity, CodeWiki, "0.7.3"]
contentType: "CodeWiki"
tags: ["Infinity", "infiniflow", "C++", "向量数据库", "混合检索", "AI 数据库"]
description: "Infinity 公共设施解读：Recoverable/Unrecoverable 双轨异常体系与 Status 错误码、AnalyzerPool 多语言分词器（cppjieba/sudachi/mecab/RAG）、SIMD 能力探测与单例模板"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/00-overview)

---

## 模块定位

`src/common/`（2.9 万行）是全库的横切层——但要先纠正一个常见误会：**类型系统不在这里**。`LogicalType`/`DataType`/`internal_types` 都在 `src/parser/type/`（见[SQL 解析器](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/03-sql-parser)），`Value` 在 `src/storage/column_vector/`。`src/common/` 真正承载的是四块基础设施：

1. **异常体系**（`utility/exception`）：`RecoverableError`/`UnrecoverableError` 两个全局函数 + 两个异常类——全库 god node（`UnrecoverableError` 2,444 个调用点/352 个文件，`RecoverableError` 826 个/201 个）。
2. **Status**（`status.cppm`）：~180 个错误码、~200 个静态工厂，跨语言契约（Python SDK 的 `errors.py` 需同步）。
3. **多语言分词器**（`analyzer/`）：standard/中文（cppjieba）/日文（sudachi）/韩文（mecab）/ngram/RAG/ik/rank_features 等，全文检索的分词层。
4. **杂项**：SIMD 能力探测、`Singleton` CRTP 模板、parallel-hashmap 封装、TOML 解析、内存追踪。

---

## 模块架构

```text
src/common/
├── utility/exception.cppm/_impl   双轨异常（RecoverableException/UnrecoverableException）
├── status.cppm/_impl              错误码 + 静态工厂（9 大组 ~180 码）
├── analyzer/                      分词器族
│   ├── analyzer_pool.cppm/_impl   flyweight 池（词典只加载一次）
│   ├── standard_analyzer          Snowball 词干化（15 种语言后缀）
│   ├── chinese_analyzer           cppjieba（CutGrain 粗/细两模式）
│   ├── japanese_analyzer / korean_analyzer   sudachi / mecab
│   ├── ngram_analyzer / rag_analyzer / ik / rank_features_analyzer
│   └── stemmer/ darts_trie/      词干化内核 + 双数组 trie
├── simd/                          CPUID 探测 + HNSW/BM25 距离内核选择
├── singleton.cppm                 CRTP Meyers 单例模板
├── analyzer.cppm                  Analyzer 基类（模板方法骨架）
└── memory/ blocking_queue/ parallel_hashmap/ toml/ ...
```

---

## 调用链路

### 异常双轨：抛出 → 转换回 Status

```cpp
// exception_impl.cpp:55-89
void RecoverableError(Status status, const char *file_name, u32 line) {
    status.AppendMessage(fmt::format("@{}:{}", TrimPath(file_name), line));  // 位置编进消息
    LOG_ERROR(status.message());
    throw RecoverableException(status);      // 内嵌结构化 Status
}
void UnrecoverableError(const std::string &message, const char *file_name, u32 line) {
    PrintTransactionHistory();               // 遍历 NewTxnManager 历史（依赖倒挂，见下）
    if (GetPrintStacktrace()) PrintStacktrace(location_message);   // std::stacktrace
    Logger::Flush();
    throw UnrecoverableException(location_message);
}
```

`file_name`/`line` 由 `std::source_location::current()` 默认参数自动注入。捕获端把异常还原：`FragmentTask::OnExecute` 捕获 `RecoverableException` 还原为 `Status` 回填客户端错误码（`fragment_task_impl.cpp:95-104`）；`QueryContext` 捕获 `UnrecoverableException` 后 `raise(SIGUSR1)` 自杀取 core（`query_context_impl.cpp:307-310`）。`GetErrorMsg` 用 `find_first_of('@')` 剥掉 `@file:line` 后缀取纯消息——`@` 是消息与位置的协议分隔符。

一个值得指出的架构坏味道：`infinity_exception` 是 `infinity_core` 的分区且**依赖倒挂**——异常模块 import `:new_txn_manager`/`:txn_context`（`exception_impl.cpp:20-21`）以便 Unrecoverable 时打印事务历史。公共设施反向依赖存储层，是最典型的 god-node 症状；改事务模块接口时这里会被一起牵动。

### 分词流程（text → terms）

```cpp
// analyzer.cppm —— 模板方法骨架
int Analyze(const Term &input, TermList &output) {
    void *array[2] = {&output, this};
    return AnalyzeImpl(input, &array, &Analyzer::AppendTermList);   // 钩子函数指针
}
```

中文实现（`chinese_analyzer_impl.cpp:107-132`）：`jieba_->Cut(input, cut_words_, true)`（粗粒度）或 `CutForSearch`（搜索引擎细粒度），`NextToken` 时查 `stopwords_` set 过滤停用词。英文（`standard_analyzer.cppm:32-66`）：`tokenizer_.Tokenize` → `DoNext()` 跳过分隔符 → `stemmer_` 词干化。调用方三处：`column_inverter_impl.cpp`（索引写入分词）、`search_driver_impl.cpp`（查询分词）、`index_full_text_impl.cpp`（DDL 取列的 analyzer）。

### AnalyzerPool：为什么做成池

cppjieba 中文词典、sudachi/mecab 日韩词典体积大且 `Load()` 慢（数百 MB 级）。`AnalyzerPool`（CRTP 单例）为每语言缓存一个已加载**原型**，`GetAnalyzer` 用拷贝构造产出新实例（`analyzer_pool_impl.cpp:74-103`）——词典只加载一次（flyweight），实例状态（`cut_words_` 游标）每份独立（单实例非线程安全）。语言分发用编译期字符串 hash switch（`constexpr u64 Str2Int` FNV-1a 变体 + `case Str2Int(CHINESE.data())`）。

### SIMD：能力探测 + 函数指针注册表

`simd_init.cppm` 的 `Get_HNSW_F32L2_ptr()` 等返回按 CPUID 选定的 AVX2/AVX512 实现（探测在 `NGT_CpuInfo_SimdType.h`）。这套注册表服务 HNSW/DiskANN/EMVB/BM25 各索引族的运行时分派（标量函数不经过它，见[函数库](/vibe-reading/articles/Database/VectorSearch/Infinity/CodeWiki/0.7.3/06-functions-expressions)）。`infinity_main.cpp:246` 启动时打印 `GetSupportedSimdTypesList()`。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|---|---|---|
| `RecoverableError` | `exception_impl.cpp:55` | Status + 位置 → 抛可恢复异常 |
| `UnrecoverableError` | `exception_impl.cpp:73` | stacktrace + 事务历史 → 抛不可恢复异常 |
| `GetErrorMsg` | `exception_impl.cpp:63` | 剥 `@file:line` 后缀 |
| `AnalyzerPool::GetAnalyzer` | `analyzer_pool_impl.cpp:74` | 原型拷贝构造新分词器 |
| `Analyzer::Analyze` | `analyzer.cppm` | 模板方法：Parse + NextToken |
| `ChineseAnalyzer::NextToken` | `chinese_analyzer_impl.cpp` | jieba 切词 + 停用词过滤 |
| `Singleton<T>::instance` | `singleton.cppm:20` | CRTP Meyers 单例 |

</details>

---

## 核心实现

### RAG analyzer：RAGFlow 分词器的 C++ 移植

`rag_analyzer.cppm:33-34` 注释明示它是 RAGFlow `rag/nlp/rag_tokenizer.py` 的 C++ 移植——组合 DartsTrie 双数组词典 + `MaxForward`/`MaxBackward` 双向匹配 + `DFS` 打分选最优切分 + WordNetLemmatizer + Stemmer + OpenCC 繁转简 + RE2 正则 + 停用词过滤。它**不是"关键词+向量混合检索"本身**，而是为混合检索的 BM25/FTS 侧提供高质量分词（fine-grained 开关对应 RAGFlow 的细/粗粒度切分），检索融合由 FusionExpression 完成。v0.7.3 还加了 RAGFlow 兼容的中文停用词表与 language-aware stemming（PR #3381/#3356）。

### Status：跨语言错误码契约

`ErrorCode` 枚举 9 大组（config 1xxx / auth 2xxx / syntax 3xxx / txn 4xxx / resource 5xxx / query 6xxx / system 7xxx / internal 8xxx / catalog 9xxx），~200 个静态工厂（`Status::DBNotExist(db_name)` 等）。`status.cppm:22` 注释明示新增错误码须同步 `python/infinity/errors.py`——thrift 协议的错误码是跨语言契约。`Status::OK()` 是 Null Object（`code_=kOk, msg_=nullptr`，`ok()` 双条件），错误路径零分配。

### 异常双轨的语义边界

- `RecoverableError(Status)` 携带结构化 ErrorCode，可被还原为 Status 返回客户端（RPC 错误码）——**可重试或可告知**的错误：语法错、表不存在、TxnConflict。
- `UnrecoverableError` 是断言式：打 stacktrace + 事务历史 + 自杀，因为**不变量破坏后进程状态不可信**——内部 bug 与其带病运行产出错误数据，不如快死快重启。

这个边界贯穿全库：所有 `Status::Xxx()` 工厂在业务代码里几乎都经 `RecoverableError` 抛出，而 `UnrecoverableError` 多出现在 `UnrecoverableError("Not support")`（未实现的 switch default）与不变量断言处。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Flyweight + Prototype | `AnalyzerPool` 原型缓存 + 拷贝构造 | 大词典只加载一次 |
| 模板方法 | `Analyzer::Analyze` 骨架 + `AnalyzeImpl` 钩子 | 分词管线复用 |
| 编译期字符串 hash switch | `analyzer_pool_impl.cpp:40-47` | 字符串分派编译成常量比较 |
| 单例（CRTP） | `common/singleton.cppm:17` | AnalyzerPool/CastTable 等共用 |
| Null Object | `Status::OK()` | 错误路径零分配 |
| 静态工厂 | `Status::Xxx()` ~200 个 | 错误码与消息集中管理 |
| 能力探测 + 函数指针注册表 | `simd_init.cppm` | 索引内核按 CPU 选 SIMD |

---

## 模块间交互

实测 import 统计：`import internal_types` **622 处**（在 parser/type，但常见误记在 common）、`:infinity_exception` + `:status` 合计 **1,147 处**、`import infinity_core`（整模块）仅 **2 处**——所有使用方都 import 细粒度分区或独立小模块，这是刻意的编译防火墙设计。analyzer 被 `storage/invertedindex`（写入/查询分词）与 `storage/definition`（DDL analyzer 名）消费；SIMD 注册表被 knn_index 各族消费。

---

## 扩展方式

**新增一种语言分词器**（4-5 个文件）：新建 `analyzer/xxx_analyzer.cppm/_impl.cpp`（继承 `CommonLanguageAnalyzer` 实现 `Parse/NextToken/IsAlpha/IsSpecialChar`，参照 `standard_analyzer.cppm`）→ `analyzer_pool.cppm:37-47` 加名字常量 → `analyzer_pool_impl.cpp:70` 的 hash switch 加 case（含原型缓存块，词典从 `Config->ResourcePath()` 加载）→ CMakeLists 注册。倒排索引模块**零改动**（`ColumnInverter::InitAnalyzer` 按名查找）。

**新增错误码**：`status.cppm` 枚举 + 工厂声明 → `status_impl.cpp` 工厂实现 → **同步 `python/infinity/errors.py`**（源码注释明示的跨语言义务，漏掉则 Python SDK 无法识别新错误）。
