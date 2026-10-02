---
source:
  type: "源码解读"
  project: "neon"
  url: "https://github.com/neondatabase/neon"
title: "Storage Controller"
date: "2026-10-02T15:00:33+08:00"
category: [Database, OLTP, Neon, CodeWiki, "main-2026-08"]
contentType: "CodeWiki"
tags: ["Neon", "Storage Controller", "编排", "调度", "Rust"]
description: "Neon 存储编排器 storcon：intent/observed 双结构、reconcile 收敛循环、generation 签发、shard split 与 failover"
readingTime: "35 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLTP/Neon/CodeWiki/main-2026-08/00-overview)

---

## 模块定位

Storage Controller（storcon）回答"**一个分片租户的 100 个 shard 放在哪 200 个 pageserver 上，谁说了算**"。没有它，云端控制面要逐 shard 逐节点编排，且无人持有 generation 全局视图——两台 pageserver 同时 attach 同一租户就会在 S3 上双写丢数据（旧实例的删除甚至会删掉新数据）。storcon 是全系统唯一持 generation 真源、唯一做放置决策的组件：调度、failover、迁移、shard split、drain/fill 全部从这里出发，然后把结果通知 compute。

职责边界：不管页面数据（pageserver 的事）、不管 WAL（safekeeper 的事）、不管用户认证（console 的事）。它自己持久化在 Postgres（diesel + 25 个嵌入式迁移）——但只存"安全关键 + 真源在外部"的对象。

## 模块架构

先说一个值得点名的工程现象：**god file 集中度**。`storage_controller/src` 约 2.74 万行，其中 `service.rs` 单文件 10,544 行（433KB）——`Service` 结构收编了租户编排全部逻辑，只有 safekeeper 部分拆去了 `service/safekeeper_service.rs`（1,742 行）；`tenant_shard.rs` 3,220、`persistence.rs` 2,726、`http.rs` 2,710、`scheduler.rs` 1,621、`reconciler.rs` 1,284 行。这是"编排逻辑天然汇聚"的产物，但也意味着改动入口几乎都在 service.rs。

架构核心是**意图/观测双结构**：`TenantShard.intent`（storcon 想要的世界）与 `observed`（外部世界的现状）分离，`Reconciler` 负责把后者改造成前者。状态不进数据库——attachment 关系只存内存，重启时扫全部 pageserver 的 `list_location_config` 重建（`scan_node_locations`，`service.rs:1094`）；DB 只存 generation（数据安全必需单调）、PlacementPolicy 与节点地址。

## 调用链路

```
租户创建 / failover 两条代表性链路：

创建：http.rs POST /v1/tenant
  → Service::tenant_create(service.rs:2607, 取 TenantOperations::Create 排它锁)
  → do_tenant_create(:2635) → persistence.insert_tenant_shards（先落盘后调度）
  → do_initial_shard_scheduling(:2804) → Scheduler::schedule_shard
  → maybe_configured_reconcile_shard(:8613)
      → TenantShard::spawn_reconciler → Reconciler::reconcile(reconciler.rs:836)
          ├ persistence.increment_generation(persistence.rs:729 原子 +1)
          ├ pageserver location_config（REST）
          └ compute_notify（PUT notify-attach → 控制面 SIGHUP postgres）

failover：spawn_heartbeat_driver(service.rs:1284) 周期心跳
  → 超过 max_offline_interval 标 Offline → AvailabilityTransition::ToOffline
  → handle_node_availability_transition(:7980)
      宕机节点上全部 observed 置 conf:None（不可信）
      → intent.demote_attached（降级保留为 secondary，不遗忘）
      → 重选 attach node → reconcile → 通知 compute 换连接串
```

