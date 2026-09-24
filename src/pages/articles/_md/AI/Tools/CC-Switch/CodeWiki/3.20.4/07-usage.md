---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "用量统计"
date: "2026-09-23T22:12:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "用量统计", "Token", "定价", "JSONL", "SQLite", "去重"]
description: "CC Switch 用量统计解读——双路计量（本地会话文件回放 + 代理实时）统一落 proxy_request_logs、七个工具的会话文件格式解析器、input token 三态语义归一、跨源去重指纹、30 天 rollup + 剪枝前补价全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`services/usage_stats.rs`（~4.5k 行）+ `session_usage*.rs` 七工具解析器族 + `proxy/usage/` 实时计量三件套 + `database/dao/usage_rollup.rs` + `model_pricing.rs`。目标：**无代理直连模式与代理接管模式双路计量**，统一落库到同一张 `proxy_request_logs` 明细表，30 天后归档成 `usage_daily_rollups` 日聚合。

```
路 a（本地文件回放）  各工具本地会话文件 → session_usage_*.rs 解析 → 去重 → 计价 → INSERT proxy_request_logs
路 b（代理实时）      proxy 响应 → parser.rs 提取 TokenUsage → calculator.rs 计价 → logger.rs INSERT
路 c（聚合）          usage_rollup.rs：>30 天明细 → 日聚合 GROUP BY → 删明细
查询面               usage_stats.rs SQL 聚合 → 前端 UsageDashboard
```

## 模块架构

### 各工具会话解析器（七个，格式各异）

