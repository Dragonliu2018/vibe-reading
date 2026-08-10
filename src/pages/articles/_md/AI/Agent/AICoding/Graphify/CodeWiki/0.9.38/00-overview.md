---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "Overview"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, AICoding, Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "Python", "知识图谱", "tree-sitter", "社区检测", "AI Coding"]
description: "graphify 把代码库、文档、PDF、图片映射为可查询的知识图谱。本文从五层架构、tree-sitter 抽取引擎、Leiden 社区检测到 MCP 集成，全面解读 v0.9.38 的内部原理。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.9.38 · **协议** Apache-2.0 · **语言** Python ≥ 3.10 · **代码量** ~48,000 行 · **仓库** [GitHub](https://github.com/Graphify-Labs/graphify)

---

## 总览

### 项目简介

graphify 是一个 AI 编码助手的技能（skill）工具——在 Claude Code、Cursor、Codex、Gemini CLI 等 15+ 种 AI 助手中输入 `/graphify .`，它就会把整个项目（代码、文档、PDF、图片、视频）映射成一张**知识图谱**。你不再需要 grep 文件，而是直接查询图谱：问一个问题、追踪两个概念之间的路径、或者解释一个节点。

**核心价值**：把"理解一个陌生代码库"从逐文件阅读变成图遍历。代码用 tree-sitter AST **确定性地**解析（不调 LLM、数据不离开本机），文档和媒体可选地用 LLM 做语义补充。每条边都带 `EXTRACTED`（源码中显式存在）或 `INFERRED`（推断得出）的置信度标签，让你区分"确定的依赖"和"可能的关联"。

**核心使用场景**：AI 助手在大型代码库中导航（替代 grep/全局搜索）、跨文件理解调用链与依赖关系、发现"意外连接"（surprising connections）和子系统边界（社区检测）、为团队生成可交互的架构图谱。

**项目边界**：负责代码结构抽取（tree-sitter AST）、图构建（NetworkX）、社区检测（Leiden）、查询与可视化导出；不负责代码执行、不实现自研 LLM、不做向量索引（明确宣称 "Not a vector index"——是可遍历的真实图，不是 embedding 近似搜索）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|----------|------|
| tree-sitter AST 抽取 | `extract.py` + `extractors/` | ~40 种语言的确定性结构抽取，不调 LLM |
| 跨文件符号解析 | `extractors/resolution.py` | JS/TS/Python import 路径解析、member-call 绑定 |
| EXTRACTED/INFERRED 标签 | `extract.py` L6239 | 每条边标注置信度，区分直接证据与推断 |
| LLM 语义抽取 | `llm.py` | docs/PDF/images/video 的语义节点+边，多 provider |
| 三层去重 | `build.py` + `dedup.py` | AST seen_ids / NetworkX 幂等 / MinHash+LSH 模糊 |
| Leiden 社区检测 | `cluster.py` | graspologic Leiden → Louvain 降级，分裂超大社区 |
| god nodes | `analyze.py` | 最高连接度节点，标识"万物流向何处" |
| query/path/explain | `cli.py` | 自然语言查询、最短路径、节点解释 |
| 交互式 graph.html | `exporters/html.py` | vis.js 力导向图，>5000 节点降级为社区元图 |
| Neo4j/FalkorDB 导出 | `exporters/graphdb.py` | 导入图数据库做复杂图查询 |
| MCP server | `serve.py` | 通过 MCP 协议暴露 graphify tools |
| PreToolUse hooks | `hooks.py` + `cli.py` | Claude Code 读文件前 nudge 先查图 |
| 文件监听增量重建 | `watch.py` | 变更文件重抽取 + build_merge 增量合并 |
| 两层缓存 | `cache.py` | AST cache（按文件 hash）+ 语义 cache（按 prompt 指纹） |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| tree-sitter + 30 语言 grammar | 核心 | 确定性 AST 解析，增量解析支持 |
| networkx | 核心 | 图数据结构、Louvain 社区检测、图算法 |
| graspologic | 可选 | Leiden 社区检测（质量优于 Louvain） |
| rapidfuzz | 核心 | Jaro-Winkler 模糊匹配（节点去重） |
| numpy | 核心 | MinHash/LSH 向量化 |
| mcp + starlette | 可选 | MCP server HTTP transport |
| anthropic / openai SDK | 可选 | LLM 语义抽取（多 provider） |
| watchdog | 可选 | 文件变更监听 |
| faster-whisper + yt-dlp | 可选 | 视频/音频转录 |
| pypdf + markdownify | 可选 | PDF 文本抽取 |

