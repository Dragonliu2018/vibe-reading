---
source:
  type: "源码解读"
  project: "paseo"
  url: "https://github.com/getpaseo/paseo"
title: "Forge 与工作区"
date: "2026-09-18T00:03:35+08:00"
category: [AI, Agent, "AI Coding", paseo, CodeWiki, "0.8.0"]
contentType: "CodeWiki"
tags: ["paseo", "TypeScript", "Git", "Forge", "Worktree"]
description: "paseo Forge 与工作区服务——开放式 ForgeRegistry 注册 5 品牌 3 adapter、GitHub 单账号 GraphQL 预算批量轮询、workspace 的 cwd/worktreeRoot 双目录模型、Linux 目录级 inotify 观察与 canary 健康检查。"
readingTime: "24 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/paseo/CodeWiki/0.8.0/00-overview)

---

## 模块定位

`packages/server/src/services/`（forge 集成，~11,400 行）加 `server/worktree/`、`server/worktree-core.ts`、`server/session/workspace-provisioning/`、`server/file-observer/`、`server/file-explorer/` 及 `src/server/` 根部的 workspace/git 服务，回答"**Paseo 怎么理解代码仓库这件事**"：这是哪家 forge 的仓库、当前在哪个 PR 上、workspace 是目录还是 worktree、哪些文件变了。Paseo 的 PR 状态展示、auto-merge、worktree 隔离、文件浏览器全部建立在这层上。

## 模块架构

```
services/
├── forge-registry.ts        # 开放组合边界（5 品牌 3 adapter）
├── forge-resolver.ts        # cwd → origin remote → host → forge（LRU 缓存）
├── forge-service.ts         # ForgeService 接口（PR/issue/merge 全操作面）
├── github-service.ts（126KB）/ gitea-service.ts / gitlab-service.ts
├── github-facts.ts / gitea-facts.ts / gitlab-facts.ts   # adapter 私有类型与 guard
└── forge-cli-command.ts     # gh/glab CLI 桥

server/ 根部
├── worktree-core.ts         # createWorktreeCore()（git 命令提权 high）
├── paseo-worktree-service.ts、auto-archive-on-merge/
├── workspace-registry*.ts   # workspace 记录权威
├── workspace-git-service.ts # git 观察（god node：125 边）
└── file-observer/ + file-explorer/
```

## 调用链路

**一次 forge 操作的链**（以 `checkout.forge.set_auto_merge` RPC 为例）：

```
checkout.forge.set_auto_merge.request
└── handleCheckoutForgeSetAutoMergeRequest()
    in server/session/checkout/checkout-session.ts
    # 同时接受旧名 checkout.github.set_auto_merge（COMPAT，v0.2.0-beta.1 引入）
    ├── resolveCurrentPullRequest()      # 从 workspaceGitService snapshot 拿当前 PR
    ├── requireForgeService(cwd)         # 经 resolver 取 adapter
    │     └── forge-resolver.ts: cwd → remote → host → registry.matchHost
    ├── enablePullRequestAutoMerge() / disablePullRequestAutoMerge()
    └── notifyGitMutation({invalidateForge: true})   # 刷新缓存
```

<details>
<summary>服务速查表</summary>

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `ForgeRegistry` | `services/forge-registry.ts` | 开放注册：`ForgeAdapterRegistration {createService, matchesHost?, probeHost?}` |
| `defaultForgeRegistry` | `services/forge-registry.ts` | github/gitlab/gitea/forgejo/codeberg（后两者复用 Gitea service） |
| `createForgeResolver()` | `services/forge-resolver.ts` | host → forge 解析，LRU 512，负结果 60s TTL |
| `runGitHubPollBatch()` | `services/github-service.ts` | `GITHUB_POLL_BATCH_MAX = 25` 批量轮询，快慢双档 20s/120s |
| `createWorktreeCore()` | `server/worktree-core.ts` | worktree 创建/归档核心（`runWithGitCommandPriority("high")`） |
| `archiveByScope()` | `server/workspace-archive-service.ts` | worktree scope 校验 `isPaseoOwnedWorktreeCwd` |
| `setupAutoArchiveOnMerge()` | `server/auto-archive-on-merge/` | PR 合并后自动归档 |
| `FileObserver.subscribe()` | `server/file-observer/index.ts` | 递归目录观察（带 ignore 更新） |
| `listDirectory()` | `server/file-explorer/service.ts` | 按需列举 + 乐观并发读写 |

