---
source:
  type: "源码解读"
  project: "trino"
  url: "https://github.com/trinodb/trino"
title: "元数据与类型系统"
date: "2026-09-29T22:21:30+08:00"
category: [Database, "Query Engine", Trino, CodeWiki, "483"]
contentType: "CodeWiki"
tags: ["Trino", "元数据", "类型系统", "函数解析"]
description: "Trino 483 Metadata 门面、FunctionResolver 函数绑定、TypeRegistry 类型注册表与 BlockEncoding 序列化"
readingTime: "20 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/00-overview)

---

## 模块定位

引擎与 catalog 世界之间的**门面层**：`Metadata` 接口（968 行、约 167 个方法）是全集群元数据统一入口，`MetadataManager` 聚合 N 个 catalog 的 `ConnectorMetadata`；函数体系（解析/注册/绑定）与类型注册表在这里；`BlockEncodingManager` 服务于跨节点序列化。调用方（analyzer/planner/operator）完全不感知 catalog 边界——**动态装卸连接器对它们不可见**，这就是门面存在的意义。

规模：`metadata/` 94 文件 + `type/` 72 文件，合计 ~27.7K 行。

## 模块架构

三个注册表（函数 `GlobalFunctionCatalog`、类型 `TypeRegistry`、block 编码 `BlockEncodingManager`）+ 一个门面（`MetadataManager`）+ 函数解析管线（`FunctionResolver`/`FunctionBinder`/`BuiltinFunctionResolver`）+ SQL 例程管理（`LanguageFunctionManager`——CREATE FUNCTION 的落点）。

## 调用链路

```
函数调用 f(x) 的解析（ExpressionAnalyzer.visitFunctionCall, ExpressionAnalyzer.java:1851）
 └─ FunctionResolver.resolveFunction(session, name, argTypes, accessControl) (:118)
     ├─ toPath：3 段名直用；1 段名沿 session.getPath() 展开搜索路径
     ├─ 逐路径 metadata.getFunctions(...) 收集候选
     │   （MetadataManager.getFunctions → ConnectorMetadata.getFunctions）
     └─ FunctionBinder.tryBindFunction (:77)
         ├─ 非 generic 签名精确匹配 → generic 精确匹配
         ├─ matchFunctionWithCoercion：每候选 SignatureBinder.bind(actualParameters)
         │   （推导 TypeVariable 绑定 + 允许隐式 coercion）收集 ApplicableFunction
         └─ selectMostSpecificFunctions 挑最具体
             多于 1 个 → AMBIGUOUS_FUNCTION_CALL（"Explicit type casts must be added"）
 └─ FunctionResolver.resolve → getFunctionDependencies → resolveFunctionBinding (:270)
     （递归解析 Cast/Operator/Function 依赖，类型变量代入 applyBoundVariables）
     → ResolvedFunction
 └─ analyzer 逐参 coerceType（内部 metadata.getCoercion）插入 cast

SELECT * FROM t 的找表（StatementAnalyzer.java:890）
 └─ metadata.getTableHandle(session, tableName)
     └─ MetadataManager.getTableHandle (:291)
         ├─ getOptionalCatalogMetadata → transactionManager.getOptionalCatalogMetadata
         │   （catalog 实例按事务绑定）
         ├─ catalogMetadata.getCatalogHandle(session, table, versions)
         └─ getMetadataFor(session, catalogHandle).getTableHandle(...)
             → TableHandle(CatalogHandle, ConnectorTableHandle, ConnectorTransactionHandle)
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计 |
| --- | --- | --- |
| `resolveFunction` in FunctionResolver.java:118 | 名字+参数类型 → ResolvedFunction | 搜索路径展开 + 权限过滤 |
| `tryBindFunction` in FunctionBinder.java:77 | 候选筛选与 coercion 仲裁 | 泛型签名 + 最具体优先 |
| `getCoercion` in Metadata 接口 | 隐式类型转换查询 | operator 一样走函数管线 |
| `getTableHandle` in MetadataManager.java:291 | 跨 catalog 找表 | 事务绑定 catalog 实例 |
| `addFunctions` in GlobalFunctionCatalog | 函数注册 | volatile FunctionMap copy-on-write 快照 |

</details>

## 核心实现

### ResolvedFunction：一次解析、全集群免二次解析

```java title="metadata/ResolvedFunction.java"
public record ResolvedFunction(BoundSignature signature, CatalogHandle catalogHandle,
        FunctionId functionId, FunctionKind functionKind, boolean deterministic,
        boolean neverFails, FunctionNullability functionNullability,
        Map<TypeDescriptor, Type> typeDependencies, Set<ResolvedFunction> functionDependencies)
