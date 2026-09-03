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
  Also use when writing private/local-only Markdown (visibility: private).
---

# Vibe Reading Article Skill

## Step 1 — 判断格式，加载参考

| 来源类型 | 格式 | 加载文件 |
|---------|------|---------|
| PR / commit / Issue | **Markdown** | `references/markdown-pr.md` + `references/markdown-style.md` |
| 代码库 Internals | **Markdown** | `references/codewiki-workflow.md` + `references/markdown-style.md` |
| 论文 | **Markdown** | `references/content-guide.md`（论文节）+ `references/paper-workflow.md` + `references/markdown-style.md` |
| 技术文章转载（博客/知乎/公众号） | **Markdown** | `references/markdown-repost.md` + `references/markdown-style.md` |
| 文学 / 电影 / 历史笔记 | **Markdown** | `references/literary-style.md`（沉浸式布局自动启用）|
| 私有 / 本地-only 文章 | **Markdown** | `references/private-articles.md` + `references/markdown-style.md` |

人工明确指定格式时，以人工为准。人工指定 `visibility: private` 或写入 `_private/` 时，走私有流程。

## Step 2 — 阅读源材料

按加载的参考文件中的阅读顺序执行。

> **论文（链接 或 本地 PDF 路径）**：按 `references/paper-workflow.md` 的「端到端处理流程」Step 0–9 执行（两种输入在 Step 0/1 分流、Step 2 起统一）——定元信息 → 落 PDF → 通读全文 → 抽图 → 撰写 §1–§8 → 图对账 → 合规检查 → 子仓库提交 → 构建 → 10 问。

> **代码库（URL 或本地路径）**：按 `references/codewiki-workflow.md` 的「端到端处理流程」Step 0–6 执行——定元信息 → 结构扫描 → （可选）graphify 建图 → 四信号模块识别 → 并行 Agent 模块分析 → 架构综合 → 撰写 §1–§12 Markdown（架构图/流程图用 SVG） → 合规检查（含双轨验证）→ 构建 → 发布。

## Step 3 — 撰写文章

- **Markdown（公开）** → `src/pages/articles/_md/<slug>.md`，规范见加载的 references
- **Markdown（私有）** → `src/pages/articles/_private/articles/<…>/<slug>.md`，见 `references/private-articles.md`
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

**公开文章**：用户确认满意后，运行 `npm run build`，用 `commit-article.sh` 提交主仓库。

**私有文章**：用户确认满意后，运行 `npm run build:private` 本地验证，用 `npm run commit:corvus -- <slug>` 提交私有源仓库（见 `references/private-articles.md`）。**不要**把 `_private/` 内容 commit 进 vibe-reading。

## 并发写作（多 session 同时写博客）

单 session 直接在主 repo 工作区写即可。**多 session 同时写不同文章时，都在主 repo main 工作区写各自 slug**——不开分支（单工作区开分支会互相切走 checkout），commit 时**只 add 自己 slug 的路径，不用 `git add -A`**（否则误收对方半成品）。

写完用脚本精确 commit：

```bash
bash .skills/vibe-reading-article/scripts/commit-article.sh <slug>
```

脚本只 add `<slug>` 的 md（`src/pages/articles/_md/**/*<slug>*.md`）+ 图（`public/images/articles/<slug>/`）+ PDF（`public/papers/<slug>.pdf`），子仓库 commit + 主 repo commit（文章 + 指针），**不 push**（人工触发）。

私有文章并发写作同理：各自 slug，用 `npm run commit:corvus -- <slug>`，不用 `git add -A`。

优点（替代 worktree）：不开分支无 checkout 切走、子仓库 commit 落主 `.git/modules` 不丢、主 repo dev 4321 共享预览（文章在工作区 HMR 直接看）。根因治的是 `git add -A` 误收——本脚本精确 add 自己 slug 路径。

## 写作规范

- 正文中文，专有名词（框架名、函数名、路径）保留英文原文
- 引用源码中真实的路径和函数名，不编造 API
- 代码块必须标注语言和 `title=`
- 每个 `##` 节有实质内容（代码 / 表格 / 流程图），不写空泛段落
