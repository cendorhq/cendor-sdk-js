/**
 * Multi-agent streaming — `run.stream([...])` streams a handoff run: events from each active agent,
 * switching on a `transfer_to_<peer>` call, with one terminal RunComplete carrying the aggregate
 * Result (port of Python `test_multi_agent_streaming.py`). Previously a run-to-completion stub.
 */
import { describe, expect, it } from 'vitest';
import {
  Agent,
  RunComplete,
  type StreamEvent,
  TextDelta,
  ToolCallEvent,
  handoff,
  run,
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

function planner(): Agent {
  return new Agent({
    name: 'planner',
    model: 'gpt-4o',
    handoffs: [handoff('writer')],
    client: stubStreamTurns([
      [
        streamToolChunk(0, { id: 't1', name: 'transfer_to_writer', args: '{}' }),
        streamTextChunk(null, { finish: 'tool_calls', usage: streamUsage() }),
      ],
    ]),
  });
}

function writer(): Agent {
  return new Agent({
    name: 'writer',
    model: 'gpt-4o',
    client: stubStreamTurns([
      [
        streamTextChunk('All '),
        streamTextChunk('done.'),
        streamTextChunk(null, { finish: 'stop', usage: streamUsage() }),
      ],
    ]),
  });
}

describe('@cendor/sdk — multi-agent streaming', () => {
  it('streams a handoff run and aggregates both segments', async () => {
    const events = await collect(run.stream([planner(), writer()], 'plan then write'));

    expect(events.some((e) => e instanceof ToolCallEvent && e.name === 'transfer_to_writer')).toBe(
      true,
    );
    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(text).toBe('All done.'); // the writer's streamed answer

    const done = events[events.length - 1];
    expect(done).toBeInstanceOf(RunComplete);
    const result = (done as RunComplete).result;
    expect(result.output).toBe('All done.');
    expect(result.agents).toEqual(['planner', 'writer']); // both segments aggregated
    expect(new Set(result.steps.map((s) => s.agent))).toEqual(new Set(['planner', 'writer']));
  });

  it('streams a single-agent list (one segment, no handoff)', async () => {
    const events = await collect(run.stream([writer()], 'just write'));
    const text = events
      .filter((e): e is TextDelta => e instanceof TextDelta)
      .map((e) => e.text)
      .join('');
    expect(text).toBe('All done.');
    const done = events[events.length - 1];
    expect(done).toBeInstanceOf(RunComplete);
    expect((done as RunComplete).result.agents).toEqual(['writer']);
  });
});
