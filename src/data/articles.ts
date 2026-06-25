import { readdirSync, readFileSync } from 'fs';

export type Category = 'code' | 'paper' | 'system';

export interface Article {
  slug:          string;
  title:         string;
  date:          string;        // YYYY-MM-DD
  category:      Category;
  tags:          string[];
  description:   string;
  readingTime?:  string;
  aiModel?:      string;
  categoryPath?: string[];      // 侧边栏分类路径，如 ['AI', '可观测性', 'Litefuse']
}

export const CATEGORY_LABEL: Record<Category, string> = {
  code:   '代码解读',
  paper:  '论文解读',
  system: '系统设计',
};

export const CATEGORY_COLOR: Record<Category, { text: string; bg: string; border: string }> = {
  code:   { text: '#58a6ff', bg: 'rgba(88,166,255,.1)',  border: 'rgba(88,166,255,.28)'  },
  paper:  { text: '#bc8cff', bg: 'rgba(188,140,255,.1)', border: 'rgba(188,140,255,.28)' },
  system: { text: '#3fb950', bg: 'rgba(63,185,80,.1)',   border: 'rgba(63,185,80,.28)'   },
};

// ── MD 文章：从 frontmatter 自动读取 ──────────────────────────────
const mdModules = import.meta.glob<{
  frontmatter: {
    title:          string;
    date:           string;
    category?:      Category;
    tags?:          string[];
    description?:   string;
    readingTime?:   string;
    aiModel?:       string;
    category_path?: string[];
  };
}>('../pages/articles/_md/*.md', { eager: true });

const mdArticles: Article[] = Object.entries(mdModules).map(([path, mod]) => {
  const slug = path.split('/').pop()!.replace(/\.md$/, '');
  const fm   = mod.frontmatter;
  return {
    slug,
    title:        fm.title,
    date:         fm.date,
    category:     fm.category      ?? 'code',
    tags:         fm.tags           ?? [],
    description:  fm.description    ?? '',
    readingTime:  fm.readingTime     || undefined,
    aiModel:      fm.aiModel         || undefined,
    categoryPath: fm.category_path   || undefined,
  };
});

// ── HTML 文章：从 <meta name="article:*"> 自动读取 ────────────────
function metaContent(html: string, name: string): string {
  return html.match(
    new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, 'i')
  )?.[1] ?? '';
}

const htmlDir    = './src/pages/articles/html';
const htmlArticles: Article[] = readdirSync(htmlDir)
  .filter(f => f.endsWith('.html'))
  .map(file => {
    const slug = file.slice(0, -5);
    const html = readFileSync(`${htmlDir}/${file}`, 'utf-8');
    const rawTags = metaContent(html, 'article:tags');
    const rawPath = metaContent(html, 'article:category-path');
    return {
      slug,
      title:        (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? slug).trim(),
      date:         metaContent(html, 'article:date'),
      category:     (metaContent(html, 'article:category') || 'code') as Category,
      tags:         rawTags ? rawTags.split(',').map(t => t.trim()) : [],
      description:  metaContent(html, 'description'),
      readingTime:  metaContent(html, 'article:readingTime') || undefined,
      aiModel:      metaContent(html, 'article:aiModel')     || undefined,
      categoryPath: rawPath ? rawPath.split(',').map(s => s.trim()) : undefined,
    };
  });

// ── 合并，按日期降序排列 ──────────────────────────────────────────
export const articles: Article[] = [...mdArticles, ...htmlArticles]
  .sort((a, b) => b.date.localeCompare(a.date));
