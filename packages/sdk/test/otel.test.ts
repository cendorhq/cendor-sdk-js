/**
 * SDK OTel span helpers — `spanTree`/`liveSpans` and the W6 `conversationId` grouping key.
 * `@opentelemetry/api` is an optional peer, absent in this workspace, so (like acttrace's
 * otel-mirror test) we inject a fake tracer that records `setAttribute` calls rather than assert
 * against a real exporter — the real-exporter assertions live on the Python side (test_live_spans.py).
 * The fake is structurally compatible with the helpers' internal Tracer/Span shape (no `any`).
 */
import { LLMCall, Money, ToolCall, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result, Step, liveSpans, spanTree } from '../src/index.js';

class FakeSpan {
  attrs: Record<string, unknown> = {};
  ended = false;
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = value;
  }
  end(): void {
    this.ended = true;
  }
}
class FakeTracer {
  spans: FakeSpan[] = [];
  startSpan(_name: string): FakeSpan {
    const s = new FakeSpan();
    this.spans.push(s);
    return s;
  }
  root(): FakeSpan {
    const r = this.spans[0];
    if (!r) throw new Error('no span started');
    return r;
  }
}

describe('spanTree conversationId', () => {
  it('stamps gen_ai.conversation.id on the root when given', () => {
    const tracer = new FakeTracer();
    const result = new Result({ output: 'ok', traceId: 'run-1', steps: [] });
    expect(spanTree(result, tracer, { conversationId: 'chat-42' })).toBe(true);
    expect(tracer.root().attrs['gen_ai.conversation.id']).toBe('chat-42');
  });

  it('omits the key by default', () => {
    const tracer = new FakeTracer();
    const result = new Result({ output: 'ok', traceId: 'run-1', steps: [] });
    expect(spanTree(result, tracer)).toBe(true);
    expect('gen_ai.conversation.id' in tracer.root().attrs).toBe(false);
  });
});

describe('liveSpans conversationId', () => {
  it('stamps gen_ai.conversation.id on the root and closes cleanly', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer, conversationId: 'chat-42' });
    scope.close();
    expect(tracer.root().attrs['gen_ai.conversation.id']).toBe('chat-42');
    expect(tracer.root().ended).toBe(true);
  });

  it('is a no-op (never throws) when OpenTelemetry is absent', () => {
    // No tracer + no @opentelemetry/api in the workspace → returns a no-op scope.
    const scope = liveSpans({ conversationId: 'chat-42' });
    expect(() => scope.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------- V2: G13 parity + G14 run label

describe('spanTree step + agent + label (G13/G14)', () => {
  it('stamps cendor.step, gen_ai.agent.name, cendor.run.id, and the label', () => {
    const tracer = new FakeTracer();
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      traceId: 'run-1',
    });
    const tool = new ToolCall({
      id: 't1',
      name: 'get_weather',
      arguments: { city: 'Paris' },
      traceId: 'run-1',
    });
    const result = new Result({
      output: 'ok',
      traceId: 'run-1',
      steps: [new Step('assistant', 'llm', call), new Step('assistant', 'tool', tool)],
    });
    expect(spanTree(result, tracer, { label: 'weather triage' })).toBe(true);
    expect(tracer.root().attrs['cendor.run.id']).toBe('run-1');
    expect(tracer.root().attrs['cendor.run.label']).toBe('weather triage');
    const children = tracer.spans.slice(1);
    expect(children.map((c) => c.attrs['cendor.step'])).toEqual([1, 2]);
    for (const c of children) expect(c.attrs['gen_ai.agent.name']).toBe('assistant');
  });
});

describe('liveSpans parity — run id, step, rollups, label (G13b/G14)', () => {
  beforeEach(() => bus._reset());
  afterEach(() => bus._reset());

  it('learns run id from the first event, numbers steps, and rolls up usage/cost at close', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer, label: 'refund triage' });
    bus.emit(
      new LLMCall({
        id: '1',
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        usage: new Usage({ inputTokens: 100, outputTokens: 40 }),
        cost: new Money('0.0025'),
        traceId: 'run-9',
      }),
    );
    bus.emit(
      new ToolCall({
        id: 't1',
        name: 'get_weather',
        arguments: { city: 'Paris' },
        traceId: 'run-9',
      }),
    );
    scope.close();

    const root = tracer.root();
    expect(root.attrs['cendor.run.label']).toBe('refund triage');
    expect(root.attrs['cendor.run.id']).toBe('run-9'); // learned from the first event
    expect(root.attrs['cendor.trace_id']).toBe('run-9');
    expect(root.attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(root.attrs['gen_ai.usage.output_tokens']).toBe(40);
    expect(root.attrs['cendor.run.cost_usd']).toBe('0.0025');
    const children = tracer.spans.slice(1);
    expect(children.map((c) => c.attrs['cendor.step'])).toEqual([1, 2]);
  });
});
