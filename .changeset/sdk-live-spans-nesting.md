---
'@cendor/sdk': patch
---

Fix: `liveSpans` and `spanTree` now **nest child call spans under the run root** so a run renders as one waterfall. Previously the TypeScript span helpers created each `chat`/`execute_tool` span with no parent context, so children scattered into separate traces (the `agent.run` root had no children in the trace view). They now parent children under the root via the OpenTelemetry context API — matching the Python behavior. `cendor.step` / `gen_ai.agent.name` / usage attributes were already emitted; this makes them show on the run's own trace.
