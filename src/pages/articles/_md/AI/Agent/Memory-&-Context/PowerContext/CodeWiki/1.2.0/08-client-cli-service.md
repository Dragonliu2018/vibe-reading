---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Client、CLI 与本地服务"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "Typer", "httpx", "launchd"]
description: "宿主侧三件套：手写 httpx SDK 门面、entry_points 插件式 Typer CLI、事务式 launchd/systemd/Windows 服务安装，以及 14 家 agent 集成的复用面。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

这三个模块是 PowerContext 的**宿主侧交付面**：`client/`（~5.4k 行）是手写 HTTP SDK——约 60 个方法的薄门面；`cli/`（~11.8k 行）是 Typer CLI，其中 `config_wizard.py`（73K）是 1.2.0 主打的交互式配置向导；`service/` 把 Server 注册为 macOS launchd / Linux systemd --user / Windows 系统服务。它们共同构成 `integrations/` 14 家集成的复用地基：所有集成要么直接 import client，要么（hook 类）用 stdlib urllib 走同一批 REST 路由。

## 模块架构

```
PowerContextClient（client.py:322，"Small handwritten facade"）
  │ ~60 个公开方法 → 统一 _request(operation, request)
  ▼
_request（client.py:1164，唯一执行路径）
  ├─ _prepare_request：TypeAdapter dump → query/body → _bind_operation_path
  ├─ ClientSpan.start（OTel，全部 suppress(Exception) 隔离）
  ├─ httpx.AsyncClient.request
  ├─ 错误分流：asyncio.CancelledError 原样 / httpx.HTTPError → TransportError
  ├─ 状态码判定：declared_success = 2xx 且 ∈ operation.responses
  │   （304 仅在 operation 声明了 304 时算 not-modified 成功）
  ├─ 失败：_decode_error → ErrorResponse → server_response_error（带 request_id）
  └─ 成功：response_type.validate_json → ValidationError → InvalidResponseError

create_cli（cli/app.py:39）                      ServiceController（service/controller.py:66）
  ├─ @cli.callback() 全局选项 → context.meta  ├─ install：分阶段事务
  ├─ register_commands 静态内容命令            │   前置守卫（零副作用）→ flock →
  └─ entry_points(group="powercontext.cli")    │   双层指纹比对 → 提交（回滚式）
      ModuleNotFoundError → continue           ├─ _wait_until_live：60s+120s 宽限
                                                └─ adapters/launchd|systemd|windows
```

## 调用链路

### CLI 装配：entry_points 插件

`pyproject.toml:102-108` 声明六个入口：`code/config/doctor/service/server/setup`，其中四个指向**可选 extras** 的模块。`create_cli()` 流程：建 root Typer → `@cli.callback()` 注册全局选项（`--server-url/--timeout/--json` 等经 `configure_client` 塞进 `context.meta`——**客户端实例延迟到子命令执行时才构造**）→ `register_commands` 静态注册内容命令 → 遍历 `entry_points(group="powercontext.cli")`（按 name 排序保证确定性）加载，`ModuleNotFoundError` 直接 continue（可选依赖缺失时 CLI 依然可启动），重名抛 ValueError。第三方集成（hermes/codex 等）也可以不修改 core 就注入子命令。

### 服务安装：事务式分阶段

```
install()（controller.py:78-131）
  1. 前置守卫（任何失败零副作用）：
     adapter.support() → UNSUPPORTED 即抛
     _build_definition → ServiceDefinition（OWNERSHIP_MARKER + 包版本 +
       python_executable 指纹；强制 loopback bind——"personal services require
       a loopback Server bind"；shell 残留 POWERCONTEXT_SERVER_* 时拒绝并脱敏打印）
     initial_probe：ProbeState.CONFLICT → "refusing to install over another listener"
  2. with _service_lock（fcntl.flock / msvcrt.locking，5s 超时）：
     磁盘指纹（registration.definition != definition 或渲染结果变化）
     + manager 内存态指纹（launchctl print 解析 metadata 比对）
     + FOREIGN/UNKNOWN 拒绝修改（只动自己装的 job）
  3. 提交分界线：changed → _commit_definition（write→reload→enable，
     任一步失败 suppress 回滚：disable + restore(previous) + reload + enable）
  4. 启动验证：_wait_until_live（60s 硬预算 + 120s 宽限；宽限期内每 5s 查
     manager_state，job 还活着就继续等——首次启动要编译字节码，以 native job
     自身存活为权威）；未 LIVE → _post_commit_error（不回滚，附 status 快照
     与 log_location 指引）
```

`_post_commit_error` 的关键语义：**提交后失败不再回滚**（服务定义已在磁盘上、往往可自愈），错误文案明确区分"注册失败"（无副作用）与"注册成功启动失败"（需要看日志重试）。前置守卫还包括：非 Windows 平台拒绝 `start_on_login=False`（exit_code=2——常驻是个人服务的语义前提）。指纹三维度（package_version/python_executable/env_file identity）使 `status` 能把"坏了"细分为 STALE（重装即愈）/MISSING_EXECUTABLE/FOREIGN，输出精确 recovery_action。

方法速查：

<details>
<summary>三模块关键类速查表</summary>

