---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "共享组件层"
date: "2026-09-20T18:45:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "React", "shadcn", "Tailwind", "Design System"]
description: "ui / ui-patterns 两层组件 + design-system / ui-library 双站：OKLCH 派生 token 与 shadcn registry 分发链路。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

四个包/应用构成一条「组件 → 文档 → 可安装 registry」链路：`packages/ui`（~10k 行，UI 原语层：Radix 原子包装 + shadcn 组件 + 主题 token）、`packages/ui-patterns`（~24k 行，业务模式层：组合原语与 NPM 库形成有业务语义的复合组件）、`apps/design-system`（对内文档站）、`apps/ui-library`（对外 shadcn registry 站）。引用规模：`from 'ui-patterns'` 在 apps/ 下共 **1784 处 import**（studio 858 文件、design-system 161、www 84、docs 40）。

## 模块架构

![共享组件层](/vibe-reading/images/articles/supabase-internals/ui-registry-layers.svg)

两层的判据（design-system README 原话）：ui 是 basic UI components；ui-patterns 是 "components which are built using NPM libraries or amalgamations of components from `packages/ui`"。典型：`ui-patterns/src/DataInputs/Input.tsx` 在 ui 的 `BaseInput` 上加 copy/reveal(密码)/icon/actions 业务能力。右侧双站定位不同——design-system **对内**（文档 + 设计规范，"references components rather than housing them"，预览索引直接指向 packages 源码路径）；ui-library **对外可安装**（条目是带 Supabase client 的完整功能块，按框架 × client 展开变体）。

## 调用链路

### 对外 registry 构建链（ui-library）

```
registry/index.ts 组装 Registry（import { type Registry } from 'shadcn/schema' —— shadcn CLI v3 官方类型）
  ├─ blocks（每块一个 registry-item.json：registryDependencies/dependencies/files）
  ├─ registryItemAppend()（registry/utils.ts）：password-based-auth block × 4 种 client
  │    （nextjs/react/react-router/tanstack）自动展开 4 个变体，合并去重依赖
  └─ examples + vueBlocks
→ scripts/build-registry.mts 写 public/r/registry.json（过滤 registry:example）
→ shadcn build public/r/registry.json   （官方 CLI 展开每条目独立 JSON，内联文件内容）
→ scripts/clean-registry.ts 清洗路径（剥 monorepo 结构、重写跨变体 import）
→ 消费：npx shadcn@latest add @supabase/xxx   （@supabase 是 shadcn upstream PR #8161 的 registry alias）
```

design-system 的链路（对内）不同：`scripts/build-registry.mts` 用 **ts-morph 做 AST 操作**——`components:ui` 条目指向 `packages/ui/src/components/shadcn/ui/${name}` 源文件、`components:fragment` 指向 `packages/ui-patterns/src`；`components:block` 额外扫描 JSX 中带 `x-chunk` 属性的元素切分为可独立预览的 chunk。产出 `__registry__/index.tsx`（134KB 的 lazy 加载索引）。注意其 `buildStyles()` 整段被注释——design-system **不是** shadcn CLI registry，只是文档站。

<details>
<summary>组件速查表</summary>

| 组件/机制 | 位置 | 说明 |
| --- | --- | --- |
| `FormItemLayout` | `ui-patterns/src/form/FormItemLayout/FormItemLayout.tsx`（22 行薄壳） | 真正逻辑在 `form/Layout/FormLayout.tsx`（460 行） |
| `SIZE_VARIANTS` | `ui/src/lib/constants.ts` 的 `SIZE` 对象 | text/padding/height 三套按 tiny→xlarge 对齐，全库尺寸单一真源 |
| `Button` 双代并存 | `ui/src/components/Button/Button.tsx`（旧）+ `shadcn/ui/button.tsx`（新，别名 `Button_Shadcn_`） | 迁移中的双轨 |
| `semantic.css` | `ui/build/css/source/semantic.css` | OKLCH 派生引擎（见下） |
| `gen:exports` | `ui-patterns/scripts/update-exports.ts` | 递归扫 src/ 生成 package.json exports map |

</details>

## 核心实现

### FormItemLayout：一套布局、两种表单体系

