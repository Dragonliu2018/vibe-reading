---
title: "AI 数据库混合搜索入门实践"
source:
  type: "article"
  project: "OceanBase"
  url: "https://mp.weixin.qq.com/s/9V_ufyN-Jdsv_DwobwRdDQ"
  author: "OceanBase"
  site: "OceanBase 公众号"
date: "2026-08-04T15:00:00+08:00"
category: [Database, OceanBase, Official]
tags: ["OceanBase", "混合搜索", "Hybrid Search", "向量搜索", "全文搜索", "RRF", "RAG"]
description: "OceanBase 混合搜索支持在单条 SQL 中融合向量搜索、全文搜索与标量过滤，通过内置 RRF 等融合算法自动实现合并排序，以单一数据库架构替代向量库+搜索引擎的繁琐拼装。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [AI 数据库混合搜索入门实践](https://mp.weixin.qq.com/s/9V_ufyN-Jdsv_DwobwRdDQ) · **作者** OceanBase · **来源** OceanBase 公众号 · **转载** 2026-08-04

---


> **编者按**
>
> AI 时代，AI Infra 离不开向量搜索和全文搜索。在和很多 AI 开发者和 DBA 交流的过程中发现，很多 AI 团队（特别是做过 RAG 的团队）都会遇到同一个问题——向量搜索能召回语义相关的内容，但经常缺少精确信息；全文搜索能命中关键词，却容易漏掉同义表述。
>
> 很多团队的解决方案是用一个数据库做全文搜索，再用纯向量数据库做语义检索，最后在应用层写代码合并召回结果与 RRF 排序。这样一来，系统越拼越复杂，效果和性能未必符合预期，运维和排查问题的成本倒是先涨了上去。
>
> 为此，我们为大家整理出了一份 OceanBase 混合搜索的最佳实践，5 分钟看懂 OceanBase 的混合搜索如何使用，并学会如何参数调整，包含了使用混合搜索时需要考虑的方方面面。本文作者为 OceanBase 数据库产品经理祖诚、OceanBase 数据库文档工程师海芊，全文 9742 字，阅读约需 15 分钟。

OceanBase 混合搜索支持在单条 SQL 中融合向量搜索（语义）、全文搜索（关键词）与标量过滤（结构化条件），通过内置 RRF 等融合算法自动实现合并排序。

它以单一数据库架构替代了“向量库 + 搜索引擎”的繁琐拼装，性能更优的同时兼顾搜得全和搜得准。

![图 1](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-01.png)

Hybrid Search = 向量搜索 + 全文搜索 + 标量过滤，一条 SQL 完成，数据库内核自动融合排序。

```sql title="Hybrid Search 示例"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1, 0.2, 0.3, 0.4]",
      "k": 10,
      "filter": {
        "range": {"id": {"gte": 1, "lte": 10}}
      }
    },
    "query": {
      "match": {"title": "数据库优化"}
    },
    "rank": {
      "rrf": {"rank_constant": 60}
    },
    "size": 10
  }'
);
```



这条 SQL 同时做了四件事：

- **向量搜索**：通过 `knn` 找语义相近的文档
- **全文搜索**：通过 query.match 找关键词匹配的文档
- **标量过滤**：通过 knn.filter.range 限定 id 范围，仅对向量搜索结果做过滤
- **融合排序**：通过 rank.rrf 自动合并两路结果，输出最终排名

![图 2](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-02.png)

## 单一搜索的盲区

![图 3](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-03.png)

以一个 RAG 知识库为例，假设数据库中存储了以下文档：

![图 4](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-04.png)

当用户发起查询 “OceanBase 向量索引” 时：

![图 5](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-05.png)

关键词搜索会遗漏同义表述，语义搜索会遗漏精确术语，混合搜索才能兼顾“搜得全”和“搜得准”。

## 现有方案的局限

在实际落地混合搜索时，常见的方案有这些，各有其适用场景和局限：

![图 6](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-06.png)

这些方案的核心问题在于：

单拎出哪个搜索能力，看上去效果都是不错的。但各个搜索能力分散在不同系统中，难以在数据库内核层面完成统一索引构建和结果融合，融合和运维的代价极高。

## Hybrid Search 的价值

Hybrid Search 在数据库内核层面统一多模态搜索能力。

![图 7](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-07.png)

![图 8](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-08.png)

## 创建堆表

Hybrid Search 仅支持堆表（ORGANIZATION HEAP）。建表时声明向量列（`VECTOR`）、JSON 列和 Array 列，用于存储多模态数据：

