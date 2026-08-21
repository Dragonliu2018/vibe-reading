---
source:
  type: "源码解读"
  project: "ArcticDB"
  url: "https://github.com/man-group/ArcticDB"
title: "Python API 层"
date: "2026-08-21T10:16:26+08:00"
category: [Database, DataFrame, ArcticDB, CodeWiki, "6.23.0"]
tags: ["ArcticDB", "Python", "归一化", "Library API"]
description: "ArcticDB Python API 层：Arctic/Library/NativeVersionStore 与 DataFrame 归一化"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/00-overview)

---

## 模块定位

Python API 层是 ArcticDB 唯一面向用户的边界。它的职责不是"做计算"——所有数据处理都在 C++ 引擎里——而是**隔离 Python 对象格式**：把 pandas/pyarrow/polars 这些异构的用户数据归一化成 C++ 能消费的 `InputFrame`，把 C++ 返回的 `OutputFrame` 还原成用户想要的格式；同时把存储 URI 解析成 C++ 的 protobuf 配置。这层独立存在，是因为 C++ 引擎绝不应该感知 pandas 的 index/dtype/NaT 这些 Python 特有概念。

## 模块架构

![Python ↔ C++ pybind11 桥](/vibe-reading/images/articles/arcticdb-internals/python-bridge.svg)

Python API 层自上而下是三级对象：`Arctic`（库管理 + URI 适配）→ `Library`（V2 用户 API）→ `NativeVersionStore`（V1 API，直接持有 C++ `PythonVersionStore` 句柄）。`Arctic.__init__` 遍历 `_LIBRARY_ADAPTERS`（6 个适配器：`S3LibraryAdapter`/`GCPXMLLibraryAdapter`/`LMDBLibraryAdapter`/`AzureLibraryAdapter`/`MongoLibraryAdapter`/`InMemoryLibraryAdapter`），用 `supports_uri(uri)` 匹配 scheme，构造出适配器并生成 C++ `LibraryManager`。`Library` 包装 `NativeVersionStore`，后者经 pybind11 调到 `arcticdb_ext.PythonVersionStore`。归一化（`_normalization.py`）是横切关注点：写前 `normalize()` 把 DataFrame 转成 `PandasData`（numpy 数组引用 + `NormalizationMetadata` protobuf），读后 `denormalize()` 还原。这样设计是为了让 C++ 引擎只处理"列 + 类型描述符"的统一内存格式，而 Python 复杂性留在 Python 侧。

## 调用链路

```text
lib.write("sym", df)                                     library.py
  └─ NativeVersionStore.write(symbol, df, ...)           _store.py
       └─ normalize(df) → NormalizedInput(PandasData)    _normalization.py
            └─ arcticdb_ext.PythonVersionStore.write()   pybind11 → version_store_api.cpp
                 └─ write_versioned_dataframe_internal   local_versioned_engine.cpp

lib.read("sym", as_of, columns, query_builder)           library.py
  └─ NativeVersionStore.read(...)                        _store.py
       └─ PythonVersionStore.read() → OutputFrame        pybind11
            └─ denormalize(frame) → pd.DataFrame         _normalization.py
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Arctic.__init__(uri)` `arctic.py` | 解析 URI、装配适配器与 LibraryManager | 惰性初始化，适配器首访时构造 |
| `Library.write/read/append/update` `library.py` | V2 用户 API，参数校验后委托 NativeVersionStore | `prune_previous_versions`（复数，V2）vs V1 单数 |
| `NativeVersionStore.write` `_store.py` | 归一化后调 C++ | `pickle_on_failure` 兜底：归一化失败时用 MsgPack 序列化 |
| `normalize(data)` `_normalization.py` | DataFrame → PandasData + NormalizationMetadata | 按类型分发到各 Normalizer，零拷贝传 numpy 数组 |
| `denormalize(frame)` `_normalization.py` | OutputFrame → 用户格式 | 按 `OutputFormat`（PANDAS/PYARROW/POLARS）还原 |

## 核心实现

### Arctic 与 Library 适配器分发

`Arctic` 类（`arctic.py`）的 `_LIBRARY_ADAPTERS` 是一个有序列表，`__init__` 用 `supports_uri(uri)` 线性匹配第一个支持的适配器。每个适配器（`adapters/arctic_library_adapter.py` 的 `ArcticLibraryAdapter` 基类）负责：URI 解析（`ParsedQuery` dataclass）、构造 protobuf `Storage` 配置、`config_library`/`add_library`/`get_library`/`list_libraries`。例如 `S3LibraryAdapter` 解析 `s3://endpoint:bucket?region=...&access=...&secret=...`，`AzureLibraryAdapter` 解析分号分隔的 `azure://Container=c;AccountName=a;AccountKey=k`。这种"URI scheme → 适配器 → protobuf → C++ 后端"的链路让新后端接入只需加一个适配器类 + 注册到列表（见扩展方式）。

