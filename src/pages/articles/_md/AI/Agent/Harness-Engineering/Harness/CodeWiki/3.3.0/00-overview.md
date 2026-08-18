---
source:
  type: "源码解读"
  project: "Harness"
  url: "https://github.com/harness/harness"
title: "Overview"
date: "2026-08-18T15:14:37+08:00"
category: [AI, Agent, "Harness Engineering", Harness, CodeWiki, "3.3.0"]
tags: ["Harness", "Gitness", "Go", "代码托管", "CI/CD", "Gitspaces", "制品仓库", "DevOps"]
description: "Harness Open Source v3.3.0 源码解读——Go 编写的开源 DevOps 平台，单进程多协议聚合代码托管（Git）、CI 流水线（Drone 衍生）、Gitspaces 托管开发环境、OCI 制品仓库四大产品面"
readingTime: "45 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v3.3.0 · **协议** Apache 2.0 · **语言** Go 1.26.5 · **代码量** ~40.3 万行 Go · **仓库** [GitHub](https://github.com/harness/harness)

---

## 总览

### 项目简介

Harness Open Source（模块路径 `github.com/harness/gitness`）是一个用 Go 编写的开源开发平台，把**代码托管**、**自动化 DevOps 流水线**、**托管开发环境（Gitspaces）**和**制品仓库**四件事聚合到一个进程里。它的定位是 Drone 的下一代：Drone 只做持续集成，Harness 在其上加了源码托管、开发环境和制品仓库，提供端到端的开源 DevOps 能力。项目当前在 `main` 分支演进，同时保留 `drone` 特性分支继续维护老 CI。

Harness 解决的核心问题是：开发团队要凑齐「仓库 + CI + 开发环境 + 制品库」通常得拼装四套独立系统（Gitea + Drone + Codespaces 替代 + Harbor 之类），部署、认证、数据流向都得自己粘。Harness 把它们收进同一进程、同一套认证与数据模型，靠 wire 依赖注入把横切关注点（锁、事件、日志、缓存、作业调度）共享给四大产品面，单条 `docker run` 即可起全栈。

核心使用场景：浏览器访问 `localhost:3000` 做仓库与 PR 管理；`git push` 走 SSH（3022）或 Smart HTTP 推代码并触发 webhook/CI；在 `.harness.yml` 里写流水线由 Drone 衍生引擎执行；一键起 Gitspace 拿到云端开发环境；`docker push` 推镜像到内置 OCI 仓库。**项目边界**：Harness 是平台框架，不训练模型、不提供模型推理；CI 执行后端当前硬编码 Docker runner（k8s runner 为扩展点但未默认启用）。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|------|---------|------|
| 代码托管 | `git/` + `app/services/repo/` + `app/githook/` | `git.Interface` 抽象 40+ 操作，`git.Service` 本地执行原生 git CLI，Smart HTTP + SSH 双协议 |
| Pull Request | `app/services/pullreq/` + `app/api/controller/pullreq/` | PR 生命周期、review、merge、codeowners、合并队列 |
| 分支保护 | `app/services/protection/` | 可组合规则：approval / status check / comment / merge strategy / merge queue |
| Webhook | `app/services/webhook/` | 事件驱动、HMAC 签名、按 repo+祖先 space 链分发、可重试 |
| CI 流水线 | `app/pipeline/`（runner/triggerer/scheduler/converter） | Drone 衍生引擎，Docker step 执行，V1 YAML + 兼容 `.drone.yml` |
| 实时日志 | `livelog/` + `stream/` | step 日志流式推送前端（SSE），全量落库 |
| Gitspaces | `app/gitspace/` + `infraprovider/` | 托管开发环境编排：SCM 拉码 → provision → 凭证注入 → 端口转发 |
| 制品仓库 | `registry/` | 基于 CNCF distribution 二次开发，支持 Docker/OCI v2、Maven、NPM、Cargo、generic |
| 多协议路由 | `app/router/` | 单端口按路径/Host 分发 Git/Registry/API/Web，SSH 独立 listener |
| 依赖注入 | `cmd/gitness/wire.go` | google/wire 编译期生成，~150 个 WireSet 聚合 |
| 后台作业 | `job/` | 带优先级/超时/重试的调度器，DB 轮询驱动 |

