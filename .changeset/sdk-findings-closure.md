---
"@cendor/sdk": patch
---

Docs + coverage truth-up — no runtime behaviour change.

- **README rewritten to the real 0.21 surface.** Automatic token/cost capture is stated as **live for
  every provider** (Hugging Face / Ollama / Gemini / Bedrock-converse shipped in `@cendor/core` 0.3.0),
  and the previously-unmentioned surface is documented: `reaskOnOutputTrip`, `streamCheckWindow`,
  streamed checkpoints, `Result.conversationId` from a keyed session, and the six `cendor.sdk`
  telemetry domains on the live OTel path. Dropped the stale "v1.1 parity" / "capture activates once a
  matching core ships" framing.
- **HF core-detection test** — the stale `it.todo` becomes a real assertion that the installed
  `@cendor/core` attributes an instrumented `chatCompletion` client to `huggingface` with captured usage.
- **Pipeline-shape JSDoc** — `sequential` / `parallel` / `parallelAsync` now document that they honour
  `audit` / `maxTurns` / `retry` / `onStep` / `guardrails`, while `session` / `checkpoint` are team-only
  (`runAgents` / `supervisor`) and `guardrailMode` is a single-agent-run option.
- **Coverage** — A2A `serve()` HTTP round-trip over loopback, a `SqliteSessionStore` disk round-trip
  (skipped when `better-sqlite3` is absent), Foundry Local / Azure Responses `buildKwargs`, and a
  resilience matrix (retryable statuses + never-retries-governance).
