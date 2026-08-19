---
source:
  type: "源码解读"
  project: "OpenCodeReview"
  url: "https://github.com/alibaba/open-code-review"
title: "报告查看器"
date: "2026-08-19T17:25:00+08:00"
category: [AI, Agent, "AI Coding", "Code Review", "Open Code Review", CodeWiki, "1.9.7"]
tags: ["OpenCodeReview", "Go", "Viewer", "HTTP", "Security"]
description: "OpenCodeReview 报告查看器——浏览器端审查会话浏览/回放，JSONL 会话数据懒加载聚合，hostguard 防 DNS rebinding，CSP 安全头，单二进制 embed 部署。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Review/Open-Code-Review/CodeWiki/1.9.7/00-overview)

---

## 模块定位

`internal/viewer/`（约 1,250 行）是 `ocr viewer` 命令的实现——启动本地 HTTP 服务，在浏览器中浏览和回放审查会话。它与审查主链路解耦：不参与 review/scan 的执行，只读取 `session` 包持久化的 JSONL 会话文件做可视化。它是可观测性的「人肉版」：相比遥测的指标聚合，viewer 提供逐会话、逐文件、逐工具调用的完整回放，是理解 run 行为的最佳工具。

## 模块架构

```
internal/viewer/
├── server.go          # StartServer + 路由 + parseTemplate/renderTemplate + FuncMap
├── store.go           # 会话数据访问层（DiscoverRepos/ListSessions/LoadSession）
├── hostguard.go       # Host 校验中间件（防 DNS rebinding）
├── handler.go         # 三个 HTTP handler
├── securityheaders.go # 安全响应头（CSP/X-Frame 等）
└── templates/ static/ # go:embed 内嵌 HTML 模板 + CSS/JS
```

核心组件：`StartServer`（入口）、`store`（会话数据仓储）、`hostGuard`（host 防护）、`securityHeaders`（安全头）。用洋葱模型 middleware 链组合：`securityHeaders(hostGuard(mux))`。

## 调用链路

viewer 命令 → 启动 server → 读取 store → 渲染页面：

