# cendor-sdk-js

**A governed agent in ~10 lines** — the TypeScript/JavaScript port of
[`cendor-sdk`](https://github.com/cendorhq/cendor-sdk). A thin, model-agnostic agent SDK where
governance (budgets, tamper-evident audit, PII redaction, record/replay) is the *foundation*, not a
plugin. ESM-only. Local-first. Apache-2.0.

```ts
import { Agent, run, tool, withBudget, AuditLog, verify } from '@cendor/sdk';

const audit = new AuditLog('refund-bot', { riskTier: 'high', path: 'audit.jsonl' });
const agent = new Agent({ name: 'refund-bot', model: 'gpt-4o', tools: [refundTool] });

const result = await withBudget({ usd: 0.5, onExceed: 'block' }, () =>
  run(agent, 'I want a refund for order #123', { audit }),
);
console.log(result.output, result.cost?.toString());
```

## What it is

- **Model-agnostic** — provider inferred from the model id; OpenAI (Chat + Responses) and Anthropic
  ship first, with the same `Provider` seam for Gemini/Bedrock/Ollama/HF/Azure/Foundry.
- **Governed by default, escapable** — a bare `run()` works on `@cendor/core` alone; every governance
  layer (`budget`, `guard`, `audit`, cassette replay) is optional and rides core's bus/interceptor
  seams. The re-exported `budget`/`guard`/`AuditLog`/… are the *real* `@cendor/*` library objects.
- **Tools via zod** — `tool(fn, { parameters: z.object({...}) })`; schemas convert to each provider's
  native tool shape.
- **v1.1 surface** — live progress hooks (`onStep`), Anthropic prompt caching (`cache: true`),
  multi-agent streaming, and live OTel spans.

Hard-depends only on `@cendor/core`; the other `@cendor/*` libraries integrate through core's seams.
Cross-language parity with the Python SDK follows the
[API parity rules](https://github.com/cendorhq/cendor-libs/blob/main/docs/specs/api-parity.md).

## Develop

```bash
pnpm install   # resolves @cendor/* from npm
pnpm build
pnpm test      # no network — real openai/@anthropic-ai SDKs against undici MockAgent + stub clients
```
