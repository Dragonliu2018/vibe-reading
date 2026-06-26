/**
 * 工具箱树形结构 — 从工具页自动派生
 *
 * 每个工具页（src/pages/tools/*.astro）在 frontmatter 中导出：
 *   export const toolMeta = {
 *     categoryPath: ['一级分类', '工具名称'],
 *     description:  '一句话描述',
 *   };
 *
 * 新增工具只需创建 .astro 文件并加 toolMeta，无需改此文件。
 */

export interface ToolNode {
  key:       string;
  label:     string;
  href?:     string;        // 叶节点：工具页路径（不含 base）
  children?: ToolNode[];
}

// ── 从工具页 export 自动读取 ─────────────────────────────────────
const toolModules = import.meta.glob<{
  toolMeta?: {
    categoryPath: string[];
    description?: string;
  }
}>('../pages/tools/*.astro', { eager: true });

function buildToolTree(): ToolNode[] {
  const roots: ToolNode[] = [];

  for (const [filePath, mod] of Object.entries(toolModules)) {
    const meta = mod.toolMeta;
    if (!meta?.categoryPath?.length) continue;   // index.astro 等无 toolMeta 的页面跳过

    // 从文件路径推导 href：'../pages/tools/diff.astro' → '/tools/diff'
    const slug = filePath.replace(/^.*\/tools\//, '').replace(/\.astro$/, '');
    const href = `/tools/${slug}`;

    const pathArr = meta.categoryPath;
    let level = roots;

    pathArr.forEach((label, i) => {
      const key = pathArr.slice(0, i + 1).join('/');
      let node = level.find(n => n.key === key);
      if (!node) {
        node = { key, label };
        level.push(node);
      }
      if (i === pathArr.length - 1) {
        node.href = href;   // 叶节点：赋予工具链接
      } else {
        node.children ??= [];
        level = node.children;
      }
    });
  }

  return roots;
}

export const toolsTree: ToolNode[] = buildToolTree();
