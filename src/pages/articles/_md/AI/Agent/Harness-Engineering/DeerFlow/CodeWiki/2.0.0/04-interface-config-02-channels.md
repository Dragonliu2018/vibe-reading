---
source:
  type: "源码解读"
  project: "deer-flow"
  url: "https://github.com/bytedance/deer-flow"
title: "Channels"
date: "2026-08-12T10:45:17+08:00"
category: [AI, Agent, "Harness Engineering", DeerFlow, CodeWiki, "2.0.0"]
tags: ["DeerFlow", "Python", "IM", "Feishu", "Buzz"]
description: "DeerFlow IM 渠道模块解析：Channel 基类、ChannelManager 调度、MessageBus、ChannelRunPolicy 与多平台流式回写。"
readingTime: "12 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview) > [← 接口与配置](/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/04-interface-config)

---

## 模块定位

本模块属于 **接口与配置** 子系统。`backend/app/channels/`（12k 行）把 agent 接入 IM 平台（飞书/钉钉/Discord/Buzz/GitHub/Slack/Telegram/企业微信）——用户在 IM @机器人即触发 agent run。核心：统一 `Channel` 基类（收/发消息契约）+ `ChannelManager`（调度 dispatcher + 去重 + run policy）+ `MessageBus`（跨进程消息分发）+ `ChannelRunPolicy`（按平台控制串行/交互/流式）+ `dedupe_store`（IM 重发去重）。与 gateway 协作：channel 用 `langgraph_sdk` client HTTP 回环到 gateway 的 `/api/threads/{id}/runs/stream`（带内部 token）。

## 核心实现

### Channel 基类 + MessageBus

```python title=backend/app/channels/base.py
class Channel(ABC):
    @abstractmethod
    async def start(self) -> None: ...   # 建平台 client + 订阅 _on_outbound
    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None: ...
    # 可选: send_file/receive_file, supports_streaming
```

```python title=backend/app/channels/message_bus.py
class MessageBus:  # InboundMessage / OutboundMessage
    async def publish_inbound(self, msg): ...   # put queue
    async def get_inbound(self) -> InboundMessage: ...
    def subscribe_outbound(self, channel_name) -> AsyncIterator[OutboundMessage]: ...
```

### ChannelManager — 调度 dispatcher

```python title=backend/app/channels/manager.py
class ChannelManager:
    # _dispatch_loop (L1612): bus.get_inbound → _is_duplicate_inbound → _handle_message
    # _handle_chat_on_thread (L2038): _resolve_run_params + _apply_channel_policy + _human_input
    # _handle_streaming_chat (L2195): client.runs.stream → 累积 AI 文本 → publish_outbound
    # _inbound_dedupe_key (L1642): 取 metadata keys 拼 dedupe key
    # _is_assistant_stream_type (L557): 白名单过滤流式事件（防隐藏上下文泄到 Buzz）
```

### ChannelRunPolicy

```python title=backend/app/channels/run_policy.py
@dataclass(frozen=True)
class ChannelRunPolicy:
    is_interactive: bool = True      # True → disable_clarification (IM 无法多轮澄清)
    requires_bound_identity: bool = True
    default_recursion_limit: int = 100
    fire_and_forget: bool = False
CHANNEL_RUN_POLICY = {}  # 注册表: CHANNEL_RUN_POLICY["feishu"] = ChannelRunPolicy(...)
# feishu_run_policy.py / buzz_run_policy.py 副作用注册
```

### dedupe_store

```python title=backend/app/channels/dedupe_store.py
class InboundDedupeStore(Protocol):  # memory / postgres 双实现
    def is_duplicate(self, key) -> bool: ...
# INBOUND_DEDUPE_TTL_SECONDS=600, INBOUND_DEDUPE_MAX_ENTRIES=4096
# make_inbound_dedupe_store: auto 选择 (多 pod 必须 postgres)
```

## 调用链路

```
[Feishu] WebSocket → 用户消息事件
  ▼ feishu._on_message: 解析 chat_id/user_id/text + "OK" reaction + "Working on it" card
  ▼ bus.publish_inbound(InboundMessage)
  ▼ ChannelManager._dispatch_loop: bus.get_inbound → _is_duplicate_inbound → _handle_message
  ▼ _handle_chat: _get_client (langgraph_sdk, internal_auth header) → _get_or_create_thread
  ▼ _begin_serialized_thread_run (asyncio.Lock 线程级串行)
  ▼ _handle_chat_on_thread:
       _resolve_run_params (合并 DEFAULT_RUN_CONFIG + channel + user + recursion_limit)
       _apply_channel_policy (is_interactive→disable_clarification; credentials_provider→GitHub token)
       _ingest_inbound_files + _human_input_message
  ▼ [if supports_streaming] _handle_streaming_chat:
       client.runs.stream(thread_id, assistant_id, input={messages}, config, context, stream_mode)
         ▼ HTTP POST → Gateway /api/threads/{id}/runs/stream (进入 HTTP 主链路)
       async for chunk: messages-tuple → 累积 AI 文本; values → artifacts
         定期 publish_outbound(OutboundMessage(text+"▉")) → 飞书 card 流式更新
  ▼ [else] client.runs.create / wait (fire_and_forget or blocking)
  ▼ _extract_response_text + _prepare_artifact_delivery → bus.publish_outbound(OutboundMessage)
  ▼ feishu.send: Patch card 最终文本 + "DONE" reaction
```

