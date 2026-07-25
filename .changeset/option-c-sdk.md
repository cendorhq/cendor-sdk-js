---
'@cendor/sdk': minor
---

**A blocked run now shows *why* — inline on the run, with no audit object** (Option C, DR-2c).

`liveSpans` renders `@cendor/tokenguard`'s budget events and `@cendor/guardrails`' decisions as
`governance.*` children of the `agent.run` root, using core's `cendor.gov.*` vocabulary. So a
telemetry user who writes zero governance code still sees the budget that stopped a run and the
guardrail that tripped, in the trace, next to the steps they governed.

- **The audit mirror still wins**: with an `AuditLog` in play, the chained `audit.*` spans are the
  rendering and these stand down (never two renderings of one decision).
- **No `audit.*` vocabulary and no `reason` string** on these spans (rule 6 — a rule's reason can
  carry input-derived text; the audit chain keeps it).
- `CENDOR_TELEMETRY=off` disables them with everything else.

Dependency floors move to the shelf that carries Option C (`@cendor/core` ≥ 0.15,
`@cendor/acttrace` ≥ 0.13, `@cendor/tokenguard` ≥ 0.8.1) — and, importantly, **the whole `@cendor/*`
set is bumped together**: a sibling left on an older core minor resolves a second copy of core (a
second event bus), and cross-library enforcement silently stops reaching the run.
