---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "OAuth 认证与凭据持久化"
date: "2026-09-24T16:22:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "OAuth", "PKCE", "持久化"]
description: "OAuth 认证与凭据持久化：伪装原生 CLI 的 PKCE 授权码流、token 刷新分层（策略层 + 执行层）、File/Git/Postgres/S3 四种 Store、Vertex 服务账号特例"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

本模块覆盖四块协作的代码：`internal/auth/<provider>/`（每家 OAuth 协议原语）、`sdk/auth/`（登录流编排 + Authenticator 注册）、`internal/store/`（File/Git/Postgres/S3 持久化后端）、`internal/cmd/*_login.go`（CLI 登录命令）。职责边界：**登录与刷新**——把浏览器里的"同意授权"变成 auth 目录里的一个 JSON 凭据文件，并保证它永不过期。

两处容易误解的勘误（实地核查结论）：

- `internal/signature/` **不是请求签名模块**——它处理 Claude thinking block 的 `signature` 字段合法性（`StripInvalidClaudeThinkingBlocks` in `claude.go:15`）与跨 provider 签名转换；对上游请求做 HMAC/RSA 签名的代码全仓不存在（OAuth token 就是凭证本身）。
- `internal/home/` **不是凭据文件管理**——它是 "Home" 中央管理服务器的客户端（Redis 协议：集群发现、TLS、failover、KV 集中分发）。凭据 JSON 文件管理在 `sdk/auth/filestore.go`。

## 模块架构

```
internal/cmd/*_login.go ──► sdk/auth/Manager（auth_manager.go 注册 9 个 Authenticator）
                                │ Login(provider) → store.Save
                    ┌───────────┴───────────┐
            internal/auth/<provider>/      sdk/cliproxy/auth.Auth（运行时对象）
            协议原语：PKCE / 回调服务 /      token 放 Metadata map
            token 交换 / TokenStorage        Storage 字段持 TokenStorage 用于回写
                    │
                    ▼
            Store 接口（sdk/cliproxy/auth/store.go:6，四选一）
            ├── FileTokenStore（默认，auth-dir 下 JSON 文件）
            ├── GitTokenStore（git remote 集中同步）
            ├── PostgresStore（DSN + 本地 spool mirror）
            └── ObjectTokenStore（S3 兼容）
```

组织方式是三层接口分离：登录协议原语（`internal/auth`，不 import sdk 可单测）、登录编排与浏览器交互（`sdk/auth` 的 `Authenticator` in `interfaces.go:25`）、运行时统一模型（`sdk/cliproxy/auth.Auth`）。同一套 OAuth 原语被 CLI 登录、Management API 代登录、executor 刷新三处复用——这就是分层的原因。

## 调用链路

Claude 登录流（OAuth 授权码 + PKCE，非设备码）完整链路：

