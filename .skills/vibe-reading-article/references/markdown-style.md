# Markdown 文章规范

## 文件命名

文件放在 `src/pages/articles/_md/` 目录下，命名规则：

| 文章类型 | 格式 | 示例 |
|---------|------|------|
| 有 `source` 字段（PR/commit/Issue 等）| `{project}-{type}-{id}-{slug}.md` | `doris-pr-26133-status-fmt-formatter.md` |
| 无 `source` 字段（源码解读、论文等）| `{kebab-case-description}.md` | `mycli-architecture.md` |

`{project}`、`{type}` 均小写（`doris`、`pr`、`commit`、`issue`）；`{slug}` 为简短英文描述，用 `-` 分隔。

## Frontmatter（必填）

```yaml
---
title: "文章标题（双引号包裹）"
source:                    # 可选：文章来源，渲染为 [Project Type-Id] title
  project: "Doris"         # 项目名，如 Doris / ClickHouse / RocksDB
  type: "PR"               # 引用类型：PR / Issue / RFC / arxiv / commit
  id: "26133"              # 编号
  url: "https://..."       # 可选：原始链接（标识可点击跳转）
date: "YYYY-MM-DD"
category: [一级分类, 二级分类, 三级分类]
tags: ["Tag1", "Tag2", "Tag3"]
description: "一句话描述，出现在文章卡片和 SEO meta 中"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
---
```

**所有字段必须填写（`source` 可选）。不要加 `layout:` 行（由 `[slug].astro` 统一处理）。**

`source`：可选字段，文章来源结构化信息，渲染为 `[Project Type-Id] title`。

| 字段 | 必填 | 示例 |
|------|------|------|
| `project` | ✅ | `Doris` / `ClickHouse` / `RocksDB` |
| `type` | ✅ | `PR` / `Issue` / `RFC` / `arxiv` / `commit` |
| `id` | ✅ | `26133` / `0001` / `2301.07041` |
| `url` | 可选 | 原始链接，有则标识可点击跳转 |
| `prType` | 可选 | PR 类型，仅 `type: PR/commit` 时填写：`feat` / `perf` / `enhancement` / `fix` / `refactor`；渲染为标题前缀，如 `[Doris PR-36280] feat: 支持 PI 作为列默认值` |

> ⚠️ **`title` 不要重复 `source` 的任何信息**：UI 最终拼接为 `[Doris PR-31893] title`，因此：
> - **不写** `[PR-XXXXX]` 前缀（`type-id` 已由 `source` 提供）
> - **不写** project 名称，如 `Apache Doris` / `Doris`（`project` 已由 `source` 提供）
> - ✅ `"支持主动清理 Catalog 回收站"`
> - ❌ `"Apache Doris 支持主动清理 Catalog 回收站"`
> - ❌ `"[PR-31893] Apache Doris 支持主动清理 Catalog 回收站"`

`category`：YAML 数组，定义文章的分类层级路径（支持任意深度）
  → **最后一项**自动作为首页卡片 badge 标签和过滤器选项
  → 完整路径用于左侧侧边栏树形结构，**无需手动注册**
  → 最后一级下挂文章链接，中间级别为折叠/展开的分类节点

**文章类型（最后一级）约定：**

| 类型 | Category 末项 | 说明 |
|------|--------------|------|
| 解读别人的 PR / commit | `PRs` | 分析他人贡献 |
| 自己写的 PR / commit | `Contributions` | 自己提交的开源贡献 |
| 源码架构解读 | `Internals` | 深入源码内部机制、架构分析 |
| 技术文章 / 笔记 | `Notes` | 原理解析、经验总结 |
| 论文解读 | `Papers` | 学术论文阅读 |

**示例：**
- `[Database, Apache Doris, PRs]` — Doris PR 解读
- `[Database, Apache Doris, Contributions]` — 自己贡献的 Doris PR
- `[Database, 生态, mycli, Internals]` — mycli 源码架构解读
- `[AI, Papers]` — AI 论文解读
- `[Database, Apache Doris, Notes]` — Doris 相关技术笔记

