---
title: "修复大块数据 RPC 传输溢出，并默认启用 brpc HTTP 通道"
source:
  project: "Doris"
  type: "PR"
  id: "35770"
  url: "https://github.com/apache/doris/pull/35770"
  prType: "fix"
date: "2026-08-05T18:30:00+08:00"
category: [Database, Apache Doris, PRs]
tags: ["Apache Doris", "BRPC", "Protobuf", "RPC", "Stream Load", "C++"]
description: "修复大块数据通过 brpc 传输时 protobuf 序列化溢出 2GB 限制的 bug，使用 std::move 转移 block 数据后清空原字段，并将 transfer_large_data_by_brpc 默认值从 false 改为 true。"
readingTime: "8 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#35770](https://github.com/apache/doris/pull/35770) · **Issue** - · **commit** [c9651614](https://github.com/apache/doris/commit/c9651614b0e65d174c317470aef0faeae5b4627d) · **首发版本** 2.0.12 · **变更行数** +71 行 · **合并时间** 2024-06-03

---

## 背景

在 Doris 的 Stream Load 和查询执行过程中，BE 节点之间需要通过 RPC 传输数据块（Block）。当数据量较大时，用户会遇到以下错误：

```
add batch req success but status isn't ok, err: [INTERNAL_ERROR]PStatus:
(172.200.0.1)[INTERNAL_ERROR]fail to add batch in load channel.
unknown load_id=0000000000000000-0000000000000000.
```

根本原因在于 **Protobuf 的 2GB 序列化限制**。Protobuf 使用 32 位长度前缀编码，单个 message 序列化后的最大尺寸为 2GB。当 Block 数据接近或超过这一限制时，`SerializeToString` 会静默失败或产生截断数据，导致反序列化端无法正确解析请求。

Doris 已有一套应对机制：当 Block 数据超过 1.8GB（`MIN_HTTP_BRPC_SIZE = 1ULL << 31`，即 2GB 预留 0.2GB 余量）时，切换到 brpc HTTP 通道传输——将 Block 数据从 Protobuf message 中取出，放入 HTTP attachment 单独发送，避免 Protobuf 序列化超限。但这套机制存在一个关键 bug：**Block 数据在编码时没有被真正移除**，Protobuf 仍然尝试序列化包含大 Block 的完整 message，导致溢出。

## 前置知识

### Protobuf 2GB 限制

Protobuf 的 `wire format` 使用 `varint` 编码长度字段，理论上最大可编码 64 位整数。但在实际实现中，Google 对单个 message 的序列化尺寸施加了 **2GB（$2^{31}$ 字节）** 的硬限制：

- `SerializeToString` 在序列化结果超过 2GB 时返回 `false`
- `ParseFromString` 在输入超过 2GB 时无法正确解析
- 这一限制源于 Protobuf 内部使用 `int32` 表示字段长度

### brpc HTTP attachment 机制

brpc 提供了一种绕过 Protobuf 限制的传输方式：将大数据从 Protobuf message 中剥离，放入 `Controller` 的 **attachment** 字段，通过 HTTP 协议单独传输。Protobuf message 只携带元信息（序列化后体积小），大 Block 数据走 attachment 通道，两者在接收端重新组装。

```
普通 RPC:  [Protobuf message（含 Block 数据）] → SerializeToString → 发送
                         ↑ 超过 2GB 时失败

HTTP RPC:  [Protobuf message（元信息，Block 已移除）] → SerializeToString → attachment 前段
           [Block 原始数据]                                        → attachment 后段
                         ↑ message 小于 2GB，序列化成功
```

## 实现

### Bug 根因：copy 而非 move

原代码在 `request_embed_attachment_contain_blockv2` 中处理 Block 数据转移：

