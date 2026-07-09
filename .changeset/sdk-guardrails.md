---
"@cendor/sdk": minor
---

`Agent({ guardrails: [...] })` — a deterministic gate at all four stages of the loop. Attach `@cendor/guardrails` rules (re-exported from `@cendor/sdk`: `defineGuardrail`, `GuardrailTripped`, `Verdict`, `GuardrailDecision`, `rules`) to gate `input` (pre-spend), `tool_call`, `tool_output`, and `output`. A `block` at input/output **throws `GuardrailTripped`** (fail-closed — an input block refuses before the model is ever called, `$0` spent); a `block` at the tool stages returns a `"[blocked by <name>] <reason>"` tool result so the loop continues without the side effect (mirroring `requireApproval`'s `"[denied]"`). `redact` rewrites the outgoing messages / tool args / result / output; `flag` records and proceeds. Every decision emits on the `@cendor/core` bus (correlated with the run), so an attached `AuditLog` chains it as a `guardrail_decision` entry. Works on the async, streaming, and multi-agent paths; each agent in a team gates with its own list.

Per-run override: `run(agent, input, { guardrails: [...] })` (and the streaming variants) replaces the agent's list for that run; `guardrails: []` disables gating. For a team, the override applies to every segment. This is per-agent/per-run scoped — unlike the process-global `guard()`, which stays the acttrace-policy scope (the two are distinct).

Adds `@cendor/guardrails` (`^0.1.0`) to dependencies.