`FormLayout.tsx` 的核心开关 `isReactForm`：true 时 label 渲染为 shadcn 的 `<FormLabel>`（从 `useFormField()` 读 error 状态自动变红）、error 渲染 `<FormMessage>`（react-hook-form 经 context 注入）；false（默认）渲染普通 `<Label>`，error 由显式 prop 传入——服务于存量非受控代码。**react-hook-form/zod 集成不发生在 FormLayout 里**而在消费端（`useForm({ resolver: zodResolver(FormSchema) })`），ui 只提供 shadcn 标准的 `Form/FormField/FormItem/FormControl/FormMessage` 双 context 桥。布局由 6 个 `cva` variant 函数组合驱动，支持 horizontal/vertical/flex/flex-row-reverse 四布局；horizontal 模式的 `isContainerResponsive` 用 Tailwind v4 **`@container` 查询**（`@xl:grid-cols-12`）替代 viewport 断点——源码注释详细解释了为什么：「组件在侧栏旁窄列中，viewport 断点永不触发」。

### OKLCH 派生 token

单一真源在 `packages/config/tailwind.config.css`：`@import` 链拉入 `ui/build/css/source/global.css`（OKLCH 派生引擎）、`semantic.css`、`themes/dark.css|light.css` 与 `@theme inline` 生成 utilities。亮点是 `semantic.css`：所有语义色（`--background/--foreground/--border`...）由 4 个 OKLCH 输入变量（`--hue: 159` Supabase 绿、`--chroma`、`--surface`、全局对比度旋钮 `--contrast: 0.5`）**经 CSS calc 派生**，theme 文件只覆盖小集合输入——`--surface-hue` 与 `--primary-hue` 拆开还允许「冷灰表面 + 绿色品牌」的发散组合。

### registry 组合展开

`registryItemAppend()`（`registry/utils.ts`）解决 N×M 维护问题：一个 `password-based-auth` block 对 4 种 client 框架自动生成 4 个变体条目，合并去重 registryDependencies/dependencies/files/envVars。client 样板只维护一份。另有 `app/api/registry/tanstack-db/route.ts` **动态生成** registry 条目（依赖用户数据库 schema）——registry 不全是静态的。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 双 context form 桥 | `ui/src/components/shadcn/ui/form.tsx` 的 `FormFieldContext` + `FormItemContext` + `useFormField()` | shadcn 标准做法，FormItemLayout 包 `<FormItem>` 即接入 |
| isReactForm 双轨渲染 | `FormLayout.tsx` | 一套布局同时服务受控（RHF）与非受控表单 |
| cva compoundVariants 布局矩阵 | `FormLayout.tsx` 6 个 cva | 布局×对齐×尺寸组合空间声明式表达 |
| registry 模式 | `ui-library/registry/` | 组件即分发渠道（获客 funnel） |
| x-chunk AST 拆分 | `design-system/scripts/build-registry.mts` | 大 block 切可单独预览的 chunk |
| subpath exports 自动生成 | `ui-patterns/scripts/update-exports.ts` | 新增组件跑一次即可对外 import（tree-shaking 保证） |

## 模块间交互

studio/www/docs 全部通过**包名 subpath import**（非 `@/` alias）：`import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'`。studio tsconfig 中另有 `"@ui/*"` legacy alias 但主流已是包名（`workspace:*`）。两层划分的实际收益：studio 不必为 www/docs 拖入 recharts/markdown 等重组件（subpath exports 保证 tree-shaking），且 `ui` 可独立喂 shadcn registry。一个边界模糊点值得注意：`ui` 的运行时 form 组件需要 react-hook-form，但它只出现在部分场景的依赖里——两层的「零业务依赖」承诺并不完美。

## 扩展方式

**新增共享 UI 组件并发布到 registry**：`packages/ui-patterns/src/Foo/` 写组件（可 `import { Button, FormItem } from 'ui'`）→ `pnpm --filter ui-patterns gen:exports` 重新生成 exports → studio 直接 `import { Foo } from 'ui-patterns/Foo'` → 进 design-system 文档在 `registry/fragments.ts` 加条目（`type: 'components:fragment'`）+ `config/docs.ts` 侧栏 + content/docs 写 MDX → `pnpm build:registry`；进对外 registry 按 `registry-item.json` 标准建目录并加入 `registry/index.ts` 聚合（注意 ui-library 的条目是「带 Supabase client 的功能块」级别，纯组件走 design-system）。

**为 FormItemLayout 加布局**：`Props.layout` 联合类型加值 + `ContainerVariants/LabelContainerVariants/DataContainerVariants` 三处同步加 variant——所有 isReactForm 与非受控两条渲染路径自动继承。

**给 ui-library 加框架变体**：`registry/clients.ts` 加 client 条目 → `blocks.ts` 的 `combine()` 自动展开 → 本地 `npx shadcn add http://localhost:3004/r/xxx-nuxtjs.json` 验证 → `clean-registry.ts` 有 import 重写需同步。
