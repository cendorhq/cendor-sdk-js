/**
 * Azure AI Foundry keyless Entra-ID auth — a refreshing bearer-token provider builds the openai
 * `AzureOpenAI` client (which injects a fresh token per request), while the string-key path keeps
 * the plain `OpenAI` client. Construction-only: the token provider is invoked lazily per request,
 * so these assert the wiring without any network.
 */
import { describe, expect, it } from 'vitest';
import { AzureFoundryProvider, AzureFoundryResponsesProvider } from '../src/providers.js';

const ctorName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const endpoint = 'https://my-resource.openai.azure.com';

describe('Azure Entra-ID token provider', () => {
  it('builds an AzureOpenAI client when azureADTokenProvider is set', () => {
    const client = new AzureFoundryProvider().rawClient({
      azureADTokenProvider: async () => 'fake-entra-token',
      baseUrl: endpoint,
    });
    expect(ctorName(client)).toBe('AzureOpenAI');
  });

  it('falls back to the plain OpenAI client for a string apiKey', () => {
    const client = new AzureFoundryProvider().rawClient({ apiKey: 'sk-test', baseUrl: endpoint });
    expect(ctorName(client)).toBe('OpenAI');
  });

  it('the Responses variant also honors the token provider', () => {
    const client = new AzureFoundryResponsesProvider().rawClient({
      azureADTokenProvider: async () => 'fake-entra-token',
      baseUrl: endpoint,
    });
    expect(ctorName(client)).toBe('AzureOpenAI');
  });

  it('does not cache token-provider clients (each build is fresh)', () => {
    const provider = new AzureFoundryProvider();
    const opts = { azureADTokenProvider: async () => 'fake-entra-token', baseUrl: endpoint };
    // client() must not return a stale cache entry for a callback that has no stable key.
    expect(provider.client(opts)).not.toBe(provider.client(opts));
  });
});
