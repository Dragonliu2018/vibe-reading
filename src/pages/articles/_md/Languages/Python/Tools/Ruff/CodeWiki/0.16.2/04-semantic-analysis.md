---
source:
  type: "源码解读"
  project: "ruff"
  url: "https://github.com/astral-sh/ruff"
title: "语义分析"
date: "2026-08-13T20:14:13+08:00"
category: ["Languages", "Python", "Tools", "Ruff", "CodeWiki", "0.16.2"]
tags: ["ruff", "Rust", "语义分析", "作用域", "绑定", "Scope"]
description: "ruff 的语义模型——可变状态机 + 作用域栈 + 绑定 arena + 名称解析，为规则提供超越 AST 模式匹配的语义信息。"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Languages/Python/Tools/Ruff/CodeWiki/0.16.2/00-overview)

---

## 模块定位

`crates/ruff_python_semantic/` 构建 `SemanticModel`——在 AST 之上叠加作用域、绑定、名称解析等语义信息。这个模块独立存在的根本原因：**纯 AST 模式匹配无法处理 Python 的许多语义场景**——前向引用（`def f(): return g()` 中 `g` 后定义）、作用域可见性（类变量在嵌套函数不可见）、导入解析（`from os import path` 的 `path` 是 `os.path`）、shadow/redefinition 判断、star import、global/nonlocal、延迟类型注解。规则需要知道"这个变量是怎么来的、在哪个作用域、是否被引用"才能做出正确判断，这些信息只有语义分析能提供。

## 模块架构

`SemanticModel` 本身**不遍历 AST**——它是一个**被动的可变状态机**，由 `ruff_linter` 中的 `Checker`（实现 `Visitor`）驱动。模块内部由几个核心组件构成：`Scopes`（作用域 arena，`IndexVec<ScopeId, Scope>`）、`Bindings`（绑定 arena，`IndexVec<BindingId, Binding>`）、`Nodes`（AST 节点栈）、`Branches`（分支栈）、`resolved_names`（名称解析缓存）。所有集合都用 arena + u32 index 引用，内存紧凑、O(1) 访问、无生命周期标注。

## 调用链路

SemanticModel 不自己驱动遍历，关键流程是**名称解析** `resolve_load`（在 `Checker::handle_node_load` 中被调用）：

```
resolve_load(name: ExprName)                       [model.rs:461]
  ├─ [特殊] in_forward_reference → 先查 global scope（PEP 563）
  ├─ [主路径] 遍历作用域链 (current → global):
  │    for scope_id in scopes.ancestor_ids(scope_id):
  │      ├─ Class scope 且 class_variables_visible==false → skip
  │      ├─ scope.get(name) → 找到 binding_id
  │      ├─ 创建 resolved_reference，push 到 binding.references
  │      └─ 按 binding.kind 判断:
  │           ├─ Annotation → 继续搜索（注解不算 resolved）
  │           ├─ Deletion → unbound，继续搜索
  │           ├─ UnboundException(Some(id)) → 返回 shadowed binding
  │           ├─ Global(Some(id)) → 跳到 global binding 继续解析
  │           ├─ Nonlocal(id, _) → 跳到被声明的外层 binding
  │           └─ 其他 → ReadResult::Resolved(binding_id) ✓
  ├─ 检查 star imports
  └─ 都没找到 → unresolved_references.push() → NotFound
```

`Global`/`Nonlocal` 绑定类型在 `resolve_load` 中不是终点而是跳转：遇到 `Global(Some(id))` 跳到 global 作用域对应 binding 继续解析，`Nonlocal(BindingId, ScopeId)` 跳到被声明的外层作用域 binding——这模拟 Python 的 `global`/`nonlocal` 声明将名字绑定重定向到特定作用域的语义。

`resolve_name`（`model.rs:1132`）是轻量查询，直接查 `resolved_names` HashMap 缓存（`resolve_load` 中填充）。

### 节点栈与游标进出

SemanticModel 维护四个"当前游标"栈顶指针：`node_id`（AST 节点栈 `Nodes`）、`scope_id`（作用域栈）、`branch_id`（分支栈 `Branches`）、`definition_id`（定义栈 `Definitions`）。Checker 在遍历 AST 时通过 `push_node`/`pop_node` 维护节点栈——`push_node` 将当前节点压入 `Nodes`（arena，`NodeWithParent` 带 `parent` 指针构成祖先链），`pop_node` 回退 `node_id` 指针（不删数据，与作用域同理）。`push_scope`/`pop_scope`、`push_branch`/`pop_branch`、`push_definition`/`pop_definition` 同样只移动栈顶指针、保留 arena 数据——这让 deferred 分析可通过 Snapshot 恢复到任意历史游标位置。

