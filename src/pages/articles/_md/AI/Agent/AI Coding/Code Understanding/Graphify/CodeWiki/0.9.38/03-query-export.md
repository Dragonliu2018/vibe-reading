---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "Query & Export"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, "AI Coding", "Code Understanding", Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "查询", "导出", "vis.js", "graph.json", "Neo4j"]
description: "graphify 查询与导出层：query/path/explain 命令查询 graph.json，方向感知最短路径，vis.js 交互式 HTML 导出，Neo4j 图数据库导出。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI Coding/Code Understanding/Graphify/CodeWiki/0.9.38/00-overview)

---

## 模块定位

查询与导出层是 graphify 的**消费端**——它不依赖抽取过程，只消费 `graph.json`。三个查询命令（query/path/explain）让用户"查询图谱而非 grep 文件"，导出子系统把图结构转化为人类可读（HTML/报告）和机器可查（JSON/图数据库）的产物。模块覆盖 `cli.py` 的查询命令、`export.py`（1127 行）、`exporters/`（4 文件 748 行）、`report.py`（300 行）。

模块的核心价值是：把图遍历能力暴露为简单的 CLI 命令，让 AI 助手用一句话就能获取 scoped 子图而非读整个代码库。

## 模块架构

![查询与导出架构](/vibe-reading/images/articles/graphify-internals/query-export-architecture.svg)

模块内部按功能分三块。**查询**（`cli.py` 中的 query/path/explain 处理函数）从 `load_node_link_graph()`（`paths.py` L318）加载 `graph.json` 为 `nx.Graph`，执行查询后格式化输出。**导出**（`export.py` + `exporters/`）把 `nx.Graph` 转为目标格式——`to_json()` 写 `graph.json`、`to_html()` 写交互式 HTML、`to_graphdb()` 导入 Neo4j/FalkorDB。**日志**（`querylog.py`）记录每次查询，驱动 `graphify reflect` 的经验学习闭环。

`paths.py`（344 行）虽然名字像路径算法，实际是 graphify 的**基础设施层**——原子写入（`write_text_atomic`/`write_json_atomic`）、路径消歧（`disambiguate_ambiguous_candidates`）、NFC 规范化、`graph.json` 加载。被 cli/serve/cache/security/hooks 等 9+ 个模块依赖。

## 调用链路

### 查询命令链路

```
graphify query "<question>"
  └─ cli.py: query 处理函数
     ├─ load_node_link_graph(graph_json_path)     paths.py L318
     │   └─ json.loads → nx.Graph (兼容 links/edges key)
     ├─ 关键词提取 + 社区定位
     │   └─ 提取与问题相关的节点 + 邻域 → scoped 子图
     ├─ 格式化输出 (Markdown/JSON)
     └─ querylog.log_query(kind="query", question=..., corpus=...)

graphify path "A" "B"
  └─ cli.py: path 处理函数
     ├─ load_node_link_graph()
     ├─ 查找 A/B 节点 (fuzzy match)
     ├─ 方向感知 BFS 最短路径
     │   └─ respect edge direction by default (#2487)
     ├─ 输出: A --relation--> X <--relation-- B (hop by hop)
     └─ querylog.log_query(kind="path", ...)

graphify explain "concept"
  └─ cli.py: explain 处理函数
     ├─ load_node_link_graph()
     ├─ 查找节点 (fuzzy match)
     ├─ 展示: Source / Community / Degree / Connections
     │   └─ 每条连接标注 [EXTRACTED] / [INFERRED]
     └─ querylog.log_query(kind="explain", ...)
```

### 导出链路

```
to_json(G, communities, output_path, force)        export.py L232
  ├─ #479 shrink guard (新图节点 < 旧图 → 拒绝写入, force 可跳过)
  ├─ json_graph.node_link_data(G)
  ├─ 附加 community/community_name/norm_label 到每个 node
  ├─ 恢复 edge 方向 (_src/_tgt)
  ├─ 写入 hyperedges
  └─ write_json_atomic(output_path, data)           paths.py L88

to_html(G, communities, output_path, labels)       exporters/html.py L325
  ├─ vis.js 力导向图渲染
  ├─ node_limit=5000, 超过 → 社区聚合元图
  ├─ EXTRACTED 边实线, INFERRED/AMBIGUOUS 虚线    html.py L500
  └─ 写入独立 HTML 文件

to_graphdb(G, ...)                                 exporters/graphdb.py
  └─ Neo4j / FalkorDB Cypher 导入
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `load_node_link_graph()` paths.py L318 | 加载 graph.json 为 nx.Graph | 兼容 links/edges key |
| `to_json()` export.py L232 | 导出 graph.json | #479 shrink guard 防部分覆盖 |
| `to_html()` exporters/html.py L325 | 导出交互式 HTML | >5000 节点降级为社区元图 |
| `to_graphdb()` exporters/graphdb.py | 导入图数据库 | Neo4j/FalkorDB Cypher |
| `disambiguate_ambiguous_candidates()` paths.py L223 | 多候选消歧 | test/非test + 路径近邻 |
| `write_json_atomic()` paths.py L88 | 原子写 JSON | temp file + os.replace |
| `querylog.log_query()` querylog.py | 记录查询日志 | 驱动 reflect 学习闭环 |

</details>

## 核心实现

### query 的 scoped 子图提取

`query "<question>"` 不是返回全图，而是提取与问题相关的 **scoped 子图**——通过关键词匹配定位相关节点，加上这些节点的邻域（1-hop 邻居），形成一个比全图小得多的子图。这适合 AI 助手上下文——把 scoped 子图作为上下文比 `GRAPH_REPORT.md` 更聚焦。

### path 的方向感知

`path A B` 用方向感知的 BFS 搜最短路径。commit 94ebee1 提到 "respect edge direction by default"——在有向图（`directed=True`）中，边的方向决定了可达性。`graphify path` 默认尊重边方向，`A --calls--> B` 不意味着 `B` 能到达 `A`。commit 94ebee1 还提到 "drop relational-verb seed pollution"——关系动词（如 "uses"/"references"）不再作为路径种子污染结果。

### explain 的置信度展示

`explain "<concept>"` 查找节点并展示所有连接，每条连接标注 `[EXTRACTED]` 或 `[INFERRED]`：

```text
$ graphify explain "APIRouter"
Node: APIRouter
  Source:    routing.py L2210
  Community: 2
  Degree:    47

