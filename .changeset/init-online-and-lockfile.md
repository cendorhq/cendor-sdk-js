---
'@cendor/init': minor
---

`doctor --online` + lockfile detection.

**`--online` is opt-in.** It compares your installed/pinned versions against the live feed at
`https://cendor.ai/releases.json` instead of the snapshot compiled into this CLI. That snapshot is a
lagging oracle by construction — only as fresh as the CLI — and `npx @cendor/init` keeps the
documented path current, but a **pinned** init in CI, which is exactly where "you are behind" matters
most, can be arbitrarily stale.

**Without the flag there is no network call at all.** That is now asserted by a test (it poisons
`globalThis.fetch` and runs `doctor`) rather than assumed: Cendor never checks for updates on its own,
and the default has to keep that true. An unreachable feed degrades to the bundled snapshot with an
`info` finding and does not change the exit code — being offline is not a wiring problem.

**Lockfile detection.** `doctor` now reads `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` and
names the **lock** when the lock is what is holding Cendor back. A caret can look perfectly healthy
while the committed lock beside it is the real constraint, and the build stays green throughout.
Honest limit: it reports what is pinned, it does not resolve.

The bundled versions snapshot is now **generated** from the site's single version source rather than
hand-synced, and carries the 2026-07-27 shelf.
