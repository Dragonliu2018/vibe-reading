---
source:
  type: "源码解读"
  project: "InfluxDB"
  url: "https://github.com/influxdata/influxdb"
title: "认证授权"
date: "2026-08-20T13:07:26+08:00"
category: [Database, TSDB, InfluxDB, CodeWiki, "3.11.1"]
tags: ["InfluxDB", "Rust", "TSDB"]
description: "InfluxDB 3 Core 认证授权：双层 trait 体系（core/authz + influxdb3_authz）、SHA-512 token、三维 bitmap 权限与 RBAC"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/InfluxDB/CodeWiki/3.11.1/00-overview)

---

## 模块定位

`influxdb3_authz` + `core/authz` 是横切所有请求的安全层。它分两层：`core/authz` 是 IOx 遗产的通用授权框架（`Authorizer` trait、gRPC client、proto 类型、HTTP header 提取、指标装饰器），`influxdb3_authz` 是 InfluxDB 3 Core 专有逻辑（Token SHA-512 认证、bitmap 权限模型、RBAC role）。核心职责：**认证**（Authentication，把 token 解析为 `TokenId`）+ **授权**（Authorization，按 `AccessRequest` 检查权限），贯穿 HTTP/gRPC 两个协议入口。边界：认证授权策略，不涉及业务逻辑——`NoAuthAuthenticator`（`--without-auth`）让所有请求放行，体现安全是可插拔横切关注点。

## 模块架构

两层 trait 体系：**IOx 层**（`core/authz`）`Authorizer` trait（`authorizer.rs`）+ `Permission`/`Action`/`Resource`/`Target` + `Authorization` + `IoxAuthorizer`（gRPC client）+ `AuthorizationHeaderExtension`（`http.rs`）+ `AuthorizerInstrumentation`（装饰器，`instrumentation.rs`）。**Core 层**（`influxdb3_authz`）`AuthProvider` trait（`lib.rs`，`authenticate`/`authorize_action`/`should_check_token`/`upcast`）+ `TokenProvider` trait + `TokenAuthenticator`（仅认证）+ `TokenAuthenticatorAndAuthorizer`（认证+授权组合）+ `NoAuthAuthenticator`。RBAC 层 `role/`（`Role`/`Permission`/`Permissions`/`permission_covers!` 宏）。`TokenPermissions`（`permissions.rs`，bitmap 存储）+ `AccessRequest` enum（数据库/token/system/admin 多类）。

## 调用链路

```
HTTP 请求 → perform_routing()  [http.rs:2680]
  ├─ 跳过认证: path == admin-token 端点 或 paths_without_authz.contains
  └─ authenticate_request()  [http.rs:2722]
       ├─ extract_v1_auth_token(req)  [http.rs:1345]  (Authorization header 或 v1 ?p= 参数)
       │    └─ validate_auth_header()  [http.rs:2232]  (Bearer/Token/Basic)
       ├─ authorizer.authenticate(token)  → TokenAuthenticator::authenticate  [lib.rs:164]
       │    └─ SHA-512 哈希 → token_provider.get_token(hashed) 查 catalog
       │    └─ 检查 expiry_millis > current_timestamp_ms
       └─ TokenId 存入 req.extensions_mut()  [http.rs:1372]
  └─ match (method, path) → handler
       ├─ Admin 端点: authorize_admin(req)  [http.rs:2097]
       │    └─ authorizer.authorize_action(Subject::Token(token_id), AccessRequest::Admin)
       │         → TokenAuthenticatorAndAuthorizer::authorize_action  [authorizer.rs:70]
       │              └─ catalog_provider.is_token_allowed_access  → token_permissions 查 Wildcard:Wildcard
       ├─ V1 query: authorizer.upcast() → IoxAuthorizer::authorize  [authorizer.rs:188]
       │    └─ authenticate + 逐个权限转 AccessRequest::MaybeDatabase 检查
       └─ Write/Query: 认证已通过，数据库级权限由 query_executor 内部处理
```

## 核心实现

### 两层 trait 与 upcast 桥接

`core/authz`（IOx 层）定义通用 `Authorizer` trait + gRPC 协议 + proto 类型，IOx 组件（如 `V1HttpHandler`）依赖它。`influxdb3_authz`（Core 层）在其上构建 InfluxDB 专有逻辑。`AuthProvider::upcast()`（`authorizer.rs:169`）把 Core 层 `AuthProvider` 转为 IOx 层 `Arc<dyn IoxAuthorizer>`——`TokenAuthenticatorAndAuthorizer` 同时 impl 两层 trait，在 `IoxAuthorizer::authorize` 内部调 `self.authenticate()` + `self.authorize_action()` 完成桥接。这使 IOx 组件透明使用 Core 层认证，无需感知实现细节，企业版可在 Core 层扩展更多权限类型（多处 `// enterprise only`）。

### Token 生成与 SHA-512 验证

生成：`create_token_and_hash()`（`influxdb3_catalog/.../schema/tokens.rs:104`）用 `OsRng` 生成 64 字节随机数，前缀 `"apiv3_"`，Base64 编码拼接，同时计算 SHA-512 哈希存储。Catalog 只存哈希不存明文。验证：`TokenAuthenticator::authenticate()`（`lib.rs:164`）接收明文 token bytes，计算 `Sha512::digest(provided)` 与 catalog 哈希比对，验证后检查 `expiry_millis > current_timestamp_ms`。Admin token 判定：`TokenInfo::is_admin()`（`lib.rs:334`）检查 permissions 是否恰为 `[Wildcard:Wildcard:Wildcard]`（`*:*:*`），通过 `create_admin_token()`（`catalog.rs:2215`）创建用 `DEFAULT_OPERATOR_TOKEN_NAME`（`"_admin"`），不可带权限。`AuthenticatorError` 已预留 `InvalidJwt`/`ExpiredJwt` 变体（`lib.rs:89`），设计时已为 JWT 留扩展。

