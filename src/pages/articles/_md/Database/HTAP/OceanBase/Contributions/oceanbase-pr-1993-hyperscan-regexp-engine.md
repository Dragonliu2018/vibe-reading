---
title: "引入 Hyperscan 作为可选正则表达式引擎"
source:
  project: "OceanBase"
  type: "PR"
  id: "1993"
  url: "https://github.com/oceanbase/oceanbase/pull/1993"
  prType: "feat"
date: "2026-08-05T17:00:00+08:00"
category: [Database, HTAP, OceanBase, Contributions]
tags: ["OceanBase", "Hyperscan", "Regex", "ICU", "C++", "ClickBench"]
description: "新增 Hyperscan 作为 ICU 之外的可选正则引擎，通过 tenant 级参数 regexp_engine 切换，REGEXP/REGEXP_COUNT/REGEXP_INSTR/REGEXP_LIKE/REGEXP_REPLACE/REGEXP_SUBSTR 六个表达式均可受益。"
readingTime: "16 min"
aiModel: "Claude Opus 5"
reviewed: false
---

> **PR** [#1993](https://github.com/oceanbase/oceanbase/pull/1993) · **Issue** [#1992](https://github.com/oceanbase/oceanbase/issues/1992) · **commit** - · **首发版本** - · **变更行数** +7850 行 · **合并时间** -

> ⚠️ 本 PR 在 GitHub 上显示为 CLOSED（未直接 merge），但代码通过内部 `[FEAT MERGE] [433] sql execution improvements` 合入 master。commit hash 和合并时间取自内部 merge，此处留空。

---

## 背景

OceanBase 原有的正则表达式引擎是 **ICU**（International Components for Unicode）。ICU 功能全面、兼容性好，但在高性能分析场景下性能不足。Issue [#1992](https://github.com/oceanbase/oceanbase/issues/1992) 指出，ClickBench 的 Q29 查询受制于 ICU 的 `REGEXP_REPLACE` 性能：

```sql title="ClickBench Q29 — REGEXP_REPLACE 是瓶颈"
SELECT REGEXP_REPLACE(Referer, '^https?://(?:www\.)?([^/]+)/.*$', '\1') AS k,
       AVG(length(Referer)) AS l, COUNT(*) AS c, MIN(Referer)
  FROM hits WHERE Referer <> ''
  GROUP BY k HAVING COUNT(*) > 100000 ORDER BY l DESC LIMIT 25;
```

**Hyperscan** 是 Intel 开源的高性能正则表达式库，专为网络流量深度检测设计，在特定 pattern（尤其是简单、高频的正则）上性能远超 ICU。但 Hyperscan 和 ICU 并非完全兼容——某些正则特性（如 `u`/`x` flag、multiline 处理）Hyperscan 支持不完善。

因此不能直接用 Hyperscan 替换 ICU，而需要**让用户按需选择引擎**。本 PR 的方案是新增 tenant 级参数 `regexp_engine`，默认 `ICU`，可切换为 `Hyperscan`：

```sql title="切换正则引擎"
ALTER SYSTEM SET regexp_engine = 'ICU';        -- 默认，兼容性优先
ALTER SYSTEM SET regexp_engine = 'Hyperscan';  -- 性能优先
```

---

## 前置知识

### ICU 正则引擎

ICU 是成熟的 Unicode 正则库，支持完整的正则语法（包括 `u` 扩展模式、`x` 忽略空白、multiline 等）。OceanBase 的 `ObExprRegexpContext` 封装了 ICU 的 `uregex_*` API：

| ICU API | OceanBase 封装 |
| --- | --- |
| `uregex_open` | `ObExprRegexpContext::init` |
| `uregex_matches` | `ObExprRegexpContext::match` |
| `uregex_find` / `uregex_start` / `uregex_end` | `ObExprRegexpContext::find` |
| `uregex_replaceAll` | `ObExprRegexpContext::replace` |

### Hyperscan 正则引擎

Hyperscan 采用**编译-执行**两阶段模型：

| 阶段 | API | 产出 |
| --- | --- | --- |
| 编译 | `hs_compile` | `hs_database_t*`（编译后的正则数据库） |
| 分配 | `hs_alloc_scratch` | `hs_scratch_t*`（扫描用的临时内存） |
| 扫描 | `hs_scan` | 通过回调函数逐个返回匹配 |

与 ICU 的"直接调用即返回结果"不同，Hyperscan 的 `hs_scan` 通过**回调函数**通知每个匹配——调用者需要在回调中收集匹配位置。这一差异是封装层的主要复杂度来源。

### 受影响的正则表达式

OceanBase 中有六个正则表达式 operator，本 PR 为它们全部增加了 Hyperscan 支持：

| 表达式 | 功能 | ICU 方法 | Hyperscan 方法 |
| --- | --- | --- | --- |
| `REGEXP` / `RLIKE` | 是否匹配 | `match` | `ObExprHsRegexCtx::match` |
| `REGEXP_COUNT` | 匹配次数 | `count` | `ObExprHsRegexCtx::count` |
| `REGEXP_INSTR` | 匹配位置 | `find` | `ObExprHsRegexCtx::find` |
| `REGEXP_LIKE` | 是否匹配（带 match_param） | `match` | `ObExprHsRegexCtx::match` |
| `REGEXP_REPLACE` | 替换 | `replace` | `ObExprHsRegexCtx::replace` |
| `REGEXP_SUBSTR` | 提取子串 | `substr` | `ObExprHsRegexCtx::substr` |

---

## 实现

### 参数配置：tenant 级引擎选择

新增 tenant 级参数 `regexp_engine`，通过 `ObConfigRegexpEngineChecker` 校验取值：

```cpp title="src/share/parameter/ob_parameter_seed.ipp"
// regexp engine
DEF_STR_WITH_CHECKER(regexp_engine, OB_TENANT_PARAMETER, "ICU",
                     common::ObConfigRegexpEngineChecker,
                     "specifies the regexp engine. Values: "
                     "ICU(International Components for Unicode), Hyperscan",
                     ObParameterAttr(Section::TENANT, Source::DEFAULT, EditLevel::DYNAMIC_EFFECTIVE));
```

```cpp title="src/share/config/ob_config_helper.h"
class ObConfigRegexpEngineChecker : public ObConfigChecker {
public:
    bool check(const ObConfigItem &t) const;  // 校验值为 "ICU" 或 "Hyperscan"
};
```

Session 中通过 `enable_hyperscan_regexp_engine_` 标志位缓存当前选择，避免每行执行时重复解析字符串：

```cpp title="src/sql/session/ob_basic_session_info.cpp"
inf_pc_configs_.enable_hyperscan_regexp_engine_ = false;  // 默认关闭（用 ICU）

bool ObBasicSessionInfo::get_enable_hyperscan_regexp_engine() const {
    return inf_pc_configs_.enable_hyperscan_regexp_engine_;
}
```

### 引擎选择：代码生成时分流

引擎选择发生在**代码生成阶段**（`cg_expr`），而非执行阶段——根据 session 参数选择不同的 `eval_func_`：

```cpp title="src/sql/engine/expr/ob_expr_regexp.cpp — cg_expr"
int ObExprRegexp::cg_expr(ObExprCGCtx &op_cg_ctx, const ObRawExpr &raw_expr, ObExpr &rt_expr) const {
    // ...
    const bool is_support_hs = op_cg_ctx.session_->get_enable_hyperscan_regexp_engine();
    rt_expr.eval_func_ = is_support_hs ? eval_hs_regexp : eval_regexp;
}
```

这种设计的优势：引擎选择在 plan 编译时确定，执行时直接调用对应的 eval 函数，无额外分支开销。切换引擎后需要重新生成 plan（通过 plan cache 失效机制处理）。

### ObExprHsRegexCtx：Hyperscan 封装

核心新增类，封装 Hyperscan 的编译-扫描-回调模型为 OceanBase 风格的同步 API。

#### 类结构

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.h"
class ObExprHsRegexCtx : public ObExprOperatorCtx {
public:
    int init(ObExprStringBuf &string_buf, const ObString &origin_pattern,
             const uint32_t flags, const bool reusable, const ObCollationType cs_type);
    int match(ObExprStringBuf &string_buf, const ObString &text,
              const int64_t start, bool &result) const;
    int find(ObExprStringBuf &string_buf, const ObString &text,
             const int64_t start, const int64_t occurrence,
             const int64_t return_option, int64_t &result) const;
    int count(ObExprStringBuf &string_buf, const ObString &text,
              const int32_t start, int64_t &result) const;
    int substr(ObExprStringBuf &string_buf, const ObString &text,
               const int64_t start, const int64_t occurrence, ObString &result) const;
    int replace(ObExprStringBuf &string_buf, const ObString &text_string,
                const ObString &replace_string, const int64_t start,
                const int64_t occurrence, ObString &result) const;
private:
    struct MatchInfo {
        int32_t from_;   // 匹配起始位置
        int32_t to_;     // 匹配结束位置
    };
    bool inited_;
    ObString pattern_;
    uint32 hs_flags_;
    hs_database_t *hs_db_;           // 编译后的正则数据库
    hs_scratch_t *hs_scratch_;       // 扫描用的临时内存
    hs_compile_error_t *hs_compile_err_;
};
```

#### init：编译正则

`init` 调用 `hs_compile` 将 pattern 编译为 `hs_database_t`，再分配 `hs_scratch_t`：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — init"
int ObExprHsRegexCtx::init(ObExprStringBuf &string_buf, const ObString &origin_pattern,
                           const uint32_t flags, const bool reusable, const ObCollationType cs_type) {
    // 非 UTF8MB4 的 pattern 需先转换 collation
    if (CS_TYPE_UTF8MB4_BIN != cs_type && CS_TYPE_UTF8MB4_GENERAL_CI != cs_type) {
        ObExprUtil::convert_string_collation(origin_pattern, cs_type, origin_pattern_utf8, ...);
    }
    // 可复用且 pattern 未变 → 直接复用上次编译结果
    if (reusable && inited_ && pattern_ == pattern && hs_flags_ == flags) {
        return OB_SUCCESS;
    }
    // 复制 pattern 到 string_buf（保证生命周期）
    char *pattern_save = static_cast<char *>(string_buf.alloc(pattern.length() + 1));
    MEMCPY(pattern_save, pattern.ptr(), pattern.length());
    pattern_save[pattern.length()] = '\0';

    // 编译正则
    if (hs_compile(pattern_save, hs_flags_, HS_MODE_BLOCK, nullptr,
                   &hs_db_, &hs_compile_err_) != HS_SUCCESS) {
        ret = OB_ERR_UNEXPECTED;
    } else if (hs_alloc_scratch(hs_db_, &hs_scratch_) != HS_SUCCESS) {
        hs_free_database(hs_db_);
    } else {
        inited_ = true;
    }
}
```

`reusable` 机制：当 `expr_ctx_id_` 有效时（plan 可复用），`ObExprHsRegexCtx` 存储在 `exec_ctx` 中跨行复用。如果 pattern 和 flags 未变，跳过重新编译——对同一 pattern 处理大量行的场景（如 Q29 的 `REGEXP_REPLACE`），避免每行重新编译。析构时 `destroy` 调用 `hs_free_scratch` 和 `hs_free_database` 释放 Hyperscan 资源，`reset` 方法在 pattern 变化时先 destroy 再重新 init。

#### get_hs_regexp_flags：flag 映射

MySQL/OceanBase 的 match_param（`c`/`i`/`m`/`n`/`u`/`x`）需要映射到 Hyperscan 的 flags：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — get_hs_regexp_flags"
int ObExprHsRegexCtx::get_hs_regexp_flags(const ObString &match_param,
        const bool is_case_sensitive, const bool is_som_leftmost,
        const bool is_single_match, uint32_t &flags) {
    flags = HS_FLAG_ALLOWEMPTY | HS_FLAG_UTF8;
    flags |= is_case_sensitive ? 0 : HS_FLAG_CASELESS;
    flags |= is_som_leftmost ? HS_FLAG_SOM_LEFTMOST : 0;
    flags |= is_single_match ? HS_FLAG_SINGLEMATCH : 0;
    for (char c : match_param) {
        switch (c) {
            case 'c': flags &= ~HS_FLAG_CASELESS; break;   // 大小写敏感
            case 'i': flags |= HS_FLAG_CASELESS; break;    // 大小写不敏感
            case 'm': flags |= HS_FLAG_MULTILINE; break;   // 多行（Hyperscan 支持不完善）
            case 'n': flags |= HS_FLAG_DOTALL; break;      // . 匹配换行
            case 'u': case 'x':
                return OB_INVALID_ARGUMENT;  // Hyperscan 不支持 u/x flag
        }
    }
}
```

| match_param | ICU | Hyperscan | 兼容性 |
| --- | --- | --- | --- |
| `c` / `i` | ✓ | ✓ | 完全兼容 |
| `m` | ✓ | ⚠️ 支持但不完善 | 部分兼容 |
| `n` | ✓ | ✓ | 完全兼容 |
| `u` / `x` | ✓ | ✗ 不支持 | **不兼容** |

不兼容的 flag（`u`/`x`）直接返回 `OB_INVALID_ARGUMENT`，提示用户切换回 ICU。

#### match：是否匹配

最简单的方法——只需知道是否匹配，回调中设置 `result = true` 即可：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — match"
int ObExprHsRegexCtx::match(..., const ObString &text, const int64_t start, bool &result) const {
    result = false;
    hs_error_t status = hs_scan(
        hs_db_, text.ptr() + start, text.length() - start, 0, hs_scratch_,
        [](unsigned int id, unsigned long long from, unsigned long long to,
           unsigned int flags, void *ctx) -> int {
            *static_cast<bool *>(ctx) = true;   // 找到一个匹配即可
            return 0;                           // 终止扫描
        },
        &result);
    return check_hs_regexp_status(status);
}
```

回调返回 0 后 Hyperscan 会**终止扫描**——对于"是否匹配"的判断，找到一个就够。`HS_FLAG_SINGLEMATCH` flag 也会让 Hyperscan 在第一个匹配后自动停止。

#### find / count / substr：收集匹配链

这三个方法需要**所有匹配的位置信息**，通过 `MatchChain`（`ObSEArray<MatchInfo, 16>`）在回调中收集：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — 回调（find/count/substr 共用）"
[](unsigned int id, unsigned long long from, unsigned long long to,
   unsigned int flags, void *ctx) -> int {
    MatchChain *chain = static_cast<MatchChain *>(ctx);
    if (chain->empty()) {
        chain->push_back(MatchInfo(from, to));           // 第一个匹配
    } else if (chain->at(chain->count() - 1).from_ == from) {
        chain->at(chain->count() - 1).to_ = to;           // 同一起点的多个匹配，取最长
    } else if (chain->at(chain->count() - 1).to_ <= from) {
        chain->push_back(MatchInfo(from, to));            // 新的非重叠匹配
    }
    return 1;  // 继续扫描
}
```

回调逻辑处理三种情况：

| 条件 | 处理 | 原因 |
| --- | --- | --- |
| `chain` 为空 | 直接 push | 第一个匹配 |
| 前一个匹配的 `from_` == 当前 `from` | 更新 `to_` | 同一起点可能有多个匹配（Hyperscan 的 NFA 特性），取最长的 |
| 前一个匹配的 `to_` <= 当前 `from` | push 新匹配 | 非重叠的新匹配 |

注释中的例子：pattern `[a-z]{2}` 对文本 `abc` 会匹配 `ab`（from=0）和 `bc`（from=1）。`bc` 的 from=1 < `ab` 的 to=2，属于重叠——被排除。这保证了 `REGEXP_COUNT` 和 `REGEXP_SUBSTR` 的语义与 ICU 一致（非重叠计数）。

收集完匹配链后，三个方法各自的逻辑：

* **`count`**：`result = match_infos.count()`
* **`find`**（REGEXP_INSTR）：`result = return_option ? end_pos : start_pos`（返回第 occurrence 个匹配的起始或结束位置）
* **`substr`**：从 `match_infos.at(occurrence - 1)` 取 `from_`/`to_`，从 text 中截取子串

#### replace：分段拼接

`replace` 最复杂——需要将匹配段替换为 replace_string，非匹配段保留。分两步：先计算结果长度，再拼接：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — replace（核心逻辑）"
// occurrence == 0：替换所有匹配
if (occurrence == 0) {
    for (int i = 0; i < match_infos.count(); i++) {
        match_infos.at(i).from_ += start;   // 修正偏移
        match_infos.at(i).to_ += start;
        res_len += match_infos.at(i).from_ - last_to;       // 匹配前的原文
        res_len += replace_string.length();                  // 替换串
        last_to = match_infos.at(i).to_;
    }
}
// occurrence > 0：只替换第 occurrence 个匹配
else if (occurrence <= match_infos.count()) {
    match_infos.at(occurrence - 1).from_ += start;
    match_infos.at(occurrence - 1).to_ += start;
    res_len += match_infos.at(occurrence - 1).from_;         // 匹配前的原文
    res_len += replace_string.length();
    last_to = match_infos.at(occurrence - 1).to_;
}
res_len += text_string.length() - last_to;   // 尾部原文

// 第二步：按计算的长度分配内存，拼接结果
// [原文段][替换串][原文段][替换串]...[原文段]
```

> **TODO**：PR 中注释 `// TODO: get_valid_replace_string like icu`——Hyperscan 的 replace 尚未完全对齐 ICU 对替换串中反向引用（`\1`/`\2`）的处理。这是 Hyperscan 不完全兼容 ICU 的一个具体体现。

### collation 转换

Hyperscan 仅支持 UTF-8 输入。当 text 或 pattern 的 collation 不是 `UTF8MB4_BIN` / `UTF8MB4_GENERAL_CI` 时（如 UTF16），需要先转换：

```cpp title="src/sql/engine/expr/ob_expr_util.cpp — convert_string_collation"
int ObExprUtil::convert_string_collation(const ObString &in_str, const ObCollationType &in_collation,
        ObString &out_str, const ObCollationType &out_collation, ObIAllocator &alloc) {
    if (charset_type_by_coll(in_collation) == charset_type_by_coll(out_collation)) {
        out_str = in_str;   // 同 charset，无需转换
    } else {
        char *buf = static_cast<char *>(alloc.alloc(in_str.length() * CharConvertFactorNum));
        ObCharset::charset_convert(in_collation, in_str.ptr(), in_str.length(),
                                   out_collation, buf, buf_len, result_len);
        out_str.assign_ptr(buf, result_len);
    }
}
```

---

## 测试

### 回归测试

新增 6 个 mysql_test 套件，覆盖六个正则表达式的 Hyperscan 实现：

| 测试文件 | 覆盖表达式 | 行数 |
| --- | --- | --- |
| `expr_regexp_hyperscan.test` | Hyperscan 引擎切换 + 全表达式 | +209 |
| `expr_regexp_count.test` | `REGEXP_COUNT` | +258 |
| `expr_regexp_instr.test` | `REGEXP_INSTR` | +281 |
| `expr_regexp_like.test` | `REGEXP_LIKE` | +247 |
| `expr_regexp_replace.test` | `REGEXP_REPLACE` | +389 |
| `expr_regexp_substr.test` | `REGEXP_SUBSTR` | +269 |

对应的 `.result` 文件共 +4354 行，验证 Hyperscan 与 ICU 的输出一致性。`expr_regexp_hyperscan.test` 专门测试引擎切换（`SET regexp_engine = 'Hyperscan'`）和回退（`SET regexp_engine = 'ICU'`）。

---

## 问题

### 为什么不直接替换 ICU

Hyperscan 与 ICU 在以下方面不兼容：

1. **flag 支持**：Hyperscan 不支持 `u`（Unicode 扩展）和 `x`（忽略空白）flag，`m`（multiline）支持不完善
2. **替换串语义**：Hyperscan 的 replace 未完全对齐 ICU 的反向引用处理（`\1`/`\2`），PR 中标注为 TODO
3. **空 pattern**：Hyperscan 不能处理空 pattern（ICU 可以），Oracle 模式下空 pattern 行为不同
4. **错误处理**：Hyperscan 没有 ICU 的 `U_INDEX_OUTOFBOUNDS_ERROR` 等细粒度错误码

因此采用双引擎并存 + 用户选择的方式，默认 ICU 保证兼容性，需要性能时切换 Hyperscan。

### 引擎选择为何在代码生成阶段

`cg_expr` 中根据 `enable_hyperscan_regexp_engine` 选择 `eval_func_`，而非在 `eval_regexp` 中运行时判断。原因：

* **性能**：避免每行执行时的分支判断，编译时确定直接调用
* **plan cache 一致性**：切换引擎后需要重新生成 plan，`ob_plan_cache_util.cpp` 中的改动（+10/-4 行）处理了 plan cache 失效——引擎配置变化时标记 plan 失效，强制重新编译

### MatchChain 的重叠匹配处理

Hyperscan 的 NFA 特性可能对同一起点返回多个匹配（不同长度）。回调中的 `chain->at(count-1).from_ == from` 分支处理这种情况——只保留最长的匹配（更新 `to_`）。而 `to_ <= from` 的检查排除重叠匹配，保证 `REGEXP_COUNT` 的语义是"非重叠匹配次数"，与 ICU 一致。

---

## 意义与影响

| 场景 | PR 前 | PR 后 |
| --- | --- | --- |
| `REGEXP_REPLACE`（Q29） | ICU，性能受限 | 可选 Hyperscan，性能提升 |
| `REGEXP` / `REGEXP_LIKE` | ICU | 可选 Hyperscan |
| `REGEXP_COUNT` / `REGEXP_INSTR` / `REGEXP_SUBSTR` | ICU | 可选 Hyperscan |
| `u`/`x` flag | ICU 支持 | 切换 Hyperscan 后报错（回退 ICU） |
| 引擎切换 | 不支持 | `ALTER SYSTEM SET regexp_engine` 动态切换 |

* **性能收益**：ClickBench Q29 的 `REGEXP_REPLACE` 是主要受益场景。Hyperscan 在简单、高频的正则 pattern 上性能远超 ICU，尤其适合网络日志分析。
* **双引擎并存**：不强制替换 ICU，通过 tenant 参数让用户按场景选择。默认 ICU 保证兼容性，Hyperscan 用于性能敏感场景。不兼容的 flag 明确报错并提示用户切换回 ICU。
* **复用机制**：`ObExprHsRegexCtx` 支持 `reusable` 模式，跨行复用编译结果，避免每行重新 `hs_compile`。对 `REGEXP_REPLACE(Referer, ...)` 这种对大量行应用同一 pattern 的场景至关重要。
* **后续演进**：代码合入后，后续 commit `Add maximum length constrait to pattern of hyperscan` 对 Hyperscan 的 pattern 长度增加了限制（防止超长 pattern 导致编译耗时过长），是本 PR 的配套改进。
* **限制**：Hyperscan 不支持 `u`/`x` flag，`m` flag 支持不完善，replace 的反向引用处理未完全对齐 ICU。这些限制意味着 Hyperscan 不能完全替代 ICU，用户需要根据正则 pattern 的特性选择合适的引擎。

---

## 附录：内部合入后的重构

本 PR 在 GitHub 上显示为 CLOSED，代码通过内部 `[FEAT MERGE] [433] sql execution improvements` 合入 master。合入时并非直接照搬，而是有多处重构和后续修复。

### 条件编译保护

PR 版本的 `ObExprHsRegexCtx` 无条件包含 Hyperscan 头文件，在非 x86 平台会编译失败。合入后增加了 `#if defined(__x86_64__)` 条件编译保护，并在 `#else` 分支提供空类占位：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.h — 合入后增加的条件编译"
#if defined(__x86_64__)
class ObExprHsRegexCtx : public ObExprOperatorCtx {
    // ... 完整实现 ...
};
#else
  // empty class for non-x86 platforms
  class ObExprHsRegexCtx {};
#endif
```

这使得 OceanBase 可以在 ARM 等非 x86 平台上编译——Hyperscan 本身仅支持 x86。后续的 `[FEAT MERGE] Optimize AP benchmark for ARM platform` commit 进一步完善了 ARM 兼容性。

### MAX_PATTERN_LEN 限制

合入后新增 `MAX_PATTERN_LEN = 2000` 常量，在 `init` 中检查 pattern 长度：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — 合入后增加的长度限制"
static const int MAX_PATTERN_LEN = 2000;

// init 中：
} else if (pattern.length() > MAX_PATTERN_LEN) {
    ret = OB_INVALID_ARGUMENT;
    LOG_WARN("pattern is too long, max length is 2000", K(ret));
    LOG_USER_ERROR(OB_INVALID_ARGUMENT,
        "hyperscan regex engine, supported pattern's maximum length is 2000");
}
```

这是后续 commit `Add maximum length constrait to pattern of hyperscan`（作者 Zach41）的独立修复——超长 pattern 会导致 `hs_compile` 编译耗时过长甚至 OOM，2000 字节的限制在性能和安全之间取平衡。

### 回调提取为静态方法

PR 版本中，`hs_scan` 的回调是每个方法内联的 lambda 表达式，逻辑重复（`find`/`count`/`substr`/`replace` 四个方法的回调完全相同）。合入后提取为静态方法 `match_handler`：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.h — 合入后提取的回调"
using MatchChain = common::ObSEArray<MatchInfo, 16>;  // 也提升为类成员 typedef
static int match_handler(unsigned int id, unsigned long long from, unsigned long long to,
                         unsigned int flags, void *ctx);
```

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — match_handler 实现"
int ObExprHsRegexCtx::match_handler(unsigned int id, unsigned long long from,
                                    unsigned long long to, unsigned int flags, void *ctx) {
    MatchChain *chain = static_cast<MatchChain *>(ctx);
    if (chain->empty()) {
        return chain->push_back(MatchInfo(from, to));
    } else if (chain->at(chain->count() - 1).from_ == from) {
        chain->at(chain->count() - 1).to_ = to;       // 同起点取最长
    } else if (chain->at(chain->count() - 1).to_ <= from) {
        return chain->push_back(MatchInfo(from, to));  // 非重叠新匹配
    }
    return OB_SUCCESS;
}
```

四个方法统一调用 `match_handler`，消除了 PR 版本中四处重复的 lambda 代码。`MatchChain` 也从 `.cpp` 中的局部 `using` 提升为类的 `private` typedef。

### 方法签名增强

合入后对方法签名做了多处增强，与 ICU 引擎（`ObExprRegexContext`）保持一致：

| 变化 | PR 版本 | 合入后 | 原因 |
| --- | --- | --- | --- |
| 方法名 | `get_hs_regexp_flags` | `get_regexp_flags` | 去掉 `hs_` 前缀，与 ICU 的 `get_regexp_flags` 对称 |
| init 参数 | 无 `regex_vars` | 增加 `regex_vars` | 预留 stack/time limit 传入（当前 `UNUSED`） |
| match/find/count/substr/replace | 无 `cs_type` | 增加 `cs_type` 参数 | 在方法内部做 collation 转换，而非调用者负责 |
| find/substr | 无 `subexpr` | 增加 `subexpr` 参数 | 支持 Oracle 模式的子表达式（当前 `UNUSED`） |

特别是 `cs_type` 参数的增加，将 collation 转换从调用者移到方法内部，并用 `ObCharset::charpos` 正确处理多字节字符的起始位置：

```cpp title="src/sql/engine/expr/ob_expr_regexp_context.cpp — 合入后的字符位置计算"
// PR 版本：直接用 byte offset
text.ptr() + start

// 合入后：用 charpos 处理多字节字符
int64_t start_pos = ObCharset::charpos(cs_type, text.ptr(), text.length(), start);
text.ptr() + start_pos
```

这修复了 PR 版本中多字节字符（如 UTF-8 中文）的 start 参数按字节而非字符计算的问题。

### 后续 Bug 修复

合入后还有两个独立 bug fix：

* `fix regexp binary match bug`（wangt1xiuyi）：修复 binary collation 下的匹配错误
* `The PDML operator does not call the member's destructor`：修复 PDML 场景下 `ObExprHsRegexCtx` 析构未调用导致 `hs_scratch_t`/`hs_database_t` 内存泄漏

### 重构总结

| 维度 | PR 版本 | 合入 master 后 |
| --- | --- | --- |
| 平台兼容 | 无保护，非 x86 编译失败 | `#if defined(__x86_64__)` + 空类占位 |
| pattern 长度 | 无限制 | `MAX_PATTERN_LEN = 2000` |
| 回调 | 四处重复的内联 lambda | 提取为静态 `match_handler` |
| MatchChain | `.cpp` 局部 typedef | 类成员 typedef |
| 方法名 | `get_hs_regexp_flags` | `get_regexp_flags`（与 ICU 对称） |
| cs_type 处理 | 调用者负责转换 | 方法内部转换 + `charpos` 多字节修正 |
| subexpr | 不支持 | 参数预留（Oracle 模式子表达式） |
| regex_vars | 不支持 | 参数预留（stack/time limit） |

合入时的重构方向是**与 ICU 引擎（`ObExprRegexContext`）接口对齐**——方法名、参数、collation 处理方式保持一致，使得上层表达式（`ob_expr_regexp.cpp` 等）可以更统一地调用两个引擎。同时增加了平台兼容性、安全限制和代码复用，是本 PR 从"功能验证"到"生产就绪"的关键一步。
