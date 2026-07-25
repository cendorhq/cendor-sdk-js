/**
 * The SDK's automatic run scope (DR-1 / W1.4): a governed run is visible with zero telemetry code.
 * TS mirror of cendor-sdk's tests/test_auto_run_scope.py.
 *
 * `run()` opens the existing `liveSpans` machinery itself when telemetry is on, the app has
 * configured an OpenTelemetry provider, and no explicit scope is open. An explicit `liveSpans()`
 * still wins (one root, never two); `CENDOR_TELEMETRY=off` disables it. The scope is closed in a
 * `finally` the SDK owns, so the unclosed-handle foot-gun of the public API does not apply here.
 *
 * Observed through a real in-memory exporter installed as the GLOBAL provider — which is the point:
 * the app configures OTel normally and writes no Cendor telemetry code.
 */
import { AuditLog } from '@cendor/acttrace';
import { bus } from '@cendor/core';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, Session, liveSpans, run } from '../src/index.js';
import { isolate, openaiChat, streamTextChunk, streamUsage, stubOpenAIStream } from './_helpers.js';
import { stubOpenAI } from './_helpers.js';

isolate();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function installProvider(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  // A real app's OTel setup (NodeSDK / provider.register()) also installs a context manager; audit ↔
  // run correlation needs one, so the test models a real app rather than a bare provider.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}
const names = (): string[] => exporter.getFinishedSpans().map((s) => s.name);

function agentWith(...replies: string[]): Agent {
  return new Agent({
    name: 'assistant',
    model: 'gpt-4o',
    client: stubOpenAI(replies.map((content) => openaiChat({ content }))),
  });
}

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  installProvider();
});
afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  bus._reset();
});

