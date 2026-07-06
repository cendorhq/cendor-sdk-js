# @cendor/sdk

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
