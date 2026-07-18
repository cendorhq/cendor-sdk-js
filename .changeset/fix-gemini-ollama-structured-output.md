---
"@cendor/sdk": patch
---

Fix three provider-adapter bugs surfaced by live black-box testing:

- **Gemini (`@google/genai`) spoke snake_case.** `GeminiProvider` sent `function_declarations`, `system_instruction`, `max_output_tokens`, `response_mime_type`/`response_schema` and read `function_call`/`finish_reason`, but the JS SDK is camelCase-only and silently drops unknown request keys — so tool declarations, the system instruction, the token cap and JSON mode were all dropped, and tool calls were never parsed. All request/response keys (and the `functionCall`/`functionResponse` history parts and `inlineData`/`fileData` multimodal parts) are now camelCase, with snake_case reads kept as a fallback for recorded fixtures.
- **Ollama tool loops died on the replay turn.** The canonical history stores tool-call `function.arguments` as a JSON string (OpenAI wire shape); the Ollama client requires an object and 400s on a string (`Value looks like object, but can't find closing '}' symbol`). `OllamaProvider` now re-hydrates arguments to objects for the Ollama wire.
- **Structured output ignored fenced JSON.** `parseOutput` did a bare `JSON.parse` and silently returned the raw string when a provider without a native JSON-schema mode (Anthropic/Ollama/HF) wrapped its JSON in a ```` ```json ```` fence or prose, breaking the declared `outputType`. It now strips the fence / extracts the first balanced JSON value before parsing.