```
viewer_cmd.go → viewer.StartServer(addr)                    # server.go
  ├─ SessionsRoot() → $HOME/.opencodereview/sessions
  ├─ 注册路由 /、/r/{repo}、/r/{repo}/{sessionID}、/static/
  ├─ hostGuard(allowed, mux)                                # 中间件层
  ├─ securityHeaders(guarded)                               # 外层
  └─ srv.ListenAndServe()

路由分发 → handler.go
  ├─ handleRepos → store.DiscoverRepos(root)                # 扫描 sessions 子目录
  ├─ handleSessions → store.ListSessions(root, repo)        # peekSession 只取首行+review_item+末行
  └─ handleSession → store.LoadSession(root, repo, id)      # readJSONLLines 全量解析

renderTemplate(w, name, data)                               # html/template 引擎 + FuncMap
  └─ parseTemplate 从 embed.FS 读 templates/*.html
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `StartServer` (`server.go`) | 启动 HTTP 服务 | middleware 洋葱链 + Go 1.22 mux |
| `peekSession` (`store.go`) | 列表页轻量读取 | 只取首行+review_item 行+末行，不全量解析 |
| `LoadSession` (`store.go`) | 详情页全量解析 | `readJSONLLines` 用 64KB buffer 非 Scanner |
| `hostGuard` (`hostguard.go`) | Host 校验 | default-deny，仅 loopback + 显式 allowlist |
| `securityHeaders` (`securityheaders.go`) | 安全响应头 | CSP `default-src 'self'`，无 unsafe-inline |
</details>

## 核心实现

### store 读取会话数据

`store.go` 直接读 `$HOME/.opencodereview/sessions/<encodedRepo>/<sessionID>.jsonl` 的 JSONL 文件，不经过 `session` 包的运行时 API。`peekSession` 只取首行（`session_start` 元信息）+ `review_item` 行（comment 计数）+ 末行（`session_end` + `run_manifest`），避免全量解析做列表页；`LoadSession` 才全量解析。`readJSONLLines` 用 `bufio.NewReaderSize(64KB)` + `ReadBytes('\n')` 而非 `bufio.Scanner`——`session_end` 内嵌完整 `run_manifest` 可能超 10 MiB Scanner 上限，这是被实际 bug 逼出的设计。`applySessionEnd` 把 `session_end` 的 `run_manifest` 反序列化成 `session.RunManifest`，校验 `SchemaVersion == "ocr.run-manifest/v1"`，旧版无 manifest 的会话标 `Legacy=true`。

### 路由与渲染

用 Go 1.22+ 的 `mux.HandleFunc("/r/{repo}/{sessionID}", ...)` + `r.PathValue`，手动校验 `..` 和 `/` 防路径穿越。模板引擎是标准库 `html/template`，无第三方依赖；`FuncMap` 里 `orderedTasks` 固定 `PlanTask → MainTask → ReLocationTask → MemoryCompressionTask` 顺序，把 map 渲染成有序切片；`severityCounts`/`groupCommentsByFile` 等视图逻辑下沉到模板层。

### hostguard 防 DNS rebinding

`server.go` 注释明说——session JSONL 含被审源码与 LLM 分析，恶意网页可把自己的域名 DNS rebinding 到 127.0.0.1，浏览器同源策略会放过请求但 Host 头仍是攻击者域名，`hostGuard` 据此拦截。`buildAllowedHosts` 默认只放 loopback；绑定 `0.0.0.0`/`::` 时**不**自动加入，强制运维设 `OCR_VIEWER_ALLOWED_HOSTS` 环境变量才能在外网访问——强制 acknowledgment。

### 安全响应头

CSP `default-src 'self'` + `script-src 'self'`（无 `unsafe-inline`，脚本已外置到 `static/session.js`）、`frame-ancestors 'none'`（防点击劫持）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 关闭地理位置/摄像头/麦克风。HSTS **故意不加**：viewer 在 loopback 跑明文 HTTP，HSTS 会错误 pin localhost。

### 为什么本地起服务而非纯静态导出

JSONL 会话数据需运行时聚合（token 分文件统计 `FileTokenBreakdown`、按 `TaskType` 分组、comment 按文件 group），且要跨多会话浏览（repos → sessions → session 三级导航）。纯静态导出需预生成全部聚合视图，而本地 server 可按需 `LoadSession` 懒加载，单二进制零依赖部署（`go:embed` 内嵌 templates/static）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| Middleware 链（洋葱） | `securityHeaders(hostGuard(mux))` (`server.go`) | 分层安全，每层 `http.Handler` 包装 |
| 仓储 | `store.go` DiscoverRepos/ListSessions/LoadSession | 文件系统抽象成数据访问层，handler 不碰路径 |
| Guard/Allowlist | `hostguard.go` `hostGuard` | default-deny，loopback + 显式 allowlist |
| Template + FuncMap | `parseTemplate` (`server.go`) | 视图逻辑下沉模板层 |
| Embed FS | `//go:embed templates/*.html static/*` | 单二进制零依赖部署 |

## 模块间交互

viewer → `session`（`store.go` import `internal/session`，反序列化 `RunManifest`，校验 `SchemaVersion`）。被 `cmd/viewer_cmd.go` 唯一调用，传 `--addr`。viewer 不依赖 agent/llm/llmloop 等执行层——它是审查产物的消费方，只读会话文件。

## 扩展方式

- **新增查看页面**（如 token 用量详情页）：`templates/` 加 `tokens.html`；`server.go:StartServer` 注册路由；`handler.go` 加 handler 调 `LoadSession` 后 `renderTemplate`；`FuncMap` 加辅助函数。
- **改安全策略**（如允许内网访问）：`hostguard.go:buildAllowedHosts` 放宽 loopback 集合，或引导设 `OCR_VIEWER_ALLOWED_HOSTS`；放宽 CSP 改 `securityheaders.go:contentSecurityPolicy`，需同步把脚本外置以免破坏 CSP。
- **新增会话记录类型解析**（如新 task type）：`store.go` 顶部 `TaskType` const 加值；`LoadSession` 的 `switch typ` 加 case；`parseTemplate` 的 `taskTypeClass` 和 `orderedTasks` 加映射，否则渲染归到 default。