```sql title="创建堆表"
CREATE TABLE articles(
id INT,
title VARCHAR(255),              -- 文本标题，用于全文搜索
content TEXT,                    -- 文本内容，用于全文搜索
embedding VECTOR(4),            -- 向量列，维度与示例数据保持一致（生产环境根据 embedding 模型调整）
title_embedding VECTOR(4),      -- 向量列，维度与示例数据保持一致（生产环境根据 embedding 模型调整）
tags JSON,                      -- JSON 标签，用于标量过滤
categories ARRAY(VARCHAR(100))  -- 数组分类，用于标量过滤
) ORGANIZATION = HEAP;
```



![图 9](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-09.png)

## 创建索引

为需要搜索的列创建对应索引。向量搜索需要向量索引（推荐 HNSW_SQ，在内存与性能间取得平衡），全文搜索需要全文索引，JSON/Array 列的过滤建议创建 Search Index 加速：

```sql title="创建索引"
-- 向量索引：用于语义相似度搜索
CREATE VECTOR INDEX idx_embedding ON articles(embedding)
WITH (distance = l2, type = hnsw_sq, lib = vsag);
CREATE VECTOR INDEX idx_title_embedding ON articles(title_embedding)
WITH (distance = l2, type = hnsw_sq, lib = vsag);

-- 全文索引：用于关键词匹配
CREATE FULLTEXT INDEX idx_title ON articles(title);

-- Search Index：加速 JSON/Array 列的标量过滤
ALTER TABLE articles ADD SEARCH INDEX idx_tags(tags);
ALTER TABLE articles ADD SEARCH INDEX idx_categories(categories);
```


## 插入示例数据

准备几条测试数据，包含不同主题的机器学习相关文章：

```sql title="插入示例数据"
INSERT INTO articles VALUES
(1, 'Machine Learning Basics', 'Introduction to machine learning algorithms and concepts',
'[0.1, 0.2, 0.3, 0.4]', '[0.1, 0.2, 0.3, 0.4]',
'{"level": "beginner", "topic": "ml"}', ARRAY('AI', 'ML'));

INSERT INTO articles VALUES
(2, 'Deep Learning Guide', 'Comprehensive guide to neural networks and deep learning',
'[0.15, 0.25, 0.35, 0.45]', '[0.15, 0.25, 0.35, 0.45]',
'{"level": "advanced", "topic": "dl"}', ARRAY('AI', 'Deep Learning'));

INSERT INTO articles VALUES
(3, 'Python Programming', 'Learn Python programming from scratch',
'[0.05, 0.1, 0.15, 0.2]', '[0.05, 0.1, 0.15, 0.2]',
'{"level": "beginner", "topic": "python"}', ARRAY('Programming'));

INSERT INTO articles VALUES
(4, 'Database Systems', 'Introduction to relational database management systems',
 '[0.2, 0.1, 0.3, 0.2]', '[0.2, 0.1, 0.3, 0.2]',
 '{"level": "intermediate", "topic": "database"}', ARRAY('Database', 'SQL'));
```


## 执行混合查询

```sql title="执行混合查询"
SELECT id, title, __score
FROM HYBRID_SEARCH(
TABLE articles,
'{
  "knn": {
    "field": "embedding",
    "query_vector": "[0.1,0.2,0.3,0.4]",
    "k": 5
  },
  "query": {
    "match": {"title": "learning"}
  },
  "rank": {
    "rrf": {"rank_constant": 60}
  },
  "size": 5
}'
);
```


这条 SQL 的每个部分作用如下：


![图 10](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-10.png)

**一句话总结**：knn 负责语义搜索，query 负责关键词搜索，rank 负责融合排序。

![图 11](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-11.png)

## 查询模式总览

```
你的查询需要什么？

├─ 语义相似 ──→ knn 子句（向量搜索）
├─ 关键词匹配 ──→ query 子句（全文搜索）
├─ 结构化过滤 ──→ filter 子句（标量过滤）
└─ 组合需求 ──→ 多子句 + rank 融合
```

![图 12](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-12.png)

查询语句基本格式：
```
HYBRID_SEARCH(TABLE table_name, 'DSL_STRING')
```

查询语句 DSL_STRING 的顶层结构：

```json title=”DSL_STRING 顶层结构”
{
  “knn”: { ... },       // 向量搜索（可选，也可为数组表示多路向量）
  “query”: { ... },     // 查询条件（可选，支持全文、标量、Array、JSON）
  “rank”: { ... },      // 融合算法（knn 和 query 同时存在时有效）
  “from”: 0,            // 分页偏移（默认 0）
  “size”: 10,           // 返回结果数（默认 10）
  “min_score”: 0.0      // 最低分数阈值（可选）
}
```

