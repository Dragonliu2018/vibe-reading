---
source:
  type: "源码解读"
  project: "TiDB"
  url: "https://github.com/pingcap/tidb"
title: "SQL 解析器"
date: "2026-09-28T10:20:11+08:00"
category: [Database, HTAP, TiDB, CodeWiki, "master-2026-08"]
contentType: "CodeWiki"
tags: ["TiDB", "Go", "Parser"]
description: "TiDB SQL 解析器解读：goyacc LALR 文法、Scanner 词法消歧、AST Visitor 体系与 driver 依赖注入"
readingTime: "18 min"
aiModel: "Claude Opus 5.5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/HTAP/TiDB/CodeWiki/master-2026-08/00-overview)

---

## 模块定位

`pkg/parser/` 把 SQL 文本编译为 `[]ast.StmtNode`。它是整个 SQL 内核的地基，也是**依赖方向最干净的模块**：作为独立 go module（自带 `pkg/parser/go.mod`），不 import 任何上层包——planner、executor、session 全部单向依赖它。除了文法本身，它还承载三件常被低估的事：MySQL 兼容性的第一道防线（SQL mode、字符集、错误码）、optimizer hint 的独立子文法（`hintparser.y`），以及 charset/collation 注册表（`pkg/parser/charset`）——放这里是为了让 types/executor 零成本引用而不产生环依赖。

## 模块架构

```
pkg/parser/
├── lexer.go            # Scanner：手写状态机 + 三级关键字前瞻
├── yy_parser.go        # Parser 外壳：ParseSQL 入口、cache 对象池
├── parser.y            # 17969 行文法（~723 条命名规则），goyacc 生成 parser.go
├── hintparser.y        # optimizer hint 子文法（独立 parser）
├── misc.go             # tokenMap：keyword → token ID
├── keywords.go         # reserved / unreserved 词分类表（go generate 维护）
├── ast/                # 节点定义：ast.go（接口）、dml.go、ddl.go、funcs.go、misc.go
├── charset/            # Charset/Collation 注册表与编码
├── mysql/              # MySQL 常量：errcode.go、const.go（ComXxx 命令表）
├── goyacc/             # TiDB fork 的 goyacc 工具
└── test_driver/        # 测试用 driver 桩（见"driver 注入"）
```

内部三段式：`Scanner`（词法）→ `yyParse` 表驱动（语法）→ 文法动作直接构造 AST 节点（语义绑定）。没有独立的"AST builder"层——文法规则的动作里直接 `&ast.AlterTableStmt{...}`，减少一次中间表示。

## 调用链路

```
Parser.ParseSQL(sql)                          yy_parser.go:188
├─ resetParams / lexer.reset(sql)             # charset.Encoding 复位 + 深度计数清零
├─ yyParse(l, parser)                         # 生成的 LALR 表驱动
│   ├─ Scanner.Lex(*yySymType)                # lexer.go:237
│   │   ├─ scan() 逐字符状态机
│   │   ├─ handleIdent → tokenMap 查关键字      # misc.go:158
│   │   └─ 前瞻消歧：fullJoinType / toTSO /     # lexer.go:268-333
│   │       optionallyEnclosedBy 等
│   └─ 规约动作构造 ast 节点 append 到 result
├─ l.Errors() → (warns, errs)                  # 非致命问题降级为 warning
├─ checkASTDepth(stmt)                         # yy_parser.go:230，防递归爆栈
└─ ast.SetFlag(stmt)                           # 计算表达式特征位
```

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `ParseSQL` in `yy_parser.go:188` | 解析入口，支持多语句 | `params` 携带 charset/SQLMode 等连接级配置 |
| `Scanner.Lex` in `lexer.go:237` | 产出 token + 语义值 | `lastKeyword*` 三级缓存定位 hint 位置 |
| `checkASTDepth` in `yy_parser.go:230` | AST 深度上限 | DoS 防护前置到 parser 层 |
| `hintParser` in `yy_parser.go:102` | `/*+ */` 内的 hint 子文法 | hint 语法与 SQL 文法解耦，独立演进 |
| `(n *SelectStmt) Accept` in `ast/dml.go:1564` | Visitor 遍历入口 | Enter 可跳过子树，Leave 可替换节点 |

<details>
<summary>方法速查表（展开）</summary>

| 方法 | 位置 | 职责 |
| --- | --- | --- |
| `New()` | `yy_parser.go:140` | 构造 Parser（panic 检查 driver 已注入） |
| `ParseOneStmt` | `yy_parser.go:260` | 解析单条语句（Prepare 路径用） |
| `Scanner.AppendWarn` | `lexer.go:155` | 非致命错误降级收集 |
| `updateParenthesesDepth` | `lexer.go` | 括号深度 ≤10000 防 DoS |
| `GetStmtLabel` | `ast/ast.go:159` | 语句打点 label（metrics/binding 用） |
| `NewValueExpr` / `NewParamMarkerExpr` | 函数变量，`ast/ast.go` | driver 注入点（见下） |
| `Node.Restore` | `ast/ast.go:30` | AST → SQL 反生成（binding/normalize 用） |

</details>

## 核心实现

### Scanner：为什么手写词法而不用生成器

