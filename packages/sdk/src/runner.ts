/**
 * The agent loop — the TS port of `cendor.sdk.runner`. Async-first: `run(agent, input, opts)` returns
 * a `Promise<Result>`; `run.stream` / `run.astream` are async generators. History is kept in the
 * canonical (OpenAI Chat) shape with the system prompt out of the list. Governance rides core's bus:
 * a per-run collector (scoped by `trace(runId)`) harvests LLM/tool calls into `Result.steps` and fires
 * the live `onStep` hook (a raised hook never breaks a run). A list of agents dispatches to
 * orchestration (handoff team).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditLog, Decision } from '@cendor/acttrace';
import { LLMCall, ToolCall, bus, currentTraceId, installTraceContext, trace } from '@cendor/core';
import { type Guardrail, GuardrailTripped } from '@cendor/guardrails';
import { emitCheckpoint, emitMemory } from './_telemetry.js';
import type { Agent } from './agent.js';
import { type Checkpointer, asCheckpointer } from './checkpoint.js';
import * as gate from './gate.js';
import { withConversation, withScope } from './governance.js';
import { withLiveRootActive } from './otel.js';
import { type Provider, assistantMessage, toolResultMessage } from './providers.js';
import { formatContext } from './rag.js';
import { type RetryPolicy, callWithRetry } from './resilience.js';
import { type JsonSchema, type Tool, zodSchemaToJson } from './tools.js';
import {
  type Message,
  type ParsedResponse,
  Result,
  RunComplete,
  Step,
  type StreamEvent,
  TextDelta,
  ThinkingDelta,
  ToolCallEvent,
  ToolResultEvent,
} from './types.js';

// Concurrency-correct trace correlation (server-side; overlapping runs stay isolated).
installTraceContext(new AsyncLocalStorage<string>());

/**
 * The acttrace `Decision` handle for the run currently executing in this async context (or
 * undefined). Human-in-the-loop tools (`./hitl`) read it to record `human_oversight` on the same
 * audit chain the run is already correlated by. Set by {@link withAuditDecision}. The TS mirror of
 * Python's `runner._active_decision` ContextVar.
 */
export const als = new AsyncLocalStorage<Decision>();

export interface RunOptions {
  session?: SessionLike | null;
  audit?: AuditLog | null;
  maxTurns?: number | null;
  retry?: RetryPolicy | null;
  onStep?: ((step: Step) => void) | null;
  /** A checkpoint path or `Checkpointer` — persists the conversation after each turn so a crashed run resumes. */
  checkpoint?: Checkpointer | string | null;
  /**
   * Per-run guardrail override — replaces the agent's own list for this run (`[]` disables gating).
   * For a team, applies to every segment; omit to use each agent's `Agent({ guardrails: [...] })`.
   */
  guardrails?: Guardrail[] | null;
  /**
   * Per-run guardrail execution mode override (`"blocking"` | `"parallel"`), else the agent's own
   * `guardrailMode`. `"parallel"` overlaps input-stage guardrails with the first model call
   * (single-agent runs). Validated — an unknown value throws.
   */
  guardrailMode?: string | null;
}

/** The minimal session surface the runner needs. `replace` may be async (awaited write-back). */
export interface SessionLike {
  snapshot(): Message[];
  replace(messages: Message[]): void | Promise<void>;
  /** Optional conversation id, propagated as `gen_ai.conversation.id` on the run span (G19). */
  id?: string | null;
}

const EMPTY_TARGETS: ReadonlyMap<string, string> = new Map();

export function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function resolveMessages(input: string | Message | Message[]): Message[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) return [...input];
  return [input];
}

function safeInput(input: unknown): unknown {
  if (typeof input === 'string' || (input !== null && typeof input === 'object')) return input;
  return String(input);
}

function isZodSchema(x: unknown): x is { parse(v: unknown): unknown } {
  return (
    !!x &&
    typeof (x as { parse?: unknown }).parse === 'function' &&
    typeof (x as { safeParse?: unknown }).safeParse === 'function'
  );
}

