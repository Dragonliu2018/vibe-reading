---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "Git Worktree 生命周期"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
contentType: "CodeWiki"
tags: ["Orca", "Git", "Worktree"]
description: "Orca 并行卖点的物理基础：worktree 预创建池（5 分钟 TTL）、552 个海洋生物名退休注册表、五重删除 fence，以及按执行主机隔离的 GitCapabilityCache。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

"一条 prompt 扇出到五个 agent，各在自己的隔离 worktree"是 Orca 的核心卖点，这个模块就是它的物理基础。`src/main/git/`（~250 文件）是 Git 命令执行层（按操作域拆文件，每文件配同名单测 + `*-real-git.test.ts` 真仓库集成测试）；`src/main/` 根下 ~90 个 `worktree-*.ts` 是生命周期编排层（preparation pool、retirement、removal safety、metadata、trash）；`src/shared/worktree/` 是跨进程类型与纯函数。另有 relay 侧镜像 `src/relay/git-handler-worktree-ops.ts`——`worktree-add.ts:234` 注释明确要求两侧 lockstep 修改。

## 模块架构

![worktree 生命周期](/vibe-reading/images/articles/orca-internals/worktree-lifecycle.svg)

模块按"创建预热 → claim 消费 → 名字退休 → 删除 fence"四个关注点切分，每个关注点一组文件、每组带独立测试。创建的完整链路入口在 `runtime-local-git-worktree-create.ts` 的 `createRuntimeLocalGitWorktree()`——runtime 编排层把 git 层的 `addWorktree`/preparation、name retirement、metadata 持久化（Store）、push target 组合起来。

## 调用链路

**创建**（预热命中路径）：

```text
用户打开 base picker（还在打字）
  → register-worktree-prefetch-handler 触发 prepareWorktreeCreateForRepo()
     （worktree-create-preparation.ts:72）
  → 计算 workspaceRoot（异步——WSL 时要 spawn wsl.exe，不能阻塞主线程）
    + canonicalBaseRef()（解析成绝对 commit/ref）
  → findPreparation() 去重 → startPreparation() 入池
  → prepareWorktreeCreateCheckout()（git/worktree-create-preparation.ts:65）
     ├─ withRepoRefMaintenancePaused('worktree-prepare')   # 暂停后台 ref 维护
     ├─ git worktree add --detach --no-checkout <preparedPath> <base>
     ├─ git reset --hard <base>      # 绕过用户 post-checkout hook 物化文件
     └─ git worktree lock            # Git ≥2.25，防 prune 无分支 detached 树

用户提交 create
  → consumePreparedWorktreeCreate()（worktree-create-preparation.ts:213）
     ├─ selectPreparationForCreate()  # exact / retarget / miss / needs-canonical-base
     ├─ retarget 分支：measureRetargetDivergence() 验证偏离容忍
     │   （exceeded → miss reason 'retarget_too_divergent'；
     │    unverifiable → 'retarget_unverifiable'）
     │   然后【重读池再选】——await 后池可能已变，重选后候选
     │   不再匹配则从头走 miss 路径
     ├─ takePreparation(entry)        # 同一同步回合内摘除，防并发双 claim
     └─ finalizePreparedWorktree()
        ├─ 并行 rev-parse 目标基与 prepared HEAD → 不一致则 reset --hard 对齐
        └─ git worktree move -f -f 到最终路径（保留 lock reason）
miss 兜底 → addWorktree()（git/worktree-add.ts:150）
  └─ git worktree add --no-track -b <branch> <path> <base>
     + persistWorktreeCreationBase()（branch.<b>.base config）
     + configurePushAutoSetupRemote()（push.autoSetupRemote=true，先 --get 尊重用户全局配置）
失败退休 → failedWorktreeCreationNeedsRetirement() → retireGeneratedWorktreeName()
```

**删除**（`removeWorktree()`，`git/worktree-removal.ts:32`）：`withRepoRefMaintenancePaused` + `runWithGitReadCacheInvalidation`（删分支要拿 packed-refs 锁）→ `getRegisteredDeletableWorktree()` 五重 fence → `moveWorktreeDirectoryToTrash`（可恢复）→ `deleteBranchAfterWorktreeRemoval`（用户删除保持 `forceBranchDelete=false` 以保留未合并 commit）→ finally 三个缓存失效（WSL routing / sparse checkout / `bumpWorktreeScanGeneration`）。

方法速查表：

