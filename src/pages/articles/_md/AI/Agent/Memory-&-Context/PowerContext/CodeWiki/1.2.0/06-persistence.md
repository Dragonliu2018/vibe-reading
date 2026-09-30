---
source:
  type: "源码解读"
  project: "powercontext"
  url: "https://github.com/oceanbase/powercontext"
title: "Persistence 存储层"
date: "2026-09-30T17:51:04+08:00"
category: [AI, Agent, "Memory & Context", PowerContext, CodeWiki, "1.2.0"]
contentType: "CodeWiki"
tags: ["PowerContext", "SQLAlchemy", "SQLite", "OceanBase"]
description: "SQLAlchemy async 存储层：46 张 pc_* 表、SQLite/OceanBase/SeekDB 三后端、可重建的 FTS/向量投影、同事务一致提交与 Unit of Work。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/Memory-&-Context/PowerContext/CodeWiki/1.2.0/00-overview)

---

## 模块定位

`builtin/persistence/`（~17.6k 行，57 文件）是领域层与 SQL 之间的唯一边界：**后端无关的 SQLAlchemy async 存储层**。顶层是共享基建（`tables.py` 1191 行定义全部 46 张 `pc_*` 表、`database.py` 的 `AsyncDatabase`、`codec.py`、各 family repository）；三个后端子目录（`sqlite/`、`oceanbase/`、`seekdb/`）各含 `profile.py`（引擎生命周期）+ 镜像的检索索引策略。后端选择发生在 `runtime/composition.py` 的 `open_builtin_contexts()`（按 `config.database` isinstance 分派）。

## 模块架构

```
AsyncDatabase（database.py:35，引擎所有权与显式事务边界）
  │  transaction() / connection(bound) / attach / own
  ▼
Repository 层（每 family 一个模块：memory.py / topic_memory.py / handoff.py /
  records.py / tags.py / processing.py / processing_intents.py / supervision.py / cursors.py）
  │  统一约定：注入 AsyncDatabase + scope_id，方法签名带 connection，自己不拥有连接
  ▼
MemoryIndex Protocol（memory_index.py，FTS+向量投影，七方法）
  ├─ NoMemoryIndex（Null Object）           ← 无索引时诚实报 CapabilityNotSupportedError
  ├─ CompositeMemoryIndex（FTS ∧ Vector）   ← repository 只见单一 index
  ├─ SQLiteMemoryFTSIndex（FTS5 影子表）    ├─ SQLiteMemoryVectorIndex（双表 + vec0）
  ├─ OceanBaseMemoryFTSIndex（权威表 FULLTEXT，投影 no-op）
  └─ OceanBaseMemoryVectorIndex（VECTOR 列 + HNSW）
```

## 调用链路

### 一次 Memory Revision 提交：目录 + FTS + 向量同事务

```
MemoryService.begin() → RelationalMemoryBackend.begin()（persistence/memory.py:302）
→ AsyncDatabase.connection(bound)（bound 为 None 才自开事务，否则加入外层）
→ _RelationalMemoryUnitOfWork.commit(MemoryCommit)（memory.py:578，_complete 防重入）
→ _commit(connection, value)（memory.py:486-575）在同一事务同一连接内按序：
    1. _validate_commit（:600）family/content_hash/revision 连续性
       + projection 覆盖 active entry 集合的全等校验（投影行与权威目录
         不一致直接拒绝提交）
    2. artifacts.create/revise（:494/:501）写 pc_artifacts 权威 revision
       （revision 即乐观并发 CAS，与 tag 替换同锁）
    3. compact 与 tag 冲突复查（:511-518，for_update 重读 tagged entry，
       冲突则整个事务回滚，避免 dangling tag）
    4. 批量 insert pc_memory_entry_versions（权威 entry 版本行，append-only）
    5. diff 计算（:525-549）base vs 新 manifest → removed/changed/drop
       （未变 entry 不做任何投影工作）
    6. 先清索引再删头行（:550-561，"index metadata may cascade from the heads"）
    7. insert pc_memory_entry_heads + index.upsert（:562-574）
```

