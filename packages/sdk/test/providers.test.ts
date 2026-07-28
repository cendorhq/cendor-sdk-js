/**
 * Provider response normalization — the TS port of `tests/test_providers.py`. Pure unit tests over
 * plain-object fixtures for every provider shape (parse / buildKwargs / translators), so response-shape
 * drift is caught here in isolation, independent of the wire tests in `providers-http.test.ts`.
 */
import { LLMCall, bus, instrument, prices } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { registerModelPrice } from '../src/index.js';
import {
  AnthropicProvider,
  AzureFoundryProvider,
  AzureFoundryResponsesProvider,
  BedrockProvider,
  FoundryLocalProvider,
  GeminiProvider,
  HuggingFaceProvider,
  OllamaProvider,
  OpenAIChatProvider,
  OpenAIResponsesProvider,
  assistantMessage,
  azureFoundryBaseUrl,
  canonicalToAnthropic,
  canonicalToBedrock,
  canonicalToGemini,
  foundryLocalBaseUrl,
  getProvider,
  inferProvider,
  resolveProvider,
  toolResultMessage,
} from '../src/providers.js';
import { tool } from '../src/tools.js';
import type { Message } from '../src/types.js';
import { bedrockResponse, geminiResponse, ollamaResponse, openaiChat } from './_helpers.js';

// createPath is a protected field; read it structurally for the registry/createPath assertions.
const createPathOf = (p: unknown): string[] => (p as { createPath: string[] }).createPath;

// --------------------------------------------------------------------------- parse (all providers)

describe('response normalization', () => {
  it('OpenAI chat — text', () => {
    const parsed = new OpenAIChatProvider().parse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }],
    });
    expect(parsed.content).toBe('Hi');
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.finishReason).toBe('stop');
  });

  it('OpenAI chat — tool calls', () => {
    const parsed = new OpenAIChatProvider().parse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'search', arguments: '{"q": "cats"}' },
              },
            ],
          },
        },
      ],
    });
    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    const tc = parsed.toolCalls[0]!;
    expect([tc.id, tc.name, tc.arguments]).toEqual(['call_9', 'search', { q: 'cats' }]);
  });

  it('OpenAI responses', () => {
    const parsed = new OpenAIResponsesProvider().parse({
      status: 'completed',
      output_text: 'The answer.',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'The answer.' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'lookup', arguments: '{"x": 1}' },
      ],
    });
    expect(parsed.content).toBe('The answer.');
    expect(parsed.toolCalls[0]!.name).toBe('lookup');
    expect(parsed.toolCalls[0]!.arguments).toEqual({ x: 1 });
  });

  it('Anthropic', () => {
    const parsed = new AnthropicProvider().parse({
      content: [
        { type: 'text', text: 'Let me check. ' },
        { type: 'tool_use', id: 'toolu_2', name: 'weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
    });
    expect(parsed.content).toBe('Let me check. ');
    expect(parsed.toolCalls[0]!.id).toBe('toolu_2');
    expect(parsed.toolCalls[0]!.arguments).toEqual({ city: 'Paris' });
    expect(parsed.finishReason).toBe('tool_use');
  });

  it('Gemini', () => {
    const parsed = new GeminiProvider().parse(
      geminiResponse({ text: 'Sunny', functionCall: { name: 'weather', args: { city: 'Paris' } } }),
    );
    expect(parsed.content ?? '').toContain('Sunny');
    expect(parsed.toolCalls[0]!.name).toBe('weather');
    expect(parsed.toolCalls[0]!.arguments).toEqual({ city: 'Paris' });
  });

  it('Bedrock', () => {
    const parsed = new BedrockProvider().parse(
      bedrockResponse({
        text: 'Sunny.',
        toolUse: { id: 'tu_1', name: 'weather', input: { city: 'Paris' } },
        stopReason: 'tool_use',
      }),
    );
    expect(parsed.content).toBe('Sunny.');
    expect(parsed.toolCalls[0]!.id).toBe('tu_1');
    expect(parsed.finishReason).toBe('tool_use');
  });

  it('Ollama', () => {
    const parsed = new OllamaProvider().parse(
      ollamaResponse({
        content: 'Hi',
        toolCalls: [{ name: 'weather', arguments: { city: 'Paris' } }],
        done: true,
        doneReason: 'stop',
      }),
    );
    expect(parsed.content).toBe('Hi');
    expect(parsed.toolCalls[0]!.name).toBe('weather');
    expect(parsed.finishReason).toBe('stop');
  });

  it('HuggingFace reuses the OpenAI chat shape', () => {
    // HF chatCompletion returns the OpenAI Chat shape; the HF provider parses it identically.
    const parsed = new HuggingFaceProvider().parse(
      openaiChat({
        content: 'Hi from HF',
        toolCalls: [{ id: 'call_hf', name: 'weather', args: { city: 'Paris' } }],
      }),
    );
    expect(parsed.content).toBe('Hi from HF');
    expect(parsed.finishReason).toBe('tool_calls');
    expect(parsed.toolCalls[0]!.name).toBe('weather');
    expect(parsed.toolCalls[0]!.arguments).toEqual({ city: 'Paris' });
  });

  it('azure_responses reuses the Responses parse', () => {
    const parsed = new AzureFoundryResponsesProvider().parse({
      status: 'completed',
      output_text: 'Done.',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
        { type: 'function_call', call_id: 'fc_9', name: 'lookup', arguments: '{"a": 2}' },
      ],
    });
    expect(parsed.content).toBe('Done.');
    expect(parsed.toolCalls[0]!.name).toBe('lookup');
    expect(parsed.toolCalls[0]!.arguments).toEqual({ a: 2 });
  });
});

