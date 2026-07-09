---
"@cendor/sdk": minor
---

V03 A3 tail — task-adherence at the `tool_call` stage. Re-exports `taskAdherence` (plus the `judge` namespace) from `@cendor/guardrails`, and the runner now auto-threads the originating user turn into `Context.instruction` at every tool-call seam (blocking and streaming), so `judge.taskAdherence` sees the user's intent with no manual wiring — closing the deferred parity tail. Bumps the `@cendor/guardrails` dependency to `^0.3.0`, which also brings `rules.spotlight` and the annotation-parity decision metadata (severity / detected / filtered / redacted / citation / license) to SDK consumers. Additive and backward-compatible.