`pc_memory_entry_heads` 的结构体现"投影可重建但强一致"：主键 `(scope_id, memory_artifact_id, entry_id)`，双外键（`head_revision` 四元组 → `pc_artifacts` 精确 revision、entry 三元组 → `pc_memory_entry_versions` 精确版本，均 `ondelete=RESTRICT`）——投影行永远钉在权威行上，权威不可删而投影悬挂。

任何一步失败整体回滚——目录行、FTS、向量三者不会半写。这正是 `MemoryUnitOfWork` 协议 docstring 的 "Commit authoritative and projection rows in one backend transaction"。

### SQLite 与 OceanBase 的索引差异

| 维度 | SQLite | OceanBase |
| --- | --- | --- |
| FTS | FTS5 影子表 `pc_memory_entry_fts`，需手工 delete/insert 同步，启动全量重建 | FULLTEXT 直接建在 `pc_memory_entry_heads` 上，投影 replace/delete/upsert 全 no-op |
| 向量 | 双表：元数据行（FK CASCADE 指向 heads）+ vec0 虚拟表，`vector_id`=lastrowid 关联 | 单表 `VECTOR(dim)` 列 + HNSW 索引，`ORDER BY l2_distance(...) APPROXIMATE` |
| tag 过滤向量 | 改用 `vec_distance_L2` 精确算全候选集距离（避免全局 KNN 后过滤） | 删掉 ` APPROXIMATE` 注入 tag 条件走精确距离 |
| 租约 | single-process term（无需续约） | 持久租约行 + 每 `lease_seconds/3`（5s）续约，`_OCEANBASE_LEASE_SECONDS=15` |

## 核心实现

### AsyncDatabase：所有权与三种事务路径

```python title="builtin/persistence/database.py:35"
class AsyncDatabase:
    """Own or attach to one SQLAlchemy async engine.
    Repositories receive the yielded AsyncConnection and never own this object."""
```

- **attach/own 双所有权**：attach 借用调用方引擎（close 只 drain），own 在 close 时 dispose。
- **内存 SQLite 串行化**：`shared_connection=True`（aiosqlite StaticPool 单物理连接）时 `transaction()` 有同 task 可重入语义（`database.py:79-83`——嵌套 repository 调用直接复用外层事务，不二次 commit）。
- **MySQL 方言修正**：`connection.dialect.name == "mysql"` 时显式 `START TRANSACTION`（`:91-94`）——OceanBase 官方 async 方言的 begin hook 是 no-op。
- **model usage 独立事务**（`_model_usage_transaction`，`:108-154`）：模型用量记录绝不加入调用方事务。SQLite 侧用 `set_progress_handler` + `loop.call_at(deadline, driver._conn.interrupt)` 原生打断（asyncio 取消会 invalidate 连接并毁掉 StaticPool 内存库）；MySQL 侧超时 socket 不归还池（`:305-307` 注释 "A lost COMMIT reply is an unknown outcome, not permission to repeat the increment"）。
- **close 语义**：`asyncio.Condition` 计数活动事务，drain 到 0 才 dispose。

### 向量与 FTS 是投影而非权威

权威数据 = `pc_artifacts`（revision 链）+ `pc_memory_entry_versions`（append-only）；`pc_memory_entry_heads` 及 FTS/向量表都只是 manifest active 状态的派生物。证据链：`MemoryIndex` docstring "Optional query projection"；SQLite FTS `initialize()` 每次启动 delete-all 全量重插（`sqlite/memory_index.py:255`）；`rebuild_projections`（`persistence/memory.py:258`）两段式快照重建（读 baseline → 离线 embed → 重开事务校验 baseline 未变 → 全量重插）；运行期防护 `vector_complete` 不满足即抛 `CapabilityNotSupportedError`（拒绝用不完整索引出错误结果）。**为什么**：换 embedding profile/换 tokenizer/索引损坏时可整表重建而不碰权威 revision 历史。

### 三后端定位与 role 约束

