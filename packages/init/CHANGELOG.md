# @cendor/init

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
