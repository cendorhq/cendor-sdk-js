/**
 * Two Azure/Foundry v1 fixes, both found by live verification on 2026-07-31 and both invisible to
 * a name-based rule, because on Azure the model id a call carries is the *deployment* name the
 * user chose.
 *
 * 1. A Foundry **project** endpoint (`…/api/projects/<name>`) — what the portal shows, and what
 *    `@azure/ai-projects` is constructed with — now takes `/openai/v1/`. Measured: with it the
 *    endpoint serves Chat Completions (it is exactly what `AIProjectClient.getOpenAIClient()`
 *    builds); without it the bare endpoint answers `400 Missing required query parameter:
 *    api-version`, an error that reads like "go back to the legacy AzureOpenAI client" and is not.
 * 2. `callModel` repairs a request once when the provider names both the rejected parameter and
 *    its replacement — the `max_tokens` → `max_completion_tokens` 400 every gpt-5/o-series
 *    deployment answers.
 */
import { describe, expect, it } from 'vitest';
import { azureFoundryBaseUrl } from '../src/providers.js';
import { callModel, paramSwap } from '../src/resilience.js';

const SWAP_MESSAGE =
  "Error code: 400 - Unsupported parameter: 'max_tokens' is not supported with this model. " +
  "Use 'max_completion_tokens' instead.";

describe('azureFoundryBaseUrl — Foundry project endpoints', () => {
  const proj = 'https://myres.services.ai.azure.com/api/projects/my-project';

  it('routes a project endpoint to /openai/v1/', () => {
    expect(azureFoundryBaseUrl({ baseUrl: proj })).toBe(`${proj}/openai/v1/`);
    expect(azureFoundryBaseUrl({ baseUrl: `${proj}/` })).toBe(`${proj}/openai/v1/`);
  });

  it('matches on the PATH, so a sovereign/private Foundry host is covered', () => {
    const other = 'https://foundry.contoso-gov.example/api/projects/p1';
    expect(azureFoundryBaseUrl({ baseUrl: other })).toBe(`${other}/openai/v1/`);
  });

  it('negative controls: an already-routed endpoint and an unrelated gateway path do not move', () => {
    expect(azureFoundryBaseUrl({ baseUrl: `${proj}/openai/v1` })).toBe(`${proj}/openai/v1/`);
    expect(azureFoundryBaseUrl({ baseUrl: 'https://gw.example.com/v1' })).toBe(
      'https://gw.example.com/v1/',
    );
  });
});

describe('callModel — one parameter-swap repair', () => {
  function swappingCreate(seen: Record<string, unknown>[]) {
    return async (kwargs: Record<string, unknown>): Promise<unknown> => {
      seen.push({ ...kwargs });
      if ('max_tokens' in kwargs) throw new Error(SWAP_MESSAGE);
      return { ok: true, max_completion_tokens: kwargs.max_completion_tokens };
    };
  }

  it('renames the parameter and re-issues the call exactly once', async () => {
    const seen: Record<string, unknown>[] = [];
    const out = await callModel(swappingCreate(seen), { model: 'dep', max_tokens: 64 }, null);
    expect(out).toEqual({ ok: true, max_completion_tokens: 64 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toHaveProperty('max_tokens');
    expect(seen[1]?.max_completion_tokens).toBe(64);
  });

  it('does not fire on an unrelated error', async () => {
    let calls = 0;
    const create = async (): Promise<unknown> => {
      calls++;
      throw new Error('something else entirely');
    };
    await expect(callModel(create, { model: 'dep', max_tokens: 8 }, null)).rejects.toThrow(
      'something else entirely',
    );
    expect(calls).toBe(1);
  });

  it('does not fire when the named key was never sent', async () => {
    let calls = 0;
    const create = async (): Promise<unknown> => {
      calls++;
      throw new Error(SWAP_MESSAGE);
    };
    await expect(callModel(create, { model: 'dep' }, null)).rejects.toThrow(
      'Unsupported parameter',
    );
    expect(calls).toBe(1);
  });

  it('repairs once — a second failure reaches the caller', async () => {
    let calls = 0;
    const create = async (): Promise<unknown> => {
      calls++;
      throw calls === 1 ? new Error(SWAP_MESSAGE) : new Error('still broken');
    };
    await expect(callModel(create, { model: 'dep', max_tokens: 8 }, null)).rejects.toThrow(
      'still broken',
    );
    expect(calls).toBe(2);
  });

  it('paramSwap returns null when the replacement key is already set', () => {
    expect(
      paramSwap(new Error(SWAP_MESSAGE), { max_tokens: 8, max_completion_tokens: 8 }),
    ).toBeNull();
  });
});