### 三维 bitmap 权限模型

权限采用 `ResourceType × ResourceIdentifier × Actions` 三维模型，所有 `Actions` 用 `u16` bitmap 存储（`ActionsBitmap = u16`，`permissions.rs:196`）。位运算高效判断包含关系：`DatabaseActions::is_allowed` 直接 `self.0 & perm.0 == perm.0`。通配符 `*`（Wildcard）自动展开为 `ActionsBitmap::MAX`。Token 级权限用 `TokenPermissions`（`permissions.rs:542`）嵌套 `HashMap<TokenId, HashMap<PermissionKey, PermissionAttributes>>` 存储。`get_permission()`（`permissions.rs:672`）三级查找：精确匹配 → 同类型 Wildcard → 全局 Wildcard。`AccessRequest` enum 涵盖 `Database(DbId, DatabaseActions)`/`AnyDatabase`/`Token(TokenId, CrudActions)`/`System`/`Admin`/`User`/`Role` 等。

### RBAC 与 permission_covers 宏

`role/role_permissions.rs` 的 `Permission` enum（`AccountAdminAll`/`Database`/`Token`/`User`/`Role`/`AdminToken`/`System`）+ `PermissionType` trait + `permission_covers!` 宏（行 127）实现统一覆盖检查。`AccountAdminAll` 自动覆盖所有权限类型（宏中 `Permission::AccountAdminAll => true`），避免每检查点手动判 admin 的重复。`Role`（`role.rs`）持有 `permissions: Vec<Permission>` + `is_required_role`。`Permissions(Vec<Permission>)` 的 `has_permission` 用 `self.0.iter().any(|p| p.covers(required))`。

### 授权嵌入 HTTP 层

认证在 `perform_routing` 入口统一执行（`http.rs:2718`），避免每 handler 重复解析 token。授权按需延迟到 handler：admin 端点调 `authorize_admin`，query/write 端点数据库级权限由 query_executor 处理。认证后 `TokenId` 存 `req.extensions_mut()`（`http.rs:1372`），handler 用 `req.extensions().get::<TokenId>()` 获取。原始 `Authorization` header 验证后移除（防日志泄露）并包装为 `AuthorizationHeaderExtension`（`http.rs:1349`）供 write path 的 IOx 级权限检查。`paths_without_authz` 允许 health/ping 跳过认证。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 | `AuthProvider` 三实现（`TokenAuthenticator`/`TokenAuthenticatorAndAuthorizer`/`NoAuthAuthenticator`） `lib.rs:163` | 配置驱动认证+授权 |
| 装饰器 | `AuthorizerInstrumentation<T>` `instrumentation.rs:14` | 包装 Authorizer 记录延迟指标 |
| 适配器 | `upcast()` 桥接两层 `authorizer.rs:169` | Core→IOx trait 透明转换 |
| Composite | `TokenAuthenticatorAndAuthorizer` 组合 authenticator+catalog_provider `authorizer.rs:44` | 认证+授权组合 |
| Blanket impl | `impl Authorizer for Option<T>` `authorizer.rs:64` | Option 可作 Authorizer（None 全放行） |

## 模块间交互

与 server：`HttpApi` 持 `authorizer: Arc<dyn AuthProvider>`（`http.rs:1017`），`perform_routing` 调 `authenticate_request`，admin 端点调 `authorize_admin`，V1 query 用 `authorizer.upcast()` 传 `V1HttpHandler`。与 catalog：`Catalog` impl `TokenPermissionProvider`/`IdProvider`/`TokenProvider`/`CatalogProvider`（`catalog.rs:3727`），`is_token_allowed_access` 查 `token_permissions`，`db_name_to_id`/`validate_db_id` 做 id 转换，`get_token` 按 hash 查 token。Token 生成在 catalog（`create_token_and_hash`）。与 processing engine：plugin 管理端点需 admin 权限（`authorize_admin`）。core/authz 与 influxdb3_authz 分层：前者 gRPC 通用框架，后者 InfluxDB 专有，企业版可在后者扩展。

## 扩展方式

- **新增权限类型（如 Schedule）**：`lib.rs` 的 `AccessRequest` 加变体 + 新 `ScheduleActions(u16)`/`ScheduleResourceIdentifier`；`permissions.rs` 的 `Actions`/`PermissionKey`/`TokenPermissionResourceIdentifier` 加变体 + `is_allowed_access` match 分支；`role/actions.rs` 加 `ScheduleAction`/`ScheduleResource`；`role/role_permissions.rs` 加 `SchedulePermission` + impl `PermissionType`；`authorizer.rs` 的 `Subject::User` 分支加 `AccessRequest::Schedule` match。
- **修改 token 格式（如 JWT）**：`tokens.rs:104` 的 `create_token_and_hash`/`compute_token_hash` 改签名验证；`TokenAuthenticator::authenticate`（`lib.rs:164`）改 JWT 验证（`AuthenticatorError` 已有 `InvalidJwt`）；`validate_auth_header`（`http.rs:2232`）已支持 Bearer scheme。
- **新增需数据库级权限端点**：`http.rs` `perform_routing` match 加 arm；handler 调 `authorize_action(Subject::Token(token_id), AccessRequest::Database(db_id, DatabaseActions::READ))`。
