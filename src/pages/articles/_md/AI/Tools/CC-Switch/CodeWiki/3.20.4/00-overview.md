---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "Overview"
date: "2026-09-23T22:18:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "TypeScript", "Tauri", "供应商切换", "本地代理", "Claude Code"]
description: "CC Switch v3.20.4 源码架构解读——9+1 个 AI CLI 工具的供应商切换器：SQLite SSOT + live 投影、本地代理热切换（格式转换/故障转移/熔断）、MCP/Prompts/Skills 统一管理、双路用量计量全解"
readingTime: "70 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** 3.20.4 · **协议** MIT · **技术栈** Tauri 2 + Rust 1.x + React 18 + TypeScript 5 · **代码量** Rust 后端 ~213k 行 + 前端 ~103k 行 · **仓库** [GitHub](https://github.com/farion1231/cc-switch) · **官网** [ccswitch.io](https://ccswitch.io)

---

## 总览

### 项目简介

CC Switch 是 Claude Code、Codex、Gemini CLI 等 **10 个 AI 编程工具**的全方位管理桌面应用——核心痛点：每个工具都有自己的配置格式（JSON/TOML/.env），切换 API 供应商意味着手动编辑配置文件，且各工具间缺乏统一的 MCP/Skills 管理方式。CC Switch 用一个桌面应用收拢这一切：50+ 供应商预设一键导入、一键切换、系统托盘即时切换、统一 MCP/Prompts/Skills 面板、本地代理热切换（格式转换 + 自动故障转移）、用量成本仪表盘、WebDAV/S3 云同步。GitHub 34k+ star，Trendshift 认证项目。

**项目边界**：本体是配置切换器 + 本地代理，不是 API 网关服务（无多用户/鉴权），也不托管模型。Deep Link 生成器（deplink.html）是仓库内的静态工具页。

