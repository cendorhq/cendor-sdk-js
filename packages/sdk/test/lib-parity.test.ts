/**
 * SDK↔lib surface-parity + identity pins (W2, plan/PLAN-SDK-LIB-INHERITANCE.md). The TS twin of
 * cendor-sdk's tests/test_lib_parity.py.
 *
 * Makes inheritance drift LOUD instead of silent: every re-export the docs call "the identical
 * library object" is pinned with `Object.is`; the `sdk.rules` namespace is diffed against the
 * library's catalogue (with DELIBERATE_EXCLUSIONS as the reviewed, single authority on what is
 * deliberately NOT re-exported); and the lib call shapes the SDK forwards are pinned so a new lib
 * capability fails this build and forces a conscious forward/decline decision.
 */
import * as acttrace from '@cendor/acttrace';
import * as core from '@cendor/core';
import * as guardrails from '@cendor/guardrails';
import * as tokenguard from '@cendor/tokenguard';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

// ---------------------------------------------------------------- identity pins

const IDENTITY_PINS: Record<string, unknown> = {
  // tokenguard
  budget: tokenguard.budget,
  withBudget: tokenguard.withBudget,
  track: tokenguard.track,
  report: tokenguard.report,
  configure: tokenguard.configure,
  downgrades: tokenguard.downgrades,
  clamps: tokenguard.clamps,
  BudgetExceeded: tokenguard.BudgetExceeded,
  // acttrace — incl. guard: the origin finding, restored to a true identity in 0.10.0
  guard: acttrace.guard,
  PolicyViolation: acttrace.PolicyViolation,
  Policy: acttrace.Policy,
  AuditLog: acttrace.AuditLog,
  verify: acttrace.verify,
  // guardrails
  defineGuardrail: guardrails.defineGuardrail,
  GuardrailTripped: guardrails.GuardrailTripped,
  GuardrailDecision: guardrails.GuardrailDecision,
  Verdict: guardrails.Verdict,
  loadPolicy: guardrails.loadPolicy,
  policySchema: guardrails.policySchema,
  presets: guardrails.presets,
  judge: guardrails.judge,
  taskAdherence: guardrails.judge.taskAdherence,
  // core
  trace: core.trace,
  currentTraceId: core.currentTraceId,
  LLMCall: core.LLMCall,
  ToolCall: core.ToolCall,
  Money: core.Money,
  sumMoney: core.sumMoney,
};

describe('identity pins', () => {
  it('every documented re-export is the identical library object', () => {
    const wrong = Object.keys(IDENTITY_PINS).filter(
      (name) => !Object.is((sdk as Record<string, unknown>)[name], IDENTITY_PINS[name]),
    );
    expect(wrong, `SDK re-exports that are NOT the library object: ${wrong}`).toEqual([]);
  });

  it('guard identity is literal (the origin finding)', () => {
    expect(Object.is(sdk.guard, acttrace.guard)).toBe(true);
  });
});

// ---------------------------------------------------------------- rules namespace diff
//
// The single authority on what the SDK `rules` module deliberately does NOT re-export. D1 (locked
// 2026-07-13) re-exported all 9 lagging factories, so only the two non-factory helpers remain —
// each with its rationale. Anything else the library adds lands as a failure here until it is
// re-exported or explicitly allow-listed.
const DELIBERATE_EXCLUSIONS = new Set([
  'payloadText', // helper (payload -> text), not a rule factory — import from @cendor/guardrails
  'NORMALIZATIONS', // constant list backing keywordDeny's normalize option — not a rule factory
]);

/** SDK-only additions to `rules` — the acttrace bridge (the SDK may compose libs; they can't). */
const SDK_ONLY_RULES = new Set(['pii', 'secrets', 'entropy']);

