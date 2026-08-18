---
source:
  type: "源码解读"
  project: "zed"
  url: "https://github.com/zed-industries/zed"
title: "协同编辑"
date: "2026-08-18T11:06:09+08:00"
category: [Tools, IDE, Zed, CodeWiki, "1.15.0"]
tags: ["zed", "Rust", "code editor", "GPUI", "CRDT"]
description: "Zed CRDT 协同编辑：op-based 操作、Lamport 时钟、星型拓扑无状态转发"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/00-overview)

---

## 模块定位

实时多人协作是 Zed 的差异化核心能力。协作架构横跨三个层面：**CRDT 文本模型**（`text` crate，已在[文本模型](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/02-text-model)详述）负责无冲突的文本合并；**RPC 传输层**（`client` + `rpc` crate）负责操作的网络传输；**协作 UI**（`collab_ui` crate）负责实时光标、选择、头像和频道视图。另有 `collab` crate 是服务端 SaaS 应用（基于 axum + sea_orm），独立于编辑器二进制部署。

Zed 的协作采用**星型拓扑 + op-based CRDT**：所有客户端连接到中心 `collab` 服务，服务转发操作但不做冲突仲裁——CRDT 保证每个客户端独立应用操作后收敛到相同状态，服务端只做路由和持久化。

---

## 模块架构

```
客户端侧（编辑器内）:
  text/                     # CRDT Buffer（Operation / Lamport clock / deferred_ops）
    └─ Buffer::edit → Operation → subscriptions 发布
  client/                   # RPC 客户端
    ├─ client.rs            # Client（全局单例，管理连接）
    ├─ user.rs              # UserStore（用户信息缓存）
    └─ proxy.rs             # 代理配置
  rpc/                      # RPC 协议层
    ├─ proto_client.rs      # protobuf 消息客户端
    ├─ conn.rs              # 连接管理
    └─ peer.rs              # 对端抽象
  collab_ui/                # 协作 UI
    ├─ channel_view.rs      # 频道视图（协作房间）
    ├─ collab_panel.rs      # 协作面板（联系人/频道列表）
    └─ notifications/       # 协作通知

服务端侧（独立部署）:
  collab/                   # SaaS 协作服务（axum + sea_orm）
    ├── src/main.rs         # 服务入口（axum Router）
    ├── src/api.rs          # HTTP API
    ├── src/rpc.rs          # RPC 转发
    ├── src/db.rs           # 数据库（sea_orm）
    ├── src/services.rs     # 业务服务
    └── src/entities.rs     # 数据实体
```

---

## 调用链路

**协作同步链路**（本地编辑到远端应用）：

```
本地编辑:
  Buffer::edit(ranges, new_text, cx)              (text/src/text.rs)
    │
    ├─ 生成 EditOperation { timestamp: lamport_clock.tick(), version, ranges, new_text }
    ├─ 本地 apply（Rope::replace + SumTree 更新）
    └─ subscriptions.publish(Operation::Edit(op))
         │
         ▼
  Project / BufferStore 订阅 Operation
    │
    ├─ client::Client 序列化 Operation 为 protobuf
    │    └─ rpc::proto_client 发送到 collab 服务
    │         └─ TCP 连接 → collab 服务端
    │
    └─ 本地 Editor 重渲染

服务端转发:
  collab 服务（crates/collab/src/main.rs）
    │
    ├─ axum HTTP/RPC 接收 Operation
    ├─ db::Database 持久化（sea_orm）
    └─ rpc 转发给同房间其他客户端
         │
         ▼

远端接收:
  client::Client 收到 Operation
    │
    └─ Buffer::handle_update(operation)
         │
         ├─ 检查 operation.version 是否 ≤ 本地已知版本
         │    ├─ 是 → 直接 apply_operation()
         │    └─ 否 → deferred_ops.push(operation)    # 暂存乱序操作
         │
         ├─ apply_operation:
         │    ├─ Rope::replace（应用编辑）
         │    ├─ fragments SumTree 更新
         │    ├─ version.merge(operation.timestamp)
         │    └─ 处理 deferred_ops 中新就绪的操作（级联）
         │
         ├─ subscriptions.publish(operation)          # 通知本地 Editor
         └─ cx.notify()                               # 触发重渲染
```

**实时光标链路**（协作伙伴的光标显示）：

```
远端用户移动光标 → Editor 生成 selection 更新
  → client 发送 UpdateFollowers / selection 消息
  → collab 服务转发
  → 本地 client 接收
  → Workspace 的 follower_states 更新
  → Editor 渲染远端光标（hovered_cursors + show_local_selections）
```

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `Buffer::edit()` | 生成并应用 `EditOperation` | Lamport 时戳保证全局唯一标识与排序 |
| `Buffer::handle_update()` | 处理远端操作 | `deferred_ops` 暂存乱序操作，依赖版本就绪后级联应用 |
| `Client::global()` (`client.rs:651`) | 获取全局 RPC 客户端 | 单例——整个进程一个连接 |
| `collab` 服务 `rpc` | 转发操作到同房间客户端 | 服务端不仲裁冲突，只路由——CRDT 保证收敛 |

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 位置 | 职责 |
|------|------|------|
| `Buffer::deferred_ops` | `text.rs` 字段 | 暂存版本未对齐的远端操作 |
| `Buffer::apply_operation()` | `text.rs` | 应用单个操作到快照 |
| `Client::start()` | `client.rs` | 建立 RPC 连接 |
| `rpc::proto_client` | `rpc/src/proto_client.rs` | protobuf 消息收发 |
| `Workspace::follower_states` | `workspace.rs` 字段 | 追踪协作伙伴的跟随状态 |
| `Editor::hovered_cursors` | `editor.rs` 字段 | 渲染远端光标 |

