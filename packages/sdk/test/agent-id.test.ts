/**
 * `new Agent({ id })` → `gen_ai.agent.id`, and the actor on every governance row (W4 / S4). TS mirror
 * of cendor-sdk's `tests/test_agent_id.py`.
 *
 * Measured 2026-07-26 (`plan/REPORT-MONITOR-DOORS-FITGAP-2026-07-26.md`):
 *
 * * `gen_ai.agent.id` was **never emitted and never stored** — an agent was a string-only label, so
 *   two agents sharing a name across apps collided and a rename lost the history.
 * * `governance_events.agent` was populated on **13 of 386** rows, so "which agent was blocked" was
 *   answerable only by inferring it from step ordering. On a governance product that is the attribute
 *   most worth having.
 *
 * Rails: the id is emitted **only when the app gave one** — never hashed, never a placeholder (D3),
 * and core still carries no identity of its own.
 */
import { LLMCall, bus } from '@cendor/core';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentAgent, currentAgentId } from '../src/governance.js';
import { Agent, liveSpans, run, spanTree } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  bus._reset();
});

const attrs = (prefix: string): Array<Record<string, unknown>> =>
  exporter
    .getFinishedSpans()
    .filter((s: ReadableSpan) => s.name.startsWith(prefix))
    .map((s) => ({ ...s.attributes }));

function agentWith(opts: { id?: string } = {}): Agent {
  return new Agent({
    name: 'refund-bot',
    model: 'gpt-4o',
    ...(opts.id ? { id: opts.id } : {}),
    client: stubOpenAI([openaiChat({ content: 'ok' })]),
  });
}

describe('gen_ai.agent.id', () => {
  it('liveSpans stamps the id when the app gave one', async () => {
    const spans = liveSpans();
    try {
      await run(agentWith({ id: 'agent-7' }), 'hi');
    } finally {
      spans.close();
    }
    const chats = attrs('chat ');
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((a) => a['gen_ai.agent.name'] === 'refund-bot')).toBe(true);
    expect(chats.every((a) => a['gen_ai.agent.id'] === 'agent-7')).toBe(true);
  });

  it('no id means the attribute is OMITTED, not invented', async () => {
    // D3, stated as a test: absent identity stays absent. No hash of the name, no placeholder.
    const spans = liveSpans();
    try {
      await run(agentWith(), 'hi');
    } finally {
      spans.close();
    }
    const chats = attrs('chat ');
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((a) => a['gen_ai.agent.name'] === 'refund-bot')).toBe(true);
    expect(
      chats.every((a) => a['gen_ai.agent.id'] === undefined),
      `an id was invented for an agent that has none: ${JSON.stringify(chats)}`,
    ).toBe(true);
  });

  it('spanTree carries the id post-hoc', async () => {
    const result = await run(agentWith({ id: 'agent-7' }), 'hi');
    expect(spanTree(result)).toBe(true);
    for (const prefix of ['agent ', 'chat ']) {
      const rows = attrs(prefix);
      expect(rows.length, `no ${prefix.trim()} span`).toBeGreaterThan(0);
      expect(
        rows.every((a) => a['gen_ai.agent.id'] === 'agent-7'),
        prefix,
      ).toBe(true);
    }
  });

  it('the id defaults to null and changes no other option', () => {
    const a = new Agent({ name: 'support', model: 'gpt-4o', instructions: 'You are helpful.' });
    expect(a.id).toBeNull();
    expect(a.name).toBe('support');
    expect(a.instructions).toBe('You are helpful.');
  });
});

describe('S4 — the SDK supplies the actor governance rows name', () => {
  /**
   * The SDK's half of S4 is *registering* the actor: its ambient provider stamps `agent` and (when the
   * app gave one) `agent_id` onto every event, and core's registry is what `@cendor/acttrace`'s mirror
   * and core's own `governance.*` spans read — neither may import the SDK (rule 2).
   *
   * The consuming half is asserted in `cendor-libs-js` (`test/governance-actor.test.ts`), because this
   * repo installs the **published** `@cendor/core` / `@cendor/acttrace`: a test here would be checking
   * the shelf, not this change. That is the black-box boundary, not a gap.
   */
  it('the ambient provider stamps the agent AND its id for the duration of a run', async () => {
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    await run(agentWith({ id: 'agent-7' }), 'hi');
    const call = seen.find((e) => e instanceof LLMCall) as LLMCall | undefined;
    expect(call, 'no LLMCall on the bus').toBeTruthy();
    expect(call?.metadata.agent).toBe('refund-bot');
    expect(call?.metadata.agent_id).toBe('agent-7');
    // …and nothing survives the run: identity is scoped, never sticky.
    expect(currentAgentId()).toBe('');
    expect(currentAgent()).toBe('');
  });

  it('an agent with no id stamps NO id — D3, not a placeholder', async () => {
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    await run(agentWith(), 'hi');
    const call = seen.find((e) => e instanceof LLMCall) as LLMCall | undefined;
    expect(call?.metadata.agent).toBe('refund-bot');
    expect(call?.metadata.agent_id).toBeUndefined();
  });
});