| 方法 | 一行职责 | 关键设计决策 |
|------|---------|-------------|
| `SemanticModel::new()` | 初始化空 Scopes（含 global scope）+ 预分配 builtin 容量 | builtin 延迟物化 |
| `push_scope(kind)` / `pop_scope()` | 作用域栈进出 | pop 只移 scope_id 指针，不删数据 |
| `add_binding(name, range, kind, flags)` | 创建绑定推入 arena + 注册到 scope | 自动 materialize 被 shadow 的 builtin |
| `resolve_load(name)` | 名称加载解析（作用域链） | 跳过 Annotation/Deletion，处理 forward ref |
| `snapshot()` / `restore()` | 保存/恢复当前位置（5 个 ID 字段） | 轻量 Copy，支持 deferred |

## 核心实现

### SemanticModel：可变状态机 + Snapshot

```rust title="model.rs"
pub struct SemanticModel<'a> {
    pub scopes: Scopes<'a>,           // IndexVec<ScopeId, Scope>
    pub scope_id: ScopeId,            // 当前作用域（栈顶指针）
    pub bindings: Bindings<'a>,       // IndexVec<BindingId, Binding>
    resolved_references: ResolvedReferences,
    unresolved_references: UnresolvedReferences,
    pub shadowed_bindings: FxHashMap<BindingId, BindingId>,  // 跨作用域 shadow
    pub flags: SemanticModelFlags,    // u32 bitflags，当前位置上下文
    resolved_names: FxHashMap<NameId, BindingId>,  // ExprName→BindingId 缓存
    // ...
}
```

`SemanticModel` 在整个分析过程中被 `&mut` 修改（push_scope/pop_scope/push_binding/resolve_load），但通过 `Snapshot`/`Restore` 实现"局部不可变"——deferred 分析时保存 5 个 ID 字段（scope/node/branch/definition/flags）的轻量快照，分析完恢复。不可变模型需在每次变更时重建数据结构，对大型文件不可行；可变 + snapshot 只需保存 5 个字段。

### Scope 与 ScopeKind

```rust title="scope.rs"
pub struct Scope<'a> {
    pub kind: ScopeKind<'a>,
    pub(crate) parent: Option<ScopeId>,
    bindings: FxHashMap<&'a str, BindingId>,   // 名字 → BindingId
    // ...
}

pub enum ScopeKind<'a> {
    Module, Class(&'a StmtClassDef), Function(&'a StmtFunctionDef),
    Generator { kind: GeneratorKind, is_async: bool },
    Lambda(&'a ExprLambda), Type, DunderClassCell,
}
```

作用域用 `IndexVec` 存储，每个 Scope 只存 `parent: Option<ScopeId>`——不使用树形 children 指针。原因：(a) 内存紧凑；(b) 分析只需从当前 scope 向上遍历祖先链，不需从 parent 向下；(c) deferred 分析可通过 ScopeId 直接访问任意历史 scope（pop 不删数据）。

### Binding 与 20 种 BindingKind

```rust title="binding.rs"
pub struct Binding<'a> {
    pub kind: BindingKind<'a>,
    pub range: TextRange,
    pub scope: ScopeId,
    pub context: ExecutionContext,         // Runtime / Typing
    pub references: Vec<ResolvedReferenceId>,
    pub flags: BindingFlags,               // u16 bitflags
}

pub enum BindingKind<'a> {
    Annotation, Assignment, NamedExprAssignment,
    FunctionDefinition(ScopeId), ClassDefinition(ScopeId),
    Import(Import), FromImport(FromImport), SubmoduleImport(SubmoduleImport),
    Deletion, BoundException, UnboundException(Option<BindingId>),
    Global(Option<BindingId>), Nonlocal(BindingId, ScopeId),
    Builtin, Export, // ... 共 20 个
}
```

每个变体对应 Python 语义中一种不同的"名字绑定方式"，语义行为不同：`Annotation` 不产生实际值，`resolve_load` 遇到它跳过继续搜索；`Deletion` 表示名字已 unbind，返回 unbound；`UnboundException` 模拟 `except ... as x` 后 x 被 unbind；`Builtin` 延迟物化。linter 规则需要区分"变量怎么来的"——F811（redefinition）需知道两 binding 是否 redefine，F401（unused import）需知道 binding 是否 import 类型。`binding.rs:854` 有约束 `assert!(size_of::<BindingKind>() <= 24)`——新变体不能让 enum 超 24 字节。

