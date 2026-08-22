---
source:
  type: "源码解读"
  project: "DataFusion"
  url: "https://github.com/apache/datafusion"
title: "公共基础"
date: "2026-08-22T14:15:24+08:00"
category: [Database, "Query Engine", DataFusion, CodeWiki, "48.0.0"]
tags: ["DataFusion", "Rust", "查询引擎", "Apache Arrow"]
description: "DataFusion 全仓地基：DFSchema、DataFusionError、TreeNode 递归模型与宏驱动配置系统。"
readingTime: "14 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/Query-Engine/DataFusion/CodeWiki/48.0.0/00-overview)

---

## 模块定位

`datafusion/common`（含 `common-runtime`、`expr-common`、`physical-expr-common`）是 DataFusion 所有 crate 的根依赖——被 30 个 crate 直接引用。它不承载查询业务逻辑，而是提供**不可压缩的底层抽象**：带 qualifier 的 schema（`DFSchema`）、贯穿全链路的错误类型（`DataFusionError`）、统一的递归遍历/重写模型（`TreeNode`）与宏驱动的配置系统（`ConfigOptions`）。任何上层模块的函数签名都形如 `Result<T>` = `Result<T, DataFusionError>`，任何计划/表达式/算子都实现 `TreeNode`——这是全仓共享的"语法"。

## 模块架构

Common 内部由四个正交的核心抽象组成，各自独立、无相互依赖：

- **`DFSchema`**（`dfschema.rs:107`）：在 Arrow `SchemaRef` 之上叠加 `field_qualifiers`（与 fields 等长的 `Vec<Option<TableReference>>`）与 `FunctionalDependencies`，使同一 schema 能容纳来自多表的列（JOIN 消歧）。
- **`DataFusionError`**（`error.rs:51`）：21 个变体的 enum，覆盖 SQL 解析到执行全链路，含 `Context` 错误链、`Shared(Arc<…>)` 多消费者共享、`Collection` 多错误聚合、可选 backtrace。
- **`TreeNode`**（`tree_node.rs:95`）：递归遍历/重写的通用 trait，定义 `visit`/`apply`/`transform_down`/`transform_up`/`rewrite` 等方法，靠 `apply_children`/`map_children` 两个抽象方法驱动。
- **`ConfigOptions`**（`config.rs:839`）：三层嵌套结构（catalog/execution/optimizer/sql_parser/explain/format/extensions），由 `config_namespace!` 宏在编译期生成 `set`/`visit`，支持点分 key 路径（如 `datafusion.execution.batch_size`）。

## 调用链路

`TreeNode` 的重写模型是优化器/物理优化器的运行底座。以一条逻辑优化规则为例，数据流如下：

```text
rule.rewrite(plan: LogicalPlan, config)              # optimizer.rs:92
  → plan.rewrite_with_subqueries(&mut Rewriter)      # TreeNode::rewrite
    → Rewriter::f_down(node) / f_up(node)            # TreeNodeRewriter 回调
      → node.map_children(|c| rewriter.rewrite(c))   # 递归子节点（apply_children 抽象）
  → 返回 Transformed<LogicalPlan> { data, transformed, tnr }
```

每步返回 `Transformed<T>`（`tree_node.rs:657`），携带 `transformed: bool` 标志——`map_children` 据此做短路优化：只有当至少一个子节点确实变化时才重建父节点，避免无谓的 `Arc` clone。`TreeNodeRecursion`（`Continue`/`Jump`/`Stop`）三值枚举精确控制递归，`Jump` 允许跳过子树但继续 `f_up` 阶段——比传统两值枚举更灵活。

## 核心实现

### DFSchema：Arrow Schema 的 qualifier 扩展

```rust title="datafusion/common/src/dfschema.rs:107"
pub struct DFSchema {
    inner: SchemaRef,                                   // Arrow Schema (Arc)
    field_qualifiers: Vec<Option<TableReference>>,      // 与 fields 等长
    functional_dependencies: FunctionalDependencies,
}
```

设计决策是采用**并列 qualifier 向量**而非在 Field metadata 中嵌入表名。原因是 Arrow `Schema` 已是成熟高性能类型，复用它避免重造 `Field`/`DataType` 体系；并列向量使 `as_arrow()` 能零成本回退到原始 Arrow Schema（`ParquetWriter` 等直接消费），保持 Arrow 生态兼容。`index_of_column_by_name` 与 `qualified_field_with_unqualified_name`（`dfschema.rs`）处理限定名/非限定名查找与歧义——这是 JOIN 后多表同名列消歧的基础。`check_names()` 强制非限定字段名唯一且不与限定名冲突。

### TreeNode：分离"变更信号"与"变更本身"

