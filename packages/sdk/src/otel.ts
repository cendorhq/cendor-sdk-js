/**
 * OpenTelemetry — the TS port of `cendor.sdk.otel`. Both are no-ops without `@opentelemetry/api`
 * installed (local-first: telemetry export is always opt-in). `spanTree` emits a post-hoc `gen_ai.*`
 * span tree from a finished `Result`; `liveSpans` (v1.1) emits a child span the moment each call lands.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { LLMCall, Money, ToolCall, bus, otel as coreOtel, currentTraceId } from '@cendor/core';
import {
  type CheckpointEvent,
  type MemoryOp,
  type OrchestrationEdge,
  type ToolGate,
  toolSource,
} from './_telemetry.js';
import { currentAgent, currentAgentId, currentConversation } from './governance.js';
import { isToolError } from './types.js';
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
 * The wire form of a money value: the **bare decimal**, never `Money.toString()`.
 *
 * `Money.toString()` renders `"0.0000045 USD"`. That is right for the audit chain (a human-readable,
 * hashed evidence artifact, and both languages agree on it) and wrong for a span attribute, which a
 * backend parses as a number: `Number("0.0000045 USD")` is `NaN`. Until `@cendor/sdk` 0.23.3 this door
 * shipped the suffixed form while `@cendor/core` and both Python paths shipped the bare decimal — so
 * the same run cost parsed differently depending on which door emitted it. Kept as a named helper so
 * the next person reaches for the right one. Precision is preserved (decimal.js, never a float).
 */
function costAttr(cost: Money): string {
  return cost.amount.toString();
}

/**
 * Open `liveSpans` scopes (innermost last), each holding the real OTel API + the run root's child
 * context. The runner uses the innermost to install the run root as the ACTIVE context span for the
 * run body — see {@link withLiveRootActive}.
 */
type LiveScope = { api: OtelApi; ctx: unknown };
// Held in AsyncLocalStorage, not a module array: once `run()` opens a scope automatically, a server
// handling concurrent runs would otherwise share ONE global stack and parent run A's children under
// run B's root (the same class of defect as the module-global emitter latch, W0.5). ALS gives each
// async context its own view; a scope opened before an `await` is visible to everything the caller
// then starts, matching Python's ContextVar semantics.
const scopeStore = (() => {
  try {
    return new AsyncLocalStorage<LiveScope[]>();
  } catch {
    return null; // non-Node runtime — fall back to the module array below
  }
})();
let scopesFallback: LiveScope[] = [];

function currentScopes(): LiveScope[] {
  // Manual scopes (module array) plus any automatic scope active in this async context.
  return [...scopesFallback, ...(scopeStore?.getStore() ?? [])];
}
// A manual `liveSpans()` handle is closed by hand, so it has no scope to bind to: it pushes onto the
// module array and `withLiveRootActive` sees it process-wide (the historical behaviour). The SDK's
// AUTOMATIC run scope instead runs the whole run body inside `scopeStore.run([...])`, which is
// correctly scoped on every supported Node — `enterWith` is NOT (measured on node 20.20 / 22.23: it
// leaks into concurrent flows and is not restored on exit; see @cendor/core's latch comment).
/** The registry entry `liveSpans()` pushed most recently — read by `openAutoScope`, which re-binds it
 * to the run body instead of leaving it process-wide. */
let lastPushedScope: LiveScope | null = null;

function pushScope(scope: LiveScope): void {
  scopesFallback = [...scopesFallback, scope];
  lastPushedScope = scope;
}
function removeScope(scope: LiveScope): void {
  scopesFallback = scopesFallback.filter((s) => s !== scope);
}

/** Raise the core live-spans depth for `fn` only (core's `AsyncLocalStorage.run`-based primitive).
 * Falls back to the enter/exit pair when running against a core that predates it. */
function withLiveDepth<T>(fn: () => T): T {
  const core = coreOtel as unknown as { _withLiveSpansDepth?: <R>(f: () => R) => R };
  if (typeof core._withLiveSpansDepth === 'function') return core._withLiveSpansDepth(fn);
  coreOtel.enterLiveSpans();
  try {
    return fn();
  } finally {
    coreOtel.exitLiveSpans();
  }
}

/** Run `fn` with `scope` on the stack for `fn` and everything it starts — and nothing else. */
function withScope<T>(scope: LiveScope | null, fn: () => T): T {
  if (!scopeStore || scope === null) return fn();
  return scopeStore.run([...currentScopes(), scope], fn);
}

