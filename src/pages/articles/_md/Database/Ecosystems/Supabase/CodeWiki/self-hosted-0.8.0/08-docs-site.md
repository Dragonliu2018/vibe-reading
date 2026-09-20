---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "docs 文档站"
date: "2026-09-20T18:40:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "OpenAPI", "MDX", "文档", "LLM"]
description: "apps/docs 文档站：spec 单一真源的 API reference 生成、5 源 federated content、manifest-gated markdown 协商。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`apps/docs`（~46k 行）是 supabase.com/docs 文档站（Next.js 15 App Router + MDX）。三大内容来源：**guides**（手写 MDX）、**reference**（spec 驱动生成）、**federated content**（构建期从 5 个外部 GitHub 仓库拉取）。它的架构核心思想是 **spec-as-single-source**：Management API 的 OpenAPI 从生产端点直接下载，CLI/SDK 文档从各产品仓库的构建产物拉取——文档与真实 API surface 由 CI 保证一致，且同一份 spec 喂 `packages/api-types` 给 dashboard 用。

## 模块架构

![docs 构建流水线](/vibe-reading/images/articles/supabase-internals/docs-build-pipeline.svg)

`spec/` 目录三类文件：OpenAPI（`api_v1/v2_openapi.json` 等，来源见 `spec/Makefile`——管理 API 是 `curl https://api.supabase.com/api/v1-json`，各服务 spec 手工维护）、CLI spec（`cli_v1_commands.yaml`，clispec '001' 格式 4092 行，来自 supabase/cli）、SDK TSDoc（`spec/reference/{javascript,server,dart}/v*/**.json`，各 SDK 仓库的 TypeDoc 输出，发布在 GitHub Pages）。Makefile 的 `transform` 步骤用 Redocly bundle 成 `spec/transforms/*_deparsed.json`——api_v1/v2 刻意不加 `--dereferenced`（`APIErrorObject.issues` 循环引用无法展平，改由代码内 `resolveRefs` 手工解析，见 `features/docs/Reference.generated.script.ts`）。

federated content 的 5 个源（`scripts/federated-content/sources/`）：wrappers（33 个 FDW wrapper 文档，`docs_v*` tag）、setup-cli、pg_graphql、vecs、terraform-provider-supabase。

## 调用链路

### 链 A：OpenAPI spec → API reference 页

```
spec/api_v1_openapi.json
  → (Makefile) redocly bundle → spec/transforms/api_v1_openapi_deparsed.json
  → features/docs/Reference.generated.script.ts（codegen:references:legacy）
      genApiSectionTree(endpointsById) / mapEndpointsById / resolveRefs
  → features/docs/generated/api.latest.sections.json + endpointsById.json
  → app/reference/[...slug]/page.tsx（dynamicParams = false，全静态）
      parseReferencePath → 四合一分派：
      ClientSdkReferencePage / CliReferencePage / ApiReferencePage / SelfHostingReferencePage
```

SDK 生成有**双轨**：legacy（`Reference.generated.script.ts`，处理 kotlin/python/swift/csharp 的 yaml spec）与 new（`scripts/build-reference-content.ts`，扫 TypeDoc 输出写 `content/reference/[lib]/[ver]/{bySlug,flat,sections,functions,typeSpec}.json`，覆盖 js/dart/server）。

### 链 B：guides MDX → markdown 变体（manifest-gated）

```
content/guides/**/*.mdx
  → internals/generate-guides-markdown.ts（build:guides-markdown）
      inlinePartials() 展开 <$Partial> → applySchema() 按 SCHEMA 把 JSX 组件转 markdown
      （internals/markdown-schema/ 下 ~24 个组件 handler；
        未注册组件 fallback 为 ({ children }) => children——解包保子内容）
  → public/markdown/guides/<slug>.md + public/markdown/manifest.json
  → middleware.ts: import MARKDOWN_SLUGS from '~/public/markdown/manifest.json'
      negotiateMarkdown(...) → 'markdown' 时 rewrite 到 /api/guides-md/<slug>
  → app/api/guides-md/[...slug]/route.ts：Content-Type: text/markdown（含 path traversal 防护）
```

关键点：**只有出现在 manifest.json 里的 slug 才可协商出 markdown**；不可接受且无变体时返回 406（`Vary: Accept`）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `resolveLatestTag` in `fetch-federated-content.ts` | 按日期找最新 tag | GraphQL 查询按 commit date 排序——REST API 无法按日期排序 tag |
| `transformUrl` | 重写 federated 文档链接 | pageMap 命中映射本地，未命中回退 externalSite |
| `applySchema` + `SCHEMA` in `generate-guides-markdown.ts` | JSX→markdown 组件转换 | visitor 模式，未注册组件解包保子内容 |
| `renderFunctionSection` in `generate-reference-markdown.ts` | SDK 函数文档拼装 | `## <fn>` + `### Examples` 结构化输出 |
| `resolveRefs` in `Reference.generated.script.ts` | 手工解循环引用 | api_v1 spec 无法 dereference 的兜底 |
| `middleware.ts` | markdown 协商 + 版本归一化 | 90 行双职责；旧版本 URL 重写到最新 |

