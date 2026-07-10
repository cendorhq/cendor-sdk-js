/**
 * Filesystem helpers: a marker-delimited "managed block" so re-running `init` updates its own block
 * in place instead of duplicating it, and never clobbers the user's surrounding content.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MARKER_BEGIN =
  '<!-- BEGIN CENDOR: managed by @cendor/init — edits between these markers are overwritten. -->';
export const MARKER_END = '<!-- END CENDOR -->';

/** A sentinel that appears in every template, used to recognise a file we previously wrote. */
export const SENTINEL = 'cendor.ai/docs/for-ai-assistants';

export function managedBlock(body: string): string {
  return `${MARKER_BEGIN}\n${body.trim()}\n${MARKER_END}`;
}

export type UpsertKind = 'created' | 'updated' | 'appended';

/**
 * Insert or refresh our managed block inside `existing` content:
 * - no file yet → create it as just the block;
 * - file has our markers → replace only the region between them (idempotent), keep the rest;
 * - file exists without markers → append the block after a blank line (never touch existing text).
 */
export function upsertManaged(
  existing: string | null,
  body: string,
): { content: string; kind: UpsertKind } {
  const block = managedBlock(body);
  if (existing === null || existing.trim() === '') {
    return { content: `${block}\n`, kind: 'created' };
  }
  const b = existing.indexOf(MARKER_BEGIN);
  const e = existing.indexOf(MARKER_END);
  if (b !== -1 && e !== -1 && e > b) {
    const before = existing.slice(0, b).replace(/\s+$/, '');
    const after = existing.slice(e + MARKER_END.length).replace(/^\s+/, '');
    const parts = [before, block, after].filter((p) => p.length > 0);
    return { content: `${parts.join('\n\n')}\n`, kind: 'updated' };
  }
  const trimmed = existing.replace(/\s+$/, '');
  return { content: `${trimmed}\n\n${block}\n`, kind: 'appended' };
}

export function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