### 技术栈

| 依赖 | 类型 | 用途 |
|------|------|------|
| Go 1.26.5 | 核心 | 系统语言 |
| google/wire | 核心 | 编译期依赖注入代码生成（`wire.go` → `wire_gen.go`） |
| gorilla/mux | 核心 | HTTP 路由（Web/API/Registry 子路由器内部） |
| jmoiron/sqlx | 核心 | 数据库访问，`store/database/dbtx` 抽象事务 |
| google.golang.org/grpc | 核心 | git 操作 RPC（主进程 ↔ 独立 git server） |
| golang-jwt/jwt v5 | 核心 | 认证 token（session、pipeline/gitspace 服务 principal） |
| rs/zerolog + go-logr/zerologr | 核心 | 结构化日志，context 透传 |
| kelseyhightower/envconfig + joho/godotenv | 核心 | 配置：`.env` → 环境变量 → `types.Config` struct tag 映射 |
| go-redis/redis v8 | 可选 | 分布式锁 / pubsub 后端（单机可降级内存/DB） |
| prometheus/client_golang | 可选 | 指标暴露（独立 metric server） |
| drone/drone-yaml + drone/spec + drone/runner-go + drone-runner-docker + drone-go | 核心 | CI 引擎沿用 Drone 生态：YAML 解析、执行 runtime、poller 框架、Docker step 后端 |
| distribution/distribution v3 | 核心 | 制品仓库基础（manifest/blob 模型），`replace` 指向本地 `./registry` |
| drone/go-scm | 核心 | Gitspace SCM 集成（GitHub/GitLab/Bitbucket 拉码） |
| hashicorp/golang-lru v2 + go-multierror | 核心 | 缓存 / 错误聚合 |
| kingpin.v2 | 核心 | CLI 子命令（server/migrate/user/swagger） |

### 版本历史

Harness 的演进脉络围绕「Drone 单一 CI → 全栈 DevOps」这条主线：

- **Gitness 阶段**：项目最初叫 Gitness（模块路径至今仍是 `github.com/harness/gitness`），定位是开源代码托管平台，是 Harness 收购 Drone 后重写托管层的产物。
- **Harness 统一品牌**：随后把代码托管、CI（Drone 能力）、Gitspaces、制品仓库整合进同一 monorepo，对外称 Harness Open Source。模块路径保留 `gitness`，仓库改名 `harness/harness`。
- **Drone 特性分支**：为不中断老 CI 用户，`drone` 分支保留 Drone 独立形态继续维护，`main` 分支承载 Harness 主线开发。README 明确目标是逐步让 Harness 在流水线能力上与 Drone 达到对等，再让用户无缝迁移。
- **v3.x**：当前解读的 v3.3.0 处于主线持续演进期，PR 流（branch scope locking、codeowner usergroup、status check bypass）和 Gitspaces/Registry 三大面都在活跃迭代。

---

## 快速上手

最快看到 Harness 跑起来的方式是官方 Docker 镜像（自带数据库与 git server）：

```bash title="启动 Harness 全栈"
docker run -d \
  -p 3000:3000 \
  -p 3022:3022 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/harness:/data \
  --name harness \
  --restart always \
  harness/harness
```

容器起来后：

- 浏览器访问 `http://localhost:3000` → 首次进入走 admin 用户初始化（由 `bootstrap.AdminUser` in `app/bootstrap/bootstrap.go` 根据 `Principal.Admin.*` 配置创建）
- `git clone http://localhost:3000/space/repo.git` → Smart HTTP 推拉代码
- `git clone ssh://git@localhost:3022/space/repo.git` → 走 SSH server（`ssh/`，3022 端口）

端到端验证（推一个仓库并触发一次 webhook）：

```bash title="验证代码托管 + 触发链路"
git init demo && cd demo
echo "# demo" > README.md
git add . && git commit -m "init"
git remote add origin http://localhost:3000/admin/demo.git
git push -u origin main
# 预期：push 经 githook pre-receive 校验 → 写入 git server → 发 repo events → webhook service 异步消费
```

