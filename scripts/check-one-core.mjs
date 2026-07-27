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

/** Every installed copy of PKG under `dir`, as {version, path}. Walks node_modules trees only. */
function findCopies(dir, found = [], seen = new Set()) {
  const real = realOrNull(dir);
  if (!real || visited.has(real)) return found;
  visited.add(real);

  const nm = join(dir, 'node_modules');
  if (!existsSync(nm)) return found;

  // Direct hit: node_modules/@cendor/core
  const direct = join(nm, ...PKG.split('/'), 'package.json');
  if (existsSync(direct)) record(direct, found, seen);

  // pnpm's store. Count only copies something actually LINKS TO — never a store root just because
  // it exists on disk.
  //
  // The first version of this enumerated `.pnpm/@cendor+core@<ver>/` directly, and that produced a
  // FALSE ALARM the first time it met a real major upgrade: `pnpm install` leaves the previous
  // version's store directory behind, unreferenced, and the gate reported "2 versions installed"
  // for a tree whose only live symlink pointed at 1.0.0. A gate that cries wolf gets ignored — and
  // this one exists precisely to be believed when it fires.
  //
  // So: a store ROOT (`.pnpm/@cendor+core@X/node_modules/@cendor/core`) is the link TARGET, not a
  // copy. What counts is a DEPENDENT's link (`.pnpm/<some-pkg>@Y/node_modules/@cendor/core`) — which
  // is exactly how a genuine duplicate manifests, and which names the culprit package in the report
  // instead of an anonymous store path. Realpath-deduping collapses many links to one real copy.
  const store = join(nm, '.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      // Skip core's OWN store root — it is the target, and it survives an upgrade unreferenced.
      if (entry.startsWith('@cendor+core@')) continue;
      const p = join(store, entry, 'node_modules', ...PKG.split('/'), 'package.json');
      if (existsSync(p)) record(p, found, seen);
    }
  }

  // npm nests duplicates inside the dependent that needs them.
  for (const entry of readdirSync(nm)) {
    if (entry === '.pnpm' || entry === '.bin') continue;
    const child = join(nm, entry);
    if (!safeIsDir(child)) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(child)) {
        const p = join(child, scoped);
        if (safeIsDir(p)) findCopies(p, found, seen);
      }
    } else {
      findCopies(child, found, seen);
    }
  }
  return found;
}

const safeIsDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

let failed = false;
for (const root of roots) {
  visited.clear(); // per-root, so two roots that overlap on disk are each walked fully
  const copies = findCopies(root);
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
