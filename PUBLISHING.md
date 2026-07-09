# Publishing `@cendor/sdk`

`@cendor/sdk` depends on the seven `@cendor/*` libraries (published from `cendor-libs-js`), which it now
installs **from the npm registry** like any consumer — no local links, no sibling checkout.

> ⚠️ **Release-gate step — drop the temporary `@cendor/guardrails` override.** Until `@cendor/guardrails`
> is published, the root `package.json` carries a **TEMPORARY** `pnpm.overrides` block (the `//pnpm-overrides`
> comment marks it) pointing `@cendor/guardrails` at a packed tarball of the sibling build (and pinning
> `@cendor/core` so one core resolves). **Before publishing** `@cendor/sdk@0.5.0`: publish `@cendor/guardrails@0.1.0`
> from `cendor-libs-js` first, then **delete the entire `pnpm` block + its `//pnpm-overrides` comment** and
> run `pnpm install` so `@cendor/sdk` resolves the published `@cendor/guardrails@^0.1.0` (and core) from npm.
> Then verify a fresh `npm i @cendor/sdk` resolves exactly ONE `@cendor/core`.

## Option A — automated with `NPM_TOKEN` (active) ✅

`release.yml` is wired for token-based direct-publish-on-push. One-time setup — add **one** repo secret
(GitHub → this repo → Settings → Secrets and variables → Actions):

- **`NPM_TOKEN`** — an npm **automation** token for the `cendor` org (same kind used by the libs repo).

Then: land a changeset (`pnpm changeset`) → push to `main`. `release.yml` runs `changeset version`
(bumps + CHANGELOGs, committed back with `[skip ci]`), then `changeset publish` publishes `@cendor/sdk`
and tags `@cendor/sdk@<version>`. No Version PR (mirrors the Python release flow). **Provenance is
off** (`NPM_CONFIG_PROVENANCE: "false"` in `release.yml`) because npm/sigstore rejects a private
source repo (`E422`); flip it to `"true"` once the repo is public.

> Requires the org to allow GitHub Actions to run (Actions minutes/policy). Making the repo public
> gives unlimited free Actions minutes.

## Option B — tokenless trusted publishing (optional)

Drop `NODE_AUTH_TOKEN` from `release.yml`, ensure the runner has npm ≥ 11.5, and configure the package's
**Trusted Publisher** on npmjs.com (org `cendorhq`, repo `cendor-sdk-js`, workflow `release.yml`).

## Local development

`pnpm install` resolves `@cendor/*` from npm (the published versions pinned in
`packages/sdk/package.json`). To develop the SDK against **unpublished** local changes to a lib, use a
temporary `pnpm.overrides` `link:` in the root `package.json` or `pnpm link`, then remove it before
committing — the committed manifest always installs from the registry.

## First / manual publish

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm test
npm config set //registry.npmjs.org/:_authToken <npm-automation-token>   # bypasses 2FA
pnpm exec changeset version    # if changesets are pending
pnpm -r publish --access public --no-git-checks
npm config delete //registry.npmjs.org/:_authToken                        # clean up after
```

Bump the `@cendor/*` dependency ranges in `packages/sdk/package.json` whenever the libs release a new
minor/major, so `@cendor/sdk` resolves against versions that exist on npm.
