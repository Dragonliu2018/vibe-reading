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
import type { ArticleSource } from './articles';

// ── 内容类型徽章调色板：一色一标签 ──────────────────────────────────
// 11 个标签是站点语料的封闭集合（frontmatter contentType），每个专属一色，
// 颜色真正编码信息。新类型追加到尾部即可（缺失降级首色）。
export const BADGE_PALETTE = [
  { text: '#58a6ff', bg: 'rgba(88,166,255,.12)',  border: 'rgba(88,166,255,.30)'  },  // CodeWiki      蓝
  { text: '#bc8cff', bg: 'rgba(188,140,255,.12)', border: 'rgba(188,140,255,.30)' },  // Papers        紫
  { text: '#7aa2f7', bg: 'rgba(122,162,247,.12)', border: 'rgba(122,162,247,.30)' },  // Docs          蓝灰
  { text: '#d2a8ff', bg: 'rgba(210,168,255,.12)', border: 'rgba(210,168,255,.30)' },  // Contributions 淡紫
  { text: '#89ddff', bg: 'rgba(137,221,255,.12)', border: 'rgba(137,221,255,.30)' },  // Official      天蓝
  { text: '#f7768e', bg: 'rgba(247,118,142,.12)', border: 'rgba(247,118,142,.30)' },  // PRs           玫红
  { text: '#9ece6a', bg: 'rgba(158,206,106,.12)', border: 'rgba(158,206,106,.30)' },  // Blogs         橄榄绿
  { text: '#e0af68', bg: 'rgba(224,175,104,.12)', border: 'rgba(224,175,104,.30)' },  // Notes         沙金
  { text: '#bb9af7', bg: 'rgba(187,154,247,.12)', border: 'rgba(187,154,247,.30)' },  // Informal      兰紫
  { text: '#7dcfff', bg: 'rgba(125,207,255,.12)', border: 'rgba(125,207,255,.30)' },  // Reading       浅蓝
  { text: '#ff9e64', bg: 'rgba(255,158,100,.12)', border: 'rgba(255,158,100,.30)' },  // Meetups       橙
] as const;

/** 内容类型标签 → 专属色（顺序即 BADGE_PALETTE 下标） */
const CONTENT_TYPES = ['CodeWiki', 'Papers', 'Docs', 'Contributions', 'Official', 'PRs', 'Blogs', 'Notes', 'Informal', 'Reading', 'Meetups'] as const;

const typeColorMap = new Map<string, (typeof BADGE_PALETTE)[number]>(
  CONTENT_TYPES.map((label, i) => [label, BADGE_PALETTE[i]])
);

/** 内容类型徽章的 inline style（一色一标签；未知类型降级首色） */
export function badgeStyle(label: string): string {
  const col = typeColorMap.get(label) ?? BADGE_PALETTE[0];
  return `color:${col.text};background:${col.bg};border:1px solid ${col.border};`;
}


// ── 徽章状态派生 ────────────────────────────────────────────────────
export interface BadgeState {
  pinned:       boolean;
  starred:      boolean;         // frontmatter star：好文标星（收藏视图聚合）
  isPrivate:    boolean;
  contentType?: string;         // 内容类型徽章标签（frontmatter 显式声明；空/缺省不渲染）
  catStyle:     string;         // 内容类型徽章 inline style
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
  pinned?:      boolean;
  star?:        boolean;
  contentType?: string;
  reviewed?:    boolean;
  source?:      ArticleSource;
  visibility?:  'public' | 'private';
}): BadgeState {
  const contentType = input.contentType || '';
  const isReviewed = !!input.reviewed;
  const isRepost   = input.source?.type === 'article';
  return {
    pinned:       !!input.pinned,
    starred:      !!input.star,
    isPrivate:    input.visibility === 'private',
    contentType,
    catStyle:     badgeStyle(contentType),
    reviewState:  isReviewed ? 'reviewed' : 'pending',
    reviewLabel:  isReviewed ? 'Reviewed' : 'Draft',
    reviewTitle:  isReviewed ? '已人工 review' : 'AI 初稿，待人工 review',
    originState:  isRepost ? 'repost' : 'original',
    originLabel:  isRepost ? '转载' : 'AI 生成',
    originTitle:  isRepost ? '转载自外部文章' : 'AI 生成内容',
  };
}
