# Markdown 文章规范

适用于所有 Markdown 格式文章的通用排版规范。PR/commit 文章还需同时参考 `markdown-pr.md`。  
`visibility: private` 的文章另见 `private-articles.md`（路径、提交、构建差异）。

---

## 文件命名

文件放在 `src/pages/articles/_md/` 目录下，**目录路径与 frontmatter `category` 字段对齐**：

```
_md/{category[0]}/{category[1]}/.../{category[N-1]}/{slug}.md
```

即 category 数组用 `/` 拼接作为子目录路径，md 文件放在末级目录下。**含空格的分类元素，路径替换为 `-`**（frontmatter `category:` 数组保留原样用于分类树显示，仅文件目录路径和文章内链接路径做替换）。

| 文章类型 | 文件名格式 | 目录示例 |
|---------|-----------|---------|
| 有 `source` 字段（PR/commit 等）| `{project}-{type}-{id}-{slug}.md` | `category: [Database, Doris, PRs]` → `_md/Database/Doris/PRs/doris-pr-26133-status-fmt-formatter.md` |
| 无 `source` 字段（论文、笔记等）| `{kebab-case-description}.md` | `category: [AI, Models, Papers]` → `_md/AI/Models/Papers/cola-dlm.md` |
| CodeWiki 多文件 | `00-overview.md`、`01-{module}.md`... | `category: [Python, MyCLI, CodeWiki, "1.2.0"]` → `_md/Python/MyCLI/CodeWiki/1.2.0/00-overview.md` |

含空格分类：`category: ["AI", "Agent", "Harness Engineering", "DeerFlow", "CodeWiki", "2.0.0"]` → 目录 `_md/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/`，链接路径同样用 `-`：`/vibe-reading/articles/AI/Agent/Harness-Engineering/DeerFlow/CodeWiki/2.0.0/00-overview`

> **存量文章不动**，仍保持在 `_md/` 根目录。仅增量文章遵循此规则。

---

## Frontmatter（必填）

```yaml
---
title: "文章标题（双引号包裹）"
date: "YYYY-MM-DDTHH:MM:SS+08:00"      # 取博客编写时的当前时间（TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S+08:00'，勿手填近似）；ISO 8601 带时区（北京时间）；同日多篇按完整值排序，展示截前 10 字符
category: [Domain, Project, Type]
tags: ["Tag1", "Tag2"]
description: "一句话描述，出现在文章卡片和 SEO meta 中"
readingTime: "N min"
aiModel: "Claude Opus 4.8"
reviewed: false
---
```

**所有字段必须填写。不要加 `layout:` 行（由 `[slug].astro` 统一处理）。**

**标题/描述内部含引号时**：字符串值外层用 ASCII `"`（YAML 分隔符），内层改用中文弯引号 `“”`（U+201C/U+201D）。中文标题常含引号（如"不明觉赞"），直接用 ASCII `"` 会让 YAML 把它当成字符串结束符，`astro build` 报 `bad indentation` 解析失败。`check-article.sh` 已做 YAML 解析校验可捕获此类错误。

`reviewed`：是否经人工 review。AI 生成初稿时一律写 `false`；人工 review 通过后改为 `true`，提交重新构建后首页/文章页徽章由 `Draft`（灰黄）切为 `Reviewed`（绿）。省略时等同 `false`。

PR/commit 文章还需加 `source` 字段，见 `markdown-pr.md`。论文解读文章也加 `source`（`type: "论文解读"`、无 id），前缀 `[project 论文解读]` 由 source 自动拼，见 `paper-workflow.md`。

**category 确认流程（写文章前必须执行）：**

1. **先查已有文章**：按原文主题域 / 来源，在 `src/pages/articles/_md/` 下 grep 同主题或同来源的已有文章，看它们的 `category` 字段。例：
   ```bash
   # 按来源查（如同项目/同作者的转载）
   grep -rl "source:\s*\n\s*project: \"Runoob\"" src/pages/articles/_md/
   # 按主题关键词查
   grep -rl "Harness Engineering\|驾驭工程" src/pages/articles/_md/ | head
   ```
2. **对齐已有分类树**：若已有同类文章，**优先复用其 category 路径**（保持分类树一致，避免同主题文章散落到不同分类下）。分类树是人工持续维护的，已有路径即为既定约定。
3. **无同类文章时按末级规则推断**（见下表），并基于现有目录结构选择最贴近的主题层。
4. **人工显式指定优先级最高**：用户在指令里给了具体 category 数组时，直接用，不走上述推断（规范也写明「人工明确指定格式时，以人工为准」）。

