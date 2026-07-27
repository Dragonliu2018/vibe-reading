/**
 * Astro Integration: 构建后生成 site-manifest.json
 *
 * 遍历 dist/ 产出所有可缓存 URL（HTML 页面 + CSS/JS + 文章图片），
 * 排除 papers/（72M PDF）和 pagefind/（1.6M 搜索索引）。
 * Service Worker 据此清单实现"缓存全站"功能。
 *
 * URL 均含 base 前缀（/vibe-reading/...），与 SW 的 BASE 一致。
 */

import { readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, extname } from 'path';

const BASE = '/vibe-reading';
const EXCLUDE_DIRS = ['papers', 'pagefind'];

// 可缓存文件扩展名
const CACHEABLE_EXT = new Set([
  '.html', '.css', '.js', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2',
]);

export function generateSiteManifest() {
  return {
    name: 'generate-site-manifest',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const distDir = dir.pathname.replace(/\/$/, '');
        const urls = [];
        let totalSize = 0;

        function walk(dir, relBase = '') {
          let entries;
          try {
            entries = readdirSync(dir);
          } catch {
            return;
          }

          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const relPath = relBase ? `${relBase}/${entry}` : entry;

            // 跳过排除目录
            if (EXCLUDE_DIRS.includes(entry)) continue;

            let stat;
            try {
              stat = statSync(fullPath);
            } catch {
              continue;
            }

            if (stat.isDirectory()) {
              walk(fullPath, relPath);
            } else if (CACHEABLE_EXT.has(extname(entry).toLowerCase())) {
              // index.html → 目录 URL（去掉 index.html）
              let urlPath;
              if (entry === 'index.html') {
                urlPath = relPath === 'index.html' ? '' : relPath.replace(/\/index\.html$/, '');
              } else {
                urlPath = relPath;
              }
              const url = `${BASE}/${urlPath}`;
              urls.push(url);
              totalSize += stat.size;
            }
          }
        }

        walk(distDir);

        const manifest = {
          generated: new Date().toISOString(),
          totalUrls: urls.length,
          totalSizeMB: Math.round((totalSize / 1024 / 1024) * 10) / 10,
          urls,
        };

        writeFileSync(
          join(distDir, 'site-manifest.json'),
          JSON.stringify(manifest, null, 2)
        );

        console.log(`  ✓ site-manifest.json: ${urls.length} URLs, ~${manifest.totalSizeMB} MB (excludes papers/pagefind)`);
      },
    },
  };
}
