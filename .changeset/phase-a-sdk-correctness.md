---
"@cendor/sdk": minor
---

Live incremental + multi-agent streaming; governance on all run paths; contextBudget assembly; sequential/parallel trace correlation; SummarizingSession write-back is now awaited.

- `run.stream` (single agent) now yields each `TextDelta`/`ToolCallEvent`/`ToolResultEvent` the instant it is produced (inside the `trace(runId)` scope, so emitted `LLMCall`/`ToolCall` bus events stay correlated), instead of buffering and draining after the run.
- `run.stream([...])` (multi-agent) streams a real handoff run: each active agent's turns stream live, control switches on a `transfer_to_<peer>` call, and a single terminal `RunComplete` carries the aggregate `Result`.
- An audit `decision()` is now opened on every run path (single blocking/stream, multi blocking/stream, sequential, parallel), recording the `{agent, model, trace_id}` bridge; the active `Decision` is published in an `AsyncLocalStorage` so `hitl.requireApproval` records `human_oversight` (on approve and reject, honoring `reviewer`).
- Per-agent governance (`track({agent})` + a `budget` when `maxUsd` is set) now wraps every orchestration segment — `maxUsd` is enforced.
- `Agent.contextBudget` is now wired: context is assembled to the token budget via `@cendor/contextkit` per turn (falling back to raw messages on any error).
- `sequential` / `parallel` / `parallelAsync` correlate under one parent trace id (`Result.traceId` = parent; every step's trace id starts with it).
- RAG context is injected once per run (persisting into `Result.messages`/session) instead of re-retrieving each turn.
- `SummarizingSession.replace` write-back is now awaited, so summarization finishes before the run returns (deterministic session state, correlated events).
