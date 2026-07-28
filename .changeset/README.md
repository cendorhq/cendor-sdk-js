# Changesets

Run `pnpm changeset` to record a version bump for `@cendor/sdk` or `@cendor/init`.

**A changeset that reaches `main` publishes — there is no version PR to review first.**
`.github/workflows/release.yml` triggers on every push to `main` and publishes directly: a `verify`
job mirrors CI (one `@cendor/core`, `pnpm build`, `pnpm lint`, the major-bump approval gate, and the
test suite on Node 20 + 22), the `release` job `needs:` it, and only then does it run
`changeset version` (committing the bumps + CHANGELOGs back to `main` with `[skip ci]`),
`changeset publish` with the `NPM_TOKEN` secret, and a tag push. A push carrying no changeset
publishes nothing, so merge the changeset when you intend the release.

npm **provenance** is off for now (`NPM_CONFIG_PROVENANCE: "false"` — sigstore rejects a private
source repo with E422); it turns on when this repo goes public. Runbook: [`../PUBLISHING.md`](../PUBLISHING.md).
