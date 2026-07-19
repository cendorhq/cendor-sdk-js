---
"@cendor/sdk": minor
---

`gen_ai.conversation.id` grouping for multi-turn runs (backward-compatible, opt-in). `spanTree(result, tracer?, { conversationId })` and `liveSpans({ conversationId })` now accept an optional conversation/session id (e.g. your session store key). When given, the root `agent.run` span carries it as the OpenTelemetry `gen_ai.conversation.id` semantic-convention attribute, so a backend can group the runs of one multi-turn conversation. Omitted by default (no key leaks when you aren't grouping). Libs-only users can pass any `gen_ai.*` attribute through `@cendor/core`'s `otel.span(...)` attributes.

See https://cendor.ai/docs/observability
