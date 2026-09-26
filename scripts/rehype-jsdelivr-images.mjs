/**
 * rehype-jsdelivr-images — build 时把文章里的图片本地路径改写为 jsDelivr CDN URL，
 * 加速国内/海外图片加载；dev 模式不改（走本地 public/images，离线可用）。
 *
 *   /vibe-reading/images/articles/{slug}/x.png
 *   → https://cdn.jsdelivr.net/gh/Dragonliu2018/vibe-reading-images@main/articles/{slug}/x.png
 *
 * 只改 <img>，不动 <a href>（PDF 链接等仍走 Pages）。
 * 命中条件：src 以 `/vibe-reading/images/` 开头（即博客本地图片引用）。
 */
const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/Dragonliu2018/vibe-reading-images@main';
const LOCAL_PREFIX = '/vibe-reading/images';

export function rehypeJsdelivrImages() {
  return (tree) => {
    const walk = (node) => {
      if (node && node.type === 'element' && node.tagName === 'img') {
        node.properties ??= {};
        const src = node.properties?.src;
        // Native lazy loading avoids eagerly downloading dozens of below-fold
        // article figures. Explicit author choices still win.
        node.properties.loading ??= 'lazy';
        node.properties.decoding ??= 'async';

        // 仅生产构建改写；dev 保留本地路径
        if (process.env.NODE_ENV === 'production' && typeof src === 'string' && src.startsWith(LOCAL_PREFIX + '/')) {
          node.properties.src = JSDELIVR_BASE + src.slice(LOCAL_PREFIX.length);
        }
      }
      if (node && node.children) {
        node.children.forEach(walk);

        // Build standalone image paragraphs as semantic figures. Doing this
        // here avoids client-side DOM replacement and the associated layout shift.
        if (
          node.type === 'element' &&
          node.tagName === 'p' &&
          node.children.length === 1 &&
          node.children[0]?.type === 'element' &&
          node.children[0].tagName === 'img'
        ) {
          const image = node.children[0];
          const alt = typeof image.properties?.alt === 'string' ? image.properties.alt.trim() : '';
          node.tagName = 'figure';
          node.properties = { ...(node.properties ?? {}), className: ['image-figure'] };
          node.children = alt
            ? [image, { type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: alt }] }]
            : [image];
        }
      }
    };
    walk(tree);
  };
}
