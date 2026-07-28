# Publishing `@cendor/sdk`

`@cendor/sdk` depends on the seven `@cendor/*` libraries (published from `cendor-libs-js`), which it now
installs **from the npm registry** like any consumer — no local links, no sibling checkout.

## Option A — automated with `NPM_TOKEN` (active) ✅

`release.yml` is wired for token-based direct-publish-on-push. One-time setup — add **one** repo secret
(GitHub → this repo → Settings → Secrets and variables → Actions):

- **`NPM_TOKEN`** — an npm **automation** token for the `cendor` org (same kind used by the libs repo).

Then: land a changeset (`pnpm changeset`) → push to `main`. `release.yml` runs its **`verify` gate**
(below), and only if that is green runs `changeset version` (bumps + CHANGELOGs, committed back with
`[skip ci]`), then `changeset publish` publishes `@cendor/sdk` and tags `@cendor/sdk@<version>`. No
Version PR (mirrors the Python release flow). **Provenance is off**
(`NPM_CONFIG_PROVENANCE: "false"` in `release.yml`) because npm/sigstore rejects a private source
repo (`E422`); flip it to `"true"` once the repo is public.

### Publishing is gated on the tests — in `release.yml`, not `ci.yml`

`release.yml` has **two** jobs: `verify` → `release`, with `release` declaring `needs: verify`.
Nothing reaches npm unless every `verify` leg is green.

That edge is the whole point. `ci.yml` and `release.yml` are two **independent** `push: main`
triggers with no dependency between them, so before this a commit could fail CI and publish to npm
from the same push — measured in the sibling repo `cendor-libs-js` on 2026-07-27: it published
fine while its CI run went red. **A cross-workflow status is not a gate; a `needs:` edge is.**

`verify` mirrors `ci.yml`'s `build-test` job — same `pnpm install --frozen-lockfile`, same Node
`[20, 22]` matrix, same order: `check:one-core` → `build` (typecheck) → `lint` → `check:major` →
`test`. It is deliberately a duplicate run rather than a reference to the CI run: a workflow can only
depend on jobs in its own graph. **When you change `ci.yml`'s gates, change `verify` too** — the
comment at the top of both jobs says so. `verify` also drops to `permissions: contents: read`; only
the `release` job needs write.

The same shape is used in `cendor-libs-js` (a `verify` job + `needs: verify`), so the two JS release
pipelines read identically.

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
