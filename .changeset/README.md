# Changesets

Run `pnpm changeset` to record a version bump for `@cendor/sdk` or `@cendor/init`.

**Releasing takes two steps, and publishing is a MERGE — not a push.**
`.github/workflows/release.yml` triggers on every push to `main`. A `verify` job mirrors CI (one
`@cendor/core`, `pnpm build`, `pnpm lint`, the major-bump approval gate, and the test suite on Node 20
+ 22) and the `release` job declares `needs:` on it, so nothing moves unless the gate is green. What
happens next depends on whether changesets are pending:

1. **Changesets present** → a pull request titled **`chore: version packages`** is opened or updated on
   the branch `changeset-release/main`, carrying the version bumps and CHANGELOG entries for review.
   **Nothing is published at this point.**
2. **No changesets, versions already bumped** — i.e. you merged that PR → `changeset publish` runs,
   publishing to npm with the `NPM_TOKEN` secret and tagging `@cendor/<pkg>@<version>`.

So a release is: land your changeset → review the version PR → **merge it to publish.**

> This replaced a direct publish-on-push flow on 2026-07-29. Under that flow a single push to `main`
> carrying a changeset went straight to npm with no human step in between — tolerable while the repo
> was private and the audience was one person, but in public an accidental push is a release.

npm **provenance** is off for now (`NPM_CONFIG_PROVENANCE: "false"` — sigstore rejects a private
source repo with E422); it turns on when this repo goes public. Runbook:
[`../PUBLISHING.md`](../PUBLISHING.md).
