---
"@cendor/sdk": minor
---

V04 re-exports (parity with `@cendor/guardrails` 0.4). Additive; bumps the `@cendor/guardrails`
dependency `^0.3.0` → `^0.4.0`.

- `rules.customCategory` + `rules.intent` on the SDK's `rules` surface — semantic category-by-example
  and the pre-LLM intent gate (BYO `embed`/`classify`), for `new Agent({ guardrails: [...] })`.
- `presets` + `policySchema` re-exported at the top level (the curated `presets.promptInjection()`
  starter and the policy JSON Schema, with `loadPolicy(src, { validate: true })`).
- G1 `keywordDeny({ match: 'word', normalize: [...] })` rides along through the re-exported rule.

No runner change — these are library capabilities surfaced through the SDK façade. All
capability-neutral (the guardrails claim gates stay shut). The zero-config `localEmbedder` is
Python-only (model2vec); in TS pass a bring-your-own `embed`.