## 导言段落（frontmatter 之后立即写）

只写引用块元信息，**不写额外的导言文字**——导言文字通常与第一个 `##` 节重复，直接省略。

```markdown
> **版本** v1.73.0 · **协议** BSD-3-Clause · **Python** ≥ 3.10 · **代码量** ~18,000 行

---

## 第一节
```

PR / Issue 类文章用 PR 元信息替代版本行：

```markdown
> **PR** [#26133](url) · **Issue** [#25974](url) · **commit** [67f1ae8](url) · **首发版本** 2.0.4 · **变更行数** +24 行 · **合并时间** 2023-11-01

---

## 问题背景
```

**元信息格式固定，所有字段必须出现。** 某个字段取不到值时，用 `-` 占位，不要省略该字段。

各字段取数方式：

| 字段 | 来源 |
|---|---|
| `PR` | PR 编号 + URL |
| `Issue` | PR body 中的 `Closes #XXXXX` / `Fix #XXXXX`；找不到则填 `-` |
| `commit` | PR 页面底部 **"merged commit `xxxxxxx` into `owner:master`"** 区域的合并 commit hash，链接到 `github.com/{owner}/{repo}/commit/{hash}`；找不到则填 `-` |
| `首发版本` | **优先**：PR 页面 Labels 中形如 `dev/x.x.x-merged` 的 label，去掉 `dev/` 前缀只保留版本号（如 `dev/3.0.0-merged` → `3.0.0`）；多个时用 ` / ` 连接（小版本在前）。**备选**：若无此类 label，在本地仓库执行 `git tag --contains <merge-commit-hash> \| sort -V \| head -1` 取首个包含该 commit 的 tag。**兜底**：仍取不到则填 `-` |
| `变更行数` | commit `--stat` 最后一行的 `+N`；找不到则填 `-` |
| `合并时间` | PR merge 时间，格式 `YYYY-MM-DD`；找不到则填 `-` |

**文章间交叉引用：** 有前后序关系的文章（如功能 PR → Bug Fix PR），在导言元信息之后、`---` 之前插入 `📎` 提示块，告知读者前置文章：

```markdown
> **PR** ... （元信息行）

> 📎 本文是 [前序文章标题](/vibe-reading/articles/{slug}) 的后续修复，建议先阅读原文。

---
```

同时在前序文章用 `> **后续**` 反向关联，放置位置视情况而定：

- 若前序文章有 `## TODO` 且该 TODO 正是后续 PR 所解决的 → 放在对应 TODO **条目正下方**
- 否则（无 TODO，或后续 PR 是一般性跟进）→ 放在 `## 意义与影响` 末尾

```markdown
> **后续**：... [PR #XXXXX](GitHub链接) 修复了这一场景，详见[文章标题](/vibe-reading/articles/{slug})。
```

**链接锚点规则**：跨文章链接（`📎`、`> **后续**`、TODO 子列表）的 href：
- 一般情况（引用整篇文章）→ 直接用文章 URL，**不加锚点**
- 明确指向某章节（如 TODO）→ 加对应节的 slug，如 `#todo`、`#意义与影响`

## 标题层级

| 级别 | 用途 | 示例 |
|---|---|---|
| `##` | 主节（对应 HTML 的 `<section>`） | `## 项目简介` |
| `###` | 子节 | `### 核心属性` |
| `####` | 小节（谨慎使用） | `#### 三种批量变体` |

**不要在文章里用 `#`（h1 由 ArticleLayout 的 title 渲染）**

## 段落和强调

```markdown
mycli 属于 **dbcli** 家族——一组基于 `prompt_toolkit` 构建的工具。

> **核心设计原则** 各层职责边界清晰，跨层通信通过接口进行。
```

