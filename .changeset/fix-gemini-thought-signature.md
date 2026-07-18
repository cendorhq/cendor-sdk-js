---
"@cendor/sdk": patch
---

Fix: Gemini 3.x multi-turn tool loops no longer 400 on the replay turn. gemini-3.x returns a `thoughtSignature` alongside each `functionCall` part that must be echoed back on the next turn; without it the API rejects the replayed call (`Function call is missing a thought_signature in functionCall parts`). `ToolInvocation` now carries `thoughtSignature`, the Gemini adapter captures it on parse, and `canonicalToGemini` re-emits it as a sibling of `functionCall`. Other providers are unaffected.
