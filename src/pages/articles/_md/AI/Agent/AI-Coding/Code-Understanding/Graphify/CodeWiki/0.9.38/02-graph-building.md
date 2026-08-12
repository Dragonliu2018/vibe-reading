---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "Graph Building"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, "AI Coding", "Code Understanding", Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "NetworkX", "Leiden", "社区检测", "去重", "phantom-edge"]
description: "graphify 图构建层：三层去重策略、NetworkX 组装、Leiden 社区检测降级、god nodes 分析与跨语言 phantom-edge 防护。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Understanding/Graphify/CodeWiki/0.9.38/00-overview)

---

## 模块定位

图构建层把抽取层产出的扁平 `{nodes, edges}` dict 变成有结构的 `nx.Graph`——去重消除冗余节点，社区检测发现子系统边界，分析计算 god nodes 和意外连接。这是从"一堆函数和类"到"有组织的架构图谱"的变换步骤。模块覆盖 `build.py`（1943 行）、`dedup.py`（842 行）、`cluster.py`（320 行）、`analyze.py`（749 行）。

模块的核心挑战是：如何在三层不同粒度上消除重复节点？如何防止跨语言幻影边？如何在没有 LLM 的情况下发现代码库的子系统边界？

## 模块架构

![图构建架构](/vibe-reading/images/articles/graphify-internals/graph-building-architecture.svg)

模块内部按数据流分四个阶段。**去重**（`dedup.py`）在图构建前运行——`deduplicate_entities()` 用四 pass 管道消除重复节点。**组装**（`build.py`）把去重后的 nodes+edges 送入 `build_from_json()`，创建 `nx.DiGraph` 或 `nx.Graph`，应用 phantom-edge 防护。**分层**（`build.py` 的 `_is_ast_tier`）通过 `_origin` 字段区分 AST 节点和语义节点——同 ID 时语义节点覆盖 AST 节点（因为语义节点有更丰富的 label 和跨文件上下文）。**社区检测**（`cluster.py`）跑 Leiden 算法发现社区，分裂超大社区。**分析**（`analyze.py`）计算 god nodes 和 surprising connections。

## 调用链路

```
build([merged], dedup=True, root)                   build.py L1264
│
├─ deduplicate_entities(nodes, edges)              dedup.py L388
│   ├─ Pass 0: Exact ID pre-dedup
│   │   └─ _collision_rank 排序 → survivor
│   │   └─ _same_source_entity → _merge_missing_attributes
│   ├─ Pass 1: Exact normalization merge
│   │   └─ _norm(label) 相同 → union (同文件总是合并, 跨文件仅 concept + entropy≥2.5)
│   ├─ Pass 2: MinHash/LSH + Jaro-Winkler
│   │   └─ _make_minhash → MinHashLSH blocking → 候选对
│   │   └─ Jaro-Winkler 验证 (同文件) / Jaro 验证 (跨文件长 label)
│   │   └─ 守卫: _is_variant_pair, _short_label_blocked, prefix-extension block
│   │   └─ community boost: +5.0 当同社区且 label≥12 chars
│   │   └─ threshold ≥ 92.0 → union
│   └─ Pass 3: LLM tiebreaker (可选, score in [75, 92))
│       └─ Union-Find components → remap table → 应用到 nodes + edges
│
├─ build_from_json(combined, directed, root)       build.py L741
│   ├─ _coerce_non_string_ids()
│   ├─ _normalize_hyperedge_members()
│   ├─ validate_extraction()
│   ├─ for edge in edges:
│   │   ├─ _is_ast_tier(item) → _origin or source_location shape
│   │   ├─ _EDGE_LANG_FAMILY 跨语言 phantom-edge guard
│   │   └─ G.add_edge(source, target, **attrs)
│   └─ return nx.DiGraph / nx.Graph
│
├─ cluster(G, resolution, exclude_hubs_percentile)  cluster.py L134
│   ├─ _partition(connected, resolution)            cluster.py L22
│   │   ├─ Leiden (graspologic) — 首选, seed=42
│   │   └─ Louvain (networkx) — ImportError fallback, random_seed=42
│   ├─ 分裂超大社区 (>25% of graph)
│   ├─ 二次分裂低 cohesion 社区 (<0.05)
│   └─ 按大小降序重新编号 (0 = 最大)
│
└─ analyze: god_nodes(G) + surprising_connections(G, communities)  analyze.py
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `build()` build.py L1264 | 图构建编排 | 先 dedup 再 build_from_json，支持 directed/undirected |
| `build_from_json()` build.py L741 | nodes+edges → nx.Graph | NetworkX 幂等 add_node，phantom-edge guard |
| `build_merge()` build.py L1547 | 增量合并已有图 | 新文件替换旧、未变保留、删除裁剪 |
| `deduplicate_entities()` dedup.py L388 | 四 pass 去重管道 | Union-Find 组件 + remap table |
| `cluster()` cluster.py L134 | 社区检测编排 | Leiden→Louvain 降级，分裂超大社区 |
| `_partition()` cluster.py L22 | 运行社区检测算法 | graspropic Leiden 首选，seed=42 可复现 |
| `score_all()` cluster.py L268 | 计算 cohesion score | 社区内连边密度 / 期望密度 |
| `god_nodes()` analyze.py | 最高连接度节点 | 度数排序，标识"万物流向何处" |
| `surprising_connections()` analyze.py | 跨社区高权重边 | 低概率但高权重的连接 |

</details>

## 核心实现

### 三层去重策略

`build.py` 顶部注释（L1-21）定义了三层去重——每层在不同粒度上消除重复，互为补充：

```
1. 文件内 (AST): seen_ids set — 同文件重复定义折叠到首次出现
2. 文件间 (build): NetworkX G.add_node() 幂等 — 同 ID 第二次调用覆盖属性
   → AST 先加，semantic 后加 → semantic 覆盖 AST（有意设计）