**一句话 take-home**：这是一个把"九个工具的配置文件地狱"抽象成 **SQLite SSOT + live 文件投影 + 本地代理注入**三层架构的桌面应用——切供应商从"改文件重启"变成"改内存下一请求生效"。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|---|---|---|
| 供应商一键切换 | services/provider + config writers | 双模式：写 live / 代理接管热切换 |
| 本地代理（格式转换） | proxy/providers/（~50k 行） | Anthropic ↔ OpenAI ↔ Gemini 双向矩阵 |
| 故障转移 + 熔断 | proxy/provider_router + circuit_breaker | 候选链 + 三态熔断器 |
| MCP 统一面板 | services/mcp.rs + mcp/ 格式适配 | 7 工具启用矩阵，双向同步 |
| Prompts 同步 | services/prompt.rs | CLAUDE.md/AGENTS.md/GEMINI.md/SOUL.md + 回填保护 |
| Skills 市场 | services/skill.rs（~7k 行） | GitHub/skills.sh/ZIP + SSOT symlink 投影 |
| 用量仪表盘 | usage_stats.rs + session_usage_* | 双路计量（会话回放 + 代理实时）+ models.dev 定价 |
| OAuth 托管 | proxy/providers/*_oauth_auth.rs | Codex/Copilot/xAI 三家 Device Flow |
| 云同步 | sync_protocol.rs + webdav/s3 | 整库快照 + 双层版本门禁 |
| Deep Link | deeplink/ | ccswitch:// 四种资源三段式导入 |

### 技术栈

| 依赖 | 类型 | 用途 |
|---|---|---|
| Tauri 2 | 核心 | 桌面壳（前端 React + 后端 Rust 进程间 invoke） |
| axum / hyper | 核心（代理） | 本地 HTTP 服务器（手动 accept loop 保留 header 大小写） |
| rusqlite | 核心 | SQLite SSOT（Mutex<Connection> 包装） |
| toml_edit / rt-json5 / serde_yaml | 核心 | 各工具配置格式的保注释增量编辑 |
| TanStack Query | 前端 | 全局状态中枢（无 zustand/redux） |
| shadcn/ui + Tailwind | 前端 | 组件库 |
| dnd-kit | 前端 | 供应商拖拽排序 |

### 版本历史

v3.7.0 引入统一 MCP 结构（SSOT 数据库为 master）；v3.8+ Deep Link config 扩展；v3.10.0+ Skills SSOT 目录化；v3.16+ 双层版本同步协议（protocol v2 + db-v6）；v3.20.4 当前版（SCHEMA_VERSION=19）。CHANGELOG.md 563KB——迭代极快的活跃项目。

## 快速上手

```bash
git clone https://github.com/farion1231/cc-switch.git && cd cc-switch
pnpm install
pnpm dev        # Tauri 开发模式（前端 HMR + Rust 增量编译）
pnpm test:unit  # vitest 单测
```

预期：桌面窗口启动，AppSwitcher 显示 10 个工具，添加一个供应商后一键切换。

## 架构设计解析

### 系统架构

![CC Switch 分层架构：前端 React → Tauri 命令 → 服务层 → 本地代理/持久化](/vibe-reading/images/articles/cc-switch-internals/architecture.svg)

架构思想：**SSOT（SQLite）+ 投影（live 文件）+ 注入（本地代理）**。前端编辑的一切先进 SQLite（事务性、可同步、可备份），再投影到各工具的 live 配置文件（原子写 + 备份回滚）；代理接管模式下 live 只指向 127.0.0.1 占位符，真实凭据与格式转换由代理逐请求注入——切换变成纯内存操作。

| 架构层 | 包含目录 | 层职责 |
|---|---|---|
| 前端 React 渲染层 | `src/`（103k） | 编辑体验、视图状态机、预设模板 |
| Tauri 命令层 | `commands/`（38 模块） | IPC 薄封装 + State 管理 |
| 服务层 | `services/`（业务核心） | 供应商/用量/MCP/Skills/同步 |
| 本地代理引擎 | `proxy/`（24.6k + providers 50k） | 热切换、故障转移、wire 级伪装 |
| 持久化与同步 | `database/` + sync 协议 | SQLite SSOT + 整库快照云同步 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| SSOT + 投影 | SQLite 是唯一真源，live 是派生物 | 事务性 + 原子切换 + 可同步 |
| wire 级伪装 | 手动 hyper loop peek 原始字节 | 网关按 header 大小写做指纹校验 |
| 反应式整流 | thinking 三件套遇错再修 | 供应商怪癖无法枚举 |
| 不透明信封 | reasoning_bridge 版本化前缀 | 无状态多轮 reasoning 不丢 |
| 保守清理 | Skills 验证后才删 | 宁可不清理也不误删用户文件 |

### 核心概念

#### 核心对象

| 对象 | 含义 | 主要关系 |
|---|---|---|
| Provider | 供应商卡（settings_config + meta 30+ 字段） | PK (id, app_type)；is_current 标记 |
| ProxyState | 代理全局状态（DB/熔断器/当前供应商/OAuth） | 共享 Arc 跨请求 |
| McpServer | MCP 定义（宽松 JSON spec + 7 工具启用矩阵） | 投影到各工具格式 |
| InstalledSkill | 技能记录（GitHub 坐标 + content_hash） | SSOT 目录的元数据 |
| TokenUsage | 四 token 计量（input/output/cache_read/cache_creation） | 双路归一落库 |

#### 核心抽象

| 抽象 | 定义位置 | 实现类 | 注册方式 |
|---|---|---|---|
| `ProviderAdapter` | proxy/providers/adapter.rs:16 | Claude/Codex/Gemini 三 adapter | get_adapter(AppType) |
| `ProviderType` | providers/mod.rs:133 | 9 种变体 | from_app_type_and_config |
| `CircuitBreaker` | proxy/circuit_breaker.rs | 三态熔断 | key "app:provider" + HalfOpen 许可协议 |
| `SkillService` | services/skill.rs | — | SyncMethod 三档（Auto/Symlink/Copy） |
| `#[tauri::command]` | commands/ 38 模块 | — | lib.rs invoke_handler |

## 代码目录

```
cc-switch/
├── src/                      # 前端 React（103k 行）
│   ├── components/           #   61k：providers/forms（ProviderForm 98.7K 单文件）等 20 子目录
│   ├── config/                #   22k：1500+ 供应商预设（按 app 一文件）
│   ├── lib/api/               #   27 个 invoke 包装域文件
│   └── lib/query/             #   TanStack Query 中枢
├── src-tauri/src/             # Rust 后端（213k 行）
│   ├── proxy/                 #   本地代理引擎 24.6k + providers 格式转换 50k
│   ├── services/              #   业务核心（skill.rs 271K / proxy.rs 407K / usage_stats.rs 161K）
│   ├── commands/              #   38 个命令模块
│   ├── database/              #   SQLite 16 表 + dao 13 文件
│   ├── tray.rs                #   托盘（Rust 自绘，~1790 行）
│   └── lib.rs                 #   2434 行装配
├── docs/release-notes/       # 发布说明
└── deplink.html              # Deep Link 生成器（静态页）
```

## 模块地图

![模块依赖：应用骨架、数据面与持久化、领域子系统三列](/vibe-reading/images/articles/cc-switch-internals/module-dependencies.svg)

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|---|---|---|---|---|
| 前端 React 层 | 编辑体验 + 预设 | App.tsx 状态机 | 渲染进程独立演进 | [01-frontend](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/01-frontend) |
| 供应商管理与 OAuth | 切换 + 认证 + 订阅 | ProviderService::switch | 切换是产品核心动作 | [02-providers-oauth](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/02-providers-oauth) |
| 配置写入引擎 | 10 工具的 live 投影 | write_live_snapshot | 每工具格式策略不同 | [03-config-writers](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/03-config-writers) |
| 本地代理引擎 | 热切换 + 故障转移 | RequestForwarder::forward_with_retry | 数据面独立于配置面 | [04-proxy-engine](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/04-proxy-engine) |
| 格式转换层 | 四格式双向矩阵 | anthropic_to_responses | 全库最高连接度核心 | [05-transform](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/05-transform) |
| MCP/Prompts/Skills | 跨工具资产管理 | SSOT 投影三件套 | 三个子系统共享模式 | [06-mcp-prompt-skill](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/06-mcp-prompt-skill) |
| 用量统计 | 双路计量 + 定价 | sync_all_unlocked | 直连/接管两模式统一 | [07-usage](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/07-usage) |
| 数据库与云同步 | SSOT + 快照同步 | apply_schema_migrations | 持久化独立于业务 | [08-database-sync](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/08-database-sync) |
| Tauri 命令与服务层 | IPC + 装配 + 托盘 | lib.rs run() | 壳层粘合 | [09-tauri-services](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/09-tauri-services) |

## 运行时行为

### 启动流程

```
lib.rs::run() → Database::init（迁移前备份 + user_version 迁移 + update_hook）
→ get_init_error 探测（db 过新 → DatabaseUpgrade 恢复界面）
→ 注册 38 个命令 + Deep Link + 托盘
→ 周期任务：session 用量同步（60s）、周期备份（24h）
→ 前端 bootstrap()：React Query + ThemeProvider + UpdateProvider + App
→ models.dev 定价异步同步（失败不阻塞）
```

### 核心运行流程

#### 切换供应商：双模式的分流

入口 `ProviderService::switch`——检测代理接管状态（`proxy_live_backup` 表 + live 占位符双判定）：接管态走 `hot_switch_provider_inner`（只改 DB，下一请求生效）；普通态走 `switch_normal`（**backfill 优先**回填外部编辑 → 更新 is_current → write_live_snapshot 原子写 live → Codex 四文件事务快照回滚 → MCP 重投影）。

#### 代理请求：一次 Claude Code 请求的旅程

![代理请求路径：接收 → 路由 → 格式转换 → 转发 → 响应转换 → 故障转移判定](/vibe-reading/images/articles/cc-switch-internals/data-flow.svg)

`server.rs` 手动 hyper loop（peek 原始字节保留 header 大小写）→ `handlers.rs` 读 RequestContext（候选链）→ `forwarder.rs::forward_with_retry` 按序遍历（熔断放行 → PRE-SEND 优化 → forward 单次尝试 → 2xx 语义校验）→ 成功且 provider 变了异步热切换托盘；失败依次试 media/thinking signature/thinking budget 整流重试 → 响应经 `streaming_*.rs` 转回 Anthropic SSE（BufferedCitationTextState 引用缓冲）→ 边转发边抽 usage 计价落库。

#### 云同步：变更自动上推

DB update_hook（9 张配置表白名单）→ debounce 1s/最多 10s 合并 → 整库快照（db.sql + skills.zip + SHA-256 manifest）upload；download 永远手动按钮——冲突模型是用户选哪份覆盖。

## 典型修改场景

#### 场景 1：新增一个预设供应商

仅前端 `config/xxxProviderPresets.ts` 加一条（templateValues + endpointCandidates）；要余额显示则 `services/balance.rs::detect_provider` 加子串。见[02](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/02-providers-oauth)。

#### 场景 2：新增一种上游 API 格式

`claude.rs` 加 api_format 分支 → 新建 transform_foo.rs + streaming_foo.rs（参照 gemini 模板）→ handlers 流式分发加分支。见[05](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/05-transform)。

#### 场景 3：新增一张 SQLite 表

schema.rs 幂等 DDL + SCHEMA_VERSION 递增 + 迁移分支 + 同步语义决策（SYNC_SKIP/PRESERVE_TABLES 或 bump DB_COMPAT_VERSION）+ dao 新文件。见[08](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/08-database-sync)。

## 测试体系

| 层 | 测试 |
|--------|------|
| Rust 单测 | `database/tests.rs`（1330 行，每版本迁移夹具）+ 各 dao 内联测试 |
| 前端单测 | vitest + Testing Library + msw（`*ProviderPresets.test.ts` 预设回归敏感） |
| Rust 集成 | proxy/providers 的转换/流式测试（`session-manager.md` 记录会话测试设计） |

```bash
pnpm test:unit                          # 前端
cd src-tauri && cargo test              # Rust
```

## 阅读源码推荐路线

- **第一遍：一次切换走通**——`services/provider/mod.rs:5712` 的 `switch` → `live.rs:1312` 的 `write_live_snapshot` → 任选一个 writer（推荐 `gemini_config.rs`，最小）→ `config.rs:383` 的 `atomic_write`
- **第二遍：一次代理请求走通**——`proxy/server.rs:94` 的 `start`（读手动 accept loop 的 header 大小写注释）→ `forwarder.rs:429` 的 `forward_with_retry_inner` → `transform_responses.rs:1775` 的 `anthropic_to_responses` → `streaming_responses.rs:2359` 的主状态机
- **第三遍：SSOT 体系**——`database/mod.rs` 顶部架构注释 → `schema.rs:445` 的迁移循环 → `sync_protocol.rs` 的快照/版本门禁 → `services/skill.rs:563` 的 SSOT 目录
- **第四遍：安全防御面**——`services/skill.rs:3117` 的 GitHub 坐标双防线 → `database/backup.rs:35-83` 的 authorizer 长注释 → `deeplinkRisk.ts` 的脱敏分级

## 附录

### 术语表

| 术语 | 含义 |
|---|---|
| live 配置 | 各 CLI 工具实际读取的配置文件（`~/.claude/settings.json` 等）——SSOT 的投影 |
| 代理接管（takeover） | live 的 base_url 指向本地代理占位符，凭据由代理注入的模式 |
| api_format | meta 字段：anthropic / openai_chat / openai_responses / gemini_native——决定转换路径 |
| backfill | 切走供应商前把 live 的外部编辑回填进 DB |
| 整流器（rectifier） | 上游报错后匹配错误文本、改写请求体重试的反应式修复 |
| keyless 卡 | OAuth 型供应商卡本身无 key，凭据由代理注入 |
| SSOT 目录 | Skills 内容的单一存储（`~/.cc-switch/skills/`），各工具目录是 symlink/copy 投影 |
| reasoning 信封 | `ccswitch-*-v1:` 前缀的 base64url——跨协议无损搬运加密推理状态 |
| DB_COMPAT_VERSION | 快照 SQL 的"代"号——与 SCHEMA_VERSION 独立，破坏可移植性才递增 |
| 双向同步 | DB→live 是写后即投影；live→DB 仅显式导入且不反向写回 |

### 参考资料

- [README](https://github.com/farion1231/cc-switch/blob/main/README_ZH.md) · [CHANGELOG](https://github.com/farion1231/cc-switch/blob/main/CHANGELOG.md) · [官网 ccswitch.io](https://ccswitch.io)
- 本系列模块文档（9 篇，见模块地图）