```cpp title="be/src/util/proto_util.h — 修改前"
template <typename Params, typename Closure>
Status request_embed_attachment_contain_blockv2(Params* brpc_request,
                                                 std::unique_ptr<Closure>& closure) {
    auto block = brpc_request->block();                    // ① const 引用，获取 Block
    Status st = request_embed_attachmentv2(
        brpc_request, block.column_values(), closure);     // ② 传 const 引用给 attachment
    block.set_column_values("");                           // ③ 尝试清空，但操作的是副本
    return st;
}
```

问题出在 **①** 处：`brpc_request->block()` 返回的是 `const Block&`（const 引用），`block` 是一个 const 对象。随后的 **③** `block.set_column_values("")` 看似清空了 `column_values`，但由于 `block` 是 const 引用，`set_column_values` 要么编译失败，要么操作的是临时副本——**原 Protobuf message 中的 `block.column_values` 字段并没有被真正清空**。

结果：`request_embed_attachmentv2` 将 Block 数据拷贝到 attachment 后，Protobuf message 中仍然保留着完整的 Block 数据。当 `SerializeToString` 被调用时，它尝试序列化整个 message（含大 Block），超过 2GB 限制，序列化失败。

### 修复：std::move + mutable 访问 + 清空

```cpp title="be/src/util/proto_util.h — 修改后"
template <typename Params, typename Closure>
Status request_embed_attachment_contain_blockv2(Params* brpc_request,
                                                 std::unique_ptr<Closure>& closure) {
    // ① 通过 mutable 链获取可变指针，std::move 转移数据所有权
    std::string column_values = std::move(*brpc_request->mutable_block()->mutable_column_values());
    // ② 显式清空原字段（move 后原 string 处于 valid-but-unspecified 状态）
    brpc_request->mutable_block()->mutable_column_values()->clear();
    // ③ 传移出的数据给 attachment，Protobuf message 中已无大 Block
    return request_embed_attachmentv2(brpc_request, column_values, closure);
}
```

三个关键改动：

| 改动 | 原代码 | 新代码 | 作用 |
| --- | --- | --- | --- |
| 访问方式 | `brpc_request->block()`（const） | `brpc_request->mutable_block()->mutable_column_values()`（mutable） | 获取可变指针，能真正修改 message |
| 数据转移 | `block.column_values()`（const 引用，隐式拷贝） | `std::move(*mutable_column_values)`（move 语义，零拷贝） | 转移 string 内部 buffer 所有权，避免拷贝大 Block |
| 清空原字段 | `block.set_column_values("")`（操作副本，无效） | `mutable_column_values->clear()`（操作原字段，有效） | 确保 Protobuf message 中的 Block 数据被真正移除 |

修复后的数据流：

```
brpc_request.block.column_values = "2GB 原始数据"
                    ↓ std::move
column_values (local) ← "2GB 原始数据"    // 零拷贝转移
brpc_request.block.column_values = ""      // 清空，message 现在 < 2GB
                    ↓
request_embed_attachmentv2(request, column_values)
    ├── SerializeToString(request) → ✅ 成功（message < 2GB）
    └── attachment.append(column_values)   // 大数据走 attachment
```

### SerializeToString 错误检查

原代码对 `SerializeToString` 的返回值**完全忽略**：

```cpp title="be/src/util/proto_util.h — 修改前"
std::string req_str;
brpc_request->SerializeToString(&req_str);    // 返回 bool，被忽略
```

如果序列化失败（例如 message 仍然超限），`req_str` 会是空字符串或部分数据，后续发送给接收端会导致反序列化失败，表现为 `unknown load_id` 错误——因为接收端无法从残缺的数据中解析出 `load_id` 字段。

修复后增加了错误检查：

```cpp title="be/src/util/proto_util.h — 修改后"
std::string req_str;
if (!brpc_request->SerializeToString(&req_str)) {
    return Status::InternalError("failed to serialize the request");
}
```

这使得序列化失败时有**明确的错误信息**返回给调用方，而不是静默传递残缺数据。

### 默认启用 transfer_large_data_by_brpc