3. 模糊去重 (dedup): MinHash/LSH + Jaro-Winkler — 跨文件名称近似合并
```

第一层在抽取引擎的 `walk()` 中完成——每个 extractor 维护 `seen_ids` set，同文件内同 ID 只发一次。第二层利用 NetworkX 的幂等性——`G.add_node()` 调两次同 ID 会用第二次的属性覆盖第一次。节点按抽取顺序添加（AST first, then semantic），所以语义节点覆盖 AST 节点。注释明确说明：如果需要改变优先级，调整传入 `build()` 的抽取顺序即可。

第三层是 `deduplicate_entities()`（`dedup.py` L388）的四 pass 管道：

- **Pass 0**（Exact ID）：同 ID 节点用 `_collision_rank` 排序选 survivor，`_merge_missing_attributes` 填充缺失属性，`_report_id_collision` 报告跨文件碰撞。
- **Pass 1**（Exact normalization）：`_norm(label)` 相同则合并——同文件内总是合并，跨文件仅 concept 类型且 entropy ≥ 2.5 时合并（code 类型跳过 #1205）。
- **Pass 2**（MinHash/LSH + Jaro-Winkler）：`_make_minhash` → MinHashLSH blocking 产生候选对 → Jaro-Winkler 验证（同文件）/ Jaro 验证（跨文件长 label）。多个守卫过滤误匹配：`_is_variant_pair`、`_short_label_blocked`、`prefix-extension block`、`_numeric_tokens_differ`、`_crossfile_fileanchored_blocked`。同社区且 label ≥ 12 chars 时 +5.0 boost。threshold ≥ 92.0 则 union。
- **Pass 3**（LLM tiebreaker，可选）：score in [75, 92) 的模糊对批量调 LLM 做 yes/no 判定。

最终用 Union-Find 组件生成 remap table，应用到 nodes + edges。

### AST vs Semantic 分层覆盖

`_is_ast_tier()`（`build.py` L43）通过 `_origin` 字段或 `source_location` 格式区分节点来源：

```python title="build.py L43-51"
def _is_ast_tier(item: dict) -> bool:
    o = item.get("_origin")
    if o is not None:
        return o == "ast"
    loc = item.get("source_location")
    return isinstance(loc, str) and bool(_AST_LOC_RE.match(loc))  # "L<line>"
```

AST 节点有 `source_location: "L<line>"`，语义节点有 `source_location: null`。这个区分用于 phantom-edge guard——跨语言 INFERRED `calls` 边只在同语言族内有效，防止 Python `import time` 绑定到 `time.ts`。

### 跨语言 phantom-edge 防护

`build.py` 的边循环（L1149-1172）用 `_EDGE_LANG_FAMILY` 字典（L61-71）做跨语言防护。语言族按真实互操作分组——JS/TS 共享模块图、C/C++/ObjC 共享编译单元、JVM 语言共享字节码。一个合法的 TS→JS import 或 C impl→header call 能通过，但跨语言族的 INFERRED `calls` 边被丢弃：

```python title="build.py L54-60 (注释)"
# Language interop families, keyed by extension, for the cross-language phantom-edge
# guard. Families group by REAL interop (JS/TS share a module graph; C/C++/ObjC
# share a compilation unit via headers; JVM langs share bytecode), so a legitimate
# TS->JS import or C impl->header call survives, while a Python `import time`
# binding to a `time.ts` (#1749) or a cross-language INFERRED `calls` edge is dropped.
```

`_EDGE_LANG_FAMILY` 与 `extract.py` 的 `_LANG_FAMILY_BY_EXT` 和 `analyze.py` 的 `_LANG_FAMILY` 三处镜像——保持同步是手动维护的。

### Leiden → Louvain 降级

`_partition()`（`cluster.py` L22）优先使用 graspologic 的 Leiden 算法（质量更好），`ImportError` 时降级到 NetworkX 内置的 Louvain。两者都用 `seed=42` / `random_seed=42` 保证可复现性：

```python title="cluster.py L22-50"
def _partition(G, resolution=1.0) -> dict[str, int]:
    stable = nx.Graph()
    stable.add_nodes_from(sorted(G.nodes(), key=str))
    # ... add edges sorted ...
    try:
        from graspologic.partition import leiden
        result = leiden(stable, **kwargs)
        return result
    except ImportError:
        pass
    communities = nx.community.louvain_communities(stable, **kwargs)
