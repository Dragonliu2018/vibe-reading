---
source:
  type: "源码解读"
  project: "Apache IoTDB"
  url: "https://github.com/apache/iotdb"
title: "AINode 推理节点"
date: "2026-10-01T21:20:00+08:00"
category: [Database, TSDB, Apache IoTDB, CodeWiki, "2.0.10"]
contentType: "CodeWiki"
tags: ["IoTDB", "Python", "时序数据库", "AI 推理", "HuggingFace", "时序模型"]
description: "第三个节点角色：纯 Python 推理进程——14 个内置时序模型（sktime 统计 + HuggingFace 深度）、多进程推理池与连续批处理、PyInstaller 免环境发行。"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/TSDB/Apache-IoTDB/CodeWiki/2.0.10/00-overview)

---

## 模块定位

AINode（`iotdb-core/ainode`，~2.3 万行 Python）是 IoTDB 2.x 引入的**第三个节点角色**——纯 Python 实现的时序 AI 推理服务进程，负责模型管理与模型推理两件事。IDL 有 `createTuningTask`（TTuningReq），但 handler 是 `pass`——训练/调优是预留槽位，没有 AIAgent 能力。心跳用 psutil 上报 CPU/内存/磁盘供 ConfigNode 的 `AsyncAINodeHeartbeatClientPool` 探活。

**为什么独立 Python 进程而不是嵌入 JVM**（代码佐证的推断）：①依赖栈隔离——torch/huggingface_hub/transformers 的 ABI 与版本管理不可能进 JVM；②崩溃隔离——模型推理的 OOM、CUDA fault 不能拖垮 DataNode 查询进程；③GIL 规避——多进程池 + 连续批处理是 Python 侧提吞吐的唯一路径；④复用 HF 生态——`auto_map`/`snapshot_download` 直接对接 HuggingFace 模型分发。`build_binary.py` 用 **PyInstaller 按 ainode.spec 打成免 Python 环境的可执行文件**，支持按加速器变体安装 torch——发行包用户无需自装 Python。

## 模块架构

![AINode 架构](/vibe-reading/images/articles/iotdb-2.0.10/ainode-architecture.svg)

`core/ai_node.py` 的 `AINode.start()`：创建 system 目录 → 判断 `system.properties`（首启 `node_register()` 注册到 ConfigNode 的 `ain_seed_config_node`（10710），重启 `node_restart()`）→ 构造 `AINodeRPCServiceHandler`（内部惰性单例 ModelManager/InferenceManager/DeviceManager）→ thrift `TThreadPoolServer` 绑定 **ain_rpc_port = 10810**（支持 SSL 与 compact 协议）→ 注册 SIGTERM/SIGINT graceful stop。

节点注册在 ConfigNode（`NodeManager` 的 RegisterAINodePlan，走 raft），但**模型注册不在 ConfigNode 的表里**——而在 AINode 本地文件系统：`ModelStorage`（`model/model_storage.py`）扫描 `ain_models_dir` 的 `builtin/` 与 `user_defined/` 两级目录，`ModelLockPool` 读写锁保护。ConfigNode 侧只有 `CreateModelState/DropModelState` procedure 状态机管理模型生命周期。

内置模型两层（`model/model_info.py`）：**8 个 sktime 统计模型**（arima、holtwinters、exponential_smoothing、naive_forecaster、stl_forecaster、gaussian_hmm、gmm_hmm、stray）状态 ACTIVE 无需权重；**6 个 HuggingFace 深度模型**状态 INACTIVE（权重默认不打包）：timer_xl、sundial、**chronos2（amazon/chronos-2）、moirai2（Salesforce/moirai-2.0-R-small）、toto（Datadog/Toto-Open-Base-1.0）**（v2.0.10 新增 Moirai2 和 Toto）、moment。每个 ModelInfo 带 `pipeline_cls` 和 `auto_map`，模型实现代码 vendored 在 `core/model/<name>/` 下。

## 调用链路

一条 forecast 请求：thrift `forecast()`（handler.py:150）→ `InferenceManager.forecast()`（inference_manager.py:267）→ `convert_tsblock_to_tensor()`（serde.py，TsBlock 二进制 ↔ tensor）→ `_do_inference_and_construct_resp()`：**有运行中池**则 InferenceRequest 入队 → `PoolController.add_request()` → `InferenceRequestPool`（**torch.multiprocessing.Process**）→ `BasicRequestScheduler` + `BasicBatcher` 按 (target_count, input_length, output_length) 分组**连续批处理** → 结果经 mp.Queue → `_handle_results()` 线程 → `set_result()` 唤醒等待；**无池**（未 LOAD 的模型）则每次请求在 CPU 上临时 `load_pipeline()` 就地推理。pipeline 三段式模板方法：preprocess → forecast/classify/chat → postprocess（`inference/pipeline/basic_pipeline.py`，ForecastPipeline/ClassificationPipeline/ChatPipeline 均继承 BasicPipeline）→ `convert_tensor_to_tsblock(output.to(float64))` 序列化回 TsBlock。

