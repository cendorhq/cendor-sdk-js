/**
 * OpenTelemetry — the TS port of `cendor.sdk.otel`. Both are no-ops without `@opentelemetry/api`
 * installed (local-first: telemetry export is always opt-in). `spanTree` emits a post-hoc `gen_ai.*`
 * span tree from a finished `Result`; `liveSpans` (v1.1) emits a child span the moment each call lands.
 */
import { createRequire } from 'node:module';
import { LLMCall, ToolCall, bus } from '@cendor/core';
import type { Result, Step } from './types.js';

const require = createRequire(import.meta.url);

interface Span {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}
interface Tracer {
  startSpan(name: string): Span;
}
interface OtelApi {
  trace: { getTracer(name: string): Tracer };
}

function otelApi(): OtelApi | null {
  try {
    return require('@opentelemetry/api') as OtelApi;
  } catch {
    return null;
  }
}

function tracerOf(tracer?: Tracer | null): Tracer | null {
  if (tracer) return tracer;
  const api = otelApi();
  return api ? api.trace.getTracer('cendor.sdk') : null;
}

function stepAttrs(span: Span, step: Step): void {
  span.setAttribute('gen_ai.agent.name', step.agent);
  if (step.call instanceof LLMCall) {
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.request.model', step.call.model);
    if (step.usage) {
      span.setAttribute('gen_ai.usage.input_tokens', step.usage.inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', step.usage.outputTokens);
    }
    if (step.cost) span.setAttribute('gen_ai.usage.cost', step.cost.toString());
  } else if (step.call instanceof ToolCall) {
    span.setAttribute('gen_ai.operation.name', 'execute_tool');
    span.setAttribute('gen_ai.tool.name', step.name);
  }
}

/** Post-hoc `gen_ai.*` span tree from a finished run. Returns false (no-op) without OpenTelemetry. */
export function spanTree(result: Result, tracer?: Tracer | null): boolean {
  const tr = tracerOf(tracer);
  if (!tr) return false;
  const root = tr.startSpan('agent.run');
  root.setAttribute('cendor.trace_id', result.traceId);
  for (const step of result.steps) {
    const span = tr.startSpan(
      step.call instanceof LLMCall ? `chat ${step.name}` : `execute_tool ${step.name}`,
    );
    span.setAttribute('cendor.trace_id', step.traceId);
    stepAttrs(span, step);
    span.end();
  }
  root.end();
  return true;
}

/** A disposable scope that emits a live child span per call. No-op without OpenTelemetry. */
export function liveSpans(opts: { tracer?: Tracer | null; name?: string } = {}): { close(): void } {
  const tr = tracerOf(opts.tracer);
  if (!tr) return { close() {} };
  const root = tr.startSpan(opts.name ?? 'agent.run');
  const sub = (event: unknown): void => {
    if (!(event instanceof LLMCall || event instanceof ToolCall)) return;
    const span = tr.startSpan(
      event instanceof LLMCall ? `chat ${event.model}` : `execute_tool ${event.name}`,
    );
    span.setAttribute('cendor.trace_id', event.traceId);
    if (event instanceof LLMCall && event.usage) {
      span.setAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens);
    }
    span.end();
  };
  bus.subscribe(sub);
  return {
    close() {
      bus.unsubscribe(sub);
      root.end();
    },
  };
}
