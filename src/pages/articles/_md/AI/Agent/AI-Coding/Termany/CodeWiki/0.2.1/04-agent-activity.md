---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "活动与会话历史"
date: "2026-09-18T15:47:48+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "状态机", "JSONL"]
description: "Termany 的双层活动感知：server 端 AgentActivityTracker 是无 TTL 的状态账本（输入行回放、OSC 778、TUI 横幅、前台进程组四路证据 + epoch CAS），web 端渲染屏分析器（spinner/确认菜单/时钟 mask）；外加 Claude/Codex JSONL transcript 的流式解析与 token 用量。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

README 承诺 "Termany tags each pane *working*, *done*, or *needs attention*"，且 "It reads the pane's foreground job and the changes on screen, not the shell prompt, so the tag also works for agents that draw their own interface"。这个承诺的实现是一个**双层感知架构**：server 端 `AgentActivityTracker`（`agentActivity.ts`，591 行）持有跨窗口一致的活动账本；web 端 `agentActivityPrompt.ts` + `agentIdleWatcher.ts` 分析**渲染后的屏幕**（自绘 TUI 的 agent 运行期没有 shell 提示符可读，shell 集成/OSC 133 对它们失效）。两层经带 epoch 校验的 HTTP report 接口单向回写。

同模块还包含两块独立能力：`agentSessions.ts`（656 行）流式解析 Claude/Codex 本地 transcript 支撑会话历史与 token 用量视图；`foregroundJob.ts`/`sessionPorts.ts`/`systemStats.ts` 是前台进程采样、端口发现、系统资源监控。

## 模块架构

```text title="活动感知的证据流"
                 ┌─ server：AgentActivityTracker（状态账本，无 TTL）────────────┐
noteInput        │ 512 字符输入行回放 → BUILTIN_AGENT_COMMANDS 命中 → startTask │
noteOutput       │ OSC 778;working|done|error（权威）                          │
                 │ OSC 0/2 窗口标题正则（tmux 式状态栏 agent）                   │
                 │ outputTail 4096 字符的 TUI 启动横幅强签名 → startTask        │
noteForegroundJob│ 进程组归还（唯一不可伪造的证据）→ working 落 done             │
                 └───────────────────────────────────────────────────────────┘
                 ↑ reportIdle / reportWorking / reportBlocked（带 taskEpoch CAS）
                 ┌─ web：屏幕分析 ─────────────────────────────────────────────┐
agentActivityPrompt │ 纯函数谓词：busy spinner / 输入行 / 确认菜单 / shell 提示符│
AgentIdleWatcher   │ 每会话状态机，无 timer/DOM/网络，可对录屏重放              │
                    └──────────────────────────────────────────────────────────┘
```

Server 侧账本刻意**没有 TTL**（`agentActivity.ts:135-139` 注释："silence is not evidence that a task stopped"）——与端口探测的"每次现查"形成对照：端口是瞬时事实（`no-store`），活动是累积事实（必须显式 ack 才清）。

## 调用链路

一次"agent 干完活"的完整判定链：

```text
agent 输出流 → pty.onData → emit()（index.ts:483）
├─ activityTracker.noteOutput(id, data)        （server 侧四路证据）
├─ jobSampler.noteOutput()                     （150ms trailing debounce）
│    └─ 输出静默后读 session.pty.process → noteForegroundJob
│         └─ away-and-back 转移（agent 进程死、shell 收回终端）→ working 落 done
└─ ws.send → web writeSessionData → term.write 渲染后回调 finishSessionWrite
     └─ completeAgentActivityIfIdle（manager.ts:560-689）
          ├─ observeScreenForActivity → watcher.update(view, now)（喂渲染屏）
          │    transition()：确认菜单→error / busy→veto / 输入行空闲→done
          ├─ 屏幕签名变了就重 arm 静默窗（AGENT_IDLE_QUIET_MS = 2000ms）
          └─ deadline 到期且 epoch 未变 → POST /api/activity/report (reportIdle)
               └─ server 按 status 分派（index.ts:714-746）
```

