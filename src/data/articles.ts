import { readdirSync, readFileSync } from 'fs';

export interface ArticleSource {
  project: string;   // 项目名，如 Doris / ClickHouse
  type:    string;   // 引用类型，如 PR / Issue / RFC / arxiv / commit
  id:      string;   // 编号，如 26133
  url?:    string;   // 可选：原始链接
}

export interface Article {
  slug:         string;
  title:        string;
  source?:      ArticleSource;
  date:         string;        // YYYY-MM-DD
  category:     string[];      // 层级路径；最后一项用作首页徽章
  categoryPath: string[];      // 同 category，供侧边栏树使用（别名，保持侧边栏逻辑不变）
  tags:         string[];
  description:  string;
  readingTime?: string;
  aiModel?:     string;
}

// ── MD 文章：从 frontmatter 自动读取 ──────────────────────────────
const mdModules = import.meta.glob<{
  frontmatter: {
    title:        string;
    date:         string;
    category?:    string[];
    tags?:        string[];
    description?: string;
    readingTime?: string;
    aiModel?:     string;
    source?:      ArticleSource;
  };
}>('../pages/articles/_md/*.md', { eager: true });

const mdArticles: Article[] = Object.entries(mdModules).map(([path, mod]) => {
  const slug = path.split('/').pop()!.replace(/\.md$/, '');
  const fm   = mod.frontmatter;
  const cat = fm.category ?? [];
  return {
    slug,
    title:        fm.title,
    source:       fm.source       || undefined,
    date:         fm.date,
    category:     cat,
    categoryPath: cat,
    tags:         fm.tags         ?? [],
    description:  fm.description  ?? '',
    readingTime:  fm.readingTime   || undefined,
    aiModel:      fm.aiModel       || undefined,
  };
});

// ── HTML 文章：从 <meta name="article:*"> 自动读取 ────────────────
function metaContent(html: string, name: string): string {
  return html.match(
    new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, 'i')
  )?.[1] ?? '';
}

const htmlDir  = './src/pages/articles/html';
// MD slugs 集合：用于检测 HTML 文章是否与 MD 文章同名
const mdSlugSet = new Set(mdArticles.map(a => a.slug));

const htmlArticles: Article[] = readdirSync(htmlDir)
  .filter(f => f.endsWith('.html'))
  .map(file => {
    const base = file.slice(0, -5);
    // 若与 MD 文章同名，自动追加 -html 后缀，文件名保持不变
    const slug = mdSlugSet.has(base) ? `${base}-html` : base;
    const html = readFileSync(`${htmlDir}/${file}`, 'utf-8');
    const rawTags = metaContent(html, 'article:tags');
    const rawCat  = metaContent(html, 'article:category');
    const cat     = rawCat ? rawCat.split(',').map(s => s.trim()) : [];
    return {
      slug,
      title:        (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? slug).trim(),
      date:         metaContent(html, 'article:date'),
      category:     cat,
      categoryPath: cat,
      tags:         rawTags ? rawTags.split(',').map(t => t.trim()) : [],
      description:  metaContent(html, 'description'),
      readingTime:  metaContent(html, 'article:readingTime') || undefined,
      aiModel:      metaContent(html, 'article:aiModel')     || undefined,
    };
  });

// ── 合并，按日期降序排列 ──────────────────────────────────────────
export const articles: Article[] = [...mdArticles, ...htmlArticles]
  .sort((a, b) => b.date.localeCompare(a.date));
