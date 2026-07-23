/**
 * Gaps-closure follow-up wave (Phase-S remainder), TS side: S6 streamed/team `conversationId`, S12
 * bounded re-ask + `streamCheckWindow`, S13 streamed checkpoints, S14 Bedrock forced-`toolChoice`
 * structured output. Offline via stub clients. Mirrors the Python `test_gaps_followup.py`.
 * (S7/S8/S9 span parity live in `otel.test.ts`.)
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent, RunComplete, run } from '../src/index.js';
import { BedrockProvider } from '../src/providers.js';
import * as rules from '../src/rules.js';
import type { StreamEvent } from '../src/types.js';
import {
  isolate,
  openaiChat,
  recordingOpenAI,
  streamTextChunk,
  streamUsage,
  stubStreamTurns,
} from './_helpers.js';

isolate();

const STRUCTURED_OUTPUT_TOOL = 'cendor_structured_output';

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function fakeSession(id: string): { id: string; snapshot(): never[]; replace(): void } {
  return { id, snapshot: () => [], replace: () => {} };
}

// --------------------------------------------------------------------------- S6: conversationId

describe('S6 streamed/team conversationId', () => {
  it('stamps conversationId on a streamed run from a keyed session', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubStreamTurns([[streamTextChunk('hi', { finish: 'stop', usage: streamUsage() })]]),
    });
    const events = await collect(run.stream(agent, 'hello', { session: fakeSession('chat-42') }));
    const done = events.at(-1) as RunComplete;
    expect(done).toBeInstanceOf(RunComplete);
    expect(done.result.conversationId).toBe('chat-42'); // S6 — was '' before this wave
  });

  it('leaves conversationId empty with no session (never synthesized)', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubStreamTurns([[streamTextChunk('hi', { finish: 'stop', usage: streamUsage() })]]),
    });
    const done = (await collect(run.stream(agent, 'hello'))).at(-1) as RunComplete;
    expect(done.result.conversationId).toBe('');
  });
});

// --------------------------------------------------------------------------- S12: re-ask + window

describe('S12 bounded re-ask + streamCheckWindow', () => {
  it('re-asks the model on an output-stage block, up to reaskOnOutputTrip', async () => {
    const rec = recordingOpenAI([
      openaiChat({ content: 'SECRET plan' }), // blocked by the output guardrail
      openaiChat({ content: 'a clean plan' }), // the revised answer passes
    ]);
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: rec.client,
      guardrails: [rules.keywordDeny(['SECRET'], { stage: 'output', action: 'block' })],
      reaskOnOutputTrip: 1,
    });
    const result = await run(agent, 'go');
    expect(result.output).toBe('a clean plan');
    expect(rec.calls.length).toBe(2); // one blocked answer + one re-ask (billed like any call)
  });

  it('re-throws the block when the re-ask budget is 0 (fail-closed default)', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: recordingOpenAI([openaiChat({ content: 'SECRET plan' })]).client,
      guardrails: [rules.keywordDeny(['SECRET'], { stage: 'output', action: 'block' })],
      // reaskOnOutputTrip defaults to 0 → a block throws
    });
    await expect(run(agent, 'go')).rejects.toThrow();
  });

  it('streamCheckWindow trips an output block mid-stream (block throws through the stream)', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubStreamTurns([
        [
          streamTextChunk('bad', {}),
          streamTextChunk(null, { finish: 'stop', usage: streamUsage() }),
        ],
      ]),
      guardrails: [rules.keywordDeny(['bad'], { stage: 'output', action: 'block' })],
      streamCheckWindow: 3, // check after every 3 buffered chars → fires on the first 'bad' delta
    });
    await expect(collect(run.stream(agent, 'go'))).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------- S13: streamed checkpoints

describe('S13 streamed checkpoints', () => {
  it('writes a finished checkpoint and done-resumes without calling the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-ckpt-'));
    const path = join(dir, 'run.json');
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubStreamTurns([
        [streamTextChunk('first', { finish: 'stop', usage: streamUsage() })],
      ]),
    });
    const first = (await collect(run.stream(agent, 'hi', { checkpoint: path }))).at(
      -1,
    ) as RunComplete;
    expect(first.result.output).toBe('first');
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    expect(state.done).toBe(true);
    expect(state.output).toBe('first');

    // Re-run with a client that throws if the model is called — the done-resume must short-circuit.
    const throwing = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('model must not be called on a done-resume (S13)');
          },
        },
      },
    };
    const agent2 = new Agent({ name: 'a', model: 'gpt-4o', client: throwing });
    const events = await collect(run.stream(agent2, 'hi', { checkpoint: path }));
    expect(events.length).toBe(1); // lone terminal RunComplete, no re-yielded deltas (S13-D)
    expect((events[0] as RunComplete).result.output).toBe('first');
  });
});

// --------------------------------------------------------------------------- S14: Bedrock forced tool

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;

describe('S14 Bedrock forced-toolChoice structured output', () => {
  it('forces the synthetic tool when tool-less', () => {
    const kw = new BedrockProvider().buildKwargs('anthropic.claude-3', [], [], '', {
      jsonMode: true,
      outputSchema: SCHEMA,
    }) as {
      toolConfig: { toolChoice: unknown; tools: { toolSpec: { name: string } }[] };
      system?: { text: string }[];
    };
    expect(kw.toolConfig.toolChoice).toEqual({ tool: { name: STRUCTURED_OUTPUT_TOOL } });
    expect(kw.toolConfig.tools[0]!.toolSpec.name).toBe(STRUCTURED_OUTPUT_TOOL);
    expect(kw.system?.[0]?.text ?? '').not.toContain('Respond with ONLY'); // no nudge on the forced path
  });

  it('parse unwraps the forced tool input into content (not a tool to execute)', () => {
    const parsed = new BedrockProvider().parse({
      output: {
        message: {
          content: [{ toolUse: { name: STRUCTURED_OUTPUT_TOOL, input: { answer: '42' } } }],
        },
      },
      stopReason: 'tool_use',
    });
    expect(parsed.toolCalls).toEqual([]);
    expect(JSON.parse(parsed.content ?? '')).toEqual({ answer: '42' });
  });
});
