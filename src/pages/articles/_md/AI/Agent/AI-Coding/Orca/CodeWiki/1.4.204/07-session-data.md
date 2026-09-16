---
source:
  type: "源码解读"
  project: "orca"
  url: "https://github.com/stablyai/orca"
title: "会话数据层"
date: "2026-09-16T17:05:03+08:00"
category: [AI, Agent, "AI Coding", Orca, CodeWiki, "1.4.204"]
tags: ["Orca", "会话数据", "journal"]
description: "把黑盒 agent 变成结构化会话：append-only journal 的 epoch 隔离与 write-ahead 回执、ai-vault 的增量 parse cache、hook server 的唯一 status store。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/00-overview)

---

## 模块定位

agent 是黑盒 CLI：Orca 不控制其内部，只能从两条通道获得结构化会话数据——**被动读磁盘产物**（`src/main/native-chat/` 的 session-file-resolver + `src/main/ai-vault/` 的扫描解析）和**主动埋点上报**（`src/main/agent-hooks/` 装进 agent 终端的 hook）。读到的数据汇入两套呈现：AI Vault 会话列表（历史 resume）与 Structured Agent Session 实时流（journal + wire）。

## 模块架构

![会话数据流](/vibe-reading/images/articles/orca-internals/session-data-flow.svg)

三条汇聚管道 + 一个 append-only journal。左列是 agent 留下的客观痕迹；中间两条管道分别是磁盘扫描（历史）与 hook 上报（实时、含权威 `transcriptPath`）；右列 journal 是落盘真源，向下经订阅者增量推送到 renderer/mobile。

## 调用链路

一次会话列表刷新：

```text
renderer AI Vault 面板（~5s 强刷）
  → ipc/ai-vault.ts: listAiVaultSessions()（scanKey = scope + host + depth）
  → AiVaultScanCoordinator.run({key, force, signal, start})
     # 同 key 单飞：最后一个 waiter 离开才 abort（settled 后不 abort）；
     # forced scan 在 FORCED_SCAN_PREEMPT_AFTER_MS = 5s 后可抢占挂死的
     # scan（canPreemptForForcedScan：#11364——legacy SSH file-stream reader
     # 无 inactivity timer，不抢占则面板空到重启）；
     # 被抢占 scan 的 waiter 经 ScanEntry.preemptedBy 同步 re-join 替换 scan
     # （不会把别人的刷新误报成自己的取消）
  → session-scanner.ts: scanAiVaultSessions()
     1. ensureSessionParseCacheLoaded()   # 缓存先于任何 parse（#9210）
     2. discoverAiVaultSessionSources()   # 各 agent root（含 WSL distros）
     3. parseSessionCandidates()          # 8 并发 + mtime 递减序早停
     4. dedupeCodexSessionsBySessionId → sort → slice(limit)
     5. mergeSessions(capped, scope)      # in-scope 不受 recency cap
     6. scheduleSessionParseCachePersist()
  → AiVaultListResult → IPC 回 renderer
```

会话文件定位（`native-chat/session-file-resolver.ts` 的 `resolveSessionFilePath`）三级优先：hook 上报的 `transcriptPath`（authoritative——新 Claude Code 的 transcript 文件名 UUID 与 hook session_id 不同，按 id 重建路径会漏）→ 按 session id 逐 root 扫描 → WSL distro 兜底（lazy tier，因为枚举 WSL home 要 `wsl.exe` 逐 distro spawn，会 boot 用户关掉的 distro）。`transcriptAgent satisfies never`（:222）：新增 agent 不选 resolver 直接编译失败。

方法速查表：

<details>
<summary>会话数据层关键方法速查</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `parseAgentSessionFileCached()` | 增量解析 | mtime+size 不变直接复用；append-only JSONL 从上次字节续读 |
| `appendSubmission()` in journal | write-ahead 写用户消息 | "Durable BEFORE the adapter dispatches anything" |
| `receiptFor(clientMessageId)` | 幂等回执 | 崩溃后重连回答"我的消息发出去没有" |
| `applyEvent()` in hook server | 状态收敛 | retired pane 直接丢弃（#12447 防幽灵 `--resume`） |
| `replayCachedPayloadsForPanes()` | 重连重放 | request-driven：客户端主动拉，非服务端盲推 |
| `resolveSessionFilePath()` | 定位会话文件 | hook transcriptPath 优先于 id 重建 |

