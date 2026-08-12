---
source:
  type: "源码解读"
  project: "graphify"
  url: "https://github.com/Graphify-Labs/graphify"
title: "Extraction Engine"
date: "2026-08-10T22:00:00+08:00"
category: [AI, Agent, "AI Coding", "Code Understanding", Graphify, CodeWiki, "0.9.38"]
tags: ["graphify", "tree-sitter", "AST", "LanguageConfig", "符号解析", "phantom-edge"]
description: "graphify 抽取引擎：tree-sitter AST 确定性抽取 ~40 种语言，LanguageConfig 统一语言差异，跨文件符号解析 + 多层 phantom-edge 防护。"
readingTime: "18 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/AI/Agent/AI-Coding/Code-Understanding/Graphify/CodeWiki/0.9.38/00-overview)

---

## 模块定位

抽取引擎是 graphify 的心脏——它用 tree-sitter AST 把源码**确定性地**解析为 nodes + edges，不调 LLM、数据不离开本机。这是 graphify "代码映射完全本地、完全免费"承诺的技术基础。模块覆盖 `extract.py`（6524 行编排器）和 `extractors/` 包（28 文件、15907 行），支持 ~40 种语言，产出的 `{nodes, edges, raw_calls}` dict 是后续图构建的全部输入。

模块的核心挑战是：如何用一套代码统一 40 种语言的语法差异？如何在不调 LLM 的情况下做跨文件符号解析？如何防止名称碰撞产生的幻影边（phantom edge）？

## 模块架构

![抽取引擎架构](/vibe-reading/images/articles/graphify-internals/extraction-architecture.svg)

模块内部按三阶段流水线组织。**Phase 1** 是缓存检查 + 语言分派——`_get_extractor()`（`extract.py` L4864）通过 `_DISPATCH` 字典按文件后缀查表，对 `.h` 等歧义后缀做 C/C++/ObjC 嗅探，对无后缀文件按 shebang 分派。**Phase 2** 是 AST 遍历——`_extract_generic()`（`engine.py` L2526）是模板方法，通过 `LanguageConfig` 配置驱动 `walk()` 和 `walk_calls()` 遍历 AST。**Phase 3** 是跨文件后处理——在所有文件抽取完成后，做语料级别的符号解析、member-call 绑定、phantom-edge 防护，产出最终的 EXTRACTED/INFERRED 标签。

`extractors/` 包正在从 `extract.py` 拆分中（见 `extractors/MIGRATION.md`）：独立语言 extractor（go/rust/bash 等 ~16 种）已迁移到各自文件；config 驱动的核心语言（python/js/java/c++/csharp/kotlin/swift 等）及其共享的 `_extract_generic` 核心仍在 `extract.py` 和 `engine.py` 中。迁移规则严格——只允许 verbatim move，facade re-export 保持向后兼容。

## 调用链路

### extract() 三阶段流水线

