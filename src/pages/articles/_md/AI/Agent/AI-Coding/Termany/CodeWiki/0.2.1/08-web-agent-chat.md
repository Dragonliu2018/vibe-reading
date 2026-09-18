---
source:
  type: "源码解读"
  project: "Termany"
  url: "https://github.com/thinkany-ai/termany"
title: "Agent 聊天前端"
date: "2026-09-18T15:56:40+08:00"
category: [AI, Agent, "AI Coding", Termany, CodeWiki, "0.2.1"]
contentType: "CodeWiki"
tags: ["Termany", "TypeScript", "React", "多Agent"]
description: "AgentPane/AgentWorkspace 双外观单 runtime 的聊天前端：NDJSON 流式增量组装、~30 个纯函数域模块支撑的群聊体系（lead 成员 JSON 决策路由 + @提及 + [[private:]]/[[a2a:]] 私信协议）、传输契约客户端强校验绝不猜测。"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/00-overview)

---

## 模块定位

web 侧 Agent 子系统分两层：**UI 壳**（`AgentPane.tsx` 2041 行、`AgentWorkspace.tsx` 2130 行 + 十余个组件）与**域逻辑**（根目录 ~30 个 `agent*.ts` 纯函数模块，各带 `.test.ts`）。前者做 orchestration（把 `reply`/`decide` 回调缝进群聊引擎），后者承载全部可测的领域规则——这个拆分不是风格洁癖：这些函数输入 store 类型、输出值/数组，零 React 依赖，可以直接在 Node test runner 里构造 `AgentMessage[]` 断言（`agentGroupChat.test.ts` 466 行覆盖提及路由/决策校验/failover）。

传输对接先纠一个直觉：前端 `api.ts` 只有 `apiPath()`/`apiUrl()` 两个 URL 工具——全部数据流是 `fetch(apiPath("/api/agent/acp/chat"))` 的 **NDJSON 行流**（SSE 只用于 activity/state 两条通知流），消费代码在 `AgentPane.reply()`。

## 模块架构

```text title="聊天子系统的两层"
AgentWorkspace.tsx（工作区级容器，App.tsx 以 appTab="agents" 挂载）
├─ 三栏 messenger：inbox（文件夹/pin/拖拽/过滤）| 会话主体 | Inspector（成员/Topic/设置）
├─ 新 Bot 向导（runtimeChoices = Termany 自带助手 + detectAgentConfigs() 检出的 ACP runtime）
├─ 按 Topic 逐个渲染 AgentPane（hidden={!selected}——切 Topic 不卸载，保住 ACP 会话态）
└─ AgentLauncher / AgentGroupDialog

AgentPane.tsx（单聊天面板，appearance: "pane" | "messenger" 双外观单 runtime）
├─ submit()：构造 reply 闭包 → 群聊走 runGroupConversation()，单聊直接 reply()
├─ reply()：fetch NDJSON → 逐行 JSON.parse → parts 增量组装 → persist/display/replaceReply 三层写入
├─ 权限应答 UI（PendingPermission → POST /api/agent/acp/permission）
└─ composer：@提及补全 / 图片粘贴 / 文件拖放

agent*.ts（~30 个域模块）
├─ agentGroupChat.ts     群聊引擎：决策路由 / failover / handoff / 私信上下文
├─ agentGroupDecision.ts controller JSON 决策请求 + 候选链 failover
├─ agentA2A.ts           Bot↔Bot 委托协议（[[a2a:ID]] 块 + 收件箱投递）
├─ agentPrivateMessages  [[private:ID]] 私信协议
├─ agentMessages.ts      气泡拆分 + messenger 语感提示词
└─ agentTopics / Order / Organization / Deletion / Pagination / Greeting / Install / …
```

**会话身份编码在 id 里**：`groupMemberSessionId(groupId, botId)`、`groupControllerSessionId(groupId, topicId)`（= `group:<gid>:topic:<tid>:controller`）、`directA2ASessionId(src, tgt, topic)`、`agentConversationTopicSessionId` 把"哪个群/哪个 topic/哪个成员/是否 controller"全部编码进 paneId，server 按 paneId 复用 ACP 进程；`removeAgentConversation()` 反向枚举同一套函数算出待清理 session——**跨层共享的正是这几个 id 构造函数**（store.ts 也 import 它们）。

