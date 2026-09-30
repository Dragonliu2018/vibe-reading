---
source:
  type: "源码解读"
  project: "SeekDB"
  url: "https://github.com/oceanbase/seekdb"
title: "库内 AI 函数"
date: "2026-09-29T22:10:29+08:00"
category: [Database, VectorSearch, SeekDB, CodeWiki, "1.4.0"]
contentType: "CodeWiki"
tags: ["SeekDB", "RAG", "SQL 函数", "libcurl", "AI 数据库"]
description: "AI_EMBED/RERANK/COMPLETE/PROMPT 四函数族、CREATE AI MODEL 与加密 endpoint 内部表、libcurl 客户端与 8 家 provider 适配、语义索引自动 embedding 与『库内编排、库外执行』"
readingTime: "30 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/00-overview)

---

## 模块定位

seekdb 把 embedding、rerank、LLM 补全做成 **SQL 表达式**（`src/sql/engine/expr/ob_expr_ai/`，4 个表达式 + 3 个工具文件），把模型配置做成 **schema 级 DDL 对象**（`CREATE AI MODEL`，`src/share/ai_service/` + `src/observer/ai_service/`）。设计姿态是「库内编排、库外执行」：seekdb 是 HTTP 客户端，推理发生在 OpenAI/Ollama/DashScope 等外部服务。为什么做成表达式而不是存储过程或外部函数？因为表达式可组合——`AI_PROMPT → AI_COMPLETE` 在一条 SQL 内管道化，RAG 全流程（embed → 向量检索 → rerank → 补全）一个查询完成，且权限进 SQL 体系（`ACCESS AI MODEL` 是标准权限项，外部函数做不到）；同时 DDL 可直接引用模型名（语义索引的 endpoint 参数），模型配置与数据绑定。

## 模块架构

```shell
src/sql/engine/expr/ob_expr_ai/
├── ob_expr_ai_embed / rerank / complete / prompt.{h,cpp}   # 4 个 ObFuncExprOperator
├── ob_ai_func.h            # 类层次: ObAIFuncBase → IComplete/IEmbed/IRerank + ObAIFuncHandle
├── ob_ai_func_client.{h,cpp}# ObAIFuncClient: libcurl easy/multi 双形态 HTTP 客户端
└── ob_ai_func_utils.{h,cpp} # ObAIFuncModel 门面 + ObAIFuncJsonUtils + 8 家 provider 适配

src/share/ai_service/       # 跨层元数据: EndpointType 枚举 + ObAiModelEndpointInfo（api_key 加密）
src/observer/ai_service/    # 执行层: ObAiServiceProxy（内部表 CRUD）+ ObAiServiceExecutor（DDL 语义）
src/observer/omt/ob_ai_service.{h,cpp}   # ObAiService server module + ObAiServiceGuard（权限/缓存）
```

| SQL 函数 | 表达式类 / item type | 参数 | 返回 |
| --- | --- | --- | --- |
| `AI_EMBED(model, content[, dim])` | `ObExprAIEmbed` / `T_FUN_SYS_AI_EMBED` | model、content VARCHAR，dim 正整数（`calc_result_typeN` 强制整型） | VARCHAR——embedding 的 JSON 文本 |
| `AI_RERANK(model, query, docs[, doc_key])` | `ObExprAIRerank` / `T_FUN_SYS_AI_RERANK` | docs JSON 数组；doc_key 指定时元素须 J_OBJECT | JSON：`[{index,score}]` 降序；带 doc_key 时原对象重排并附 `model_score` |
| `AI_COMPLETE(model, prompt[, config])` | `ObExprAIComplete` / `T_FUN_SYS_AI_COMPLETE` | prompt 可为字符串或 AI_PROMPT 的 JSON | LONGTEXT |
| `AI_PROMPT(template[, args...])` | `ObExprAIPrompt` / `T_FUN_SYS_AI_PROMPT` | 模板 + 任意字符串参数（JSON 参数显式不支持） | `{"template":...,"args":[...]}`，**纯本地渲染不发 HTTP** |

四个函数均声明 `NOT_VALID_FOR_GENERATED_COL`——禁止生成列，堵住「DML 隐式触发 HTTP 外呼」。

## 调用链路

以 `eval_ai_embed`（`ob_expr_ai_embed.cpp:78`）为代表的求值链：

```
SQL 算子向量化求值 → eval_ai_embed
├─ expr.eval_param_value(ctx, arg_model_id, arg_content[, arg_dim])
├─ ObEvalCtx::TempAllocGuard + ObMallocHookAttrGuard     # ★ HTTP 收发全部走 eval 级临时内存，eval 结束即回收
├─ ObAIFuncUtils::get_ai_func_info(allocator, model_id, info)   # 现场解析 ObAIFuncExprInfo
├─ server_service<query::ObIAiEndpointResolver>()       # 服务定位器
│    → resolve_by_model_name(model_id, ..., resolved_endpoint) # → ObAiModelEndpointInfo
├─ ObAIFuncModel model(temp_alloc, *info, *endpoint_info)       # 门面对象
│    └─ call_dense_embedding(content, config, result)
│         ├─ get_embed_provider() → ObOpenAIUtils/ObOllamaUtils/...（按 provider 字符串）
│         ├─ get_header()（api_key 从 endpoint 解密）→ get_body()（JSON 树构造请求体）
│         ├─ ObAIFuncClient::send_post（curl_easy 同步 POST）
│         └─ parse_embed_output()（兼容 base64 向量与 float 数组两种响应格式）
└─ ObAIFuncUtils::set_string_result(expr, ctx, res, result)
```

