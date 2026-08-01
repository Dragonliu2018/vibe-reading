---
title: "补齐 AddColumnsClause 在 AGG_KEYS 表的 key 标记逻辑"
source:
  project: "Doris"
  type: "PR"
  id: "61798"
  url: "https://github.com/apache/doris/pull/61798"
  prType: "fix"
date: "2026-07-31T11:30:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "Schema Change", "AGG_KEYS", "FE", "崩溃"]
description: "AGG 模型表用 ALTER ADD COLUMNS 加 double/float 列时，AddColumnsClause 未像 AddColumnClause 那样标记 key，导致非法 schema 透传到 BE 在 _full_encode_keys 空指针崩溃；修复补上 setIsKey 让 FE 在 analyze 阶段拒绝。"
readingTime: "7 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#61798](https://github.com/apache/doris/pull/61798) · **Issue** [#61797](https://github.com/apache/doris/issues/61797) · **commit** [a3052de](https://github.com/apache/doris/commit/a3052de2e5cbc397d67b9cd9d5cd9701aaa6426c) · **首发版本** - · **变更行数** +12 行 · **合并时间** 2026-03-31

---

## 背景

Doris 的 AGG（聚合）模型表里，每一列要么是 **key 列**，要么是带聚合方式的 **value 列**。给 AGG 表加列时，如果某列没写聚合方式，它理应被当成 key 列处理。但 `ALTER TABLE ... ADD COLUMNS (...)`（多列版本）的 `analyze` 漏了这步判定，于是当用户往 AGG 表加一个 `double`/`float` 的 key 列并导入数据时，BE 直接 **SIGSEGV 崩溃**。

