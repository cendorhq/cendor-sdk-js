# @cendor/sdk

## 0.14.1

### Patch Changes

- c7875a1: Fix: `liveSpans` and `spanTree` now **nest child call spans under the run root** so a run renders as one waterfall. Previously the TypeScript span helpers created each `chat`/`execute_tool` span with no parent context, so children scattered into separate traces (the `agent.run` root had no children in the trace view). They now parent children under the root via the OpenTelemetry context API — matching the Python behavior. `cendor.step` / `gen_ai.agent.name` / usage attributes were already emitted; this makes them show on the run's own trace.

## 0.14.0

### Minor Changes

- 396c450: Richer run spans for the monitor. `liveSpans`/`spanTree` now stamp `gen_ai.agent.name` (which agent made the call) and a 1-based `cendor.step` on every child span; `liveSpans` reaches parity with `spanTree` — its root learns `cendor.run.id`/`cendor.trace_id` from the run's correlation id and carries the run's `gen_ai.usage.*` + `cendor.run.cost_usd` rollups at close. New opt-in `{ label }` on both → `cendor.run.label` on the root, so a monitor can show what a run was _for_ (never derived from the prompt — prompts/tool values stay off spans). The per-agent `maxUsd` ceiling is now named (`agent:<name> max_usd`) so a cap block is attributable. Dependency floors bumped to the V2 emission wave (`@cendor/tokenguard ^0.4`, `@cendor/acttrace ^0.8`, `@cendor/guardrails ^0.7`). Additive and backward-compatible.

## 0.13.0

### Minor Changes

