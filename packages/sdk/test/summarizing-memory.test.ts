/**
 * SummarizingSession — rolling summarization of old turns into a durable memory note (port of Python
 * `test_summarizing_memory.py`). The across-runs case exercises the awaited write-back: summarization
 * must finish before the run returns (it flaked under the old fire-and-forget `replace`).
 */
import { describe, expect, it } from 'vitest';
import { Agent, SummarizingSession, run } from '../src/index.js';
import type { Message } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

const PREFIX = 'Conversation summary so far:\n';

/** Deterministic offline summarizer: count folded messages, threading the prior summary. */
function fakeSummarizer(old: Message[], prior: string | null): string {
  const base = prior ? `${prior} ` : '';
  return `${base}[folded ${old.length}]`;
}

function msgs(n: number): Message[] {
  return Array.from({ length: n }, (_v, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));
}

describe('@cendor/sdk — SummarizingSession', () => {
  it('folds old turns into a memory note', async () => {
    const mem = new SummarizingSession({
      summarizer: fakeSummarizer,
      maxMessages: 4,
      keepRecent: 2,
    });
    await mem.replace(msgs(5)); // 5 > 4 -> summarize

    expect(mem.messages[0]!.role).toBe('system');
    expect(String(mem.messages[0]!.content).startsWith(PREFIX)).toBe(true);
    expect(String(mem.messages[0]!.content)).toContain('[folded 3]');
    expect(mem.messages.slice(1).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(mem.length).toBe(3); // note + 2 recent (bounded)
  });

  it('threads the prior summary and stays bounded', async () => {
    const mem = new SummarizingSession({
      summarizer: fakeSummarizer,
      maxMessages: 4,
      keepRecent: 2,
    });
    await mem.replace(msgs(5)); // first fold
    const firstNote = String(mem.messages[0]!.content);
    // grow again: prior note + 2 recent + 3 new = 6 > 4 -> re-summarize, threading the prior note
    await mem.replace([...mem.messages, ...msgs(3)]);
    const note = String(mem.messages[0]!.content);
    expect(note).not.toBe(firstNote); // updated
    expect(note).toContain('[folded');
    expect((note.match(/\[folded/g) ?? []).length).toBeGreaterThanOrEqual(2); // prior carried forward
    expect(mem.length).toBeLessThanOrEqual(4); // stays bounded across rounds
  });

  it('stays bounded but retains a memory note across runs (awaited write-back)', async () => {
    const mem = new SummarizingSession({
      summarizer: fakeSummarizer,
      maxMessages: 4,
      keepRecent: 2,
    });
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      instructions: 'x',
      client: stubOpenAI([openaiChat({ content: 'ok' })]),
    });
    for (let i = 0; i < 4; i++) await run(agent, `turn ${i}`, { session: mem });
    expect(mem.length).toBeLessThanOrEqual(4);
    expect(String(mem.messages[0]!.content).startsWith(PREFIX)).toBe(true);
  });
});
