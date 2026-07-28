/**
 * OPT-IN live version lookup for `doctor --online`. Twin of cendor-init's `online.py`.
 *
 * Cendor never checks for updates on its own — no library opens a socket, and `doctor` with no flag
 * makes zero network calls (there is a test that asserts exactly that). This exists so a human, or a
 * CI job, can *deliberately* ask "what is current?" rather than trusting the snapshot baked into
 * whichever version of this CLI happens to be installed.
 *
 * The offline snapshot is a lagging oracle by construction: it is only as fresh as the CLI. `npx
 * @cendor/init` fetches the latest CLI each run, so the documented path stays current — but a
 * *pinned* init in CI, which is exactly where "you are behind" matters most, can be arbitrarily
 * stale. `--online` closes that gap without making the network the default.
 *
 * Source: https://cendor.ai/releases.json — a static, CORS-open feed rendered from the same data as
 * the human /releases page, so the two cannot disagree.
 *
 * Uses global `fetch` (built in since Node 18; this package requires Node >= 20) — no dependency added.
 */

/**
 * The live feed. Its field shape is a stable contract — fields are added, never renamed or removed —
 * so an older pinned CLI keeps reading it.
 */
export const RELEASES_URL = 'https://cendor.ai/releases.json';

/** Short by design — a version check must never be the reason a CI job hangs. */
export const TIMEOUT_MS = 5000;

export interface ReleaseRow {
  name: string;
  pypi: string;
  pypiVer: string;
  npm: string;
  npmVer: string;
}

export interface ReleaseFeed {
  asOf?: string;
  libraries?: ReleaseRow[];
  sdk?: ReleaseRow[];
  devtooling?: ReleaseRow[];
}

/** The live feed could not be read. Carries a reason a human can act on, never a stack trace. */
export class OnlineLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineLookupError';
  }
}

/**
 * Fetch and parse the live release feed.
 *
 * @throws {OnlineLookupError} on any network, HTTP, or parse failure. Callers degrade to the offline
 * snapshot rather than failing the run: being unable to reach the internet is not a wiring problem,
 * and `doctor` is meant to work offline.
 */
export async function fetchReleases(
  url: string = RELEASES_URL,
  timeoutMs: number = TIMEOUT_MS,
): Promise<ReleaseFeed> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': '@cendor/init doctor --online' },
    });
  } catch (err) {
    const why =
      (err as Error)?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err);
    throw new OnlineLookupError(`could not reach ${url} (${why})`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new OnlineLookupError(`${url} returned HTTP ${res.status}`);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new OnlineLookupError(`${url} did not return valid JSON`);
  }
  if (typeof data !== 'object' || data === null || !('libraries' in data)) {
    throw new OnlineLookupError(`${url} returned an unexpected shape (no 'libraries')`);
  }
  return data as ReleaseFeed;
}

/**
 * Flatten the feed's rows into `{ "@cendor/<pkg>": version }`, matching the snapshot's `npm` map.
 *
 * Unknown or future top-level sections are ignored rather than erroring: the feed's contract is that
 * fields are only ever ADDED, so an older CLI must keep working against a newer feed.
 */
export function npmMap(feed: ReleaseFeed): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of ['libraries', 'sdk', 'devtooling'] as const) {
    for (const row of feed[section] ?? []) {
      if (
        row &&
        typeof row.npm === 'string' &&
        typeof row.npmVer === 'string' &&
        row.npm &&
        row.npmVer
      ) {
        out[`@cendor/${row.npm}`] = row.npmVer;
      }
    }
  }
  return out;
}
