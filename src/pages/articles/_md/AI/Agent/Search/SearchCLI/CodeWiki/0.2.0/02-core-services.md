---
source:
  type: "源码解读"
  project: "SearchCLI"
  url: "https://github.com/volcengine/SearchCLI"
title: "核心服务层"
date: "2026-08-19T17:42:29+08:00"
category: ["AI", "Agent", "Search", "SearchCLI", "CodeWiki", "0.2.0"]
tags: ["SearchCLI", "TypeScript", "API Client", "Config", "Credential Store"]
description: "SearchCLI 核心服务层——三层 API 客户端、五级配置优先级、三后端凭证存储与六种输出格式。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/00-overview)

---

## 模块定位

核心服务层（`src/core/*.ts`，不含 `connector/` 和 `search-tuning/` 子目录，约 8800 行、33 个文件）是 SearchCLI 的基础设施底座。它对上屏蔽火山引擎 API 的签名细节、对下封装 HTTP 与凭证存储，让命令分发层和叶子命令层只面对干净的 `client.search()` / `printOutput()` 接口。它是全项目扇入最高的层——上层 35+ 个命令文件直接 import 本层模块，`output-format` 被 import 9 次、`service-config` 6 次、`openapi-client` 4 次。外部依赖刻意保持极简：仅 `@volcengine/openapi`（签名）、`zod`（schema 校验）、`jsonrepair`（LLM JSON 修复）三个。

## 模块架构

![核心服务层架构](/vibe-reading/images/articles/searchcli-internals/api-client-layers.svg)

核心服务层内部是四块职责：**API 客户端**（`http.ts` 签名引擎 + 五个上层 client）、**配置与凭证**（`user-config`/`service-config`/`config`/`credential-store`/`environment`）、**输出格式化**（`output-format`）、**schema 推断与 onboarding 编排**（`console-schema-inference`/`schema-prompt-inference`/`item-onboarding`）。这四块之间几乎不互相依赖——它们各自独立服务于上层命令，是"水平"的基础设施而非"纵向"的调用链。唯一的纵向关系是 `http.ts` 作为底层签名引擎被所有 client 依赖，`user-config` 作为配置中枢被 `service-config`/`config`/`llm-client` 依赖。

## 调用链路

以一次 `vs search run` 的 API 调用为例，从 client 到 HTTP 的链路：

1. `runSearchRunCommand` 调 `new VikingRuntimeApiClient(serviceConfig)`，`client.search(applicationId, sceneId, payload)` in `src/core/runtime-api-client.ts`。
2. `search()` 委托 `postJson(config, '/api/v1/application/{id}/search', payload)` in `src/core/http.ts`。
3. `postJson()` → `requestJson()`：构建 URL（`dataPlaneBaseUrl` + pathname），调 `buildHeaders(includeControlPlaneHeaders=false)` 优先用 `apiKey`（Bearer）其次 AK/SK 签名，发 fetch。
4. 响应解析：`extractResponseMetadataError()` 从火山引擎 `ResponseMetadata.Error` 提取逻辑错误（HTTP 200 也可能抛 `ApiRequestError`），成功则返回 `T`。

平行地，`VikingOpenApiClient.post('GetApplication', payload)` 走控制面：`translateOpenApiPath()` in `src/core/http.ts:128` 把 action 名翻译成带 `Action`/`Version`/`Region` query params 的控制面 URL，强制 AK/SK 签名并注入 `x-tt-backend` header。`VikingDataClient`/`VikingSearchClient` 则直接用 `fetch` + `buildSignedRequestHeaders()`（不委托 `postJson`），因为它们接收 `RuntimeConfig`、URL 模板内联在 class 中。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `postJson()` / `requestJson()` in `src/core/http.ts` | 数据面 HTTP | `buildHeaders` 优先 apiKey 其次 AK/SK 签名 |
| `postOpenApiJson()` / `requestOpenApiJson()` in `src/core/http.ts` | 控制面 HTTP | `translateOpenApiPath` 翻译 action 名，强制 AK/SK + `x-tt-backend` |
| `buildSignedRequestHeaders()` in `src/core/http.ts` | 公开签名 header 构建 | 供 data-client/search-client 直接复用，不走 postJson |
| `resolveCliDefaults()` in `src/core/user-config.ts:229` | 配置解析总入口 | 五级优先级：参数→环境变量→profile→全局→默认 |
| `resolveServiceConfig()` in `src/core/service-config.ts:56` | 控制面服务配置 | zod 校验 + 缺凭证抛错 |
| `printOutput()` in `src/core/output-format.ts` | 统一输出入口 | Promise→jq 过滤→formatOutput→写文件/stdout |
| `loadServiceCredentialsSync()` in `src/core/credential-store.ts` | 读 AK/SK | auto 模式 keychain 优先，其次加密文件 |

