/**
 * Push the local Corvus clone to origin.
 *
 *   npm run push:corvus
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const corvusRoot = join(process.cwd(), 'src/pages/articles/_private');

if (!existsSync(join(corvusRoot, '.git'))) {
  console.error('Corvus clone not found. Run `npm run setup:private` first.');
  process.exit(1);
}

const result = spawnSync('git', ['push', '-u', 'origin', 'HEAD'], {
  cwd: corvusRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
