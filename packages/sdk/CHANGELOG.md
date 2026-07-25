# @cendor/sdk

## 0.23.1

### Patch Changes

- f5c126f: **Fix: the automatic run scope is now correct on Node 20 / 22, not just Node 24.**

  0.22.0–0.23.0 leaned on `@cendor/core`'s `AsyncLocalStorage.enterWith`-based latch, which only behaves
  as intended on Node ≥ 24 (see `@cendor/core` 0.15.1). On Node 20 / 22 an automatic scope leaked out of
  its run, so after `await run(...)` the caller's context stayed latched (later libs-only calls silently
  lost their flat spans) and two concurrent `run()`s shared one scope — the second opened no root and its
  steps could be parented under the first run's.

  The automatic scope now raises the latch **and** its `liveSpans` registry entry inside
  `AsyncLocalStorage.run()` (core's `_withLiveSpansDepth`), which is correctly scoped on every supported
  Node; the streaming path keeps the counter for the stream's lifetime and releases it in a `finally` (so
  abandoning a stream with `break` still releases it). Verified in docker on **node 20.20 / 22.23 /
  24.18**: two concurrent zero-code runs each get their own root, each step is parented under its own run,
  and the latch is clear afterwards on all three.

  A manual `liveSpans()` handle is unchanged and remains process-wide while open — that is what a
  hand-closed handle can honestly guarantee; the automatic path is the one with a scope to bind to.
  Requires `@cendor/core` ≥ 0.15.1.

## 0.23.0

### Minor Changes

- 1c3e1f5: **A blocked run now shows _why_ — inline on the run, with no audit object** (Option C, DR-2c).

  `liveSpans` renders `@cendor/tokenguard`'s budget events and `@cendor/guardrails`' decisions as
  `governance.*` children of the `agent.run` root, using core's `cendor.gov.*` vocabulary. So a
  telemetry user who writes zero governance code still sees the budget that stopped a run and the
  guardrail that tripped, in the trace, next to the steps they governed.

  - **The audit mirror still wins**: with an `AuditLog` in play, the chained `audit.*` spans are the
    rendering and these stand down (never two renderings of one decision).
  - **No `audit.*` vocabulary and no `reason` string** on these spans (rule 6 — a rule's reason can
    carry input-derived text; the audit chain keeps it).
  - `CENDOR_TELEMETRY=off` disables them with everything else.

  Dependency floors move to the shelf that carries Option C (`@cendor/core` ≥ 0.15,
  `@cendor/acttrace` ≥ 0.13, `@cendor/tokenguard` ≥ 0.8.1) — and, importantly, **the whole `@cendor/*`
  set is bumped together**: a sibling left on an older core minor resolves a second copy of core (a
  second event bus), and cross-library enforcement silently stops reaching the run.

## 0.22.0

### Minor Changes

- 2021502: **A governed run is now visible with zero telemetry code** (see `@cendor/core` 0.14 for the switch).

  ⚠️ **Default-behaviour change.** If your app configures an OpenTelemetry provider and you upgrade,
  `run()` / `run.stream()` open the run scope themselves: you get the `agent.run` root with its steps as
  children, usage/cost rollups, `gen_ai.conversation.id` from your `session`, and — because the root is
  the active span — governance correlated to the run. Previously this needed
  `const s = liveSpans(); try { … } finally { s.close() }` around every run.

  - **An explicit `liveSpans()` still wins**: the SDK opens nothing when a scope is already open, so
    there is never a second root. `CENDOR_TELEMETRY=off` disables the automatic path entirely, and with
    `@opentelemetry/api` absent nothing happens at all.
  - **The automatic scope closes in a `finally` the SDK owns** — including a throwing run and an
    abandoned stream (`break` out of `for await`), so the API's unclosed-handle foot-gun cannot bite the
    automatic path.
  - **No invented identity**: `cendor.run.label` stays empty unless you pass one (a label is a
    human-authored tag), and the conversation id is only ever the `session.id` you chose.

  Also fixed, both load-bearing once runs scope themselves:

  - **The `liveSpans` scope registry is per async context** (`AsyncLocalStorage`), so two concurrent
    runs no longer share one scope — previously the second run's children could be parented under the
    first run's root.
  - **`liveSpans()`'s root now carries `gen_ai.operation.name = 'agent'`**, matching `spanTree` and the
    Python `live_spans` root (backends that group by operation read it).
  - Bumped the `@cendor/*` dependency set to the current shelf. A stale sibling pin is not cosmetic: a
    library pinned to an older `@cendor/core` minor resolves a **second copy of core**, i.e. a second
    event bus, and cross-library cooperation (a guardrail decision reaching the SDK) silently stops.

