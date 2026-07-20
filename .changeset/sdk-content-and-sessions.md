---
"@cendor/sdk": minor
---

Opt-in content on the run spans + auto session grouping — the SDK half of the Cendor journey console (Monitor v3). Backward-compatible (additive); content stays OFF unless you opt in with `@cendor/core`'s `otel.captureContent()`.

- **Opt-in content on `spanTree` / `liveSpans` (G17/G18).** When content capture is on, each `chat` step span carries `gen_ai.input.messages`, `gen_ai.output.messages` (incl. parsed **thinking** parts), and `gen_ai.system_instructions` (from the request kwargs for Anthropic/Responses/Gemini/Bedrock); each `execute_tool` span carries `cendor.tool.arguments` / `cendor.tool.result`. Masked + byte-capped by the core config, never on `audit.*` spans (rule 6). Off by default.
- **Auto conversation id (G19).** `run({ session })` propagates the session key as `gen_ai.conversation.id` — `SqliteSessionStore.load(id)` / `MemorySessionStore.load(id)` stamp `Session.id`, and `new Session([], 'chat-42')` works for the in-memory case. `liveSpans` reads it live; `spanTree` reads it from `Result.conversationId` (new field). An explicit `conversationId` still wins; never synthesized.
- **Cassette replay flag on run spans (G22).** A replayed `chat` step carries `cendor.replayed=true`.
- **G20 co-existence.** `liveSpans` signals core's opt-in bus→span emitter to stand down while it owns the spans.

Dependency ranges bump to the Monitor v3 shelf: `@cendor/core ^0.7.0`, `@cendor/acttrace ^0.9.0`, `@cendor/squeeze ^0.3.0`.