MySQL 的词法有一堆"看后面几个 token 才能定类型"的坑：`FULL OUTER JOIN` 要前瞻消歧（`fullJoinType` in `lexer.go:268`）、TiDB 扩展的 `TO TSO`/`ASOF` 同理（`lexer.go:289-333`）。`Scanner` 用 `lastKeyword/lastKeyword2/lastKeyword3` 三级缓存记录最近关键字，据此判定 `/*+ */` 是否是 optimizer hint（是则交给 `hintParser`）以及 version comment `/*!80001 ... */` 的兼容行为。SQL mode（`ANSI_QUOTES`/`PIPES_AS_CONCAT` 等）直接改变词法规则，所以 `Scanner` 持有 `sqlMode mysql.SQLMode` 字段。字符集在词法层就要处理：字面量扫描时经 `convert2Connection`（`lexer.go:173`）做 client → connection 编码转换，失败降级为 warning——这就是 Warn 机制存在的原因（`Errors()` in `lexer.go:96` 返回 `(warns, errs)` 双列表）。

### AST：接口层次与 Visitor 契约

```go
// pkg/parser/ast/ast.go
Node (ast.go:28)                    // Restore / Accept / Text / SetOriginTextPosition
 ├─ ExprNode (ast.go:69)            // + FieldType + Flag（特征位）
 │   └─ FuncNode
 └─ StmtNode (ast.go:106)           // + statement()
     ├─ DDLNode / DMLNode / SensitiveStmtNode（SecureText 隐藏密码）
```

每个节点手写 `Accept`（如 `(n *SelectStmt) Accept` in `ast/dml.go:1564`）：先 `v.Enter`，返回 skip 则不递归直接 `Leave`；否则按依赖序递归子节点。关键契约：**Leave 阶段允许把节点替换成不同类型**（接口注释 `ast.go:151-153`）——planner 的表达式改写（常量折叠、类型推导后的重写）依赖这一点。`SelectStmt`（`ast/dml.go:1249`）的 `QueryBlockOffset` 字段用于把 hint 关联到正确的查询块，`InsertStmt`（`dml.go:2405`）的 `RowAlias` 支持 MySQL 8.0.19 行别名语法——AST 节点字段就是"MySQL 兼容性面"的直接体现。

### driver 注入：parser 不依赖 types

`ast.NewValueExpr` 和 `ast.NewParamMarkerExpr` 是**函数变量**（不是普通函数），真实实现在 `pkg/types/parser_driver/value_expr.go:45` 注入。这样 parser 作为独立 module 不必 import types/求值逻辑，测试时可用 `pkg/parser/test_driver` 的桩替换。代价是 `New()` 构造时会 panic 检查 driver 是否已注册（`yy_parser.go:140`）——忘了 import 真实 driver 就启动失败，宁可 fail fast。

### SQL 指纹：normalize 与 digest

与 Restore 同属"AST 反向输出"家族的还有 SQL 指纹：`Normalize` 与 `DigestHash`（`pkg/parser/digester.go`）把任意 SQL 压成规范形式 + 固定 digest——这是 SPM（`MatchSQLBinding`）、statement summary、plan digest 的公共基础。规范化规则里最能体现取舍的三条：optimizer hint 整体丢弃（`reduceOptimizerHint`，保证 hint 不影响绑定匹配）、`force/ignore index` 与 `straight_join` 等改写去除（语义归一）、普通字面量压成 `?` 且 **IN 列表整体压成一个占位符**（`replaceSingleLiteralWithInList`，`IN (1,2,3)` 与 `IN (4,5)` 指纹相同——绑定能同时命中两种写法）。

### 扩展语法与 feature 门控

TiDB 扩展（`AUTO_RANDOM`、`PLACEMENT`、`TTL` 等）的开关不在文法里，而集中在 `pkg/parser/tidb/features.go` 的 `FeatureIDAutoRandom` 等常量，供 `CanParseFeature` 做版本兼容过滤——parser 能"认"语法但由上游决定是否"允许"。MySQL 协议错误码与命令常量表（`ComQuery` 等）放在 `pkg/parser/mysql/const.go`，是 server 包 dispatch 的依据——协议常量与解析器同源，避免两处维护。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| Visitor + Accept | `ast.go:145` 的 `Visitor` + 各节点 `Accept` | 预处理/名字解析/改写都以遍历器实现，与节点定义解耦 |
| Driver / 依赖注入 | `ast.NewValueExpr` 函数变量 + `parser_driver` | 切断 parser → types 依赖，保持独立 module |
| 两级 parser | `hintParser` in `yy_parser.go:102` | hint 语法独立演进，不膨胀主文法 |
| 对象池 | `Parser.cache []yySymType` in `yy_parser.go:109` | yyParse 临时对象复用，减少高频解析的分配 |

## 模块间交互

被 import：`pkg/planner`（Preprocess、PlanBuilder）、`pkg/executor`（adapter 打点）、`pkg/session`（Parse）、`pkg/server`（经 session 的 Parse）。parser 自身不 import 上层。AST 流向 planner 的路径：`Optimize` in `pkg/planner/optimize.go:973` 先调 `core.Preprocess`（`pkg/planner/core/preprocess.go:128`）做名字解析——**注意预处理不在 parser 里**，因为名字解析需要 sessionctx（当前 DB、系统变量、InfoSchema），parser 是无会话的纯函数模块，掺入会破坏依赖方向。

## 扩展方式

新增一条 SQL 语法的完整步骤见概览「典型修改场景 1」。要点：只改 `parser.y` + `ast/` 两处；生成文件 `parser.go` 永不手改（`pkg/parser/Makefile` 的 `make parser` 跑 `bin/goyacc`）；unreserved keyword 要同步 `keywords.go` 并 `go generate ./genkeyword`。
