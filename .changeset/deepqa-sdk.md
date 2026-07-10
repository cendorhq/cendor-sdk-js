---
"@cendor/sdk": minor
---

Deep-QA fixes.

- Re-export `judge` / `taskAdherence` from `@cendor/sdk` — one-import parity with Python's `cendor.sdk.judge` / `cendor.sdk.task_adherence`. They were defined in `governance` but never forwarded from the entrypoint, so the docs' `import { judge } from '@cendor/sdk'` + `judge.taskAdherence(...)` threw at runtime (M8).
- Bump the `@cendor/*` dependency ranges to the deep-QA releases — `@cendor/core` `^0.5.0` (token accuracy H2 + Gemini capture H3), `@cendor/guardrails` `^0.6.0` (streaming output gate M2, `rules.language` default M3, sync LLM-judge M4, plus `localEmbedder`), and the rest — so a fresh `npm i @cendor/sdk` resolves the fixed libraries and dedupes to a single `@cendor/core` (no split-brain) (M6).
