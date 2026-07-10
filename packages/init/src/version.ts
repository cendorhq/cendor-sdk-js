/** Minimal version helpers — enough for x.y.z comparisons; no semver dependency (offline, light). */

/** Strip a range operator/prefix (`^1.2.3`, `>=1.2`, `~1`) down to its first x.y.z-ish token. */
export function cleanVersion(spec: string): string | null {
  const m = spec.match(/(\d+(?:\.\d+){0,2})/);
  return m ? (m[1] as string) : null;
}

/** Compare two dotted numeric versions. -1 if a<b, 0 if equal, 1 if a>b. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Does a declared npm range provably EXCLUDE `latest` (so the user is stuck behind it)? Honest and
 * conservative: only returns true when we are confident — an open-ended `>=`/`*` returns false
 * (latest is reachable, just not installed). Handles caret/tilde/exact/upper-bound forms.
 */
export function rangeBlocksLatest(spec: string, latest: string): boolean {
  const s = spec.trim();
  if (s === '' || s === '*' || s === 'latest' || s.startsWith('workspace:')) return false;

  // Explicit upper bound `<Y` / `<=Y` that excludes latest.
  const upper = s.match(/<(=?)\s*(\d+(?:\.\d+){0,2})/);
  if (upper) {
    const inclusive = upper[1] === '=';
    const bound = upper[2] as string;
    const c = compareVersions(latest, bound);
    if (inclusive ? c > 0 : c >= 0) return true;
  }

  const floor = cleanVersion(s);
  if (!floor) return false;

  if (s.startsWith('^')) {
    const [a = 0, b = 0, c = 0] = floor.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const ceil = a > 0 ? `${a + 1}.0.0` : b > 0 ? `0.${b + 1}.0` : `0.0.${c + 1}`;
    return compareVersions(latest, ceil) >= 0; // caret excludes >= ceiling
  }
  if (s.startsWith('~')) {
    const [a = 0, b = 0] = floor.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return compareVersions(latest, `${a}.${b + 1}.0`) >= 0; // tilde excludes >= next minor
  }
  // Exact pin (`==1.2.3` or a bare `1.2.3`, no range operator) below latest.
  if (/^(==)?\s*\d/.test(s) && !/[>~^]/.test(s)) return compareVersions(floor, latest) < 0;

  return false; // open-ended `>=`/`>` — latest is reachable
}
