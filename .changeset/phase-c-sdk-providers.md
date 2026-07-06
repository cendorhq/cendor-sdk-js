---
"@cendor/sdk": minor
---

Providers: port HuggingFace, Azure AI Foundry (chat + responses), Foundry Local, Ollama (with
streaming reassembly), Gemini, and Bedrock, retiring the `UnportedProvider` stubs. Adds multimodal
content conversion (`anthropicContent` / `geminiParts` / Bedrock text) and fixes an Anthropic
multimodal passthrough bug (user content now routed through `anthropicContent`).

End-to-end token/cost capture for HuggingFace, Ollama, Gemini, and Bedrock activates once a
`@cendor/core` release with the matching `instrument()` detection is published and this package bumps
its dependency — those integration tests are marked `it.todo` until then. Azure AI Foundry and Foundry
Local capture usage today (they use the standard OpenAI client, already detected by core).
