/**
 * Behavior tests for the 0.10.0 inheritance fixes — the TS twins of cendor-sdk's
 * test_bridge_resolution.py / test_embeddings.py additions / test_context_fallback_event.py.
 * Offline; no network.
 */
import { Policy } from '@cendor/acttrace';
import { LLMCall, bus } from '@cendor/core';
import { evaluate as gateEvaluate } from '@cendor/guardrails';
import { BudgetExceeded, withBudget } from '@cendor/tokenguard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import { embed } from '../src/rag.js';
import * as rules from '../src/rules.js';
import { ContextBudgetFallback, assemble } from '../src/runner.js';

// Force the contextBudget assembly failure path (the fallback-event test below).
vi.mock('@cendor/contextkit', () => ({
  Block: class {},
  Context: class {
    constructor() {
      throw new Error('assembly exploded');
    }
  },
}));

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

const SPECIAL = 'patient diagnosed with diabetes, religion: catholic';

describe('pii bridge delegates per-category resolution (V5)', () => {
  it('gdpr special_category blocks even under action: redact (the canonical case)', () => {
    const g = rules.pii(Policy.gdpr(), { action: 'redact' });
    const verdict = g.check(SPECIAL, { agent: 't', stage: 'input' } as never);
    expect(verdict?.action).toBe('block');
    expect(verdict?.reason).toContain('special_category');
  });

  it('policy redact tier still redacts and scrubs', () => {
    const g = rules.pii(Policy.gdpr(), { action: 'redact' });
    const verdict = g.check('email bob@acme.com', { agent: 't', stage: 'input' } as never);
    expect(verdict?.action).toBe('redact');
    expect(String(verdict?.replacement)).not.toContain('bob@acme.com');
  });

  it('the action option applies only to flag-tier findings', () => {
    const flagged = new Policy({}, 'flag'); // everything at flag tier
    const g = rules.pii(flagged, { action: 'block' });
    const verdict = g.check('email bob@acme.com', { agent: 't', stage: 'input' } as never);
    expect(verdict?.action).toBe('block'); // promoted by action

    const g2 = rules.pii(Policy.default(), { action: 'block' });
    const v2 = g2.check('email bob@acme.com', { agent: 't', stage: 'input' } as never);
    expect(v2?.action).toBe('redact'); // default policy: email -> redact tier, NOT promoted
  });

  it('bridge options ride to defineGuardrail (timeout / onError / metadata — the stale-comment fix)', async () => {
    const g = rules.pii(Policy.default(), {
      timeout: 5,
      onError: 'fail_open',
      metadata: { team: 'sec' },
    });
    expect(g.timeout).toBe(5);
    expect(g.onError).toBe('fail_open');
    expect(g.metadata).toEqual({ team: 'sec' });
    // end-to-end through the lib's own gate: metadata lands on the decision
    const { decisions } = await gateEvaluate([g], 'input', 'email bob@acme.com');
    expect(decisions[0]?.metadata?.team).toBe('sec');
  });
});

describe('embeddings governance (W9 adoption)', () => {
  function fakeClient(seen: Record<string, unknown>) {
    return {
      embeddings: {
        create: async (opts: Record<string, unknown>) => {
          Object.assign(seen, opts);
          return {
            data: [{ embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 4, total_tokens: 4 },
          };
        },
      },
    };
  }

  it('emits exactly one LLMCall via core (no shim double emission), with metadata.embedding', async () => {
    const calls: LLMCall[] = [];
    const collect = (e: unknown) => {
      if (e instanceof LLMCall) calls.push(e);
    };
    bus.subscribe(collect);
    const seen: Record<string, unknown> = {};
    try {
      const vectors = await embed('text-embedding-3-small', 'hello', {
        client: fakeClient(seen),
      });
      expect(vectors).toEqual([[0.1, 0.2]]);
    } finally {
      bus.unsubscribe(collect);
    }
    expect(calls.length).toBe(1);
    expect(calls[0].metadata.embedding).toBe(true);
    expect(calls[0].usage?.inputTokens).toBe(4);
    // golden: $0.02/1M * 4 tokens = 0.00000008
    expect(calls[0].cost?.amount.toString()).toBe('8e-8');
  });

  it('a keyless pre-flight USD budget blocks embed() before the provider call', async () => {
    const seen: Record<string, unknown> = {};
    await expect(
      withBudget({ usd: 0.0000000000001, onExceed: 'block' }, () =>
        embed('text-embedding-3-small', 'hello world a longer text', { client: fakeClient(seen) }),
      ),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(Object.keys(seen).length).toBe(0); // blocked pre-flight; the provider was never called
  });
});

describe('contextBudget fallback event', () => {
  it('emits a ContextBudgetFallback diagnostic and still degrades to raw messages', async () => {
    const events: ContextBudgetFallback[] = [];
    const collect = (e: unknown) => {
      if (e instanceof ContextBudgetFallback) events.push(e);
    };
    bus.subscribe(collect);
    try {
      const agent = new Agent({
        name: 't',
        model: 'gpt-4o',
        instructions: 'x',
        contextBudget: 8000, // the mocked contextkit Context throws -> fallback path
      });
      const msgs = [{ role: 'user', content: 'hi' }];
      const out = await assemble(agent, msgs);
      expect(out).toBe(msgs); // unchanged fallback behavior
    } finally {
      bus.unsubscribe(collect);
    }
    expect(events.length).toBe(1);
    expect(events[0].agent).toBe('t');
  });
});
