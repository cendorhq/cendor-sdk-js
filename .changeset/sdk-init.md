---
"@cendor/sdk": minor
---

Initial release of `@cendor/sdk` — the TypeScript port of `cendor-sdk`. A governed agent loop over
`@cendor/core`: OpenAI (Chat + Responses) and Anthropic providers (real SDKs, `instrument()`ed),
zod-schema tools, structured outputs, streaming, handoff/sequential/parallel/supervisor
orchestration, sessions (memory + better-sqlite3), retrieval (`VectorIndex`), retries, eval over
cassettes, HITL approval, and OTel spans (no-op without OpenTelemetry). Governance (budgets, audit,
guard) is re-exported from the real `@cendor/*` libraries and rides core's seams. Includes the v1.1
surface: live `onStep` hooks, Anthropic prompt caching, and multi-agent streaming.
