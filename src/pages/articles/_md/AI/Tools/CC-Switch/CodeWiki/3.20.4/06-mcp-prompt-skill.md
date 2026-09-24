---
source:
  type: "源码解读"
  project: "cc-switch"
  url: "https://github.com/farion1231/cc-switch"
title: "MCP、Prompts 与 Skills"
date: "2026-09-23T22:10:00+08:00"
category: ["AI", Tools, CC-Switch, CodeWiki, "3.20.4"]
contentType: "CodeWiki"
tags: ["CC Switch", "Rust", "MCP", "Skills", "Prompts", "SSOT", "symlink", "Deep Link"]
description: "CC Switch MCP/Prompts/Skills 统一管理解读——DB 为 SSOT + live 投影的双向同步语义、回填保护与 restore 窗口互斥、Skills SSOT 目录 + symlink 优先投影 + 两级路径安全、Deep Link 三段式导入全解"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/00-overview)

---

## 模块定位

`services/mcp.rs`（22.3k）+ `services/prompt.rs`（36.8k）+ `services/skill.rs`（271.6K，~7k 行）+ `src-tauri/src/mcp/`（各工具格式适配）+ `deeplink/`。三类"跨工具资产"共享同一套模式：**应用内 SQLite SSOT + 向各工具 live 配置的投影**（v3.7.0 统一结构引入）。

## 模块架构

### MCP：统一面板数据模型

- **`McpServer`**（app_config.rs:272）：`{id, name, server: serde_json::Value, apps: McpApps, ...}`——`server` 是宽松 JSON，同一份 spec 投影到不同工具时由格式适配器转换（Codex 要 TOML、OpenCode 有 local/remote 差异）
- **`McpApps`**：7 个 bool 标志（claude/codex/gemini/grokbuild/opencode/hermes/mcode）；OpenClaw/Pi/ClaudeDesktop 硬编码 false（不支持 MCP 或走独立通道——注释："do not manufacture a disabled mirror"）
- 前端搜索文本 `getMcpSearchText` 用显式 allow-list——注释明确 `env/headers` 含凭据**绝不能进搜索索引**

### "双向同步"的确切语义

**方向一（主）：DB → live**。`McpService::upsert_server/toggle_app/delete_server`（services/mcp.rs:19/84/65）写库后立即 `sync_server_to_app_no_config` 按 AppType 分发。编辑时**diff 前后 apps 集合**：取消勾选某应用先读旧记录（prev_apps）再从该工具 live 删除——增量策略而非全量重写。

**方向二（回读）：live → DB，仅显式导入时**。`import_from_claude/codex/...` + `import_from_all_apps`。**merge 策略：按 id 匹配，已存在只把该应用 flag 置 true，绝不覆盖已有 server spec**；注释反复强调"导入不应反向写回任何 live 配置"——防止导入 A 工具意外改写 B 工具。

**全量重投影**：`sync_all_enabled` best-effort——`~/.claude.json` 坏 JSON 不阻断其他应用，失败聚合成一个错误上报（注释解释了历史实现 `unwrap_or(0)` 吞错的问题）。

### Prompts：回填保护 + restore 窗口互斥

文件映射（`prompt_files.rs::prompt_file_path`）：Claude → `CLAUDE.md`；Codex/GrokBuild/OpenCode/OpenClaw/Pi/Mcode → `AGENTS.md`；Gemini → `GEMINI.md`；**Hermes → `SOUL.md`**（特例）。同一 app 同时只能有一个 enabled。

**回填保护**（防外部编辑被切换覆盖）两个入口：

1. **读时回填**：`PromptService::get_prompts`（prompt.rs:55）每次读取时若 live 与 DB enabled 项不同，把 live 内容写回 DB；**同时用 `sync_protocol::sync_mutex().try_lock()` 判断**——若正处于云同步 restore 窗口，跳过回填（避免把陈旧 live 灌进刚恢复的 DB）
2. **切换时回填 + 备份**：`enable_prompt`（:153）切换前读 live——非空回填到当前 enabled 项；无 enabled 项且内容不重复则创建 `backup-{timestamp}` 备份 Prompt

**restore 场景刻意不走 enable_prompt**（"restore 路径不能读陈旧 live 内容再写回新导入的 DB"）；`project_prompt_set_to_path` 在**没有任何 enabled 项时保持 live 原样不动**——live 文件不属于同步 payload，清空会抹掉快照从未包含的本地内容。

**Pi 特殊模型**：无"启用位"，激活态完全由原生 AGENTS.md 内容派生（live 与哪条 content 相等谁 active）；外改后编辑得 `AppError::Conflict`。

