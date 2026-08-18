---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "API 接口层"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "REST", "OpenAPI", "authn", "authz"]
description: "Harness HTTP API 层：handler→controller→service 三层分工，chi 中间件链，scope/resource/permission 鉴权模型，reflect 推导的 OpenAPI 生成，统一 usererror 翻译"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/00-overview)

---

## 模块定位

API 接口层是 Harness 对外的 REST 边界——把 HTTP 请求解码、鉴权后交给 controller 编排，再把结果或错误统一渲染回客户端。它的核心职责边界：handler 只做 HTTP 薄层（取 session、解 path、解码 body、调 controller、写响应），controller 做业务编排（校验、鉴权、调 store/service/git、发事件、审计、SSE），不含持久化与领域逻辑本身。这层解决的问题是：四大产品面有数百个端点，若 HTTP 解码/鉴权/错误处理散落各处会重复且易错——Harness 用中间件链 + controller-service 分层 + 统一错误翻译把横切关注点收敛到一处。

## 模块架构

```
HTTP 请求
   │
   ▼
app/router/api_router.go   APIRouter 拦截 /api/ 前缀，strip prefix
   │
   ▼
chi Router (app/router/api.go)  NewAPIHandler 接收所有 controller
   │  r.Use(nocache, Recoverer, logging, CORS, audit, authn.Attempt)
   ▼
app/api/middleware/authn   认证：JWT/cookie/token → auth.Session 注入 context
   │
   ▼
app/api/handler/*          薄 handler：取 session/path → DecodeBody → 调 controller → render
   │
   ▼
app/api/controller/*       编排：Sanitize → getRepoCheckAccess → store/service/git → 发事件/SSE/audit
   │
   ▼
app/services/* + store/* + git.Interface
```

Handler 与 Controller 都通过构造函数注入依赖，由 wire 编织（`wire_gen.go` 生成）。Controller 无基类、无嵌入，是纯 struct——共性字段（`tx` dbtx.Transactor、`urlProvider`、`authorizer`、各 store/service）通过构造函数参数注入。

## 调用链路

以**创建 PR** 为代表性链路（`POST /v1/repos/{repo_ref}/pullreq`）：

```
APIRouter.ServeHTTP → strip /api → chi router
  └─ middleware: authn.Attempt(authenticator) in app/api/middleware/authn/authn.go
        Authenticator.Authenticate(r) in app/auth/authn/jwt.go → auth.Session 注入 ctx
  └─ handlerpullreq.HandleCreate(pullreqCtrl) in app/api/handler/pullreq/pr_create.go
        ├─ request.AuthSessionFrom(ctx)            取 session
        ├─ request.GetRepoRefFromPath(r)            解 path 参数
        ├─ request.DecodeBody(r, in)                JSON 解码（限 10MiB）
        └─ pullreqCtrl.Create(ctx, session, repoRef, in) in app/api/controller/pullreq/pr_create.go
              ├─ in.Sanitize()                       输入校验
              ├─ getRepoCheckAccess → apiauth.CheckRepo  鉴权
              ├─ verifyBranchExistence              查 git 分支
              ├─ checkIfAlreadyExists               查重复 PR
              ├─ fetch git objects / merge base     调 git.Interface
              ├─ tx.WithTx(...)                    事务内创建 PR+reviewer+label+ref
              └─ 事务外：发 events + SSE + instrument
  └─ render.JSON / render.TranslatedUserError        响应出口
```

<details>
<summary>方法速查表</summary>

| 方法 | 路径 | 职责 | 关键设计 |
|------|------|------|---------|
| `HandleCreate` | `app/api/handler/pullreq/pr_create.go` | PR handler | 闭包 `http.HandlerFunc` |
| `pullreqCtrl.Create` | `app/api/controller/pullreq/pr_create.go` | PR 业务编排 | 事务内写、事务外发事件 |
| `authn.Attempt` | `app/api/middleware/authn/authn.go` | 认证中间件 | 无 auth data→匿名 principal |
| `apiauth.CheckRepo` | `app/api/auth/repo.go` | repo 鉴权 | 拆 path→Scope+Resource |
| `usererror.Translate` | `app/api/usererror/translate.go` | 错误→HTTP | `errors.Is` switch |
| `render.TranslatedUserError` | `app/api/render/render_error.go` | 错误渲染 | handler 唯一错误出口 |
| `OpenAPI.Generate` | `app/api/openapi/openapi.go` | spec 生成 | reflect 推导 schema |

</details>

## 核心实现

### 三层分工与 controller 编排

Handler 是纯 HTTP 薄层：从 context 取 `auth.Session`、从 path 解析参数、`request.DecodeBody` 反序列化 JSON body（限 10MiB）、调 controller、`render.JSON` 写响应，**不含业务逻辑**。Controller 是业务编排核心：input 校验 (`Sanitize`)、鉴权 (`getRepoCheckAccess` → `apiauth.Check`)、调 store/service/git 执行业务、发事件 (`eventReporter`)、审计 (`auditService`)、SSE 推送、事务管理 (`controller.TxOptLock`)。一个 controller 方法可能调多个 store + service + git 接口。

`repo.Controller` in `app/api/controller/repo/controller.go` 有 40+ 字段（`git.Interface`、`repoStore`、`spaceStore`、`protectionManager`、`importer`、`codeOwners`、`locker`、`indexer`、`resourceLimiter`、`auditService` 等），`pullreq.Controller` 有 35+ 字段。构造函数 `NewController(...)` 参数极多，由 wire 做 DI 编织。

### 认证与鉴权模型

