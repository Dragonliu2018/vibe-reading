---
source:
  type: "源码解读"
  project: "RTK"
  url: "https://github.com/rtk-ai/rtk"
title: "Token 统计"
date: "2026-08-25T10:45:03+08:00"
category: [AI, Agent, "AI Coding", RTK, CodeWiki, "0.45.0"]
tags: ["RTK", "Rust", "CLI 代理", "Token 统计"]
description: "RTK analytics/ 模块：rtk gain 仪表盘、ccusage 集成与加权 CPT 账单经济学。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/RTK/CodeWiki/0.45.0/00-overview)

---

## 模块定位

`src/analytics/`（~2759 行）是 RTK 的**统计与经济学分析层**——读 `core/tracking` 写入的 SQLite 历史库生成 `rtk gain` 节省仪表盘，并关联外部 `ccusage` 工具估算 Claude Code 账单美元节省。它是纯读端，不产生写操作（除 `--reset` 调 `tracker.reset_all()`），消费同一 SQLite 库（`~/.local/share/rtk/tracking.db`）。它的职责边界是：**展示节省量级与代理采纳率**，不参与命令执行或过滤决策——统计是事后观察，不影响代理行为。

## 模块架构

analytics/ 内部分三层：**数据层**（`ccusage.rs` 是 ccusage npm 包的 Rust adapter，子进程调用 + JSON 反序列化）、**聚合层**（`cc_economics.rs` 用 HashMap 以 period key join ccusage 花费与 rtk 节省数据，计算加权 CPT）、**展示层**（`gain.rs` 渲染 TTY 感知的彩色仪表盘 + KPI + 进度条 + 表格）。`session_cmd.rs` 做会话采纳率分析（rtk vs raw 命令比例）。

文字上，三层是经典的数据流水线：`ccusage.rs` 从外部工具拿原始数据 → `cc_economics.rs` 用 period key（日期/周/月）做 join 并计算经济学指标 → `gain.rs` 用 `colored` crate 渲染。`gain.rs` 的 `run()` 用 `match format { "json" => export_json, "csv" => export_csv, _ => display_text }` 选择渲染策略。`tracker.get_summary_filtered()` 用 `WHERE (?1 IS NULL OR project_path = ?1 OR project_path GLOB ?2)` 实现可选的项目范围过滤——同一方法同时服务全局和项目级查询。

## 调用链路

`rtk gain` 默认仪表盘调用链：

```text title="analytics/gain.rs:run() 仪表盘流程"
gain::run(...) -> Result<i32>
├── Tracker::new()                                          # 打开 SQLite
├── resolve_project_scope(project) -> Option<String>        # --project flag
├── tracker.get_summary_filtered(project_scope)              [tracking.rs:595]
│   ├── SQL: SELECT input_tokens, output_tokens, saved_tokens, exec_time_ms
│   │        FROM commands WHERE (? IS NULL OR project_path=? OR project_path GLOB ?)
│   ├── 逐行累加 → total_commands/input/output/saved/time
│   ├── avg_savings_pct = total_saved / total_input * 100
│   ├── get_by_command(project) → GROUP BY rtk_cmd ORDER BY saved DESC LIMIT 10
│   └── get_by_day(project) → GROUP BY date ORDER BY date DESC LIMIT 30
├── print_kpi() × 5 项（commands/input/output/saved+%/time）
├── print_efficiency_meter(avg_savings_pct)                 # █░ 进度条 + 颜色分级
├── hook_check::status() → stderr hook 健康度警告
├── check_rtk_disabled_bypass()                              # 扫近 7 天 session
│   └── ClaudeProvider.discover_sessions() + extract_commands()
│       → 统计 RTK_DISABLED= 使用率 > 10% 时警告
├── trust::untrusted_active_filter_count() → 未信任 filter 警告
├── By Command 表格（动态列宽 + mini_bar + colorize_pct_cell）
└── [--graph] print_ascii_graph(by_day)  / [--history] get_recent_filtered(10)
```