API 面：`GET /api/activity`（全量快照，server 持有以跨窗口一致）、`GET /api/activity/events`（SSE，每次推**完整快照**而非增量——重连自愈不依赖转移序列）、`POST /api/activity/register`（UI 启动 agent 时权威开新任务）、`/ack`（确认后删 done 条目——但 agent TUI 仍持有输入时**拒绝删除**，386-390 行注释：此时绿点是活跃会话的当前状态，不是一次性通知）、`/report`。

## 核心实现

### 证据分级与 epoch CAS

四路证据按可信度排：屏幕内容（可伪造、可过时）< OSC 778 显式上报（权威）< 前台进程组归还（不可伪造）。OSC 解析由手写的 `extractOsc` 状态机完成（542-590 行）——处理 BEL `\x07` / ST `\x1b\\` 两种终止符、**跨 chunk 不完整序列暂存 `pendingOsc`（上限 2048 字符，超长丢弃）**。自定义 **OSC 778** 的载荷正则是 `/^778;(working|done|error)(?:;([^\r\n]*))?$/i`——全仓库只有解析端没有发送端，它是留给外部集成/wrapper 的逃生舱（`agentActivityPrompt.ts:14` 注释："Agents that report their own state over OSC 778 bypass this heuristic entirely and should be preferred wherever possible"）。窗口标题（OSC 0/2）由 `statusFromTitle` 按分隔符切字段后匹配三张正则表，同样只是可伪造证据之一。

`taskEpoch` 是单调递增的 CAS 代数（`startTask`，到 MAX_SAFE_INTEGER 回绕），所有屏幕证据只允许改写**其观察到的那个代数**，防旧观察污染新任务。最精细的不变式是 `reportWorking` 的 green latch（agentActivity.ts:313-329 长注释）：一次已读的真完成不许被输出吞掉；但 agent 停滞超过客户端静默窗会被误判完成，此后屏上任何内容都无法翻案——唯一例外是**同一 epoch 的 spinner 还在 repaint**（= 任务从未结束）。且 `reportWorking` 只翻状态、绝不收回 pty 归属。

### 输入行回放与横幅强签名

`noteInput`（180-206 行）逐字符模拟一个 512 字符的输入行缓冲（`\r` 提交、`\x03`/`\x15` 清空、退格），Enter 时查 `BUILTIN_AGENT_COMMANDS` 表（claude/codex/cx/gemini/grok/openclaw/fastclaw/hermes/opencode/kilo/cursor-agent/kimi/droid/omp → 规范名）。`register()` 的 `awaitingRegisteredInput` 标志防止 UI 已权威注册后、用户提交 prompt 的那次 Enter 被输入行回放重复开一个 epoch。防 DoS：只扫前 8192 字符（`MAX_INPUT_SCAN_CHARS`）——巨型粘贴只保留"Enter 提交给活跃 agent"这一个可能有转移意义的动作。

`noteOutput` 后半维护 4096 字符 `outputTail`，跑两档检测：`detectedAgent`（宽松产品名匹配）**只改标签不启动任务**——"arbitrary shell output mentioning 'Codex' is not proof that an agent task started"（防 `echo "Codex"` 伪造）；`detectedInteractiveAgent`（113-131 行）要求真 TUI 启动界面的稳定部件（如 Codex 的 `>_ OpenAI Codex (v…) … /model to change`），且两部件须在 1500 字符内共现，命中才允许 `startTask`。细节：Claude 正则结尾不加 `\b`，因为剥转义后版本号会直接粘到名字上（"Claude Codev2.1.220"）。

### web 侧：屏幕谓词与静默窗

`agentActivityPrompt.ts`（纯函数层）的谓词全部来自对真实录屏的观察：`agentBusyScreenVisible` 扫底部 12 行匹配 spinner 字形行（`SPINNER_GLYPHS` 是 Claude 实测帧序）、带 `…` 尾的动词行（Claude 的动词从轮换池抽取，词表追不上——**用省略号区分进行中与完成后的摘要行**）、`esc to interrupt`；⏺ 工具标记故意排除（tool 行比调用活得久）。`agentConfirmationPromptVisible` 识别确认菜单（问题 + 选项 + 选中标记 + 导航指令的组合逻辑）→ status "error"（等人 ≠ 完成）。`screenSignature` 把屏幕文本中的**环境时钟**（HH:MM、日期）替换成 MASK 再做指纹——否则一个带时钟的提示符每秒 repaint 一次能把会话永远钉在黄点；但刻意**不** mask 时长/计数器：agent 自己的 "(23s · ↑ 1.2k tokens)" 正是携带工具回合穿过无 busy 标记期的证据。

