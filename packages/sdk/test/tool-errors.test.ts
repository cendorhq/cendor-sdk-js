/**
 * S7 — a caller can tell a tool failed without matching strings, and the model still sees the string.
 *
 * MEASURED MECHANISM (plan/evidence-gapclose-2026-07-31/s7_probe_tool_failure_visibility.py, and the
 * same holds in TS): a tool that throws emits **zero** `ToolCall` events on the bus (`@cendor/core`
 * does not catch around the tool), so it appears in neither `Result.steps` nor `Result.toolSteps`, and
 * no `execute_tool` span is rendered. `result.incomplete` stays `false` — the run "succeeded". The
 * only machine-readable trace was the `"[error] …"` prefix inside a tool message.
 *
 * `Result.toolErrors` closes that. The string handed to the MODEL is a deliberate contract and is
 * byte-identical — asserted below, because a "fix" that changed it would silently change how every
 * model recovers from a tool failure.
 */
import { ToolCall, bus } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Result, isToolError, run, tool } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

const explode = tool(
  (args: { x: number }): string => {
    throw new TypeError(`boom on ${args.x}`);
  },
  {
    name: 'explode',
    description: 'Always fails.',
    parameters: z.object({ x: z.number() }),
  },
);

const fine = tool((args: { x: number }) => `ok ${args.x}`, {
  name: 'fine',
  description: 'Always works.',
  parameters: z.object({ x: z.number() }),
});

function agentWith(tools: ReturnType<typeof tool>[], toolName: string, args: object) {
  return new Agent({
    name: 'probe',
    model: 'gpt-4o',
    instructions: 'Use tools.',
    tools,
    client: stubOpenAI([
      openaiChat({ toolCalls: [{ id: 'call_0', name: toolName, args: args as never }] }),
      openaiChat({ content: 'could not' }),
    ]),
  });
}

describe('@cendor/sdk — typed tool errors (S7)', () => {
  it('reports a throwing tool as a typed ToolError', async () => {
    const result = await run(agentWith([explode], 'explode', { x: 1 }), 'please explode');
    expect(result.toolFailed).toBe(true);
    expect(result.toolErrors).toEqual([
      { tool: 'explode', type: 'TypeError', message: 'boom on 1', toolCallId: 'call_0' },
    ]);
  });

  // --- NEGATIVE CONTROL on the contract: the model-facing text is byte-identical. ---
  it('leaves the string the model sees unchanged', async () => {
    const result = await run(agentWith([explode], 'explode', { x: 7 }), 'please explode');
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.content)).toEqual(['[error] TypeError: boom on 7']);
  });

  it('types an unknown tool as UnknownTool', async () => {
    const result = await run(agentWith([fine], 'nope', {}), 'call nope');
    expect(result.toolErrors.map((e) => [e.tool, e.type])).toEqual([['nope', 'UnknownTool']]);
  });

  // --- NEGATIVE CONTROL: a successful run reports NOTHING. ---
  it('a successful tool run has no tool errors, and does produce a step', async () => {
    const result = await run(agentWith([fine], 'fine', { x: 3 }), 'please work');
    expect(result.toolFailed).toBe(false);
    expect(result.toolErrors).toEqual([]);
    expect(result.toolSteps).toHaveLength(1); // a SUCCEEDING tool does emit a ToolCall
  });

  it('pins the measured baseline: a failed tool emits no ToolCall', async () => {
    const seen: unknown[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    const result = await run(agentWith([explode], 'explode', { x: 1 }), 'please explode');
    off();
    expect(seen.filter((e) => e instanceof ToolCall)).toEqual([]);
    expect(result.toolSteps).toEqual([]);
    expect(result.incomplete).toBe(false); // the run itself did not fail
    expect(result.toolErrors.length).toBeGreaterThan(0); // …but the failure is now visible
  });

  // --- NEGATIVE CONTROL: a guardrail BLOCK is a decision, never a tool error. ---
  it('does not treat a guardrail block string as a tool error', () => {
    const blocked = new Result({
      output: 'x',
      messages: [{ role: 'tool', tool_call_id: 'c1', name: 'refund', content: '[blocked] policy' }],
    });
    expect(blocked.toolFailed).toBe(false);
    expect(blocked.toolErrors).toEqual([]);
  });

  it('isToolError classifies only the marker', () => {
    expect(isToolError('[error] TypeError: x')).toBe(true);
    expect(isToolError('[blocked] policy')).toBe(false);
    expect(isToolError('all good')).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError(17)).toBe(false);
    expect(isToolError({ error: true })).toBe(false);
  });

  it('keeps the whole body when the marker carries no type separator', () => {
    const r = new Result({
      output: 'x',
      messages: [{ role: 'tool', tool_call_id: 'c', name: 't', content: '[error] bare' }],
    });
    expect(r.toolErrors).toEqual([{ tool: 't', type: '', message: 'bare', toolCallId: 'c' }]);
  });

  it('does not re-split a colon inside the message', () => {
    const r = new Result({
      output: 'x',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c',
          name: 't',
          content: '[error] HTTPError: 404: not found',
        },
      ],
    });
    expect(r.toolErrors).toEqual([
      { tool: 't', type: 'HTTPError', message: '404: not found', toolCallId: 'c' },
    ]);
  });

  it('reports multiple failures in order', () => {
    const r = new Result({
      output: 'x',
      messages: [
        { role: 'tool', tool_call_id: 'a', name: 't1', content: '[error] A: one' },
        { role: 'assistant', content: 'hm' },
        { role: 'tool', tool_call_id: 'b', name: 't2', content: 'ok' },
        { role: 'tool', tool_call_id: 'c', name: 't3', content: '[error] B: two' },
      ],
    });
    expect(r.toolErrors.map((e) => [e.tool, e.type, e.message])).toEqual([
      ['t1', 'A', 'one'],
      ['t3', 'B', 'two'],
    ]);
  });

  it('survives a resumed run, because it derives from the messages a checkpoint persists', () => {
    const r = new Result({
      output: 'final',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'c0', name: 'explode', content: '[error] E: old' },
        { role: 'assistant', content: 'final' },
      ],
    });
    expect(r.toolErrors.map((e) => e.message)).toEqual(['old']);
  });
});