// End-to-end usage capture for HF: `@cendor/core` (≥ 0.3.0; this package pins ^0.12.0) duck-types the
// `InferenceClient.chatCompletion` method and attributes the LLMCall to `huggingface` (DR-1). Proven
// here against the *installed* core by instrumenting a chatCompletion-shaped stub and reading the bus.
describe('HF core detection', () => {
  it('cendor-core attributes the instrumented HF chatCompletion client to "huggingface"', async () => {
    const calls: LLMCall[] = [];
    const sub = (ev: unknown): void => {
      if (ev instanceof LLMCall) calls.push(ev);
    };
    bus.subscribe(sub);
    try {
      const client = instrument({
        chatCompletion: async (_params: unknown) =>
          openaiChat({ content: 'HF reply', usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      }) as { chatCompletion: (p: unknown) => Promise<unknown> };
      await client.chatCompletion({
        model: 'meta-llama/Meta-Llama-3-8B-Instruct',
        messages: [{ role: 'user', content: 'hi' }],
      });
    } finally {
      bus.unsubscribe(sub);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.provider).toBe('huggingface'); // core detects chatCompletion → HF, not openai
    expect(calls[0]!.usage?.inputTokens).toBe(11);
    expect(calls[0]!.usage?.outputTokens).toBe(7);
  });
});

// --------------------------------------------------------------------------- Azure / Foundry base-url

describe('Azure / Foundry base-url normalization', () => {
  it('normalizes Foundry endpoints', () => {
    expect(azureFoundryBaseUrl({ baseUrl: 'https://myres.openai.azure.com' })).toBe(
      'https://myres.openai.azure.com/openai/v1/',
    );
    expect(azureFoundryBaseUrl({ baseUrl: 'https://myres.services.ai.azure.com' })).toBe(
      'https://myres.services.ai.azure.com/openai/v1/',
    );
    expect(azureFoundryBaseUrl({ baseUrl: 'https://myres.openai.azure.com/openai/v1/' })).toBe(
      'https://myres.openai.azure.com/openai/v1/',
    );
    expect(azureFoundryBaseUrl({ baseUrl: 'https://myres.services.ai.azure.com/models' })).toBe(
      'https://myres.services.ai.azure.com/models/',
    );
  });

  it('reads the Azure endpoint from env', () => {
    const saved = {
      base: process.env.AZURE_OPENAI_BASE_URL,
      ai: process.env.AZURE_AI_ENDPOINT,
      ep: process.env.AZURE_OPENAI_ENDPOINT,
    };
    try {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset (assigning undefined coerces to the string "undefined")
      delete process.env.AZURE_OPENAI_BASE_URL;
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env.AZURE_AI_ENDPOINT;
      process.env.AZURE_OPENAI_ENDPOINT = 'https://envres.openai.azure.com';
      expect(azureFoundryBaseUrl({})).toBe('https://envres.openai.azure.com/openai/v1/');
      // biome-ignore lint/performance/noDelete: env vars must be truly unset
      delete process.env.AZURE_OPENAI_ENDPOINT;
      expect(azureFoundryBaseUrl({})).toBeNull();
    } finally {
      if (saved.base != null) process.env.AZURE_OPENAI_BASE_URL = saved.base;
      if (saved.ai != null) process.env.AZURE_AI_ENDPOINT = saved.ai;
      if (saved.ep != null) process.env.AZURE_OPENAI_ENDPOINT = saved.ep;
    }
  });

  it('normalizes Foundry Local endpoints', () => {
    expect(foundryLocalBaseUrl({ baseUrl: 'http://localhost:5273' })).toBe(
      'http://localhost:5273/v1/',
    );
    expect(foundryLocalBaseUrl({ baseUrl: 'http://localhost:5273/v1' })).toBe(
      'http://localhost:5273/v1/',
    );
  });

  it('Foundry Local requires an endpoint', () => {
    const saved = process.env.FOUNDRY_LOCAL_ENDPOINT;
    try {
      // biome-ignore lint/performance/noDelete: env vars must be truly unset (assigning undefined coerces to the string "undefined")
      delete process.env.FOUNDRY_LOCAL_ENDPOINT;
      expect(foundryLocalBaseUrl({})).toBeNull();
      // No endpoint anywhere → a clear, actionable error rather than silently hitting api.openai.com.
      expect(() => new FoundryLocalProvider().rawClient({})).toThrow(
        /Foundry Local needs an endpoint/,
      );
    } finally {
      if (saved != null) process.env.FOUNDRY_LOCAL_ENDPOINT = saved;
    }
  });
});

// --------------------------------------------------------------------------- registry + aliases

describe('registry', () => {
  it('registers the new providers and aliases', () => {
    expect(getProvider('huggingface')).toBeInstanceOf(HuggingFaceProvider);
    expect(getProvider('hf')).toBeInstanceOf(HuggingFaceProvider);
    expect(getProvider('azure')).toBeInstanceOf(AzureFoundryProvider);
    expect(getProvider('azure_openai')).toBeInstanceOf(AzureFoundryProvider);
    expect(getProvider('foundry')).toBeInstanceOf(AzureFoundryProvider);
    expect(getProvider('azure_responses')).toBeInstanceOf(AzureFoundryResponsesProvider);
    expect(getProvider('foundry_responses')).toBeInstanceOf(AzureFoundryResponsesProvider);
    expect(getProvider('foundry_local')).toBeInstanceOf(FoundryLocalProvider);
    expect(getProvider('foundry-local')).toBeInstanceOf(FoundryLocalProvider);
    // Chat-shape providers subclass the OpenAI Chat provider; the Responses variant the Responses one.
    expect(getProvider('huggingface')).toBeInstanceOf(OpenAIChatProvider);
    expect(getProvider('foundry_local')).toBeInstanceOf(OpenAIChatProvider);
    expect(getProvider('azure_responses')).toBeInstanceOf(OpenAIResponsesProvider);
    expect(getProvider('huggingface').name).toBe('huggingface');
    expect(getProvider('azure').name).toBe('azure');
    expect(getProvider('foundry_local').name).toBe('foundry_local');
    expect(getProvider('azure_responses').name).toBe('azure_responses');
    // HF binds to chatCompletion; Azure/Foundry-Local keep chat.completions.create; Responses keeps
    // responses.create.
    expect(createPathOf(getProvider('huggingface'))).toEqual(['chatCompletion']);
    expect(createPathOf(getProvider('azure'))).toEqual(['chat', 'completions', 'create']);
    expect(createPathOf(getProvider('foundry_local'))).toEqual(['chat', 'completions', 'create']);
    expect(createPathOf(getProvider('azure_responses'))).toEqual(['responses', 'create']);
  });

  it('infers and resolves providers', () => {
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('claude-opus-4-8')).toBe('anthropic');
    expect(inferProvider('gemini-2.0-flash')).toBe('google');
    expect(resolveProvider('gpt-4o').name).toBe('openai');
    expect(resolveProvider('anything', 'anthropic').name).toBe('anthropic');
    // HF ids and Foundry deployment names aren't prefix-inferable — they require an explicit provider=.
    expect(resolveProvider('meta-llama/Llama-3.1-8B-Instruct', 'huggingface').name).toBe(
      'huggingface',
    );
    expect(resolveProvider('my-gpt4o-deployment', 'azure').name).toBe('azure');
    expect(() => inferProvider('totally-unknown-model')).toThrow();
  });
});

// --------------------------------------------------------------------------- tool formatting

describe('tool formatting', () => {
  const search = tool(() => [], {
    name: 'search',
    description: 'Search the KB.',
    parameters: z.object({ query: z.string(), top_k: z.number().default(3) }),
  });

  it('formats per provider', () => {
    const openai = getProvider('openai').formatTools([search]) as { type: string }[];
    expect(openai[0]!.type).toBe('function');
    const anthropic = getProvider('anthropic').formatTools([search]) as { name: string }[];
    expect(anthropic[0]!.name).toBe('search');
    const gemini = getProvider('google').formatTools([search]) as {
      functionDeclarations: { name: string }[];
    }[];
    expect(gemini[0]!.functionDeclarations[0]!.name).toBe('search');
    const bedrock = getProvider('bedrock').formatTools([search]) as {
      tools: { toolSpec: { name: string } }[];
    };
    expect(bedrock.tools[0]!.toolSpec.name).toBe('search');
  });

  it('HuggingFace and Azure reuse the OpenAI function-tool shape', () => {
    const hf = getProvider('huggingface').formatTools([search]) as { type: string }[];
    expect(hf[0]!.type).toBe('function');
    const azure = getProvider('azure').formatTools([search]) as {
      function: { name: string };
    }[];
    expect(azure[0]!.function.name).toBe('search');
  });
});

// --------------------------------------------------------------------------- build_kwargs

describe('build_kwargs', () => {
  it('guards temperature for o-series models', () => {
    const p = new OpenAIChatProvider();
    expect('temperature' in p.buildKwargs('gpt-4o', [], [], '', { temperature: 0.5 })).toBe(true);
    expect('temperature' in p.buildKwargs('o3-mini', [], [], '', { temperature: 0.5 })).toBe(false);
    expect('temperature' in p.buildKwargs('o1', [], [], '', { temperature: 0.5 })).toBe(false);
  });

  it('OpenAI output_schema uses native json_schema', () => {
    const p = new OpenAIChatProvider();
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const k = p.buildKwargs('gpt-4o', [], [], '', { jsonMode: true, outputSchema: schema }) as {
      response_format: { type: string; json_schema: { schema: unknown } };
    };
    expect(k.response_format.type).toBe('json_schema');
    expect(k.response_format.json_schema.schema).toEqual(schema);
    const k2 = p.buildKwargs('gpt-4o', [], [], '', { jsonMode: true });
    expect(k2.response_format).toEqual({ type: 'json_object' });
  });

  it('Ollama and Gemini native structured output', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const ok = new OllamaProvider().buildKwargs('llama3.1', [], [], '', {
      jsonMode: true,
      outputSchema: schema,
    });
    expect(ok.format).toEqual(schema); // Ollama takes the schema as its format constraint
    const gk = new GeminiProvider().buildKwargs('gemini-2.0-flash', [], [], '', {
      jsonMode: true,
      outputSchema: schema,
    }) as { config: { responseMimeType: string; responseSchema: unknown } };
    expect(gk.config.responseMimeType).toBe('application/json');
    expect(gk.config.responseSchema).toEqual(schema);
  });

  it('Gemini/Bedrock build_kwargs carry the tool history (P0 regression)', () => {
    const hist = toolHistory();
    const gk = new GeminiProvider().buildKwargs('gemini-2.0-flash', hist, [], '', {});
    const gContents = JSON.stringify(gk.contents);
    expect(gContents).toContain('functionCall');
    expect(gContents).toContain('Sunny');
    const bk = new BedrockProvider().buildKwargs('meta.llama', hist, [], '', {});
    const bMessages = JSON.stringify(bk.messages);
    expect(bMessages).toContain('toolUse');
    expect(bMessages).toContain('Sunny');
  });

  it('Ollama re-hydrates tool-call arguments to an object (FINDINGS 2026-07-18 B4)', () => {
    // Canonical history stores function.arguments as a JSON string; the ollama client rejects a
    // string ("Value looks like object, but can't find closing '}' symbol") and 400s the replay turn.
    const ok = new OllamaProvider().buildKwargs('llama3.2', toolHistory(), [], '', {}) as {
      messages: { role: string; tool_calls?: { function: { arguments: unknown } }[] }[];
    };
    const asst = ok.messages.find((m) => m.role === 'assistant')!;
    const args = asst.tool_calls![0]!.function.arguments;
    expect(typeof args).toBe('object');
    expect(args).toEqual({ city: 'Paris' });
  });
});

