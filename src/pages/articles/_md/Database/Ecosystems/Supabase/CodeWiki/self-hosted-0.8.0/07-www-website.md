---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "www 官网"
date: "2026-09-20T18:35:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "Next.js", "MDX", "SEO", "LLM"]
description: "apps/www 营销官网：下划线内容集合、构建期 TS 模块生成、_go 声明式落地页与面向 agent 的 markdown 分发矩阵。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

`apps/www`（~128k 行）是 supabase.com 营销官网：博客（421 篇 MDX）、客户案例、活动、定价、竞品对比、活动落地页。它在这个版本最值得解读的不是营销内容，而是**构建期内容工程**——所有内容在 build 时被脚本转成静态 TS 模块与 markdown 产物，以及一个贯穿全站的 **LLM-first 分发矩阵**：官网同时是人类站点和 agent 可读站点。

## 模块架构

双 Router 共存：Next.js 15 同时保留 App Router（`app/`，新内容）与 Pages Router（`pages/`，约 30+ 旧页面：changelog、launch-week、legal、solutions 等未迁移）。内容组织用**下划线前缀目录**的自研约定（非 content-collections）：`_blog/`（421 个 `YYYY-MM-DD-slug.mdx`）、`_customers/`、`_events/`、`_alternatives/`（竞品对比，仅 3 篇核心竞品）、`_go/`（TS/TSX 落地页注册表，非内容）。

关键澄清：`content:build` 不是 content-collections，而是三个自研 Node 脚本链——`generateStaticContent.mjs`（GitHub stars/Ashby 职位数/私有 changelog 仓库 → RSS）+ `generateMdContent.mjs`（mdx → markdown 产物）+ `fetchAgentSkills.mjs`。

![www 内容流水线](/vibe-reading/images/articles/supabase-internals/www-content-pipeline.svg)

## 调用链路

博客页渲染链（`app/blog/[slug]/page.tsx`）：

```
generateStaticParams() ← lib/posts.tsx 的 getAllPostSlugs('_blog')
  （fs.readdirSync + FILENAME_SUBSTRING=11 剥日期前缀得 slug）
→ generateMetadata() ← getPostdata(slug) + gray-matter（OG 图取 imgSocial）
→ BlogPostPage()：matter 解析
  → preprocessMdxWithCodeTabs + addSelfClosingTags
  → extractToc(preprocessed, tocDepth)
  → prevPost/nextPost/relatedPosts（getSortedPosts({ tags })）
  → 注入 BlogPosting + BreadcrumbList JSON-LD
→ <BlogPostClient>；export const revalidate = 30
```

`lib/posts.tsx` 是所有内容集合的统一读取层：`getSortedPosts({ directory, limit, tags, categories })`，对 `_blog` 强制 `validateBlogFrontmatterImages`（imgSocial/imgThumb 成对、禁止 `/images/blog/` 前缀——写了相对路径如 `my-post/og.png`）。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `getAllPostSlugs`/`getSortedPosts` in `lib/posts.tsx` | 内容集合统一读取 | FILENAME_SUBSTRING=11 剥 `YYYY-MM-DD-` 前缀 |
| `generateMdContent.mjs` | mdx → `content.generated.ts` | middleware 在 edge runtime 不能读 fs；静态 import 利于 nft trace；slug 冲突/保留字（`DYNAMIC_SLUGS = ['pricing']`）构建期校验 |
| `negotiateMarkdown` in `common/markdown-negotiation` | Accept 头协商三态 | 与 docs 共享同一函数；bot/爬虫/`.md` 后缀拿 markdown，不可接受且有变体时 406 |
| `mdAlternates` in `lib/md-alternates.ts` | 声明 md 备选 | metadata `types: { 'text/markdown': .../<slug>.md }` |
| `generateStaticContent.mjs` | stars/职位/changelog 快照 | 缺 secret 本地 warn 跳过、Vercel 上 fail（防发布过期 changelog） |
| `goPageSchema.safeParse` + `validateGoPageInvariants` | 落地页双重校验 | zod + marketing 包不变量检查 |

</details>

## 核心实现

### LLM-first 内容分发矩阵

同一个内容源同时供五条出口：

1. **markdown 协商**：`middleware.ts` 按 `Accept: text/markdown` 或 `.md` 后缀 rewrite 到 `/api-v2/md/[...slug]`，从构建期生成的 `MD_CONTENT` Map 静态返回（`pricing` 走 `lib/llms.ts` 的 `generatePricingContent()` 动态生成）；
2. **`llms.txt` / `llms-full.txt`**：运行时递归读 **docs** 构建产出的 markdown（`outputFileTracingIncludes` 把兄弟 app 目录打进 serverless bundle）；
3. **changelog markdown**：GitHub App（`CHANGELOG_SYNC_APP_*`）一次性 tarball 拉取私有仓库 `supabase/changelog` → `public/changelog.md` + 按产品标签的 RSS；
4. **`.well-known/agent-skills/index.json`**：拉 `supabase/agent-skills` 最新 Release；
5. **`mdAlternates`** metadata 让每页声明 markdown 变体。

