/**
 * Orchestration — the TS port of `cendor.sdk.orchestration`. Handoff teams carry the canonical
 * conversation across provider switches via synthetic `transfer_to_<peer>` tools; every segment runs
 * under a child trace id `${parent}:${agent}#${seg}` so all steps form one correlated tree. Per-agent
 * governance rides the same seams: each segment is wrapped in `track({agent})` and, when the agent
 * sets `maxUsd`, a per-agent `budget(...)`, and opens its own audit `decision()` on the shared
 * `AuditLog`. Also `sequential` (pipe), `parallel` / `parallelAsync` (fan-out), and `supervisor`.
 */
import { bus, trace } from '@cendor/core';
import { track, withBudget } from '@cendor/tokenguard';
import { z } from 'zod';
import type { Agent, HandoffTarget } from './agent.js';
import { type Checkpointer, asCheckpointer } from './checkpoint.js';
import {
  type EventQueue,
  agentLoop,
  createEventQueue,
  makeCollector,
  parseOutput,
  prepareMessages,
  providerAndCreate,
  streamSegment,
  uuidHex,
  withAuditDecision,
} from './runner.js';
import type { RunOptions } from './runner.js';
import { type Tool, tool } from './tools.js';
import { Result, RunComplete, type Step, type StreamEvent } from './types.js';
import type { Message } from './types.js';

const TRANSFER = 'transfer_to_';

/** A declared handoff target. */
export class Handoff {
  constructor(readonly target: string) {}
}
/** Declare a handoff target for `Agent({ handoffs: [...] })`. */
export function handoff(agentOrName: Agent | string | Handoff): Handoff {
  if (agentOrName instanceof Handoff) return agentOrName;
  return new Handoff(typeof agentOrName === 'string' ? agentOrName : agentOrName.name);
}

function targetName(t: HandoffTarget): string {
  if (typeof t === 'string') return t;
  if ('target' in t) return t.target;
  return (t as Agent).name;
}

function userMessage(value: unknown): Message {
  return { role: 'user', content: typeof value === 'string' ? value : String(value) };
}

/** Agent tools + synthetic transfer tools for its reachable handoff peers (PY `_effective`). */
function effective(
  active: Agent,
  registry: Map<string, Agent>,
): { toolset: Tool[]; targets: Map<string, string> } {
  const toolset: Tool[] = [...active.tools];
  const targets = new Map<string, string>();
  for (const h of active.handoffs) {
    const name = targetName(h);
    if (name === active.name || !registry.has(name)) continue;
    const toolName = `${TRANSFER}${name}`;
    targets.set(toolName, name);
    toolset.push(
      tool(() => `Transferred to ${name}.`, {
        name: toolName,
        description: `Hand off the conversation to the '${name}' agent when it is better suited.`,
        parameters: z.object({ reason: z.string() }),
      }),
    );
  }
  return { toolset, targets };
}

/** Per-agent governance: attribute spend to the agent + enforce its `maxUsd` cap (PY `_scope`). */
function withScope<T>(agent: Agent, fn: () => Promise<T>): Promise<T> {
  return track({ agent: agent.name }, () => {
    if (agent.maxUsd != null) {
      return withBudgetBlock(agent.maxUsd, fn);
    }
    return fn();
  });
}

async function withBudgetBlock<T>(usd: number, fn: () => Promise<T>): Promise<T> {
  // onExceed:'block' never resolves to undefined (it throws BudgetExceeded), so the cast is sound.
  return (await withBudget({ usd, onExceed: 'block' }, fn)) as T;
}

function toolResolver(toolset: Tool[]): (name: string) => Tool | null | undefined {
  const map = new Map(toolset.map((t) => [t.name, t]));
  return (name) => map.get(name);
}

function agentFromTrace(parent: string): (traceId: string) => string {
  return (t) => {
    if (!t.startsWith(`${parent}:`)) return '';
    const rest = t.slice(parent.length + 1);
    const hash = rest.lastIndexOf('#');
    return hash >= 0 ? rest.slice(0, hash) : rest;
  };
}

/**
 * Resolve `(parent, messages, active, seen, startSeg)` from an unfinished checkpoint, or start fresh.
 * Multi-agent resume PRESERVES the saved run_id (the parent trace id) and ignores the new input (PY
 * `_resume_state`).
 */