Connections (47):
  --> RequestValidationError [uses] [INFERRED]
  --> Dependant [uses] [INFERRED]
  --> .get() [method] [EXTRACTED]
  <-- __init__.py [imports] [EXTRACTED]
```

这让用户一眼看出哪些连接是源码中显式存在的（EXTRACTED），哪些是 graphify 推断的（INFERRED）。

### HTML 导出的 vis.js 可视化

`to_html()`（`exporters/html.py` L325）生成独立的 HTML 文件，使用 vis.js 渲染交互式力导向图。关键设计：

- **节点着色**：按社区着色，颜色来自 Leiden 检测结果。
- **边样式**：EXTRACTED 边为实线，INFERRED/AMBIGUOUS 边为虚线（`html.py` L500-503），视觉区分确定性。
- **超大图降级**：超过 `node_limit`（默认 5000）时自动从节点级图降级为**社区聚合元图**——每个社区变成一个节点，避免浏览器渲染卡顿。
- **confidence score**：`_CONFIDENCE_SCORE_DEFAULTS = {"EXTRACTED": 1.0, "INFERRED": 0.5, "AMBIGUOUS": 0.2}`（`export.py` L159），三个级别对应不同提取可信度。

### #479 shrink guard

`to_json()` 在写入前检查新图节点数是否小于旧图——如果是，拒绝写入，防止部分抽取覆盖完整图。这是增量重建的安全网：如果 `extract` 只抽取了部分文件（如 cache miss 过多），不应该把残缺的图覆盖到已有的完整 `graph.json`。`force=True` 或 `--allow-partial` 可跳过此检查。

### querylog 与 reflect 学习闭环

三个查询命令结束时都调 `querylog.log_query(kind=..., question=..., corpus=...)` 记录查询日志，并调 `_touch_query_stamp(gp)` 更新时间戳。这驱动 `graphify reflect` 的经验学习闭环——查询结果可通过 `save-result` 命令保存，`reflect` 汇总后生成 `.graphify_learning.json`，最终被 explain 和 HTML 导出读取为 Lesson overlay。这让 graphify "越用越聪明"——用户的查询和反馈成为图的元数据。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 命令分派 | `dispatch_command()` in `cli.py` L805 | 字符串路由到处理函数 |
| 导出器策略 | `exporters/base.py` + `export.py` | 不同导出格式独立实现，统一接口 |
| 降级策略 | `to_html()` node_limit | >5000 节点降级为社区元图 |
| 安全防护 | `to_json()` #479 shrink guard | 防部分覆盖完整图 |

## 模块间交互

- **← build.py**：通过 `nx.Graph` + communities dict 接收构建结果。
- **← cli.py**：所有查询/导出命令的调用方。
- **→ paths.py**：`load_node_link_graph` 加载 graph.json，`write_json_atomic`/`write_text_atomic` 原子写入。
- **→ querylog.py**：记录查询日志。
- **→ exporters/html.py**：HTML 导出委托给 vis.js 渲染。
- **→ exporters/graphdb.py**：图数据库导出委托给 Neo4j/FalkorDB driver。

## 扩展方式

### 新增一种导出格式

1. **`graphify/exporters/`**：创建 `xyz.py`，实现 `to_xyz(G, communities, output_path, ...)` 函数
2. **`graphify/export.py`**：在导出分派逻辑中添加新格式选项
3. **`graphify/cli.py`**：在 `export` 命令参数中添加 `--format xyz` 选项

### 新增一个查询命令

1. **`graphify/cli.py`**：在 `dispatch_command()` 中添加 `if cmd == "newcmd":` 分支
2. **`graphify/cli.py`**：实现查询逻辑——`load_node_link_graph()` → 图遍历 → 格式化输出
3. **`graphify/querylog.py`**：`log_query(kind="newcmd", ...)` 记录日志
4. **对应测试**：`tests/test_*.py`
