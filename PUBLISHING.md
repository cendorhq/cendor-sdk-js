# Publishing `@cendor/sdk`

`@cendor/sdk` depends on the six `@cendor/*` libraries, so **publish those first** (see
`cendor-libs-js/PUBLISHING.md`). Then the SDK follows the identical flow: tokenless npm **trusted
publishing** + provenance, versions driven by Changesets, git tag ≍ manifest version.

## Local development
`@cendor/*` are linked from the sibling `../cendor-libs-js` repo via `pnpm.overrides` (`link:`) in
`package.json` — so `pnpm install` works against the local, built libs. Build the libs first
(`cd ../cendor-libs-js && pnpm build`).

## First publish (once, after the libs are on npm)
```bash
# with @cendor/* published, the link overrides resolve to real versions on a clean CI/registry install
pnpm install --frozen-lockfile && pnpm build && pnpm test
npm login
npm publish --workspace @cendor/sdk --access public --provenance
```

## Trusted publishing (one-time, npmjs.com → @cendor/sdk → Settings → Trusted Publisher)
- Organization: `cendorhq` · Repository: `cendor-sdk-js` · Workflow: `release.yml` · Environment: blank.

## Every release after
Land a changeset (`pnpm changeset`), merge to `main`; `release.yml` opens a "Version Packages" PR;
merging it publishes `@cendor/sdk` via OIDC with provenance and tags `@cendor/sdk@<version>`.

## CI note
The SDK's `ci.yml` checks out + builds the sibling `cendor-libs-js` (needs `secrets.LIBS_REPO_TOKEN`
while that repo is private) so the `link:` deps resolve pre-publish. After the libs are on npm, drop
that step and the `pnpm.overrides` block and install from the registry.