- b58c732: `gen_ai.conversation.id` grouping for multi-turn runs (backward-compatible, opt-in). `spanTree(result, tracer?, { conversationId })` and `liveSpans({ conversationId })` now accept an optional conversation/session id (e.g. your session store key). When given, the root `agent.run` span carries it as the OpenTelemetry `gen_ai.conversation.id` semantic-convention attribute, so a backend can group the runs of one multi-turn conversation. Omitted by default (no key leaks when you aren't grouping). Libs-only users can pass any `gen_ai.*` attribute through `@cendor/core`'s `otel.span(...)` attributes.

  See https://cendor.ai/docs/observability

## 0.12.0

### Minor Changes

- 2c16393: Re-export the OpenTelemetry observability export surface: `OTelMirror` (from `@cendor/acttrace` 0.7) and `BudgetEvent` (from `@cendor/tokenguard` 0.3). Attach `new AuditLog(system, { mirror: new OTelMirror() })` to stream the governed loop's audit trail — decisions, guardrail actions, `budget_event`s, human oversight — to any OpenTelemetry backend as an operational copy (the hash-chained file stays the sole `verify()` evidence). Dependency floors bumped to `@cendor/acttrace ^0.7.0`, `@cendor/tokenguard ^0.3.0`.

  See https://cendor.ai/docs/observability

## 0.11.0

### Minor Changes

- 9166d81: Require zod 4 for tool and output schemas; drop `zod-to-json-schema`.

  Tool parameters and structured-output schemas are now converted with zod 4's native
  `z.toJSONSchema` (`io: 'input'`, `additionalProperties: false` on every object) — the emitted
  per-provider tool shapes are unchanged.

  **Breaking for zod 3 callers.** A zod 3 schema passed to `tool({ parameters })` or an agent's
  `outputType` is now rejected with a clear error instead of silently producing an empty parameter
  schema (the failure mode in `@cendor/sdk` ≤ 0.10 when a zod 4 schema was passed). To migrate: on
  zod 3.25+ change the import to `import { z } from 'zod/v4'`, or upgrade zod to `^4`, or pass a
  pre-built JSON Schema via `jsonSchema:`. Users do not need to match the SDK's bundled zod version.

## 0.10.2

### Patch Changes

- 4124d6b: Fix: Gemini 3.x multi-turn tool loops no longer 400 on the replay turn. gemini-3.x returns a `thoughtSignature` alongside each `functionCall` part that must be echoed back on the next turn; without it the API rejects the replayed call (`Function call is missing a thought_signature in functionCall parts`). `ToolInvocation` now carries `thoughtSignature`, the Gemini adapter captures it on parse, and `canonicalToGemini` re-emits it as a sibling of `functionCall`. Other providers are unaffected.

## 0.10.1

### Patch Changes

- f6937be: Fix three provider-adapter bugs surfaced by live black-box testing:

  - **Gemini (`@google/genai`) spoke snake_case.** `GeminiProvider` sent `function_declarations`, `system_instruction`, `max_output_tokens`, `response_mime_type`/`response_schema` and read `function_call`/`finish_reason`, but the JS SDK is camelCase-only and silently drops unknown request keys — so tool declarations, the system instruction, the token cap and JSON mode were all dropped, and tool calls were never parsed. All request/response keys (and the `functionCall`/`functionResponse` history parts and `inlineData`/`fileData` multimodal parts) are now camelCase, with snake_case reads kept as a fallback for recorded fixtures.
  - **Ollama tool loops died on the replay turn.** The canonical history stores tool-call `function.arguments` as a JSON string (OpenAI wire shape); the Ollama client requires an object and 400s on a string (`Value looks like object, but can't find closing '}' symbol`). `OllamaProvider` now re-hydrates arguments to objects for the Ollama wire.
  - **Structured output ignored fenced JSON.** `parseOutput` did a bare `JSON.parse` and silently returned the raw string when a provider without a native JSON-schema mode (Anthropic/Ollama/HF) wrapped its JSON in a ` ```json ` fence or prose, breaking the declared `outputType`. It now strips the fence / extracts the first balanced JSON value before parsing.

## 0.10.0

### Minor Changes

- e9abcde: The SDK inherits the libraries — verified. `guard` is now the identical acttrace object, embeddings are governed pre-flight, `rules` reaches full Python parity, the pii bridge honors per-category actions, and a new parity/identity test suite pins every re-export so drift fails the build. Pins move to `@cendor/acttrace ^0.6.0` / `@cendor/core ^0.6.0` (+ the current shelf for the rest — one deduped core, one bus).

  - **`guard` is the identical `@cendor/acttrace` object** (`Object.is(sdk.guard, acttrace.guard)`). acttrace 0.6.0's dual shape carries the scope form (`guard(opts, fn)` — the SDK's historical call shape, drop-in), so the SDK wrapper is deleted. `GuardOptions` is now acttrace's type, re-exported.
  - **`rules` reaches full Python parity (D1):** `spotlight`, `language`, `classifier`, `openaiModeration`, `bedrockGuardrail`, `azureContentSafety`, `modelArmor`, `groundedness`, and `deniedTopics` now ride the SDK `rules` namespace. Only the helpers (`payloadText`, `NORMALIZATIONS`) stay library-only.
  - **Behavior fix — `rules.pii`/`secrets`/`entropy` honor per-category policy actions** (via acttrace's new `resolveFindings`, the same resolution `guard()` applies). A `block`-tier category blocks and a `redact`-tier one is scrubbed **regardless of the `action` option**, which now applies only to flag-tier findings — `pii(Policy.gdpr(), { action: 'redact' })` blocks a `special_category` finding instead of merely scrubbing it. The bridges also accept **`timeout` / `onError` / `metadata`** (forwarded to `defineGuardrail` — closing the long-stale "0.2.0" wait; the lib has shipped them since 0.6.x).
  - **`embed()` is governed pre-flight:** it rides `instrument()` so `@cendor/core` 0.6.0 captures the call — a keyless `withBudget({ usd, onExceed: 'block' }, …)` refuses an over-budget embed _before_ it fires. The SDK's hand-built emit shim is deleted (no double emission).
  - **New re-exports:** `loadPolicy` (config-as-data parity with Python), `downgrades`, `clamps`; `ContextBudgetFallback` (the new diagnostic bus event a failed `contextBudget` assembly emits — silent but observable).
  - **`Result.usage` aggregates through core's field-complete `sumUsage`**; never-retry is `instanceof`-matched on the real `BudgetExceeded`/`PolicyViolation` classes; `EvalCase.normalizer` is forwarded to cassette's replay matching.
  - **New `test/lib-parity.test.ts`:** `Object.is` pins for every documented re-export, a rules-catalogue diff against a reviewed exclusion allowlist, forwarded-shape pins, and the shim-expiry harness.

## 0.9.2

### Patch Changes

- 28f6731: Provider-auth hardening. A live provider call that fails to authenticate **while the keyless
  placeholder is in play** now throws `MissingAPIKeyError` (exported from `@cendor/sdk`) naming the
  env var to set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY`, `HF_TOKEN`) and
  linking the docs, instead of the provider's bare 401 — never firing with a real key, a pre-built
  `client`, on non-auth errors, or on keyless offline flows. Bedrock now rejects `apiKey` with a clear
  "authenticates via the AWS credential chain" error instead of silently ignoring it.

