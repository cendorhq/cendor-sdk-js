/** A bounded, dependency-free recursive source walk that skips the usual noise directories. */
import { type Dirent, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'env',
  '.env',
  'dist',
  'build',
  'out',
  '.next',
  '.astro',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'site-packages',
  '.tox',
  '.eggs',
  '.idea',
  '.cache',
]);

/** Return absolute paths of files under `root` whose extension is in `exts` (e.g. ['.py']). */
export function walkSource(root: string, exts: readonly string[], maxFiles = 4000): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.endsWith('.egg-info')) stack.push(full);
      } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

export function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}
