---
source:
  type: "源码解读"
  project: "CLIProxyAPI"
  url: "https://github.com/router-for-me/CLIProxyAPI"
title: "模型注册表"
date: "2026-09-25T00:08:00+08:00"
category: ["AI", Tools, CLIProxyAPI, CodeWiki, "7.3.16"]
contentType: "CodeWiki"
tags: ["CLIProxyAPI", "Go", "模型注册表", "mDNS", "引用计数"]
description: "模型注册表：静态内嵌 models.json + 3 小时双 URL 远程刷新、模型可见性 = 引用计数 f(凭据池)、能力三态（WebSearch *bool）、配额 5 分钟自动恢复、Codex/Devin 客户端目录独立更新器、mDNS 局域网发现"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/00-overview)

---

## 模块定位

`internal/registry/`（7 个非测试文件 ~3.4k 行）+ `internal/discovery/`（mDNS，~1.3k 行）回答一个问题：**"这个代理现在有哪些模型可用？"** 它是 `/v1/models` 端点、模型路由反查（模型名 → provider → executor）、翻译参数裁剪（MaxCompletionTokens/Thinking 能力）的唯一数据源。

核心设计立场：注册表**不维护模型开关**——模型可见性是凭据池的派生属性。一个模型的"存在"由引用计数决定：有活跃凭据注册它它就在，凭据全部下线/配额超限/暂停它就自动消失。所以本模块与 Conductor（[03-conductor](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/03-conductor)）是一对生产者-消费者：Conductor 把配额与暂停状态投影进注册表，注册表据此调整可见性。

## 模块架构

```
静态目录（//go:embed models/models.json，14 节）
   │ init() 先行加载（离线可用）
   ▼
ModelRegistry（全局单例，GetGlobalRegistry → sync.Once）
   ├── models map[modelID]*ModelRegistration     # Count++/-- 引用计数
   ├── clientModels/clientModelInfos             # clientID(=authID) → 模型列表
   ├── clientEpochs/clientGenerations            # 防陈旧写入
   ├── availableModelsCache                      # 按协议 TTL 缓存（generation 失效）
   └── hook ModelRegistryHook                     # 异步广播（5s 超时 + recover）
   ▲                                    ▲
   │ RegisterClient/UnregisterClient     │ ApplyClientModelProjections
   │ （凭据加载/下线）                    │ （Conductor 配额/暂停投影，epoch CAS）
   │
远程刷新（3h ticker）：StartModelsUpdater
   ├── fetchModelsFromRemote（GitHub raw + models.router-for.me 双 URL）
   ├── validateModelsCatalog → detectChangedProviders
   └── notifyModelRefresh → 对变更 provider 的 auth 重新注册
       另两个同构独立更新器：codex_client_models / devin_models
mDNS（internal/discovery/）：_ai-gateway._tcp 广播 + 协议 subtype + TXT 记录
```

## 调用链路

四条关键链路：

