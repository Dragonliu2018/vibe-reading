---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "补全引擎详解"
date: "2026-08-09T10:30:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "补全", "sqlparse", "rapidfuzz"]
description: "mycli 补全引擎深度解读：三层架构（解析→建议→匹配）、SuggestRule 规则引擎、多级模糊匹配、后台线程刷新。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## 模块定位

补全引擎负责在用户输入 SQL 时实时提供上下文感知的补全建议。它将补全过程拆为三层（解析→匹配→刷新），使解析逻辑可独立测试，元数据刷新不阻塞用户输入。

## 模块架构

![补全引擎模块架构](/vibe-reading/images/articles/mycli-internals/completion-engine-architecture.svg)

三层架构：解析层（`completion_engine.py`，`suggest_type()` + `SuggestRule[]` 规则引擎，纯函数无状态）→ 数据+匹配层（`sqlcompleter.py`，`SQLCompleter` 持有 `dbmetadata` + `Fuzziness` 多级匹配）→ 异步刷新层（`completion_refresher.py`，daemon Thread + 独立连接 + `@refresher` 注册表）。跨层链接：解析层被匹配层调用，刷新层完成后热替换填充匹配层。

## 调用链路

![补全引擎调用链路](/vibe-reading/images/articles/mycli-internals/completion-engine-call-chain.svg)

路径 A（补全生成）：`get_completions(Document)` → `suggest_type()` 解析 SQL 上下文产出 `list[Suggestion]`（经 `sqlparse.parse` + `SuggestRule` 规则引擎）→ 遍历 suggestion 取候选集 → `find_matches()` 多级 Fuzziness 匹配 → 排序输出 `list[Completion]`。路径 B（后台刷新）：`refresh()` → daemon Thread `_bg_refresh()` → 新建 `SQLCompleter` + 独立 `SQLExecute` 连接 → 遍历 `@refresher` 注册表填充元数据 → callback 原子热替换。

<details>
<summary>方法速查表</summary>

| 方法 | 职责 | 关键设计决策 |
|------|------|-------------|
| `SQLCompleter.get_completions()` | 补全入口，返回 Completion 列表 | 遍历 suggestion 列表按类型分发 |
| `suggest_type()` in `completion_engine.py` | 解析 SQL 上下文，产出 suggestion 列表 | 纯函数无状态，SuggestRule 规则引擎 |
| `find_matches()` in `sqlcompleter.py` | 候选集模糊匹配 | 多级 Fuzziness 优先级排序 |
| `load_schema_metadata()` | 原子替换 schema 元数据 | 赋值替换而非 append，保证并发安全 |
| `CompletionRefresher.refresh()` | 启动后台线程刷新 schema | 独立连接 + 新建 completer 实例 |
| `_bg_refresh()` | 后台遍历 @refresher 函数 | `_restart_refresh` Event 支持重启 |

</details>

---

## 核心实现

### 三层补全架构

| 层 | 文件 | 职责 | 状态 |
|----|------|------|------|
| 解析层 | `completion_engine.py` | 输入 SQL 文本 → 输出 `list[Suggestion]` | 无状态纯函数 |
| 数据+匹配层 | `sqlcompleter.py` | 根据 suggestion 类型取候选集 → 模糊匹配 | 有状态（schema 元数据） |
| 异步刷新层 | `completion_refresher.py` | 后台线程填充 completer 元数据 | daemon Thread |

解析层 `suggest_type()` 是纯函数，不持有任何状态，可独立测试。

### SuggestRule 规则引擎

```python title="mycli/packages/completion_engine.py"
@dataclass(frozen=True)
class SuggestContext:
    token: str | Token | None
    token_value: str | None
    text_before_cursor: str
    word_before_cursor: str | None
    full_text: str
    identifier: Identifier
    parsed_cb: Callable[[], sqlparse.sql.Statement]       # 延迟解析
    tokens_wo_space_cb: Callable[[], list[Token]]         # 延迟解析

@dataclass(frozen=True)
class SuggestRule:
    name: str
    predicate: Predicate   # Callable[[SuggestContext], bool]
    emit: Emitter          # Callable[[SuggestContext], list[Suggestion]]
```