```rust title="datafusion/common/src/tree_node.rs:95"
pub trait TreeNode: Sized {
    fn apply_children<'n, F>(&'n self, f: F) -> Result<TreeNodeRecursion>;
    fn map_children<F>(self, f: F) -> Result<Transformed<Self>>;
    // 默认实现：visit / apply / transform_down / transform_up / transform_down_up / rewrite / exists
}

pub struct Transformed<T> { pub data: T, pub transformed: bool, pub tnr: TreeNodeRecursion }
```

不可变树做改写时，最大性能问题是子树未变却返回新 `Arc` 导致上游不必要的 clone 与引用计数变动。`transformed: bool` 让 `map_children` 短路。**`DynTreeNode`**（`tree_node.rs:1179`）+ blanket impl `impl<T: DynTreeNode + ?Sized> TreeNode for Arc<T>` 使 trait object（`Arc<dyn PhysicalExpr>`）也能参与统一树遍历——物理表达式树的重写复用同一套 API。

### DataFusionError：多消费者场景的 Shared 设计

`Shared(Arc<DataFusionError>)` 变体（`error.rs:148`）专为 Repartition 等场景设计——一个上游错误需传播给多个下游消费者。用 `Arc` 共享同一实例而非 `Clone`，避免带 backtrace 错误的重复内存。`From<&Arc<DataFusionError>>` 实现先检查是否已是 `Shared` 防止重复包装。`find_root()` 非递归沿 `source()` 链找根因；`DataFusionErrorBuilder`（`error.rs:682`）收集多错误后封为 `Collection`。

### ConfigOptions：宏驱动的配置 DSL

```rust title="datafusion/common/src/config.rs:839"
pub struct ConfigOptions {
    pub catalog: CatalogOptions, pub execution: ExecutionOptions,
    pub optimizer: OptimizerOptions, pub sql_parser: SqlParserOptions,
    pub explain: ExplainOptions, pub format: FormatOptions, pub extensions: Extensions,
}
```

配置项超 100 个、分布 10+ 子结构。用 `config_namespace!` 宏（`config.rs:111`）在编译期生成 struct 定义、`Default` impl 与 `ConfigField::set()`/`visit()` 的 match 分支，支持点分 key 路径解析与自定义 transform（如 `to_lowercase`）、弃用 `warn`。`Extensions`（`BTreeMap<&'static str, ExtensionBox>`）允许第三方 crate 通过 `ExtensionOptions` trait 注册自定义配置命名空间。env 变量也由 `visit()` 自动收集（`from_env`，`config.rs:914`）。

> 另一项全局性约束在 `lib.rs:25`：`#![deny(clippy::clone_on_ref_ptr)]` 强制每次 `Arc` clone 显式写 `Arc::clone(&x)`，防止性能敏感的查询引擎里隐式 Arc clone 堆积导致内存膨胀。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor | `TreeNodeVisitor`/`TreeNodeRewriter`（`tree_node.rs:458`） | 分离遍历算法与节点逻辑，`LogicalPlan`/`Expr`/`ExecutionPlan` 共享同一遍历器 |
| Builder | `DataFusionErrorBuilder`（`error.rs:682`） | 收集多错误后聚合，避免中途 fail 丢上下文 |
| 宏驱动 Codegen | `config_namespace!`（`config.rs:111`） | 100+ 配置项消除样板，支持 serde 无法表达的点分路径与 transform |
| Newtype | `DFSchemaRef = Arc<DFSchema>`、`SharedResult<T>`（`error.rs:45`） | 语义化类型别名，统一 `hashbrown` 实现 |

## 模块间交互

被 30 个 crate 直接依赖。交互方式：所有 crate 函数签名用 `Result<T>`；`LogicalPlan`/`Expr`/`ExecutionPlan`/`PhysicalExpr` 全部 impl `TreeNode`（优化器/物理优化器的 `transform_down`/`transform_up` 调它）；`ConfigOptions` 经 `SessionConfig` 传到执行全链路；`common-runtime` 的 `SpawnedTask`（tokio task 包装，Drop 时 abort）被 `physical-plan` 的流式执行用。`expr-common`/`physical-expr-common` 把逻辑/物理表达式共享类型（`Accumulator`、`PhysicalExpr` trait）独立出来避免循环依赖。

## 扩展方式

- **新增错误类型**：在 `DataFusionError` enum 加变体，同步更新 `impl Error::source`（`error.rs:~362`）、`error_prefix()`（`:490`）、`message()`（`:526`），按需加宏 re-export。
- **新增配置项**：在 `config_namespace!` 的对应 struct 加一行 `pub field: T, default = v`，宏自动生成 set/visit，无需改其他代码。
- **为新 Plan 类型实现 TreeNode**：impl `apply_children`/`map_children` 两个方法，自动获得 `visit`/`rewrite`/`transform_*` 默认实现；若 children 是 `Arc<dyn Trait>` 形式，改 impl `DynTreeNode` 用 blanket impl。
