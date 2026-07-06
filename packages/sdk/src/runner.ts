/**
 * The agent loop — the TS port of `cendor.sdk.runner`. Async-first: `run(agent, input, opts)` returns
 * a `Promise<Result>`; `run.stream` / `run.astream` are async generators. History is kept in the
 * canonical (OpenAI Chat) shape with the system prompt out of the list. Governance rides core's bus:
 * a per-run collector (scoped by `trace(runId)`) harvests LLM/tool calls into `Result.steps` and fires
 * the live `onStep` hook (a raised hook never breaks a run). A list of agents dispatches to
 * orchestration (handoff team).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditLog } from '@cendor/acttrace';
import { LLMCall, ToolCall, bus, installTraceContext, trace } from '@cendor/core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Agent } from './agent.js';
import { type Provider, assistantMessage, toolResultMessage } from './providers.js';
import { type RetryPolicy, callWithRetry } from './resilience.js';
import type { JsonSchema } from './tools.js';
import {
  type Message,
  type ParsedResponse,
  Result,
  RunComplete,
  Step,
  type StreamEvent,
  TextDelta,
  ToolCallEvent,
  ToolResultEvent,
} from './types.js';

// Concurrency-correct trace correlation (server-side; overlapping runs stay isolated).
installTraceContext(new AsyncLocalStorage<string>());

export interface RunOptions {
  session?: { snapshot(): Message[]; replace(messages: Message[]): void } | null;
  audit?: AuditLog | null;
  maxTurns?: number | null;
  retry?: RetryPolicy | null;
  onStep?: ((step: Step) => void) | null;
}

export function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function resolveMessages(input: string | Message | Message[]): Message[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) return [...input];
  return [input];
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
  if (isZodSchema(outputType)) {
    const js = zodToJsonSchema(outputType as never, { $refStrategy: 'none' }) as JsonSchema;
    // biome-ignore lint/performance/noDelete: strip the JSON-schema meta key
    delete js.$schema;
    return js;
  }
  if (typeof outputType === 'object') return outputType as JsonSchema;
  return null;
}

function parseOutput(content: string | null, outputType: unknown): unknown {
  if (!outputType || content === null) return content;
  let data: unknown = content;
  try {
    data = JSON.parse(content);
  } catch {
    return content; // provider didn't emit JSON — return the prose
  }
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

async function injectRetrievedContext(agent: Agent, messages: Message[]): Promise<Message[]> {
  if (!agent.retriever) return messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const query = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
  if (!query) return messages;
  const chunks = await agent.retriever(query);
  if (!chunks || chunks.length === 0) return messages;
  const ctx: Message = {
    role: 'system',
    content: `Relevant context:\n\n${chunks.join('\n\n---\n\n')}`,
  };
  // insert before the last user message
  const idx = messages.lastIndexOf(lastUser as Message);
  const out = [...messages];
  out.splice(idx, 0, ctx);
  return out;
}

interface LoopContext {
  runId: string;
  agent: Agent;
  provider: Provider;
  create: (kwargs: Record<string, unknown>) => Promise<unknown>;
  maxTurns: number;
  retry: RetryPolicy | null;
}

export { parseOutput, injectRetrievedContext, makeCollector };

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

async function executeToolCalls(
  agent: Agent,
  parsed: ParsedResponse,
  messages: Message[],
): Promise<void> {
  const results = await Promise.all(
    parsed.toolCalls.map(async (tc) => {
      const tool = agent.getTool(tc.name);
      if (!tool) return `[error] unknown tool: ${tc.name}`;
      try {
        return stringifyResult(await tool.invoke(tc.arguments));
      } catch (err) {
        return `[error] ${(err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`;
      }
    }),
  );
  parsed.toolCalls.forEach((tc, i) =>
    messages.push(toolResultMessage(tc.id, tc.name, results[i]!)),
  );
}

/** Run one agent's blocking loop, mutating `messages`. Returns the final output (or null if incomplete). */
async function runLoop(ctx: LoopContext, messages: Message[]): Promise<unknown> {
  const { agent } = ctx;
  let output: unknown = null;
  for (let turn = 0; turn < ctx.maxTurns; turn++) {
    const wire = await injectRetrievedContext(agent, messages);
    const kwargs = buildCallKwargs(agent, wire);
    const response = await callWithRetry(() => ctx.create(kwargs), ctx.retry);
    const parsed = ctx.provider.parse(response);
    messages.push(assistantMessage(parsed.content, parsed.toolCalls));
    if (parsed.toolCalls.length > 0) {
      await executeToolCalls(agent, parsed, messages);
      continue;
    }
    output = parseOutput(parsed.content, agent.outputType);
    return output;
  }
  return output; // exhausted maxTurns without a final answer -> null -> incomplete
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
    const step = new Step(
      agentFor(event.traceId),
      event instanceof LLMCall ? 'llm' : 'tool',
      event,
    );
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

async function withAuditDecision<T>(
  audit: AuditLog | null | undefined,
  input: unknown,
  agentName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!audit) return fn();
  return audit.decision(async () => fn(), { input, actor: agentName });
}