> 上述只给外部操作与结果验证。内部启动时 `main → initSystem(wire) → bootstrap.System → http server` 的对象装配细节见「运行时行为 > 启动流程」。

---

## 代码目录

```
harness/
├── cmd/gitness/           # 进程入口：main.go（kingpin CLI）+ wire.go/wire_gen.go（DI 生成）
├── app/                   # 平台主代码（~19 万行）
│   ├── api/               # HTTP API 层：handler/controller/middleware/openapi/render/usererror
│   ├── services/          # 领域服务：pullreq/repo/space/protection/webhook/mergequeue/...
│   ├── store/             # 持久化：database/ + migrate/ + cache/ + logs/
│   ├── pipeline/          # CI 引擎：runner/triggerer/scheduler/converter/manager/canceler
│   ├── gitspace/          # Gitspace 编排：orchestrator/infrastructure/scm/secret
│   ├── githook/           # git hook 回调处理（pre-receive/post-receive）
│   ├── events/            # 领域事件定义（aitask/check/git/gitspace/pullreq/repo/...）
│   ├── router/            # 多协议路由（Git/Registry/API/Web 子路由器链）
│   ├── bootstrap/         # 启动初始化（system/pipeline/gitspace principal + admin user）
│   ├── server/            # HTTP server 装配
│   ├── auth/              # 认证（authn）/ 鉴权（authz）
│   ├── config/ paths/ url/ sse/ jwt/ token/ connector/   # 配置、路径、URL、SSE、token 等
│   └── request/          # 请求工具（路径提取、前缀剥离）
├── git/                   # Git 操作引擎：interface.go + service.go(gRPC) + 各操作 + sha/parser/storage
├── registry/              # 制品仓库子系统（~14.5 万行，基于 distribution）：app/(api/services storage manifest) + gc/job/
├── infraprovider/         # Gitspace 基础设施提供者
├── cli/                   # CLI 子命令实现（operations/server account migrate user hooks swagger）
├── types/                 # 全局领域类型与 enum（被 import 776 次，全仓基础）
├── store/                 # 顶层 store：dbtx 事务抽象、错误模型（ErrResourceNotFound/ErrDuplicate）
├── job/                   # 后台作业调度器
├── events/                # 事件框架（app/events/ 各领域事件的基础设施）
├── lock/                  # 分布式锁（advisory/nfs/redis 可切换）
├── pubsub/                # 发布订阅抽象
├── stream/ livelog/       # 流式传输 + 实时日志
├── ssh/                   # SSH server（git over ssh）
├── audit/ blob/ cache/ encrypt/ crypto/   # 审计、大对象、缓存、加密
├── web/                   # 前端静态资源
└── charts/ scripts/       # Helm chart + 辅助脚本
```

> `registry/` 是相对独立的子系统（go.mod 用 `replace github.com/harness/gitness/registry => ./registry` 指向本地），其余顶层小包是平台横切关注点，服务于 `app/` 主代码。

---

## 架构设计解析

### 系统架构

Harness 的架构思想是**单进程多协议全栈 + 编译期装配 + 横切关注点共享**。之所以这样设计，是因为 DevOps 全栈的四个产品面（代码托管、CI、Gitspace、制品仓库）背后共享同一套认证、数据模型、事件总线和作业调度——若拆成四个微服务，认证同步、数据一致性、部署复杂度都会爆炸。Harness 把它们收进一个进程，靠 `app/router` 的多协议路由器链按路径/Host 分发流量（Git Smart HTTP、REST API、Docker Registry、Maven、Web UI 共用 3000 端口，SSH 走独立 3022），靠 google/wire 在编译期把几百个 provider 拓扑排序生成 `wire_gen.go`，靠 `events`/`stream`/`lock`/`pubsub`/`job` 等横切包的 interface+多实现模式让"单机内存实现 ↔ 生产 Redis/GCS 实现"零业务代码切换。

![Harness 分层架构](/vibe-reading/images/articles/harness-codewiki-3.3.0/architecture.svg)

