---
source:
  type: "源码解读"
  project: "Helmsman"
  url: "https://github.com/Red-EAD/helmsman"
title: "基础设施层"
date: "2026-08-18T21:08:07+08:00"
category: ["AI", "Infra", "Retrieval", "Helmsman", "CodeWiki", "1.0"]
tags: ["Helmsman", "MiniHyperVec", "CollectionMeta", "PathConfig", "Dataset", "mmap"]
description: "Helmsman 基础设施层：类型枚举、CollectionMeta、PathConfig 路径约定、Dataset 模板 mmap 加载、GtReader、root.hpp god header。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Infra/Retrieval/Helmsman/CodeWiki/1.0/00-overview)

---

## 模块定位

基础设施层是 Helmsman 的全局底座——类型枚举、元数据序列化、路径约定、二进制文件 I/O、数据集加载。它被几乎所有上层模块依赖（`root.hpp` 被 11 个头文件 include，`collection_meta.hpp` 被 4 个模块 import），本身不包含业务逻辑，只提供"让上层能找到文件、读懂格式、加载进内存"的通用能力。

核心组件：`collection/types.hpp`（VecType/DisType/IndexType 枚举）、`CollectionMeta`（collection 元数据 JSON 序列化）、`PathConfig` + `release::constants`（路径约定）、`Dataset<T>`（mmap 数据集加载）、`GtReader`（ground truth 读写）、`root.hpp`（god header）。

---

## 模块架构

```text
root.hpp (god header: SPDK + TBB + hnswlib + json + ~30 STL)
  ↑ 被 11 个头文件 include
  │
types.hpp (VecType/DisType/IndexType) ← params.hpp (BuildParam 族依赖枚举)
  ↑                                        ↑
meta_path.hpp (PathConfig + release::constants)   collection_meta.hpp (CollectionMeta + IndexMeta)
  ↑                                                  ↑
files_rw.hpp (writeBinaryPOD/readBinaryPOD + 原子 fsync)
  ↑
dataset.hpp (Dataset<T> 模板, 4 特化)  groundtruth.hpp (GtReader)  benchmark.hpp (benchmark_param)
  ↑
test/multi_thread_search (Dataset<int8_t> + loadGroundTruth)
index/hyperconst_imp (Dataset<uint64_t/int32_t> 读 cluster_ids/norms)
runtime/env/minihypervec_env (PathConfig + NVMeMetaHandler)
```

---

## 调用链路

```text
PathConfig::getInstance()                     // meta_path.cpp:4-8 (Meyer 单例)
  → init(g_path_config)                       // g_path_config = "/mnt/service/minihyper-vec/setup/path_config.json"
    → util::read_file_to_string(path, content)
    → json::parse(content)
    → j.at("nvme_meta_path")   → pc->nvme_meta_path
    → j.at("release_index_path") → pc->release_index_path

release::constants::getCentroidsIndexPath("coll")        // meta_path.cpp:146-159
  → release_index_path + "coll" + "/" + "coll" + "_centroids_index.bin"
  → "/mnt/.../release_index/coll/coll_centroids_index.bin"

Dataset<int8_t>(query_path)                   // dataset.cpp:296
  → open_file_and_map(path)                   //   open + fstat + mmap + madvise(WILLNEED)
  → 探测 header: [uint64 num][uint32 dim] (12B) 或 [uint32 num][uint32 dim] (8B)
  → data_base_ = base + header_size
  → getDataBase() → 返回 mmap 区域指针

CollectionMeta::loadCollectionMeta(path, meta)          // collection_meta.cpp:126
  → read_file_to_string → json::parse → loadCollectionMetaFromJson
    → switch(index_type) → case HV_CONST: make_unique<MiniHyperVecConstBuildParam>()->from_json
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `PathConfig::getInstance` | 路径配置单例 | Meyer's singleton |
| `release::constants::getXxxPath` | 拼 collection 文件路径 | 三段式：`release_index_path/collection_name/collection_name_suffix` |
| `CollectionMeta::load/saveCollectionMeta` | 元数据 JSON 读写 | `ordered_json` 保字段顺序 + 原子 fsync |
| `Dataset<T>::open_file_and_map` | mmap 加载向量文件 | `madvise(WILLNEED/RANDOM)` 优化随机访问 |
| `Dataset<T>::getVecs` | 按 ID 取向量 | 从 mmap 区域拷贝 |
| `GtReader::getGroundTruth` | 读 ground truth | 自动探测 id stride (4/8 字节) |
| `persist_string_atomic_fsync` | 原子写文件 | tmp → fsync → rename → fsync(dir) |

</details>

---

## 核心实现

### 类型枚举与 IndexType

```cpp title="include/collection/types.hpp"
enum class VecType : uint32_t { UNKNOWN = 0, INT8 = 1 };
enum class DisType : uint32_t { UNKNOWN = 0, L2 = 1, IP = 2 };
enum class IndexType : uint32_t { UNKNOWN = 0, HNSW = 1, HV_CONST = 2 };
```

**为什么 `VecType` 只有 INT8**：int8 量化是 ANNS 最常见的压缩格式，内存缩 4 倍且可走 AVX int8 SIMD。float/int32 虽在 `Dataset<T>` 有特化，但用于内部数据（cluster_ids 的 uint64、cluster_norms 的 int32），不作用户向量类型。`IndexType` 只有 HNSW（纯内存）与 HV_CONST（NVMe 聚簇）——对应两条搜索路径。`DisType::L2` 的字符串形式是 `"Euclidean"`（`source/collection/types.cpp`），语义化命名便于 JSON 配置可读。

### CollectionMeta：元数据 JSON 序列化

```cpp title="include/collection/collection_meta.hpp"
struct IndexMeta
{
    IndexType index_type = IndexType::UNKNOWN;
    std::unique_ptr<index::BuildParam> build_param = nullptr;
    IndexMeta(const IndexMeta &o);  // 通过 build_param->clone() 深拷贝
};