### V1/V2 API 双层与归一化

`Library`（V2，推荐）包装 `NativeVersionStore`（V1，C++ 直连）。`Library` 的 `read()` 支持 `as_of` 为版本号/时间戳/快照名/负索引，而 V1 只接受版本号——V2 在 Python 侧把这些形式归一化成 C++ 的 `VersionQuery` variant。归一化的核心是 `NormalizedInput` 命名元组（`item` = `PandasData`，`metadata` = `NormalizationMetadata` protobuf）。`PandasData` 是 pybind 绑定结构，持有列名/索引名与 numpy 数组的引用——**数值列尽量零拷贝**（`py::array_t` 包 C++ buffer），字符串列需编码成 UTF-8 字节存入 `StringPool`。类型映射遵循 pandas dtype：`int64`→`INT64`、`datetime64[ns]`→`NANOSECONDS_UTC64`、`object`(字符串)→`UTF_DYNAMIC64`、`category`→底层类型 + 字典。混合 int/float 列自动提升为 `FLOAT64`（为支持 NaN）。

### 多输出格式与 Arrow/Polars

`OutputFormat` 枚举控制读返回类型：`PANDAS`（默认）、`PYARROW`、`POLARS`。pyarrow/polars 写入都经 `ArrowTableNormalizer`（polars 先 `.to_arrow()` 转 pa.Table 再归一化），把表转成 record batch 向量给 C++。读取时 polars 输出有个细节：polars 只支持 `large_string`（64-bit offset），所以指定 `pa.string()` 的字符串格式选项会自动提升为 `pa.large_string()`。`update()` 带 `date_range` 时用 `restrict_data_to_date_range_only` 裁剪输入——pyarrow 路径用二分搜索 + `pa.Table.slice`（零拷贝），原生 polars filter 因要物化布尔掩码被实测更慢故不走。`ReadResult` 还携带 `sort_order`（`SortedValue` 枚举），polars 输出时调 `set_sorted()` 让索引列跳过排序检查。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 适配器模式 | `adapters/*_library_adapter.py` | 把异构 URI 协议统一成 protobuf Storage 配置 |
| 外观模式 | `Library` 包装 `NativeVersionStore` | V2 给用户干净 API，V1 保留给高级/迁移场景 |
| 策略分发 | `Normalizer` 子类按 Python 类型分发 | pandas/Series/ndarray/arrow/polars/MsgPack 各自处理 |
| 建造者 | `LibraryOptions` 配置 `dynamic_schema`/`dedup`/`encoding_version` | 分离库创建参数与运行时配置 |

## 模块间交互

Python API 层向下只依赖 C++ 的 `arcticdb_ext`（pybind11 模块，见 [Python 绑定模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/10-python-bindings)）。`NativeVersionStore._library` 是 `PythonVersionStore` 实例，它的 `write()`/`read()` 接受 `InputTensorFrame`/`OutputTensorFrame`——这是跨越 Python↔C++ 边界的核心数据结构（见 [Python 绑定](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/10-python-bindings)）。归一化产出的 `NormalizationMetadata` 随数据一起落盘，读回时由 C++ 透传给 Python 侧 `denormalize` 还原原始结构。适配器层与 [存储后端模块](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage) 是一一对应的：每个 Python 适配器对应一个 C++ `Storage` 子类。

## 扩展方式

新增自定义存储适配器：1) 定义 `ParsedQuery` dataclass 承载 URI 参数；2) 实现 `ArcticLibraryAdapter` 子类（`supports_uri`/`__init__`/`config_library`）；3) 加入 `arctic.py` 的 `_LIBRARY_ADAPTERS` 列表；4) 确保 C++ 侧有对应 `Storage` 子类与 `storage_factory.cpp` 分支（见 [存储后端](/vibe-reading/articles/Database/DataFrame/ArcticDB/CodeWiki/6.23.0/07-storage)）。自定义归一化（如存非 DataFrame 对象）：继承 `Normalizer` 基类实现 `normalize`/`denormalize`，但注意公共 API 未直接暴露注册接口，MsgPack 兜底已覆盖大多数任意对象。
