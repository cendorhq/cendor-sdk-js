/**
 * Retry hardening — the TS port of `cendor.sdk.resilience`. Only the *successful* attempt ever emits
 * an `LLMCall` (a failed provider call throws before `instrument`'s post-hook), so retries never
 * double-count. `BudgetExceeded` / `PolicyViolation` are never retried.
 */

import { PolicyViolation } from '@cendor/acttrace';
import { BudgetExceeded } from '@cendor/tokenguard';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_HINTS = [
  'timeout',
  'connection',
  'ratelimit',
  'apiconnection',
  'internalserver',
  'serviceunavailable',
  'overloaded',
  'apistatus',
  'temporarilyunavailable',
];

/**
 * Default classifier: never retry governance errors — matched by `instanceof` on the real library
 * classes (a name-string match would silently turn never-retry into retry if a lib renamed its
 * exception). Otherwise retry on a retryable HTTP status or a transient type-name hint — the name
 * heuristic applies only to transient hints.
 */
export function defaultIsTransient(exc: unknown): boolean {
  if (exc instanceof BudgetExceeded || exc instanceof PolicyViolation) return false;
  const status =
    (exc as { status?: number; statusCode?: number })?.status ??
    (exc as { statusCode?: number })?.statusCode;
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
  const name = (exc as { constructor?: { name?: string } })?.constructor?.name?.toLowerCase() ?? '';
  return TRANSIENT_HINTS.some((h) => name.includes(h));
}

export interface RetryPolicyOptions {
  maxAttempts?: number;
  backoffBase?: number;
  backoffFactor?: number;
  maxBackoff?: number;
  shouldRetry?: (exc: unknown) => boolean;
  sleep?: (seconds: number) => Promise<void>;
}

/** A retry policy with exponential backoff. `sleep` is injectable (tests pass a no-op). */
export class RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBase: number;
  readonly backoffFactor: number;
  readonly maxBackoff: number;
  readonly shouldRetry: (exc: unknown) => boolean;
  readonly sleep: (seconds: number) => Promise<void>;

  constructor(opts: RetryPolicyOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBase = opts.backoffBase ?? 0.2;
    this.backoffFactor = opts.backoffFactor ?? 2.0;
    this.maxBackoff = opts.maxBackoff ?? 10.0;
    this.shouldRetry = opts.shouldRetry ?? defaultIsTransient;
    this.sleep = opts.sleep ?? ((s: number) => new Promise((r) => setTimeout(r, s * 1000)));
  }

  /** Backoff delay (seconds) before the given 0-based attempt index. */
  delay(attempt: number): number {
    return Math.min(this.backoffBase * this.backoffFactor ** attempt, this.maxBackoff);
  }
}

/** Run an async factory with retry. `retry=null` → a single attempt (no retries). */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  retry: RetryPolicy | null,
): Promise<T> {
  if (retry === null) return fn();
  let lastError: unknown;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retry.maxAttempts - 1 || !retry.shouldRetry(err)) throw err;
      await retry.sleep(retry.delay(attempt));
    }
  }
  throw lastError;
}

/**
 * An OpenAI-shaped 400 that names both the rejected parameter and its replacement, e.g.
 * `Unsupported parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead.` Reasoning-family deployments (gpt-5*, o*) answer this to a
 * Chat Completions call carrying `max_tokens`.
 */
const PARAM_SWAP_RE =
  /'([A-Za-z0-9_]+)'\s+is not supported[^.]*\.\s*Use\s+'([A-Za-z0-9_]+)'\s+instead/i;

/**
 * A repaired copy of `kwargs` when the provider named a parameter *and* its replacement, else null.
 *
 * On **Azure/Foundry this cannot be predicted from the model id**: the id a call carries is the
 * *deployment* name, which the user chose — `"my-chat"` says nothing about whether the model behind
 * it is a reasoning family — so a name-based rule is structurally unable to solve it and the
 * provider's own message is the only reliable signal. Measured 2026-07-31 against a live Foundry
 * deployment: `Agent({ maxTokens })` with `provider: 'azure'` 400'd outright.
 *
 * Deliberately narrow: it repairs only when the message names both sides, the old key is present,
 * and the new key is not already set. Every other failure propagates exactly as before.
 */
export function paramSwap(
  err: unknown,
  kwargs: Record<string, unknown>,
): Record<string, unknown> | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = PARAM_SWAP_RE.exec(message);
  if (m === null) return null;
  const [, oldKey, newKey] = m as unknown as [string, string, string];
  if (!(oldKey in kwargs) || newKey in kwargs) return null;
  const repaired = { ...kwargs };
  repaired[newKey] = repaired[oldKey];
  delete repaired[oldKey];
  return repaired;
}

/**
 * Issue one model call: {@link callWithRetry} plus a single **parameter-swap repair**.
 *
 * The repair runs independently of `retry` (it is not a transient failure — it is the only way to
 * be right about an Azure deployment name) and at most once per call. The Python twin lives in
 * `cendor.sdk.resilience.call_with_retry`.
 */
export async function callModel<T>(
  create: (kwargs: Record<string, unknown>) => Promise<T>,
  kwargs: Record<string, unknown>,
  retry: RetryPolicy | null,
): Promise<T> {
  try {
    return await callWithRetry(() => create(kwargs), retry);
  } catch (err) {
    const repaired = paramSwap(err, kwargs);
    if (repaired === null) throw err;
    return await callWithRetry(() => create(repaired), retry);
  }
}