```

graspologic 的 ANSI 进度条会破坏 Windows PowerShell 5.1 的滚动缓冲区（#19），所以 `_suppress_output()` context manager 重定向 stdout。

### 超大社区分裂

`cluster()` 分裂两类异常社区：
- **超大社区**（>25% of graph，`_MAX_COMMUNITY_FRACTION` = 0.25）：递归对子图重新跑 `_partition`，直到每个子社区 ≤ 25%。
- **低 cohesion 社区**（<0.05，`_COHESION_SPLIT_THRESHOLD`）：cohesion score 由 `score_all()` 计算（社区内连边密度 / 期望密度），低于阈值的社区再次分裂。最小分裂大小 `_MIN_SPLIT_SIZE` = 10。

### 关键常量速查

| 常量 | 值 | 位置 | 含义 |
|------|-----|------|------|
| `_ENTROPY_THRESHOLD` | 2.5 | dedup.py L169 | 低于此 entropy 的 label 不参与模糊匹配 |
| `_LSH_THRESHOLD` | 0.7 | dedup.py L170 | MinHash LSH 候选阈值 |
| `_MERGE_THRESHOLD` | 92.0 | dedup.py L171 | Jaro-Winkler 合并阈值 |
| `_COMMUNITY_BOOST` | 5.0 | dedup.py L172 | 同社区加分 |
| `_NUM_PERM` | 128 | dedup.py L173 | MinHash 排列数 |
| `_MAX_COMMUNITY_FRACTION` | 0.25 | cluster.py L80 | 社区最大占比 |
| `_MIN_SPLIT_SIZE` | 10 | cluster.py L81 | 最小分裂大小 |
| `_COHESION_SPLIT_THRESHOLD` | 0.05 | cluster.py L82 | 低 cohesion 分裂阈值 |

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 三层去重策略 | build.py L1-21 + dedup.py L388 | 不同粒度互补——精确ID/归一化/模糊匹配各管一层 |
| 降级策略 | cluster.py L22 `_partition()` | Leiden→Louvain，最优到可用 |
| 策略选择 | dedup.py Pass 2→3 | Jaro-Winkler ≥92 直接合并，[75,92) 调 LLM tiebreaker |
| 幂等组装 | build.py `G.add_node()` | NetworkX 幂等性天然解决文件间去重 |

## 模块间交互

图构建层是抽取层的**消费者**和导出层的**生产者**：

- **← extract.py / llm.py**：通过 CLI 间接接收 `{nodes, edges, hyperedges}` dict。`build.py` 不直接 import `extract()`。
- **← cli.py**：`build()` 的调用方，传入 `dedup=True`/`directed`/`root` 参数。
- **→ export.py**：产出的 `nx.Graph` + communities dict 传给 `to_json()`。
- **→ llm.py**：`dedup.py` 调 `_call_llm()` 做 Pass 3 LLM tiebreaker。
- **→ ids.py**：调 `make_id` / `normalize_id` 做节点 ID 处理。
- **→ paths.py**：调 `default_graph_json` / `load_node_link_graph`。
- **→ validate.py**：`build_from_json` 调 `validate_extraction()` 验证输入形状。

## 扩展方式

### 调整社区检测参数

修改 `cluster.py`：`_partition()` 的 `resolution` 参数——>1 产生更多更小社区，<1 产生更少更大社区；`_MAX_COMMUNITY_FRACTION`（L80）、`_MIN_SPLIT_SIZE`（L81）、`_COHESION_SPLIT_THRESHOLD`（L82）控制分裂行为。调用方 `cli.py` 中 `cluster(G, resolution, ...)` 传参。

### 新增一种去重策略

修改 `dedup.py`：在 `deduplicate_entities()` 中添加新 pass（如在 Pass 2 和 Pass 3 之间）；新增守卫函数控制触发条件；`_MERGE_THRESHOLD`（L171）等常量可能需调整；`build.py` `build()` 的 `dedup_llm_backend` 参数可能需扩展。

### 新增 phantom-edge 防护规则

修改 `build.py`：`_EDGE_LANG_FAMILY` 字典（L61-71）新增语言族映射；边循环（L1149-1172）可能需对 `calls` 的 INFERRED 规则增加例外；同步更新 `extract.py` 的 `_LANG_FAMILY_BY_EXT` 和 `analyze.py` 的 `_LANG_FAMILY`（三处镜像需手动保持同步）。
