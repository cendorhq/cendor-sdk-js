import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init.js';
import { SENTINEL } from '../src/io.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cendor-init-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('runInit', () => {
  it('auto-detects assistants present and always adds AGENTS.md', () => {
    mkdirSync(join(root, '.github'));
    mkdirSync(join(root, '.cursor'));
    writeFileSync(join(root, 'CLAUDE.md'), '# app\n');
    const r = runInit({ root });
    expect(new Set(r.chosen)).toEqual(new Set(['copilot', 'cursor', 'claude', 'agents']));
    expect(existsSync(join(root, '.github/copilot-instructions.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor/rules/cendor.mdc'))).toBe(true);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(read('.cursor/rules/cendor.mdc')).toContain(SENTINEL);
  });

  it('never clobbers existing user content in a shared file', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# My rules\n\nDo not delete me.\n');
    runInit({ root, assistants: ['claude'] });
    const out = read('CLAUDE.md');
    expect(out).toContain('# My rules');
    expect(out).toContain('Do not delete me.');
    expect(out).toContain('Calling Cendor');
  });

  it('is idempotent — re-running does not duplicate the block', () => {
    runInit({ root, assistants: ['agents'] });
    const first = read('AGENTS.md');
    const r2 = runInit({ root, assistants: ['agents'] });
    expect(read('AGENTS.md')).toBe(first);
    expect(r2.actions[0]?.status).toBe('updated');
  });

  it('--dry-run writes nothing', () => {
    const r = runInit({ root, all: true, dryRun: true });
    expect(r.actions.every((a) => a.status.startsWith('would-'))).toBe(true);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, '.cursor/rules/cendor.mdc'))).toBe(false);
  });

  it('skips an owned file it did not write unless --force', () => {
    write('.cursor/rules/cendor.mdc', 'my own unrelated rule\n');
    const skipped = runInit({ root, assistants: ['cursor'] });
    expect(skipped.actions[0]?.status).toBe('skipped');
    expect(read('.cursor/rules/cendor.mdc')).toBe('my own unrelated rule\n');
    const forced = runInit({ root, assistants: ['cursor'], force: true });
    expect(forced.actions[0]?.status).toBe('updated');
    expect(read('.cursor/rules/cendor.mdc')).toContain(SENTINEL);
  });

  it('--mcp writes connect config only where absent', () => {
    const r = runInit({ root, assistants: ['agents'], mcp: true });
    expect(JSON.parse(read('.cursor/mcp.json')).mcpServers.cendor.url).toBe(
      'https://mcp.cendor.ai',
    );
    expect(JSON.parse(read('.vscode/mcp.json')).servers.cendor.type).toBe('http');
    // Re-run leaves existing config alone.
    const r2 = runInit({ root, assistants: ['agents'], mcp: true });
    expect(r2.actions.some((a) => a.path === '.cursor/mcp.json' && a.status === 'skipped')).toBe(
      true,
    );
  });

  it('--scaffold writes a language-appropriate starter for a node project', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"x","version":"1.0.0"}');
    runInit({ root, assistants: ['agents'], scaffold: true });
    expect(read('cendor-quickstart.mjs')).toContain('budget({ usd: 0.5');
    expect(read('cendor-quickstart.mjs')).toContain('instrument(new OpenAI())');
  });

  it('--scaffold writes a python starter for a python project', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\nversion="0.1.0"\n');
    runInit({ root, assistants: ['agents'], scaffold: true });
    expect(read('cendor_quickstart.py')).toContain('from cendor.core import instrument');
    expect(read('cendor_quickstart.py')).toContain('@budget(usd=0.50, on_exceed="raise")');
  });
});
