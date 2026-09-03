/**
 * 侧边栏分类树 — 从文章的 categoryPath 字段自动派生
 *
 * MD 文章：frontmatter 中的 category（YAML 数组，内部映射为 categoryPath）
 *   category: [AI, Agent, Observability, Litefuse]
 *
 * HTML 文章：<meta name="article:category" content="AI,Agent,Observability,Litefuse">
 *
 * 新增文章只需在文件里写 category，无需改此文件。
 */

import { articles, sourceLabel } from './articles';

export interface TreeNode {
  key:       string;       // 完整路径作为唯一 key，例如 "AI/Agent/Observability/Litefuse"
  label:     string;       // 显示名称
  children?: TreeNode[];   // 子分类
  slugs?:    string[];     // 当前节点直属文章 slug
}

// ── 计算文章在侧边栏的展示标题（含 source 前缀）──────────────────
function displayTitle(slug: string): string {
  const a = articles.find(a => a.slug === slug);
  if (!a) return slug;
  if (!a.source) return a.title;
  const label = sourceLabel(a.source, a.categoryPath ?? []);
  return label ? `${label} ${a.title}` : a.title;
}

// ── 在树中沿 path 建/复用节点，并把 slug 挂到叶子（同叶防重复）────────
function placeSlug(roots: TreeNode[], path: string[], slug: string) {
  if (!path.length) return;
  let level = roots;
  path.forEach((label, i) => {
    const key = path.slice(0, i + 1).join('/');   // 唯一 key
    let node = level.find(n => n.key === key);
    if (!node) {
      node = { key, label };
      level.push(node);
    }
    if (i === path.length - 1) {
      // 最后一段：文章挂在这个节点下（主分类与副分类都可能落到同叶，去重）
      node.slugs ??= [];
      if (!node.slugs.includes(slug)) node.slugs.push(slug);
    } else {
      node.children ??= [];
      level = node.children;
    }
  });
}

// ── 判断分类分支是否仅含私有文章（如 Corvus）────────────────────────
function collectSlugs(node: TreeNode): string[] {
  const slugs = [...(node.slugs ?? [])];
  for (const child of node.children ?? []) slugs.push(...collectSlugs(child));
  return slugs;
}

function isPrivateBranch(node: TreeNode): boolean {
  const slugs = collectSlugs(node);
  if (!slugs.length) return false;
  return slugs.every((slug) => articles.find((a) => a.slug === slug)?.visibility === 'private');
}

// ── 从 articles 自动构建分类树 ──────────────────────────────────────
function buildTree(): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const article of articles) {
    // 主分类：决定文件位置、徽章、sourceLabel
    placeSlug(roots, article.categoryPath ?? [], article.slug);
    // 副分类组（列表）：文章在树中多处引用，文件仍只在主分类目录
    for (const also of article.alsoCategoryPaths ?? [])
      placeSlug(roots, also, article.slug);
  }

  // 叶节点内的文章排序：
  // 有 source.id（PR 号）→ 按数值升序（体现时间线）
  // 无 source.id → 按展示标题字母序
  function sortSlugs(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (node.slugs) {
        node.slugs.sort((a, b) => {
          const artA = articles.find(x => x.slug === a);
          const artB = articles.find(x => x.slug === b);
          // Overview 固定排第一
          if (artA?.title === 'Overview') return -1;
          if (artB?.title === 'Overview') return 1;
          // type=101（入门指南）排最前（仅次于 Overview）
          const guideA = artA?.source?.type === '101';
          const guideB = artB?.source?.type === '101';
          if (guideA !== guideB) return guideA ? -1 : 1;
          const idA = artA?.source?.id ? parseInt(artA.source.id) : NaN;
          const idB = artB?.source?.id ? parseInt(artB.source.id) : NaN;
          if (!isNaN(idA) && !isNaN(idB)) return idA - idB;   // 都有 PR 号：数值升序
          if (!isNaN(idA)) return -1;                           // 只 a 有：a 在前
          if (!isNaN(idB)) return 1;                            // 只 b 有：b 在前
          return displayTitle(a).localeCompare(displayTitle(b)); // 都没有：字母序
        });
      }
      if (node.children) sortSlugs(node.children);
    }
  }
  sortSlugs(roots);

  // 分类节点排序：非类型词（项目名等）在前按字母序，类型词（Papers/Contributions 等
  // 占位/兜底末级）置后按字母序——避免兜底桶夹在项目名中间（如 Papers 混在 SGLang/vLLM 间）
  const TYPE_LABELS = new Set([
    'Papers', 'Contributions', 'CodeWiki', 'PRs',
    'Official', 'Informal', 'Docs', 'Meetups', 'Notes', 'Reading', 'Blogs', 'Ecosystems',
  ]);
  function sortLabels(nodes: TreeNode[], depth = 0) {
    nodes.sort((a, b) => {
      // 顶层：私有命名空间（Corvus 等）排在全部公开分类之后
      if (depth === 0) {
        const aPrivate = isPrivateBranch(a);
        const bPrivate = isPrivateBranch(b);
        if (aPrivate !== bPrivate) return aPrivate ? 1 : -1;
      }
      const aType = TYPE_LABELS.has(a.label);
      const bType = TYPE_LABELS.has(b.label);
      if (aType !== bType) return aType ? 1 : -1;   // 类型词置后
      return a.label.localeCompare(b.label, 'en');  // 同组内字母序
    });
    nodes.forEach((n) => n.children && sortLabels(n.children, depth + 1));
  }
  sortLabels(roots);

  return roots;
}

export const categoryTree: TreeNode[] = buildTree();

/** 顶层分类按 public / private 分区（private 命名空间如 Corvus 置后） */
export function splitRootCategoryTree(roots: TreeNode[] = categoryTree) {
  const publicRoots: TreeNode[] = [];
  const privateRoots: TreeNode[] = [];
  for (const node of roots) {
    (isPrivateBranch(node) ? privateRoots : publicRoots).push(node);
  }
  return { publicRoots, privateRoots };
}

// ── 找出包含指定 slug 的所有祖先节点 key 集合 ─────────────────────
// 多分类下同一 slug 可能命中多个叶子（主分类 + 各副分类），需收集全部命中链，
// 使侧边栏同时高亮文章所属的所有分类路径。
export function findActivePath(nodes: TreeNode[], slug: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!slug) return result;

  function walk(nodes: TreeNode[], ancestors: string[]) {
    for (const node of nodes) {
      if (node.slugs?.includes(slug)) {
        ancestors.forEach(k => result.add(k));
        result.add(node.key);
        // 不 return：继续遍历兄弟与子树，收集所有命中链
      }
      if (node.children) walk(node.children, [...ancestors, node.key]);
    }
  }

  walk(nodes, []);
  return result;
}
