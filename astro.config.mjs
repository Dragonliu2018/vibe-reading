import { defineConfig } from 'astro/config';
import { existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';

const BASE = '/vibe-reading';

const MIME = {
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.wasm': 'application/wasm',
};

export default defineConfig({
  site: 'https://Dragonliu2018.github.io',
  base: '/vibe-reading',
  output: 'static',

  integrations: [{
    /**
     * 构建后自动往 HTML 文章页注入 giscus-loader.js
     * HTML 源文件零修改，新增文章自动获得评论功能
     */
    name: 'inject-giscus',
    hooks: {
      'astro:build:done': async ({ dir, pages }) => {
        const { existsSync: ex, readFileSync: rf, writeFileSync: wf } = await import('fs');
        const { join: pj } = await import('path');
        const SCRIPT = `<script src="${BASE}/giscus-loader.js" defer></script>`;

        for (const page of pages) {
          // 仅注入 HTML 文章页（MD 文章已通过 GiscusComments.astro 组件加载）
          if (!page.pathname.startsWith('articles/html/')) continue;
          const file = pj(dir.pathname, page.pathname, 'index.html');
          if (!ex(file)) continue;
          const html = rf(file, 'utf-8');
          if (html.includes('giscus-loader.js')) continue; // 已注入，跳过
          wf(file, html.replace('</body>', `${SCRIPT}\n</body>`));
        }
      },
    },
  }],

  vite: {
    plugins: [
      {
        name: 'pagefind-dev-server',
        configureServer(server) {
          // Vite 在 dev 模式下会把 base ('/vibe-reading') 从 req.url 中剥离
          // 所以实际拦截的是 /pagefind/* 而不是 /vibe-reading/pagefind/*
          server.middlewares.use((req, res, next) => {
            const url = req.url ?? '';
            // 匹配两种情况（带/不带 base 前缀）
            const prefix1 = '/vibe-reading/pagefind/';
            const prefix2 = '/pagefind/';
            let file = null;
            if (url.startsWith(prefix1))      file = url.slice(prefix1.length);
            else if (url.startsWith(prefix2)) file = url.slice(prefix2.length);
            if (!file) return next();

            const filePath = join('dist', 'pagefind', file.split('?')[0]);
            if (!existsSync(filePath)) return next();
            res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
            res.end(readFileSync(filePath));
          });
        },
      },
      {
        // dev 模式：拦截 HTML 文章页请求，注入 giscus-loader.js 后返回
        // build 模式由 astro:build:done integration 处理
        name: 'inject-giscus-dev',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = (req.url ?? '').split('?')[0].replace(/\/$/, '');
            // 匹配 /articles/html/<slug> 路由（Vite 已剥离 base 前缀）
            const m = url.match(/^(?:\/vibe-reading)?\/articles\/html\/([^/]+)$/);
            if (!m) return next();

            const slug = m[1];
            const filePath = join('src', 'pages', 'articles', 'html', `${slug}.html`);
            if (!existsSync(filePath)) return next();

            const html = readFileSync(filePath, 'utf-8');
            const SCRIPT = `<script src="${BASE}/giscus-loader.js" defer></script>`;
            const out = html.includes('giscus-loader.js')
              ? html
              : html.replace('</body>', `${SCRIPT}\n</body>`);

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(out);
          });
        },
      },
    ],
  },
});
