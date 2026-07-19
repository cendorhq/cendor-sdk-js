---
"@cendor/sdk": minor
---

Re-export the OpenTelemetry observability export surface: `OTelMirror` (from `@cendor/acttrace` 0.7) and `BudgetEvent` (from `@cendor/tokenguard` 0.3). Attach `new AuditLog(system, { mirror: new OTelMirror() })` to stream the governed loop's audit trail — decisions, guardrail actions, `budget_event`s, human oversight — to any OpenTelemetry backend as an operational copy (the hash-chained file stays the sole `verify()` evidence). Dependency floors bumped to `@cendor/acttrace ^0.7.0`, `@cendor/tokenguard ^0.3.0`.

See https://cendor.ai/docs/observability
