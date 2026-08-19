---
source:
  type: "源码解读"
  project: "SearchCLI"
  url: "https://github.com/volcengine/SearchCLI"
title: "Overview"
date: "2026-08-19T17:42:29+08:00"
category: ["AI", "Agent", "Search", "SearchCLI", "CodeWiki", "0.2.0"]
tags: ["SearchCLI", "TypeScript", "CLI", "AI Search", "Volcengine", "oclif"]
description: "火山引擎 AI Search 的开源 CLI 与可安装 Viking skills——为 agent 与业务系统提供稳定、可调、可审查的搜索/推荐/对话检索接入与调优能力。"
readingTime: "28 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **版本** v0.2.0 · **协议** Apache-2.0 · **语言** TypeScript (Node.js ≥ 20) · **代码量** ~32,100 行 · **仓库** [GitHub](https://github.com/volcengine/SearchCLI)

---

## 总览

### 项目简介

**SearchCLI** 是火山引擎（Volcengine）AI Search 产品的开源命令行界面，对应的 npm 包名为 `viking-cli`，可执行文件为 `vs`。它的定位不是"又一个搜索 SDK"，而是**把生产级搜索、推荐、对话检索能力以稳定、可调、可审查的方式接入到 agent 系统和业务系统**的工程化路径。

具体来说，SearchCLI 解决三类问题：

- **能力接入**：外部 agent 需要上架数据、创建应用、绑定数据集、配置检索场景、运行搜索/推荐/对话，这些操作在火山引擎控制台是图形化的、不可复现的；SearchCLI 把它们变成可脚本化、可 review 的命令。
- **质量调优**：检索系统上线后"搜得准不准"是长期痛点；SearchCLI 内置一套完整的搜索调优流水线（生成测试 query → 执行检索 → LLM 相关性判定 → 计算指标 → 生成调优策略 → 应用到场景），让检索质量可量化、可迭代。
- **数据上车**：结构化业务数据要从 MySQL/MongoDB/Redis/文件流式同步到 AI Search；SearchCLI 的数据连接器子系统提供断点续传的管道。

**项目边界**：SearchCLI 是客户端侧的 CLI 与工作流层，**本身不实现检索引擎**——真正的检索、排序、向量计算都在火山引擎 AI Search 服务端。CLI 负责"把请求安全地送上去、把结果结构化地带回来、把过程留痕可审查"。

核心使用场景：开发者把搜索能力集成进业务系统、团队构建需要稳定检索工作流的 agent 系统、运营/方案团队在投产前可审查地接入数据与验证运行时行为。

### 功能矩阵

SearchCLI 的能力按命令组组织，每组对应一个业务域：

| 命令组 | 实现目录 | 职责 |
| --- | --- | --- |
| `vs auth` / `vs llm` / `vs doctor` | `src/commands/auth/`、`src/commands/llm/`、`src/commands/doctor.ts` | 平台认证、LLM 凭证、环境体检（CORE 域） |
| `vs skill` | `src/commands/skill/`、`src/skills/` | 可安装 Viking skills 的 init/install/list/validate |
| `vs item` | `src/commands/item/`、`src/core/item-onboarding.ts` | 结构化物品上车（profile/plan/apply，V1 已隐藏，V2 走 dataset 路径） |
| `vs app` | `src/commands/app/` | 应用管理（create/绑定数据集/在线配置/wait-ready 体检） |
| `vs dataset` / `vs data` | `src/commands/dataset/`、`src/commands/data/` | 数据集与数据写入（schema 推断/ingest/write） |
| `vs search` | `src/commands/search/` | 搜索运行时与场景（run/scene CRUD/tune 子流水线） |
| `vs recommend` | `src/commands/recommend/` | 推荐运行时与场景 |
| `vs chat` | `src/commands/chat/run.ts` | 对话式检索 |
| `vs connector` | `src/commands/connector/`、`src/core/connector/` | 数据连接器（init/run/status/stop/export） |
| `vs project` | `src/commands/project/`、`src/project/` | 前端 Web 项目生成与部署 |
| `vs search tune` | `src/commands/search/tune/`、`src/core/search-tuning/` | 检索质量评估与调优全流水线 |

