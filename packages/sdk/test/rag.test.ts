/**
 * RAG seam — `Agent({ retriever })` injects retrieved context once per run as a system message, and
 * it lands in `Result.messages` (port of Python `test_rag.py::test_agent_retriever_injects_context`).
 * Offline via a deterministic bag-of-words embedder and an echo client.
 */
import { LLMCall, bus, currentTraceId } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import { Agent, VectorIndex, run } from '../src/index.js';
import { isolate } from './_helpers.js';

isolate();

const VOCAB = ['refund', 'support', 'hours', 'policy', 'window', 'days', 'shipping'];
function fakeEmbedder(texts: string[]): number[][] {
  return texts.map((t) => VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1.0 : 0.0)));
}

/** An embedder that also emits an instrumented-style `LLMCall` carrying the ambient trace id at call
 * time — the behavior of a real embeddings client wrapped with `instrument()`. */
function emittingEmbedder(texts: string[]): number[][] {
  bus.emit(
    new LLMCall({
      id: 'embed',
      provider: 'openai',
      model: 'text-embedding-3-small',
      messages: texts.map((t) => ({ role: 'user', content: t })),
      traceId: currentTraceId(),
      metadata: { embedding: true },
    }),
  );
  return fakeEmbedder(texts);
}

/** A stub that echoes back whether it saw the retrieved passage in a system message. */
function echoClient(): { chat: { completions: { create: (p: unknown) => Promise<unknown> } } } {
  return {
    chat: {
      completions: {
        create: async (p: unknown) => {
          const messages = (p as { messages: { role: string; content: string }[] }).messages;
          const sysCtx = messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join(' ');
          const answer = sysCtx.includes('Refunds') ? 'SAW_CONTEXT' : 'NO_CONTEXT';
          return {
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          };
        },
      },
    },
  };
}

describe('@cendor/sdk — RAG retriever injection', () => {
  it('ranks by similarity', async () => {
    const idx = new VectorIndex({ embedder: fakeEmbedder });
    await idx.add(
      ['Refunds are available within 30 days.', 'Support hours are 9-5 UTC.'],
      [{ id: 'refund' }, { id: 'support' }],
    );
    expect(idx.length).toBe(2);
    const hits = await idx.search('what is the refund window in days', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('Refund');
    expect(hits[0]!.metadata.id).toBe('refund');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('injects the retrieved passage as a system message that persists into the result', async () => {
    const idx = new VectorIndex({ embedder: fakeEmbedder });
    await idx.add(['Refunds are available within 30 days.']);
    const agent = new Agent({
      name: 'rag',
      model: 'gpt-4o',
      instructions: 'Answer from context.',
      retriever: idx.asRetriever(1),
      client: echoClient(),
    });
    const result = await run(agent, 'refund window?');
    expect(result.output).toBe('SAW_CONTEXT'); // retrieved passage was injected as a system message
    // the injected context is part of the recorded conversation
    expect(
      result.messages.some(
        (m) => m.role === 'system' && String(m.content ?? '').includes('Refunds'),
      ),
    ).toBe(true);
  });

  it('attributes the retriever embed to the run (GLR-4: prepareMessages inside the run scopes)', async () => {
    const idx = new VectorIndex({ embedder: emittingEmbedder });
    await idx.add(['Refunds are available within 30 days.']); // this embed fires outside any run
    const agent = new Agent({
      name: 'rag',
      model: 'gpt-4o',
      instructions: 'Answer from context.',
      retriever: idx.asRetriever(1),
      client: echoClient(),
    });
    const result = await run(agent, 'refund window?');
    // The query embed fired during prepareMessages — now inside trace(runId) + the agent scope — so
    // it is collected as a run step, carries the run's trace id, and is agent-stamped. RED before
    // the fix (embed traceId '' → dropped by the collector).
    const embeds = result.steps.filter(
      (s) => s.call instanceof LLMCall && (s.call as LLMCall).metadata.embedding,
    );
    expect(embeds.length).toBeGreaterThanOrEqual(1);
    expect(embeds[0]!.agent).toBe('rag');
    expect((embeds[0]!.call as LLMCall).traceId).toBe(result.traceId);
  });
});