从顶到底六层，上层依赖下层，`bootstrap + wire` 在编译期装配全层，横切基础设施层贯穿所有层：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| ------ | ------- | ------------------------ |
| 协议入口层 | `app/router/` `ssh/` `app/api/handler/` | 隔离外部协议（HTTP/SSH/Registry 多协议），保护核心不受接口变化影响 |
| 应用编排层 | `app/api/controller/` `app/bootstrap/` `cmd/gitness/` | 编排用例流程（鉴权、事务、调 service/git），wire 装配全部对象 |
| 领域服务层 | `app/services/` | 承载业务规则（PR/保护规则/webhook/合并队列），跨 controller 复用 |
| 产品引擎层 | `git/` `app/pipeline/` `app/gitspace/` `registry/` | 四大产品面的核心引擎，各自独立子系统 |
| 持久化层 | `app/store/` `store/` | 封装持久化细节（sqlx/dbtx/迁移/缓存），对上提供领域语义接口 |
| 横切基础设施层 | `job/` `lock/` `pubsub/` `events/` `stream/` `livelog/` `blob/` `cache/` `encrypt/` `audit/` | 适配外部资源（Redis/GCS/DB），可切换，interface+多实现 |

### 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 编译期 DI（google/wire） | `cmd/gitness/wire.go` ~150 WireSet | 依赖错误编译期暴露，无运行时反射开销 |
| 多协议路由器链 | `app/router/router.go` 有序 `Interface` 切片 | 单进程多协议靠路径分发，避免多进程部署 |
| Repository + 事务边界在 service | `app/store/database/*` + `dbtx.WithTx` | 多 store 共享事务，store 无感知 |
| 事件驱动消费者 | `events` Reporter/ReaderFactory + `webhook.Service` | 生产消费解耦，异步重试 |
| interface+多实现可切换 | `lock`/`pubsub`/`events`/`blob`/`encrypt` 各 2+ 实现 | 单机内存 ↔ 生产 Redis/GCS 零改动 |
| 适配器（Drone 嵌入） | `app/pipeline/manager/client.go` `embedded` | 复用 Drone 成熟 runtime，进程内调用消除网络开销 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---------|------|---------|---------|
| `types.PullReq` | Pull Request 领域对象 | 创建到 merged/closed | 属于 repo，含 reviewer/activity |
| `Branch`（protection） | 分支保护规则集 | 规则配置持久化 | 含 Bypass/PullReq/Lifecycle |
| `types.Execution` | 一次 CI 执行 | 触发到 finished | 含 stages，属于 pipeline |
| `sha.SHA` | git SHA 值类型 | 请求级 | Nil/None/EmptyTree 三态 |
| `auth.Session` | 认证会话 | 请求级 | 含 Principal + Metadata |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
|----------|---------|--------|---------|
| `git.Interface` | `git/interface.go` | `git.Service`（本地 CLI） | wire `ProvideService` 返回接口 |
| `Bootstrap func` | `app/bootstrap/bootstrap.go` | `System()` | wire `ProvideBootstrap` |
| `infraprovider.InfraProvider` | `infraprovider/infra_provider.go` | `DockerProvider`（+4 待核实） | Factory 按 enum |
| `protection.Definition` | `protection/service.go` | `DefApprovals`/`DefStatusChecks`/... | `Manager.Register` |
| `job.Handler` | `job/executor.go` | 各业务 handler | `executor.Register` boot 时 |

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/harness-codewiki-3.3.0/module-dependencies.svg)

