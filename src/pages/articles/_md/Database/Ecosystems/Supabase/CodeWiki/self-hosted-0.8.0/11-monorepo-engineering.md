---
source:
  type: "源码解读"
  project: "supabase"
  url: "https://github.com/supabase/supabase"
title: "Monorepo 工程化"
date: "2026-09-20T18:55:00+08:00"
category: [Database, Ecosystems, Supabase, CodeWiki, "self-hosted-0.8.0"]
contentType: "CodeWiki"
tags: ["Supabase", "pnpm", "Turborepo", "CI", "Playwright"]
description: "pnpm catalog 版本真源、TypeScript 6/7 双轨、44 workflows 的 PR 检查编排、E2E 双轨 matrix 与 ESLint ratchet 棘轮。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Ecosystems/Supabase/CodeWiki/self-hosted-0.8.0/00-overview)

---

## 模块定位

monorepo 根（`pnpm-workspace.yaml`、`turbo.jsonc`、`.github/workflows/` 44 个、`scripts/`、`e2e/`、`blocks/`）是支撑 7 apps + 15 packages + e2e 的工程基座。这个仓库的工程化激进程度在开源项目里罕见：React 19 + Next 16 + Vite 8 + Tailwind 4 + TS 7 native，且 studio 双框架并行期 E2E 每次 PR 跑双轨 matrix——一个把「前沿采用」制度化的工程组织。

## 模块架构

workspace 四分区（`pnpm-workspace.yaml` 的 `packages:`）：`apps/*`（7 个可部署站点）、`packages/*`（15 个共享库）、`blocks/*`（Vue registry blocks——Nuxt 技术栈、与主仓 React 完全异质的孤岛，`blockExoticSubdeps: true` 放行）、`e2e/*`（Playwright 测试 workspace，测试代码与 app 代码物理隔离，app 的 devDependencies 不污染测试环境）。

turbo 任务图极简（`turbo.jsonc`）：只有 `build` 和 `typecheck` 有拓扑依赖（`^build`/`^typecheck`）；`test` 和 `lint` **不缓存**——保证测试始终真实重跑，避免缓存污染掩盖 flaky；`build` 的 outputs 排除 `.next/cache`（该目录由 actions/cache 独立复用）。

## 调用链路

一次 PR 的检查编排（核心链路，`typecheck.yml` + `studio-e2e-test.yml`）：

![CI 关键链](/vibe-reading/images/articles/supabase-internals/e2e-ci-matrix.svg)

**静态检查链** `typecheck.yml`：checkout（persist-credentials: false）→ pnpm/node setup（`.nvmrc` + pnpm cache）→ **install 之前**先跑 `node scripts/check-case-hazards.mjs`（零依赖 fail-fast，专抓「CI Linux 正确但 macOS/Windows 大小写不敏感文件系统坏掉」的 import）→ `pnpm install --frozen-lockfile` → `turbo --continue typecheck`（native tsc，`--max-old-space-size=4096`）→ lint。

**E2E 链** `studio-e2e-test.yml`：`dorny/paths-filter` 判定 studio 相关路径（pg-meta/studio/e2e/lockfile）变更，未变整 job 跳过 → matrix 双维度 `framework: [next, tanstack]` × `shardIndex: [1,2]`——**每个 PR 双轨并行验证** → `pnpm run e2e:setup:cli`（`supabase start --exclude studio,mailpit` 拉起真实后端 Docker 栈）→ `build:studio`（`NODE_ENV=test MODE=test`）→ `pnpm e2e --shard=i/2`（`PWTEST_SHARD_WEIGHTS=62:38` 手动配平分片负载）→ blob report 合并 → PR 评论结果。

<details>
<summary>工程机制速查表</summary>

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| catalog | `pnpm-workspace.yaml` `catalog:` 块 | 全仓版本唯一定义点；子包用 `"catalog:"` 引用 |
| overrides | 同文件 `overrides:` | 传递依赖手术刀：`'h3@1': 1.15.11`（Nuxt blocks 双 h3 导致 nominal 类型不匹配）、`'monaco-editor': 'catalog:'` |
| minimumReleaseAge | 同文件，`4320` 分钟 | **3 天供应链发布冷却**，新包 3 天内不进 lockfile；豁免 `@supabase/*`、typescript 等 |
| TS 双轨 | catalog 注释 + `@typescript/native: npm:typescript@~7.0.2` | 见下节 |
| 棘轮 | `studio-lint-ratchet.yml` + `apps/studio/.github/eslint-rule-baselines.json`（78.5K） | PR 只许减；周日 cron `--decrease-baselines` bot 自动降基线开 PR |
| autofix 凭据隔离 | `autofix_linters.yml` | 无写凭据 job 产出 patch artifact → 第二 job 用 GitHub App token 以 `supabase-autofix-bot` push |
| action SHA 锁 | 所有 workflow `uses: actions/checkout@9c091bb2...` | 防 tag 重写攻击；`zizmor.yml` 扫 workflow 安全 |
| patch | `patchedDependencies: react-data-grid` | `patches/react-data-grid.patch` |

</details>

## 核心实现

### pnpm catalog：外部版本只有一个真源

