---
"@cendor/sdk": minor
---

`run()`, `run.stream`, and the orchestration entries (`runAgents`, `sequential`, `parallel`,
`parallelAsync`, `streamAgents`) now make the caller's `liveSpans()` run root the **active context
span** for the run body (via a `context.with` wrap, parity with Python's `live_spans`). While a
`liveSpans` scope is open, audit entries emitted during the run correlate to the run's trace
(`@cendor/acttrace` stamps `cendor.audit.otel_trace_id`) and `audit.*` mirror spans nest under the
run's trace — so an observability tool (e.g. Cendor Monitor) can link a governance event back to the
run that produced it. This closes the TS-only governance→run linkage gap (Python already activated
its run root).

It composes with a caller's own active span rather than replacing it, is confined to the run body
(the span is restored on exit), and is a **no-op** when no `liveSpans` scope is open or when
`@opentelemetry/api` / its context manager is absent — runs without `liveSpans` behave exactly as
before. No API change.

Also raises the floor on `@cendor/core` (`^0.9.0`) and `@cendor/acttrace` (`^0.10.0`) so a single
`@cendor/core` instance dedupes across the tree with the activated-span + `run_id` correlation
support.