- `**加粗**`：模块名、概念名、关键术语首次出现
- `` `行内代码` ``：文件名、函数名、类名、命令
- `>` 引用块：重要原则、警告、架构原则

## 代码块

代码块支持通过 `title="..."` 指定标题，会显示在代码框左上角，**每个代码块都应当有标题**。

**标题选取优先级（由高到低）：**

| 优先级 | 场景 | 示例 title |
|---|---|---|
| **1. 文件路径** | 代码来自具体文件 | `"sqlexecute.py"` / `"src/main.rs"` |
| **2. 有意义的名称** | 描述代码用途/概念 | `"fmt::formatter 特化"` / `"自动补全流程"` |
| **3. 默认** | 实在无合适标题 | 不写 title（自动显示"代码块"）|

````markdown
```python title="sqlexecute.py"
class SQLExecute:
    conn: pymysql.Connection
    dbname: str
```

```cpp title="fmt::formatter<Status> 特化"
template <typename Char>
struct fmt::formatter<Status, Char> {
  auto format(const Status& s, auto& ctx) const;
};
```

```bash title="构建命令"
cargo build --release
```
````

- 语言标识必须标注（`python` / `cpp` / `bash` / `typescript` / `go` / `rust` / `text` 等）
- **不再在代码首行加 `# 文件路径` 注释**，改用 `title=` 属性代替

## 表格

```markdown
| 方法 | 查询目标 | 用途 |
| --- | --- | --- |
| `tables()` | information_schema.TABLES | 表名补全 |
| `databases()` | SHOW DATABASES | 库名补全 |
```

第一列加粗（由 ArticleLayout prose 样式自动处理）。

## 列表

```markdown
- **智能 SQL 补全** (`sqlcompleter.py`): 描述功能
- **多协议连接** (`sqlexecute.py`): 描述功能

1. 读取文件开头 4 字节（magic）
2. 读取 20 字节 login_key
3. XOR 生成 AES 密钥
```

- 功能列表：`**名称** (文件)`: 描述
- 步骤列表：有序编号

## 目录树（用 text 代码块）

````markdown
```
mycli/
  __init__.py    # 版本元数据
  main.py        # CLI 入口（~1400 行）
  packages/
    special/     # 特殊命令子系统
```
````

## 流程图

**当代码调用逻辑复杂时，必须用流程图辅助说明**，不要只靠文字描述。

---

### 优先：调用专用 skill

来源：`markdown-viewer/skills`，安装命令（一次性）：

```bash
npx skills add markdown-viewer/skills
```

安装后以下 skill 可用，根据图表类型调用对应 skill，生成效果远优于手写 ASCII：

| 场景 | 调用 skill | 说明 |
|------|-----------|------|
| 时序图 / 多对象调用链 | `/uml` → Sequence | `A -> B : method()` |
| 流程图 / 分支 / 活动图 | `/uml` → Activity | `if (condition)` |
| 分层架构 / 组件拓扑 | `/uml` → Component 或 `/architecture` | 系统层级关系 |
| 状态机 | `/uml` → State Machine | 状态转换 |
| 模块依赖 / 调用图 | `/graphviz` | DOT 语言，自动布局 |

**调用示例：**
- 需要画调用链 → 告知用户"我将调用 `/uml` 生成时序图"，然后生成 PlantUML Sequence 图
- 需要画架构层次 → 调用 `/architecture` 生成 HTML 架构图

---

### 备选：ASCII 流程图（仅限简单场景）

节点 ≤ 5、无复杂分支时可用 ASCII，其他情况优先调用专用 skill。
使用 Unicode 制图字符，所有节点使用**完整四边方框**。

**字符速查：** `╭ ╮ ╰ ╯`（圆角）`┌ ┐ └ ┘`（方角）`─ │ ├ ┤ ┬ ┴ ▼ ▲ ► ◄ ✓ ✗`

#### 对齐自检（含中文时必须执行）

