<!-- Thanks for the PR. Keep it focused and green. Full contract: CONTRIBUTING.md -->

## What & why

<!-- What does this change, and what problem does it solve? Link the related issue. Explain the *why* —
     that is the part a reviewer cannot reconstruct from the diff. -->

Touches: <!-- packages/sdk / packages/init / both -->

## Gates — run each one bare and read its exit code

<!-- Exactly what CI runs (.github/workflows/ci.yml), on Node 20 and 22. `release.yml` re-runs the
     same list in its `verify` job before anything reaches npm. Never pipe a gate into `tail`/`grep`
     and chain the next step off `&&`: a pipeline's exit code is the last command's, so a failing
     check reads as a pass. -->

```bash
pnpm install --frozen-lockfile   # resolves @cendor/* from npm, like any consumer
pnpm check:one-core              # GATE: exactly one @cendor/core — two is two event buses
pnpm build                       # tsc -b — typecheck + emit
pnpm lint                        # biome check .
pnpm check:major                 # a major bump needs explicit in-band approval
pnpm test                        # vitest, offline
```

- [ ] `pnpm check:one-core` — it runs **before** the suite on purpose: with two cores installed the tests can still pass while cross-library cooperation is silently dead, so a green suite is not evidence
- [ ] `pnpm build`
- [ ] `pnpm lint`
- [ ] `pnpm check:major`
- [ ] `pnpm test` — green, and **offline**: no API key, no network; provider-shaped stub clients and `undici`'s `MockAgent`

One more gate, which needs sibling checkouts of the docs repos
([`cendor-libs`](https://github.com/cendorhq/cendor-libs), [`cendor-sdk`](https://github.com/cendorhq/cendor-sdk))
next to this one. It runs after `pnpm build`, and in CI it **self-skips when the docs-repo token is
unset** — so a green CI is not proof it ran:

```bash
pnpm check:docs   # typechecks every ```ts docs snippet + every JSDoc @example against the built dist
```

- [ ] `pnpm check:docs` — run locally, not assumed from CI. **Required if this PR edits any `@example` or any TypeScript documentation tab**: a taught call-shape that no longer compiles is worse than no example

## Checklist

- [ ] Tests added or updated in this PR for the new behavior. Fixing a defect? A test that **would have failed before** the fix, and a note on how you know
- [ ] Every public symbol carries a JSDoc `@example` with the *correct* call shape — that is what an editor's language server (and an AI assistant) hands a reader inline
- [ ] Docs updated **upstream**: this repo holds code, not the docs tree. The SDK's pages live in [`cendor-sdk/docs`](https://github.com/cendorhq/cendor-sdk/tree/main/docs); a Python↔TypeScript gap opened or closed goes in the [parity matrix](https://cendor.ai/docs/languages)
- [ ] A [changeset](https://github.com/changesets/changesets) added (`pnpm changeset` → a new `.changeset/*.md`): a **patch** for a fix, a **minor** for a new capability a user can call
- [ ] **No hand-edited version number and no hand-edited `CHANGELOG.md`** — changesets own both, and hand-bumping under changesets corrupts the next release
- [ ] Touched `packages/init/`? Its version moves on its own cadence (dev tooling, outside the shared `@cendor/*` major), and its rules templates are a **vendored copy** of `cendor-libs/docs/assistant-rules.md` — keep them in sync rather than forking the text

## The rules this repo will not bend

- [ ] Money is `decimal.js`, never a `number` — costs, prices, and budgets end to end. Binary floating point cannot represent a price, and a budget wrong in the 15th digit is a budget nobody can audit
- [ ] Governance still attaches through `@cendor/core`'s bus / interceptor / sink seams — nothing patched, and the re-exported `budget` / `guard` / `Policy` / `AuditLog` / `rules` / `trace` are still the *identical* library objects (`packages/sdk/test/lib-parity.test.ts` pins this with `Object.is`)
- [ ] No generic capability added here — a way to govern *any* call belongs in [`cendor-libs-js`](https://github.com/cendorhq/cendor-libs-js); this repo owns orchestration (the loop, handoff, tool schemas, provider response normalization)
- [ ] Provider SDKs stay optional peers, imported lazily — installing `@cendor/sdk` must never pull one. `@cendor/core` is the only hard dependency
- [ ] Tool and output schemas stay **zod 4** (`z.toJSONSchema`); a zod 3 schema keeps failing with the explicit "change the import to `zod/v4`, or upgrade zod to ^4" error rather than silently emitting a wrong JSON Schema
- [ ] Still local-first: no required account, network, or running server
- [ ] Every number I added is reproducible from the tests or a benchmark, and nothing claims regulatory compliance (the audit trail produces *evidence to support* a case) or gives legal advice
- [ ] Commit messages are conventional-ish with a body, and carry **no `Co-Authored-By` trailer**

### ⚠️ If this touches async context, run scope, streaming, or concurrency

- [ ] Tested on **Node 20 and 22**, not only 24+. `AsyncLocalStorage` changed implementation in Node 24 (AsyncContextFrame): on 20/22 an `enterWith` leaks into concurrent flows and is never restored, and `@cendor/core` shipped exactly that bug invisibly because it was only ever exercised on 24. Use `run(value, fn)`, never `enterWith`
- [ ] Tested with **two overlapping runs and a client that actually takes time**. A zero-latency stub finishes run A before run B starts, so the process-wide bus never interleaves and every cross-run attribution defect is invisible — a fully sequential suite has already been green over exactly that class of bug

## ⚠️ A merge to `main` publishes to npm

`release.yml` triggers on push to `main`: when a changeset is present it runs `changeset version`,
commits the bump, and runs `changeset publish`. Its `verify` job re-runs the full gate list above on
the Node 20 + 22 matrix and `release` declares `needs: verify`, so a red build cannot ship — but a
green one ships **immediately**, with no separate approval step.

- [ ] I understand a merge here publishes, and my changeset's bump type is the one I actually want
- [ ] **Crossing a MAJOR?** Not an autonomous decision, in either language: it is irreversible on npm and re-frames the product for every reader. It needs the maintainer's explicit approval, recorded in-band as an `Approved-Major:` line in the changeset or in the repo-root `APPROVED-MAJOR` file naming the exact version. `pnpm check:major` fails the build without it. Propose it, say what breaks, and wait
