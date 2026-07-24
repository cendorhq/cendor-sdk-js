/**
 * E-wave SDK domain telemetry (TS parity with `tests/test_domain_spans.py`): RAG / memory /
 * orchestration / checkpoints / tools / MCP `cendor.sdk` spans. `@opentelemetry/api` is an optional
 * peer, absent in this workspace, so — like `otel.test.ts` — we inject a fake tracer and drive events
 * through the bus; the real-exporter assertions live on the Python side (test_domain_spans.py).
 */
import { ToolCall, bus, trace } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CheckpointEvent,
  MemoryOp,
  OrchestrationEdge,
  ToolGate,
  _resetTelemetryRegistries,
  registerToolSource,
  toolSource,
} from '../src/_telemetry.js';
import { liveSpans, loadMcpTools } from '../src/index.js';

class FakeSpan {
  attrs: Record<string, unknown> = {};
  ended = false;
  name: string;
  constructor(name = '') {
    this.name = name;
  }
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = value;
  }
  end(): void {
    this.ended = true;
  }
}
class FakeTracer {
  spans: FakeSpan[] = [];
  startSpan(name: string): FakeSpan {
    const s = new FakeSpan(name);
    this.spans.push(s);
    return s;
  }
  root(): FakeSpan {
    const r = this.spans[0];
    if (!r) throw new Error('no span started');
    return r;
  }
  named(name: string): FakeSpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}

describe('E-wave domain spans', () => {
  beforeEach(() => {
    bus._reset();
    _resetTelemetryRegistries();
  });
  afterEach(() => {
    bus._reset();
    _resetTelemetryRegistries();
  });

  it('memory.load / memory.save', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(new MemoryOp('load', 'chat-7', 1, 42, 'run-1'));
    bus.emit(new MemoryOp('save', 'chat-7', 3, 99, 'run-1'));
    scope.close();
    const load = tracer.named('memory.load')[0]!;
    expect(load.attrs['cendor.memory.op']).toBe('load');
    expect(load.attrs['cendor.memory.session_id']).toBe('chat-7');
    expect(load.attrs['gen_ai.conversation.id']).toBe('chat-7');
    expect(load.attrs['cendor.sdk.kind']).toBe('memory.load');
    expect(load.attrs['cendor.memory.turns']).toBe(1);
    expect(tracer.named('memory.save')[0]!.attrs['cendor.memory.turns']).toBe(3);
    expect(tracer.root().attrs['cendor.run.id']).toBe('run-1'); // family learned from the first event
  });

  it('checkpoint.save / checkpoint.resume', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(new CheckpointEvent('save', 'run-1', true, 5, 2));
    bus.emit(new CheckpointEvent('resume', 'run-1', false, 5));
    scope.close();
    const save = tracer.named('checkpoint.save')[0]!;
    expect(save.attrs['cendor.checkpoint.op']).toBe('save');
    expect(save.attrs['cendor.checkpoint.done']).toBe(true);
    expect(save.attrs['cendor.checkpoint.segment']).toBe(2);
    expect(tracer.named('checkpoint.resume')[0]!.attrs['cendor.checkpoint.op']).toBe('resume');
  });

  it('orchestration.handoff, learning the family from the edge', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(new OrchestrationEdge('planner', 'writer', 0, 'transfer_to_writer', 'run-xyz'));
    scope.close();
    const edge = tracer.named('orchestration.handoff')[0]!;
    expect(edge.attrs['cendor.orch.from_agent']).toBe('planner');
    expect(edge.attrs['cendor.orch.to_agent']).toBe('writer');
    expect(edge.attrs['cendor.orch.segment']).toBe(0);
    expect(edge.attrs['cendor.orch.transfer_tool']).toBe('transfer_to_writer');
    expect(tracer.root().attrs['cendor.run.id']).toBe('run-xyz');
  });

  it('blocked tool → execute_tool span with outcome=blocked', () => {
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    bus.emit(new ToolGate('delete_everything', 'no-destructive-ops', 'run-abc', 'assistant'));
    scope.close();
    const blocked = tracer.named('execute_tool delete_everything')[0]!;
    expect(blocked.attrs['cendor.tool.outcome']).toBe('blocked');
    expect(blocked.attrs['cendor.tool.blocked_by']).toBe('no-destructive-ops');
    expect(blocked.attrs['cendor.tool.source']).toBe('local');
    expect(blocked.attrs['gen_ai.agent.name']).toBe('assistant');
    expect(blocked.attrs['cendor.trace_id']).toBe('run-abc');
  });

  it('rag.assemble / rag.compress from library-shaped events (dispatched by class name)', () => {
    // The subscriber dispatches by event.constructor.name; faithful stand-ins with the real field
    // shapes exercise the extraction offline (contextkit camelCase, squeeze snake_case).
    class AssemblyReport {
      budget = 1000;
      used = 640;
      reservedOutput = 256;
      model = 'gpt-4o';
      decisions = [
        { action: 'kept', tokensBefore: 400, tokensAfter: 400 },
        { action: 'dropped', tokensBefore: 300, tokensAfter: 0 },
      ];
    }
    class CompressionEvent {
      technique = 'extractive';
      tokens_before = 800;
      tokens_after = 200;
      ratio = 0.25;
      store_kind = 'memory';
      kind = 'text';
      trace_id = 'run-rag';
    }
    const tracer = new FakeTracer();
    const scope = liveSpans({ tracer });
    // AssemblyReport carries no trace id (like the real one) → resolved from the ambient run scope.
    trace('run-rag', () => bus.emit(new AssemblyReport()));
    bus.emit(new CompressionEvent());
    scope.close();
    const asm = tracer.named('rag.assemble')[0]!;
    expect(asm.attrs['cendor.rag.budget']).toBe(1000);
    expect(asm.attrs['cendor.rag.kept']).toBe(1);
    expect(asm.attrs['cendor.rag.dropped']).toBe(1);
    expect(asm.attrs['cendor.rag.tokens_before']).toBe(700);
    const comp = tracer.named('rag.compress')[0]!;
    expect(comp.attrs['cendor.rag.technique']).toBe('extractive');
    expect(comp.attrs['cendor.rag.tokens_after']).toBe(200);
  });

  it('execute_tool span carries source=mcp when the tool is registered', () => {
    const tracer = new FakeTracer();
    registerToolSource('get_weather', 'mcp', 'weather-mcp', 'stdio');
    const scope = liveSpans({ tracer });
    bus.emit(
      new ToolCall({
        id: 't1',
        name: 'get_weather',
        arguments: { city: 'Paris' },
        traceId: 'run-1',
      }),
    );
    scope.close();
    const t = tracer.named('execute_tool get_weather')[0]!;
    expect(t.attrs['cendor.tool.source']).toBe('mcp');
    expect(t.attrs['cendor.tool.mcp.server']).toBe('weather-mcp');
    expect(t.attrs['cendor.tool.mcp.transport']).toBe('stdio');
    expect(t.attrs['cendor.tool.outcome']).toBe('ok');
  });

  it('loadMcpTools registers each tool source and is no-op-safe without OpenTelemetry', async () => {
    const session = {
      listTools: async () => ({
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
          { name: 'fetch', description: 'Fetch', inputSchema: { type: 'object' } },
        ],
      }),
      callTool: async () => ({ content: [{ text: 'ok' }] }),
    };
    const tools = await loadMcpTools(session, { server: 'github', transport: 'stdio' });
    expect(tools.map((t) => t.name).sort()).toEqual(['fetch', 'search']);
    expect(toolSource('search')).toEqual({ source: 'mcp', server: 'github', transport: 'stdio' });
  });
});