| 工具 | 格式 | 位置 | 关键机制 |
|---|---|---|---|
| Claude Code | JSONL | `~/.claude/projects/*/*.jsonl`（含 `subagents/` 递归） | 字节游标增量 seek + **尾部指纹**检测文件被外部重写，重写区间永久跳过防双算 |
| Codex | **JSONL**（不是 SQLite！） | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count` **累计计数器做 delta 差分**（high-water 处理回绕）；子代理 rollout 用父线程 replay-prefix 匹配防重复记账 |
| Grok Build | JSONL | `~/.grok/{sessions,archived_sessions}/.../updates.jsonl` | 模块头注释极精彩：`turn_completed` 的 usage 是**每轮独立总量而非累计**——"勿改回相邻事件差分：曾犯，实测单进程双 prompt 证伪"；CLI 自报 `costUsdTicks`（1 tick=1e-10 USD）优先于本地定价 |
| Gemini CLI | **JSON**（单对象含 messages 数组） | `~/.gemini/tmp/<hash>/chats/session-*.json` | 每条 message 有唯一 id，天然去重 |
| OpenCode | **SQLite** | `~/.local/share/opencode/opencode.db`（session/message 表） | — |
| Pi | JSONL | `.pi/sessions`（全局/项目两级，128MB 上限） | 游标 `last_synced_at` **编码文件 revision 而非时间戳** |
| MCode | SQLite | `runtime-state.sqlite`，`SQLITE_OPEN_READONLY` 打开不改动原库 | 游标存虚拟 file_path |

增量游标统一存 `session_log_sync` 表（file_path 主键 + line/byte offset + tail fingerprint）。统一入口 `sync_all_unlocked()`（session_usage.rs:120）启动跑一次后**每 60 秒**定时。

### 定价系统三层来源

1. **内置 seed 表**（schema.rs:1620）：硬编码官方牌价（定价注释精确到 cache read 是 0.05x 还是 0.1x）；版本升级"清空 + 重新 seed"；**tombstone 机制**：用户删除的 seed 行不被重新 seed 复活
2. **models.dev 自动同步**（前端拉取，每 6 小时）：models.dev 是 LiteLLM 同源生态的公共模型注册表
3. **用户自定义**：本地 `model-pricing.json` **只存用户/models.dev 覆盖**（不导出完整 seed 表，防内置价被当作 override）

**成本回填闭环**：零成本行由 `backfill_missing_usage_costs_on_conn()`（usage_stats.rs:1804）在启动、**剪枝前**、定价更新后重算。查价走候选归一链（`strip_model_date_suffix` 火山带日期模型、`strip_bedrock_model_version_suffix`、`strip_reasoning_effort_suffix` 等别名清洗）。

### 聚合查询

`usage_daily_rollups` 六列复合 PK：**日期 × app_type × provider_id × model × request_model × pricing_model**——`request_model` 保留"客户端别名→真实模型"的路由审计精度。`usage_stats.rs` 查询面全部先查明细再查 rollup COALESCE 相加；rollup 天只算"被时间区间**完整覆盖**的整天"（部分覆盖天宁可丢弃——宁可少算不重复算）。

## 核心实现

### input token 语义归一（SSOT）

**问题**：Anthropic 的 `input_tokens` 不含 cache read；OpenAI Responses / Gemini / Grok 含。**解决**：`input_token_semantics` 三态列（LEGACY/TOTAL/FRESH）+ `sql_helpers.rs` 的 `fresh_input_sql()` CASE 表达式，**写入侧（logger）、回填侧（backfill）、展示侧（所有聚合 SQL）三处共用**。`CACHE_INCLUSIVE_APP_TYPES = ["codex","gemini","grokbuild"]` 显式列出——注释解释 why：新 app 默认 Claude 语义更安全，漏配表现为"cache hit rate 异常低"（响亮可发现）而非静默多扣。

### 跨源去重（session vs proxy）

同一请求在代理态可能被代理（逐请求）和 session 文件（CLI 照写）**各记一次**。双保险：

- **写入侧** `should_skip_session_insert()`（usage_stats.rs:339）：request_id 已存在，或 `DedupKey` 指纹（app_type + model + 四个 token 数 **±10 分钟窗口**）命中 proxy 行即跳过
- **读取侧兜底** `effective_usage_log_filter()`（:331）：所有查询和 rollup 都挂 `NOT EXISTS(指纹匹配的 2xx proxy 行)` 的 SQL 排除条件——防两种源写入竞态漏网

### 剪枝不可逆 → 剪枝前补价

`rollup_and_prune(30)` 的 cutoff 对齐**本地午夜**（防半天半卷入导致区间查询漏算），在 SAVEPOINT 内先 INSERT OR REPLACE 聚合再 DELETE 明细。**关键防御**：剪枝前强制跑一次 `backfill_missing_usage_costs_on_conn`——"明细一旦汇总删除就永远失去按 pricing_model 补价重算的机会"（usage_rollup.rs:91 注释）；失败仅告警不阻断（防一行坏定价卡死日志清理）。

**游标预取失败 → 中止而非全量重导**：session_log_sync 空表回退 = 对已剪明细失明，全量重导会让旧条目在下次 rollup 时**再次**累加，统计永久放大。

### claude-desktop 展示折叠

Desktop 网关流量按 `app_type='claude-desktop'` 入账（保审计精度），但读侧用 `folded_app_type_sql()`（:257）在**展示口径**折叠进 claude——注释强调"不要回退到存储合并"；额度检查保留原始精确比较。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 双路归一 | session 回放 + proxy 计量同表 | 直连/接管两种模式统一记账 |
| 三态语义列 | input_token_semantics | 跨厂商口径归一且可演进 |
| 指纹 + 窗口 | DedupKey ±10min | 无 request_id 时的兜底去重 |
| 保守聚合 | rollup 只算完整覆盖天 | 宁可少算不重复算 |
| tombstone | seed 删除不复活 | 尊重用户删官方价 |

## 模块间交互

- **与代理**：`proxy/usage/parser.rs` 从四种 API 的流式/非流式响应提取 TokenUsage（OpenAI 系多字段兜底链：`cached_tokens` → `prompt_cache_hit_tokens`，DeepSeek 兼容）
- **与数据库**：`usage_cache.rs` 澄清——它不是 Dashboard 缓存而是**托盘**的进程内写穿式缓存（重启即空），与本子系统仅共享 "usage" 名字
- **与前端**：`lib/query/usage.ts` 的 keep-last-good 10 分钟缓存（见[前端 React 层](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/01-frontend)）
- `TEXT 存金额`（schema）：避免浮点误差

## 扩展方式

**新增一个工具的用量解析**（以 Pi 为模板）：① 新建 `session_usage_<tool>.rs`：定义 `APP_TYPE/DATA_SOURCE/PROVIDER_PLACEHOLDER` 常量 + `sync_<tool>_usage(db)`，复用 load_sync_cursors/update_sync_state/SessionSyncResult；② 接入 `sync_all_unlocked()` 加 merge_sync_step；③ **注册 data_source 到去重 SQL**（`effective_usage_log_filter` 的 IN 列表 + DedupKey cache_creation 通配分支）；④ 展示名 `provider_name_coalesce` 加 CASE；⑤ **input 含 cache 则加入 `CACHE_INCLUSIVE_APP_TYPES`**（注释警告：写入侧、回填侧、fresh_input_sql 三处依赖，grokbuild 曾在回填侧漏掉）；⑥ seed_model_pricing 补牌价 + 前端类型/i18n。
