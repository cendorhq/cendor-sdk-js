/**
 * `doctor` — validate the wiring so it doesn't break at runtime. Static checks only; NEVER mutates.
 *
 * Exits non-zero on hard problems (CI-usable), zero when only warnings remain. The npm ecosystem
 * (package.json / node_modules) is checked exactly here; for a Python project's dep/version accuracy
 * run `uvx cendor-init doctor` (it can read the installed environment).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Detected,
  NPM_PKG_FOR_PROVIDER,
  PYPI_EXTRA_FOR_PROVIDER,
  detectProject,
  providersUsedInSource,
} from './detect.js';
import { RELEASES_URL } from './online.js';
import { rel, walkSource } from './scan.js';
import { versionsSnapshot } from './templates.js';
import type { Finding, Severity } from './types.js';
import { cleanVersion, compareVersions, rangeBlocksLatest } from './version.js';

export interface DoctorResult {
  findings: Finding[];
  exitCode: number;
}

const PY_EXTS = ['.py'] as const;
const NODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

interface SourceIndex {
  pyFiles: { path: string; text: string }[];
  nodeFiles: { path: string; text: string }[];
}

function readAll(root: string, files: string[]): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const f of files) {
    try {
      out.push({ path: f, text: readFileSync(f, 'utf8') });
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

function indexSources(root: string): SourceIndex {
  return {
    pyFiles: readAll(root, walkSource(root, PY_EXTS)),
    nodeFiles: readAll(root, walkSource(root, NODE_EXTS)),
  };
}

/** Count `instrument(` call sites and note whether any Cendor symbol is used at all. */
function usage(src: SourceIndex): { instrumentCount: number; usesCendor: boolean } {
  let instrumentCount = 0;
  let usesCendor = false;
  const files = [...src.pyFiles, ...src.nodeFiles];
  for (const { text } of files) {
    if (/\binstrument\s*\(/.test(text)) {
      instrumentCount += (text.match(/\binstrument\s*\(/g) ?? []).length;
    }
    if (/from\s+cendor[.\s]|import\s+cendor|@cendor\//.test(text)) usesCendor = true;
  }
  return { instrumentCount, usesCendor };
}

function checkStrayInit(root: string, src: SourceIndex, out: Finding[]): void {
  const stray = src.pyFiles
    .filter((f) => /(?:^|[\\/])cendor[\\/]__init__\.py$/.test(f.path))
    .map((f) => rel(root, f.path));
  if (stray.length > 0) {
    out.push({
      severity: 'error',
      title: 'A top-level cendor/__init__.py exists',
      detail:
        '`cendor` is a PEP 420 namespace package. A top-level `cendor/__init__.py` in your own tree ' +
        'shadows the namespace and breaks every `from cendor.<tool> import ...`.',
      fix: 'Delete the file. Each Cendor distribution owns only cendor/<tool>/, never cendor/__init__.py.',
      locations: stray,
    });
  }
}

function checkBareImport(root: string, src: SourceIndex, out: Finding[]): void {
  const hits: string[] = [];
  for (const { path, text } of src.pyFiles) {
    // `import cendor` (bare) yields an EMPTY namespace object — almost always a mistake.
    if (/(?:^|\n)[ \t]*import[ \t]+cendor[ \t]*(?:#.*)?(?:\n|$)/.test(text))
      hits.push(rel(root, path));
  }
  if (hits.length > 0) {
    out.push({
      severity: 'warn',
      title: 'Bare `import cendor`',
      detail:
        '`cendor` is a namespace with no module body, so `import cendor` imports nothing usable.',
      fix: 'Import from the flat path instead, e.g. `from cendor.tokenguard import budget`.',
      locations: hits.slice(0, 8),
    });
  }
}

function checkInstrument(src: SourceIndex, u: ReturnType<typeof usage>, out: Finding[]): void {
  if (u.usesCendor && u.instrumentCount === 0) {
    out.push({
      severity: 'warn',
      title: 'No instrument() call found',
      detail:
        'Cendor is imported but the provider client is never wrapped, so nothing is observed — ' +
        'budgets, gating, and audit will all see zero calls.',
      fix: 'Wrap the client once: `client = instrument(OpenAI())` / `instrument(new OpenAI())`.',
    });
  }
}

const MONEY_CONTEXT = /(cost|price|prices|money|usd|\.estimate\s*\(|Money|Decimal)/;

function checkMoney(root: string, src: SourceIndex, out: Finding[]): void {
  const hits: string[] = [];
  for (const { path, text } of src.pyFiles) {
    for (const line of text.split('\n')) {
      if (/\bfloat\s*\(/.test(line) && MONEY_CONTEXT.test(line)) {
        hits.push(rel(root, path));
        break;
      }
    }
  }
  for (const { path, text } of src.nodeFiles) {
    for (const line of text.split('\n')) {
      if (
        (/\bNumber\s*\(/.test(line) || /\.toNumber\s*\(\)/.test(line)) &&
        MONEY_CONTEXT.test(line)
      ) {
        hits.push(rel(root, path));
        break;
      }
    }
  }
  if (hits.length > 0) {
    out.push({
      severity: 'warn',
      title: 'Money coerced to a float / number',
      detail:
        'Cost and price values are Decimal / decimal.js on purpose — converting to float/number ' +
        'reintroduces the rounding error the Decimal type exists to prevent.',
      fix: 'Keep money as Decimal / decimal.js; format only at the edge with str()/.toString().',
      locations: [...new Set(hits)].slice(0, 8),
    });
  }
}

function checkNodeProviders(
  root: string,
  detected: Detected,
  src: SourceIndex,
  out: Finding[],
): void {
  const used = new Set<string>();
  for (const { text } of src.nodeFiles)
    for (const p of providersUsedInSource(text, 'node')) used.add(p);
  const present = (provider: string): boolean => {
    if (detected.declaredProviders.has(provider)) return true; // in package.json
    const pkg = NPM_PKG_FOR_PROVIDER[provider];
    return pkg ? existsSync(join(root, 'node_modules', ...pkg.split('/'))) : false; // installed
  };
  for (const p of [...used].filter((prov) => !present(prov))) {
    const pkg = NPM_PKG_FOR_PROVIDER[p] ?? p;
    out.push({
      severity: 'error',
      title: `Provider SDK "${pkg}" is used but not installed`,
      detail: `Your code imports "${pkg}", but it is neither in package.json nor node_modules. Cendor never pulls a provider SDK for you — it is a peer dependency you install.`,
      fix: `npm i ${pkg}`,
    });
  }
}

function checkPyProviders(detected: Detected, src: SourceIndex, out: Finding[]): void {
  const used = new Set<string>();
  for (const { text } of src.pyFiles)
    for (const p of providersUsedInSource(text, 'python')) used.add(p);
  const declared = detected.declaredProviders;
  const missing = [...used].filter((p) => !declared.has(p));
  for (const p of missing) {
    const extra = PYPI_EXTRA_FOR_PROVIDER[p];
    out.push({
      severity: 'warn',
      title: `Provider SDK for "${p}" is imported but not declared`,
      detail: `Your Python code imports the ${p} SDK, but it is not declared in pyproject/requirements. Provider SDKs are optional extras — install only what you call. (Run \`uvx cendor-init doctor\` for an exact installed-environment check.)`,
      fix: extra
        ? `pip install "cendor-sdk[${extra}]"  (or the provider package directly)`
        : undefined,
    });
  }
}

/**
 * Flag @cendor/* packages behind the latest release.
 *
 * `latest`/`asOf` come from the LIVE feed when `doctor --online` was asked for; with them omitted
 * this reads the bundled snapshot and makes no network call at all (the default).
 */
function checkNpmVersions(
  detected: Detected,
  out: Finding[],
  latest?: Record<string, string>,
  asOf?: string,
): void {
  const snap = versionsSnapshot();
  const live = latest !== undefined;
  const latestOf = latest ?? snap.npm;
  const stamp = asOf || snap.asOf;
  const behind: string[] = [];
  // Installed versions are exact — compare directly. Declared-only ranges: warn only when the range
  // PROVABLY excludes latest (a caret on 0.x, a `<` bound, an exact pin) — never on an open `>=`.
  for (const [name, ver] of Object.entries(detected.installedNpm)) {
    const want = latestOf[name];
    const have = cleanVersion(ver);
    if (want && have && compareVersions(have, want) < 0) {
      behind.push(`${name} ${have} (installed) < ${want}`);
    }
  }
  for (const [name, spec] of Object.entries(detected.declaredNpm)) {
    if (name in detected.installedNpm) continue;
    const want = latestOf[name];
    if (want && rangeBlocksLatest(spec, want)) behind.push(`${name} "${spec}" excludes ${want}`);
  }
  if (behind.length > 0) {
    const source = live
      ? `the live feed at ${RELEASES_URL} (as of ${stamp})`
      : `the bundled snapshot (as of ${stamp}). This is an offline hint — re-run with --online, or see /releases, for the canonical answer`;
    out.push({
      severity: 'warn',
      title: 'A Cendor package looks behind the latest release',
      detail: `An installed or pinned version trails ${source}. Type Teach and fixes only arrive on upgrade.`,
      fix: 'npm i @cendor/…@latest  (check https://cendor.ai/releases)',
      locations: behind,
    });
  }
}

/** Lockfiles that pin a resolved version regardless of how wide the declared range is. */
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

/**
 * Name the LOCKFILE when it is what is holding a project back.
 *
 * A wide declared range (`^0.16.0`) looks healthy while the lock beside it pins 0.16.0 and `npm
 * install` honours it. Cendor's own cookbook JS recipes were frozen exactly this way — the caret was
 * fine, the committed lock was the constraint, and CI stayed green throughout.
 */
function checkLockfile(root: string, out: Finding[]): void {
  const snap = versionsSnapshot();
  for (const lockName of LOCKFILES) {
    const lock = join(root, lockName);
    if (!existsSync(lock)) continue;

    let text: string;
    try {
      text = readFileSync(lock, 'utf8');
    } catch {
      return;
    }

    const stale: string[] = [];
    if (lockName === 'package-lock.json') {
      // npm's lock is JSON: node_modules/@cendor/<x> -> { version }.
      try {
        const parsed = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
        for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
          const name = path.replace(/^.*node_modules\//, '');
          if (!name.startsWith('@cendor/') || !entry?.version) continue;
          const want = snap.npm[name];
          const have = cleanVersion(entry.version);
          if (want && have && compareVersions(have, want) < 0) {
            stale.push(`${name} ${have} (locked in ${lockName}) < ${want}`);
          }
        }
      } catch {
        return; // an unparseable lock is not ours to diagnose
      }
    } else {
      // pnpm/yarn: text scan for `@cendor/<x>@<version>` — no YAML dependency for a hint.
      for (const m of text.matchAll(/(@cendor\/[a-z]+)[@:]\s*'?(\d+\.\d+\.\d+)/g)) {
        const pkg = m[1];
        const ver = m[2];
        if (!pkg || !ver) continue; // noUncheckedIndexedAccess: a group can be undefined
        const want = snap.npm[pkg];
        const have = cleanVersion(ver);
        if (want && have && compareVersions(have, want) < 0) {
          const line = `${pkg} ${have} (locked in ${lockName}) < ${want}`;
          if (!stale.includes(line)) stale.push(line);
        }
      }
    }

    if (stale.length > 0) {
      out.push({
        severity: 'warn',
        title: `${lockName} pins Cendor below the latest release`,
        detail:
          'Your declared ranges may be perfectly wide — the LOCKFILE is what is holding these versions. Nothing will upgrade, and the build stays green, until you move the lock.',
        fix: 'npm update   (then re-run your tests)',
        locations: stale,
      });
    }
    return; // one lockfile per project; the first found is the one in force
  }
}

const SNAPSHOT_UPDATED_RE = /"_updated"\s*:\s*"(\d{4}-\d{2}-\d{2})"/;
export const PRICE_SNAPSHOT_MAX_AGE_DAYS = 30;

/**
 * Warn when the installed @cendor/core's bundled price snapshot is >30 days old. Reads the
 * embedded snapshot text from node_modules (no import, still offline); skips silently when
 * @cendor/core isn't installed here.
 */
function checkPriceSnapshot(root: string, detected: Detected, out: Finding[]): void {
  if (!('@cendor/core' in detected.installedNpm)) return;
  try {
    const file = join(root, 'node_modules', '@cendor', 'core', 'dist', 'prices-snapshot.js');
    if (!existsSync(file)) return;
    const m = SNAPSHOT_UPDATED_RE.exec(readFileSync(file, 'utf8'));
    if (!m?.[1]) return;
    const ageMs = Date.now() - new Date(`${m[1]}T00:00:00Z`).getTime();
    const age = Math.floor(ageMs / 86_400_000);
    if (age > PRICE_SNAPSHOT_MAX_AGE_DAYS) {
      out.push({
        severity: 'warn',
        title: `Bundled price snapshot is ${age} days old`,
        detail: `@cendor/core's offline price table is dated ${m[1]}. Models released since then estimate at $0 (a warn-once blind spot for USD budgets) until the table is refreshed.`,
        fix: 'Call `prices.refresh()` at startup, or upgrade: npm i @cendor/core@latest',
      });
    }
  } catch {
    // a hint, never a doctor failure
  }
}

// --------------------------------------------------------------------------- telemetry (the switch)
/** Source patterns that mean "this app configures an OpenTelemetry provider itself". */
const OTEL_PROVIDER_RE =
  /setGlobalTracerProvider\s*\(|new\s+NodeSDK\s*\(|useAzureMonitor\s*\(|OTEL_EXPORTER_OTLP_ENDPOINT/;
/** Floors for the automatic path (the versions that carry the switch). */
export const TELEMETRY_FLOORS: Record<string, string> = {
  '@cendor/core': '0.15.0',
  '@cendor/sdk': '0.22.0',
  '@cendor/acttrace': '0.13.0',
  '@cendor/tokenguard': '0.7.0',
};

/**
 * Telemetry wiring, statically.
 *
 * Three things can silently cost an app its telemetry: `CENDOR_TELEMETRY=off` committed next to a
 * configured provider, an OTel pipeline on a Cendor too old to emit by itself, and a
 * `new OTelSink()` on `@cendor/tokenguard` < 0.7.0 constructed above the provider (a permanent
 * no-op counter — the JS metrics API has no proxy). None of them raises at runtime, because the
 * emitters are deliberately silent, so they belong in `doctor`.
 */
function checkTelemetry(root: string, detected: Detected, src: SourceIndex, out: Finding[]): void {
  const files = [...src.pyFiles, ...src.nodeFiles];
  const configures = files.some((f) => OTEL_PROVIDER_RE.test(f.text));
  const offLocations = files
    .filter((f) => f.text.includes('CENDOR_TELEMETRY=off'))
    .map((f) => rel(root, f.path));
  if (configures && offLocations.length > 0) {
    out.push({
      severity: 'warn',
      title: 'CENDOR_TELEMETRY=off next to a configured OpenTelemetry provider',
      detail:
        'This app configures an OTel provider, but `CENDOR_TELEMETRY=off` appears in the source/config ' +
        '— so Cendor emits nothing: no call spans, no spend counters, no governance spans. That is a ' +
        'valid choice; it is only worth flagging because nothing warns at runtime.',
      fix: 'Remove `CENDOR_TELEMETRY=off` (or set it to `auto`) to let telemetry flow.',
      locations: offLocations,
    });
  }
  if (configures) {
    const behind: string[] = [];
    for (const [pkg, floor] of Object.entries(TELEMETRY_FLOORS)) {
      const installed = detected.installedNpm[pkg];
      const have = installed ? cleanVersion(installed) : null;
      if (have && compareVersions(have, floor) < 0) behind.push(`${pkg} ${have} < ${floor}`);
    }
    if (behind.length > 0) {
      out.push({
        severity: 'warn',
        title: 'A Cendor package predates automatic telemetry',
        detail:
          'This app configures an OpenTelemetry provider, but a package is older than the release ' +
          'where Cendor started emitting on its own. Until you upgrade, telemetry needs the explicit ' +
          'attachments (`otel.useSpanEmitter()`, `useSink(new OTelSink())`, `liveSpans()`, ' +
          '`new AuditLog(s, { mirror: new OTelMirror() })`).',
        fix: 'npm i @cendor/core@latest @cendor/sdk@latest',
        locations: behind,
      });
    }
  }
  const sinkFiles = src.nodeFiles.filter((f) => f.text.includes('new OTelSink('));
  const tgInstalled = detected.installedNpm['@cendor/tokenguard'];
  const tgOld = tgInstalled
    ? compareVersions(cleanVersion(tgInstalled) ?? '0.0.0', '0.7.0') < 0
    : false;
  if (sinkFiles.length > 0) {
    out.push({
      severity: tgOld ? 'warn' : 'info',
      title: tgOld
        ? 'new OTelSink() on @cendor/tokenguard < 0.7.0 (order-sensitive)'
        : 'TypeScript OTelSink constructed by hand',
      detail:
        'In `@cendor/tokenguard` < 0.7.0 a sink constructed BEFORE the app’s provider bound a ' +
        'no-op counter permanently (the JS metrics API has no proxy), so spend counters were silently ' +
        'empty. From 0.7.0 the meter is acquired lazily and order no longer matters — and the ' +
        'automatic spend tap means you usually need no sink at all.',
      fix: 'Drop the explicit sink (telemetry flows on its own), or upgrade: npm i @cendor/tokenguard@latest',
      locations: sinkFiles.map((f) => rel(root, f.path)),
    });
  }
}

/** What a caller may hand in from the live feed. Absent ⇒ the offline snapshot, and no network. */
export interface LiveVersions {
  npm: Record<string, string>;
  asOf?: string;
  /** Set when `--online` was asked for but the feed could not be read; rendered as an info finding. */
  error?: string;
}

/**
 * Static-check a project's Cendor wiring.
 *
 * `live` is only ever populated by `doctor --online`. **With it omitted this makes no network call of
 * any kind** — that is the contract, and a test asserts it. Cendor never checks for updates on its
 * own; the tooling checks only when you ask.
 */
export function runDoctor(root: string, live?: LiveVersions): DoctorResult {
  const detected = detectProject(root);
  const src = indexSources(root);
  const u = usage(src);
  const findings: Finding[] = [];

  if (live?.error) {
    findings.push({
      severity: 'info',
      title: 'Could not reach the live release feed — using the bundled snapshot',
      detail: `${live.error}. Version findings below compare against the snapshot baked into this CLI (as of ${versionsSnapshot().asOf}), which may be older than what is published.`,
      fix: `Check ${RELEASES_URL} in a browser, or drop --online.`,
    });
  }

  // Universal checks (both file types).
  checkStrayInit(root, src, findings);
  checkBareImport(root, src, findings);
  checkInstrument(src, u, findings);
  checkMoney(root, src, findings);
  checkTelemetry(root, detected, src, findings);

  // Native-ecosystem checks.
  if (detected.node) {
    checkNodeProviders(root, detected, src, findings);
    checkNpmVersions(detected, findings, live?.error ? undefined : live?.npm, live?.asOf);
    checkLockfile(root, findings);
    checkPriceSnapshot(root, detected, findings);
  }
  if (detected.python) {
    checkPyProviders(detected, src, findings);
    findings.push({
      severity: 'info',
      title: 'Python project detected',
      detail:
        'This CLI checks the npm ecosystem exactly. For accurate installed-environment Python checks ' +
        '(peer deps, exact package versions), run `uvx cendor-init doctor` from the same project — it ' +
        'reads the real environment instead of guessing from manifest ranges.',
    });
  }

  if (
    !u.usesCendor &&
    Object.keys(detected.installedNpm).length === 0 &&
    Object.keys(detected.declaredNpm).length === 0 &&
    Object.keys(detected.declaredPypi).length === 0
  ) {
    findings.unshift({
      severity: 'info',
      title: 'No Cendor usage detected',
      detail: 'Found no Cendor imports or dependencies in this project — nothing to validate.',
      fix: 'Run `npx @cendor/init` to wire Cendor + your AI assistant in one step.',
    });
  } else if (!findings.some((f) => f.severity === 'error' || f.severity === 'warn')) {
    findings.push({
      severity: 'ok',
      title: 'Wiring looks good',
      detail: `Cendor usage found${u.instrumentCount > 0 ? `, instrument() called ${u.instrumentCount}×` : ''}; no problems detected.`,
    });
  }

  const exitCode = findings.some((f) => f.severity === 'error') ? 1 : 0;
  return { findings, exitCode };
}

export const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2, ok: 3 };
