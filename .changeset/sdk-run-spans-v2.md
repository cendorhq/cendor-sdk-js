---
'@cendor/sdk': minor
---

Richer run spans for the monitor. `liveSpans`/`spanTree` now stamp `gen_ai.agent.name` (which agent made the call) and a 1-based `cendor.step` on every child span; `liveSpans` reaches parity with `spanTree` — its root learns `cendor.run.id`/`cendor.trace_id` from the run's correlation id and carries the run's `gen_ai.usage.*` + `cendor.run.cost_usd` rollups at close. New opt-in `{ label }` on both → `cendor.run.label` on the root, so a monitor can show what a run was *for* (never derived from the prompt — prompts/tool values stay off spans). The per-agent `maxUsd` ceiling is now named (`agent:<name> max_usd`) so a cap block is attributable. Dependency floors bumped to the V2 emission wave (`@cendor/tokenguard ^0.4`, `@cendor/acttrace ^0.8`, `@cendor/guardrails ^0.7`). Additive and backward-compatible.
