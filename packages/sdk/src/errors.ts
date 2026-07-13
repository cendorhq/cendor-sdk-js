/**
 * Error names byte-identical with the Python SDK. `BudgetExceeded` (tokenguard) and `PolicyViolation`
 * (acttrace) are the real library error classes, re-exported so callers catch by the same name.
 */
export { BudgetExceeded } from '@cendor/tokenguard';
export { PolicyViolation } from '@cendor/acttrace';

/**
 * A live provider call failed to authenticate and no API key was ever supplied. The SDK builds the
 * provider client with a deliberate keyless *placeholder* so offline flows (cassette replay,
 * pre-flight budget blocks) work without credentials; when a *live* call is then rejected with a 401,
 * this replaces the provider's opaque error with an actionable one that names the env var to set. It
 * never fires when a real key (or a pre-built `client`) was supplied, nor on non-auth errors.
 */
export class MissingAPIKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MissingAPIKeyError';
  }
}
