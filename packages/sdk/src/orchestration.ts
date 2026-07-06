/**
 * Orchestration — the TS port of `cendor.sdk.orchestration`. Handoff teams carry the canonical
 * conversation across provider switches via synthetic `transfer_to_<peer>` tools; every segment runs
 * under a child trace id `${parent}:${agent}#${seg}` so all steps form one correlated tree. Also
 * `sequential` (pipe), `parallel` / `parallelAsync` (fan-out), and `supervisor` (router).
 */
import { bus } from '@cendor/core';
import { z } from 'zod';
import type { Agent, HandoffTarget } from './agent.js';
import { assistantMessage, toolResultMessage } from './providers.js';
import { callWithRetry } from './resilience.js';
import {
  buildCallKwargs,
  injectRetrievedContext,
  makeCollector,
  parseOutput,
  uuidHex,
} from './runner.js';
import type { RunOptions } from './runner.js';
import { type Tool, tool } from './tools.js';
import { Result, RunComplete, type Step, type StreamEvent, TextDelta } from './types.js';
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

function resolveInput(input: string | Message | Message[]): Message[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) return [...input];
  return [input];
}

function transferTools(
  active: Agent,
  registry: Map<string, Agent>,
): { tools: Tool[]; targets: Map<string, string> } {
  const tools: Tool[] = [];
  const targets = new Map<string, string>();
  for (const h of active.handoffs) {
    const name = targetName(h);
    if (name === active.name || !registry.has(name)) continue;
    const toolName = `${TRANSFER}${name}`;
    targets.set(toolName, name);
    tools.push(
      tool(() => `Transferring to the '${name}' agent.`, {
        name: toolName,
        description: `Hand off the conversation to the '${name}' agent when it is better suited.`,
        parameters: z.object({ reason: z.string() }),
      }),
    );
  }
  return { tools, targets };
}

async function runSegment(
  active: Agent,
  messages: Message[],
  extraTools: Tool[],
  transferTargets: Map<string, string>,
  retry: RunOptions['retry'],
): Promise<{ output: unknown; switchTo: string | null }> {
  const provider = active.providerImpl;
  const create = provider.createMethod(provider.client(active.clientConfig()));
  const toolset = [...active.tools, ...extraTools];
  const toolMap = new Map(toolset.map((t) => [t.name, t]));
  for (let turn = 0; turn < active.maxTurns; turn++) {
    const wire = await injectRetrievedContext(active, messages);
    // buildCallKwargs uses agent.toolset; inline the augmented toolset here instead.
    const base = buildCallKwargs(active, wire);
    if (toolset.length > 0) {
      base.tools = toolset.map((t) =>
        provider.name === 'anthropic'
          ? t.toAnthropic()
          : provider.name === 'openai_responses'
            ? t.toOpenaiResponses()
            : t.toOpenai(),
      );
    }
    const response = await callWithRetry(() => create(base), retry ?? null);
    const parsed = provider.parse(response);
    messages.push(assistantMessage(parsed.content, parsed.toolCalls));
    if (parsed.toolCalls.length === 0) {
      return { output: parseOutput(parsed.content, active.outputType), switchTo: null };
    }
    let switchTo: string | null = null;
    for (const tc of parsed.toolCalls) {
      const target = transferTargets.get(tc.name);
      if (target) {
        switchTo = target;
        messages.push(toolResultMessage(tc.id, tc.name, `Transferring to the '${target}' agent.`));
        continue;
      }
      const t = toolMap.get(tc.name);
      let result: string;
      if (!t) result = `[error] unknown tool: ${tc.name}`;
      else {
        try {
          const r = await t.invoke(tc.arguments);
          result = typeof r === 'string' ? r : JSON.stringify(r);
        } catch (err) {
          result = `[error] ${(err as Error)?.message ?? String(err)}`;
        }
      }
      messages.push(toolResultMessage(tc.id, tc.name, result));
    }
    if (switchTo) return { output: null, switchTo };
  }
  return { output: null, switchTo: null };
}

