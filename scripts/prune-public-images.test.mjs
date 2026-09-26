import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prunePublicImages } from './prune-public-images.mjs';

test('keeps referenced build images and removes unreferenced copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-reading-prune-'));
  try {
    mkdirSync(join(root, 'articles', 'demo'), { recursive: true });
    mkdirSync(join(root, 'images', 'articles', 'demo'), { recursive: true });
    writeFileSync(
      join(root, 'articles', 'demo', 'index.html'),
      '<iframe src="/vibe-reading/images/articles/demo/keep.html"></iframe>',
    );
    writeFileSync(join(root, 'images', 'articles', 'demo', 'keep.html'), 'keep');
    writeFileSync(join(root, 'images', 'articles', 'demo', 'drop.png'), 'drop');

    assert.deepEqual(prunePublicImages(root), { kept: 1, pruned: 1 });
    assert.equal(readFileSync(join(root, 'images', 'articles', 'demo', 'keep.html'), 'utf8'), 'keep');
    assert.throws(() => readFileSync(join(root, 'images', 'articles', 'demo', 'drop.png')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores traversal-shaped URLs outside the images root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-reading-prune-'));
  try {
    mkdirSync(join(root, 'images'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<a href="/vibe-reading/images/../secret.txt">x</a>');
    writeFileSync(join(root, 'images', 'drop.png'), 'drop');
    writeFileSync(join(root, 'secret.txt'), 'secret');

    assert.deepEqual(prunePublicImages(root), { kept: 0, pruned: 1 });
    assert.equal(readFileSync(join(root, 'secret.txt'), 'utf8'), 'secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
