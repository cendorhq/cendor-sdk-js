---
'@cendor/sdk': patch
---

fix(otel): the automatic run scope must not adopt a concurrent run's calls

Found by review after the zero-telemetry-code wave, reproduced with clients that have real latency —
every acceptance probe had been sequential, and a zero-latency stub finishes one run before the next
starts, so the bus never interleaved.

Three defects, all in the newly-default automatic path:

- **Cross-run adoption.** A scope learned its run family from the first bus event it saw, and
  `bus.emit` is a process-wide fanout — so two *overlapping* runs rendered one run's call twice (once
  under each root), dropped the other run's call entirely, and stamped **both** roots with the same
  `cendor.run.id`. In a backend that sums `gen_ai.usage.cost` over spans that is double-counted spend
  plus a lost run. A run family now has exactly one owning scope, and the automatic scope learns only
  from an event emitted inside its **own** async context. A hand-closed `liveSpans()` handle keeps the
  historical "first event wins" (a user may legitimately wrap work that runs on another thread).
- **A run-less call is no longer adopted.** An `LLMCall`/`ToolCall` with no run id belongs to no run:
  core's flat emitter renders it, the run scope must not (it used to become the run's step 1, putting a
  foreign call's cost inside the run).
- **The streamed scope is context-bound.** `autoScopeStream` wrapped the *creation* of the inner
  generator in `AsyncLocalStorage.run`, which binds nothing — an async generator body resumes in the
  **consumer's** context (measured). So it also had to stand the core emitter down through the
  process-wide counter for the stream's whole lifetime, which made any concurrent run emit *nothing at
  all* (no root, no flat span), and `withLiveRootActive` was a silent no-op inside the stream, leaving
  **0 of 5** mirrored audit spans in the streamed run's trace (blocking runs: 4 of 5; Python: 4 of 5).
  The inner generator is now driven by hand with the store entered around each **resumption**, so the
  body and the producer task it starts see both the latch and the scope registry, while the consumer
  between deltas sees neither — the same shape as `withAutoRunScope`, and parity with Python's copied
  context.

`autoRunScope()` (internal, never exported from the package) also returned a handle whose registry
entry had been removed, so nothing could nest under its root; it now returns a plain `liveSpans()`
handle with the manual semantics its docstring describes.

4 regression tests, each verified failing against 0.23.1. 242 tests, `tsc` + biome clean,
`check:docs` 206 snippets.