// ------------------------------------------------------------------ run-family claims (GLR-3 fix)
// A scope learns which run it belongs to from the first event it observes — but `bus.emit` is a
// process-wide fanout, so with `run()` opening a scope automatically the FIRST event a scope sees can
// belong to a *different, concurrent* run. Measured before this registry existed: two overlapping
// zero-code runs rendered one run's call twice (once under each root), dropped the other's entirely,
// and stamped both roots with the same `cendor.run.id`. So a family may be claimed by exactly one
// open scope: a scope never learns a family another scope already owns, and skips its events.
/** A scope's claim on one run family: its identity token + the registry entry to activate. */
type FamilyOwner = { token: object; scope: LiveScope | null };
const claimedFamilies = new Map<string, FamilyOwner>();

/** The run family of a trace id: orchestration segments are `${parent}:${agent}#${seg}`. */
function familyOf(traceId: string): string {
  return traceId.includes(':') ? traceId.slice(0, traceId.indexOf(':')) : traceId;
}
/** Claim `family` for this scope. False when another open scope already owns it. */
function claimFamily(family: string, owner: FamilyOwner): boolean {
  const held = claimedFamilies.get(family);
  if (held !== undefined) return held.token === owner.token;
  claimedFamilies.set(family, owner);
  return true;
}
function releaseFamily(family: string, owner: FamilyOwner): void {
  if (family && claimedFamilies.get(family)?.token === owner.token) claimedFamilies.delete(family);
}
/** The open scope that owns `traceId`'s run family, if any — so the right run root is activated even
 * when several scopes are visible (two concurrent streams share the consumer's context). */
function scopeOwning(traceId: string): LiveScope | null | undefined {
  if (!traceId) return undefined;
  return claimedFamilies.get(familyOf(traceId))?.scope;
}

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
  // Prefer the scope that owns the ambient run (exact, even when two scopes are visible at once);
  // fall back to the innermost visible scope, which is what a run has before its first event.
  const scopes = currentScopes();
  const owner = scopeOwning(currentTraceId() ?? '');
  const top = (owner && scopes.includes(owner) ? owner : undefined) ?? scopes[scopes.length - 1];
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

/** Source attribution for a tool span — `local` unless wrapped from an MCP server (E-wave). */
function toolSourceAttrs(name: string): Record<string, string> {
  const src = toolSource(name);
  const attrs: Record<string, string> = { 'cendor.tool.source': src?.source ?? 'local' };
  if (src?.server) attrs['cendor.tool.mcp.server'] = src.server;
  if (src?.transport) attrs['cendor.tool.mcp.transport'] = src.transport;
  return attrs;
}

/**
 * A tool call's outcome (`ok` | `error`) from the runner's own result convention — a failed tool
 * returns `[error] …`. Computed in-process; only the label lands on the span, never the result.
 *
 * Classifies through {@link isToolError}, the single definition shared with `Result.toolErrors` — the
 * two cannot disagree about what a tool failure is.
 *
 * ⚠️ Measured 2026-07-31 (GAPCLOSE S7): this can currently only fire for a tool that *returns* the
 * marker or replays one, because a tool that THROWS emits no `ToolCall` at all, so no `execute_tool`
 * span is rendered for it. `Result.toolErrors` is the surface that sees those; closing the span-side
 * gap needs core to emit on failure and is deliberately not done here.
 */
function toolOutcome(call: ToolCall): string {
  return isToolError(call.result) ? 'error' : 'ok';
}

// --- E-wave domain spans (RAG / memory / orchestration / checkpoints / blocked tools) ------------
// Rendered by `liveSpans` from bus events (see _telemetry.ts). Each returns [spanName, attrs]; every
// attrs object carries `cendor.sdk.kind` so a monitor can switch on it robustly. RAG rides the
// library events (contextkit AssemblyReport / squeeze CompressionEvent) — dispatched by class name.

type DomainSpan = [string, Record<string, unknown>];

