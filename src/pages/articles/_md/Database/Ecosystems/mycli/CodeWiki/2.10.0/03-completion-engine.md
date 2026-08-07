---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "补全引擎详解"
date: "2026-08-07T01:30:00+08:00"
category: [Database, Ecosystems, mycli, CodeWiki, "2.10.0"]
tags: ["mycli", "Python", "补全", "sqlparse", "rapidfuzz"]
description: "mycli 补全引擎深度解读：三层架构（解析→建议→匹配）、SuggestRule 规则引擎、多级模糊匹配、后台线程刷新。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/mycli/CodeWiki/2.10.0/00-overview)

---

## 调用链路

```
SQLCompleter.get_completions(document, complete_event)
├── suggest_type(text, text_before_cursor)       # completion_engine.py
│   ├── sqlparse.parse(text_before_cursor)       # 解析 SQL
│   ├── suggest_special(text)                    # 特殊命令分支
│   └── suggest_based_on_last_token(last_token)  # 规则引擎
│       └── for rule in SUGGEST_BASED_ON_LAST_TOKEN_RULES:
│           ├── rule.predicate(ctx) → bool
│           └── rule.emit(ctx) → list[Suggestion]
│
└── for suggestion in suggestions:               # 遍历建议
    ├── "column" → populate_scoped_cols() → find_matches()
    ├── "table"  → populate_schema_objects() → find_matches()
    └── "keyword" → find_matches(self.keywords)
    └── 排序（fuzziness → rank → length）→ Completion

CompletionRefresher.refresh(executor, callbacks)
└── daemon Thread → _bg_refresh()
    ├── SQLCompleter(**options)                 # 新建 completer 实例
    ├── SQLExecute(...)                         # 新建独立连接
    ├── for refresher in @refresher 注册表:
    │   ├── refresh_databases(completer, executor)
    │   ├── refresh_tables(completer, executor)
    │   └── ... (共 13 个 refresher)
    └── for callback in callbacks: callback(completer)  # 回调通知
```

| 方法 | 职责 | 关键设计决策 |
|------|------|-------------|
| `SQLCompleter.get_completions()` | 补全入口，返回 Completion 列表 | 遍历 suggestion 列表按类型分发 |
| `suggest_type()` | 解析 SQL 上下文，产出 suggestion 列表 | 纯函数无状态，SuggestRule 规则引擎 |
| `find_matches()` | 候选集模糊匹配 | 多级 Fuzziness 优先级排序 |
| `CompletionRefresher.refresh()` | 启动后台线程刷新 schema | 独立连接 + 新建 completer 实例 |
| `CompletionRefresher._bg_refresh()` | 后台遍历 @refresher 函数 | _restart_refresh Event 支持重启 |

---

## 三层补全架构

mycli 的补全过程被拆为三层，各层职责清晰分离：

| 层 | 文件 | 职责 | 状态 |
|----|------|------|------|
| 解析层 | `completion_engine.py` | 输入 SQL 文本 → 输出 `list[Suggestion]` | 无状态纯函数 |
| 数据+匹配层 | `sqlcompleter.py` | 根据 suggestion 类型取候选集 → 模糊匹配 | 有状态（schema 元数据） |
| 异步刷新层 | `completion_refresher.py` | 后台线程填充 completer 元数据 | daemon Thread |

这种分离使得解析逻辑可独立测试，`completion_engine.py` 的 `suggest_type()` 是纯函数，不持有任何状态。

## SQLCompleter：补全主类

```python title="mycli/sqlcompleter.py"
class Fuzziness(IntEnum):
    PERFECT = 0      # 精确前缀匹配
    REGEX = 1        # 正则子串匹配
    UNDER_WORDS = 2  # 下划线分词前缀
    CAMEL_CASE = 3   # 驼峰分词匹配
    RAPIDFUZZ = 4    # rapidfuzz WRatio 模糊匹配

class SQLCompleter(Completer):
    def get_completions(self, document, complete_event) -> Iterable[Completion]: ...
    def find_matches(self, orig_text, collection, fuzzy=True, ...) -> Generator: ...
    def extend_relations(self, data, kind) -> None: ...
    def extend_columns(self, column_data, kind) -> None: ...
```

