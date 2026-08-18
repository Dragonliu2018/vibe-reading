---
source:
  type: "源码解读"
  project: "sidex"
  url: "https://github.com/Sidenai/sidex"
title: "语法高亮与 TextMate"
date: "2026-08-18T15:41:58+08:00"
category: [Tools, IDE, SideX, CodeWiki, "0.1.3"]
tags: ["sidex", "Rust", "tree-sitter", "TextMate", "grammar", "Oniguruma"]
description: "SideX 语法高亮——TextMate grammar 栈式状态机 + tree-sitter 结构化解析，binary tokenize 直喂 Monaco"
readingTime: "15 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Tools/IDE/SideX/CodeWiki/0.1.3/00-overview)

---

## 模块定位

这一层负责把源码文本变成带颜色的 token 流喂给 Monaco 渲染，以及提供结构化语法树给折叠/括号匹配/缩进。SideX 有**两套机制并存**：`sidex-textmate` 是 vscode-textmate 的忠实 Rust 移植（Oniguruma 正则、packed u32 metadata、Monaco 兼容），`sidex-syntax` 基于 tree-sitter 做结构化语法分析（高亮/折叠/括号/缩进/注入）。两者分工：TextMate 做精准着色，tree-sitter 做结构语义。值得注意的是 `sidex-syntax` 还自带一套简化 TextMate fallback（用 `fancy_regex` 而非 Oniguruma）。

## 模块架构

```
命令层
  commands/textmate.rs   TextMateStore（Registry + grammars + stacks 句柄表）
  commands/syntax.rs     syntax_detect_language / syntax_tokenize
        ↓
sidex-textmate crate（~8167 行，最大 crate之一）   sidex-syntax crate（~6000 行）
  ├─ grammar/grammar_core.rs  Grammar + GrammarInner       ├─ highlight.rs      Highlighter + HighlightConfig
  ├─ grammar/state_stack.rs   StateStackImpl（不可变链表栈） ├─ tree_sitter_parser.rs  TreeSitterManager
  ├─ grammar/attr_stack.rs    AttributedScopeStack         ├─ language.rs        builtin_language_configurations
  ├─ tokenizer/hot_path.rs    tokenize_string 状态机        ├─ folding.rs / bracket.rs / indent.rs
  ├─ theme.rs                 Theme + ColorMap + trie      ├─ textmate.rs        简化 fallback tokenizer
  ├─ metadata.rs              32 位 packed EncodedToken    ├─ semantic_tokens.rs  merge LSP overlay
  └─ regex.rs                 Oniguruma FFI                └─ ...
```

`TextMateStore`（`commands/textmate.rs:23`）通过 `tauri::State` 全局共享：`registry: Arc<Registry>`、`grammars: RwLock<HashMap<String, Arc<Grammar>>>`、`stacks: RwLock<HashMap<u64, Arc<StateStackImpl>>>`（前端持 u64 句柄，后端持实际栈）、`next_stack`。前端 `NativeTextMate`（`sidexTextMateService.ts`）是单例 bridge。

## 调用链路

TextMate tokenize 单行（`textmate_tokenize_line_binary`）：

```
前端 NativeTextMate.tokenizeLineBinary(scopeName, lineText, prevStack: u64)
  → TextMateStore.grammars.get(scopeName) → Arc<Grammar>
  → TextMateStore.stacks.get(prevStack) → Arc<StateStackImpl>
  → Grammar::tokenize_line_binary
      → tokenize() in grammar/tokenize.rs:84
         ├─ ensure_root_rule_id()  惰性编译根规则
         ├─ initial_stack()  构建初始栈 / 重置已有栈行内位置
         ├─ 附加 \n 到行尾（Oniguruma $ anchor 依赖）
         └─ tokenize_string()  in tokenizer/hot_path.rs:60
             ① check_while_conditions  遍历栈 BeginWhile frame 验证，失败 pop
             ② scan_next  同时扫 active rule + injection rules，取最左/最高优先级
             ③ dispatch: END_RULE_ID→pop / MatchRule→emit+pop / BeginEnd→push / BeginWhile→push+存 while regex
             ④ 无匹配/time budget 耗尽退出
      → LineTokens::emit_binary  从 AttributedScopeStack 读 packed u32，merge 相邻相同 metadata token
  → 返回新 rule_stack 句柄 + Vec<u32> [startIndex, metadata] 流
```

tree-sitter 高亮（`syntax_tokenize`）：匹配 `HighlightConfig`（目前只硬编码 Rust 的 `RUST_HIGHLIGHT_QUERY`，其他语言返回空 Vec——待核实扩展计划）→ `Highlighter::highlight` → `parser.parse` → `QueryCursor::matches` 收集 capture spans → 排序（start 升序、end 降序处理嵌套）→ 转 `HighlightEvent` 流 → `HighlightedLine`。

| 方法 | 一行职责 | 关键设计决策 |
|------|----------|-------------|
| `tokenize_string` in `hot_path.rs:60` | TextMate 栈式状态机 | 显式循环，状态编码在不可变链表栈 |
| `textmate_tokenize_line_binary` | binary tokenize | 返回 packed u32，Monaco 直接消费 |
| `textmate_update_theme` | 切主题 | scanner cache 独立于 theme，切换廉价 |
| `textmate_release_stack` | 释放栈句柄 | 手动生命周期，文档关闭时前端调 |
| `Highlighter::collect_events` in `highlight.rs:909` | tree-sitter query 解释器 | query 定义"程序"，QueryCursor 是解释器 |

## 核心实现

### 栈式状态机 + 不可变链表

