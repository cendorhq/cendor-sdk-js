---
"@cendor/sdk": patch
---

Docs + packaging for launch: rewrite the README to reflect the shipped 0.3.x surface (all providers,
MCP/A2A/Foundry interop, live streaming, and `contextBudget` are implemented — the old "Deferred"
section was stale), keeping the honest caveat that token/cost capture for HF/Ollama/Gemini/Bedrock
activates with a matching `@cendor/core` detection release. Ship LICENSE + NOTICE in the tarball; add
`homepage`/`bugs` metadata and npm/license badges. No runtime changes.
