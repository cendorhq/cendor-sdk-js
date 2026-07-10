# @cendor/sdk

[![npm version](https://img.shields.io/npm/v/@cendor/sdk.svg)](https://www.npmjs.com/package/@cendor/sdk) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Build an LLM agent with spending limits, a tamper-evident audit trail, PII redaction, and record/replay testing built in from the start** — a governed agent in about 10 lines. The TypeScript port of [`cendor-sdk`](https://github.com/cendorhq/cendor-sdk); governance is the foundation, not a plugin. Hard-depends only on `@cendor/core`; the other `@cendor/*` libraries integrate through core's bus/interceptor seams.

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

## What's implemented

- **Agent loop** — `run(agent, input, opts)` (async), tool calling, `maxTurns`, structured output
  (`outputType` as a zod schema or JSON-schema object), `Result`/`Step` with aggregate `usage`/`cost`.
- **Providers** — OpenAI (Chat Completions + Responses), Anthropic, Google Gemini, AWS Bedrock,
  Ollama, Hugging Face, and Azure AI Foundry (chat + responses) + Foundry Local, driven through the
  real SDKs (`instrument()`ed); provider inferred from the model id, or pass a pre-built `client`.
  Token/cost capture for Hugging Face, Ollama, Gemini, and Bedrock activates once a `@cendor/core`
  release ships the matching `instrument()` detection; Azure AI Foundry and Foundry Local capture
  usage today (standard OpenAI client).
- **Tools via zod** — `tool(fn, { parameters: z.object({...}) })` → each provider's native tool shape.
- **Governance** (re-exported real libraries) — `budget`/`withBudget`, `track`, `report`, `guard`,
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
- **Parity with the Python SDK's v1.1 features** — live `onStep` progress hook (a thrown hook never
  breaks a run), Anthropic prompt caching (`Agent({ cache: true })`), multi-agent streaming.
- **Interop** — MCP client (`loadMcpTools`/`loadMcpPrompts`/`getMcpPrompt`/`loadMcpResources`), A2A
  server + client (`A2AServer`/`A2AClient`/`serve`), a Foundry / Bot Framework adapter
  (`FoundryAdapter`), and durable resumable runs (`Checkpointer`).
- **Context assembly** — `Agent({ contextBudget })` packs each turn to a token budget via
  `@cendor/contextkit`.

## Honest limits

- End-to-end token/cost capture for Hugging Face, Ollama, Gemini, and Bedrock activates once a
  `@cendor/core` release ships the matching `instrument()` detection and this package bumps its
  dependency. Azure AI Foundry and Foundry Local capture usage today (standard OpenAI client).

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
