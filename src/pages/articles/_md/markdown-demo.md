---
title: "Markdown 文章示例"
date: "2026-06-24"
category: [Papers]
tags: [Markdown, Astro, Demo]
description: "这是一篇用于测试 Markdown 渲染效果的示例文章，覆盖常用语法元素。"
readingTime: "2 min"
aiModel: "Claude Opus 4.8"
---

## 简介

这是一篇 **Markdown** 格式的技术文章示例，用于验证各类语法元素的渲染效果。

> 💡 写新文章时复制这个文件，修改 frontmatter 和正文内容即可。

## 代码示例

行内代码：`import.meta.env.BASE_URL`

代码块：

```typescript
interface Article {
  slug:     string;
  title:    string;
  date:     string;
  category: 'code' | 'paper' | 'system';
}

const articles: Article[] = [
  { slug: 'demo', title: '示例', date: '2026-06-24', category: 'paper' },
];
```

## 列表

**无序列表：**

- 代码库解读：分析开源项目架构
- 论文解读：精读前沿技术论文
- 系统设计：拆解经典系统方案

**有序列表：**

1. AI 生成文章初稿
2. 人工审阅并校正
3. 提交发布到博客

## 表格

| 文章类型 | 格式 | 适合场景 |
|----------|------|----------|
| 代码解读 | HTML | 含架构图、流程图的富文本 |
| 论文解读 | Markdown | 文字为主，含公式和表格 |
| 系统设计 | 两者均可 | 按内容复杂度选择 |

## 引用

> Vibe Reading 的核心理念：AI 负责广度，人工保证深度与准确性。

## 分割线

---

内容继续...

## 小结

Markdown 适合以**文字为主**的技术文章，HTML 适合需要**自定义组件**（架构图、流程步骤等）的富文本内容。
