---
source:
  type: "源码解读"
  project: "MatrixOne"
  url: "https://github.com/matrixorigin/matrixone"
title: "AI 原生检索"
date: "2026-09-20T19:33:49+08:00"
category: [Database, HTAP, MatrixOne, CodeWiki, "4.1.4"]
contentType: "CodeWiki"
tags: ["MatrixOne", "Go", "向量检索", "HNSW", "全文检索", "BM25"]
description: "MatrixOne AI 检索模块解读：indexplugin 插件契约、IVF/HNSW/GPU 检索链、jieba+BM25 全文倒排与 iscp 增量同步。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/00-overview)

---

## 模块定位

`pkg/vectorindex/`（约 1.9 万行）+ `pkg/fulltext/` + `pkg/monlp/` + `pkg/cuvs/`（GPU 绑定）+ `pkg/iscp/`（增量同步协议）构成 MatrixOne 的 AI 原生检索能力：向量索引（IVF-Flat / IVF-PQ / HNSW / CAGRA，CPU usearch 与 GPU cuVS 双路径）与全文检索（中文 jieba 分词 + BM25 打分）。它在架构上是 plan 层的"被插件方"与 colexec 的表函数实现方——检索算法集合高频迭代（新算法、新参数、GPU 支持轮番落地），插件化把这片快变区与优化器主体隔离。

## 模块架构

![AI 检索插件架构](/vibe-reading/images/articles/matrixone-internals/vector-fulltext-arch.svg)

```go title="pkg/indexplugin/plugin.go — 算法插件契约"
type AlgoPlugin interface {
    Algo() string                          // 对应 INDEX ... USING <algo>
    Catalog() catalogplugin.Hooks          // 隐藏表 schema、类型约束、session 变量
    Compile() compileplugin.Hooks          // HandleCreateIndex/HandleReindex/HandleDropIndex
    Plan() planplugin.Hooks                // CanApply / ApplyForSort（ANN 改写）
    Idxcron() idxcronplugin.Hooks          // 定时重建门槛
}
```

运行期统一抽象是 `cache.VectorIndexSearchIf`（`pkg/vectorindex/cache/cache.go`：`Search/SearchFloat32/Load/UpdateConfig/Destroy`），全局单例 `Cache *VectorIndexCache`（TTL 5 分钟）。CPU 算法经 `all/all.go` blank import 注册（fulltext/hnsw/ivfflat），GPU 算法经 `all/all_gpu.go`（`//go:build gpu`：cagra/ivfpq）。

注册表细节（`pkg/indexplugin/plugin.go`）：`Register` 对**重复注册直接 panic**（"duplicate registration for algo"，init 期就暴露冲突）；`Get`/`IsVectorIndexAlgo` 都经 `normalize`（`ToLower + TrimSpace`，plugin.go:135）归一化算法名；`IsVectorIndexAlgo('fulltext')` 返回 **false**——它先排除 fulltext 再查注册表（:107-111），fulltext 走独立的 `IsFullTextIndexAlgo`，SQL 层对两种索引的改写路径完全不同。

> 勘误：早先资料提到的 `VectorIndexFW` 统一抽象在 v4.1.4 不存在；实际就是 `VectorIndexSearchIf` + `AlgoPlugin` 两层。

## 调用链路

**向量检索**：`ORDER BY l2_distance(embedding, q) LIMIT k` → `pkg/sql/plan/apply_indices.go` 的 `buildVectorSortContext` + `collectVectorIndexes` → `indexplugin.Get(algo).Plan().ApplyForSort` → `applyIndicesForSortUsingHnsw`（apply_indices_hnsw.go:123）改写为 `FUNCTION_SCAN(hnsw_search) ⋈ INNER JOIN(pk=pk) → SORT/LIMIT`（limit 下推 + 有过滤时 over-fetch，`calculatePostFilterOverFetchFactor`）→ 运行时 `colexec/table_function/hnsw_search.go` 的 `newHnswAlgoFn` + `veccache.Cache.Search`（:246）→ `HnswSearch.Search` 用 `ThreadPoolExecutor` 并行搜多个子索引、`SearchResultSafeHeap` 归并，距离经 `metric.DistanceTransformHnsw` 还原。

**Build**：compile hooks `HandleCreateIndex` → `genBuildSQL` → `hnsw_create` 表函数流式调 `HnswBuild.Add`（channel + worker 池），容量满 rollover `SaveToFile`，`ToInsertSql` 把索引文件按 chunk INSERT 进隐藏 metadata/index 表；加载时 `LoadIndexFromBuffer`（hnsw/model.go:422）流式写临时文件 + `fallocate` + usearch `View()` mmap。

