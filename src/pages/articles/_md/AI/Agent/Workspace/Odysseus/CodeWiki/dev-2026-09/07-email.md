---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "邮件系统"
date: "2026-09-18T17:27:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "IMAP", "邮件分诊", "LLM"]
description: "Odysseus 邮件系统是全库最大路由文件（6.2k 行）+ 2.9k 行独立 MCP server 的双面实现：routes 层服务管理面（UI/缓存/轮询），MCP server 服务 agent 面（IMAP 工具），幂等缓存表驱动分诊与摘要。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

邮件是 Odysseus 里最"传统企业级"的功能域：IMAP 收件、SMTP 发信、LLM 分诊（紧急/速回/Newsletter）、摘要、回复草稿、日历事件提取、定时发信。它解决的问题是自托管的**邮箱即个人数据源**——agent 能读你的邮件、替你分诊、起草回复。代码量也是全库之最：`routes/email_routes.py`（6152 行，全库最大路由文件，234 个路由函数）+ `routes/email_helpers.py`（2008 行）+ `routes/email_pollers.py`（1565 行）+ `src/email_thread_parser.py`（614 行）+ `mcp_servers/email_server.py`（2912 行）+ `routes/contacts/`（921 行）。

## 模块架构

一个功能域、**两套实现**，这是理解本模块的关键。**routes 层**（`email_routes.py` + `email_helpers.py`）服务 Web UI 管理面：账户配置、四层缓存、连接池、FastAPI auth（`require_owner()`）。**MCP server 层**（`email_server.py`）服务 agent 面：以 stdio 子进程被 `McpManager` 拉起，暴露 14 个工具（`list_emails` / `read_email` / `ai_draft_email_reply` / `scan_email_unsubscribes` 等，`list_tools()` at `email_server.py:2089`），直接读同一 SQLite / IMAP——不能依赖 FastAPI request 上下文，故代码有重复（两份 `_imap_connect`、`_detect_sent_folder`）。为什么容忍重复：`src/builtin_mcp.py:69` 注释自认"每个 server 携带数百行独特 IMAP/HTTP/manager 逻辑，不值得折叠进 native 路径"；而 bash/python/filesystem 等平凡包装已折入 `_direct_fallback()` 原生执行。

多用户隔离在账户解析侧有专门防御：`_get_email_config()`（`routes/email_helpers.py:1011`）五级回退（account_id 指定行 → `is_default=True` 行 → 第一个 enabled 行（按 created_at 升序）→ legacy settings.json → 环境变量）中，无 owner 参数的查找经 `_owner_or_matching_legacy_account()` 收紧——**无主（legacy）账户行仅当其 `imap_user` 或 `from_address` 等于该 owner 时对该 owner 可见**，否则多用户部署下任何用户都能解析到别人的默认账户。路由侧的 `_assert_owns_account()`（`email_helpers.py:458`）：非归属账户返回 404 "Account not found"（防探测存在性，同全库 404-not-403 惯例）；DB 查询异常 fail-closed 抛 503 "Account check failed"——宁可拒服务也不放行未验证的账户。

数据层：`EmailAccount`（`core/database.py:386`）ORM——IMAP（host/port/user/password/starttls）+ SMTP（host/port/security/user/password）+ OAuth（`oauth_provider/access_token/refresh_token`），每 owner 多账户，唯一 `is_default` 由 `EmailAccountOwnerLock` 表做 per-owner 互斥（跨方言锁：SQLite `BEGIN IMMEDIATE`，行锁库走持久 mutex 行）。凭据经 `src/secret_storage.py` Fernet 加密落库，密钥在 `data/.app_key`（0600）——威胁模型是"被偷的 SQLite 备份"而非进程沦陷。AI 缓存在独立 SQLite（`SCHEDULED_DB`）：`_init_scheduled_db()`（`email_helpers.py:699`）建 7 张缓存表（summaries / replies / translations / tags / calendar_extractions / urgency_alerts / scheduled_emails）。

## 调用链路

**分诊链**（定时）：task_scheduler 的 cron 任务 `check_email_urgency`（每小时）→ `action_check_email_urgency()`（`src/builtin_actions.py:2250`，TRIAGE_VERSION=10，缓存 key `account_id:uid`）→ `_enumerate_enabled_accounts()` 遍历账户 → `_imap_connect()` 拉信 → LLM 分级（urgent / reply-soon / newsletter…）→ 写 `email_urgency_state_<owner>.json` + 打 IMAP tag → 新 UID 达到阈值才 fire reminder。`summarize_emails` / `draft_email_replies` / `extract_email_events` 等 8 个 action 注册于 `_MODEL_BACKED_ACTIONS`（`src/task_scheduler.py:1197`），排队进 model slot。

**UI 拉取链**：`setup_email_routes()`（`email_routes.py:1513`）四层缓存——`_LIST_CACHE`（45s TTL）列表、`_READ_CACHE`（30min）正文、`_IMAP_POOL` 连接池（`_pooled_connect()`，NOOP 探活、60s idle 回收）、后台 prefetch 预热 top-N——注释明说是为了消除"每次冷点击都对 Dovecot 做 TCP+TLS+LOGIN+RFC822 全量拉取"。

**回复草稿链**：`need_reply` → `task_llm_call_async()` + `_EMAIL_REPLY_SYS_PROMPT_BASE`（附加 `writing_style` 与附件文本），存 `email_ai_replies`，UI 点击即现。手动 `/api/email/ai-reply`（`:5147`）更重：经 `_pre_retrieve_context()` 与 `_fetch_sender_thread_context()`（`email_helpers.py:1674`）跨 INBOX/Sent/Archive 挖该发件人历史往来与附件文本注入 prompt。

