# Publishing `@cendor/sdk`

`@cendor/sdk` depends on the seven `@cendor/*` libraries (published from `cendor-libs-js`), which it now
installs **from the npm registry** like any consumer — no local links, no sibling checkout.

## Option A — automated with `NPM_TOKEN` (active) ✅

`release.yml` uses the changesets **"Version Packages" PR** flow with an `NPM_TOKEN`, so
**publishing is a merge, not a push**. One-time setup — add **one** repo secret (GitHub → this repo →
Settings → Secrets and variables → Actions):

- **`NPM_TOKEN`** — an npm **automation** token for the `cendor` org (same kind used by the libs repo).

Then: land a changeset (`pnpm changeset`) → push to `main`. `release.yml` runs its **`verify` gate**
(below), and only if that is green does `release` run `changesets/action`, which branches:

1. **changesets pending** → it opens or updates a PR titled **`chore: version packages`** on the branch
   `changeset-release/main`, carrying the version bumps and CHANGELOGs. **Nothing is published yet.**
2. **no changesets, versions already bumped** (you merged that PR) → `changeset publish` publishes
   `@cendor/sdk` / `@cendor/init` and tags `@cendor/<pkg>@<version>`.

**Review the version PR, then merge it — the merge is the release.**

> **Why the PR step exists (changed 2026-07-29).** This was direct publish-on-push: one push to `main`
> carrying a changeset went straight to npm with no human step between the merge and the registry.
> Fine on a private repo with an audience of one; in public an accidental push is a release, and a
> release is irreversible. FLIP-CHECKLIST A4. The flow needs the org setting *Allow GitHub Actions to
> create and approve pull requests* (enabled org-wide 2026-07-29 — the repo-level toggle 409s while
> the org forbids it), and `createGithubReleases` is deliberately off to preserve current behaviour.

**Provenance is off** (`NPM_CONFIG_PROVENANCE: "false"` in `release.yml`) because npm/sigstore rejects
a private source repo (`E422`); flip it to `"true"` once the repo is public.

### A MAJOR needs the approval twice under this flow — and that is deliberate

`check:major` runs in `verify`, and it checks **two** things: pending changesets that declare `major`
(which need an in-band `Approved-Major:` line), and **`package.json` versions against the last
published tag** (which need an `APPROVED-MAJOR` file naming the exact token). The second check exists
because `changeset version` cannot express every target, so a hand-set major would otherwise sail past.

Under the version-PR flow those two checks fire at *different* moments, because
`changeset version` **consumes the changeset**:

| Moment | Changeset present? | Version bumped? | Which check fires |
|---|---|---|---|
| you push the changeset to `main` | yes | no | the changeset check — needs `Approved-Major:` |
| on the version PR, and after it merges | **no** | **yes** | the tag check — needs `APPROVED-MAJOR` |

So a major release needs **both**: the `Approved-Major:` line in the changeset, *and* an
`APPROVED-MAJOR` file listing the exact token (e.g. `@cendor/core@4.0.0`). Add the file to the version
PR when its CI stops on the tag check — the failure prints the exact token to paste. Verified by
negative control on 2026-07-29: faking `@cendor/squeeze` to `4.0.0` with no changeset and no approval
file exits **1** with `Add this exact token to cendor-libs-js/APPROVED-MAJOR: @cendor/squeeze@4.0.0`.

**Minor and patch releases are unaffected** — the tag check only fires when the major number rises,
which is every routine release's no-op. This is not a workaround: a major is irreversible on npm, and
two independent in-band approvals at two moments is the behaviour you want. Remove the
`APPROVED-MAJOR` file once the release has published.

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