</details>

## 核心实现

### 三层 API 客户端

`http.ts`（328 行）是底层签名引擎，不是 class 而是一组纯函数，是所有 API 调用的基石。核心是 `buildHeaders()` in `src/core/http.ts:159`，按 `includeControlPlaneHeaders` flag 区分两条认证路径：数据面请求优先 `apiKey`（Bearer token）其次 AK/SK 签名；控制面请求强制 AK/SK 签名（`Signer` from `@volcengine/openapi`）并注入 `x-tt-backend`。`ApiRequestError` class in `src/core/http.ts:13` 封装 API 错误，`extractResponseMetadataError()` in `src/core/http.ts:272` 从火山引擎 OpenAPI 的 `ResponseMetadata.Error` 结构提错——即使 HTTP 200 也会抛逻辑错误。

上层五个 client 都很薄：`VikingOpenApiClient`（`src/core/openapi-client.ts`，仅 24 行）是控制面适配器，委托 `postOpenApiJson`/`requestOpenApiJson`；`VikingRuntimeApiClient`（`src/core/runtime-api-client.ts`，42 行）是数据面适配器，`search()`/`recommend()`/`chatSearch()`/`dataWrite()`/`dataList()` 等方法委托 `postJson`。**两者是平级关系，不是分层**——都直接依赖 `http.ts`，只是走不同签名路径。`VikingDataClient`（`src/core/data-client.ts`，83 行）和 `VikingSearchClient`（`src/core/search-client.ts`，131 行）则直接用 `fetch` + `buildSignedRequestHeaders()`，因为接收 `RuntimeConfig`（含 applicationId/datasetId/sceneId）、URL 内联在 class 中。`requestChatCompletion()` in `src/core/llm-client.ts`（200 行）调 OpenAI 兼容 chat API，用 `jsonrepair` 修复 LLM 返回的不完整 JSON。

> 为什么 `openapi-client` 和 `runtime-api-client` 分两层？根本原因是火山引擎有**两套 API 面**：控制面（管理操作，走 `controlPlaneBaseUrl`，URL 带 `Action`/`Version`/`Region` query，必须 AK/SK 签名）与数据面（运行时操作，走 `dataPlaneBaseUrl`，支持 API Key 或 AK/SK）。`http.ts` 的 `translateOpenApiPath()` 是两面分化的关键：pathname 是纯 action 名（如 `GetApplication`）时翻译成控制面 URL，否则视为数据面路径直接拼接。两个 class 不是冗余，而是面向不同调用者的清晰边界。

### 配置与凭证管理

`user-config.ts`（569 行）是全局 CLI 配置中枢，配置文件在 `~/.viking/config.json`。核心函数 `resolveCliDefaults(input)` in `src/core/user-config.ts:229` 是配置解析**总入口**，被 `config.ts`/`service-config.ts`/`llm-client.ts` 调用。**配置来源五级优先级**（从高到低）：函数参数（命令行 flag）→ 环境变量（`VIKING_*`）→ profile 配置（`profiles[activeProfile]`）→ 全局存储配置（`config.json` 顶层）→ 硬编码默认值（`DEFAULT_SERVICE='aisearch'`、`DEFAULT_TIMEOUT_MS=15000` 等）。`authSource` 字段（`src/core/user-config.ts:264`）追踪认证来源（`'api-key'|'flag'|'env'|'secure-store'|'none'`）供安全审计。`service-config.ts`（97 行）和 `config.ts`（112 行）是面向控制面/运行时的薄封装，都调 `resolveCliDefaults()` 取默认值再 zod 校验——`service-config` 缺凭证时抛 `formatMissingVikingAuthMessage()` 错。`environment.ts`（173 行）内置三个环境（火山北京/新加坡、BytePlus 新加坡），`resolveEndpointsOrThrow()` 从 baseUrl 推断 control/data plane URL。

`credential-store.ts`（642 行）支持三种凭证存储后端：**macOS Keychain**（`spawnSync('security', ...)`）、**AES-256-GCM 加密文件**（`~/.viking/credentials.json.enc`，主密钥 `~/.viking/credentials.key`，权限 `0o600`/目录 `0o700`）、**内存临时存储**（进程内 `Map`，退出即失）。`auto` 模式 macOS 优先 keychain。两套独立凭证体系：Service AK/SK（keychain service `viking-cli`）与 LLM API Key（`viking-cli-llm`），因为火山搜索 AK/SK 和方舟 LLM API Key 可能属不同 IAM 账号。加密文件格式 `{ version: 1, algorithm: 'aes-256-gcm', iv, tag, ciphertext }`，主密钥首次自动生成 32 字节随机。`feature-flags.ts`（14 行）极简：`VIKING_ENABLE_PROJECT=1` 启用 `project` 命令组，未启用时 `requireProjectFeatureEnabled()` 抛 "Unknown command" 使其对外不可见。

