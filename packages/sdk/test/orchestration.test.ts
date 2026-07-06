/**
 * Multi-agent orchestration — handoff, supervisor/router, sequential, parallel — with nested trace
 * correlation, per-agent governance, and one verifiable audit trail (port of Python
 * `test_orchestration.py`). Offline via stub provider clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  AuditLog,
  BudgetExceeded,
  parallel,
  parallelAsync,
  run,
  sequential,
  supervisor,
  verify,
} from '../src/index.js';
import {
  anthropicMessage,
  isolate,
  openaiChat,
  recordingOpenAI,
  stubAnthropic,
  stubOpenAI,
} from './_helpers.js';

isolate();

function auditPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cendor-orch-')), 'audit.jsonl');
}

describe('@cendor/sdk — orchestration', () => {
  it('supervisor routes to a sub-agent with a correlated audit trail', async () => {
    const researcher = new Agent({
      name: 'researcher',
      model: 'gpt-4o',
      instructions: 'Do the research.',
      client: stubOpenAI([openaiChat({ content: 'Here is the research on X.' })]),
    });
    const coordinator = new Agent({
      name: 'coordinator',
      model: 'gpt-4o',
      instructions: 'Route to a specialist.',
      client: stubOpenAI([
        openaiChat({
          toolCalls: [{ name: 'transfer_to_researcher', args: { reason: 'needs research' } }],
        }),
      ]),
    });
    const path = auditPath();
    const log = new AuditLog('team', { riskTier: 'limited', path });

    const result = await supervisor(coordinator, [researcher], 'Research X', { audit: log });
    log.detach();

    expect(result.output).toBe('Here is the research on X.');
    expect(result.agents).toEqual(['coordinator', 'researcher']);

    // nested-trace correlation: one tree — every step's trace_id starts with the parent run id
    expect(result.steps.every((s) => s.traceId.startsWith(result.traceId))).toBe(true);
    expect(new Set(result.steps.map((s) => s.agent))).toEqual(
      new Set(['coordinator', 'researcher']),
    );

    // one verifiable audit trail with a decision per agent segment
    const [ok, detail] = verify(path);
    expect(ok, detail).toBe(true);
    const decisions = log.entries.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(2); // coordinator + researcher
  });

  it('run([entry, peer], ...) is a handoff team', async () => {
    const writer = new Agent({
      name: 'writer',
      model: 'gpt-4o',
      instructions: 'Write the brief.',
      client: stubOpenAI([openaiChat({ content: 'The brief.' })]),
    });
    const planner = new Agent({
      name: 'planner',
      model: 'gpt-4o',
      instructions: 'Plan, then hand off.',
      handoffs: ['writer'],
      client: stubOpenAI([openaiChat({ toolCalls: [{ name: 'transfer_to_writer', args: {} }] })]),
    });
    const result = await run([planner, writer], 'Research and write a brief');
    expect(result.output).toBe('The brief.');
    expect(result.agents).toEqual(['planner', 'writer']);
  });

  it('hands off across providers (OpenAI -> Anthropic)', async () => {
    const writer = new Agent({
      name: 'writer',
      model: 'claude-opus-4-8',
      instructions: 'Write.',
      client: stubAnthropic(anthropicMessage({ text: 'The finished brief.' })),
    });
    const planner = new Agent({
      name: 'planner',
      model: 'gpt-4o',
      instructions: 'Plan, then hand off.',
      handoffs: ['writer'],
      client: stubOpenAI([openaiChat({ toolCalls: [{ name: 'transfer_to_writer', args: {} }] })]),
    });
    const result = await run([planner, writer], 'Research and write');
    expect(result.output).toBe('The finished brief.');
    expect(result.agents).toEqual(['planner', 'writer']);
    expect((result.llmSteps[0]!.call as { provider: string }).provider).toBe('openai');
    expect(
      (result.llmSteps[result.llmSteps.length - 1]!.call as { provider: string }).provider,
    ).toBe('anthropic');
  });

  it('enforces a per-agent budget cap pre-flight', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const cheap = new Agent({
      name: 'cheap',
      model: 'gpt-4o',
      instructions: 'x',
      maxUsd: 0.0000001,
      client: rec.client,
    });
    await expect(run([cheap], 'hello')).rejects.toBeInstanceOf(BudgetExceeded);
    expect(rec.calls).toHaveLength(0); // the agent's own budget blocked it pre-flight
  });

  it('pipes a sequential pipeline with trace correlation', async () => {
    const first = new Agent({
      name: 'first',
      model: 'gpt-4o',
      instructions: 'Draft.',
      client: stubOpenAI([openaiChat({ content: 'a draft' })]),
    });
    const second = new Agent({
      name: 'second',
      model: 'gpt-4o',
      instructions: 'Polish.',
      client: stubOpenAI([openaiChat({ content: 'the final brief' })]),
    });
    const result = await sequential([first, second], 'start');
    expect(result.output).toBe('the final brief');
    expect(result.agents).toEqual(['first', 'second']);
    expect(result.llmSteps).toHaveLength(2);
    expect(result.steps.every((s) => s.traceId.startsWith(result.traceId))).toBe(true);
  });

  it('fans out in parallel (sequential execution)', async () => {
    const a = new Agent({
      name: 'a',
      model: 'gpt-4o',
      instructions: 'A',
      client: stubOpenAI([openaiChat({ content: 'out-a' })]),
    });
    const b = new Agent({
      name: 'b',
      model: 'gpt-4o',
      instructions: 'B',
      client: stubOpenAI([openaiChat({ content: 'out-b' })]),
    });
    const result = await parallel([a, b], 'same input');
    expect(result.output).toEqual({ a: 'out-a', b: 'out-b' });
    expect(result.llmSteps).toHaveLength(2);
    expect(result.steps.every((s) => s.traceId.startsWith(result.traceId))).toBe(true);
  });

  it('fans out with real concurrency (parallelAsync)', async () => {
    const a = new Agent({
      name: 'a',
      model: 'gpt-4o',
      instructions: 'A',
      client: stubOpenAI([openaiChat({ content: 'out-1' })]),
    });
    const b = new Agent({
      name: 'b',
      model: 'gpt-4o',
      instructions: 'B',
      client: stubOpenAI([openaiChat({ content: 'out-2' })]),
    });
    const result = await parallelAsync([a, b], 'x');
    expect(result.output).toEqual({ a: 'out-1', b: 'out-2' });
    expect(result.steps.every((s) => s.traceId.startsWith(result.traceId))).toBe(true);
  });
});
