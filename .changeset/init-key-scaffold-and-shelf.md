---
"@cendor/init": patch
---

`init --scaffold` now emits a provider-key line in the starter and next-steps (the SDK reads the
provider's standard env var, e.g. `OPENAI_API_KEY`, or `apiKey` on the Agent — never a Cendor key),
and the offline versions snapshot is refreshed to the 2026-07-13 shelf (`@cendor/sdk` 0.9.2,
`@cendor/init` 0.2.2, mirroring `cendor-sdk` 1.6.2 / `cendor-init` 0.2.2).
