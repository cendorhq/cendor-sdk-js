<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/cendor-sdk-js-banner-dark.png">
    <img alt="cendor-sdk-js" src=".github/assets/cendor-sdk-js-banner-light.png" width="820">
  </picture>
</p>

# cendor-sdk-js

**A governed agent in ~10 lines** — the TypeScript/JavaScript port of
[`cendor-sdk`](https://github.com/cendorhq/cendor-sdk). A thin, model-agnostic agent SDK where
governance (budgets, tamper-evident audit, PII redaction, record/replay) is the *foundation*, not a
plugin. ESM-only. Local-first. Apache-2.0.

[![npm: @cendor/sdk](https://img.shields.io/npm/v/@cendor/sdk.svg?label=%40cendor%2Fsdk)](https://www.npmjs.com/package/@cendor/sdk) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

```ts
import OpenAI from 'openai';
import { Agent, run, tool, withBudget, AuditLog, verify } from '@cendor/sdk';
import { z } from 'zod';

const refund = tool((a: { orderId: string }) => `refunded ${a.orderId}`, {
  name: 'refund',
  description: 'Issue a refund',
  parameters: z.object({ orderId: z.string() }),
});

const audit = new AuditLog('refund-bot', { riskTier: 'high', path: 'audit.jsonl' });
const agent = new Agent({ name: 'refund-bot', model: 'gpt-4o', tools: [refund], client: new OpenAI() });

const result = await withBudget({ usd: 0.5, onExceed: 'block' }, () =>
  run(agent, 'refund order #123', { audit }),
);
console.log(result.output, result.cost?.toString());
```

## What it is

- **Model-agnostic** — provider inferred from the model id; OpenAI (Chat + Responses), Anthropic,
  Google Gemini, AWS Bedrock, Ollama, Hugging Face, and Azure AI Foundry (+ Foundry Local) are all
  ported behind one `Provider` seam. (Token/cost capture for HF/Ollama/Gemini/Bedrock activates with
  a matching `@cendor/core` detection release; Azure/Foundry Local capture today.)
- **Governed by default, escapable** — a bare `run()` works on `@cendor/core` alone; every governance
  layer (`budget`, `guard`, `audit`, cassette replay) is optional and rides core's bus/interceptor
  seams. The re-exported `budget`/`guard`/`AuditLog`/… are the *real* `@cendor/*` library objects.
- **Tools via zod** — `tool(fn, { parameters: z.object({...}) })`; schemas convert to each provider's
  native tool shape.
- **Parity with the Python SDK's v1.1 features** — live progress hooks (`onStep`), Anthropic prompt
  caching (`cache: true`), multi-agent streaming, live OTel spans, and MCP / A2A / Foundry interop.

Hard-depends only on `@cendor/core`; the other `@cendor/*` libraries integrate through core's seams.
Cross-language parity with the Python SDK follows the
[API parity rules](https://github.com/cendorhq/cendor-libs/blob/main/docs/specs/api-parity.md).

## Develop

```bash
pnpm install   # resolves @cendor/* from npm
pnpm build
pnpm test      # no network — real openai/@anthropic-ai SDKs against undici MockAgent + stub clients
```