## 调用链路

一轮单聊的完整链路（NDJSON 事件驱动）：

```text
submit()（AgentPane.tsx ~L1063）
├─ 构造 user: AgentMessage（attachments/files/recipients）+ agentReplyPrompt（注入分 bubble 指令
│   与 <!-- message_break --> 分隔符协议，agentMessages.ts:114）
├─ persist(history) → store.setAgentMessages → zustand set → sync.ts scheduleSave（400ms debounce PUT）
└─ reply(null)（fetch POST /api/agent/acp/chat，AbortController 存 abortRef）
     └─ response.body.getReader() + TextDecoder 按行 split → 逐事件 switch：
          delta   → rawText += / parts 追加 → replaceReply(id, [draft])（React 局部重渲，不落盘）
          tool    → 按 id merge 进 parts（title/status/input/output 增量）
          permission → setPermissions([...]) 弹权限 UI
          error   → throw → catch 记入 failure
          done    → 无 runtime 模型时 setAgentModel
     └─ finally：splitAgentReply(result)（按 message_break/段落/句长拆 ≤4 个 bubble）
          → replaceReply(..., save=true) → persist → store + PUT /api/state
```

## 核心实现

### 群聊：隐形 controller 与决策路由

数据模型：一个群是一个 `AgentConversation`（`agentGroup: {memberIds, leadMemberId, runtimeId, topics, activeTopicId}`），成员是独立 Bot conversation；人类被建模为 `human: {kind:"human", name, privateAddress:"human"}`。

`groupControllerSessionId` 是**隐形调度会话**——运行群决策的隔离 session，与任何成员的普通聊天 session 分开（"Coordination is isolated from the lead member's ordinary private/group reply sessions"），它不产生聊天消息，只产出结构化 JSON 决策。主持人 = `groupLeadMember(group)`（UI 可换 lead）。

`runGroupConversation()`（agentGroupChat.ts:230-430）的主循环：

1. 用户消息先过 `explicitGroupDecision()`：`mentionedGroupMembers()` 解析 @提及（`routingText()` 先剥掉代码围栏/行内代码/引用/链接/邮箱再匹配；**最长名优先**防 @Ann 命中 @Anna；`addressesEveryone()` 识别 `@all`/`@everyone`/`@大家`/`@所有人`/`@所有成员`/`@全体成员`）——有明确提及直接 routing（single/parallel），**绕过 controller**。
2. 无提及 → `requestGroupDecisionWithFailover()`（agentGroupDecision.ts）：按 [lead, 其余成员] 顺序，每个候用自己的 runtime 在 controller session 上跑 `groupDecisionPrompt()`（"You are the lead member supervising this group task… Return only JSON"），45s 超时，失败换下一个候选，输出经 `validateGroupDecision()` **严格契约校验**：mode ∈ none/single/parallel/sequential、memberIds 必须是群成员、triggerMessageIds 必须是可见消息、拒绝 tool/permission 事件、>16k 输出——"never infer a recipient or a fallback"。
3. 决策出的成员批次由 `reply(member, turn, …)` 执行：`groupConversationPrompt()` 注入群档案、turn、共享消息 `sharedGroupMessages()`（预算 48k 字符）、**privateInbox**（只给本成员作为 sender/recipient 的私信，预算 24k）。parallel 用 `Promise.all`；sequential 串行且后者可见前者产出；成员失败 → `quarantine()` 隔离（摘出本轮参与、触发 UI 的"临时主持人"横幅）并**串行**按序选替补（`executeWithFailover`）——串行是因为替补需要看到前面替补的产出再决定是否还需要它。**lead 首轮前置优化**：controller 初始路由不含 lead 时，先把原决策存进 `deferredInitialDecision`、让 lead 先出面，首轮结束后再执行原决策。
4. 每轮结束 `handoffsFrom()` 扫新消息里的 @提及和私信投递生成下一批 pending；直到 mode=none / 轮数上限 `GROUP_MAX_TURNS = 24`（纯执行护栏，"the model decides when the conversation is complete"）/ abort。

