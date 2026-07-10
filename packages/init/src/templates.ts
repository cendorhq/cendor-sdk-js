/**
 * Loads the vendored assistant-rules templates + the offline versions snapshot.
 *
 * These are VENDORED copies of section 3 ("Wire up your AI assistant") of the docs source of truth,
 * `cendor-libs/docs/for-ai-assistants.md`. That page is the single source — do not fork its wording;
 * when it changes, re-copy the blocks here (see the cendorhq root CLAUDE.md release-sync list).
 *
 * The files live in `../templates/` (one level above this module in both `src/` and the published
 * `dist/`), so they resolve the same whether the CLI runs from source (tests/vitest) or from the
 * published tarball. They are listed in the package `files` array so they ship offline.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../templates/${name}`, import.meta.url)), 'utf8');
}

/** GitHub Copilot repo-wide instructions (`.github/copilot-instructions.md`). */
export const copilotBody = (): string => read('copilot.md');
/** Cursor project rule — a whole file, frontmatter included (`.cursor/rules/cendor.mdc`). */
export const cursorFile = (): string => read('cursor.mdc');
/** The cross-tool `AGENTS.md` section (also reused for Windsurf's `.windsurf/rules`). */
export const agentsBody = (): string => read('agents.md');
/** Claude Code `CLAUDE.md` section. */
export const claudeBody = (): string => read('claude.md');

export interface VersionsSnapshot {
  asOf: string;
  npm: Record<string, string>;
  pypi: Record<string, string>;
}

/** Offline snapshot of published versions — a `doctor` hint, not the source of truth (see /releases). */
export function versionsSnapshot(): VersionsSnapshot {
  return JSON.parse(read('versions.json')) as VersionsSnapshot;
}