**数据结构变化**：SQLite 行（`commands` 表）→ `GainSummary` struct（`tracking.rs:114`，含 `total_commands`/`by_command`/`by_day`）→ `print_kpi`/`print_efficiency_meter` 渲染为 TTY 彩色输出。`--format json/csv` 走 `export_json`/`export_csv`，序列化 `ExportData{summary, daily?, weekly?, monthly?}`。

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `gain::run()` `gain.rs:15` | `rtk gain` 仪表盘 | match format 选 json/csv/text 渲染策略 |
| `get_summary_filtered()` `tracking.rs:595` | 聚合节省统计 | WHERE + GLOB 支持可选 project 过滤 |
| `print_efficiency_meter()` `gain.rs:331` | █░ 进度条 | 颜色分级（高=绿/中=黄/低=红） |
| `cc_economics::run()` `cc_economics.rs` | 账单经济学 | 加权 CPT 估美元节省 |
| `ccusage::fetch()` `ccusage.rs:54` | 调 ccusage npm 包 | 子进程 + serde，不可用返回 Ok(None) |
| `compute_weighted_metrics()` `cc_economics.rs:113` | 加权 CPT | output=5×input, cache_create=1.25×, cache_read=0.1× |
| `session_cmd::run()` `session_cmd.rs` | 会话采纳率 | rtk vs raw 命令比例 |

</details>

## 核心实现

### bytes/4 估算与节省率口径

`tracking.rs:1320` 的 `estimate_tokens` 用 `ceil(len/4)` 估算 token——4 bytes/token 是 OpenAI tiktoken 对英文的近似值。**为何不用真 tokenizer**：RTK 是零依赖 CLI，引入 tiktoken/tokenizers 会增加网络延迟和依赖；对"节省量级"统计足够精确，且这个估算只用于 tracking，不参与过滤决策（`never_worse` 两边同口径比较，结果可靠）。

节省率有两层口径，刻意分离：
- **bash output 压缩率**（`tracking.rs:425`）：`savings_pct = (input - output) / input`，衡量"原始命令输出被压缩了多少"——这是 `rtk gain` 仪表盘的数字，也是 RTK 官方"60-90%"口径。
- **throughput 占比**（`cc_economics.rs:104`）：`saved / (saved + input + output)`，衡量节省占总体吞吐的比例——用于月度经济学。

这种分离体现 RTK 对口径的诚实：README 开宗明义说"bash output 是 input token 的一项，input token 是账单的一部分，节省在每个步骤稀释"。`rtk gain` 报的是 bash output 压缩率，不是账单节省率；账单级节省要靠 cc_economics 模块关联 ccusage 估算。

### ccusage 集成与加权 CPT

`ccusage.rs` 是 ccusage npm 包的 Rust adapter——ccusage 没有 Rust 绑定，通过 `ccusage daily/weekly/monthly --json --since 20250101` 子进程 + serde 反序列化集成。优先用全局 `ccusage` binary，fallback 到 `npx --yes ccusage`。**优雅降级**：ccusage 不可用时返回 `Ok(None)`，不阻断——`PeriodEconomics` 的 ccusage 字段全用 `Option`，合并逻辑用 `Option::map` 处理缺失。字段 alias（`#[serde(alias = "period")]`）处理 ccusage 版本变更兼容。

`cc_economics.rs` 的核心是**加权 CPT（Cost Per Token）**——用 API 价格比加权而非简单 `cost/total_tokens`：

```rust title="src/analytics/cc_economics.rs:113 加权 CPT"
// API 价格比: output=5x input, cache_create=1.25x, cache_read=0.1x
let weighted_units = input + 5.0 * output + 1.25 * cache_create + 0.1 * cache_read;
let input_cpt = cost / weighted_units;        // 加权 input 单价
let savings = saved_tokens * input_cpt;        // 节省的美元
```

**为何加权**：Claude API 的 output token 价格是 input 的 5 倍，cache read 仅 0.1 倍。简单 `cost/total_tokens`（blended）会被大量廉价 cache read 稀释，严重低估节省；`cost/(input+output)`（active）忽略 cache，严重高估。加权公式最接近真实计费模型。代码注释明确：blended = UNDERESTIMATES，active = OVERESTIMATES，weighted = PRIMARY（`cc_economics.rs:43-48`）。还有周对齐处理——rtk 用 Saturday 起始，ccusage 用 ISO Monday，`convert_saturday_to_monday()`（`:302`）做 +2 天转换防 join 错位。

