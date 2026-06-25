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

## 格式选择

| 格式 | 适用 | 放置位置 |
|---|---|---|
| **HTML** | 需要复杂视觉布局（架构图、分层、卡片组） | `src/pages/articles/html/<slug>.html` |
| **Markdown** | 以文字/代码为主，标准结构 | `src/pages/articles/_md/<slug>.md` |

**默认选 HTML**（视觉效果更丰富，与现有文章一致）。用户明确要求 Markdown、或内容以代码块/列表为主时选 Markdown。

---

## 工作流

### 1. 阅读分析源材料

先读 `references/content-guide.md` 了解针对不同来源的分析方法。

**代码库：** 读 README + 目录树（2 层）+ 入口文件 → 识别语言/框架/架构/核心设计  
**论文：** 读摘要/引言/方法/结论 → 提取研究问题/创新点/结果  
**文档/产品：** 读核心概念/功能/架构 → 提取价值主张/用户场景/技术实现

### 2. 规划文章结构

从 `references/content-guide.md` 选用对应来源类型的结构模板。

### 3. 撰写文章

- **HTML 格式**：读 `assets/html-base.html`（完整基础模板），按 `references/html-style.md`（CSS 组件库）填充内容
- **Markdown 格式**：读 `references/markdown-style.md`，按 frontmatter 格式和 prose 规范写作

### 4. 发布到博客（用户确认满意后）

博客通过文件内嵌的元信息自动注册，**无需修改 `articles.ts`**。

**HTML 文章** → 复制到 `src/pages/articles/html/<slug>.html`

文件必须满足：
- `<html>` 标签含 `data-pagefind-ignore="all"`（避免搜索重复索引）
- `<head>` 含完整 article meta 标签，包括 `article:category-path`（见下方模板）

**Markdown 文章** → 复制到 `src/pages/articles/_md/<slug>.md`

文件必须满足：
- frontmatter 含所有字段（见 `references/markdown-style.md`），包括 `category_path`
- **不要** `layout:` 行（由 `[slug].astro` 统一处理）

**`category_path` 规范（两种格式均需填写）：**

定义文章在左侧侧边栏的分类层级，支持任意深度，侧边栏自动派生树形结构。

```yaml
# MD frontmatter（YAML 数组）
category_path: [一级分类, 二级分类, 三级分类, 源码解读]
```

```html
<!-- HTML meta（逗号分隔字符串）-->
<meta name="article:category-path" content="一级分类,二级分类,三级分类,源码解读">
```

现有分类参考（请与已有结构保持一致，避免创建重复分类）：
- `[Database, 生态, mycli, 源码解读]`
- `[AI, 可观测性, Litefuse, 源码解读]`
- `[AI, 可观测性, Langfuse, 源码解读]`
- `[AI, AI应用, Multica, 源码解读]`
- `[AI, AI应用, Paperclip, 源码解读]`

**发布后运行：**
```bash
npm run build   # 更新 pagefind 搜索索引
```

---

## 写作规范

**语言：** 正文中文，专有名词（框架名、函数名、文件路径）保留英文原文  
**技术内容：** 引用源码中的真实路径和函数名，代码块必须标注语言，不编造 API  
**内容密度：** 每个 h2 节有实质内容（代码/表格/流程图），不写空泛段落  
**关键数据：** 版本号、代码行数、性能指标等数字尽量从源材料中提取
