---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "供应商管理与 OAuth"
date: "2026-09-23T22:05:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "供应商切换", "OAuth", "Device Flow", "SQLite", "原子写入"]
description: "CC Switch 供应商管理解读——双模式切换（普通写 live vs 代理接管热切换）、backfill 优先原则、Codex 四文件事务快照回滚、三家 OAuth Device Flow 差异、keyless 卡设计、余额订阅查询全解"
readingTime: "26 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`src-tauri/src/services/provider/`（12.6k）+ `database/dao/providers.rs` + `proxy/providers/` 的三个 auth manager + `services/balance.rs` + `subscription.rs`。god node：CodexOAuthManager 55 度、CopilotAuthManager 48 度、XaiOAuthManager 40 度。**SQLite 是 SSOT，live 配置文件只是当前供应商的投影**（provider.rs:7 注释："不再写供应商副本文件"）。

## 模块架构

### Provider 数据模型

- **`Provider`**（provider.rs:11）：`id`、`settings_config: Value`（核心，app 各异：Claude 是 `{env:{ANTHROPIC_BASE_URL,...}}`；Codex 是 `{auth:{...}, config:"<TOML 字符串>"}`）、`category`（official/custom）、`in_failover_queue`
- **`ProviderMeta`**（provider.rs:444）：**不写 live、仅存 DB** 的 30+ 字段——`api_format`（anthropic/openai_chat/openai_responses/gemini_native，决定代理是否做格式转换）、`api_key_field`、`auth_binding`（绑定托管 OAuth 账号）、`provider_type`（github_copilot/codex_oauth/xai_oauth）、限额等
- **SQLite**：`providers` 表 **PK (id, app_type)**——同 id 可在多 app 下存在；`is_current` 单行标记。DAO 的 `replace_provider_id` 改 id 时先插新行再迁 endpoints/health 再删旧行（避免中间态）；`save_provider` UPSERT 更新时**保留** is_current/in_failover_queue
- **种子**：仅 5 条 `OFFICIAL_SEEDS`（每 app 一条官方入口），settings flag `official_providers_seeded` 保证**每库只跑一次**——删除后不重建（尊重用户意图）

### 切换机制：双模式

入口 `ProviderService::switch`（services/provider/mod.rs:5712）分两条路径：

**代理接管（takeover）模式**：若 `proxy_live_backup` 表有备份或 live 里检测到代理占位符 → `hot_switch_provider_inner`——只更新 DB `is_current`，**live 保持 `ANTHROPIC_BASE_URL = http://127.0.0.1:<port>`**，真实凭据由本地代理逐请求注入。**禁止切到官方供应商**（官方 API 走代理可能封号；仅 Codex 官方放行原生认证直通）。

**普通模式 `switch_normal`**（mod.rs:5805）四步：

1. **Backfill**（切走前）：把 live 文件里用户直接改过的内容回填到旧 provider 的 DB 行（`restore_live_settings_for_provider_backfill`，live.rs:1057）——**用户在应用内直接改的偏好/hook/插件不丢**
2. 更新 DB `is_current`
3. **写 live**：`write_live_snapshot`（live.rs:1312）按 app 分发（见[配置写入引擎](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/03-config-writers)）
4. **Codex 托管 OAuth 是四文件事务**：`CodexLiveStateSnapshot::capture()` 捕获 auth/config/catalog/marker 快照，任何一步失败整体回滚——**防止"CLI 轮换过的新 token 被旧 DB 行覆盖"**
5. MCP 重投影（Codex 的 `[mcp_servers]` 与 config.toml 同文件、整体替换后必须补回），失败降级 warning 不阻断

**切换与接管互斥串行化**（`lock_switch_for_app` 按 app）——防刚启动的 takeover 被普通 live 写覆盖。

## 核心实现

### OAuth 三家：多账号 Device Flow，凭据由代理注入

三家都落在 `proxy/providers/`（因为本地代理在请求时注入真实凭据）：