// --------------------------------------------------------------------------- translators

function toolHistory(): Message[] {
  return [
    { role: 'user', content: 'weather in Paris?' },
    assistantMessage(null, [{ id: 'tc1', name: 'get_weather', arguments: { city: 'Paris' } }]),
    toolResultMessage('tc1', 'get_weather', 'Sunny, 24C'),
  ];
}

describe('canonical → provider translators', () => {
  it('Anthropic tool round-trip', () => {
    const wire = canonicalToAnthropic([
      { role: 'user', content: 'weather?' },
      assistantMessage(null, [{ id: 'tu_1', name: 'weather', arguments: { city: 'Paris' } }]),
      toolResultMessage('tu_1', 'weather', 'Sunny in Paris'),
    ]);
    expect(wire[0]).toEqual({ role: 'user', content: 'weather?' });
    expect(wire[1]!.role).toBe('assistant');
    expect(
      (wire[1]!.content as { type: string; name?: string }[]).some(
        (b) => b.type === 'tool_use' && b.name === 'weather',
      ),
    ).toBe(true);
    expect(wire[2]!.role).toBe('user');
    const results = wire[2]!.content as { type: string; tool_use_id: string }[];
    expect(results[0]!.type).toBe('tool_result');
    expect(results[0]!.tool_use_id).toBe('tu_1');
  });

  it('Gemini tool round-trip', () => {
    const contents = canonicalToGemini(toolHistory());
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'weather in Paris?' }] });
    const modelTurn = contents[1]!;
    expect(modelTurn.role).toBe('model');
    const fc = (modelTurn.parts as { functionCall?: { name: string; args: unknown } }[]).find(
      (p) => p.functionCall,
    )!.functionCall!;
    expect(fc.name).toBe('get_weather');
    expect(fc.args).toEqual({ city: 'Paris' });
    const respTurn = contents[2]!;
    expect(respTurn.role).toBe('user');
    const fr = (
      respTurn.parts as { functionResponse?: { name: string; response: { result: string } } }[]
    ).find((p) => p.functionResponse)!.functionResponse!;
    expect(fr.name).toBe('get_weather');
    expect(fr.response.result).toContain('Sunny');
  });

  it('Gemini round-trips the thought signature (FINDINGS 2026-07-19 B7)', () => {
    // gemini-3.x returns a thoughtSignature sibling of functionCall that must be echoed back on the
    // replayed call, else turn 2 400s ("missing thought_signature"). parse() must capture it and
    // canonicalToGemini() must re-emit it.
    const resp = {
      candidates: [
        {
          finish_reason: 'STOP',
          content: {
            parts: [
              {
                functionCall: { name: 'get_weather', args: { city: 'Paris' } },
                thoughtSignature: 'SIG123',
              },
            ],
          },
        },
      ],
    };
    const parsed = new GeminiProvider().parse(resp);
    expect(parsed.toolCalls[0]!.thoughtSignature).toBe('SIG123');
    // thread it through canonical history and confirm the sibling is re-emitted
    const hist = [assistantMessage(null, parsed.toolCalls)];
    const parts = canonicalToGemini(hist)[0]!.parts as { thoughtSignature?: unknown }[];
    expect(parts.find((p) => p.thoughtSignature)?.thoughtSignature).toBe('SIG123');
  });

  it('Gemini 3: a foreign, unsigned functionCall is replayed as text, never fabricated', () => {
    // Cross-provider handoff INTO a gemini agent: the receiving agent replays the *supervisor's*
    // history. An OpenAI supervisor's `transfer_to_*` call never carried a thoughtSignature — and
    // gemini-3.x 400s on a replayed functionCall that has none. No honest signature exists for a
    // call another provider made, so the turn goes back as text instead.
    const hist: Message[] = [
      { role: 'user', content: 'refund my order 42' },
      assistantMessage(null, [
        { id: 'call_9xKq3', name: 'transfer_to_research', arguments: { topic: 'refund policy' } },
      ]),
      toolResultMessage('call_9xKq3', 'transfer_to_research', 'transferred to research'),
    ];
    const wire = JSON.stringify(
      new GeminiProvider().buildKwargs('gemini-3-pro-preview', hist, [], '', {}).contents,
    );
    expect(wire, 'an unsigned foreign functionCall still reaches gemini-3').not.toContain(
      'functionCall',
    );
    expect(wire, 'the orphaned functionResponse still reaches gemini-3').not.toContain(
      'functionResponse',
    );
    expect(wire, 'a signature was fabricated').not.toContain('thoughtSignature');
    // the information survives — as text the API always accepts
    expect(wire).toContain('transfer_to_research');
    expect(wire).toContain('refund policy');
    expect(wire).toContain('transferred to research');
    // older families never validated signatures — their payload must be untouched
    expect(
      JSON.stringify(
        new GeminiProvider().buildKwargs('gemini-2.0-flash', hist, [], '', {}).contents,
      ),
    ).toContain('functionCall');
  });

  it("Gemini 3: the model's OWN signed tool turn is still replayed verbatim", () => {
    const parsed = new GeminiProvider().parse({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'get_weather', args: { city: 'Paris' } },
                thoughtSignature: 'SIG123',
              },
              { functionCall: { name: 'get_time', args: { city: 'Paris' } } }, // parallel: unsigned
            ],
          },
        },
      ],
    });
    const hist: Message[] = [
      assistantMessage(null, parsed.toolCalls),
      toolResultMessage(parsed.toolCalls[0]!.id, 'get_weather', 'Sunny in Paris'),
    ];
    const wire = JSON.stringify(
      new GeminiProvider().buildKwargs('gemini-3-pro-preview', hist, [], '', {}).contents,
    );
    expect(wire).toContain('SIG123');
    expect(wire).toContain('functionCall');
    expect(wire).toContain('get_time'); // a partially-signed parallel turn is Gemini's own — verbatim
    expect(wire).toContain('functionResponse');
  });

  it('Bedrock tool round-trip', () => {
    const wire = canonicalToBedrock(toolHistory());
    expect(wire[0]).toEqual({ role: 'user', content: [{ text: 'weather in Paris?' }] });
    const assistant = wire[1]!;
    expect(assistant.role).toBe('assistant');
    const tu = (
      assistant.content as { toolUse?: { toolUseId: string; name: string; input: unknown } }[]
    ).find((b) => b.toolUse)!.toolUse!;
    expect([tu.toolUseId, tu.name, tu.input]).toEqual(['tc1', 'get_weather', { city: 'Paris' }]);
    const result = wire[2]!;
    expect(result.role).toBe('user');
    const tr = (
      result.content as { toolResult?: { toolUseId: string; content: { text: string }[] } }[]
    ).find((b) => b.toolResult)!.toolResult!;
    expect(tr.toolUseId).toBe('tc1');
    expect(tr.content[0]!.text).toContain('Sunny');
  });
});