`query` 子句支持以下类型查询，各有不同的放置位置和相关性评分规则。

**相关性评分**指子句是否参与 BM25 等分数的计算——参与评分的子句影响结果排序，不参与的仅做过滤，只决定”哪些文档入选”而不影响排序。

![图 13](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-13.png)

**组合规则**：

- 全文搜索子句可在 query 内的任何位置使用；bool.filter 中的全文子句仅做过滤，不参与评分
- 标量过滤、Array 过滤、JSON 过滤**不能**放在 bool.must/bool.should 中（会报错），其余位置可用（query 顶层、bool.filter、bool.must_not、knn.filter）
- 嵌套 bool 的评分豁免：如果 bool 处于外层 filter 或 must_not 内，其内部 must/should 也不参与评分，此时标量/Array/JSON 子句可以出现在嵌套的 must/should 中
- knn.filter 与 query.bool.filter**不共享**：如果全文和向量都需要相同的过滤条件，必须分别指定

## 向量搜索

**优势**：能理解语义相似性，召回同义词、近义词相关结果，无需精确关键词匹配。

**劣势**：可能遗漏精确术语，对专有名词匹配精度不如关键词搜索；需要预计算向量嵌入。

```json title="knn 完整结构"
{
  "knn": {
    "field": "embedding",              // 必填，向量列名
    "query_vector": "[0.1,0.2,...]",   // 必填，查询向量，推荐字符串格式
    "k": 10,                           // 必填，返回结果数 [1, 16384]
    "boost": 1.0,                      // 可选，融合权重，默认 1.0，范围 >= 0
    "similarity": 0.8,                 // 可选，相似度阈值 [0.0, 1.0]，不支持 IP 距离
    "filter": { ... },                 // 可选，过滤条件，语法同 query.bool，不参与评分
    "search_options": {                // 可选，向量查询调优参数
      "ef_search": 64,                 //   HNSW 搜索宽度 [1, 1000]，默认 1000
      "refine_k": 4.0,                 //   精细搜索倍率 [1.0, 1000.0]，仅 HNSW_BQ 索引支持
      "filter_mode": "pre",            //   过滤模式：pre / pre-knn / pre-brute / post / post-index-merge
      "drop_ratio_search": 0.0         //   稀疏向量搜索丢弃率 [0.0, 0.9]
    }
  }
}
```

![图 14](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-14.png)

### knn 参数

![图 15](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-15.png)

### search_options 参数

![图 16](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-16.png)

### filter_mode 选项

![图 17](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-17.png)

### 多路向量搜索

`knn` 支持数组形式，实现多路向量搜索。每路向量搜索独立执行，结果按融合算法合并：

```sql
SELECT id, title, __score
FROM HYBRID_SEARCH(
TABLE articles,
'{
  "knn": [
    {
      "field": "embedding"
      ,
      "query_vector": "[0.1,0.2,0.3,0.4]"
      ,
      "k": 5,
      "boost": 0.7
    },
    {
      "field": "title_embedding"
      ,
      "query_vector": "[0.4,0.3,0.2,0.1]"
      ,
      "k": 5,
      "boost": 0.3
    }
  ],
  "size": 5
}'
);
```


**多路向量搜索的要点**：

- 每路 `knn` 的 `field` 可以是不同向量列
- 每路可独立设置 `boost`、`filter`、`search_options` 等参数
- 各路的 `filter` 不共享，需要分别指定
- 多路向量的结果取并集，按分数融合算法排名

## 全文搜索

**优势**：精确匹配关键词，对专有名词、型号、ID 等精确术语召回率高；支持 BM25 相关性评分。

**劣势**：无法理解语义，同义词、近义词需要额外配置；可能返回关键词匹配但语义不相关的结果。

```json title="query 全文搜索结构"
{
  "query": {
    "match": { ... },          // 全文搜索（参与评分），单字段匹配
    "match_phrase": { ... },   // 短语匹配
    "multi_match": { ... },    // 多字段匹配
    "query_string": { ... },   // 查询字符串
    "bool": { ... }            // 组合查询，可嵌套全文和标量过滤
  }
}
```

### match 查询

单字段全文匹配，支持简写和完整格式：

