import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { using } from '@cendor/cassette';
import { LLMCall, bus } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  VectorIndex,
  alwaysApprove,
  alwaysReject,
  embed,
  evaluate,
  requireApproval,
  run,
  tool,
} from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

describe('rag', () => {
  it('VectorIndex ranks by cosine similarity and yields a retriever', async () => {
    const embedder = (texts: string[]) => texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1]));
    const idx = new VectorIndex({ embedder });
    await idx.add(['cats are great', 'dogs are loyal']);
    expect(idx.length).toBe(2);
    const hits = await idx.search('a cat', 1);
    expect(hits[0]!.text).toBe('cats are great');
    const retriever = idx.asRetriever(1);
    expect(await retriever('cat')).toEqual(['cats are great']);
  });

  it('embed emits a governed LLMCall (embedding:true)', async () => {
    const client = {
      embeddings: {
        create: async () => ({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 5 } }),
      },
    };
    const calls: LLMCall[] = [];
    const sub = (e: unknown) => {
      if (e instanceof LLMCall) calls.push(e);
    };
    bus.subscribe(sub);
    try {
      const vectors = await embed('text-embedding-3-small', 'hello', { client });
      expect(vectors).toEqual([[0.1, 0.2]]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.metadata.embedding).toBe(true);
    } finally {
      bus.unsubscribe(sub);
    }
  });
});

describe('hitl', () => {
  it('requireApproval denies without running the tool, and runs when approved', async () => {
    const danger = tool((a: { x: number }) => `ran ${a.x}`, {
      name: 'danger',
      parameters: z.object({ x: z.number() }),
    });
    const denied = await requireApproval(danger, { approver: alwaysReject }).invoke({ x: 1 });
    expect(String(denied)).toContain("[denied] human oversight rejected 'danger'");
    const ok = await requireApproval(danger, { approver: alwaysApprove }).invoke({ x: 2 });
    expect(ok).toBe('ran 2');
  });
});

describe('eval', () => {
  it('replays a recorded cassette and checks expectations (cost/tokens are real)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cendor-eval-'));
    const path = join(dir, 'trace.json');
    const agent = new Agent({
      name: 'e',
      model: 'gpt-4o',
      client: stubOpenAI([
        openaiChat({
          content: 'The answer is 42.',
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      ]),
    });
    await using(path, { mode: 'record' }, async () => {
      await run(agent, 'what is the answer?');
    });
    const report = await evaluate(agent, [
      { name: 'contains', input: 'what is the answer?', cassette: path, expectContains: '42' },
      { name: 'too-cheap-cap', input: 'what is the answer?', cassette: path, maxUsd: 0.0000001 },
    ]);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
  });
});
