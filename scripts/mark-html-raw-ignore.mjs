/**
 * 在 pagefind 索引前，给 dist/html-raw/ 里的 HTML 文件 body 加上
 * data-pagefind-ignore="all"，避免原始 HTML 文章被重复索引。
 * 只修改 dist/ 里的构建产物，不动 public/html-raw/ 源文件。
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const dir = 'dist/html-raw';
let count = 0;

for (const file of readdirSync(dir)) {
  if (!file.endsWith('.html')) continue;
  const fp = join(dir, file);
  const src = readFileSync(fp, 'utf-8');
  const out = src.replace(/<body(\s|>)/i, '<body data-pagefind-ignore="all"$1');
  if (out !== src) { writeFileSync(fp, out); count++; }
}

console.log(`[pagefind] marked ${count} html-raw files as ignored`);
