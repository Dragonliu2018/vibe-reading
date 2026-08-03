---
title: "明细表"
source:
  type: "article"
  project: "Doris"
  url: "https://doris.apache.org/zh-CN/docs/3.x/table-design/data-model/duplicate"
  author: "Apache Doris"
  site: "Apache Doris 官方文档"
date: "2026-08-03T15:00:00+08:00"
category: [Database, Apache Doris, Docs, "3.x", "02 使用指南", "数据表设计", "表类型"]
tags: ["Apache Doris", "明细表", "Duplicate Key", "表类型", "排序键", "数据模型"]
description: "Apache Doris 3.x 官方文档：明细表（Duplicate Key Table）是默认建表模型，保留全量原始数据，不去重不聚合，适用于日志存储、用户行为分析、交易数据等场景。"
readingTime: "6 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **原文** [明细表](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-model/duplicate) · **作者** Apache Doris · **来源** Apache Doris 官方文档（3.x）· **转载** 2026-08-03

---

明细表是 Doris 中的默认建表模型，用于保存每条原始数据记录。在建表时，通过 DUPLICATE KEY 指定数据存储的排序列，以优化常用查询。一般建议选择三列或更少的列作为排序键，具体选择方式参考[排序键](https://doris.apache.org/zh-CN/docs/3.x/table-design/data-model/overview#排序键)。明细表具有以下特点：

- 保留原始数据：明细表保留了全量的原始数据，适合于存储与查询原始数据。对于需要进行详细数据分析的应用场景，建议使用明细表，以避免数据丢失的风险；
- 不去重也不聚合：与聚合模型与主键模型不同，明细表不会对数据进行去重与聚合操作。即使两条相同的数据，每次插入时也会被完整保留；
- 灵活的数据查询：明细表保留了全量的原始数据，可以从完整数据中提取细节，基于全量数据做任意维度的聚合操作，从而进行元数数据的审计及细粒度的分析。

## 使用场景

一般明细表中的数据只进行追加，旧数据不会更新。明细表适用于需要存储全量原始数据的场景：

- 日志存储：用于存储各类的程序操作日志，如访问日志、错误日志等。每一条数据都需要被详细记录，方便后续的审计与分析；
- 用户行为数据：在分析用户行为时，如点击数据、用户访问轨迹等，需要保留用户的详细行为，方便后续构建用户画像及对行为路径进行详细分析；
- 交易数据：在某些存储交易行为或订单数据时，交易结束时一般不会发生数据变更。明细表适合保留这一类交易信息，不遗漏任意一笔记录，方便对交易进行精确的对账。

## 建表说明

在建表时，可以通过 DUPLICATE KEY 关键字指定明细表。明细表必须指定数据的 Key 列，用于在存储时对数据进行排序。下例的明细表中存储了日志信息，并针对于 log_time、log_type 及 error_code 三列进行了排序：

```sql title="创建明细表"
CREATE TABLE IF NOT EXISTS example_tbl_duplicate
(
    log_time DATETIME NOT NULL,
    log_type INT NOT NULL,
    error_code INT,
    error_msg VARCHAR(1024),
    op_id BIGINT,
    op_time DATETIME
)
DUPLICATE KEY(log_time, log_type, error_code)
DISTRIBUTED BY HASH(log_type) BUCKETS 10;
```

## 数据插入与存储

在明细表中，数据不进行去重与聚合，插入数据即存储数据。明细表中 Key 列指做为排序。

![明细表数据追加存储](/vibe-reading/images/articles/doris-official-duplicate-table/duplicate-table-insert.png)

在上例中，表中原有 4 行数据，插入 2 行数据后，采用追加（APPEND）方式存储，共计 6 行数据：

```sql title="插入数据并查询"
-- 4 rows raw data
INSERT INTO example_tbl_duplicate VALUES
('2024-11-01 00:00:00', 2, 2, 'timeout', 12, '2024-11-01 01:00:00'),
('2024-11-02 00:00:00', 1, 2, 'success', 13, '2024-11-02 01:00:00'),
('2024-11-03 00:00:00', 2, 2, 'unknown', 13, '2024-11-03 01:00:00'),
('2024-11-04 00:00:00', 2, 2, 'unknown', 12, '2024-11-04 01:00:00');

-- insert into 2 rows
INSERT INTO example_tbl_duplicate VALUES
('2024-11-01 00:00:00', 2, 2, 'timeout', 12, '2024-11-01 01:00:00'),
('2024-11-01 00:00:00', 2, 2, 'unknown', 13, '2024-11-01 01:00:00');

-- check the rows of table
SELECT * FROM example_tbl_duplicate;
+---------------------+----------+------------+-----------+-------+---------------------+
| log_time            | log_type | error_code | error_msg | op_id | op_time             |
+---------------------+----------+------------+-----------+-------+---------------------+
| 2024-11-02 00:00:00 |        1 |          2 | success   |    13 | 2024-11-02 01:00:00 |
| 2024-11-01 00:00:00 |        2 |          2 | timeout   |    12 | 2024-11-01 01:00:00 |
| 2024-11-03 00:00:00 |        2 |          2 | unknown   |    13 | 2024-11-03 01:00:00 |
| 2024-11-04 00:00:00 |        2 |          2 | unknown   |    12 | 2024-11-04 01:00:00 |
| 2024-11-01 00:00:00 |        2 |          2 | unknown   |    13 | 2024-11-01 01:00:00 |
| 2024-11-01 00:00:00 |        2 |          2 | timeout   |    12 | 2024-11-01 01:00:00 |
+---------------------+----------+------------+-----------+-------+---------------------+
```
