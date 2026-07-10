/**
 * Memory — the TS port of `cendor.sdk.memory`. `Session` is cross-call conversation memory; the
 * runner loads a snapshot in and replaces it out on finish. `SummarizingSession` folds old turns
 * into a durable note; `SqliteSessionStore` / `MemorySessionStore` are durable multi-conversation
 * stores behind a common `SessionStore` interface.
 */
import { createRequire } from 'node:module';
import { Agent } from './agent.js';
import type { Message } from './types.js';

const require = createRequire(import.meta.url);

/** In-memory conversation memory with optional JSON persistence. */
export class Session {
  messages: Message[];
  constructor(messages: Message[] = []) {
    this.messages = messages;
  }
  add(message: Message): void {
    this.messages.push(message);
  }
  extend(messages: Message[]): void {
    this.messages.push(...messages);
  }
  snapshot(): Message[] {
    return [...this.messages];
  }
  replace(messages: Message[]): void {
    this.messages = [...messages];
  }
  clear(): void {
    this.messages = [];
  }
  get length(): number {
    return this.messages.length;
  }
  save(path: string): void {
    const fs = require('node:fs');
    const pathMod = require('node:path');
    fs.mkdirSync(pathMod.dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ messages: this.messages }), 'utf8');
  }
  static load(path: string): Session {
    const fs = require('node:fs');
    if (!fs.existsSync(path)) return new Session();
    const data = JSON.parse(fs.readFileSync(path, 'utf8')) as { messages?: Message[] };
    return new Session(data.messages ?? []);
  }
}

export type Summarizer = (
  oldMessages: Message[],
  priorSummary: string | null,
) => string | Promise<string>;

const MEMORY_PREFIX = 'Conversation summary so far:\n';

function renderMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = String(m.role ?? '');
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const tools = Array.isArray(m.tool_calls)
        ? ` [called ${m.tool_calls.map((t) => (t as { function?: { name?: string } }).function?.name).join(', ')}]`
        : '';
      return `${role}: ${text}${tools}`;
    })
    .join('\n');
}

/** A governed one-shot summarizer built from a tiny Agent (its LLMCall rides the bus). */
export function llmSummarizer(
  model: string,
  opts: { provider?: string; apiKey?: string; baseUrl?: string; maxTokens?: number } = {},
): Summarizer {
  return async (oldMessages, priorSummary) => {
    const { run } = await import('./runner.js');
    const agent = new Agent({
      name: 'memory-summarizer',
      model,
      provider: opts.provider ?? null,
      apiKey: opts.apiKey ?? null,
      baseURL: opts.baseUrl ?? null,
      maxTokens: opts.maxTokens ?? 512,
      instructions:
        'Summarize the conversation so far concisely, preserving facts, decisions, and open threads.',
    });
    const prompt = `${priorSummary ? `${priorSummary}\n\n` : ''}Summarize:\n${renderMessages(oldMessages)}`;
    const result = await run(agent, prompt);
    return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  };
}

export interface SummarizingSessionOptions {
  model?: string;
  summarizer?: Summarizer;
  maxMessages?: number;
  keepRecent?: number;
  messages?: Message[];
}

/** A `Session` that folds old turns into a durable summary note when it grows past `maxMessages`. */
export class SummarizingSession extends Session {
  private readonly summarizer: Summarizer;
  private readonly maxMessages: number;
  private readonly keepRecent: number;

  constructor(opts: SummarizingSessionOptions = {}) {
    super(opts.messages ?? []);
    if (!opts.summarizer && !opts.model)
      throw new Error('SummarizingSession requires summarizer or model');
    this.summarizer = opts.summarizer ?? llmSummarizer(opts.model as string);
    this.maxMessages = opts.maxMessages ?? 20;
    this.keepRecent = opts.keepRecent ?? 8;
  }

  override async replace(messages: Message[]): Promise<void> {
    super.replace(messages);
    // Summarization is an LLM `run`; the runner awaits `replace`, so it finishes before the run
    // returns — deterministic session state, correlated bus events, and surfaced errors (PY
    // `SummarizingSession.replace` is synchronous + blocking).
    await this.maybeSummarize();
  }

  async maybeSummarize(): Promise<void> {
    if (this.messages.length <= this.maxMessages) return;
    let prior: string | null = null;
    let rest = this.messages;
    const first = this.messages[0];
    if (
      first &&
      first.role === 'system' &&
      typeof first.content === 'string' &&
      first.content.startsWith(MEMORY_PREFIX)
    ) {
      prior = first.content.slice(MEMORY_PREFIX.length);
      rest = this.messages.slice(1);
    }
    const recent = rest.slice(-this.keepRecent);
    const older = rest.slice(0, rest.length - this.keepRecent);
    if (older.length === 0) return;
    const summary = await this.summarizer(older, prior);
    this.messages = [{ role: 'system', content: `${MEMORY_PREFIX}${summary}` }, ...recent];
  }
}

// --------------------------------------------------------------------------- stores

/** A durable multi-conversation store. */
export interface SessionStore {
  load(id: string): Session;
  save(id: string, session: Session): void;
  ids(): string[];
  close(): void;
}

/** In-memory session store (browser/tests). */
export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Message[]>();
  load(id: string): Session {
    return new Session([...(this.map.get(id) ?? [])]);
  }
  save(id: string, session: Session): void {
    this.map.set(id, session.snapshot());
  }
  ids(): string[] {
    return [...this.map.keys()];
  }
  close(): void {}
}

/**
 * Durable SQLite-backed session store (Node; via `better-sqlite3`). Note the casing —
 * `SqliteSessionStore` (Python's equivalent is spelled `SQLiteSessionStore`).
 *
 * @example
 * ```ts
 * import { SqliteSessionStore } from '@cendor/sdk';
 * const session = new SqliteSessionStore('sessions.db');
 * ```
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: {
    prepare(sql: string): {
      run(...a: unknown[]): unknown;
      get(...a: unknown[]): unknown;
      all(...a: unknown[]): unknown[];
    };
    exec(sql: string): void;
    close(): void;
  };
  constructor(path: string) {
    const Database = require('better-sqlite3');
    this.db = new Database(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, messages TEXT NOT NULL)',
    );
  }
  load(id: string): Session {
    const row = this.db.prepare('SELECT messages FROM sessions WHERE id = ?').get(id) as
      | { messages?: string }
      | undefined;
    if (!row) return new Session();
    return new Session(JSON.parse(row.messages ?? '[]') as Message[]);
  }
  save(id: string, session: Session): void {
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id, messages) VALUES (?, ?)')
      .run(id, JSON.stringify(session.snapshot()));
  }
  ids(): string[] {
    return (this.db.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
  }
  close(): void {
    this.db.close();
  }
}

/**
 * @deprecated Canonical casing is `SqliteSessionStore` (Python uses `SQLiteSessionStore`). Kept as an
 * alias so Python users' spelling still resolves in TypeScript.
 *
 * @example
 * ```ts
 * import { SQLiteSessionStore } from '@cendor/sdk';
 * const session = new SQLiteSessionStore('sessions.db');
 * ```
 */
export const SQLiteSessionStore = SqliteSessionStore;
