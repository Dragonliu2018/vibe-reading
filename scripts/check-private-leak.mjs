/**
 * Guard the public build output against Corvus private articles.
 *
 * Checks are structural, not textual:
 * - public Markdown must not declare visibility: private
 * - generated HTML must not carry data-content-visibility="private"
 * - private slugs must not occupy public article routes, the site manifest, or pagefind
 *
 * Title / body substring matching is intentionally avoided: common titles
 * ("Overview") would false-positive against the public corpus.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';

export const PRIVATE_VISIBILITY_ATTR = 'data-content-visibility="private"';

export function walkFiles(root, predicate = () => true) {
  if (!existsSync(root)) return [];

  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function markdownSlug(filePath, root) {
  return relative(root, filePath).replace(/\.md$/, '').split('\\').join('/');
}

export function collectPrivateSlugs(privateRoot) {
  return walkFiles(privateRoot, (file) => file.endsWith('.md'))
    .map((filePath) => markdownSlug(filePath, privateRoot));
}

export function findPrivateVisibilityInPublicSources(publicRoot, projectRoot = publicRoot) {
  const errors = [];
  for (const filePath of walkFiles(publicRoot, (file) => file.endsWith('.md'))) {
    const content = readFileSync(filePath, 'utf-8');
    if (/^visibility:\s*private\s*$/m.test(content)) {
      errors.push(`Public source declares private visibility: ${relative(projectRoot, filePath)}`);
    }
  }
  return errors;
}

function htmlArticlePath(outputRoot, slug) {
  return join(outputRoot, 'articles', ...slug.split('/'), 'index.html');
}

export function checkPublicOutput({ outputRoot, privateSlugs = [], projectRoot = outputRoot }) {
  const errors = [];
  const rel = (filePath) => relative(projectRoot, filePath);

  if (!existsSync(outputRoot) || !statSync(outputRoot).isDirectory()) {
    throw new Error(`Output directory ${outputRoot} does not exist.`);
  }

  for (const slug of privateSlugs) {
    const articlePath = htmlArticlePath(outputRoot, slug);
    if (!existsSync(articlePath)) continue;

    const html = readFileSync(articlePath, 'utf-8');
    if (html.includes(PRIVATE_VISIBILITY_ATTR)) {
      errors.push(`Private article was generated in public output: articles/${slug}/`);
    } else {
      errors.push(`Private slug collides with a public article: articles/${slug}/`);
    }
  }

  for (const filePath of walkFiles(outputRoot, (file) => file.endsWith('.html'))) {
    const content = readFileSync(filePath, 'utf-8');
    if (content.includes(PRIVATE_VISIBILITY_ATTR)) {
      errors.push(`Private visibility marker found in public output: ${rel(filePath)}`);
    }
  }

  const manifestPath = join(outputRoot, 'site-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = readFileSync(manifestPath, 'utf-8');
    for (const slug of privateSlugs) {
      if (manifest.includes(`/articles/${slug}`)) {
        errors.push(`Private article appears in site manifest: articles/${slug}/`);
      }
    }
  }

  const pagefindRoot = join(outputRoot, 'pagefind');
  if (existsSync(pagefindRoot)) {
    const pagefindFiles = walkFiles(pagefindRoot, (file) => {
      const ext = file.slice(file.lastIndexOf('.'));
      return ext === '.json' || ext === '.js' || ext === '.txt';
    });
    for (const filePath of pagefindFiles) {
      const content = readFileSync(filePath, 'utf-8');
      for (const slug of privateSlugs) {
        if (content.includes(`/articles/${slug}`)) {
          errors.push(`Private article appears in pagefind index: articles/${slug}/`);
        }
      }
    }
  }

  return errors;
}

export function runLeakCheck({
  projectRoot = process.cwd(),
  outputDir = 'dist',
} = {}) {
  const outputRoot = join(projectRoot, outputDir);
  const privateRoot = join(projectRoot, 'src/pages/articles/_private/articles');
  const publicRoot = join(projectRoot, 'src/pages/articles/_md');

  const privateSlugs = collectPrivateSlugs(privateRoot);
  const errors = [
    ...findPrivateVisibilityInPublicSources(publicRoot, projectRoot),
    ...checkPublicOutput({ outputRoot, privateSlugs, projectRoot }),
  ];

  return { errors, privateSlugs, outputRoot };
}

function isMain() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const outputDir = process.argv[2] ?? 'dist';
  const { errors } = runLeakCheck({ outputDir });
  if (errors.length > 0) {
    console.error('Private content leak check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log(`Private content leak check passed for ${outputDir}.`);
}
