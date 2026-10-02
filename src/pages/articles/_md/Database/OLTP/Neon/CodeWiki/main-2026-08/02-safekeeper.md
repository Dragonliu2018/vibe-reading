---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Safekeeper"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "Safekeeper", "共识", "WAL", "Paxos"]
description: "Neon WAL 共识服务：term-based ProposerElected 协议、写回缓存、S3 备份单写者选举、interpreted WAL 与冷时间线下盘"
readingTime: "35 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Safekeeper 回答一个问题：**WAL 在 compute 死掉/脑裂/重启时如何保证既不丢、又只有一个真相版本**。它接收 compute 内嵌 walproposer 的广播，做 quorum 持久化（防两台 compute 同时写），并承担三个次生职责：供 pageserver 拉取（解码成 interpreted WAL）、定期备份到 S3（WAL 的最终容错副本）、在万级租户共享集群上把冷时间线的 WAL 下盘释放。

它**不是**通用存储——只追加写 WAL 字节，没有查询能力；也**不是** Raft——没有 leader 选举，leader（proposer）在集群外的 compute 里。协议有 TLA+ 规约与验证（`safekeeper/spec/`：`ProposerAcceptorStatic.tla`、`ProposerAcceptorReconfig.tla`）。

## 模块架构

单二进制多 tokio runtime：WAL_SERVICE（libpq 5454 端口，收 WAL / 发 WAL）、BACKGROUND（备份/清理/eviction）、BROKER、HTTP（管理 API）。每个 timeline 一个 `Timeline`（`timeline.rs:445`），内部 `SharedState` RwLock 装 `StateSK` 三态（Loaded/Offloaded/Empty——磁盘驻留状态机，冷时间线整体下盘后是 Offloaded，访问时经守卫强制 unevict 从 S3 回拉）。`SafeKeeper<CTRL, WAL>`（`safekeeper.rs:874`）是纯共识状态机（可注入控制文件与 WAL 存储实现，模拟测试就能换假实现跑真协议），`timeline_manager.rs` 的每 timeline 事件循环驱动六类后台任务启停。

## 调用链路

两条主链路——写入共识与读出推送：