关键属性 `dbmetadata` 是嵌套 dict：`dbmetadata[kind][schema][relation][columns]`，kind 包含 tables/views/functions/procedures/enum_values/foreign_keys/indexed_columns。

## 补全主流程

```
SQLCompleter.get_completions(document, complete_event)
├── suggest_type(document.text, document.text_before_cursor)
│   ├── sqlparse.parse(text_before_cursor)        # 解析 SQL
│   ├── suggest_special(text)                     # 特殊命令分支
│   └── suggest_based_on_last_token(last_token)   # 规则引擎
│       └── for rule in SUGGEST_BASED_ON_LAST_TOKEN_RULES:
│           ├── rule.predicate(ctx)  → bool
│           └── rule.emit(ctx)       → list[Suggestion]
│
├── for suggestion in suggestions:                # 遍历建议
│   ├── "column" → populate_scoped_cols() → find_matches()
│   ├── "table"  → populate_schema_objects() → find_matches()
│   └── "keyword" → find_matches(self.keywords)
│
└── 排序（fuzziness → rank → length）→ Completion 对象
```

## SuggestRule 规则引擎

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

`SUGGEST_BASED_ON_LAST_TOKEN_RULES` 是有序的 `SuggestRule` 列表，`suggest_based_on_last_token` 顺序遍历，命中第一个即返回。这是策略模式 + Chain of Responsibility 的混合。新增语法上下文的补全逻辑只需加一条 `SuggestRule`，无需修改分发逻辑。

`SuggestContext` 用 `parsed_cb` / `tokens_wo_space_cb` 延迟解析（配合 `lru_cache`），避免在不需要完整解析的规则中浪费开销。

## 多级模糊匹配

`find_fuzzy_match` 按优先级尝试四种匹配：

| 级别 | 策略 | 示例 |
|------|------|------|
| PERFECT | 精确前缀匹配 | `sel` → `SELECT` |
| REGEX | 正则子串匹配 | `lect` → `SELECT` |
| UNDER_WORDS | 下划线分词前缀 | `stoid` → `STRING_TO_VECTOR` |
| CAMEL_CASE | 驼峰分词匹配 | `joi` → `JOIN` |
| RAPIDFUZZ | rapidfuzz WRatio | 仅 text ≥ 4 字符时启用 |

`Fuzziness` 值同时用作排序键——完美匹配排在前面。

## CompletionRefresher：后台刷新

```python title="mycli/completion_refresher.py"
def refresher(name, refreshers=CompletionRefresher.refreshers):
    def wrapper(wrapped):
        refreshers[name] = wrapped
        return wrapped
    return wrapper

@refresher("tables")
def refresh_tables(completer, executor): ...

@refresher("databases")
def refresh_databases(completer, executor): ...
# 共 13 个 refresher
```

`_bg_refresh` 中新建了一个 `SQLExecute` 连接和 `SQLCompleter` 实例，完成后通过 callback 返回。这避免了在刷新过程中对在线 completer 的并发修改——读者（UI 线程的 `get_completions`）永远不会看到半刷新的状态。

`_bg_refresh` 中的 `while 1 / for / else` 结构配合 `_restart_refresh` Event 实现了"刷新过程中如果用户切换了数据库，就从头开始"的语义，而不需要杀死线程。

## 关键设计决策

**三层职责分离**：解析层（completion_engine）是纯函数无状态，数据层（sqlcompleter）持有 schema 元数据，异步层（completion_refresher）负责后台刷新。这使解析逻辑可独立测试。

**后台刷新用独立连接 + 新建 completer 实例**：完成后通过 callback 返回新 completer，旧 completer 继续服务直到被替换。`load_schema_metadata` 的文档注释明确指出"原子替换 per-schema dicts"以保持并发安全。

**Refresher 注册表 + 重启机制**：`@refresher` 装饰器注册模式使新增元数据类型只需加一个函数。`_restart_refresh` Event 实现数据库切换时从头刷新。