**只有执行过 `LOAD MODEL ... TO DEVICES` 的模型才走多进程池 + 连续批处理**；输出统一转 DOUBLE 是因为 DataNode 侧把推理输出暴露为 DOUBLE 列（代码注释明确）。`PoolController.first_req_init()` 的自动扩缩池逻辑整段被注释（"Automatic Pool Management (Developing)"）——目前扩缩容完全由用户 SQL 驱动。

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `AINode.start()`（ai_node.py） | 启动注册 + RPC | system.properties 判首启/重启 |
| `handler.forecast()`（:150） | 推理入口 | 池化/临时加载双路径 |
| `ModelStorage.register_model(model_id, uri)` | 模型注册 | URI 分 REPO/FILE 两类 |
| `_fetch_model_from_hf_repo()` | 权重下载 | snapshot_download 整仓，2 线程异步 |
| `PoolController.add_request()` | 请求入池 | 按 (model, device) 维度建池 |
| `BasicBatcher` | 连续批处理 | 按形状分组 |
| `load_pipeline()`（pipeline_loader.py） | pipeline 加载 | builtin 走包 import，用户模型走动态 sys.path |
</details>

## 核心实现

### 与 SQL 的集成

树模型语法（IoTDBSqlParser.g4 747-808 行）：`CREATE MODEL modelId uriClause`、`CALL INFERENCE(modelId, inputSql, hparam...)` → DataNode 的 `InferenceOperator`（`queryengine/execution/operator/process/ai/`）经 `AINodeClientManager` 借 AINodeClient 发 `TInferenceReq`；`LOAD MODEL existingModelId TO DEVICES '...'` / `UNLOAD MODEL`；`SHOW MODELS / SHOW LOADED MODELS / SHOW AI_DEVICES`；`DROP MODEL`（内置模型禁删，`BuiltInModelDeletionException`）。表模型把 **FORECAST 做成 table-valued function**（`StatementAnalyzer` 的 `TableBuiltinTableFunction.FORECAST`，强制 ORDER BY time ASC），经 `DataNodeTableFunctionAINodeService.forecast()` 转发 `TForecastReq`（outputLength、historyCovs/futureCovs、options）。

### 模型注册与加载

`registerModel` → `ModelStorage.register_model(model_id, uri)`：URI 分 REPO（huggingface repo id）和 FILE（本地路径）；`_fetch_model_from_hf_repo()` 用 `snapshot_download` 整仓下载，`validate_model_files()` 校验 model.safetensors + config.json；下载用 `ThreadPoolExecutor(max_workers=2)` 异步。`loadModel/unloadModel` 面向设备：TLoadModelReq 的 deviceIdList 转 `torch.device` 后交给 `PoolController` 按 (model, device) 维度异步建/拆推理池。`util/huggingface_cache.py` 是 vendored 的 transformers KV-Cache（DynamicCache）——用于推理而非下载缓存。

### 进程边界的统一货币

数据序列化用 thrift `binary` 字段传 TsBlock 字节流（`util/serde.py`），保持与 JVM 侧 TsBlock 表示兼容——**进程边界上的统一货币是 tensor 的 DOUBLE 序列化**。`output_length` 上限由 `ain_inference_max_output_length`（默认 96）校验。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 | thrift Handler + 四个 Manager 单例 | RPC 层零业务 |
| 模板方法 | `BasicPipeline` 三段式 | 推理形态复用骨架 |
| 插件注册表 | ModelInfo 的 `pipeline_cls` 字符串 + `load_pipeline()` 分派 | 新模型零 handler 改动 |
| 对象池 | PoolController 的推理进程池 | 加载昂贵，复用进程 |

## 模块间交互

与 DataNode 的交互全部经 `ainode.thrift`（InferenceOperator / FORECAST 表函数 / ClusterConfigTaskExecutor 转发管理语句）；与 ConfigNode 的交互是节点注册与心跳；部署上 Maven 经 exec 插件调 `build_binary.py`，`ainode.xml` 把 dist/ainode 装进发行包。

## 扩展方式

新增内置模型：`model_info.py` 的 `BUILTIN_HF_TRANSFORMERS_MODEL_MAP` 加 ModelInfo（model_id/model_type/pipeline_cls/repo_id/auto_map）→ `core/model/<newmodel>/` 下 vendored 写三件套（configuration_*.py / modeling_*.py / pipeline_*.py，参考 toto/）→ `load_pipeline()` 自动生效，无需改 handler。启用自动弹性池：补完 `pool_controller.py` 里被注释的 `first_req_init()/_expand_pools_on_device()`（上游标注 "Developing" 的半成品）。实现 createTuningTask：补 handler.py:178 的空实现——IDL、DataNode 的 tuning 分支、ConfigNode 的 CreateModelState procedure 槽位都已留好。

> ⚠️ 待核实：ConfigNode 侧模型注册的具体持久化表；多 AINode 时的 endpoint 选择策略；`ain_cluster_ingress_port=6667`（ingress/iotdb.py）的实际用法。
