/**
 * Provider-auth hardening — fake, provider-shaped clients, no network.
 *
 * N1: a live 401 while the keyless *placeholder* is in play becomes a `MissingAPIKeyError` naming the
 * env var to set — and never fires with a real key, on non-auth errors, or on keyless success. N2:
 * Bedrock rejects `apiKey` with a clear error instead of silently ignoring it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissingAPIKeyError } from '../src/errors.js';
import {
  AnthropicProvider,
  AzureFoundryProvider,
  BedrockProvider,
  type ClientOptions,
  FoundryLocalProvider,
  GeminiProvider,
  HuggingFaceProvider,
  OllamaProvider,
  OpenAIChatProvider,
} from '../src/providers.js';

const KEY_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACEHUB_API_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AZURE_INFERENCE_CREDENTIAL',
  'AZURE_AI_API_KEY',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of KEY_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of KEY_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const OPTS: ClientOptions = {
  apiKey: null,
  baseUrl: null,
  client: null,
  azureADTokenProvider: null,
};

const authError = () => Object.assign(new Error('bad key'), { status: 401 });

/** An OpenAI provider whose client's `create` throws whatever `throwOn` returns (or succeeds). */
class FakeOpenAI extends OpenAIChatProvider {
  constructor(private readonly throwOn: (() => unknown) | null) {
    super();
  }
  override rawClient(_opts: ClientOptions): unknown {
    const err = this.throwOn;
    return {
      chat: {
        completions: {
          create: async () => {
            if (err) throw err();
            return { choices: [{ message: { content: 'ok' } }], usage: {} };
          },
        },
      },
    };
  }
}

describe('N1 placeholder-401 hint', () => {
  it('turns a placeholder 401 into MissingAPIKeyError naming the env var + docs', async () => {
    const p = new FakeOpenAI(authError);
    const create = p.createMethod(p.client(OPTS));
    await expect(create({})).rejects.toBeInstanceOf(MissingAPIKeyError);
    await expect(create({})).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(create({})).rejects.toThrow(/api-keys--credentials/);
  });

  it('does NOT fire with a real key (env)', async () => {
    process.env.OPENAI_API_KEY = 'sk-real';
    const p = new FakeOpenAI(authError);
    const create = p.createMethod(p.client(OPTS));
    await expect(create({})).rejects.not.toBeInstanceOf(MissingAPIKeyError);
  });

  it('does NOT fire with an explicit apiKey', async () => {
    const p = new FakeOpenAI(authError);
    const create = p.createMethod(p.client({ ...OPTS, apiKey: 'sk-explicit' }));
    await expect(create({})).rejects.not.toBeInstanceOf(MissingAPIKeyError);
  });

  it('does NOT fire on a non-auth error', async () => {
    const badReq = () => Object.assign(new Error('bad request'), { status: 400 });
    const p = new FakeOpenAI(badReq);
    const create = p.createMethod(p.client(OPTS));
    await expect(create({})).rejects.not.toBeInstanceOf(MissingAPIKeyError);
    await expect(create({})).rejects.toThrow(/bad request/);
  });

  it('does NOT fire on a keyless success (placeholder still works)', async () => {
    const p = new FakeOpenAI(null);
    const create = p.createMethod(p.client(OPTS));
    const res = (await create({})) as { choices: { message: { content: string } }[] };
    expect(res.choices[0]?.message.content).toBe('ok');
  });
});

describe('placeholder detection matrix', () => {
  // usesPlaceholder is protected; a tiny cast exposes it for the assertion.
  const uses = (p: unknown, o: Partial<ClientOptions> = {}) =>
    (p as { usesPlaceholder(o: ClientOptions): boolean }).usesPlaceholder({ ...OPTS, ...o });

  it('is true for keyed providers without a key, false otherwise', () => {
    expect(uses(new OpenAIChatProvider())).toBe(true);
    expect(uses(new AnthropicProvider())).toBe(true);
    expect(uses(new AzureFoundryProvider())).toBe(true);
    expect(uses(new HuggingFaceProvider())).toBe(true);
    expect(uses(new OpenAIChatProvider(), { apiKey: 'k' })).toBe(false);
    // keyless providers never use the auth placeholder ⇒ never hint
    expect(uses(new BedrockProvider())).toBe(false);
    expect(uses(new OllamaProvider())).toBe(false);
    expect(uses(new GeminiProvider())).toBe(false);
    expect(uses(new FoundryLocalProvider())).toBe(false);
  });

  it('an env key suppresses the placeholder (incl. HF alt var)', () => {
    process.env.OPENAI_API_KEY = 'sk-x';
    expect(uses(new OpenAIChatProvider())).toBe(false);
    process.env.HUGGINGFACEHUB_API_TOKEN = 'hf-x';
    expect(uses(new HuggingFaceProvider())).toBe(false);
  });
});

describe('N2 Bedrock apiKey', () => {
  it('rejects apiKey with a clear AWS-credential-chain error', () => {
    expect(() => new BedrockProvider().rawClient({ ...OPTS, apiKey: 'k' })).toThrow(
      /AWS credential chain/,
    );
  });
});
