/**
 * OpenTelemetry — the TS port of `cendor.sdk.otel`. Both are no-ops without `@opentelemetry/api`
 * installed (local-first: telemetry export is always opt-in). `spanTree` emits a post-hoc `gen_ai.*`
 * span tree from a finished `Result`; `liveSpans` (v1.1) emits a child span the moment each call lands.
 */
import { createRequire } from 'node:module';
import { LLMCall, Money, ToolCall, bus, otel as coreOtel } from '@cendor/core';
import { currentAgent, currentConversation } from './governance.js';
import type { Result, Step } from './types.js';

const require = createRequire(import.meta.url);

interface Span {
  setAttribute(key: string, value: unknown): void;
  /** `endTime` (epoch ms) backdates the span's end so live child durations are accurate (S8). */
  end(endTime?: number): void;
}
/** `context`/`startTime` are optional; a fake tracer may ignore them (the real OTel one nests). */
interface Tracer {
  startSpan(name: string, options?: { startTime?: number }, context?: unknown): Span;
}
interface OtelApi {
  trace: { getTracer(name: string): Tracer; setSpan(context: unknown, span: Span): unknown };
  context: { active(): unknown; with<T>(context: unknown, fn: () => T): T };
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

/**
 * Open `liveSpans` scopes (innermost last), each holding the real OTel API + the run root's child
 * context. The runner uses the innermost to install the run root as the ACTIVE context span for the
 * run body — see {@link withLiveRootActive}.
 */
const liveScopes: Array<{ api: OtelApi; ctx: unknown }> = [];

/**
 * Run `fn` with the innermost open `liveSpans` root installed as the **active context span** (parity
 * with Python's `start_as_current_span`), so audit entries emitted during the run carry the run's
 * trace id (`@cendor/acttrace` correlation) and `audit.*` mirror spans nest under the run trace.
 *
 * A **no-op that just runs `fn`** when no `liveSpans` scope is open, or when `@opentelemetry/api` /
 * its context manager is absent (`liveSpans` registers a scope only when the real API resolved). It
 * composes with a caller's own active span (the scope's context was captured from `context.active()`
 * when `liveSpans` opened) rather than replacing it, and the activation is confined to `fn`.
 *
 * @internal called by the runner/orchestration around each run body.
 */
export function withLiveRootActive<T>(fn: () => T): T {
  const top = liveScopes[liveScopes.length - 1];
  return top ? top.api.context.with(top.ctx, fn) : fn();
}

/** Best-effort system prompt from a call's request kwargs — for providers where the system prompt
 * is a kwarg (Anthropic `system`, Responses `instructions`, Gemini `system_instruction`, Bedrock
 * `system`), not a message. For chat-completions/Ollama it's already in `call.messages`. */
function systemFromCall(call: LLMCall): unknown {
  const kw = (call.metadata as Record<string, unknown>)?.request_kwargs as
    | Record<string, unknown>
    | undefined;
  if (!kw || typeof kw !== 'object') return undefined;
  for (const key of ['instructions', 'system', 'system_instruction']) {
    if (kw[key]) return kw[key];
  }
  const cfg = kw.config as Record<string, unknown> | undefined;
  if (cfg && typeof cfg === 'object' && cfg.system_instruction) return cfg.system_instruction;
  return undefined;
}

/** `gen_ai.*` content attrs for a chat call (G17/G18), or `{}` when capture is off. */
function callContentAttrs(call: LLMCall): Record<string, string> {
  return coreOtel.contentAttrs({
    system: systemFromCall(call),
    inputMessages: call.messages,
    outputMessages: coreOtel.responseMessages(call),
  });
}

/** Tool arg/result content attrs (G17), or `{}` when capture is off. */
function toolContentAttrsFor(call: ToolCall): Record<string, string> {
  return coreOtel.toolContentAttrs(call.arguments, call.result);
}

/**
 * S7: enrich an LLM span with provider, real latency, finish reason, streamed flag, and any recorded
 * error — parity with Python `otel._set_call_attrs` (+ `gen_ai.system`). `ttft_ms` / `usage_estimated`
 * / `replayed` stay stamped at the call sites (already present) to match the Python layout exactly.
 */
function setCallAttrs(span: Span, call: LLMCall): void {
  span.setAttribute('gen_ai.system', call.provider);
  if (call.latencyMs != null) span.setAttribute('gen_ai.latency_ms', call.latencyMs);
  const meta = call.metadata ?? {};
  const finish = meta.finish_reason;
  if (finish) span.setAttribute('gen_ai.response.finish_reason', String(finish));
  if (meta.streamed) span.setAttribute('gen_ai.response.streamed', true);
  const err = meta.error;
  if (err) {
    span.setAttribute('error', true);
    span.setAttribute('gen_ai.error', String(err));
  }
}

/**
 * S7: enrich a tool span with latency and argument *names* (values omitted — may be sensitive).
 * Parity with Python `otel._set_tool_attrs` (unwraps a nested `kwargs` dict, like the Python helper).
 */
function setToolAttrs(span: Span, call: ToolCall): void {
  if (call.latencyMs != null) span.setAttribute('gen_ai.latency_ms', call.latencyMs);
  const args = call.arguments;
  if (args && typeof args === 'object') {
    const kw = (args as Record<string, unknown>).kwargs;
    const src = kw && typeof kw === 'object' ? (kw as Record<string, unknown>) : args;
    const names = Object.keys(src);
    if (names.length > 0) span.setAttribute('gen_ai.tool.arg_names', names.sort().join(','));
  }
}

/** S9: contiguous groups of steps by agent, preserving order — parity with Python `_group_by_agent`. */
function groupByAgent(steps: readonly Step[]): Array<[string, Step[]]> {
  const groups: Array<[string, Step[]]> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last[0] === step.agent) last[1].push(step);
    else groups.push([step.agent, [step]]);
  }
  return groups;
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
      if (step.usage.reasoningTokens) {
        span.setAttribute('gen_ai.usage.reasoning_tokens', step.usage.reasoningTokens);
      }
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
  // G19: fall back to the conversation id the runner propagated from the session key (explicit
  // arg wins). semconv: only a real key is used, never a synthesized one.
  const conversationId = opts.conversationId || result.conversationId || undefined;
  const root = tr.startSpan('agent.run');
  root.setAttribute('gen_ai.operation.name', 'agent');
  root.setAttribute('cendor.run.id', result.traceId);
  root.setAttribute('cendor.trace_id', result.traceId);
  if (conversationId) root.setAttribute('gen_ai.conversation.id', conversationId);
  if (opts.label) root.setAttribute('cendor.run.label', opts.label);
  // Run-level rollups on the root — parity with the Python span_tree (a monitor reads run tokens /
  // cost / agents off the agent.run root). G-V4-2: agents on the root fills the runs-list column.
  root.setAttribute('cendor.run.agents', result.agents.join(','));
  root.setAttribute('gen_ai.usage.input_tokens', result.usage.inputTokens);
  root.setAttribute('gen_ai.usage.output_tokens', result.usage.outputTokens);
  root.setAttribute('cendor.run.cost_usd', result.cost.amount.toString());
  const rootCtx = childContext(api, root); // nest the per-agent segment spans UNDER the run root
  let stepNo = 0; // 1-based ordinal across the whole run (matches liveSpans' cendor.step)
  // S9: 3-level tree (root → `agent {name}` segment → call spans), parity with Python span_tree.
  for (const [agentName, group] of groupByAgent(result.steps)) {
    const agentSpan = tr.startSpan(`agent ${agentName}`, undefined, rootCtx);
    agentSpan.setAttribute('gen_ai.operation.name', 'invoke_agent');
    agentSpan.setAttribute('gen_ai.agent.name', agentName);
    const ctx = childContext(api, agentSpan); // nest this agent's call spans under its segment span
    for (const step of group) {
      stepNo += 1;
      const span = tr.startSpan(
        step.call instanceof LLMCall ? `chat ${step.name}` : `execute_tool ${step.name}`,
        undefined,
        ctx,
      );
      span.setAttribute('cendor.trace_id', step.traceId);
      stepAttrs(span, step, stepNo);
      if (step.call instanceof LLMCall) {
        setCallAttrs(span, step.call); // S7: gen_ai.system + latency + finish_reason + streamed + error
        const ttft = step.call.metadata?.ttft_ms; // G-V4-1: TTFT inside a governed journey
        if (ttft != null) span.setAttribute('cendor.ttft_ms', ttft as number);
        if (step.call.metadata?.usage_estimated)
          span.setAttribute('cendor.usage_estimated', 'true'); // G-V4-3
        if (step.call.metadata.replayed) span.setAttribute('cendor.replayed', true); // G22
        for (const [k, v] of Object.entries(callContentAttrs(step.call))) span.setAttribute(k, v);
      } else if (step.call instanceof ToolCall) {
        setToolAttrs(span, step.call); // S7: latency + tool.arg_names
        for (const [k, v] of Object.entries(toolContentAttrsFor(step.call)))
          span.setAttribute(k, v);
      }
      span.end();
    }
    agentSpan.end();
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
  coreOtel.enterLiveSpans(); // G20: the core bus→span emitter stands down while we own the spans
  const root = tr.startSpan(opts.name ?? 'agent.run');
  if (opts.conversationId) root.setAttribute('gen_ai.conversation.id', opts.conversationId);
  if (opts.label) root.setAttribute('cendor.run.label', opts.label);
  const ctx = childContext(api, root); // nest each live child UNDER the run root (one trace)
  // Register this scope so the runner can make `root` the active context span for the run body
  // (real API only; an injected fake tracer models no context, so it never activates — unchanged).
  const scope = api ? { api, ctx } : null;
  if (scope) liveScopes.push(scope);
  let stepNo = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = Money.zero();
  let runIdSet = false;
  let convSet = Boolean(opts.conversationId);
  let family = ''; // the run-family root, learned from the first event (GLR-3)
  const agentsSeen = new Set<string>(); // ordered-unique agents → cendor.run.agents (G-V4-2)
  const sub = (event: unknown): void => {
    if (!(event instanceof LLMCall || event instanceof ToolCall)) return;
    const traceId = event.traceId ?? '';
    if (!runIdSet && traceId) {
      // Learn the run-family root from the first observed event: the segment before the first ':'
      // (orchestration segments are `${parent}:${agent}#${seg}`; a single-agent run is the bare
      // runId). Matches makeCollector.match + the monitor's run_id normalization.
      family = traceId.includes(':') ? traceId.slice(0, traceId.indexOf(':')) : traceId;
      root.setAttribute('cendor.run.id', family);
      root.setAttribute('cendor.trace_id', family);
      runIdSet = true;
    }
    // GLR-3: render only events from THIS run family — a concurrent run sharing the process bus must
    // not pollute this run's steps / rollups / children (same test as makeCollector.match).
    if (family && traceId !== family && !traceId.startsWith(`${family}:`)) return;
    if (!convSet) {
      // G19: prefer the conversation id stamped on the event at construction (GLR-2 — survives an
      // out-of-scope delivery), else the ambient scope. Only a real key is used, never synthesized.
      const metaCid = (event as { metadata?: Record<string, unknown> }).metadata?.conversation_id;
      const cid = (typeof metaCid === 'string' && metaCid) || currentConversation();
      if (cid) {
        root.setAttribute('gen_ai.conversation.id', cid);
        convSet = true;
      }
    }
    stepNo += 1;
    // Agent name: the ambient current agent, falling back to the event's stamped metadata.
    const meta = (event as { metadata?: Record<string, unknown> }).metadata;
    const agent = currentAgent() || (typeof meta?.agent === 'string' ? meta.agent : '');
    if (agent) agentsSeen.add(agent); // G-V4-2: collect participants for the root
    // S8: backdate the child's start by the call's latency so its duration is accurate (parity with
    // Python live_spans + core's own emitter, which both pass start_time/end_time).
    const end = Date.now();
    const start = end - (event.latencyMs ?? 0);
    const span = tr.startSpan(
      event instanceof LLMCall ? `chat ${event.model}` : `execute_tool ${event.name}`,
      { startTime: start },
      ctx,
    );
    span.setAttribute('cendor.trace_id', traceId);
    span.setAttribute('cendor.step', stepNo);
    if (agent) span.setAttribute('gen_ai.agent.name', agent);
    if (event instanceof LLMCall) {
      span.setAttribute('gen_ai.operation.name', 'chat');
      span.setAttribute('gen_ai.request.model', event.model);
      setCallAttrs(span, event); // S7: gen_ai.system + latency + finish_reason + streamed + error
      if (event.usage) {
        span.setAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens);
        // GLR-2 rider: reasoning tokens on the child span — parity with Python live_spans + core's
        // libs-only emitter (both stamp it); only when nonzero, matching those.
        if (event.usage.reasoningTokens) {
          span.setAttribute('gen_ai.usage.reasoning_tokens', event.usage.reasoningTokens);
        }
        totalInput += event.usage.inputTokens;
        totalOutput += event.usage.outputTokens;
      }
      if (event.cost) {
        span.setAttribute('gen_ai.usage.cost', event.cost.toString());
        totalCost = totalCost.add(event.cost);
      }
      const ttft = event.metadata?.ttft_ms; // G-V4-1: TTFT inside a live governed journey
      if (ttft != null) span.setAttribute('cendor.ttft_ms', ttft as number);
      if (event.metadata?.usage_estimated) span.setAttribute('cendor.usage_estimated', 'true'); // G-V4-3
      if (event.metadata.replayed) span.setAttribute('cendor.replayed', true); // G22
      for (const [k, v] of Object.entries(callContentAttrs(event))) span.setAttribute(k, v);
    } else {
      span.setAttribute('gen_ai.operation.name', 'execute_tool');
      span.setAttribute('gen_ai.tool.name', event.name);
      setToolAttrs(span, event); // S7: latency + tool.arg_names
      for (const [k, v] of Object.entries(toolContentAttrsFor(event))) span.setAttribute(k, v);
    }
    span.end(end); // S8: backdated end time (start was backdated by latency above)
  };
  bus.subscribe(sub);
  return {
    close() {
      bus.unsubscribe(sub);
      if (scope) {
        // Remove THIS scope by identity (safe under nesting / out-of-order close).
        const i = liveScopes.indexOf(scope);
        if (i >= 0) liveScopes.splice(i, 1);
      }
      coreOtel.exitLiveSpans();
      // Usage/cost rollups on the root at close — parity with spanTree's finished totals.
      root.setAttribute('gen_ai.usage.input_tokens', totalInput);
      root.setAttribute('gen_ai.usage.output_tokens', totalOutput);
      root.setAttribute('cendor.run.cost_usd', totalCost.amount.toString());
      // G-V4-2: agents on the root fill the runs-list Agents column for live-streamed runs.
      root.setAttribute('cendor.run.agents', [...agentsSeen].join(','));
      root.end();
    },
  };
}
