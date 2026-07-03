/**
 * Giscus 全站评论加载器 — 唯一配置点
 *
 * 激活步骤：
 * 1. 仓库 Settings → Features → 开启 Discussions
 * 2. 安装 Giscus App：https://github.com/apps/giscus
 * 3. 访问 https://giscus.app/zh-CN，获取 data-category-id
 * 4. 将值填入下方 CATEGORY_ID，然后 npm run build
 *
 * 此文件是唯一需要修改的地方，所有文章页自动生效。
 */
(function () {
  var REPO        = 'Dragonliu2018/vibe-reading';
  var REPO_ID     = 'R_kgDOTD2Blw';
  var CATEGORY    = 'Announcements';
  var CATEGORY_ID = 'DIC_kwDOTD2Bl84DAAkz';
  var THEME       = 'transparent_dark';
  var LANG        = 'zh-CN';

  if (!CATEGORY_ID) return;

  // 自建评论容器
  var section = document.createElement('section');
  section.id = 'giscus-section';
  section.setAttribute('data-pagefind-ignore', 'all');
  section.style.cssText = [
    'margin-top: 56px',
    'padding-top: 32px',
    'border-top: 1px solid rgba(255,255,255,0.08)',
    'font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
  ].join(';');

  var mount = document.createElement('div');
  mount.id = 'giscus-mount';

  section.appendChild(mount);

  // 插入策略（优先级依次降低）：
  // 1. .article-col — MD 文章正文列，自动继承列宽和 padding
  // 2. <main>       — HTML 文章
  // 3. <footer> 之前 — 兜底
  // 4. <body> 末尾  — 最终兜底
  var articleCol = document.querySelector('.article-col');
  var main       = document.querySelector('main');
  var footer     = document.querySelector('footer, .page-footer');
  if (articleCol)  articleCol.appendChild(section);
  else if (main)   main.appendChild(section);
  else if (footer) footer.insertAdjacentElement('beforebegin', section);
  else             document.body.appendChild(section);

  // 加载 Giscus iframe
  var s = document.createElement('script');
  s.src = 'https://giscus.app/client.js';
  s.setAttribute('data-repo',              REPO);
  s.setAttribute('data-repo-id',           REPO_ID);
  s.setAttribute('data-category',          CATEGORY);
  s.setAttribute('data-category-id',       CATEGORY_ID);
  s.setAttribute('data-mapping',           'pathname');
  s.setAttribute('data-strict',            '0');
  s.setAttribute('data-reactions-enabled', '1');
  s.setAttribute('data-emit-metadata',     '0');
  s.setAttribute('data-input-position',    'top');
  s.setAttribute('data-theme',             THEME);
  s.setAttribute('data-lang',              LANG);
  s.setAttribute('crossorigin',            'anonymous');
  s.async = true;
  mount.appendChild(s);
})();