`SUGGEST_BASED_ON_LAST_TOKEN_RULES` 是有序的 `SuggestRule` 列表，`suggest_based_on_last_token` 顺序遍历，命中第一个即返回。新增 SQL 语法上下文的补全逻辑只需加一条 `SuggestRule`，无需修改分发逻辑。

`SuggestContext` 用 `parsed_cb` / `tokens_wo_space_cb` 延迟解析（配合 `lru_cache`），避免在不需要完整解析的规则中浪费开销。

### 多级模糊匹配

`Fuzziness` 用 IntEnum 定义，数值越小优先级越高：

| 级别 | 策略 | 示例 |
|------|------|------|
| PERFECT | 精确前缀匹配 | `sel` → `SELECT` |
| REGEX | 正则子串匹配 | `lect` → `SELECT` |
| UNDER_WORDS | 下划线分词前缀 | `stoid` → `STRING_TO_VECTOR` |
| CAMEL_CASE | 驼峰分词匹配 | `joi` → `JOIN` |
| RAPIDFUZZ | rapidfuzz WRatio | 仅 text ≥ 4 字符时启用 |

`completion_sort_key()` 直接用 fuzziness 值作为排序首键——完美匹配排在前面。

### CompletionRefresher：后台刷新

```python title="mycli/completion_refresher.py"
@refresher("tables")
def refresh_tables(completer, executor): ...

@refresher("databases")
def refresh_databases(completer, executor): ...
# 共 13 个 refresher
```

`_bg_refresh` 新建独立 `SQLExecute` 连接和 `SQLCompleter` 实例，完成后通过 callback 返回新 completer。这避免了在刷新过程中对在线 completer 的并发修改——读者（UI 线程的 `get_completions`）永远不会看到半刷新的状态。

`load_schema_metadata()` 通过直接赋值（而非逐条 append）替换 per-schema dict，保证并发读者要么看到旧 dict 要么看到新 dict，不会看到半更新的中间状态。

`_restart_refresh` Event 实现了"刷新过程中如果用户切换了数据库，就从头开始"的语义，不需要杀死线程。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 规则引擎 | `completion_engine.py` SuggestRule[] | SQL 上下文分支多，解耦为独立 predicate-emit 对 |
| 策略模式 | `sqlcompleter.py` find_matches | fuzzy/perfect 两种匹配策略 |
| 装饰器注册 | `completion_refresher.py` @refresher | 新增元数据类型只需加函数 |
| 观察者/回调 | `completion_refresher.py` callbacks | 后台完成后通知主线程热替换 |
| 延迟求值 | `completion_engine.py` lru_cache | 并非所有规则需要完整解析，避免浪费 |
| 原子替换 | `sqlcompleter.py` load_schema_metadata | 赋值替换保证并发读者安全 |

## 模块间交互

![补全引擎模块交互](/vibe-reading/images/articles/mycli-internals/completion-engine-interactions.svg)

`sqlcompleter.py` import `completion_engine.suggest_type`、`prompt_toolkit.Completer`、`rapidfuzz`、`pygments`（MySQL 内置关键字/函数/数据类型）。`completion_engine.py` import `sqlparse`、`packages.special.main.COMMANDS`。`completion_refresher.py` import `SQLCompleter`、`SQLExecute`（新建独立连接）。被 `client.py`、`client_query.py`、`schema_prefetcher.py` 引用。

## 扩展方式

- **新增补全类型**（如 materialized view）：`completion_engine.py` 加 `SuggestRule` → `sqlcompleter.py` 在 `dbmetadata` 加 key + `get_completions()` 加分支 → `completion_refresher.py` 加 `@refresher` 函数
- **新增模糊匹配策略**：`Fuzziness` IntEnum 加成员 → `find_fuzzy_match()` 加分支 → 排序自动生效
- **修改 JOIN 补全优先级**：`sqlcompleter.py` 的 `_fk_join_conditions()` 或 `completion_sort_key()` 调整 FK 权重