```
初始化：init()（model_updater.go:68）内嵌目录加载
└── GetGlobalRegistry()（model_registry.go:206，sync.Once）
    └── cmd/server/main.go:840 startModelCatalogUpdaters
        # 按 modelCatalogUpdaterPlan（main.go:831）启动三个 updater
        # Home 模式仍刷新 codex/devin、关 models.json 刷新

远程刷新（3h）：StartModelsUpdater（model_updater.go:78）
└── runModelsUpdater：启动即拉 + ticker(3h)（modelsRefreshInterval，model_updater.go:20）
    └── tryRefreshModels（:116）
        └── fetchModelsFromRemote（:148，双 URL，30s 超时）
            └── validateModelsCatalog（:335，查空 ID/重复 ID）
                └── detectChangedProviders（:200，DeepEqual+JSON 对比）
                    └── notifyModelRefresh（:267）
                        └── registerModelRefreshCallback（sdk/cliproxy/service_plugins.go:322）
                            # 对变更 provider 的所有 auth 重新
                            # refreshModelRegistrationForAuthWithCache（service_models.go:319）

凭据动态注册：auth 加载
└── registerModelsForAuth（service_models.go:17，按 provider 取静态目录，codex 按档位）
    └── registerResolvedModelsForAuth（service_executors.go:428）
        └── RegisterClient（model_registry.go:429）
            └── addModelRegistration（:666）：Count++ + 缓存失效 + 异步 hook
注销：UnregisterClient（:820）：Count--，归零即 delete（:877）——模型从列表消失

/v1/models 读取：unifiedModelsHandler（internal/api/server_routes.go:591，按 UA 分流）
└── GetAvailableModels(handlerType)（如 openai_handlers.go:56）
    └── 双检锁读 availableModelsCache（model_registry.go:1251）
        └── buildAvailableModelsLocked（:1347）
            └── modelRegistrationAvailability（:1279）
                # effective = Count - 配额过期 - 暂停 + 双重计数修正
                └── convertModelToMap（:1649）：openai/claude/gemini 三格式投影
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|---|---|---|
| `GetGlobalRegistry` in `model_registry.go:206` | 单例入口 | `sync.Once` + hook 注入点 |
| `RegisterClient` in `model_registry.go:429` | 凭据注册其模型集 | 引用计数而非开关 |
| `UnregisterClient` in `model_registry.go:820` | 凭据下线 | Count 归零即删，模型自动消失 |
| `addModelRegistration` in `model_registry.go:666` | 单模型计数 + 缓存失效 | generation++ 清 availableModelsCache |
| `modelRegistrationAvailability` in `model_registry.go:1279` | 算有效可用性 | 配额 5min 窗口自动恢复 |
| `LookupModelInfo` in `model_registry.go:252` | 动态优先静态兜底查元数据 | 翻译层参数裁剪入口 |
| `ApplyClientModelProjections` in `model_registry.go:945` | Conductor 投影写入 | epoch/generation CAS 拒绝陈旧写入 |
| `StartModelsUpdater` in `model_updater.go:78` | 3h 远程目录刷新 | 双 URL + validate 后才替换 |
| `GetResponsesWebSearchCapability` in `model_registry.go:327` | 三态能力聚合 | 保守合并：任一 false → false |
| `BuildServiceSpec` in `discovery/service.go:148` | mDNS 服务描述 | RFC 6763/6335 合规 + 拒绝 loopback |
</details>

## 核心实现

### 静态内嵌 + 远程刷新：双层目录为什么都要

静态层 `//go:embed models/models.json`（`model_updater.go:28`，目录在 `model_definitions.go:24-38` 定义 14 节：claude/gemini/vertex/aistudio/codex 四档/kimi/antigravity/xai/devin/meta）保证**离线零配置启动**——新用户拉起进程就有模型列表；远程层从 `router-for-me/models` 仓库（双 URL：GitHub raw + `models.router-for.me` 镜像，30s 超时）3 小时刷新一次，让**新模型目录无需发版即可下发**——上游发新模型到用户可见不再等二进制更新。安全边界在 `validateModelsCatalog`（`model_updater.go:335`）：远程数据必须过校验（空 ID/重复 ID 检查）才替换本地目录，失败保留旧目录——远程仓库被污染不会击穿运行中的代理。

### 能力三态：`WebSearch *bool` 为什么不是 bool

`NativeCapabilities`（`model_registry.go:29-33`）的 `WebSearch *bool`——nil = 目录未确立。聚合函数 `ResolveResponsesWebSearchCapability`（`:278`）保守合并：任一路由已知 false → false；存在未知（nil）→ 返回 nil。Why：如果用 `bool`，"目录未收录"会被误读成"不支持"，Responses 端点就永远无法对未知模型放行原生 web search；三态让"未知"显式流动，调用方对 nil 走自己的默认策略。Codex 客户端目录侧用 `GetResponsesWebSearchCapability`（`:327`）聚合各路由能力（消费方 `internal/client/codex/models/models.go:63`）。

### 可见性 = f(凭据池)：引用计数 + 配额窗口

`ModelRegistration`（`model_registry.go:150-165`）为每个模型维护 `Count`（提供它的活跃 client 数）、`QuotaExceededClients`（配额超限 → 5 分钟窗口）、`SuspendedClients`。`/v1/models` 的最终可见性在 `modelRegistrationAvailability`（`:1279`）计算：`effective = Count - 配额未过期数 - 暂停数 + 双重计数修正`，`effectiveClients <= 0` 即隐藏（`:1318-1324`）。配额窗口（`modelQuotaExceededWindow`，`:387`）5 分钟后自动恢复 + `CleanupExpiredQuotas`（`:1770`）清扫，防止一次配额超限把模型永久藏起来。Conductor 侧经 `GetModelsAndEpochForClient` + `ApplyClientModelProjections`（`conductor_refresh.go:630/639`）把调度期观察到的配额/暂停状态投影回注册表——epoch CAS 保证陈旧投影不覆盖新状态；调度失效由 `RegistrationEpoch()`（`conductor_selection.go:133`）驱动。

