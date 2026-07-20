/**
 * Governance re-exports — the real `@cendor/tokenguard` / `@cendor/acttrace` objects (never
 * wrappers). That includes `guard`: since `@cendor/acttrace` 0.6.0 it is dual-shape —
 * `guard(policy, audit?)` returns the raw interceptor, `guard(opts, fn)` is the scope form — so
 * the SDK re-exports the identical library object (`Object.is(sdk.guard, acttrace.guard)`).
 * `registerModelPrice` is SDK-owned. A bare `run()` needs none of this; governance rides
 * `@cendor/core`'s bus + interceptor seams.
 *
 * @example
 * ```ts
 * import { rules, judge } from '@cendor/sdk';
 * const deny = rules.keywordDeny(['drop table'], { action: 'block' });
 * const check = judge.judge(async (system, user) => 'x', 'Trip on destructive shell commands.');
 * ```
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Dec, prices } from '@cendor/core';
import {
  BudgetEvent,
  BudgetExceeded,
  budget,
  clamps,
  configure,
  downgrades,
  report,
  track,
  withBudget,
} from '@cendor/tokenguard';
import type { Agent } from './agent.js';

export { budget, withBudget, track, report, configure, downgrades, clamps, BudgetExceeded };
// BudgetEvent (@cendor/tokenguard 0.3): a pre-flight budget action on the bus (blocked/downgraded/
// clamped) — acttrace chains it, an OTelMirror surfaces it in your APM/SIEM.
export { BudgetEvent };
export { AuditLog, OTelMirror, verify, Policy, PolicyViolation, guard } from '@cendor/acttrace';
export type { GuardOptions, OnBlock } from '@cendor/acttrace';
export { trace, currentTraceId } from '@cendor/core';
// The deterministic guardrails gate — the real @cendor/guardrails objects. `defineGuardrail` is the
// TS analogue of Python's `@guardrail`; kept distinct from `guard` above (the acttrace-policy scope).
export { GuardrailDecision, GuardrailTripped, Verdict, defineGuardrail } from '@cendor/guardrails';
export type { Action, Check, Context, Guardrail, Stage } from '@cendor/guardrails';
// BYO-judge helpers (V03 A3): `judge.taskAdherence(respond, opts?)` is a `tool_call`-stage alignment
// check — the SDK auto-threads the user's turn into `Context.instruction` (via the runner), so the
// deferred parity tail is closed. `taskAdherence` is also re-exported directly for one-import parity
// with Python's `cendor.sdk.task_adherence`.
export { judge } from '@cendor/guardrails';
import { judge as _judge } from '@cendor/guardrails';
/**
 * BYO LLM-judge alignment check (`tool_call` stage): *is this proposed tool call aligned with the
 * user's instruction?* Wrap the returned check with `rules.llmJudge` to get a `Guardrail`; the SDK
 * auto-threads the originating turn into `Context.instruction`.
 *
 * @example
 * ```ts
 * import { taskAdherence, rules } from '@cendor/sdk';
 * const check = taskAdherence(async (system, user) => 'x', { action: 'flag' });
 * const guardrail = rules.llmJudge(check, { stage: 'tool_call' });
 * ```
 */
export const taskAdherence = _judge.taskAdherence;
// V04: curated starter injection list + the policy JSON Schema. `loadPolicy(src, { validate })`
// is re-exported too (0.10.0 — closing the config-as-data lag vs Python's `load_policy`).
// `judge.intentPrompt` (the LLM-judge intent backend) rides the re-exported `judge` namespace above.
export { loadPolicy, presets, policySchema } from '@cendor/guardrails';
// `rules` is the SDK's own superset: the deterministic @cendor/guardrails rules re-exported PLUS the
// acttrace-bridged `pii` / `secrets` / `entropy` detector guardrails (SDK-only — the library can't
// import acttrace). One surface: `import { rules } from '@cendor/sdk'`.
export * as rules from './rules.js';