**rerank 的批处理**（`ob_expr_ai_rerank.cpp:100-210`）：`batch_size = 20`（"max batch size"）——**一个批是 20 个文档合并进一个 HTTP 请求体**（query + documents 一次 POST），批与批之间是顺序同步 for 循环；每批 `construct_batch_document_array → inner_eval_ai_rerank → batch_result_add_base`（批内 index 加回全局偏移）→ `compact_json_array_by_key`（按 SCORE_KEY 对两个已排序数组归并）。doc_key 分支（`eval_ai_rerank_with_doc_key`，:220）抽取各对象 key 字段 → `call_rerank` → `sort_document_array_by_model_result` 按模型序重排**原 doc 对象**并注入 `model_score`。注意粒度：表达式框架逐行调 eval，即 `SELECT AI_EMBED(...) FROM t` 是**每行一次独立 HTTP 调用**——批量接口（`call_dense_embedding_vector_v2` + `send_post_batch` curl multi）已就位但表达式路径未启用（朝异步演进的预留）。

## 核心实现

### ObAIFuncClient：libcurl 双形态 + 超时封顶

单请求 `curl_easy_*` 同步阻塞；批量 `curl_multi_*`（`send_post_batch`：N 个 easy handle 挂 `curlm_`，`curl_multi_wait(1000ms)` 轮询至 `running_handles == 0`）；另有 `send_post_batch_no_wait/check_batch_finished/get_batch_result` 异步轮询接口（头文件注释标注 "embedding service interface"，v1.4.0 无调用方——后台 embedding 服务的预留）。同步 HTTP 的保护机制是**超时封顶**而非线程池隔离：

1. HTTP 超时继承 `THIS_WORKER` 剩余超时（`ob_ai_func_client.cpp:80-92`）——**语句的 query_timeout 同时就是 AI 外呼上限**，AI 慢不会让 SQL 超出用户预算；`abs_timeout_ts_` 绝对截止 + 重试循环逐轮检查 → `OB_TIMEOUT`；
2. 连接超时硬编码 10s；重试默认 3 次、指数退避 `1000×(1<<i) + rand()%1000` ms、只认 429/500/502/503/504（`is_retryable_status_code()`，:501）；
3. 非 2xx 经 `FORWARD_USER_ERROR` 把 HTTP 状态码与响应体透传成 SQL 错误；`TempAllocGuard` 保证响应不侵蚀算子内存。

请求体不是字符串拼接而是 OceanBase 自带 JSON 树（各 provider 的 `get_body()` 用 `ObJsonObject/ObJsonArray` 构造，`init_easy_handle()` 里 `body->print()` 后 `CURLOPT_POSTFIELDS` 发出）。

### 模型配置：三层结构与现场解析

```
语法: CREATE/ALTER/DROP AI MODEL（sql_parser_mysql_mode.y:14137-14152，AI 是保留字；权限项 OB_PRIV_*_AI_MODEL）
存储: 内部表 __all_ai_model_endpoint（OB_ALL_AI_MODEL_ENDPOINT_TNAME）
       ObAiServiceProxy 的 SQL CRUD（SELECT * FROM ... WHERE endpoint_name = ...）
定义: ObAiModelEndpointInfo（share/ai_service/ob_ai_service_struct.h:32）
       name_/scope_/endpoint_id_/url_/access_key_(密文)/provider_/request_model_name_/
       parameters_/request_transform_fn_/response_transform_fn_
       （后两者允许 endpoint 配 JSON 变换函数自定义请求/响应映射）
类型: EndpointType 枚举 {DENSE_EMBEDDING=1, SPARSE_EMBEDDING=2, COMPLETION=3, RERANK=4}
       （share/ai_service/ob_ai_model_info.h:35，注释要求新增类型同步 ENDPOINT_TYPE_STR）
```

api_key 落库为密文（`encrypt_access_key_`），使用时经 `get_unencrypted_access_key()` 解密；ALTER 走 `merge_delta_endpoint()` 增量合并 + 版本行乐观锁（`SPECIAL_ENDPOINT_ID_FOR_VERSION`/`lock_and_fetch_endpoint_version`）。**运行时解析是每次 eval 现场查**：`cg_expr()` 里把「code generation 时预解析进 plan cache」的代码整段注释（`ob_expr_ai_rerank.cpp:493-525` 的 TODO "support schema version match in plan cache for ai func"）——模型配置可变，宁可每执行一次现场解析，也不让 plan cache 携带过期配置。权限执行点在 `omt::ObAiServiceGuard::check_access_privilege()`（`ACCESS AI MODEL` 授权）；`ObAiService` 以 server module 形式在 `ob_server.cpp` 启动注册（`mods_ai_service_`），ob_server.cpp:293-308 直接转发 create/alter/drop 到 `ObAiServiceExecutor`。

