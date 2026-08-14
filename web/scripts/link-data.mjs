/**
 * Make the built data artifacts visible to Vite as `public/data`.
 *
 * The artifacts live in `data/web/` at the repo root so the pipeline and the
 * site can share them, but Vite only serves what is under `public/`. This runs
 * before `dev` and `build` so a fresh clone works with no manual setup — the
 * previous instructions told the reader to symlink it themselves, which fails
 * on a fresh clone because git does not track the empty `public/` directory.
 *
 * A symlink where the platform allows one, a copy where it does not (Windows
 * without developer mode), so this is not a Unix-only repository.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(webRoot, '..', 'data', 'web');
const target = join(webRoot, 'public', 'data');

if (!existsSync(source)) {
  console.error(
    `link-data: ${source} not found.\n` +
      'Build the artifacts first:  python3 pipeline/build_web.py',
  );
  process.exit(1);
}

mkdirSync(join(webRoot, 'public'), { recursive: true });

// An existing link may point at a stale location, so replace rather than skip.
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  rmSync(target, { recursive: true, force: true });
}

try {
  symlinkSync(source, target, 'junction');
  console.log('link-data: public/data -> ../../data/web');
} catch {
  cpSync(source, target, { recursive: true });
  console.log('link-data: copied data/web into public/data (symlink unavailable)');
}
