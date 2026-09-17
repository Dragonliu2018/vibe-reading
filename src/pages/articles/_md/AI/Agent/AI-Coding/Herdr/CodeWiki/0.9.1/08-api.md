---
source:
  type: "源码解读"
  project: "herdr"
  url: "https://github.com/herdrdev/herdr"
title: "Socket API"
date: "2026-09-17T10:53:00+08:00"
category: [AI, Agent, "AI Coding", Herdr, CodeWiki, "0.9.1"]
tags: ["herdr", "Rust", "Unix socket", "JSON API"]
description: "herdr JSON Socket API：104 个 method 的 schema 驱动协议、事件订阅与 agent.wait 混合等待语义。"
readingTime: "19 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Herdr/CodeWiki/0.9.1/00-overview)

---

## 模块定位

`src/api/`（约 9,500 行）+ `src/ipc.rs` + `src/cli/` 实现 herdr 对外的稳定面：`herdr.sock` 上的 NDJSON API。这是 "agent-native" 卖点的全部基础设施——CLI 子命令、agent（经 `skills/herdr/SKILL.md` 引导）、插件、甚至 TUI 客户端自己的按键动作，全走同一套 API。server 本身**不含业务逻辑**，是纯传输/编排层；所有语义都在 `src/app/api*.rs`（95K 的巨型 match）。

为什么是 JSON over Unix socket 而不是 HTTP/gRPC：`src/ipc.rs` 的 `bind_private_local_listener` + `src/api/server.rs:56` 的 `SOCKET_PERMISSION_MODE = 0o600`——**socket 文件权限即访问控制**（仅本用户），零依赖、无端口占用。Windows 用 named pipe + SDDL DACL 等价实现。单连接单请求（除流式方法）的极简模型：读到一行 JSON、处理、写回、关连接——无连接状态机。

## 模块架构

![api 模块组件](/vibe-reading/images/articles/herdr-codewiki-0.9.1/module-08-api.svg)

调用方发 `{"method":"pane.list","params":{...}}` 形式的单行 JSON；`api/server.rs` accept 后每连接一个 OS 线程跑 `handle_connection_with_stop_control()`（5s 超时、1MB 上限、非阻塞逐字节轮询——为 Windows named pipe 与 Unix 统一语义）；流式方法（subscribe / events.wait / agent.prompt / agent.wait / pane.wait_for_output / graphics stream）被先 match 出来各自接管 stream，其余走 `dispatch_to_app()`——建 std mpsc，把 `ApiRequestMessage` 塞进 `api_tx`（tokio unbounded），阻塞等 `respond_to` 回执（5s 超时）。app 侧返回的已是**序列化好的 JSON 字符串**，server 线程零转换直写 socket。事件侧：`EventHub` 是 512 条环形日志，`subscriptions.rs` 100ms 轮询增量拉，`wait.rs` 做 agent 状态等待。

## 调用链路

**CLI 请求链**（`herdr pane list`）：

```
run_pane_command → pane_list() in cli/pane.rs
└─ Request { id: "cli:pane:list", method: Method::PaneList(...) }
   └─ send_request() in cli.rs:769
      ├─ target::api_client()（--machine 时懒启动 SavedSshApiBridge）
      ├─ ensure_server_protocol_compatible()：先 ping 校验 PROTOCOL_VERSION
      └─ ApiClient::request_value() → ipc::connect_local_stream()
         → 写一行 JSON
server 端：
start_server_inner() in api/server.rs:99（accept 线程）
└─ std::thread::spawn → handle_connection_with_stop_control()
   ├─ read_initial_request_line()（5s 超时 / 1MB 上限）
   └─ dispatch_to_app() in api/server.rs:855
      └─ api_tx.send(ApiRequestMessage{ request, respond_to })
         → headless 主循环 LoopEvent::Api（headless.rs:624）
            → handle_api_request_with_render_impact()（headless.rs:2921）
               → App::handle_api_request_after_internal_events_drained() in app/api.rs:885
                  → handle_pane_list() in app/api/panes.rs:137
                     → collect_panes_for_workspace() 读 AppState
                     → respond_to.send(encode_success(...))   # JSON 字符串
                        → server 线程 write_text_line_allow_disconnect() 写回
```

**wait until blocked 链**（`agent.wait`，`api/wait.rs:140`）：

