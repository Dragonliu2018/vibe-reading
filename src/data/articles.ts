import { readdirSync, readFileSync } from 'fs';

export type PrType = 'feat' | 'perf' | 'enhancement' | 'fix' | 'refactor';

export interface ArticleSource {
  project: string;   // 项目名，如 Doris / ClickHouse
  type:    string;   // 引用类型，如 PR / Issue / RFC / arxiv / commit / 论文解读
  id?:     string;   // 编号，如 26133（PR/commit 必填；论文解读/转载可省略）
  url?:    string;   // 可选：原始链接
  pdf?:    string;   // 博客本地 PDF 链接（论文解读 type=论文解读 时必填，见 check-article.sh）
  prType?: PrType;   // PR 类型（仅 type=PR/commit 时有效）
}

export interface Article {
  slug:         string;
  title:        string;
  source?:      ArticleSource;
  date:         string;        // ISO 8601: YYYY-MM-DDTHH:MM:SS+08:00（北京时间）；排序按完整值，展示截前 10 字符
  category:     string[];      // 层级路径；最后一项用作首页徽章
  categoryPath: string[];      // 同 category，供侧边栏树使用（别名，保持侧边栏逻辑不变）
  tags:         string[];
  description:  string;
  readingTime?: string;
  aiModel?:     string;
  reviewed?:    boolean;     // frontmatter 显式声明已 review；与 src/data/reviewed.ts 数组取并集，构建期静态决定徽章状态
}

/**
 * 计算 source 前缀标签（不含 prType、不含标题）：
 *   article 转载 → [project 来源]（来源取 categoryPath 末级）
 *   Docs 官方文档 → 无前缀（分类已由徽章体现）
 *   有 id（PR/commit）→ [project type-id]
 *   无 id（如 论文解读）→ [project type]
 * 返回 '' 表示无前缀。首页卡片 / 侧边栏 / 文章页 / 排序统一用此函数，避免 4 处副本漂移。
 */
export function sourceLabel(source: ArticleSource, categoryPath: string[] = []): string {
  if (source.type === 'article') {
    // Docs 官方文档不加前缀，分类由徽章体现
    if (categoryPath.includes('Docs')) return '';
    const origin = categoryPath.length ? categoryPath[categoryPath.length - 1] : '';
    const parts = [source.project, origin].filter(Boolean);
    return parts.length ? `[${parts.join(' ')}]` : '';
  }
  const idSuffix = source.id ? `-${source.id}` : '';
  return `[${source.project} ${source.type}${idSuffix}]`;
}

/**
 * 计算文章的「分类徽章」标签：
 *   - 含 Docs 的官方文档分类 → 取 "Docs"（而非版本号/章节等末级）
 *   - 含 CodeWiki 的代码解读分类 → 取 "CodeWiki"（而非版本号末级）
 *   - 其余 → 取 category 末级
 * 首页卡片 / 文章页徽章 / 首页过滤器统一用此函数，避免副本漂移。
 */
export function badgeCat(category: string[] = []): string {
  if (!category.length) return '';
  if (category.includes('Docs')) return 'Docs';
  if (category.includes('CodeWiki')) return 'CodeWiki';
  return category[category.length - 1];
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
    reviewed?:    boolean;
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
    reviewed:     fm.reviewed      || undefined,
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
