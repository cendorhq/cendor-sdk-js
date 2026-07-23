---
"@cendor/sdk": minor
---

Phase-S follow-up — the parity items deferred from 0.19 land in TypeScript:

- **S6** streamed + team `conversationId` from a keyed session (`streamOne` / `streamAgents` /
  `runAgents` now wrap in `withConversation` and stamp `Result.conversationId`), so a monitor groups
  multi-turn streamed and multi-agent runs.
- **S12** bounded output-block **re-ask** — `new Agent({ reaskOnOutputTrip: N })` re-asks the model to
  revise a blocked final answer up to N times (non-streaming; each re-ask is a billed model call) —
  and incremental streaming output checks — `new Agent({ streamCheckWindow: N })` re-evaluates the
  buffered output every N chars so a block fires earlier in a `run.stream`.
- **S13** streamed checkpoints — `run.stream` / `run.astream` now honor `checkpoint` (per-turn saves
  for a single agent, per-turn + per-segment for a team). A finished checkpoint replays a lone
  terminal `RunComplete` (no model call); an unfinished resume skips prepare and does not re-yield
  prior deltas. **Fixes** the prior silent-ignore of `checkpoint` in stream options (a latent API lie).
- **S7/S8/S9** span-tree parity with Python — `spanTree`/`liveSpans` now stamp `gen_ai.system`,
  `gen_ai.latency_ms`, `gen_ai.response.finish_reason`, the streamed flag, `error`/`gen_ai.error`, and
  tool `gen_ai.tool.arg_names`; live child spans are backdated by the call latency; and `spanTree` is a
  3-level `agent.run` → per-agent `agent {name}` → call tree.
- **S14** Bedrock forced-`toolChoice` structured output — a **tool-less** Bedrock agent with
  `outputType` forces a synthetic schema-shaped tool and unwraps its input into the answer; with real
  tools it falls back to the JSON nudge (a forced choice can't coexist with tools on Converse).

Streaming re-ask is intentionally offered in neither language — a streamed answer's deltas can't be
unshown to re-ask. Same `@cendor/core` `^0.11` / `@cendor/tokenguard` `^0.6` shelf (no floor bump).