describe('the automatic run scope', () => {
  it('a zero-code run produces a root and children', async () => {
    const result = await run(agentWith('hello'), 'hi');
    expect(result.output).toBe('hello');
    const spans = exporter.getFinishedSpans();
    expect(names()).toContain('agent.run');
    expect(names()).toContain('chat gpt-4o');
    const root = spans.find((s) => s.name === 'agent.run')!;
    const chat = spans.find((s) => s.name === 'chat gpt-4o')!;
    expect(chat.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(root.attributes['gen_ai.operation.name']).toBe('agent');
    expect(Number(root.attributes['gen_ai.usage.input_tokens'])).toBeGreaterThan(0);
    expect(root.attributes['cendor.run.label']).toBeUndefined(); // never invented
  });

  it('the session id becomes the conversation id', async () => {
    const session = new Session([], 'chat-42');
    await run(agentWith('hello'), 'hi', { session });
    const root = exporter.getFinishedSpans().find((s) => s.name === 'agent.run')!;
    expect(root.attributes['gen_ai.conversation.id']).toBe('chat-42');
  });

  it('an explicit scope still wins — exactly one root', async () => {
    const spans = liveSpans({ label: 'refund triage' });
    try {
      await run(agentWith('hello'), 'hi');
    } finally {
      spans.close();
    }
    const roots = exporter.getFinishedSpans().filter((s) => s.name === 'agent.run');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.attributes['cendor.run.label']).toBe('refund triage');
  });

  it('CENDOR_TELEMETRY=off produces nothing', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    await run(agentWith('hello'), 'hi');
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('no provider configured produces nothing, and never throws', async () => {
    trace.disable();
    const result = await run(agentWith('hello'), 'hi');
    expect(result.output).toBe('hello');
  });

  it('governance correlates to the auto scope', async () => {
    const audit = new AuditLog('support'); // its mirror auto-attaches too (DR-2a)
    try {
      await run(agentWith('hello'), 'hi', { audit });
    } finally {
      audit.detach();
    }
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'agent.run')!;
    const auditSpans = spans.filter((s) => s.name.startsWith('audit.'));
    expect(auditSpans.length).toBeGreaterThan(0);
    expect(auditSpans.some((s) => s.spanContext().traceId === root.spanContext().traceId)).toBe(
      true,
    );
  });

  it('a throwing run still closes the auto scope', async () => {
    const agent = new Agent({
      name: 'boom',
      model: 'gpt-4o',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('boom');
            },
          },
        },
      } as never,
    });
    await expect(run(agent, 'hi')).rejects.toThrow();
    const { otel } = await import('@cendor/core');
    expect(otel.liveSpansActive()).toBe(false);
    expect(names()).toContain('agent.run');
  });

  function streamingAgent(): Agent {
    return new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      client: stubOpenAIStream([
        streamTextChunk('hel'),
        streamTextChunk('lo'),
        streamUsage(5, 2),
      ]) as never,
    });
  }

  it('the stream path auto-scopes exactly once', async () => {
    const events: unknown[] = [];
    for await (const ev of run.stream(streamingAgent(), 'hi')) events.push(ev);
    expect(events.length).toBeGreaterThan(0);
    expect(names().filter((n) => n === 'agent.run')).toHaveLength(1);
    // No double render: the streamed call appears once (as the run's child), not also as a flat span.
    expect(names().filter((n) => n === 'chat gpt-4o')).toHaveLength(1);
  });

  it('abandoning a stream still closes the scope', async () => {
    for await (const _ev of run.stream(streamingAgent(), 'hi')) break;
    const { otel } = await import('@cendor/core');
    expect(otel.liveSpansActive()).toBe(false);
  });

  it('two concurrent runs each get their own root, correctly parented', async () => {
    await Promise.all([run(agentWith('a'), 'hi'), run(agentWith('b'), 'hi')]);
    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((s) => s.name === 'agent.run');
    expect(roots).toHaveLength(2);
    const chats = spans.filter((s) => s.name === 'chat gpt-4o');
    expect(chats).toHaveLength(2);
    // Each chat's parent is a root, and the two chats do NOT share one parent (the module-global
    // scope stack used to hand both runs the innermost root — see the ALS scope registry).
    const parents = chats.map((c) => c.parentSpanContext?.spanId);
    expect(new Set(parents).size).toBe(2);
    for (const p of parents) expect(roots.map((r) => r.spanContext().spanId)).toContain(p);
  });

  // ------------------------------------------------------------------ GLR-3: no cross-run adoption
  // These four use clients with REAL latency, so the runs genuinely overlap. With zero-latency stubs
  // a run finishes before the next one starts and the bus never interleaves — which is why the defect
  // below survived the wave: every acceptance probe was sequential.
  /** An openai-shaped client whose completion takes `ms`, so two runs are in flight at once. */
  function slowAgent(model: string, content: string, ms: number): Agent {
    return new Agent({
      name: 'assistant',
      model,
      client: {
        chat: {
          completions: {
            create: async () => {
              await new Promise((r) => setTimeout(r, ms));
              return openaiChat({ content });
            },
          },
        },
      } as never,
    });
  }
  /** Each run's own root, keyed by the run id it learned. */
  function rootsByRunId(): Map<string, string> {
    return new Map(
      exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'agent.run')
        .map((s) => [String(s.attributes['cendor.run.id'] ?? ''), s.spanContext().spanId]),
    );
  }

  it('two OVERLAPPING runs never adopt each other’s calls', async () => {
    await Promise.all([
      run(slowAgent('gpt-4o-mini', 'a', 30), 'hi'),
      run(slowAgent('gpt-4.1-mini', 'b', 10), 'hi'),
    ]);
    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((s) => s.name === 'agent.run');
    expect(roots).toHaveLength(2);
    // Each root learned its OWN run id (both used to end up with the id of whichever run emitted
    // first) and each call was rendered exactly once, under the root of the run that made it.
    const byRunId = rootsByRunId();
    expect(byRunId.size).toBe(2);
    expect([...byRunId.keys()].every(Boolean)).toBe(true);
    const chats = spans.filter((s) => s.name.startsWith('chat '));
    expect(chats.map((c) => c.name).sort()).toEqual(['chat gpt-4.1-mini', 'chat gpt-4o-mini']);
    for (const c of chats) {
      expect(c.parentSpanContext?.spanId).toBe(
        byRunId.get(String(c.attributes['cendor.trace_id'])),
      );
    }
  });

  it('a stream in flight does not silence a concurrent run', async () => {
    const stream = run.stream(streamingAgent(), 'hi')[Symbol.asyncIterator]();
    await stream.next(); // the stream's scope is open
    // The automatic stream scope is bound to the STREAM's async context, so the consumer's context is
    // clean: a concurrent run still opens its own scope (it used to see a process-wide latch and emit
    // nothing at all — neither a root nor a flat span).
    const { otel } = await import('@cendor/core');
    expect(otel.liveSpansActive()).toBe(false);
    await run(slowAgent('gpt-4.1-mini', 'b', 5), 'hi');
    while (!(await stream.next()).done) {
      /* drain */
    }
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name === 'agent.run')).toHaveLength(2);
    expect(
      spans
        .filter((s) => s.name.startsWith('chat '))
        .map((s) => s.name)
        .sort(),
    ).toEqual(['chat gpt-4.1-mini', 'chat gpt-4o']);
  });

  it('a run-less libs-only call is not adopted into a run', async () => {
    const { LLMCall, Usage } = await import('@cendor/core');
    await Promise.all([
      run(slowAgent('gpt-4o-mini', 'a', 25), 'hi'),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        bus.emit(
          new LLMCall({
            id: 'x1',
            provider: 'openai',
            model: 'libs-only-model',
            messages: [],
            usage: new Usage(10, 5),
          }),
        );
      })(),
    ]);
    // A call with no run id belongs to no run: core's flat emitter renders it, the run scope must not
    // (it used to become the run's step 1, putting a foreign call's cost inside the run).
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'agent.run')!;
    const children = spans.filter((s) => s.parentSpanContext?.spanId === root.spanContext().spanId);
    expect(children.map((c) => c.name)).toEqual(['chat gpt-4o-mini']);
  });

  it('a STREAMED run correlates its governance to the run trace', async () => {
    const audit = new AuditLog('support'); // its mirror auto-attaches (DR-2a)
    try {
      for await (const _ev of run.stream(streamingAgent(), 'hi', { audit })) {
        /* drain */
      }
    } finally {
      audit.detach();
    }
    // Parity with the blocking path (and with Python): the run root is the active span inside the
    // stream too, so the mirrored audit spans land in the run's trace. Binding the scope around the
    // generator's *creation* achieved nothing — an async generator body resumes in the CONSUMER's
    // context — so this was 0 of 5 before the scope moved to each resumption.
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'agent.run')!;
    const audits = spans.filter((s) => s.name.startsWith('audit.'));
    expect(audits.length).toBeGreaterThan(0);
    expect(
      audits.filter((a) => a.spanContext().traceId === root.spanContext().traceId).length,
    ).toBeGreaterThan(0);
  });
});