```
写：compute walproposer ──START_WAL_PUSH──> wal_service.rs:task_main
  → handler.rs 解析 → handle_start_wal_push_guts(receive_wal.rs:221)
    split socket，双 mpsc(256) 隔离网络 IO 与磁盘 IO
  → spawn WalAcceptor(:520).run(:562)
      AppendRequest → NoFlushAppendRequest（fsync 攒批，1s 定时）
  → Timeline::process_msg(timeline.rs:1104 持写锁)
  → SafeKeeper::process_msg(safekeeper.rs:937)
      ├ handle_greeting(:970)：版本/seg_size 校验，membership 切换
      ├ handle_vote_request(:1052)：先 fsync 再投票
      ├ handle_elected(:1106)：find_highest_common_point 校验截断点
      ├ handle_append_request(:1293)：顺序写 + update_commit_lsn(:1266)
      └ 回 AppendResponse{flush_lsn, commit_lsn} → compute syncrep 唤醒

读：pageserver ──START_REPLICATION(Interpreted)──> handler.rs:112
  → handle_start_replication(send_wal.rs:452)
  → InterpretedWalReader(send_interpreted_wal.rs:73)
      StreamingWalReader 读盘(缺段自动 S3 回拉)
      → WalStreamDecoder 解码
      → InterpretedWalRecord::from_bytes_filtered 按 shard 过滤
      → ToWireFormat(可压缩) → BeMessage::InterpretedWalRecords 推送
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `process_msg` (`safekeeper.rs:937`) | 六种共识消息分发中枢 | 单入口，状态机可整体审查 |
| `handle_vote_request` (`safekeeper.rs:1052`) | 投票 | 先持久化投票再回复，防双投票 |
| `handle_elected` (`safekeeper.rs:1106`) | 确认新 proposer | 断言 `start_streaming_at >= commit_lsn`，永不截断已提交数据 |
| `update_commit_lsn` (`safekeeper.rs:1266`) | commit 单调推进 | 取 min(msg.commit_lsn, 本地 flush_lsn) 后单调推进；commit 由 proposer 算 quorum 后推送，SK 只存储 |
| `determine_offloader` (`wal_backup.rs:206`) | S3 备份单写者选举 | 确定性散列，各 SK 独立算出同一人 |
| `calc_horizon_lsn` (`remove_wal.rs:17`) | WAL GC 底界 | 三底界取 min，多方可恢复才敢删 |
| `recovery_needed` (`recovery.rs:60`) | peer 免选举追赶 | 无活跃 compute 时直接从最超前 peer 拉 |

</details>

## 核心实现

### Term 协议：Paxos 血统的"单 proposer"简化

与 Raft 的本质差异：**leader 在集群外**。compute 的 walproposer 是 proposer，safekeeper 是 acceptor——SK 之间互不通信选主（broker 只是捎带信息），"谁当 leader"被简化为"给哪个 term 投票"。一致性不靠 Raft 的 prevLogTerm 逐条校验，而靠 `TermHistory`（`safekeeper.rs:52`，term→切换 LSN 的向量）+ `ProposerElected` 一次性截断：新 proposer 当选时，`find_highest_common_point`（`:115`）找出自己与本地 WAL 的分叉点，把分叉之后的部分 truncate。`handle_elected` 里的断言 `start_streaming_at >= commit_lsn`（`:1106`）是协议的安全底线——**已提交的数据永不截断**。

为什么这样设计：目标是**最小化 PG 内核改动**。walproposer 借标准流复制框架广播 WAL，compute 不需要理解共识；SK 只做追加落盘 + 投票持久化，脑裂防护收敛到"投票前先 fsync"这一条规则（`handle_vote_request` 里 msg.term > 本地 term 时先持久化再回复）。Raft 的选主、日志回填、joint consensus 在这里全部不存在，代价是 leader 只能在 compute 里（SK 集群自己不能推进写入——没有 compute 就没有新 WAL，这是 acceptable，因为 Neon 的写路径本来就需要 compute 存活）。

### 写回缓存与控制文件

`TimelineState<CTRL>`（`state.rs:188`）分两层：`pers`（持久控制文件）+ `inmem`（写回缓存）。`start_change/finish_change` 提供事务式 API，commit_lsn 这类高频字段只在内存推进，`timeline_manager` 每 300s `update_control_file_save`（`timeline_manager.rs:526`）批量落盘；**term 切换点例外强制同步**——新 term 的第一笔必须先持久化，这是投票安全的前提。控制文件本体是 `FileStorage`（`control_file.rs:43`）：magic + version + checksum，写临时文件原子 rename，版本升级走 `control_file_upgrade.rs`。

### WAL 存储：四 LSN 分离

`PhysicalStorage`（`wal_storage.rs:88`）实现 `Storage` trait，四个位点各司其职：`write_lsn`（网络字节进度）/ `write_record_lsn`（最后完整记录）/ `flush_lsn`（fdatasync 过的）/ `flush_record_lsn`。分离的原因：网络写可以停在记录中间（decoder 才找得到记录边界），而 `flush_lsn` 只对齐记录边界——崩溃恢复从 `flush_record_lsn` 开始，绝不重放半条记录。读路径 `WalReader`（`:659`）本地缺失段自动从 S3 下载——SK 本地也是缓存，S3 才是真源（与 pageserver 哲学一致）。

### S3 备份：确定性单写者选举

多个 SK 都能备份，但同一时刻只想一个人写 S3（无 CAS，双写靠内容幂等容忍但浪费）。`determine_offloader`（`wal_backup.rs:206`）的方案：过滤掉滞后超 128MB 的节点，剩者按 `timeline_id % n` 散列选人——**每个 SK 独立计算、结果相同**，无需任何协调通信。触发条件 `is_wal_backup_required`（`:57`）：有活跃 compute，或 commit 段号 > backup 段号。尾段 `.partial` 处理是备份最难的部分（`wal_backup_partial.rs`）：`UploadStatus{InProgress/Uploaded/Deleting}` **先写控制文件再做 S3 操作**，崩溃后可 GC；文件名内嵌 `segno_term_flush_commit_skNN`，多写者场景下消费者按名字选最新。

### Interpreted WAL：读路径的 KV 直通车

`send_interpreted_wal.rs` 让 SK 承担三件事：解码 WAL、按 shard 过滤、预序列化成紧凑 wire 格式（可压缩）。收益对照鲜明——分片租户场景下每个 shard pageserver 只收与自己相关的记录（网络与解码 CPU 双省），一次磁盘读 fanout 到 N 个 shard（`create_or_update_interpreted_reader` 以 `max_delta_for_fanout` 判定可挂载）。本基线 ingest 路径已只支持 interpreted（vanilla 仅剩 replica 场景），这是从"字节搬运"到"语义搬运"的演进。

### Eviction 与 peer recovery

`timeline_eviction.rs:22 ready_for_eviction` 的下盘条件相当苛刻：无 compute、控制文件已刷、无驻留守卫、broker 不活跃、尾段 partial 已上传——满足才删本地 WAL 置 `EvictionState::Offloaded`。回拉限速（`EVICTION_CONCURRENCY=2` + 随机抖动）防"早高峰集体回拉"风暴。peer recovery（`recovery.rs:60`）则解决另一个问题：SK 重启后落后了，如果此时有活跃 compute，走正常选举会引发不必要的 proposer 切换/截断；若无活跃 compute 且 donor 同时满足 `donor.term == donor.last_log_term`（证明该 term 的 leader 真存在过）与 `donor.term >= my.term`，直接 `START_REPLICATION(term=)` 从最超前 peer 拉齐——**免选举追赶**。

### WAL GC 三底界

`calc_horizon_lsn`（`remove_wal.rs:17`）= min(peer_horizon_lsn, remote_consistent_lsn, backup_lsn)：所有 peer 都有的 WAL（peer_horizon）、pageserver 已物化上传的底界（remote_consistent）、S3 已备份的底界（backup）——**任何一方还需要的 WAL 都不能删**。可选叠加 lagging walsender 底界。这是"删错了就永远找不回来"的最后一道闸。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 泛型状态机 + 注入实现 | `SafeKeeper<CTRL, WAL>`（`safekeeper.rs:874`） | 模拟测试可换假存储跑真协议 |
| 写回缓存 | `TimelineState` inmem/pers（`state.rs:188`） | 高频更新与持久化频率解耦 |
| 状态三态机 | `StateSK::Loaded/Offloaded/Empty`（`timeline.rs:147`） | 万级 timeline 共享集群的内存分级 |
| RAII 驻留守卫 | `WalResidentTimeline`（`timeline.rs:1021`） | Drop 释放，无显式 unevict 泄漏 |
| 注册表 + Drop 自动注销 | `WalReceivers/WalSenders`（registry 模式） | 连接生命周期无需手动清理 |

## 模块间交互

向 compute：`START_WAL_PUSH` 共识 + feedback 回灌（pageserver 的 disk_consistent_lsn 经 `WalReceivers::broadcast_pageserver_feedback` 注入 AppendResponse 回到 compute，驱动 catalog xmin 与背压）。向 pageserver：两条复制路径（interpreted 主路径 + vanilla replica）。向 broker：`push_loop/pull_loop` 每 1s 广播 + 订阅 `SafekeeperTimelineInfo`（offloader 选举、peer recovery、remote_consistent 同步的数据源）。向 storcon：HTTP API 管理 timeline 生命周期、`pull_timeline` 跨 SK 全量拉回。依赖 libs：safekeeper_api（membership）、postgres_backend/pq_proto（libpq + InterpretedWalRecords 消息）、postgres_ffi/wal_decoder（解码）、remote_storage（S3）。

> 本基线特有：`hadron.rs` 及 34 个 `BEGIN_HADRON` 标记文件是第三方 HCC 部署变体补丁（向 HCC 注册、磁盘限额拒写、offloader backup_lag 超阈值全员重选），非 Neon 官方主线，阅读时可跳过或对照学习其运维化改造思路。

## 扩展方式

- **协议加字段/消息**：`ProposerAcceptorMessage::parse`（`safekeeper.rs:487`）+ `AcceptorProposerMessage::serialize`（`:780`）+ `process_msg`（`:937`）加 handler；沿用 `*V2` 结构体 + `SK_PROTO_VERSION` 递增模式，**需同步 pg 端 walproposer C 代码**。
- **改 WAL 保留策略**：`Manager::update_wal_removal`（`timeline_manager.rs:556`）与 `remove_wal::calc_horizon_lsn`。
- **改备份触发/命名**：`wal_backup.rs::backup_task_main`、`Segment::object_name`（`:522`）；partial 侧改 `wal_backup_partial.rs`，注意控制文件内的 State 结构不可随意改格式。

对应测试：`test_runner/regress/test_safekeeper*`；共识正确性在 `safekeeper/tests/walproposer_sim/`（desim 确定性模拟，见 06 篇 libs 章）。
