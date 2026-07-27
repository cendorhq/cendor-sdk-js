import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';
import { versionsSnapshot } from '../src/templates.js';
import type { Finding, Severity } from '../src/types.js';
import { rangeBlocksLatest } from '../src/version.js';

// P1 (SFC-D7): the clean-bill fixture derives its @cendor/core pin from the bundled snapshot so a
// versions-snapshot bump (which broke this test twice) can never make the fixture read as "behind".
const SNAPSHOT_CORE = versionsSnapshot().npm['@cendor/core'];

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
    // Pin derived from the bundled snapshot (not hardcoded) — see SNAPSHOT_CORE above.
    write(
      'package.json',
      `{"name":"x","version":"1.0.0","dependencies":{"@cendor/core":"^${SNAPSHOT_CORE}","openai":"^4.77.0"}}`,
    );
    write(
      'src/a.ts',
      "import { instrument } from '@cendor/core';\nimport OpenAI from 'openai';\nconst c = instrument(new OpenAI());\n",
    );
    const r = runDoctor(root);
    expect(r.exitCode).toBe(0);
    expect(titles(r.findings, 'error')).toHaveLength(0);
    expect(titles(r.findings, 'warn').some((t) => t.includes('behind'))).toBe(false);
    expect(r.findings.some((f) => f.severity === 'ok')).toBe(true);
  });

  it('the derived clean-bill pin survives a snapshot bump (structural, P1)', () => {
    // A caret on the exact snapshot version always admits that version, so `doctor` never flags the
    // clean fixture as "behind" — for the current snapshot AND any hypothetical future bump.
    expect(rangeBlocksLatest(`^${SNAPSHOT_CORE}`, SNAPSHOT_CORE)).toBe(false);
    for (const bumped of ['0.13.0', '0.99.1', '1.0.0']) {
      expect(rangeBlocksLatest(`^${bumped}`, bumped)).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------- telemetry (the switch)
// Since @cendor/core 0.15 telemetry flows on its own, so the failure modes moved: not "you forgot to
// attach", but "you turned it off next to a configured provider" or "your Cendor is too old to emit".
// Neither warns at runtime (the emitters are deliberately silent), so doctor is where they surface.

describe('doctor — telemetry', () => {
  it('flags CENDOR_TELEMETRY=off next to a configured provider (warn, not a CI failure)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-doctor-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"name":"app","dependencies":{"@cendor/sdk":"^0.22.0"}}',
    );
    writeFileSync(
      join(dir, 'app.ts'),
      "import { NodeSDK } from '@opentelemetry/sdk-node';\nnew NodeSDK({}).start();\n// deploy: CENDOR_TELEMETRY=off\n",
    );
    const res = runDoctor(dir);
    expect(res.findings.some((f) => f.title.includes('CENDOR_TELEMETRY=off'))).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it('says nothing about telemetry when no provider is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-doctor-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"name":"app","dependencies":{"@cendor/core":"^0.15.0"}}',
    );
    writeFileSync(
      join(dir, 'app.ts'),
      "import { instrument } from '@cendor/core';\ninstrument(client);\n",
    );
    const res = runDoctor(dir);
    expect(res.findings.some((f) => f.title.includes('CENDOR_TELEMETRY'))).toBe(false);
  });

  it('notes a hand-written OTelSink (the historical ordering trap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-doctor-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"name":"app","dependencies":{"@cendor/tokenguard":"^0.8.1"}}',
    );
    writeFileSync(
      join(dir, 'app.ts'),
      "import { OTelSink } from '@cendor/tokenguard/sinks';\nuseSink(new OTelSink());\n",
    );
    const res = runDoctor(dir);
    expect(res.findings.some((f) => f.title.includes('OTelSink'))).toBe(true);
  });
});

// --------------------------------------------------------------- lockfile + --online (W2.4 / W4.2)
// Twin of cendor-init's tests. Two properties, only one of which is about a feature:
//   1. a LOCKFILE that pins @cendor/* low is named as the cause (a wide caret hides it entirely)
//   2. runDoctor with no `live` argument makes ZERO network calls — the no-phone-home posture
describe('lockfile + --online', () => {
  function nodeProjectWithLock(lockedCore: string): void {
    write(
      'package.json',
      JSON.stringify({ name: 'demo', dependencies: { '@cendor/core': '^0.1.0' } }),
    );
    write(
      'package-lock.json',
      JSON.stringify({
        name: 'demo',
        lockfileVersion: 3,
        packages: { 'node_modules/@cendor/core': { version: lockedCore } },
      }),
    );
  }

  it('names package-lock.json when the LOCK is what is behind', () => {
    // The declared caret is not the constraint here — the committed lock is, and `npm install`
    // honours it. Cendor's own JS recipes were frozen exactly this way, green the whole time.
    nodeProjectWithLock('0.1.0');
    const titles = runDoctor(root)
      .findings.filter((f) => f.severity === 'warn')
      .map((f) => f.title);
    expect(titles.some((t) => t.includes('package-lock.json'))).toBe(true);
  });

  it('says nothing when the lock is on the current shelf', () => {
    nodeProjectWithLock(SNAPSHOT_CORE as string);
    const titles = runDoctor(root)
      .findings.filter((f) => f.severity === 'warn')
      .map((f) => f.title);
    expect(titles.some((t) => t.toLowerCase().includes('lock'))).toBe(false);
  });

  it('makes no network call without --online', async () => {
    // Not "should not" — must not. Cendor's update posture is "we never check at runtime, and the
    // tooling only checks when you ask"; a default that quietly fetched would make that false.
    nodeProjectWithLock('0.1.0');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('doctor fetched without --online');
    }) as typeof fetch;
    try {
      expect(() => runDoctor(root)).not.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('uses the live map when one is supplied, and degrades on an unreachable feed', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'demo', dependencies: { '@cendor/core': '0.1.0' } }),
    );

    // A live feed reporting a much newer core: the finding must quote IT, not the snapshot.
    const live = runDoctor(root, { npm: { '@cendor/core': '99.0.0' }, asOf: '2099-01-01' });
    const behind = live.findings.find((f) => f.title.includes('behind'));
    expect(behind).toBeDefined();
    expect((behind?.locations ?? []).join(' ')).toContain('99.0.0');
    expect(behind?.detail).toContain('2099-01-01');

    // An unreachable feed is INFO, not failure, and must not change the exit code.
    const degraded = runDoctor(root, { npm: {}, error: 'could not reach the feed (test)' });
    expect(
      degraded.findings.some((f) => f.title.includes('Could not reach the live release feed')),
    ).toBe(true);
    expect(degraded.exitCode).toBe(runDoctor(root).exitCode);
  });

  it('npmMap flattens the real feed shape', async () => {
    const { npmMap } = await import('../src/online.js');
    const m = npmMap({
      asOf: '2026-07-27',
      libraries: [
        { name: 'core', pypi: 'cendor-core', pypiVer: '1.14.1', npm: 'core', npmVer: '0.16.1' },
      ],
      sdk: [{ name: 'sdk', pypi: 'cendor-sdk', pypiVer: '1.20.0', npm: 'sdk', npmVer: '0.24.0' }],
      // A future section this CLI does not know about must not break it.
      devtooling: [],
    });
    expect(m).toEqual({ '@cendor/core': '0.16.1', '@cendor/sdk': '0.24.0' });
  });
});
