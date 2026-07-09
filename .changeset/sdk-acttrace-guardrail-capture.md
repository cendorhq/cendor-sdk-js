---
"@cendor/sdk": patch
---

Bump the `@cendor/acttrace` dependency to `^0.5.0` so a fresh install of `@cendor/sdk` resolves
acttrace 0.5.0 — the release that chains guardrail decisions as tamper-evident `guardrail_decision`
entries. Under the previous `^0.4.0` cap, `npm i @cendor/sdk` pulled acttrace 0.4.2, so
`GuardrailDecision` events emitted by `Agent({ guardrails: [...] })` were not captured in the audit
chain. No API change; deps-only.
