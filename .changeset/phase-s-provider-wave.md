---
"@cendor/sdk": minor
---

Provider capabilities wave (parity with `cendor-sdk` 1.14.0), on the new `@cendor/core` 0.11 /
`@cendor/tokenguard` 0.6 shelf:

- **Anthropic incremental streaming + ThinkingDelta (S1/S2)** — `AnthropicProvider` now streams: text
  arrives as `TextDelta` (`text_delta`), extended thinking as `ThinkingDelta` (`thinking_delta`), and
  tool calls reassemble from `input_json_delta` fragments keyed by content-block index. Previously
  Anthropic fell back to a single whole-response delta.
- **Native Anthropic structured output (S14)** — `output_config.format` json_schema (normalized to
  `additionalProperties: false`) on supported model families; older models degrade to the
  JSON-instruction nudge. Bedrock keeps the nudge (forced-`toolChoice` is a documented honest limit).
- **Ollama + Bedrock images (S15)** — a multimodal user turn with data-URL images translates to
  Ollama's `images: [base64…]` and Bedrock Converse image blocks (raw bytes). Remote http(s) image
  URLs remain unsupported (no fetching) — documented.
- Floors: `@cendor/core ^0.11.0`, `@cendor/tokenguard ^0.6.0` (+ sibling cascade pins).

Honest limits tracked for a follow-up (not in this release): streamed/multi-agent `conversation.id`
grouping, TS guardrails re-ask / stream-window, streamed-run checkpoints, Bedrock forced-`toolChoice`
structured output, and the finer TS span-attribute set.
