import { articleBySlug, sourceLabel } from './articles';
import { deriveBadges } from './badges';
import { categoryTree, splitRootCategoryTree, type TreeNode } from './categories';
import { encodeArticleSlug } from './paths';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const chevron = `<svg class="tree-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderNode(node: TreeNode, base: string, depth = 0): string {
  const childHtml = (node.children ?? []).map((child) => renderNode(child, base, depth + 1)).join('');
  const articleHtml = (node.slugs ?? []).map((slug) => {
    const article = articleBySlug.get(slug);
    const source = article?.source;
    const baseTitle = article?.title ?? slug;
    const prTypeLabel = source?.prType ? `${source.prType}: ` : '';
    let displayTitle = baseTitle;
    if (source) {
      const label = sourceLabel(source, article?.categoryPath ?? []);
      if (label) displayTitle = `${label} ${prTypeLabel}${baseTitle}`;
    }

    const review = deriveBadges({ reviewed: article?.reviewed });
    const count = review.reviewCount > 1
      ? `<span class="tree-review-count">×${review.reviewCount}</span>`
      : '';
    const reviewMark = `<span class="tree-review-mark" data-review-state="${review.reviewState}" data-count="${review.reviewCount}" title="${escapeHtml(review.reviewTitle)}"><svg class="tree-review-icon" viewBox="0 0 12 12" aria-hidden="true"><use href="#tree-review-${review.reviewState}"/></svg>${count}</span>`;

    return `<a class="tree-article" href="${base}/articles/${encodeArticleSlug(slug)}">${reviewMark}<span class="tree-article-title">${escapeHtml(displayTitle)}</span></a>`;
  }).join('');

  const sub = depth > 0 ? ' tree-cat-sub' : '';
  return `<div class="tree-node"><button class="tree-cat${sub}" data-key="${escapeHtml(node.key)}" data-depth="${depth}">${chevron}<span class="tree-cat-name">${escapeHtml(node.label)}</span></button><div class="tree-children">${childHtml}${articleHtml}</div></div>`;
}

/**
 * Render the large article navigation once as a shared static fragment.
 * Per-page active/open state is applied by Sidebar.astro after insertion.
 */
export function renderArticleSidebarTree(base = '/vibe-reading'): string {
  const { publicRoots, privateRoots } = splitRootCategoryTree(categoryTree);
  const publicHtml = publicRoots.map((node) => renderNode(node, base)).join('');
  const privateHtml = privateRoots.map((node) => renderNode(node, base)).join('');
  const hasPrivateZone = privateRoots.length > 0;

  const divider = (zone: 'public' | 'private', label: string) =>
    `<div class="tree-zone-divider tree-zone-divider--${zone}" role="separator" aria-label="${label} categories"><span class="tree-zone-divider-line" aria-hidden="true"></span><span class="tree-zone-divider-label">${label}</span><span class="tree-zone-divider-line" aria-hidden="true"></span></div>`;

  return [
    '<div class="tree-header"><p class="tree-label">Categories</p><button id="g-collapse-all" class="collapse-all-btn" type="button">全部折叠</button></div>',
    hasPrivateZone ? divider('public', 'Public') : '',
    publicHtml,
    hasPrivateZone ? divider('private', 'Private') : '',
    privateHtml,
  ].join('');
}
