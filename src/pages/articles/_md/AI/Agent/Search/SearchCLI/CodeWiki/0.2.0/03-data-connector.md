---
source:
  type: "源码解读"
  project: "SearchCLI"
  url: "https://github.com/volcengine/SearchCLI"
title: "数据连接器"
date: "2026-08-19T17:42:29+08:00"
category: ["AI", "Agent", "Search", "SearchCLI", "CodeWiki", "0.2.0"]
tags: ["SearchCLI", "TypeScript", "Data Connector", "Cursor", "At-Least-Once"]
description: "SearchCLI 数据连接器——Source/Runner/Sink 管道、游标断点续传与多源策略。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Search/SearchCLI/CodeWiki/0.2.0/00-overview)

---

## 模块定位

数据连接器（`src/core/connector/`，12 个文件、约 1629 行）是 SearchCLI 的数据上车子系统：从外部数据源（MySQL/MongoDB/Redis Stream/JSONL 文件）抽取数据，经 Runner 主循环缓冲后批量写入火山引擎 AI Search 数据集，支持游标断点续传、状态管理、信号停止与 daemon 模式。它对应 `vs connector init/run/status/stop/export/inspect` 命令组。这个模块独立成文是因为它有一套自洽的管道架构（Source→Runner→Sink）和明确的状态机（断点续传），职责边界清晰——它不依赖搜索/推荐业务逻辑，只做"把外部数据可靠地搬到 AI Search"。

## 模块架构

![连接器管道架构](/vibe-reading/images/articles/searchcli-internals/connector-pipeline.svg)

连接器内部是经典的管道/过滤器结构，三个核心角色：**Source**（抽取，四种实现可互换）、**Runner**（编排主循环，`runConnector` 自由函数非 class）、**Sink**（批量写入，单实现直接 new）。`StateStore` 是纯函数集合（无 class 封装），负责把游标和统计持久化到文件系统。`Bootstrap` 提供两条装配路径——常规运行（读 config.json → 工厂造 Source → new Sink）和导出（Source → 本地 JSONL 文件，不写火山引擎）。`Config` 用 Zod schema 做运行时校验，source 部分用 `z.discriminatedUnion('type', ...)` 按 type 字段分支——与 TypeScript discriminated union 类型定义一一对应，类型安全与运行时校验统一。

## 调用链路

`vs connector run --job <name>` 的调用链：

1. `src/commands/connector/run.ts`（oclif Command）解析 flag，调 `runConnectorRunCommand()` in `src/app/connector-commands.ts`（做 daemon spawn/env 注入等编排）。
2. `runConnector()` in `src/core/connector/runner.ts:43` 是核心：`loadConnectorConfig(job)` 读 config.json → `loadConnectorRuntime(job)` 检查并发锁（防同 pid 进程重复跑）→ `createConnectorSource(config.source)` 工厂造 Source → `new ConnectorSink(config.sink, serviceConfig)` → 注册 SIGTERM/SIGINT handler → 进主循环。
3. 主循环每轮：`source.readChanges(state.cursor, maxRows)` 返回 `AsyncIterable<ConnectorChange>`，Runner `for await` 逐条 `sink.buffer(change)` + `state.cursor = change.cursor` → `await sink.flush(state)` 批量写 → `saveConnectorState()` 持久化游标 → 检查停止信号 → `sleep(intervalMs, {signal})` 可被 abort。
4. `sink.flush()` in `src/core/connector/sink.ts:46`：`splice` 取出缓冲数组 → `client.dataWrite(datasetId, {fields: [...]})`（走 `VikingRuntimeApiClient` → `postJson`）→ 更新 `state.stats`。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `runConnector()` in `src/core/connector/runner.ts:43` | 运行主循环 | 自由函数非 class，编排生命周期；逐条 buffer+cursor、批量 flush |
| `readChanges(cursor, limit)` in Source 接口 | 抽取变更 | 返回 `AsyncIterable<ConnectorChange>`，天然支持流式/分页 |
| `ConnectorSink.flush(state)` in `src/core/connector/sink.ts:46` | 批量写入 | splice 清空缓冲，一次提交整批减少 HTTP 往返 |
| `createConnectorSource(config)` in `src/core/connector/sources/index.ts:10` | 工厂造 Source | switch config.type 分发到四种实现 |
| `saveConnectorState()` in `src/core/connector/state-store.ts` | 持久化断点 | 写 state.json，嵌套合并 stats 防字段缺失崩溃 |
| `dynamicImport()` in `src/core/connector/sources/helpers.ts:11` | 动态导入驱动 | `new Function` 绕过 bundler，让 mysql2/mongodb/redis 可选 |

