import { defineConfig } from 'astro/config';
import { existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';

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

  vite: {
    plugins: [{
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
    }],
  },
});
