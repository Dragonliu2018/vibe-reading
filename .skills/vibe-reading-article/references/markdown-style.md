# Markdown 文章规范

适用于所有 Markdown 格式文章的通用排版规范。PR/commit 文章还需同时参考 `markdown-pr.md`。

---

## 文件命名

文件放在 `src/pages/articles/_md/` 目录下：

| 文章类型 | 格式 | 示例 |
|---------|------|------|
| 有 `source` 字段（PR/commit 等）| `{project}-{type}-{id}-{slug}.md` | `doris-pr-26133-status-fmt-formatter.md` |
| 无 `source` 字段（论文、笔记等）| `{kebab-case-description}.md` | `mycli-architecture.md` |

---

## Frontmatter（必填）

```yaml
---
title: "文章标题（双引号包裹）"
date: "YYYY-MM-DD"
category: [Domain, Project, Type]
tags: ["Tag1", "Tag2"]
description: "一句话描述，出现在文章卡片和 SEO meta 中"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
---
```

**所有字段必须填写。不要加 `layout:` 行（由 `[slug].astro` 统一处理）。**

PR/commit 文章还需加 `source` 字段，见 `markdown-pr.md`。

**category 末级约定：**

| 末级 | 含义 |
|------|------|
| `Contributions` | 自己写的 PR / commit |
| `Internals` | 解读他人的 PR / commit，或源码架构解读 |
| `Notes` | 技术笔记 |
| `Papers` | 论文解读 |

---

## 导言段落（frontmatter 之后立即写）

只写引用块元信息，**不写额外导言文字**（与第一个 `##` 节重复，直接省略）：

```markdown
> **版本** v1.73.0 · **协议** BSD-3-Clause · **Python** ≥ 3.10 · **代码量** ~18,000 行

---

## 第一节
```

PR 文章的导言格式见 `markdown-pr.md`。

---

## 标题层级

| 级别 | 用途 |
|---|---|
| `##` | 主节 |
| `###` | 子节 |
| `####` | 小节（谨慎使用）|

**不在文章正文中用 `#`**（h1 由 ArticleLayout 的 title 渲染）。

---

## 段落和强调

- `**加粗**`：模块名、概念名、关键术语首次出现
- `` `行内代码` ``：文件名、函数名、类名、命令
- `>` 引用块：重要原则、警告、架构原则

---

## 代码块

每个代码块必须有 `title="..."`，优先级：文件路径 > 有意义的名称 > 省略（自动显示"代码块"）。

````markdown
```python title="sqlexecute.py"
class SQLExecute:
    conn: pymysql.Connection
```
````

语言标识必须标注（`python` / `cpp` / `bash` / `typescript` / `go` / `rust` / `sql` / `text` 等）。

---

## 表格

```markdown
| 方法 | 查询目标 | 用途 |
| --- | --- | --- |
| `tables()` | information_schema.TABLES | 表名补全 |
```

---

## 列表

```markdown
- **名称** (`file.py`): 描述功能

1. 步骤一
2. 步骤二
```

---

## 目录树（用无语言代码块）

```
mycli/
  __init__.py    # 版本元数据
  main.py        # CLI 入口（~1400 行）
```

---

## 流程图

**代码调用逻辑复杂时必须用流程图**，优先调用专用 skill：

| 场景 | 调用 skill | 来源 |
|------|-----------|------|
| 时序图 / 调用链 | `/uml` → Sequence | `npx skills add markdown-viewer/skills` |
| 流程图 / 分支 | `/uml` → Activity | 同上 |
| 架构层级 | `/architecture` 或 `/uml` → Component | 同上 |
| 依赖 / 调用图 | `/graphviz` | 同上 |

备选：节点 ≤ 5 时用 ASCII（Unicode 制图字符，完整四边方框）。

**对齐自检（含中文时必须执行）：** 汉字占 2 列，ASCII 占 1 列；数上边框 `─` 的数量 N，目标宽度 W = N + 2；每条 `│...│` 内容行累加须等于 W。

---

## 图片

**禁止直接引用远程 URL**（GitHub user-attachments、CDN 等），图片必须先下载到博客本地再引用。

### 存放路径

```
public/images/articles/{article-slug}/{filename}.png
```

示例（文章 slug 为 `starrocks-pr-52103-checkpoint-on-follower`）：

```bash
public/images/articles/starrocks-pr-52103/checkpoint-architecture.png
```

### 下载命令

```bash
mkdir -p public/images/articles/{slug}
curl -sL "{remote-url}" -o public/images/articles/{slug}/{filename}.png
```

### Markdown 引用

引用时加 `/vibe-reading` base 前缀（与 `astro.config.mjs` 的 `base` 一致）：

```markdown
![图片描述](/vibe-reading/images/articles/{slug}/{filename}.png)
```

---

## 分割线

每个主要节之间（`##` 之前）可加 `---`，不强制要求。

---

## 文章长度估算

| 节数 | 估计长度 |
|---|---|
| 6-8 节 | ~3,000-5,000 字 |
| 10-12 节 | ~6,000-10,000 字 |
| 14+ 节 | 建议拆分为多篇 |