`StateStackImpl`（`state_stack.rs:21`）是 TextMate tokenize 核心——`parent: Option<Arc<StateStackImpl>>` 的不可变链表。每个 frame 记录当前活跃规则、scope 栈、动态 end 规则（支持 begin/end 反向引用）。`positions: Arc<Mutex<StackPositions>>` 用 Mutex 是因 `reset()` 每行开始就地改行内位置。`AttributedScopeStack`（`attr_stack.rs:42`）是 theme-aware 的 scope 栈：每次 push scope 时就预做 theme lookup，把 packed metadata 缓存在 frame 上，发射 token 时只读栈顶，无需热路径 theme 查询。push 创建新节点共享 parent（flyweight），pop 返回 parent clone，`with_end_rule` 值不变时返回 `Arc::clone(self)` 避免无谓分配。

### 32 位 packed metadata

`EncodedTokenAttributes = u32`（`metadata.rs:8`），位布局 `LanguageId(8) | StandardTokenType(2) | BalancedBracket(1) | FontStyle(4) | Foreground(9) | Background(8)`，与 VSCode `EncodedTokenAttributes` 位级兼容。binary tokenize 返回 `Vec<u32>` 的 `[startIndex, metadata]` 对，Monaco 的 `TextModel` 直接作 `Uint32Array` 消费"without translation"（`textmate.rs:6` 注释），IPC 序列化开销最小化。plain 版（`textmate_tokenize_line`）返回 string scopes，仅调试用。

### tree-sitter 增量解析与语言注入

`TreeSitterManager::parse_incremental`（`tree_sitter_parser.rs:153`）克隆旧 tree → `tree.edit(edit)` → `parser.parse(source, Some(&tree))` 复用未变 AST 节点。`to_input_edit`（`parser.rs:80`）用 `Buffer` 的 `char_to_byte` + `position_to_offset` 把 `EditOperation` 转 tree-sitter 的 byte offset + Point。`get_injections`（`tree_sitter_parser.rs:216`）通过 `injections_query` 查 `injection.content`/`injection.language` capture，返回 `Vec<InjectionRange>`，用于 HTML 嵌入 JS/CSS。

### 语义 token 合并

`sidex-syntax/src/semantic_tokens.rs` 的 `merge_highlights`/`merge_semantic_tokens` 把 LSP semantic token overlay 与 syntax highlight 合并，**semantic 优先**——LSP 提供的精确类型信息覆盖 tree-sitter/TextMate 的粗粒度 token。

## 设计模式

| 模式 | 位置 | 为什么用 |
|------|------|---------|
| 栈式状态机 | `hot_path.rs:60` `tokenize_string` | TextMate grammar 本质是状态机，跨行状态编码在不可变链表栈 |
| 解释器 | `highlight.rs:909` | tree-sitter query 定义"程序"，QueryCursor 解释执行 |
| 缓存 | `grammar_core.rs:73` scanner_cache、`theme.rs:107` Theme cache、`tree_sitter_parser.rs:13` query_cache | 惰性编译 Oniguruma 正则、缓存 scope→trie 匹配，避免重复 |
| Trait 抽象 | `tokenizer/contracts.rs` GrammarRuntime/StateStack/TokenSink | 解耦 tokenizer 热路径与 grammar 实现，可独立测试 |
| 不可变链表 + Flyweight | StateStackImpl/AttributedScopeStack | push 共享 parent 子树，O(1) |
| Stack Diff | `diff_state_stacks.rs` | worker↔UI 线程栈同步的最小 pop/push 操作 |

## 模块间交互

`sidex-textmate` **自带完整 theme 子系统**（`theme.rs` + `theme/` 目录），不依赖外部 `sidex-theme` crate——`Registry` 持 `Theme`，`Grammar` 经 `Registry::theme_match` 访问。`commands/theme.rs` 是独立的编辑器全局颜色主题模块（不同层面）。`sidex-syntax` 不依赖 `sidex-textmate`；两者间接联系是都把 `sidex-text` 当共享基础（TextMate 不直接依赖，syntax 用 `Buffer` 的 Rope + `to_input_edit`）。`sidex-syntax/textmate.rs` 自带简化 TextMate fallback（`fancy_regex`，无 Oniguruma 依赖，不需 theme/packed metadata）。`sidex-textmate` 不依赖 `sidex-text`。命令层 `TextMateStore` 被 Monaco 经前端 `NativeTextMate` bridge 消费。

## 扩展方式

**新增一种语言的 TextMate grammar**：前端获取 `.tmLanguage.json` → `NativeTextMate.loadGrammar({scopeName, grammarJson, ...})` → 后端 `textmate_load_grammar` 解析 JSON → `Registry::add_grammar` → `Grammar::new` 编译规则树（`RuleFactory` 处理 Match/BeginEnd/BeginWhile/Include/Capture）。无需改后端代码。

**新增 tree-sitter 语言支持**：在 `syntax.rs:rust_highlight_config()` 旁加新语言 `HighlightConfig`（需 `tree_sitter_xxx` crate + highlight query 字符串）→ `syntax_tokenize` match 加分支 → 可选 `language.rs::builtin_language_configurations` 加语言配置 → 可选注册 `TreeSitterManager`。注意目前只硬编码了 Rust。

**修改主题颜色映射**：前端收集 `ThemeSettingPayload` → `NativeTextMate.updateTheme(settings, colorMap?)` → 后端 `Theme::create_from_raw` → `parse_theme`（展开逗号列表）→ `resolve_parsed_theme_rules`（排序、提默认、建 trie）→ `Registry::set_theme` → 返回 color_map。已编译 grammar 的 scanner cache 不受影响。
