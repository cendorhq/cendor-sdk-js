/**
 * Governance composes through core's seams with zero SDK glue: budgets block/raise, guard redacts
 * before send, spend is attributed by tag, and cheaper-model downgrade reroutes (port of Python
 * `test_governance.py`). Offline via stub / recording OpenAI-shaped clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  AuditLog,
  BudgetExceeded,
  Policy,
  guard,
  report,
  run,
  track,
  verify,
  withBudget,
} from '../src/index.js';
import { isolate, openaiChat, recordingOpenAI, stubOpenAI } from './_helpers.js';

isolate();

function agentWith(client: unknown, model = 'gpt-4o'): Agent {
  return new Agent({ name: 'a', model, instructions: 'Be brief.', client });
}

describe('@cendor/sdk — governance', () => {
  it('budget onExceed:block stops the call pre-flight', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client);
    await expect(
      withBudget({ usd: 0.0000001, onExceed: 'block' }, () => run(agent, 'hello')),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(rec.calls).toHaveLength(0); // blocked pre-flight
  });

  it('budget onExceed:raise stops after the crossing call', async () => {
    const rec = recordingOpenAI([
      openaiChat({ content: 'hi', usage: { prompt_tokens: 1000, completion_tokens: 1000 } }),
    ]);
    const agent = agentWith(rec.client);
    await expect(
      withBudget({ usd: 0.0000001, onExceed: 'raise' }, () => run(agent, 'hello')),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(rec.calls).toHaveLength(1); // the crossing call ran, then raised
  });

  it('guard redacts PII from the outbound request before send', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'ok' })]);
    const agent = agentWith(rec.client);
    const path = join(mkdtempSync(join(tmpdir(), 'cendor-guard-')), 'audit.jsonl');
    const log = new AuditLog('support', { path });

    await guard({ policy: Policy.default(), audit: log }, () =>
      run(agent, 'email me at alice@example.com', { audit: log }),
    );
    log.detach();

    const sent = JSON.stringify(rec.calls[0]);
    expect(sent).not.toContain('alice@example.com');
    expect(sent).toContain('<redacted>');

    const [ok, detail] = verify(path);
    expect(ok, detail).toBe(true);
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.some((f) => (f.payload as { action?: string }).action === 'redacted')).toBe(true);
  });

  it('track attributes spend by feature', async () => {
    const agent = agentWith(
      stubOpenAI([
        openaiChat({ content: 'hi', usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      ]),
    );
    await track({ feature: 'support' }, () => run(agent, 'hello'));

    const r = report(['feature']);
    expect(r.total().amount.greaterThan(0)).toBe(true);
    expect(r.assertUnder(1.0, { feature: 'support' })).toBe(true);
  });

  it('downgrade reroutes to a cheaper model', async () => {
    const agent = agentWith(
      stubOpenAI([
        openaiChat({ content: 'hi', usage: { prompt_tokens: 5000, completion_tokens: 50 } }),
      ]),
    );
    const result = await withBudget(
      { usd: 0.0001, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
      () => run(agent, 'hello'),
    );
    expect((result!.llmSteps[0]!.call as { model: string }).model).toBe('gpt-4o-mini');
  });
});