> 核心原则：category 不是凭空推断的，是**对齐已有博客分类树**的——先查再定，不先定再查。

---

**category 末级约定：**

| 末级 | 含义 |
|------|------|
| `Contributions` | 自己写的 PR / commit |
| `CodeWiki` | 源码架构解读（AI 解读 code），末级再带版本号（如 `[Python, MyCLI, CodeWiki, "1.2.0"]`）。徽章显示 `CodeWiki`（而非版本号），与 `Docs` 同理。无 tag 仓库用 `<主分支名>-<YYYY-MM>`（主分支名取仓库默认分支；完整年份，如 `"main-2025-12"`/`"master-2025-12"`），并在导言记录解读基线 commit（短 hash+日期+链接） |
| `PRs` | 解读他人的 PR / commit |
| `Official` | 官方文章转载（非版本化：官方博客 / 公众号 / 社区指南） |
| `Docs` | 官方文档站版本化文档转载，末级再带版本号（如 `[Database, Apache Doris, Docs, "3.x"]`） |
| `Informal` | 非官方技术博客转载 |
| `Notes` | 技术笔记 |
| `Papers` | 论文解读 |

> 转载类末级按来源分：版本化官方文档 `Docs`（+ 版本号）/ 非版本化官方文章 `Official` / 非官方 `Informal`。`Docs` 和 `CodeWiki` 的版本号元素必须加引号（`"3.x"` / `"2.1"` / `"1.2.0"` / `"main-2025-12"`），否则 YAML 会把 `2.1` 解析成浮点数。

---

**多分类（副分类 `alsoCategories`，默认不加）：**

**默认一篇文章只有主分类。** 只有当一篇文章被**显式指定属于多个分类**时，才加副分类——分类树是"一处存放、多处引用"模型：

- `category`（主分类，必填，第一个分类组）：决定**文件位置**（目录路径与 `category` 对齐）、徽章、sourceLabel。文章文件只存在于主分类目录。
- `alsoCategories`（副分类，**默认省略**，`string[][]`）：仅当文章需在侧边栏**多处引用**时才加。每项是一个完整分类路径，`buildTree` 把 slug 挂到每条副分类路径的叶子，文件不复制、不移动。

**什么时候才加副分类**（满足其一，且主分类无法覆盖）：
- 用户明确要求文章归入多个分类组
- 文章横跨两个独立的分类域，且两个域的读者都会各自去自己熟悉的分类树下找它（如某工具既是 `Database` 又是 `AI`，两类读者各找各的树）

**什么时候不加**（常见误判）：
- ❌ "参考的同类文章有副分类" → 不构成理由，每篇文章按自身需要判断
- ❌ "项目基于 X（如基于 PostgreSQL）" → 主分类已能定位，不需要再挂到 X 的分类树下做镜像
- 判断标准：**去掉副分类后，读者在主分类树下能否找到这篇文章？能找到就不需要副分类。**

```yaml
# 默认：只有主分类（绝大多数文章）
category: [Database, OLTP, PostgreSQL, CodeWiki, "18.6"]

# 仅当显式需要多处引用时才加副分类
category: [Database, TSDB, TimescaleDB, CodeWiki, "2.29.2"]
alsoCategories:
  - [Database, OLTP, PostgreSQL, Extension, TimescaleDB, CodeWiki, "2.29.2"]
```

约定：
- 主分类按"产品功能身份"选（如 TimescaleDB → TSDB）。副分类不是"把项目所有身份都挂一遍"，而是"确有另一群读者会去别的树找它"。
- 副分类路径建议与主分类结构一致（CodeWiki 文章的副分类也带 `CodeWiki, 版本号` 尾），使副分类页是主分类页的真镜像。
- HTML 文章用 `<meta name="article:also-categories" content="Database,OLTP,PostgreSQL;Database,PG,Tsdb">`（`;` 分组、`,` 组内）。
- `check-article.sh` 校验 `alsoCategories`（若存在）须为 `string[][]`（非空字符串数组的列表）。

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

> **md 引用始终写本地路径 `/vibe-reading/images/...`**（dev 走本地、可离线）。生产构建时由 `rehype-jsdelivr-images` 插件自动改写为 jsDelivr CDN（`cdn.jsdelivr.net/gh/Dragonliu2018/vibe-reading-images@main/...`）加速加载，无需手改引用。PDF 链接（`<a href>`）不改写，仍走 Pages + 浏览器原生 viewer 的 Range 流式。

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
