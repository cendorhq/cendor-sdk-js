/**
 * Agent({ guardrails: [...] }) wired at the four stages — offline stub clients (port of the Python
 * test_guardrails.py). Covers: input block pre-spend (the provider is never called), input redact
 * rewriting the outgoing messages, a tool_call block returning "[blocked …]" while the loop
 * continues, tool_output redaction, output block/redact, the per-run override, an orchestrated team,
 * streaming, and that every decision is emitted (correlated by traceId) on the bus (acttrace
 * chaining into a `guardrail_decision` entry is proven in cendor-libs-js against the new acttrace).
 */
import { bus } from '@cendor/core';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  GuardrailDecision,
  GuardrailTripped,
  type Message,
  judge,
  rules,
  run,
  taskAdherence,
  tool,
} from '../src/index.js';
import { isolate, openaiChat, recordingOpenAI, stubOpenAI, stubStreamTurns } from './_helpers.js';

isolate();

function agentWith(client: unknown, guardrails: Agent['guardrails'] = []): Agent {
  return new Agent({ name: 'a', model: 'gpt-4o', instructions: 'Be brief.', client, guardrails });
}

function toolMsg(result: { messages: Message[] }): string {
  return String(result.messages.find((m) => m.role === 'tool')?.content ?? '');
}

function collectDecisions(): GuardrailDecision[] {
  const seen: GuardrailDecision[] = [];
  bus.subscribe((e) => {
    if (e instanceof GuardrailDecision) seen.push(e);
  });
  return seen;
}