</details>

## 核心实现

### AgentSessionJournal：append-only + epoch + upcast

每个会话一个 journal store（`native-chat/agent-session-journal/journal-store.ts`），文件头注释即设计宣言："Append-only journal store for one agent session"。构造时经 `createJournalStoreCollaborators` 组装 rowWriter / epochController / itemAppender / lifecycleBatchAppender / restore 五个协作者，写入全部经 `JournalWriteQueue` 串行化（"Serializes sequence assignment with the durable write behind it"——**序列号分配与落盘原子绑定**）。

Row 类型（`journal-row-schema.ts`）：`JournalEpochRow | JournalItemRow | JournalTombstoneRow | JournalSubmissionRow | JournalDispatchRow | JournalLifecycleBatchRow`，每行带 `{v, epoch, seq, fence, ts}` 基座。三个关键语义：

- **`JournalSubmissionRow` 是 write-ahead 行**——用户消息先落盘再发给 agent，崩溃后重连可凭 `receiptFor()` 回答"到底发出去没有"（幂等回执）；
- **`JournalEpochRow` 开新 epoch 隔离不可信前缀**——绑定 `AgentJournalEpochReason`（`session_created / legacy_import / corruption / unreconcilable_prefix / handle_forked / schema_unreadable`）：损坏或无法和解的前缀不是删改，而是开新 epoch；
- **版本演进只在读时**——`parseJournalRow` 读时 upcast；`version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION` 返回 `{ok:false, unreadable:true}`，调用方必须**降级为 read-only 而非跳过**（文件头："A row whose version this build does not understand is UNREADABLE, not skippable"）。

### parse cache：renderer 每 5 秒强刷不能重读 GB 级 transcript

`parseAgentSessionFileCached`（`session-scanner-parse-cache.ts`）的函数注释给出了动机（STA-1278/STA-1417 "main process pegging one core"）。三级：mtime+size 不变直接复用；append-only JSONL 用 `ResumableSessionParseState` 从上次消费字节续读（`resumableStateFactoryFor` 只对 claude/codex/cursor/copilot/droid/gemini-jsonl/antigravity/graph 系开启；grok/rovo/devin 等原地重写的整 JSON 只走 unchanged-only）；变了且不可续则全量。并发安全靠 per-path lane（"a concurrent parse of the same path shares this entry's resume point"）。远端扫描有独立的天花板：`limitRemoteScanFilesystemConcurrency` 共享 8 in-flight（why："nested fan-out put ~64 filesystem round trips on one SSH mux or relay event loop at once, blowing the scan budget and starving pty/fs/hook traffic"）。OpenCode 1.17.x 的 SQLite 走独立 worker（协议 type-only + electron-free，"importing it into the worker bundle can never pull the client's Electron dependency across the boundary"）。

### hook server：唯一 status store 与 retired-surface 抑制

`AGENTS.md` 的关键约束："The execution host owns agent status in one store, the hook server's, and every reader (sidebar, `worktree ps`, mobile, dashboard) subscribes to it."——这是 2026-09-09 审计的产物：当时有 **6 个生产者、3 个消费者、main 进程内 3 份重复行**，各读者自定 precedence 导致同一 pane 桌面/手机/CLI 显示不一致。现在的规则：precedence 在**写时**一次裁定并记录 provenance；读者只保留 presentation policy；mirroring is not merging——客户端永不回写观测。

