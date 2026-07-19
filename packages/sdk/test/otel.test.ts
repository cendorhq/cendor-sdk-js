/**
 * SDK OTel span helpers — `spanTree`/`liveSpans` and the W6 `conversationId` grouping key.
 * `@opentelemetry/api` is an optional peer, absent in this workspace, so (like acttrace's
 * otel-mirror test) we inject a fake tracer that records `setAttribute` calls rather than assert
 * against a real exporter — the real-exporter assertions live on the Python side (test_live_spans.py).
 * The fake is structurally compatible with the helpers' internal Tracer/Span shape (no `any`).
 */
import { describe, expect, it } from 'vitest';
import { Result, liveSpans, spanTree } from '../src/index.js';

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