async function resumeState(
  ckpt: Checkpointer | null,
  agents: Agent[],
  input: string | Message | Message[],
  session: RunOptions['session'],
): Promise<{
  parent: string;
  messages: Message[];
  active: Agent;
  seen: string[];
  startSeg: number;
}> {
  const registry = new Map(agents.map((a) => [a.name, a]));
  const state = ckpt?.load() ?? null;
  if (state && !state.done) {
    return {
      parent: state.run_id || uuidHex(),
      messages: [...(state.messages ?? [])],
      active: registry.get(state.active ?? '') ?? agents[0]!,
      seen: [...(state.seen ?? [])],
      startSeg: state.seg ?? 0,
    };
  }
  return {
    parent: uuidHex(),
    messages: await prepareMessages(agents[0]!, input, session),
    active: agents[0]!,
    seen: [],
    startSeg: 0,
  };
}

/** Run a handoff team. `agents[0]` is the entry point; peers are reachable by handoff. */
export async function runAgents(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const ckpt = asCheckpointer(opts.checkpoint);
  const registry = new Map(agents.map((a) => [a.name, a]));
  const {
    parent,
    messages,
    active: startActive,
    seen,
    startSeg,
  } = await resumeState(ckpt, agents, input, opts.session);
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    opts.onStep,
  );
  bus.subscribe(sub);
  let active: Agent = startActive;
  let output: string | null = null;
  const maxSegments = 2 * registry.size + 2;
  let seg = startSeg;
  const save = (done: boolean, segNo: number, activeName: string, out: unknown = null): void => {
    ckpt?.save({
      run_id: parent,
      messages,
      active: activeName,
      seen,
      seg: segNo,
      done,
      output: out,
    });
  };
  try {
    for (seg = startSeg; seg < maxSegments; seg++) {
      if (!seen.includes(active.name)) seen.push(active.name);
      const child = `${parent}:${active.name}#${seg}`;
      const { toolset, targets } = effective(active, registry);
      const a = active;
      const segNo = seg;
      const onTurn = ckpt ? (): void => save(false, segNo, a.name) : null;
      const { provider, create } = providerAndCreate(a);
      const res = await withScope(a, () =>
        trace(child, () =>
          withAuditDecision(opts.audit, messages, a.name, a.model, child, () =>
            agentLoop(a, messages, {
              provider,
              create,
              maxTurns: opts.maxTurns ?? a.maxTurns,
              retry: opts.retry ?? null,
              toolset,
              resolve: toolResolver(toolset),
              transferTargets: targets,
              onTurn,
            }),
          ),
        ),
      );
      if (res.switchTo && registry.has(res.switchTo)) {
        active = registry.get(res.switchTo)!;
        save(false, seg + 1, active.name);
        continue;
      }
      output = res.output;
      break;
    }
    await opts.session?.replace(messages);
    save(true, seg, active.name, output);
    return new Result({
      output: parseOutput(output, active.outputType),
      steps,
      traceId: parent,
      agents: seen,
      messages,
      incomplete: output === null,
    });
  } finally {
    bus.unsubscribe(sub);
  }
}

/** Async alias of {@link runAgents} (JS is async-first; both names exported for parity). */
export const runAgentsAsync = runAgents;

/** Pipe each agent's output into the next as a fresh user message. */
export async function sequential(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const parent = uuidHex();
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    opts.onStep,
  );
  bus.subscribe(sub);
  const seen: string[] = [];
  const messagesAll: Message[] = [];
  let current: unknown = input;
  let output: string | null = null;
  try {
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      seen.push(agent.name);
      const child = `${parent}:${agent.name}#${i}`;
      const msgs: Message[] = [userMessage(current)];
      const { provider, create } = providerAndCreate(agent);
      const res = await withScope(agent, () =>
        trace(child, () =>
          withAuditDecision(opts.audit, msgs, agent.name, agent.model, child, () =>
            agentLoop(agent, msgs, {
              provider,
              create,
              maxTurns: opts.maxTurns ?? agent.maxTurns,
              retry: opts.retry ?? null,
              toolset: agent.tools,
              resolve: (n) => agent.getTool(n),
              transferTargets: new Map(),
            }),
          ),
        ),
      );
      output = res.output;
      messagesAll.push(...msgs);
      current = output;
    }
    return new Result({
      output,
      steps,
      traceId: parent,
      agents: seen,
      messages: messagesAll,
    });
  } finally {
    bus.unsubscribe(sub);
  }
}

/** Run each agent on the same input (sequential execution); output is `{name: output}`. */
export async function parallel(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const parent = uuidHex();
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    opts.onStep,
  );
  bus.subscribe(sub);
  const outputs: Record<string, unknown> = {};
  try {
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      outputs[agent.name] = await runOneAgent(agent, `${parent}:${agent.name}#${i}`, input, opts);
    }
    return new Result({
      output: outputs,
      steps,
      traceId: parent,
      agents: agents.map((a) => a.name),
      messages: [],
    });
  } finally {
    bus.unsubscribe(sub);
  }
}

