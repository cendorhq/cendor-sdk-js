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
