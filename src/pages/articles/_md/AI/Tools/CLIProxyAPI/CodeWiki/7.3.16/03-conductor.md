---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "凭据调度 Conductor"
date: "2026-09-24T16:16:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "负载均衡", "熔断降权", "OAuth"]
description: "Conductor 凭据调度：双轨选择（authScheduler 镜像 fast path + legacy 兜底）、双粒度 cooldown（模型级/凭据级 5h/7d）、会话亲和与 LCP 指纹、指数退避、.cds 跨重启持久化、最小堆刷新循环"
readingTime: "28 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`sdk/cliproxy/auth/` 是全项目最核心的运行时模块（~34k 行生产代码）：**凭据池的全部调度决策单点收口**——选择（谁上）、降权（谁歇）、恢复（谁回来）、刷新（token 谁来换）、重试（失败怎么办）。`Manager`（社区昵称 Conductor）同时承担四重角色：executor 注册表、凭据真源（auths map）、调度入口、结果回写。handler 层只调 `Execute/ExecuteStream/ExecuteCount` 三个入口，不感知任何凭据细节；executor 无状态，一切凭据判断都在这里。

为什么独立：凭据是**带状态的运行时资产**（quota 水位、冷却 deadline、刷新定时器、会话绑定），这些状态横跨请求生命周期且被 watcher/Management/刷新循环三方写入，必须有单一所有者。执行器如果各自管凭据，会立刻在"429 该冷多久""401 该不该换号"这类判断上分裂。

## 模块架构

```
Manager（conductor.go:139）
   ├── store / cooldownStore            # 凭据持久化 + 冷却状态独立持久化（.cds）
   ├── executors map{provider→ProviderExecutor}   # 执行器注册表
   ├── selector Selector                # 用户配置的顶层策略（RR/WRR/FillFirst/SessionAffinity）
   ├── scheduler *authScheduler         # auths 的增量只读镜像（fast path）
   ├── pluginScheduler                  # 插件调度器，先于原生选择运行
   ├── hook Hook / ResultPolicy         # OnAuthRegistered/OnResult 观察者
   ├── refreshLoop（最小堆）             # OAuth 定时刷新
   └── auths map{authID→*Auth}          # 凭据真源
          └── Auth{Attributes, Metadata, Quota, ModelStates{model→冷却}, Generation}

authScheduler（scheduler.go:45，镜像）
   ├── providers → providerScheduler → modelScheduler（一个 (provider,model) 分片）
   │       └── priorityOrder + readyByPriority{优先级→ready桶} + blocked cooldownQueue
   ├── mixedCursors / smoothWeightedState     # 跨 provider 轮询游标
   └── scheduledState: Ready / Cooldown / Blocked / Disabled
```

镜像与真源的关系是本模块最重要的架构：`authScheduler` 是 `m.auths` 的**增量只读镜像**，把"哪些凭据 ready、按什么优先级分桶、cooldown 何时到期"预计算好，pick 时免锁免过滤；真源仍由 `syncScheduler`（`conductor_selection.go:136`，以 `structuralEpoch + registry epoch` 为同步版本号）增量喂给它。两轨并存的原因见下文。

## 调用链路

一次 `ExecuteStream`（`conductor_execution.go:234`）的完整调度链：

