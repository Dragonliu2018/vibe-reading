import assert from 'node:assert/strict';
import test from 'node:test';
import { rehypeJsdelivrImages } from './rehype-jsdelivr-images.mjs';

test('adds lazy image defaults, rewrites production URLs, and creates figures', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const tree = {
      type: 'root',
      children: [{
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{
          type: 'element',
          tagName: 'img',
          properties: { src: '/vibe-reading/images/articles/demo.png', alt: 'Demo' },
          children: [],
        }],
      }],
    };

    rehypeJsdelivrImages()(tree);

    const figure = tree.children[0];
    const image = figure.children[0];
    assert.equal(figure.tagName, 'figure');
    assert.deepEqual(figure.properties.className, ['image-figure']);
    assert.equal(figure.children[1].tagName, 'figcaption');
    assert.equal(figure.children[1].children[0].value, 'Demo');
    assert.equal(image.properties.loading, 'lazy');
    assert.equal(image.properties.decoding, 'async');
    assert.equal(image.properties.src, 'https://cdn.jsdelivr.net/gh/Dragonliu2018/vibe-reading-images@main/articles/demo.png');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('preserves explicit loading and non-standalone image structure', () => {
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{
        type: 'element',
        tagName: 'a',
        properties: { href: '/full.png' },
        children: [{
          type: 'element',
          tagName: 'img',
          properties: { src: '/other.png', loading: 'eager' },
          children: [],
        }],
      }],
    }],
  };

  rehypeJsdelivrImages()(tree);
  const image = tree.children[0].children[0].children[0];
  assert.equal(tree.children[0].tagName, 'p');
  assert.equal(image.properties.loading, 'eager');
  assert.equal(image.properties.decoding, 'async');
});