```cpp title="be/src/common/config.cpp"
// 修改前
DEFINE_mBool(transfer_large_data_by_brpc, "false");
// 修改后
DEFINE_mBool(transfer_large_data_by_brpc, "true");
```

`transfer_large_data_by_brpc` 控制是否在 Block 数据超过 1.8GB 时自动切换到 brpc HTTP 通道。该配置在 branch-2.0 上已默认启用，此 PR 将 master 分支的默认值也改为 `true`，保持分支间一致。

`DEFINE_mBool` 中的 `m` 前缀表示该配置是 **mutable** 的——可以在运行时通过 `ADMIN SET FRONTEND CONFIG` 动态修改，无需重启 BE。

## 测试

### 回归测试

新增 P2 级回归测试 `test_large_data_by_rpc.groovy`：

```groovy title="regression-test/suites/load_p2/test_large_data_by_rpc.groovy"
suite("test_large_data_by_rpc", "p2") {
    def tableName = "test_large_data_by_rpc"

    sql """ DROP TABLE IF EXISTS ${tableName} """
    sql """
        CREATE TABLE ${tableName} (
             `id` INT NULL,
             `id1` INT NULL,
             `id2` INT NULL,
             `array1` ARRAY<TEXT> NULL,
             `map1` MAP<TEXT,TEXT> NULL,
             `struct1` STRUCT<f1:VARCHAR(65533),...,f110:VARCHAR(65533)> NULL,
             `json1` JSON NULL
        ) ENGINE=OLAP
        DUPLICATE KEY(`id`, `id1`, `id2`)
        DISTRIBUTED BY HASH(`id1`) BUCKETS 1
        PROPERTIES ("replication_allocation" = "tag.location.default: 1");
    """

    streamLoad {
        table "${tableName}"
        set 'column_separator', '|'
        set 'compress_type', 'GZ'
        file """${getS3Url()}/regression/load/data/large_data_by_rpc.csv.gz"""
        time 30000
        check { result, exception, startTime, endTime ->
            if (exception != null) { throw exception }
            def json = parseJson(result)
            assertEquals("success", json.Status.toLowerCase())
            assertEquals(json.NumberTotalRows, 3000)
        }
    }
}
```

测试设计要点：

| 要素 | 设计意图 |
| --- | --- |
| 表结构含 20 个 VARCHAR(65533) 字段 + ARRAY + MAP + JSON | 构造宽行，使单批 Block 容易超过 1.8GB |
| GZ 压缩上传 | 压缩后网络传输量小，但 BE 解压后数据膨胀，触发大 Block RPC |
| 3000 行数据 | 配合宽行，解压后数据量足以触发 brpc HTTP 通道 |
| P2 级别 | 需要大数据资源（S3 上的测试数据文件），不跑在常规 CI 中 |

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| Block 数据 > 1.8GB 的 Stream Load | `SerializeToString` 静默失败，`unknown load_id` 错误 | 数据正确通过 attachment 传输，加载成功 |
| Block 数据 > 2GB 的查询传输 | Protobuf 序列化溢出，请求丢失 | 同上，绕过 2GB 限制 |
| `transfer_large_data_by_brpc` 配置 | 默认 `false`，需手动开启 | 默认 `true`，开箱即用 |
| 序列化失败时 | 残缺数据静默发送，难以排查 | 返回 `InternalError`，日志可见 |

**核心修复**是一行 `std::move` + `clear`——将 Block 数据从 Protobuf message 中真正移除，而非无效的 const 操作。这是一个典型的 **C++ const 正确性 bug**：原代码假设 `block.set_column_values("")` 能修改 message，但 const 引用使得修改无效。

**防御性改进**是 `SerializeToString` 的返回值检查。即使未来再出现类似的 message 超限问题，也能通过明确的 `InternalError` 错误信息快速定位，而不是让残缺数据在网络上传输后才在接收端表现为不可解析的 `unknown load_id`。

**配置对齐**将 master 分支与 branch-2.0 的默认行为统一，避免用户从 2.0 升级到 3.0 时遇到行为回退。
