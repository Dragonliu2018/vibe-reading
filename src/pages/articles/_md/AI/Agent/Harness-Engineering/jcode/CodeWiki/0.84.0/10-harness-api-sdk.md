---
source:
  type: "源码解读"
  project: "jcode"
  url: "https://github.com/1jehuang/jcode"
title: "Harness API 与 SDK"
date: "2026-09-11T17:39:13+08:00"
category: [AI, Agent, "Harness Engineering", jcode, CodeWiki, "0.84.0"]
tags: ["jcode", "Rust", "TypeScript", "NDJSON", "SDK", "ACP", "版本化协议"]
description: "jcode Harness API 与 SDK——内部协议与公开 API 分离的三明治架构、NDJSON v1 帧格式与版本协商、Rust/TypeScript 双 SDK parity 守卫、transport 抽象、ACP 适配器"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Harness-Engineering/jcode/CodeWiki/0.84.0/00-overview)

---

## 模块定位

这一组模块是 jcode 的"对外服务化"层：稳定版本化的 harness API（任何 UI/脚本驱动 jcode 的公开边界）+ Rust/TypeScript 双 SDK + 跨平台 transport 抽象 + ACP 适配器。它独立成域的原因是一个兼容性经济学问题：**内部 wire 协议（`jcode-protocol`）随 daemon 自由演进，公开 API 冻结为精心筛选的子集**——两套协议的生命周期完全不同。

---

## 模块架构

三明治架构：

```
外部客户端 (Desktop2 / 编辑器插件 / 脚本)
   │  NDJSON, v1 稳定协议
   ▼
jcode-api.sock ── jcode-harness-api-server (bridge)
   │  JSON→JSON 纯翻译 (translate.rs)
   ▼
jcode.sock ── daemon（内部 jcode-protocol，随意演进）
```

- `jcode-harness-api`：公开 API 类型 + NDJSON 帧 helper + socket 路径解析。头注释定位："deliberately smaller than the internal `jcode-protocol`: only curated, stable surface lives here"
- `jcode-harness-api-server`：bridge 进程。翻译是 JSON-to-JSON，**不依赖重型内部协议类型**——内部协议的 additive 变更不会破坏它；"This keeps the daemon untouched while the API surface stabilizes"，稳定后可把翻译移进 daemon 进程内
- `jcode-sdk`（Rust，Desktop2 日常构建其上）与 `sdk/typescript`（`@1jehuang/jcode-sdk` v1.2.0，ESM Node≥20，运行时依赖仅 ajv + 平台二进制包）
- `jcode-transport`：Unix socket / Windows named pipe 统一 `Listener`/`Stream`——独立成 crate 是为了让 bridge 用它而不依赖 `jcode-base`（否则要复制 450 行 named pipe 处理进 bridge）

---

## 调用链路