```sql
-- 简写格式
{
  "match": {
    "title": "machine learning"
}}
-- 完整格式：
{
  "match": {
    "title": {
      "query": "machine learning"
      ,
      "boost": 2.0
      ,
      "operator": "and"
      ,
      "minimum_should_match": 2
}}}
```



![图 18](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-18.png)

### match_phrase 查询

短语匹配，词序必须一致：

```json title="match_phrase 查询"
{
  "match_phrase": {
    "title": {
      "query": "machine learning",
      "slop": 2,
      "boost": 1.5
    }
  }
}
```

![图 19](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-19.png)

### multi_match 查询

跨多字段全文匹配，支持字段权重语法 `"字段名^权重"`：

```json title="multi_match 查询"
{
  "multi_match": {
    "query": "machine learning",
    "fields": ["title^2.0", "content"],
    "type": "best_fields",
    "operator": "or",
    "minimum_should_match": 1,
    "boost": 1.5
  }
}
```

![图 20](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-20.png)

### query_string 查询

支持词权重语法 `"词^权重"`，用空格分隔多个词项（默认 OR 逻辑）：

```json title="query_string 查询"
{
  "query_string": {
    "query": "database^2.0 optimization",
    "fields": ["title^1.5", "content"],
    "type": "best_fields",
    "default_operator": "and",
    "minimum_should_match": 1,
    "boost": 1.0
  }
}
```

![图 21](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-21.png)

**注意**：`query_string.query` 的查询文本中出现以下内容会触发错误：

- **保留关键字**（不区分大小写）：`and`、`or`、`not`、`to`
- **保留字符**：`+ - & | ! = < > ( ) [ ] { } " ~ * ? : \ /`

例如 `"query": "database and optimization"` 会因 `and` 触发 `ERROR 1210: query contains reserved keyword`；`"query": "hello (world)"` 会因 `(` 触发 `ERROR 1210: query contains reserved character`。如需使用这些词或字符，请改用 `match` 系列或 `bool` 查询组合。

### bool 组合查询

```json title="bool 组合查询"
{
  "bool": {
    "must": [
      {"match": {"title": "learning"}}
    ],
    "should": [
      {"match": {"content": "algorithm"}}
    ],
    "must_not": [
      {"match": {"title": "deep"}}
    ],
    "filter": [
      {"range": {"id": {"gte": 1, "lte": 5}}}
    ],
    "minimum_should_match": 1,
    "boost": 1.2
  }
}
```

![图 22](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-22.png)

## 标量过滤

**优势**：精确筛选结构化条件（价格范围、时间区间、标签等），过滤性能高。Array/JSON 列可利用 Search Index 加速，标量列通过普通索引（如 B-tree）加速。

**劣势**：仅做布尔判断不计入相关性评分，不能单独完成语义或关键词搜索，需配合其他搜索方式使用。

标量过滤条件不参与评分、不支持 `boost`，可放在 `query` 顶层、`bool.filter`/`bool.must_not` 或 `knn.filter` 中，不能放在 `bool.must`/`bool.should` 中。

![图 23](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-23.png)

### range 范围查询

```json title="range 范围查询"
{
  "range": {
    "id": {
      "gte": 3,
      "lte": 100
    }
  }
}
```

![图 24](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-24.png)

支持数值和日期类型。

### term / terms 精确匹配

```json title="term / terms 精确匹配"
// 单值匹配
{"term": {"id": 1}}

// 多值匹配
{"terms": {"id": [1, 3, 5]}}
```

![图 25](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-25.png)

### Array 过滤

Array 列过滤放在 query 顶层，支持三种操作符：

```json title="Array 过滤"
// 包含指定元素
{"array_contains": {"categories": "ai"}}

// 与指定数组有交集
{"array_overlaps": {"categories": ["ai", "cloud"]}}

// 包含指定数组的所有元素
{"array_contains_all": {"categories": ["ai", "ml"]}}
```

![图 26](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-26.png)

**注意**：建议为对应列创建 Search Index 以加速 Array 过滤查询。Array 过滤不能放在 `bool.must`/`bool.should` 中。

### JSON 过滤

JSON 列过滤放在 `query` 顶层，支持三种操作符，均通过 `candidate` 指定候选值、可选 `path` 指定 JSON 路径：

```json title="JSON 过滤"
// json_contains：检查 doc_json 是否包含 {"name": "doc2"}
{"json_contains": {"doc_json": {"candidate": {"name": "doc2"}, "path": "$"}}}

// json_member_of：检查 doc_json.name 值是否属于候选数组
{"json_member_of": {"doc_json": {"candidate": "doc2", "path": "$.name"}}}

// json_overlaps：检查 doc_json 的 $.tags 路径是否与候选数组有交集
{"json_overlaps": {"doc_json": {"candidate": ["database", "mysql"], "path": "$.tags"}}}
```

