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

// --------------------------------------------- V3: opt-in content (G17/G18), G19 auto id, G22 replay

import { otel } from '@cendor/core';

describe('V3 content + sessions on spanTree/liveSpans', () => {
  beforeEach(() => {
    bus._reset();
    otel.resetCapture();
  });
  afterEach(() => {
    bus._reset();
    otel.resetCapture();
  });

  function chatStep(): Step {
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      traceId: 'run-1',
    });
    call.metadata.response = { choices: [{ message: { content: 'Sunny.' } }] };
    return new Step('assistant', 'llm', call);
  }

  it('captures no content by default', () => {
    const tracer = new FakeTracer();
    spanTree(new Result({ output: 'ok', traceId: 'run-1', steps: [chatStep()] }), tracer);
    const chat = tracer.spans[1];
    expect(chat.attrs[otel.GENAI_INPUT_MESSAGES]).toBeUndefined();
    expect(chat.attrs[otel.GENAI_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('captures input + output messages when opted in', () => {
    otel.captureContent();
    const tracer = new FakeTracer();
    spanTree(new Result({ output: 'ok', traceId: 'run-1', steps: [chatStep()] }), tracer);
    const chat = tracer.spans[1];
    expect(String(chat.attrs[otel.GENAI_INPUT_MESSAGES])).toContain('weather in Paris');
    expect(String(chat.attrs[otel.GENAI_OUTPUT_MESSAGES])).toContain('Sunny');
  });

  it('captures tool arg/result content when opted in', () => {
    otel.captureContent();
    const tracer = new FakeTracer();
    const tool = new ToolCall({
      id: 't',
      name: 'get_weather',
      arguments: { city: 'Paris' },
      result: 'Sunny',
      traceId: 'run-1',
    });
    spanTree(
      new Result({ output: 'ok', traceId: 'run-1', steps: [new Step('a', 'tool', tool)] }),
      tracer,
    );
    expect(String(tracer.spans[1].attrs[otel.CENDOR_TOOL_ARGUMENTS])).toContain('Paris');
  });

  it('reads conversationId from Result on spanTree (G19)', () => {
    const tracer = new FakeTracer();
    spanTree(
      new Result({ output: 'ok', traceId: 'run-1', conversationId: 'chat-9', steps: [] }),
      tracer,
    );
    expect(tracer.root().attrs['gen_ai.conversation.id']).toBe('chat-9');
  });

  it('stamps cendor.replayed on a replayed step (G22)', () => {
    const tracer = new FakeTracer();
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [],
      traceId: 'run-1',
    });
    call.metadata.replayed = true;
    spanTree(
      new Result({ output: 'ok', traceId: 'run-1', steps: [new Step('a', 'llm', call)] }),
      tracer,
    );
    expect(tracer.spans[1].attrs['cendor.replayed']).toBe(true);
  });
});

// ---------------------------------------------- V5: emission truth (G-V4-1 TTFT, G-V4-2 agents, G-V4-3 estimated)

describe('emission truth on spanTree (G-V4-1/2/3)', () => {
  it('stamps ttft + usage_estimated on the chat span and rollups + agents on the root', () => {
    const tracer = new FakeTracer();
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      usage: new Usage({ inputTokens: 100, outputTokens: 40 }),
      cost: new Money('0.0025'),
      traceId: 'run-1',
    });
    call.metadata.ttft_ms = 12.5; // recovered on the first streamed chunk
    call.metadata.usage_estimated = true; // stream reported no usage → offline estimate
    const result = new Result({
      output: 'ok',
      traceId: 'run-1',
      agents: ['assistant'],
      steps: [new Step('assistant', 'llm', call)],
    });
    expect(spanTree(result, tracer)).toBe(true);
    const chat = tracer.spans[1];
    expect(chat.attrs['cendor.ttft_ms']).toBe(12.5); // G-V4-1
    expect(chat.attrs['cendor.usage_estimated']).toBe('true'); // G-V4-3 (string, only when set)
    // parity with the Python span_tree: run rollups + agents on the agent.run root (monitor reads these)
    expect(tracer.root().attrs['cendor.run.agents']).toBe('assistant'); // G-V4-2 parity
    expect(tracer.root().attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(tracer.root().attrs['gen_ai.usage.output_tokens']).toBe(40);
    expect(tracer.root().attrs['cendor.run.cost_usd']).toBe('0.0025');
  });

  it('omits usage_estimated + ttft on a non-streamed call (nothing invented)', () => {
    const tracer = new FakeTracer();
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      traceId: 'run-1',
    });
    spanTree(
      new Result({ output: 'ok', traceId: 'run-1', steps: [new Step('a', 'llm', call)] }),
      tracer,
    );
    expect('cendor.usage_estimated' in tracer.spans[1].attrs).toBe(false);
    expect('cendor.ttft_ms' in tracer.spans[1].attrs).toBe(false);
  });
});

