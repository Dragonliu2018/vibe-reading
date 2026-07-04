---
name: vibe-reading-article
description: >
  Write technical articles for the Vibe Reading blog
  (https://github.com/Dragonliu2018/vibe-reading) by analyzing source material —
  code repositories, academic papers, or technical documents. Produces either a
  standalone HTML article (full custom CSS, Apple+GitHub dark theme) or a Markdown
  article (ArticleLayout.astro frontmatter). Use when the user says things like:
  "写一篇文章解读这个代码库", "把这个论文整理成博客文章",
  "生成 vibe reading 风格的技术文章", "分析这个项目并输出 html/markdown 文章",
  "迁移到博客", "发布到博客", or provides source material and asks to write an article.
---

# Vibe Reading Article Skill

## Step 1 — 判断格式，加载参考

| 来源类型 | 格式 | 加载文件 |
|---------|------|---------|
| PR / commit / Issue | **Markdown** | `references/markdown-pr.md` + `references/markdown-style.md` |
| 代码库 Internals | **HTML** | `references/content-guide.md`（代码库节）+ `references/html-style.md` |
| 论文 | **Markdown** | `references/content-guide.md`（论文节）+ `references/markdown-style.md` |
| 产品 / 文档介绍 | **HTML** | `references/content-guide.md`（产品节）+ `references/html-style.md` |

人工明确指定格式时，以人工为准。

## Step 2 — 阅读源材料

按加载的参考文件中的阅读顺序执行。

## Step 3 — 撰写文章

- **Markdown** → `src/pages/articles/_md/<slug>.md`，规范见加载的 references
- **HTML** → `src/pages/articles/html/<slug>.html`，基础模板见 `assets/html-base.html`

## Step 3.5 — 源码准确性验证（仅 PR / commit 文章）

文章写完后，**重新获取 PR/commit 的实际变更**，逐项核对文章内容：

```
核对清单（见 references/markdown-pr.md#源码核验）
```

发现错误立即修正，再进入 Step 4。

## Step 4 — 合规检查

```bash
bash .skills/vibe-reading-article/scripts/check-article.sh <file>
```

exit 0 = 通过；exit 1 = 输出具体错误，按提示修正后重跑。

## Step 5 — 发布

用户确认满意后：将文件放到对应目录，运行 `npm run build`。

## 写作规范

- 正文中文，专有名词（框架名、函数名、路径）保留英文原文
- 引用源码中真实的路径和函数名，不编造 API
- 代码块必须标注语言和 `title=`
- 每个 `##` 节有实质内容（代码 / 表格 / 流程图），不写空泛段落