![图 27](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-27.png)

![图 28](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-28.png)

**注意**：建议为 JSON 列创建 Search Index 以速过滤。JSON 过滤不能放在 `bool.must`/`bool.should` 中。

### JSON 路径提取

在 term、terms、range 等标量过滤中，可以通过 `字段名.路径` 语法提取 JSON 字段中的嵌套值：

```json title="JSON 路径提取"
// term：精确匹配 JSON 路径值
{"term": {"doc_json.name": "doc2"}}

// range：范围过滤 JSON 路径值
{"range": {"doc_json.metadata.score": {"gte": 50}}}

// terms：多值匹配 JSON 路径值
{"terms": {"doc_json.name": ["doc1", "doc2", "doc3"]}}
```

**注意**：`doc_json.name` 等价于 `json_extract(doc_json, '$.name')`。

## 混合查询与融合算法

**优势**：兼顾语义理解和关键词精确匹配，召回率和准确率同时提升；内置多种融合算法，无需应用层拼接。

**劣势**：需要同时维护向量索引和全文索引，存储成本增加；融合算法参数需要调优。

![图 29](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-29.png)

### 哪些搜索可以融合

Hybrid Search 的 `knn` 和 `query` 子句可同时存在，只要任意一方存在即可执行查询。两方都指定时，`rank` 控制融合方式；仅一方指定时，按该方自身的分数返回结果。

`knn` 支持数组形式的多路向量搜索，`query` 为单路（多条件通过 `bool.must`/`bool.should` 组合）。标量过滤（`term`/`terms`/`range`/`array_*`/`json_*`）不参与评分，仅筛选结果。

![图 30](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-30.png)

**常用组合模式**：

![图 31](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-31.png)

**什么是「一路」？**

- `knn` 数组中的每个元素是独立的一路向量搜索——例如同时搜文本向量和图片向量是 2 路。
- `query` 中的多条件（如 `bool.must` 内多个 `match`）仍算作 1 路全文搜索，它们在单路内通过 `bool` 组合，而非多路独立融合。
- 标量过滤（`filter`）不产生评分，不参与融合排序。

**注意**：仅标量过滤（无 `knn`、无全文 `match`）可以执行，但结果无相关性排序，仅按表的自然顺序返回。如需要排序，至少指定一路向量或全文。

### 向量 + 全文融合

```sql title="向量 + 全文融合"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 1.0
    },
    "query": {
      "match": {
        "title": {
          "query": "learning",
          "boost": 1.0
        }
      }
    },
    "size": 5
  }'
);
```

同时指定 `knn` 和 `query` 时，默认使用 Weighted Sum 融合——两路分数直接相加，各路权重默认 1.0。

### 多路向量 + 全文融合

当有多列向量数据时（如文本向量、图像向量），可以同时进行多路向量搜索：

```sql title="多路向量 + 全文融合"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": [
      {
        "field": "embedding",
        "query_vector": "[0.1,0.2,0.3,0.4]",
        "k": 10,
        "boost": 0.7
      },
      {
        "field": "title_embedding",
        "query_vector": "[0.3,0.4,0.2,0.1]",
        "k": 10,
        "boost": 0.3
      }
    ],
    "query": {
      "match": {
        "title": "手机"
      }
    },
    "rank": {
      "rrf": {
        "rank_constant": 60
      }
    },
    "size": 10
  }'
);
```

**注意事项**：

- 每路向量可设置不同 `boost` 权重（上例中文本权重 0.7，图像权重 0.3）
- 各路 `filter` 独立，需要时分别指定
- 多路向量结果先取并集，再与全文结果融合

## 融合算法详解

混合搜索的核心问题是：向量搜索的产物和全文搜索的产物产生的逻辑不同，怎么合并才能最好地贴近请求的原意？

- 向量搜索返回的是语义的距离值（如 L2 距离 0~∞，余弦相似度 -1~1）
- 全文搜索返回的是 BM25 分数（通常 0~30）

直接把两种分数加在一起，就像把摄氏度和华氏度相加——数字虽然能算出来，但是无法很好的反应温度。融合算法就是解决这个"单位不同"的问题，将两种产物结合在一起，使得结果更符合请求。

**你的场景属于哪种？**