</details>

## 核心实现

### Forge 抽象：开放组合边界

`ForgeRegistry`（`forge-registry.ts`）是开放式组合边界——注册项为 `ForgeAdapterRegistration {createService, matchesHost?, probeHost?}`。`defaultForgeRegistry` 注册 5 个品牌 3 个 adapter：github/gitlab/gitea/forgejo/codeberg，其中 forgejo 与 codeberg 复用 `createGiteaService`（Gitea 家族）。`matchHost` 从 protocol manifest 的 `cloudHosts` 派生（`matchesCloudHost()`，registry 不硬编码主机表）；自托管/GHES 靠 `probeHost` 运行时探测。**歧义处理**：多个 adapter 同时认领一个 host 时降级为 "no forge" 并 `#warnAmbiguous` 每主机只警告一次——这条路径被每个 workspace 的 PR 状态轮询共享，崩溃代价不可接受（`forge-registry.ts:100-103` 注释）。

`createForgeResolver()` 按 cwd 解析 origin remote → host → forge，LRU 缓存（`FORGE_RESOLVER_CACHE_MAX = 512`）；探测结果正结果永久缓存、负结果 60s 过期（后装的 CLI 无需重启即生效）；并发探测合并。信任门：只与已知云主机或已认证 CLI 的主机通信，probe 不做匿名 HTTP。

### facts 层与开放信封

`github-facts.ts` 等是 adapter 私有的类型与 guard（如 `GitHubPullRequestStatusFacts` 含 `mergeStateStatus`、`autoMergeRequest`、`viewerCanEnableAutoMerge`、merge 方法开关、merge queue 状态）。协议侧 `forgeSpecific` 是**开放信封**（`z.object({forge: z.string()}).passthrough()`），`forge` 字段是 facts 家族标签而非品牌 id（Forgejo/Codeberg 也发 `forgeSpecific.forge === "gitea"`）——老客户端收到新 forge facts 时中性降级而非解析失败，这是版本偏斜容忍的核心设计。

### GitHub service：单账号预算批量轮询

`createGitHubService()`（`github-service.ts`，126KB 工厂闭包）最大的特点是**单一账号级 GraphQL 预算**：`GITHUB_POLL_BATCH_MAX = 25` 批量轮询（`runGitHubPollBatch`/`flushDueGitHubPolls`），快慢双档（20s/120s）、错误退避封顶 300s、rate limit 耗尽时 `pauseGitHubPollsAfterRateLimit` 暂停到 reset 时间——文档明确禁止在轮询路径加 per-target 请求。

### workspace 与 worktree：cwd / worktreeRoot 双目录

workspace 记录（`docs/data-model.md`）：`cwd` 是**精确执行目录**、`worktreeRoot` 是**后备 checkout 根**（精确 subproject 在 worktree 内时二者不同）；`isPaseoOwnedWorktree` 决定 Paseo 可否删除/重建；`mainRepoRoot` 用于恢复重建后按 `worktreeRoot→cwd` 相对路径还原。**所有权唯一来源是 `workspaceId`**（opaque `wks_<hex>`，不可当路径解析），运行时禁止从 cwd 推断所有权。所有写入（目录打开、agent 导入、worktree 创建）统一经 `session/workspace-provisioning/workspace-provisioning-service.ts` 进 registry——单一入口保证记录一致性。

worktree 操作：`server/worktree/commands.ts` 是 RPC 薄层，核心在 `worktree-core.ts` 的 `createWorktreeCore()`（经 `runWithGitCommandPriority("high")` 提升 git 命令优先级）；意图解析在 `resolve-worktree-creation-intent.ts`（branch-off vs checkout vs PR checkout）。归档时 `archiveCommand` 校验 `isPaseoOwnedWorktreeCwd`（scope=worktree 时非 Paseo owned 拒绝 `NOT_ALLOWED`）；`auto-archive-on-merge/` 的 `archiveIfSafe()` 实现 PR 合并后自动归档——workspace 生命周期与 agent 生命周期（02 篇）刻意分开管理。

