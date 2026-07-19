/**
 * The SDK rule catalogue — the deterministic `@cendor/guardrails` rules re-exported for one import,
 * **plus** PII / secrets / entropy guardrails bridged from `@cendor/acttrace`'s detector catalogue.
 * The TS port of `cendor.sdk.rules`.
 *
 * The bridge lives here, in the SDK, on purpose. The library `@cendor/guardrails` imports **only**
 * `@cendor/core` (constitution rule 2 — no tool→tool imports), so it can't call `@cendor/acttrace`.
 * The **SDK** imports every library, so it may compose them: {@link pii} / {@link secrets} /
 * {@link entropy} are ordinary `Guardrail`s whose check calls `acttrace.scan` / `acttrace.redact`.
 * This gives PII detection **at all four stages** — including `tool_output`, which the process-global
 * `guard(Policy…)` interceptor never sees (it only gates LLM/tool *inputs*). One detection engine
 * (acttrace's catalogue), not two.
 *
 * The reason string records category names + counts only, never a raw value (acttrace counts only).
 * There is **no catch-rate claim** — coverage is exactly acttrace's catalogue.
 */
import { Policy, enableEntropyDetector, redact, resolveFindings, scan } from '@cendor/acttrace';
import type { Context, Guardrail, OnError } from '@cendor/guardrails';
import { STAGES, Verdict, defineGuardrail, rules as guardrailRules } from '@cendor/guardrails';

// Re-export the deterministic built-ins so `import { rules } from '@cendor/sdk'` is one surface.
export const keywordDeny = guardrailRules.keywordDeny;
export const regexRule = guardrailRules.regexRule;
export const urlAllowlist = guardrailRules.urlAllowlist;
export const urlDeny = guardrailRules.urlDeny;
export const lengthBounds = guardrailRules.lengthBounds;
export const jsonSchema = guardrailRules.jsonSchema;
export const custom = guardrailRules.custom;
export const llmJudge = guardrailRules.llmJudge;
// V04: semantic category-by-example + the pre-LLM intent gate (BYO embed/classify).
export const customCategory = guardrailRules.customCategory;
export const intent = guardrailRules.intent;
// Full Python parity (0.10.0, D1): spotlight + the detection-tier adapters + hosted rails + the
// similarity checks now ride the SDK `rules` namespace too. (`payloadText`/`NORMALIZATIONS` stay
// library-only — helpers, not rule factories; see the parity test's DELIBERATE_EXCLUSIONS.)
export const spotlight = guardrailRules.spotlight;
export const language = guardrailRules.language;
export const classifier = guardrailRules.classifier;
export const openaiModeration = guardrailRules.openaiModeration;
export const bedrockGuardrail = guardrailRules.bedrockGuardrail;
export const azureContentSafety = guardrailRules.azureContentSafety;
export const modelArmor = guardrailRules.modelArmor;
export const groundedness = guardrailRules.groundedness;
export const deniedTopics = guardrailRules.deniedTopics;

type BridgeAction = 'block' | 'redact' | 'flag';

/**
 * PII/secret guardrails default to gating every stage — including `tool_output`, the capability the
 * process-global `guard()` can't reach.
 */
const DEFAULT_STAGES: string[] = [...STAGES];

/** A scanning error should never *leak*: redact/block fail closed; only an advisory flag fails
 * open. An explicit `onError` always wins (mirrors the Python bridge). */
function resolveOnError(action: BridgeAction, onError?: OnError): OnError {
  if (onError !== undefined) return onError;
  return action === 'flag' ? 'fail_open' : 'fail_closed';
}

interface BridgeOptions {
  name: string;
  stage: string | readonly string[];
  action: BridgeAction;
  scanPolicy: Policy;
  groups?: Set<string>;
  categories?: Set<string>;
  timeout?: number;
  onError?: OnError;
  metadata?: Record<string, unknown>;
}

/**
 * Build a `Guardrail` whose check scans `payload` with `acttrace.scan` and enforces **per-category**
 * actions via `acttrace.resolveFindings` — the same resolution `guard()` applies, never flattened
 * to one action. The policy's `block`/`redact` tiers are honored per finding; the explicit `action`
 * option is the enforcement applied to findings the policy leaves at **flag** tier. Precedence: any
 * effective block → block; else any effective redact → redact (scrubs exactly those categories);
 * else flag. The reason records only category names + counts — never a raw value.
 */
function bridge(opts: BridgeOptions): Guardrail {
  const { name, stage, action, scanPolicy, groups, categories, timeout, onError, metadata } = opts;
  const reasonOf = (findings: { category: string }[]): string => {
    const cats = [...new Set(findings.map((f) => f.category))].sort().join(', ');
    const n = findings.length;
    return `${name}: ${n} categor${n === 1 ? 'y' : 'ies'} detected (${cats})`;
  };
  const check = (payload: unknown, _ctx: Context): Verdict | null => {
    let findings = scan(payload, scanPolicy).filter((f) => f.action !== 'allow');
    if (groups) findings = findings.filter((f) => groups.has(f.group));
    if (categories) findings = findings.filter((f) => categories.has(f.category));
    if (findings.length === 0) return null;
    const tiers = resolveFindings(findings); // acttrace's own per-category resolution (guard's)
    const promoted = action === 'block' || action === 'redact' ? tiers.flag : [];
    const blocked = [...tiers.block, ...(action === 'block' ? promoted : [])];
    const toRedact = [...tiers.redact, ...(action === 'redact' ? promoted : [])];
    if (blocked.length > 0) return new Verdict('block', reasonOf(blocked));
    if (toRedact.length > 0) {
      // Scrub exactly the effective-redact categories (policy-redact tier + promoted flags).
      const scrub = new Policy(
        Object.fromEntries(toRedact.map((f) => [f.category, 'redact'])),
        'allow',
      );
      const [cleaned] = redact(payload, scrub);
      return new Verdict('redact', reasonOf(toRedact), cleaned);
    }
    return new Verdict('flag', reasonOf(findings));
  };
  return defineGuardrail(check, {
    stage,
    name,
    timeout,
    onError: resolveOnError(action, onError),
    ...(metadata ? { metadata } : {}),
  });
}