| 类/函数 | 位置 | 一行职责 |
| --- | --- | --- |
| `PowerContextClient` | `client/client.py:322` | ~60 方法薄门面，统一走 `_request` |
| `_request` | `client.py:1164` | 唯一执行路径（序列化/span/错误分层） |
| `_request_handoff_report_content` | `client.py:502` | 唯二执行路径（原始 bytes 流式） |
| `create_cli` | `cli/app.py:39` | entry_points 插件装配 |
| `ServiceController` | `service/controller.py:66` | 事务式服务安装（probe/sleep 可注入） |
| `native_service_adapter` | `service/adapters/__init__.py` | 按平台选 launchd/systemd/windows |

</details>

## 核心实现

### 为什么 client 手写而不用生成的整套 SDK

模型与 Operation 表是生成的，但**执行层手写**。从代码可推断的理由：(a) **传输策略是产品决策而非协议决策**——构造期即拒绝明文非 loopback（`client.py:351`），且注释明确论证"传入 http_client 不等于安全"（防 LangGraph 共享连接池绕过守卫，须显式 `trust_transport_security=True`）；(b) 错误语义需要人为分层（TransportError/ServerResponseError/InvalidResponseError）并统一携带 `X-PowerContext-Request-ID`；(c) OTel span 的 failure-isolation 策略（基础设施坏了绝不影响业务请求，无 tracer 时返回空对象 no-op）；(d) 个别操作的请求级语义特例（`_prepare_request` 对 `PREPARE_CONTEXT` 的 exclude_unset 例外——调用方没显式设 assembly 时从 payload pop 掉，让 server 端按默认装配）。

### 明文守卫放在构造期而非请求期

`client.py:335-352`：fail-fast，且对"请求体本身含 Memory 内容"的威胁模型做了显式建模——没有 token 不代表明文可接受。同一守卫在 hook 侧也有对应（`powercontext_client_config.py` 的 `normalize_server_url` 拒绝非 loopback 的 http URL）。

### 向导状态机

`cli/config_wizard.py` 1636 行主文件 + 6 个拆分文件（`_agents/_document/_installation/_models/_seekdb/_ui`，合计约 3000 行），按**对话页面**切分而非按函数（document=逐页渲染、models=模型选择、ui=交互原语）——显式的 page-by-page 状态机组织。向导写一个 `.env` + `.env.next-steps.md`；seekdb 缺依赖时问一次并在后台安装。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 + 声明式路由表 | `Operation` 纯数据 + 手写 `_request` | 方法签名是人写的 API，执行逻辑单点 |
| 插件注册 | entry_points group | 可选 extras 装配，第三方可扩展 |
| 事务式安装 + 双层指纹 | `ServiceController` | 用户机器上的系统级 manager 失败留半成品比失败更糟 |
| 装饰器链 | `UsageReporting*`（inference 侧） | usage 归因不侵入业务调用 |
| failure-isolated tracing | `ClientSpan` 全 suppress | 观测基础设施坏了不影响业务 |

## 模块间交互

**Client 的复用面**：`integrations/langchain/src/powercontext_langchain/client.py`（`PowerContextMiddleware`，293 行，LangChain AgentMiddleware——注入 system context + turn 采集）、`langgraph/`（recall/tools）、`pydantic-ai/toolset.py`（255 行，Toolset 形态）、`hermes/`、`codex/plugins/`；core 包内 `cli/system.py`、`cli/config_wizard.py` 等也 import client。集成方可传入自己的 `httpx.AsyncClient`（连接池共享）但必须显式 `trust_transport_security=True`。**CLI → Client**：全局选项经 Typer Context 传递，每命令一个短生命周期实例。**Service → env**：controller 依赖 `cli/env_file.py`（临时清空 `POWERCONTEXT_HOME` 保证读 .env 而非继承 shell）与 `server/configuration.py`（安装期复用同一套 Server 配置解析推导 endpoint）。

14 家集成按形态分四类：**hook 型**（claude-code/codex：stdlib urllib，零依赖进程 + 6s 预算 fail-open）；**中间件型**（langchain/langgraph）；**toolset 型**（pydantic-ai）；**插件协议型**（agent-plugin 通用 mcp.json + SKILL.md、dsh/hermes/openclaw/opencode/pi/workbuddy/zcode 各家 CLI 配置助手）。共享 SKILL.md 的路由表 + 反幻觉边界（"Automatic capture is only Source acceptance, not proof of saved Memory"）。

## 扩展方式

**新增 CLI 子命令**：`pyproject.toml` 的 entry_points 加一行 `foo = "powercontext.foo.cli:app"`，模块里 `app = typer.Typer(name="foo")`（必须有 name，`app.py:108` 校验）。core 内置内容命令走 `register_commands`（`client/cli.py:1787`）静态注册。

**新增 client 方法**：yaml 加 operation → 生成 → `client.py` 顶部 import 新常量与模型，加薄方法 `return await self._request(FOO, request, path_parameters=...)`；响应非 JSON 或需流式参照 `_request_handoff_content`；`request_location == "query"` 的操作走 query 参数而非 body（新 operation 的声明决定走向）。

**修改服务安装行为**：维持三条不变量——提交前零副作用、提交后失败用 `_post_commit_error`（不回滚、附 status）、变更判定同时看 definition 与 render 结果两条渠道。
