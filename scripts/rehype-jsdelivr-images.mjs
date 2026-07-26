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
    // 仅生产构建改写；dev 保留本地路径
    if (process.env.NODE_ENV !== 'production') return;
    const walk = (node) => {
      if (node && node.type === 'element' && node.tagName === 'img') {
        const src = node.properties?.src;
        if (typeof src === 'string' && src.startsWith(LOCAL_PREFIX + '/')) {
          node.properties.src = JSDELIVR_BASE + src.slice(LOCAL_PREFIX.length);
        }
      }
      if (node && node.children) node.children.forEach(walk);
    };
    walk(tree);
  };
}