### Codex/Devin 为什么需要独立更新器

`codex_client_models.json`（523KB）不是普通模型目录——它**模拟 OpenAI Codex CLI 后端 `/models` 响应**（slug/base_instructions/minimal_client_version/reasoning levels，必含默认模板 "gpt-5.5"，`codex_client_models.go:99`），是伪装 Codex 原生客户端（见 [04-executors](/vibe-reading/articles/AI/Tools/CLIProxyAPI/CodeWiki/7.3.16/04-executors)）的"剧本"之一，必须紧跟上游客户端演进——所以有独立的 `codex_client_models_updater.go:31` 独立刷新，且目录带 `revision`（`codex_client_models.go:43`）供 `optimize-multi-agent-v2` 做缓存键（`internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go:319`）。Devin 侧模型迭代快，走动态 → models.json devin 节 → 硬编码 `staticDevinModels`（`model_definitions.go:90`）**三级兜底**（`devin_models.go:36-49`）。

### mDNS：零配置发现网关

`internal/discovery/` 广播 `_ai-gateway._tcp.local.` 服务 + 协议 subtype（`discovery/types.go:12-26`）+ 不超过 400B 的 TXT 记录（`spec.go:59`：version/product/instance_id/tls/auth_required/api 路径）。`BuildServiceSpec`（`service.go:148`）严守 RFC 6763/6335 并**拒绝 loopback 地址、回退全接口广播**（`:202`）——解决的问题是：局域网内客户端（手机/别的机器）零配置发现这台代理的地址、端口、协议与是否需要鉴权。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 单例 | `GetGlobalRegistry` in `model_registry.go:202-220`；updater 各配 `sync.Once`（`model_updater.go:38`） | 进程级唯一目录 |
| Observer/Hook | `ModelRegistryHook` + `SetHook`（`model_registry.go:377`）；触发在独立 goroutine、5s 超时、panic recover（`:389-405`） | 模型集变化广播，慢消费者不拖垮注册路径 |
| generation 失效缓存 | `availableModelsCache` + generation 计数 | 读多写少的 `/v1/models` 加速 |
| epoch/generation CAS | `ApplyClientModelProjections`（`model_registry.go:945`） | 陈旧投影不覆盖新状态 |
| 防御性深拷贝 | `cloneModelInfo`（`model_registry.go:753`） | 读出副本防外部改坏目录 |

## 模块间交互

**消费方四路**：路由反查 `internal/util/provider.go:65` 用 `GetModelProviders` 反查模型可用 provider 决定 executor 选择；翻译层大量 `registry.LookupModelInfo(model, provider)`（动态优先、静态兜底，`model_registry.go:252`）读 `MaxCompletionTokens`/`Thinking` 做参数裁剪（如 `translator/claude/openai/responses/claude_openai-responses_request.go:61,112`）；`/v1/models` 三协议 handler（见调用链路）；Conductor 投影（见上）。**生产方**：Service 在凭据注册/注销时调 `RegisterClient`/`UnregisterClient`（经 `sdk/cliproxy/service_models.go`，`registerModelsForAuth`（`:17`）按 provider 档位取目录——codex 的 plan 档位在 `service_models.go:67-168`）。目录刷新回调 `SetModelRefreshCallback`（`model_updater.go:53`）是单槽设计，未注册时挂起 `pendingRefreshChanges` 补投。

## 扩展方式

**给目录加一个模型**：改 `internal/registry/models/models.json` 对应节即可，无需改代码；Codex 专属硬编码模型走 `WithCodexBuiltins`（`model_definitions.go:247`）upsert。

**新增需远程拉取模型列表的 provider** 五步：`staticModelsJSON` 加字段（`model_definitions.go:24`）→ `validateModelsCatalog` 的 requiredSections 加节（`model_updater.go:340`）→ `detectChangedProviders` sections 加行（`:211`）→ `GetStaticModelDefinitionsByChannel` 加 case（`model_definitions.go:482`）+ 新增 `GetXxxModels` accessor → `sdk/cliproxy/service_models.go` 的 `resolveModelsForAuth` 加 provider 分支。

**调整配额恢复窗口**：`modelQuotaExceededWindow`（`model_registry.go:387`）与 `CleanupExpiredQuotas`（`:1770`）。