export interface PiiOptions {
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
  /** Per-check wall-clock limit in seconds (async gate path) — forwarded to `defineGuardrail`. */
  timeout?: number;
  /** Error/timeout policy; defaults fail-closed for redact/block, fail-open for flag. */
  onError?: OnError;
  /** Static metadata merged into every decision this guardrail emits. */
  metadata?: Record<string, unknown>;
}

/**
 * A guardrail over `@cendor/acttrace`'s full detector catalogue, governed by `policy`.
 *
 * **Per-category actions are honored** (since 0.10.0, via `acttrace.resolveFindings` — the same
 * resolution `guard()` applies): a category the `policy` resolves to `block` blocks and one it
 * resolves to `redact` is scrubbed, regardless of the `action` option. The explicit `action` —
 * `"redact"` (default), `"block"`, or `"flag"` — is the enforcement applied to findings the policy
 * leaves at **flag** tier. So `pii(Policy.gdpr(), { action: 'redact' })` still *blocks* a
 * `special_category` finding (gdpr says block); to purely observe, use an all-flag policy, not
 * `action: 'flag'`. Runs at every stage by default, so it also scans **tool outputs** — content
 * `guard()` never sees.
 */
export function pii(policy?: Policy | null, opts: PiiOptions = {}): Guardrail {
  const {
    action = 'redact',
    stage = DEFAULT_STAGES,
    name = 'pii',
    timeout,
    onError,
    metadata,
  } = opts;
  const resolved = policy ?? Policy.default();
  return bridge({ name, stage, action, scanPolicy: resolved, timeout, onError, metadata });
}

export interface SecretsOptions {
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
  /** Per-check wall-clock limit in seconds (async gate path) — forwarded to `defineGuardrail`. */
  timeout?: number;
  /** Error/timeout policy; defaults fail-closed for redact/block, fail-open for flag. */
  onError?: OnError;
  /** Static metadata merged into every decision this guardrail emits. */
  metadata?: Record<string, unknown>;
}

/**
 * A guardrail scoped to `@cendor/acttrace`'s `secret` group — API keys, tokens, private keys, JWTs.
 * `action="redact"` (default) scrubs them before the payload continues; `"block"` / `"flag"` stop /
 * record instead. A convenience wrapper over {@link pii} with a secrets-only policy.
 */
export function secrets(opts: SecretsOptions = {}): Guardrail {
  const {
    action = 'redact',
    stage = DEFAULT_STAGES,
    name = 'secrets',
    timeout,
    onError,
    metadata,
  } = opts;
  const scoped = new Policy({ secret: action === 'redact' ? 'redact' : 'flag' }, 'allow');
  return bridge({
    name,
    stage,
    action,
    scanPolicy: scoped,
    groups: new Set(['secret']),
    timeout,
    onError,
    metadata,
  });
}

export interface EntropyOptions {
  minLength?: number;
  minEntropy?: number;
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
  /** Per-check wall-clock limit in seconds (async gate path) — forwarded to `defineGuardrail`. */
  timeout?: number;
  /** Error/timeout policy; defaults fail-closed for redact/block, fail-open for flag. */
  onError?: OnError;
  /** Static metadata merged into every decision this guardrail emits. */
  metadata?: Record<string, unknown>;
}

/**
 * A guardrail for **opaque, high-entropy secrets** the anchored patterns miss (long random ids,
 * base64 blobs). Enables `@cendor/acttrace`'s optional entropy detector (`minLength` / `minEntropy`
 * tune it) and gates on its `high_entropy_secret` category.
 *
 * Defaults to `action="flag"` because the entropy detector is **noisy** by nature. Enabling it
 * mutates acttrace's global detector registry (the documented way to turn entropy detection on); it
 * is idempotent and re-tunable.
 */
export function entropy(opts: EntropyOptions = {}): Guardrail {
  const {
    minLength = 24,
    minEntropy = 3.5,
    action = 'flag',
    stage = DEFAULT_STAGES,
    name = 'entropy',
    timeout,
    onError,
    metadata,
  } = opts;
  enableEntropyDetector(minLength, minEntropy); // idempotent
  const scoped = new Policy(
    { high_entropy_secret: action === 'redact' ? 'redact' : 'flag' },
    'allow',
  );
  return bridge({
    name,
    stage,
    action,
    scanPolicy: scoped,
    categories: new Set(['high_entropy_secret']),
    timeout,
    onError,
    metadata,
  });
}