### 私信与 A2A：两套标记协议

**私信**：成员回复里的 `[[private:RECIPIENT_ID]]…[[/private]]` 块由 `parsePrivateReply()` 流式剥离（**fail closed**：半个开标记也扣住不显示）；信封校验同样 fail closed——单条内容超 12,000 字符、投递数达 20 条上限、或嵌套 `[[private` 时整条 invalid；`privateReplyDeliveries()` 解析收件人（id 精确匹配或**恰好一个**同名匹配——多个同名成员一律 invalid，绝不猜；`human` 是投递地址不可 @）。`deliverPrivateMessages()`（store 调用）把私信存到群 conversation 的 `agentPrivateMessages`（截尾 `slice(-200)` 条），同时给收件人为 human 的每个 Bot 的**直聊收件箱**投一份副本（`sourceGroup` 标注、`agentUnread` 计数）；群聊 prompt 里注入的私信上下文（`privateContext`）预算 24k 字符，与共享消息 48k 分开。

**A2A**：非群的 Bot 直聊里，Bot 可用 `[[a2a:RECIPIENT_ID]]…[[/a2a]]` 把任务私发另一 Bot——`directA2ASourcePrompt()` 明确"由模型推断人类意图指哪个 Bot，transport 层只接受 opaque id，绝不猜名字"；同名歧义 → invalid 整体丢弃。信封校验比私信更紧：**投递数达 8 条上限**或单条超 12,000 字符即 invalid；会话 id `directA2ASessionId(src, tgt, topic)` 形如 `a2a:<src>:bot:<tgt>[:topic:<tid>]`（独立于任何 Bot 的私聊/群聊会话）；收件箱 streaming 用哨兵 id `a2aInboxStreamingId(botId)` 让侧栏显示 working。投递后 AgentPane `submit()` 的非群分支对每个 delivery 调 `reply(recipient, undefined, history, delivery)`，回复经 store 的 `deliverAgentA2AReply` 落到目标 Bot 收件箱（`sourceBot`/`sourceBotMessage` 标注，UI 用 `BotTransfer` 组件双向展示；入库的 reply content 同样截 12k）。

### 消息渲染

