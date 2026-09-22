---
source:
  type: "源码解读"
  project: "yugabyte-db"
  url: "https://github.com/yugabyte/yugabyte-db"
title: "YQL 执行层"
date: "2026-09-23T00:30:00+08:00"
category: [Database, HTAP, YugabyteDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["YugabyteDB", "C++", "qlexpr", "builtin 函数", "YCQL", "Redis", "表达式下推"]
description: "YugabyteDB YQL 执行层解读——QLExprExecutor 树遍解释器、bf 三层框架（构建期代码生成非 JIT）、YSQL 表达式下推真机制是序列化 PG Expr 用 ybgate 复用 PG 求值器、YCQL 维护模式证据全解"
readingTime: "22 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`src/yb/yql/`（201k 行：cql/、redis/、pggate 相关的表达式设施）+ `src/yb/qlexpr/`（5k 行）+ `src/yb/bfcommon/bfql/bfpg/`（5.8k 行）。这一层回答"表达式怎么在客户端编译、在 tserver 上执行"。**先修正两个常见误解**：

1. **`codegen.cc` 不是 JIT/LLVM**——`src/yb/bfql/codegen.cc` 和 `src/yb/bfpg/codegen.cc` 是**构建期 C++ 代码生成器**：CMake 先编出 `bfql_codegen` 可执行文件，读取 `directory.cc` 的函数声明表，生成 `gen_opcodes.h`（BFOpcode 枚举）、`gen_opspec_table.cc`（类型检查表）、`gen_bfunc_table.cc`（函数指针执行表）。运行时无任何动态编译
2. **qlexpr 不是 bytecode VM**——`QLExprExecutor::EvalExpr`（ql_expr.cc:97-166 的 `DoEvalExpr`）是对 protobuf 表达式树的**递归树遍解释器**，直接 switch `expr_case()`

## 模块架构

```
客户端编译侧                          tserver 执行侧
CQL: ptree (88 个 PT* 节点)            QLExprExecutor (qlexpr/ql_expr.h)
  → Executor::ExecPTNode               ├─ YCQL: DocExprExecutor (docdb/doc_expr.cc)
    (cql/ql/exec/executor.cc, 114k)    │    覆盖 EvalTSCall 执行聚合/写条件
    → QLWriteRequestPB / QLReadPB     └─ YSQL: DocPgExprExecutor (docdb/doc_pg_expr.cc)
      (表达式树 = QLExpressionPB          经 ybgate_api 反序列化 PG Expr
       含 bfcall/tscall opcode)           用 PG 自己的求值器跑真 PG 语义

bf 三层: bfcommon(共享: BFDecl 元数据 + cast/convert)
         bfql (CQL 方言 ~180 声明) + bfpg (PG 方言, 极小——见下)
```

**双协议贯穿全层**：`QLValuePB` vs `LWQLValuePB`（Lightweight protobuf）——2023-25 年大规模 LW 迁移的产物；tserver 写热路径走 LW。

## 核心实现

### YSQL 表达式下推：bfpg 已边缘化，真机制是序列化 PG Expr

这是本模块最反直觉的发现——`FindPgsqlOpcode` 在 bfpg 之外**零调用者**（grep 验证）。现代 YSQL 的谓词下推链路：

1. PG 后端 `YBCNewEvalExprCall`（`src/postgres/src/backend/executor/ybExpr.c:783-810`）用 `ybSerializeNode` 把 PG Expr 树序列化为 CSTRING 常量
2. pggate `PgExpr::NameToOpcode("eval_expr_call")` → `bfpg::TSOpcode::kPgEvalExprCall`（`yql/pggate/pg_expr.cc:174`）
3. tserver 端 `DocPgExprExecutor`（`docdb/doc_pg_expr.cc:319`）通过 **ybgate API**（`src/postgres/src/backend/ybgate/ybgate_api.c`，**编译进 yb-tserver**）`YbgPrepareExpr` 反序列化、`YbgEvalExpr` 求值——**用 PG 自己的求值器在 DocDB 侧跑真 PG 语义**，PG MemoryContext 由 `MemoryContextGuard` 管理
4. 下推资格由 `yb_can_pushdown_func`（ybExpr.c:276）白名单 `yb_funcs_safe_for_pushdown` + 黑名单控制——仅 builtin + immutable（catalog 不可达的函数不能推）

**Why 这个设计**：不复制语义，直接复用 PG 求值器——bfpg 目录因此冻结（只剩 cast、聚合、`+/-/==`、`now()`）。bfpg 只覆盖聚合 TSOpcode 和少量运算符。

### YCQL 表达式：编译到 PB 树 + 跨进程解释

cqlserver 解析 CQL（flex/bison）→ `Executor` 把 PT 树**编译成 `QLWriteRequestPB`**（`PTBcall::Analyze`（pt_bcall.cc:145）调 `bfql::BFCompileApi::FindQLOpcode` 做类型检查 + 重载解析（`HasExactTypeSignature` → `HasSimilarTypeSignature` 两轮））→ 经 YBClient 发 tserver → 任何进程用同一个 `QLExprExecutor` 解释。"编译一次、处处执行"的**解释型**方案。`DocExprExecutor` 覆盖 `EvalTSCall` 执行聚合（kCount/kSum/kMin/kMax）和集合原位修改（kMapExtend/kListAppend）。

### 扫描谓词下推

`QLScanRange`（ql_scanspec.h:102）从条件 PB 抽取每列 min/max bound，支持交/并/补；`GetRangeKeyScanSpec`（doc_scanspec_util.cc:26）把范围翻译成 DocDB range key 组件（非闭区间追加 `kHighest/kLowest` 哨兵）；tserver 逐行 `spec->Match()` 过滤。

### 二次索引双模式

`IndexInfo`（qlexpr/index.h）是索引元数据单一真源（含部分索引 `where_predicate_spec_`、backfill 状态、`vector_idx_options_`）。读路径两模式（`yql/pggate/pg_select.cc:42-68` 注释）：

- **embedded**：colocated 表把索引请求内嵌进 `PgsqlReadRequestPB.index_request`，tserver 单 RPC 完成索引查 + 回表
- **batched**：普通分片表由 `PgSelectIndex::FetchYbctidBatch` 每批取 1024 个 ybctid，`PgDocReadOp::DoPopulateByYbctidOps`（pg_doc_op.cc:857，六步注释）按 tablet 分桶批式回表，`keep_order` 用 `MergingPgDocOpFetchStream` 归并保序

**部分索引谓词在写路径服务端求值**：`QLWriteOperation::UpdateIndexes`（cql_operation.cc:1465）对 existing/new 两行分别 EvalCondition——处理"谓词由真变假需删索引项"的组合语义，正确性逻辑放在拥有旧值/新值的 tserver。

### bf 框架与 opcode wire 契约

`bfcommon`（`BFDecl<Opcode, Traits>` 元数据 + 33k 行 cast/convert 共享实现）→ `bfql`（CQL 方言，`directory.cc` 约 180 个声明）+ `bfpg`。**O(1) 数组下标分发**：`kBFExecFuncsRefAndRaw[std::to_underlying(opcode)](params)`（bfql.h:247）。**关键约束**：`bfql/directory.cc:57` 注释强制"新条目只能追加到表尾"——`kBFDirectory` 的数组序号直接生成 `BFOpcode` 枚举值，新旧混部集群按整数 opcode 分发，重排即调错函数（wire 契约）。

### Redis 兼容层

`RedisParser`（redisserver/redis_parser.h:42）是**带记忆的流式有限状态机**（INITIAL→SINGLE_LINE / BULK_HEADER→BULK_ARGUMENT_SIZE→BULK_ARGUMENT_BODY），直接跑在自研 RPC 的 reactor 线程上（`RedisConnectionContext : rpc::ConnectionContextWithQueue`），单连接命令批处理。~85 条命令用 BOOST_PP 宏表声明，每条一个 `ParseXxx` 直接填进 YBRedisWriteOp/ReadOp。存储模型：redis 数据放 `YQL_DATABASE_REDIS` namespace 单表，`DocKey::FromRedisKey(hash_code, key)`（redis key 即 DocKey 哈希分量），TTL 用 DocDB 原生 `dockv::Expiration`。

### YCQL 的现状：维护模式（git 活跃度证据）

2024-01 以来：`yql/pggate` **718 commits**（大量功能性）；`yql/cql` 81 commits 且绝大多数是横切改动，YCQL 专属功能仅 **JWT/OIDC 认证**（2025 年）和零星修复；`bfql/bfpg` 各 4 commits 全是重构。**结论：YCQL 处于维护模式**——仍收安全修复与新认证特性，但无查询能力演进（官方正式声明在站点文档，**待核实**）。

## 设计模式

| 模式 | 位置 | 为什么用 |
|---|---|---|
| 树遍解释器 | QLExprExecutor（ql_expr.cc:97） | PB 树跨进程可解释，客户端/服务端复用 |
| 构建期代码生成 | bfql/bfpg codegen.cc | 元数据表单源生成枚举/类型检查/执行表 |
| 复用而非复制 | kPgEvalExprCall + ybgate（doc_pg_expr.cc:111） | PG 语义零漂移 |
| 双形态泛型 | QLValuePB vs LWQLValuePB | 热路径免 protobuf 反射 |

## 模块间交互

- **与 pggate**：见[PostgreSQL 查询层](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/06-ysql)——pggate 的 `PgExpr` 是本层的客户端入口
- **与 DocDB**：`DocExprExecutor`/`DocPgExprExecutor` 在 docdb/ 目录（见[DocDB 存储抽象](/vibe-reading/articles/Database/HTAP/YugabyteDB/CodeWiki/master-2026-08/04-docdb)）
- **与 RPC**：CQL/Redis 连接上下文都基于自研 rpc（`ConnectionContextWithCallId/WithQueue`）
- pggate 的 buffering 语义（read point、写缓冲 7 类强制 flush 场景）见 §模块定位注释与 pggate/README

## 扩展方式

**新增一个 YCQL builtin 函数**（按 `bfql/directory.h:18-30` 官方步骤）：① C++ 实现放 `bfcommon/bfunc_convert.h`（共享）或 `bfql/bfunc_standard.h`（CQL 专属）；② `bfql/directory.cc` 的 `kBFDirectory` **表尾**追加声明（顺序即 wire 契约）；③ 构建时 `bfql_codegen` 自动重新生成 5 个 gen_* 文件；④ SQL 语法则改 parser_gram.y + kwlist.h。

**新增 YSQL 下推函数**：**常规路径不是 bfpg**——改 `src/postgres/src/backend/executor/ybExpr.c` 的 `yb_funcs_safe_for_pushdown` 白名单 + `yb_can_pushdown_func`，表达式经序列化由 PG 求值器执行。
