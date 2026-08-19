---
source:
  type: "源码解读"
  project: "SearchCLI"
  url: "https://github.com/volcengine/SearchCLI"
title: "搜索调优引擎"
date: "2026-08-19T17:42:29+08:00"
category: ["AI", "Agent", "Search", "SearchCLI", "CodeWiki", "0.2.0"]
tags: ["SearchCLI", "TypeScript", "LLM-as-a-Judge", "NDCG", "Search Tuning"]
description: "SearchCLI 搜索调优引擎——从 query 生成、LLM 相关性判定到策略生成与场景应用的全流水线。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/00-overview)

---

## 模块定位

搜索调优引擎（`src/core/search-tuning/`，14 个文件、约 3747 行）是 SearchCLI 最具技术含量的子系统：它把"搜得准不准"这个模糊问题变成可量化的流水线——生成测试 query → 执行检索 → 用 LLM 做 pointwise 相关性判定 → 计算 NDCG/MRR/Precision 指标 → 生成调优策略 → 应用到搜索场景。对应 `vs search tune query-generate|plan|run|apply|report|compare|validate|llm-check` 命令组。它独立成文是因为它内部有一套完整的 pipeline 编排、worker pool 并发、checkpoint 断点续传和跨 run 共享的 label cache，职责边界清晰——它消费检索能力但不实现检索，只评估和调参。

## 模块架构

![调优流水线架构](/vibe-reading/images/articles/searchcli-internals/tuning-pipeline.svg)

调优引擎内部是一条线性管道 + 两个旁路。线性管道是 `runSearchTuning()` in `src/core/search-tuning/runner.ts:64` 编排的七阶段：setup → search → label(judge) → metrics → write report，对应 `vs search tune run` 的执行过程。两个旁路：**LabelCache**（跨 run 共享的 LLM 判定缓存，`label-cache.ts`）挂在 label 阶段，cache-aside 模式——先查 cache miss 才调 LLM；**Checkpoint**（每批搜索/每 100 个 label 写一次）挂在 search 和 label 阶段，支持 `--resume-run-id` 断点续跑。`types.ts` 定义全模块数据模型（`TuningQuery`/`TuningStrategy`/`JudgeLabel`/`QueryMetrics`/`StrategyMetrics`/`TuningRunReportShape`）。`strategy-generator.ts` 和 `apply.ts` 分别在管道两端：前者生成候选策略矩阵，后者把推荐策略转成线上 scene 配置。

## 调用链路

`vs search tune run --application-id 123` 的调用链：