- 两路搜索的结果质量差不多 ──→ Weighted Sum（默认，直接加）
- 不确定哪路搜索的结果更好 ──→ RRF（只看排名，不看分数）
- 想让某路搜索的结果更优先 ──→ WRRF（排名融合 + 加权）
- 发现某路结果总是霸占前排 ──→ Weighted Sum + MinMax（先归一化再加）

![图 32](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-32.png)

**选择建议**：拿不准时优先用 RRF，它不受分数范围影响，无需调参就能正常工作。

**融合权重（boost）设置位置**：

![图 33](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-33.png)

**注意**：`query` 顶层不支持 `boost` 参数；`knn` 与全文子句 `boost` 是乘法关系。

### RRF 融合

**设计思路**：RRF（Reciprocal Rank Fusion）的核心思想是——放弃分数，只看排名。不管向量搜索的分数是 0.95 还是全文搜索的分数是 28.5，RRF 只关心"这个文档在第几名"。排名越靠前，贡献的分数越高；排名越靠后，衰减越平缓。这样就从根源上消除了"分数单位不同"的问题。

```sql title="RRF 融合示例"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 1.0
    },
    "query": {
      "match": {
        "title": {
          "query": "learning",
          "boost": 1.0
        }
      }
    },
    "rank": {
      "rrf": {
        "rank_constant": 60,
        "rank_window_size": 100
      }
    },
    "size": 5
  }'
);
```

RRF 公式：`score = Σ(weight_i × 1 / (rank_constant + rank_i))`

- `rank_constant`：默认 60，范围 >= 1。它控制排名靠前的结果优势有多大——值越小，Top 1 和 Top 10 的差距越大；值越大，排名间的差距越平缓
- `rank_window_size`：排名窗口大小，默认等于 from + size，必须 >= size。控制融合时的候选集范围——增大可以扩大候选集提升召回率，但增加计算开销
- 各路结果按原始分数降序排列后分配排名

**rank_constant 怎么选？**

- 默认 60 适合大多数场景，不需要调整
- 如果你希望排名靠前的结果优势更明显（更"精英"），可以调小到 10~30
- 如果你希望排名间的差距更平缓（更"民主"），可以调大到 100+

### WRRF 融合（加权 RRF）

设计思路：RRF 默认对两路搜索一视同仁，但实际场景中你往往更信任某一路。比如 RAG 场景中语义理解通常比关键词匹配更重要，电商搜索中商品名称的精确匹配通常比描述的语义相似更重要。WRRF 在 RRF 的基础上给每路搜索设一个 boost 权重，让你能表达"我更看重哪一路"。

```sql title="WRRF 融合示例"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 2.0
    },
    "query": {
      "match": {
        "title": {
          "query": "learning",
          "boost": 1.0
        }
      }
    },
    "rank": {
      "rrf": {
        "rank_constant": 60,
        "rank_window_size": 100
      }
    },
    "size": 5
  }'
);
```

上例中向量搜索的 boost=2.0，全文搜索的 boost=1.0，意味着向量搜索排名靠前的结果对最终分数的贡献是全文搜索的两倍。

**注意**：boost 可以设置在 knn 层级或全文子句（如 match/multi_match）内部。knn.boost 控制向量搜索的权重，全文子句内的 boost 控制该子句的权重（两者是乘法关系）。query 顶层不支持 boost 参数。

**boost 怎么选？**

- 1.0 = 一视同仁（默认）
- 1.5~2.0 = 适度侧重，适合"某一路更重要但不排斥另一路"的场景
- 3.0+ = 强调某一路，适合"几乎只看某一路，另一路做补充"的场景

### Weighted Sum + MinMax 归一化

**什么时候需要归一化？**

- 如果你发现某一路的结果总是排在前面，不是因为更相关，而是因为分数天然更高，就需要归一化
- 如果你不确定是否需要，用 RRF 更稳妥——RRF 天然不受分数范围影响

设计思路：Weighted Sum 是最直观的融合——把两路分数加起来。但直接相加有个问题：如果向量搜索的分数范围是 0~1，而全文搜索的分数范围是 0~30，那全文搜索的分数天然就压过了向量搜索，即使向量搜索认为某个文档非常相关，也抵不过全文搜索的一个中等分数。MinMax 归一化的作用是先把两路分数都缩放到 0~1 的同一区间，避免某一路分数完全主导了查询。

```sql title="Weighted Sum + MinMax 归一化示例"
SELECT id, title, __score
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 0.7
    },
    "query": {
      "match": {
        "title": {
          "query": "learning",
          "boost": 0.3
        }
      }
    },
    "rank": {
      "weighted_sum": {
        "normalizer": "minmax",
        "rank_window_size": 100
      }
    },
    "size": 5
  }'
);
```

