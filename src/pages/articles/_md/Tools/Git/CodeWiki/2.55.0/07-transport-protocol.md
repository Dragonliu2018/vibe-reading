---
source:
  type: "源码解读"
  project: "git"
  url: "https://github.com/git/git"
title: "传输与协议"
date: "2026-08-11T20:38:04+08:00"
category: [Tools, Git, CodeWiki, "2.55.0"]
tags: ["git", "C", "transport", "pkt-line", "protocol-v2", "http"]
description: "解读 Git 网络传输——transport_vtable 后端策略、pkt-line 帧协议、fetch/push pack 协议、protocol v2 capability 协商、negotiation。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/Git/CodeWiki/2.55.0/00-overview)

---

## 模块定位

传输与协议是 Git 唯一与网络/外部进程耦合的模块——`git fetch`/`push`/`clone`/`ls-remote` 都通过它建立连接、协商对象、传输 pack。本模块负责传输抽象层（统一 local/ssh/http/bundle 多后端）、wire protocol（pkt-line 帧格式 + capability 协商）、fetch/push pack 协议、以及 negotiation（找出 common commits 避免重复传输）。它独立成模块是为了让上层 fetch/push 命令不感知底层协议——新增一种传输方式只需实现 vtable 或写一个 remote helper，无需改命令逻辑。核心职责边界：负责"怎么把对象在两个仓库间搬"，不负责对象内容（pack 来自对象数据库，ref 更新交给引用管理）。

## 模块架构

```
struct transport  (transport.h:67)
   ├─ vtable: const struct transport_vtable *   (transport-internal.h:11)
   │      ┌─ builtin_smart_vtable   transport.c:1168   git:// ssh:// file://
   │      ├─ bundle_vtable          transport.c:1162   本地 bundle 文件
   │      ├─ taken_over_vtable      transport.c:1003   连接接管
   │      └─ transport_helper       transport-helper.c  外部 helper (含 remote-curl)
   ├─ remote: struct remote *       (remote.h:74)  远程仓库配置
   ├─ url / data / remote_refs      运行时状态
   └─ hash_algo: const struct git_hash_algo *  协商后确定
```

`struct transport_vtable` (`transport-internal.h:11`) 定义 6 个函数指针（`set_option`/`get_refs_list`/`fetch_refs`/`push_refs`/`connect`/`disconnect`）。`transport_get()` (`transport.c:1177`) 按 URL scheme 选 vtable：`git://`/`ssh://`/`file://` 走原生 `builtin_smart_vtable`，`http(s)://` 通过 transport-helper 框架调外部 `git-remote-curl` 程序，bundle 文件走 `bundle_vtable`。

## 调用链路

**Fetch 链路**：

```
transport_get(url)            transport.c:1177   按 scheme 选 vtable
→ handshake()                 transport.c:339    connect_setup → git_connect() connect.c:1410
→ discover_version()          connect.c:143     读首行定 v0/v1/v2
→ get_remote_refs()           (v2) / get_remote_heads() connect.c:340 (v0/v1)  ref 广告
→ fetch_refs_via_pack()       transport.c:435
  → fetch_pack()              fetch-pack.c:2168
    [v2] do_fetch_pack_v2()   fetch-pack.c:1704  状态机 SEND_REQUEST→PROCESS_ACKS→DONE
    [v0/v1] do_fetch_pack()   fetch-pack.c:1130 → find_common() fetch-pack.c:350  发 have 收 ACK
  → 服务端发 pack 流 → 客户端 index-pack/unpack-objects 写入 odb
```

**Push 链路**：`transport_push()` → `send_pack()` (`send-pack.c:510`) 协商 capabilities → `pack_objects()` (`send-pack.c:60`) 起 `git pack-objects --revs --stdout` 子进程，stdin feed oid 列表，stdout 直接写远端 → `receive_status()` 读 ref 更新结果。

**pkt-line 帧**：每条消息 `format_packet()` (`pkt-line.c:146`) 先写 4 字节 hex 长度头再写 payload；`packet_flush()` (`:93`) 发 `0000` 标记流结束；`packet_delim()` 发 `0001` 分隔段。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `transport_get()` in `transport.c:1177` | 选 vtable | 按 URL scheme 分派，上层不感知协议 |
| `git_connect()` in `connect.c:1410` | 建连接 | 起 ssh/daemon 子进程（run-command） |
| `discover_version()` in `connect.c:143` | 协商版本 | 读首行定 v0/v1/v2 |
| `process_capabilities_v2()` in `connect.c:134` | v2 capability 协商 | 独立 capability 段，可扩展命令 |
| `fetch_pack()` in `fetch-pack.c:2168` | fetch 客户端 | v0/v1/v2 分流 |
| `find_common()` in `fetch-pack.c:350` | 找 common commits | 发 have 收 ack，最小化传输 |
| `send_pack()` in `send-pack.c:510` | push 客户端 | pack-objects 子进程生成 pack |
| `format_packet()` in `pkt-line.c:146` | 帧编码 | 4 字节 hex 长度前缀自定界 |
| `packet_flush()` in `pkt-line.c:93` | 流结束标记 | 保留长度值 0000 表控制语义 |

</details>

## 核心实现

### transport 抽象与后端策略

