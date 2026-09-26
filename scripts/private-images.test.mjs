import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  privateImagesDevPlugin,
  privateImagesIntegration,
  resolvePrivateImageFile,
} from './private-images.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'vibe-private-images-'));
  const images = join(base, 'private images');
  mkdirSync(join(images, 'article'), { recursive: true });
  writeFileSync(join(images, 'article', 'diagram.svg'), '<svg/>');
  writeFileSync(join(base, 'secret.json'), '{"secret":true}');
  return { base, images };
}

test('resolves valid base-prefixed and base-stripped image URLs', () => {
  const { base, images } = fixture();
  try {
    const expected = realpathSync(join(images, 'article', 'diagram.svg'));
    assert.equal(resolvePrivateImageFile(images, '/vibe-reading/imgs/article/diagram.svg'), expected);
    assert.equal(resolvePrivateImageFile(images, '/imgs/article/diagram.svg?cache=1'), expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rejects traversal, malformed encoding, directories, and unrelated URLs', () => {
  const { base, images } = fixture();
  try {
    const rejected = [
      '/imgs/../secret.json',
      '/imgs/%2e%2e/secret.json',
      '/imgs/..\\secret.json',
      '/imgs/%E0%A4%A',
      '/imgs/article/',
      '/other/article/diagram.svg',
    ];
    for (const url of rejected) {
      assert.equal(resolvePrivateImageFile(images, url), null, url);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rejects a symlink that points outside the image root', () => {
  const { base, images } = fixture();
  try {
    symlinkSync(join(base, 'secret.json'), join(images, 'article', 'escape.json'));
    assert.equal(resolvePrivateImageFile(images, '/imgs/article/escape.json'), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dev middleware serves an image with safe headers and passes traversal onward', () => {
  const { base, images } = fixture();
  try {
    let middleware;
    privateImagesDevPlugin({ enabled: true, sourceDir: images }).configureServer({
      middlewares: { use(fn) { middleware = fn; } },
    });

    const headers = {};
    let body;
    middleware(
      { url: '/imgs/article/diagram.svg' },
      {
        setHeader(name, value) { headers[name] = value; },
        end(value) { body = value; },
      },
      () => assert.fail('valid image should not call next'),
    );
    assert.equal(headers['Content-Type'], 'image/svg+xml');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(body.toString(), '<svg/>');

    let passed = false;
    middleware(
      { url: '/imgs/../secret.json' },
      {},
      () => { passed = true; },
    );
    assert.equal(passed, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('build integration copies images when the output URL contains spaces', async () => {
  const { base, images } = fixture();
  try {
    const output = join(base, 'build output');
    mkdirSync(output);
    const integration = privateImagesIntegration({ enabled: true, sourceDir: images });
    await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${output}/`) });
    assert.equal(readFileSync(join(output, 'imgs', 'article', 'diagram.svg'), 'utf8'), '<svg/>');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('public mode does not register middleware or copy private images', async () => {
  const { base, images } = fixture();
  try {
    let registered = false;
    privateImagesDevPlugin({ enabled: false, sourceDir: images }).configureServer({
      middlewares: { use() { registered = true; } },
    });
    assert.equal(registered, false);

    const output = join(base, 'public output');
    mkdirSync(output);
    const integration = privateImagesIntegration({ enabled: false, sourceDir: images });
    await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${output}/`) });
    assert.equal(existsSync(join(output, 'imgs')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