function schemaFromOutputType(outputType: unknown): JsonSchema | null {
  if (!outputType) return null;
  // A duck-typed zod schema (v3 or v4) — zodSchemaToJson converts v4 and rejects v3 loudly.
  if (isZodSchema(outputType)) return zodSchemaToJson(outputType as never);
  if (typeof outputType === 'object') return outputType as JsonSchema;
  return null;
}

const NO_JSON = Symbol('no-json');

/**
 * Parse JSON from model output that may be wrapped: a ```json fenced block, or prose around a single
 * JSON value. Providers without a native JSON-schema mode (Anthropic, Ollama-without-format, HF) very
 * commonly fence their output, so a bare `JSON.parse` returned the raw string and silently broke the
 * declared `outputType`. Returns {@link NO_JSON} when nothing parseable is found.
 */
function looseJsonParse(text: string): unknown {
  const s = text.trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to fence-stripping / balanced extraction
  }
  // ```json … ``` or ``` … ``` fenced block
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  // first balanced { … } or [ … ], string/escape aware
  const start = s.search(/[[{]/);
  if (start >= 0) {
    const open = s[start] as '{' | '[';
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return NO_JSON;
        }
      }
    }
  }
  return NO_JSON;
}

function parseOutput(content: string | null, outputType: unknown): unknown {
  if (!outputType || content === null) return content;
  const data = looseJsonParse(content);
  if (data === NO_JSON) return content; // provider didn't emit JSON — return the prose
  if (isZodSchema(outputType)) {
    try {
      return outputType.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
  } catch {
    return String(value);
  }
}

function errString(err: unknown): string {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
  return `[error] ${name}: ${(err as Error)?.message ?? String(err)}`;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join(' ');
  }
  return String(content ?? '');
}

/**
 * "Always-on" RAG (matches PY `_inject_retrieved_context`): retrieve context for the latest user
 * query and insert it as a system message before that turn — once per run, mutating `messages` in
 * place so it persists into `Result.messages` / the session. No-op if there's no user turn or the
 * retriever returns nothing.
 */
export async function injectRetrievedContext(agent: Agent, messages: Message[]): Promise<void> {
  if (!agent.retriever) return;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  const query = textOfContent(messages[idx]!.content);
  const chunks = await agent.retriever(query);
  if (chunks && chunks.length > 0) {
    messages.splice(idx, 0, { role: 'system', content: formatContext(chunks) });
  }
}

/** Resolve starting messages (session snapshot + input) and inject RAG context once (PY `_prepare_messages`). */
export async function prepareMessages(
  agent: Agent,
  input: string | Message | Message[],
  session: SessionLike | null | undefined,
): Promise<Message[]> {
  const messages: Message[] = [...(session?.snapshot() ?? []), ...resolveMessages(input)];
  if (session) emitMemory('load', session, currentTraceId() ?? ''); // E-wave: memory.load span
  if (agent.retriever) await injectRetrievedContext(agent, messages);
  return messages;
}

/**
 * Diagnostic bus event: `contextBudget` assembly failed and the turn fell back to raw messages.
 * Emitted on `@cendor/core`'s bus so the deliberate best-effort fallback is *silent but
 * observable* — subscribe and alert on it if a fallback matters to you. Unknown event types are
 * ignored by the stock subscribers (bus-events spec), so emitting this is side-effect-free.
 * The TS twin of Python's `cendor.sdk.runner.ContextBudgetFallback`.
 */
export class ContextBudgetFallback {
  constructor(
    readonly agent: string,
    readonly budgetTokens: number,
    readonly error: string,
  ) {}
}

/**
 * Optional context assembly to a token budget via contextkit (emits an audited AssemblyReport).
 * Falls back to the raw messages if unset or if assembly can't handle the shape (PY `_assemble`).
 */
export async function assemble(agent: Agent, messages: Message[]): Promise<Message[]> {
  if (!agent.contextBudget) return messages;
  try {
    const { Block, Context } = await import('@cendor/contextkit');
    const ctx = new Context({
      budgetTokens: agent.contextBudget,
      model: agent.model,
      reserveOutput: agent.maxTokens ?? 512,
    });
    ctx.add(new Block({ messages: messages as Record<string, unknown>[] }));
    return (await ctx.assemble()) as unknown as Message[];
  } catch (exc) {
    try {
      // make the silent fallback observable on the bus (never let the emit itself break it)
      bus.emit(
        new ContextBudgetFallback(
          agent.name,
          Number(agent.contextBudget),
          exc instanceof Error ? exc.constructor.name : String(exc),
        ),
      );
    } catch {
      // diagnostics must never break the run
    }
    return messages; // assembly is best-effort; degrade to raw messages
  }
}

