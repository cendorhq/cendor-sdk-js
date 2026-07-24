/**
 * Orchestration — the TS port of `cendor.sdk.orchestration`. Handoff teams carry the canonical
 * conversation across provider switches via synthetic `transfer_to_<peer>` tools; every segment runs
 * under a child trace id `${parent}:${agent}#${seg}` so all steps form one correlated tree. Per-agent
 * governance rides the same seams: each segment is wrapped in `track({agent})` and, when the agent
 * sets `maxUsd`, a per-agent `budget(...)`, and opens its own audit `decision()` on the shared
 * `AuditLog`. Also `sequential` (pipe), `parallel` / `parallelAsync` (fan-out), and `supervisor`.
 */
import { bus, trace } from '@cendor/core';
import { z } from 'zod';
import { emitCheckpoint, emitHandoff, emitMemory } from './_telemetry.js';
import type { Agent, HandoffTarget } from './agent.js';
import { type CheckpointState, asCheckpointer } from './checkpoint.js';
import * as gate from './gate.js';
import { withConversation, withScope } from './governance.js';
import { withLiveRootActive } from './otel.js';
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
 * `_resume_state`). A DONE checkpoint is handled by the caller's short-circuit before this runs.
 */
function resumeState(
  state: CheckpointState | null,
  agents: Agent[],
): {
  parent: string;
  messages: Message[];
  active: Agent;
  seen: string[];
  startSeg: number;
  prepared: boolean;
} {
  const registry = new Map(agents.map((a) => [a.name, a]));
  if (state && !state.done) {
    // E-wave: checkpoint.resume span (unfinished team run — continue from the saved state).
    emitCheckpoint(
      'resume',
      state.run_id ?? '',
      false,
      (state.messages ?? []).length,
      state.seg ?? null,
    );
    return {
      parent: state.run_id || uuidHex(),
      messages: [...(state.messages ?? [])],
      active: registry.get(state.active ?? '') ?? agents[0]!,
      seen: [...(state.seen ?? [])],
      startSeg: state.seg ?? 0,
      prepared: true, // a resumed conversation already carries its prepared messages
    };
  }
  // GLR-4: a fresh run prepares inside the first segment's scope (so the entry agent's retriever
  // embed is attributed to the run), not here — outside every scope.
  return {
    parent: uuidHex(),
    messages: [],
    active: agents[0]!,
    seen: [],
    startSeg: 0,
    prepared: false,
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
  const saved = ckpt?.load() ?? null;
  // Done-resume short-circuit: a completed checkpoint replays its stored result WITHOUT minting a
  // run or re-entering any segment (no model call, no tool re-run). Steps are empty (no bus events);
  // the persisted messages/output are returned as-is. PY parity with the single-agent short-circuit.
  if (saved?.done) {
    const finalAgent = registry.get(saved.active ?? '') ?? agents[0]!;
    emitCheckpoint('resume', saved.run_id ?? '', true, (saved.messages ?? []).length); // E-wave
    return new Result({
      // Stored `output` is the raw model content persisted at completion (always string | null).
      output: parseOutput((saved.output ?? null) as string | null, finalAgent.outputType),
      steps: [],
      traceId: saved.run_id ?? '',
      conversationId: opts.session?.id ?? '', // S6
      agents: [...(saved.seen ?? [])],
      messages: [...(saved.messages ?? [])],
      incomplete: saved.output == null,
      guardrailDecisions: [], // empty on a resume (no segment ran)
    });
  }
  const {
    parent,
    messages: initialMessages,
    active: startActive,
    seen,
    startSeg,
    prepared: preparedInit,
  } = resumeState(saved, agents);
  let messages = initialMessages;
  let prepared = preparedInit; // GLR-4: a fresh run prepares inside the first segment's scope
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
    // withLiveRootActive makes the caller's liveSpans run root (if any) the active context span for
    // the whole team run, so audit entries correlate + audit.* spans join the run trace (no-op
    // without a scope / OTel; parity with Python live_spans). `collecting` gathers guardrail decisions.
    return await withLiveRootActive(() =>
      gate.collecting(async () => {
        for (seg = startSeg; seg < maxSegments; seg++) {
          if (!seen.includes(active.name)) seen.push(active.name);
          const child = `${parent}:${active.name}#${seg}`;
          const { toolset, targets } = effective(active, registry);
          const a = active;
          const segNo = seg;
          const onTurn = ckpt ? (): void => save(false, segNo, a.name) : null;
          const { provider, create } = providerAndCreate(a);
          // S6: withConversation propagates the session key to liveSpans (G19) for the whole team run.
          const res = await withConversation(opts.session, () =>
            withScope(a, () =>
              trace(child, async () => {
                // GLR-4: prepare the entry agent's messages inside its scope (first segment only), so
                // a retriever's embed call is attributed to the run (traceId=child) rather than
                // firing outside every scope.
                if (!prepared) {
                  messages = await prepareMessages(a, input, opts.session);
                  prepared = true;
                }
                return withAuditDecision(opts.audit, messages, a.name, a.model, child, () =>
                  agentLoop(a, messages, {
                    provider,
                    create,
                    maxTurns: opts.maxTurns ?? a.maxTurns,
                    retry: opts.retry ?? null,
                    toolset,
                    resolve: toolResolver(toolset),
                    transferTargets: targets,
                    onTurn,
                    guardrails: gate.effective(a, opts.guardrails),
                  }),
                );
              }),
            ),
          );
          if (res.switchTo && registry.has(res.switchTo)) {
            emitHandoff(active.name, res.switchTo, seg, `transfer_to_${res.switchTo}`, parent); // E-wave
            active = registry.get(res.switchTo)!;
            save(false, seg + 1, active.name);
            continue;
          }
          output = res.output;
          break;
        }
        await opts.session?.replace(messages);
        if (opts.session) emitMemory('save', opts.session, parent); // E-wave: memory.save
        save(true, seg, active.name, output);
        return new Result({
          output: parseOutput(output, active.outputType),
          steps,
          traceId: parent,
          conversationId: opts.session?.id ?? '', // S6
          agents: seen,
          messages,
          incomplete: output === null,
          guardrailDecisions: gate.snapshot(),
        });
      }),
    );
  } finally {
    bus.unsubscribe(sub);
  }
}

