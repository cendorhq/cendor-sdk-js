---
"@cendor/sdk": minor
---

Wave-1 guardrails: `rules.pii` / `rules.secrets` / `rules.entropy` (acttrace-bridged detector guardrails at all four stages, including `tool_output`), `Result.guardrailDecisions` (every trip/flag recorded during a run — single-agent, streaming, and multi-agent), and `Agent({ guardrailMode })` / per-run `guardrailMode` (`"blocking"` default | `"parallel"` overlaps the input gate with the first model call). `rules` is now the SDK superset (deterministic built-ins + the bridged detectors). Re-exporting the LLM-judge helpers and honoring per-guardrail `timeout`/`onError` are deferred until `@cendor/guardrails` 0.2.0 publishes.