```
DoClaudeLogin in internal/cmd/anthropic_login.go
└── manager.Login(ctx, "claude", cfg, opts) in sdk/auth/manager.go:52
    └── (*ClaudeAuthenticator).Login in sdk/auth/claude.go:38
        ├── GeneratePKCECodes（internal/auth/claude/pkce.go）+ 随机 state
        ├── NewOAuthServer(callbackPort=54545)（oauth_server.go 本地回调服务）
        ├── GenerateAuthURL（anthropic_auth.go:319）
        │     # claude.ai/oauth/authorize?...code_challenge=S256
        │     # client_id = Claude Code 官方 CLI 的 client_id（伪装原生客户端）
        ├── browser.OpenURL（无头环境降级：打印 URL + SSH 隧道指引）
        ├── WaitForCallback(5min)（15 秒后允许手动粘贴回调 URL）
        ├── ExchangeCodeForTokens（anthropic_auth.go:370）
        │     # POST platform.claude.com/v1/oauth/token
        │     # 字段顺序镜像 Claude Code 2.1.220 抓包 wire 顺序（struct 序列化而非 map）
        │     # User-Agent: axios/1.15.2 + Firefox uTLS 指纹绕 Cloudflare
        ├── inspectOAuthAccount → FetchOAuthProfile/FetchOAuthRoles（回放原生客户端伴生调用）
        ├── GenerateDeviceIDPool（设备 ID 池）
        └── CredentialFileName in filename.go:20 → claude-{sha256(identity)前8位}-{email}.json
            # 哈希前缀防同名 email 撞文件；FindMatchingLegacyCredential 兼容旧命名迁移
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `Manager.Login` in `sdk/auth/manager.go:52` | 按 provider 查 authenticator 并登录+存盘 | 注册表分派 |
| `ClaudeAuthenticator.Login` in `sdk/auth/claude.go:38` | 编排回调/换 token/存档 | `RefreshLead`=4h |
| `ExchangeCodeForTokens` in `anthropic_auth.go:370` | 授权码换 token | wire 字段顺序保真 |
| `RefreshTokensWithRetry` in `anthropic_auth.go` | 刷新 + 429 熔断窗口 | singleflight 合并并发刷新 |
| `ClaudeExecutor.Refresh` in `claude_executor_auth.go:149` | 执行层刷新 | 读 refresh_token → 换新 → 写回 Metadata |
| `tryRefreshAfterUnauthorized` in `conductor_refresh.go:474` | 401 兜底刷新 | 刷新后原地重试一次 |
| `FileTokenStore.Save` in `sdk/auth/filestore.go:75` | 写凭据 JSON | 目录 0700 / metadata 文件 0600 |
| `GitTokenStore.Save` in `gitstore.go:407` | 写工作区 + commit + push | 多实例集中同步与历史回滚 |
</details>

## 核心实现

### 伪装原生客户端：OAuth 的全部工程难点

OAuth client 注册是上游封闭生态——不伪装就无法用订阅账号登录。所以登录流的每层都做了身份保真：硬编码官方 CLI 的 client_id 与回调端口（Claude 54545、Codex 1455）；请求体用 **struct 而非 map 序列化**，因为"字段顺序镜像 Claude Code 2.1.220 抓包的 wire 顺序"（`anthropic_auth.go:144-146` 注释）；HTTP 头伪装 `User-Agent: axios/1.15.2`（`applyClaudeOAuthAxiosHeaders`）；uTLS Firefox 指纹绕 Cloudflare（`internal/auth/claude/utls_transport.go`）。Codex 侧同构（`internal/auth/codex/openai_auth.go`，加 `codex_cli_simplified_flow=true`、`id_token_add_organizations=true`，另设设备码变体 `sdk/auth/codex_device.go`；Kimi 是真设备码流 `StartDeviceFlow` in `internal/auth/kimi/kimi.go:247`）。

登录成功后还有**伴生调用回放**：`FetchOAuthProfile`/`FetchOAuthRoles` 模拟原生客户端登录后的 advisory 请求补齐 account/org UUID 和 email（失败仅告警不影响登录）。

### 凭据对象模型：弱类型 map 的宽容契约

运行时 `Auth` in `sdk/cliproxy/auth/types.go:48` 的 token 本体放 `Metadata map[string]any`（access_token/refresh_token/expired），不可变配置放 `Attributes map[string]string`，`Storage` 字段持登录时创建的 `TokenStorage` 实现用于回写。过期判断 `HasValidAccessToken`（`types.go:614-646`）从 Metadata 读时间戳，兜底 `parseJWTExp` 解析 access_token 里的 JWT `exp`。Why 弱类型：Conductor 刷新、watcher 对账、外部手写 JSON 文件三种来源都要无损进出，`NormalizeCredentialMetadata`/`CredentialsChanged`（`conductor_refresh.go:376`）以归一化 helper 比较变化——强类型字段会在这三个来源的字段演进上碎掉。

### 刷新分层：策略层 + 执行层

- **策略层**（何时刷）：`Manager.shouldRefresh` in `conductor_refresh.go:115`，提前量由 provider 注册（`RegisterRefreshLeadProvider`，Claude 4 小时，经 `sdk/auth/refresh_registry.go` 的 `init()` 自注册）；401 时请求路径兜底 `tryRefreshAfterUnauthorized`。
- **执行层**（怎么刷）：各 executor 的 `Refresh(ctx, auth)` 方法，如 `ClaudeExecutor.Refresh` 读 refresh_token → `RefreshTokensWithRetry(ctx, rt, 3)`（singleflight 合并并发刷新；429 时按 `Retry-After` 设 `claudeRefreshBlock` 熔断窗口）→ 写回 Metadata。401 后的身份字段保护：**profile 失败时绝不清空已有 identity**（`claude_executor_auth.go:170-179` 注释），`UpdateTokenStorage`（`anthropic_auth.go:671`）只覆写非空字段。

### 持久化四后端与 Home 特例

`Store` 接口（`Save/List/Delete`）四实现互斥选择在 `cmd/server/main.go:668-674`：

- **FileTokenStore**（默认）：auth-dir 下 JSON，进程内 `sync.Mutex` 串行写，目录 0700；`List` 支持 `PluginMultiAuthParser` 把一个文件展开成多条 virtual auth。注意**非原子写**（直接 `os.Create`）——靠 watcher 的 debounce 容忍。
- **GitTokenStore** in `internal/store/gitstore.go`（go-git 纯 Go）：Save = 写工作区（metadata 走 tmp+rename 原子写）→ `commitAndPushWithOptionsLocked`（`gitstore.go:1661`）推送到配置 remote/branch；config.yaml 也纳入同一 repo。Why git：多实例部署的凭据集中同步 + 每次保存一个 commit 的历史回滚。**不加密**——token 明文进 repo，安全完全依赖 remote 仓库访问控制。
- **PostgresStore**（pgx，`auth_store`/`config_store`/`cooldown_store` 三表）：同时 mirror 到本地 spool 目录，让 watcher 等文件型工作流继续工作。
- **ObjectTokenStore**（minio-go，S3 兼容）。

关键特例：**Home 模式下所有本地 store 一律禁用**（`cmd/server/main.go:435-438`）——凭据刷新委托 Home（`helps.RefreshAuthViaHome` in `claude_executor_auth.go:153`），本节点不碰磁盘凭据。

### Vertex 特例：不走 OAuth

服务账号 JSON 原样存进 `service_account` key（`VertexCredentialStorage` in `internal/auth/vertex/vertex_credentials.go:18`），无浏览器流程，由 `--vertex-import` 导入（`internal/cmd/vertex_import.go`）；运行期 executor 自签 Google JWT（`keyutil.go`）换 access token。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略（Authenticator 注册表） | `sdk/auth/interfaces.go:25` + `auth_manager.go:13` 显式注册 | 每家登录流独立演进 |
| 工厂 + 全局注册表 | `RegisterTokenStore`/`GetTokenStore` in `store_registry.go` | 四后端惰性单例 |
| Facade（TokenStorage） | `SaveTokenToFile` in `internal/auth/models.go:8` | 各家 JSON 形态封装 |
| Singleflight | `RefreshTokensWithRetry` | 并发刷新合并成一次上游调用 |
| 熔断 | `claudeRefreshBlock` 窗口 | 刷新 429 时暂停打上游 |

## 模块间交互

CLI（`internal/cmd/*_login.go`）与 Management API（`auth_files_provider_oauth.go` 的 `RequestCodexToken` 等）都汇入 `sdkAuth.Manager.Login`；Conductor 的刷新循环调 executor 的 `Refresh`（见 [03-conductor](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/03-conductor)）；watcher 监听 auth 目录变化经 `GetTokenStore()` 对账——外部手工放凭据文件也会被拾起；Home 模式下 `internal/home` 客户端取代本地 store。

## 扩展方式

**新增 provider OAuth 登录**五步：① `internal/auth/<provider>/` 写协议原语（常量 + GenerateAuthURL/ExchangeCodeForTokens/RefreshTokens/TokenStorage，抄 `internal/auth/codex/` 六个小文件）；② `sdk/auth/<provider>.go` 实现 `Authenticator`（抄 `claude.go` 回调骨架）；③ `internal/cmd/auth_manager.go:13` 注册 + 新建 `internal/cmd/<provider>_login.go`；④ `sdk/auth/refresh_registry.go` 加 refresh lead；⑤ `internal/runtime/executor/<provider>_executor_auth.go` 实现 `Refresh`。

**加凭据文件新字段**：改 `ClaudeTokenStorage`（`token.go`）须同步 `UpdateTokenStorage`（防 refresh 抹掉旧 identity）与 executor 的 metadata 回写；参与相等性判断的字段检查 `normalizeAuth` in `internal/watcher/dispatcher.go:352`——时间戳类要在这里抹掉，否则 watcher 误报 Modify。
