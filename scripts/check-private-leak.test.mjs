import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIVATE_VISIBILITY_ATTR,
  collectPrivateSlugs,
  findPrivateVisibilityInPublicSources,
  checkPublicOutput,
  runLeakCheck,
} from './check-private-leak.mjs';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('collectPrivateSlugs walks nested markdown', () => {
  const root = tempDir('vr-private-src-');
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'alpha.md'), '---\nvisibility: private\n---\n');
  writeFileSync(join(root, 'nested', 'beta.md'), '---\nvisibility: private\n---\n');
  writeFileSync(join(root, 'notes.txt'), 'ignore');

  assert.deepEqual(collectPrivateSlugs(root).sort(), ['alpha', 'nested/beta']);
  rmSync(root, { recursive: true, force: true });
});

test('public sources must not declare visibility: private', () => {
  const root = tempDir('vr-public-src-');
  writeFileSync(join(root, 'ok.md'), '---\ntitle: Public\n---\n');
  writeFileSync(join(root, 'secret.md'), '---\ntitle: Secret\nvisibility: private\n---\n');

  const errors = findPrivateVisibilityInPublicSources(root, root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /secret\.md/);
  rmSync(root, { recursive: true, force: true });
});

test('common titles in public HTML are not treated as leaks', () => {
  const outputRoot = tempDir('vr-public-dist-');
  mkdirSync(join(outputRoot, 'articles', 'overview'), { recursive: true });
  writeFileSync(
    join(outputRoot, 'articles', 'overview', 'index.html'),
    '<html lang="zh-CN" data-content-visibility="public"><title>Overview</title></html>',
  );

  const errors = checkPublicOutput({
    outputRoot,
    privateSlugs: ['corvus-secret'],
    projectRoot: outputRoot,
  });
  assert.deepEqual(errors, []);
  rmSync(outputRoot, { recursive: true, force: true });
});

test('private page marker in public output is a leak', () => {
  const outputRoot = tempDir('vr-leaked-dist-');
  mkdirSync(join(outputRoot, 'articles', 'corvus-secret'), { recursive: true });
  writeFileSync(
    join(outputRoot, 'articles', 'corvus-secret', 'index.html'),
    `<html lang="zh-CN" ${PRIVATE_VISIBILITY_ATTR}><title>Secret</title></html>`,
  );

  const errors = checkPublicOutput({
    outputRoot,
    privateSlugs: ['corvus-secret'],
    projectRoot: outputRoot,
  });
  assert.ok(errors.some((error) => error.includes('Private article was generated')));
  rmSync(outputRoot, { recursive: true, force: true });
});

test('public page occupying a private slug is a collision', () => {
  const outputRoot = tempDir('vr-collision-dist-');
  mkdirSync(join(outputRoot, 'articles', 'shared-slug'), { recursive: true });
  writeFileSync(
    join(outputRoot, 'articles', 'shared-slug', 'index.html'),
    '<html lang="zh-CN" data-content-visibility="public"><title>Public</title></html>',
  );

  const errors = checkPublicOutput({
    outputRoot,
    privateSlugs: ['shared-slug'],
    projectRoot: outputRoot,
  });
  assert.ok(errors.some((error) => error.includes('collides')));
  rmSync(outputRoot, { recursive: true, force: true });
});

test('site manifest listing a private article is a leak', () => {
  const outputRoot = tempDir('vr-manifest-dist-');
  writeFileSync(join(outputRoot, 'index.html'), '<html></html>');
  writeFileSync(
    join(outputRoot, 'site-manifest.json'),
    JSON.stringify({ urls: ['/vibe-reading/articles/corvus-secret'] }),
  );

  const errors = checkPublicOutput({
    outputRoot,
    privateSlugs: ['corvus-secret'],
    projectRoot: outputRoot,
  });
  assert.ok(errors.some((error) => error.includes('site manifest')));
  rmSync(outputRoot, { recursive: true, force: true });
});

test('runLeakCheck passes on a clean public tree', () => {
  const projectRoot = tempDir('vr-project-');
  const publicRoot = join(projectRoot, 'src/pages/articles/_md');
  const outputRoot = join(projectRoot, 'dist');
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(publicRoot, 'hello.md'), '---\ntitle: Hello\n---\n');
  writeFileSync(join(outputRoot, 'index.html'), '<html data-content-visibility="public"></html>');

  const { errors } = runLeakCheck({ projectRoot, outputDir: 'dist' });
  assert.deepEqual(errors, []);
  rmSync(projectRoot, { recursive: true, force: true });
});
