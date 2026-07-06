/**
 * Provider response normalization — the TS port of `tests/test_providers.py`. Pure unit tests over
 * plain-object fixtures for every provider shape (parse / buildKwargs / translators), so response-shape
 * drift is caught here in isolation, independent of the wire tests in `providers-http.test.ts`.
 */
import { prices } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

// DEFERRED — end-to-end usage capture for HF needs new @cendor/core detection (Phase B). The shipped
// @cendor/core@0.2.0 only detects openai / openai_responses / anthropic, so it cannot attribute an
// LLMCall to `huggingface` yet. Re-enable once the core release lands and the sdk-js dep is bumped.
it.todo(
  'cendor-core attributes the HF chatCompletion client (needs @cendor/core chatCompletion detection)',
);

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
      function_declarations: { name: string }[];
    }[];
    expect(gemini[0]!.function_declarations[0]!.name).toBe('search');
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
    }) as { config: { response_mime_type: string; response_schema: unknown } };
    expect(gk.config.response_mime_type).toBe('application/json');
    expect(gk.config.response_schema).toEqual(schema);
  });

  it('Gemini/Bedrock build_kwargs carry the tool history (P0 regression)', () => {
    const hist = toolHistory();
    const gk = new GeminiProvider().buildKwargs('gemini-2.0-flash', hist, [], '', {});
    const gContents = JSON.stringify(gk.contents);
    expect(gContents).toContain('function_call');
    expect(gContents).toContain('Sunny');
    const bk = new BedrockProvider().buildKwargs('meta.llama', hist, [], '', {});
    const bMessages = JSON.stringify(bk.messages);
    expect(bMessages).toContain('toolUse');
    expect(bMessages).toContain('Sunny');
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
    const fc = (modelTurn.parts as { function_call?: { name: string; args: unknown } }[]).find(
      (p) => p.function_call,
    )!.function_call!;
    expect(fc.name).toBe('get_weather');
    expect(fc.args).toEqual({ city: 'Paris' });
    const respTurn = contents[2]!;
    expect(respTurn.role).toBe('user');
    const fr = (
      respTurn.parts as { function_response?: { name: string; response: { result: string } } }[]
    ).find((p) => p.function_response)!.function_response!;
    expect(fr.name).toBe('get_weather');
    expect(fr.response.result).toContain('Sunny');
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
    // Gemini: text part + inline_data + file_data.
    const parts = canonicalToGemini(msg)[0]!.parts as {
      text?: string;
      inline_data?: { mime_type: string };
      file_data?: unknown;
    }[];
    expect(parts).toContainEqual({ text: 'what is this?' });
    expect(parts.some((p) => p.inline_data && p.inline_data.mime_type === 'image/png')).toBe(true);
    expect(parts.some((p) => p.file_data)).toBe(true);
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

  it('a registered price makes an unpriced deployment id cost > $0', () => {
    registerModelPrice('cendor-test-deployment-xyz', { input: 2.5, output: 10.0 }); // USD / 1M tokens
    const cost = prices.estimate('cendor-test-deployment-xyz', 1_000_000, {
      outputTokens: 1_000_000,
    });
    expect(cost.amount.toString()).toBe('12.5'); // 2.50 input + 10.00 output
  });
});
