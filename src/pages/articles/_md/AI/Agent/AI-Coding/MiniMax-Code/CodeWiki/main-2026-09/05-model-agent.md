---
source:
  type: "源码解读"
  project: "minimax-code"
  url: "https://github.com/MiniMax-AI/minimax-code"
title: "模型与 Agent 服务"
date: "2026-09-18T22:27:16+08:00"
category: [AI, Agent, "AI Coding", "MiniMax Code", CodeWiki, "main-2026-09"]
contentType: "CodeWiki"
tags: ["minimax-code", "mcode", "TypeScript", "BYOK", "模型解析", "Agent 目录"]
description: "model-system + agent 服务解读——LocalModelResolver 三源解析（managed/minimax_api/custom_provider + Codex OAuth）、内置 agent roster（mavis/explore/worker/verifier）、prompt-config 不可变快照与加密远端 bundle、llm-context-inspector 前缀对比"
readingTime: "17 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/MiniMax-Code/CodeWiki/main-2026-09/00-overview)

---

## 模块定位

`service/model-system/`（~1.95 万行）+ `service/agent/`（~1.2 万行）+ `prompt-config/` + `plan/` + `llm-context-inspector/` 合起来回答两个问题：**这次对话用哪个模型、怎么鉴权**（model-system），以及**这次对话是哪个 agent、system prompt 从哪来**（agent 服务）。这两个问题是独立演化的域——模型生态（新 provider、新 API 格式）与 agent 人格生态（新内置 agent、远端 prompt 下发）变化节奏完全不同，所以拆成两个 service 而非一个 "LLM 配置中心"。

## 模块架构

![模型解析三源](/vibe-reading/images/articles/minimax-code/model-resolution.svg)

model-system 内部按职责切分：`resolution/`（LocalModelResolver + BYOK 计划器）、`catalog/`（三源目录合并）、`management/`（provider CRUD 门面 + 按域拆分的 operations 模块）、`connectivity/`、`codex-oauth.ts`、`identity.ts`（API 格式白名单）。agent 服务是另一条线：`builtin/catalog.ts` 的 `BuiltinAgentCatalog` 读 `assets/agents/` 的文件型定义，`application/agent.service.ts` 的 `LocalAgentService`（degree 102）管 DB 行与渲染。两者在 turn-system 的 `LocalAgentPreparationService.prepareResolved`（agent-host/preparation/local-agent-preparation-service.ts:102）汇合——先 `configBuilder.buildPrepared` 组装 agentConfig（含 `IModelRef`），再 `resolveModel`。

## 调用链路

模型解析链（`LocalModelResolver.resolveModel`）：

```
selectModel → parseProviderId（resolution/model-key.ts）拆三源
  ├─ BYOK minimax_api：planMinimaxApiResolution（用户 API key，anthropic-messages，api.minimaxi.com/anthropic）
  ├─ BYOK custom_provider：planCustomProviderResolution（读 byok.custom_provider[providerKey].models[modelId]）
  │    OAuth 类 provider 产出 authProvider → resolveByokResolutionPlan 经 providerAuthGetter 取凭据
  └─ 托管 resolveManagedModel：resolveLocalProviderCredentials 判定 authMode
       （managed-login / oauth / provider_api_key，@mavis/config 的 resolveProviderAuthMode）
       MiniMax 账号注入 Bearer + managed fetch 重试；codex key 从 codex-auth.json 取
→ finishResolve：thinking 协议解析 → 组装 Pi Model<Api> → headers（OpenRouter attribution 等）
   → streamFn 包装（withByokErrorAttribution / withLocalDynamicMaxTokens）
```

Agent 选择链（`resolveAgentReadScopeRaw` 五级）：`agent:<name>` 显式 → primary family（mavis/legacy main）→ canonical subagent role → 精确/大小写不敏感名 → display name 兼容；歧义抛 `AMBIGUOUS_AGENT_NAME`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `resolveModel()` in resolution/local-model-resolver.ts | 模型解析主入口 | Plan-then-resolve 两段式 |
| `planCustomProviderResolution()` in model-resolver-byok.ts | BYOK 计划 | 纯数据计划与副作用取凭据分离 |
| `listEffectiveProviders()` in management/service.ts | provider 门面 | Facade + 四个 operations 模块 |
| `startLogin()` in codex-oauth.ts | Codex OAuth | 先写内存 AuthStorage 确认未取消才落盘 |
| `listDefinitions()` / `render()` in builtin/catalog.ts | 内置 agent 目录 | 文件型定义（PERSONA.md + .md.hbs） |
| `renderProfile()` in agent-profile.ts:168 | prompt 渲染 | persona + system + shared base 分层 |
| `capture()` in prompt-config.service.ts | prompt 目录快照 | 模型调用前定死，绝不混用远端与 builtin 片段 |

</details>

## 核心实现

### API 格式白名单与 Codex 例外