```
SDK: JcodeClient::connect(ConnectOptions)
  ├─ ensure_runtime        先拉起 daemon+bridge（只手启动过的 runtime 才能用的 app 与坏 app 无法区分）
  ├─ over(transport): split → spawn_reader 线程 → Hello → HelloOk{version, server, capabilities}
  ├─ create_session(working_dir) → CreateSession → Attached{session}
  └─ run(session_id, "…", RunOptions)          先订阅再发送！
       ├─ events(Some(session_id)) 订阅（write 与 subscribe 之间落地的 ack 会丢）
       ├─ send_message → 等 MessageAccepted 事件（默认 10s）
       ├─ 循环：TextDelta 累积 / ToolDone 收集 / PermissionRequest→auto_approve
       └─ TurnDone → TurnResult{text, reasoning, tool_calls, usage}
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `run_bridge_stream()` in `harness-api-server/src/lib.rs` | bridge 主循环 | `min_version <= MAJOR && max_version >= MAJOR` 否则断连 |
| `read_frame()` / `write_frame()` in `harness-api/src/client.rs` | NDJSON 帧编解码 | 一行一 JSON + `\n`，跳空行 |
| `run()` in `jcode-sdk/src/client.rs:1170` | 驱动一个 turn | **先订阅再发送**（否则 ack 丢失假超时） |
| `describe_disconnect()` in `diagnostics.rs` | 断连人话化 | `Stage` 记录断连时在干什么 |
| `validate()` in `ssh.rs` | SSH 输入消毒 | 拒绝 `user@host` 与字段重复——防 OpenSSH %h/%r 插值注入 |
| `bundledJcodeBinary()` in `sdk/typescript/src/binary.ts` | 平台二进制解析 | 缺失时回落 PATH |
| `handle_message()` in `src/cli/acp.rs` | ACP JSON-RPC 分发 | `_` 前缀私有扩展方法 |

</details>

---

## 核心实现

### NDJSON v1 帧与版本协商

`ClientFrame { v: u32, id: u64, #[serde(flatten)] request: ApiRequest }`——`v` 是协议主版本（`API_VERSION_MAJOR = 1`）、`id` 客户端分配单调递增、回复帧回显 `reply_to`；流式事件（TextDelta 等）省略 `reply_to`。`ApiRequest` 用 `#[serde(tag = "req")]` 内部标签，`ApiEvent` 用 `#[serde(tag = "ev")]`——schema 快照测试（`harness_api_tests/schema_snapshot.rs::client_frame_wire_shape`）钉死精确 JSON：`{"v":1,"id":7,"req":"send_message","session_id":"s1","content":"hi"}`。

向后兼容规则：客户端必须 ignore unknown fields、跳过 unknown event kinds（枚举带 `#[serde(other)] Unknown` catch-all）；additive 变更 bump `MINOR`，breaking 变更 bump `MAJOR` 且须在 `Hello` 握手协商（`HarnessClient::hello` 的 `min_version` 与 `max_version` 都取 `API_VERSION_MAJOR`；读到流末尾返回 `FrameError::Eof`）。capabilities 是 additive feature discovery 通道——bridge 通告 9 项（`sessions`/`streaming`/`session_fork` 等）；**`permissions` 不在其中**——SDK 的 `supports()` 文档明确当前 bridge 不发权限事件，客户端"等权限提示会永远等下去"，必须查而非假设。

**bridge 进程治理**：`single_instance_lock`（`harness-api-server/src/lib.rs:105`）用 socket 同名 `.lock` 文件加 `flock(LOCK_EX|LOCK_NB)`——内核在持有者死亡时自动释放，崩溃的 bridge 不会把下一个 wedge 住；持锁后才 remove 旧 socket 文件。socket 权限 chmod 0600——默认 umask 会导致 0755，任何本地用户可读 transcript 并花掉 owner 的 provider token。bridge 在连上内部 daemon 成功之前不回 `HelloOk`（"不要在 daemon 不可达前声称连接可用"）。

**DoS 防护**：`MAX_FRAME_BYTES = 16 MiB`（`harness-api-server/src/lib.rs:45`）——`read_line` 无界增长缓冲区会让一个不换行的客户端耗尽宿主内存，而 bridge 服务全机客户端。读满 16 MiB 且行尾不是 `\n` 时返回 `InvalidData` 并断连（流已 mid-frame 无法重同步）；握手版本不兼容返回 `ErrorCode::UnsupportedVersion`，首帧不是合法 JSON 返回 `InvalidRequest`。

### socket 路径的单一真源

`sockets.rs` 刻意放在 API crate 而非 bridge，注释解释了 why：曾因 bridge 和 desktop 各持一份路径解析逻辑（一个看 `$XDG_RUNTIME_DIR`、一个死盯 `~/.jcode`）导致"健康 bridge 在跑但 desktop 永远连不上"。现在 `runtime_dir()`（`JCODE_RUNTIME_DIR` > `$XDG_RUNTIME_DIR` > macOS `$TMPDIR` > `/tmp/jcode-<user>`）+ `api_socket_path()`（`jcode-api.sock`）定义一份两侧共用，还有守卫测试 `the_api_socket_sits_beside_the_daemon_socket`。

### 双 SDK 与三层 parity 守卫

Rust `jcode-sdk`：`client.rs`（1558 行）+ `launch.rs`（隔离私有实例）+ `ssh.rs`（系统 OpenSSH 到远端 `jcode api --stdio`，绝不本地 fallback；`validate()` 严格消毒——host/user 仅 `[A-Za-z0-9_.-]`，拒绝 `-` 开头、拒绝 `user@host` 与 `user` 字段重复指定，防 ProxyCommand 的 %h/%r 插值注入；`client_name` 限 1024 字节保持首帧低于管道容量）+ `diagnostics.rs`（`describe_disconnect(stage, error, ...)` 把断连翻成"你的 wifi 断了"式人话，未识别的原文透传——"错误的猜测比原文更糟"；`ErrorKind::code()` 与 TS SDK 的 code 字符串一致——"两个 SDK 用同一个名字描述同一种失败"）。客户端是 `Clone` 句柄：一个 `spawn_reader` 线程独占流，按 `reply_to` 匹配 pending reply map（`HashMap<u64, Sender>`），无人等待的帧广播给所有订阅者（send 失败时移除死订阅）；带 session 过滤的订阅也会收到不指名 session 的事件——error 事件代替 turn_done 发送，过滤掉会让 turn 永远等待。

TypeScript SDK：`protocol.ts` 头注释 "Mirrors `crates/jcode-harness-api` exactly... schema-parity test fails the build if the tag sets drift apart"。能力面与 Rust 完全对齐（`connect`/`launch`/`listSessions`/`createSession`/`attachSession`/`forkSession`/`sendMessage`/`softInterrupt`/`peekSession`/`respondToPermission`/`run`/`runStructured`/`events()`...）。三层 parity 守卫：(a) Rust `sdk_tests/parity.rs`；(b) `capability_coverage.rs` 测试**直接读 TS 源比对**变体与字段清单；(c) TS `schema-parity.test.ts` 反向读 Rust 源比对 tag 集——漏改即红。

`run_structured` 是 SDK 层契约而非协议特性：本地 JSON Schema 校验 + 失败给模型有界次数的纠错重试（默认 2 次），两侧同默认。

### ACP 适配器：第三个协议端

`src/cli/acp.rs`（2190 行）让 jcode 可被任何 ACP 兼容编辑器（如 Zed）当编码 agent 驱动：**stdin/stdout 上的 JSON-RPC 2.0**（NDJSON），`ACP_PROTOCOL_VERSION = 1`。三档 profile（`AcpProfile::{Standard, Extended, Full}`）决定扩展方法可用性。关键架构事实：acp.rs import 的是 `crate::protocol::{Request, ServerEvent}`——它桥接**内部 daemon 协议**而非 harness API，每个 `AcpSession` 持有到 daemon 的独立连接。即 jcode 有三个对外协议端：内部协议（TUI/ACP）、harness API（bridge）、ACP（JSON-RPC over stdio），各自独立翻译。

---

## 模块间交互

bridge 从 daemon 推送的缓存目录直接回答 `list_models`（catalog 未到时挂起 `SimpleKind::Models` 等待——打开 picker 无 round-trip）；`PeekSession` 从存储记录读任意会话尾部（多会话 dashboard 免打扰设计，`PEEK_LIMIT=12`）；`SetApiKey` 刻意排除 OAuth token。TS SDK 的六个平台 optionalDependencies 携带 jcode 二进制（`binary.ts` 经 `require.resolve` 解析，缺失回落 PATH）。`jcode api`（`ApiBridge`，alias `api`）子命令在 Unix socket 上服务 harness API——flag 刻意叫 `--api-socket`，因为全局 `--socket` 已选内部 daemon socket。

---

## 扩展方式

**新增 API 请求**（以 `FooBar` 为例的兼容流程）：`requests.rs` 的 `ApiRequest` 加变体（新字段全部 `#[serde(default)]`）→ additive bump `API_VERSION_MINOR` → `translate.rs` 加映射分支（纯函数可单测；需 attach 加进 `REQUIRES_ATTACH`，只读存储的如 `peek_session` 刻意不加）→ `schema_snapshot.rs` 加 wire-shape 测试 → TS `protocol.ts` 镜像类型（两道 parity 守卫强制）→ 双 SDK 各加方法（`sdk_tests/parity.rs` 强制对齐）→ 需探测则 capabilities 加字符串。新事件靠既有 `#[serde(other)] Unknown` 兜底。分层测试网：harness-api 的 snapshot/coverage → server 的 `translate_tests.rs`（2031 行）→ Rust SDK parity + ssh 集成 → TS `test/*.test.ts`。
