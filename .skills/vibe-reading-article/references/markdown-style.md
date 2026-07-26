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
reviewed: false
---
```

**所有字段必须填写。不要加 `layout:` 行（由 `[slug].astro` 统一处理）。**

`reviewed`：是否经人工 review。AI 生成初稿时一律写 `false`；人工 review 通过后改为 `true`，提交重新构建后首页/文章页徽章由 `Draft`（灰黄）切为 `Reviewed`（绿）。省略时等同 `false`。

PR/commit 文章还需加 `source` 字段，见 `markdown-pr.md`。论文解读文章也加 `source`（`type: "论文解读"`、无 id），前缀 `[project 论文解读]` 由 source 自动拼，见 `paper-workflow.md`。

**category 末级约定：**

| 末级 | 含义 |
|------|------|
| `Contributions` | 自己写的 PR / commit |
| `Codebases` | 源码架构解读（AI 解读 code） |
| `PRs` | 解读他人的 PR / commit |
| `Official` | 官方文章转载 |
| `Informal` | 非官方技术博客转载 |
| `Notes` | 技术笔记 |
| `Papers` | 论文解读 |

> 转载类末级按来源分：官方 `Official` / 非官方 `Informal`。

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

## 数学公式

博客已启用 KaTeX（`remark-math` + `rehype-katex` + `@astrojs/markdown-remark`，CSS 与字体已打包）。公式用 KaTeX 语法，**不要用代码块放公式**。

- **行内**：`$p_\psi(z_0)$`、`$z_1 \sim \mathcal{N}(0,I)$`
- **展示（display）**：必须用**多行** `$$`（⚠️ 单行 `$$...$$` 会被渲染成 inline，无居中块）：

  ````markdown
  $$
  \log p(x) \geq \mathbb{E}_{z_0 \sim q_\phi}\!\left[\log p_\theta(x \mid z_0) - \log q_\phi(z_0 \mid x)\right]
  $$
  ````

- **逐行注释**用 `\underbrace{...}_{\text{…}}` 把公式分段标注。
- 常用宏：`\mathbb{E}` `\mathcal{N}` `\mid` `\,\|` `\sum` `\nabla` `\partial` `\top` `\ast` `\approx` `\geq` `\leq` `\cdot` `\quad` `\left[…\right]`。
- 行内符号（如 `z0`、`p(x)`）也用 `$...$`，不用反引号 `` `z0` `` 包，与公式风格一致。

> 论文解读的公式规则与示例见 `paper-workflow.md`。

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

### 下载与提交（图片在 submodule）

`public/images` 是子仓库 `Dragonliu2018/vibe-reading-images`（submodule）。下载图后需在子仓库 commit+push，再在主 repo 暂存指针。

**推荐用脚本自动化**：

```bash
npm run add-image -- {slug} {url1} [url2 ...]
# 例：npm run add-image -- doris-official https://a.com/fig1.png https://b.com/fig2.png
```

脚本自动：下载到 `public/images/articles/{slug}/` → 子仓库 `git add/commit/push` → 主 repo `git add public/images` 暂存指针。完成后在主 repo commit 文章即可。

**反爬站点（知乎/公众号/掘金）**：用 `agent-browser` 手动下载图到 `public/images/articles/{slug}/`，再跑：

```bash
npm run add-image -- {slug} --commit-only   # 只做子仓库 commit + 主 repo 暂存
```

**手动（不用脚本）**：

```bash
mkdir -p public/images/articles/{slug}
curl -sL "{remote-url}" -o public/images/articles/{slug}/{filename}.png
cd public/images && git add -A && git commit -m "add {slug}" && git push && cd ..
git add public/images          # 主 repo 记 submodule 指针
```

> 论文/PR PDF 中的图（Figure）用 PyMuPDF 渲染图区抽取（`page.get_pixmap(clip=rect)`），详见 `paper-workflow.md` 图节。PDF 本身放 `public/papers`（子仓库 `vibe-reading-papers`），同样需子仓库 commit + 主 repo 记指针。

### Markdown 引用

引用时加 `/vibe-reading` base 前缀（与 `astro.config.mjs` 的 `base` 一致）：

````markdown
![图1-1 rowset版本](/vibe-reading/images/articles/{slug}/fig-1-1-rowset-version.png)
````

### 图注与居中（alt 即图注）

- **alt 文本就是图注**：图片的 `alt` 会自动渲染为图片下方的图注，并居中显示（由 `ArticleLayout.astro` 的内联脚本 + `article.css` 处理）。**不要**在图片下方再单独写一行图注文字，否则会重复。

  ````markdown
  ✅ alt 即图注，下方不另写
  ![图1-1 rowset版本](.../fig-1-1-rowset-version.png)

  下一段正文…

  ❌ alt + 下方重复图注
  ![图1-1 rowset版本](.../fig-1-1-rowset-version.png)

  图 1-1 rowset 版本
  ````

- **装饰性图片用空 alt**：banner、头图、作者照等不需要图注的图片写空 alt `![](...)`，不生成图注（空 alt 也是无障碍最佳实践，表示装饰图）。

  ````markdown
  ![](/vibe-reading/images/articles/{slug}/series-banner.jpg)
  ````

- **行内图片不生成图注**：只有"段落里仅一张图"的独立图片才会被包成 `<figure>` 加图注；行内图片（与文字混排）保持原样，alt 不显示。

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