struct CollectionMeta
{
    std::string collection_name;
    VecType vec_type = VecType::UNKNOWN;
    IndexMeta index_meta;
    static int32_t saveCollectionMeta(const std::string &path, const CollectionMeta &meta);
    static int32_t loadCollectionMeta(const std::string &path, CollectionMeta &meta);
};
```

`IndexMeta` 持 `unique_ptr<BuildParam>`，通过虚函数 `clone()` 实现多态深拷贝（`collection_meta.cpp:10-17`）。`loadCollectionMetaFromJson` 按 `index_type` switch 分派到具体 `BuildParam` 子类（当前仅处理 HV_CONST case）。序列化用 `nlohmann::ordered_json` 保字段顺序，`saveCollectionMeta` 经 `persist_string_atomic_fsync` 原子落盘。

### PathConfig + release::constants：三段式路径约定

```cpp title="include/meta_path.hpp"
inline static constexpr std::string_view g_path_config =
    "/mnt/service/minihyper-vec/setup/path_config.json";

struct PathConfig
{
    std::string nvme_meta_path = "";
    std::string release_index_path = "";
    static PathConfig *getInstance();
};

namespace release::constants
{
    inline constexpr std::string_view centroids_index_filename = "_centroids_index.bin";
    inline constexpr std::string_view cluster_ids_filename = "_cluster_ids.bin";
    inline constexpr std::string_view cluster_norms_filename = "_cluster_norms.bin";
    inline constexpr std::string_view rawdata_filename = "_rawdata.bin";
    inline constexpr std::string_view cluster_map_filename = "_cluster_map.bin";
    // ... 8 个 getXxxPath 函数
}
```

**三段式路径**：`release_index_path / collection_name / collection_name + filename_suffix`（如 `/mnt/.../release_index/my_coll/my_coll_centroids_index.bin`）。每 collection 独立目录避免命名冲突、便于按 collection 管理生命周期；文件名带 collection_name 前缀，即使复制到他处也能辨识归属。`getHardwareMetaPath` 例外（不带 collection_name）。文件名用 `inline constexpr std::string_view` 编译期常量，零运行开销、集中管理命名约定。`path_config.json` 把 `nvme_meta_path`（硬件绑定）与 `release_index_path`（业务数据）分离，允许两类数据部署在不同存储。

### Dataset<T>：mmap 数据集加载

```cpp title="include/util/file/dataset.hpp"
template <> class Dataset<int8_t>   // 同样有 float/uint64_t/int32_t 特化
{
public:
    std::string file_path;
    uint32_t dim = 0;
    uint64_t total_cnt = 0;
    explicit Dataset(const std::string &path);
    int8_t *getDataBase() const;     // 返回 mmap 区域数据指针
    int32_t getVecs(const std::vector<uint64_t> &ids, std::vector<int8_t> &out_vecs);
private:
    int32_t fd_ = -1;
    void *map_ = (void *)-1;
    const int8_t *data_base_ = nullptr;
};
```

`open_file_and_map`（`dataset.cpp:133`）用 `mmap` + `madvise(MADV_WILLNEED)` 零拷贝映射文件，自动探测两种 header 格式（12 字节 `[uint64 num][uint32 dim]` 或 8 字节 `[uint32 num][uint32 dim]`），校验 `header + num*dim*kElemSize == file_size`。`getDataBase()` 直接返回 mmap 指针，`getVecs` 按 ID 偏移拷贝——deploy 时 `HyperConstImp` 用 `Dataset<uint64_t>` 读 cluster_ids、`Dataset<int8_t>` 读 rawdata。

**为什么 4 种显式特化而非通用模板**：每种类型的 `kElemSize = sizeof(T)` 不同，header 校验的编译期计算必须特化。一套接口（dim/total_cnt/getDataBase/getVecs）覆盖四种二进制格式，调用方无需关心格式细节。`mmap` 而非 `read` 是因为向量文件大（GB 级），零拷贝 + 内核按需分页比全量读快。

### GtReader：ground truth 读写

```cpp title="include/util/file/groundtruth.hpp"
class GtReader
{
public:
    explicit GtReader(const std::string &path);
    uint32_t num_queries() const noexcept;   // nq_
    uint32_t k() const noexcept;             // k_
    bool ids_are_u64() const noexcept;       // ids_stride_ == 8
private:
    uint32_t nq_ = 0; uint32_t k_ = 0;
    size_t ids_off_ = 0; size_t dists_off_ = 0;
    uint64_t ids_stride_ = 0;                // 4 或 8 字节
};
```

`.gt` 文件布局：`[8B header: nq + k][ids 区域: nq*k*stride][dists 区域: nq*k*4B float]`。`parse_header_and_layout`（`groundtruth.cpp:121`）自动探测 id stride（4 字节 uint32 或 8 字节 uint64）——`ids_bytes = (file_size - 8) - nq*k*sizeof(float)`，`ids_stride = ids_bytes / (nq*k)` 必须是 4 或 8。兼容两种 id 宽度让 benchmark 工具适配不同数据集。

### root.hpp：god header

```cpp title="include/root.hpp"
#include <spdk/env.h>          // 7 个 spdk/ 头
#include <tbb/tbb.h>
#include <immintrin.h>         // AVX2/AVX512
// ~30 个 STL 头
#include "util/hnswlib/hnswlib.hpp"
#include "util/jsonlib/json.hpp"
```

`root.hpp` 汇总 SPDK/TBB/immintrin/hnswlib/json/STL 全部 include，被 11 个头文件引用。**利**：一行 `#include "root.hpp"` 搞定所有依赖，避免 include 顺序错误（SPDK/immintrin 有平台依赖）；**弊**：每个编译单元引入全部依赖，编译开销显著，修改 `root.hpp` 触发全量重编译。对高性能 ANNS 引擎这种"几乎所有源文件都要 SPDK+SIMD+STL"的项目，便利性胜过编译开销。