function ragAssembleAttrs(ev: Record<string, unknown>): DomainSpan {
  const decisions = (ev.decisions as Array<Record<string, unknown>> | undefined) ?? [];
  const kept = decisions.filter((d) => d?.action === 'kept').length;
  const dropped = decisions.filter((d) => d?.action === 'dropped').length;
  const before = decisions.reduce((n, d) => n + (Number(d?.tokensBefore) || 0), 0);
  const after = decisions.reduce((n, d) => n + (Number(d?.tokensAfter) || 0), 0);
  return [
    'rag.assemble',
    {
      'cendor.sdk.kind': 'rag.assemble',
      'gen_ai.operation.name': 'rag.assemble',
      'cendor.rag.budget': Number(ev.budget) || 0,
      'cendor.rag.used': Number(ev.used) || 0,
      'cendor.rag.reserved_output': Number(ev.reservedOutput) || 0,
      'cendor.rag.model': String(ev.model ?? ''),
      'cendor.rag.blocks': decisions.length,
      'cendor.rag.kept': kept,
      'cendor.rag.dropped': dropped,
      'cendor.rag.tokens_before': before,
      'cendor.rag.tokens_after': after,
    },
  ];
}

function ragCompressAttrs(ev: Record<string, unknown>): DomainSpan {
  return [
    'rag.compress',
    {
      'cendor.sdk.kind': 'rag.compress',
      'gen_ai.operation.name': 'rag.compress',
      'cendor.rag.technique': String(ev.technique ?? ''),
      'cendor.rag.tokens_before': Number(ev.tokens_before) || 0,
      'cendor.rag.tokens_after': Number(ev.tokens_after) || 0,
      'cendor.rag.ratio': String(ev.ratio ?? ''),
      'cendor.rag.store_kind': String(ev.store_kind ?? ''),
      'cendor.rag.kind': String(ev.kind ?? ''),
    },
  ];
}

function memoryAttrs(ev: MemoryOp): DomainSpan {
  const name = `memory.${ev.op}`;
  const attrs: Record<string, unknown> = {
    'cendor.sdk.kind': name,
    'gen_ai.operation.name': name,
    'cendor.memory.op': ev.op,
    'cendor.memory.turns': ev.turns,
    'cendor.memory.bytes': ev.bytes,
  };
  if (ev.sessionId) {
    attrs['cendor.memory.session_id'] = ev.sessionId;
    attrs['gen_ai.conversation.id'] = ev.sessionId;
  }
  return [name, attrs];
}

function checkpointAttrs(ev: CheckpointEvent): DomainSpan {
  const name = `checkpoint.${ev.op}`;
  const attrs: Record<string, unknown> = {
    'cendor.sdk.kind': name,
    'gen_ai.operation.name': name,
    'cendor.checkpoint.op': ev.op,
    'cendor.checkpoint.done': ev.done,
    'cendor.checkpoint.turns': ev.turns,
  };
  if (ev.segment != null) attrs['cendor.checkpoint.segment'] = ev.segment;
  return [name, attrs];
}

function handoffAttrs(ev: OrchestrationEdge): DomainSpan {
  return [
    'orchestration.handoff',
    {
      'cendor.sdk.kind': 'orchestration.handoff',
      'gen_ai.operation.name': 'orchestration.handoff',
      'cendor.orch.from_agent': ev.fromAgent,
      'cendor.orch.to_agent': ev.toAgent,
      'cendor.orch.segment': ev.segment,
      'cendor.orch.transfer_tool': ev.transferTool,
    },
  ];
}

function toolBlockedAttrs(ev: ToolGate): DomainSpan {
  const attrs: Record<string, unknown> = {
    'cendor.sdk.kind': 'execute_tool',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': ev.name,
    'cendor.tool.outcome': 'blocked',
    'cendor.tool.blocked_by': ev.blockedBy,
    ...toolSourceAttrs(ev.name),
  };
  if (ev.agent) attrs['gen_ai.agent.name'] = ev.agent;
  return [`execute_tool ${ev.name}`, attrs];
}

/**
 * Option C (DR-2c): an enforcement event as a `governance.*` child of the run root.
 *
 * Core owns the vocabulary (`cendor.gov.*`) and the rule-6 posture — no `audit.*` names, no `reason`
 * strings (a guardrail's reason can carry input-derived text; see core's Option C note). The SDK only
 * re-uses it so the same decision lands **inside the run** rather than beside it. Returns `null` when
 * the event isn't an enforcement event, or when an audit mirror already owns the wire.
 */
function governanceAttrs(ev: any): DomainSpan | null {
  const core = coreOtel as unknown as {
    _govAttrs?: (e: unknown) => [string, Record<string, unknown>] | null;
    governanceMirrorActive?: () => boolean;
  };
  if (!core._govAttrs || core.governanceMirrorActive?.() === true) return null;
  const mapped = core._govAttrs(ev);
  if (mapped === null || mapped === undefined) return null;
  const [name, attrs] = mapped;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) kept[k] = v;
  return [name, kept];
}