describe('emission truth on liveSpans (G-V4-1/2/3)', () => {
  beforeEach(() => bus._reset());
  afterEach(() => bus._reset());

  it('stamps ttft + usage_estimated on the chat span and agents on the root', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      usage: new Usage({ inputTokens: 100, outputTokens: 40 }),
      cost: new Money('0.0025'),
      traceId: 'run-9',
    });
    call.metadata.ttft_ms = 9.75;
    call.metadata.usage_estimated = true;
    call.metadata.agent = 'assistant'; // liveSpans reads currentAgent() || metadata.agent
    bus.emit(call);
    scope.close();
    const chat = tracer.spans[1];
    expect(chat.attrs['cendor.ttft_ms']).toBe(9.75); // G-V4-1
    expect(chat.attrs['cendor.usage_estimated']).toBe('true'); // G-V4-3
    expect(tracer.root().attrs['cendor.run.agents']).toBe('assistant'); // G-V4-2
  });
});

describe('liveSpans run-family filter + ambient agent/conversation (GLR-2/3)', () => {
  beforeEach(() => bus._reset());
  afterEach(() => bus._reset());

  const call = (traceId: string, meta: Record<string, unknown> = {}): LLMCall => {
    const c = new LLMCall({
      id: traceId,
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      usage: new Usage({ inputTokens: 10, outputTokens: 5 }),
      traceId,
    });
    Object.assign(c.metadata, meta);
    return c;
  };

  it('renders only THIS run family, dropping a concurrent run (GLR-3)', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(call('run-A')); // first event → learns family 'run-A'
    bus.emit(call('run-B')); // concurrent run → filtered out
    bus.emit(call('run-A')); // same run → rendered
    scope.close();
    // spans[0] is the root; only the two run-A calls become child spans.
    expect(tracer.spans.filter((s) => s.attrs['gen_ai.operation.name'] === 'chat')).toHaveLength(2);
    expect(tracer.root().attrs['cendor.run.id']).toBe('run-A');
  });

  it('accepts orchestration segments of the same family, drops another family (GLR-3)', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(call('parent:agentA#0')); // learns family 'parent'
    bus.emit(call('parent:agentB#1')); // same family → rendered
    bus.emit(call('other:agentC#0')); // different family → dropped
    scope.close();
    expect(tracer.spans.filter((s) => s.attrs['gen_ai.operation.name'] === 'chat')).toHaveLength(2);
    expect(tracer.root().attrs['cendor.run.id']).toBe('parent'); // normalized to the family root
  });

  it('stamps agent + conversation from event metadata when the scope has exited (GLR-2)', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer }); // no explicit conversationId; no active ALS scope
    bus.emit(call('run-9', { agent: 'reviewer', conversation_id: 'chat-42' }));
    scope.close();
    const chat = tracer.spans[1];
    expect(chat.attrs['gen_ai.agent.name']).toBe('reviewer');
    expect(tracer.root().attrs['gen_ai.conversation.id']).toBe('chat-42');
  });

  it('stamps reasoning tokens on the child span (GLR-2 rider)', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    const c = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [],
      usage: new Usage({ inputTokens: 100, outputTokens: 40, reasoningTokens: 12 }),
      traceId: 'run-9',
    });
    bus.emit(c);
    scope.close();
    expect(tracer.spans[1].attrs['gen_ai.usage.reasoning_tokens']).toBe(12);
  });
});