// --------------------------------------------------------------------------- multimodal

describe('multimodal content translation', () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  const msg: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      ],
    },
  ];

  it('maps to each provider image block', () => {
    // Anthropic: text block + base64 image + url image.
    const blocks = canonicalToAnthropic(msg)[0]!.content as {
      type: string;
      text?: string;
      source?: { type: string; media_type?: string; data?: string };
    }[];
    expect(blocks).toContainEqual({ type: 'text', text: 'what is this?' });
    expect(
      blocks.some(
        (b) =>
          b.type === 'image' &&
          b.source?.type === 'base64' &&
          b.source.media_type === 'image/png' &&
          b.source.data === 'QUJD',
      ),
    ).toBe(true);
    expect(blocks.some((b) => b.type === 'image' && b.source?.type === 'url')).toBe(true);
    // Gemini: text part + inlineData + fileData (camelCase — @google/genai drops snake_case).
    const parts = canonicalToGemini(msg)[0]!.parts as {
      text?: string;
      inlineData?: { mimeType: string };
      fileData?: unknown;
    }[];
    expect(parts).toContainEqual({ text: 'what is this?' });
    expect(parts.some((p) => p.inlineData && p.inlineData.mimeType === 'image/png')).toBe(true);
    expect(parts.some((p) => p.fileData)).toBe(true);
    // Bedrock: text kept (image bytes out of scope there).
    const bContent = canonicalToBedrock(msg)[0]!.content as { text: string }[];
    expect(bContent[0]!.text).toBe('what is this?');
  });

  it('OpenAI passes multimodal content through unchanged', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'https://x' } },
    ];
    const k = new OpenAIChatProvider().buildKwargs(
      'gpt-4o',
      [{ role: 'user', content }],
      [],
      '',
      {},
    );
    const wire = k.messages as Message[];
    expect(wire[wire.length - 1]!.content).toEqual(content);
  });
});

