---
"@cendor/sdk": minor
---

Emission truth on governed journeys (Monitor v5, G-V4-1/2/3). `spanTree` and `liveSpans` now stamp
`cendor.ttft_ms` (time-to-first-token, recovered on the first streamed chunk) and
`cendor.usage_estimated="true"` (when a streamed call reported no usage and the count was recovered by
offline estimate) on `chat` spans; `liveSpans` stamps `cendor.run.agents` on the run root at close,
reaching parity with `spanTree` (whose root also now carries `cendor.run.agents` + usage/cost rollups,
matching the Python `span_tree`). So a monitor shows TTFT inside a governed journey, distinguishes
estimated vs real streamed tokens, and fills the Agents view for live-streamed runs. Additive.
Floor bumped to `@cendor/core@^0.8.0`.