</details>

---

## 核心实现

### CRDT 操作模型

协作的核心在 `text` crate 的 `Operation` / `EditOperation`（`text/src/text.rs:619`，详见[文本模型](/vibe-reading/articles/Tools/IDE/Zed/CodeWiki/1.15.0/02-text-model)）。每个操作携带：

- `timestamp: clock::Lamport`——单调递增逻辑时钟，标识操作的唯一性和因果顺序
- `version: clock::Global`——操作基于的版本向量，声明"我编辑时已知哪些操作"
- `ranges` + `new_text`——编辑的内容

**为什么用 op-based CRDT 而非 state-based**：op-based 只传输增量（编辑操作），带宽小；state-based 需要传输完整文档状态。对于代码编辑（高频小改动），op-based 更高效。代价是需要保证操作的可交换性——Zed 通过 Lamport 时钟排序 + 基于版本向量的依赖检查实现。

### `deferred_ops`：乱序操作处理

网络传输不保证操作按因果顺序到达。`Buffer` 的 `deferred_ops: OperationQueue`（`text/src/text.rs`）暂存版本未对齐的操作——如果一个操作的 `version` 引用了本地尚未收到的操作，先排队。待依赖操作到达并应用后，`deferred_ops` 中新就绪的操作级联应用。

这保证了**因果一致性**：如果操作 B 依赖操作 A（B 的 version 包含 A），则 A 必定先于 B 应用。不相关的操作（并发编辑）可按 Lamport 时戳任意顺序应用——CRDT 保证两种顺序最终收敛到相同状态。

### `Client`：RPC 传输单例

`Client`（`client/src/client.rs:207`）是编辑器进程的全局 RPC 客户端——通过 `Client::global(cx)`（`client.rs:651`）获取，整个进程一个实例。它管理到 `collab` 服务的持久 TCP 连接，处理认证、重连、代理。

`rpc` crate 提供 protobuf 消息层——`proto_client.rs` 封装消息序列化/反序列化，`conn.rs` 管理连接生命周期，`peer.rs` 抽象对端。`Buffer` 的 `Operation` 序列化为 protobuf 消息经 `Client` 发送。

### `collab` 服务端

`collab` crate 是独立的 SaaS 服务（不在编辑器二进制内）——基于 axum（HTTP API）+ sea_orm（数据库）。它做三件事：

1. **路由操作**：接收客户端的 `Operation`，转发给同房间其他客户端
2. **持久化**：操作存入数据库，新加入的客户端可以拉取历史
3. **房间管理**：协作房间（channel）的创建、成员管理、权限

**服务端不做冲突仲裁**——这是 CRDT 的关键优势。传统协作（如 Operational Transformation）需要中心服务做复杂变换，而 CRDT 操作可交换合并，服务端只做无状态转发。这让 `collab` 服务端简单且可水平扩展。

### `collab_ui`：协作界面

`collab_ui` 提供协作的视觉反馈：`channel_view.rs` 是协作房间视图（共享编辑器），`collab_panel.rs` 是联系人/频道列表，`Editor` 中的 `hovered_cursors` 渲染远端用户的实时光标和选择。`Workspace` 的 `follower_states`（`workspace.rs`）追踪协作伙伴的跟随状态——"跟随模式"让一个用户自动滚动到另一个用户的编辑位置。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| op-based CRDT | `text/` Operation + Lamport clock | 增量传输带宽小，操作可交换合并，无需中心仲裁 |
| 星型拓扑 + 无状态转发 | `collab` 服务只路由不仲裁 | 服务端简单可扩展，CRDT 保证客户端收敛 |
| 延迟队列 | `text/` `deferred_ops: OperationQueue` | 处理网络乱序，保证因果一致的应用顺序 |
| 全局单例连接 | `Client::global()` | 进程级一个 RPC 连接，所有 Buffer 共享 |
| 跟随状态 | `Workspace::follower_states` | 跟随模式——一个用户自动跟随另一个的视口 |

---

## 模块间交互

- **依赖**：`text`（CRDT Buffer / Operation）、`rpc`（协议）、`gpui`（Entity/View）、`proto`（protobuf 定义）。
- **被依赖**：`workspace`（follower_states / 协作房间）、`editor`（远端光标渲染）、`project`（远程项目通过 `client` RPC）、`collab_ui`（协作面板）。
- **交互方式**：`Buffer` 通过 `subscriptions` 发布 `Operation`，`client` 订阅并经 RPC 发送；远端 `Buffer` 的 `handle_update` 接收并 `apply`。`Workspace` 订阅 `client` 的 presence 事件更新 `follower_states`。`collab` 服务端通过 axum HTTP/RPC 接收并转发，与编辑器通过 protobuf 协议解耦。`collab` crate 不依赖编辑器的任何 crate——它是独立服务。

---

## 扩展方式

**新增一种协作同步消息**（如"同步书签位置"）：

1. `crates/proto/` 在 protobuf 定义中添加新消息类型
2. `crates/rpc/src/proto_client.rs` 添加消息收发方法
3. `crates/text/src/text.rs` 或 `crates/project/src/` 添加 `handle_*` 接收逻辑
4. `crates/collab/src/rpc.rs` 服务端添加转发逻辑
5. 对应测试：`crates/text/src/tests.rs` 的协作测试模块
