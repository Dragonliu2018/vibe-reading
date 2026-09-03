/**
 * Fail if the public vibe-reading index stages Corvus sources.
 * The nested clone under src/pages/articles/_private/ is versioned separately.
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
  encoding: 'utf-8',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const staged = result.stdout.split('\0').filter(Boolean);
const blocked = staged.filter((path) => path.startsWith('src/pages/articles/_private/'));

if (blocked.length > 0) {
  console.error('Refusing to commit Corvus sources in the public repo:');
  for (const path of blocked) {
    console.error(`- ${path}`);
  }
  console.error('\nCommit private articles with `npm run commit:corvus` instead.');
  process.exit(1);
}
