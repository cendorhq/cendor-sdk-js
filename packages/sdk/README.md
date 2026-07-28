# @cendor/sdk

[![npm version](https://img.shields.io/npm/v/@cendor/sdk.svg)](https://www.npmjs.com/package/@cendor/sdk) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Build an LLM agent with spending limits, a tamper-evident audit trail, PII redaction, and record/replay testing built in from the start** — a governed agent in about 10 lines. The TypeScript port of [`cendor-sdk`](https://github.com/cendorhq/cendor-sdk); governance is the foundation, not a plugin. It adds no governance machinery of its own: all seven `@cendor/*` libraries ship as dependencies, and each cooperates through `@cendor/core`'s bus/interceptor seams — no tool imports another.

```ts
import OpenAI from 'openai';
import { Agent, run, tool, withBudget, AuditLog, verify } from '@cendor/sdk';
import { z } from 'zod';

const refund = tool((a: { orderId: string }) => `refunded ${a.orderId}`, {
  name: 'refund',
  description: 'Issue a refund',
  parameters: z.object({ orderId: z.string() }),
});

const audit = new AuditLog('refund-bot', { riskTier: 'high', path: 'audit.jsonl', signingKey: process.env.KEY });
const agent = new Agent({ name: 'refund-bot', model: 'gpt-4o', tools: [refund], client: new OpenAI() });

const result = await withBudget({ usd: 0.5, onExceed: 'block' }, () =>
  run(agent, 'refund order #123', { audit }),
);
console.log(result.output, result.cost.toString());
audit.detach();
console.log(verify('audit.jsonl', { key: process.env.KEY })); // [true, "ok: ..."]
```

**Auth:** `new OpenAI()` reads `OPENAI_API_KEY` from your environment — or pass `apiKey` on the
`Agent` (or drop `client` and let the SDK build it). No Cendor-specific key.
[Keys & providers →](https://cendor.ai/docs/sdk/providers#api-keys--credentials)


## Observability — your OTel backend, zero telemetry code

Configure an OpenTelemetry provider the way you already would (or point `OTEL_EXPORTER_OTLP_ENDPOINT`
at [Cendor Monitor](https://cendor.ai/docs/monitor)) and `run()` does the rest: an `agent.run` root
span with each step as a child, usage/cost rollups, your `session` id as `gen_ai.conversation.id`,
and — because the root is the active span — governance correlated to the run, including the
`governance.*` span for the budget or guardrail that stopped it. Concurrent runs each land under
their own root. An explicit `liveSpans()` still wins; `CENDOR_TELEMETRY=off` turns it all off;
`CENDOR_DEBUG_TELEMETRY=1` says what was detected. Cendor has no endpoint, exporter, or key — it
emits into **your** provider.

## What's implemented

- **Agent loop** — `run(agent, input, opts)` (async), tool calling, `maxTurns`, structured output
  (`outputType` as a zod schema or JSON-schema object), `Result`/`Step` with aggregate `usage`/`cost`.
- **Providers** — OpenAI (Chat Completions + Responses), Anthropic, Google Gemini, AWS Bedrock,
  Ollama, Hugging Face, and Azure AI Foundry (chat + responses) + Foundry Local, driven through the
  real SDKs (`instrument()`ed); provider inferred from the model id, or pass a pre-built `client`.
  Token/cost is captured end-to-end for every provider by the installed `@cendor/core`'s
  `instrument()` — no per-provider wiring, and no provider left to a future release.
- **Tools via zod** — `tool(fn, { parameters: z.object({...}) })` → each provider's native tool shape.
- **Governance** (the identical re-exported libraries — CI-pinned since 0.10.0, incl. `guard`) — `budget`/`withBudget`, `track`, `report`, `guard`,
  `AuditLog`/`verify`, `registerModelPrice`, `BudgetExceeded`. A bare `run()` needs none of it.
- **Guardrails** — `Agent({ guardrails: [...] })` gates all four stages. `rules` is one surface: the
  deterministic `@cendor/guardrails` built-ins (`keywordDeny`, `regexRule`, `urlAllowlist`/`urlDeny`,
  `lengthBounds`, `jsonSchema`, `custom`, `llmJudge`) **plus** the acttrace-bridged detector
  guardrails `rules.pii` / `rules.secrets` / `rules.entropy` — PII/secret/high-entropy detection at
  every stage, including `tool_output` (which the process-global `guard()` never sees). Every
  trip/flag lands on `Result.guardrailDecisions` (and the audit chain). `Agent({ guardrailMode:
  'parallel' })` (or `run(agent, input, { guardrailMode })`) overlaps input-stage guardrails with the
  first model call for slow tier-3/4 input checks (a block still throws; no input redaction in that
  mode).
- **Orchestration** — `handoff`, `sequential`, `parallel`/`parallelAsync`, `supervisor`, multi-agent
  handoff teams (`run([entry, ...peers], input)`) on one correlated trace tree.
- **Memory** — `Session`, `SummarizingSession`, `llmSummarizer`, `MemorySessionStore`,
  `SqliteSessionStore` (better-sqlite3).
- **Retrieval** — `embed`/`aembed`, `VectorIndex`, `Hit`, always-on RAG via `Agent({ retriever })`.
- **Hardening** — `RetryPolicy` (only the successful attempt emits a call), `Checkpointer`-shaped state.
- **Eval** — `evaluate(agent, cases)` replaying cassettes (cost/tokens are the real recorded figures).
- **HITL** — `requireApproval` gate. **OTel** — `spanTree`/`liveSpans` (no-op without `@opentelemetry/api`).
- **Streaming** — `run.stream` / `run.astream` yielding `TextDelta`/`ToolCallEvent`/`ToolResultEvent`/
  `RunComplete`.
- **Full agent-loop surface** — live `onStep` progress hook (a thrown hook never breaks a run),
  Anthropic prompt caching (`Agent({ cache: true })`), multi-agent streaming with streamed
  checkpoints, bounded re-ask on an output trip (`reaskOnOutputTrip`), partial-output stream checks
  (`streamCheckWindow`), `Result.conversationId` from a keyed session, and six `cendor.sdk` telemetry
  domains on the live OTel path (RAG · memory · orchestration · checkpoints · tools · MCP).
- **Interop** — MCP client (`loadMcpTools`/`loadMcpPrompts`/`getMcpPrompt`/`loadMcpResources`), A2A
  server + client (`A2AServer`/`A2AClient`/`serve`), a Foundry / Bot Framework adapter
  (`FoundryAdapter`), and durable resumable runs (`Checkpointer`).
- **Context assembly** — `Agent({ contextBudget })` packs each turn to a token budget via
  `@cendor/contextkit`.

## Honest limits

- **PII redaction is regex/pattern-based** — no Presidio NER (that's the Python-only `[ner]` extra),
  so recall is lower on unstructured names/addresses.
- **Embeddings governance is OpenAI-family only** — `embed()` / `aembed()` capture the OpenAI
  embeddings client for pre-flight budgeting; other providers surface documented guidance instead.
- **Gemini / Bedrock / OpenAI-Responses stream one whole-response delta** — not true token-by-token
  streaming (same honest limit as the Python SDK).

## Parity

Field names map `snake_case` (Python) → `camelCase`; type and error names are identical
(`BudgetExceeded`, `PolicyViolation`, `Agent`, `RetryPolicy`, …). See the
[API parity rules](https://github.com/cendorhq/cendor-libs/blob/main/docs/specs/api-parity.md).

## Install

```bash
npm i @cendor/sdk openai              # + @anthropic-ai/sdk for Claude
```

Using an AI coding assistant? `npx @cendor/init` (TS) / `uvx cendor-init` (Python) wires it up — or point it at [cendor.ai/docs/for-ai-assistants](https://cendor.ai/docs/for-ai-assistants).

`openai` / `@anthropic-ai/sdk` / `@opentelemetry/api` are optional peers; `better-sqlite3` is optional.