## 0.21.1

### Patch Changes

- 5821b77: Docs + coverage truth-up — no runtime behaviour change.

  - **README rewritten to the real 0.21 surface.** Automatic token/cost capture is stated as **live for
    every provider** (Hugging Face / Ollama / Gemini / Bedrock-converse shipped in `@cendor/core` 0.3.0),
    and the previously-unmentioned surface is documented: `reaskOnOutputTrip`, `streamCheckWindow`,
    streamed checkpoints, `Result.conversationId` from a keyed session, and the six `cendor.sdk`
    telemetry domains on the live OTel path. Dropped the stale "v1.1 parity" / "capture activates once a
    matching core ships" framing.
  - **HF core-detection test** — the stale `it.todo` becomes a real assertion that the installed
    `@cendor/core` attributes an instrumented `chatCompletion` client to `huggingface` with captured usage.
  - **Pipeline-shape JSDoc** — `sequential` / `parallel` / `parallelAsync` now document that they honour
    `audit` / `maxTurns` / `retry` / `onStep` / `guardrails`, while `session` / `checkpoint` are team-only
    (`runAgents` / `supervisor`) and `guardrailMode` is a single-agent-run option.
  - **Coverage** — A2A `serve()` HTTP round-trip over loopback, a `SqliteSessionStore` disk round-trip
    (skipped when `better-sqlite3` is absent), Foundry Local / Azure Responses `buildKwargs`, and a
    resilience matrix (retryable statuses + never-retries-governance).

## 0.21.0

### Minor Changes

- ff2f646: SDK telemetry wave — structural signals for RAG, memory, orchestration, checkpoints, tools, and MCP become first-class `cendor.sdk` spans, rendered as their own domains by any OTel backend (or Cendor Monitor). **Zero `@cendor/core` changes** — the new signals ride the core bus and the existing `liveSpans` scope; content rules unchanged (labels/ids/counts only, never message bodies).

  - **RAG** (`rag.assemble` / `rag.compress`): `contextBudget` assembly (contextkit `AssemblyReport`) and squeeze compression (`CompressionEvent`) surface as `cendor.sdk` child spans in a `liveSpans` run — budget/used, blocks kept vs dropped, token deltas, technique.
  - **Memory** (`memory.load` / `memory.save`): a run reading/writing a `Session` emits a span with the session id, turn count, and byte size.
  - **Orchestration** (`orchestration.handoff`): each `transfer_to_<peer>` handoff emits an edge (from → to, segment, transfer tool) so a monitor builds the multi-agent graph from rows.
  - **Checkpoints** (`checkpoint.save` / `checkpoint.resume`): a `Checkpointer` write + a resume decision emit spans (run id, done flag, turn count).
  - **Tools**: every `execute_tool` span carries `cendor.tool.source` (`local` | `mcp`, + server/transport) and `cendor.tool.outcome` (`ok` | `error` | `blocked`). A `tool_call` guardrail block — which runs no tool — emits a dedicated `execute_tool {name}` span with `outcome="blocked"` + `cendor.tool.blocked_by`.
  - **MCP server attribution**: `loadMcpTools(session, { server, transport })` tags each tool's spans and emits `mcp.connect` / `mcp.list_tools` lifecycle spans for per-server attribution. Labels are optional and non-secret.

## 0.20.1

### Patch Changes