/** Drive one `Agent`. */
export class Runner {
  constructor(
    readonly agent: Agent,
    readonly opts: RunOptions = {},
  ) {}

  async run(input: string | Message | Message[]): Promise<Result> {
    const agent = this.agent;
    const runId = uuidHex();
    const provider = agent.providerImpl;
    const create = provider.createMethod(provider.client(agent.clientConfig()));
    const maxTurns = this.opts.maxTurns ?? agent.maxTurns;
    const messages: Message[] = [
      ...(this.opts.session?.snapshot() ?? []),
      ...resolveMessages(input),
    ];
    const { steps, sub } = makeCollector(
      (t) => t === runId,
      () => agent.name,
      this.opts.onStep,
    );
    bus.subscribe(sub);
    try {
      const output = await trace(runId, () =>
        withAuditDecision(this.opts.audit, input, agent.name, () =>
          runLoop(
            { runId, agent, provider, create, maxTurns, retry: this.opts.retry ?? null },
            messages,
          ),
        ),
      );
      this.opts.session?.replace(messages);
      return new Result({
        output,
        steps,
        traceId: runId,
        agents: [agent.name],
        messages,
        incomplete: output === null,
      });
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

/** Single-agent streaming: native token streaming for OpenAI-family, whole-response fallback otherwise. */
export async function* streamOne(
  agent: Agent,
  input: string | Message | Message[],
  opts: Omit<RunOptions, 'onStep' | 'retry'> = {},
): AsyncGenerator<StreamEvent> {
  const runId = uuidHex();
  const provider = agent.providerImpl;
  const client = provider.client(agent.clientConfig());
  const create = provider.createMethod(client);
  const maxTurns = opts.maxTurns ?? agent.maxTurns;
  const messages: Message[] = [...(opts.session?.snapshot() ?? []), ...resolveMessages(input)];
  const { steps, sub } = makeCollector(
    (t) => t === runId,
    () => agent.name,
    null,
  );
  bus.subscribe(sub);
  let output: unknown = null;
  try {
    const events: StreamEvent[] = [];
    const gen = trace(runId, async () => {
      for (let turn = 0; turn < maxTurns; turn++) {
        const wire = await injectRetrievedContext(agent, messages);
        const kwargs = buildCallKwargs(agent, wire);
        let parsed: ParsedResponse;
        if (provider.supportsStream) {
          kwargs.stream = true;
          const stream = (await create(kwargs)) as AsyncIterable<unknown>;
          const chunks: unknown[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
            const text = provider.streamText(chunk);
            if (text) events.push(new TextDelta(text));
          }
          parsed = provider.parseStream(chunks);
        } else {
          const response = await create(kwargs);
          parsed = provider.parse(response);
          if (parsed.content) events.push(new TextDelta(parsed.content));
        }
        messages.push(assistantMessage(parsed.content, parsed.toolCalls));
        if (parsed.toolCalls.length > 0) {
          for (const tc of parsed.toolCalls)
            events.push(new ToolCallEvent(tc.name, tc.arguments, tc.id));
          await executeToolCalls(agent, parsed, messages);
          for (const tc of parsed.toolCalls) {
            const rmsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === tc.id);
            events.push(new ToolResultEvent(tc.name, String(rmsg?.content ?? '')));
          }
          continue;
        }
        output = parseOutput(parsed.content, agent.outputType);
        return;
      }
    });
    // Collect events as the trace runs. (trace returns a promise; events fill synchronously per await.)
    await gen;
    for (const ev of events) yield ev;
    opts.session?.replace(messages);
    yield new RunComplete(
      new Result({
        output,
        steps,
        traceId: runId,
        agents: [agent.name],
        messages,
        incomplete: output === null,
      }),
    );
  } finally {
    bus.unsubscribe(sub);
  }
}

export const run: RunFn = Object.assign(runImpl, { stream: streamImpl, astream: streamImpl });

export { currentTraceId, trace } from '@cendor/core';