认证 (`authn`)：`Authenticator` 接口 in `app/auth/authn/authenticator.go` 的 `Authenticate(r) (*auth.Session, error)` 返回 `auth.Session{Principal, Metadata}`，实现在 `app/auth/authn/jwt.go`（JWT/cookie/token）。中间件 `authn.Attempt(authenticator)` 尝试认证，无 auth data 则匿名 (`auth.AnonymousPrincipal`)，认证失败返回 401，session 经 `request.WithAuthSession` 注入 context。

鉴权 (`authz`)：`Authorizer` 接口 in `app/auth/authz/authz.go` 的 `Check(ctx, session, scope, resource, permission) (bool, error)`。模型是三元组：`Scope{SpacePath}` + `Resource{Type, Identifier}` + `enum.Permission`（如 `PermissionRepoView`/`PermissionRepoPush`/`PermissionRepoEdit`）。辅助函数 `apiauth.Check` in `app/api/auth/auth.go` 调用后据 `authenticated` 与是否匿名返回 `ErrUnauthorized`（匿名未通过）或 `ErrForbidden`（认证未通过）。`apiauth.CheckRepo` in `app/api/auth/repo.go` 从 `repo.Path` 拆分 spacePath + repoName 构造 Scope+Resource，`CheckRepoState` 额外校验 repo 状态（active/archived/importing）与请求 permission 的兼容性。

鉴权不在中间件层统一做，而是由各 controller 方法内部主动调 `getRepoCheckAccess`——因为不同端点的 permission 粒度不同，放中间件反而僵化。`authz.BlockSessionToken` 中间件 in `app/api/middleware/authz/authz.go` 仅用于 git 路由，阻止 session token 访问 git。

### OpenAPI 生成与错误翻译

OpenAPI 用 `swaggest/openapi-go/openapi4` 库，**代码生成式而非注解**：通过 Go struct tag + reflect 从 request/response 类型自动推导 schema。`OpenAPI.Generate()` in `app/api/openapi/openapi.go` 创建 `openapi4.Reflector`，依次调用各模块的 `build*`/`*Operations` 函数。每个模块一个文件（如 `openapi/repo.go`），定义 request struct（嵌入 controller 的 Input 类型 + path/query tag），逐个 operation 注册到 `Spec.AddOperation`。这意味着 spec 与 handler/router **完全独立**——不是从代码自动提取，而是手写注册（schema 从 struct tag 推导）。新增端点需同时改 handler + router + openapi 三处。

错误处理统一走 `usererror.Translate` in `app/api/usererror/translate.go`：用 `errors.As`/`errors.Is` switch-case 将底层 error（store/git/check/codeowners/lock 等十余种）映射为 `usererror.Error{Status, Message}`，如 `store.ErrResourceNotFound` → `ErrNotFound`(404)、`store.ErrDuplicate` → `ErrDuplicate`(409)、`lock.Error` → `ErrResourceLocked`。未匹配 → `ErrInternal`(500)。handler 唯一错误出口是 `render.TranslatedUserError(ctx, w, err)`——handler 只需把 controller 返回的 error 丢给它。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 中间件链（Chain of Responsibility） | `app/router/api.go` `r.Use(...)` | 串联 nocache/Recoverer/logging/CORS/audit/authn，标准 `func(http.Handler) http.Handler` 签名 |
| Controller-Service 分层 | controller 编排、service 复用、store 数据访问 | 隔离 HTTP 与业务，service 跨 controller 复用 |
| Wire DI | 所有 controller/handler/openapi `wire.NewSet` | 构造函数参数即依赖声明，编译期生成 |
| Context 传递（仿 K8s） | `app/api/request/context.go` | `auth.Session`/`User`/`Space`/`Repo`/`RequestID` 用自定义 key 类型存 context |

## 模块间交互

Controller → Service：`repo.Controller` import 了 `protection`、`codeowners`、`importer`、`locker`、`keywordsearch`、`label`、`rules`、`autolink`、`mergequeue`、`publickey`、`settings`、`instrument`、`publicaccess` 等十余个 service（见 [领域服务层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services)）。Controller → Store：直接依赖 `store.RepoStore`/`SpaceStore`/`PullReqStore` 等 DAO（见 [持久化层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/04-store)）。Controller → Git：`git.Interface` 抽象所有 git 操作（见 [Git 操作引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git)）。Router 挂载在 [启动模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/01-bootstrap-wire)装配的 `Router` 上。

## 扩展方式

**新增 REST 端点**（如 `POST /repos/{repo_ref}/custom`）：① Controller：在 `app/api/controller/repo/` 新建 `custom.go`，定义 `CustomInput` + `Sanitize()` + `(c *Controller) Custom(...)`，方法内调 `getRepoCheckAccess` 鉴权后执行业务；② Handler：在 `app/api/handler/repo/` 新建 `custom.go` 写 `HandleCustom(repoCtrl) http.HandlerFunc`，按 pattern 取 session→取 path→DecodeBody→调 controller→render；③ Router：在 `app/router/api.go` 的 `setupRepos` 中加 `r.Post("/custom", handlerrepo.HandleCustom(repoCtrl))`；④ OpenAPI：在 `app/api/openapi/repo.go` 的 `repoOperations` 中加 operation，定义 request struct（嵌入 `repoRequest` + `repo.CustomInput`），调 `reflector.SetRequest` + `SetJSONResponse` + `Spec.AddOperation`。

**新增中间件**：写 `func MyMiddleware(next http.Handler) http.Handler`，在 `NewAPIHandler` 中 `r.Use(...)` 全局挂载或 `r.Group(func(r) { r.Use(...); ... })` 局部挂载。

**新增错误类型映射**：在 `app/api/usererror/usererror.go` 加 `var ErrXxx = New(statusCode, "message")`，在 `translate.go` 的 `Translate` switch 中加 `case errors.Is/As(err, ...): return ErrXxx`——handler 无需改动，所有 error 统一走 `render.TranslatedUserError`。