`AgentMessage`（store.ts:85-124）：role/content/**parts**（text|tool 的交错流水）/attachments/files/sender/recipient(s)/sourceGroup/sourceBot/botDeliveries/replyGroupId（一次 model turn 拆出的连续气泡共享）。`Markdown.tsx`（117 行）：marked（gfm+breaks）→ 自定义 code renderer 加 copy/run 按钮（shell 类 fence 才有 run）→ **DOMPurify.sanitize**；本地媒体管线 `markdownLocalMedia.ts` 把 agent 输出里的绝对路径与 `file://` URL（带媒体扩展名）重写为 `/api/fs/media` 端点。无语法高亮（纯 escapeHtml + CSS）。

工具调用的展示：`agentToolDisplay()` 把 ACP tool title/input 正则归类为 read/run/search/edit/delegate/other 六类；`AgentSteps` 组件渲染 work log——streaming 时钉开，结束后折叠为 "worked for Xs · N tools"。**群聊里成员的 tool input/output 被抹除**（AgentPane `reply()` 内统一改标题）——注释原文：防泄露"私密游戏分工"。

长消息：`agentMessagePagination.ts` 每页 40 条，开会话只挂最新一页，滚到顶 72px 触发向前翻页（`prependPositionRef` 保滚动锚点）。气泡级拆分 `splitAgentReply()`：显式 `<!-- message_break -->` 优先（提示词教的），否则按段落/句子拆——**工具活动（tool parts）贴第一泡、最终错误贴末泡**；纯文本块超 ~160 字（`TARGET_REPLY_MESSAGE_LENGTH`）才继续细分，但**长度 ≤160、含代码围栏、或整体是结构化 Markdown（列表/表格/标题，`hasStructuredMarkdown`）的块整块保留不拆**；拆出的气泡超过 4 条（`MAX_REPLY_MESSAGES`）时，把剩余部分合并进最后一条而非丢弃。

### agents.ts 与模型菜单

`DEFAULT_AGENTS` 11 个内置 ACP agent（claude/codex/openclaw 默认启用；gemini/grok/fastclaw/hermes/opencode/cursor/kimi/omp 默认禁用），图标 `assets/agents/*`；安装命令白名单 `INSTALLERS`（`agentInstall.ts`，产品自有命令，自定义命令绝不变成一键执行）。存取是 localStorage + server SQLite 双真源。**注意：`modelSource: "termany"`（Termany 代管模型凭证）目前仅有占位报错**（acpRuntime.ts:184-186 "not available yet"）。`agentModelMenu.ts` 把 ACP 的 config options 排成菜单：>12 项且全含 `/` 时按 vendor 分组（OpenCode 400 模型场景），否则平铺。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 纯函数域模块 + UI 壳 | ~30 个 agent*.ts vs AgentPane/Workspace | 副作用边界清晰：状态变换纯函数化，命令式清理收口一处 |
| 传输契约客户端强校验 | `validateGroupDecision` / `a2aReplyMessages` | 防模型幻觉注入路由——"never infer a recipient or a fallback" |
| id 即命名空间 | `groupMemberSessionId` 等四个构造函数 | 跨层共享的最小契约，server 无需理解群聊语义 |
| 双外观单 runtime | `appearance: "pane" | "messenger"` | 页内 pane 与 Agents 工作区共用一套消息流/权限/模型逻辑 |
| persist/display/replaceReply 三层写入 | AgentPane + `pendingIdsRef` | streaming 占位消息永不落库 |
| 显式未读计数 | `agentUnread` | "普通回复、群回复与私信投递共享一个未读模型，不必从时间戳重构 UI 可见性" |

## 模块间交互

上游：`store` 的 `AgentConversation` 与 ~30 个 action（addAgentConversation/addAgentGroup/deliverAgentPrivateMessages/…）；`SplitView` 以 `leaf.view === "agent"` 挂 AgentPane（页内外观）。下游：server 的 `/api/agent/acp/chat`（NDJSON）、`/api/agent/acp/permission`、`/api/agents`（注册表）、`/api/agents/detect`、`/api/fs/media`（本地图片代理）；`@termany/core` 的 `defaultAgentRuntime`（agents.ts 清单引用）。`AgentHistory`/`AgentUsage` 是两个平级视图组件（消费 agentSessions 数据，见[活动与会话历史](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/04-agent-activity)）。

## 扩展方式

**新增一个可聊天 agent**：`assets/agents/foo.svg` 图标 + `agents.ts` 的 `DEFAULT_AGENTS` 加条目（runtime 用 `defaultAgentRuntime("foo")`——**server 侧 adapter 也要有对应实现**，见[ACP 运行时](/vibe-reading/articles/AI/Agent/AI-Coding/Termany/CodeWiki/0.2.1/03-acp-runtime)，前端只加清单不会真正可用）+ `agentInstall.ts` 的 `INSTALLERS` 加安装命令。检测/启用/排序全自动。对应测试 `agentBotName.test.ts`、`agentAvailability.test.ts`。

**新增一种消息渲染块（如 chart part）**：`AgentPart` union 加变体 → AgentPane 的 NDJSON switch 加分支 + `AgentSteps` 加渲染 → 若要进 inbox 预览则改 `agentMessagePreview.ts`（目前只认 text/tool 二分）。群聊决策上下文不受影响（`sharedGroupMessages` 只取 content）。

**群聊新增一种 mode（如 debate 辩论）**：`GroupDecision.mode` 扩展 → `validateGroupDecision()` 校验分支 → `runGroupConversation()` 执行策略 → `groupDecisionPrompt()` 提示词更新；UI 层基本零改动——`agentGroupChat.test.ts` 补用例即是拆文件的可测试收益。