export { parseOutput, makeCollector };

export function buildCallKwargs(agent: Agent, wire: Message[]): Record<string, unknown> {
  const outputSchema = schemaFromOutputType(agent.outputType);
  let kwargs = agent.providerImpl.buildKwargs(
    agent.model,
    wire,
    agent.toolset,
    agent.instructions,
    {
      jsonMode: agent.outputType != null,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      outputSchema,
    },
  );
  if (Object.keys(agent.extra).length > 0) kwargs = { ...kwargs, ...agent.extra };
  if (agent.cache) kwargs = agent.providerImpl.applyCache(kwargs);
  return kwargs;
}

function toolPayload(provider: Provider, t: Tool): JsonSchema {
  if (provider.name === 'anthropic') return t.toAnthropic();
  if (provider.name === 'openai_responses') return t.toOpenaiResponses();
  return t.toOpenai();
}

/** Build call kwargs, overriding `tools` with the effective toolset (agent tools + transfer tools). */
function buildKwargsWith(
  agent: Agent,
  wire: Message[],
  toolset: Tool[],
  provider: Provider,
): Record<string, unknown> {
  const kwargs = buildCallKwargs(agent, wire);
  if (toolset.length > 0) kwargs.tools = toolset.map((t) => toolPayload(provider, t));
  return kwargs;
}

/** `{provider, create}` for an agent — the instrumented client's create method. */
export function providerAndCreate(agent: Agent): {
  provider: Provider;
  create: (kwargs: Record<string, unknown>) => Promise<unknown>;
} {
  const provider = agent.providerImpl;
  const create = provider.createMethod(provider.client(agent.clientConfig()));
  return { provider, create };
}

/** Shared config for one agent's turns. */
export interface LoopConfig {
  provider: Provider;
  create: (kwargs: Record<string, unknown>) => Promise<unknown>;
  maxTurns: number;
  retry: RetryPolicy | null;
  toolset: Tool[];
  resolve: (name: string) => Tool | null | undefined;
  transferTargets: ReadonlyMap<string, string>;
  /** Checkpoint hook (PY `on_turn`): called with `messages` after each turn — after a tool turn and after the final answer. */
  onTurn?: ((messages: Message[]) => void) | null;
  /** The effective guardrails for this run (agent's own, or the per-run override). */
  guardrails?: Guardrail[];
  /**
   * Resolved execution mode. `"parallel"` overlaps the input gate with the first model call; else
   * the input gate runs blocking (pre-spend) before the loop. Set by the single-agent `Runner`;
   * orchestration segments leave it unset (blocking), mirroring Python `run_agents`.
   */
  guardrailMode?: gate.GuardrailMode;
}

/**
 * Run one agent's blocking turns over `messages` (mutated in place). Returns `{output, switchTo}` —
 * `switchTo` is a handoff target name if the agent transferred control, else null. Mirrors PY
 * `run_agent_sync` (assemble → call → tools → repeat). Output is the raw model content; callers apply
 * `parseOutput`.
 */
