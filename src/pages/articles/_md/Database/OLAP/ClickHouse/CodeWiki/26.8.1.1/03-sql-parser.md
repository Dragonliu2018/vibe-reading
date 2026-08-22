---
source:
  type: "源码解读"
  project: "ClickHouse"
  url: "https://github.com/ClickHouse/ClickHouse"
title: "SQL 解析器"
date: "2026-08-22T15:50:10+08:00"
category: [Database, OLAP, ClickHouse, CodeWiki, "26.8.1.1"]
tags: ["ClickHouse", "Parser", "Lexer", "AST", "递归下降"]
description: "ClickHouse 手写递归下降 SQL 解析器源码解读——Lexer 零拷贝 Token、IParserBase 回溯框架、IAST 组合树。"
readingTime: "25 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> [← 返回概览](/vibe-reading/articles/Database/OLAP/ClickHouse/CodeWiki/26.8.1.1/00-overview)

---

## 模块定位

`src/Parsers/` 是手写递归下降 SQL 解析器，把 SQL 文本 → AST（抽象语法树）。它独立成模块因为解析是纯结构映射——不做语义分析、无副作用，输出 AST 供下游 Analyzer 消费。模块单向依赖（上层 import Parsers，不反向），便于独立测试与演进。

## 模块架构

```text
src/Parsers/
  ├─ Lexer.h/.cpp          ── 词法分析（逐字符状态机 switch）
  ├─ IParser.h             ── IParser 基类 + Pos（带深度/回溯计数的迭代器）
  ├─ IParserBase.h/.cpp    ── 递归下降辅助基类（wrapParseImpl 回退）
  ├─ ParserQuery.h/.cpp    ── Parser 聚合类（|| 短路链尝试所有语句）
  ├─ parseQuery.h/.cpp     ── parseQuery 入口（Token 懒加载+错误处理）
  ├─ IAST.h                ── AST 节点基类（children 向量 + intrusive_ptr）
  ├─ ASTSelectQuery.h      ── SELECT 节点（Expression 枚举+positions map）
  ├─ ASTFunction.h         ── 函数/运算符节点
  └─ AST*.h                ── 数十种 AST 节点
```

## 调用链路

```text
parseQuery(parser, query, ...) in parseQuery.cpp
  └─ parseQueryAndMovePosition → tryParseQuery
     ├─ Tokens tokens(begin, end, ...)          ── 持有 Lexer，懒加载 Token
     ├─ IParser::Pos iterator(tokens, max_depth, max_backtracks)
     └─ parser.parse(pos, res, expected)
        └─ ParserQuery::parseImpl in ParserQuery.cpp:49
           └─ IParserBase::parse → wrapParseImpl(IncreaseDepth, [...]{ parseImpl })
              ├─ ParserQueryWithOutput::parse → ParserSelectQuery::parseImpl
              │  ├─ ParserKeyword("SELECT").ignore
              │  ├─ ParserExpressionList::parseImpl → ParserList::parseUtil
              │  │  └─ ParserExpression::parseImpl
              │  │     └─ ParserLeftAssociativeBinaryOperatorList::parseImpl（优先级递归下降）
              │  └─ ParserTablesInSelectQuery::parse
           └─ 失败则 pos 回退，尝试下一个语句解析器（|| 链）
```

<details>
<summary>方法速查表</summary>

| 方法 | 一行职责 | 关键设计决策 |
| --- | --- | --- |
| `Lexer::nextTokenImpl` in `Lexer.cpp:127` | 逐字符分词 | 巨型 switch 状态机 |
| `IParserBase::parse` in `IParserBase.cpp:7` | 模板方法骨架 | wrapParseImpl 失败回退 pos |
| `ParserQuery::parseImpl` in `ParserQuery.cpp:49` | 尝试所有语句解析 | \|\| 短路链 |
| `IAST::format` in `IAST.h` | AST→SQL 文本 | format-parse round-trip |
| `IAST::as<Derived>` via `TypePromotion` | 安全向下转型 | typeid_cast 比 dynamic_cast 快 |

</details>

## 核心实现

### Lexer：零拷贝 Token

```cpp title="src/Parsers/Lexer.h"
struct Token {
    TokenType type;
    const char * begin;    // 指向原始查询字符串
    const char * end;      // 不拷贝字符串，零开销
    bool isSignificant() const;
    bool isError() const { return type > EndOfStream; }  // 错误 Token 在枚举末尾
};
class Lexer {
    Token nextTokenImpl();   // 逐字符 switch 状态机
    TokenType prev_significant_token_type;  // 消歧 . 是元组访问还是浮点数
};
```