模块间依赖方向：上层 `api/controller` 编排调用 `services` 与 `store`，也直接调 `git.Interface`；`services` 依赖 `store`/`git`/`events`(基础设施)；三大产品引擎（pipeline/gitspace/registry）各自依赖 `store`/`git`/基础设施；基础设施层被全部模块依赖。`bootstrap + wire` 在编译期装配所有模块（见架构图）。模块间的动态调用顺序见「运行时行为 > 核心运行流程」。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|------|------|---------|-----------|---------|
| 启动与依赖注入 | CLI/wire 装配/多协议路由 | `cmd/gitness/main.go` | 装配车间，只造对象不分协议分发，与业务逻辑隔离 | [01](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/01-bootstrap-wire) |
| API 接口层 | HTTP REST 边界与鉴权 | `app/router/api.go` | HTTP 薄层与业务编排分离，统一错误翻译与 OpenAPI 生成 | [02](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api) |
| 领域服务层 | PR/保护规则/webhook/合并队列 | `app/services/wire.go` | 跨 controller 复用的业务规则，controller 只编排不实现 | [03](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services) |
| 持久化层 | sqlx/dbtx/迁移/缓存 | `store/database/dbtx/` | 数据访问与业务隔离，双方言(postgres/sqlite)可切换 | [04](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/04-store) |
| Git 操作引擎 | 原生 git CLI 封装 + githook | `git/interface.go` | 代码托管核心，hook 双路径(运行时回调+CLI 二进制) | [05](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git) |
| CI 流水线引擎 | Drone 衍生 CI 执行 | `app/pipeline/triggerer/` | 独立执行后端(Docker)，复用 Drone 生态 | [06](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/06-pipeline) |
| Gitspaces | 托管开发环境编排 | `app/gitspace/orchestrator/` | 异步事件驱动三段式，Factory 可插拔 infra/scm/ide | [07](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/07-gitspace) |
| 制品仓库 | 多格式 OCI/Maven/NPM registry | `registry/app/pkg/` | 内嵌 distribution，独立子系统共享主 app 认证/事件 | [08](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/08-registry) |
| 跨切面基础设施 | job/lock/pubsub/events/livelog/ssh | `job/` `events/` `lock/` | 横切关注点集合，全部 interface+多实现可切换 | [09](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra) |

---

## 运行时行为

### 启动流程

```
main() in cmd/gitness/main.go:37
  └─ kingpin 解析 → server.Register(app, initSystem)
        └─ command.run() in cli/operations/server/server.go:44
              ├─ godotenv.Load(.env) + LoadConfig(envconfig → *types.Config)
              ├─ initSystem(ctx, config) in cmd/gitness/wire.go:175
              │     └─ wire.Build(...) → wire_gen.go:202 自底向上构造
              │           database → stores → caches → controllers → services → router → server → System
              ├─ system.bootstrap(ctx) in app/bootstrap/bootstrap.go:69
              │     ├─ SystemService/PipelineService/GitspaceService  三个 service principal
              │     └─ AdminUser  创建 admin（幂等，duplicate 容忍）
              └─ errgroup 并行启动：HTTP(3000) · metric · SSH(3022) · JobScheduler · CI poller
```

对象装配的关键：wire 编译期把 ~150 个 `WireSet` 拓扑排序，生成 `initSystem()` 自底向上调用 provider——database → stores → caches → controllers → services → router → server → System。service principal（system/pipeline/gitspace）是包级变量在 bootstrap 阶段一次性赋值、进程级常驻。配置来自 `.env` → 环境变量 → `types.Config` struct tag（envconfig），`backfillURLs` 派生 URL，无 YAML。

### 核心运行流程

下面三条链路覆盖了 Harness 的核心运行模式：HTTP 请求处理（PR 创建）、CI 触发、git push。

#### 代码托管：创建 Pull Request

业务流程：HTTP POST → 多协议路由 → 认证中间件 → handler 解码 → controller 编排（鉴权+查重+取 git 对象）→ 事务内创建 PR/reviewer/git ref → 事务外发事件与 SSE → 返回 201。

![创建 PR 数据流](/vibe-reading/images/articles/harness-codewiki-3.3.0/data-flow.svg)

从 `handler.HandleCreate` in `app/api/handler/pullreq/pr_create.go:26` 出发，`pullreqCtrl.Create` in `app/api/controller/pullreq/pr_create.go:82` 是核心：`Sanitize` 校验 → `getRepoCheckAccess` 鉴权（`apiauth.CheckRepo` 构造 Scope+Resource 调 `authz.Authorizer.Check`）→ `git.FetchObjects`/`GetRef`/`MergeBase`/`DiffStats` 经 `git.Interface` 本地执行 git CLI 取 SHA → `checkIfAlreadyExists` 查重 → `controller.TxOptLock` 开启事务，context 注入事务 accessor，事务内 `repoStore.Update`(递增 PullReqSeq) → `pullreqStore.Create`(INSERT RETURNING 回填 ID) → `reviewerStore.Create` → `git.UpdateRef`(创建 `refs/pullreq/{N}/head`，事务内最后一步，失败则整事务回滚) → 事务外 `events.Created`(异步被 webhook service 消费) + `sse.Publish`(前端推送) + `instrument.Track`。数据结构变化：HTTP body JSON → `CreateInput` → `*types.PullReq`（经 `mapInternalPullReq` 到 DB struct）→ HTTP 201 body。

