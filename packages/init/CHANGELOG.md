# @cendor/init

## 0.4.1

### Patch Changes

- 6b9cd6f: Declare the Node floor we actually test and can satisfy: `>=20`, not `>=18`.

  `@cendor/sdk` claimed `engines.node >=18` while every `@cendor/*` library it depends on declares
  `>=20`, so a Node 18 install resolved to an engines conflict raised by the transitive `@cendor/core`
  rather than by the package the user asked for. CI has only ever tested Node 20 and 22, in both
  `ci.yml` and the `verify` job that gates a release, so `>=18` was never an evidenced claim.

  `@cendor/init` has no runtime dependencies, so `>=18` was satisfiable there — but equally untested,
  and a CLI that claims a floor no CI exercises is the same defect in a quieter form. Both now state
  the tested floor. Nothing else changes: no API, no behaviour, no output.

## 0.4.0

### Minor Changes

- 2f709ed: `doctor --online` + lockfile detection.

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

## 0.3.0

**Never published — this version does not exist on npm.** `npm view @cendor/init versions` goes
`0.2.2` → `0.4.0`, and no `@cendor/init@0.3.0` tag was ever cut.

`0.3.0` was written by hand into `packages/init/package.json` (`2f709ed`, "release(init):
@cendor/init 0.3.0 — doctor `--online` + lockfile detection") while the changeset describing that
same work was still pending. Versions here are owned by changesets, so the release run applied the
pending **minor** on top of the hand-written `0.3.0` and published **0.4.0** instead.

Nothing was lost: every change meant for `0.3.0` — `doctor --online`, lockfile detection, and the
generated versions snapshot — shipped in [0.4.0](#040) above, whose entry is that changeset.

## 0.2.2

### Patch Changes

- 28f6731: `init --scaffold` now emits a provider-key line in the starter and next-steps (the SDK reads the
  provider's standard env var, e.g. `OPENAI_API_KEY`, or `apiKey` on the Agent — never a Cendor key),
  and the offline versions snapshot is refreshed to the 2026-07-13 shelf (`@cendor/sdk` 0.9.2,
  `@cendor/init` 0.2.2, mirroring `cendor-sdk` 1.6.2 / `cendor-init` 0.2.2).

## 0.2.1

### Patch Changes

- 434ad67: `doctor` now warns when the installed `@cendor/core`'s bundled price snapshot is more than 30 days
  old (models released since then estimate at $0 until `prices.refresh()` or an upgrade — an offline
  hint, never an error). The offline versions snapshot is refreshed to the 2026-07-11 patch shelf
  (core 0.5.2 / 1.5.2, mcp 0.1.3, init 0.2.1).

## 0.2.0

### Minor Changes

- e29c748: SDK-aware `--scaffold`. When `@cendor/sdk` / `cendor-sdk` is detected in the project (declared or
  installed), `init --scaffold` now writes a governed **`Agent`** starter — budget cap + a guardrails
  deny rule + `guard(Policy…)` PII redaction + a tamper-evident `AuditLog`, on one `run()` — instead
  of the bare `instrument()` + budget starter. Libraries-only projects keep the existing starter. No
  other behaviour changes; the Python twin (`cendor-init`) ships the same branch.

## 0.1.1

### Patch Changes

- 9c81182: Tidy the init CLI: remove the dead, undocumented `-y/--yes` flag; snapshot the `@cendor/mcp` /
  `@cendor/init` package versions so `doctor` can flag them when a project pins an outdated one; and
  re-point the vendored rules-template comments at the new `assistant-rules` docs page (the docs split
  the AI-assistant material out of `for-ai-assistants`). Template bodies are byte-identical — no
  behavior change.