/** Async alias of {@link runAgents} (JS is async-first; both names exported for parity). */
export const runAgentsAsync = runAgents;

/**
 * Pipe each agent's output into the next as a fresh user message. Honours the per-run governance
 * surface — `audit`, `maxTurns`, `retry`, `onStep`, and `guardrails` (a per-run override of each
 * agent's list; decisions collected into `result.guardrailDecisions`). **`session` / `checkpoint`
 * are not applied by the pipeline shapes** (a pipe has no single conversation to persist or resume —
 * use a handoff team `runAgents` / `supervisor` for that), and `guardrailMode` is a single-agent-run
 * option (pipes always gate blocking). They stay on the shared {@link RunOptions} type for a uniform
 * call shape. Same behaviour as the Python `sequential`.
 */
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
    return await withLiveRootActive(() =>
      gate.collecting(async () => {
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
                  guardrails: gate.effective(agent, opts.guardrails),
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
          guardrailDecisions: gate.snapshot(),
        });
      }),
    );
  } finally {
    bus.unsubscribe(sub);
  }
}

/**
 * Run each agent on the same input (sequential execution); output is `{name: output}`. Honours the
 * same per-run governance surface as {@link sequential} (`audit` / `maxTurns` / `retry` / `onStep` /
 * `guardrails` → `result.guardrailDecisions`); `session` / `checkpoint` / `guardrailMode` are not
 * applied by the pipeline shapes (team- / single-agent-only).
 */
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
    return await withLiveRootActive(() =>
      gate.collecting(async () => {
        for (let i = 0; i < agents.length; i++) {
          const agent = agents[i]!;
          outputs[agent.name] = await runOneAgent(
            agent,
            `${parent}:${agent.name}#${i}`,
            input,
            opts,
          );
        }
        return new Result({
          output: outputs,
          steps,
          traceId: parent,
          agents: agents.map((a) => a.name),
          messages: [],
          guardrailDecisions: gate.snapshot(),
        });
      }),
    );
  } finally {
    bus.unsubscribe(sub);
  }
}