export async function agentLoop(
  agent: Agent,
  messages: Message[],
  cfg: LoopConfig,
): Promise<{ output: string | null; switchTo: string | null }> {
  const { provider } = cfg;
  const guardrails = cfg.guardrails ?? [];
  const traceId = currentTraceId();
  let output: string | null = null;
  let reasksLeft = gate.effectiveReasks(agent, null); // S12: opt-in output-block re-ask budget
  // In `parallel` mode overlap the input gate with the first model call (its latency hides behind
  // the call on the pass path); else gate before the loop (pre-spend: block throws / redact rewrites).
  let gatePromise: Promise<void> | null = null;
  if (cfg.guardrailMode === 'parallel') {
    gatePromise = gate.startInputGate(guardrails, agent.name, messages, traceId);
    // The gate may settle (reject on a block) before we join it after the first model call. Attach a
    // no-op handler now so that in-flight rejection is never "unhandled"; the `await` below still
    // observes and rethrows it. (JS can't cancel a promise, so there is nothing else to clean up.)
    gatePromise?.catch(() => {});
  } else {
    await gate.gateInput(guardrails, agent.name, messages, traceId);
  }
  for (let turn = 0; turn < cfg.maxTurns; turn++) {
    const wire = await assemble(agent, messages);
    const kwargs = buildKwargsWith(agent, wire, cfg.toolset, provider);
    const response = await callWithRetry(() => cfg.create(kwargs), cfg.retry);
    const parsed = provider.parse(response);
    if (gatePromise !== null) {
      await gatePromise; // parallel mode: join the input gate (a block throws here, post-call)
      gatePromise = null;
    }
    messages.push(assistantMessage(parsed.content, parsed.toolCalls));
    if (parsed.toolCalls.length > 0) {
      let switchTo: string | null = null;
      for (const tc of parsed.toolCalls) {
        const result = await executeTool(
          cfg.resolve,
          tc.name,
          tc.arguments,
          guardrails,
          agent.name,
          traceId,
          gate.originatingInstruction(messages),
        );
        messages.push(toolResultMessage(tc.id, tc.name, result));
        const target = cfg.transferTargets.get(tc.name);
        if (target) switchTo = target;
      }
      cfg.onTurn?.(messages);
      if (switchTo) return { output: null, switchTo };
      continue;
    }
    try {
      output = await gate.gateOutput(guardrails, agent.name, parsed.content, traceId); // block throws
    } catch (err) {
      if (err instanceof GuardrailTripped) {
        // S12: opt-in bounded re-ask on an output block (else re-throw — fail-closed).
        const step = gate.reaskStep(err, reasksLeft);
        reasksLeft = step.reasksLeft;
        if (step.message === null) throw err;
        messages.push(step.message);
        cfg.onTurn?.(messages);
        continue;
      }
      throw err;
    }
    cfg.onTurn?.(messages);
    return { output, switchTo: null };
  }
  return { output, switchTo: null };
}

async function executeTool(
  resolve: (name: string) => Tool | null | undefined,
  name: string,
  args: Record<string, unknown>,
  guardrails: Guardrail[] = [],
  agentName = '',
  traceId = '',
  instruction = '',
): Promise<string> {
  const { blocked, args: gatedArgs } = await gate.gateToolCall(
    guardrails,
    agentName,
    name,
    args,
    traceId,
    instruction,
  );
  if (blocked !== null) return blocked; // tool_call guardrail blocked — don't run the tool
  const tool = resolve(name);
  if (!tool) return `[error] unknown tool: ${name}`;
  let result: string;
  try {
    result = stringifyResult(await tool.invoke(gatedArgs));
  } catch (err) {
    return errString(err);
  }
  return gate.gateToolOutput(guardrails, agentName, name, result, traceId);
}

/**
 * Stream one agent's turns, calling `emit` live for each event. Returns `{output, switchTo}`. Mirrors
 * PY `stream_agent_sync`. Providers that reassemble a stream emit text incrementally; the rest fall
 * back to a whole-response delta. No retry on the streaming path (matches Python).
 */