</details>

## 核心实现

### Source 抽象与多源策略

`ConnectorSource` 接口 in `src/core/connector/types.ts:134` 定义统一契约：`open()`/`close()`/`readChanges(cursor, limit): AsyncIterable<ConnectorChange>`。`readChanges` 返回异步迭代器，Runner 用 `for await...of` 拉取——天然支持流式与分页两种语义。每条 `ConnectorChange` 携带自己的 `cursor`，Runner 逐条更新 `state.cursor`。工厂函数 `createConnectorSource()` in `src/core/connector/sources/index.ts:10` 按 `config.type` switch 分发到四种实现，这是策略模式——Runner 只依赖接口，不感知具体实现。

四种实现的抽取逻辑各有侧重：**JSONL**（`jsonl.ts`）用 `readline.createInterface` 逐行读，游标是行号，重启从 `startLine` 跳过已读行，ID 回退 `jsonl:{lineNum}`——唯一不需要 cursor field 的源。**MySQL**（`mysql.ts`）用 keyset pagination 复合游标 `(cursor_field > ? OR (cursor_field = ? AND id_field > ?))`，避免 OFFSET 性能退化；用 text-protocol `query()` 而非 prepared statement（`mysql.ts:66` 注释解释某些部署对 `execute()` 报错）；`quoteIdentifier` 白名单校验防 SQL 注入。**MongoDB**（`mongo.ts`）用 `$or` 构建等价 keyset 查询，timestamp 游标转 `Date`、`_id` 匹配 24 位 hex 则转 `ObjectId`（字符串比较会不匹配）。**Redis Stream**（`redis-stream.ts`）用 `xRead` 消费，游标是 Redis 内置 entry ID（`{timestamp}-{seq}`），初始 `0-0`——唯一真正面向"流"语义的源，其他三个都是轮询拉取。

> `dynamicImport()` in `src/core/connector/sources/helpers.ts:11` 用 `new Function('specifier', 'return import(specifier)')` 包裹 `import()`，是为了让 bundler（esbuild/rollup）不追踪这个动态 import，从而 `mysql2`/`mongodb`/`redis` 成为**可选依赖**——用户只装自己用的驱动即可，不必装全部三个。错误信息友好提示 "Run npm install in this CLI package before using this connector"。

### Runner 主循环与断点续传

`runConnector()` in `src/core/connector/runner.ts:43` 是模块核心，自由函数（非 class）。主循环每轮：读变更 → 逐条 buffer + 推进 cursor → flush 批量写 → `saveConnectorState()` 持久化 → 检查停止 → 可中断 sleep。一个关键设计决策：**游标逐条推进但 state 只在 flush 成功后才保存**。这意味着崩溃恢复时，state.json 记录的是上一轮 flush 成功后的最后 cursor——如果 flush 成功但 saveConnectorState 前崩溃，下一轮会重复读上一批数据，靠 upsert 幂等性兜底。这是 **at-least-once 语义**，不是 exactly-once。

StateStore 的状态全在文件系统（`/tmp/viking/connector/<job>/`，可经 `VIKING_CONNECTOR_ROOT` 覆盖）：`config.json`（配置）、`state.json`（游标+统计）、`runtime.json`（pid/status/心跳）、`stop`（停止信号文件，存在即请求停止）、`trace.ndjson`（事件日志）、`imported-records.log`（导入记录）。崩溃恢复时 `loadConnectorState` 读回最后 cursor，`runtime.json` 的 status 可能停留在 `running` 但 `isProcessAlive(pid)` 返回 false（旧 pid 已死），所以不会被并发锁拦住。`loadConnectorState()` in `src/core/connector/state-store.ts:20` 对 `stats` 做嵌套合并——防旧 state.json 缺少新增 stats 字段时崩溃。停止机制双通道：`connectorStopRequested()` 检查 `stop` 文件（`vs connector stop` 创建），SIGTERM/SIGINT handler 调 `requestInProcessStop` 设 `stopReason` 并 abort 当前 sleep（`sleepAbortController?.abort()` in `src/core/connector/runner.ts:98`）。

