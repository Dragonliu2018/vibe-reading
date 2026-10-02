---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Broker 与 Scrubber"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "gRPC", "Pub/Sub", "S3", "数据巡检"]
description: "Neon Storage Broker 时间线发现 pub/sub 与 Storage Scrubber S3 一致性巡检：无状态广播、引用计数孤儿检测、谨慎删除护栏"
readingTime: "25 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位（Storage Broker）

Safekeeper 与 Pageserver 需要互相发现：pageserver 要知道"哪些 safekeeper 上有我要的 timeline、谁最超前"，safekeeper 之间要知道彼此的进度（offloader 选举、peer recovery）。点对点互连是 O(n²) 连接 + 全局节点发现难题，Neon 用一个 ~1.3k 行的独立 gRPC pub/sub 服务解决——`storage_broker/`。它是**彻底无状态**的：不持久化任何消息、不记任何订阅关系到磁盘，挂了重启即可（客户端全部有重连兜底）。

## 核心实现（Broker）

服务定义（`storage_broker/proto/broker.proto`）只有四个 rpc：

```protobuf title="storage_broker/proto/broker.proto"
service BrokerService {
    rpc SubscribeSafekeeperInfo(SubscribeSafekeeperInfoRequest)
        returns (stream SafekeeperTimelineInfo);
    rpc PublishSafekeeperInfo(stream SafekeeperTimelineInfo)
        returns (google.protobuf.Empty);
    rpc SubscribeByFilter(SubscribeByFilterRequest) returns (stream TypedMessage);
    rpc PublishOne(TypedMessage) returns (google.protobuf.Empty);
}
```

`SafekeeperTimelineInfo` 是唯一的实质载荷：sk_id + 各 LSN（flush/commit/backup/remote_consistent/peer_horizon）+ term + 连接串 + availability_zone——pageserver 据此选"最超前且存活"的 SK 拉取，`availability_zone` 支撑跨/同 AZ 就近调度。`TypedMessage` 信封 + `MessageType` 枚举（SAFEKEEPER_TIMELINE_INFO / SAFEKEEPER_DISCOVERY_REQUEST / RESPONSE——discovery 系列是较新的增强，`docs/storage_broker.md` 的"只有一种消息"说法已滞后）。

实现要点：`SharedState`（`bin/storage_broker.rs:296`）两级 broadcast 通道——全局（All 订阅，容量 16384）+ per-timeline 懒建（容量 32）；`Registry::register_subscriber` + `Subscriber::drop` RAII 自动反注册。慢消费者 `RecvError::Lagged` 只计数告警不阻塞他人——**允许丢消息**是这个设计的灵魂：状态是 1s 周期全量刷新（safekeeper `push_loop`，`safekeeper/src/broker.rs:83`），丢一帧下帧就补上了，因此无需持久化/确认机制。单端口同时服务 gRPC(h2) 与 HTTP1（/metrics、/status），按 content-type 分流。

发布/订阅矩阵（grep 验证）：

| 节点 | 发布 | 订阅 |
| --- | --- | --- |
| safekeeper | `push_loop` 每 1s 全部活跃 timeline；discovery 应答 | `pull_loop` 订 All（选举/GC 决策依据）；自身消息回显兼作 broker 存活信号 |
| pageserver | 无候选连接时发 DiscoveryRequest（fire-and-forget） | 每 timeline 一条 `SubscribeByFilter`（ttid 过滤）维护 `wal_stream_candidates` |

**为什么不点对点**：节点只连 broker 一个星型端点，扩容安全；为什么 gRPC streaming 而非轮询：发布是 client-streaming 长流推送，事件零延迟；HTTP/2 keepalive + `broker_reset_interval`（pageserver 侧）检测僵死连接。

---

## 模块定位（Storage Scrubber）

对象存储是唯一真源，但没人阻止它变"脏"：上传了一半的进程崩了、shard split 失败留下孤儿、generation 切换产生旧对象、甚至 scrubber 自己的 bug。`storage_scrubber/`（~5.2k 行）是**独立于 pageserver 的只读巡检 + 谨慎清理进程**——pageserver 宕机/损坏时它照样能跑，这是它独立存在的全部理由。它复用 pageserver crate 的 `IndexPart`/`LayerFileMetadata` 解析代码（`pageserver = { path = "../pageserver" }` 库依赖），保证与写入方逐字节兼容。

## 核心实现（Scrubber）