<details>
<summary>worktree 关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `prepareWorktreeCreateForRepo()` | 预检入池 | key = repo + workspace + base + wslDistro 四元组 |
| `enforcePreparationLimit()` | 池满驱逐 | 先驱逐**同一 workspace** 最老条目（多 repo 并行工作者的结构性 miss） |
| `rearmPreparation()` | 消费后补树 | 仅在 burst 检测（`worktree-create-preparation-burst.ts`）判定连发时 |
| `retireGeneratedWorktreeName()` | 名字退休 | 用户手敲的名字永不退休（`normalizeRetirableGeneratedName`） |
| `canSafelyRemoveOrphanedWorktreeDirectory()` | 孤儿回收 | 必须由 `.git` 文件内容证明归属——"path shape alone is not authority" |
| `runWithFallback(cap, modern, fallback)` | 能力回退 | `GitCapabilityCache` 30 分钟 retry interval |

</details>

## 核心实现

### Preparation Pool：把 checkout 从提交路径上摘掉

`git worktree add` 的完整 checkout 是创建延迟的大头（注释：一棵树 ≈200 MB tracked content）。预检树让提交时只剩 `worktree move`（重命名级开销）。但预检树有磁盘成本，所以三个约束：(a) TTL 5 分钟（`WORKTREE_CREATE_PREPARATION_TTL_MS`，TTL 定时器 `unref()` 不阻止进程退出，过期驱逐会 abort controller 并后台 discard）；(b) 上限 3（`WORKTREE_CREATE_PREPARATION_LIMIT`）；(c) **rearm 仅在 burst 被证实后**——`rearmPreparation` 先 `recordPreparationConsume`（`continuesBurst` 判定连发，且必须在 `findPreparation` 检查之前记录），替换准备被创建后不 await（后台跑）。`rearmPreparation` 的注释算过账："a replacement costs a full checkout and ~5 minutes of disk until its TTL, so arming one after an isolated create spends that on nobody"（孤立创建后补树等于白花钱）。

`--detach --no-checkout` + `reset --hard` 两段式是刻意的：直接 `worktree add` 会跑用户 post-checkout hook；`--no-checkout` 建骨架后 `reset --hard` 物化文件不触发 hook（`git/worktree-create-preparation.ts:91` 注释）。加 `worktree lock` 防 git 把无分支 detached 树当垃圾 prune。

```ts title="src/main/worktree-create-preparation-pool.ts"
export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000   // 5 分钟过期
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3             // 磁盘上限：3 棵预检树
```

### 名字退休：宁可过度回收的隐私取舍

Orca 用 552 个海洋生物名（`shared/marine-creatures.ts`，tier 化：`nautilus`、`nautilus-2`…）生成 worktree 名。退休注册表（`shared/worktree/retired-name-registry.ts` 的 `RetiredNameRegistry`）采用**水位线 + 显式名单**的紧凑结构而非朴素 Set：`exhaustedTiers` 记录已耗尽的 tier 水位线（一个完整 tier 恰好 552 个名字，`MAX_EXHAUSTED_TIERS` 封顶），`names` 只存落在已耗尽 tier 之外的名字——"Retirement is permanent"，不驱逐只紧凑化，`mergeRetiredNameRegistries` 取两者水位线最大值合并名字集。名字复用的代价是把**上一个 agent 的对话历史目录**交给下一个占用者（retirement discovery 会扫 `~/.claude/projects` 的 cwd 编码 bucket；Codex 刻意不扫——其 cwd 记在会话 jsonl 里，解析等于读用户对话文件）。所以：创建成功（或可识别失败）即退休——`retireGeneratedWorktreeName` 经 `normalizeRetirableGeneratedName` 只把**规范生成器输出**（canonical generator output）持久化，repeat-suffix 变体（如 `nautilus-2-3`）由水位线覆盖不单独存；一次性 backfill seed（`ensureRetiredWorktreeNamesBackfilled` + `discoverRetiredWorktreeNames`，用 `getRepoExecutionHostId` 判本地执行而非 legacy `connectionId`——runtime-owned 仓库误用 connectionId 会既写错地方又漏扫）扫描现存 workspace leaf 名 + Claude projects bucket 补历史已用名；方向性取舍明确——**宁可过度退休**（损失一个池名）也不漏，`collectRetiredNamesFromLeafNames` 注释 "matches generously and never tries to be exact"。

### 删除 fence：Git 自身语义不安全

`assertWorktreeDoesNotContainRegisteredWorktree` 注释指出 `git worktree remove --force` 会把嵌套 worktree 当普通 untracked 目录删掉工作文件、却留下可 prune 的子记录——必须应用层拦截。五重拒绝条件：空路径 / 等于 repoPath / 文件系统根 / 包含 repoPath / 包含 $HOME（`isLikelyPosixHomeDirectory` 匹配 `/home/<user>`、`/Users/<user>` 模式）。孤儿目录回收时 `canSafelyRemoveOrphanedWorktreeDirectory()` 要求 `.git` 文件内容证明归属或 Orca 创建溯源（`orcaCreatedAt`/`orcaCreationSource`）——"path shape alone is not authority"。