/**
 * Real concurrency via `Promise.all`; output is `{name: output}`. Honours the same per-run governance
 * surface as {@link sequential}; `session` / `checkpoint` / `guardrailMode` are not applied by the
 * pipeline shapes (team- / single-agent-only).
 */
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
    return await withLiveRootActive(() =>
      gate.collecting(async () => {
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
          guardrailDecisions: gate.snapshot(),
        });
      }),
    );
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
          guardrails: gate.effective(agent, opts.guardrails),
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
  const ckpt = asCheckpointer(opts.checkpoint);
  const saved = ckpt?.load() ?? null;
  // S13: a finished team-stream checkpoint replays its stored Result as a lone terminal RunComplete
  // — no segment runs, no re-yielded deltas (S13-D). Mirrors runAgents' done-resume short-circuit.
  if (saved?.done) {
    const finalAgent = registry.get(saved.active ?? '') ?? agents[0]!;
    emitCheckpoint('resume', saved.run_id ?? '', true, (saved.messages ?? []).length); // E-wave
    yield new RunComplete(
      new Result({
        output: parseOutput((saved.output ?? null) as string | null, finalAgent.outputType),
        steps: [],
        traceId: saved.run_id ?? '',
        conversationId: opts.session?.id ?? '', // S6
        agents: [...(saved.seen ?? [])],
        messages: [...(saved.messages ?? [])],
        incomplete: saved.output == null,
        guardrailDecisions: [],
      }),
    );
    return;
  }
  // S13: resume an unfinished team stream (preserves parent/active/seen/seg; skips prepare) or start
  // fresh (prepare inside the first segment's scope — GLR-4).
  const {
    parent,
    messages: initialMessages,
    active: startActive,
    seen,
    startSeg,
    prepared: preparedInit,
  } = resumeState(saved, agents);
  let messages: Message[] = initialMessages;
  let prepared = preparedInit;
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    null,
  );
  bus.subscribe(sub);
  const queue: EventQueue<StreamEvent> = createEventQueue<StreamEvent>();
  let active: Agent = startActive;
  let output: string | null = null;
  const maxSegments = 2 * registry.size + 2;
  let seg = startSeg;
  const save = (done: boolean, segNo: number, activeName: string): void => {
    ckpt?.save({ run_id: parent, messages, active: activeName, seen, seg: segNo, done, output });
  };
  const produce = async (): Promise<void> => {
    try {
      // withLiveRootActive activates the caller's liveSpans run root for the streamed team run so
      // audit entries correlate + audit.* spans join the run trace (no-op without a scope / OTel).
      // withConversation (G19/S6) propagates the session key so liveSpans groups multi-turn runs.
      const result = await withLiveRootActive(() =>
        gate.collecting(() =>
          withConversation(opts.session, async () => {
            for (seg = startSeg; seg < maxSegments; seg++) {
              if (!seen.includes(active.name)) seen.push(active.name);
              const child = `${parent}:${active.name}#${seg}`;
              const { toolset, targets } = effective(active, registry);
              const a = active;
              const segNo = seg;
              const onTurn = ckpt ? (): void => save(false, segNo, a.name) : null; // S13 per-turn
              const { provider, create } = providerAndCreate(a);
              const res = await withScope(a, () =>
                trace(child, async () => {
                  // GLR-4/S11: prepare inside the first segment's scope so the entry agent's
                  // retriever embed is attributed to the run rather than firing outside every scope.
                  if (!prepared) {
                    messages = await prepareMessages(a, input, opts.session);
                    prepared = true;
                  }
                  return withAuditDecision(opts.audit, messages, a.name, a.model, child, () =>
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
                        onTurn,
                        guardrails: gate.effective(a, opts.guardrails),
                      },
                      (ev) => queue.push(ev),
                    ),
                  );
                }),
              );
              if (res.switchTo && registry.has(res.switchTo)) {
                emitHandoff(active.name, res.switchTo, seg, `transfer_to_${res.switchTo}`, parent); // E-wave
                active = registry.get(res.switchTo)!;
                save(false, seg + 1, active.name); // S13: checkpoint the handoff
                continue;
              }
              output = res.output;
              break;
            }
            await opts.session?.replace(messages);
            if (opts.session) emitMemory('save', opts.session, parent); // E-wave: memory.save
            save(true, seg, active.name); // S13: final done save
            return new Result({
              output: parseOutput(output, active.outputType),
              steps,
              traceId: parent,
              conversationId: opts.session?.id ?? '', // S6
              agents: seen,
              messages,
              incomplete: output === null,
              guardrailDecisions: gate.snapshot(),
            });
          }),
        ),
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

// re-export for downstream consumers that only import from orchestration
export type { Step };