```

重载选择（搜索路径、权限过滤、coercion 仲裁）全部集中在 coordinator 一次性完成；`ResolvedFunction` 携带 FunctionId + BoundSignature + **依赖闭包**（cast/operator/function），plan 序列化下发 worker 后免二次解析——同一查询在全集群语义确定。worker 侧只做 specialization：`FunctionManager.getScalarFunctionImplementation(resolvedFunction, invocationConvention)`（FunctionManager.java:106，specializedScalarCache 1000 条/1h）按 catalogHandle 路由 FunctionProvider，产出 `ScalarFunctionImplementation`（核心是 MethodHandle + instanceFactory + lambdaInterfaces）交给字节码生成。

### 函数从哪来：两条注册路

引擎自带：`metadata/SystemFunctionBundle.java`（window/aggregate/scalar 三段 builder）经 `ServerMainModule.RegisterFunctionBundles`（ServerMainModule.java:510）聚合 `Set<FunctionBundle>` 注入 `globalFunctionCatalog.addFunctions`。插件：`PluginManager.installPlugin`（PluginManager.java:241-246）拿 `plugin.getFunctions()` 交给 `InternalFunctionBundle.builder().functions(class)` 按注解分派解析。`addFunctions` 查重：FunctionId 全局唯一 + 同名同 signature 拒绝；`checkNotSpecializedTypeOperator` 禁止第三方覆盖 `EQUAL`/`XX_HASH_64` 等泛型类型操作符。

### TypeRegistry 与类型操作符

`metadata/TypeRegistry.java` 构造器注册 27 种固定类型（`addType(BIGINT)`…）+ 12 种参数化类型（`addParametricType(VarcharParametricType.VARCHAR)`…）；`getType(TypeDescriptor)` 未命中时 `instantiateParametricType` → `parametricType.createType(typeManager, signature.getParameters())` 并缓存（1000 条 NonEvictableCache）。`type/` 包主体是各类型 operators（`BigintOperators`/`IpAddressOperators`——`@ScalarOperator` 注解的 EQUAL/CAST 等实现）与 `TypeCoercion`（类型转换规则中心）。`resolveOperator` 把操作符 mangle 成 `$operator$ADD` 这类函数名复用同一解析管线。

### BlockEncodingManager：exchange 的序列化注册表

98 行的构造期注册 13 种内置编码（VariableWidth/ByteArray/ShortArray/IntArray/LongArray/Fixed12/Int128Array/Variant/Dictionary/Array/Map/Row/RunLength，整型编码按 `SimdSupport` 探测结果启用压缩）。`blockEncodingsByName`（反序列化）与 `blockEncodingNamesByBlockClass`（序列化）双向表，配合 `InternalBlockEncodingSerde` 服务于 exchange 的 Page 跨节点传输——**编码名自描述**：两端按名取编码即可还原 Block，新 Block 类型/编码演进不破坏协议，且允许不同 CPU 能力的 worker 用不同 SIMD 压缩参数。

### LanguageFunctionManager：SQL 写的函数

`CREATE FUNCTION` 的函数体是 SQL：`LanguageFunctionManager.analyzeAndPlan`（metadata/LanguageFunctionManager.java:195）把定义体经 `sql/routine/` 的 `SqlRoutineAnalyzer`→`SqlRoutinePlanner`→`IrRoutine` 编译（`SqlRoutineCompiler.compile` 产出 `SpecializedSqlScalarFunction`）；函数定义本身存进 connector（`MetadataManager.createLanguageFunction` → `ConnectorMetadata.createLanguageFunction`）。worker 侧对应 `WorkerLanguageFunctionProvider`。

### CatalogManager 的真实状态

`metadata/CatalogManager.java`（81 行接口）实现在 `connector/CoordinatorDynamicCatalogManager.java`：`activeCatalogs`（CatalogName→Catalog）与 `allCatalogs`（CatalogHandle→RegisteredCatalog，含已卸载句柄）两张 map；`CatalogStatus` 枚举只有 **OPERATIONAL/FAILING** 两态（"可 drop"语义由 `getReachableDynamicCatalogs` 单独表达——不是 active/inactive）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 门面 | `Metadata` + `MetadataManager` | 调用方与 catalog 动态装卸解耦 |
| 注册表 ×3 | GlobalFunctionCatalog / TypeRegistry / BlockEncodingManager | 启动期写入、运行期只读+缓存 |
| copy-on-write | GlobalFunctionCatalog 的 volatile FunctionMap | 函数注册不阻塞解析读 |
| Guice 多绑定 | `RegisterFunctionBundles` 聚合 Set<FunctionBundle> | 函数包分散在各模块、集中注册 |

## 模块间交互

- **analyzer**：`StatementAnalyzer.java:890` 的 `getTableHandle`、`ExpressionAnalyzer.java:1851` 的 `resolveFunction`（见[SQL 解析与分析](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/01-sql-parser-analyzer)）；
- **planner**：`EffectivePredicateExtractor.java:269` 的 `getTableProperties`、`PlanFragmenter.java:364` 取分区信息（见[查询规划与优化器](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/02-planner-optimizer)）；
- **代码生成**：`sql/gen/BytecodeGeneratorContext.java:119` 的 `functionManager.getScalarFunctionImplementation`（见[执行计划落地与代码生成](/vibe-reading/articles/Database/Query-Engine/Trino/CodeWiki/483/05-local-execution-gen)）；
- **查询级生命周期**：`MetadataManager` 持 `ConcurrentMap<QueryId, QueryCatalogs>`——首次触碰某 catalog 时 `registerCatalogForQuery` → `ConnectorMetadata.beginQuery`，查询结束 `cleanupQuery` 反向清理。

## 扩展方式

**新增 builtin 类型**：`io.trino.type.XxxType`（impl `Type` 或继承 `AbstractVariableWidthType`）→ `TypeRegistry.java` 构造器 `addType(XXX)`（parametric 则 `addParametricType` + `type/XxxParametricType.java`）→ `type/XxxOperators.java` 用 `@ScalarOperator` 写 EQUAL/CAST 并加进 `SystemFunctionBundle.create` 的 `.scalars(...)`。

**新增 builtin 函数**：`io.trino.operator.scalar.XxxFunctions` 类 + `@ScalarFunction` 方法 → `SystemFunctionBundle` builder 加 `.scalars(XxxFunctions.class)`。（插件路径：`Plugin.getFunctions()`。）

**新增 session property**：`io.trino.SystemSessionProperties` 加 `@SessionProperty` 字段 → ServerMainModule 绑定 → `SessionPropertyManager.addSystemSessionProperties`（metadata/SessionPropertyManager.java:88）注册。