### GitCapabilityCache：按 host 隔离的能力探测

```ts title="src/shared/git-capability-cache.ts"
export type GitCapability =
  | 'fetch-no-write-fetch-head'
  | 'for-each-ref-exclude'
  | 'merge-tree-merge-base'
  | 'merge-tree-write-tree'
  | 'rev-parse-path-format'
  | 'worktree-list-z'
```

为什么按 host 隔离（`git/git-capability-state.ts` 的 `localCapabilitiesByExecutionHost` Map + `sshCapabilitiesByProvider` WeakMap）：同一台机器上 Windows 宿主 git、每个 WSL distro 内的 git、SSH 远端的 git 是**不同二进制、不同版本**。30 分钟 retry interval 的注释解释了取值："抑制热循环失败的同时，不要求重启就能检测长会话中的 git 原地升级"。用法是 `runWithFallback(cap, modernCmd, fallbackCmd, classifier)`（如 `remote-rebase.ts:69` 的 `fetch --no-write-fetch-head` vs 裸 `fetch`），fallback 必须在 Git 2.25 基线下可用（AGENTS.md 的兼容契约）。

### WSL 三层处理

(a) capability 按 `wsl:<distro>` 分 key；(b) linked worktree 的 git 命令路由由 `wsl-linked-worktree-git-routing.ts` 决定走 distro 内 git 还是 Windows 宿主 git；(c) 路径用 `toHostFilesystemPath` 区分 host 视角（UNC 前导 `//Server` 会被 `posix.join` 折叠，故必须 win32 ops）。9P 门控读（`worktree-retirement-discovery.ts:68`）：WSL UNC 列目录走 `wslGatedReaddir('scan')` 共享并发门，门拒绝**返回而非抛出**（抛出会让一次扫描整体报废），且不把洞 memoize 成"没有退休名"。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Pool 预热 + 工作区亲和驱逐 | `worktree-create-preparation-pool.ts:108` | 创建延迟大头从提交路径摘掉 |
| Claim-then-take 同步围栏 | `worktree-create-preparation.ts:123-169` | select 与 take 之间允许 await，await 后重读池重选 |
| Capability probe cache | `shared/git-capability-cache.ts` | 新旧 git 并存的能力探测与回退 |
| Defense in depth 删除 fence | `worktree-removal-safety.ts` | Git 语义不安全的操作应用层兜底 |
| Orphan 证明 | `worktree-orphan-gitdir-proof.ts` | 回收孤儿必须证据，路径形态不算授权 |

## 模块间交互

与 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)：`createRuntimeLocalGitWorktree()` 是编排者。与 [Agent Provider 适配](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/06-agent-providers)：agent 在 worktree 内运行，worktree 身份类型在 `src/shared/worktree/id.ts` / `host-qualified-identity.ts`（host 限定身份，区分 local/WSL/SSH host 上的同名路径）。与 [SSH 远程执行](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/09-ssh-execution-host)：远端 git 通过 relay RPC 跑（不是每次 spawn `ssh git ...`），`ssh-relay-session.ts:1206` 的 `registerSshGitProvider` 注册。后台维护协调点：`local-repo-ref-maintenance.ts` 的 `withRepoRefMaintenancePaused` 是 git 写操作的统一互斥点（busy probe 按 repo key 注册，LRU 上限 64）。

## 扩展方式

**支持新 git option**：`GitCapability` union 加名 → 使用处写 `capabilities.runWithFallback(...)` → 补 `git-capability-state.test.ts`（fallback 必须在 Git 2.25 基线下可用，`git-compatibility.md`）。

**改 worktree 命名策略**：改 `shared/marine-creatures.ts`（池内容）或 `creatureNameAtTier`（tier 格式，注意 `nautilus-1` 不算 tier-1 的边界）；`normalizeRetirableGeneratedName`（`worktree-name-retirement.ts:70`）决定什么算"可退休的生成名"——这个区分是 load-bearing 的。

**改 preparation 匹配/驱逐规则**：`worktree-create-preparation-claim.ts` 与 `enforcePreparationLimit`；改 key 构成时必须同步 `prepareWorktreeCreateForRepo` 与 `createLocalWorktree` 两侧的 wslDistro 线程化（`worktree-create-preparation.ts:83` 注释警告过这个坑）。

**改删除规则**：`worktree-removal-safety.ts` + `shared/worktree/removal.ts`（renderer 侧共享的 fence 错误）；lockstep 检查 relay 侧 `src/relay/git-handler-worktree-ops.ts`。
