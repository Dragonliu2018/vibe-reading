---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "Overview"
date: "2026-09-24T16:10:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "代理服务器", "OAuth", "多账号负载均衡", "协议翻译"]
description: "CLIProxyAPI v7.3.16 源码架构解读——把 Claude Code / Codex / Gemini CLI 等 OAuth 订阅账号封装成 OpenAI/Claude/Gemini 兼容 API 的本地代理：N×M 协议翻译矩阵、凭据调度 Conductor（双轨调度 + 双粒度 cooldown + 会话亲和）、Cloak 伪装执行器、Go 原生插件 ABI、Management API 全解"
readingTime: "75 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> **版本** v7.3.16（tag，2026-09-24）· **协议** MIT · **语言** Go 1.26 · **代码量** ~244,000 行生产代码（另 ~321,000 行测试）· **仓库** [GitHub](https://github.com/router-for-me/CLIProxyAPI)

---

## 总览

### 项目简介

CLIProxyAPI 是一个用 Go 编写的**本地代理服务器**：把 Claude Code、OpenAI Codex、Gemini CLI、Antigravity、Kimi、xAI、Devin 等 AI 编程工具的 **OAuth 订阅账号**，封装成 OpenAI（Chat Completions + Responses）、Claude Messages、Gemini GenerateContent 三种兼容 API 端点。任何说这些"方言"的客户端或 SDK，不需要 API key，只要指向本地端口（默认 8317）就能用上你的订阅额度。

它解决三个实际问题：

- **协议方言互通**——Claude Code 客户端想用 Codex 订阅、OpenAI SDK 想用 Claude 订阅，入站格式与上游格式之间的 N×M 翻译全部由代理完成；
- **多账号负载均衡**——同一 provider 挂多个 OAuth 账号，轮询/加权/填满优先调度，429 自动降权冷却、自动换号重试、token 过期自动刷新；
- **订阅身份保真**——上游按"是否原生客户端"识别订阅流量，执行器层做 wire 级伪装（client_id、header、TLS 指纹、系统提示注入），让非原生客户端的请求也走订阅通道。