```
ExecuteStream
├── HomeEnabled？ → executeHome（Home 控制面选凭据，本地只回写结果）
├── 外层 retry-round 循环（每轮新建 roundAttempted 集合，塞进 opts.Metadata）
│   └── executeStreamMixedOnce（内层凭据故障转移循环）
│       ├── pickNextMixed（conductor_selection.go:2143）
│       │   ├── 有 pluginScheduler / 自定义 selector → legacy path
│       │   │     pickNextMixedLegacy: m.mu.RLock 克隆候选 → 过滤（Disabled/已试/无 executor/
│       │   │       不支持模型/cooldown——isAuthBlockedForModel in selector.go:823）
│       │   │     → 插件优先 → selector.Pick（会话亲和在此介入）
│       │   └── 内置 selector 且无插件 → fast path：m.scheduler.pickMixed（scheduler.go:445）
│       │         promoteExpired → 最高优先级 ready 桶 → 按策略 pick
│       ├── preparedExecutionModelsWithAlias（conductor_models.go:326）  # 别名/模型池
│       ├── prepareRequestAuth（RequestAuthPreparer，如 Codex 现签 token）
│       ├── applyRequestAfterAuthInterceptor    # 插件可改写/终止
│       ├── executor.ExecuteStream             # 真正打上游
│       │   └── 401 → tryRefreshAfterUnauthorized → 刷新后原地重试一次
│       └── MarkResult（成功/失败都回写）→ 失败 continue 换号 / CredentialScope break
└── 外层判定 shouldRetryAfterErrorWithAttempted → waitForCooldown（带抖动等待）后重来
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `Execute`/`ExecuteStream` in `conductor_execution.go:121/234` | 执行入口，双层重试编排 | Home/本地双分支 |
| `executeMixedOnce` in `conductor_execution.go:465` | 内层换号循环 | `tried` 集合排除 |
| `pickNextMixed` in `conductor_selection.go:2143` | 选凭据三分派 | fast path/legacy/Home |
| `useSchedulerFastPath` in `conductor_selection.go:1626` | 判定能否走镜像 | 内置三种 selector 且无插件 |
| `pickMixed` in `scheduler.go:445` | 镜像内 pick | 优先级桶 + 游标保留 |
| `promoteExpiredLocked` in `scheduler.go:1283` | 冷却到期自动复活 | 惰性升级，无定时器 |
| `MarkResult` in `conductor_cooldown.go:743` | 结果回写冷却 | 模型级/凭据级双分支，单调只延长 |
| `tryRefreshAfterUnauthorized` in `conductor_refresh.go:474` | 401 兜底刷新 | `didRefreshOnUnauthorized` 防循环 |
| `SessionAffinitySelector.Pick` in `selector.go:973` | 会话亲和选择 | 三级绑定优先于 priority |
| `StartAutoRefresh` in `conductor_refresh.go:44` | 刷新循环 | 最小堆 + worker 池 |
| `RegisterExecutor` in `conductor_lifecycle.go:34` | 执行器注册 | 单点收口 |
| `PersistCooldownStates`/`RestoreCooldownStates` in `conductor_cooldown.go:218/299` | 冷却持久化 | 每凭据一个 .cds 文件 |
</details>

## 核心实现

### 双轨选择：镜像 fast path 与 legacy 兜底

legacy path（`pickNextMixedLegacy` in `conductor_selection.go:2030`）每次选择都要 `m.mu.RLock` 克隆全部 Auth 再过滤，O(N) 且持锁；fast path 用 `authScheduler` 把 ready/blocked/优先级预计算成 `readyByPriority` 桶，pick 变成桶内 O(候选)。但插件调度器和自定义 selector 需要**看到完整候选列表**做自己的判断，所以 legacy path 作为语义完备的兜底保留（`useSchedulerFastPath` in `conductor_selection.go:1626` 判定）。两轨共存要求轮询语义一致——大量游标保留逻辑（`snapshotReadyViewCursors` in `scheduler.go:116`）保证 fast path 换轨/回轨时轮转位置不重置。镜像同步用 `structuralEpoch` + `auth.Generation` + 移除墓碑（`RecordRemovalTombstone` in `scheduler.go:330`）防陈旧快照回流。

### RoundRobin 按"身份"续转，而非计数器下标

`RoundRobinSelector.Pick` in `selector.go:614` 记录的是**上次选中的 auth 身份**（`successorIndex` 二分查找后继），不是数值下标。Why：重试排除和 cooldown 会动态收缩候选切片，数值下标在切片收缩时会静默重置轮转——造成部分凭据饿死、另一些被连续轰炸。按 lastID 找后继在集合任意变化时依然公平。

### 会话亲和：解决 prompt cache 失效

LLM 订阅的 prompt cache 按凭据（账号）绑定——同一会话轮换凭据，几百 K token 的前缀缓存全部作废。`SessionAffinitySelector.Pick` in `selector.go:973` 三级绑定：显式 harness session ID（Claude Code 的 `session_id`）→ **LCP Merkle 前缀指纹匹配**（`pickLCP` in `selector.go:1114`：对不带 session 头的客户端，用对话内容最长公共前缀哈希"认亲"）→ fallback selector。绑定优先于 priority（"已绑定的可用凭据即使低优先级也不换"）；失败解绑有节制——`OnResult` in `selector.go:1458` 只在"该凭据健康性失败"时 CAS 解绑（`CompareAndDelete` in `session_cache.go:331`），请求级错误不解绑。

### 双粒度 cooldown 与单调性

状态载体不是独立结构，而是 `Auth.NextRetryAfter`（凭据级）与 `ModelState.NextRetryAfter + Quota`（模型级），`MarkResult` in `conductor_cooldown.go:743` 按错误类型分层写入：

| 错误 | 冷却 | 说明 |
|---|---|---|
| 401/402/403 | 30min（`disable_cooling` 可清零） | 先尝试刷新再冷却 |
| 404 / 模型不支持 | 12h | 该模型在这条凭据上长期不可用 |
| 429 quota | 指数退避 1s×2^level，封顶 30min | 尊重上游 Retry-After；窗口内重复失败复用同一窗口不升级（防并发请求集体爬梯） |
| 408/5xx/Cloudflare 520-526 | 1min 起步 | Cloudflare challenge 独立退避 |
| invalid_grant | 30min | 刷新失败 |

两条铁律：**单调性**——"后到的失败只延长仍存活的 cooldown，绝不缩短"（`MarkResult` 965-967 行、`applyAuthFailureState` 2271-2275 行，配套 `conductor_cooldown_monotonic_test.go`）；**请求级错误不入账**——`RequestScopedError`（探测请求失败、fast-mode 无 credits 的 429）不冷却任何凭据，`shouldSkipCredentialCooldown` in `conductor_cooldown.go:1506` 拦截，防一次坏请求把整个池子打入冷却。

**5h/7d 统一窗口**是凭据级的特例：Anthropic 的 `Anthropic-Ratelimit-Unified-5h-Status/7d-Status == "rejected"` 头（`ClaudeHeadersIndicateUnifiedRateLimitRejection` in `helps/claude_ratelimit.go:24`）表示账号级窗口耗尽，`Result.CredentialScope=true` → `MarkResult` 909-944 行把冷却**传播到该凭据所有 ModelStates** 并打 `auth.Quota.Reason="credential_quota"`、`auth.Unavailable=true`。多数订阅按模型限流（模型级不连坐），而 5h/7d 是账号级——这就是双粒度存在的理由。状态机全景见概览「状态流」。

**持久化**：冷却状态独立于 token 文件存 `.cds` JSON（`FileCooldownStateStore` in `cooldown_state.go:59`），`RestoreCooldownStates` 重启后把仍在窗口内的冷却灌回——否则重启会引发请求风暴打刚恢复的账号。Why 独立文件：token 文件属"身份"（登录流写入），冷却属"运行时健康"，混写会让 watcher 误判凭据变化。

### 模型别名与 force mapping

`preparedExecutionModelsWithAlias` in `conductor_models.go:326` 解析 `oauth-model-alias` 配置：别名 → 上游真实模型，支持**模型池**（一个别名映射多个真实模型逐个试）。这是"对外暴露稳定模型名、对内映射到不同账号档位"的机制（`oauth_model_alias.go`）。执行失败时按池顺序降级尝试。

### 自动刷新循环：最小堆 + per-auth 锁

`authAutoRefreshLoop` in `auto_refresh_loop.go:19` 用最小堆调度每个凭据的下一次刷新时间：`nextRefreshCheckAt`（`auto_refresh_loop.go:356`）综合每 provider 的 `RefreshLead`（`RegisterRefreshLeadProvider` in `types.go:665`，如 Claude 提前 4 小时，插件可注入）、JWT exp、上次刷新时间入堆；到期经 `markRefreshPending` 去重后交给 worker 池（`refreshWorkers` in `conductor_refresh.go:656`，按凭据数伸缩）。`maxRefreshTimerWait=30s` 封顶——为 Linux suspend 后 CLOCK_MONOTONIC 停摆兜底。刷新完 `UpdateRefreshedAuth` in `conductor_lifecycle.go:151` 原子合入并持久化。并发防护用 per-key 单飞锁：`refreshLocks`/`persistLocks`/`requestPrepareLocks` 三个 `sync.Map`，按 authID 串行化"401 恢复刷新"与"定时刷新"的竞争。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 策略 | `Selector` 四实现 in `selector.go`，`SetSelector` 运行期热换 | 调度偏好按配置切换 |
| 状态镜像/双轨 | `authScheduler` + `useSchedulerFastPath` | 性能与语义完备的权衡 |
| 注册表 | `executors map` + `RegisterRefreshLeadProvider` | executor 与刷新提前量都按 provider 注册 |
| 装饰器 | `SessionAffinitySelector` 包装任意 fallback | 亲和可叠加在任何策略上 |
| 观察者 | `Hook`（OnAuthRegistered/OnAuthUpdated/OnResult）in `conductor.go:98` | usage 统计/Service/面板订阅凭据事件 |
| 最小堆调度 | `authAutoRefreshLoop` in `auto_refresh_loop.go` | O(log n) 插入，到期驱动免轮询 |
| 鸭子类型错误分类 | `IsCredentialScoped()`/`IsRequestScoped()` 探测 | executor 定义语义，conductor 消费，解耦分类与回写 |

## 模块间交互

- **executor**：实现 `ProviderExecutor`（接口在本包定义，依赖倒置），按 `Identifier()` 定位；错误语义经 `Result{CredentialScope, RetryAfter, ...}`（`conductor.go:50` 起）与鸭子接口传入。
- **handler**：唯一调用方，`Options.Metadata` 是带外总线（pinned auth、tried 集合、session key、home retry round 全塞这里，40+ key 常量在 `sdk/cliproxy/executor/types.go:12-87`）。
- **registry**：`RegistrationEpoch` 感知外部模型注册变化触发镜像重同步；`canonicalModelKey` 剥 thinking 后缀后查能力。
- **internal/home**：`PublishHomeDispatch` in `conductor_home.go:39` 原子发布 `homeAuthDispatcher + executionregistry.Registry` bundle；启用后 `pickNextViaHome` 取代本地选择。
- **插件**：`pluginScheduler` 在原生选择**之前**运行；插件刷新能力经 `NewPluginRefreshCompatExecutor` 装饰注入。
- **Management**：`PutRequestRetry` 等经 `SetRetryConfig` 热更新重试参数；`ResetQuota` 清冷却状态。

## 扩展方式

**新增调度策略**：实现 `Selector.Pick`；在 `schedulerStrategy` in `scheduler.go:167` 与 `builtinSchedulerStrategy` 注册映射（否则 fast path 退化 legacy，功能正确但损失性能）；`newRoutingSelector` in `service_config.go:65` 加配置解析；`isBuiltInSelector` 更新判定。

**新增 cooldown 信号**：executor 侧定义带 `IsCredentialScoped()`/`IsRequestScoped()` 的错误类型（参照 `claudeRateLimitError` in `claude_executor_request.go:626`），纯消息匹配则在 `conductor_cooldown.go` 加 `isXxxResultError`（参照 `isCloudflareChallengeResultError:1849`）；`MarkResult` 的模型级与凭据级**两处**分支加写入；`cooldownReason` 补文案。调度侧过滤自动生效，无需改动。

**接入新 OAuth provider**：实现 `ProviderExecutor` 全六方法 + `RegisterRefreshLeadProvider` 声明提前量，冷却/轮询/亲和/刷新全部自动获得——这是契约设计的直接红利。