</details>

## 核心实现

### prebuild 8 步 codegen

`package.json` 的 `prebuild` 串起 `codegen:graphql → codegen:references → codegen:examples → build:federated-content → build:markdown → build:gz-archive` 等约 8 步。产物（`features/docs/generated/`、`content/reference/`、`examples/`、`public/markdown/`）全部 gitignore（`clean` 脚本 rimraf）。运行时零成本——全部是构建期脚本。

`build:gz-archive` 的 tar 选项刻意注释说明：sorted entries + portable headers + fixed mtime 保证**确定性/可复现构建**。结合 manifest-gated 协商、406 语义、bot 专用简化 HTML（`app/api/crawlers/route.ts`——SDK 深层 section 页对 bot 重写到此处），这是一套完整面向 LLM 爬虫与 AI 编码工具的内容分发（模型按 `Accept: text/markdown` 拉取、`docs.tar.gz` 供 AI agent 整包下载）。

### guides 路由：每 section 一个 catch-all

`app/guides/cron/[[...slug]]/page.tsx`、`app/guides/auth/[[...slug]]/page.tsx` 等——每 section 一个 catch-all 而非单一全局。每个 page 是薄 wrapper：`getGuidesMarkdown(slug)` → `<GuideTemplate {...data} />`，模板逻辑在 `features/docs/GuidesMdx.template.tsx` / `GuidesMdx.utils.tsx`。partial 复用通过 `<$Partial path="..." />` 指向 `content/_partials/`。

### federated 而非 fork

wrappers/pg_graphql/terraform 等仓库的文档由维护者随代码同 PR 更新，docs 构建期拉最新 tag（wrappers 的 `latestTag.pattern: '^docs_v\d+\.\d+\.\d+'` 允许文档与代码独立发版）。`loadSources()` 动态 import sources 目录自动发现新源——接入新 federated 源只需加一个导出 `FederatedContentSource` 的 ts 文件（section/org/repo/branch/docsDir/externalSite/pageMap），无需改主流程。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Spec-as-single-source | `spec/Makefile` + `packages/api-types/redocly.yaml` | API 变更一次提交同时更新文档与类型，消灭双源漂移 |
| 构建期内容生成 | `prebuild` 脚本群 | 运行时零成本；产物可复现 |
| 组件 schema 化降级转换 | `internals/markdown-schema/` | 同一份 MDX 供 React（html）和 markdown（AI/bot）两种消费者 |
| 内容协商三态 | `common/markdown-negotiation`（www 共享） | bot/显式 `.md` 拿 markdown，其余拿 React 页 |
| 双轨 SDK codegen | legacy（yaml）+ new（TypeDoc json） | 不同 SDK 仓库的 spec 形态差异 |
| 多格式输出 | html + 逐页 markdown + 确定性 tarball + sitemap | 一个内容源 N 个分发面 |

## 模块间交互

与 `packages/api-types` **不直接共享 spec 文件而是同一源头**：api-types 的 `redocly.yaml` 指向本地跑的 Management API（`http://localhost:8080/api/v1-json`），docs 的 Makefile 指向生产端点——Management API 是单一真源，两边各自拉取生成。`examples/` 由 `codegen:examples` 直接拷 monorepo 根的 examples 目录（`shx cp -r ../../examples ./examples`）。与 www：共享 `markdown-negotiation` 与 `ui-patterns`；www 的 llms-full.txt 运行时读本 app 的 markdown 产物。`spec/Makefile` 引用的 `packages/generator`（CLI spec 解析器）在本快照 monorepo 中未见目录——已迁移为独立引用（待核实具体仓库位置）。

## 扩展方式

**新增 API reference 章节**：服务端加端点 → `spec/` 下 `make download.api.v1` 重拉 OpenAPI → 需要新导航分组时改 `spec/common-api-sections.json` → `pnpm codegen:references` 重新生成 sections.json → 有文字介绍页在 `docs/ref/api/` 加 mdx。markdown 输出自动跟上。

**guides 新增自定义 MDX 组件**：`internals/markdown-schema/MyWidget.tsx` 实现 `ComponentHandler` 并在 `generate-guides-markdown.ts` 的 `SCHEMA` 注册——否则 markdown 变体里该组件被静默解包只剩 children，AI 消费者丢失语义。

**接入新 federated 文档源**：`scripts/federated-content/sources/` 加导出 `FederatedContentSource` 的 ts 文件 + 导航条目。对应测试：`e2e/docs/` 的 a11y 与 local-smoke 配置。
