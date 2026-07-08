import { type AuditLog, type Policy, guard as acttraceGuard } from '@cendor/acttrace';
/**
 * Governance re-exports — the real `@cendor/tokenguard` / `@cendor/acttrace` objects (never wrappers),
 * plus the SDK's own `guard` (a callback-scope around acttrace's interceptor) and `registerModelPrice`.
 * A bare `run()` needs none of this; governance rides `@cendor/core`'s bus + interceptor seams.
 */
import { Dec, addInterceptor, prices, removeInterceptor } from '@cendor/core';
import { BudgetExceeded, budget, configure, report, track, withBudget } from '@cendor/tokenguard';
import type { Agent } from './agent.js';

export { budget, withBudget, track, report, configure, BudgetExceeded };
export { AuditLog, verify, Policy, PolicyViolation } from '@cendor/acttrace';
export { trace, currentTraceId } from '@cendor/core';

export interface GuardOptions {
  policy?: Policy | null;
  audit?: AuditLog | null;
  onBlock?: unknown;
}

/**
 * Run `fn` with an acttrace policy `guard` installed on core's interceptor seam (block / redact-before-
 * send / flag), removed on exit. The callback-scope form of the Python `with guard(...)` CM.
 */
export async function guard<T>(opts: GuardOptions, fn: () => Promise<T>): Promise<T> {
  const interceptor = acttraceGuard(opts.policy ?? null, opts.audit ?? null, opts.onBlock as never);
  addInterceptor(interceptor);
  try {
    return await fn();
  } finally {
    removeInterceptor(interceptor);
  }
}

const PER: Record<string, number> = { '1M': 1_000_000, '1K': 1_000, token: 1 };

export interface RegisterModelPriceOptions {
  input: number | string;
  output?: number | string;
  cached?: number | string;
  cacheWrite?: number | string;
  per?: string;
}

/** Register a model's rates (default per 1M tokens) in core's price table so USD budgets bind on it. */
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
