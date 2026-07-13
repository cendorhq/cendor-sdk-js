---
"@cendor/sdk": patch
---

Provider-auth hardening. A live provider call that fails to authenticate **while the keyless
placeholder is in play** now throws `MissingAPIKeyError` (exported from `@cendor/sdk`) naming the
env var to set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY`, `HF_TOKEN`) and
linking the docs, instead of the provider's bare 401 — never firing with a real key, a pre-built
`client`, on non-auth errors, or on keyless offline flows. Bedrock now rejects `apiKey` with a clear
"authenticates via the AWS credential chain" error instead of silently ignoring it.