### 版本历史

graphify 当前处于 v0.9.x 系列（v1.0 公开发布前的早期访问阶段），由 Y Combinator S26 批次的 Graphify Labs 维护。v0.9.38 是截至解读时的最新版本，近期演进集中在**抽取正确性修复**——仅最近 20 个 commit 就涉及 JS/Kotlin/Swift/SQL/C#/TS 多语言的 extractor 修复、去重确定性改进、callflow 方向感知等。代码库正处于从单文件 `extract.py`（6524 行）向 `extractors/` 包拆分的迁移过程中（见 `extractors/MIGRATION.md`），独立语言 extractor 已迁移完成，config 驱动的核心语言待迁移。

---

## 快速上手

```bash
uv tool install graphifyy      # 或 pipx install graphifyy
graphify install               # 向 AI 助手注册 skill
```

在 AI 助手中输入：

```
/graphify .
```

输出三个文件到 `graphify-out/`：

```
graphify-out/
├── graph.html       浏览器打开 — 点击节点、过滤、搜索
├── GRAPH_REPORT.md  摘要：关键概念、意外连接、建议问题
└── graph.json       完整图谱 — 随时查询，无需重新读文件
```

端到端验证（README 示例，graphify run on FastAPI codebase）：

```text
$ graphify explain "APIRouter"
Node: APIRouter
  Source:    routing.py L2210
  Community: 2
  Degree:    47

$ graphify path "FastAPI" "ModelField"
Shortest path (3 hops):
  FastAPI --uses--> DefaultPlaceholder <--references-- get_request_handler() --references--> ModelField
```

---

## 架构设计解析

### 系统架构

graphify 的架构思想是**确定性优先、语义补充**——代码结构用 tree-sitter AST 确定性地抽取（同一文件 + 同一 grammar 版本永远产生相同结果，可 byte-stable 缓存），只有文档/PDF/图片/视频等非代码内容才调 LLM 做语义抽取。两层抽取结果合并后送入 NetworkX 图构建管线，经过去重、社区检测、分析，最终导出为可查询的 `graph.json` 和可视化的 `graph.html`。

整个系统分五层，从上到下是数据流向，基础设施层贯穿全部：

![分层架构](/vibe-reading/images/articles/graphify-internals/architecture.svg)

