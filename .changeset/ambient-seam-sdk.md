---
"@cendor/sdk": minor
---

Wire the SDK onto the `@cendor/core` ambient seam so run context survives out-of-scope delivery, and
harden `liveSpans`:

- **Provider registration (GLR-2):** the active agent + conversation id are stamped onto every
  `LLMCall`/`ToolCall` at construction, so `liveSpans` reads them from the event even when the call is
  finalized outside the run scope (a stream drained after the scope, a context-losing layer).
  `liveSpans` now prefers the event's stamped `conversation_id` and stamps
  `gen_ai.usage.reasoning_tokens` on child spans (parity with Python `live_spans` + the core span
  emitter).
- **Run-family filter (GLR-3, default on):** `liveSpans` renders only the run family it observed
  first (the segment before the first `:`), so a concurrent run sharing the process bus no longer
  pollutes its steps, rollups, or children.
- **RAG in scope (GLR-4):** `prepareMessages` now runs inside the run scopes, so a retriever's
  embedding call is attributed to the run (a collected step, agent-stamped, counted against the run
  budget) instead of firing anonymously before the run opened.
- **ThinkingDelta (GLR-12):** a new additive `run.stream` event surfacing streamed reasoning text for
  providers that stream it (Ollama `think` models; OpenAI-compatible `reasoning_content`), kept
  separate from `TextDelta`. Additive — a consumer that doesn't handle `'thinking_delta'` is
  unaffected.

Floors `@cendor/core` at `^0.10.0` (the seam) and moves to the current library shelf so one core copy
dedupes.