export async function streamSegment(
  agent: Agent,
  messages: Message[],
  cfg: Omit<LoopConfig, 'retry'>,
  emit: (ev: StreamEvent) => void,
): Promise<{ output: string | null; switchTo: string | null }> {
  const { provider } = cfg;
  const guardrails = cfg.guardrails ?? [];
  const traceId = currentTraceId();
  let output: string | null = null;
  const window = gate.streamWindow(agent); // S12: opt-in incremental output check (0 = off)
  await gate.gateInput(guardrails, agent.name, messages, traceId); // pre-spend: block throws / redact
  for (let turn = 0; turn < cfg.maxTurns; turn++) {
    const wire = await assemble(agent, messages);
    const kwargs = buildKwargsWith(agent, wire, cfg.toolset, provider);
    let parsed: ParsedResponse;
    if (provider.supportsStream) {
      const stream = (await cfg.create({ ...kwargs, stream: true })) as AsyncIterable<unknown>;
      const chunks: unknown[] = [];
      let buffered = '';
      let checked = 0;
      for await (const chunk of stream) {
        chunks.push(chunk);
        const thinking = provider.streamThinking(chunk); // GLR-12: reasoning, if the provider streams it
        if (thinking) emit(new ThinkingDelta(thinking));
        const text = provider.streamText(chunk);
        if (text) {
          emit(new TextDelta(text));
          if (window) {
            buffered += text;
            if (buffered.length - checked >= window) {
              // a block throws mid-stream; already-yielded deltas can't be unshown (S12)
              await gate.gateStreamPartial(guardrails, agent.name, buffered, traceId);
              checked = buffered.length;
            }
          }
        }
      }
      parsed = provider.parseStream(chunks);
    } else {
      const response = await cfg.create(kwargs);
      parsed = provider.parse(response);
      if (parsed.content) emit(new TextDelta(parsed.content));
    }
    messages.push(assistantMessage(parsed.content, parsed.toolCalls));
    if (parsed.toolCalls.length > 0) {
      let switchTo: string | null = null;
      for (const tc of parsed.toolCalls) {
        emit(new ToolCallEvent(tc.name, tc.arguments, tc.id));
        const result = await executeTool(
          cfg.resolve,
          tc.name,
          tc.arguments,
          guardrails,
          agent.name,
          traceId,
          gate.originatingInstruction(messages),
        );
        messages.push(toolResultMessage(tc.id, tc.name, result));
        emit(new ToolResultEvent(tc.name, result));
        const target = cfg.transferTargets.get(tc.name);
        if (target) switchTo = target;
      }
      cfg.onTurn?.(messages); // S13: checkpoint after the tool turn
      if (switchTo) return { output: null, switchTo };
      continue;
    }
    // output stage runs after the deltas already streamed — a block throws here (post-hoc)
    output = await gate.gateOutput(guardrails, agent.name, parsed.content, traceId);
    cfg.onTurn?.(messages); // S13: checkpoint after the answering turn
    return { output, switchTo: null };
  }
  return { output, switchTo: null };
}

/**
 * A per-run bus collector that harvests steps (scoped by `match(traceId)`) and fires onStep.
 * `agentFor(traceId)` names the agent for each step (a function so multi-agent runs derive the active
 * segment's agent from the child trace id).
 */
function makeCollector(
  match: (traceId: string) => boolean,
  agentFor: (traceId: string) => string,
  onStep?: ((step: Step) => void) | null,
) {
  const steps: Step[] = [];
  const sub = (event: unknown): void => {
    if (!(event instanceof LLMCall || event instanceof ToolCall)) return;
    if (!match(event.traceId)) return;
    const agentName = agentFor(event.traceId);
    // G13a: stamp which agent made the call into the event's free metadata (core types untouched).
    const meta = (event as { metadata?: Record<string, unknown> }).metadata;
    if (meta && typeof meta === 'object' && meta.agent === undefined) meta.agent = agentName;
    const step = new Step(agentName, event instanceof LLMCall ? 'llm' : 'tool', event);
    steps.push(step);
    if (onStep) {
      try {
        onStep(step);
      } catch {
        /* a raised progress hook must never break a run */
      }
    }
  };
  return { steps, sub };
}

/**
 * Open an acttrace `decision()` for the run, record the `{agent, model, trace_id}` bridge, and run
 * `fn` inside both the decision's auto-tagging scope and the module-level {@link als} store (so HITL
 * can read the active `Decision`). No-op wrapper when `audit` is null. Mirrors PY `_decision`.
 */
export async function withAuditDecision<T>(
  audit: AuditLog | null | undefined,
  input: unknown,
  agentName: string,
  model: string,
  traceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!audit) return fn();
  return audit.decision(
    async (d) => {
      try {
        d.record({ agent: agentName, model, trace_id: traceId });
      } catch {
        /* recording is best-effort; never break a run */
      }
      return als.run(d, fn);
    },
    { input: safeInput(input), actor: agentName },
  );
}