### 技术栈

| 依赖 | 类型 | 用途 |
| --- | --- | --- |
| `@oclif/core` | 核心 | CLI 框架，提供 Command 基类、flag 解析、help 生成（dev 模式用） |
| `@volcengine/openapi` | 核心 | 火山引擎 OpenAPI SDK，`openapi-client.ts` 封装的底层 |
| `zod` | 核心 | 运行时 schema 校验，贯穿命令参数与 API 请求体 |
| `csv-parse` | 数据接入 | CSV 流式解析，连接器与数据导入 |
| `jsonrepair` | 容错 | 修复 LLM 输出的非法 JSON，judge 阶段用 |
| `mysql2` | 连接器源 | MySQL 数据源抽取 |
| `mongodb` | 连接器源 | MongoDB 数据源抽取 |
| `redis` | 连接器源 | Redis Stream 数据源抽取 |
| `esbuild` / `tsx` | 构建 | TS→JS 编译与 dev 直跑 |
| `@yao-pkg/pkg` | 打包 | 打成 standalone 二进制（`bin/run.js` → `dist/standalone.js`） |

### 版本历史

v0.2.0 是当前主线版本，处于快速演进期。一个关键脉络是**物品上车的 V1→V2 迁移**：V1 的 `vs item profile/plan/apply` 基于"计划目录"的 plan/apply 模式（仍保留但已从 help 隐藏），V2 改走 `vs dataset import-url → infer-schema → infer-result → dataset create → vs data write → vs app attach-dataset` 的显式步骤，把 schema 推断结果作为可复用 artifact 落盘。同期 `search tune` 流水线引入 `SearchSceneV2` 与 `RelevanceCutoffConfig`，支持按场景调参。本文基于 `main` 分支 HEAD（v0.2.0）解读。

---

## 快速上手

