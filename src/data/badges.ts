/**
 * 文章徽章统一派生层
 *
 * 首页卡片与文章详情页共享同一套徽章逻辑：分类色、review 状态、origin 状态、pinned。
 * 此前 BADGE_PALETTE / catColorMap / badgeStyle / 状态派生在 index.astro 与 ArticleLayout.astro
 * 各存一份副本，容易漂移；本模块收口为单一来源。
 *
 * 仅用蓝紫系——绿/橙黄留给 review-badge、粉/teal 留给 origin-badge、金留给 pin-badge、红留给 private-badge，
 * 六类徽章色域不重合。CSS 尺寸（首页 10.5px / 详情页 11px）仍由各页作用域决定，不在此处。
 */
import { articles, badgeCat, type ArticleSource } from './articles';

// ── 分类徽章调色板（蓝紫系）──────────────────────────────────────────
export const BADGE_PALETTE = [
  { text: '#58a6ff', bg: 'rgba(88,166,255,.12)',  border: 'rgba(88,166,255,.30)'  },
  { text: '#bc8cff', bg: 'rgba(188,140,255,.12)', border: 'rgba(188,140,255,.30)' },
  { text: '#7aa2f7', bg: 'rgba(122,162,247,.12)', border: 'rgba(122,162,247,.30)' },
  { text: '#d2a8ff', bg: 'rgba(210,168,255,.12)', border: 'rgba(210,168,255,.30)' },
] as const;

// 按全站分类出现频次降序分配颜色，保证相同标签全站同色
const catColorMap = new Map(
  Object.entries(
    articles.reduce<Record<string, number>>((acc, a) => {
      const last = badgeCat(a.category);
      if (last) acc[last] = (acc[last] ?? 0) + 1;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .map(([label], i) => [label, BADGE_PALETTE[i % BADGE_PALETTE.length]])
);

/** 分类徽章的 inline style（颜色由全站频次映射决定，降级到首色） */
export function badgeStyle(label: string): string {
  const col = catColorMap.get(label) ?? BADGE_PALETTE[0];
  return `color:${col.text};background:${col.bg};border:1px solid ${col.border};`;
}

// ── 徽章状态派生 ────────────────────────────────────────────────────
export interface BadgeState {
  pinned:       boolean;
  isPrivate:    boolean;
  catLabel:     string;          // 分类徽章标签（空字符串表示不渲染）
  catStyle:     string;          // 分类徽章 inline style
  reviewState:  'reviewed' | 'pending';
  reviewLabel:  string;
  reviewTitle:  string;
  originState:  'repost' | 'original';
  originLabel:  string;
  originTitle:  string;
}

/**
 * 从文章片段派生全部徽章状态。首页（Article）与详情页（frontmatter）入参字段不同，
 * 用最小交集接口适配两处，避免把整个 Article/frontmatter 类型耦合进来。
 */
export function deriveBadges(input: {
  pinned?:     boolean;
  category?:   string[];
  reviewed?:   boolean;
  source?:     ArticleSource;
  visibility?: 'public' | 'private';
}): BadgeState {
  const catLabel = badgeCat(input.category ?? []);
  const isReviewed = !!input.reviewed;
  const isRepost   = input.source?.type === 'article';
  return {
    pinned:       !!input.pinned,
    isPrivate:    input.visibility === 'private',
    catLabel,
    catStyle:     badgeStyle(catLabel),
    reviewState:  isReviewed ? 'reviewed' : 'pending',
    reviewLabel:  isReviewed ? 'Reviewed' : 'Draft',
    reviewTitle:  isReviewed ? '已人工 review' : 'AI 初稿，待人工 review',
    originState:  isRepost ? 'repost' : 'original',
    originLabel:  isRepost ? '转载' : 'AI 生成',
    originTitle:  isRepost ? '转载自外部文章' : 'AI 生成内容',
  };
}
