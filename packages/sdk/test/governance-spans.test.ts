/**
 * Option C in the SDK (DR-2c): a blocked run's governance lands INSIDE the run, with no audit object.
 * TS mirror of cendor-sdk's tests/test_governance_spans.py.
 *
 * Core renders enforcement decisions flat for a libs-only app; inside an SDK run `liveSpans` renders
 * the same events as children of the run root, so a telemetry user sees *why* a run stopped without
 * adopting the evidence library. When a real audit mirror is on the wire it wins (never two).
 */
import { AuditLog } from '@cendor/acttrace';
import { bus, otel as coreOtel } from '@cendor/core';
import { BudgetExceeded, withBudget } from '@cendor/tokenguard';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, rules, run } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const gov = (): ReturnType<InMemorySpanExporter['getFinishedSpans']> =>
  exporter.getFinishedSpans().filter((s) => s.name.startsWith('governance.'));

function agentWith(reply = 'hello', guardrails?: unknown[]): Agent {
  return new Agent({
    name: 'assistant',
    model: 'gpt-4o',
    client: stubOpenAI([openaiChat({ content: reply })]),
    ...(guardrails ? { guardrails: guardrails as never } : {}),
  });
}

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  (coreOtel as unknown as { _resetGovernanceMirrors(): void })._resetGovernanceMirrors();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterEach(async () => {
  (coreOtel as unknown as { _resetGovernanceMirrors(): void })._resetGovernanceMirrors();
  await provider.shutdown();
  trace.disable();
  bus._reset();
});

describe('Option C in the SDK', () => {
  it('a blocked run shows why, with zero governance code', async () => {
    await expect(
      withBudget({ usd: 0.0000001, onExceed: 'block', name: 'tiny cap' }, async () => {
        await run(agentWith(), 'hi');
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);

    const spans = exporter.getFinishedSpans();
    expect(gov().map((s) => s.name)).toEqual(['governance.budget_event']);
    const a = gov()[0]!.attributes;
    expect(a['cendor.gov.type']).toBe('budget_event');
    expect(a['cendor.gov.action']).toBe('blocked');
    expect(a['cendor.gov.budget']).toBe('tiny cap');
    expect(a['cendor.audit.type']).toBeUndefined(); // rule 6
    const root = spans.find((s) => s.name === 'agent.run')!;
    expect(gov()[0]!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it('a guardrail block renders inline on the run', async () => {
    const agent = agentWith('hello', [rules.keywordDeny(['forbidden'], { action: 'block' })]);
    await expect(run(agent, 'a forbidden request')).rejects.toThrow();
    expect(gov().map((s) => s.name)).toEqual(['governance.guardrail_decision']);
    const a = gov()[0]!.attributes;
    expect(a['cendor.gov.guardrail']).toBe('keyword_deny');
    expect(a['cendor.gov.stage']).toBe('input');
    expect(a['cendor.gov.action']).toBe('block');
    expect(a['cendor.gov.reason']).toBeUndefined();
  });

  it('an audit mirror wins over the ops spans', async () => {
    const audit = new AuditLog('support'); // auto-attaches an OTelMirror ⇒ core stands down
    try {
      await expect(
        withBudget({ usd: 0.0000001, onExceed: 'block', name: 'tiny cap' }, async () => {
          await run(agentWith(), 'hi', { audit });
        }),
      ).rejects.toBeInstanceOf(BudgetExceeded);
    } finally {
      audit.detach();
    }
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('audit.budget_event');
    expect(names.some((n) => n.startsWith('governance.'))).toBe(false);
  });

  it('CENDOR_TELEMETRY=off kills the inline governance too', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    await expect(
      withBudget({ usd: 0.0000001, onExceed: 'block', name: 'cap' }, async () => {
        await run(agentWith(), 'hi');
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
