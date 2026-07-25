---
'@cendor/sdk': minor
---

**A governed run is now visible with zero telemetry code** (see `@cendor/core` 0.14 for the switch).

⚠️ **Default-behaviour change.** If your app configures an OpenTelemetry provider and you upgrade,
`run()` / `run.stream()` open the run scope themselves: you get the `agent.run` root with its steps as
children, usage/cost rollups, `gen_ai.conversation.id` from your `session`, and — because the root is
the active span — governance correlated to the run. Previously this needed
`const s = liveSpans(); try { … } finally { s.close() }` around every run.

- **An explicit `liveSpans()` still wins**: the SDK opens nothing when a scope is already open, so
  there is never a second root. `CENDOR_TELEMETRY=off` disables the automatic path entirely, and with
  `@opentelemetry/api` absent nothing happens at all.
- **The automatic scope closes in a `finally` the SDK owns** — including a throwing run and an
  abandoned stream (`break` out of `for await`), so the API's unclosed-handle foot-gun cannot bite the
  automatic path.
- **No invented identity**: `cendor.run.label` stays empty unless you pass one (a label is a
  human-authored tag), and the conversation id is only ever the `session.id` you chose.

Also fixed, both load-bearing once runs scope themselves:

- **The `liveSpans` scope registry is per async context** (`AsyncLocalStorage`), so two concurrent
  runs no longer share one scope — previously the second run's children could be parented under the
  first run's root.
- **`liveSpans()`'s root now carries `gen_ai.operation.name = 'agent'`**, matching `spanTree` and the
  Python `live_spans` root (backends that group by operation read it).
- Bumped the `@cendor/*` dependency set to the current shelf. A stale sibling pin is not cosmetic: a
  library pinned to an older `@cendor/core` minor resolves a **second copy of core**, i.e. a second
  event bus, and cross-library cooperation (a guardrail decision reaching the SDK) silently stops.
