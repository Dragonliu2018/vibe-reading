/**
 * Clone or update the private Corvus article repository into
 * src/pages/articles/_private/ (nested git clone for CONTENT_MODE=private).
 *
 *   npm run setup:private
 *   CORVUS_REPO=git@github.com:you/Corvus.git npm run setup:private
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dest = join(process.cwd(), 'src/pages/articles/_private');
const repo = process.env.CORVUS_REPO ?? 'git@github.com:Dragonliu2018/Corvus.git';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (existsSync(join(dest, '.git'))) {
  console.log(`Updating Corvus in ${dest}`);
  run('git', ['-C', dest, 'pull', '--ff-only']);
} else if (existsSync(dest)) {
  console.error(
    `${dest} exists but is not a git clone.\n` +
    'Move it aside and re-run `npm run setup:private`.',
  );
  process.exit(1);
} else {
  console.log(`Cloning ${repo} → ${dest}`);
  run('git', ['clone', repo, dest]);
}

console.log('Done. Start the private site with `npm run dev:private`.');