**事件链**：用户浏览收件箱时 `_record_email_received_events()`（`email_routes.py:366`）用 `email_event_seen` 表去重后 `fire_event("email_received")`，并即时触发 away-only 回复 pass。

## 核心实现

### 轮询而非推送

全库无 IMAP IDLE 实现——定时任务（cron 每小时分诊）+ UI 拉取时的 `email_received` 事件已够用。为什么：自托管 Dovecot 场景下 IDLE 需常驻每账户一条连接，多租户下成本高；而轮询可完全交给 cron/systemd（`ODYSSEUS_INPROCESS_POLLERS=0` 关掉内置 poller，由 `odysseus-mail poll-scheduled` CLI 驱动——避免两个副本竞态同一 SQLite）。内置 `_scheduled_email_poller()`（`email_pollers.py:1498`，30s 一轮）只管定时发信队列；`_auto_summarize_pass()`（`:450`）做多账户 fan-out，**顺序执行而非并发**——每账户独占一条 IMAP 连接更简单安全。定时发信的完整状态流转：`_scheduled_poll_once()`（`:1383`）用 `UPDATE scheduled_emails SET status='sending' WHERE id=? AND status='pending'` 的 rowcount 原子抢占（仅抢到的 poller 继续发送）→ 成功置 `sent`、异常置 `failed` 并写 error。发送侧 `POST /send` 成功后还会用 `SendEmailRequest.source_uid` / `source_folder` 回写原始邮件：写 `\Answered` 标志（`_store_email_flag()` + `_email_index_update_flags()` 同步索引）并清除 done/response 标签（`_clear_done_response_tags()`）；`wait_for_delivery=True` 时接口等 SMTP 发送 + Sent 文件夹 append 完成并返回 sent UID。

### 幂等缓存即状态机

7 张缓存表以 message_id 存在性判断"已处理"；无 Message-ID 的邮件用 `synth-<sha256>` 合成 ID。定时发信的原子抢占：`_scheduled_poll_once()`（`email_pollers.py:1383`）用 `UPDATE ... WHERE status='pending'` 的 rowcount 抢占行——防 in-process poller 与 cron CLI 双发。

### owner 复合主键的教训

`email_tags` / `email_summaries` 等表均以 **(message_id, owner) 复合 PK**——Message-ID 全局唯一（同一封 newsletter 发给多用户 ID 相同），曾发生跨租户 tag 互相覆盖（`email_helpers.py:770` 注释 review C2）。这是全库 owner-scoping 反复出现的教训在邮件域的具体形态。

### 线程解析双策略

`parse_thread()`（`src/email_thread_parser.py:605`）是前端 `emailLibrary.js` 的服务端移植，HTML 优先：`body_html` 走 `_parse_html`（blockquote 嵌套），缺失或解析失败回退 `body_text` 走 `_parse_plaintext`（`> ` 嵌套与多语言 "On ... wrote:" 归因行，20+ locale 正则；Outlook 头块、CJK 归属行也识别）；未检测到任何引用标记时返回 None（调用方平铺渲染），超过 200,000 字符的输入直接返回 None（防病态邮件拖垮解析）。返回的每个 turn 为 `{level, body_html, meta}`——level 0 是当前回复，层级越深链上消息越早。`THREAD_PARSER_VERSION=6` 做版本化缓存失效——缓存以 `{"v": 版本, "turns": [...]}` 包装，版本不同即过期，解析逻辑升级后旧缓存自动重建。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 多账户 fan-out | `_auto_summarize_pass()` in `routes/email_pollers.py:450` | 每账户独立 pass，owner 严格隔离 |
| 幂等缓存即状态机 | `_init_scheduled_db()` in `routes/email_helpers.py:699` | message_id 存在性判"已处理" |
| 原子抢占 | `_scheduled_poll_once()` in `routes/email_pollers.py:1383` | rowcount 抢占防双发 |
| 版本化缓存失效 | `THREAD_PARSER_VERSION=6` in `src/email_thread_parser.py` | 解析器升级自动重建缓存 |
| 五级配置回退 | `_get_email_config()` in `routes/email_helpers.py:1011` | account_id → 默认行 → 首个 enabled → legacy settings → 环境变量 |

## 模块间交互

LLM 经 `resolve_task_candidates()` / `task_llm_call_async()`（owner 路由到对应租户的模型配置）；task_scheduler 承载 8 个 email action 且任务结果可经 `_deliver_via_email()` 送达；`McpManager` 托管 email_server 子进程（崩溃自动 `_reconnect_builtin()` 重建，调用侧 `tool_execution.py:1316` 强制注入 owner 参数）；账户表在主 SQLite、AI 缓存在独立 `SCHEDULED_DB`。

## 扩展方式

- **支持新邮件服务商**：标准 IMAP/SMTP+密码直接在 Settings UI 加账户即可（`POST /api/email/accounts`）——服务商差异由 `_detect_sent_folder()` / `_detect_drafts_folder()` / `_detect_spam_folder()`（`email_helpers.py:1336-1424`）按文件夹名启发式吸收。
- **新增 OAuth 提供商**：仿照 `_refresh_google_token()` / `make_oauth_state()`（`email_helpers.py:102/68`）加分支，并同步 `_xoauth2_bytes()` 的 SASL 生成。⚠️ 待核实：OAuth 路径目前仅 Google 一家（`_google_oauth_imap_transport_allowed()` in `routes/email_routes.py:88`）。