```
extract(paths, cache_root, root)                    extract.py L5139
│
├─ Phase 1: 缓存 + 分派
│   ├─ _get_extractor(path)                         extract.py L4864
│   │   ├─ _DISPATCH[suffix] → extract_python/extract_js/...
│   │   ├─ _SHEBANG_DISPATCH (无后缀文件)
│   │   └─ _is_objc_header() / _is_cpp_header() (.h 歧义)
│   └─ load_cached(path, root, kind="ast")          cache.py L772
│       └─ HIT → 跳过抽取; MISS → 加入 uncached_work
│
├─ Phase 2: 并行抽取 (ProcessPoolExecutor)
│   └─ _extract_single_file() → _safe_extract()     extract.py L163/L4920
│       └─ extractor(path) → _extract_generic(path, config)
│           ├─ importlib.import_module(config.ts_module)
│           ├─ Parser(language).parse(source)       engine.py L2535
│           ├─ walk(node)                           engine.py L2713
│           │   ├─ config.import_handler(node)     → imports 边
│           │   ├─ class_types match                → node + contains/inherits 边
│           │   ├─ function_types match             → node + 收集 body
│           │   └─ config.extra_walk_fn()           → 语言专属钩子
│           └─ walk_calls(body, caller_nid)         engine.py L4496
│               └─ call_types match                 → raw_calls 记录
│
├─ Phase 3: 跨文件后处理 (语料级)
│   ├─ _augment_symbol_resolution_edges()           resolution.py L1867
│   │   ├─ _collect_js/python_symbol_resolution_facts()
│   │   └─ _apply_symbol_resolution_facts()         resolution.py L819
│   ├─ run_language_resolvers()                     resolver_registry.py L68
│   │   └─ swift/python/csharp/java member-call 解析
│   ├─ 共享跨文件调用 pass                          extract.py L6078+
│   │   ├─ global_label_to_nids 索引
│   │   ├─ _LANGUAGE_BUILTIN_GLOBALS 过滤
│   │   ├─ _lang_family() 跨语言防护
│   │   ├─ _has_import_evidence() 门控
│   │   └─ → EXTRACTED (有 import 证据) / INFERRED (名称唯一匹配)
│   └─ _semantic_id_remap                           extract.py L5420
│
└─ 返回 {nodes, edges, raw_calls, failed_sources}
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `extract()` extract.py L5139 | 抽取编排主函数 | 三阶段流水线，支持增量（resolution_context 参数） |
| `_get_extractor()` extract.py L4864 | 按后缀/shebang 分派语言 | _DISPATCH 字典 + .h 歧义嗅探 |
| `_extract_generic()` engine.py L2526 | 模板方法：parse→walk→walk_calls | config 驱动，source_override 支持容器格式 |
| `walk()` engine.py L2713 | 遍历 AST 顶层结构 | 按 config 类型集合分派，调用 import_handler |
| `walk_calls()` engine.py L4496 | 遍历函数体提取调用 | function_boundary_types 控制递归边界 |
| `_augment_symbol_resolution_edges()` resolution.py L1867 | JS/Python 跨文件符号解析 | 三阶段：收集事实→应用事实→解析路径 |
| `run_language_resolvers()` resolver_registry.py L68 | 按语言运行 member-call 解析器 | 注册表模式，每个 resolver 有 god-node guard |
| `_safe_extract()` extract.py L163 | 单文件抽取异常隔离 | 失败返回空 result，不中断批次 |

</details>

## 核心实现

### LanguageConfig：统一 40 种语言的配置类

`LanguageConfig`（`extractors/models.py` L13）是整个抽取引擎的核心抽象——它把语言的语法差异分解为三类可配置项，让 ~15 种语言共享一个 `_extract_generic` 实现（~1300 行），每种语言只需 ~10 行 config 定义：

```python title="extractors/models.py L13-54"
@dataclass
class LanguageConfig:
    ts_module: str                    # tree-sitter 包名，如 "tree_sitter_python"
    ts_language_fn: str = "language"  # 调用入口属性名

    class_types: frozenset = frozenset()       # AST 中代表 class 的节点类型
    function_types: frozenset = frozenset()    # 代表 function 的节点类型
    import_types: frozenset = frozenset()      # 代表 import 的节点类型
    call_types: frozenset = frozenset()        # 代表 call 的节点类型

    name_field: str = "name"                    # AST 上取名称的 field 名
    body_field: str = "body"                    # AST 上取函数体的 field 名
    call_function_field: str = "function"       # call 节点上取 callee 的 field
    call_accessor_node_types: frozenset = frozenset()  # member/attribute 节点

    import_handler: Callable | None = None           # 语言专属 import 处理器
    resolve_function_name_fn: Callable | None = None # C/C++ declarator 名称解析
    extra_walk_fn: Callable | None = None             # 额外遍历钩子