function agentFromTrace(parent: string): (traceId: string) => string {
  return (t) => {
    if (!t.startsWith(`${parent}:`)) return '';
    const rest = t.slice(parent.length + 1);
    const hash = rest.lastIndexOf('#');
    return hash >= 0 ? rest.slice(0, hash) : rest;
  };
}

/** Run a handoff team. `agents[0]` is the entry point; peers are reachable by handoff. */
export async function runAgents(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const registry = new Map(agents.map((a) => [a.name, a]));
  const parent = uuidHex();
  const { steps, sub } = makeCollector(
    (t) => t.startsWith(`${parent}:`),
    agentFromTrace(parent),
    opts.onStep,
  );
  bus.subscribe(sub);
  const seen: string[] = [];
  const messages: Message[] = [...(opts.session?.snapshot() ?? []), ...resolveInput(input)];
  let active: Agent | undefined = agents[0];
  let output: unknown = null;
  const maxSegments = 2 * registry.size + 2;
  try {
    const { trace } = await import('@cendor/core');
    for (let seg = 0; seg < maxSegments && active; seg++) {
      if (!seen.includes(active.name)) seen.push(active.name);
      const { tools, targets } = transferTools(active, registry);
      const childTrace = `${parent}:${active.name}#${seg}`;
      const activeAgent: Agent = active;
      const res = await trace(childTrace, () =>
        runSegment(activeAgent, messages, tools, targets, opts.retry ?? null),
      );
      if (res.switchTo && registry.has(res.switchTo)) {
        active = registry.get(res.switchTo);
        continue;
      }
      output = res.output;
      break;
    }
    opts.session?.replace(messages);
    return new Result({
      output,
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
  const { run } = await import('./runner.js');
  let current: string | Message | Message[] = input;
  let last: Result | null = null;
  const allSteps: Step[] = [];
  const seen: string[] = [];
  const messages: Message[] = [];
  for (const a of agents) {
    const r = await run(a, current, { audit: opts.audit ?? null, maxTurns: opts.maxTurns ?? null });
    allSteps.push(...r.steps);
    seen.push(a.name);
    messages.push(...r.messages);
    current = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    last = r;
  }
  return new Result({ output: last?.output ?? null, steps: allSteps, agents: seen, messages });
}

/** Run each agent on the same input (sequential execution); output is `{name: output}`. */
export async function parallel(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const { run } = await import('./runner.js');
  const out: Record<string, unknown> = {};
  const allSteps: Step[] = [];
  for (const a of agents) {
    const r = await run(a, input, { audit: opts.audit ?? null, maxTurns: opts.maxTurns ?? null });
    out[a.name] = r.output;
    allSteps.push(...r.steps);
  }
  return new Result({
    output: out,
    steps: allSteps,
    agents: agents.map((a) => a.name),
    messages: [],
  });
}

/** Real concurrency via `Promise.all`; output is `{name: output}`. */
export async function parallelAsync(
  agents: Agent[],
  input: string | Message | Message[],
  opts: RunOptions = {},
): Promise<Result> {
  const { run } = await import('./runner.js');
  const results = await Promise.all(
    agents.map((a) =>
      run(a, input, { audit: opts.audit ?? null, maxTurns: opts.maxTurns ?? null }),
    ),
  );
  const out: Record<string, unknown> = {};
  const allSteps: Step[] = [];
  results.forEach((r, i) => {
    out[agents[i]!.name] = r.output;
    allSteps.push(...r.steps);
  });
  return new Result({
    output: out,
    steps: allSteps,
    agents: agents.map((a) => a.name),
    messages: [],
  });
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

/** Multi-agent streaming (v1.1). Runs the team and yields the final output as a `TextDelta` + `RunComplete`. */
export async function* streamAgents(
  agents: Agent[],
  input: string | Message | Message[],
  opts: Omit<RunOptions, 'onStep' | 'retry'> = {},
): AsyncGenerator<StreamEvent> {
  const result = await runAgents(agents, input, opts);
  if (typeof result.output === 'string' && result.output) yield new TextDelta(result.output);
  yield new RunComplete(result);
}