hook POST 的 ingest（`server-ingest-structured.ts / server-ingest-terminal.ts / server-ingest-remote.ts`）做各 agent normalization 后写入 store；`applyEvent()` 的 `isPaneSurfaceRetired(event.paneKey)` 检查抑制幽灵事件——#12447：孤儿进程的完成事件若被缓存/转发，会让重连客户端自动在正被写入的 transcript 上再打一个 `--resume`。listener internals 放在 `shared/agent-hook-listener`，"keeps listener internals in shared/ so the relay can host the same pipeline without Electron"——同一 hook pipeline 既跑主进程也跑 [relay](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/10-relay-cloud)（供远程 SSH host 上报）。

### first-work rename：hook 的典型消费

`buildPosixAgentHookPostCommand`（`agent-hooks/hook-post-command.ts`）在 agent 终端注入 curl：hook 触发把 payload POST 到 `http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/hook/<source>`（base64 头、0.5s connect timeout 避免拖慢 agent）。典型用途 `maybeAutoRenameBranchOnFirstWork`（`first-work-branch-rename.ts`）：fresh workspace 首次 agent 工作时，把自动生成的 creature 分支名换成 prompt 派生的短名。门控 `canRenameOrcaCreatedBranch`（why："a user branch could coincidentally match a creature name; only Orca-stamped worktrees are safe to auto-rename"）。失败路径一等公民：`setRenameError` 写错误徽章，`rememberBranchRenameFailureOutput` 保存截断的 CLI 输出。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Append-only + epoch | `journal-store.ts` | 崩溃/损坏/重连语义统一为"开新 epoch" |
| Write-ahead + 幂等回执 | `appendSubmission` / `receiptFor` | 崩溃恢复的确定性答案 |
| 增量 cursor 复用 | `session-scanner-parse-cache.ts` | 5s 强刷 × GB transcript 的预算约束 |
| 单飞 + 抢占 | `ai-vault-scan-coordinator.ts` | 同 key 合并并发 + 挂死 scan 可救 |
| 单写多读 store | `agent-hook-server.ts` + `docs/reference/agent-status-store.md` | 消除 6 生产者 3 读者的 precedence 混乱 |

## 模块间交互

与 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)：`StructuredAgentSessionHost`（`structured-agent-session-host.ts`，"where the lease, journal, and provider adapter meet"）聚合订阅者、任务队列、handoff、lease 续期——lease 状态机详见 [Agent 运行时核心](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/03-runtime)。与 [Agent Provider 适配](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/06-agent-providers)：transcript-reader/tail-reader/watch 消费 `session-file-resolver` 的结果做实时流；深度集成的 adapter（claude/codex）直接产结构化事件。与 [Relay 云中继](/vibe-reading/articles/AI/Agent/AI-Coding/Orca/CodeWiki/1.4.204/10-relay-cloud)：`RelayAgentHookServer` 复用同一 pipeline，事件经 envelope publication 推到移动端（超帧先 shed 大字段、`interactivePrompt` 最后 shed——阻塞式问题卡是 load-bearing）。

## 扩展方式

**新增一个 agent 的会话文件解析**（以 JSONL 存于 `~/.foo/sessions` 为例）：

1. `shared/native-chat-agent-support.ts`：`resolveNativeChatTranscriptAgent` 认识 'foo'；
2. `native-chat/session-file-resolver.ts`：`resolveSessionFileById` 的 switch 加 case（漏掉撞 `transcriptAgent satisfies never` 编译失败）；新增 `fooSessionsDir()`，root 解析须与 ai-vault scanner 的常量 mirror（OMP 的先例是 `OMP_CODING_AGENT_DIR` 两边同步）；
3. `ai-vault/`：新增 `session-scanner-foo-parser.ts` + `parseAgentSessionFile` switch 加 case + source discovery 注册 + `resumableStateFactoryFor` 决定是否可增量（append-only JSONL 才给 resume state）；
4. SQLite 存储则参照 OpenCode 四件套（worker-protocol / worker-spawn / worker-client / worker-entry）；
5. wire 层若要实时会话：实现 `StructuredAgentSessionAdapter` + `adapterSupportsCreate` 门控，配套 `server-foo-normalization`。

测试规范（AGENTS.md）：终端规则类改动必须按 `docs/reference/agent-pty-transcript-capture.md` 用捕获的 transcript 写，不凭记忆的屏幕。
