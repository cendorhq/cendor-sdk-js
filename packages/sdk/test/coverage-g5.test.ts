/**
 * G5 coverage additions (parity with the Python `test_a2a_serve.py` + pipeline governance wave):
 * A2A `serve()` real HTTP round-trip over loopback, `SqliteSessionStore` disk round-trip
 * (skipped cleanly when `better-sqlite3` is absent), Foundry Local / Azure Responses `buildKwargs`
 * beyond URL normalization, and a resilience expansion (retryable-status matrix +
 * never-retries-governance-trips + retry-then-succeed). All offline / loopback.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyViolation } from '@cendor/acttrace';
import { BudgetExceeded } from '@cendor/tokenguard';
import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '../src/a2a.js';
import { Agent, Session, SqliteSessionStore } from '../src/index.js';
import { AzureFoundryResponsesProvider, FoundryLocalProvider } from '../src/providers.js';
import { RetryPolicy, callWithRetry, defaultIsTransient } from '../src/resilience.js';
import { openaiChat, stubOpenAI } from './_helpers.js';

const requireFn = createRequire(import.meta.url);
const hasSqlite = ((): boolean => {
  try {
    requireFn.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

// --------------------------------------------------------------------------- A2A serve() over HTTP

function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    })
      .on('error', reject)
      .end();
  });
}

function httpPost(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('@cendor/sdk — A2A serve() HTTP round-trip (loopback)', () => {
  it('serves the agent card and a message/send over 127.0.0.1', async () => {
    const agent = new Agent({
      name: 'greeter',
      model: 'gpt-4o',
      instructions: 'Greet.',
      client: stubOpenAI([openaiChat({ content: 'Hello over HTTP.' })]),
    });
    const server = serve(agent); // 127.0.0.1:0 (ephemeral)
    try {
      await new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once('listening', () => resolve());
      });
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const card = (await httpGet(`${base}/.well-known/agent-card.json`)) as {
        status: number;
        body: { name: string; capabilities: { streaming: boolean } };
      };
      expect(card.status).toBe(200);
      expect(card.body.name).toBe('greeter');
      expect(card.body.capabilities.streaming).toBe(false); // honestly advertised

      const rpc = {
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
      };
      const res = (await httpPost(`${base}/`, rpc)) as {
        status: number;
        body: {
          result: { parts: { kind: string; text?: string }[]; metadata: { trace_id: string } };
        };
      };
      expect(res.status).toBe(200);
      const text = res.body.result.parts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
      expect(text).toBe('Hello over HTTP.');
      expect(res.body.result.metadata.trace_id).toBeTruthy();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --------------------------------------------------------------------------- SqliteSessionStore disk

describe('@cendor/sdk — SqliteSessionStore disk round-trip', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it.skipIf(!hasSqlite)('persists a session to a file and reloads it in a fresh store', () => {
    dir = mkdtempSync(join(tmpdir(), 'cendor-sqlite-'));
    const dbPath = join(dir, 'sessions.db');

    const store = new SqliteSessionStore(dbPath);
    const session = new Session(
      [
        { role: 'user', content: 'my name is Dana' },
        { role: 'assistant', content: 'Hi Dana.' },
      ],
      'user-42',
    );
    store.save('user-42', session);
    expect(store.ids()).toContain('user-42');
    store.close();
    expect(existsSync(dbPath)).toBe(true);

    // Reopen — durable across "restarts".
    const reopened = new SqliteSessionStore(dbPath);
    try {
      const loaded = reopened.load('user-42');
      expect(loaded.snapshot()).toEqual(session.snapshot());
      expect(reopened.load('unknown').snapshot()).toEqual([]); // empty session for a new id
    } finally {
      reopened.close();
    }
  });
});

// --------------------------------------------------------------------------- Foundry Local / Azure Responses

describe('@cendor/sdk — Foundry Local / Azure Responses buildKwargs', () => {
  it('Foundry Local builds an OpenAI-chat request (model + messages)', () => {
    const k = new FoundryLocalProvider().buildKwargs(
      'phi-3.5-mini',
      [{ role: 'user', content: 'hi' }],
      [],
      '',
      {},
    ) as { model: string; messages: unknown[] };
    expect(k.model).toBe('phi-3.5-mini');
    expect(Array.isArray(k.messages)).toBe(true);
    expect(k.messages.length).toBe(1);
  });

  it('Azure Responses builds a Responses-API request (input, not messages)', () => {
    const k = new AzureFoundryResponsesProvider().buildKwargs(
      'gpt-4o',
      [{ role: 'user', content: 'hi' }],
      [],
      'Be terse.',
      {},
    ) as Record<string, unknown>;
    expect(k.model).toBe('gpt-4o');
    expect('input' in k).toBe(true); // Responses API uses `input`
    expect('messages' in k).toBe(false);
    expect(k.instructions).toBe('Be terse.');
  });
});

// --------------------------------------------------------------------------- resilience expansion

describe('@cendor/sdk — resilience', () => {
  it('retryable-status matrix: transient statuses retry, others do not', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(defaultIsTransient({ status })).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(defaultIsTransient({ status })).toBe(false);
    }
  });

  it('never retries governance trips (BudgetExceeded / PolicyViolation)', () => {
    expect(defaultIsTransient(new BudgetExceeded('over budget'))).toBe(false);
    expect(defaultIsTransient(new PolicyViolation('policy'))).toBe(false);
  });

  it('callWithRetry retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const policy = new RetryPolicy({ maxAttempts: 3, sleep: async () => {} });
    const out = await callWithRetry(async () => {
      attempts++;
      if (attempts < 2) throw { status: 503 };
      return 'ok';
    }, policy);
    expect(out).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('callWithRetry does not retry a governance trip and gives up immediately', async () => {
    let attempts = 0;
    const policy = new RetryPolicy({ maxAttempts: 5, sleep: async () => {} });
    await expect(
      callWithRetry(async () => {
        attempts++;
        throw new BudgetExceeded('over');
      }, policy),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(attempts).toBe(1); // classifier said "don't retry" → one attempt only
  });
});