7 个 clap 子命令（`main.rs:50-126`）：`find-garbage`/`purge-garbage`（控制面对账清理）、`scan-metadata`（pageserver 元数据巡检）、`tenant-snapshot`（整租户下载）、`pageserver-physical-gc`（物理层 GC）、`find-large-objects`、`cron-job`。purge 默认 dry-run，全局 `--delete` 才真删。

一次 `scan-metadata` 的流水线：`stream_tenants` → `stream_tenant_timelines`（`metadata_stream.rs`，delimiter 列举 + 两级 `try_buffered(32)` 并发）→ `list_timeline_blobs`（`checks.rs:360`：`parse_layer_object_name`（`:341`）把对象名拆成 `(layer 文件名, Generation)` 二元组，后缀格式不符的进 `unknown_keys` 只报告不处理；多 index 时**选最高 generation**）→ `analyze_tenant` → `branch_cleanup_and_check_errors`（`checks.rs:55`：index 版本合法性、disk_consistent_lsn 双写一致、`check_valid_layermap` 复用 pageserver 校验、每层 `check_ref` 记引用）→ `get_orphans()` 取 refcount=0 的层。缺失层用 HEAD 二次确认区分"与 pageserver 删除竞态"和"真缺失"。

三条值得抄的工程护栏（每条都有真实事故背景）：

1. **孤儿判定必须 tenant 级且带 generation 过滤**（`scan_pageserver_metadata.rs:175/265`）：shard split 后各 shard index 会引用彼此的层，必须等同一 tenant 全部 shard 列举齐才能算引用计数；层 generation ≥ index generation 时跳过（层刚上传、index 未写是正常竞态）——"谨慎优先于完整"。
2. **删除一律带时间阈值**：purge 要求对象集最大 mtime ≥ min_age（`garbage.rs:608`）；`PurgeMode` 分两档——`DeletedOnly` 只删 Console 明确已删的租户，`DeletedAndMissing` 连"Console 里查无此租户"的也删（默认保守取前者，防止 Console 数据不全时误删）。physical GC 保留最近 2 个 generation 的 index 并要求 min_age——事故时便于取证、split 回滚无需 un-delete。Full GC 还强制要求 storcon API 在线（`main.rs:362`：删祖先层前确认无 in-progress split，否则拒绝运行）。
3. **purge 拒绝"全删"清单**（`garbage.rs:550`）：active_tenant_count=0 时直接拒绝——防御 scrubber 自身 bug 生成灾难性删除列表。

另一个设计亮点：删除与控制面联动闭环——巡检结果经 `build_health_update_request` POST storcon `control/v1/metadata_health/update`（storcon 据此降级不健康租户），GC 经 storcon 定位 tenant（`storage_controller_client`）。

## 模块间交互

Broker：被 safekeeper（broker.rs）与 pageserver（`walreceiver/connection_manager.rs:336/715`）消费；本地环境由 neon_local 拉起；`benches/rps.rs` 是压测。Scrubber：对 S3 只读 + 谨慎删除（并发压到 32，注释提醒"be mindful of pageservers accessing the same prefixes"）；对 storcon 上报健康、请求 GC；对 Console API 判定租户是否已删（`cloud_admin_api.rs`）；配套脚本 `scripts/sk_cleanup_tenants`（按 Console 删除态清 SK 本地目录，先移 trash-dir）、`scripts/sk_collect_dumps`（收集 SK debug dump 供对账）。

## 扩展方式

- **Broker 新增订阅事件类型**：proto 加枚举/消息 → `bin/storage_broker.rs` 内部 `Message` enum 加变体并同步 `from/tenant_timeline_id/as_typed_message/message_type` 四处 → 发布端产消息、订阅端在 `subscribe_by_filter` 的 types 向量与 `register_timeline_update` 的 match 加分支。
- **Scrubber 新增一致性检查**：`checks.rs` `branch_cleanup_and_check_errors` 的 Parsed 分支追加规则，必要时 `MetadataSummary` 加统计——单点插入即获得并发与汇总。
- **新增 GC 对象类型**：仿 `pageserver_physical_gc.rs::maybe_delete_index`（`:291`）的四段验证链——解析合法 → generation 滞后 → 满 min_age → dry-run 判定——在 `gc_timeline` 内接入。

对应测试：broker 无独立测试（经 `test_runner/regress/test_broker.py` 间接覆盖）；scrubber 行为在 `test_runner/regress/test_scrubber.py`、`test_virtual_files.py` 相关段落。