- dc32178: Re-pin `@cendor/core` to `^0.12.0` (and the sibling libs to their latest patches) so a fresh install of `@cendor/sdk` resolves a **single** `@cendor/core` copy. `@cendor/core` 0.12.0 is a minor (the openai-agents + Foundry framework adapters), so the prior `^0.11.0` caret would not admit it — leaving fresh installs with two core copies (the 0.x split-brain). No SDK API change; the adapters ride `@cendor/core` subpaths and need no SDK surface.

## 0.20.0

### Minor Changes

- 50a4ee2: Phase-S follow-up — the parity items deferred from 0.19 land in TypeScript:

  - **S6** streamed + team `conversationId` from a keyed session (`streamOne` / `streamAgents` /
    `runAgents` now wrap in `withConversation` and stamp `Result.conversationId`), so a monitor groups
    multi-turn streamed and multi-agent runs.
  - **S12** bounded output-block **re-ask** — `new Agent({ reaskOnOutputTrip: N })` re-asks the model to
    revise a blocked final answer up to N times (non-streaming; each re-ask is a billed model call) —
    and incremental streaming output checks — `new Agent({ streamCheckWindow: N })` re-evaluates the
    buffered output every N chars so a block fires earlier in a `run.stream`.
  - **S13** streamed checkpoints — `run.stream` / `run.astream` now honor `checkpoint` (per-turn saves
    for a single agent, per-turn + per-segment for a team). A finished checkpoint replays a lone
    terminal `RunComplete` (no model call); an unfinished resume skips prepare and does not re-yield
    prior deltas. **Fixes** the prior silent-ignore of `checkpoint` in stream options (a latent API lie).
  - **S7/S8/S9** span-tree parity with Python — `spanTree`/`liveSpans` now stamp `gen_ai.system`,
    `gen_ai.latency_ms`, `gen_ai.response.finish_reason`, the streamed flag, `error`/`gen_ai.error`, and
    tool `gen_ai.tool.arg_names`; live child spans are backdated by the call latency; and `spanTree` is a
    3-level `agent.run` → per-agent `agent {name}` → call tree.
  - **S14** Bedrock forced-`toolChoice` structured output — a **tool-less** Bedrock agent with
    `outputType` forces a synthetic schema-shaped tool and unwraps its input into the answer; with real
    tools it falls back to the JSON nudge (a forced choice can't coexist with tools on Converse).

  Streaming re-ask is intentionally offered in neither language — a streamed answer's deltas can't be
  unshown to re-ask. Same `@cendor/core` `^0.11` / `@cendor/tokenguard` `^0.6` shelf (no floor bump).

## 0.19.0

### Minor Changes

- 3cd1bb2: Provider capabilities wave (parity with `cendor-sdk` 1.14.0), on the new `@cendor/core` 0.11 /
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

## 0.18.0

### Minor Changes

- 471feaf: Wire the SDK onto the `@cendor/core` ambient seam so run context survives out-of-scope delivery, and
  harden `liveSpans`:

  - **Provider registration (GLR-2):** the active agent + conversation id are stamped onto every
    `LLMCall`/`ToolCall` at construction, so `liveSpans` reads them from the event even when the call is
    finalized outside the run scope (a stream drained after the scope, a context-losing layer).
    `liveSpans` now prefers the event's stamped `conversation_id` and stamps
    `gen_ai.usage.reasoning_tokens` on child spans (parity with Python `live_spans` + the core span
    emitter).
  - **Run-family filter (GLR-3, default on):** `liveSpans` renders only the run family it observed
    first (the segment before the first `:`), so a concurrent run sharing the process bus no longer
    pollutes its steps, rollups, or children.
  - **RAG in scope (GLR-4):** `prepareMessages` now runs inside the run scopes, so a retriever's
    embedding call is attributed to the run (a collected step, agent-stamped, counted against the run
    budget) instead of firing anonymously before the run opened.
  - **ThinkingDelta (GLR-12):** a new additive `run.stream` event surfacing streamed reasoning text for
    providers that stream it (Ollama `think` models; OpenAI-compatible `reasoning_content`), kept
    separate from `TextDelta`. Additive — a consumer that doesn't handle `'thinking_delta'` is
    unaffected.

  Floors `@cendor/core` at `^0.10.0` (the seam) and moves to the current library shelf so one core copy
  dedupes.

## 0.17.0

### Minor Changes

- 0a531fc: `run()`, `run.stream`, and the orchestration entries (`runAgents`, `sequential`, `parallel`,
  `parallelAsync`, `streamAgents`) now make the caller's `liveSpans()` run root the **active context
  span** for the run body (via a `context.with` wrap, parity with Python's `live_spans`). While a
  `liveSpans` scope is open, audit entries emitted during the run correlate to the run's trace
  (`@cendor/acttrace` stamps `cendor.audit.otel_trace_id`) and `audit.*` mirror spans nest under the
  run's trace — so an observability tool (e.g. Cendor Monitor) can link a governance event back to the
  run that produced it. This closes the TS-only governance→run linkage gap (Python already activated
  its run root).

  It composes with a caller's own active span rather than replacing it, is confined to the run body
  (the span is restored on exit), and is a **no-op** when no `liveSpans` scope is open or when
  `@opentelemetry/api` / its context manager is absent — runs without `liveSpans` behave exactly as
  before. No API change.

  Also raises the floor on `@cendor/core` (`^0.9.0`) and `@cendor/acttrace` (`^0.10.0`) so a single
  `@cendor/core` instance dedupes across the tree with the activated-span + `run_id` correlation
  support.

## 0.16.0

### Minor Changes

- a4f98b9: Emission truth on governed journeys (Monitor v5, G-V4-1/2/3). `spanTree` and `liveSpans` now stamp
  `cendor.ttft_ms` (time-to-first-token, recovered on the first streamed chunk) and
  `cendor.usage_estimated="true"` (when a streamed call reported no usage and the count was recovered by
  offline estimate) on `chat` spans; `liveSpans` stamps `cendor.run.agents` on the run root at close,
  reaching parity with `spanTree` (whose root also now carries `cendor.run.agents` + usage/cost rollups,
  matching the Python `span_tree`). So a monitor shows TTFT inside a governed journey, distinguishes
  estimated vs real streamed tokens, and fills the Agents view for live-streamed runs. Additive.
  Floor bumped to `@cendor/core@^0.8.0`.

## 0.15.0

### Minor Changes

- d9aecb5: Opt-in content on the run spans + auto session grouping — the SDK half of the Cendor journey console (Monitor v3). Backward-compatible (additive); content stays OFF unless you opt in with `@cendor/core`'s `otel.captureContent()`.

  - **Opt-in content on `spanTree` / `liveSpans` (G17/G18).** When content capture is on, each `chat` step span carries `gen_ai.input.messages`, `gen_ai.output.messages` (incl. parsed **thinking** parts), and `gen_ai.system_instructions` (from the request kwargs for Anthropic/Responses/Gemini/Bedrock); each `execute_tool` span carries `cendor.tool.arguments` / `cendor.tool.result`. Masked + byte-capped by the core config, never on `audit.*` spans (rule 6). Off by default.
  - **Auto conversation id (G19).** `run({ session })` propagates the session key as `gen_ai.conversation.id` — `SqliteSessionStore.load(id)` / `MemorySessionStore.load(id)` stamp `Session.id`, and `new Session([], 'chat-42')` works for the in-memory case. `liveSpans` reads it live; `spanTree` reads it from `Result.conversationId` (new field). An explicit `conversationId` still wins; never synthesized.
  - **Cassette replay flag on run spans (G22).** A replayed `chat` step carries `cendor.replayed=true`.
  - **G20 co-existence.** `liveSpans` signals core's opt-in bus→span emitter to stand down while it owns the spans.

  Dependency ranges bump to the Monitor v3 shelf: `@cendor/core ^0.7.0`, `@cendor/acttrace ^0.9.0`, `@cendor/squeeze ^0.3.0`.

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