#### 持续集成：push 触发流水线

push 经 githook `pre-receive` 校验后写入 git server，controller 发 repo events，`triggerer.Trigger` in `app/pipeline/triggerer/trigger.go:132` 消费事件：`fileService.Get` 从 git 取 YAML → `converterService.Convert` 按扩展名分派（jsonnet/starlark/透传）→ `isV1Yaml` 判断 V1(`spec:`) 或 Drone 遗格式 → 解析构建 `dag.Dag`（`DependsOn` 管理 stage 依赖）→ `skipBranch`/`skipEvent` 过滤 → 事务写 execution+stages → 对 `Pending` stage 调 `scheduler.Schedule`。`scheduler.queue` DB 轮询拉取，`Request` 按平台匹配分发给 `runner` poller，`embedded` client in `manager/client.go:39` 把 Drone runner 的 RPC 进程内转发到 `ExecutionManager`，step 在 Docker 容器执行，日志经 `livelog.LogStream` 实时推前端 + 全量落 blob。完成发 `events.Reporter` 供 check 系统/webhook 消费。详见 [CI 引擎模块](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/06-pipeline)。

#### 代码托管：git push over SSH

SSH client 连 3022 → `ssh.Server` in `ssh/server.go:88` 的 `publicKeyHandler` 调 `publickey.SSHAuthService.ValidateKey` 验证公钥 → `sessionHandler` 解析命令白名单只允许 `git-upload-pack`/`git-receive-pack`/`git-lfs-*` → git 命令委托 `RepoCtrl.GitServicePack()`（复用 HTTP router 同一 controller）→ `git.ServicePack` 处理 `git-receive-pack`，push 时注入 `CreateEnvironmentForPush` 环境变量（含 `GIT_HOOK_PAYLOAD` gob+base64 payload）→ git CLI 触发 `pre-receive` hook 二进制 → `ProcessPreReceiveObjects` 扫描推送对象（超大文件/committer 邮箱/LFS 指针）→ 通过后 `hook.RefUpdater` 状态机 INIT→PRE→UPDATE→POST 更新 ref → post-receive 发 events 触发 webhook/CI。SSH 与 HTTP 共享 `RepoCtrl`/`LFSCtrl` 业务层，传输层不同业务层统一。详见 [Git 引擎](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/05-git)与[基础设施层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/09-infra)。

---

## 典型修改场景

#### 场景 1：新增一个 REST 端点

需改四处（见 [API 层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/02-api)扩展方式）：`app/api/controller/<name>/` 新建 Controller + `CustomInput` + `Sanitize` + 方法（内调 `getRepoCheckAccess` 鉴权）；`app/api/handler/<name>/` 写 `HandleCustom` 闭包；`app/router/api.go` 的 `setupRepos` 加 `r.Post(...)`；`app/api/openapi/<name>.go` 加 operation（reflector 推导 schema）；若新增 service 依赖则改 controller `NewController` 签名 + wire。

#### 场景 2：新增一条分支保护规则类型

实现 `protection.Definition` interface（`Sanitize` + `SupportsParent`）→ `protection/service.go` 的 `Manager.Register` 注册 → 新增 `rule_xxx.go` 定义 struct → 在 `verify_pullreq.go` 或新文件实现 `MergeVerify` 校验 → 更新 `enum.RuleType`。见 [领域服务层](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/03-services)。

#### 场景 3：新增一种制品格式

`registry/app/api/handler/<fmt>/` 加 handler、`app/pkg/<fmt>/` 加 controller（实现 `pkg.Artifact` 的 Local+Remote）、`app/api/router/<fmt>/` 加路由、`app/remote/adapter/<fmt>/` 加 upstream adapter、`app/api/wire.go` 注册 WireSet。OCI 格式无需改 manifest；非 OCI 格式用 `GenericBlobStore`。见 [制品仓库](/vibe-reading/articles/AI/Agent/Harness-Engineering/Harness/CodeWiki/3.3.0/08-registry)。

