---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "配置写入引擎"
date: "2026-09-23T22:08:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "配置文件", "原子写入", "TOML", "YAML", "JSON5", "备份回滚"]
description: "CC Switch 配置写入引擎解读——10 个工具的 live 配置面全景、TOML 全文替换 vs JSON/YAML 增量 upsert vs JSON5 round-trip 三种策略、Pi 乐观并发 revision、Claude Desktop 多文件快照回滚全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`src-tauri/src/services/config.rs` + 各工具专属 writer（codex_config.rs / gemini_config.rs / grok_config.rs / hermes_config.rs / opencode_config.rs / openclaw_config.rs / mcode_config.rs / pi_config/ / claude_desktop 的 app_store.rs）。职责：把 SQLite 里的 Provider 投影到各 AI 工具的 live 配置文件（JSON/TOML/YAML/.env）。**共享地基**：`config.rs:383` 的 `atomic_write`（临时文件 + rename）、`atomic_write_private`（0600 凭据）、`write_json_file`（键排序 pretty）。

## 模块架构

### 10 个工具的配置面全景

| 工具 | 路径 | 格式/段落 | 策略 |
|---|---|---|---|
| **Codex** | `~/.codex/auth.json` + `config.toml` | JSON（OPENAI_API_KEY/tokens）+ TOML（model_provider 指针 + model_providers 表） | **文本级整体替换**，但写前用 `toml_edit::DocumentMut` 做**增量注入**（experimental_bearer_token）+ 迁移（stale reserved provider 表清理） |
| **Gemini CLI** | `~/.gemini/.env` + `settings.json` | KEY=VALUE + `security.auth.selectedType` | .env 全量重写（键排序）；settings **读-改-写 merge** 只插 selectedType。目录 chmod 700、.env chmod 600 |
| **Grok Build** | `~/.grok/config.toml` | `models.default` + `[model."<name>"]` 表 | 整体替换（官方条目快照写回）；代理接管走 `toml_edit` 增量只改 base_url/api_key |
| **Hermes** | `~/.hermes/config.yaml`（支持 HERMES_HOME env + settings 覆盖） | `custom_providers:` 序列 + `model:` 段 | **段落级增量 upsert**：`replace_yaml_section` 只替换目标顶层 section，注释和无关段保留 |
| **OpenCode** | `~/.config/opencode/opencode.json` + `opencode.db` | JSON5 读 / JSON 写；`provider`、`mcp`、`plugin` 段 | 读-改-写：只 insert/remove `provider[id]`，用户自有 model/theme 等保留；根节点非对象时报错而非重建 |
| **OpenClaw** | `~/.openclaw/openclaw.json` | JSON5 | **round-trip JSON5**（rt-json5）保注释/格式；save 前**重读磁盘与 load 快照对比**，外部变更报冲突；无变化跳过写盘 |
| **MCode** | `~/.minimax/config.yaml` | `custom_provider.<id>` 映射 | 增量 upsert；**双层保护**：proper-lockfile 目录锁（stale 10s 回收）+ DB commit 失败回滚旧字节 |
| **Claude Desktop** | macOS `~/Library/Application Support/Claude(-3p)/claude_desktop_config.json` + profile 文件 | `deploymentMode` + gateway profile（inferenceGatewayApiKey 等） | **多文件写 + 快照回滚**：写 4 个文件，`with_rollback` 前 `snapshot_files` 内存快照，失败 `restore_snapshots` 还原或删除 |
| **Pi** | `~/.pi/agent/models.json` + `settings.json` | `providers.<key>` 节点 | **乐观并发**：`read_models_document_with_revision` 记录 SHA-256 作 revision，写前复核，外部改动报 Conflict；replace/remove 还带期望值比对（CAS） |
| **Claude Code** | `~/.claude/settings.json` | `env` 段 | app_config.rs 的写入路径（ANTHROPIC_BASE_URL/AUTH_TOKEN） |

### 备份三档

1. **持久备份文件**（Hermes/OpenClaw）：`~/.cc-switch/backups/<tool>/`，数量上限轮转
2. **内存快照 + 失败回滚**（Codex/Claude Desktop/MCode）：操作前 capture，失败 restore
3. **仅 atomic_write**（Gemini/Grok/OpenCode/Pi）：临时文件 + rename 保证不半写

## 核心实现

### TOML 工具的"全文替换 + 保格式注入"混合

Codex/Grok 的 provider 侧存整个 config.toml 文本，live 写入是**文本级整体替换**——但需要注入 API key 时用 `toml_edit::DocumentMut` 做**保格式保注释的增量修改**（`set_codex_experimental_bearer_token`，:3371：custom id 注入 model_providers 表、reserved id 注入顶层）。写前还有三个迁移函数（`migrate_stale_reserved_provider_tables` 等）处理历史遗留格式。

### JSON5 round-trip：OpenClaw 的注释保留

OpenClaw 用 rt-json5（`RtJSONText`）解析保留原文格式，`set_root_section` 只替换目标顶层 key 的 value——**注释与缩进原样保留**。`save` 时的并发防御：重读磁盘与 load 时快照对比，外部变更报 "config changed on disk" 冲突。

### Pi 的乐观并发（TOCTOU 防御）

`read_models_document_with_revision`（pi_config/mod.rs:298）记录文件 SHA-256 作 revision；修改 providers map 后 `ensure_models_revision`（:408）写前复核 revision，不匹配报 Conflict（"changed outside CC Switch"）。**replace/remove 还带期望值比对**——CAS 语义，防两个 CC Switch 实例并发写。

### Claude Desktop 的多文件事务

`apply_provider` → `apply_provider_to_paths`：写 4 个文件（normal/threep 两个 claude_desktop_config.json 加 deploymentMode、profile JSON、_meta.json）。`with_rollback`（:955）先 `snapshot_files`（:1062）内存快照 4 个文件字节，任何失败 `restore_snapshots`（:1084）用 atomic_write 还原或删除。Proxy 模式的 gateway token 由 `get_or_create_gateway_token`（:278）生成。官方恢复走 `restore_official_at_paths_inner`（1p + 删 profile）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略分发 | `write_live_snapshot` 按 app 分发 | 每工具格式差异大，无法统一 |
| 原子写 | atomic_write（临时 + rename） | 所有工具共享的地基 |
| 乐观锁 | Pi 的 SHA-256 revision + CAS | TOCTOU 防御 |
| 快照回滚 | Codex/Claude Desktop 的 capture/restore | 多文件逻辑事务 |
| Round-trip | OpenClaw rt-json5 | 用户手写的注释/格式保留 |

## 模块间交互

- **上游**：[供应商管理](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/02-providers-oauth)的 `switch_normal` 第三步经 `write_live_snapshot` 进入本层
- **与代理接管**：`apply_proxy_takeover`（grok 等）把 live 的 base_url 改写为 127.0.0.1 占位符——与切换互斥串行化
- **与 MCP/Prompts/Skills**：各自有独立写入路径（见[MCP/Prompts/Skills](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/06-mcp-prompt-skill)），但 Codex 的 MCP 段与 config.toml 同文件——供应商切换整体替换后必须重投影 MCP

## 扩展方式

**支持一个新工具的配置格式**：① 新建 `services/<tool>_config.rs`：路径函数（`get_<tool>_config_path`，支持 settings 覆盖 + env 覆盖）+ 写入函数（选策略：全文替换/增量 upsert/round-trip）；② `write_live_snapshot` 加分发分支；③ 备份策略选一档；④ 若含 MCP 段，接入 `McpService::sync_enabled_for_app`；⑤ 测试覆盖"外部改动"与"写失败回滚"两条路径。
