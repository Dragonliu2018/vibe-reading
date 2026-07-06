/**
 * 侧边栏分类树 — 从文章的 categoryPath 字段自动派生
 *
 * MD 文章：frontmatter 中的 category（YAML 数组，内部映射为 categoryPath）
 *   category: [AI, 可观测性, Litefuse]
 *
 * HTML 文章：<meta name="article:category" content="AI,可观测性,Litefuse">
 *
 * 新增文章只需在文件里写 category，无需改此文件。
 */

import { articles } from './articles';

export interface TreeNode {
  key:       string;       // 完整路径作为唯一 key，例如 "AI/可观测性/Litefuse"
  label:     string;       // 显示名称
  children?: TreeNode[];   // 子分类
  slugs?:    string[];     // 当前节点直属文章 slug
}

// ── 计算文章在侧边栏的展示标题（含 source 前缀）──────────────────
function displayTitle(slug: string): string {
  const a = articles.find(a => a.slug === slug);
  if (!a) return slug;
  return a.source
    ? `[${a.source.project} ${a.source.type}-${a.source.id}] ${a.title}`
    : a.title;
}

// ── 从 articles 自动构建分类树 ──────────────────────────────────────
function buildTree(): TreeNode[] {
  const roots: TreeNode[] = [];

  for (const article of articles) {
    const path = article.categoryPath;
    if (!path?.length) continue;

    let level = roots;

    path.forEach((label, i) => {
      const key = path.slice(0, i + 1).join('/');   // 唯一 key

      let node = level.find(n => n.key === key);
      if (!node) {
        node = { key, label };
        level.push(node);
      }

      if (i === path.length - 1) {
        // 最后一段：文章挂在这个节点下
        node.slugs = [...(node.slugs ?? []), article.slug];
      } else {
        // 中间节点：确保有 children 并继续向下
        node.children ??= [];
        level = node.children;
      }
    });
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

  // 分类节点按标签字母序排列（中英文混合，zh locale）
  function sortLabels(nodes: TreeNode[]) {
    // 英文分类在前（A-Z），中文分类在后
    nodes.sort((a, b) => a.label.localeCompare(b.label, 'en'));
    nodes.forEach(n => n.children && sortLabels(n.children));
  }
  sortLabels(roots);

  return roots;
}

export const categoryTree: TreeNode[] = buildTree();

// ── 找出包含指定 slug 的所有祖先节点 key 集合 ─────────────────────
export function findActivePath(nodes: TreeNode[], slug: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!slug) return result;

  function walk(nodes: TreeNode[], ancestors: string[]): boolean {
    for (const node of nodes) {
      if (node.slugs?.includes(slug)) {
        ancestors.forEach(k => result.add(k));
        result.add(node.key);
        return true;
      }
      if (node.children && walk(node.children, [...ancestors, node.key])) {
        return true;
      }
    }
    return false;
  }

  walk(nodes, []);
  return result;
}