## 0.9.1

### Patch Changes

- 45f2db3: AI-assistant onboarding: inline Type Teach ships in the package — `@example` + correct-shape JSDoc on the public API (`Agent`, `run`, `SqliteSessionStore`, re-exported `rules`/`judge`), including the `SqliteSessionStore` ↔ `SQLiteSessionStore` casing note — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code. Full trap sheet: https://cendor.ai/docs/for-ai-assistants

## 0.9.0

### Minor Changes

- 787f8e2: Deep-QA fixes.

  - Re-export `judge` / `taskAdherence` from `@cendor/sdk` — one-import parity with Python's `cendor.sdk.judge` / `cendor.sdk.task_adherence`. They were defined in `governance` but never forwarded from the entrypoint, so the docs' `import { judge } from '@cendor/sdk'` + `judge.taskAdherence(...)` threw at runtime (M8).
  - Bump the `@cendor/*` dependency ranges to the deep-QA releases — `@cendor/core` `^0.5.0` (token accuracy H2 + Gemini capture H3), `@cendor/guardrails` `^0.6.0` (streaming output gate M2, `rules.language` default M3, sync LLM-judge M4, plus `localEmbedder`), and the rest — so a fresh `npm i @cendor/sdk` resolves the fixed libraries and dedupes to a single `@cendor/core` (no split-brain) (M6).

## 0.8.0

### Minor Changes

- ce6f5d7: V04 re-exports (parity with `@cendor/guardrails` 0.4). Additive; bumps the `@cendor/guardrails`
  dependency `^0.3.0` → `^0.4.0`.

  - `rules.customCategory` + `rules.intent` on the SDK's `rules` surface — semantic category-by-example
    and the pre-LLM intent gate (BYO `embed`/`classify`), for `new Agent({ guardrails: [...] })`.
  - `presets` + `policySchema` re-exported at the top level (the curated `presets.promptInjection()`
    starter and the policy JSON Schema, with `loadPolicy(src, { validate: true })`).
  - G1 `keywordDeny({ match: 'word', normalize: [...] })` rides along through the re-exported rule.

  No runner change — these are library capabilities surfaced through the SDK façade. All
  capability-neutral (the guardrails claim gates stay shut). The zero-config `localEmbedder` is
  Python-only (model2vec); in TS pass a bring-your-own `embed`.

## 0.7.0

### Minor Changes

- 3f7c13b: V03 A3 tail — task-adherence at the `tool_call` stage. Re-exports `taskAdherence` (plus the `judge` namespace) from `@cendor/guardrails`, and the runner now auto-threads the originating user turn into `Context.instruction` at every tool-call seam (blocking and streaming), so `judge.taskAdherence` sees the user's intent with no manual wiring — closing the deferred parity tail. Bumps the `@cendor/guardrails` dependency to `^0.3.0`, which also brings `rules.spotlight` and the annotation-parity decision metadata (severity / detected / filtered / redacted / citation / license) to SDK consumers. Additive and backward-compatible.

## 0.6.0

### Minor Changes

- 89c4d8e: Wave-1 guardrails: `rules.pii` / `rules.secrets` / `rules.entropy` (acttrace-bridged detector guardrails at all four stages, including `tool_output`), `Result.guardrailDecisions` (every trip/flag recorded during a run — single-agent, streaming, and multi-agent), and `Agent({ guardrailMode })` / per-run `guardrailMode` (`"blocking"` default | `"parallel"` overlaps the input gate with the first model call). `rules` is now the SDK superset (deterministic built-ins + the bridged detectors). Re-exporting the LLM-judge helpers and honoring per-guardrail `timeout`/`onError` are deferred until `@cendor/guardrails` 0.2.0 publishes.

## 0.5.1

### Patch Changes

- b52af95: Bump the `@cendor/acttrace` dependency to `^0.5.0` so a fresh install of `@cendor/sdk` resolves
  acttrace 0.5.0 — the release that chains guardrail decisions as tamper-evident `guardrail_decision`
  entries. Under the previous `^0.4.0` cap, `npm i @cendor/sdk` pulled acttrace 0.4.2, so
  `GuardrailDecision` events emitted by `Agent({ guardrails: [...] })` were not captured in the audit
  chain. No API change; deps-only.

