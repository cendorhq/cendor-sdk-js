/**
 * Phase S wave (TS parity): Anthropic incremental streaming + ThinkingDelta (S1/S2), native
 * structured output (S14), Ollama/Bedrock images (S15). Offline via instrumented stub clients.
 */
import { instrument } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunComplete,
  type StreamEvent,
  TextDelta,
  ThinkingDelta,
  ToolCallEvent,
  run,
  tool,
} from '../src/index.js';
import {
  AnthropicProvider,
  bedrockContent,
  canonicalToBedrock,
  ollamaMessage,
} from '../src/providers.js';
import { isolate } from './_helpers.js';

isolate();

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function anthropicClient(turns: unknown[][]) {
  const it = turns[Symbol.iterator]();
  return instrument({
    messages: {
      create: async () => {
        const events = it.next().value as unknown[];
        async function* gen() {
          for (const e of events) yield e;
        }
        return gen();
      },
    },
  }) as { messages: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
}

const cbdText = (text: string, index = 0) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'text_delta', text },
});
const cbdThinking = (text: string, index = 0) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking: text },
});
const cbdJson = (partial: string, index = 0) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json: partial },
});
const messageStart = (input = 10) => ({
  type: 'message_start',
  message: { usage: { input_tokens: input } },
});
const messageDelta = (stop = 'end_turn', out = 5) => ({
  type: 'message_delta',
  delta: { stop_reason: stop },
  usage: { output_tokens: out },
});

describe('@cendor/sdk — Phase S wave (TS)', () => {
  it('S1: Anthropic incremental text streaming', async () => {
    const client = anthropicClient([
      [
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        cbdText('Hello '),
        cbdText('world'),
        messageDelta(),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'claude-opus-4-8', instructions: 'x', client });
    const events = await collect(run.stream(agent, 'hi'));
    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');
    const done = events[events.length - 1];
    expect(done).toBeInstanceOf(RunComplete);
    expect((done as RunComplete).result.output).toBe('Hello world');
  });

  it('S2: Anthropic ThinkingDelta stream (thinking not folded into content)', async () => {
    const client = anthropicClient([
      [
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        cbdThinking('reason '),
        cbdThinking('here'),
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        cbdText('answer', 1),
        messageDelta(),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'claude-opus-4-8', instructions: 'x', client });
    const events = await collect(run.stream(agent, 'hi'));
    const thinking = events
      .filter((e): e is ThinkingDelta => e instanceof ThinkingDelta)
      .map((e) => e.text)
      .join('');
    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(thinking).toBe('reason here');
    expect(text).toBe('answer');
  });

  it('S1: Anthropic tool call reassembled from input_json_delta', async () => {
    const getWeather = tool((args: { city: string }) => `Sunny in ${args.city}`, {
      name: 'get_weather',
      description: 'weather',
      parameters: z.object({ city: z.string() }),
    });
    const client = anthropicClient([
      [
        messageStart(),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
        },
        cbdJson('{"city":'),
        cbdJson(' "Paris"}'),
        messageDelta('tool_use'),
      ],
      [
        messageStart(12),
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        cbdText("It's sunny."),
        messageDelta(),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'claude-opus-4-8', tools: [getWeather], client });
    const events = await collect(run.stream(agent, 'weather?'));
    const calls = events.filter((e): e is ToolCallEvent => e instanceof ToolCallEvent);
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.arguments).toEqual({ city: 'Paris' });
    expect((events[events.length - 1] as RunComplete).result.output).toBe("It's sunny.");
  });

  it('S14: Anthropic native structured output on a supported model; degrades on old', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const kwargs = new AnthropicProvider().buildKwargs(
      'claude-opus-4-8',
      [{ role: 'user', content: 'x' }],
      [],
      'sys',
      {
        jsonMode: true,
        outputSchema: schema,
      },
    );
    expect(kwargs.output_config).toBeDefined();
    const fmt = (
      kwargs.output_config as { format: { type: string; schema: Record<string, unknown> } }
    ).format;
    expect(fmt.type).toBe('json_schema');
    expect(fmt.schema.additionalProperties).toBe(false);

    const old = new AnthropicProvider().buildKwargs(
      'claude-3-5-sonnet-20240620',
      [{ role: 'user', content: 'x' }],
      [],
      'sys',
      {
        jsonMode: true,
        outputSchema: schema,
      },
    );
    expect(old.output_config).toBeUndefined();
    expect(String(old.system)).toContain('JSON object');
  });

  it('S15: Ollama images + Bedrock image blocks', () => {
    const data = Buffer.from('img-bytes').toString('base64');
    const content = [
      { type: 'text', text: 'what?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }, // remote -> dropped
    ];
    const om = ollamaMessage({ role: 'user', content } as never) as Record<string, unknown>;
    expect(om.content).toBe('what?');
    expect(om.images).toEqual([data]);

    const blocks = bedrockContent(content) as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ text: 'what?' });
    const img = blocks[1]!.image as { format: string; source: { bytes: Uint8Array } };
    expect(img.format).toBe('png');
    expect(Buffer.from(img.source.bytes).toString()).toBe('img-bytes');
    expect(blocks.length).toBe(2); // remote dropped

    const wire = canonicalToBedrock([{ role: 'user', content }] as never);
    expect((wire[0]!.content as Array<Record<string, unknown>>)[1]!.image).toBeDefined();
  });
});