### project_path 用 GLOB 而非 LIKE

`tracking.rs:53` 的查询用 `project_path GLOB ?` 而非 `LIKE ?`——文件路径可能含 `_` 和 `%`，LIKE 模式下 `_` 匹配单字符、`%` 匹配任意序列，会误判路径匹配。GLOB 用 `*` 通配符，不误解释路径特殊字符。注释明确："Uses GLOB instead of LIKE to avoid `_` and `%` in paths acting as wildcards."

## 设计模式

| 模式 | 位置（文件名 + 方法名） | 为什么用 |
|------|------------------------|---------|
| Repository 模式 | `tracking.rs` `Tracker` 封装 `Connection` | 所有查询经 prepare + query_map，可选 project 过滤 |
| Trait 多态 | `display_helpers.rs` `PeriodStats` trait | Day/Week/MonthStats 各实现，泛型 `print_period_table<T>` 统一渲染 |
| 策略模式 | `gain.rs:51` `match format` | json/csv/text 三种渲染策略 |
| Adapter 模式 | `ccusage.rs` 是 ccusage npm 包的 Rust adapter | 子进程 + JSON 反序列化 + 字段兼容 |
| 优雅降级 | `ccusage.rs:129` 不可用返回 Ok(None) | 不阻断仪表盘，Option 字段处理缺失 |

## 模块间交互

```text title="analytics 依赖关系"
analytics/gain.rs
  ├── core/tracking::{Tracker, DayStats, WeekStats, MonthStats, GainSummary}  # 读同一 SQLite
  ├── core/display_helpers::{format_duration, print_period_table}
  ├── core/utils::{format_tokens, truncate}
  ├── hooks/hook_check::status()              # hook 健康度
  ├── hooks/trust::untrusted_active_filter_count()
  └── discover/provider + discover/registry   # check_rtk_disabled_bypass

analytics/cc_economics.rs
  ├── super::ccusage (fetch + CcusagePeriod + Granularity)
  ├── core/tracking::{Tracker, DayStats, WeekStats, MonthStats}
  └── core/utils::{format_cpt, format_tokens, format_usd}

analytics/ccusage.rs
  ├── core/stream::exec_capture              # 子进程捕获
  └── core/utils::{resolved_command, tool_exists}

analytics/session_cmd.rs
  ├── discover/provider::{ClaudeProvider, SessionProvider}   # 读 JSONL
  └── discover/registry::{classify_command, split_command_chain}
```

关键：analytics 是**纯读端**，消费 `core/tracking` 写入的同一 SQLite 库，不产生写操作。`core/tracking` 的 `TimedExecution::track()` 在每次 rtk 命令执行时通过 hook 自动写历史——analytics 只是事后读出来算。session_cmd 和 learn 共享 `discover::provider` 读 JSONL session 的基础设施。

## 扩展方式

**修改仪表盘展示**（如增加"按项目分组"维度）：改 `gain.rs:15` `run()` 在主分支加 KPI 行，可能需改 `tracking.rs` `get_summary_filtered()` 加 SQL 查询 + `GainSummary` struct 加字段，`display_helpers.rs` `print_period_table` 泛型渲染辅助。

**修改 ccusage 加权逻辑**（如价格比更新）：改 `cc_economics.rs:19-21` 的 `WEIGHT_OUTPUT`/`WEIGHT_CACHE_CREATE`/`WEIGHT_CACHE_READ` 常量（注释标注 "verified Feb 2026"），同步更新 `test_compute_weighted_input_cpt`（`:1009`）期望值。

**新增统计维度**（如"按命令类型分类"）：改 `tracking.rs` 加 `get_by_category()` 方法（SQL GROUP BY 分类），`gain.rs` 调用并渲染，`export_json`/`export_csv` 加字段。
