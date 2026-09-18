---
source:
  type: "源码解读"
  project: "Odysseus"
  url: "https://github.com/odysseus-dev/odysseus"
title: "数据与安全基座"
date: "2026-09-18T17:31:00+08:00"
category: [AI, Agent, Workspace, Odysseus, CodeWiki, "dev-2026-09"]
contentType: "CodeWiki"
tags: ["Odysseus", "SQLAlchemy", "认证", "多租户"]
description: "Odysseus core/ 基座：core.database 全库扇入第一（37 次 import）；25 张表 migrate-on-boot；bcrypt+TOTP 认证链；owner 列多租户隔离；uuid 后缀原子写与 Windows 兼容层。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Workspace/Odysseus/CodeWiki/dev-2026-09/00-overview)

---

## 模块定位

`core/`（5181 行）是全库扇入之最——`core.database` 被 import 37 次（其中 `core.database as cdb` 31 次）。它解决四件事：**持久化**（SQLite + SQLAlchemy，25 张表）、**认证**（密码 + TOTP + 会话 + API token）、**多租户隔离**（owner 列体系）、**平台兼容**（Windows 原生支持）。威胁模型写在 `THREAT_MODEL.md`：防"被偷的 SQLite 备份"（静态加密）而非进程沦陷；`/api/v1/chat` 的 `base_url` SSRF 是 known gap（PR #1039）。

代码分布：`core/database.py`（2737 行）、`core/session_manager.py`（782 行）、`core/auth.py`（680 行）、`core/platform_compat.py`（452 行）、`core/models.py`（191 行）、`core/middleware.py`（152 行）、`core/atomic_io.py`（66 行）、`core/exceptions.py` / `constants.py` / `log_safety.py`；消费侧辅助 `src/auth_helpers.py`（被 import 38 次）、`src/owner_identity.py`。

## 模块架构

**三层持久化分面**：`core/models.py` 纯 dataclass（`Session` / `ChatMessage`，无持久化逻辑，且持模块级单例 `_SESSION_MANAGER_INSTANCE` 供 `set_session_manager_instance()` 注入）↔ `core/database.py` ORM（约 25 张表）↔ `core/session_manager.py` 门面（`_db_to_session_meta()` / `_db_to_session()` 做映射）。`core/database.py` 模块导入时即建全局单例：`DATABASE_URL`（默认 `sqlite:///{DATA_DIR}/app.db`，相对路径锚定 `get_app_root()`）→ `engine`（`check_same_thread=False`）→ `SessionLocal`；`@event.listens_for(Engine, "connect")` 里的 `set_sqlite_pragma()` 执行 `PRAGMA foreign_keys=ON`。取用两种：FastAPI 依赖 `get_db()`（yield + close）与上下文管理器 `get_db_session()`（commit/rollback/close）。

**ORM 清单**（都在 `core/database.py`）：`Session`（`owner` 列、`last_message_at` 与 `last_accessed` 分离——后者会被改名/打开聊天污染）、`ChatMessage`、`Document` / `DocumentVersion`、`GalleryAlbum` / `GalleryImage`、`EmailAccount` + `EmailAccountOwnerLock`、`ModelEndpoint`、`ProviderAuthSession`、`McpServer`、`Comparison`、`Signature`、`ApiToken`、`Webhook`、`UserTool` / `UserToolData`、`CrewMember`、`ScheduledTask`、`EditorDraft`、`TaskRun`、`Memory`、`Note`、`CalendarCal` / `CalendarEvent` / `CalendarDeletedEvent`、`Integration`。`EncryptedText(TypeDecorator)` 透明加密：`process_bind_param()` 写入时经 `src.secret_storage.encrypt` Fernet 加密（`enc:` 前缀），`process_result_value()` 读取时 `decrypt` 还原——业务代码对列的使用完全无感知；**遗留明文行读取时原样通过**（无 `enc:` 前缀不解密），下次写入才落为密文，启动迁移 `_migrate_encrypt_email_passwords()` 主动补齐——保护静态文件（防备份/镜像泄露），不防能读密钥的活进程。

## 调用链路