**项目边界**：它是本地/自托管代理，不是云端网关服务；不做模型推理（纯转发翻译）；自 v6.10.0 起内置用量统计已移除（交给 [CPA Usage Keeper](https://github.com/Willxup/cpa-usage-keeper) 等外置面板）；它有一个可选的 "Home" 中央控制面（Redis 协议）支持集群凭据集中分发，但单机是主场景。

### 功能矩阵

| 特性 | 实现位置 | 说明 |
|---|---|---|
| OpenAI Chat Completions / Responses 端点 | `sdk/api/handlers/openai/` | 含 WebSocket 变体与 Codex 双工 steering |
| Claude Messages 端点 | `sdk/api/handlers/claude/` | Claude Code 直接对接 |
| Gemini GenerateContent 端点 | `sdk/api/handlers/gemini/` | Google AI Studio 客户端对接 |
| 7 种 wire 格式 N×M 翻译 | `internal/translator/` | openai / openai-response / claude / gemini / codex / antigravity / interactions |
| 多账号轮询负载均衡 | `sdk/cliproxy/auth/selector.go` | RR / 平滑加权 RR / FillFirst / 会话亲和 |
| 429 降权冷却与故障转移 | `sdk/cliproxy/auth/conductor_cooldown.go` | 模型级 + 凭据级双粒度，跨重启持久化 |
| OAuth token 自动刷新 | `sdk/cliproxy/auth/auto_refresh_loop.go` | 最小堆调度，401 兜底刷新 |
| 上游订阅身份伪装 | `internal/runtime/executor/claude_executor_cloaking.go` | 系统提示注入 / uTLS 指纹 / CCH 签名 |
| thinking/reasoning 跨格式往返 | `internal/thinking/` + `internal/cache/` | 签名恢复 + 多轮回放缓存 |
| Go/Rust/C 原生插件 | `internal/pluginhost/` | 自研 C ABI（dlopen + JSON RPC） |
| Management API + Web 面板 | `internal/api/handlers/management/` | ~150 条路由，面板资产自动下载 |
| 配置与凭据热重载 | `internal/watcher/` | fsnotify + diff + 增量事件 |
| 同端口 HTTP + Redis 多路复用 | `internal/api/protocol_multiplexer.go` | redis-cli 直接订阅 usage 流 |
| mDNS 局域网发现 | `internal/discovery/` | `_ai-gateway._tcp` DNS-SD 广播 |
| 可嵌入 Go SDK | `sdk/cliproxy/` | Builder 装配，自定义 provider 零 internal 依赖 |
| 集群 Home 控制面 | `internal/home/` | Redis KV 集中分发配置/凭据/配额 |

### 技术栈

| 依赖 | 类型 | 用途 |
|---|---|---|
| gin | 核心 | HTTP 路由与中间件 |
| gjson / sjson | 核心 | 字节级 JSON 变换（翻译矩阵全部基于它，不做 struct 反序列化） |
| fsnotify | 核心 | 配置与凭据文件监听 |
| uTLS（`refraction-networking/utls`） | 核心 | 上游 TLS ClientHello 指纹伪装 |
| go-git | 可选 | GitTokenStore：凭据进 git 仓库做多实例同步 |
| go-redis | 可选 | Home 集群控制面 + usage 队列 |
| pgx / minio-go | 可选 | Postgres / S3 兼容对象存储后端 |
| libp2p/zeroconf | 可选 | mDNS 局域网发现 |
| godotenv / logrus / bubbletea | 辅助 | 环境变量 / 日志 / TUI 管理界面 |
| cgo | 核心 | 插件 dlopen 加载（Windows 走 LoadLibrary） |

### 版本历史

- **v6.x**：引入 Go SDK 嵌入模型（`sdk/cliproxy` 从 internal 下沉）、Management API v0、移除内置用量统计（v6.10.0）；
- **v7.x**（本版）：模块路径升到 `/v7`，插件系统从 Go `plugin.Open` 换成自研语言中立 C ABI（Go/Rust/C 插件均可），执行器层补齐 Antigravity/Kimi/xAI/Devin/Meta 家族，Codex 引入 WebSocket 双工 transport 与 response steering，凭据调度引入 `authScheduler` 快速路径镜像与 5h/7d 统一配额窗口。

---

## 快速上手

代码阅读者最快的"跑起来"路径（三步）：

```bash
# 1. 构建（Go 1.26+，需要 cgo——插件系统用 dlopen）
go build -o cli-proxy-api ./cmd/server

# 2. 最小配置：config.yaml
#    port: 8317
#    auth-dir: "~/.cli-proxy-api"
#    api-keys: ["sk-local-1"]
# 3. OAuth 登录一个 Claude 账号，然后启动
./cli-proxy-api --claude-login
./cli-proxy-api --config config.yaml
```

端到端验证（登录完成后）：

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer sk-local-1" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"stream":true}'
# 预期：SSE 流式返回（data: {...} 帧），模型走的是你的 Claude 订阅账号
```

模型列表端点 `/v1/models` 可确认可用模型；`--tui` 启动终端管理界面，或在 config 里配置 `remote-management.secret-key` 后访问 `/v0/management` Web 面板。

---

## 架构设计解析

### 系统架构

先讲设计思想。CLIProxyAPI 的本质是一个**双面翻译器 + 凭据池调度器**：对外呈现三种稳定的"客户端协议"（OpenAI/Claude/Gemini），对内维护每种"上游协议"的执行器，中间靠一个注册表驱动的翻译矩阵连接。它的架构决策都围绕两个不变量展开：

1. **客户端协议和上游协议永远解耦**——任何入站格式可以打到任何上游（`ConvertClaudeRequestToCodex` 这样的成对翻译器注册进 `sdk/translator` 的 `(from, to)` 双层 map），新增一种协议只需增加矩阵的一行/一列；
2. **凭据是运行时一等公民**——凭据（`Auth`）有自己的状态机（ready/cooldown/blocked）、持久化（token JSON 文件 + 独立的 `.cds` 冷却状态文件）、刷新循环和调度策略，执行器被刻意设计成**无状态**的（只持 `*config.Config`），一切凭据相关的判断都收口在 Conductor 一层。

分层与数据面/控制面分离是第三个关键决策：`Service`（门面）只负责装配与生命周期，HTTP 请求进来后**完全不经过 Service**——`api.Server` 直接调用 `coreManager.Execute`（`conductor_execution.go:121`），Service 关停不影响 in-flight 请求。

![CLIProxyAPI 分层架构](/vibe-reading/images/articles/cli-proxy-api-internals/architecture.svg)

自上而下五层：客户端层（三种协议方言的客户端）→ 接入层（协议 Handler + API key 鉴权 + Management API + 同端口协议多路复用）→ 调度层（Conductor：选择器策略、调度镜像、冷却与重试）→ 执行层（每上游一个 `ProviderExecutor` 实现）→ 上游订阅端点。右侧是贯穿三层的横切基础设施：翻译矩阵、thinking 处理与回放缓存、模型注册表、插件宿主、配置热重载。

| 架构层 | 包含目录 | 层职责 |
|---|---|---|
| 接入层 | `internal/api/`、`sdk/api/handlers/` | 隔离外部协议与鉴权，把 HTTP 请求规整成统一的 `Request/Options`，保护核心不感知 HTTP 细节 |
| 调度层 | `sdk/cliproxy/auth/` | 凭据池的全部运行时决策：选择、降权、恢复、刷新、重试，执行器与 handler 都不掺和 |
| 执行层 | `internal/runtime/executor/` | 每上游一个翻译+发送+流解析的实现，契约（`ProviderExecutor`）在 sdk 层定义，依赖倒置 |
| 横切服务 | `internal/translator/`、`internal/thinking/`、`internal/cache/`、`internal/registry/` | 无状态可复用的格式转换与元数据服务，被 handler/executor/调度三方消费 |
| 基础设施 | `internal/config/`、`internal/watcher/`、`internal/auth/`、`internal/store/`、`internal/pluginhost/`、`internal/home/` | 配置、持久化、扩展机制，全部经接口或回调注入上层 |
| SDK 面 | `sdk/`（除 internal 依赖的契约包外） | 对外稳定 ABI：嵌入方与插件作者只 import `sdk/`，`internal/` 受 Go 可见性保护 |

> 注意一个反直觉的事实：`sdk/cliproxy` 反向 import 了 `internal/`（api/watcher/home）——sdk 不是纯下沉层，而是"官方嵌入入口"，`internal/` 防的是插件作者而非自己。

### 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| Builder + 门面 | `NewBuilder`/`Build` in `sdk/cliproxy/builder.go`；`Service` in `service.go` | 15 个 `With*` 让嵌入方零成本起步；Service 聚合 10+ 子系统的生命周期 |
| 依赖倒置（接口放消费方） | `ProviderExecutor` in `sdk/cliproxy/auth/conductor.go:16`，实现全在 `internal/runtime/executor/` | 接口由 Conductor（消费方）定义，52k 行实现可随便重写不破坏外部编译 |
| 注册表 + side-effect import | `sdk/translator/registry.go` + `internal/translator/init.go` 27 个匿名 import | 翻译器"声明即注册"，新增一对格式零中心文件改动 |
| 策略 | `Selector` 四实现 in `selector.go`；`CodexAutoExecutor` HTTP/WS 路由 | 调度策略运行期热换，双 transport 按凭据能力分发 |
| 状态镜像 + 双轨 | `authScheduler` in `scheduler.go` 是 `m.auths` 的增量只读镜像 | fast path 无锁 pick；自定义 selector 时整体退化 legacy path 保证语义完备 |
| 观察者 | `Hook`（OnAuthRegistered/OnResult）in `conductor.go:98`；fsnotify watcher | 凭据状态变化广播给 Service/usage 统计/管理面板 |
| 装饰器 | `SessionAffinitySelector` 包装任意 fallback Selector；`NewPluginRefreshCompatExecutor` 包装裸 compat executor | 亲和与插件刷新能力可叠加在既有实现上 |
| 管道 + 带外总线 | `Options.Metadata` 40+ 常量 key in `sdk/cliproxy/executor/types.go:12-87` | 调度器/亲和/LCP 与 executor 传提示不改接口签名 |
| 桥接（C ABI） | `loader_unix.go` dlopen + `cliproxy_plugin_init` 函数表 | 宿主与插件只交换 JSON 消息，Go/Rust/C 三语言插件等价可行 |
| 乐观并发（CAS + generation） | `ReplaceClaudeThinkingReplayIfUnchanged` in `internal/cache/claude_thinking_replay_cache.go:165` | 回放缓存并发追加不丢失不重复 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
|---|---|---|---|
| `Service` | 门面：配置、凭据、executor、watcher、server 的组合根 | 进程级，`Build()` 装配 → `Run()` 阻塞 → `Shutdown()` 幂等关闭 | 持有但不参与请求路径 |
| `Auth`（凭据） | 一个 OAuth 账号/API key 的运行时镜像：Attributes（配置）+ Metadata（token）+ Quota/ModelState（健康） | 从 auth 文件合成，watcher 增量维护，Generation 单调递增 | 被 Conductor 调度，被 executor 消费 |
| `Manager`（Conductor） | 凭据池调度中枢：executors 注册表 + auths 真源 + 重试编排 | 进程级单例，随 Service 创建 | handler 唯一执行入口 |
| `authScheduler` | Conductor 内的增量调度镜像（ready/cooldown/blocked 分桶） | 随 Manager，`syncScheduler` 增量同步 | fast path 的 pick 数据源 |
| `Request`/`Options`/`StreamResult` | 执行契约三件套（`sdk/cliproxy/executor/types.go`） | 每请求 | handler 构造 → Conductor → executor |
| `Registry`（模型注册表） | 全局模型目录：静态内嵌 + 3 小时远程刷新 + 按凭据动态注册 | 进程级单例 `GetGlobalRegistry()` | `/v1/models`、路由反查、能力查询 |
| `CooldownStateRecord` | 冷却状态持久化记录（`.cds` 文件） | 跨进程重启 | `FileCooldownStateStore` 存取 |
| `Host`（插件宿主） | dlopen 加载的插件集合，atomic.Value 快照 | 随 config 热重载增删 | 向 Conductor 注册 executor/调度器/拦截器 |

对象关系（ASCII）：

```
Service ──┬── api.Server ── BaseAPIHandler ──┐
           │                                   ├── coreauth.Manager（Conductor）
           ├── watcher ── AuthUpdate 队列 ────► │    ├── authScheduler（镜像）
           ├── pluginHost ── RegisterExecutor ► │    ├── executors map{provider→Executor}
           └── homeRegistry（Home 模式）         │    └── auths map{authID→Auth}
                                                  │         └── ModelStates{model→冷却}
                                                  └──► internal/runtime/executor/*（无状态）
                                                          └──► 上游订阅 API
```

#### 核心抽象

| 接口/抽象类 | 定义位置 | 实现类 | 注册方式 |
|---|---|---|---|
| `ProviderExecutor`（六方法执行契约） | `sdk/cliproxy/auth/conductor.go:16` | Claude/Codex/Gemini/Antigravity/Kimi/xAI/Devin/Meta/AIStudio/Vertex/OpenAICompat 执行器 + 插件 `executorAdapter` | `Manager.RegisterExecutor` in `conductor_lifecycle.go:34` |
| `Selector`（调度策略） | `sdk/cliproxy/auth/conductor.go:72` | RoundRobin / WeightedRR / FillFirst / SessionAffinity | `newRoutingSelector` in `service_config.go:65` 按配置装配 |
| `Authenticator`（登录流编排） | `sdk/auth/interfaces.go:25` | claude/codex/antigravity/kimi/devin/xai/meta 等 9 家 | `internal/cmd/auth_manager.go:13` 显式注册 |
| `Store`（凭据持久化） | `sdk/cliproxy/auth/store.go:6` | FileTokenStore / GitTokenStore / PostgresStore / ObjectTokenStore | 全局注册表 `RegisterTokenStore`，`cmd/server/main.go:668` 四选一 |
| `TokenStorage`（token 落盘） | `internal/auth/models.go:8` | 每家 provider 一个（如 `ClaudeTokenStorage`） | 登录流构造 |
| `RequestTransform`/`ResponseTransform`（翻译器） | `sdk/translator/types.go` | `internal/translator/{上游}/{客户端}/` 每对格式一个包 | 包 `init()` 自注册 + `internal/translator/init.go` 匿名 import |
| `ProviderApplier`（thinking 配置应用） | `internal/thinking/types.go` | claude/openai/codex/gemini/antigravity/kimi/interactions/xai 各一个 | `RegisterProvider` 自注册 + 插件可注册同名 |
| `Plugin` 能力集（`Capabilities`） | `sdk/pluginapi/types.go:82` | Executor/AuthProvider/Scheduler/ModelRouter/Interceptor/Translator 等 15 类 | 插件 `register` RPC 上报，宿主 `Capabilities` 结构体聚合 |
| `CooldownStateStore` | `sdk/cliproxy/auth/cooldown_state.go:33` | FileCooldownStateStore（默认）/ PostgresCooldownStore | `SwapCooldownStateStore` 热换 |

---

## 代码目录

```shell
CLIProxyAPI/
├── cmd/
│   └── server/            # main 入口（CLI flags：各家 --*-login、--tui、--discover）
├── internal/
│   ├── api/               # HTTP 服务器装配、路由注册、协议多路复用、management 路由、中间件
│   ├── auth/              # 每 provider 的 OAuth 协议原语（PKCE、回调服务、token 交换）
│   ├── cache/             # reasoning 回放缓存 + 签名恢复缓存（bounded LRU）
│   ├── client/            # claude/codex/grokbuild 上游 HTTP 客户端
│   ├── config/            # Config 模型、加载校验、保注释 YAML 写回
│   ├── home/              # Home 集群控制面客户端（Redis 协议）
│   ├── pluginhost/        # 插件宿主：dlopen、ABI、适配器、崩溃守卫
│   ├── pluginstore/       # 插件安装：GitHub Release / registry.json + sha256
│   ├── registry/          # 模型注册表：内嵌目录 + 3h 远程刷新 + 配额水位
│   ├── runtime/executor/  # ★ 全项目最大模块（~52k 行）：每上游一个执行器 + helps/ 公共层
│   ├── signature/         # Claude thinking 签名净化与跨 provider 签名转换
│   ├── store/             # Git/Postgres/S3 持久化后端
│   ├── thinking/          # thinking 配置归一化（Mode/Level/Budget + 后缀解析）
│   ├── translator/        # ★ N×M 翻译矩阵（{上游}/{客户端} 成对子包）
│   ├── watcher/           # fsnotify + diff + 事件合成 + 增量 dispatch
│   └── wsrelay/           # Gemini WebSocket 中继
├── sdk/
│   ├── api/handlers/      # 三协议 handler + 流转发基座（BaseAPIHandler）
│   ├── cliproxy/          # Service/Builder 门面 + executionregistry + pipeline 契约
│   │   ├── auth/          # ★ Conductor：Manager/selector/scheduler/cooldown/刷新
│   │   ├── executor/      # Request/Options/StreamResult 数据契约（接口在 auth 包）
│   │   └── pipeline/      # 对外 SDK 执行契约（Context/Hook，仓库内无 importer）
│   ├── translator/        # 翻译注册表 + Format 常量 + Pipeline/PluginHooks
│   ├── pluginapi/         # 插件作者 API（Capabilities 契约）
│   └── pluginabi/         # C ABI 版本常量（ABIVersion/SchemaVersion）
└── test/                  # 跨包集成测试（翻译保真、thinking 往返、配额故障转移）
```

---

## 模块地图

![模块依赖地图](/vibe-reading/images/articles/cli-proxy-api-internals/module-dependencies.svg)

依赖主线沿"服务核心 → HTTP 网关 → Conductor → 执行器"的请求路径纵向展开；翻译矩阵与 thinking 是执行器的横向依赖；配置热重载、OAuth 持久化、模型注册表、插件系统从左侧和右侧汇入 Conductor。全部交互见上图，模块职责与"为什么独立"如下：

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
|---|---|---|---|---|
| 服务核心与装配 | Service 门面、Builder 装配、executor 注册收口、Home 执行资源记账 | `Build` in `sdk/cliproxy/builder.go` | 生命周期与请求路径分离，嵌入方只接触这一层 | [01-service-core](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/01-service-core) |
| HTTP 网关 | 三协议端点、鉴权中间件、流转发、同端口多路复用 | `NewServer` in `internal/api/server.go:118` | 协议差异必须隔离在统一契约之前 | [02-api-gateway](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/02-api-gateway) |
| Conductor 凭据调度 | 凭据池选择/冷却/恢复/刷新/重试的全部运行时决策 | `Execute` in `sdk/cliproxy/auth/conductor_execution.go:121` | 凭据是带状态的运行时资产，决策必须单点收口 | [03-conductor](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/03-conductor) |
| Provider 执行器 | 每上游一个"翻译进、发送、流解析、翻译出"实现 | `NewClaudeExecutor` in `claude_executor.go:139` | 上游差异（wire 格式、限流头、伪装要求）天然按家分化 | [04-executors](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/04-executors) |
| 协议翻译矩阵 | 7 格式 N×M 请求/响应/SSE 翻译 | `TranslateRequest` in `sdk/translator/registry.go` | 无状态纯函数注册表，矩阵单元独立演进 | [05-translator](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/05-translator) |
| OAuth 认证与持久化 | 登录流、token 刷新、四种持久化后端 | `Login` in `sdk/auth/manager.go:52` | 登录协议原语被 CLI/Management/executor 刷新三处复用 | [06-auth-oauth](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/06-auth-oauth) |
| 配置与热重载 | Config 模型、fsnotify、diff 事件、增量应用 | `reloadConfig` in `internal/watcher/config_reload.go` | 配置与凭据变更必须不重启生效且不丢运行时状态 | [07-config-watcher](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/07-config-watcher) |
| 模型注册表 | 静态+动态模型目录、能力三态、mDNS 发现 | `GetGlobalRegistry` in `registry/model_registry.go:206` | 模型可见性 = f(凭据池)，随凭据动态伸缩 | [08-registry](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/08-registry) |
| Thinking 与回放缓存 | thinking 配置归一化、签名恢复、多轮回放 | `applyThinking` in `internal/thinking/apply.go` | reasoning 跨格式往返是协议互通的最大暗坑 | [09-thinking](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/09-thinking) |
| 插件系统 | 语言中立 C ABI、15 类扩展点、崩溃守卫、安装校验 | `ApplyConfig` in `pluginhost/host.go:205` | 扩展点横跨所有层，必须独立于任何单一模块 | [10-plugin](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/10-plugin) |
| Management API | ~150 条管理路由、OAuth 代登录、日志、配额 | `registerManagementRoutes` in `server_management.go:14` | 管理面与代理面共用进程但鉴权/审计完全隔离 | [11-management](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/11-management) |

> 模块间的动态调用顺序见下面「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

```
main() in cmd/server/main.go
├── SetupBaseLogger（init）→ LoadConfigOptional in internal/config/config_load.go
│     （默认值预置 → YAML unmarshal → 12 个 Sanitize* → 校验权重）
├── 选持久化后端（四选一）→ sdkAuth.RegisterTokenStore
├── configaccess.Register(&cfg.SDKConfig)          # api-keys 注册为访问控制 provider
├── cmd.StartServiceWithPluginHost → cliproxy.NewBuilder().WithConfig(...).Build()
│     in sdk/cliproxy/builder.go
│   ├── coreauth.NewManager(tokenStore, newRoutingSelector(routingState), nil)
│   │     # Manager 即 Conductor；selector 按 routing.strategy 装配（可包会话亲和）
│   ├── pluginhost.New() + ApplyConfig（发现并加载插件 .so）
│   └── 组装 Service，注入回调：WithConfigReloadHook / WithPostAuthPersistHook
└── service.Run(ctx) in service_lifecycle.go
    ├── coreManager.Load(ctx)                     # 从 auth 目录加载全部凭据
    ├── registerAvailableExecutors in service_executors.go
    │     # 15 个合成 baseline Auth → 逐个 New*Executor → RegisterExecutor
    │     # 插件 executor 也在此注册（原生优先仲裁）
    ├── coreManager.StartAutoRefresh(ctx, 15min)  # 最小堆 OAuth 刷新循环（goroutine）
    ├── api.NewServer(cfg, coreManager, accessManager, ...) → server.Start()
    │     # 真实 TCP listener + muxListener；goroutine: Serve + acceptMuxConnections
    ├── watcherWrapper.Start(ctx)                 # fsnotify：config + auth 目录（goroutine）
    ├── applyPprofConfig / applyDiscoveryConfig   # pprof 与 mDNS 广播（可选 goroutine）
    └── select { <-ctx.Done() | <-serverErr }     # 主 goroutine 阻塞；Shutdown 幂等关闭
```

对象装配要点：**配置**来自 config.yaml（默认值 → 文件 → CLI flags 覆写；env 只影响个别项如 `MANAGEMENT_PASSWORD`）；**Conductor 在 Build 期创建、Run 期装载凭据**——凭据不是配置而是运行时资产，由 watcher 增量维护；**executor 注册收口单点**（`registerAvailableExecutors`，注释明言 "Keep all Service-owned executor registration paths here"），避免配置重载时插件/原生互相覆盖；**api.Server 与 Service 解耦**——server 只持有 coreManager/accessManager 引用，配置事件经 `WithConfigReloadHook` 回调回灌 Service 形成闭环。

### 核心运行流程

以下三条链路覆盖了 CLIProxyAPI 最重要的运行模式：代理转发（数据面主链路）、凭据故障转移（调度面）、配置热重载（控制面）。OAuth 登录流是第四条重要链路，详见 [06-auth-oauth](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/06-auth-oauth)。

#### 数据面：一次流式代理请求

业务流程：客户端 POST 请求 → API key 鉴权 → 协议 Handler 解析 → 模型路由反查 provider 列表 → Conductor 选凭据 → 执行器翻译为上游 wire 格式并发送 → SSE 逐块翻译回客户端格式 → 流式写回。

![一次流式代理请求数据流](/vibe-reading/images/articles/cli-proxy-api-internals/data-flow.svg)

文字解读：数据形态经历四次变换——`gin.Context` 的原始字节（zstd 可解码）→ `Request{Model, Payload} + Options{SourceFormat, ResponseFormat, Metadata}`（handler 构造，`ReadRequestBody` in `request_body.go:16`）→ 上游 wire JSON（executor 内 `TranslateRequest`）→ `StreamResult{Headers, Chunks chan}`（executor 后台 goroutine 逐行 `TranslateStream`，`param *any` 保持跨 chunk 翻译状态机）→ `data: {...}` SSE 帧（`ForwardStream` in `stream_forwarder.go:59`）。两个关键设计：**bootstrap 重试窗口**——首个数据帧到达前不提交 SSE 头，失败可静默换凭据重试（`StreamingBootstrapRetries`），头一旦提交，错误只能写成 `event: error` 帧（SSE 半双工的不可逆边界）；**channel 流水线**——每请求 2-3 个 goroutine（executor 读上游、handler 转发拦截、gin handler 本身）以 channel 背压衔接，客户端断开经 `ctx.Done()` 逐层传播。

#### 调度面：凭据故障转移与冷却恢复

`ExecuteStream` 内外双循环：外层 retry-round（等冷却恢复后重来），内层 `executeStreamMixedOnce` 每轮 `pickNextMixed` 选凭据 → `prepareRequestAuth` → `preparedExecutionModelsWithAlias`（别名/模型池解析）→ `executor.ExecuteStream`。上游 429 时 `MarkResult` in `conductor_cooldown.go:743` 按状态码写冷却（401/403 → 30min、404 → 12h、429 → 指数退避封顶 30min 且尊重 Retry-After），`tried` map 排除已试凭据后 `continue` 换号，上限 `maxRetryCredentials`。401 有特例：先 `tryRefreshAfterUnauthorized` 刷新 token 原地重试一次，仍失败才冷却换号。请求级错误（`RequestScopedError`，如探测请求失败）不入账——任何凭据都会拒绝的错误不该烧整个池子。

#### 控制面：配置与凭据热重载

config.yaml 变更：fsnotify → 150ms debounce → SHA-256 去重 → `LoadConfig` 重读（旧值用 YAML 字节快照比对，防引用共享）→ `diff.BuildConfigChangeDetails` 打变更清单 → `reloadClients` 按影响面增量重建 → `Server.UpdateClientsContext` 逐字段应用。凭据文件变更：单文件增量合成（不做全量重扫）→ `AuthUpdate` Add/Modify/Delete 事件（按 auth ID 去重合并）→ 256 缓冲队列批量投递 → Service 定点更新。单调 revision 防止"删除复活"（慢扫描拿到的过期快照被丢弃）；Management API 改配置**故意走与文件 watch 相同的 reload 路径**，避免两套应用逻辑漂移。

### 状态流

![凭据调度状态机](/vibe-reading/images/articles/cli-proxy-api-internals/state-flow.svg)

状态枚举 `scheduledState` 定义在 `sdk/cliproxy/auth/scheduler.go:30`（Ready/Cooldown/Blocked/Disabled），写入发生在 `MarkResult` in `conductor_cooldown.go` 与 `applyAuthFailureState`（凭据级分支），恢复由调度器 `promoteExpiredLocked` in `scheduler.go:1283` 在每次 pick 时自动升级。模型级冷却（多数订阅按模型限流）与凭据级阻断（Anthropic 5h/7d 统一窗口，`Result.CredentialScope` 触发跨模型传播）双粒度分离；冷却状态独立持久化为 `.cds` 文件（`FileCooldownStateStore`），重启后仍在窗口内的冷却自动恢复——防止重启引发请求风暴打刚恢复的账号。

---

## 典型修改场景

#### 场景 1：新增一个上游 provider（executor 路线）

- 实现 `ProviderExecutor` 六方法（`sdk/cliproxy/auth/conductor.go:16`），文件族放 `internal/runtime/executor/xxx_executor{,_execute,_stream,_request}.go`；
- `baselineExecutorAuths()` in `sdk/cliproxy/service_executors.go:201` 加 provider 名 + `registerExecutorForAuth` switch 加 `case executor.NewXxxExecutor(cfg)`；
- 翻译矩阵：`internal/translator/xxx/{claude,openai,gemini}/` 每客户端方言一对翻译器 + `internal/translator/init.go` 加匿名 import；
- 模型目录：`internal/registry/models/models.json` 对应 provider 节加模型条目；
- 对应测试：`internal/runtime/executor/xxx_executor_test.go`（参考 `claude_executor_test.go` 9462 行的表驱动模式）。
- 若是普通 OpenAI 兼容上游：**零代码**——`NewOpenAICompatExecutor` + config 的 `openai-compatibility` 节配置即接入。

#### 场景 2：新增一种 wire 格式（客户端方言）

- `sdk/translator/formats.go` 加 `FormatFoo`、`internal/constant` 加常量；
- 每个现有上游目录下建 `foo/` 子目录写双向翻译（复用 `internal/translator/common/` 共享工具）；
- `internal/translator/init.go` 加匿名 import；`internal/api/server_routes.go` 加路由；`sdk/api/handlers/` 新建 `foo/` handler 包（嵌入 `BaseAPIHandler`）；
- `handlers_execution.go` 的 entryProtocol 接线。对应测试：`test/` 下加翻译保真测试（参考 `thinking_conversion_test.go`）。

#### 场景 3：新增一个管理端点（标量配置开关）

- `internal/api/handlers/management/config_basic.go` 加 `GetFoo`/`PutFoo`（复用 `updateBoolField` 自动获得持久化 + 异步 reload）；
- `registerManagementRoutes` in `internal/api/server_management.go` 注册 GET/PUT；
- `Server.UpdateClientsContext` in `internal/api/server_reload.go` 补字段级 diff 应用；
- 若该字段影响凭据调度，还需 `internal/watcher/diff/config_diff.go` 加 diff 输出 + `reloadConfig` 的 `forceAuthRefresh` 条件。
- 对应测试：`internal/api/server_test.go`（3278 行）的 reload 断言模式。

---

## 测试体系

```
*_test.go（716 个，与源码同目录）     # 单元 + 组件测试，占代码量 ~57%
test/（8 个集成测试）                # 跨包端到端：翻译保真、thinking 往返、配额故障转移、并行工具调用
examples/                           # 可执行示例：custom-provider（SDK 嵌入）、plugin/（go/c/rust 三语言插件）
```

| 代码层 | 测试类型 | 代表文件 |
|---|---|---|
| Conductor 调度/冷却 | 状态机回归 + 竞态 | `conductor_oauth_alias_nofork_test.go`（134K）、`conductor_cooldown_monotonic_test.go` |
| 执行器 | wire 级快照 + 分类表驱动 | `claude_executor_test.go`（9462 行）、`codex_websockets_executor_test.go` |
| 翻译矩阵 | 请求/响应字节保真 | `gemini_openai-responses_request_test.go`、`test/thinking_conversion_test.go`（125K） |
| 网关/Management | HTTP 层集成 | `internal/api/server_test.go`（3278 行） |
| 插件宿主 | 适配器契约 | `pluginhost/adapters_test.go`（3788 行） |

想理解某个执行器，优先读它的 `*_test.go`——错误分类表（哪个状态码触发哪种冷却）几乎都在测试里以表驱动形式穷举，是最准确的"可执行文档"。

---

## 阅读源码推荐路线

- **第一遍：主流程（半天）**
  `cmd/server/main.go` 的 `main()` → `internal/cmd/run.go` 的 `StartServiceWithPluginHost` → `sdk/cliproxy/builder.go` 的 `Build()` → `service_lifecycle.go` 的 `Run()` → `internal/api/server.go` 的 `NewServer`/`Start` → `server_routes.go` 的 `setupRoutes`——看清单端口如何同时服务三种协议。
- **第二遍：一次请求（重点）**
  `sdk/api/handlers/openai/openai_handlers.go` 的 `ChatCompletions` → `handlers_execution.go` 的 `executeWithAuthManagerFormats` → `sdk/cliproxy/auth/conductor_execution.go` 的 `Execute`/`executeStreamMixedOnce` → `internal/runtime/executor/claude_executor_stream.go` 的 `ExecuteStream` → `sdk/api/handlers/stream_forwarder.go` 的 `ForwardStream`。
- **第三遍：调度与冷却（核心难点）**
  `sdk/cliproxy/auth/types.go` 的 `Auth`/`ModelState` → `selector.go` 的 `SessionAffinitySelector.Pick` → `scheduler.go` 的 `pickMixed`/`promoteExpiredLocked` → `conductor_cooldown.go` 的 `MarkResult`（双粒度写入）→ `auto_refresh_loop.go` 的最小堆。
- **第四遍：翻译与协议保真**
  `sdk/translator/registry.go`（双层 map 注册表）→ `internal/translator/codex/claude/` 一对完整翻译器（请求 + SSE 状态机响应）→ `internal/thinking/apply.go` → `internal/cache/claude_thinking_replay_cache.go`。
- **第五遍：按兴趣选模块深入**
  插件系统从 `examples/plugin/simple/go/main.go` 对照 `internal/pluginhost/loader_unix.go` 读；伪装与对抗从 `claude_executor_cloaking.go` + `helps/utls_client.go` 读；Home 集群从 `internal/home/client.go` 读。

---

## 附录

### 术语表

| 术语 | 含义 |
|---|---|
| Conductor | `sdk/cliproxy/auth.Manager` 的社区昵称：凭据池的调度中枢 |
| Auth / 凭据 | 一个 OAuth 账号或 API key 的运行时对象（磁盘上一个 JSON 文件） |
| Executor | `ProviderExecutor` 实现：一家上游协议的翻译+发送+流解析单元 |
| 翻译矩阵 | `internal/translator/{上游}/{客户端}/` 的 N×M 格式转换器集合 |
| Cloaking | 给非原生客户端注入 Claude Code 身份特征（系统提示/UA/指纹）以维持订阅配额 |
| CCH 签名 | cache-control-hash：Anthropic 请求体的缓存控制摘要签名 |
| LCP | Longest Common Prefix：无 session 头的客户端用对话前缀 Merkle 指纹认亲做会话亲和 |
| reasoning 回放 | 把上一轮 thinking/encrypted reasoning 缓存，下轮自动注入，保 prompt cache 与签名链 |
| Home | 可选的 Redis 协议中央控制面：集群模式下凭据/配置集中分发 |
| `.cds` | cooldown state 文件：冷却状态跨重启持久化 |
| bootstrap 重试 | SSE 首帧提交前的静默换凭据重试窗口 |
| Responses steering | Codex WebSocket 双工模式：响应中途注入新输入（`docs/STEERING.md`） |

### 参考资料

- 官方文档站：[help.router-for.me](https://help.router-for.me/)（配置参考 / Management API）
- SDK 文档：`docs/sdk-usage.md`、`docs/sdk-advanced.md`（自定义 provider 与翻译器）、`docs/sdk-access.md`、`docs/sdk-watcher.md`、`docs/STEERING.md`（Codex 双工 steering 边界）
- 插件商店 registry：[CLIProxyAPI-Plugins-Store](https://github.com/router-for-me/CLIProxyAPI-Plugins-Store)
- 可执行示例：`examples/custom-provider/`（SDK 嵌入）、`examples/plugin/`（go/c/rust 三语言等价插件）
