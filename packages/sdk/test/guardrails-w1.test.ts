/**
 * Wave-1 guardrails additions in the SDK — the acttrace PII/secrets/entropy bridge
 * (`rules.pii` / `secrets` / `entropy`), `Result.guardrailDecisions`, and the
 * `guardrailMode: 'parallel'` input-stage overlap. Offline stub clients + the real published
 * `@cendor/acttrace` detectors. Mirrors the Python `tests/test_guardrails_w1.py`.
 */
import { describe, expect, it } from 'vitest';
import {
  Agent,
  GuardrailTripped,
  type Message,
  type ToolCall,
  rules,
  run,
  tool,
} from '../src/index.js';
import { isolate, openaiChat, recordingOpenAI, stubOpenAI } from './_helpers.js';

isolate();

function agentWith(
  client: unknown,
  overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  return new Agent({
    name: 'assistant',
    model: 'gpt-4o',
    instructions: 'Be helpful.',
    client,
    ...overrides,
  });
}

function toolMsg(result: { messages: Message[] }): string {
  return String(result.messages.find((m) => m.role === 'tool')?.content ?? '');
}

// --------------------------------------------------------------------------- PII / secrets bridge

describe('@cendor/sdk — rules.pii / secrets / entropy bridge', () => {
  it('pii redacts an email before the request is sent (input)', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'ok' })]);
    const agent = agentWith(rec.client, { guardrails: [rules.pii(null, { stage: 'input' })] });
    const result = await run(agent, 'please email alice@example.com the report');
    const sent = JSON.stringify((rec.calls[0] as { messages: unknown }).messages);
    expect(sent).not.toContain('alice@example.com'); // acttrace scrubbed it before the provider saw it
    expect(sent).toContain('<redacted>');
    expect(result.output).toBe('ok');
  });

  it('secrets blocks a leaked key pre-spend (category named, value not)', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, {
      guardrails: [rules.secrets({ action: 'block', stage: 'input' })],
    });
    let err: unknown;
    try {
      await run(agent, 'my key is sk-abcdEFGH1234ijklMNOP');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailTripped);
    expect(rec.calls).toHaveLength(0); // blocked before the model — $0
    const reason = (err as GuardrailTripped).decisions.at(-1)?.reason ?? '';
    expect(reason).toContain('api_key'); // category named
    expect(reason).not.toContain('sk-abcdEFGH1234ijklMNOP'); // never the raw value
  });

  it('pii scans tool_output — the new capability guard() cannot reach', async () => {
    const raw = 'user is bob@corp.example with card 4111 1111 1111 1111';
    const fetchRecord = tool(() => raw, {
      name: 'fetch_record',
      description: 'Fetch a user record.',
    });
    const client = stubOpenAI([
      openaiChat({ toolCalls: [{ name: 'fetch_record', args: {} }] }),
      openaiChat({ content: 'done' }),
    ]);
    const agent = agentWith(client, {
      tools: [fetchRecord],
      guardrails: [rules.pii(null, { action: 'redact', stage: 'tool_output' })],
    });
    const result = await run(agent, 'look it up');
    // the tool ran (raw result on the bus), but the model saw it scrubbed
    expect((result.toolSteps[0]?.call as ToolCall).result).toBe(raw);
    expect(toolMsg(result)).not.toContain('bob@corp.example');
    expect(toolMsg(result)).toContain('<redacted>');
  });

  it('entropy flags a high-entropy blob (does not block)', async () => {
    const blob = 'aZ9k2Lp7Qw3Rt6Yx1Vb8Nc4Md0Ef5Gh2Ij7Kl';
    const rec = recordingOpenAI([openaiChat({ content: 'ok' })]);
    const agent = agentWith(rec.client, {
      guardrails: [rules.entropy({ action: 'flag', stage: 'input' })],
    });
    const result = await run(agent, `here is a value: ${blob}`);
    expect(rec.calls).toHaveLength(1); // flag does not block
    expect(result.guardrailDecisions.some((d) => d.action === 'flag')).toBe(true);
  });
});

// --------------------------------------------------------------- Result.guardrailDecisions

describe('@cendor/sdk — Result.guardrailDecisions', () => {
  it('carries flag + redact decisions from the input stage', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'done' })]), {
      guardrails: [
        rules.keywordDeny(['watchword'], { action: 'flag' }),
        rules.regexRule(/sk-\w+/, { action: 'redact', stage: 'input' }),
      ],
    });
    const result = await run(agent, 'watchword and a key sk-abc123');
    const actions = new Set(result.guardrailDecisions.map((d) => d.action));
    expect(actions.has('flag')).toBe(true);
    expect(actions.has('redact')).toBe(true);
    expect(result.guardrailDecisions.every((d) => d.stage === 'input')).toBe(true);
  });

  it('is empty when the agent has no guardrails', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'hi' })]));
    const result = await run(agent, 'hello');
    expect(result.guardrailDecisions).toEqual([]);
  });
});

// --------------------------------------------------------------------------- parallel mode

describe('@cendor/sdk — guardrailMode: parallel', () => {
  it('passes through: a clean input overlaps the first model call', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, {
      guardrails: [rules.keywordDeny(['forbidden'], { action: 'flag' })],
    });
    const result = await run(agent, 'a clean request', { guardrailMode: 'parallel' });
    expect(rec.calls).toHaveLength(1);
    expect(result.output).toBe('hi');
  });

  it('a block still raises (post-call in parallel mode)', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'hi' })]), {
      guardrails: [rules.keywordDeny(['forbidden'], { action: 'block' })],
    });
    await expect(
      run(agent, 'a forbidden request', { guardrailMode: 'parallel' }),
    ).rejects.toBeInstanceOf(GuardrailTripped);
  });

  it('honours the mode set on the agent field', async () => {
    const slowJudge = async (): Promise<null> => null; // passes
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'ok' })]), {
      guardrailMode: 'parallel',
      guardrails: [rules.custom(slowJudge, { stage: 'input', name: 'judge' })],
    });
    const result = await run(agent, 'anything');
    expect(result.output).toBe('ok');
  });

  it('an invalid guardrailMode throws', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'ok' })]), {
      guardrailMode: 'nonsense' as 'blocking',
      guardrails: [rules.keywordDeny(['x'])],
    });
    await expect(run(agent, 'hi')).rejects.toThrow(/guardrailMode/);
  });
});