归一化公式：`normalized_score = (score - min) / (max - min)`

当 max 与 min 差值极小时（< 1e-6），归一化分数默认为 1.0。

## 分页与过滤

### min_score 分数过滤

仅返回融合分数 >= min_score 的结果，过滤掉相关度低的低分文档：

```sql title="min_score 分数过滤"
SELECT id, title
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 0.7
    },
    "query": {
      "match": {
        "title": {
          "query": "learning",
          "boost": 0.3
        }
      }
    },
    "min_score": 0.5,
    "size": 5
  }'
);
```

### from / size 分页

```sql title="from / size 分页"
SELECT id, title
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5
    },
    "from": 2,
    "size": 3,
    "min_score": 0.1
  }'
);
```

- `from`：偏移量，默认 0
- `size`：返回结果数，默认 10
- 限制：`from + size <= 10000`

## 向量 + 全文 + 标量过滤（完整示例）

```sql title="向量 + 全文 + 标量过滤完整示例"
SELECT id, title
FROM HYBRID_SEARCH(
  TABLE articles,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.1,0.2,0.3,0.4]",
      "k": 5,
      "boost": 1.5
    },
    "query": {
      "bool": {
        "must": [
          {"match": {"title": "learning"}}
        ],
        "filter": [
          {"range": {"id": {"gte": 1, "lte": 8}}}
        ],
        "boost": 1.0
      }
    },
    "rank": {
      "rrf": {"rank_constant": 60}
    },
    "size": 5
  }'
);
```

![图 34](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-34.png)


前面几章讲清了混搜的能力边界和语法。这一章换一个角度：如果没有混搜，实现以下场景会有多麻烦。

下面用一个典型 RAG 知识库场景为例子，体现混搜的简单高效。

![图 35](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-35.png)


### RAG / AI 对话系统

**场景需求**

用户向 AI 提一个自然语言问题，如「OceanBase 分布式事务怎么保证一致性」。系统需要从知识库中找出最相关的文档片段，喂给 LLM 生成回答。

这个场景的核心诉求：

- **语义覆盖**：用户问题不会恰好匹配文档标题，必须靠语义理解找到意思相近的文档
- **关键词兜底**：专有名词（如"两阶段提交"、"全局快照"）语义模型可能遗漏，需要精确关键词命中
- **召回率优先**：宁可多召回几篇让 LLM 自己挑，也别漏掉关键信息

### 传统做法

不使用混合搜索时，典型方案是 LLM 扩写、改写、转换 + 向量和全文索引双查，应用层合并：

1. 将用户的问题通过 LLM 进行扩写 → 三到五个衍生问题，提高查询命中率
2. 将每个衍生问题向量化，调用向量索引查语义相近的文档 → Top 20 × 衍生问题个数
3. 提取问题中的关键词，调用全文索引查关键词匹配的文档 → Top 20 × 衍生问题个数
4. 应用层合并去重（两路可能有重叠文档）并手动实现 RRF 排序，取 Top 5 返回

这种做法的问题：

- 两个系统独立查询，应用代码复杂度高
- 在计算层返回结果后做融合的效率低，数据库内核在多路查询时可以做存储查询优化，加速查询效率、降低硬件开销

### 使用混合搜索

一条 SQL 替代上述步骤 2 至步骤 4。建表包含向量列和全文索引列，查询时同时在向量路和全文路召回，RRF 自动融合：

这段 SQL 可以分成三层看：先建一张能存文档和向量的堆表，再分别建向量索引和全文索引，最后用 HYBRID_SEARCH 同时走向量路和全文路。真正复杂的是第三段混合查询，读的时候盯住 `knn`、`query`、`rank` 这三个位置就行。

```sql title="RAG 场景混合搜索示例"
-- 1. 建表（示例使用 4 维向量，实际使用时根据 embedding 模型调整）
CREATE TABLE rag_docs(
    id INT,
    title VARCHAR(255),
    content TEXT,
    embedding VECTOR(4),
    category VARCHAR(50),
    created_at DATE
) ORGANIZATION = HEAP;

-- 2. 建索引
CREATE VECTOR INDEX idx_emb ON rag_docs(embedding)
  WITH(distance=cosine, type=hnsw_sq, lib=vsag);
CREATE FULLTEXT INDEX idx_title on rag_docs(title);

-- 3. 混合查询
SELECT id, title, content, __score
FROM HYBRID_SEARCH(
  TABLE rag_docs,
  '{
    "knn": {
      "field": "embedding",
      "query_vector": "[0.12,0.34,0.56,0.78]",
      "k": 20,
      "boost": 1.5
    },
    "query": {
      "multi_match": {
        "query": "分布式事务一致性",
        "fields": ["title", "content"]
      }
    },
    "rank": {
      "rrf": {"rank_constant": 60}
    },
    "size": 5
  }'
);
```