### provider 族与语义索引的接线

`ObAIFuncProviderUtils` 常量列出 **8 家服务商**（`ob_ai_func_utils.h:266-273`）：`OPENAI / OLLAMA / ALIYUN-OPENAI / ALIYUN-DASHSCOPE / SILICONFLOW / COHERE / HUNYUAN-OPENAI / DEEPSEEK`。抽象接口 `ObAIFuncIComplete/IEmbed/IRerank` 各定义 `get_header() + get_body() + parse_output()` 三虚函数——**新服务商 = 实现三个虚函数**，传输层（`ObAIFuncClient`）完全不动。组合范式：`AI_PROMPT` 产出模板化 prompt object → 作为 `AI_COMPLETE` 的 prompt 参数 → provider 层展开为 messages（`ObOpenAIComplete::construct_messages_array`、`ObDashscopeComplete::construct_input_obj`）。

**语义索引自动 embedding** 的接线在 `observer/vector_index/ob_vector_index_util.cpp`（`ObAIFuncModel` 在 expr_ai 目录外的唯一命中）：hybrid vector index 的 DDL 携带 `endpoint` 参数 + dim + hnsw（:3445 校验组合），后台 `ObHybridVectorRefreshTask` 经 `omt::ObAiServiceGuard` 取 endpoint 调 `call_dense_embedding`；查询侧（:748-771）同样经门面把查询文本实时转向量——**索引与查询文本 embed 共用同一个 `ObAIFuncModel` 门面**，而非调用表达式类本身。`ob_expr_semantic_distance.cpp`（160 行）的两个类分工：`ObExprSemanticDistance`（"only used for parser"——`calc_semantic_distance` 直接返回 `OB_NOT_SUPPORTED`）是语法锚点，求值前被改写（`sql/rewrite/ob_transform_pre_process.cpp`）；`ObExprSemanticVectorDistance` 是真正执行者，委托 `ObExprVectorDistance::calc_distance` 按 `ObVecDisType` 算 L2/cosine/IP/L1。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 策略（provider 适配） | `ObAIFuncBase` 三接口 × 8 家 provider | 传输与编排集中稳定，多态扩展发生在 provider 层——graphify 中 `ObAIFuncClient(34)`/`get_header(17)`/`send_post(14)` 高扇出的原因 |
| 门面 | `ObAIFuncModel::call_completion/call_dense_embedding/call_rerank` | 串联 header→body→send→parse 的唯一入口，SQL 表达式与语义索引两处复用 |
| 现场解析（反 plan cache） | eval 期 resolver 调用 | 模型配置可变性与计划缓存矛盾——牺牲一次 schema 查询换正确性 |
| RAII 内存域 | `TempAllocGuard` + `ObMallocHookAttrGuard` | HTTP 大响应不进长生命周期内存 |

## 模块间交互

向上经 `REG_OP`（`ob_expr_operator_factory.cpp:1048` 一带）注册进表达式工厂、经 `REG_EXTRA_INFO`（`ob_expr_extra_info_factory.cpp:110-112`）挂 `ObAIFuncExprInfo` 序列化；向 share/ai_service 依赖元数据定义、向 observer/ai_service 依赖 DDL 执行与内部表 CRUD；经 `server_service<query::ObIAiEndpointResolver>()` 被 SQL 层解耦取用（接口定义在 `query/api/query/ai/`）。被[向量索引体系](/vibe-reading/articles/Database/VectorSearch/SeekDB/CodeWiki/1.4.0/05-vector-index)的 hybrid refresh 任务消费（自动 embedding）；`AI_COMPLETE` 的 prompt 通道与 `hybrid_search/` 的 JSON DSL 正交。

## 扩展方式

新增 `AI_SUMMARIZE`：① 新建 `ob_expr_ai/ob_expr_ai_summarize.{h,cpp}`（仿 `ObExprAIRerank` 三件套）；② item type `T_FUN_SYS_AI_SUMMARIZE` + 名字宏 `N_AI_SUMMARIZE`；③ `REG_OP` 注册（有运行时元数据再加 `REG_EXTRA_INFO`）；④ 需要新 EndpointType 则改 `ob_ai_model_info.h` 枚举 + `ENDPOINT_TYPE_STR`；⑤ `ObAIFuncUtils` 加 body/parse + 各 provider 实现。对接新模型服务商（provider 是 endpoint 元数据的字符串字段，DDL/存储层零改动）：① `ob_ai_func_utils.h:266-273` 加常量；② 新建 `ObXUtils` 实现三接口虚函数；③ `get_embed/complete/rerank_provider` 加分派 case；④ 用户 `CREATE AI MODEL ... PROVIDER X` 即可。