```

三类配置项各有分工：**AST 类型集合**（`class_types`/`function_types`/`import_types`/`call_types`）将 tree-sitter 的语法节点类型映射到 graphify 的语义分类——例如 Python 的 class 是 `"class_definition"`，Java 的是 `"class_declaration"`，config 把这些差异统一。**字段路径**（`name_field`/`body_field`/`call_function_field`）指定从 AST 节点提取名称/函数体/callee 的 field 名。**Callable 钩子**（`import_handler`/`extra_walk_fn`/`resolve_function_name_fn`）让语言注入专属逻辑——如 C/C++ 的 declarator 名称需要解包、JS 的 arrow function 需要特殊处理、Swift 的 import 指向 module 而非文件。

Python 的 config 实例化示例：

```python title="extract.py L743-755"
_PYTHON_CONFIG = LanguageConfig(
    ts_module="tree_sitter_python",
    class_types=frozenset({"class_definition"}),
    function_types=frozenset({"function_definition"}),
    import_types=frozenset({"import_statement", "future_import_statement"}),
    call_types=frozenset({"call"}),
    import_handler=_import_python,  # 策略注入
)
```

独立 extractor（Go/Rust/Bash 等）在 `extractors/` 目录下各自独立实现，因为它们的 AST 结构差异太大或需要特殊处理。Go extractor（`extractors/go.py`，434 行）是自包含的完整函数，不使用 `LanguageConfig`。

### tree-sitter 确定性抽取 vs 正则 vs LLM

模块 docstring 明确声明：`"Deterministic structural extraction from source code using tree-sitter."`（`extract.py` L1）。选择 tree-sitter 而非正则或 LLM 的原因：

- **vs 正则**：正则无法可靠处理嵌套结构（嵌套函数、泛型参数、多行 import），不同语言语法差异巨大，维护正则规则集成本远高于 AST 节点类型映射。tree-sitter 提供增量解析和错误恢复（`_first_parse_error_line` in `engine.py` L2329），能处理语法不完美的源码。
- **vs LLM**：LLM 抽取不确定（同输入不同输出），无法 byte-stable 缓存。graphify 的缓存机制（`load_cached`/`save_cached` in `cache.py`）依赖抽取结果的确定性。tree-sitter 的 AST 解析是确定性的——同一文件 + 同一 grammar 版本永远产生相同 nodes/edges，使得缓存命中可靠。

### EXTRACTED vs INFERRED 置信度标签

每条边都带置信度标签，让下游消费者区分"确定存在的依赖"和"可能存在的依赖"：

```python title="extract.py L6239-6244"
if has_import_evidence:
    confidence = "EXTRACTED"
    confidence_score = 1.0
else:
    confidence = "INFERRED"
    confidence_score = 0.8
```

**EXTRACTED**（1.0）：边的关系在源码中有直接证据——同文件内 AST 直接抽取的所有边（`add_edge` 默认 `confidence="EXTRACTED"` in `engine.py` L2668）、跨文件调用且调用者有 import 证据指向被调用者（`_has_import_evidence()` 返回 True）、类型限定的 member call（`Type.staticMethod()` 中类型名显式出现）。

**INFERRED**（0.8）：边的关系通过推断建立——跨文件调用且调用者无 import 证据但名称唯一匹配到一个定义、通过本地类型推断的 member call（`obj.method()` 中 receiver 类型来自局部变量推断）、间接调用/回调传递（`indirect_call` 始终为 INFERRED，即使有 import 证据，因为名称是被当作值引用而非直接调用）。

### 跨文件符号解析（resolution.py）

`_extract_generic` 在单文件模式下运行，不知道其他文件的存在。跨文件解析（如 `import { Foo } from './bar'` 需要知道 `bar.ts` 导出了 `Foo`）必须在所有文件抽取完成后、在语料级别进行。`_augment_symbol_resolution_edges()`（`resolution.py` L1867）分三阶段工作：

1. **收集事实**（`_collect_js_symbol_resolution_facts` / `_collect_python_symbol_resolution_facts`）：重新解析 JS/Python 文件的 AST，提取 declarations/imports/aliases/exports/uses，存入 `_SymbolResolutionFacts` 容器（`models.py` L108）。
2. **应用事实**（`_apply_symbol_resolution_facts`）：将事实转为图边——为每个 import 事实创建 `imports` 边，为 re-export 创建 `imports_from` 边。
3. **JS import path 解析**（`_resolve_js_import_target`，`resolution.py` L528）：解析 import specifier 到磁盘文件——相对路径 → tsconfig path aliases → workspace packages → package.json `exports` 字段。解析失败时返回 `_make_id("ref", raw)`，前缀 `"ref"` 确保外部包永不与本地文件/符号节点碰撞。

```python title="extractors/resolution.py L528-553"
def _resolve_js_import_target(raw, str_path):
    resolved_path = _resolve_js_module_path(raw, Path(str_path).parent)
    if resolved_path is not None:
        return _make_id(str(resolved_path)), resolved_path
    # 未解析：相对路径/alias/workspace 全失败 → 外部包
    return _make_id("ref", raw), None  # ref 前缀防碰撞