```
wait_for_agent()
├─ agent_get() 拿初始状态立即判匹配
└─ wait_for_resolved_agent() in wait.rs:364（混合模式循环）
   ├─ 事件优先：event_hub.events_after() 消费 PaneAgentDetected /
   │    PaneAgentStatusChanged / PaneClosed / PaneExited
   └─ 命中 should_probe 才发 agent.get 探测（事件驱动省请求，探测防丢事件）
      └─ agent 消亡（released/closed/moved）→ agent_wait_not_running 错误
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `start_server_inner()` in `api/server.rs:99` | accept 循环 | 线程-per-connection，Drop 按 inode 拥有权清 socket |
| `handle_connection_with_stop_control()` | 连接处理 | 长连接方法特化分发 |
| `dispatch_to_app()` in `api/server.rs:855` | 桥接 app | 阻塞等 respond_to，app 返回已序列化 JSON |
| `stream_subscriptions()` in `api/server.rs:713` | 订阅接管 | 先记 current_sequence 再建快照 |
| `wait_for_resolved_agent()` in `api/wait.rs:364` | 混合等待 | 事件 + 探测，`accept_transient_status` 区分瞬时/终态 |
| `prompt_agent()` in `api/wait.rs:176` | prompt --wait | 前后各取一次 agent 身份防"prompt 到换人 pane" |
| `api_method_name()` in `api/server.rs:390` | 日志名 | 104 分支手写，round-trip 测试族守护 |

</details>

## 核心实现

### Schema-as-code：测试守护的生成物

整个 API 的单一真源是 `Method` enum——**104 个 variant**，`#[serde(tag = "method", content = "params")]` 序列化成类 JSON-RPC。所有线格式类型派生 `schemars::JsonSchema`；`protocol_schema_document()`（`api/schema/tests.rs:27`）生成 5 个 schema（request/success/error/event/subscription_event），测试 `generated_protocol_schema_artifact_is_current` 与 `docs/next/api/herdr-api.schema.json` **逐字节比对**——设 `HERDR_UPDATE_API_SCHEMA=1` 跑测试即可重生成。schema 入库意味着 `herdr api schema --json` 离线可用（`include_str!` 进二进制），agent 工具链无网络依赖。同步机制不是手工文档，是测试守护的生成物。

### EventHub 与订阅模型

```rust
// src/api/event_hub.rs —— 极简环形缓冲
pub struct EventHub { inner: Arc<Mutex<EventHubState>> }
struct EventHubState { next_sequence: u64, events: Vec<(u64, EventEnvelope)> }
impl EventHub { const MAX_EVENTS: usize = 512; /* push / events_after / current_sequence */ }
```

`ActiveSubscription` 四变体（Event / OutputMatched / AgentStatusChanged / ScrollChanged）：纯事件类从 `events_after(last_sequence)` 增量拉；output/scroll 类是"带状态快照的轮询订阅"——每轮向 app 发内部 `pane.read`/`pane.get` 做 diff。为什么 EventHub 只有 512 条：事件是提示而非承诺，**溢出丢事件由探测兜底**（wait 的混合模式就是为此设计）。0.9.0 起订阅从 current_sequence 起步而非重放历史——API 客户端应先订阅再取快照（#1270）。

### 一致快照与 UI 影响白名单

`handle_api_request_after_internal_events_drained` + headless 的 `drain_api_requests_with_shutdown_check`：先 drain 内部事件再处理 API——保证 `pane.list` 这类读请求看到的是 PTY 输出等内部事件全部落定后的一致快照。反向的 `request_changes_ui()`（`api/mod.rs:22`）白名单决定请求是否触发 `RenderImpact::Full`——只读请求（pane.list）不强制重渲染。事件外发路径 `App::emit_event()`（`app/api.rs:748`）先 `run_plugin_event_hooks(&event)` 再 `event_hub.push(event)`，41 处调用点分布全仓。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Schema-as-code | `Method` enum + schemars | 编译器穷尽 match，缺一环编译不过 |
| 线程-per-connection + channel 汇聚 | `api/server.rs:113` | API 并发收敛到 app 串行处理，免锁 |
| 封闭式协议 | `IntegrationTarget` 等冻结 enum | API 兼容性优先，新值走 experimental |
| 混合等待 | `wait_for_resolved_agent` in `wait.rs:364` | 低开销与正确性兼顾 |

## 模块间交互

`ipc.rs` 是本地 socket 客户端侧共用件（CLI、remote 桥都用它连）；`cli/target.rs` 的 `TargetScope`/`MachineTarget` 让任何 `api_client()` 调用在 `--machine` 语境下懒启动 SSH 桥。app 侧 `app/api/` 按领域拆 handlers；`ServerHandle` 的 `SocketFileIdentity`(dev+ino) 保证只删除自己创建的 socket 文件——防止误删后继 server 的（两个 herdr 抢同一 socket 路径时的关键防御）。