### 输出格式化

`output-format.ts`（582 行）支持 6 种格式：`json`/`table`/`yaml`/`pretty`/`ndjson`/`csv`。`printOutput(value, argv)` 是统一输出入口：`Promise.resolve(value)` → 可选 jq 过滤 → `formatOutput()` 渲染 → 写文件或 stdout。`formatOutput()` 是策略模式 switch 分发器，每个 case 对应一个格式化策略函数。关键设计：`pretty` 是智能格式——先检测 `ItemApplyDryRunSummary`（特殊 checklist 渲染），否则 `extractPrimaryCollection()` in `src/core/output-format.ts:437` 从 API 响应信封自动提取主集合（检查 `items`/`entries`/`Applications` 等 14 个候选 key），扁平记录渲染 key-value 表，嵌套对象降级为 YAML。`applyBasicJqSelector()` in `src/core/output-format.ts:459` 实现简化版 jq（仅点号属性访问 + 数组展开），不引入完整 jq 依赖。表格渲染 `renderTable()` 和 CSV 转义 `csvEscape()` 全手写，零第三方依赖。

### Schema 推断与 onboarding 编排

两条 schema 推断路径：**Console API 推断** `inferSchemaArtifactsWithConsole()` in `src/core/console-schema-inference.ts`（上传数据到 TOS → 调 `AddInferDatasetSchemaTaskV2` 创建任务 → 轮询 `GetInferDatasetSchemaResultV2`）；**LLM Prompt 推断** `inferSchemaMetadataWithPrompt()` in `src/core/schema-prompt-inference.ts`（1049 行，采样数据 → 调 `requestChatCompletion()` 让 LLM 推断字段语义）。`item-onboarding.ts`（2031 行，核心层最大文件）是数据 onboarding 编排层，同时使用两条路径：数据验证 → schema 推断（console + LLM 双路）→ 人工确认 → 数据集/应用创建/绑定 → 配置更新。`infer-schema-confirm.ts`（362 行）提供 onboarding 中的人工审核逻辑。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器 (Adapter) | `VikingOpenApiClient`/`VikingRuntimeApiClient` | 把火山引擎签名逻辑适配为简单 `post()`/`search()` 接口，上层不感知签名 |
| 外观 (Facade) | `resolveCliDefaults()`/`printOutput()`/`resolveServiceConfig()` | 封装多级优先级/多步骤流程为一个调用，简化上层 |
| 策略 (Strategy) | `formatOutput()` in `src/core/output-format.ts` | switch 分发到 6 个格式化策略，新增格式只加 case |
| 工厂 | `buildHeaders()` in `src/core/http.ts` | 按请求类型（数据面/控制面）和认证方式创建不同 headers |
| 模板方法 | `credential-store.ts` 的 load/save/delete | 按 `preferredMode` 分发到 keychain/file/ephemeral，`auto` 有 fallback 链 |

## 模块间交互

核心服务层是被大量依赖的底座：上层 `app/*-commands.ts` 和 `commands/*.ts` 几乎每个命令都 import `output-format` 做输出、import `service-config` 做配置解析。内部依赖关系：`http.ts` 是底层，被五个 client import；`user-config.ts` 是配置中枢，被 `config`/`service-config`/`llm-client` import；`credential-store.ts` 被 `user-config` import 读取安全存储凭证；`environment.ts` 被 `user-config` import 解析端点；`types.ts` 纯类型定义被大量模块 import；`node-bootstrap.ts` 被两入口副作用 import 装环境 shim；`auth-errors.ts` 被 `http`/`data-client`/`search-client` import 提供友好认证错误。connector 和 search-tuning 子系统也依赖本层的 `runtime-api-client`/`service-config`/`llm-client`。无循环依赖。

## 扩展方式

新增一个控制面 API 调用（如 `CreateDataset`）：仅调用方文件改，`const client = new VikingOpenApiClient(config); await client.post('CreateDataset', {...})`——core 层无需改，这是薄适配器的好处。新增一种输出格式（如 `--markdown`）：仅 `output-format.ts` 改——`OutputFormat` 类型加值、`OUTPUT_FORMATS` 加项、`formatOutput()` switch 加 case、实现 `formatAsMarkdown()`。新增一个数据面端点：在 `runtime-api-client.ts` 加方法 `dataBatchWrite(datasetId, payload) { return postJson(this.config, '/api/v1/dataset/'+datasetId+'/batch_write', payload); }`；若需自定义签名则参考 `VikingDataClient` 模式新建 class 直接用 `buildSignedRequestHeaders()`。