**认证链**：`POST /login`（`login()` in `routes/auth_routes.py:166`）→ `_login_limiter.check()` 限速 → `auth_manager.verify_password()`（`bcrypt.checkpw`，hash 由 `_hash_password()` in `core/auth.py:73`）→ `totp_verify()`（pyotp，`valid_window=1`，secret 缺失 fail closed）→ `create_session_trusted()` 签发 `secrets.token_hex(32)`，TTL 7 天，内存 dict + `atomic_write_json` 落盘 `data/sessions.json`；cookie `httponly=True, samesite="lax", secure=_secure_cookie(request)`。**每请求验证**在 `AuthMiddleware`（`app.py:364`，最外层）：`get_application_route_path()` 处理 ASGI `root_path` → 放行 preflight 与豁免路径 → internal-tool loopback → `Bearer ody_` token（缓存 + `bcrypt.checkpw` 比对 `ApiToken.token_hash`，盖 `request.state.current_user = "api"` 与 scopes）→ cookie 路径 `auth_manager.validate_token(token)` + `get_username_for_token(token)`。关键点：`validate_token()` 每次复查 username 仍在 `self.users`——**孤儿 session 立即踢出**。下游二次闸门 `get_current_user()` / `require_user()` / `require_admin()` / `require_privilege()`（`src/auth_helpers.py`）——`require_user()` 注释明确防 "SSRF from a sibling service" 绕过中间件。

**启动迁移链**：`init_db()` 在 `Base.metadata.create_all` 后跑约 50 个 `_migrate_*()` 幂等函数——`_migrate_add_owner_column()`、`_migrate_assign_legacy_owner()`、`_migrate_encrypt_email_passwords()` 等，典型 migrate-on-boot 而非 Alembic（自托管单文件 SQLite 不值得引迁移框架）。chmod 必须在 `create_all` **之后**：`safe_chmod 0o600`（`core/platform_compat.py`）要先有文件才能改权限——建库时 SQLite 默认按 umask 落盘，建完立即收紧；`_sqlite_db_path()` 对 DB 及 `_SQLITE_SIDECARS`（`-journal` / `-wal` / `-shm`）统一处理。Windows 上 `safe_chmod` 返回 False 不算告警——`core/platform_compat.py` 的 `safe_chmod()` 在 Windows 是 no-op（用户目录已 ACL 隔离），失败是预期而非异常。`set_sqlite_pragma()` 经 `@event.listens_for(Engine, "connect")` 注册在 **`Engine` 类**（而非 engine 实例）的 connect 事件上——类级监听对所有引擎生效，函数内 `isinstance(x, sqlite3.Connection)` 检查确保只在真正的 SQLite 连接上执行 `PRAGMA foreign_keys=ON`（未来换 Postgres 时同一段代码自动跳过）。

## 核心实现

### owner 多租户：逐列演进

隔离体系是逐列长出来的：`_migrate_add_owner_column()` → `_migrate_add_multiuser_owner_columns()` → `_migrate_assign_legacy_owner()` / `_migrate_backfill_document_owner_from_session()` 把 NULL/legacy 行归到 Default/Local 桶（`DEFAULT_LOCAL_OWNER = "__odysseus_local__"` in `src/owner_identity.py`）。查询侧统一 `owner_filter(query, model_cls, user, include_shared=True)`（`src/auth_helpers.py:191`）：`user` 为空（单用户/未认证模式）时是 **no-op** 原样返回 query；`include_shared=True`（默认）生成 `(owner == user) | (owner IS None)`——兼容 legacy 共享行；`include_shared=False` 生成仅 `owner == user`——严格租户隔离的查询用。**`RESERVED_USERNAMES`**（frozenset，`core/auth.py`）封堵 `internal-tool` / `api` / `demo` / `system` / `__odysseus_local__` 被注册为真人账号——因为 `require_admin` 会无条件放行 `current_user == "internal-tool"`，一个叫 internal-tool 的真人账号就是权限提升漏洞。

### SessionManager 的懒水合

`SessionManager`（`core/session_manager.py:65`）：`load_sessions()` 启动时只载最近 100 个未归档 session 的**元数据**（`archived == False` 过滤、`last_accessed.desc()` 排序、`limit(100)`——选 `last_accessed` 而非 `last_message_at`：后者会被改名污染，前者反映"最近真正打开过"），消息按需 `get_session()` 懒水合——修复启动时全量消息进 RAM。`delete_session()` 先 `cleanup_session_images` 再级联删消息、把 `Document` 脱钩成孤儿文档以免误删。`ensure_task_session()` 调度器专用（不覆写已有缓存）。

