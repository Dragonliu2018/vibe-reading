/**
 * 侧边栏分类树 — 从文章的 categoryPath 字段自动派生
 *
 * MD 文章：frontmatter 中的 category_path（YAML 数组）
 *   category_path: [AI, 可观测性, Litefuse]
 *
 * HTML 文章：<meta name="article:category-path" content="AI,可观测性,Litefuse">
 *
 * 新增文章只需在文件里写 category_path，无需改此文件。
 */

import { articles } from './articles';

export interface TreeNode {
  key:       string;       // 完整路径作为唯一 key，例如 "AI/可观测性/Litefuse"
  label:     string;       // 显示名称
  children?: TreeNode[];   // 子分类
  slugs?:    string[];     // 当前节点直属文章 slug
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
