/**
 * Commit private Corvus articles in the local clone under _private/.
 *
 * Corvus is versioned in its own git repository; vibe-reading never tracks these files.
 *
 *   npm run commit:corvus -- 01-ai-foundations
 *   npm run commit:corvus -- --all
 *   npm run commit:corvus -- 01-ai-foundations --push
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const corvusRoot = join(process.cwd(), 'src/pages/articles/_private');
const args = process.argv.slice(2);
const push = args.includes('--push');
const filtered = args.filter((a) => a !== '--push');
const all = filtered.includes('--all');
const slug = all ? '' : filtered[0];

function run(command, runArgs, { cwd = corvusRoot, allowFail = false } = {}) {
  const result = spawnSync(command, runArgs, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFail) {
    process.exit(result.status ?? 1);
  }
  return result.status ?? 0;
}

function git(args, opts) {
  return run('git', args, opts);
}

if (!existsSync(join(corvusRoot, '.git'))) {
  console.error(
    'Corvus clone not found. Run `npm run setup:private` first.',
  );
  process.exit(1);
}

let paths = [];

if (all) {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: corvusRoot,
    encoding: 'utf-8',
  });
  if (!status.stdout.trim()) {
    console.log('No changes in Corvus.');
    process.exit(0);
  }
} else if (!slug) {
  console.error(
    'Usage: npm run commit:corvus -- <slug>\n' +
    '       npm run commit:corvus -- --all [--push]',
  );
  process.exit(1);
} else {
  const found = spawnSync(
    'find',
    ['articles', '-name', `*${slug}*.md`, '-type', 'f'],
    { cwd: corvusRoot, encoding: 'utf-8' },
  );
  paths = found.stdout.trim().split('\n').filter(Boolean);
  if (!paths.length) {
    console.error(`No Corvus article matching slug ${JSON.stringify(slug)} under articles/`);
    process.exit(1);
  }
  console.log('▶ Corvus article(s):');
  for (const p of paths) console.log(`  ${p}`);
  git(['add', ...paths]);
}

const message = all
  ? `corvus: sync private articles`
  : `corvus: ${slug}`;

console.log('▶ Corvus commit');
if (all) {
  git(['add', '-A']);
}

const commitStatus = git(['commit', '-m', message], { allowFail: true });
if (commitStatus !== 0) {
  console.log('Nothing to commit.');
  process.exit(0);
}

git(['log', '-1', '--oneline'], { allowFail: false });

if (push) {
  console.log('▶ Corvus push');
  git(['push', '-u', 'origin', 'HEAD']);
} else {
  console.log('\nPush when ready:\n  npm run push:corvus');
}