## 设计模式

| 模式 | 位置 | 说明 |
| --- | --- | --- |
| 策略 | 多 IM 适配器 | 统一 `Channel` 基类，多平台复用 |
| 观察者/发布订阅 | `MessageBus` | 跨进程消息分发，inbound queue + outbound subscribe |
| 命令 | `commands.py` `KNOWN_CHANNEL_COMMANDS` frozenset | 单一数据源驱动 help/palette/dispatch，加命令单点编辑 |
| 去重 | `dedupe_store` | TTL+容量防 IM 重发；多 pod postgres |
| 策略 | `ChannelRunPolicy` 注册表 | 按平台控制串行/交互/流式 |

## 模块间交互

- **依赖**：`deerflow.persistence`（`ChannelConnectionRepository` 存连接/凭证/OAuth state）、`config`（channel_connections_config + dedupe_storage）、`deerflow.config.paths`、`deerflow.runtime.user_context`。
- **被调用**：IM webhook 经 gateway（内部 token 认证）或 channels 自接 webhook；`gateway/github/` 处理 GitHub webhook。
- **与 gateway 分工**：channels 通过 `langgraph_sdk` client HTTP 回环调 gateway 的 runs/stream（带 `X-DeerFlow-Internal-Auth` header + owner_user_id）；gateway 负责 agent 执行，channels 负责 IM 协议适配与流式回写。

## 核心实现（续）

### 为什么统一 Channel 基类

多平台复用：飞书/钉钉/Discord/企业微信/Slack/Telegram 协议各异但收发消息契约相同。`Channel` ABC + `MessageBus` 解耦适配器与调度器，新平台只需实现 `start/send` + 平台消息解析→`_make_inbound`→`bus.publish_inbound`。

### 为什么 ChannelRunPolicy 按平台分

IM 平台行为差异大：飞书/钉钉支持 card 流式更新（`supports_streaming`）；GitHub PR comment 无法流式（fire_and_forget + 后台 watcher）；Buzz 走 Nostr 事件不可撤回（逼出 `_is_assistant_stream_type` 白名单严格过滤）。`is_interactive=True` 时 `disable_clarification`（IM 无法多轮澄清意图）。

### 为什么 Buzz 走 Nostr + 白名单过滤

Buzz 用 Nostr relay（BIP-340 签名、不可撤回的公开事件）作为传输层。DeerFlow 的 `DynamicContextMiddleware`/`DurableContextMiddleware` 会把 `<memory>`/`<durable_context_data>` 块当隐藏 `HumanMessage` 写到 `messages-tuple` 流——旧 denylist（"含 tool 就拒"）会把这类隐藏上下文当 assistant 回复发到 Buzz relay，事后无法撤回（#已 live 验证）。故 manager 改用**白名单** `_is_assistant_stream_type`：只放行明确的 assistant 文本流。Nostr 不是"为去中心化而选"，是 Buzz 产品传输层特性约束了流式过滤必须严格。

### 为什么 dedupe_store

IM 平台重发（飞书 webhook 至少一次语义 + gateway 重启 + 消费超时重投）。TTL+容量防重；`_inbound_dedupe_key` 取稳定 metadata keys（不能用 `client_msg_id` 不稳，Slack channel id 非全局唯一故 `CHAT_SCOPED_WORKSPACE_CHANNELS` 不含 slack）。多 pod 必须 postgres（`manager.py:268` 告警）。真幂等（抗晚期重发）需持久化 dedupe key 到 `ChannelStore`（标"待实现"）。

## 扩展方式

### 新增 IM 适配器（如企业微信）

新建 `backend/app/channels/wecom.py` 的 `WeComChannel(Channel)` 实现 `start/stop/send`（+ 可选 `send_file/receive_file`、覆盖 `supports_streaming`）；新建 `wecom_run_policy.py` `CHANNEL_RUN_POLICY["wecom"]=ChannelRunPolicy(...)`（若行为同默认可跳过）；`manager.py` 副作用 import 注册；`service.py` 工厂注册；`manager.py` 的 `CHANNEL_CAPABILITIES` 加 capabilities。加平台私有命令不推荐（破坏"单一权威命令集"契约）。

### 改去重策略

TTL/容量改 `dedupe_store.py` 的 `INBOUND_DEDUPE_TTL_SECONDS`/`INBOUND_DEDUPE_MAX_ENTRIES`；key 维度改 `manager.py` 的 `_inbound_dedupe_key` + `INBOUND_DEDUPE_METADATA_KEYS`（注意注释警告）；换后端改 `make_inbound_dedupe_store` auto 逻辑 + `app_config.dedupe_storage`。

### 加 IM 命令（如 /clear）

`commands.py` 的 `KNOWN_CHANNEL_COMMANDS` frozenset 加 `"/clear"`（唯一编辑点，docstring："single edit required"）——所有适配器 `is_known_channel_command` 自动同步；`manager.py` 的 `_handle_command` 加分支处理。

对应测试：`backend/tests/channels/` + `test_dedupe_store.py` + `test_message_bus.py`。