1. `src/commands/search/tune/run.ts` → `runSearchTuneRunCommand()` in `src/app/search-tuning-commands.ts` → `inspectTuningContext()`（推断 datasetId、拉样本、取字段配置）→ `runSearchTuning()` in `src/core/search-tuning/runner.ts:64`。
2. **Setup**（`runner.ts:75`）：`createNewRunSetup()` in `runner.ts:692` 调 `resolveQueries()`（加载或生成 query）→ `generateTuningStrategies()`（matrix/SPA 生成候选）→ `summarizeStrategyCoverage()`；加载 `LabelCache`；算 `judgeProfileHash`。
3. **Search**（`runner.ts:182`）：`buildPendingSearches()` 生成 strategy×query 笛卡尔积（跳过已完成的），按 `searchConcurrency` 分批 `Promise.allSettled` 并发 `client.search()`（`VikingSearchClient`），每批写 checkpoint。
4. **Label**（`runner.ts:282`）：source-item 模式 `materializeSourceItemLabels()` in `runner.ts:826` 不调 LLM 直接匹配；llm 模式 `buildPendingLabels()` 去重后 `runLabelWorkers()` in `runner.ts:973` worker pool 并发 `judgeRelevance()`，超 `maxLabelFailureRate`（默认 1%）抛错提示 `--resume-run-id`。
5. **Metrics**（`runner.ts:458`）：`computeStrategyMetrics()` 算各策略指标 → `chooseRecommendedStrategy()` 选最优。
6. **Write**（`runner.ts:497`）：写 rankings.jsonl/labels-used.jsonl/metrics.json/recommendation.json/report.json/report.md 等，run-state 置 `completed`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runSearchTuning()` in `src/core/search-tuning/runner.ts:64` | 编排全流水线 | setup→search→label→metrics→write，每阶段 checkpoint |
| `generateTuningQuerySet()` in `query-generator.ts:50` | LLM 生成测试 query | 滑动窗口采样 + 防重 + retrievableFieldOnly 排除图片字段 |
| `judgeRelevance()` in `judge.ts:66` | LLM pointwise 相关性判定 | 4 级评分，judgeProfileHash 进 cache key，换 prompt/model 自动失效 |
| `computeStrategyMetrics()` in `metrics.ts:6` | 算 NDCG/MRR/Precision | NDCG@20 为主排序键（覆盖更多结果位） |
| `generateTuningStrategies()` in `strategy-generator.ts:13` | 生成候选策略 | optimizer 选 matrix（笛卡尔积）或 SPA（空间填充采样） |
| `buildSceneApplyDraft()` in `apply.ts:28` | 推荐策略转 scene 配置 | snake_case→PascalCase，unappliedRequestParams 标记 request-only 参数 |
| `buildLabelCacheKey()` in `label-cache.ts:41` | 5 维 cache key | dataset+query+item+item_view+judge_profile hash |

</details>

## 核心实现

### Query 生成与 LLM 判定

`generateTuningQuerySet()` in `src/core/search-tuning/query-generator.ts:50` **用 LLM 生成测试 query**，不是模板法。流程：`inspect.ts` 的 `loadDatasetSamples()` 通过 `VikingRuntimeApiClient.dataList()` 拉数据集样本（默认 20 条）→ 按 `batchSize`/`llmConcurrency` 并发调 `requestChatCompletion()`，用 `QUERY_GENERATION_PROMPT`（`query-generator.ts:10`）让 LLM 返回 JSON 数组（每条含 id/text/type/intent/sourceItemIds，type 取 `title_rewrite`/`category`/`attribute_combo`/`scenario_need`/`vague_natural_language`）→ `parseJsonResponse()` 解析 → `normalizeQuery()` 标准化 → 循环到 `requestedQueryCount`。每批传不同 item 样本窗口 + 最近 50 条已生成 query 防重。`retrievableFieldOnly` 模式只保留 `textRetrievableFields` 定义的字段、排除 image 字段，防止 LLM 把图片 URL 当文本属性。

`judgeRelevance()` in `src/core/search-tuning/judge.ts:66` 是 **pointwise LLM-as-a-judge**：两套 prompt（`TEXT_JUDGE_PROMPT` 纯文本、`TEXT_IMAGE_JUDGE_PROMPT` 多模态），4 级评分（3=高度相关，2=相关，1=弱相关，0=不相关），输出 `{grade, confidence, reason}`。`buildItemJudgeView()` in `judge.ts:53` 从 `SearchResultItem` 构造 judge view——按优先级选 12 个关键字段、超长截断到 600 字符；text-image 模式 `extractImageUrlsFromFields()` 从 imageIndexFields 提图片 URL（支持嵌套 `.` 路径和数组展开）。关键设计：`buildJudgeProfileHash()` in `judge.ts:37` 对 prompt 内容、judgeInput 类型、imageIndexFields（排序）、maxJudgeImages、model 名称做 SHA256，纳入 cache key——**换 prompt 或 model，hash 变，cache 自动失效**，避免旧判定污染新评估。

### 指标计算与策略推荐

`computeStrategyMetrics()` in `src/core/search-tuning/metrics.ts:6` 计算指标：NDCG@K（`ndcgAtK()` in `metrics.ts:58`，用 `discountedGain()` = `(2^grade - 1)/log2(index+2)`，ideal 排序取所有 label 的 grade 降序，算 @10 和 @20）、MRR@10（`reciprocalRankAtK()` in `metrics.ts:65`，首个 grade≥2 的 `1/(rank+1)`，截断 top-10）、Precision@10（`precisionAtK()` in `metrics.ts:74`，top-10 中 grade≥2 比例）、Zero Result Rate、Latency。`chooseRecommendedStrategy()` in `metrics.ts:27` 用 `compareStrategyMetrics()` 排序：按 `averageNdcgAt20` 降序 → 平局 `averageNdcgAt10` → 再平局 `averageMrrAt10` → 最后 `averageLatencyMs` 升序（同质量选更快的）。**NDCG@20 是主排序键而非 @10**，因为 @20 覆盖更多结果位置更能区分策略优劣。

### 策略生成与 Apply

`generateTuningStrategies()` in `src/core/search-tuning/strategy-generator.ts:13` 按 `optimizer` 选两种生成方式：**matrix 优化器** `generateSimilarityOnlyStrategies()` 固定 2 个 baseline（keyword-only/semantic-only）+ 3 参数笛卡尔积（`denseWeights=[0,0.25,0.5,0.75,1]`、`keywordMatchPercents=[0,0.3,0.5,0.7]`、`maxRetrievedNums=[50,100,200]`）+ 单维度扫描，去重截断到 maxStrategies；**SPA 优化器** `generateSpaStrategies()` 先放 8 个精选种子，再以 5 个 center 点为中心、2 个 ring（粗调 delta=0.25/50/0.3、细调 delta=0.1/25/0.1）做 6 方向变体，模拟空间填充采样。`buildSceneApplyDraft()` in `src/core/search-tuning/apply.ts:28` 把推荐策略转线上 `PerDatasetConfig`——`buildPerDatasetConfig()` in `apply.ts:85` 把 `searchDynamic` 的 snake_case 映射为 PascalCase scene 字段（Mode/QueryKeywordMatchPercent/UserDefinedRecallMode/DenseWeight 等），`unappliedRequestParams` 标记 request-only 参数（如 `disable_personalize`）不持久化。实际创建由 `search-tuning-commands.ts` 调 `VikingOpenApiClient` 走 `CreateSearchSceneV2` → `PublishSearchSceneV2` → `GetSearchSceneV2` 三步。

### Label Cache 与断点续传

`hash.ts` 的 `sha256Hex()` + `stableStringify()`（递归排序 object keys、过滤 undefined）保证 cache key 确定性——相同内容无论 key 顺序都产生相同 hash。`label-cache.ts` 缓存 LLM 判定结果（`JudgeLabel`），`loadLabelCache()` in `label-cache.ts:15` 从 JSONL 加载到 `Map<cache_key, JudgeLabel>`（ENOENT 静默返回空 Map），`appendLabel()` 先更新内存 Map 再 appendFile。`buildLabelCacheKey()` in `label-cache.ts:41` 是 5 维 key：`dataset_id`（数据集隔离）+ `query_hash`（query text+intent）+ `item_id` + `item_view_hash`（item 展示内容 hash，内容变则失效）+ `judge_profile_hash`（prompt+model，换则失效）。**cache 文件在 `.viking/search-tuning/cache/labels.jsonl`，不按 runId 隔离，多个 run 共享**，最大化 LLM 调用复用。Checkpoint 贯穿 search 和 label 阶段——`completedRankingKeys` Set 去重已完成搜索、`labelsUsed` Map 去重已判定标签，每批/每 100 个 label 写一次 checkpoint，中断后 `--resume-run-id` 从磁盘恢复。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 管道/流水线 (Pipeline) | `runSearchTuning()` in `src/core/search-tuning/runner.ts:64` | setup→search→label→metrics→write 线性管道，每阶段有 checkpoint |
| 策略 (Strategy) | `generateTuningStrategies()` in `strategy-generator.ts:13` | optimizer 选 matrix 或 SPA 策略生成算法 |
| Worker Pool | `runLabelWorkers()` in `src/core/search-tuning/runner.ts:973` | N worker 从共享 nextIndex 拉取并发判定，支持 retry + checkpoint |
| Checkpoint/Resume | `writeSearchCheckpoint()` + `loadExistingRunSetup()` | 每批写 checkpoint，`--resume-run-id` 恢复 |
| Cache-Aside | `label-cache.ts` + `buildPendingLabels()` | 先查 cache miss 才调 LLM，结果写回 cache |
| Progress Observer | `TuningProgressEvent` + `onProgress` | 分阶段进度通知，CLI 层输出到 stderr |

## 模块间交互

被 `src/app/search-tuning-commands.ts`（547 行分发层，对应 7 个 `vs search tune` 子命令）调用。依赖 core 的 `llm-client`（`requestChatCompletion`/`parseJsonResponse`，query 生成和 judge 用）、`search-client`（`VikingSearchClient.search()` 执行检索）、`runtime-api-client`（`dataList()` 拉样本）、`openapi-client`（`GetAppDataConfig`/`CreateSearchSceneV2`/`PublishSearchSceneV2`）、`app-status`（推断 datasetId）、`service-config`/`config`、`files`、`search-mode`（枚举转换）、`output-format`。无循环依赖。

## 扩展方式

新增评估指标（如 Recall@K）：改 4 处——`types.ts` 在 `QueryMetrics`/`StrategyMetrics` 加字段；`metrics.ts` 新增 `recallAtK()` + 在 `computeQueryMetrics()` 调用；`report.ts` 的策略表格加列；`compare.ts` 的 `RunComparisonRow`/`buildRunComparisonRow()` 加字段。更换 LLM judge prompt：仅改 `judge.ts` 的 `TEXT_JUDGE_PROMPT` 常量——`buildJudgeProfileHash()` 自动把新 prompt hash 纳入 cache key，旧 cache 自动失效，无需手动清理；若改评分尺度还需同步 `clampInteger(grade,0,3)` 上限和 `metrics.ts` 中 grade≥2 阈值。新增 optimizer（如 grid-search-v2）：`types.ts` 的 `TuningStrategyOptimizer` 加值；`strategy-generator.ts` 的 `SEARCH_TUNING_OPTIMIZERS` 加项 + `generateTuningStrategies()` 加分支 + 实现 `generateXxxStrategies()`；`plan.ts`/`runner.ts`/命令层自动适配（strategies 来自 `generateTuningStrategies()`）。