### Sink 批量写入

`ConnectorSink.flush()` in `src/core/connector/sink.ts:46` 取 `splice` 清空 `upserts[]` 缓冲，一次 `client.dataWrite(datasetId, {fields: batch.map(i=>i.fields)})` 提交整批，减少 HTTP 往返。批次大小由 `config.batch.maxRows` 控制。关键设计：**当前 `deleteMode: 'ignore'` 是唯一支持的 delete 模式**（`src/core/connector/types.ts:25`），delete 变更只记 id 到 `ignoredDeleteIds` 不调 API——连接器当前只做 upsert 同步，不处理删除。**无重试**：flush 直接调 dataWrite，失败异常冒泡到 Runner 的 try/catch，由 `handleRunError` 记录并终止；下次手动重启从上次 cursor 继续。Sink 假设目标端 upsert 幂等，这是 at-least-once 安全的前提。底层 `dataWrite()` in `src/core/runtime-api-client.ts` 走 `postJson` → `requestJson`，用火山引擎签名认证。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略 (Strategy) | `ConnectorSource` 接口 + 4 实现 in `src/core/connector/sources/` | 统一契约下 4 种实现可互换，Runner 不感知具体源 |
| 工厂 (Factory) | `createConnectorSource()` in `src/core/connector/sources/index.ts:10` | 按 config.type 创建对应 Source，新增源只加 case |
| 管道/过滤器 (Pipeline) | Source → Runner → Sink | 数据单向流动，每阶段处理并传递 |
| 观察者 (Observer) | `src/core/connector/runner.ts:101` SIGTERM/SIGINT | 信号监听改控制流，中断 sleep |
| discriminated union | `src/core/connector/types.ts:64` + `config.ts:43` | TS 类型 + Zod 运行时双重保障，按 type 分支 |

## 模块间交互

调用方：`src/commands/connector/*`（oclif Command）→ `src/app/connector-commands.ts`（编排）→ `src/core/connector/`（核心）。connector 依赖 core 的 `service-config`（`resolveServiceConfig`/`ServiceConfig`）、`runtime-api-client`（`VikingRuntimeApiClient.dataWrite()`）、`files`（`ensureDir`/`writeJson`/`slugify`）、`http`（间接，经 runtime-api-client）。外部库：`zod`（必装，配置校验）、`mysql2`/`mongodb`/`redis`（可选，`dynamicImport` 按需加载）。无循环依赖。

## 扩展方式

新增 Postgres 数据源：改 6 处——`types.ts` 加 `'postgres'` 到 `ConnectorSourceType` + 新增 `PostgresConnectorSourceConfig` + union 加成员；新建 `sources/postgres.ts` 实现 `PostgresConnectorSource`（`dynamicImport('pg')`，keyset pagination 参考 `mysql.ts`）；`sources/index.ts` 工厂 switch 加 `case 'postgres'`；`sources/helpers.ts` 的 `getSourceEnvRequirements` 加 PG 环境变量；`config.ts` 的 `sourceSchema` discriminatedUnion 加 postgres schema + `buildSourceConfig` 加分支；`src/commands/connector/init.ts`/`export.ts` 的 source flag options 加 `'postgres'`（注意 `init.ts:54` 当前有 `if (flags.source !== 'mysql' && flags.source !== 'jsonl')` 硬编码守卫，需放宽——mongo/redis-stream 核心层已支持但命令层未开放）。

> 当前实现的边界：四种 Source 都只 yield `op: 'upsert'` 不 yield `delete`，无 binlog CDC / Mongo Change Stream 消费——是轮询式全量增量同步，不是真正 CDC。Mongo 和 Redis Stream 有 CDC 能力但当前只做了轮询拉取（Mongo 用 find+sort，Redis 用 xRead 一次性拉取而非 XREAD BLOCK 长连接）。
