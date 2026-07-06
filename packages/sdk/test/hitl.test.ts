/**
 * Human-in-the-loop — `requireApproval` records the verdict on the run's active audit `Decision` via
 * `humanOversight` (approve AND reject), honoring the `reviewer` option; a rejection blocks the tool
 * (port of Python `test_interop.py` HITL cases). Offline via stub clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AuditLog, run, tool, verify } from '../src/index.js';
import { requireApproval } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

function auditPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cendor-hitl-')), 'audit.jsonl');
}

function refundTool(refunds: [number, number][]) {
  return tool(
    (args: { order_id: number; amount: number }) => {
      refunds.push([args.order_id, args.amount]);
      return `Refunded $${args.amount} for order ${args.order_id}.`;
    },
    {
      name: 'issue_refund',
      description: 'Issue a refund for an order.',
      parameters: z.object({ order_id: z.number(), amount: z.number() }),
    },
  );
}

describe('@cendor/sdk — HITL', () => {
  it('records an approval in the audit chain and runs the real tool', async () => {
    const refunds: [number, number][] = [];
    const approvals: [string, Record<string, unknown>][] = [];
    const guarded = requireApproval(refundTool(refunds), {
      approver: (name, args) => {
        approvals.push([name, args]);
        return [true, 'within policy'];
      },
      reviewer: 'ops@bank',
    });
    const agent = new Agent({
      name: 'support',
      model: 'gpt-4o',
      tools: [guarded],
      instructions: 'Use tools.',
      client: stubOpenAI([
        openaiChat({ toolCalls: [{ name: 'issue_refund', args: { order_id: 42, amount: 50 } }] }),
        openaiChat({ content: 'Your refund is on its way.' }),
      ]),
    });
    const path = auditPath();
    const log = new AuditLog('support', { riskTier: 'high', path });
    const result = await run(agent, 'Refund order 42 for $50', { audit: log });
    log.detach();

    expect(approvals).toEqual([['issue_refund', { order_id: 42, amount: 50 }]]);
    expect(refunds).toEqual([[42, 50]]); // approved -> the real tool ran
    expect(result.output).toBe('Your refund is on its way.');

    const oversight = log.entries.filter((e) => e.type === 'human_oversight');
    expect(oversight).toHaveLength(1);
    expect((oversight[0]!.payload as { action: string }).action).toBe('approved');
    expect((oversight[0]!.payload as { reviewer: string }).reviewer).toBe('ops@bank');
    const [ok, detail] = verify(path);
    expect(ok, detail).toBe(true);
  });

  it('blocks the tool on rejection and records a rejected oversight entry', async () => {
    const refunds: [number, number][] = [];
    const guarded = requireApproval(refundTool(refunds), {
      approver: () => [false, 'amount too large'],
    });
    const agent = new Agent({
      name: 'support',
      model: 'gpt-4o',
      tools: [guarded],
      instructions: 'Use tools.',
      client: stubOpenAI([
        openaiChat({ toolCalls: [{ name: 'issue_refund', args: { order_id: 7, amount: 9999 } }] }),
        openaiChat({ content: "I couldn't process that refund." }),
      ]),
    });
    const path = auditPath();
    const log = new AuditLog('support', { path });
    const result = await run(agent, 'Refund order 7 for $9999', { audit: log });
    log.detach();

    expect(refunds).toEqual([]); // rejected -> the real tool never ran
    expect(String(result.output)).toContain("couldn't");
    const oversight = log.entries.filter((e) => e.type === 'human_oversight');
    expect(oversight).toHaveLength(1);
    expect((oversight[0]!.payload as { action: string }).action).toBe('rejected');
  });
});
