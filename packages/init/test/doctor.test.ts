import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import type { Finding, Severity } from '../src/types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cendor-doctor-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}
const titles = (fs: Finding[], sev: Severity): string[] =>
  fs.filter((f) => f.severity === sev).map((f) => f.title);

describe('runDoctor', () => {
  it('exits non-zero when a provider SDK is used but not installed (node)', () => {
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^0.5.0"}}',
    );
    write(
      'src/x.mjs',
      "import OpenAI from 'openai';\nimport { instrument } from '@cendor/core';\nconst c = instrument(new OpenAI());\n",
    );
    const r = runDoctor(root);
    expect(r.exitCode).toBe(1);
    expect(titles(r.findings, 'error').some((t) => t.includes('openai'))).toBe(true);
  });

  it('flags a stray cendor/__init__.py as an error', () => {
    write('src/cendor/__init__.py', '# oops\n');
    write('src/cendor/tool/__init__.py', '');
    const r = runDoctor(root);
    expect(r.exitCode).toBe(1);
    expect(titles(r.findings, 'error').some((t) => t.includes('__init__.py'))).toBe(true);
  });

  it('warns on bare `import cendor` and float() on money, exits 0', () => {
    write(
      'pyproject.toml',
      '[project]\nname="x"\nversion="0.1.0"\ndependencies=["cendor-core>=1.5"]\n',
    );
    write(
      'app.py',
      'import cendor\nfrom cendor.core import instrument\nprice = 0.01\nx = float(price)\n',
    );
    const r = runDoctor(root);
    expect(r.exitCode).toBe(0);
    const warns = titles(r.findings, 'warn');
    expect(warns.some((t) => t.includes('import cendor'))).toBe(true);
    expect(warns.some((t) => t.includes('float'))).toBe(true);
  });

  it('warns when Cendor is imported but never instrumented', () => {
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/tokenguard":"^0.2.6"}}',
    );
    write('src/a.ts', "import { budget } from '@cendor/tokenguard';\n");
    const r = runDoctor(root);
    expect(titles(r.findings, 'warn').some((t) => t.includes('instrument'))).toBe(true);
  });

  it('warns when an installed @cendor version is behind the snapshot', () => {
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^0.5.0"}}',
    );
    write('node_modules/@cendor/core/package.json', '{"name":"@cendor/core","version":"0.1.0"}');
    write('src/a.ts', "import { instrument } from '@cendor/core';\nconst c = instrument({});\n");
    const r = runDoctor(root);
    expect(titles(r.findings, 'warn').some((t) => t.includes('behind'))).toBe(true);
  });

  it('warns when the installed @cendor/core price snapshot is >30 days old', () => {
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^0.5.1"}}',
    );
    write('node_modules/@cendor/core/package.json', '{"name":"@cendor/core","version":"0.5.1"}');
    write(
      'node_modules/@cendor/core/dist/prices-snapshot.js',
      'export const PRICES_JSON = `{"_updated": "2020-01-01","models": {}}`;\n',
    );
    write('src/a.ts', "import { instrument } from '@cendor/core';\nconst c = instrument({});\n");
    const r = runDoctor(root);
    expect(titles(r.findings, 'warn').some((t) => t.includes('price snapshot'))).toBe(true);
  });

  it('does not warn when the price snapshot is fresh', () => {
    const today = new Date().toISOString().slice(0, 10);
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^0.5.1"}}',
    );
    write('node_modules/@cendor/core/package.json', '{"name":"@cendor/core","version":"0.5.1"}');
    write(
      'node_modules/@cendor/core/dist/prices-snapshot.js',
      `export const PRICES_JSON = \`{"_updated": "${today}","models": {}}\`;\n`,
    );
    write('src/a.ts', "import { instrument } from '@cendor/core';\nconst c = instrument({});\n");
    const r = runDoctor(root);
    expect(titles(r.findings, 'warn').some((t) => t.includes('price snapshot'))).toBe(false);
  });

  it('reports no usage on an empty project and exits 0', () => {
    const r = runDoctor(root);
    expect(r.exitCode).toBe(0);
    expect(titles(r.findings, 'info').some((t) => t.includes('No Cendor usage'))).toBe(true);
  });

  it('gives a clean bill on a correct project', () => {
    write(
      'package.json',
      '{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^0.11.0","openai":"^4.77.0"}}',
    );
    write(
      'src/a.ts',
      "import { instrument } from '@cendor/core';\nimport OpenAI from 'openai';\nconst c = instrument(new OpenAI());\n",
    );
    const r = runDoctor(root);
    expect(r.exitCode).toBe(0);
    expect(titles(r.findings, 'error')).toHaveLength(0);
    expect(r.findings.some((f) => f.severity === 'ok')).toBe(true);
  });
});