const PER: Record<string, number> = { '1M': 1_000_000, '1K': 1_000, token: 1 };

export interface RegisterModelPriceOptions {
  input: number | string;
  output?: number | string;
  cached?: number | string;
  cacheWrite?: number | string;
  per?: string;
}

/**
 * Register a model's rates (default per 1M tokens) in core's price table so USD budgets bind on it.
 *
 * @example
 * ```ts
 * import { registerModelPrice } from '@cendor/sdk';
 * registerModelPrice('my-fine-tune', { input: 0.5, output: 1.5 });
 * ```
 */
export function registerModelPrice(model: string, opts: RegisterModelPriceOptions): void {
  const per = opts.per ?? '1M';
  const div = PER[per];
  if (div === undefined)
    throw new Error(`per must be one of 1M, 1K, token, got ${JSON.stringify(per)}`);
  const d = (v: number | string) => new Dec(String(v)).dividedBy(div);
  const rates: {
    input: InstanceType<typeof Dec>;
    output: InstanceType<typeof Dec>;
    cached?: InstanceType<typeof Dec>;
    cache_write?: InstanceType<typeof Dec>;
  } = {
    input: d(opts.input),
    output: d(opts.output ?? 0),
  };
  if (opts.cached != null) rates.cached = d(opts.cached);
  if (opts.cacheWrite != null) rates.cache_write = d(opts.cacheWrite);
  prices.register(model, rates);
}

/**
 * Per-agent governance: attribute spend to the agent (`track({agent})`) + enforce its `maxUsd` cap
 * (a pre-flight `budget(onExceed:'block')`) when set. The single shared helper the orchestrator wraps
 * around every segment AND the single-agent `Runner`/`streamOne` wrap around their run — so `maxUsd`
 * binds on every path, not just multi-agent. PY parity: `orchestration._scope`.
 */
export function withScope<T>(agent: Agent, fn: () => Promise<T>): Promise<T> {
  // The agent currently executing a turn, read by `otel.liveSpans` to stamp `gen_ai.agent.name` on
  // each child span at emit time — robust regardless of bus fan-out order (the event is emitted
  // synchronously inside this scope; AsyncLocalStorage propagates across the awaits in `fn`).
  return activeAgent.run(agent.name, () =>
    track({ agent: agent.name }, () => {
      if (agent.maxUsd != null) {
        return withBudgetBlock(agent.name, agent.maxUsd, fn);
      }
      return fn();
    }),
  );
}

const activeAgent = new AsyncLocalStorage<string>();

/** The name of the agent currently executing a turn, or `''` outside a run. */
export function currentAgent(): string {
  return activeAgent.getStore() ?? '';
}

const activeConversation = new AsyncLocalStorage<string>();

/** The conversation id of the run in flight (from the session key), or `''` (G19). Read by
 * `otel.liveSpans` to stamp `gen_ai.conversation.id` on the root span. */
export function currentConversation(): string {
  return activeConversation.getStore() ?? '';
}

/** Run `fn` with the ambient conversation id set from a session's key (G19). If the session has no
 * id, `fn` runs unchanged — a conversation id is never synthesized. */
export function withConversation<T>(session: unknown, fn: () => Promise<T>): Promise<T> {
  const cid = (session as { id?: string | null } | undefined)?.id;
  return cid ? activeConversation.run(String(cid), fn) : fn();
}

async function withBudgetBlock<T>(
  agentName: string,
  usd: number,
  fn: () => Promise<T>,
): Promise<T> {
  // onExceed:'block' never resolves to undefined (it throws BudgetExceeded), so the cast is sound.
  // Name the per-agent ceiling so a block by an agent's maxUsd is attributable in a monitor
  // (which budget blocked what) — the @cendor/tokenguard 0.4 budget({ name }) hook (G10).
  return (await withBudget(
    {
      usd,
      onExceed: 'block',
      name: `agent:${agentName} max_usd`,
      description: `per-agent USD ceiling for ${agentName}`,
    },
    fn,
  )) as T;
}
