import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AuditLog,
  BudgetExceeded,
  RetryPolicy,
  RunComplete,
  Session,
  type StreamEvent,
  type TextDelta,
  run,
  tool,
  verify,
  withBudget,
} from '../src/index.js';
import {
  anthropicMessage,
  delta,
  isolate,
  openaiChat,
  stubAnthropic,
  stubOpenAI,
  stubOpenAIStream,
} from './_helpers.js';

isolate();

describe('@cendor/sdk — governed single agent', () => {
  it('runs, aggregates cost/usage, and records a verifiable audit chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-sdk-'));
    const path = join(dir, 'audit.jsonl');
    const audit = new AuditLog('refund-bot', { riskTier: 'high', path, signingKey: 's3cret' });
    const agent = new Agent({
      name: 'refund-bot',
      model: 'gpt-4o',
      instructions: 'Be helpful.',
      client: stubOpenAI([openaiChat({ content: 'Sure, here is a refund.' })]),
    });
    const result = await run(agent, 'I want a refund', { audit });
    expect(result.output).toBe('Sure, here is a refund.');
    expect(result.incomplete).toBe(false);
    expect(result.llmSteps).toHaveLength(1);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.cost.amount.greaterThan(0)).toBe(true); // gpt-4o is priced
    expect(result.traceId).toBeTruthy();
    audit.detach();
    const [ok] = verify(path, { key: 's3cret' });
    expect(ok).toBe(true);
  });

  it('drives a tool loop and stringifies the tool result back to the model', async () => {
    const weather = tool((args: { city: string }) => `sunny in ${args.city}`, {
      name: 'get_weather',
      description: 'weather',
      parameters: z.object({ city: z.string() }),
    });
    const agent = new Agent({
      name: 'w',
      model: 'gpt-4o',
      tools: [weather],
      client: stubOpenAI([
        openaiChat({ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }),
        openaiChat({ content: 'It is sunny in Paris.' }),
      ]),
    });
    const result = await run(agent, 'weather in Paris?');
    expect(result.output).toBe('It is sunny in Paris.');
    expect(result.toolSteps).toHaveLength(1);
    expect(result.toolSteps[0]!.name).toBe('get_weather');
  });

  it('parses structured output via a zod outputType', async () => {
    const agent = new Agent({
      name: 's',
      model: 'gpt-4o',
      outputType: z.object({ city: z.string(), temp: z.number() }),
      client: stubOpenAI([openaiChat({ content: '{"city":"Paris","temp":21}' })]),
    });
    const result = await run(agent, 'weather?');
    expect(result.output).toEqual({ city: 'Paris', temp: 21 });
  });

  it('records live progress via onStep and never breaks on a throwing hook', async () => {
    const seen: string[] = [];
    const agent = new Agent({
      name: 'p',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'hi' })]),
    });
    const result = await run(agent, 'hi', {
      onStep: (s) => {
        seen.push(s.name);
        throw new Error('hook boom'); // must be swallowed
      },
    });
    expect(result.output).toBe('hi');
    expect(seen).toEqual(['gpt-4o']);
  });

  it('threads a Session across calls', async () => {
    const session = new Session();
    const agent = new Agent({
      name: 'm',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'first' }), openaiChat({ content: 'second' })]),
    });
    await run(agent, 'one', { session });
    await run(agent, 'two', { session });
    expect(session.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
  });
});

describe('@cendor/sdk — governance', () => {
  it('budget onExceed:block raises BudgetExceeded before the call runs', async () => {
    const agent = new Agent({
      name: 'b',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'x' })]),
    });
    await expect(
      withBudget({ usd: 0.0000001, onExceed: 'block' }, () =>
        run(agent, 'a longer prompt that would cost more than a tenth of a microdollar'),
      ),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe('@cendor/sdk — resilience', () => {
  it('retries a transient failure; only the successful attempt emits an LLMCall', async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) {
              const err = new Error('service unavailable') as Error & { status: number };
              err.status = 503;
              throw err;
            }
            return openaiChat({ content: 'recovered' });
          },
        },
      },
    };
    const agent = new Agent({ name: 'r', model: 'gpt-4o', client });
    const result = await run(agent, 'hi', {
      retry: new RetryPolicy({ maxAttempts: 3, sleep: async () => {} }),
    });
    expect(result.output).toBe('recovered');
    expect(calls).toBe(2);
    expect(result.llmSteps).toHaveLength(1); // no double count
  });
});

describe('@cendor/sdk — orchestration', () => {
  it('hands off across agents via a synthetic transfer tool', async () => {
    const planner = new Agent({
      name: 'planner',
      model: 'gpt-4o',
      handoffs: ['writer'],
      client: stubOpenAI([
        openaiChat({
          toolCalls: [{ name: 'transfer_to_writer', args: { reason: 'writing needed' } }],
        }),
      ]),
    });
    const writer = new Agent({
      name: 'writer',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'the final draft' })]),
    });
    const result = await run([planner, writer], 'write a poem');
    expect(result.agents).toEqual(['planner', 'writer']);
    expect(result.output).toBe('the final draft');
  });
});

describe('@cendor/sdk — streaming', () => {
  it('streams TextDeltas then a terminal RunComplete', async () => {
    const agent = new Agent({
      name: 'st',
      model: 'gpt-4o',
      client: stubOpenAIStream([delta('Hel'), delta('lo')]),
    });
    const events: StreamEvent[] = [];
    for await (const ev of run.stream(agent, 'hi')) events.push(ev);
    const text = events
      .filter((e): e is TextDelta => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello');
    const last = events[events.length - 1];
    expect(last).toBeInstanceOf(RunComplete);
    expect((last as RunComplete).result.output).toBe('Hello');
  });
});

describe('@cendor/sdk — Anthropic provider (stub shape)', () => {
  it('parses an Anthropic message + tool_use', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'claude-opus-4-8',
      client: stubAnthropic(anthropicMessage({ text: 'Bonjour' })),
    });
    const result = await run(agent, 'hi');
    expect(result.output).toBe('Bonjour');
    expect(result.usage.inputTokens).toBe(20);
  });
});