| Manager | 流程特点 | 存储 |
|---|---|---|
| **CodexOAuthManager**（codex_oauth_auth.rs:388） | OpenAI 设备码流程；**code_verifier 由 OpenAI 服务端返回**（形似 PKCE 但 verifier 托管在服务端）；refresh 提前 60s 缓冲；并发设计极重——`login_epoch`（AtomicU64，clear_auth 后在飞登录无法重新登记）+ 每账号 refresh 锁 + `lifecycle_lock`/`storage_lock` | `~/.cc-switch/codex_oauth_auth.json`（仅 refresh/id_token 持久化，access 只在内存）；托管切换时写 CLI 原生形状的 auth.json（RFC3339 纳秒 `last_refresh`）+ marker 文件声明所有权 |
| **CopilotAuthManager**（copilot_auth.rs:416） | 标准 GitHub Device Flow，**client_id 用 VS Code 的**；支持 GHES 企业域；**两级 token**：GitHub OAuth（持久）→ 每次调 `copilot_internal/v2/token` 换短命 Copilot token（到期前 60s 刷新，双检查锁） | `~/.cc-switch/copilot_auth.json`，v1 单账号自动迁移 v3 |
| **XaiOAuthManager**（xai_oauth_auth.rs:190） | **端点从 OIDC discovery 文档动态解析**（协议变化不用改代码）；轮询有 slow_down 自适应间隔、24h 上限防御 | `~/.cc-switch/xai_oauth_auth.json`（临时文件 + rename + chmod 600） |

**Keyless 卡设计**（provider.rs:90 `uses_proxy_injected_oauth`）：xai_oauth/github_copilot 卡**本身无 key**，真实凭据由代理逐请求注入，存储的 config 只是上游快照；`codex_oauth` 刻意排除——auth.json 里的官方登录就是它的凭据。

### 余额/订阅查询

- **`balance.rs`**（455 行）：按 base_url 子串检测 6 家（DeepSeek/StepFun/SiliconFlow/OpenRouter/Novita…），返回统一 `UsageResult`。**错误通道二分法**（模块头文档）：`Err(String)` = 瞬时传输失败（前端 retry + keep-last-good）；`Ok(success:false)` = 确定性失败（空 key/鉴权失败）立即透出——为区分先 `resp.bytes()` 再 parse（reqwest 的 `json()` 会把读体错误也包成 decode）
- **`subscription.rs`**（1597 行）：**只读 CLI 已有 OAuth 凭据，不实现登录**。凭据优先 macOS Keychain，回退文件；查询 Claude `api/oauth/usage`、Codex `chatgpt.com/backend-api/wham/usage`、Gemini `cloudcode-pa` 内部端点。成功后写 UsageCache + emit + 托盘刷新；**Err 不写快照不 emit**（防抹掉该保留的旧值）。结果 `SubscriptionQuota { QuotaTier{five_hour/seven_day}, ExtraUsage }`——托盘 suffix 显示剩余额度

### 预设系统

前端 `src/config/*ProviderPresets.ts` 共约 **1500+ 条预设**（opencode 371、hermes 363…），`ProviderPreset` 含 `settingsConfig`/`templateValues`（表单变量动态替换）/`endpointCandidates`/`apiFormat`。**预设是纯前端模板**——入库后即独立记录；后端只有 5 条官方 seed 与前端"官方预设"一一对应（providers_seed.rs 头注释显式交叉引用）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| SSOT + 投影 | SQLite 唯一存储 | 事务性并发写保护 + 整库快照同步 |
| Backfill 优先 | switch_normal 第一步 | 外部编辑不丢 |
| 快照事务 | CodexLiveStateSnapshot 四文件 | 防 CLI 轮换的新 token 被旧 DB 覆盖 |
| Keyless + 注入 | uses_proxy_injected_oauth | 凭据不落 provider 卡 |
| 错误二分 | balance.rs Err vs Ok(false) | 前端缓存策略正确分派 |

## 模块间交互

- **与配置写入**：`write_live_snapshot` 按工具分发到各 writer（见[配置写入引擎](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/03-config-writers)）
- **与代理**：`meta.api_format`/`auth_binding` 驱动转发行为；OAuth manager 被 proxy 路由引用注入凭据（见[本地代理引擎](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/04-proxy-engine)）
- **与同步**：providers 表在 auto_sync 白名单里（见[数据库与云同步](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/08-database-sync)）

## 扩展方式

**新增一个预设供应商**：仅前端 `src/config/xxxProviderPresets.ts` 加一条；要余额显示则 balance.rs 的 `detect_provider()` 加子串 + 新增 `query_xxx()`。

**新增第 4 家 OAuth**：新增 `proxy/providers/xxx_auth.rs` manager（仿 xai 最薄）+ `commands/xxx_oauth.rs` State + `commands/auth.rs::ensure_auth_provider` 分支 + `ProviderMeta.provider_type` 加值 + 代理路由注入凭据。

**新增官方入口 seed**：改 `OFFICIAL_SEEDS`（老库因 flag 已置位不会自动获得，需走 `ensure_official_seed_by_id` 修复路径）。
