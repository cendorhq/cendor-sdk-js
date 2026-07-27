#!/usr/bin/env node
// GATE G1 — exactly ONE @cendor/core must be installed.
//
// WHY
// Every @cendor/* sibling declares `@cendor/core` with a caret. At 0.x a caret never crosses a minor,
// so the moment one package pins ^0.16 while another still pins ^0.15, the package manager installs
// TWO copies of core — which means TWO event buses. Cross-library cooperation then stops SILENTLY: a
// guardrail decision emitted on bus A is never seen by the SDK listening on bus B. Measured live on
// 2026-07-25 (@cendor/guardrails 0.7.6 pinned ^0.12.2 against an SDK on 0.15.0) and again on
// 2026-07-26 in cendor-testsuits. Nothing failed loudly either time.
//
// This gate converts that silence into a red build. It is intentionally dependency-free and works for
// both npm (nested node_modules) and pnpm (the .pnpm content-addressed store).
//
// USAGE   node scripts/check-one-core.mjs [rootDir ...]
// EXIT    0 = exactly one version (or none installed); 1 = two or more

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PKG = '@cendor/core';
const roots = (process.argv.slice(2).length ? process.argv.slice(2) : ['.']).map((p) => resolve(p));

// A pnpm workspace links siblings by SYMLINK (packages/tokenguard/node_modules/@cendor/core ->
// packages/core), so an unguarded walk can revisit the same real directory forever. Dedupe on the
// resolved real path, which also means a symlinked copy and its target count as ONE copy — exactly
// the semantics we want (a link is not a second core).
const visited = new Set();
const realOrNull = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** Every REACHABLE copy of PKG under `dir`, as {version, path}.
 *
 * REACHABILITY IS THE WHOLE ALGORITHM, and it took two false alarms to learn why.
 *
 * `pnpm install` does not prune its content-addressed store: after an upgrade,
 * `.pnpm/@cendor+core@<old>/` and `.pnpm/@cendor+acttrace@<old>/` both remain on disk, unreferenced.
 * Two earlier versions of this gate enumerated store directories and so counted those corpses as
 * installed copies — it reported "2 versions of @cendor/core" for trees where the live graph held
 * exactly one. A gate that cries wolf gets ignored, and this one exists to be believed when it fires.
 *
 * So we never enumerate the store. We walk the graph the runtime actually walks: start at the
 * project's own `node_modules` (the links pnpm creates for DECLARED deps), follow each into whatever
 * it resolves to, and recurse through that package's own `node_modules`. An orphan is unreachable by
 * construction — nothing links to it — so it cannot be counted. A genuine duplicate stays visible,
 * because a dependent still on the old shelf IS reachable, and the report names that dependent.
 *
 * This is also correct for npm, whose duplicates are real nested directories rather than links.
 */
function findCopies(dir, found = [], seen = new Set()) {
  const real = realOrNull(dir);
  if (!real || visited.has(real)) return found;
  visited.add(real);

  const nm = join(dir, 'node_modules');
  if (!existsSync(nm)) return found;

  // Is this package itself the one we're hunting?
  const direct = join(nm, ...PKG.split('/'), 'package.json');
  if (existsSync(direct)) record(direct, found, seen);

  // Recurse into every DECLARED dependency link. `.pnpm` is skipped deliberately: it is the store,
  // reached only by following a link into it, never by enumeration.
  for (const entry of readdirSync(nm)) {
    if (entry === '.pnpm' || entry === '.bin' || entry.startsWith('.')) continue;
    const child = join(nm, entry);
    if (!existsSync(child)) continue; // a broken link from a half-pruned tree
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(child)) {
        const p = join(child, scoped);
        if (existsSync(p)) findCopies(p, found, seen);
      }
    } else {
      findCopies(child, found, seen);
    }
  }
  return found;
}

function record(pkgJsonPath, found, seen) {
  // Dedupe on the REAL path so a workspace symlink and its target are not counted twice.
  const key = realOrNull(pkgJsonPath) ?? pkgJsonPath;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    const j = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (j.name === PKG) found.push({ version: j.version, path: pkgJsonPath });
  } catch {
    /* unreadable package.json — not a copy we can attribute */
  }
}

/** Seeds for one project: the root, plus every workspace package (whose deps live in their OWN
 * node_modules and are not reachable from the root's). Missing `packages/` is fine — a plain app. */
function seedsFor(root) {
  const seeds = [root];
  const pkgs = join(root, 'packages');
  if (existsSync(pkgs)) {
    for (const name of readdirSync(pkgs)) {
      const p = join(pkgs, name);
      if (existsSync(join(p, 'package.json'))) seeds.push(p);
    }
  }
  return seeds;
}

let failed = false;
for (const root of roots) {
  visited.clear(); // per-root, so two roots that overlap on disk are each walked fully
  const copies = [];
  const seen = new Set();
  for (const seed of seedsFor(root)) findCopies(seed, copies, seen);
  const versions = [...new Set(copies.map((c) => c.version))].sort();

  if (versions.length === 0) {
    console.log(`  skip   ${root}  (${PKG} not installed)`);
    continue;
  }
  if (versions.length === 1) {
    console.log(`  ok     ${root}  ${PKG}@${versions[0]}  (${copies.length} path(s), one version)`);
    continue;
  }

  failed = true;
  console.error(`\n  FAIL   ${root}`);
  console.error(`         ${versions.length} versions of ${PKG} installed: ${versions.join(', ')}`);
  console.error(
    '         Two copies of core = two event buses. Cross-library cooperation stops silently.',
  );
  for (const c of copies.sort((a, b) => a.version.localeCompare(b.version))) {
    console.error(`           ${c.version}  ${c.path}`);
  }
  console.error(
    '         FIX: bump the WHOLE @cendor/* set to one shelf (not just core), then reinstall.\n',
  );
}

if (failed) {
  console.error('G1 one-core: FAILED');
  process.exit(1);
}
console.log('G1 one-core: PASS');