<details>
<summary>方法速查表（点击展开）</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `tenant_create` (`service.rs:2607`) | 建租户 | 先持久化后调度，UniqueViolation 幂等重试 |
| `reconcile` (`reconciler.rs:836`) | 意图→现实收敛 | 幂等，失败不阻塞主流程 |
| `schedule_shard` (`scheduler.rs:309`) | 选放置节点 | 打分结构体字段序即优先级 |
| `increment_generation` (`persistence.rs:729`) | 代数号签发 | `UPDATE ... RETURNING` 原子自增 |
| `re_attach` (`service.rs:2377`) | pageserver 重启批量续签 | DB 先批量增 generation 再更新内存 |
| `handle_node_availability_transition` (`service.rs:7980`) | 节点上下线响应 | conf:None 三态区分"确定没有"与"未知" |
| `tenant_shard_split` (`service.rs:6131`) | 1→N 分裂 | 两段式 + 后台 abort 队列回滚 |

</details>

## 核心实现

### Intent / Observed：level-triggered 编排

`IntentState`（`tenant_shard.rs:161`）= attached + secondary + preferred_az，每次变更同步维护 Scheduler 引用计数；`ObservedState`（`:397`）= 每节点 `Option<LocationConfig>` 的三态（无 entry = 确定没有；`conf:None` = 可能有但未知；`Some` = 已知）。`get_reconcile_needed`（`:1485`）= intent 脏 ∨ 存在未知位置 ∨ 待通知 compute——**level-triggered 而非 edge-triggered**：不依赖"谁改了什么"的事件流，任何时候对账当前状态即可决定是否需要动作，天然容错（漏掉一次事件不影响正确性）。每 shard 单 reconciler 在飞、`sequence` + `SeqWait` 防陈旧结果覆盖新决策，双优先级信号量池（High 可偷 Normal），超限进延迟队列 + 20s 兜底循环。

### Scheduler：打分结构即优先级文档

`NodeAttachmentSchedulingScore`（`scheduler.rs:154`）的 `Ord` derive 字段顺序就是优先级：AZ 匹配 > 租户内反亲和（`AffinityScore`，同租户 shard 分散）> utilization > 已 attach 数 > node_id。妙处是 **secondary 的 AZ 打分与 attached 相反**——secondary 刻意避开 preferred AZ 以跨机房容灾。`ScheduleContext::avoid` 提供同租户 shard 的反亲和约束。打分维度要扩展时，加字段进结构体即自动获得优先级语义。

### Generation：防脑裂的单调令牌

`increment_generation`（`persistence.rs:729`）用 `UPDATE generation=generation+1 ... RETURNING` 原子签发；reconciler **先落盘拿新 generation 再 attach**（`reconciler.rs:881`）——已处于目标配置且 generation 一致的幂等重入会跳过递增，避免虚假的 generation 增长；pageserver 启动经 `/upcall/v1/re-attach` 批量续签（`service.rs:2377`），删除侧 DeletionQueue Validator 凭 storcon 的 generation 视图拒绝旧代删除。为什么 DB 必须放持久盘：generation 回退 = 僵尸实例复活 = 数据丢失（docs/storage_controller.md L70 明言）。leadership 也复用 DB：`controllers` 表的 CAS 更新（`UPDATE ... WHERE address=prev`，0 行即失败）+ `step_down_current_leader` HTTP 让位并交接 `GlobalObservedState`——不是 advisory lock，是可审计的数据行。

### Shard Split：两段式 + 回滚护栏

`tenant_shard_split`（`service.rs:6131`）把"逻辑上的 1 次分裂"变成"物理上 N 个新 shard 的创建"：先 reconcile 清空 secondary（pageserver 不支持带 secondary 分裂）→ `persistence.begin_shard_split` **事务内**写子 shard（占位 generation 在事务中填真值，唯一键防并发双 split）→ 内存置 `Splitting`（期间拒绝一切 reconcile/CRUD）→ 逐 parent 调 pageserver `tenant_shard_split`（真正的 L0 物理分裂在 pageserver 完成，storcon 只协调）→ 校验返回的 child ID 后 commit。失败走 `abort_tx` 后台队列回滚（携带 tenant 锁与 gate 的 `TenantShardSplitAbort` 异步执行，重试幂等）；入口处若 persistence 报告该 tenant 有 in-progress 的 timeline import 直接 409 拒绝。split 成功后 `tenant_shard_split_start_secondaries` 让子 shard 立即上传 heatmap、secondary 开始预热，不等后台周期。split 期间 storcon 对外 API 语义不变——分片是租户内部实现细节。

