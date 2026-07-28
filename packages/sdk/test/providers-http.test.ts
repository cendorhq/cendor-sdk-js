import {
  type Dispatcher,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici';
/**
 * Real-SDK wire tests: drive the genuine `openai` / `@anthropic-ai/sdk` clients through
 * `instrument()` + the runner, with HTTP mocked by undici's MockAgent (no network). This proves the
 * real SDKs parse the real response shapes — the TS mirror of the Python respx discipline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Route the real SDK clients' HTTP through undici's fetch, which uses the mocked global dispatcher.
const mockedFetch = undiciFetch as unknown as typeof fetch;
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { z } from 'zod';
import { Agent, run } from '../src/index.js';
import { anthropicMessage, isolate, openaiChat } from './_helpers.js';

isolate();

let original: Dispatcher;
let mockAgent: MockAgent;

beforeEach(() => {
  original = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});
afterEach(async () => {
  setGlobalDispatcher(original);
  await mockAgent.close();
});

describe('real OpenAI SDK over MockAgent', () => {
  it('parses a Chat Completions response through the runner', async () => {
    mockAgent
      .get('https://api.openai.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(
        200,
        openaiChat({
          content: 'Hello from OpenAI.',
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const client = new OpenAI({ apiKey: 'test-key', fetch: mockedFetch });
    const agent = new Agent({ name: 'oa', model: 'gpt-4o', client });
    const result = await run(agent, 'hi');
    expect(result.output).toBe('Hello from OpenAI.');
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.cost.amount.greaterThan(0)).toBe(true);
  });
});

describe('real Anthropic SDK over MockAgent', () => {
  it('parses a Messages response through the runner', async () => {
    mockAgent
      .get('https://api.anthropic.com')
      .intercept({ path: '/v1/messages', method: 'POST' })
      .reply(
        200,
        anthropicMessage({
          text: 'Hello from Claude.',
          usage: { input_tokens: 40, output_tokens: 12 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const client = new Anthropic({ apiKey: 'test-key', fetch: mockedFetch });
    const agent = new Agent({ name: 'an', model: 'claude-opus-4-8', client });
    const result = await run(agent, 'hi');
    expect(result.output).toBe('Hello from Claude.');
    expect(result.usage.inputTokens).toBe(40);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.cost.amount.greaterThan(0)).toBe(true);
  });
});

describe('real @google/genai SDK over MockAgent', () => {
  it('never puts additionalProperties on the wire for an outputType', async () => {
    // @google/genai DOES strip camelCase `additionalProperties` client-side — but only while
    // recursing `properties` / `items` / `anyOf`. A `prefixItems` subtree (a zod tuple) is copied
    // VERBATIM, so an unsanitized schema leaks the key the Gemini Developer API 400s on. Proven at
    // the wire, not at our own boundary: the client is a different codebase from google-genai.
    let body: unknown;
    mockAgent
      .get('https://generativelanguage.googleapis.com')
      .intercept({ path: (p: string) => p.includes(':generateContent'), method: 'POST' })
      .reply(200, (opts: { body?: string | null }) => {
        body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
        return {
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text: '{"tup":[{"t":"x"}]}' }] } },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        };
      });

    const client = new GoogleGenAI({ apiKey: 'test-key' });
    const agent = new Agent({
      name: 'gm',
      model: 'gemini-3-pro-preview',
      client,
      outputType: z.object({ tup: z.tuple([z.object({ t: z.string() })]) }),
    });
    await run(agent, 'hi');

    const wire = JSON.stringify((body as { generationConfig?: unknown }).generationConfig ?? body);
    expect(wire, 'a prefixItems subtree reaches the wire unprocessed by @google/genai').toContain(
      'prefixItems',
    );
    expect(wire, 'additionalProperties reached the Gemini API').not.toContain(
      'additionalProperties',
    );
    expect(wire).not.toContain('additional_properties');
  });
});