**全文检索**：`fulltext_match()` → `applyIndicesForProjectionUsingFullTextIndex` → `fulltext_index_scan` 表函数（colexec/table_function/fulltext.go）→ `ParsePattern`（boolean/NL 双模式，jieba 分词）→ `PatternToSql`（fulltext/sql.go，含 `SingleKeywordTopKBM25SQL`/`PhraseTopKBM25SQL` 下推 top-k）对倒排隐藏表 `(doc_id, pos, word, __mo_pk_rowid) clustered by word` 执行 SQL → `SearchAccum.Eval`/`Pattern.Eval` 计算 BM25。Build 走 `INSERT INTO 隐藏表 SELECT ... CROSS APPLY fulltext_index_tokenize(...)`（fulltext/plugin/compile/compile.go:37）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `indexplugin.Get(algo).Plan().ApplyForSort` | ANN 改写分发 | 插件单一真源 |
| `applyIndicesForSortUsingHnsw`（apply_indices_hnsw.go:123） | HNSW 计划改写 | 表函数 + join + over-fetch |
| `veccache.Cache.Search`（cache.go） | 共享缓存检索 | TTL + sync.Cond 并发首载 |
| `HnswBuild.Add/SaveToFile`（hnsw/build.go） | 流式构建 | channel + rollover |
| `LoadIndexFromBuffer`（hnsw/model.go:422） | mmap 加载 | 移出 Go heap 消 GC 压力 |
| `ParsePattern`（fulltext.go） | 全文查询解析 | jieba 双模式 |
| `PatternToSql`（fulltext/sql.go） | 生成倒排表 SQL | BM25 top-k 下推 |
</details>

## 核心实现

### GPU 注册用 build tag 而非运行时探测

`all_gpu.go` 的注释给出理由：CPU 二进制上注册 cagra 会让 CREATE INDEX 在隐藏表已建、DELETE 已跑之后才失败——提前在 plan 层报 "unsupported index type" 避免 DDL 半途副作用。这是"能力探测要在副作用前"的典型工程化处理。

### 索引文件存 SQL 隐藏表而非本地 fileservice

`HnswModel.ToSql/LoadIndexFromBuffer` 把索引数据 chunk 化存进隐藏表——索引数据随事务与副本复制走，CN 保持无状态；加载时经临时文件 + usearch `View()` mmap，把多 GB 索引移出 Go heap（源码注释原话）。

### jieba 双模式分词与字典解析

build 用 `useHmm=false`（词典分词，跨部署可复现），query 用 `true`（HMM 新词发现扩大召回）——因此 `SharedJiebaTokenizer`（jieba.go）维护 **HMM/非 HMM 两个 `sync.Once` 单例**；初始化失败后错误被缓存**不再重试**（字典缺失属于环境问题，重试无意义）；对共享单例调用 `Free()` 直接 return（生命周期归进程管理）。字典目录解析四级（jieba_dict.go 的 `resolveJiebaDictDir`）：`MO_JIEBA_DICT_DIR` 环境变量 → `<exe>/dict` → `<exe>/../share/matrixone/jieba` → 源码文件旁 `dict`；`newJiebaChecked` 先 stat 五个字典文件，把 cgo panic 转成返回错误。且 ASCII span 先交给 `SimpleTokenizer`——gojieba 对无词典英文词会退化成单字。

### 评分算法：BM25 的 idf 复用 TF-IDF

`GetScoreAlgo`（fulltext.go:1102）读系统变量 **`ft_relevancy_algorithm`**（types.go:32），值为 `"BM25"` 时用 `ALGO_BM25`，**未配置或其他值一律默认 `ALGO_TFIDF`**；BM25 分支的 idf 注释明言 "use old tfidf algo"（:218）——`log10(Nrow/nmatch)` 后平方，与 TF-IDF 同源；`EvalLeaf`（:192）中词频为 0 时返回空 `[]float32{}` 而非 nil（"never return nil result"，下游按切片处理）。BM25 参数 `BM25_K1=1.5`、`BM25_B=0.75`（fulltext/types.go）。

### Cache + TTL 的共享索引