/** Real concurrency via `Promise.all`; output is `{name: output}`. */
export async function parallelAsync(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const parent = uuidHex();
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    opts.onStep,
  );
  bus.subscribe(sub);
  try {
    const pairs = await Promise.all(
      agents.map(async (agent, i) => {
        const out = await runOneAgent(agent, `${parent}:${agent.name}#${i}`, input, opts);
        return [agent.name, out] as const;
      }),
    );
    const outputs: Record<string, unknown> = {};
    for (const [name, out] of pairs) outputs[name] = out;
    return new Result({
      output: outputs,
      steps,
      traceId: parent,
      agents: agents.map((a) => a.name),
      messages: [],
    });
  } finally {
    bus.unsubscribe(sub);
  }
}

/** Run a single agent under a given child trace id with per-agent scope + decision (fan-out helper). */
async function runOneAgent(
  agent: Agent,
  child: string,
  input: string | Message | Message[],
  opts: RunOptions,
): Promise<string | null> {
  const msgs: Message[] = [userMessage(input)];
  const { provider, create } = providerAndCreate(agent);
  const res = await withScope(agent, () =>
    trace(child, () =>
      withAuditDecision(opts.audit, msgs, agent.name, agent.model, child, () =>
        agentLoop(agent, msgs, {
          provider,
          create,
          maxTurns: opts.maxTurns ?? agent.maxTurns,
          retry: opts.retry ?? null,
          toolset: agent.tools,
          resolve: (n) => agent.getTool(n),
          transferTargets: new Map(),
        }),
      ),
    ),
  );
  return res.output;
}

/** Router pattern — the coordinator hands off to any sub-agent. */
export async function supervisor(
  coordinator: Agent,
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const names = agents.map((a) => a.name);
  for (const n of names)
    if (!coordinator.handoffs.some((h) => targetName(h) === n)) coordinator.handoffs.push(n);
  return runAgents([coordinator, ...agents], input, opts);
}

/**
 * Multi-agent live streaming: stream each active agent's turns, switch active agent on a
 * `transfer_to_<peer>` tool call, and emit a single terminal `RunComplete` with the aggregate
 * `Result` (agents in first-seen order, steps from all segments, traceId = parent). Mirrors PY
 * `stream_agents_sync`.
 */
export async function* streamAgents(
  agents: Agent[],
  input: string | Message | Message[],
  opts: Omit<RunOptions, 'onStep' | 'retry'> = {},
): AsyncGenerator<StreamEvent> {
  const registry = new Map(agents.map((a) => [a.name, a]));
  const parent = uuidHex();
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    null,
  );
  bus.subscribe(sub);
  const queue: EventQueue<StreamEvent> = createEventQueue<StreamEvent>();
  const seen: string[] = [];
  const messages = await prepareMessages(agents[0]!, input, opts.session);
  let active: Agent = agents[0]!;
  let output: string | null = null;
  const maxSegments = 2 * registry.size + 2;
  const produce = async (): Promise<void> => {
    try {
      for (let seg = 0; seg < maxSegments; seg++) {
        if (!seen.includes(active.name)) seen.push(active.name);
        const child = `${parent}:${active.name}#${seg}`;
        const { toolset, targets } = effective(active, registry);
        const a = active;
        const { provider, create } = providerAndCreate(a);
        const res = await withScope(a, () =>
          trace(child, () =>
            withAuditDecision(opts.audit, messages, a.name, a.model, child, () =>
              streamSegment(
                a,
                messages,
                {
                  provider,
                  create,
                  maxTurns: opts.maxTurns ?? a.maxTurns,
                  toolset,
                  resolve: toolResolver(toolset),
                  transferTargets: targets,
                },
                (ev) => queue.push(ev),
              ),
            ),
          ),
        );
        if (res.switchTo && registry.has(res.switchTo)) {
          active = registry.get(res.switchTo)!;
          continue;
        }
        output = res.output;
        break;
      }
      await opts.session?.replace(messages);
      queue.push(
        new RunComplete(
          new Result({
            output: parseOutput(output, active.outputType),
            steps,
            traceId: parent,
            agents: seen,
            messages,
            incomplete: output === null,
          }),
        ),
      );
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

// re-export for downstream consumers that only import from orchestration
export type { Step };