describe('@cendor/sdk — guardrails', () => {
  it('input block is pre-spend (the provider is never called)', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, [rules.keywordDeny(['forbidden'], { action: 'block' })]);
    await expect(run(agent, 'a forbidden request')).rejects.toBeInstanceOf(GuardrailTripped);
    expect(rec.calls).toHaveLength(0);
  });

  it('input redact rewrites the outgoing messages', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'ok' })]);
    const agent = agentWith(rec.client, [
      rules.regexRule(/sk-\w+/, { action: 'redact', stage: 'input' }),
    ]);
    const result = await run(agent, 'my key is sk-abc123secret');
    const sent = JSON.stringify((rec.calls[0] as { messages: unknown }).messages);
    expect(sent).not.toContain('sk-abc123secret');
    expect(sent).toContain('[redacted]');
    expect(result.output).toBe('ok');
  });

  it('tool_call block returns "[blocked …]" and the loop continues', async () => {
    const sideEffects: string[] = [];
    const runCommand = tool(
      (args: { cmd: string }) => {
        sideEffects.push(args.cmd);
        return `ran ${args.cmd}`;
      },
      { name: 'run_command', description: 'Run a command' },
    );
    const client = stubOpenAI([
      openaiChat({ toolCalls: [{ name: 'run_command', args: { cmd: 'rm -rf /' } }] }),
      openaiChat({ content: "I can't run that." }),
    ]);
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      instructions: 'x',
      client,
      tools: [runCommand],
      guardrails: [rules.keywordDeny(['rm -rf'], { stage: 'tool_call', action: 'block' })],
    });
    const result = await run(agent, 'delete everything');
    expect(result.output).toBe("I can't run that.");
    expect(sideEffects).toEqual([]); // the tool's side effect never happened
    expect(toolMsg(result)).toMatch(/^\[blocked by keyword_deny\]/);
  });

  it('tool_output redaction rewrites the tool result the model sees', async () => {
    const fetchSecret = tool(() => 'the token is sk-LEAK9999', {
      name: 'fetch_secret',
      description: 'Fetch a value',
    });
    const client = stubOpenAI([
      openaiChat({ toolCalls: [{ name: 'fetch_secret', args: {} }] }),
      openaiChat({ content: 'done' }),
    ]);
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      instructions: 'x',
      client,
      tools: [fetchSecret],
      guardrails: [rules.regexRule(/sk-\w+/, { action: 'redact', stage: 'tool_output' })],
    });
    const result = await run(agent, 'get it');
    expect(toolMsg(result)).not.toContain('sk-LEAK9999');
    expect(toolMsg(result)).toContain('[redacted]');
  });

  it('output block raises after generation', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'this is classified' })]), [
      rules.keywordDeny(['classified'], { stage: 'output', action: 'block' }),
    ]);
    await expect(run(agent, 'tell me')).rejects.toBeInstanceOf(GuardrailTripped);
  });

  it('output redact rewrites the result', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'the ssn is 123-45-6789' })]), [
      rules.regexRule(/\d{3}-\d{2}-\d{4}/, { action: 'redact', stage: 'output' }),
    ]);
    const result = await run(agent, 'give it');
    expect(result.output).toBe('the ssn is [redacted]');
  });

  it('per-run override replaces the agent guardrails', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client); // no guardrails on the agent
    await expect(
      run(agent, 'a forbidden thing', { guardrails: [rules.keywordDeny(['forbidden'])] }),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(rec.calls).toHaveLength(0);
  });

  it('per-run empty override disables the agent guardrails', async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, [rules.keywordDeny(['forbidden'], { action: 'block' })]);
    const result = await run(agent, 'a forbidden thing', { guardrails: [] });
    expect(rec.calls).toHaveLength(1);
    expect(result.output).toBe('hi');
  });

  // NOTE: the SDK's job is to *emit* correlated decisions on the bus. acttrace chaining them into a
  // `guardrail_decision` entry needs the new @cendor/acttrace (unpublished; that capture is tested in
  // cendor-libs-js + the post-publish testsuits). Here we assert the SDK's own responsibility.
  it('emits a guardrail decision on the bus, correlated by traceId', async () => {
    const seen = collectDecisions();
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'ok' })]), [
      rules.keywordDeny(['watchword'], { action: 'flag' }),
    ]);
    const result = await run(agent, 'a watchword appears');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.guardrail).toBe('keyword_deny');
    expect(seen[0]?.stage).toBe('input');
    expect(seen[0]?.action).toBe('flag');
    expect(seen[0]?.traceId).toBe(result.traceId);
  });

  it('an input block emits a block decision and never calls the model', async () => {
    const seen = collectDecisions();
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, [rules.keywordDeny(['forbidden'], { action: 'block' })]);
    await expect(run(agent, 'a forbidden request')).rejects.toBeInstanceOf(GuardrailTripped);
    expect(seen[0]?.action).toBe('block');
    expect(rec.calls).toHaveLength(0);
  });

  it("a team uses each agent's own guardrails", async () => {
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const entry = new Agent({
      name: 'entry',
      model: 'gpt-4o',
      instructions: 'Route.',
      client: rec.client,
      guardrails: [rules.keywordDeny(['forbidden'], { action: 'block' })],
    });
    const peer = new Agent({
      name: 'peer',
      model: 'gpt-4o',
      instructions: 'Help.',
      client: rec.client,
    });
    await expect(run([entry, peer], 'a forbidden request')).rejects.toBeInstanceOf(
      GuardrailTripped,
    );
    expect(rec.calls).toHaveLength(0);
  });

  it('streaming output block raises after the deltas', async () => {
    const client = stubStreamTurns([
      [
        { choices: [{ index: 0, delta: { content: 'this is ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'classified' }, finish_reason: 'stop' }] },
      ],
    ]);
    const agent = agentWith(client, [
      rules.keywordDeny(['classified'], { stage: 'output', action: 'block' }),
    ]);
    await expect(async () => {
      for await (const _ev of run.stream(agent, 'tell me')) {
        /* consume */
      }
    }).rejects.toBeInstanceOf(GuardrailTripped);
  });

  it('a bare run with no guardrails is unchanged', async () => {
    const agent = agentWith(stubOpenAI([openaiChat({ content: 'plain' })]));
    const result = await run(agent, 'hello');
    expect(result.output).toBe('plain');
  });

  it('an async custom check runs on the async loop', async () => {
    const { Verdict } = await import('../src/index.js');
    const acheck = rules.custom(async () => new Verdict('block', 'async says no'), {
      stage: 'input',
      name: 'acheck',
    });
    const rec = recordingOpenAI([openaiChat({ content: 'hi' })]);
    const agent = agentWith(rec.client, [acheck]);
    await expect(run(agent, 'anything')).rejects.toBeInstanceOf(GuardrailTripped);
    expect(rec.calls).toHaveLength(0);
  });

  it('re-exports judge + taskAdherence for one-import parity with Python (M8)', () => {
    // Regression: the docs' `import { judge } from '@cendor/sdk'` + `judge.taskAdherence(...)`
    // failed at runtime because index.ts never forwarded them from governance.ts.
    expect(typeof judge).toBe('object'); // the judge namespace
    expect(typeof judge.judge).toBe('function');
    expect(typeof judge.taskAdherence).toBe('function');
    expect(typeof judge.intentPrompt).toBe('function');
    expect(typeof taskAdherence).toBe('function'); // the flat re-export (cendor.sdk.task_adherence)
    // and it composes into a usable guardrail (the copy-paste doc snippet)
    const g = rules.llmJudge(
      judge.taskAdherence(() => '{"trip": false, "reason": "ok"}'),
      {
        stage: 'tool_call',
        action: 'flag',
      },
    );
    expect(g.name).toBe('llm_judge');
  });
});