### 原子写：uuid 后缀

`atomic_write_json()` in `core/atomic_io.py:22`——tmp 文件用 **uuid4 随机后缀**（`uuid.uuid4().hex`；注释解释 PID 后缀在同进程内仍会撞）+ `os.fsync`（数据真正落盘，防断电截断）+ `os.replace`（原子重命名，读方要么看到旧文件要么看到完整新文件），`finally` 里 `os.unlink` 清理残留 tmp——三者合起来解决 `auth.json` / `sessions.json` 被 kill -9 截断。

### 跨方言锁

`lock_email_account_owner_mutations()`（`core/database.py:474`）：SQLite 走 `BEGIN IMMEDIATE`，行锁库走 `EmailAccountOwnerLock` 持久 mutex 行，owner key 排序防死锁；配 partial unique index（`ux_email_accounts_one_default_per_owner`，按 dialect 注册 DDL）保证每 owner 只有一个默认邮箱。

### platform_compat：Windows 原生支持的存在理由

`core/platform_compat.py` 的核心规则是"仅 stdlib + ctypes，避免散落的 `os.name=='nt'` 判断"：`safe_chmod()`（Windows 上 no-op，用户目录已 ACL 隔离）、`pid_alive()`（`os.kill(pid,0)` 在 Windows 会**真的杀掉**进程——改用 `OpenProcess/GetExitCodeProcess`）、`find_bash()`（Git Bash 探测）、`detached_popen_kwargs()`、WSL 路径翻译 `translate_path()`。

### 安全防护点与 THREAT_MODEL 对账

XSS → CSP nonce（`SecurityHeadersMiddleware`，`style-src 'unsafe-inline'` 的保留有注释论证：inline style 不执行脚本）；凭据泄露 → `redact_url()`（`core/log_safety.py`，剥离 userinfo/query）、`EncryptedText`；SSRF → `src/webhook_manager.py` 私网黑名单（`src/url_safety.py` / `src/outbound_fetch.py` 同类）；loopback 信任 → `_is_trusted_loopback()` 拒绝带 `cf-connecting-ip` 等代理头的"伪本机"请求。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例/服务定位器 | engine/SessionLocal import 即建；`AuthManager` 挂 `app.state` | 全库共享一个 DB 句柄 |
| migrate-on-boot | `init_db()` + ~50 个 `_migrate_*()` 幂等函数 | 不引 Alembic，重启即迁移 |
| 原子写 | `atomic_write_json()` in `core/atomic_io.py:22` | uuid 后缀 + fsync + os.replace |
| 跨方言锁 | `lock_email_account_owner_mutations()` :474 | SQLite 与行锁库统一互斥 |
| 中间件链 | `core/middleware.py` 只放纯函数 | 便于单测 |

## 模块间交互

被 routes/src 全量消费（`from core.database as cdb` 后用 `cdb.get_db_session()` / `cdb.Session`）；认证辅助 `src/auth_helpers.py` 的 `owner_filter()` / `effective_user()`（bearer token 归因到 `api_token_owner`，使 paired client 与桌面 UI 看到同一份数据）；`companion/routes.py` 的配对令牌复用同一 owner 体系。

## 扩展方式

新增一张表：`core/database.py` 加 `class Foo(TimestampMixin, Base)`（多用户表务必带 `owner = Column(String, index=True)`，参考 `Session.owner`）→ 需要列级演进则写 `_migrate_add_foo_column()` 挂进 `init_db()` 调用序列 → 查询侧在 routes 用 `cdb.get_db_session()`。新增权限项：`core/auth.py` 的 `DEFAULT_PRIVILEGES` 加 key（路由用 `require_privilege(request, key)`；注意 `ADMIN_PRIVILEGES` 是布尔翻转推导，sentinel 类 key 需如 `block_all_models` 那样手工覆写）。对应测试：`tests/` 下 `area_security` 类（如 `test_agent_state_dir_confinement.py`）。
