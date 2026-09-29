---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "协议接入"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "MySQL 协议"]
description: "TiDB MySQL 协议服务器解读：手写 PacketIO 二进制编解码、握手状态机、COM 分发与连接内存复用"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/server/` 手写实现 MySQL wire protocol：握手、认证、COM 命令分发、结果集序列化、Prepared Statement 二进制协议。它是 SQL 内核的第一道门，也是**与 MySQL 生态兼容的物理契约**——连接器、ORM、代理全都只认这套字节流。与内核的解耦点：每连接一个 `clientConn` 持有经 `TiDBContext` 包装的 session，协议层不 import session 实现（可被 mock_conn 替换测试）。注意目录事实：命令分发就在 `conn.go` 的 `dispatch` 大 switch（无独立 command 包）；`pkg/server/handler/` 下是 HTTP status 端口的 handler（`tikvhandler` 等），与 wire protocol 无关。

## 模块架构

```
pkg/server/
├── server.go             # Server：accept 循环（Run :499）+ 连接表 + Kill
├── conn.go               # clientConn（:171）：握手 + dispatch（:1437）+ handleQuery（:1857）
├── conn_stmt.go          # Prepared/Execute/Fetch 二进制协议
├── driver_tidb.go        # TiDBContext（:63）：session 的防腐包装
├── internal/
│   ├── packetio.go       # PacketIO（:59）：MySQL 包编解码、压缩、序列号校验
│   ├── resultset/        # ResultSet/CursorResultSet 抽象
│   └── column/ textrow/  # 列定义与 text/binary 行序列化
└── handler/              # HTTP status 端口（运维接口，非 wire protocol）
```

## 调用链路

```
Server.Run (server.go:499)
└─ startNetworkListener (:561)  # for { Accept; s.newConn; go s.onConn(conn) }
    └─ onConn (:766) → clientConn.handshake (conn.go:333)
        ├─ writeInitialHandshake (:474)    # 版本/salt/capability/默认 auth 插件
        ├─ readOptionalSSLRequestAndHandshakeResponse (:580)  # 可选 TLS 升级
        ├─ checkAuthPlugin (:939)          # 插件协商，必要时 authSwitchRequest
        ├─ openSessionAndDoAuth (:854)    # 认证 + useDB + init_connect
        └─ 写 OK、协商压缩 → clientConn.Run (:1157)
            for {
              CAS(Dispatching→Reading) → readPacket（wait_timeout 生效）
              CAS(Reading→Dispatching) → dispatch (conn.go:1437)   # 命令大 switch
                case mysql.ComQuery → handleQuery (:1857)
                  ├─ cc.ctx.Parse → []ast.StmtNode
                  └─ 逐条 handleStmt (:2217) → cc.ctx.ExecuteStmt
                      → 有结果集则 writeResultSet (:2473)
                        → writeColumnInfo + writeChunks → flush
            }
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `dispatch` in `conn.go:1437` | 按 command byte 路由 | 常量表 `mysql.ComXxx` 来自 parser 包（同源维护） |
| `PacketIO.readOnePacket` in `packetio.go:141` | 读一个 MySQL 包 | 序列号校验 + maxAllowedPacket 累计防超大包 |
| `handleQuery` in `conn.go:1857` | COM_QUERY 全流程 | 多语句按 `ClientMultiStatements` 拆分执行 |
| `HandleStmtPrepare` in `conn_stmt.go:73` | 二进制 prepare 协议 | 手写 stmt_id/列数/参数定义包 |

## 核心实现

### PacketIO：为什么手写二进制编解码

MySQL 包格式（3 字节长度 + 1 字节 sequence + payload，16MB 分片、可选 zlib/zstd 压缩帧）没有标准 Go 库，且**序列号必须跨包连续维护**——`readOnePacket`（`packetio.go:141`）手工解 header 并校验 `sequence != p.sequence` 报 `ErrInvalidSequence`；写侧 `WritePacket`（`:244`）手工分片。压缩序列号（`compressedSequence`）与普通序列号是两套计数。`readOnePacket` 同时累计校验 `maxAllowedPacket`，在协议层拒绝超大恶意包。

### 连接级内存复用：arena + chunkAlloc

MySQL 协议的特点是**每条语句几十上百个小 packet**，GC 压力全在热路径上。`clientConn` 持两级复用：连接级 `arena.Allocator`（`cc.alloc`，32KB 起步，每轮 `Run` 循环开头 `cc.alloc.Reset()`，`conn.go:1221`）与请求级 `chunkAlloc`（dispatch 后 `ClearAlloc` + `Reset`，`:1278`）。结果集写包全部 `cc.alloc.AllocWithLen(4, n)` 复用首包 buffer（如 `writeColumnInfo` in `:2512`）——这是把 allocator 当 arena 用的经典技巧， TiDB 无 GC 压力的关键一环。

### 状态机与 KILL：CAS 驱动的连接状态

