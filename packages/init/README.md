# @cendor/init

[![npm version](https://img.shields.io/npm/v/@cendor/init.svg)](https://www.npmjs.com/package/@cendor/init) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**One command to make your project Cendor-ready and Cendor-fluent for your AI assistant** — plus a
`doctor` that catches the wiring mistakes before they bite. Offline: no network, no API key.

```bash
npx @cendor/init            # detect + write assistant rules files (idempotent)
npx @cendor/init doctor     # validate the wiring; exit 1 on hard problems (CI-usable)
```

> Optional developer tooling. It writes files and inspects your project — it makes **no network
> call** and no Cendor library depends on it at runtime. (Python users: `uvx cendor-init`.)

## What `init` does

1. **Detects your project** — Node (`package.json`) or Python (`pyproject.toml` / `requirements`),
   which provider SDKs you have, and which `@cendor/*` / `cendor-*` packages are installed.
2. **Writes the matching assistant rules file(s)** so your assistant reads the correct Cendor
   call-shapes on every edit — no need to paste anything. Detected by default; `--all` for every one:
   - `.github/copilot-instructions.md` (GitHub Copilot)
   - `.cursor/rules/cendor.mdc` (Cursor)
   - `AGENTS.md` (the cross-tool default — always written)
   - a marked section in `CLAUDE.md` (Claude Code)
   - `.windsurf/rules` (Windsurf)

   **Idempotent and safe:** re-running updates a marker-delimited block in place — it never
   duplicates, and never clobbers your surrounding content. A dedicated file it didn't create is left
   alone unless you pass `--force`.
3. **Offers MCP setup** (`--mcp`) — drops the connect config for the Cendor MCP server (remote
   `mcp.cendor.ai` or local `npx @cendor/mcp` / `uvx cendor-mcp`) where it's absent.
4. **Optional starter** (`--scaffold`) — a minimal, correct starter in your language: a governed
   **`Agent`** loop (budget + guardrails + `guard` + audit) when `@cendor/sdk` / `cendor-sdk` is
   detected, otherwise an `instrument()` + budgeted-call example.

The rules content is a copy of the docs source of truth,
[`assistant-rules`](https://cendor.ai/docs/assistant-rules) — the single place these copy-paste rules
blocks live. The trap registry they draw on is
[`for-ai-assistants`](https://cendor.ai/docs/for-ai-assistants).

## What `doctor` checks

Static checks only — it **never mutates** your project, and exits non-zero on hard problems so it
works in CI:

- **Namespace** — flags a stray `cendor/__init__.py` in your tree, or a bare `import cendor` (the
  namespace has no module body — import `from cendor.<tool>`).
- **Provider deps** — a provider SDK your code imports but hasn't installed (Cendor never pulls one
  for you).
- **`instrument()` once** — warns if Cendor is imported but the client is never wrapped (nothing is
  observed).
- **Money** — flags coercing a price/cost to `float` / `number` (it should stay `Decimal` /
  `decimal.js`).
- **Versions** — warns when an installed/pinned `@cendor/*` version trails the latest release.
- **Lockfile** — names the lock when *it* is the constraint. A declared `^3.0.0` looks perfectly wide
  while the `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` beside it pins an older version and
  the install honours it — nothing upgrades and the build stays green the whole time.
- **Price snapshot** — warns when the installed `@cendor/core`'s bundled price table is over 30 days
  old (read from `node_modules`, still offline).
- **Telemetry** — flags `CENDOR_TELEMETRY=off` committed next to a configured OpenTelemetry provider,
  and a Cendor package older than the release where telemetry started flowing on its own.

The version checks compare against a snapshot **bundled in this CLI**, so `doctor` makes no network
call at all — Cendor never checks for updates on its own. Pass `--online` to compare against the live
[`/releases.json`](https://cendor.ai/releases.json) feed instead; if the feed can't be reached it
degrades to the snapshot and says so rather than failing.

```bash
npx @cendor/init doctor --online   # opt-in: compare versions against the live feed
npx @cendor/init --help
```

## Options

`init` (the default command):

| Flag | Effect |
|---|---|
| `--all` | write every assistant rules file, not just the detected ones |
| `--assistant <list>` | comma-separated subset: `copilot,cursor,agents,claude,windsurf` |
| `--mcp` | also drop MCP connect config where absent |
| `--scaffold` | also write a correct starter — a governed `Agent` when the SDK is present, else `instrument()`+budget |
| `--force` | overwrite an owned file (`.cursor/rules/cendor.mdc`) even if not ours |
| `--dry-run` | show what would change without writing |

`doctor`:

| Flag | Effect |
|---|---|
| `--online` | compare versions against the live `https://cendor.ai/releases.json` feed instead of the snapshot bundled in this CLI. Without it, `doctor` makes **no** network call |

Both commands take `-h` / `--help` and `-v` / `--version`.

Apache-2.0 · [cendor.ai](https://cendor.ai) · [For AI assistants](https://cendor.ai/docs/for-ai-assistants) · [MCP](https://cendor.ai/mcp)