## 扩展方式

新增 API method `agent.restart` 的完整清单（编译器强制四处同步）：

1. `src/api/schema/agents.rs` 加 `AgentRestartParams`（derive `schemars::JsonSchema`）
2. `src/api/schema.rs` 的 `Method` 加 `#[serde(rename = "agent.restart")]` 变体
3. `src/api/server.rs::api_method_name()` 加分支（穷尽 match 编译错）
4. `src/api/schema/response.rs` 的 `ResponseResult` 加结果变体
5. `src/app/api.rs` 巨型 match 加处理臂
6. 改 UI 状态则加进 `request_changes_ui()`（`src/api/mod.rs`）
7. `HERDR_UPDATE_API_SCHEMA=1 cargo test` 重生成 schema.json
8. 可选：`src/cli/agent.rs` 加 CLI 子命令

新增事件订阅类型：`schema/events.rs` 的 `Subscription`/`EventKind` 加变体 → `subscriptions.rs` 的 `ActiveSubscription::new`/`poll` 加分支 → app 侧 emit 点调用 `emit_event` → 重生成 schema。

---

## 边缘机制速查

闭卷验证补充：

### 连接防护与 socket 治理

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `MAX_INITIAL_REQUEST_BYTES / INITIAL_REQUEST_TIMEOUT` | `api/server.rs` | 首行上限 1MB（超限 InvalidData 'api request line is too large'）、5s 超时——非阻塞逐字节轮询（read_initial_request_line_with_limits），Windows named pipe 统一语义
| `Ping 短路` | `handle_request in api/server.rs` | Ping 在 server 侧直接回 Pong{version, protocol, capabilities} 不派发 app——协议探活不占 app 循环；client_shell.surface.set 返回 connection_local_only；ServerStop 置 server_stop 标志，已停时其他请求返回 server_unavailable
| `SocketFileIdentity / remove_socket_file_if_owned` | `api/server.rs · ipc.rs` | Drop 时先 running.store(false) 再按所有权删 socket：Unix 用 dev+ino、Windows 用文件内容 marker（windows_socket_marker 为 'pid:纳秒'）——只删自己创建的，不误删后继 server 的
| `prepare_socket_path / stale_socket_connect_error` | `ipc.rs` | 路径存在时先 connect 探测：连得上=AddrInUse（busy）；ConnectionRefused/NotFound/TimedOut（Windows 还有 WouldBlock）视为陈旧残留，remove_file 后重绑

### wait 与订阅语义细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `prompt_agent` | `api/wait.rs` | 无 wait 直接 dispatch；有 wait 时 AGENT_PROMPT_EFFECT_TIMEOUT_MS=5s 观察窗（prompt_activity_statuses 把 Working/Blocked 视为活动），超时返回 PromptStalled（agent_prompt_stalled）；settled 等待从提交前的 last_event_sequence 重放（'Replay from before submission'）防提交瞬间的事件丢失
| `agent_wait_statuses` | `api/wait.rs` | until 为空默认 [Idle, Done, Blocked]；PaneMoved/PaneClosed/PaneExited、released 的 PaneAgentDetected、身份不匹配 → agent_wait_not_running（错误码 agent_not_running）；agent_wait_probe_error 把 agent_not_found 转 agent_not_running
| `EventHub 订阅起点` | `api/server.rs · subscriptions.rs` | stream_subscriptions 先取 current_sequence 再逐个建 ActiveSubscription——跳过历史但保留 setup window 事件（lifecycle_subscription_skips_history_but_keeps_setup_window_events 测试）
| `output_match_read_source / currently_matching` | `api/subscriptions.rs` | ReadSource::Recent 归一化为 RecentUnwrapped；currently_matching=true 时再次匹配返回 None、无匹配复位——边沿触发防重复推送；构造时 pane_read probe 失败则订阅创建失败；Regex 编译失败返回 invalid_regex；match_output 按行找第一个命中

### 客户端细节

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| `ConnectionTarget` | `api/client.rs` | LocalSession(None) 用默认 socket、Some(name) 用会话 socket、SocketPath 显式路径；status() 发 Method::Ping 从 Pong 构造 RuntimeStatus
| `set_timeout_best_effort` | `api/client.rs` | Windows 上 Unsupported 超时错误忽略视为成功；parse_response_value 区分 Success/ErrorResponse；write_request JSON + 换行 flush——NDJSON 协议