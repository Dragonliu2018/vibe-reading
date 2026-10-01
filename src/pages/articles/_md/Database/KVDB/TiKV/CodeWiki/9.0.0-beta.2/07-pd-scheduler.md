---
source:
  type: "源码解读"
  project: "tikv"
  url: "https://github.com/tikv/tikv"
title: "PD Client 与集群调度"
date: "2026-10-01T21:10:00+08:00"
category: [Database, KVDB, TiKV, CodeWiki, "9.0.0-beta.2"]
contentType: "CodeWiki"
tags: ["TiKV", "PD", "Region Split", "心跳", "调度"]
description: "TiKV 与 PD 控制面交互：双向流 region 心跳、TiKV 发起的 region split（size/keys/load 三策略）、调度指令执行与 load-base split 热点自治。"
readingTime: "20 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/KVDB/TiKV/CodeWiki/9.0.0-beta.2/00-overview)

---

## 模块定位

TiKV 是数据面，PD 是控制面（独立进程）：PD 没有 key 级数据视图，只凭心跳做全局调度。本模块是两者之间的全部通道：region 心跳上报、store 心跳、split/merge 的发起与确认、调度指令（转移 leader/迁移副本）的接收执行。控制面与数据面交互集中在一个模块，避免散落各处的 PD 依赖。

## 模块架构

```text
components/pd_client/src/client.rs    RpcClient（:52）——PD gRPC 门面（心跳流/TSO/调度）
components/raftstore/src/store/worker/
├── pd.rs               PdWorker（Runner :909，Task enum :138）
├── split_check.rs      SplitCheckWorker（:602，Scan/Approximate/Usekey 三策略）
├── split_controller.rs AutoSplitController（:757，load-base split）
└── region.rs           RegionTask（仅 Apply/Destroy 两态：快照善后）
src/server/resolve.rs   PdStoreAddrResolver（:172）store_id → 地址缓存
```

## 调用链路

### Region 心跳（双向流）

```text
on_pd_heartbeat_tick（fsm/peer.rs:6710）
└─ Peer::heartbeat_pd（peer.rs:5837）组 HeartbeatTask（term/size/keys/down_peers）
   └─ pd_scheduler.schedule → Runner::handle_heartbeat（pd.rs:1187）
      └─ client.rs:584 region_heartbeat   # hb_sender mpsc 复用一条 gRPC 双向流
         【PD 的调度指令从同一条流的 response 回来】
         └─ schedule_heartbeat_receiver（pd.rs:1602）
            └─ handle_region_heartbeat_response（client.rs:679）
               → change_peer/transfer_leader/merge → admin 命令发回 raftstore
```

### Region Split（TiKV 发起）

