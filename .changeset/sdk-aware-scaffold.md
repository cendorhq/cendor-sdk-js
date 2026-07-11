---
"@cendor/init": minor
---

SDK-aware `--scaffold`. When `@cendor/sdk` / `cendor-sdk` is detected in the project (declared or
installed), `init --scaffold` now writes a governed **`Agent`** starter — budget cap + a guardrails
deny rule + `guard(Policy…)` PII redaction + a tamper-evident `AuditLog`, on one `run()` — instead
of the bare `instrument()` + budget starter. Libraries-only projects keep the existing starter. No
other behaviour changes; the Python twin (`cendor-init`) ships the same branch.