## 0.5.0

### Minor Changes

- aab4a7e: `Agent({ guardrails: [...] })` — a deterministic gate at all four stages of the loop. Attach `@cendor/guardrails` rules (re-exported from `@cendor/sdk`: `defineGuardrail`, `GuardrailTripped`, `Verdict`, `GuardrailDecision`, `rules`) to gate `input` (pre-spend), `tool_call`, `tool_output`, and `output`. A `block` at input/output **throws `GuardrailTripped`** (fail-closed — an input block refuses before the model is ever called, `$0` spent); a `block` at the tool stages returns a `"[blocked by <name>] <reason>"` tool result so the loop continues without the side effect (mirroring `requireApproval`'s `"[denied]"`). `redact` rewrites the outgoing messages / tool args / result / output; `flag` records and proceeds. Every decision emits on the `@cendor/core` bus (correlated with the run), so an attached `AuditLog` chains it as a `guardrail_decision` entry. Works on the async, streaming, and multi-agent paths; each agent in a team gates with its own list.

  Per-run override: `run(agent, input, { guardrails: [...] })` (and the streaming variants) replaces the agent's list for that run; `guardrails: []` disables gating. For a team, the override applies to every segment. This is per-agent/per-run scoped — unlike the process-global `guard()`, which stays the acttrace-policy scope (the two are distinct).

  Adds `@cendor/guardrails` (`^0.1.0`) to dependencies.

## 0.4.1

### Patch Changes

- 1f1848b: Enforce `Agent.maxUsd` on single-agent `run()` and `stream()`, not only on orchestrated/multi-agent runs. The per-agent USD cap was previously applied only inside the orchestrator's per-segment scope, so a plain `run(agent, ...)` billed with no ceiling. The single-agent run and stream paths now wrap the same pre-flight `withBudget({ onExceed: 'block' })` scope the orchestrator uses, so an over-budget call is refused before it is sent.

  Also short-circuit resuming an already-completed checkpoint: resuming a run whose checkpoint is marked `done` now returns the stored result (`steps: []`, zero model calls, zero tool calls) instead of rebuilding from the original input and replaying the whole loop (which re-invoked the model and re-ran completed tools). Applies to single- and multi-agent runs.

## 0.4.0

### Minor Changes

- 180731e: Unify the `@cendor/*` dependency line on the core 0.4.0 cascade and ship keyless Entra-ID auth.

  - **Fix (dependency resolution):** bump every `@cendor/*` dependency to the published set that resolves a **single** `@cendor/core` (`core`/`acttrace` → `^0.4.0`, `tokenguard`/`cassette`/`squeeze` → `^0.2.5`, `contextkit` → `^1.0.5`). Previously the SDK pinned `@cendor/core ^0.3.0` and `@cendor/acttrace ^0.3.0` while the other libs had moved to `core ^0.4.0`, so a fresh `npm i @cendor/sdk` installed two `@cendor/core` instances — two event-bus singletons — and budget enforcement, `track`, cassette replay, and downgrade-reroute silently no-op'd. All governance/orchestration tests pass with the unified single core.
  - **Feature:** `azureADTokenProvider` (an async `() => Promise<string>` token callback) on the agent/client options authenticates against Azure AI Foundry with Microsoft Entra ID (keyless), refreshing the token per request. Requires the `AzureOpenAI` client from `openai >= 4.53`.

## 0.3.3

### Patch Changes

- cfc6bad: Docs + packaging for launch: rewrite the README to reflect the shipped 0.3.x surface (all providers,
  MCP/A2A/Foundry interop, live streaming, and `contextBudget` are implemented — the old "Deferred"
  section was stale), keeping the honest caveat that token/cost capture for HF/Ollama/Gemini/Bedrock
  activates with a matching `@cendor/core` detection release. Ship LICENSE + NOTICE in the tarball; add
  `homepage`/`bugs` metadata and npm/license badges. No runtime changes.

## 0.3.2

### Patch Changes

- a7b62c8: Plain-language README opener (the tagline npm renders at the top of the package page). Docs only.

## 0.3.1

### Patch Changes

- f08aaa1: Plain-language npm package description (metadata only — no code change).

## 0.3.0

### Minor Changes

- fb14ccf: Live incremental + multi-agent streaming; governance on all run paths; contextBudget assembly; sequential/parallel trace correlation; SummarizingSession write-back is now awaited.

  - `run.stream` (single agent) now yields each `TextDelta`/`ToolCallEvent`/`ToolResultEvent` the instant it is produced (inside the `trace(runId)` scope, so emitted `LLMCall`/`ToolCall` bus events stay correlated), instead of buffering and draining after the run.
  - `run.stream([...])` (multi-agent) streams a real handoff run: each active agent's turns stream live, control switches on a `transfer_to_<peer>` call, and a single terminal `RunComplete` carries the aggregate `Result`.
  - An audit `decision()` is now opened on every run path (single blocking/stream, multi blocking/stream, sequential, parallel), recording the `{agent, model, trace_id}` bridge; the active `Decision` is published in an `AsyncLocalStorage` so `hitl.requireApproval` records `human_oversight` (on approve and reject, honoring `reviewer`).
  - Per-agent governance (`track({agent})` + a `budget` when `maxUsd` is set) now wraps every orchestration segment — `maxUsd` is enforced.
  - `Agent.contextBudget` is now wired: context is assembled to the token budget via `@cendor/contextkit` per turn (falling back to raw messages on any error).
  - `sequential` / `parallel` / `parallelAsync` correlate under one parent trace id (`Result.traceId` = parent; every step's trace id starts with it).
  - RAG context is injected once per run (persisting into `Result.messages`/session) instead of re-retrieving each turn.
  - `SummarizingSession.replace` write-back is now awaited, so summarization finishes before the run returns (deterministic session state, correlated events).

- bc29de8: Providers: port HuggingFace, Azure AI Foundry (chat + responses), Foundry Local, Ollama (with
  streaming reassembly), Gemini, and Bedrock, retiring the `UnportedProvider` stubs. Adds multimodal
  content conversion (`anthropicContent` / `geminiParts` / Bedrock text) and fixes an Anthropic
  multimodal passthrough bug (user content now routed through `anthropicContent`).

  End-to-end token/cost capture for HuggingFace, Ollama, Gemini, and Bedrock activates once a
  `@cendor/core` release with the matching `instrument()` detection is published and this package bumps
  its dependency — those integration tests are marked `it.todo` until then. Azure AI Foundry and Foundry
  Local capture usage today (they use the standard OpenAI client, already detected by core).

- f07b04d: MCP client (tools/prompts/resources); checkpoint/resume durability; A2A server+client+serve; Foundry Bot-Framework adapter.

  - `loadMcpTools` / `loadMcpPrompts` / `getMcpPrompt` / `loadMcpResources` consume a duck-typed MCP client session (the `@modelcontextprotocol/sdk` `Client` shape) — MCP tools become governed `Tool`s (server schema used verbatim) that flow through the same loop/bus/audit/budget. `@modelcontextprotocol/sdk` is an optional peer dependency (never imported at runtime; the session is caller-supplied).
  - `Checkpointer` (+ `asCheckpointer`) persists a run's conversation to a local JSON file after each turn (atomic temp-file + rename); a crashed run resumes without re-doing completed work. Wired through `RunOptions.checkpoint` for both single-agent (`Runner`) and multi-agent (`runAgents`) paths via a new `onTurn` hook on the loop; multi-agent resume preserves the saved run_id and ignores new input.
  - `A2AServer` / `A2AClient` expose a governed agent over the A2A JSON-RPC `message/send` protocol (in-process for tests/embedding), carrying governance metadata (trace id, cost); `serve()` is an optional local node:http server.
  - `FoundryAdapter` adapts a governed agent to the Bot Framework Activity protocol (custom-engine agent), returning an outbound Activity with governance metadata in `channelData.cendor`.

## 0.2.0

### Minor Changes

- 3c46063: Initial release of `@cendor/sdk` — the TypeScript port of `cendor-sdk`. A governed agent loop over
  `@cendor/core`: OpenAI (Chat + Responses) and Anthropic providers (real SDKs, `instrument()`ed),
  zod-schema tools, structured outputs, streaming, handoff/sequential/parallel/supervisor
  orchestration, sessions (memory + better-sqlite3), retrieval (`VectorIndex`), retries, eval over
  cassettes, HITL approval, and OTel spans (no-op without OpenTelemetry). Governance (budgets, audit,
  guard) is re-exported from the real `@cendor/*` libraries and rides core's seams. Includes the v1.1
  surface: live `onStep` hooks, Anthropic prompt caching, and multi-agent streaming.
