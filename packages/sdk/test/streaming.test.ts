/**
 * Streaming — `run.stream` yields text deltas, tool events, and a terminal RunComplete (port of the
 * Python `test_streaming.py`). Offline via stub OpenAI-shaped stream clients (no network); asserts
 * live text reassembly, tool-call delta accumulation across fragments, and that the final Result
 * matches a blocking run.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  RunComplete,
  type StreamEvent,
  TextDelta,
  ThinkingDelta,
  ToolCallEvent,
  ToolResultEvent,
  run,
  tool,
} from '../src/index.js';
import {
  isolate,
  streamTextChunk,
  streamToolChunk,
  streamUsage,
  stubStreamTurns,
} from './_helpers.js';

isolate();

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('@cendor/sdk — single-agent streaming', () => {
  it('streams text deltas live and a terminal RunComplete', async () => {
    const client = stubStreamTurns([
      [
        streamTextChunk('Hello '),
        streamTextChunk('world'),
        streamTextChunk(null, { finish: 'stop', usage: streamUsage() }),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'gpt-4o', instructions: 'x', client });
    const events = await collect(run.stream(agent, 'hi'));

    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');

    const done = events[events.length - 1];
    expect(done).toBeInstanceOf(RunComplete);
    const result = (done as RunComplete).result;
    expect(result.output).toBe('Hello world');
    expect(result.traceId).toBeTruthy(); // correlated like a blocking run
    expect(result.llmSteps.map((s) => s.name)).toEqual(['gpt-4o']);
  });

  it('yields ThinkingDelta for a provider that streams reasoning, separate from text (GLR-12)', async () => {
    const client = stubStreamTurns([
      [
        { choices: [{ index: 0, delta: { reasoning_content: 'let me ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] },
        streamTextChunk('The answer.'),
        streamTextChunk(null, { finish: 'stop', usage: streamUsage() }),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'gpt-4o', instructions: 'x', client });
    const events = await collect(run.stream(agent, 'hi'));
    const thinking = events
      .filter((e): e is ThinkingDelta => e instanceof ThinkingDelta)
      .map((e) => e.text)
      .join('');
    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(thinking).toBe('let me think'); // reasoning surfaced separately
    expect(text).toBe('The answer.'); // the visible answer is unaffected
  });

  it('yields no ThinkingDelta when the provider streams no reasoning (GLR-12 additive)', async () => {
    const client = stubStreamTurns([
      [streamTextChunk('hi'), streamTextChunk(null, { finish: 'stop', usage: streamUsage() })],
    ]);
    const agent = new Agent({ name: 'a', model: 'gpt-4o', instructions: 'x', client });
    const events = await collect(run.stream(agent, 'hi'));
    expect(events.some((e) => e instanceof ThinkingDelta)).toBe(false);
  });

  it('reassembles a tool call across streamed argument fragments', async () => {
    const getWeather = tool((args: { city: string }) => `Sunny in ${args.city}`, {
      name: 'get_weather',
      description: 'weather',
      parameters: z.object({ city: z.string() }),
    });
    const client = stubStreamTurns([
      // turn 1: a tool call streamed as argument fragments
      [
        streamToolChunk(0, { id: 'call_1', name: 'get_weather', args: '{"city":' }),
        streamToolChunk(0, { args: ' "Paris"}' }),
        streamTextChunk(null, { finish: 'tool_calls', usage: streamUsage() }),
      ],
      // turn 2: the streamed answer
      [
        streamTextChunk("It's "),
        streamTextChunk('sunny.'),
        streamTextChunk(null, { finish: 'stop', usage: streamUsage(8, 3) }),
      ],
    ]);
    const agent = new Agent({ name: 'a', model: 'gpt-4o', tools: [getWeather], client });
    const events = await collect(run.stream(agent, 'weather in Paris?'));

    const calls = events.filter((e): e is ToolCallEvent => e instanceof ToolCallEvent);
    const results = events.filter((e): e is ToolResultEvent => e instanceof ToolResultEvent);
    expect(calls[0]!.name).toBe('get_weather');
    expect(calls[0]!.arguments).toEqual({ city: 'Paris' }); // fragments reassembled + parsed
    expect(results[0]!.result).toContain('Sunny in Paris');

    const done = events[events.length - 1];
    expect(done).toBeInstanceOf(RunComplete);
    const result = (done as RunComplete).result;
    expect(result.output).toBe("It's sunny.");
    expect(result.toolSteps.map((s) => s.name)).toEqual(['get_weather']);
  });
});