### Builtin 延迟物化

Python builtins（`print`/`len`/`int` 等）不在初始化时全部创建 binding，而是只在被引用时通过 `materialize_builtin_binding` 创建（`model.rs:292`）。避免为每个文件创建 ~150 个 builtin binding，只有实际被使用的才物化，节省内存和时间。

**Symbol 枚举三态**：`lookup_symbol_in_scope` 返回 `Symbol` 枚举——`Symbol::Binding(BindingId)`（已物化的绑定）、`Symbol::Builtin`（存在 builtin 但未物化）、`Symbol::Unbound`（未找到）。当返回 `Symbol::Builtin` 时，`push_binding` 在创建新 binding 前先调 `materialize_builtin_binding` 把被 shadow 的 builtin 物化为真实的 `BindingKind::Builtin` 绑定，再记录 shadow 关系——这样 builtin 既延迟创建又不丢失 shadow 链。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| Visitor 驱动的语义分析 | `Checker` impl `Visitor` in `checkers/ast/mod.rs:969` | 遍历逻辑与状态管理分离 |
| 作用域栈 + ID 持久化 | `Scopes` as `IndexVec` in `scope.rs:259` | pop 不删数据，deferred 可访问历史 scope |
| 延迟分析 (deferred/snapshot) | `Snapshot` in `model.rs:2930`，`deferred.rs` | Python 前向引用要求函数体在模块级完成后分析 |
| Arena + ID 索引 | `Bindings`/`Scopes` as `IndexVec` | O(1) 访问、紧凑、无生命周期标注、可 Copy |
| bitflags 状态 | `SemanticModelFlags`(u32) / `BindingFlags`(u16) | 跟踪当前位置上下文，snapshot/restore 保存恢复 |

## 模块间交互

```
ruff_python_parser ──parse──> ruff_python_ast (AST 类型)
                                   │
                                   ▼
                             ruff_python_semantic
                             ├── model.rs      (SemanticModel 核心)
                             ├── scope.rs      (Scope, ScopeKind)
                             ├── binding.rs    (Binding, BindingKind)
                             ├── reference.rs  (Resolved/UnresolvedReference)
                             ├── analyze/      (typing/class/visibility/type_inference 等高层工具)
                             └── cfg/          (控制流图)
                                   │
                                   ▼
                             ruff_linter (Checker 驱动 + 规则消费)
```

`Checker` 通过 `self.semantic()`（`mod.rs:524`）获取只读引用，通过 `self.semantic.push_scope()` 等方法修改状态。`analyze/` 子目录提供基于 SemanticModel 的高层分析函数（如 `analyze::typing::match_typing_expr` 判断是否 `typing.Optional`），供规则调用。

## 重要设计决策

**为什么 linter 规则需要语义信息而不只靠 AST 模式匹配？** 纯 AST 模式匹配无法处理：前向引用（函数体在模块级完成后才分析）、作用域可见性（类变量在嵌套函数不可见）、导入解析（`from os import path` 的 qualified_name）、shadow/redefinition 区分（`x=1;x=2` 非 redefine，`import x;def x()` 是）、star import、global/nonlocal、延迟类型注解（`x: "list[int]"` 字符串需二次解析）。`resolve_load`（`model.rs:461`）的复杂逻辑正是为这些场景而生。

**shadowed_bindings 分两层**：同作用域 shadow 在 `Scope::shadowed_bindings`（`scope.rs:38`，`x=1;x=2` 后者 shadow 前者）；跨作用域 shadow 在 `SemanticModel::shadowed_bindings`（`model.rs:111`，函数内 `x=1` shadow 全局 `import x`）。

## 扩展方式

**新增一种 BindingKind**（如 `MatchPattern` 表示 match 语句模式绑定）：
1. `binding.rs`——`BindingKind` enum 加变体 + 必要时 `BindingFlags` 加 flag + 更新 `redefines()`/`is_unbound()` 等判断方法（注意 `size_of::<BindingKind>() <= 24` 约束）
2. `model.rs`——更新 `resolve_load`（`model.rs:557`）、`lookup_symbol_in_scope`（`model.rs:863`）、`resolve_qualified_name`（`model.rs:1196`）中的 match 分支
3. `checkers/ast/mod.rs`——在 `handle_node_store` 或 `visit_stmt` 添加创建该 binding kind 的逻辑
4. `ruff_python_semantic/src/analyze/`——若涉及类型推断/导入分析，更新相关文件