这解释了 www `prebuild` 依赖 docs 构建的原因：`build:guides-markdown` 的产物是 llms-full.txt 的数据源。

### `_go` 声明式落地页注册表

营销活动页（活动报名、ebook 下载、webinar、AMOE 法律页）全部声明式配置：`_go/index.tsx` 汇总导入全部页面定义（类型 `GoPageInput`：`{ template: 'lead-gen', slug, metadata, hero, sections: [...] }`）→ `lib/go.ts` 用 `goPageSchema.safeParse`（zod）+ `marketing` 包的 `validateGoPageInvariants` 双重校验 → `app/go/[...slug]/page.tsx` → 薄壳 `GoPageRenderer` 委托 marketing 包渲染。新活动页只需写一个导出 `GoPageInput` 的 tsx 并注册 import，构建期拦截错误配置。

### 构建期数据快照

首页不运行时调外部 API：GitHub stars / 职位数 / 最新 10 篇博客进 `.generated/staticContent/_index.json`；RSS 与 sitemap 全部构建期生成。资产走自建 CDN：`next.config.mjs` 的 `getAssetPrefix()` → `https://frontend-assets.supabase.com/<SITE_NAME>/<commit12>`（部署脚本 `scripts/upload-static-assets.sh` 直传 Cloudflare R2，路径含 commit SHA 保证不可变）。

### 多 zone 架构

`/docs`、`/dashboard`、`/library`、`/design-system` 各 rewrite 到独立部署（`lib/rewrites.js`）——营销站与文档站**分 app 部署、运行时反代解耦**，但品牌组件/定价真源/feature flags 经 monorepo 共享。`_alternatives` 的 3 篇竞品对比长文（Firebase/Auth0/Heroku Postgres，大量 Feature 对比表 MDX）捕获 "supabase vs X" 搜索流量，仍挂在最老的 Pages Router 流水线上（`pages/alternatives/[slug].tsx` 的 `getStaticProps` + `mdxSerialize`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 构建期预生成 TS 模块 | `generateMdContent.mjs` → `content.generated.ts` | edge middleware 不能读 fs；nft trace 正确 |
| 内容协商三态 | `common/markdown-negotiation`（www/docs 共享） | 人类与 agent 双读者 |
| 声明式落地页注册表 | `_go/` + zod 双重校验 | 营销页配置化，错误构建期拦截 |
| Section 组件化首页 | `app/(home)/_components/HomeContent.tsx` | 10 个具名 section，非首屏 `next/dynamic` 懒加载 |
| 多 zone 反代 | `lib/rewrites.js` | 部署解耦，单域名出口 |
| 混合内容源 | `app/events/page.tsx` 并行拉 Notion API + `_events/` MDX | 各取所长 |

## 模块间交互

workspace 依赖 `ui`、`ui-patterns`、`common`、`shared-data`、`icons`、`marketing`、`api-types` 等九包（`transpilePackages` 全列出）。`shared-data/plans` / `shared-data/pricing` 是定价数据的单一真源（`lib/llms.ts` 生成 pricing.md、dashboard/docs 同源消费）。与 docs 的关系见 LLM 分发矩阵——构建期（prebuild 依赖）与运行时（读 docs 的 markdown 产物）双重耦合，是 monorepo 内唯一的跨 app 内容依赖。

## 扩展方式

**新增官方博客**：`_blog/2026-09-20-my-post.mdx`（frontmatter：title/description/author（author_id 对应 `lib/authors.json`）/date，配图放 `public/images/blog/my-post/` 且 frontmatter 写相对路径）→ `pnpm content:build` 后自动出现在：博客列表、RSS（generateStaticContent）、`blog/my-post.md` LLM 变体、sitemap。

**新增首页 section**：`app/(home)/_components/XxxSection.tsx` + 文案加到 `data/home/content.tsx` + 在 `HomeContent.tsx` 序列注册（首屏直接 import、其余 `dynamic()`）。

**新增活动落地页**：`_go/<campaign>/` 写导出 `GoPageInput` 的 tsx（选 template、拼 sections）→ `_go/index.tsx` 注册 import——zod + invariants 构建期拦截；无需动 `app/go/[...slug]`。
