/**
 * The live progress hook fires per Step as a multi-agent handoff run progresses, matching the
 * post-hoc `Result.steps` (port of Python
 * `test_progress_hook.py::test_on_step_fires_across_a_multi_agent_handoff`). Offline via stub clients.
 */
import { describe, expect, it } from 'vitest';
import { Agent, type Step, handoff, run } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

describe('@cendor/sdk — progress hook', () => {
  it('fires across a multi-agent handoff for both segments, live', async () => {
    const planner = new Agent({
      name: 'planner',
      model: 'gpt-4o',
      handoffs: [handoff('writer')],
      client: stubOpenAI([
        openaiChat({ toolCalls: [{ id: 't1', name: 'transfer_to_writer', args: {} }] }),
      ]),
    });
    const writer = new Agent({
      name: 'writer',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'Done.' })]),
    });

    const seen: Step[] = [];
    const result = await run([planner, writer], 'plan and write', { onStep: (s) => seen.push(s) });

    const agentsSeen = new Set(seen.map((s) => s.agent));
    expect(agentsSeen.has('planner')).toBe(true);
    expect(agentsSeen.has('writer')).toBe(true);
    expect(seen.map((s) => [s.agent, s.kind])).toEqual(result.steps.map((s) => [s.agent, s.kind]));
  });
});