### Drain / Fill：限流的后台迁移

节点下线（drain）不是一次 API 调用，而是 `background_node_operations.rs` 的限流操作：`MAX_RECONCILES_PER_OPERATION=64` 节流迁移，避免 drain 一个大节点打爆 reconciler 并发池；`ongoing_operation` 单槽防多个大操作叠加。`optimize_all`（`service.rs:8810`）在系统空闲时做迁移优化，`autosplit_tenants`（`:9213`）按尺寸阈值自动触发 split——编排的"自动化程度"在持续加深。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 意图/观测双结构 | `tenant_shard.rs:161/397` | level-triggered，重试幂等，故障自愈 |
| per-id 锁映射 | `IdLockMap`（`id_lock_map.rs`） | 同租户操作串行化，不同租户并发 |
| 状态机 × 转移枚举 | `NodeAvailability` + `AvailabilityTransition`（`node.rs:89`） | WarmingUp 宽限期等中间态显式建模 |
| 泛型心跳器 | `Heartbeater<Server, State>`（`heartbeater.rs:69`） | pageserver/safekeeper 复用一套探测框架 |
| CAS 领导权 | `persistence.rs update_leader` | 可审计、跨重启，优于 advisory lock |
| 嵌入式迁移 | `embed_migrations!`（`persistence.rs:36`） | 部署零手工步骤，新旧二进制滚动共存 |

## 模块间交互

对 pageserver 双向：正向 `PageserverClient`（location_config/tenant_shard_split/utilization），反向 upcall `/upcall/v1/re-attach`、`/validate`（storcon 裁决 timeline GC 安全性）。心跳探测有个反直觉细节：`Heartbeater` 对 Offline 节点也照常发探测（克隆 Node 强制置 Active 绕过可用性悲观检查，`heartbeater.rs`），否则节点一旦标 Offline 就永远发现不了它恢复——可用性状态机靠"继续探测"闭环。对 compute：经 `ComputeHook` PUT `notify-attach`/`notify-safekeepers`（JWT，失败重试至成功——最终一致）。对 safekeeper：`safekeeper_service.rs` + `safekeeper_reconciler.rs`（SK 注册、跨 AZ 选 3 副本、membership 迁移）。`client/` crate（`storage_controller_client`）给 scrubber（GC 定位）和 storcon_cli（40+ 运维子命令）复用。对 storcon 自身：`PeerClient` → 对端 `/control/v1/step_down`（HA 双活交接）。

## 扩展方式

- **新增调度打分维度**（如磁盘水位）：`NodeAttachmentSchedulingScore`（`scheduler.rs:154`）加字段（derive Ord 即优先级）+ `NodeSchedulingScore::generate` 填充；secondary 侧同改 `NodeSecondarySchedulingScore`。
- **新增健康判定信号**：`HeartbeaterTask::run` 加探测 + `PageserverState` 推断；生效路径在 `spawn_heartbeat_driver` 的映射 → `handle_node_availability_transition`。
- **新增租户编排操作**：`http.rs::make_router` 加路由 → `Service` 方法（先取 `tenant_op_locks`）→ `tenant_shard.rs` 改 intent + `sequence.next()` → `maybe_reconcile_shard`。执行逻辑零手写。

对应测试：`test_runner/regress/test_storage_controller*`（failover/split/drain 全场景）、`control_plane/storcon_cli` 可手动驱动。
