# 🔥 Vibe Reading

> AI 生成 · 人工 Review | 技术文档解读博客

在线访问：**https://Dragonliu2018.github.io/vibe-reading/**

## 关于

Vibe Reading 是一个技术文档深度解读博客，内容由 AI 生成初稿，经人工审阅校正后发布。
涵盖代码库解读、论文精读、系统设计分析等内容。

## 技术栈

- [Astro](https://astro.build/) — 静态站生成器
- GitHub Pages — 免费托管
- GitHub Actions — 自动部署

## 添加新文章

### 1. AI 生成完整 HTML 文章

将生成的 HTML 文件放入 `src/pages/articles/`：

```bash
cp your-article.html src/pages/articles/your-article-slug.html
```

### 2. 在文章列表中注册

编辑 `src/data/articles.ts`，在 `articles` 数组末尾添加一条记录：

```typescript
{
  slug:        'your-article-slug',   // 对应文件名（不含 .html）
  title:       '文章标题',
  date:        '2026-07-01',          // YYYY-MM-DD
  category:    'code',                // code | paper | system
  tags:        ['Tag1', 'Tag2'],
  description: '文章简介（展示在首页卡片上）',
  readingTime: '15 min',              // 可选
  aiModel:     'Claude Opus 4.8',     // 可选，生成该文章的 AI 模型
},
```

### 3. 提交推送

```bash
git add .
git commit -m "docs: add <文章标题>"
git push
```

推送后 GitHub Actions 自动构建并部署，约 2-3 分钟上线。

## 文章分类

| Category | 说明 |
|----------|------|
| `code`   | 代码库解读 |
| `paper`  | 论文解读 |
| `system` | 系统设计 |

## 本地开发

```bash
npm install
npm run dev      # 启动开发服务器 → http://localhost:4321/vibe-reading/
npm run build    # 构建静态文件
npm run preview  # 预览构建结果
```

## 文章列表

| 标题 | 分类 | 日期 |
|------|------|------|
| [Litefuse 代码库深度解读](src/pages/articles/litefuse-codebase-overview.html) | 代码解读 | 2026-06-23 |