`MODEL_PROVIDER_APIS = ['anthropic-messages','openai-completions','openai-responses']`（identity.ts:27）是通用 BYOK 协议面。`openai-codex-responses` 虽被配置类型接受，但**刻意排除**在通用白名单外——其凭据/baseURL/thinking 归 Pi 专属 Codex transport 管，runtime 不得改写其 base URL 或注入 BYOK thinking patch（identity.ts:20-26 注释）。MiniMax 平台 API 固定 anthropic-messages 格式（minimax-api.ts 的 `MINIMAX_API_FORMAT`）。provider 不存在时 `fallbackBuiltinIdentity` 回退第一个内置模型。

### catalog 三源合并

内置 provider 来自 config（Pi 目录 + `MINIMAX_API_MODEL_CATALOG`）；BYOK minimax_api 与内置共享同一 catalog，仅 overlay 用户 context 选择；custom_provider 单独列出；`listLocalRuntimeModels`（catalog.ts:24）合并供 selector。远端发现结果按 ID 合并且**已保存字段优先**，发现失败永不覆盖已有配置（README.md:76-79）——用户配置不被网络抖动摧毁。

### 内置 agent：文件型定义 + DB seed

`assets/agents/builtin-agents.json` roster 驱动：`["mavis", "explore", "worker", "verifier"]`（另有 workflow/desktop-task 等目录未入 roster）。每个 agent 目录三件套：`PERSONA.md`（frontmatter：display_name/description/avatar）、`system-prompt.md.hbs`（handlebars，含 locale/mode/feature 层）、`agent.md`（capability 覆盖）。`LocalAgentService.ensureBuiltinRows`（agent.service.ts:876）自动 seed DB 行并重建 canonical 文件；非 orchestrator 角色自动获得 `prompt-base-worker` 共享层。`LocalAgentService extends AgentConfigDocuments`（Template Method，覆写写锁与校验）。

### prompt 供应链：两条独立线

内置 agent 的 persona/system 来自 packaged `.md.hbs`；**AGENTS.md 是 profile 级全局指令**，由 turn-system 的 `persistence/global-instructions.ts`（"Turn-owned access to the profile-wide AGENTS.md"）在 turn 层注入，不经 agent prompt-template——两条线刻意分离。`prompt-config` 的 `capture()` 产出不可变 `PromptReadContext`，`readPromptWithBuiltinFallback` 保证同一次请求绝不混用远端与 builtin 片段；远端 bundle 是 AES-256-GCM 加密拉取 + 校验。`llm-context-inspector` 是调试利器：按 turn/call 捕获完整 request/response JSON，核心价值在 `compareContextPrefix`——相邻两次调用的前缀对比，诊断 prompt caching 命中率与上下文膨胀。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Facade + 操作模块拆分 | `LocalModelProviderService` + `service-{candidate,connection,custom-provider,minimax}-operations.ts` | 稳定门面下按域演进 |
| Plan-then-resolve 两段式 | `ByokResolutionPlan` 与 `resolveByokResolutionPlan` | 计划纯数据可测试 |
| Composition Root | `initializeModelSystem`（唯一 ModelSystemOwner）+ `createRuntimeAgentComposition`（跨进程锁内 cutover + seed） | 避免多 owner 竞态 |
| 不可变快照 | `PromptReadContext` | 请求内 prompt 目录一致 |
| 一次性 receipt 迁移 | `LegacyAgentBootstrapImportReceipt`（composition.ts:437-476） | 防用户删除的 legacy agent 每次启动复活 |

## 模块间交互

`production-composition.ts:259/300` 把 `resolveModel` 注入 turn/queue 流程；session-system 的 title 生成（`sessions/title/title-model-completion.ts`）与 queue service 复用同一 resolver。`LocalAgentService.bindPromptConfig` 绑定 capture；`@earendil-works/pi-ai` 提供 `Api`/`Model`/`getModels` 与 provider 静态目录（`lookupLocalCatalogModel` 直接查）；pi-coding-agent 的 `AuthStorage` 被 `CodexOAuthManager` 复用。tui 的 provider UI 经 process-local capability 调 `startLogin/cancelLogin`。

## 扩展方式

- **新增内置 agent**：`assets/agents/<name>/` 放三件套 + roster 加名（详见概览场景 1）。
- **新增 provider API 格式**：`model-system/identity.ts` 的 `MODEL_PROVIDER_APIS` + `model-resolver-byok.ts` 的 `resolveCustomProviderApi` 白名单；有 thinking 协议则扩 `model-ref.ts` 的 `resolveByokThinkingApi` 与 `THINKING_FORMATS`。
- **新增 BYOK OAuth provider 类型**：`model-resolver-byok.ts` 的 `resolveCustomProviderCredentials`（kind === 'oauth' 分支）+ `service-custom-provider-operations.ts` 创建校验。
