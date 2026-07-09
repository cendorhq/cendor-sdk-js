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
import { Policy, enableEntropyDetector, redact, scan } from '@cendor/acttrace';
import type { Context, Guardrail } from '@cendor/guardrails';
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

type BridgeAction = 'block' | 'redact' | 'flag';

/**
 * PII/secret guardrails default to gating every stage — including `tool_output`, the capability the
 * process-global `guard()` can't reach.
 */
const DEFAULT_STAGES: string[] = [...STAGES];

interface BridgeOptions {
  name: string;
  stage: string | readonly string[];
  action: BridgeAction;
  scanPolicy: Policy;
  redactPolicy: Policy;
  groups?: Set<string>;
  categories?: Set<string>;
}

/**
 * Build a `Guardrail` whose check scans `payload` with `acttrace.scan` and enforces the guardrail
 * `action` on any actionable finding (`redact` scrubs via `acttrace.redact`). The reason records only
 * category names + counts — never a raw value.
 *
 * NOTE: built via the published `@cendor/guardrails` `defineGuardrail({ stage, name })` — the 0.1.0
 * `Guardrail` type has no `timeout` / `onError`, so those are not set here (a scan error surfaces
 * directly). Per-guardrail `onError` for these bridges lands once `@cendor/guardrails` 0.2.0 ships.
 */
function bridge(opts: BridgeOptions): Guardrail {
  const { name, stage, action, scanPolicy, redactPolicy, groups, categories } = opts;
  const check = (payload: unknown, _ctx: Context): Verdict | null => {
    let findings = scan(payload, scanPolicy).filter((f) => f.action !== 'allow');
    if (groups) findings = findings.filter((f) => groups.has(f.group));
    if (categories) findings = findings.filter((f) => categories.has(f.category));
    if (findings.length === 0) return null;
    const cats = [...new Set(findings.map((f) => f.category))].sort().join(', ');
    const n = findings.length;
    const reason = `${name}: ${n} categor${n === 1 ? 'y' : 'ies'} detected (${cats})`;
    if (action === 'redact') {
      const [cleaned] = redact(payload, redactPolicy);
      return new Verdict('redact', reason, cleaned);
    }
    return new Verdict(action, reason);
  };
  return defineGuardrail(check, { stage, name });
}

export interface PiiOptions {
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
}

/**
 * A guardrail over `@cendor/acttrace`'s full detector catalogue, governed by `policy`.
 *
 * `policy` (default `Policy.default()`, which redacts secrets + emails and flags the rest) decides
 * which categories are actionable; `action` decides what the guardrail does on any finding —
 * `"redact"` (default; scrubs via `acttrace.redact`), `"block"`, or `"flag"`. Pass `Policy.gdpr()` /
 * `Policy.pci()` / `Policy.strict()` for a wider net. Runs at every stage by default, so it also
 * scans **tool outputs** — content `guard()` never sees.
 */
export function pii(policy?: Policy | null, opts: PiiOptions = {}): Guardrail {
  const { action = 'redact', stage = DEFAULT_STAGES, name = 'pii' } = opts;
  const resolved = policy ?? Policy.default();
  return bridge({ name, stage, action, scanPolicy: resolved, redactPolicy: resolved });
}

export interface SecretsOptions {
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
}

/**
 * A guardrail scoped to `@cendor/acttrace`'s `secret` group — API keys, tokens, private keys, JWTs.
 * `action="redact"` (default) scrubs them before the payload continues; `"block"` / `"flag"` stop /
 * record instead. A convenience wrapper over {@link pii} with a secrets-only policy.
 */
export function secrets(opts: SecretsOptions = {}): Guardrail {
  const { action = 'redact', stage = DEFAULT_STAGES, name = 'secrets' } = opts;
  const scoped = new Policy({ secret: action === 'redact' ? 'redact' : 'flag' }, 'allow');
  return bridge({
    name,
    stage,
    action,
    scanPolicy: scoped,
    redactPolicy: scoped,
    groups: new Set(['secret']),
  });
}

export interface EntropyOptions {
  minLength?: number;
  minEntropy?: number;
  action?: BridgeAction;
  stage?: string | readonly string[];
  name?: string;
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
    redactPolicy: scoped,
    categories: new Set(['high_entropy_secret']),
  });
}
