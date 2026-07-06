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
});