上面 `-- 3. 混合查询` 这段最关键：`knn` 先按向量相似度多召回一些候选，`multi_match` 用标题和正文做关键词兜底，`rank.rrf` 再把两路结果按排名融合。这里的 `size: 5` 不是让每一路只查 5 条，而是最终返回融合后的 Top 5；向量路的 `k: 20` 是先多拿一些候选，避免关键信息还没进入融合阶段就被截掉。

混搜的查询语句与传统做法的对应关系：

![图 36](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-36.png)

## 参数选择思路

- `distance=cosine`：文本语义搜索推荐余弦距离，对向量长度不敏感
- `k=20`：先多召回一些结果，由 RRF 融合筛选出最匹配的 Top 5
- `boost=1.5`：语义搜索权重略高，RAG 场景语义理解比关键词更关键
- `rrf`：不确定两路分数分布时的稳健选择，对异常分数不敏感

![图 37](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-37.png)

## 实战提示

- 向量维度必须与 embedding 模型输出一致（如 OpenAI text-embedding-3-small 输出 1536 维）
- 全文索引需要使用 utf8mb4 字符集，否则中文分词可能异常
- k 值不宜过大，通常 k = 3~5 × size 即可，k 越大计算量越大

![图 38](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-38.png)

## 核心优势

1. **单一 SQL 实现多模态搜索**：无需多系统组合，一条 SQL 完成向量 + 全文 + 标量过滤
2. **内置多种融合算法**：Weighted Sum / RRF / WRRF，覆盖主流融合需求
3. **MySQL 协议兼容**：降低切换成本，现有 MySQL 生态工具可直接使用
4. **分布式架构**：支持水平扩展，适合大规模数据场景
5. **事务一致性**：混合搜索与业务数据在同一数据库，天然支持 ACID 事务
6. **多语言支持**：全文索引支持多种语言
7. **高压缩比**：文档存储空间压缩比高，适合海量数据

![图 39](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-39.png)

![图 40](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-40.png)

## 关键限制

以下限制决定是否能够采用 Hybrid Search 方案，建议在实际使用前确认：

![图 41](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-41.png)

![图 42](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-42.png)

### 语法限制

以下限制影响 SQL 编写方式：

![图 43](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-43.png)

### 参数限制

以下参数有取值范围限制：

![图 44](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-44.png)

### 其他

![图 45](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-45.png)

### 版本差异

![图 46](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-46.png)

4.6.0 的 HYBRID_SEARCH 语法是推荐使用方式，功能更完整。

![图 47](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-47.png)

## 常见问题（FAQ）

**Q: HYBRID_SEARCH 和 dbms_hybrid_search 包有什么区别？**

![图 48](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-48.png)

**Q: 全文索引和 Search Index 有什么区别？**

![图 49](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-49.png)

![图 50](/vibe-reading/images/articles/oceanbase-official-hybrid-search/fig-50.png)

## 总结

如果大家能耐心读到这里，肯定就是万中无一的 AI 或数据库的爱好者了，十分感谢！

最后再多啰嗦一句：这篇文章内容较多，大家可以先不用去记忆 SQL 和参数。需要记住的其实还是这个老生谈淡的基础概念：

**向量搜索负责语义召回，全文搜索负责关键词兜底，标量过滤负责把范围框住，融合算法负责把多路结果排到一张榜单里。**

最后，给大家画个重点。需要了解的是：OceanBase Hybrid Search 在 4.6.0 版本提供了一条 SQL 实现多模态搜索的能力，这个混合搜索能力的核心价值有：

- **消除搜索盲区**：向量搜索 + 全文搜索互补，提升召回率
- **简化开发运维**：单一数据库替代多系统组合，一条 SQL 替代应用层多路合并
- **灵活的融合策略**：内置 Weighted Sum / RRF / WRRF 三种融合算法，适应不同场景

**推荐使用路径**：

1. 初次使用：从 RRF 融合开始，无需调参
2. 精细调优：切换到 Weighted Sum + minmax，通过 boost 控制各路权重
3. 性能优化：调整 ef_search、filter_mode 等参数