### file-observer：平台分策与 canary

`FileObserver.subscribe(directory, callback, {ignore})` 的后端策略（`internal/`）：`linux.ts` 目录级 inotify 自管理（`MAX_WATCHED_DIRECTORIES = 5,000` 上限）与 `native-recursive.ts`（macOS/Windows 单一原生递归 watcher + 目录索引清单，250,000 条目上限后降级 polling）。**明确禁止**换 `fs.watch({recursive:true})`——Node 22 的 Linux 递归实现是 JS 层遍历整棵树逐个 watch，Paseo 早期目录级实现曾耗尽资源（PR #794）。

所有权模型：观察服务在"拥有方服务边界"创建（WorkspaceGitService），消费方只给 root + 排除子树，不许分支平台或管理子 watcher；`unsubscribe()` 是 awaited barrier（resolve 后无残留 scan/事件/native handle）；teardown 必须容忍 root 已被改名/删除（归档正在删目录）。健康机制：`watcher-liveness-canary.ts` 在 .git 目录内一次性 canary 验证订阅真的收到事件，失败降级有界轮询。

### file-explorer：乐观并发

`file-explorer/service.ts` 按需 `listDirectory`（entry 含 size/modifiedAt）+ `readFile`/`writeFile` 带**乐观并发**：文件版本三态（ready/missing/error）+ `revision`（stat 派生指纹），写入带 `expectedModifiedAt`/`expectedRevision`，冲突返回 `conflict` 版本而非覆盖。git 感知点仅在 rename（先 `rev-parse --is-inside-work-tree` 再 `git mv`）。注意单文件观察（`file-explorer/observer.ts` 的 per-file watch + debounce）与 `file-observer/` 的递归目录观察是**两套**，共享名字易混淆。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 开放注册表 | `ForgeRegistry` in `forge-registry.ts` | 新 forge 无需加分支（registry 注释 L16-19 明言） |
| 开放信封 + passthrough | protocol 的 `forgeSpecific` | 新 facts 老客户端中性降级 |
| 歧义降级 | `#warnAmbiguous` in `forge-registry.ts:100` | 共享轮询路径不可崩 |
| 单一写入口 | `workspace-provisioning-service.ts` | workspace 记录一致性 |
| canary 健康检查 | `watcher-liveness-canary.ts` | watcher 静默失败可检测 |
| 乐观并发 | `file-explorer/service.ts` | 多端编辑不静默覆盖 |

## 模块间交互

- 上游：checkout 域的 session 分发器（01 篇责任链）调用 forge 操作与 worktree 命令；
- 横向：`auto-archive-on-merge` 与 02 篇 agent 生命周期协作（PR 合并 → workspace 归档 → agent 关闭但未必归档）；workspace-git-service 的观察数据喂 timeline 的 changes/diff tab（10 篇）；
- graphify god nodes：`WorkspaceGitServiceImpl`（125 边）、`RunGitCommand`（103 边）、`PersistedWorkspaceRecord`（86 边）。

## 扩展方式

新增一家 forge（`docs/forge-providers.md` checklist）：

1. 可选：`packages/protocol/src/forge-manifest.ts` 加 `ForgeDefinition`（label/nouns/云主机）；
2. `packages/server/src/services/acme-service.ts` 实现 `ForgeService` + 旁置 `acme-facts.ts` + `defaultForgeRegistry` 一条 entry；
3. app 侧逻辑/视图双模块（`packages/app/src/git/forges/acme.ts` + `acme.view.tsx`，分别注册进 `CLIENT_FORGE_LOGIC_MODULES`/`CLIENT_FORGE_VIEW_MODULES`——拆分是为 Node e2e 不拉 react-native）。

若 CI 数据模型装不进现有 `ForgeService` 字段，**加宽共享接口**而不是伪造值（先例：Gitea Actions 无 check-run id → `GetCheckDetailsOptions.checkRunId` 变可选、加 `workflowRunId`）。禁止：协议 typed-union arm、中心 facts/icons/colors map、给 normalized status 加 provider 词汇（用 `packages/protocol/src/check-traits.ts` 的 trait 常量）。