`AgentIdleWatcher` 每 session 一个，**无 timer/DOM/网络**（可对录制会话回放整段判定）。静默窗 `AGENT_IDLE_QUIET_MS = 2_000` 的注释给出实测依据：Claude 录制回合中 repaint 最大间隔 454ms（纯回答）/962ms（工具驱动），2x 余量。manager 侧 `completeAgentActivityIfIdle` 处理"过早 done 被忙碌证据推翻"的回收（同 epoch 无副作用拉回 working，不往 pty 写字节——"把用户手动按 Enter 强制变黄做成自动化"）。

### transcript 解析：正则而非 JSON.parse

`agentSessions.ts` 文件头注释（1-13 行）即文档：claude 在 `~/.claude/projects/<path-slug>/<uuid>.jsonl`（正则只收顶层会话，排除 `agent-*.jsonl` 子代理 transcript）；codex 在 `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`。全部 `readline.createInterface` 流式读。**token 行用正则而非 `JSON.parse`**——"some lines are megabytes"。Claude 的 usage 去重：一条 assistant 消息写成多行（每 content block 一行，重复同一 usage），按 `msg_id:requestId` 去重；`isSidechain:true`（子代理）只算 contextTokens。Codex 的 `total_token_usage` 是累计值，"last one wins"；`last_token_usage` 的 cached 计入了 input_tokens，需拆出对齐 claude 字段语义。

双缓存（"full" 含 token / "session" 仅头部 40 行）+ inflight Promise 去重——打开历史浏览**绝不**把廉价的头部读升级成 GB 级 usage 扫描；**缓存键以 `mtimeMs:size` 校验文件未变**，变了才重解析。`listAgentSessions()` 的 cursor 是**文件偏移而非行偏移**（572-574 行注释），roots 过滤非匹配文件时 cursor 仍前进。每行返回前对 cwd 做 `fs.stat` 存活检查——**每次请求现查，不缓存**（"the parse cache outlives worktrees"），失败打 `cwdMissing: true`，前端据此归入 "Deleted worktrees" 分组并从主 checkout resume。

价格表**不在 server 在前端** `AgentUsage.tsx:25-39` 的 `PRICING` 前缀匹配表——职责分离：server 出原始 token，web 出可随时更新的估价（匹配不上的模型仍计入 token 总额但排除出成本卡）。`listAgentUsage` 把日期钳到滚动 31 天窗，按 `agent|project|date|model` 归并。

### 前台进程采样与端口发现

`sampleOnceOutputSettles`（foregroundJob.ts:57-76）不是定时轮询：**输出触发 + trailing debounce**（150ms）。选 trailing 而非 leading 的理由（52-55 行注释）：进程接管/退出终端必打印东西（shell 至少重画提示符），空闲会话零开销无需 timer；而最重要的采样是 turn 最后一个 chunk 之后那次——刚 fire 过的 leading 节流会错过。采样读 `session.pty.process`（resolve master fd 上的 tcgetpgrp()），比较的是 **shell 自报的名字而非 spawn 参数**（macOS `/bin/sh` 自报 "bash"）；`noteForegroundJob` 只认 **away-and-back 转移**——`sawForegroundCommand` 标志在 job 离开 shell 时置位，回到 shell 才结算并复位；从不离开 shell 的 job（Windows conpty 全程报 shell、ssh 本地 job 永远是 `ssh`）必须什么也不得出结论。

`sessionListeningPorts`（sessionPorts.ts:119-131）用 `lsof -nP -iTCP -sTCP:LISTEN` + `ps -Ao pid=,ppid=` 两次外部命令：从每个监听 pid **向上走父链**判断"此 pane 或其后代"（dev server 通常是 shell→npm→vite 孙进程；机器上只有个位数进程在监听而进程表有几百行，上行匹配远便宜于下行展开），深度封顶 64 防坏表死循环。2s TTL 探测缓存让多 pane 同 tick 共享一次 probe。**best-effort 降级**：无 lsof/ps 或 Windows 返回空，端口按钮干脆不出现（14-17 行注释："exactly as it did before this feature"）。设计动机（头注释）：pane 里 "Port 3000 is in use" 这行字永远留在 scrollback 里——**前端不信任文本，文本里看到的 URL 与内核的活体答案求交**。