// --------------------------------------------------------------------------- live event queue

/** A single-producer/single-consumer async queue backing the live streaming generators. */
export interface EventQueue<T> {
  push(item: T): void;
  close(): void;
  fail(err: unknown): void;
  [Symbol.asyncIterator](): AsyncGenerator<T>;
}

export function createEventQueue<T>(): EventQueue<T> {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: { err: unknown } | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(item: T): void {
      items.push(item);
      notify();
    },
    close(): void {
      closed = true;
      notify();
    },
    fail(err: unknown): void {
      failure = { err };
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        while (items.length > 0) yield items.shift() as T;
        if (failure) throw failure.err;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

// --------------------------------------------------------------------------- Runner

/**
 * Drive one `Agent`. The class form of {@link run} — construct once with `{ session, audit,
 * checkpoint, … }`, then call `.run(input)`.
 *
 * @example
 * ```ts
 * import { Agent, Runner } from '@cendor/sdk';
 * const runner = new Runner(new Agent({ name: 'support', model: 'gpt-4o' }));
 * const result = await runner.run('Where is my order?');
 * ```
 */
export class Runner {
  constructor(
    readonly agent: Agent,
    readonly opts: RunOptions = {},
  ) {}

  async run(input: string | Message | Message[]): Promise<Result> {
    const agent = this.agent;
    const ckpt = asCheckpointer(this.opts.checkpoint);
    const saved = ckpt?.load() ?? null;
    // Done-resume short-circuit: a completed checkpoint replays its stored result WITHOUT minting a
    // run or re-entering agentLoop (no model call, no tool re-run). Steps are empty (no bus events);
    // the persisted messages/output are returned as-is. PY parity.
    if (saved?.done) {
      emitCheckpoint('resume', saved.run_id ?? '', true, (saved.messages ?? []).length); // E-wave
      return new Result({
        // Stored `output` is the raw model content persisted at completion (always string | null).
        output: parseOutput((saved.output ?? null) as string | null, agent.outputType),
        steps: [],
        traceId: saved.run_id ?? '',
        conversationId: this.opts.session?.id ?? '',
        agents: [agent.name],
        messages: [...(saved.messages ?? [])],
        incomplete: saved.output == null,
        guardrailDecisions: [], // empty on a resume (the loop never ran)
      });
    }
    // Resolve + validate the guardrail mode up front (an unknown mode throws — PY `effective_mode`).
    const guardrailMode = gate.effectiveMode(agent, this.opts.guardrailMode ?? null);
    // Mint a fresh runId even on resume (single-agent parity with PY runner._start).
    const runId = uuidHex();
    const { provider, create } = providerAndCreate(agent);
    const maxTurns = this.opts.maxTurns ?? agent.maxTurns;
    const resume = saved && !saved.done ? [...(saved.messages ?? [])] : null;
    if (resume) emitCheckpoint('resume', saved?.run_id ?? '', false, resume.length); // E-wave
    // GLR-4: prepared inside the run scopes below (so a retriever's embed call is attributed) —
    // captured here for session.replace / checkpoint / Result after the run body returns.
    let messages: Message[] = [];
    const onTurn = ckpt
      ? (msgs: Message[]): void => ckpt.save({ run_id: runId, messages: msgs, done: false })
      : null;
    const { steps, sub } = makeCollector(
      (t) => t === runId,
      () => agent.name,
      this.opts.onStep,
    );
    bus.subscribe(sub);
    try {
      // `collecting` gathers this run's guardrail decisions for `Result.guardrailDecisions`.
      // withLiveRootActive makes the caller's liveSpans run root (if any) the ACTIVE context span
      // for the whole run body, so audit entries correlate to the run (cendor.audit.otel_trace_id)
      // and audit.* mirror spans join the run's trace. No-op without a liveSpans scope / OTel —
      // parity with Python `live_spans`.
      return await withLiveRootActive(() =>
        gate.collecting(async () => {
          // Per-agent scope (attribution + `maxUsd` cap) wraps the single-agent path too, mirroring
          // the orchestrator's `runOneAgent` — previously `maxUsd` was silently dropped here.
          // withConversation (G19) propagates the session key so liveSpans groups multi-turn runs.
          const res = await withConversation(this.opts.session, () =>
            withScope(agent, () =>
              trace(runId, () =>
                withAuditDecision(
                  this.opts.audit,
                  input,
                  agent.name,
                  agent.model,
                  runId,
                  async () => {
                    // GLR-4: prepareMessages runs INSIDE the run scopes, so a retriever's embed call
                    // carries traceId=runId — collected as a step, agent-stamped, budgeted, chained.
                    messages =
                      resume !== null
                        ? resume
                        : await prepareMessages(agent, input, this.opts.session);
                    return agentLoop(agent, messages, {
                      provider,
                      create,
                      maxTurns,
                      retry: this.opts.retry ?? null,
                      toolset: agent.tools,
                      resolve: (n) => agent.getTool(n),
                      transferTargets: EMPTY_TARGETS,
                      onTurn,
                      guardrails: gate.effective(agent, this.opts.guardrails),
                      guardrailMode,
                    });
                  },
                ),
              ),
            ),
          );
          await this.opts.session?.replace(messages);
          if (this.opts.session) emitMemory('save', this.opts.session, runId); // E-wave: memory.save
          ckpt?.save({ run_id: runId, messages, done: true, output: res.output });
          return new Result({
            output: parseOutput(res.output, agent.outputType),
            steps,
            traceId: runId,
            conversationId: this.opts.session?.id ?? '',
            agents: [agent.name],
            messages,
            incomplete: res.output === null,
            guardrailDecisions: gate.snapshot(),
          });
        }),
      );
    } finally {
      bus.unsubscribe(sub);
    }
  }
}

// --------------------------------------------------------------------------- run callable

type RunFn = {
  (agent: Agent | Agent[], input: string | Message | Message[], opts?: RunOptions): Promise<Result>;
  stream(
    agent: Agent | Agent[],
    input: string | Message | Message[],
    opts?: Omit<RunOptions, 'onStep' | 'retry'>,
  ): AsyncGenerator<StreamEvent>;
  astream: RunFn['stream'];
};

async function runImpl(
  agent: Agent | Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  if (Array.isArray(agent)) {
    const { runAgents } = await import('./orchestration.js');
    return runAgents(agent, input, opts);
  }
  return new Runner(agent, opts).run(input);
}

async function* streamImpl(
  agent: Agent | Agent[],
  input: string | Message | Message[],
  opts: Omit<RunOptions, 'onStep' | 'retry'> = {},
): AsyncGenerator<StreamEvent> {
  if (Array.isArray(agent)) {
    const { streamAgents } = await import('./orchestration.js');
    yield* streamAgents(agent, input, opts);
    return;
  }
  yield* streamOne(agent, input, opts);
}

/**
 * Single-agent live streaming: each `TextDelta` / `ToolCallEvent` / `ToolResultEvent` is yielded the
 * instant it is produced, then a terminal `RunComplete`. Provider calls run inside the `trace(runId)`
 * (+ optional audit `decision`) scope on a background producer, so emitted `LLMCall`/`ToolCall` bus
 * events keep `traceId === runId`; a queue relays events to the consumer without a yield ever
 * crossing the trace scope. Mirrors PY `stream_agent_sync`.
 */
export async function* streamOne(
  agent: Agent,
  input: string | Message | Message[],
  opts: Omit<RunOptions, 'onStep' | 'retry'> = {},
): AsyncGenerator<StreamEvent> {
  const ckpt = asCheckpointer(opts.checkpoint);
  const saved = ckpt?.load() ?? null;
  // S13: a finished checkpoint replays its stored Result as a lone terminal RunComplete — no model
  // call, no re-yielded deltas (S13-D). Mirrors Runner.run's done-resume short-circuit.
  if (saved?.done) {
    emitCheckpoint('resume', saved.run_id ?? '', true, (saved.messages ?? []).length); // E-wave
    yield new RunComplete(
      new Result({
        output: parseOutput((saved.output ?? null) as string | null, agent.outputType),
        steps: [],
        traceId: saved.run_id ?? '',
        conversationId: opts.session?.id ?? '', // S6
        agents: [agent.name],
        messages: [...(saved.messages ?? [])],
        incomplete: saved.output == null,
        guardrailDecisions: [],
      }),
    );
    return;
  }
  const resume = saved && !saved.done ? [...(saved.messages ?? [])] : null; // S13
  if (resume) emitCheckpoint('resume', saved?.run_id ?? '', false, resume.length); // E-wave
  const runId = uuidHex();
  const { provider, create } = providerAndCreate(agent);
  const maxTurns = opts.maxTurns ?? agent.maxTurns;
  // GLR-4: prepared inside the run scopes below; captured here for session.replace / Result.
  let messages: Message[] = [];
  const onTurn = ckpt // S13: per-turn checkpoint at each turn boundary (streamSegment calls it)
    ? (msgs: Message[]): void => ckpt.save({ run_id: runId, messages: msgs, done: false })
    : null;
  const { steps, sub } = makeCollector(
    (t) => t === runId,
    () => agent.name,
    null,
  );
  bus.subscribe(sub);
  const queue = createEventQueue<StreamEvent>();
  const produce = async (): Promise<void> => {
    try {
      // `collecting` gathers this run's guardrail decisions for `Result.guardrailDecisions`.
      // withLiveRootActive activates the caller's liveSpans run root for the run body so audit
      // entries correlate + audit.* spans join the run trace (no-op without a scope / OTel). The
      // consumer `for await` loop below stays OUTSIDE — user code must not run under the run root.
      const result = await withLiveRootActive(() =>
        gate.collecting(async () => {
          // Per-agent scope (attribution + `maxUsd` cap) wraps the single-agent stream path too.
          // withConversation (G19/S6) propagates the session key so liveSpans groups multi-turn runs.
          const res = await withConversation(opts.session, () =>
            withScope(agent, () =>
              trace(runId, () =>
                withAuditDecision(opts.audit, input, agent.name, agent.model, runId, async () => {
                  // GLR-4/S11: prepareMessages runs INSIDE the run scopes so a retriever's embed call
                  // is attributed to the run (traceId=runId), collected, budgeted, agent-stamped. On
                  // resume (S13) the saved messages carry the prepared history — skip prepare.
                  messages =
                    resume !== null ? resume : await prepareMessages(agent, input, opts.session);
                  return streamSegment(
                    agent,
                    messages,
                    {
                      provider,
                      create,
                      maxTurns,
                      toolset: agent.tools,
                      resolve: (n) => agent.getTool(n),
                      transferTargets: EMPTY_TARGETS,
                      onTurn,
                      guardrails: gate.effective(agent, opts.guardrails),
                    },
                    (ev) => queue.push(ev),
                  );
                }),
              ),
            ),
          );
          await opts.session?.replace(messages);
          if (opts.session) emitMemory('save', opts.session, runId); // E-wave: memory.save
          ckpt?.save({ run_id: runId, messages, done: true, output: res.output }); // S13: final done
          return new Result({
            output: parseOutput(res.output, agent.outputType),
            steps,
            traceId: runId,
            conversationId: opts.session?.id ?? '', // S6
            agents: [agent.name],
            messages,
            incomplete: res.output === null,
            guardrailDecisions: gate.snapshot(),
          });
        }),
      );
      queue.push(new RunComplete(result));
      queue.close();
    } catch (err) {
      queue.fail(err);
    }
  };
  const producer = produce();
  try {
    for await (const ev of queue) yield ev;
  } finally {
    bus.unsubscribe(sub);
  }
  await producer;
}

/**
 * Run an agent (or a team of agents) over `input` and resolve to a `Result`. The main entry point;
 * `run.stream` / `run.astream` are the live streaming generators.
 *
 * @example
 * ```ts
 * import { Agent, run } from '@cendor/sdk';
 * const agent = new Agent({ name: 'support', model: 'gpt-4o' });
 * const result = await run(agent, 'Summarize my last invoice.');
 * console.log(result.output);
 * ```
 */
export const run: RunFn = Object.assign(runImpl, { stream: streamImpl, astream: streamImpl });

export { currentTraceId, trace } from '@cendor/core';
