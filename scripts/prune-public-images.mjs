import {
  existsSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNED_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt']);

function extension(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

function walkFiles(root, visit, skippedRoot = '') {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (skippedRoot && path === skippedRoot) continue;
    if (entry.isDirectory()) walkFiles(path, visit, skippedRoot);
    else if (entry.isFile()) visit(path);
  }
}

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

/** Find local production image URLs emitted into generated text assets. */
export function collectReferencedPublicImages(outputDir, base = '/vibe-reading') {
  const root = resolve(outputDir);
  const imagesRoot = resolve(root, 'images');
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedBase}/images/([^\\s"'<>?#)]+)`, 'g');
  const referenced = new Set();

  walkFiles(root, (path) => {
    if (!SCANNED_EXTENSIONS.has(extension(path))) return;
    const contents = readFileSync(path, 'utf8');
    for (const match of contents.matchAll(pattern)) {
      let candidate;
      try { candidate = decodeURIComponent(match[1]); } catch { continue; }
      candidate = candidate.replace(/\\/g, '/');
      const absolute = resolve(imagesRoot, candidate);
      const rel = normalizedRelative(imagesRoot, absolute);
      if (rel && rel !== '..' && !rel.startsWith('../')) referenced.add(rel);
    }
  }, imagesRoot);

  return referenced;
}

/** Delete only unreferenced files from the generated images directory. */
export function prunePublicImages(outputDir, base = '/vibe-reading') {
  const root = resolve(outputDir);
  const imagesRoot = resolve(root, 'images');
  if (!existsSync(imagesRoot) || !statSync(imagesRoot).isDirectory()) {
    return { kept: 0, pruned: 0 };
  }

  const referenced = collectReferencedPublicImages(root, base);
  const directories = [];
  let kept = 0;
  let pruned = 0;

  walkFiles(imagesRoot, (path) => {
    const rel = normalizedRelative(imagesRoot, path);
    if (referenced.has(rel)) kept++;
    else {
      unlinkSync(path);
      pruned++;
    }
  });

  const collectDirectories = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = resolve(dir, entry.name);
      collectDirectories(child);
      directories.push(child);
    }
  };
  collectDirectories(imagesRoot);
  for (const dir of directories) {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  }

  return { kept, pruned };
}

export function prunePublicImagesIntegration({ base = '/vibe-reading' } = {}) {
  return {
    name: 'prune-unreferenced-public-images',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const result = prunePublicImages(fileURLToPath(dir), base);
        logger.info(`kept ${result.kept} referenced local image assets; pruned ${result.pruned}`);
      },
    },
  };
}