describe('rules namespace parity', () => {
  it('re-exports the full library rule catalogue (minus the reviewed exclusions)', () => {
    const libNames = Object.keys(guardrails.rules).filter(
      (n) => !DELIBERATE_EXCLUSIONS.has(n) && typeof n === 'string',
    );
    const missing = libNames.filter((n) => !(n in sdk.rules));
    expect(
      missing,
      `@cendor/guardrails rules the SDK doesn't re-export: ${missing} — re-export or allow-list`,
    ).toEqual([]);
  });

  it('shared rules names are identical objects; only the bridge is SDK-side', () => {
    const shared = Object.keys(guardrails.rules).filter((n) => n in sdk.rules);
    const diff = shared.filter(
      (n) =>
        !Object.is(
          (sdk.rules as Record<string, unknown>)[n],
          (guardrails.rules as Record<string, unknown>)[n],
        ),
    );
    expect(diff, `sdk.rules re-exports that are NOT the library object: ${diff}`).toEqual([]);
    const extras = Object.keys(sdk.rules).filter((n) => !(n in guardrails.rules));
    expect(new Set(extras)).toEqual(SDK_ONLY_RULES);
  });
});

// ---------------------------------------------------------------- shape pins

describe('forwarded lib shape pins', () => {
  it('acttrace guard dual shape: raw interceptor + (opts, fn) scope (compile + runtime pin)', async () => {
    // raw form returns a callable interceptor
    const itc = sdk.guard(acttrace.Policy.default());
    expect(typeof itc).toBe('function');
    // scope form matches the SDK's historical (opts, fn) call shape — drop-in for 0.9.x callers
    const out = await sdk.guard({ policy: acttrace.Policy.default() }, async () => 42);
    expect(out).toBe(42);
  });

  it('guardrails STAGES canary — the SDK loop gates exactly these four hardcoded stages', () => {
    expect([...guardrails.STAGES]).toEqual(['input', 'tool_call', 'tool_output', 'output']);
  });

  it('BudgetConfig pin vs withScope forwarding — a new budget field lands here first', () => {
    // withScope forwards exactly usd (as maxUsd) + hardcodes onExceed:'block'. Pin the config
    // surface so a new BudgetConfig field forces a conscious forward/decline decision.
    // (Object keys of a TS interface aren't introspectable — pin via an exhaustive literal that
    // the compiler widens against BudgetConfig; a new REQUIRED field breaks this line.)
    const full: Parameters<typeof tokenguard.budget>[0] = {
      usd: 1,
      tokens: 1,
      onExceed: 'block',
      scope: 'inherit',
      downgrade: {},
      outputReserve: 1,
      reasoningReserve: 1,
    };
    expect(Object.keys(full).length).toBe(7);
  });
});

// ---------------------------------------------------------------- shim-expiry harness
//
// House pattern (report §5.4): when the SDK ships a WORKAROUND for a lib gap, add a test here
// asserting the gap STILL EXISTS — the lib catching up turns the test red and forces the shim's
// deletion (exactly what did NOT happen for this bridge's stale "0.2.0" options comment).
// As of 0.10.0 there are NO active shims: the embeddings emit path (the last one) was deleted
// when @cendor/core 0.6.0 grew embeddings capture; the bridge forwards timeout/onError/metadata
// since @cendor/guardrails supports them. The inverse pin below guards the adoption itself.

describe('shim-expiry harness', () => {
  it('core captures embeddings.create (the reason the SDK emit shim was deleted)', async () => {
    const calls: unknown[] = [];
    const collect = (e: unknown) => {
      if (e instanceof core.LLMCall) calls.push(e);
    };
    core.bus.subscribe(collect);
    try {
      const client = core.instrument({
        embeddings: {
          create: async (_opts: Record<string, unknown>) => ({
            data: [{ embedding: [0.1] }],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        },
      });
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'x' });
    } finally {
      core.bus.unsubscribe(collect);
    }
    expect(calls.length).toBe(1);
    expect((calls[0] as InstanceType<typeof core.LLMCall>).metadata.embedding).toBe(true);
  });
});
