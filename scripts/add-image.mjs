#!/usr/bin/env node
/**
 * add-image — 下载图片到 public/images 子仓库，并自动在子仓库 commit+push、主 repo 暂存指针。
 *
 * 用法：
 *   下载并提交：  node scripts/add-image.mjs <slug> <url1> [url2 ...]
 *   仅提交已手动下载的图：node scripts/add-image.mjs <slug> --commit-only
 *
 * 示例：
 *   node scripts/add-image.mjs doris-official-compaction https://a.com/fig1.png https://b.com/fig2.png
 *   # （知乎/公众号等反爬站点需 agent-browser 手动下到 public/images/articles/<slug>/ 后）
 *   node scripts/add-image.mjs doris-official-compaction --commit-only
 *
 * 图片落地路径：public/images/articles/<slug>/（与文章引用 /vibe-reading/images/articles/<slug>/ 一致）
 * 文件名取 URL 末段；无扩展名默认 .png；同名自动加序号。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IMAGES_ARTICLES = join(ROOT, 'public/images/articles');

const [, , slug, ...rest] = process.argv;
const commitOnly = rest.includes('--commit-only');
const urls = rest.filter(a => !a.startsWith('--'));

if (!slug || (!commitOnly && urls.length === 0)) {
  console.error('用法: node scripts/add-image.mjs <slug> <url1> [url2 ...]');
  console.error('     node scripts/add-image.mjs <slug> --commit-only');
  process.exit(1);
}

const slugDir = join(IMAGES_ARTICLES, slug);

function fileNameFromUrl(url, idx) {
  let name = '';
  try { name = basename(new URL(url).pathname); } catch { name = ''; }
  if (!extname(name)) name = `image-${idx + 1}.png`;
  return name;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`  ✓ ${dest.replace(ROOT, '')}`);
}

// 1. 下载（--commit-only 跳过）
if (!commitOnly) {
  await mkdir(slugDir, { recursive: true });
  console.log(`下载 ${urls.length} 张图 → public/images/articles/${slug}/`);
  for (let i = 0; i < urls.length; i++) {
    let name = fileNameFromUrl(urls[i], i);
    let dest = join(slugDir, name);
    if (existsSync(dest)) {
      const ext = extname(name);
      const base = ext ? name.slice(0, -ext.length) : name;
      dest = join(slugDir, `${base}-${i}${ext}`);
    }
    try { await download(urls[i], dest); }
    catch (e) { console.error(`  ✗ ${e.message}`); }
  }
} else {
  console.log(`--commit-only：跳过下载，提交 public/images/articles/${slug}/ 已有图`);
}

// 2. 子仓库 commit + push
const subDir = join(ROOT, 'public/images');
console.log('子仓库 commit + push...');
try {
  execSync('git add -A', { cwd: subDir, stdio: 'inherit' });
  execSync(`git commit -m "add images for ${slug}"`, { cwd: subDir, stdio: 'inherit' });
  execSync('git push', { cwd: subDir, stdio: 'inherit' });
} catch {
  console.log('（子仓库无新改动或 push 失败，跳过）');
}

// 3. 主 repo 暂存指针
console.log('主 repo 暂存 submodule 指针...');
execSync('git add public/images', { cwd: ROOT, stdio: 'inherit' });
console.log('✓ 完成。图片指针已暂存，接着在主 repo commit 文章即可（git commit）');