cache.go 头注释："index model is huge… 不可能为每个用户整载入内存"。机制细节：`VectorIndexCacheTTL = 5 分钟`，`NewVectorIndexCache` 设 `TickerInterval = TTL/2`（cache.go:170）；`HouseKeeping`（:214）删除满足 **`Expired()`（超 TTL）或 `Outdated.Load()`（被标记过期）** 两种条件之一的条目并 `Destroy`；每次 Search/Load 访问会把条目的 `ExpireAt` 续期到 `now + TTL`（:124）。并发首载用 `sync.Cond`——且 **`Cond` 用 `Mutex.RLocker()` 创建**（:259-260 注释：让 `Cond.Wait()` 走 RLock，等待者不阻塞读锁）；`Search` 遇 `ErrInvalidState`（条目刚被 Destroy）时无限 for 重试——缓存条目的销毁与重建是常态，重试比报错更符合语义。

### HnswBuild 的并发错误传播与 rollover

`recordWorkerErr` 用 `sync.Once` 实现 **first-error-wins**（首个 worker 错误 close stopped channel，让所有 worker 尽快退出，后续错误不再覆盖）；`Add` 在 add_chan 满时 select `stopped` 已关闭则返回 `WorkerErr()`。rollover（索引满滚动新文件）时 `addVectorSync` 先 `save_idx.inflight.Wait()` 再 `SaveToFile()`——**inflight WaitGroup 保证写线程全部退出后才持久化**，不会持久化部分索引、也不会销毁仍在被写入的 usearch 索引（`getIndexForAdd` 协调）。并发 add 的 two-pass 修复引自 MatrixOne #24849 / usearch #735——并发曾产生孤儿节点导致 recall 抖动，上游修复后恢复多线程。

### iscp：每 (表, job) 独立水位的增量同步

框架 `iteration.go ExecuteIteration → CollectChanges → IndexConsumer`（fulltext/ivfflat 产出 SQL 直接执行；hnsw/cagra/ivfpq 产出 CDC JSON blob 由算法自管 Update+Save，iscp/hooks.go:34）——框架只管水位与调度，算法差异封装在产出物形态里。日志表 `mo_iscp_log`（catalog/types.go:181）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 插件注册表 | `plugin.Register/Get` + all.go blank import | 算法集合单一真源，消除 drift |
| 共享缓存 | `VectorIndexCache` TTL + HouseKeeping | 大对象跨会话复用 |
| 流式 build/load | add_chan worker 池 + inflight WaitGroup | rollover 安全 |
| 零分配 Top-K | 泛型 SoA `FastMaxHeap[T,K]`（vectorindex/index.go） | 热路径免分配 |
| 预过滤检索 | `usearchex.FilteredSearchUnsafeWithMembership`（cgo 谓词桥接 docfilter bloom/cbitmap） | 带过滤条件的 ANN |

## 模块间交互

plan 层经 `plugin_builder.go` 的 `toPlanplugin/fromPlanplugin` 转换内外类型；compile 层各 `<algo>/plugin/compile/compile.go`；执行层 `table_function.go:179` 分发 `hnsw_search` 等表函数；另有一条块内路径——`tae/blockio/read.go:388` 的 `HandleOrderByLimitOnIVFFlatIndex` 在 block 读取期用嵌入索引/内联暴力做 top-k。与 [Publication 与 Git for Data](/vibe-reading/articles/Database/HTAP/MatrixOne/CodeWiki/4.1.4/10-publication-git4data) 无直接耦合，但 iscp 的 watermark 模式与 CCPR 同构。

## 扩展方式

按 `pkg/indexplugin/all/all.go` 注释的 5 步模板新增向量索引算法：

1. `pkg/catalog` 加 `MoIndex<Foo>Algo` + parser 关键字
2. 拷 `pkg/vectorindex/ivfpq/plugin/` 实现四个 Hooks
3. `pkg/sql/plan/apply_indices_<foo>.go` 写 `applyIndicesForSortUsing<Foo>`/`prepare<Foo>IndexContext`
4. `all.go`（或 GPU 则 `all_gpu.go`）加一行 blank import
5. `test/distributed/cases/vector/` 加 SQL 用例

新增 tokenizer：实现 `monlp/tokenizer` 的 `Tokenizer.Tokenize(input []byte) iter.Seq2[Token, error]` → `fulltext/plugin/plan/schema.go` parser 白名单加名 → `fulltext.go` 的 `CreatePattern/ParsePatternInNLMode` 加分派 → `fulltext_tokenize.go` 表函数接线。新增打分算法：`fulltext/types.go` 扩 `FullTextScoreAlgo`（现 BM25/TF-IDF）→ `Pattern.Eval` 加分支 → `fulltext/sql.go` 加 TopK SQL 生成。

> 待核实：blockio 嵌入式 IVFFlat 索引的具体落盘格式细节（objectio IndexReaderTopOp 全链路未深读）；cagra build 参数与 `pkg/cuvs/cagra.go` 的完整映射只做了抽样确认。