中文字符占 2 列，ASCII 占 1 列，生成后按以下步骤逐行验证：

```
1. 数上边框 ─ 的数量 N → 目标宽度 W = N + 2
2. 每条 │...│ 内容行：汉字/中文标点 +2，其余字符 +1，累加
3. 若某行 ≠ W → 在右侧 │ 前补删空格
4. 所有行 = W → 对齐完成
```

**线性流程示例**（自检：每行 = 25 列）：

````markdown
```
╭───────────────────────╮
│     fmt::format()     │
╰───────────┬───────────╯
            │
            ▼
╭───────────────────────╮
│  查找 formatter 特化  │
╰───────────┬───────────╯
            │
            ▼
╭───────────────────────╮
│ format() → ctx.out()  │
╰───────────────────────╯
```
````

**分层架构示例**（自检：每行 = 38 列）：

````markdown
```
┌────────────────────────────────────┐
│  CLI 层     main.py / MyCli        │
├────────────────────────────────────┤
│  执行层      SQLExecute            │
├────────────────────────────────────┤
│  补全层      SQLCompleter          │
├────────────────────────────────────┤
│  连接层      PyMySQL               │
└────────────────────────────────────┘
```
````

## 分割线

每个主要节之间（`##` 之前）可以加 `---`，但不强制要求。

## Markdown vs HTML 选择原则

**PR / commit 类文章：默认 Markdown，除非人工明确指定 HTML。**

**选 Markdown 当：**
- PR / commit / Issue 类文章（默认）
- 内容以文字解释、代码块、表格为主
- 不需要复杂视觉组件（卡片组、分层图、双列布局）
- 快速发布，不需要精细视觉设计

**选 HTML 当（需人工明确指定）：**
- 需要 card-grid 展示多个功能卡片
- 需要 layer-stack 展示分层架构
- 需要自定义导航、进度条、复杂布局
- 内容视觉丰富度很重要（产品介绍、大型代码库解读）

## 文章长度估算

| 节数 | 估计生成长度 |
|---|---|
| 6-8 节 | ~3,000-5,000 字 |
| 10-12 节 | ~6,000-10,000 字 |
| 14+ 节 | 建议拆分为多篇 |

---

## PR / Commit 文章模板

`source.type` 为 `PR` 或 `commit` 时使用此模板。共 10 个章节，标注必填/可选。

### 章节一览

| # | 章节 | 是否必填 | 说明 |
|---|------|---------|------|
| 1 | 背景 | ✅ 必填 | PR/commit 的来龙去脉，可参考对应 Issue；只描述**问题本身**，不放新旧对比数据（那是"性能测试"的内容）|
| 2 | 前置知识 | 可选 | 读懂本文需要的名词/原理；无则省略，勿过度解释 |
| 3 | 设计参考 | 可选 | 竞品实现、RFC、设计文档等；无则省略 |
| 4 | 实现 | ✅ 必填 | 核心实现原理、代码调用链路、重点难点 |
| 5 | 测试 | 可选 | 按测试类型分子章节（### 单元测试 / ### 回归测试 / ### 性能测试）；无测试则省略整章 |
| 6 | Review | 可选 | 有意义的 review 意见及答复；无则省略 |
| 7 | 问题 | 可选 | 实现过程中的棘手问题及解决方案；无则省略 |
| 8 | 意义与影响 | ✅ 必填 | 这个 PR/commit 的重要价值和影响范围 |
| 9 | TODO | 可选 | 当前未解决、后续需跟进的问题；无则省略 |
| 10 | 参考 | 可选 | 相关参考链接；无则省略。**不包含**对应 Issue / PR 链接（元信息行已有）|

### 文章骨架