```text
on_split_check_tick（fsm/peer.rs:6357）
└─ SplitCheckTask → check_split_and_bucket（split_check.rs:602）
   ├─ Scan policy：逐 key 扫累计 size
   └─ Approximate policy：RocksDB get_suggest_split_keys（O(1)，失败降级 Scan）
   └─ 产出 split_keys → router.ask_split（CasualMessage::SplitRegion）
      └─ on_prepare_split_region（fsm/peer.rs:6422）
         ├─ 校验 leader + validate_split_region（epoch/keys 边界）
         └─ PdTask::AskBatchSplit → handle_ask_batch_split（pd.rs:1093）
            ├─ pd_client.ask_batch_split  # 只向 PD 申请新 region_id/new_peer_ids！
            └─ new_batch_split_region_request + send_admin_request（pd.rs:2501）
               【BatchSplit admin cmd 过 Raft 提交】
               └─ on_ready_split_region（fsm/peer.rs:4459）
                  ├─ 创建新 peer
                  └─ 立即 heartbeat_pd 上报 + report_batch_split 回 PD
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|--------------|
| `region_heartbeat` in client.rs:584 | 心跳走双向流 | 十万 region 不打爆 PD |
| `handle_heartbeat` in pd.rs:1187 | 心跳处理+coprocessor hook | 增量基线 |
| `handle_ask_batch_split` in pd.rs:1093 | split 发起 | PD 只发 ID 不选点 |
| `check_split_and_bucket` in split_check.rs:602 | 分裂检查 | 双 policy 降级 |
| `AutoSplitController::flush` in split_controller.rs:757 | 热点 split 决策 | 纯客户端自治 |
| `handle_store_heartbeat` in pd.rs:1229 | store 心跳增量上报 | 热点阈值裁剪 |
| `get_store`（resolve） | 地址缓存 60s 刷新 | PD 兼任节点目录 |

</details>

## 核心实现

### 心跳双向流复用

region 心跳每 region 默认 10s、region 数十万级——逐次独立 RPC 会打爆 PD。`region_heartbeat`（client.rs:584）用 `hb_sender` mpsc channel 复用**一条 RegionHeartbeat gRPC 双向流**，异步 `send_all` 批量推送；更妙的是 PD 的调度指令从**同一条流的 response** 回来（`schedule_heartbeat_receiver` 转 `HandleRegionHeartbeatResponse` 回调序列）——无需 TiKV 轮询 operator。增量上报（`PeerStat.last_store_report_*` + 热点阈值 `hotspot_byte_report_threshold`）控制心跳体积。`fake heartbeat`（pd.rs:1970）：心跳延迟超 5min 发空心跳保持连通标记但不更新 last_report_ts，防被误判为正常节点。

### Split 的职责划分：TiKV 选点，PD 发 ID

split key 的选取必须基于本地数据扫描（size/keys 直方图）——PD 无数据只能做全局调度与 epoch 仲裁。所以流程是 TiKV 检查→申请 ID→过 Raft AdminCmd（保证新 region 元数据多副本一致）→TiKV 主动上报，PD 从心跳 learn 新拓扑（最终一致）。Usekey policy 反向：PD 在心跳响应直接下发 split keys（PD 主动的少数场景）。

### Load-base split：客户端热点自治

`AutoSplitController::flush`（split_controller.rs:757）：QPS/byte/CPU 三阈值（grpc poll 与 unified read pool 线程忙碌判定）+ `Recorder` 滑窗采样（`sample_num`/`detect_times`）定位热点 key → `Task::AutoSplit` → 走同一 `handle_ask_batch_split`。纯客户端热点自治，无需 PD 感知 key 级热度——PD 的调度粒度是 region，热点 key 的即时切分等不了调度链路。

### compaction 联动

`on_compaction_finished`（split_check.rs:910）：compaction 造成 size 骤降时触发增量复检，避免 approximate 统计陈旧导致 split 误判。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Actor/Worker | pd.rs/split_check.rs/region.rs 各自 Runner | 后台任务与 FSM 解耦 |
| 策略模式 | `CheckPolicy::{Scan, Approximate, Usekey}` | 检查方式可切换 |
| 依赖倒置 | `Runner<EK, ER, T: PdClient>` | FakePdClient 可测 |
| 回调流 | `handle_region_heartbeat_response` | response stream 变事件 |
| Self-scheduling | Incompatible 时降级重投 AskSplit | 滚动更新兼容 |

## 模块间交互

↔ raftstore：`RaftRouter` 是唯一回程通道（admin request/CasualMessage/send_store_msg）；心跳响应里的 change_peer_v2/transfer_leader/merge 全在 `schedule_heartbeat_receiver` 转 admin。↔ server：`PdStoreAddrResolver` 包装 addr-resolver worker，用 `get_store` 缓存供 RaftMessage 传输层解析 peer 地址——PD 既是调度者也是节点目录。↔ coprocessor：`on_region_heartbeat` observer 聚合引擎统计。v2 引擎走 `client_v2.rs`/`server2.rs` 独立 wiring（本篇覆盖 v1）。

## 扩展方式

- **新增调度指令**：PD 心跳响应加新 op → kvproto → `schedule_heartbeat_receiver` 加分支 + `new_xxx_request` + `send_admin_request` 三点（参考 witness 切换 pd.rs:1699 附近）
- **调整 split 判定维度**：加 policy 或阈值（load-base 加维度即改 `AutoSplitController::flush` 与 `SplitConfig`）
- **心跳加统计字段**：`HeartbeatTask`/`RegionStat` + `client.rs` 填充 + `handle_store_heartbeat` 增量基线