// --------------------------------------------------------------------------- tool schema + pricing

describe('tool schema and pricing', () => {
  it('expands a nested object parameter into an object schema', () => {
    const register = tool(() => 'ok', {
      name: 'register',
      description: 'Register a user.',
      parameters: z.object({
        name: z.string(),
        address: z.object({ city: z.string(), postcode: z.string() }),
      }),
    });
    const addr = (
      register.parameters.properties as Record<
        string,
        { type: string; properties: object; required: string[] }
      >
    ).address;
    expect(addr.type).toBe('object');
    expect(new Set(Object.keys(addr.properties))).toEqual(new Set(['city', 'postcode']));
    expect(new Set(addr.required)).toEqual(new Set(['city', 'postcode']));
  });

  it('never emits an empty parameter schema for a non-empty zod 4 schema', () => {
    const t = tool(() => 'ok', {
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ query: z.string(), top_k: z.number().default(3) }),
    });
    const props = t.parameters.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['query', 'top_k']); // regression: SDK ≤0.10 silently emitted {}
    expect(t.parameters.additionalProperties).toBe(false);
    // `.default()` params describe model *input* → stay optional, not forced into `required`.
    expect(t.parameters.required).toEqual(['query']);
  });

  it('rejects a zod 3 schema loudly instead of silently emitting an empty schema', () => {
    const v3schema = z3.object({ city: z3.string() });
    expect(() =>
      // zod 3 schema deliberately passed where a zod 4 schema is required (compile-rejected too).
      tool(() => 'ok', { name: 'weather', parameters: v3schema as never }),
    ).toThrow(/zod 4/);
  });

  it('a registered price makes an unpriced deployment id cost > $0', () => {
    registerModelPrice('cendor-test-deployment-xyz', { input: 2.5, output: 10.0 }); // USD / 1M tokens
    const cost = prices.estimate('cendor-test-deployment-xyz', 1_000_000, {
      outputTokens: 1_000_000,
    });
    expect(cost.amount.toString()).toBe('12.5'); // 2.50 input + 10.00 output
  });
});