- **SQLite**：本地单机档，`sqlite-vec` 捆绑提供向量检索。
- **OceanBase**：网络共享档——唯一支持 `artifact_processing_role` 拆分（all/api/background）的后端。**为什么**（结构推证）：role 拆分意味着 API 进程与后台 worker 通过共享数据库协作，而 SQLite 文件库是单进程本地资源（`:memory:` 更是 StaticPool 进程内单连接），另一进程根本无法访问；且 supervisor 的跨进程租约语义只有 oceanbase 模式才有。校验在 `runtime/config.py:462`："runtime.artifact_processing_role must be 'all' for SQLite and embedded seekdb"。
- **SeekDB**：嵌入式单机 OceanBase 兼容节点——本地启动实例 + 自注册方言 `mysql+aseekdb`（async Unix socket）。方言只覆写 `do_close → do_terminate`（"seekdb resets the socket while aiomysql drains COM_QUIT"）；`init_command "SET autocommit = 0"`（handshake 缺 autocommit 标志）。**复用 OceanBase 全部索引实现**（`composition.py:974`），即"OceanBase 语义、零部署"的开发档位。

### 表结构概览（46 张）

按职责分五组：Scope 组（`pc_scopes/context_references/bindings/settings/creation_requests`）、Source 组（`pc_sources/source_journal_heads/source_cursors/connector_checkpoints/source_definition_manifests`）、Artifact 组（`pc_artifacts/artifact_heads/lineage_sources/lineage_artifacts/publications/candidate_*/tags` + memory 的 `entry_versions/entry_heads` + topic_memory 的 `active_topics/active_chunks/...`）、后台处理组（`artifact_processing_pending/leases/intents/binding_states/...`）、Skill 与计量组（`skill_packages/skill_publications/agent_skill_targets/model_usage_daily/recall_token_daily`）。`schema.py` 的 `create_tables` 按 `Table.metadata` 分组 `create_all(checkfirst=True)`；FTS 虚拟表/FULLTEXT/HNSW 等 create_all 覆盖不了的由各 `index.initialize()` 补建。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Repository（约定式） | 各 family repository 模块 | 自己不拥有连接，统一签名 `async def f(self, connection, scope_id, ...)` |
| Unit of Work | `MemoryUnitOfWork` 协议 + `_RelationalMemoryUnitOfWork`（`_complete` 防重入） | 原子写边界 |
| Strategy + 双后端镜像 | `MemoryIndex` 七方法两两镜像 | 后端差异压在索引层 |
| Null Object | `NoMemoryIndex` | 诚实暴露无检索能力 |
| Codec | `dump_model/load_model/validate_json_model` + 各 repo 私有 `_xxx_values` | Pydantic ↔ 行，strict 校验 |

## 模块间交互

**装配**：`open_builtin_contexts` 按 `config.database` isinstance 选 Profile 与索引类，`tables = BUILTIN_TABLES + index.tables + topic_index.tables` 传给 Profile open，随后 `bootstrap_processing_schema`/`ensure_*_schema` 补建非 create_all 对象。**消费**：`RelationalContexts`（`runtime/relational.py:511`）持有 database/index，`_ScopedServices.memory()` 构建 backend；Memory 家族的写入经 `backend.begin()` → `MemoryUnitOfWork.commit`（详见 [01-memory](01-memory)）。**Supervisor**：消费 `processing_leases/processing_pending/processing_intents` 仓库（lease/fence 契约见 [05-runtime](05-runtime)）。

## 扩展方式

**新增一张表**：`tables.py` 用 `SHARED_METADATA` + `identity_string(N)` 定义（注意 MySQL FK 列长需匹配，`tag_key_hash` 指纹降索引宽度是先例）→ repository 模块写 codec → 若是 create_all 覆盖不了的（FTS/FULLTEXT/向量/带 schema_version 迁移）另写 `ensure_xxx_schema` 并在 composition **两条 profile 分支**的初始化事务里调用 → 需要后台处理的加进 `processing.py` family 集合与 `processing_migration.py` manifest。

**新增后端**：`xxx/profile.py`（`XxxConfig` + `XxxProfile.open` asynccontextmanager，参照 `seekdb/profile.py` 含方言注册）→ 镜像实现 `MemoryIndex/TopicMemoryIndex/ExperienceIndex` → `composition.py` 加 elif 分支 → 通用层适配点（`database.py` 的 MySQL `START TRANSACTION` 与 `is_transaction_contention` 错误码目前只认 aiosqlite/aiomysql；`SELECTION_BATCH_SIZE=500` 是跨后端 bind 参数上限）。