`clientConn.status` 四态（`connStatusDispatching/Reading/Shutdown/WaitShutdown`）全部用 `CompareAndSwapStatus`（`conn.go:255-274`）驱动：Read/Dispatch 双态循环是正常态，shutdown/kill 通过让 CAS 失败注入事件。`dispatch` 里 `context.WithCancel` 存进 `cc.mu.cancelFunc`（`:1458-1462`），使 `Server.Kill → killQuery`（`server.go:1110`）能跨 goroutine 取消执行；ctx 同时携带 topSQL/pprof label/trace task 这些"每条语句一份"的元数据——这就是协议层大量闭包/defer 传 ctx 的原因。写结果集途中被 KILL 的处理同样精细：`SQLKiller.SetFinishFunc` + `InWriteResultSet`（`:2281-2288`）保证 `rs.Finish()` 一定被调（见概览数据流）。

### 并发限流与优雅关闭

连接数之上还有一层 **token 限流**：`Server.concurrentLimiter`（`util.TokenLimiter`，按 `cfg.TokenLimit` 初始化）控制同时在执行语句的连接数，dispatch 前取 token、结束释放——防止海量并发把 CPU 打穿。优雅关闭是三步协议：`startShutdown` 先把健康检查置 false（摘流量），再等 `GracefulWaitBeforeShutdown` 让 LB 切走，最后 `enterShutdownMode` 后 `registerConn` 直接拒绝新连接；已在事务中的连接（`Run` 循环里 `inShutdownMode` 与 `InTxn()` 双判断）允许跑完当前事务——协议层内嵌的关闭状态机与连接状态 CAS 是同一套机制的两种应用。

### Conn 与 Session 解耦 + 认证插件

`cc.ctx` 是 `*TiDBContext`（`driver_tidb.go:63`，session + prepared stmt 表），用 RWMutex 保护——因为 `COM_CHANGE_USER`/`COM_RESET_CONNECTION` 会**销毁重建 session 而 TCP 连接保持**。一个反直觉细节：`writeInitialHandshake` 结尾故意 `cc.ctx.Close(); cc.SetCtx(nil)`（`:520-525`）——collation/capability 要等客户端 response 才知道，session 必须用最终值重建。认证是插件化的：`checkAuthPlugin`（`:939`）按 `mysql.user.plugin` 选择 `mysql_native_password`/`caching_sha2_password`（`authSha` in `:761`）/JWT session token/SM3/LDAP 等，不匹配则发 `authSwitchRequest`（`:276`）让客户端换插件，extension 还能注册自定义插件。协议行为由系统变量驱动：`wait_timeout` 每轮读取（`getWaitTimeout` in `:557`）、`default_auth_plugin` 在握手时经 `GetGlobalSystemVar` 读取。

### Prepared Statement 与 cursor

`HandleStmtPrepare`（`conn_stmt.go:73`）调 `cc.ctx.Prepare` 后手写二进制写出 stmt_id/参数数/列定义；`handleStmtExecute`（`:138`）解析 null bitmap 与参数类型值，`binary=true` 走 binary 协议；`CursorTypeReadOnly` 开启 cursor 模式后由后续 `handleStmtFetch` 分批 `writeChunksWithFetchSize`——这是 MySQL 协议里少有的"流式拉取"语义。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 命令分发 | `dispatch` switch in `conn.go:1437` | 协议命令封闭集合，穷举可检 |
| 状态机 | `connStatus*` + CAS in `conn.go:255-274` | shutdown/kill 与正常循环的竞态安全交错 |
| 策略（插件） | `checkAuthPlugin` in `conn.go:939` | 认证方式可扩展（含 extension 注册） |
| 防腐层 | `TiDBContext` in `driver_tidb.go:63` | 协议层可脱离 session 实现测试 |
| 对象池 | arena/chunkAlloc in `conn.go` | 消除每语句 packet 分配 |

## 模块间交互

下游 session：`cc.ctx.ExecuteStmt` 即 `session.executeStmtImpl`（见 [07-session-txn](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/07-session-txn)）；COM_INITDB 的 `use db` 也构造 `ast.StmtNode` 走 session 执行（`useDB` in `conn.go:1621`）。parser：`cc.ctx.Parse`。错误出口：session 层决定 retry 后仍失败的错误经 `Run` 循环调 `cc.writeError`（`:1726`）封装 ERR packet。Proxy Protocol：`go-proxyprotocol` 的 LazyListener 包裹 listener（`initTiDBListener` in `server.go:417`），`PeerHost` 优先返回代理传来的真实 peer——云上负载均衡场景的真实客户端 IP。

## 扩展方式

新增 COM 命令：`pkg/parser/mysql/const.go` 加常量与 `Command2Str` 映射 → `conn.go` 的 `dispatch` 加 case → 新建 `handleXxx`（模板：`handleResetConnection` in `conn.go:2801`）→ `conn_test.go` 协议级测试。新增"系统变量影响协议"的行为：变量注册在 `pkg/sessionctx/vardef`/`variable`，读取点在 `conn.go`；需握手协商的则改 `writeInitialHandshake` + capability 位。改包层（序列号/压缩/心跳）只动 `internal/packetio.go` 一处——分层的好处。
