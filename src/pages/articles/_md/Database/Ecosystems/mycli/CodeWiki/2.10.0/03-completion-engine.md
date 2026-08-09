---
source:
  type: "源码解读"
  project: "mycli"
  url: "https://github.com/dbcli/mycli"
title: "补全引擎"
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

补全引擎之所以拆成三层，本质是要把"无状态的解析"、"有状态的匹配"、"耗时的刷新"三类工作隔离，让它们各自拥有独立的生命周期与测试边界。

解析层（`completion_engine.py`）把光标前的 SQL 文本翻译成 `list[Suggestion]`，是纯函数、零状态——每条 `SuggestRule` 都能脱离数据库和 prompt_toolkit 单元测试，新增 SQL 上下文分支只改规则表、不动分发逻辑。数据+匹配层（`sqlcompleter.py`）必须持有状态：候选词来自数据库实时元数据，会随 `USE` 切换和 DDL 操作变化，把状态集中在此让"取候选集→`find_matches()` 多级 Fuzziness 匹配→排序"成为唯一的可变状态入口。异步刷新层（`completion_refresher.py`）解决"元数据刷新要发 SQL 查询、耗时可达数百毫秒"的矛盾，跑在 daemon Thread 上绝不阻塞 UI 线程的 `get_completions`——所以另起一个 `SQLCompleter` + 独立 `SQLExecute` 连接在后台填好，完成后原子替换在线 completer。

三层协作遵循"解析→匹配→刷新填充"的单一方向：UI 线程调用解析层拿到 suggestion 列表，交给匹配层按类型取候选并模糊排序；刷新层在后台默默重建匹配层的状态、完成后热替换上去。这条数据流是单向的——匹配层从不反向调用解析层，刷新层也只写不读匹配层的内部结构。

## 调用链路

![补全引擎调用链路](/vibe-reading/images/articles/mycli-internals/completion-engine-call-chain.svg)

调用链路背后是两条职责截然不同的路径：一条是用户每敲一个键就要跑的补全生成路径，另一条是偶发触发的后台元数据刷新路径。

补全生成路径对延迟极其敏感（prompt_toolkit 每次按键同步调用 `get_completions`），因此有三处关键设计控制开销：其一，`suggest_type()` 内的 `SuggestRule` 规则引擎顺序遍历、命中即返回，避免对每条 SQL 做全量规则匹配；其二，`SuggestContext` 的 `parsed_cb` / `tokens_wo_space_cb` 配合 `lru_cache` 延迟解析，并非所有规则都需要完整 `sqlparse.parse`，避免无谓开销；其三，`find_matches()` 用 `Fuzziness` IntEnum 给候选排序——完美前缀匹配排在前面、rapidfuzz WRatio 仅在输入 ≥ 4 字符时启用，把昂贵的模糊计算推到最后一层。

后台刷新路径要解决的是"刷新期间用户继续输入"的并发矛盾。`refresh()` 起一个 daemon Thread 跑 `_bg_refresh()`，线程内新建独立 `SQLExecute` 连接——刷新查询绝不抢占用户输入所用的连接。填充元数据时不直接修改在线 completer，而是构造一个全新的 `SQLCompleter`、遍历 `@refresher` 注册表填好后通过 callback 原子热替换上去，读者要么看到旧 dict 要么看到新 dict、永远看不到半更新的中间状态。`_restart_refresh` Event 则在"刷新途中用户又切了数据库"时从头开始，无需杀死线程。

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

**触发时机**：
- mycli 启动时——首次加载 schema 元数据
- 用户执行 `USE` 切换数据库后——自动触发
- 用户执行 `REFRESH` 命令——手动触发
- 执行 DDL 语句（`CREATE TABLE`/`DROP TABLE` 等）后——检测到 schema 变化时自动触发

触发路径：`ClientQueryMixin.refresh_completions()` → 设置当前 schema 指针 → 启动 `CompletionRefresher.refresh()`。

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

补全引擎三层的跨模块依赖恰好对应它们各自的职责边界，每一层只引入它真正需要的库，避免把解析耦合进匹配、或把 IO 耦合进解析。

解析层（`completion_engine.py`）只依赖 `sqlparse` 做 SQL token 化，以及 `packages.special.main.COMMANDS` 识别 `\d` 这类 special 命令——它不需要知道数据库长什么样、也不需要 prompt_toolkit 的 Completion 类型，所以能作为纯逻辑模块独立复用。数据+匹配层（`sqlcompleter.py`）的依赖反映了它的两个职责：`prompt_toolkit.Completer` / `Completion` 提供框架集成接口，`rapidfuzz` 提供 WRatio 模糊匹配，`pygments` 提供内置的 MySQL 关键字/函数/数据类型词表——它还 import 解析层的 `suggest_type`，把"解析→匹配"两层串起来。刷新层（`completion_refresher.py`）的依赖最特殊：import `SQLExecute` 是为了新建一条独立连接跑刷新 SQL，import `SQLCompleter` 是为了在后台构造好替换品——这两条 import 都只服务于"后台构造 + 原子替换"这一个目的。

对外，补全引擎被 `client.py`（启动时触发首次刷新）、`client_query.py`（`USE` / DDL 后触发刷新）、`schema_prefetcher.py`（预取 schema）三处引用——这些上层模块只与 `CompletionRefresher.refresh()` 这一个入口交互，不直接触碰 completer 内部状态，保证了刷新的时序由调用方决定、状态变更由刷新层统一管理。

## 扩展方式

- **新增补全类型**（如 materialized view）：`completion_engine.py` 加 `SuggestRule` → `sqlcompleter.py` 在 `dbmetadata` 加 key + `get_completions()` 加分支 → `completion_refresher.py` 加 `@refresher` 函数
- **新增模糊匹配策略**：`Fuzziness` IntEnum 加成员 → `find_fuzzy_match()` 加分支 → 排序自动生效
- **修改 JOIN 补全优先级**：`sqlcompleter.py` 的 `_fk_join_conditions()` 或 `completion_sort_key()` 调整 FK 权重