五层职责和依赖方向如下。数据从上往下流——入口层接收命令，检测层扫描文件，抽取层产出 nodes+edges，图构建层组装 NetworkX 图，导出层输出文件。基础设施层（缓存、安全、ID 生成）被所有层共享依赖：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
|--------|----------|------------------------|
| 入口与集成层 | `__main__.py` `cli.py` `install.py` `serve.py` `hooks.py` | 隔离外部协议（CLI/MCP/AI 助手），将外部输入翻译为内部命令；保护核心管线不因平台差异变化 |
| 检测层 | `detect.py` `paths.py` | 扫描文件系统并分类，为抽取层提供准确的文件列表；增量 manifest 避免重复扫描 |
| 抽取层 | `extract.py` `extractors/` `llm.py` `semantic_cleanup.py` `ingest.py` | 把源码/文档解析为 nodes+edges，是整个系统的核心——确定性的 AST 抽取 + 可选的 LLM 语义补充 |
| 图构建与分析层 | `build.py` `dedup.py` `cluster.py` `analyze.py` | 把扁平的 nodes+edges 组装为有结构的图，去重消除冗余，社区检测发现子系统边界 |
| 导出与可视化层 | `export.py` `exporters/` `report.py` | 把图结构转化为人类可读（HTML/报告）和机器可查（JSON/图数据库）的产物 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表/分派 | `_DISPATCH` dict in `extract.py` L4655 | 后缀→extractor 的直接映射，新增语言只需加一行 |
| 模板方法 | `_extract_generic()` in `engine.py` L2526 | 固定抽取流程（parse→walk→walk_calls），各语言通过 `LanguageConfig` 填入差异 |
| 策略模式 | `LanguageConfig.import_handler` in `models.py` L45 | 各语言注入专属 import 处理逻辑，统一签名不同实现 |
| 解析器注册表 | `resolver_registry.py` L57 | 跨文件 member-call 解析器按语言注册，`extract()` 不需改 |
| 降级策略 | `_partition()` in `cluster.py` L22 | Leiden→Louvain，LLM 命名→Hub 命名→占位符 |
| 自适应重试 | `_extract_with_adaptive_retry()` in `llm.py` L2034 | LLM 截断时二分递归重试，统一处理三种失败信号 |
| 增量检查点 | `_checkpoint_chunk()` in `llm.py` L2329 | 每个 LLM chunk 完成后立即写 cache，中断不丢已完成结果 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|----------|------|----------|----------|
| `graph.json` | 完整知识图谱（node-link 格式） | 一次构建产出，多次查询复用 | 被所有查询命令加载 |
| Node | 图节点（函数/类/概念/文档段落） | 从抽取到导出全程携带 `id`/`label`/`source_file`/`community` | 通过 Edge 互连 |
| Edge | 图边（calls/imports/inherits/references） | 携带 `relation`/`confidence`/`source_file` | 连接两个 Node |
| Hyperedge | 超边（3+ 节点的群体关系） | 仅 LLM 语义抽取产出 | 包含多个 Node |
| Community | 社区（子系统） | cluster 阶段产出，`{community_id: [node_ids]}` | 包含多个 Node |
| `LanguageConfig` | 语言配置（tree-sitter AST 映射） | 模块级常量，进程生命周期 | 被 `_extract_generic` 消费 |
| `manifest.json` | 文件增量状态 | 每次构建更新 | 驱动增量抽取 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|-----------|----------|--------|----------|
| extractor 函数签名 `(path: Path) -> dict` | `extract.py` | `extract_python`/`extract_js`/`extract_go` 等 | `_DISPATCH` 字典 |
| `LanguageResolver` | `resolver_registry.py` L29 | `_resolve_swift_member_calls` 等 | `register()` 函数 |
| LLM provider | `BACKENDS` dict in `llm.py` L100 | claude/openai/gemini/ollama/bedrock 等 | `BACKENDS` 字典 + `_load_custom_providers()` |
| Exporter | `exporters/base.py` | `html.py`/`graphdb.py` | `export.py` 分派 |

---

## 代码目录

```
graphify/
├── __main__.py        # CLI 入口 main()，install/platform 分派
├── cli.py             # 命令分派 dispatch_command()，所有非 install 子命令
├── extract.py         # AST 抽取编排器（6524 行），_DISPATCH 分派 + extract() 主函数
├── extractors/        # tree-sitter 抽取器包（28 文件，15907 行）
│   ├── engine.py      # _extract_generic 核心（5414 行），walk/walk_calls
│   ├── models.py      # LanguageConfig 数据类 + 符号解析事实
│   ├── resolution.py  # 跨文件符号解析（2828 行），JS/TS/Python import
│   ├── base.py        # _LANGUAGE_BUILTIN_GLOBALS 过滤 + 工具函数
│   ├── go.py          # 独立 extractor 示例（自包含）
│   ├── csharp.py      # C# extractor + partial class 解析
│   └── ...            # ~20 种语言 extractor
├── llm.py             # LLM 语义抽取（3164 行），多 provider + 自适应重试
├── build.py           # NetworkX 图构建（1943 行），三层去重 + phantom-edge 防护
├── cluster.py         # Leiden/Louvain 社区检测（320 行）
├── dedup.py           # 节点去重（842 行），MinHash/LSH + Jaro-Winkler
├── analyze.py         # god nodes + surprising connections（749 行）
├── export.py          # 导出编排（1127 行），to_json + #479 shrink guard
├── exporters/
│   ├── html.py        # 交互式 graph.html（vis.js）
│   └── graphdb.py     # Neo4j/FalkorDB 导出
├── install.py         # AI 助手 skill 注册（2291 行），15+ 平台
├── serve.py           # MCP server（2290 行），HTTP transport
├── hooks.py           # Git hooks + PreToolUse guard（718 行）
├── detect.py          # 文件扫描与分类（2021 行）
├── cache.py           # 两层缓存（1364 行），AST + 语义
├── watch.py           # 文件监听增量重建（1887 行）
├── report.py          # GRAPH_REPORT.md 生成（300 行）
├── paths.py           # 原子写入 + 路径消歧（344 行）
├── security.py        # 路径消毒 + URL 验证（460 行）
├── ids.py             # make_id + normalize_id（50 行）
├── resolver_registry.py  # 跨语言解析器注册表（85 行）
└── semantic_cleanup.py   # 语义抽取结果清洗（336 行）
```