Issue [#61797](https://github.com/apache/doris/issues/61797) 给出的崩溃栈（空指针解引用，`@0x0`）：

```text title="BE 崩溃调用栈（Issue #61797）"
SIGSEGV address not mapped to object (@0x0)
doris::segment_v2::VerticalSegmentWriter::_full_encode_keys(...)
doris::segment_v2::VerticalSegmentWriter::write_batch()
doris::SegmentFlusher::flush_single_block(...)
doris::SegmentCreator::flush_single_block(...)
doris::BetaRowsetWriterV2::flush_memtable(...)
doris::FlushToken::_flush_memtable(...)
doris::MemtableFlushTask::run()
```

崩溃发生在 memtable 落盘时的 **key 编码**路径 `_full_encode_keys`，是个空指针解引用。但根因不在 BE——是 FE 的 `AddColumnsClause.analyze` 漏标 key，让一个既非 key、又无聚合方式的非法列穿透到 BE，key 编码拿到不一致的列 accessor 后解空指针。Issue 里也点明期望行为：**float/double 不应能作为 AGG 表的 key 列被加入，应在 FE 严格拒绝**。

---

## 前置知识

### AGG_KEYS 与「无聚合方式即 key」

Doris 表按 `KeysType` 分 DUP / UNIQUE / AGG 等。AGG_KEYS 模型下，列要么是 key（参与排序、可不写聚合方式），要么是 value（必须带 `SUM`/`MAX`/`REPLACE` 等聚合方式）。所以一条判定规则成立：**在 AGG_KEYS 表里，没写聚合方式的列就是 key 列**。

### 单列 vs 多列：两条不对称的加列路径

`ALTER TABLE ADD COLUMN`（单列）走 `AddColumnClause`，`ALTER TABLE ADD COLUMNS`（多列）走 `AddColumnsClause`。这两条路径本应共用同一套 key 判定，但实现是各自独立的。关键差异在 `analyze` 里对 AGG_KEYS + 无聚合方式列的处理：

```java title="AddColumnClause.analyze（单列，已有完整逻辑）"
if (table instanceof OlapTable && ((OlapTable) table).getKeysType() == KeysType.AGG_KEYS
        && columnDef.getAggregateType() == null) {
    columnDef.setIsKey(true);
}
// ...
columnDef.setKeysType(((OlapTable) table).getKeysType());   // 单列路径还设了 keysType
columnDef.analyze(true);
```

单列路径 `AddColumnClause` 既 `setIsKey(true)` 又 `setKeysType(...)`，把列正确归类成 key。而多列路径 `AddColumnsClause` 在修复前**完全没有这段逻辑**——这就是 bug 的温床。

### ColumnDef.analyze 里的 key 校验链

`colDef.analyze(true)` 内部对「key 列 + float/double」有明确拒绝：

```java title="ColumnDef.analyze 中的 float/double key 拒绝"
if (type.getPrimitiveType() == PrimitiveType.FLOAT
        || type.getPrimitiveType() == PrimitiveType.DOUBLE) {
    if (isOlap && isKey) {
        throw new AnalysisException("Float or double can not used as a key, use decimal instead.");
    }
}
```

这条校验的前提是 `isKey == true`。只要加列路径在 `analyze` 前把无聚合方式的列标成 key，float/double 就会在这里被 FE 拦下、抛出清晰错误，根本到不了 BE。

---

## 实现

### 修复前：多列路径不标 key

```java title="AddColumnsClause.analyze — 修复前（关键片段）"
for (ColumnDef colDef : columnDefs) {
    colDef.analyze(true);   // 直接 analyze，isKey 默认 false
    // ...
}
```

`AddColumnsClause.analyze` 对 `columnDefs` 直接逐个 `analyze`，没有针对 AGG_KEYS + 无聚合方式的 `setIsKey` 逻辑。于是加一个 `double` 列时，`isKey` 保持 `false`，`ColumnDef.analyze` 里的 float/double key 校验（`if (isOlap && isKey)`）被跳过，FE 不报错，非法列一路下穿到 BE，memtable flush 时 `_full_encode_keys` 解到空 accessor 崩溃。

### 修复后：补上 setIsKey，对齐单列路径

```java title="AddColumnsClause.analyze — 修复后"
for (ColumnDef colDef : columnDefs) {
    if (tableName != null) {
        Table table = Env.getCurrentInternalCatalog().getDbOrAnalysisException(tableName.getDb())
                .getTableOrAnalysisException(tableName.getTbl());
        if (table instanceof OlapTable && ((OlapTable) table).getKeysType() == KeysType.AGG_KEYS
                && colDef.getAggregateType() == null) {
            colDef.setIsKey(true);
        }
    }
    colDef.analyze(true);
    // ...
}
```

修复只加了 12 行：在循环里查表，命中 `AGG_KEYS` 且列无聚合方式时 `colDef.setIsKey(true)`，再走 `analyze(true)`。效果链路：

1. `setIsKey(true)` 把无聚合方式列正确归类成 key（与单列路径一致）；
2. `ColumnDef.analyze(true)` 随即触发 `if (isOlap && isKey)` 分支，对 `FLOAT`/`DOUBLE` 抛 `Float or double can not used as a key, use decimal instead.`；
3. FE 在分析期就拒绝这条 schema change，非法 schema 不会下穿到 BE，崩溃消失。

> 这又是一个「**修复在 FE，崩溃在 BE**」的案例：症状是 BE 的空指针 core dump，但真正该兜底的是 FE 的列归类。BE 的 key 编码没有义务为 FE 漏标 key 的非法列兜底。

---

## 测试

### 回归测试

需要如实指出：**PR #61798 本身没有附带回归测试**。`git show` 的 diff 只有 `AddColumnsClause.java` 一个文件、+12 行，没有 `.groovy`/`.out`。PR 自检清单里勾了 `[x] Regression test`，但 diff 里并无对应测试文件，属于清单与实际不符。同源的 branch-3.0 跟进 PR [#61799](https://github.com/apache/doris/pull/61799)（commit `4090f6c`）也是同样的 +12 行、无测试。

### 复现脚本

Issue #61797 里给出的复现路径就是目前最权威的验证步骤：

```sql title="复现脚本（Issue #61797）"
-- 1. 建 AGG 模型表
CREATE TABLE t (k1 int) ENGINE=OLAP AGG KEY(k1) DISTRIBUTED BY HASH(k1) BUCKETS 1
  PROPERTIES("replication_allocation"="tag.location.default:1");

-- 2. 用 ADD COLUMNS 加一个 double 列（无聚合方式）
ALTER TABLE t ADD COLUMNS (d double);

-- 3. 导入数据 → 修复前 BE SIGSEGV；修复后 FE 在第 2 步即报错拒绝
```

修复后第 2 步会直接返回 `Float or double can not used as a key, use decimal instead.`，根本到不了导入。由于两个 PR 都没补测试，这条路径目前缺少自动化回归覆盖——是这次修复留下的一个明显缺口。

---

## 意义与影响

这个 bug 的触发面：**任何对 AGG 模型表执行 `ALTER TABLE ADD COLUMNS` 且其中含 float/double 列（或更广义地，无聚合方式列）的操作，都可能直接打挂 BE**。对线上集群而言，一句看起来人畜无害的加列 DDL + 一次导入，就能让 BE 进程崩溃，属于高危路径。

修复的价值：

1. **补齐单列/多列路径的 parity**。`AddColumn` 与 `AddColumns` 两条加列路径本应共用 key 判定，此前只有单列路径做对。这次把多列路径的 `setIsKey` 补上，从源头消除非法列下穿。
2. **让 FE 兜底而非 BE 兜底**。修复把拦截点前移到 FE `analyze`，复用已有的 `Float or double can not used as a key` 校验，BE 的 key 编码路径无需为非法 schema 做防御，符合「谁归类谁兜底」。
3. **留下了测试与 parity 缺口**。两处未竟——#61798/#61799 都没补回归测试，且 `setKeysType` 仍缺失。若后续有人用 `ADD COLUMNS` 给 AGG 表加 BITMAP/HLL 无聚合列，可能仍踩到 parity 不完整的边角。

版本层面，PR 于 2026-03-31 合入 `branch-2.1`，同源修复于 2026-04-03 以 [#61799](https://github.com/apache/doris/pull/61799) 合入 `branch-3.0`；PR 未带 `dev/x.x.x-merged` 分支 pick 标签，首发版本待定。仍在 2.1/3.0 早版本上跑 AGG 表的集群，若遇加列崩溃，应已包含此修复。
