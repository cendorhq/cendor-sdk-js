---
"@cendor/sdk": patch
---

Enforce `Agent.maxUsd` on single-agent `run()` and `stream()`, not only on orchestrated/multi-agent runs. The per-agent USD cap was previously applied only inside the orchestrator's per-segment scope, so a plain `run(agent, ...)` billed with no ceiling. The single-agent run and stream paths now wrap the same pre-flight `withBudget({ onExceed: 'block' })` scope the orchestrator uses, so an over-budget call is refused before it is sent.

Also short-circuit resuming an already-completed checkpoint: resuming a run whose checkpoint is marked `done` now returns the stored result (`steps: []`, zero model calls, zero tool calls) instead of rebuilding from the original input and replaying the whole loop (which re-invoked the model and re-ran completed tools). Applies to single- and multi-agent runs.