TokenType 用 X-macro `APPLY_FOR_TOKENS(M)` 同时定义枚举、`getTokenName`、`getErrorTokenDescription`，避免三处不同步。关键字与标识符合并为 `BareWord`（区分推迟到 Parser 的 `ParserKeyword`）。`Tokens` 懒加载——不需要预扫描全部 Token。

### IParserBase：回退式递归下降框架

```cpp title="src/Parsers/IParserBase.h"
class IParserBase : public IParser {
    template <typename F>
    static bool wrapParseImpl(Pos & pos, const F & func) {
        Pos begin = pos;                    // 记录起点
        bool ok = func();
        if (!ok) pos = begin;               // 失败回退（PEG 风格）
        return ok;
    }
    bool parse(Pos & pos, ASTPtr & node, Expected & expected) override;  // 模板方法
protected:
    virtual bool parseImpl(Pos & pos, ASTPtr & node, Expected & expected) = 0;
};
```

`parse()` 固定流程：add expected → increaseDepth → parseImpl → decreaseDepth → 回退或高亮。`Pos` 持 `depth`（递归深度，超限抛 `TOO_DEEP_RECURSION`）与 `backtracks`（回退次数，超限抛 `TOO_SLOW_PARSING`）——防恶意查询 DoS。

运算符优先级通过 parser 嵌套层次表达：`ParserLeftAssociativeBinaryOperatorList`（`ExpressionListParsers.h:171`）先解析操作数再循环匹配运算符，`ParserExpression` 按优先级从低到高依次委托。

### IAST：侵入式引用计数组合树

```cpp title="src/Parsers/IAST.h"
class IAST : public TypePromotion<IAST> {
    ASTs children;                          // 子节点向量（组合模式）
    mutable std::atomic<UInt32> ref_counter;  // 侵入式引用计数
    virtual String getID(char delimiter) const = 0;
    virtual ASTPtr clone() const = 0;
    template <typename T> void set(T * & field, const ASTPtr & child);  // 同时存 children 与裸指针
};
using ASTPtr = boost::intrusive_ptr<IAST>;  // 比共享 ptr 省 16 字节/节点
```

`children` 统一存放子节点，AST 子类还可有裸指针成员指向 children 元素（如 `ASTSelectQuery::positions` map 索引）。`TypePromotion::as<Derived>()` 用 `typeid_cast`（type_info 指针比较，不走完整 RTTI 链）做安全向下转型——消费端用 `query->as<ASTSelectQuery>()` 分派，而非经典 Visitor。

```cpp title="src/Parsers/ASTSelectQuery.h"
class ASTSelectQuery : public IAST {
    enum class Expression : uint8_t { WITH, SELECT, TABLES, WHERE, GROUP_BY, HAVING,
        WINDOW, ORDER_BY, LIMIT_BY, LIMIT, SETTINGS, INTERPOLATE, ... };
    std::unordered_map<Expression, size_t> positions;  // Expression→children 索引
};
```

`ASTFunction` 用位域 `ASTFunctionFlags` 复用 `IAST::flags_storage`，运算符也是 ASTFunction（`is_operator=true`，如 `a+b` → `ASTFunction{name="plus"}`）。

## 设计模式

| 模式 | 位置 | 为什么用 |
| --- | --- | --- |
| 组合 | `IAST::children` | AST 树统一遍历 |
| 模板方法 | `IParserBase::parse`→`parseImpl` | 骨架固定，回退自动 |
| 递归下降 | 运算符优先级嵌套 | 优先级由层次表达 |
| 非经典访问者 | `TypePromotion::as<>` | 比 Visitor 少模板代码，务实 |
| 策略 | `Expected` 错误收集 | 到达最远位置的期望变体 |

## 扩展方式

新增 SQL 语法（如 `SAMPLE` 新变体）：在 `CommonParsers.h` 的 `APPLY_FOR_PARSER_KEYWORDS` 加关键字；`ParserSelectQuery::parseImpl` 加 `ignore` 与参数解析；`ASTSelectQuery::Expression` 加子句枚举；`formatImpl` 加格式化输出。新增语句类型：建 `ASTNewQuery.h` + `ParserNewQuery.h`，在 `ParserQuery::parseImpl` 的 `||` 链加调用，在 `InterpreterFactory::get` 加 `as<ASTNewQuery>` 分支。

## 模块间交互

Parsers 只依赖 `Core`、`Common`（Exception、TypePromotion）、`IO`（WriteBuffer）。上层 `InterpreterFactory` import 大量 `AST*.h` 用 `as<>()` 分派；`QueryTreeBuilder`（`src/Analyzer/QueryTreeBuilder.cpp`）遍历 AST 转换为 QueryTree。AST 通过 `as<>()` 在 InterpreterFactory 与 QueryTreeBuilder 两处分派。`splitMultipartQuery` 按 `;` 分割多语句，`formatWithPossiblyHidingSensitiveData` 做 format-parse round-trip。