典型条目：`@supabase/supabase-js: 2.112.3`（SDK 家族有意锁同一版本号）、`react: ^19.2.6`、`zod: 3.25.76`（生态兼容精确锁死）、`typescript: ~6.0.2`、`'@typescript/native': npm:typescript@~7.0.2`。catalog 让「升级一个共享依赖」从 N 处改动变 1 处；再叠加 `overrides: 'catalog:'` 把 monaco-editor 等传递依赖也收敛进 catalog。配套防误装：根 `preinstall: npx only-allow pnpm` + `engines: { pnpm: 11.13, node: >=22.13 }` + `engineStrict: true`。

### TypeScript 6/7 双轨

`pnpm-workspace.yaml` 注释原文：*"TypeScript 7 has no programmatic API until 7.1, so `typescript` stays aliased to the 6.0-API compat package for tools that import it (typescript-eslint, Next.js build typechecking), while `@typescript/native` provides the native TS 7 `tsc` binary used by typecheck scripts."*——TS 7 是 Go 原生重写（tsgo），7.1 之前没有 JS programmatic API，import 其 API 的工具直接换 7 会挂。两个包在 17 个 workspace 的 devDependencies 同时存在，typecheck 享受 10x 编译速度。`npm:typescript@~7.0.2` 的显式 alias 把差异封装在依赖声明层。

### ESLint ratchet 棘轮

studio（几十万行）的 lint 清零不可能一次完成，ratchet 把它转化为增量过程：`eslint-rule-baselines.json` 记录每条规则当前违规数，PR 跑 `lint:ratchet` 只许减不许增；每周日 cron 跑 `--decrease-baselines` 自动收缩基线并 force-push 到 bot 分支开 PR。**存量豁免、增量冻结、自动收缩**——债务单调递减且零人工。

### e2e 的被测系统组装

`e2e/studio` 是独立 workspace（仅 `@playwright/test`、`@supabase/supabase-js`、faker + `api-types: workspace:*`），`features/` 下 27 个 spec（sql-editor、table-editor、rls-policies、edge-functions、realtime-inspector 等）。被测系统由根 scripts 一条龙组装：`supabase start` 拉起真实 PostgREST/GoTrue/Realtime 后端 + `build:studio` 本地构建 + `serve.js` 启动——E2E 测的是完整栈而非 mock。

### blocks/vue：异质孤岛

`blocks/vue` 是 shadcn 风格的 **Vue registry**（realtime-cursor、realtime-chat、password-based-auth、infinite-query 等 Supabase 功能示例块），依赖 nuxt ^4.4.6 + shadcn CLI。h3 钉 1.15.11 的 override 就是为它服务（两份 h3 会让 `H3Event` nominal 类型不匹配）。**Makefile 已边缘化**——只剩 GitHub API 抓 contributors 的数据脚本（还引用已不存在的 `web/` 目录，属遗留）；真正的任务编排全部在 package.json scripts + turbo。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 版本单一真源 | catalog + overrides | 一致性与供应链安全一并解决 |
| 供应链冷却期 | `minimumReleaseAge: 4320` | npm 投毒防御 |
| 护栏前置 | `check-case-hazards.mjs` 在 install 前跑 | 「护栏必须放在能看到问题的环境」——它抓的 bug 恰是 CI Linux 不可见的 |
| 棘轮 | ratchet workflow + 基线 JSON | 大重构转为 cron 推进的增量过程 |
| 凭据隔离 | autofix 双 job + artifact | patch 通过 artifact 传递而非共享 secret |
| 稀疏 checkout | 多 workflow | lint-ratchet 只拉所需目录省 runner 时间 |
| CDN 直传 | `scripts/upload-static-assets.sh` | 静态资产直传 Cloudflare R2（路径含 commit12），绕开 Vercel egress 计费；self-hosted 构建完全跳过 |

## 模块间交互

子包经 `workspace:*` 协议引用内部包，lockfile 保证一致。`pnpm-lock.yaml` 变更触发所有 paths-filter 含 lockfile 的 workflow（含 E2E 全量 matrix）。`knip.jsonc` 的 ignore 列表（TanStack 迁移文件、动态 import 组件、evals）本身即是文档——哪些文件「看起来死了但其实是动态引用」；注意 knip 目前是本地/手动工具，未挂 CI（进 CI 的死代码治理是 ratchet）。CI 大量用 Blacksmith 托管 runner（2/4/8 vcpu）换速度。

## 扩展方式

**升级共享依赖版本**：改 `pnpm-workspace.yaml` 的 catalog 一行 → `pnpm install`（受 3 天冷却约束，版本发布不满 3 天需入 `minimumReleaseAgeExclude` 或等待）→ SDK 家族检查同系列是否一起升 → push 后 lockfile 变更自动触发全量检查。

**新增 CI 检查**：参照 `typecheck.yml` 骨架（checkout persist-credentials:false → pnpm setup → frozen install）→ 加 `concurrency cancel-in-progress: true` 防同 PR 旧构建堆积 → 关心部分路径用 paths-filter + sparse-checkout → `uses:` 一律 SHA 锁版本并通过 zizmor 扫描。

**新增 studio E2E 测试**：`e2e/studio/features/` 加 `xxx.spec.ts`（27 个现成参照）→ 本地 `pnpm e2e:setup:selfhosted` 复现 CI 环境 → 无需改 CI 配置（`e2e/studio/**` 已在 paths-filter 内自动进 matrix）。
