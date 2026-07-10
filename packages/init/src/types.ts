/**
 * Shared types for the `@cendor/init` CLI (`init` + `doctor`).
 *
 * The CLI is offline: it reads/writes files and inspects the project, and makes no network call and
 * needs no key. It never mutates the project in `doctor`.
 */

/** An AI assistant we can write a rules file for. `agents` = the cross-tool `AGENTS.md` default. */
export type Assistant = 'copilot' | 'cursor' | 'agents' | 'claude' | 'windsurf';

export const ALL_ASSISTANTS: readonly Assistant[] = [
  'copilot',
  'cursor',
  'agents',
  'claude',
  'windsurf',
];

/** What kind of project this is — decides the scaffold language and which `doctor` checks are exact. */
export type Ecosystem = 'node' | 'python' | 'unknown';

/** Result of writing (or planning to write) one file. `would-*` states come from `--dry-run`. */
export type FileStatus =
  | 'created'
  | 'updated'
  | 'appended'
  | 'skipped'
  | 'would-create'
  | 'would-update'
  | 'would-append'
  | 'would-skip';

export interface FileAction {
  /** Path relative to the project root, forward-slashed for display. */
  path: string;
  status: FileStatus;
  note?: string;
}

/** A single `doctor` observation. `error` trips a non-zero exit; `warn`/`info`/`ok` do not. */
export type Severity = 'error' | 'warn' | 'info' | 'ok';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** How to fix it (shown under the finding). */
  fix?: string;
  /** Up to a few relevant file paths (relative to root). */
  locations?: string[];
}