### Skills：SSOT 目录 + symlink 优先投影

`skill.rs`（~7k 行）的职责面：发现（GitHub 仓库递归扫描含 SKILL.md 的目录 + skills.sh 聚合搜索）→ 安装（GitHub zip / 本地 ZIP）→ **先落 SSOT 目录**（`get_ssot_dir`：`~/.cc-switch/skills/` 或统一标准 `~/.agents/skills/`）→ 投影到各工具目录。

**投影机制 `sync_to_app_dir`**（:2445）：`SyncMethod` 三档——**Auto（默认）**：目标已是真实目录（非 symlink）用复制刷新；已是 symlink 则删链后优先 `create_symlink`，失败回退 `replace_dest_with_copy`（临时目录 + `fs::rename` **目录级近似原子替换**）。目标目录映射 `get_app_skills_dir`：`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills` 等（全部支持 settings 覆盖）。

**为何 7k 行：安全防御 + 并发 + 边界情况**：

- **两级路径安全**：DB 的 `directory` 可能来自被污染的同步快照——所有 join 前过 `require_valid_directory`（注释直说"防止任意目录删除"）；GitHub 坐标 `validate_repo_ref` + `assert_github_archive_url` 双防线——branch 会拼进归档 URL，`../../releases/download/...` 可把落点改写到攻击者的 release asset
- **并发**：全局 skill_state 锁（锁序"全局同步锁 → 此锁 → DB mutex"，不在 .await 间持有 std guard）；install 在下载期间故意放锁、**下载完成后重查**防 TOCTOU
- **幂等安装**：`reuse_existing_install`——同仓库同名只置 enabled 标志；不同仓库同名报 `SKILL_DIRECTORY_CONFLICT`
- **"永不删不属于我们的东西"**：Pi/Mcode 的同名目录只有在能验证为 CC Switch 部署（symlink 指向 SSOT 或内容哈希匹配）时才删，否则保留并在返回值警告；卸载即使校验失败也删 DB 行避免用户被脏行锁死
- **归档预算**：解压受 30,000 条目/512 MiB/128 MiB 压缩体限制——防 zip 炸弹
- **更新乐观锁**：`update_skill_metadata` DAO 的 `WHERE id AND installed_at` 双条件——防"网络下载更新期间被卸载重装"的旧快照复活

### Deep Link：三段式导入

`ccswitch://v1/import?resource={provider|prompt|mcp|skill}&...`：`parse_deeplink_url` 强校验 → **后端只解析，emit `deeplink-import` 给前端确认对话框**（脱敏 `maskValue` + 风险分级 `deeplinkRisk.ts`）→ 用户确认后 invoke `import_from_deeplink_unified`。skill 的 deeplink 只是把仓库**加进订阅列表**，不直接安装。MCP merge 语义与导入一致（已存在只 OR apps 标志）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| SSOT + 投影 | 三子系统共用的 v3.7.0 结构 | 同一资产在 7 个工具间免手动复制 |
| 导入/投影分离 | "导入不反向写回" | 导入 A 不顺手覆盖 B |
| 互斥锁 | prompts 回填的 `sync_mutex().try_lock()` | restore 窗口与回填竞态 |
| 保守清理 | Pi/Mcode 验证后才删 | 宁可不清理也不误删 |
| 三段式 | deeplink 解析-预览-确认 | 不可信输入不直接落地 |

## 模块间交互

- **与数据库**：`mcp_servers`/`prompts`/`skills` 表在 auto_sync 白名单（见[数据库与云同步](/vibe-reading/articles/AI/Tools/CC-Switch/CodeWiki/3.20.4/08-database-sync)）；skills.zip 是文件系统 SSOT 的打包
- **与配置写入**：MCP 投影走 `mcp::sync_single_server_to_*` 格式适配（Codex TOML 同文件；Windows 自动 `cmd /c` 包装 npx，WSL 路径跳过）
- **与切换**：供应商切换后 `sync_to_app` 全量重投影 skills（provider/live.rs:1728 调用）

## 扩展方式

**新增一个 Skill 来源类型（如 GitLab）**：`SkillRepo` 目前硬编码 GitHub 语义——需加 `source` 字段（表加列 + DAO SQL 同步）+ `download_repo` 按 source 分发归档 URL 构造器 + 新域的出口断言（仿 assert_github_archive_url）+ deeplink 校验扩展 + 前端 RepoManagerPanel 加来源选择。**坑**：skill.rs 多处隐式假设"repo == GitHub 坐标"（同仓库判断/更新分组键/doc URL 解析），grep `repo_owner` 全量核对，不要只改下载函数。
