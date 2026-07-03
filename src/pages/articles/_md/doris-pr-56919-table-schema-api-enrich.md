---
title: "丰富 Table Schema Open API 的返回信息"
source:
  project: "Doris"
  type: "PR"
  id: "56919"
  url: "https://github.com/apache/doris/pull/56919"
date: "2026-07-01"
category: [Database, Apache Doris, Contributions]
tags: ["Apache Doris", "Java", "Open API", "FE", "Schema"]
description: "在 Table Schema Open API 响应中新增 column_uid、schema_version 和 materialized_indexes，提升 Schema 演进的可观测性。"
readingTime: "6 min"
aiModel: "Claude Opus 4.8"
---

> **PR** [#56919](https://github.com/apache/doris/pull/56919) · **Issue** [#56800](https://github.com/apache/doris/issues/56800) · **commit** [7be7888](https://github.com/apache/doris/commit/7be788844c86ef3093e63d3aeb299327b100e3a9) · **首发版本** 4.0.1 · **变更行数** +65 行 · **合并时间** 2025-10-21

---

## 背景

Doris 提供了一个查询表 Schema 的 HTTP Open API：

```text title="Table Schema Open API 端点"
GET /api/{db}/{table}/_schema
GET /api/{catalog}/{db}/{table}/_schema
```

PR 前，该 API 的响应仅包含基础列信息（列名、类型、注释、聚合类型、是否可空）和顶层的 `keysType`。Issue [#56800](https://github.com/apache/doris/issues/56800) 由 **Hastyshell** 提出，指出缺少两类对调试 Schema 演进问题至关重要的字段：

1. **每列的 `column_uid`**：列在 Schema 变更历史中的唯一标识
2. **顶层的 `schema_version`**：当前 Schema 的版本号

---

## 前置知识

**`column_uid`（列唯一 ID）**：Doris 为每个列分配一个在表生命周期内单调递增的整型 ID，不随列的 ALTER（改名、改类型）而变化。在排查"同一列在不同 Schema 版本中是否对应"时，`column_uid` 是唯一可靠的标识——列名可能被重命名，类型可能被修改，但 UID 始终不变。

**`schema_version`**：每次 DDL 变更（ALTER TABLE）都会使 Schema 版本号 +1。通过比对不同节点上的 `schema_version`，可以快速定位 Schema 是否同步一致。

**物化索引（Materialized Index）**：Doris 支持在基表之外创建物化视图（Rollup），每个物化视图在内部被称为一个"物化索引"，有独立的列子集、keys 类型、Schema Hash 和版本号。基表本身也是一个物化索引（base index）。

---

## 实现

整个变更集中在 `TableSchemaAction.java` 单个文件中，65 行新增代码做了三件事。

### 抽取 buildColumnInfo() 辅助方法

原来在 `properties` 列表填充时的内联逻辑被提取为私有方法，同时新增 `column_uid` 和 `is_key` 字段：

```java title="TableSchemaAction.java — buildColumnInfo() 辅助方法"
private Map<String, String> buildColumnInfo(Column column) {
    Map<String, String> columnInfo = new HashMap<>();
    Type colType = column.getOriginType();
    PrimitiveType primitiveType = colType.getPrimitiveType();

    // DECIMAL 类型额外输出精度和小数位
    if (primitiveType == PrimitiveType.DECIMALV2 || primitiveType.isDecimalV3Type()) {
        ScalarType scalarType = (ScalarType) colType;
        columnInfo.put("precision", scalarType.getPrecision() + "");
        columnInfo.put("scale", scalarType.getScalarScale() + "");
    }

    columnInfo.put("column_uid",      String.valueOf(column.getUniqueId())); // 新增
    columnInfo.put("type",            primitiveType.toString());
    columnInfo.put("comment",         column.getComment());
    columnInfo.put("name",            column.getDisplayName());
    columnInfo.put("aggregation_type", Optional.ofNullable(column.getAggregationType())
            .map(t -> t.toSql()).orElse(""));
    columnInfo.put("is_nullable",     column.isAllowNull() ? "Yes" : "No");
    columnInfo.put("is_key",          column.isKey() ? "Yes" : "No");     // 新增

    return columnInfo;
}
```

### 新增顶层 schema_version

对 OlapTable，在返回 `keysType` 的同时补充 `schema_version`：

```java title="TableSchemaAction.java — 顶层字段新增"
if (table instanceof OlapTable) {
    resultMap.put("keysType",        ((OlapTable) table).getKeysType().name());
    resultMap.put("schema_version",  ((OlapTable) table).getBaseSchemaVersion()); // 新增
    // ...
}
```

### 新增 materialized_indexes

遍历 `indexIdToMeta` 映射，将每个物化索引的元信息和列详情一并输出：

```java title="TableSchemaAction.java — materialized_indexes 构建"
Map<Long, MaterializedIndexMeta> indexIdToMeta = olapTable.getIndexIdToMeta();
Map<String, Object> materializedIndexSchemas = new HashMap<>();

for (Map.Entry<Long, MaterializedIndexMeta> entry : indexIdToMeta.entrySet()) {
    Long indexId = entry.getKey();
    MaterializedIndexMeta indexMeta = entry.getValue();
    String indexName = olapTable.getIndexNameById(indexId);

    Map<String, Object> indexInfo = new HashMap<>();
    indexInfo.put("index_id",       indexId);
    indexInfo.put("keys_type",      indexMeta.getKeysType().name());
    indexInfo.put("schema_version", indexMeta.getSchemaVersion());
    indexInfo.put("schema_hash",    indexMeta.getSchemaHash());
    indexInfo.put("storage_type",   indexMeta.getStorageType().name());

    // 每个物化索引各自的列列表
    List<Map<String, String>> indexColumnList = new ArrayList<>();
    for (Column column : indexMeta.getSchema()) {
        indexColumnList.add(buildColumnInfo(column));
    }
    indexInfo.put("columns", indexColumnList);

    String key = indexName != null ? indexName : "index_" + indexId;
    materializedIndexSchemas.put(key, indexInfo);
}

resultMap.put("materialized_indexes", materializedIndexSchemas);
```

增强后的 API 响应结构（节选自 PR 描述）：

```json title="增强后的 API 响应结构"
{
  "data": {
    "schema_version": 0,
    "keysType": "DUP_KEYS",
    "materialized_indexes": {
      "sales_records": {
        "schema_version": 0,
        "storage_type": "COLUMN",
        "schema_hash": 98423311,
        "keys_type": "DUP_KEYS",
        "index_id": 1760849908202,
        "columns": [
          {
            "aggregation_type": "",
            "column_uid": "0",
            "is_nullable": "Yes",
            "is_key": "Yes",
            "name": "record_id",
            "comment": "",
            "type": "INT"
          }
        ]
      }
    },
    "properties": [
      {
        "name": "record_id",
        "aggregation_type": "",
        "column_uid": "0",
        "comment": "",
        "is_nullable": "Yes",
        "is_key": "Yes",
        "type": "INT"
      }
    ],
    "status": 200
  }
}
```

---

## Review


**Hastyshell**（Issue 提出者，同时担任 Reviewer）在 review 中提出两点建议：
1. 从 `MaterializedIndexMeta` 中补充每个物化索引的列详情（通过 `indexIdToMeta` + `getSchema()` 暴露），而不仅仅是顶层信息
2. 在 PR 描述中贴出示例输出，并在 doris-website 更新对应文档

两项建议均已采纳并完成。

---

## 意义与影响

| 字段 | PR 前 | PR 后 |
| --- | --- | --- |
| 每列 `column_uid` | ❌ 无 | ✅ 列的跨版本唯一标识 |
| 每列 `is_key` | ❌ 无 | ✅ 是否为排序键 |
| 顶层 `schema_version` | ❌ 无 | ✅ 当前基表 Schema 版本号 |
| 物化索引详情 | ❌ 无 | ✅ 含每个索引的列、类型、版本、Hash |

对于需要排查 Schema 一致性问题的 DBA 和运维人员，增强后的 API 可以直接回答：
- "这两个节点上的 Schema 是否一致？" → 对比 `schema_version`
- "这列经历了哪些变更还是同一列？" → 通过 `column_uid` 跨版本追踪
- "物化视图的 Schema 与基表有何差异？" → 对比 `materialized_indexes` 与 `properties`
