const NUMBER_PREFIX = /^\s*(?:\d+(?:\.\d+)+[.、]?|\d+[.、])\s+/;

function removeAuthoredNumber(heading) {
  const first = heading.children?.[0];
  if (first?.type !== 'text') return;
  first.value = first.value.replace(NUMBER_PREFIX, '');
  if (!first.value) heading.children.shift();
}

/**
 * Add hierarchical numbers to Markdown h2-h6 headings when the article opts in
 * with `autoNumberHeadings: true`. Existing authored numbers are normalized so
 * enabling the field is safe during gradual source migration.
 */
export function remarkHeadingNumbers() {
  return (tree, file) => {
    const frontmatter = file?.data?.astro?.frontmatter;
    const enabled = frontmatter?.autoNumberHeadings;
    if (enabled === undefined || enabled === false) return;
    if (enabled !== true) {
      throw new Error('frontmatter autoNumberHeadings 必须是布尔值');
    }

    const counters = Array(7).fill(0);
    for (const node of tree.children ?? []) {
      if (node.type !== 'heading' || node.depth < 2 || node.depth > 6) continue;

      for (let depth = 2; depth < node.depth; depth++) {
        if (counters[depth] === 0) counters[depth] = 1;
      }
      counters[node.depth] += 1;
      for (let depth = node.depth + 1; depth <= 6; depth++) counters[depth] = 0;

      removeAuthoredNumber(node);
      const number = counters.slice(2, node.depth + 1).join('.');
      node.children.unshift({ type: 'text', value: `${number}${node.depth === 2 ? '.' : ''} ` });
    }
  };
}
