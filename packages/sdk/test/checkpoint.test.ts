/**
 * Checkpoint / resume durability — the TS port of `test_hardening.py::test_checkpointed_run_resumes_
 * after_crash` and `test_multi_agent_checkpoint.py`. Offline via stub clients.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, run, tool } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

function ckptPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'cendor-ckpt-')), name);
}

describe('@cendor/sdk — checkpoint / resume', () => {
  it('single-agent run resumes after a crash without re-running the tool', async () => {
    const path = ckptPath('run.ckpt.json');
    let toolRuns = 0;
    const weather = tool(
      (args: { city: string }) => {
        toolRuns++;
        return `Sunny in ${args.city}`;
      },
      {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: z.object({ city: z.string() }),
      },
    );

    // Attempt 1: turn 1 asks for the tool (runs it, checkpoint saved), turn 2 crashes.
    let n1 = 0;
    const client1 = {
      chat: {
        completions: {
          create: async () => {
            n1++;
            if (n1 === 1)
              return openaiChat({
                toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }],
              });
            throw new Error('process died mid-run');
          },
        },
      },
    };
    const agent1 = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      tools: [weather],
      instructions: 'Use tools.',
      client: client1,
    });
    await expect(run(agent1, 'weather in Paris?', { checkpoint: path })).rejects.toThrow();
    expect(toolRuns).toBe(1); // the tool ran once before the crash

    // Attempt 2 (resume): a fresh client only needs to produce the final answer.
    const agent2 = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      tools: [weather],
      instructions: 'Use tools.',
      client: stubOpenAI([openaiChat({ content: "It's sunny in Paris." })]),
    });
    const result = await run(agent2, 'weather in Paris?', { checkpoint: path });

    expect(result.output).toBe("It's sunny in Paris.");
    expect(toolRuns).toBe(1); // NOT re-run on resume (loaded from the checkpoint)
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('multi-agent checkpoint is written with done/output on completion', async () => {
    const path = ckptPath('team.ckpt.json');
    const a = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'done' })]),
    });
    const result = await run([a], 'hi', { checkpoint: path });
    expect(result.output).toBe('done');
    const state = JSON.parse(readFileSync(path, 'utf-8')) as { done: boolean; output: string };
    expect(state.done).toBe(true);
    expect(state.output).toBe('done');
  });

  it('multi-agent resume uses the pre-written original messages and ignores new input', async () => {
    const path = ckptPath('team.ckpt.json');
    writeFileSync(
      path,
      JSON.stringify({
        run_id: 'r1',
        messages: [{ role: 'user', content: 'ORIGINAL' }],
        active: 'a',
        seen: ['a'],
        seg: 0,
        done: false,
      }),
    );
    const a = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'resumed' })]),
    });
    const result = await run([a], 'IGNORED-NEW-INPUT', { checkpoint: path });
    expect(result.messages.some((m) => m.content === 'ORIGINAL')).toBe(true);
    expect(result.messages.some((m) => m.content === 'IGNORED-NEW-INPUT')).toBe(false);
    expect(result.output).toBe('resumed');
  });

  it('single-agent resume of a DONE checkpoint replays the stored result — 0 model + 0 tool calls', async () => {
    const path = ckptPath('done.ckpt.json');
    let modelCalls = 0;
    let toolRuns = 0;
    const weather = tool(
      (args: { city: string }) => {
        toolRuns++;
        return `Sunny in ${args.city}`;
      },
      {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: z.object({ city: z.string() }),
      },
    );
    // A completed run's checkpoint: final answer + the already-run tool trail, persisted with done:true.
    writeFileSync(
      path,
      JSON.stringify({
        run_id: 'done-run',
        messages: [
          { role: 'user', content: 'weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_0', name: 'get_weather', content: 'Sunny in Paris' },
          { role: 'assistant', content: "It's sunny in Paris." },
        ],
        done: true,
        output: "It's sunny in Paris.",
      }),
    );
    const client = {
      chat: {
        completions: {
          create: async () => {
            modelCalls++;
            return openaiChat({ content: 'SHOULD NOT RUN' });
          },
        },
      },
    };
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      tools: [weather],
      instructions: 'Use tools.',
      client,
    });

    const result = await run(agent, 'weather in Paris?', { checkpoint: path });

    expect(result.output).toBe("It's sunny in Paris."); // stored output replayed
    expect(modelCalls).toBe(0); // model NOT re-invoked
    expect(toolRuns).toBe(0); // completed tool NOT re-run
    expect(result.steps).toHaveLength(0); // no bus events on a short-circuit
    expect(result.llmSteps).toHaveLength(0);
    expect(result.toolSteps).toHaveLength(0);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true); // persisted trail preserved
  });

  // ------------------------------------ SETTLED (unfinished-but-complete) checkpoints
  //
  // The crash window: every path saves the answering turn with done:false BEFORE the done:true save
  // lands, so a crash there leaves an "unfinished" checkpoint whose transcript already ends with
  // the final assistant answer. Resuming that used to re-enter the model loop on a complete
  // conversation — where re-doing the task, tools included, is a legitimate sample for the model
  // (measured live: BUG-sdk-resume-recalls-a-tool-already-in-the-replayed-messages).

  function writeSettled(
    path: string,
    tail: Record<string, unknown>[] | null,
    output: string | null = null,
  ): void {
    const messages: Record<string, unknown>[] = [
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: 'Sunny in Paris' },
      ...(tail ?? [{ role: 'assistant', content: "It's sunny in Paris." }]),
    ];
    writeFileSync(path, JSON.stringify({ run_id: 'r-settled', messages, done: false, output }));
  }

  function countingClient(counter: { model: number }, content = 'SHOULD NOT RUN') {
    return {
      chat: {
        completions: {
          create: async () => {
            counter.model++;
            return openaiChat({ content });
          },
        },
      },
    };
  }

  it('settled resume (unfinished, transcript ends in the final answer) — 0 model + 0 tool calls', async () => {
    const path = ckptPath('settled.ckpt.json');
    writeSettled(path, null);
    const counter = { model: 0 };
    let toolRuns = 0;
    const weather = tool(
      (args: { city: string }) => {
        toolRuns++;
        return `Sunny in ${args.city}`;
      },
      {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: z.object({ city: z.string() }),
      },
    );
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      tools: [weather],
      client: countingClient(counter),
    });
    const result = await run(agent, 'weather in Paris?', { checkpoint: path });
    expect(result.output).toBe("It's sunny in Paris.");
    expect(counter.model).toBe(0); // the loop was never re-entered
    expect(toolRuns).toBe(0); // the completed tool was not re-run
    expect(result.steps).toHaveLength(0); // no bus events on a resume
    expect(result.traceId).toBe('r-settled'); // done-resume parity: stored run id, no fresh mint
    expect(result.incomplete).toBe(false);
  });

  it('settled resume prefers a stored output over the last-message content', async () => {
    // A stream-path save carries `output` (possibly guardrail-transformed) with done:false.
    const path = ckptPath('settled-stored.ckpt.json');
    writeSettled(path, [{ role: 'assistant', content: 'raw answer' }], 'gated answer');
    const counter = { model: 0 };
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      client: countingClient(counter),
    });
    const result = await run(agent, 'weather in Paris?', { checkpoint: path });
    expect(result.output).toBe('gated answer');
    expect(counter.model).toBe(0);
  });

  it('a mid-run checkpoint (transcript ends at a tool result) still resumes through the loop', async () => {
    const path = ckptPath('midrun.ckpt.json');
    writeSettled(path, []); // ends at the tool-result message — genuinely mid-run
    const counter = { model: 0 };
    let toolRuns = 0;
    const weather = tool(
      (args: { city: string }) => {
        toolRuns++;
        return `Sunny in ${args.city}`;
      },
      {
        name: 'get_weather',
        description: 'Current weather for a city.',
        parameters: z.object({ city: z.string() }),
      },
    );
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      tools: [weather],
      client: countingClient(counter, "It's sunny in Paris."),
    });
    const result = await run(agent, 'weather in Paris?', { checkpoint: path });
    expect(result.output).toBe("It's sunny in Paris.");
    expect(counter.model).toBe(1); // the loop ran — this shape is NOT settled
    expect(toolRuns).toBe(0); // the saved tool result was replayed, not re-executed by the SDK
  });

  it('an empty-content assistant tail is not settled (conservative predicate)', async () => {
    const path = ckptPath('empty-tail.ckpt.json');
    writeSettled(path, [{ role: 'assistant', content: '' }]);
    const counter = { model: 0 };
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      client: countingClient(counter, 'recovered answer'),
    });
    const result = await run(agent, 'weather in Paris?', { checkpoint: path });
    expect(result.output).toBe('recovered answer');
    expect(counter.model).toBe(1);
  });

  it('a settled TEAM checkpoint short-circuits like a done one', async () => {
    const path = ckptPath('team-settled.ckpt.json');
    let modelCalls = 0;
    writeFileSync(
      path,
      JSON.stringify({
        run_id: 'team-settled',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'final team answer' },
        ],
        active: 'a',
        seen: ['a'],
        seg: 0,
        done: false, // the crash window: the segment answered, the done save never landed
        output: null,
      }),
    );
    const client = {
      chat: {
        completions: {
          create: async () => {
            modelCalls++;
            return openaiChat({ content: 'SHOULD NOT RUN' });
          },
        },
      },
    };
    const a = new Agent({ name: 'a', model: 'gpt-4o', client });
    const result = await run([a], 'IGNORED-NEW-INPUT', { checkpoint: path });
    expect(result.output).toBe('final team answer');
    expect(modelCalls).toBe(0); // no segment re-entered
  });

  it('multi-agent resume of a DONE checkpoint replays the stored result — 0 model + 0 tool calls', async () => {
    const path = ckptPath('team-done.ckpt.json');
    let modelCalls = 0;
    writeFileSync(
      path,
      JSON.stringify({
        run_id: 'team-done',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'final team answer' },
        ],
        active: 'a',
        seen: ['a'],
        seg: 0,
        done: true,
        output: 'final team answer',
      }),
    );
    const client = {
      chat: {
        completions: {
          create: async () => {
            modelCalls++;
            return openaiChat({ content: 'SHOULD NOT RUN' });
          },
        },
      },
    };
    const a = new Agent({ name: 'a', model: 'gpt-4o', client });

    const result = await run([a], 'IGNORED-NEW-INPUT', { checkpoint: path });

    expect(result.output).toBe('final team answer'); // stored output replayed
    expect(modelCalls).toBe(0); // no segment re-entered
    expect(result.steps).toHaveLength(0); // no bus events on a short-circuit
    expect(result.agents).toEqual(['a']); // seen list restored
    expect(result.messages.some((m) => m.content === 'final team answer')).toBe(true);
  });
});
