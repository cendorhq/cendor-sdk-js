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

function checkNpmVersions(detected: Detected, out: Finding[]): void {
  const snap = versionsSnapshot();
  const behind: string[] = [];
  // Installed versions are exact — compare directly. Declared-only ranges: warn only when the range
  // PROVABLY excludes latest (a caret on 0.x, a `<` bound, an exact pin) — never on an open `>=`.
  for (const [name, ver] of Object.entries(detected.installedNpm)) {
    const latest = snap.npm[name];
    const have = cleanVersion(ver);
    if (latest && have && compareVersions(have, latest) < 0) {
      behind.push(`${name} ${have} (installed) < ${latest}`);
    }
  }
  for (const [name, spec] of Object.entries(detected.declaredNpm)) {
    if (name in detected.installedNpm) continue;
    const latest = snap.npm[name];
    if (latest && rangeBlocksLatest(spec, latest))
      behind.push(`${name} "${spec}" excludes ${latest}`);
  }
  if (behind.length > 0) {
    out.push({
      severity: 'warn',
      title: 'A Cendor package looks behind the latest release',
      detail: `An installed or pinned version trails the bundled snapshot (as of ${snap.asOf}). Type Teach and fixes only arrive on upgrade. This is an offline hint — /releases is the source of truth.`,
      fix: 'npm i @cendor/…@latest  (check https://cendor.ai/releases)',
      locations: behind,
    });
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

export function runDoctor(root: string): DoctorResult {
  const detected = detectProject(root);
  const src = indexSources(root);
  const u = usage(src);
  const findings: Finding[] = [];

  // Universal checks (both file types).
  checkStrayInit(root, src, findings);
  checkBareImport(root, src, findings);
  checkInstrument(src, u, findings);
  checkMoney(root, src, findings);

  // Native-ecosystem checks.
  if (detected.node) {
    checkNodeProviders(root, detected, src, findings);
    checkNpmVersions(detected, findings);
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