`readSystemStats`（systemStats.ts:459-480）：CPU 基于 `os.cpus()` 累计计数器差分；内存**刻意不用** `total - os.freemem()`（macOS freemem 只数 free list，开机久的机器永远 ~100% used）——macOS 走 `vm_stat`（active+wired+compressed 作 used，页面大小从输出解析），Linux 走 `/proc/meminfo` 的 `total - MemAvailable`；swap 走 `sysctl`/meminfo；memory pressure 是启发式近似而非内核指标——三档判定：committed>0.92 或 compressed>0.3 或 swapped>0.75 → critical；committed>0.75 或 compressed>0.15 或 swapped>0.35 → warning（148-149 行）。进程按可执行名分组、**返回全集而非 top-N**（308-309 行注释：截断会悄悄藏掉用户正在搜的东西）。`killProcess` 的护栏：只允许 SIGTERM/SIGKILL、拒绝 pid≤1、**拒绝杀 server 自己**；ESRCH 翻译成 `KillError("process is already gone")`、EPERM 翻译成 "not permitted — the process belongs to another user"（499-500 行）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 状态机 + epoch CAS | `AgentIdleWatcher.transition()` + `taskEpoch` | 屏幕证据可伪造可过时，代数隔离旧观察 |
| 证据分级 | 四路证据按可信度排列 | 进程组是唯一不可伪造的来源，故为终局证据 |
| 双层感知 | server 账本 + web 屏幕分析 | 跨窗口一致性与渲染屏可读性各取所长 |
| 录屏即测试 | `fixtures/agent-screens/*.txt` | 启发式的每条规则都有真实屏幕作证据 |
| 双缓存 + inflight 去重 | `agentSessions.ts` 的 full/session 两档 | 廉价浏览不触发昂贵扫描 |
| trailing debounce | `sampleOnceOutputSettles` | 输出标记了所有值得采样的转移 |

## 模块间交互

上游：`index.ts` 的 `emit()` 把输出喂给 tracker 与 jobSampler；`wss` 的 input 帧喂 `noteInput`；web 侧 manager 的 `completeAgentActivityIfIdle` 经三个 report 端点回写，SSE `/api/activity/events` 推全量快照（带 `activityInstance` pid+时间戳区分 server 重启）。下游：TreeSidebar 的 ACTIVE 区消费快照把有活动的页浮到顶部（error > running 排序）；`AgentHistory.tsx` 经 `/api/agent-sessions` + `/api/git/worktrees` 组合出跨 worktree 分组；updater 的 `relaunchApp` 查 running 任务决定能否升级。`agentSessions` 与 git.ts 无直接 import——worktree roots 由前端传入。

## 扩展方式

**新增一种 agent 的活动识别**：server 侧 `BUILTIN_AGENT_COMMANDS`（agentActivity.ts:52）加命令映射；有稳定启动横幅就加强正则到 `detectedInteractiveAgent`；设终端标题的 agent 可能已被 `statusFromTitle` 的三张表覆盖。前端若 spinner/composer 字形不同，扩 `SPINNER_GLYPHS`/`AGENT_GLYPH_PROMPT_RE` 并录 fixture 进 `agent-screens/`，补 `agentActivityPrompt.test.ts`/`agentIdleWatcher.test.ts` 用例。

**新增一个 transcript 来源**（如 gemini-cli）：`agentSessions.ts` 写 `listGeminiFiles()` + `parseGeminiFile()`（token 提取仿 `parseClaudeFile` 的正则流）+ `parseGeminiSessionHead()`，在 `PROVIDERS` 注册——`listAgentSessions`/`scanAgent`/`supportedAgents` 自动接入，路由无需改。前端 `AgentUsage.tsx` 的 `PRICING` 加模型前缀价格。

**调整判定可靠性参数**：静默窗 `AGENT_IDLE_QUIET_MS`（调高只延迟绿点，调低会过早完成仍在跑的任务）；采样延迟 `JOB_SETTLE_MS`；端口探测共享窗 `PROBE_TTL_MS`。