`struct transport_vtable` (`transport-internal.h:11`) 是传输后端契约。`transport_get()` (`transport.c:1177`) 按 URL scheme 选 vtable——这让上层 `builtin/fetch.c` 只调 `transport_fetch_refs()`，不感知是 SSH 还是 HTTP。新增协议有两条路：路线 A（内置）实现新 `transport_vtable` 并在 `transport_get()` 加 scheme 分支；路线 B（外部 helper）写独立程序 `git-remote-<scheme>`，实现 `cmd_main()`（参照 `remote-curl.c:1554`），通过 stdin/stdout 与 transport-helper 协议交互，无需改核心代码。`struct transport` 还持有协商后确定的 `hash_algo`（`transport.h`）和 `smart_options`（深度/过滤/thin 等选项）。

### pkt-line 帧协议

`set_packet_header()` (`pkt-line.c:134`) 把长度编码为 4 位 hex。设计理由：(1) 自定帧协议不依赖 TCP 边界，可在任意流（管道/HTTP body）上工作；(2) 每行自定界，接收方逐行解析无需缓冲整个消息；(3) flush 包 `0000` 和 delim 包 `0001` 用保留长度值表达控制语义——一个编码方案同时承载数据与控制。fetch 中 `want`/`have`/`done` 行均通过 `packet_buf_write()` 写入 strbuf 缓冲批量发送（`fetch-pack.c:421/503/515/615`）。

### protocol v2 与 capability 协商

`discover_version()` (`connect.c:143`) 协商版本后，v2 走 `process_capabilities_v2()` (`connect.c:134`) 读独立 capability 段。设计理由：v0/v1 的 capability 附在 ref 广告首行 NUL 之后，受限于首行格式；v2 用独立 capability 段，可扩展新命令如 `fetch`/`ls-refs`/`bundle-uri`/`object-info`。v2 还支持部分 fetch——`get_remote_refs()` 接受 `ref_prefixes` 参数（`transport.h:274`），服务端只返回匹配的 ref 减少不必要传输。`protocol-caps.c` 的 `cap_object_info()` (`:80`) 等服务端 capability 函数可独立扩展。

### fetch negotiation

`find_common()` (`fetch-pack.c:350`) 和 `do_fetch_pack_v2()` (`fetch-pack.c:1704`) 通过 `fetch_negotiator` (`fetch-negotiator.h:20`) 的 `next()`/`ack()` 接口发送 `have` 行、接收服务端 ACK。目的是避免传输客户端已有的对象，减少 pack 体积和带宽。三种算法可插拔：`consecutive`（default）、`skipping`（跳步加速）、`noop`，`fetch_negotiator_init()` (`fetch-negotiator.c:8`) 按 `fetch.negotiationAlgorithm` 配置选择，实现在 `negotiator/default.c`/`skipping.c`/`noop.c`。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 后端策略模式 | `struct transport_vtable` in `transport-internal.h:11`，`transport_get()` in `transport.c:1177` | local/ssh/http/bundle/helper 可切换 |
| 适配器模式 | `remote-curl.c`（`cmd_main` at `:1554`）+ transport-helper | 把 HTTP 适配成 git wire protocol |
| 模板方法 | fetch/push 共用 handshake→discover_version→协商→传输骨架 | 两个方向复用连接生命周期 |
| 自定帧协议 | `format_packet()`/`packet_flush()` in `pkt-line.c` | 4 字节长度前缀，数据/控制同编码 |
| 策略模式（negotiator） | `fetch_negotiator` + `negotiator/{default,skipping,noop}.c` | 协商算法可插拔 |

## 模块间交互

本模块被 `builtin/fetch.c`（`transport_get` at `:1597`）、`builtin/push.c`（`transport_push` at `:390`）、`builtin/clone.c`/`ls-remote.c` 调用。依赖对象数据库（`odb_has_object`/`odb_read_object_info` in `send-pack.c:48`/`protocol-caps.c:66` 判断对象是否存在）、packfile（`pack-objects` 子进程生成 pack，fetch 端 `index-pack`/`unpack-objects` 接收）、refs（`refs_resolve_ref_unsafe` in `transport.c:106` 读写远程 ref）、run-command（`git_connect` 起 ssh 子进程）、config（`remote_get` 读 `remote.*`/`branch.*` 配置）。

## 扩展方式

**新增传输后端**：路线 A（内置）实现新 `struct transport_vtable`（参照 `builtin_smart_vtable` at `transport.c:1168`），在 `transport_get()` (`transport.c:1177`) 的 URL 判断链加 scheme 分支；路线 B（外部 helper）写 `git-remote-<scheme>` 独立程序，实现 `cmd_main()`（参照 `remote-curl.c:1554`），通过 stdin/stdout 与 transport-helper 协议交互。

**修改 negotiation 算法**：实现 `fetch_negotiator.h:20` 的 `known_common`/`add_tip`/`next`/`ack`/`release` 接口 → `fetch_negotiator_init()` (`fetch-negotiator.c:8`) switch 加 case。

**修改 wire protocol 帧**：改 `pkt-line.c` 的 `format_packet()` (`:146`) 和 `set_packet_header()` (`:134`)，新增控制包参照 `packet_flush()`/`packet_delim()` (`:93-112`)。对应测试 `t5702-protocol-v2.sh`、`t5538-push-shallow.sh`。