// biome ignores: `noExplicitAny` is off in this config; builders accept a library or an SDK event.
const DOMAIN_BUILDERS: Record<string, (ev: any) => DomainSpan | null> = {
  AssemblyReport: ragAssembleAttrs,
  CompressionEvent: ragCompressAttrs,
  MemoryOp: memoryAttrs,
  CheckpointEvent: checkpointAttrs,
  OrchestrationEdge: handoffAttrs,
  ToolGate: toolBlockedAttrs,
  // Option C: enforcement decisions as run children (core renders the same two events flat for a
  // libs-only app). Duck-typed by class name, like every other row here.
  BudgetEvent: governanceAttrs,
  GuardrailDecision: governanceAttrs,
};

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

/** The agent id recorded on a step's call, or `''`. */
function agentIdOfStep(step: Step): string {
  const aid = (step.call as { metadata?: Record<string, unknown> } | undefined)?.metadata?.agent_id;
  return typeof aid === 'string' ? aid : '';
}

function stepAttrs(span: Span, step: Step, stepNo: number): void {
  span.setAttribute('gen_ai.agent.name', step.agent);
  // W4: post-hoc, the Result is all there is — the id rode in on the call's metadata (stamped by the
  // ambient provider at construction). Omitted when unknown; never invented.
  const sid = agentIdOfStep(step);
  if (sid) span.setAttribute('gen_ai.agent.id', sid);
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
    // `.amount`, never `Money.toString()` — see the note on `costAttr` below.
    if (step.cost) span.setAttribute('gen_ai.usage.cost', costAttr(step.cost));
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
    const segmentAgentId = group.map(agentIdOfStep).find(Boolean);
    if (segmentAgentId) agentSpan.setAttribute('gen_ai.agent.id', segmentAgentId);
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
        for (const [k, v] of Object.entries(toolSourceAttrs(step.name))) span.setAttribute(k, v);
        span.setAttribute('cendor.tool.outcome', toolOutcome(step.call)); // E-wave: ok | error
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
  opts: {
    tracer?: Tracer | null;
    name?: string;
    conversationId?: string;
    label?: string;
    /** @internal The caller raises + releases the core latch itself, scoped to its own run body (the
     * automatic run scope). Without this a hand-closed handle bumps the process-wide counter, which
     * would make a second concurrent run believe a scope was already open. */
    _callerOwnsDepth?: boolean;
    /** @internal Learn the run family ONLY from an event emitted inside this scope's own async
     * context — the automatic path, which is context-bound by construction. A hand-closed
     * `liveSpans()` handle keeps the historical "first event wins", because a user may legitimately
     * open it around work that runs on another thread / worker where no context reaches. */
    _ownContextOnly?: boolean;
  } = {},
): { close(): void } {
  const r = resolve(opts.tracer);
  if (!r) return { close() {} };
  const { tr, api } = r;
  const ownsDepth = opts._callerOwnsDepth !== true;
  if (ownsDepth) coreOtel.enterLiveSpans(); // G20: the emitter stands down while we own the spans
  const root = tr.startSpan(opts.name ?? 'agent.run');
  // Parity with `spanTree` and the Python `live_spans` root (a backend that groups by
  // gen_ai.operation.name — and Cendor Monitor's door router — reads this, not just the span name).
  root.setAttribute('gen_ai.operation.name', 'agent');
  if (opts.conversationId) root.setAttribute('gen_ai.conversation.id', opts.conversationId);
  if (opts.label) root.setAttribute('cendor.run.label', opts.label);
  const ctx = childContext(api, root); // nest each live child UNDER the run root (one trace)
  // Register this scope so the runner can make `root` the active context span for the run body
  // (real API only; an injected fake tracer models no context, so it never activates — unchanged).
  const scope = api ? { api, ctx } : null;
  if (scope) pushScope(scope);
  const owner: FamilyOwner = { token: {}, scope };
  let stepNo = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = Money.zero();
  let runIdSet = false;
  let convSet = Boolean(opts.conversationId);
  let family = ''; // the run-family root, learned from the first event (GLR-3)
  const agentsSeen = new Set<string>(); // ordered-unique agents → cendor.run.agents (G-V4-2)
  const learnAndFilter = (traceId: string): boolean => {
    // Learn the run-family root from the first observed event: the segment before the first ':'
    // (orchestration segments are `${parent}:${agent}#${seg}`; a single-agent run is the bare
    // runId). Matches makeCollector.match + the monitor's run_id normalization. Returns false for a
    // foreign run (GLR-3 — a concurrent run sharing the process bus must not pollute this one).
    if (!traceId) return false; // not attributable to any run — the flat emitter renders it
    if (!runIdSet) {
      // `bus.emit` is a process-wide fanout, so the first event this scope sees can belong to a
      // DIFFERENT concurrent run. Learning it anyway is what made two overlapping zero-code runs
      // render one run twice, lose the other, and stamp both roots with one run id. The automatic
      // scope therefore learns only from its own async context, and a family has exactly one owner.
      if (opts._ownContextOnly === true && scope !== null && !currentScopes().includes(scope)) {
        return false; // emitted outside this scope — it belongs to another run
      }
      if (!claimFamily(familyOf(traceId), owner)) return false;
      family = familyOf(traceId);
      root.setAttribute('cendor.run.id', family);
      root.setAttribute('cendor.trace_id', family);
      runIdSet = true;
    }
    return !(family && traceId !== family && !traceId.startsWith(`${family}:`));
  };
  // E-wave: render a domain event (RAG/memory/orchestration/checkpoint/blocked-tool) as a
  // `cendor.sdk` child span. AssemblyReport carries no traceId — read the ambient run scope
  // (bus.emit is a synchronous same-thread fanout, so the emitting call's trace() scope is active).
  const domainSpan = (event: any, builder: (e: any) => DomainSpan | null): void => {
    // SDK events carry camelCase `traceId`; squeeze's CompressionEvent carries snake_case
    // `trace_id`; contextkit's AssemblyReport carries neither → read the ambient run scope.
    const traceId = ((event?.traceId ?? event?.trace_id) as string) || currentTraceId() || '';
    if (!learnAndFilter(traceId)) return;
    const mapped = builder(event);
    if (mapped === null) return; // Option C stood down (an audit mirror owns the wire)
    const [name, attrs] = mapped;
    const now = Date.now();
    const span = tr.startSpan(name, { startTime: now }, ctx);
    span.setAttribute('cendor.trace_id', traceId);
    for (const [k, v] of Object.entries(attrs)) if (v != null) span.setAttribute(k, v);
    span.end(now);
  };
  const sub = (event: unknown): void => {
    const cls = (event as { constructor?: { name?: string } })?.constructor?.name ?? '';
    const builder = DOMAIN_BUILDERS[cls];
    if (builder) {
      domainSpan(event, builder);
      return;
    }
    if (!(event instanceof LLMCall || event instanceof ToolCall)) return;
    // The stamped trace id, else the ambient run scope (same fallback as `domainSpan` — `bus.emit` is
    // a synchronous fanout, so the emitting call's `trace()` scope is still active).
    const traceId = event.traceId || currentTraceId() || '';
    if (!learnAndFilter(traceId)) return;
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
    // W4/S4: the agent's stable id, when the app gave it one. Emitted ONLY when known — never hashed,
    // never placeholdered (D3). A name is a label; an id is identity.
    const agentId = currentAgentId() || (typeof meta?.agent_id === 'string' ? meta.agent_id : '');
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
    if (agentId) span.setAttribute('gen_ai.agent.id', agentId);
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
        span.setAttribute('gen_ai.usage.cost', costAttr(event.cost));
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
      for (const [k, v] of Object.entries(toolSourceAttrs(event.name))) span.setAttribute(k, v);
      span.setAttribute('cendor.tool.outcome', toolOutcome(event)); // E-wave: ok | error
      for (const [k, v] of Object.entries(toolContentAttrsFor(event))) span.setAttribute(k, v);
    }
    span.end(end); // S8: backdated end time (start was backdated by latency above)
  };
  bus.subscribe(sub);
  return {
    close() {
      bus.unsubscribe(sub);
      if (scope) removeScope(scope); // by identity — safe under nesting / out-of-order close
      releaseFamily(family, owner); // the run is over — a later scope may own this family again
      if (ownsDepth) coreOtel.exitLiveSpans();
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

// ------------------------------------------------------------------ the automatic run scope (DR-1)
/**
 * Open a `liveSpans` scope for a run **only when nobody else has** — the zero-telemetry-code path.
 *
 * Returns `null` (nothing opened) when `CENDOR_TELEMETRY=off`, when the app has not configured an
 * OpenTelemetry provider, or when an explicit `liveSpans()` scope is already open (theirs wins — a
 * second root would nest a duplicate run). The caller owns closing it in a `finally`, so the
 * unclosed-handle foot-gun of the public API does not apply to the automatic path.
 *
 * The conversation id comes from the run's `session` — the id the user chose. No label is invented:
 * `cendor.run.label` is a human-authored tag, and inventing one would be identity Cendor does not own.
 *
 * Prefer {@link withAutoRunScope} / {@link autoScopeStream}: they bind the scope to the run body's own
 * async context. This bare form gets the **manual** semantics (a hand-closed handle, visible
 * process-wide) because a bare handle has no body to bind to.
 *
 * @internal
 */
export function autoRunScope(session?: { id?: string | null } | null): { close(): void } | null {
  if (!scopeIsAvailable(session)) return null;
  return liveSpans(session?.id ? { conversationId: session.id } : {});
}

/** The three predicates that decide whether the SDK may open a scope of its own. Never throws — an
 * older `@cendor/core` must not break a run. */
function scopeIsAvailable(_session?: { id?: string | null } | null): boolean {
  try {
    if (coreOtel.telemetryMode() === 'off') return false;
    if (coreOtel.liveSpansActive()) return false;
    return coreOtel.providerConfigured();
  } catch {
    return false;
  }
}

/** Open the automatic scope and hand back BOTH its close handle and its registry entry, so the caller
 * can bind that entry to `fn` alone (see {@link withAutoRunScope}). `null` ⇒ nothing was opened. */
function openAutoScope(
  session?: { id?: string | null } | null,
): { handle: { close(): void }; scope: LiveScope | null } | null {
  if (!scopeIsAvailable(session)) return null;
  const handle = liveSpans({
    ...(session?.id ? { conversationId: session.id } : {}),
    _callerOwnsDepth: true, // withAutoRunScope / autoScopeStream raise the depth for the run body only
    _ownContextOnly: true, // …and bind the scope to it, so a concurrent run is never adopted
  });
  // `liveSpans` pushed its registry entry onto the module array (the manual semantics); take it off
  // and let the caller scope it instead. `lastPushedScope` is set by `liveSpans` in the same tick.
  const scope = lastPushedScope;
  if (scope) removeScope(scope);
  return { handle, scope };
}

/**
 * Run `fn` inside {@link autoRunScope}, closing it in a `finally` the SDK owns.
 *
 * Both the core latch and this module's scope stack are **isolated** for the duration, so the scope
 * cannot leak into the caller's async context — otherwise `await run(...)` would leave the caller
 * latched (its later libs-only calls silently losing their spans) and two concurrent runs would share
 * one scope, parenting one run's steps under the other's root.
 */
export async function withAutoRunScope<T>(
  session: { id?: string | null } | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const opened = openAutoScope(session);
  if (opened === null) return fn();
  const { handle, scope } = opened;
  // The depth AND the scope stack are raised only for `fn` (AsyncLocalStorage.run — correct on every
  // supported Node), so a concurrent run never loses its flat spans and nothing survives the run.
  return withLiveDepth(() =>
    withScope(scope, async () => {
      try {
        return await fn();
      } finally {
        handle.close();
      }
    }),
  );
}

/** Wrap a stream generator so its automatic scope is bound to the STREAM's own async context and
 * closes when the stream ends or is abandoned. */
export function autoScopeStream<T>(
  session: { id?: string | null } | null | undefined,
  inner: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  return (async function* () {
    const opened = openAutoScope(session);
    if (opened === null) {
      yield* inner();
      return;
    }
    const { handle, scope } = opened;
    // An async generator's body is resumed in the CONSUMER's context, so wrapping the *creation* of
    // `inner()` in `AsyncLocalStorage.run` binds nothing (measured: the store is invisible inside the
    // body). Drive it by hand instead and enter the store around each RESUMPTION: the body — and the
    // producer task it starts, which inherits the context it was created in — then sees both the core
    // latch and the scope registry, while the consumer between deltas sees neither. That keeps the
    // stream path scoped exactly like `withAutoRunScope` (and like Python's copied context), instead
    // of standing the flat emitter down process-wide for the stream's whole lifetime.
    const it = inner()[Symbol.asyncIterator]();
    try {
      while (true) {
        const step = await withLiveDepth(() => withScope(scope, () => it.next()));
        if (step.done) return;
        yield step.value;
      }
    } finally {
      // Abandonment (`break`) lands here: close the inner generator inside the scope so its own
      // `finally` blocks (trace/audit/collector unwinding) run where they were opened.
      await withLiveDepth(() => withScope(scope, () => it.return?.(undefined as never)));
      handle.close();
    }
  })();
}