---

## 模块地图

graphify 的五个核心模块各自有明确的职责边界。下图展示模块间的调用与数据传递关系——CLI 命令层是中枢，向下调用检测、抽取、图构建、导出；抽取引擎和 LLM 语义层分别产出 AST 节点和语义节点，合并后送入图构建；基础设施层被所有模块共享依赖：

![模块关系](/vibe-reading/images/articles/graphify-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|----------|-----------|----------|
| 抽取引擎 | tree-sitter AST 确定性抽取 ~40 语言 | `extract()` in `extract.py` L5139 | 确定性抽取是 graphify 的核心价值——不调 LLM、可缓存、可复现。与 LLM 语义层分离保证了代码映射"完全本地" | [抽取引擎](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/01-extraction-engine) |
| 图构建与分析 | 组装 NetworkX 图、去重、社区检测 | `build()` in `build.py` L1264 | nodes+edges 到有结构图的变换是独立的关注点——去重策略、社区算法、phantom-edge 防护都需独立演进 | [图构建与分析](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/02-graph-building) |
| 查询与导出 | 查询 graph.json、导出 HTML/Neo4j | `to_json()` in `export.py` L232 | 查询和导出不依赖抽取过程——只消费 `graph.json`，可独立运行 | [查询与导出](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/03-query-export) |
| LLM 语义层 | docs/PDF/media 的语义抽取 | `extract_corpus_parallel()` in `llm.py` L2227 | LLM 抽取是不确定性的、有成本的、需缓存的——与确定性 AST 抽取物理隔离，避免污染核心管线 | [LLM 语义层](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/04-llm-semantic) |
| 集成与服务 | AI 助手注册、MCP server、hooks | `main()` in `__main__.py` L460 | 外部协议适配（CLI/MCP/15+ AI 助手）变化频繁，隔离在核心管线之外 | [集成与服务](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/05-integration-serving) |

---

## 运行时行为

### 启动流程

graphify 的 CLI 入口是 `graphify.__main__.main()`（`__main__.py` L460），通过 `[project.scripts]` 注册为 `graphify` 命令。启动流程是命令分派式的——`main()` 先尝试 `dispatch_install_cli(cmd)` 处理 install/uninstall，不匹配则委托 `cli.dispatch_command(cmd)` 处理所有其他子命令：

```
graphify .
  └─ __main__.main()                         __main__.py L460
     └─ _run_cli()                           __main__.py L483
        ├─ _check_skill_version()            __main__.py L164  # 版本戳检查
        ├─ dispatch_install_cli(cmd)         install.py        # install/uninstall
        └─ dispatch_command(cmd)             cli.py L805       # 所有其他命令
           ├─ "extract" → extract pipeline   cli.py L2805
           ├─ "cluster-only" → report pipeline  cli.py L1709
           ├─ "query" → query subgraph       cli.py
           ├─ "path" → shortest path         cli.py
           ├─ "explain" → node explain       cli.py
           ├─ "update" → incremental rebuild  cli.py
           └─ "hook-guard" → PreToolUse guard cli.py L582
```

对象装配方式：graphify 不使用 DI 容器或框架——所有对象在 `dispatch_command` 内部按需创建。配置来自命令行参数 + 环境变量（`GRAPHIFY_OUT` 覆盖输出目录、`GRAPHIFY_MAX_WORKERS` 限制并发）。`extract()` 入口处显式 `.clear()` 两个模块级缓存（`_WORKSPACE_PACKAGE_CACHE`、`_XAML_CSHARP_CLASS_CACHE`），避免跨调用状态泄漏。

### 核心运行流程

graphify 的 `/graphify .` 实际分**两阶段**执行。阶段一（`extract` 命令）完成扫描→抽取→构建→聚类→导出 `graph.json`；阶段二（`cluster-only` 命令）重新聚类、命名社区、生成 `GRAPH_REPORT.md` 和 `graph.html`。`extract` 命令在 `cli.py` L4011 明确注释："extract intentionally stops at graph.json + analysis; the report and community labels are produced by `cluster-only`"。

#### 主链路 1：extract 管线（graph 构建）

业务流程：扫描文件 → AST 抽取 → 语义抽取 → 合并 → 构建图 → 去重 → 社区检测 → 分析 → 导出 graph.json

![数据流](/vibe-reading/images/articles/graphify-internals/data-flow.svg)

文字描述：`detect_incremental()`（`detect.py` L1891）扫描文件并分类为 CODE/DOCUMENT/PAPER/IMAGE/VIDEO，增量 manifest 只返回变更文件。代码文件送入 `extract()`（`extract.py` L5139）——Phase 1 逐文件检查 AST cache（`load_cached`），Phase 2 未缓存文件用 `ProcessPoolExecutor` 并行 tree-sitter 解析（CPU 密集，多进程绕过 GIL），Phase 3 做跨文件符号解析（JS/TS import 路径、Python member-call 绑定）。文档/媒体文件送入 `extract_corpus_parallel()`（`llm.py` L2227）——按 token budget 分块，`ThreadPoolExecutor`（max_concurrency=4）并发 LLM 调用，截断时自适应二分重试。两路结果合并为 `{nodes, edges, hyperedges}` dict，送入 `build()`（`build.py` L1264）——`deduplicate_entities` 去重后 `build_from_json` 组装 `nx.DiGraph`。`cluster()`（`cluster.py` L134）跑 Leiden 社区检测（graspologic 缺失时降级 Louvain），分裂超大社区（>25%）。`analyze` 阶段计算 god nodes 和 surprising connections。最后 `to_json()`（`export.py` L232）写入 `graph.json`（带 #479 shrink guard 防止部分抽取覆盖完整图）。

#### 主链路 2：query/path/explain（图查询）

业务流程：加载 graph.json → 子图提取/路径搜索/节点查找 → 格式化输出

文字描述：三个查询命令都从 `load_node_link_graph()`（`paths.py` L318）加载 `graph.json` 为 `nx.Graph`。`query "<question>"` 做关键词匹配 + 社区定位提取 scoped 子图（比全图小得多，适合 AI 助手上下文）。`path A B` 用方向感知的 BFS 搜最短路径（`cluster.py` L94ebee1 提到 "respect edge direction by default"）。`explain "<concept>"` 查找节点并展示所有连接（标注 EXTRACTED/INFERRED）。每个查询结束时 `querylog.log_query()` 记录查询日志 + 更新时间戳，供 `graphify reflect` 的经验学习闭环使用。

#### 主链路 3：hook-guard（PreToolUse 拦截）

业务流程：Claude Code 即将读文件 → graphify hook-guard 检查 → nudge/deny → 放行

文字描述：`graphify install` 向 Claude Code 的 `.claude/settings.json` 注册 PreToolUse hook，当 AI 助手即将 Read/Grep 源码文件时触发 `graphify hook-guard`（`cli.py` L582）。guard 检查 `graphify-out/graph.json` 是否存在且覆盖目标文件——如果存在且新鲜，返回 soft nudge（`_READ_NUDGE`，提示"先查图再读文件"）；strict 模式下返回 deny（`_READ_DENY`，`permissionDecision: "deny"`），但 deny **至多每 session 触发一次**（`_mark_session_denied`），防止 strand agent。所有 hook 逻辑遵循 **fail-open 原则**——任何异常静默返回 exit 0，不阻止用户操作。

---

## 典型修改场景

#### 场景 1：新增一种语言的 extractor

需修改的文件和函数：
- `graphify/extract.py`：`_DISPATCH` 字典（L4655）添加 `".xyz": extract_xyz`；添加 `extract_xyz()` 函数 + `_XYZ_CONFIG = LanguageConfig(...)` 实例化
- `graphify/detect.py`：`CODE_EXTENSIONS` 集合添加 `.xyz` 后缀
- 如需跨文件解析：`graphify/extract.py` L3584 区域 `register_language_resolver()` 注册 `_resolve_xyz_member_calls`
- 对应测试：`tests/test_extract_*.py`

#### 场景 2：修改社区检测参数

需修改的文件和函数：
- `graphify/cluster.py`：`_partition()` 的 `resolution` 参数（L22）——>1 产生更多更小社区，<1 产生更少更大社区
- `graphify/cluster.py`：`_MAX_COMMUNITY_FRACTION`（L80，默认 0.25）、`_MIN_SPLIT_SIZE`（L81，默认 10）、`_COHESION_SPLIT_THRESHOLD`（L82，默认 0.05）
- 调用方：`graphify/cli.py` 中 `cluster(G, resolution, ...)` 的参数传递

#### 场景 3：新增一个 LLM provider

需修改的文件和函数：
- `graphify/llm.py`：`BACKENDS` 字典（L100）添加 entry（`base_url`/`env_key`/`default_model`/`pricing`）
- `graphify/llm.py`：`detect_backend()`（L2827）priority 列表添加新 provider
- 如是 OpenAI-compatible：不需新函数，直接走 `_call_openai_compat()`（L1156）
- 零代码方案：用户在 `~/.graphify/providers.json` 添加配置，`_load_custom_providers()`（L264）自动合并
- 对应测试：`tests/test_openai_custom_endpoint.py`

---

## 测试体系

```
tests/
├── test_extract_cli.py          # 抽取 CLI 端到端
├── test_dedup.py                # 去重逻辑
├── test_build_merge_*.py        # 图构建合并
├── test_csharp_partial_classes.py  # C# partial class
├── test_semantic_similarity.py  # 语义相似度
├── test_hook_strict.py          # hook strict 模式
├── test_tree_html.py            # HTML 导出
├── test_symbol_resolution.py    # 符号解析
├── test_pascal.py               # Pascal 语言
├── test_community_labels_skill.py  # 社区命名
├── fixtures/                    # 跨语言测试夹具
│   ├── cpp_paired/              # C++ 头文件配对
│   ├── objc_mixed/              # ObjC 混合
│   ├── pascal_cross_file/       # Pascal 跨文件
│   └── swift_cross_file/        # Swift 跨文件
└── ...                          # 共 190 个测试文件
```

测试采用扁平结构（不分 unit/integration/e2e），但通过命名约定区分层次：`test_extract_*` 是抽取端到端、`test_dedup`/`test_build_merge` 是图构建单元、`fixtures/` 提供跨语言的真实代码夹具。修改某层代码时，参照文件名前缀找到对应测试——如改 C# extractor 看 `test_csharp_*`，改 hook 看 `test_hook_*`。`fixtures/` 下的跨语言夹具是理解 extractor 行为的最佳"可执行文档"。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `__main__.py` 的 `main()`（L460）→ `cli.py` 的 `dispatch_command()`（L805）→ `extract.py` 的 `extract()`（L5139）→ `build.py` 的 `build()`（L1264）→ `export.py` 的 `to_json()`（L232）
  读这条链路理解"从 `/graphify .` 到 `graph.json` 的数据如何流转"。

- **第二遍：理解核心数据结构**
  `extractors/models.py` 的 `LanguageConfig`（L13）→ `extractors/engine.py` 的 `_extract_generic()`（L2526）→ `build.py` 顶部注释的三层去重策略（L1-21）→ `cluster.py` 的 `_partition()`（L22）
  读这些理解"40 种语言如何被统一抽取、节点如何去重、社区如何检测"。

- **第三遍：理解扩展机制**
  `extract.py` 的 `_DISPATCH` 字典（L4655）→ `resolver_registry.py` 的 `register()`（L57）→ `llm.py` 的 `BACKENDS` 字典（L100）→ `install.py` 的平台分派
  读这些理解"如何新增语言、新增解析器、新增 LLM provider、新增 AI 助手平台"。

- **第四遍：选择重点子模块深入阅读**
  [抽取引擎](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/01-extraction-engine) · [图构建与分析](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/02-graph-building) · [查询与导出](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/03-query-export) · [LLM 语义层](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/04-llm-semantic) · [集成与服务](/vibe-reading/articles/AI/Agent/AICoding/Graphify/CodeWiki/0.9.38/05-integration-serving)