```markdown
> **PR** [#XXXXX](url) · **Issue** [#XXXXX](url) · **commit** [xxxxxxx](url) · **首发版本** x.x.x · **变更行数** +N 行 · **合并时间** YYYY-MM-DD

---

## 背景

<!-- 必填：这个 PR/commit 要解决什么问题？为什么要做？
     如果对应 Issue 有详细描述，提炼关键信息引用
     ⚠️ 只写问题的定性描述，不放新旧对比数字/benchmark 表——那是"测试 → 性能测试"的内容 -->

---

## 前置知识

<!-- 可选：读者需要预先了解的概念、术语、原理
     只写"不了解会看不懂本文"的内容，避免过度科普 -->

---

## 设计参考

<!-- 可选：实现前参考了哪些方案？竞品如何实现？有无 RFC/设计文档？-->

---

## 实现

<!-- 必填：核心实现原理
     - 关键数据结构 / 接口变更
     - 代码调用链路（复杂时配流程图）
     - 重点、难点、非显而易见的设计决策 -->

---

## 测试

<!-- 可选：按实际包含的测试类型分子章节，无测试则省略整章 -->

### 单元测试

<!-- 可选：覆盖哪些函数/类？核心断言是什么？-->

### 回归测试

<!-- 可选：路径、测试套件名、覆盖场景 -->

### 性能测试

<!-- 可选：Benchmark 方法 + 新旧对比数据表；性能优化类 PR 必填此子章节 -->

---

## Review

<!-- 可选：有意义的 review 讨论
     - 编码规范、模式修正
     - 实现正确性质疑及答复
     不要罗列无实质内容的 LGTM / 格式检查 -->

---

## 问题

<!-- 可选：实现过程中遇到的卡点和解法
     适合记录"踩坑"或"反直觉"的地方 -->

---

## 意义与影响

<!-- 必填：这个 PR/commit 有什么重要价值？
     - 功能影响范围
     - 性能/稳定性/可维护性收益（结论性描述，数字已在"性能测试"中，此处不重复）
     - 对后续工作的铺垫 -->

---

## TODO

<!-- 可选：当前 PR/commit 明确未解决、需后续跟进的问题，用 checklist 格式书写
     注意：后续发现的 bug 不属于此处
     ⚠️ 即使某个 TODO 已在后续 PR 中解决，也不要删除这条记录——它是 PR 合并时历史状态的一部分

格式规范：
  - [ ] 未完成的条目描述
  - [x] 已完成的条目描述
    [[Project Type-Id] 文章标题](文章链接)   ← 换行，链接文字带 source 前缀

示例：
  - [x] MySQL 字典的批量查询，由 sundy-li 在 Review 中提出
    - [[Databend PR-16948] 用 IN 批量查询加速 MySQL 字典读取](/vibe-reading/articles/databend-pr-16948-mysql-dict-batch)
  - [ ] key 当前格式化为字符串有性能开销，后续用原生类型直接绑定 -->

---

## 参考

<!-- 可选：相关参考链接，如 RFC、论文、竞品文档、官方规范等
     ⚠️ 不要放 Issue / PR 链接——这两项已在元信息行（> **PR** · **Issue**）中包含 -->
```

### 写作要点

- **背景** 聚焦"为什么"，只做定性描述，不放 benchmark 数字或新旧对比表（那是"性能测试"子章节的内容）；不要重复"实现"章节的内容
- **前置知识** 以"不了解会读不懂"为门槛，宁缺毋滥
- **实现** 是核心，代码调用链路复杂时必须配流程图（见流程图章节）
- **Review** 只摘录有实质讨论价值的意见，跳过机器人 / 格式检查
- **关联文章**：有前后序关系时，后序文章导言加 `📎` 提示块；前序文章在 **TODO 对应条目正下方**加 `> **后续**` 反向链接（不是放在"意义与影响"）
- **TODO** 用 checklist 格式（`- [ ]` / `- [x]`）；已完成的条目用**子列表**附上博客链接，链接文字带 source 前缀（如 `[Databend PR-16948] 标题`）；条目本身不要删除，是 PR 合并时历史状态的一部分
- 可选章节**信息为空时直接省略**，不要保留空章节占位
