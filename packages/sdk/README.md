# @cendor/sdk

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
- **Providers** — OpenAI (Chat Completions + Responses) and Anthropic, driven through the real SDKs
  (`instrument()`ed); provider inferred from the model id. Others (Gemini/Bedrock/Ollama/HF/Azure/
  Foundry) are scaffolded behind the same `Provider` interface — they throw a clear error until
  ported; use OpenAI/Anthropic or pass a pre-built `client`.
- **Tools via zod** — `tool(fn, { parameters: z.object({...}) })` → each provider's native tool shape.
- **Governance** (re-exported real libraries) — `budget`/`withBudget`, `track`, `report`, `guard`,
  `AuditLog`/`verify`, `registerModelPrice`, `BudgetExceeded`. A bare `run()` needs none of it.
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
- **v1.1** — live `onStep` progress hook (a thrown hook never breaks a run), Anthropic prompt caching
  (`Agent({ cache: true })`), multi-agent streaming.

## Deferred (tracked; not yet in this port)

- MCP / A2A / Foundry interop adapters.
- Native token-level streaming delivery (events are currently sequenced then yielded).
- `contextBudget` context assembly (the loop passes messages through; `@cendor/contextkit` is fully
  ported and can be used directly).
- Providers beyond OpenAI + Anthropic (scaffolded, not implemented).

## Parity

Field names map `snake_case` (Python) → `camelCase`; type and error names are identical
(`BudgetExceeded`, `PolicyViolation`, `Agent`, `RetryPolicy`, …). See the
[API parity rules](https://github.com/cendorhq/cendor-libs/blob/main/docs/specs/api-parity.md).

## Install

```bash
npm i @cendor/sdk openai              # + @anthropic-ai/sdk for Claude
```
`openai` / `@anthropic-ai/sdk` / `@opentelemetry/api` are optional peers; `better-sqlite3` is optional.