```

### 幻影边（phantom edge）多层防护

幻影边是源码中不存在的虚假依赖，通常由名称碰撞引起。graphify 构建了**八层防护**：

1. **内置全局过滤**（`_LANGUAGE_BUILTIN_GLOBALS` in `base.py` L13）：`String`/`Number`/`print`/`len` 等内置函数在几乎每个文件中被调用，不过滤会形成 god-node。base.py 注释说明：`"Without this filter they become god-nodes accumulating spurious edges from every call site"` (#726)。
2. **God-node guard**（各 member-call resolver）：`len(candidates) != 1` 时 bail——如 `_resolve_swift_member_calls` in `extract.py` L2538。一个方法名在多个类中定义时不绑定到任何一个。
3. **跨语言族防护**（`_lang_family()` in `extract.py` L6118）：名称匹配只在同一语言族内进行（Python→Python, Kotlin↔Java, C↔C++↔ObjC）。防止 TSX 回调绑定到同名的 Kotlin 方法。
4. **JS/TS import 证据门控**（`extract.py` L6221）：JS/TS 模块没有隐式跨模块作用域，跨文件调用只在有 import 证据时有效。
5. **Bash 调用隔离**（`extract.py` L6094）：Bash 调用只通过 `resolve_bash_source_edges` 解析，不参与全局名称匹配。
6. **Go predeclared 过滤**（`_GO_PREDECLARED_FUNCS` in `extractors/go.py` L38）：`append`/`len`/`make` 等内置函数如果与某方法同名会吸收所有内置调用。
7. **Callable 定义标记**（`_callable`/`_callable_class` in `extract.py` L5998）：间接调用只在目标是真实 callable 定义时产生边。
8. **ref 命名空间**（`resolution.py` L548）：未解析的外部包 import 用 `_make_id("ref", raw)` 而非 `_make_id(raw)`，前缀防碰撞。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|----------|
| 注册表/分派 | `_DISPATCH` dict in `extract.py` L4655 | 后缀→extractor 直接映射，新增语言加一行 |
| 模板方法 | `_extract_generic()` in `engine.py` L2526 | 固定流程（parse→walk→walk_calls），config 填差异 |
| 策略模式 | `LanguageConfig.import_handler` in `models.py` L45 | 统一签名不同实现，语言注入专属逻辑 |
| 解析器注册表 | `resolver_registry.py` L57 | member-call 解析器按语言注册，`extract()` 不改 |

## 模块间交互

抽取引擎是**生产者**——产出 `{nodes, edges, raw_calls}` dict 供 `build.py` 消费。它与上下游的关系清晰分离：

- **→ build.py**：不直接 import `extract()`，而是通过 CLI/watch 间接获得返回值。`build.py` 只直接使用 `graphify.extractors.base._file_stem` 做路径处理。这是生产者-消费者分离。
- **→ cache.py**：`extract()` Phase 1 调 `load_cached()` 检查缓存命中，`_extract_single_file()` 调 `save_cached()` 写入缓存。JS/TS 系列文件（`_JS_CACHE_BYPASS_SUFFIXES`）绕过缓存，因为解析结果可能因 tsconfig 别名变化而失效。
- **→ detect.py**：用 `_shebang_interpreter` 路由无后缀文件，用 `CODE_EXTENSIONS` 收集代码文件，用 `_is_ignored` 过滤。
- **→ security.py**：调 `sanitize_metadata()` 对元数据消毒。
- **→ paths.py**：调 `disambiguate_ambiguous_candidates()` 做多候选消歧（test/非test + 路径近邻）。
- **← cli.py / watch.py**：CLI 入口和文件监听调用 `extract()` 和 `_get_extractor()`。

## 扩展方式

### 新增一种语言的 extractor

1. **`graphify/extract.py`**：`_DISPATCH` 字典（L4655）添加 `".xyz": extract_xyz`；添加 `extract_xyz()` 函数（模式为 `_extract_generic(path, _XYZ_CONFIG)`）；添加 `_XYZ_CONFIG = LanguageConfig(...)` 实例化
2. **`graphify/detect.py`**：`CODE_EXTENSIONS` 集合添加 `.xyz`
3. **跨文件解析**（如需）：添加 `_resolve_xyz_member_calls()` 并在 L3584 区域 `register_language_resolver()`
4. **独立 extractor**（如 AST 差异大）：在 `graphify/extractors/xyz.py` 创建独立实现（参考 `extractors/go.py`），然后在 `extract.py` 添加 facade re-import

### 修改跨文件符号解析规则

1. **`graphify/extractors/resolution.py`**：`_resolve_js_module_path()`（L505）添加新解析策略；`_resolve_js_import_target()`（L528）调整返回 ID 格式
2. **`graphify/extract.py`**：`extract()` Phase 3 中，新后处理步骤加在 `_augment_symbol_resolution_edges`（L5410）之后