---

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 单例（Meyer's） | `PathConfig::getInstance`（`meta_path.cpp:4`） | 全局唯一路径配置 |
| 命名空间常量约定 | `release::constants`（`meta_path.hpp`） | `inline constexpr string_view` 编译期常量，集中管理文件名 |
| 模板显式特化 | `Dataset<T>` 4 特化（`dataset.hpp`） | 一套接口覆盖 4 种二进制格式，`kElemSize` 编译期确定 |
| 虚函数多态 + clone | `BuildParam::clone()`（`params.hpp:38`） | `IndexMeta` 深拷贝支持多态 `BuildParam` 子类 |
| 原子写入 | `persist_string_atomic_fsync`（`file_rw.cpp:47`） | tmp→fsync→rename→fsync(dir) 保证崩溃安全 |
| mmap 零拷贝 | `Dataset<T>::open_file_and_map`、`GtReader`（`dataset.cpp`/`groundtruth.cpp`） | 大文件零拷贝 + `madvise` 优化随机访问 |
| POD 二进制序列化 | `writeBinaryPOD/readBinaryPOD`（`hnswlib.hpp:162`） | 类型安全模板，HNSW 索引序列化 |

---

## 模块间交互

本层是全局高扇入底座，被所有上层依赖：

- **`root.hpp`** 被 `meta_path`/`types`/`dataset`/`groundtruth`/`files_rw`/`benchmark`/`nvme_meta`/`distance_cal`/`rank_cal`/`prune_tool`/`cuda_root` 共 11 个头文件 include。
- **`collection_meta.hpp`** 被 `runtime/cluster/cluster_extra`、`runtime/env/minihypervec_env`、`runtime/worker/offline_worker`、`index/index_abs` import。
- **`meta_path.hpp`** 被 `collection_meta`、`minihypervec_env`、`offline_worker` import。
- **`util/file/`** 被 `test/multi_thread_search`（`Dataset<int8_t>` + `loadGroundTruth`）、`index/hyperconst_imp`（`Dataset<uint64_t/int32_t>` 读 cluster_ids/norms）、`runtime/env`（`PathConfig`）调用。

依赖方向纯向下，不反向依赖任何业务层。

---

## 扩展方式

- **新增 VecType::FLOAT16**：`types.hpp` 加枚举 → `types.cpp` 加 string 映射 → `dataset.hpp/cpp` 加 `Dataset<float16_t>` 特化 → `distance_cal.hpp` 加 FP16 SIMD。影响面广（VecType 是全局枚举，JSON 序列化/benchmark 解析/index builder 都需适配）。
- **新增 IndexType（如 IVF）**：`types.hpp` 加枚举 → `params.hpp` 加 `IvfBuildParam`/`IvfSearchParam` → `collection_meta.cpp:loadCollectionMetaFromJson` switch 加 IVF case → `benchmark.cpp:parseSearchParamByIndexType` switch 加 IVF。
- **改 release 文件名约定**：改 `release::constants` 的 `constexpr string_view`（如 `_index_meta.json` → `_index_meta_v2.json`），所有 `getXxxPath` 调用点自动生效（`hyperconst_imp.cpp` 约 15 处）。旧产物需迁移脚本。