> 以下是最简路径，完整安装见 [install-guide](https://github.com/volcengine/SearchCLI/blob/main/docs/install-guide.md)。

```bash title="install.sh"
git clone git@github.com:volcengine/SearchCLI.git vs
cd vs
bash ./scripts/install.sh          # 构建 dist/ 并安装 vs 到 PATH
```

认证（二选一）：已环境变量就绪用 `import-env`，否则交互登录：

```bash title="auth"
vs auth import-env                 # 从 VIKING_AK / VIKING_SK 导入
# 或
vs auth login                      # 交互式（需真实终端）
vs auth status --json              # 验证凭证
vs doctor --json                   # 环境体检
```

端到端验证——跑一次搜索（前提：已有 application 与 search scene）：

```bash title="vs search run"
vs search run \
  --application-id 123 \
  --scene-id default-search \
  --query "wireless headphones" \
  --format json
```

预期输出：一段 JSON，包含 `Items`、`Total`、检索召回结果。`--format json` 是 SearchCLI 的"机器可读"约定，agent 与脚本一律用它；`--pretty` 则给人看。看到结构化返回即说明 CLI 已正确装配凭证、定位到 AI Search 服务端并完成往返。

调优流水线验证（可选，需先 `vs llm login` 配置 LLM）：

```bash title="vs search tune"
vs search tune llm-check --live --json   # 确认 LLM 可用
vs search tune plan --application-id 123  # 干跑规划（不调服务）
```

---

## 代码目录

```text
SearchCLI/
├── bin/
│   └── run.js                  # 生产入口：require('../dist/standalone.js')
├── src/
│   ├── index.ts                # dev 入口：@oclif/core run（命令自动发现）
│   ├── standalone.ts           # 生产入口：三域分发器
│   ├── version.ts               # VERSION = '0.2.0'
│   ├── app/                     # 命令分发层（~11.8k 行）
│   │   ├── platform-commands.ts # 平台域：auth/llm/doctor/skill/project/purchase
│   │   ├── product-commands.ts  # 产品域：app/data/dataset/search/recommend/chat/item/connector…（5945 行）
│   │   ├── skill-commands.ts    # skill 域
│   │   ├── shortcut-commands.ts # 快捷命令别名
│   │   ├── item-commands.ts     # V1 item plan/apply 工作流
│   │   ├── connector-commands.ts
│   │   ├── search-tuning-commands.ts
│   │   ├── project-commands.ts
│   │   └── workflow-commands.ts
│   ├── commands/                # 命令实现层（102 个 oclif Command 文件，~4.9k 行）
│   │   ├── auth/ llm/ skill/ doctor.ts
│   │   ├── app/ dataset/ data/ dict/ item/
│   │   ├── search/{run.ts,scene/,tune/}
│   │   ├── recommend/ chat/ connector/
│   │   ├── project/ purchase/
│   │   └── …
│   ├── core/                    # 核心服务层（~14.2k 行）
│   │   ├── openapi-client.ts    # 火山引擎 OpenAPI 封装
│   │   ├── runtime-api-client.ts # 运行时 API（search/recommend/chat）
│   │   ├── data-client.ts search-client.ts llm-client.ts
│   │   ├── config.ts service-config.ts user-config.ts credential-store.ts
│   │   ├── output-format.ts files.ts feature-flags.ts
│   │   ├── connector/           # 数据连接器子模块（~1.6k 行）
│   │   └── search-tuning/       # 搜索调优子模块（~3.7k 行）
│   ├── command-support/service-flags.ts   # 服务标志位（高扇入）
│   ├── skills/                  # 内嵌 repo skills 清单（打包进产物）
│   └── project/embedded-project-template.ts # 内嵌前端项目模板
├── skills/                      # 可安装 Viking skills（SKILL.md，给外部 agent 用）
├── scripts/                     # 构建/打包/验收/安装脚本
├── templates/project-web/       # `vs project create` 生成的 Web 项目骨架
├── docs/                        # COMMANDS.md / install-guide / agent-quick-start
└── examples/                    # field-catalog.json / eval-set.json 示例
```

一级目录职责：`bin/`+`src/*.ts` 是入口与版本；`src/app/` 是命令分发层；`src/commands/` 是叶子命令实现；`src/core/` 是核心服务与两个子系统（connector、search-tuning）；`skills/` 是给外部 agent 安装的 Viking skills（markdown 形态，非 TS）；`scripts/` 是维护者构建/验收工具链；`templates/` 是 `vs project create` 的前端模板源。`src/core/` 的两个子目录是独立模块，详见各自模块文档。

---

## 架构设计解析

### 系统架构

![SearchCLI 分层架构](/vibe-reading/images/articles/searchcli-internals/architecture.svg)

SearchCLI 的整体架构思想是**"客户端薄壳 + 分层隔离"**——CLI 本身不实现检索引擎，而是把请求安全地送上去、把结果结构化地带回来、把过程留痕可审查。为此它分了五层，自上而下依赖单向向下：

| 架构层 | 包含目录 | 层职责（为什么这层存在） |
| --- | --- | --- |
| 入口层 | `bin/`、`src/standalone.ts`、`src/index.ts` | 隔离"怎么进来"——双入口（standalone 生产 / oclif 开发）共享同一套业务逻辑，支持打包成单文件 binary |
| 命令分发层 | `src/app/*-commands.ts` | 隔离"路由到哪里"——三域分发（platform/product/skill），把 argv 映射到具体命令实现，避免运行时动态模块加载 |
| 命令实现层 | `src/commands/**/*.ts` | 隔离"参数怎么定义"——oclif Command 类只做 flag 定义/解析/委托，刻意做薄，业务逻辑下沉 |
| 核心服务层 | `src/core/*.ts` | 承载"怎么调火山引擎"——API 客户端/配置/凭证/输出，对上屏蔽签名细节，是全项目扇入最高的底座 |
| 子系统层 | `src/core/connector/`、`src/core/search-tuning/` | 解决两个独立复杂问题——数据上车管道与检索质量调优，各自自洽（Source/Runner/Sink 管道、调优 pipeline） |

外部交互方：火山引擎 AI Search（控制面 OpenAPI + 数据面 Runtime API）、OpenAI 兼容 LLM（调优判定与 query 生成用）、外部数据源（MySQL/MongoDB/Redis Stream，连接器抽取）。这样分层解决了三个问题：入口与分发解耦（换打包方式不影响业务）、命令薄壳（业务逻辑集中可测）、core 层稳定（上层命令频繁变化不污染 API 封装）。

### 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 前端控制器 | `main()` in `src/standalone.ts:11` | 单一入口集中路由，支持 binary 打包 |
| 命令模式 | `runXxxCommand()` in `app/*-commands.ts` | 业务操作封装为函数，双入口共享零重复 |
| 策略 | `ConnectorSource` 接口 / `formatOutput()` / `generateTuningStrategies()` | 多源/多格式/多 optimizer 可互换 |
| 外观 | `resolveCliDefaults()` / `printOutput()` / `callOpenApi()` | 封装多级优先级与多步流程 |
| 管道/过滤器 | Source→Runner→Sink / `runSearchTuning()` | 数据单向流动，每阶段处理传递 |
| Cache-Aside | `label-cache.ts` + `buildPendingLabels()` | LLM 判定跨 run 共享，miss 才调 |

### 核心概念

#### 核心对象

| 核心对象 | 含义 | 生命周期 | 主要关系 |
| --- | --- | --- | --- |
| `ServiceConfig` | 控制面服务配置（含签名凭证） | 每命令 resolve 一次 | 被 openapi-client/sink 持有 |
| `RuntimeConfig` | 运行时配置（含 applicationId/datasetId） | 每运行时命令 resolve | 被 search-client/data-client 持有 |
| `ConnectorChange` | 连接器变更记录（op/id/fields/cursor） | 单批次 | Source 产 → Runner 缓冲 → Sink 写 |
| `TuningStrategy` | 调优候选策略（searchDynamic+requestParams） | 单 run | strategy-generator 产 → runner 评估 |
| `JudgeLabel` | LLM 判定结果（grade/confidence/reason+hashes） | 跨 run（cache） | judge 产 → cache 存 → metrics 消费 |
| `AppStatusSnapshot` | 应用就绪状态快照（phase/ready/datasets） | 轮询产生 | wait-ready/shortcut/tuning 消费 |

#### 核心抽象

| 接口/抽象 | 定义位置 | 实现类 | 注册方式 |
| --- | --- | --- | --- |
| `ConnectorSource` | `src/core/connector/types.ts:134` | `MySql/Mongo/RedisStream/JsonlConnectorSource` | `createConnectorSource()` 工厂 switch |
| `TuningStrategyOptimizer` | `src/core/search-tuning/types.ts` | `matrix` / `spa` 生成函数 | `generateTuningStrategies()` 分支 |
| `TuningLabelSource` | `src/core/search-tuning/types.ts` | `llm` / `source-item` | `resolveEffectiveLabelSource()` 解析 auto |
| oclif `Command` | `@oclif/core` | `src/commands/**/*.ts` 102 个 | 文件系统约定（dist/commands 扫描） |

---

## 模块地图

![模块依赖关系](/vibe-reading/images/articles/searchcli-internals/module-dependencies.svg)

四个有效模块的依赖方向自上而下：命令分发层依赖核心服务层（调 API client/配置/输出）；数据连接器和搜索调优作为核心服务层之上的领域子系统，依赖核心服务层的 `runtime-api-client`/`service-config`/`llm-client` 等，同时被命令分发层通过 `connector-commands.ts`/`search-tuning-commands.ts` 编排调用。外部依赖：`@volcengine/openapi`（签名）、`zod`（校验）贯穿核心层；`mysql2`/`mongodb`/`redis` 仅连接器按需动态导入；火山引擎 AI Search 是所有 API 的最终目的地。

| 模块 | 职责 | 核心入口 | 为什么独立 | 深入阅读 |
| --- | --- | --- | --- | --- |
| 命令分发层 | 双入口、三域分发、薄命令实现 | `src/standalone.ts` main() | 解决"binary 打包 vs 命令发现"权衡，路由逻辑集中 | [命令分发层](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/01-command-dispatch) |
| 核心服务层 | API 客户端/配置/凭证/输出/schema 推断 | `resolveServiceConfig()` | 全项目扇入最高的底座，对上屏蔽签名细节 | [核心服务层](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/02-core-services) |
| 数据连接器 | 外部数据源→AI Search 断点续传管道 | `runConnector()` in `runner.ts:43` | 自洽的 Source/Runner/Sink 管道 + 状态机，与检索业务无关 | [数据连接器](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/03-data-connector) |
| 搜索调优引擎 | query 生成→判定→指标→策略→应用 | `runSearchTuning()` in `runner.ts:64` | 完整评估 pipeline + LLM-as-judge + cache，独立的检索质量闭环 | [搜索调优引擎](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/04-search-tuning) |

> 模块间的动态调用顺序见下方「运行时行为 > 核心运行流程」。

---

## 运行时行为

### 启动流程

进程启动是一次性的装配过程：

```
bin/run.js (require dist/standalone.js)
  └── src/core/node-bootstrap.ts: installLocalStorageShim()   # 装 localStorage shim 防 SDK 报错
      └── src/standalone.ts: main()
          ├── 读 process.argv.slice(2)
          ├── printRootHelp() / VERSION   # help/version 短路
          ├── runSkillDomainFromArgv()      # skill 域
          ├── runPlatformDomainFromArgv()   # platform 域（返回 false 则继续）
          ├── runProductDomainFromArgv()    # product 域
          └── throw Unknown command
```

**对象装配**发生在命令执行时（非启动时）——SearchCLI 不用 DI 容器，而是"用时再 resolve"。每个 `runXxxCommand` 内部调用 `resolveServiceConfig(input)` / `resolveRuntimeConfig(input)`，这两函数从 `resolveCliDefaults()` 取五级优先级配置（参数→环境变量→profile→全局→默认），再 zod 校验。`ServiceConfig` 实例随后 `new VikingOpenApiClient(config)` / `new VikingRuntimeApiClient(config)` 装配出 API client——client 与 config 同生命周期，命令结束即随 GC。凭证从 `credential-store.ts` 的 `loadServiceCredentialsSync()` 懒加载，auto 模式 macOS 走 keychain、否则走加密文件。feature-flag `VIKING_ENABLE_PROJECT=1` 在 `src/index.ts` 入口处由 `isProjectFeatureEnabled()` 守卫，未启用时 `project` 命令对外不可见。

### 核心运行流程

下面三条链路覆盖 SearchCLI 最重要的运行模式：搜索运行时验证、物品上车 plan/apply（含 dry-run 与确认门）、搜索调优全流程。前两条是命令分发层的典型路由，第三条是搜索调优子系统的内部编排。

#### 搜索：`vs search run`

业务流程：用户传 application-id/scene-id/query → CLI 解析 → 签名调数据面 search API → 格式化输出。

![端到端数据流](/vibe-reading/images/articles/searchcli-internals/data-flow.svg)

文字描述：`main()` 取 `argv[0]='search'`，`runProductDomainFromArgv` 匹配 `case 'search'` 调 `runSearchCli`，`switch (action)` 匹配 `case 'run'` 调 `runSearchRunCommand(options)` in `src/app/product-commands.ts:1007`。该函数 `resolveServiceConfig()` 拿带签名 `ServiceConfig` → `new VikingRuntimeApiClient(config)` → `client.search(applicationId, sceneId, payload)` 委托 `postJson()` in `src/core/http.ts`（`buildHeaders` 优先 apiKey 其次 AK/SK 签名）→ 响应经 `extractResponseMetadataError()` 检查（HTTP 200 也可能抛逻辑错）→ `printOutput()` 按 `--format`/`--json`/`--pretty` 渲染到 stdout 或文件。链路跨三层模块边界：入口/分发（app）→ 命令实现（commands）→ 核心服务（core/http），数据以 `string[]` argv 进、以 `SearchResponseShape` 出、最终渲染为 JSON/表格/YAML。全程 async/await，无并发；错误经 `ApiRequestError` 冒泡到 `main().catch` 设 `process.exitCode=1`。

#### 数据上车：`vs item profile | plan | apply`

业务流程：用户提交 items.json → profile 推断 schema → plan 生成计划目录 → apply 执行（dry-run → 确认门 → 上架 → read-after-write 验证）。

文字描述：`runItemCli` 的 `switch(action)` 分发到 `profile`/`plan`/`apply`，调 `src/app/item-commands.ts` 的对应函数，后者委托 `src/core/item-onboarding.ts`（2031 行编排层）——它用 `inferSchemaArtifactsWithConsole()`（服务端 TOS 上传 + OpenAPI 推断任务）和 `inferSchemaMetadataWithPrompt()`（LLM prompt 推断）双路推断字段语义。`apply` 链路是 SearchCLI"可审查执行模型"的集中体现：`runItemApplyCommand` 先 **dry-run**——`buildApplyDryRunSummary()` in `item-onboarding.ts:567` 返回完整步骤列表（validation_gate → review_confirmation → schema_check → create_dataset → ingest_items → create_application → activate_application → wait_ready → search_scene_bootstrap → search_trial → chat_trial → recommend_bootstrap → recommend_trial）但不执行任何 API 调用，供用户预览。真正执行时过**三道确认门**：门 1 验证门（`plan.validation.ok` 检查 primary_key 缺失/重复/类型混杂，可 `--force` 跳过）；门 2 人工审核确认门（`--confirm-review` 必须显式传入，`review-confirmation.json` 须 status=confirmed 且 4 个 requiredChecks 全 true，或 `--interactive-review` 自动写）；门 3 推荐场景入口绑定确认（仅当 recommendBhvSceneTypes 非空）。执行后有**六次 read-after-write 验证**：绑定 dataset 后读回 GetAppDataConfig、在线配置更新后读回 GetAppOnlineConfig、索引就绪轮询 fetchAppStatusSnapshot、搜索场景 PublishSearchSceneV2 后读回 GetSearchSceneV2、chat 绑定后读回、推荐场景后读回——每次写操作后立即读回确认落地。`--wait-ready` 会轮询 `app wait-ready` 直到应用就绪。这是"过程留痕可审查"的工程化兑现。

#### 调优：`vs search tune run`

业务流程：加载/生成 query → 并发检索候选策略 → LLM/source-item 判定 → 算指标 → 选最优策略 → 写报告 → （可选）apply 到场景。

文字描述：`runSearchCli` 的 `case 'tune'` 三级分发到 `run` 子命令，调 `runSearchTuneRunCommand()` in `src/app/search-tuning-commands.ts` → `inspectTuningContext()`（推断 datasetId、拉样本、取字段配置）→ `runSearchTuning()` in `src/core/search-tuning/runner.ts:64`。runner 编排七阶段：setup（`createNewRunSetup` 生成 query + 候选策略）→ search（`Promise.allSettled` 按 `searchConcurrency` 并发 `VikingSearchClient.search()`，每批写 checkpoint）→ label（source-item 模式直接匹配 id 打 grade=3，llm 模式 worker pool 并发 `judgeRelevance()`）→ metrics（`computeStrategyMetrics` 算 NDCG@20/10、MRR@10、Precision@10）→ write（report.json/report.md/recommendation.json 等，run-state 置 completed）。`--resume-run-id` 从 checkpoint 恢复中断的 run。label 阶段命中 `label-cache`（5 维 key，跨 run 共享）的跳过 LLM 调用。详见 [搜索调优引擎](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/04-search-tuning)。

### 状态流

连接器任务有一个明确的状态机（`runtime.json` 的 status 字段）：`idle`（已 init 未 run）→ `running`（主循环中）→ `stopped`（收到停止信号）→ `failed`（异常终止）→ `completed`（正常结束）。转换触发：`vs connector run` 置 running；`vs connector stop` 创建 stop 文件 → 下轮 iteration 检查后置 stopped；Runner catch 块置 failed；主循环正常退出置 completed。崩溃恢复时 `isProcessAlive(pid)` 检测旧 pid 已死，允许新进程接管而不被并发锁拦住。调优 run 有类似状态机（`run-state.json` 的 status：running/completed/failed），支持 `--resume-run-id` 从 running 状态恢复。

---

## 典型修改场景

#### 场景 1：新增一个 `vs app new-action` 命令

需改：`src/app/product-commands.ts`（加 `runAppNewActionCommand` 函数 + `runAppCli` switch 加 case + `printAppCommandHelp` 加文本 + `parseStandaloneArguments` 注册新 flag）；可选 `src/commands/app/new-action.ts`（dev 模式 oclif Command 类）。核心服务层与 core 无需改动——薄适配器设计让新命令直接复用 `callOpenApi()`/`callDataPlane()` 门面。详见 [命令分发层 > 扩展方式](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/01-command-dispatch#扩展方式)。

#### 场景 2：新增 Postgres 数据源到连接器

需改：`src/core/connector/types.ts`（加 `'postgres'` 类型 + `PostgresConnectorSourceConfig`）；新建 `src/core/connector/sources/postgres.ts`（`dynamicImport('pg')` + keyset pagination，参考 `mysql.ts`）；`sources/index.ts` 工厂加 case；`sources/helpers.ts` 加 PG 环境变量；`config.ts` zod schema 加分支；`src/commands/connector/init.ts`/`export.ts` flag options 加值并放宽 `init.ts:54` 硬编码守卫。详见 [数据连接器 > 扩展方式](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/03-data-connector#扩展方式)。

#### 场景 3：更换 LLM judge prompt 或新增评估指标

换 prompt：仅改 `src/core/search-tuning/judge.ts` 的 `TEXT_JUDGE_PROMPT` 常量——`buildJudgeProfileHash()` 自动把新 prompt hash 纳入 cache key，旧 cache 自动失效无需手动清理。新增指标（如 Recall@K）：改 `types.ts`（加字段）+ `metrics.ts`（加函数）+ `report.ts`（加列）+ `compare.ts`（加字段）。详见 [搜索调优引擎 > 扩展方式](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/04-search-tuning#扩展方式)。

---

## 测试体系

SearchCLI 的测试以**验收测试**为主，位于 `scripts/suites/` 与 `scripts/run-acceptance.cjs`，分层为 mock 与 live 两套：

```
scripts/
├── run-acceptance.cjs            # 验收测试运行器
├── fixtures/                     # 测试夹具
└── suites/                       # 测试套件（含 v2-onboarding、live 等）
```

| 代码层 | 测试类型 |
| --- | --- |
| 命令分发层 / 核心服务层 | 验收测试（`npm run test:acceptance:dist`，mock 模式） |
| 端到端含真实服务 | live 验收（`test:acceptance:dist:live`，需 AK/SK） |
| 独立逻辑模块 | 内联单元测试（`scripts/*.test.ts`，如 `console-schema-inference.test.ts`、`search-tuning-field-context.test.ts`） |

验收测试通过 `npm run build` 后跑 `--dist` 或 `--binary`（打包后二进制），验证 CLI 整体行为；`v2-onboarding` 套件专测 V2 上车路径；`live` 套件需 `VIKING_ACCEPTANCE_LIVE=1` 跑真实服务。想理解某个命令的行为，优先看 `scripts/suites/` 对应套件——它是可执行的行为规约。维护者还可用 `npm run validate:skills` 校验 `skills/` 下的 Viking skills 格式。

---

## 阅读源码推荐路线

- **第一遍：理解主流程**
  `bin/run.js` → `src/standalone.ts` 的 `main()` → `src/app/product-commands.ts` 的 `runProductDomainFromArgv` → `runSearchCli` → `runSearchRunCommand` in `src/app/product-commands.ts:1007` → `src/core/runtime-api-client.ts` 的 `search()` → `src/core/http.ts` 的 `postJson()`。
- **第二遍：理解配置与凭证装配**
  `src/core/user-config.ts` 的 `resolveCliDefaults()` in `:229`（五级优先级）→ `src/core/service-config.ts` 的 `resolveServiceConfig()` → `src/core/credential-store.ts` 的 `loadServiceCredentialsSync()`（keychain/加密文件/ephemeral 三后端）→ `src/core/http.ts` 的 `buildHeaders()`（签名路径选择）。
- **第三遍：理解两个领域子系统**
  数据上车：`src/core/connector/types.ts` 的 `ConnectorSource` 接口 → `sources/index.ts` 工厂 → `runner.ts` 的 `runConnector()` 主循环 → `state-store.ts` 断点续传；检索调优：`src/core/search-tuning/runner.ts` 的 `runSearchTuning()` → `query-generator.ts` → `judge.ts` 的 `judgeRelevance()` → `metrics.ts` → `apply.ts`。
- **第四遍：选择重点模块深入阅读**（各模块文档）：
  [命令分发层](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/01-command-dispatch) · [核心服务层](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/02-core-services) · [数据连接器](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/03-data-connector) · [搜索调优引擎](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/04-search-tuning)

---

## 附录

### 术语表

| 术语 | 含义 |
| --- | --- |
| AI Search | 火山引擎的搜索/推荐/对话检索产品，SearchCLI 的服务端 |
| Viking | SearchCLI 的内部代号（npm 包名 `viking-cli`，环境变量 `VIKING_*`） |
| 控制面 (Control Plane) | 管理操作 API，走 OpenAPI action 名，必须 AK/SK 签名 |
| 数据面 (Data Plane) | 运行时 API（search/recommend/chat/data），支持 API Key 或 AK/SK |
| Viking skills | 可安装的 markdown 技能包（`skills/` 目录），给外部 agent 用同一套工作流 |
| source-item 标签 | 调优判定的一种快速标签源——按 query 的 sourceItemIds 匹配，不调 LLM |
| keyset pagination | 用 `(cursor_field, id_field)` 复合排序+过滤的增量游标分页，避免 OFFSET 性能退化 |
| at-least-once | 连接器的交付语义——崩溃恢复可能重复读上一批，靠 upsert 幂等兜底 |

### 参考资料

- [SearchCLI GitHub 仓库](https://github.com/volcengine/SearchCLI) · [COMMANDS.md](https://github.com/volcengine/SearchCLI/blob/main/docs/COMMANDS.md) · [Agent Quick Start](https://github.com/volcengine/SearchCLI/blob/main/docs/agent-quick-start.md)
- [oclif 文档](https://oclif.io/)（CLI 框架）· [`@volcengine/openapi` Signer](https://www.npmjs.com/package/@volcengine/openapi)（请求签名）· [zod](https://zod.dev)（schema 校验）
- 方法论参考：[deepwiki-rs](https://github.com/sopaco/deepwiki-rs)（四阶段流水线）、[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)（分层分解）