---

## 测试体系

Harness 的测试分三层，与代码层大致对应：

```
mocks/                     生成的接口 mock（git/pullreq/sse/store）
app/testing/integration/   集成测试 harness（integration.go）
*_test.go                  单元测试，与源码同目录（app 113 / git 23 / registry 83 / job 2 / lock 2 个文件）
registry/tests/            制品仓库格式 conformance 测试（cargo/gopkg/maven/npm + conformance_test.sh）
.testapi/                  测试 API 辅助
```

| 代码层 | 测试类型 |
|--------|---------|
| `git/`（Interface 抽象） | 单元测试 + `mocks/git` mock |
| `app/store/*` | 单元测试（postgres/sqlite 双方言）+ `mocks/store` |
| `app/api/controller/*` | 集成测试（`app/testing/integration` harness） |
| `registry/` | 单元测试 + 格式 conformance 测试 |

`git.Interface`/`store.*Store`/`pullreq` 等核心接口都有生成的 mock（`mocks/`），让单测能隔离 git CLI 与 DB。改某层代码时，参照上表找对应测试类型优先阅读——`*_test.go` 实际是很好的可执行文档。

---

## 阅读源码推荐路线

- **第一遍：理解启动与请求主流程**
  `cmd/gitness/main.go` 的 `main()` → `cli/operations/server/server.go:44` 的 `command.run()` → `cmd/gitness/wire.go:175` 的 `initSystem`（看 `wire_gen.go:202` 生成的装配）→ `app/router/router.go:45` 的 `Router.ServeHTTP` 多协议分发 → `app/api/handler/pullreq/pr_create.go` 的 `HandleCreate` → `app/api/controller/pullreq/pr_create.go:82` 的 `Create`。
- **第二遍：理解核心数据结构与领域规则**
  `types/pullreq.go` 的 `PullReq` → `app/services/protection/rule_branch.go` 的 `Branch` + `protection/verify_pullreq.go` 的 `DefPullReq.MergeVerify` → `app/services/mergequeue/mq_process.go` 的合并队列状态机。
- **第三遍：理解四大产品引擎**
  `git/interface.go` 的 `Interface` + `git/service.go` 的本地 CLI 执行 + `git/hook/refupdate.go` 状态机 → `app/pipeline/triggerer/trigger.go:132` 的 `Trigger` + `manager/client.go:39` 的 `embedded` → `app/gitspace/orchestrator_trigger.go:100` 三段式 → `registry/app/pkg/core_controller.go` 的格式分发。
- **第四遍：理解横切基础设施与可切换实现**
  `store/database/dbtx/runner.go` 的 `WithTx` 事务注入 → `events/system.go` 的 `System` 工厂 + `stream/redis_consumer.go` 的 reclaimer → `lock/lock.go` + `lock/redis.go` 的内存/Redis 切换 → `livelog/stream.go` 的 5000 行 FIFO + subscriber fan-out。再按兴趣选重点子模块深入各模块文档。

---

## 附录

### 术语表

| 术语 | 含义 |
|------|------|
| Gitness | Harness 开源版的原始项目名，模块路径 `github.com/harness/gitness` 沿用至今 |
| Gitspace | Harness 的托管开发环境产品（类似 GitHub Codespace） |
| service principal | 进程级服务账户（system/pipeline/gitspace），代用户执行系统操作 |
| TxOptLock | controller 的事务+乐观锁封装，version 冲突自动重试 ≤5 次 |
| merge queue | 串行化合并队列，避免多 PR 互相 invalidate merge base |
| embedded client | 把 Drone runner 的 RPC 进程内转发到 ExecutionManager 的适配器 |
| WireSet | google/wire 的 provider 集合，按包组织 |
| dbtx | 事务抽象层，context 传递事务 accessor，store 无感知 |

### 参考资料

- [Harness 开发者文档](https://developer.harness.io/docs/open-source)
- [google/wire 依赖注入](https://github.com/google/wire)
- [Drone（CI 引擎前身）](https://www.drone.io/)
- [CNCF distribution（制品仓库基础）](https://github.com/distribution/distribution)
- [devcontainer.json 标准](https://containers.dev/)
