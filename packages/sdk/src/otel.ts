/**
 * OpenTelemetry — the TS port of `cendor.sdk.otel`. Both are no-ops without `@opentelemetry/api`
 * installed (local-first: telemetry export is always opt-in). `spanTree` emits a post-hoc `gen_ai.*`
 * span tree from a finished `Result`; `liveSpans` (v1.1) emits a child span the moment each call lands.
 */
import { createRequire } from 'node:module';
import { LLMCall, Money, ToolCall, bus } from '@cendor/core';
import { currentAgent } from './governance.js';
import type { Result, Step } from './types.js';

const require = createRequire(import.meta.url);

interface Span {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}
/** `context`/`startTime` are optional; a fake tracer may ignore them (the real OTel one nests). */
interface Tracer {
  startSpan(name: string, options?: { startTime?: number }, context?: unknown): Span;
}
interface OtelApi {
  trace: { getTracer(name: string): Tracer; setSpan(context: unknown, span: Span): unknown };
  context: { active(): unknown };
}

function otelApi(): OtelApi | null {
  try {
    return require('@opentelemetry/api') as OtelApi;
  } catch {
    return null;
  }
}

/** Resolve the tracer + (when using the real global API) the context helpers needed to NEST child
 * spans under the run root. An injected tracer skips nesting (fakes don't model context; the real
 * API does). */
function resolve(tracer?: Tracer | null): { tr: Tracer; api: OtelApi | null } | null {
  if (tracer) return { tr: tracer, api: null };
  const api = otelApi();
  return api ? { tr: api.trace.getTracer('cendor.sdk'), api } : null;
}

/** A context that parents children under `root` (real API only; `undefined` with an injected fake). */
function childContext(api: OtelApi | null, root: Span): unknown {
  return api ? api.trace.setSpan(api.context.active(), root) : undefined;
}

function stepAttrs(span: Span, step: Step, stepNo: number): void {
  span.setAttribute('gen_ai.agent.name', step.agent);
  span.setAttribute('cendor.step', stepNo); // 1-based ordinal across the run (G13)
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

/**
 * Post-hoc `gen_ai.*` span tree from a finished run. Returns false (no-op) without OpenTelemetry.
 * Pass `conversationId` (e.g. your session store key) to stamp `gen_ai.conversation.id` on the root
 * `agent.run` span so multi-turn runs group as one conversation.
 *
 * Pass `label` to stamp a short, human-authored `cendor.run.label` on the root — never derived from
 * the prompt (prompts/tool values stay off spans by design; a label is a tag you choose).
 *
 * @example
 * ```ts
 * import { spanTree } from '@cendor/sdk';
 * spanTree(result, undefined, { conversationId: 'chat-42', label: 'refund triage' });
 * ```
 */
export function spanTree(
  result: Result,
  tracer?: Tracer | null,
  opts: { conversationId?: string; label?: string } = {},
): boolean {
  const r = resolve(tracer);
  if (!r) return false;
  const { tr, api } = r;
  const root = tr.startSpan('agent.run');
  root.setAttribute('cendor.run.id', result.traceId);
  root.setAttribute('cendor.trace_id', result.traceId);
  if (opts.conversationId) root.setAttribute('gen_ai.conversation.id', opts.conversationId);
  if (opts.label) root.setAttribute('cendor.run.label', opts.label);
  const ctx = childContext(api, root); // nest call spans UNDER the run root (one trace)
  let stepNo = 0;
  for (const step of result.steps) {
    stepNo += 1;
    const span = tr.startSpan(
      step.call instanceof LLMCall ? `chat ${step.name}` : `execute_tool ${step.name}`,
      undefined,
      ctx,
    );
    span.setAttribute('cendor.trace_id', step.traceId);
    stepAttrs(span, step, stepNo);
    span.end();
  }
  root.end();
  return true;
}

/**
 * A disposable scope that emits a live child span per call. No-op without OpenTelemetry.
 * Pass `conversationId` (e.g. your session store key) to stamp `gen_ai.conversation.id` on the root
 * `agent.run` span so multi-turn runs group as one conversation.
 *
 * Each child carries the making agent's `gen_ai.agent.name` and a 1-based `cendor.step`; the root
 * learns `cendor.run.id` / `cendor.trace_id` from the first event and, at `close()`, carries the
 * run's usage/cost rollups — parity with `spanTree`. Pass `label` for a short, human-authored
 * `cendor.run.label` (never the prompt).
 *
 * @example
 * ```ts
 * import { liveSpans } from '@cendor/sdk';
 * const spans = liveSpans({ conversationId: 'chat-42', label: 'refund triage' });
 * // run your agent here…
 * spans.close();
 * ```
 */
export function liveSpans(
  opts: { tracer?: Tracer | null; name?: string; conversationId?: string; label?: string } = {},
): { close(): void } {
  const r = resolve(opts.tracer);
  if (!r) return { close() {} };
  const { tr, api } = r;
  const root = tr.startSpan(opts.name ?? 'agent.run');
  if (opts.conversationId) root.setAttribute('gen_ai.conversation.id', opts.conversationId);
  if (opts.label) root.setAttribute('cendor.run.label', opts.label);
  const ctx = childContext(api, root); // nest each live child UNDER the run root (one trace)
  let stepNo = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = Money.zero();
  let runIdSet = false;
  const sub = (event: unknown): void => {
    if (!(event instanceof LLMCall || event instanceof ToolCall)) return;
    const traceId = event.traceId ?? '';
    if (!runIdSet && traceId) {
      // Learn the run/correlation id from the first observed event (the trace scope is entered
      // inside run(), after this root span was created) — parity with spanTree's cendor.run.id.
      root.setAttribute('cendor.run.id', traceId);
      root.setAttribute('cendor.trace_id', traceId);
      runIdSet = true;
    }
    stepNo += 1;
    // Agent name: the ambient current agent, falling back to the event's stamped metadata.
    const meta = (event as { metadata?: Record<string, unknown> }).metadata;
    const agent = currentAgent() || (typeof meta?.agent === 'string' ? meta.agent : '');
    const span = tr.startSpan(
      event instanceof LLMCall ? `chat ${event.model}` : `execute_tool ${event.name}`,
      undefined,
      ctx,
    );
    span.setAttribute('cendor.trace_id', traceId);
    span.setAttribute('cendor.step', stepNo);
    if (agent) span.setAttribute('gen_ai.agent.name', agent);
    if (event instanceof LLMCall) {
      span.setAttribute('gen_ai.operation.name', 'chat');
      span.setAttribute('gen_ai.request.model', event.model);
      if (event.usage) {
        span.setAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens);
        totalInput += event.usage.inputTokens;
        totalOutput += event.usage.outputTokens;
      }
      if (event.cost) {
        span.setAttribute('gen_ai.usage.cost', event.cost.toString());
        totalCost = totalCost.add(event.cost);
      }
    } else {
      span.setAttribute('gen_ai.operation.name', 'execute_tool');
      span.setAttribute('gen_ai.tool.name', event.name);
    }
    span.end();
  };
  bus.subscribe(sub);
  return {
    close() {
      bus.unsubscribe(sub);
      // Usage/cost rollups on the root at close — parity with spanTree's finished totals.
      root.setAttribute('gen_ai.usage.input_tokens', totalInput);
      root.setAttribute('gen_ai.usage.output_tokens', totalOutput);
      root.setAttribute('cendor.run.cost_usd', totalCost.amount.toString());
      root.end();
    },
  };
}
