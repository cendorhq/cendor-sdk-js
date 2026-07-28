# Contributing to cendor-sdk-js

Thanks for your interest in contributing. This file covers **this repository** — the pnpm workspace
that publishes [`@cendor/sdk`](packages/sdk) (the governed agent SDK, the TypeScript port of
[`cendor-sdk`](https://github.com/cendorhq/cendor-sdk)) and [`@cendor/init`](packages/init) (the
offline `init` / `doctor` CLI).

## Ground rules

- **Honest claims.** Every number in docs, READMEs, or the site must be reproducible from the
  benchmark suite or the tests. Never overstate coverage, test counts, provider support, or
  compliance. The audit trail produces *evidence to support* compliance — never a guarantee.
- **Local-first.** Nothing here may require an account, network, or running server. Provider SDKs
  (`openai`, `@anthropic-ai/sdk`, …) are **optional peers**, never hard dependencies; `@cendor/core`
  is the SDK's only hard dependency.
- **Governance is the foundation, not a plugin.** The `budget` / `guard` / `AuditLog` / `rules` you
  import from `@cendor/sdk` are the **real** `@cendor/*` library objects, re-exported for one-import
  convenience — `packages/sdk/test/lib-parity.test.ts` pins that with `Object.is`. Never re-implement
  a library's behaviour here; forward to it.
- **Money is `decimal.js`, never a `number`.**
- **The libraries themselves live in [`cendor-libs-js`](https://github.com/cendorhq/cendor-libs-js).**
  A generic capability belongs there (and in its Python twin), not in the SDK; the SDK owns
  orchestration — the loop, handoff, tool schemas, provider response normalization.
- Be respectful and constructive — see the [Code of Conduct](CODE_OF_CONDUCT.md).

The release runbook is [`PUBLISHING.md`](PUBLISHING.md); the versioning standard is in
[`CLAUDE.md`](CLAUDE.md).

## Getting set up

A [pnpm](https://pnpm.io/) workspace on Node ≥ 20 (CI runs 20 and 22; the published packages declare
`engines.node >= 18`). ESM only.

```bash
pnpm install --frozen-lockfile   # resolves @cendor/* from npm, like any consumer
pnpm build                       # tsc -b (typecheck + emit)
pnpm test                        # vitest, offline
```

`@cendor/*` always resolves **from the npm registry** — there are no local links in the committed
manifests. To develop against an unpublished local change to a library, add a temporary
`pnpm.overrides` `link:` in the root `package.json` and remove it before committing.

All tests run **offline** — no API key, no network. They use stub, provider-shaped clients and
`undici`'s `MockAgent`. If a change needs a real network call to pass, it doesn't belong in the test
suite (record a `cassette` fixture instead).

## The gates (run these before you open a PR)

Exactly what CI runs, in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — and, since
publishing is gated on them too, in `release.yml`'s `verify` job:

```bash
pnpm install --frozen-lockfile
pnpm check:one-core   # GATE: exactly one @cendor/core installed — two = two event buses
pnpm build            # typecheck + build
pnpm lint             # biome
pnpm check:major      # a MAJOR bump needs an in-band approval line (see CLAUDE.md)
pnpm test
```

Run them **bare** and read the exit code. Never pipe a gate into `tail`/`grep` and chain with `&&` —
a pipeline's status is the last command's, so a failing gate reads as a pass.

One more gate, which needs sibling checkouts of the docs repos
([`cendor-libs`](https://github.com/cendorhq/cendor-libs),
[`cendor-sdk`](https://github.com/cendorhq/cendor-sdk)) next to this one:

```bash
pnpm check:docs       # typechecks every ```ts docs snippet + every JSDoc @example vs the built dist
```

It requires `pnpm build` first, and overrides its inputs with `DOCS_DIRS` / `CENDOR_LIBS_JS` when
your checkouts live elsewhere. In CI it self-skips when the docs-repo token is unset. **Run it after
editing any TypeScript documentation tab or any `@example`** — a taught call-shape that no longer
compiles is worse than no example.

## Making a change

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Fork, branch, and keep changes focused. Match the surrounding code's style.
3. Full types on every public API; keep the public surface small and underscore-prefix internals.
4. Support sync **and** async wherever a model or tool call is involved.
5. Every public symbol carries a JSDoc `@example` with the *correct* call shape — an editor's
   language server (and an AI assistant) is handed that shape inline, so it has to compile.
6. Add or update tests in the same PR. New behavior ships with tests — stub clients, no network.
7. Add a [changeset](https://github.com/changesets/changesets) (`pnpm changeset`) describing the
   change and the bump: a new capability is a **minor**, a fix is a **patch**. Do **not** edit a
   version number or a `CHANGELOG.md` by hand — changesets own both.
8. Update the relevant docs page. This repo holds code, not the docs tree: the SDK's pages live in
   [`cendor-sdk/docs`](https://github.com/cendorhq/cendor-sdk/tree/main/docs) (rendered at
   [cendor.ai/docs/sdk](https://cendor.ai/docs/sdk)). If the change closes or opens a
   Python↔TypeScript gap, say so in the parity matrix
   ([`cendor-libs/docs/languages.md`](https://github.com/cendorhq/cendor-libs/blob/main/docs/languages.md)).
9. Open a PR against `main` with a clear description of the *why*.

## Commit and PR conventions

- Conventional-ish commit messages (`feat:`, `fix:`, `docs:`, `chore:`), with a body explaining the
  reasoning.
- Do **not** add a `Co-Authored-By` trailer.
- Keep PRs green: CI runs lint, type checks, the one-core and major-bump gates, the test suite on
  Node 20 and 22, and the docs-snippet typecheck on every push.

## Reporting a security issue

Do not open a public issue — see [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
