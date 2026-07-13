/**
 * Retrieval & embeddings — the TS port of `cendor.sdk.rag` / `embeddings`. `embed()` calls an
 * OpenAI-shaped embeddings client through `instrument()`, so `@cendor/core` (≥ 0.6) captures the
 * governed `LLMCall` (`metadata.embedding = true`, usage + cost) and the **pre-flight interceptor
 * pass applies** — a keyless `withBudget({ usd, onExceed: 'block' }, …)` refuses an over-budget
 * embed before it fires, and a `guard(...)` can redact the text first. The SDK owns the *feature*
 * (it is the caller); the *capture* is core's — the hand-built emit path was deleted in 0.10.0.
 * `VectorIndex` is a dependency-free in-memory cosine index; `as_retriever` wires it into
 * `Agent({ retriever })`.
 */
import { instrument } from '@cendor/core';

export type Embedder = (texts: string[]) => number[][] | Promise<number[][]>;

interface EmbeddingsClient {
  embeddings: {
    create(params: { model: string; input: string[]; dimensions?: number }): Promise<unknown>;
  };
}

function get(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

export interface EmbedOptions {
  client: EmbeddingsClient;
  dimensions?: number;
}

/**
 * Embed inputs via an OpenAI-shaped client. The call rides `instrument()` (idempotent), so core
 * emits the governed `LLMCall` (`metadata.embedding = true`) and pre-flight budgets/guards apply.
 * Returns one vector per input.
 */
export async function embed(
  model: string,
  inputs: string | string[],
  opts: EmbedOptions,
): Promise<number[][]> {
  const list = typeof inputs === 'string' ? [inputs] : inputs;
  const client = instrument(opts.client);
  const resp = await client.embeddings.create({
    model,
    input: list,
    ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
  });
  const data = (get(resp, 'data') as unknown[]) ?? [];
  return data.map((d) => (get(d, 'embedding') as number[]) ?? []);
}

/** Async alias (JS is async-first). */
export const aembed = embed;

/** One search hit. */
export class Hit {
  constructor(
    readonly text: string,
    readonly score: number,
    readonly metadata: Record<string, unknown> = {},
  ) {}
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** `"Relevant context:\n\n" + chunks joined` — what the runner injects as always-on RAG context. */
export function formatContext(chunks: string[]): string {
  return `Relevant context:\n\n${chunks.join('\n\n---\n\n')}`;
}

export interface VectorIndexOptions {
  model?: string;
  client?: EmbeddingsClient;
  embedder?: Embedder;
}

/** A dependency-free in-memory cosine vector index over `embed()`. */
export class VectorIndex {
  private readonly entries: {
    text: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }[] = [];
  private readonly model: string;
  private readonly embedder: Embedder;

  constructor(opts: VectorIndexOptions = {}) {
    this.model = opts.model ?? 'text-embedding-3-small';
    if (opts.embedder) this.embedder = opts.embedder;
    else if (opts.client) {
      const client = opts.client;
      this.embedder = (texts) => embed(this.model, texts, { client });
    } else {
      this.embedder = () => {
        throw new Error('VectorIndex requires an embedder or a client');
      };
    }
  }

  async add(texts: string[], metadatas?: Record<string, unknown>[]): Promise<void> {
    const vectors = await this.embedder(texts);
    texts.forEach((text, i) =>
      this.entries.push({ text, vector: vectors[i] ?? [], metadata: metadatas?.[i] ?? {} }),
    );
  }

  async search(query: string, k = 5): Promise<Hit[]> {
    const [qv] = await this.embedder([query]);
    return this.entries
      .map((e) => new Hit(e.text, cosine(qv ?? [], e.vector), e.metadata))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  asRetriever(k = 5): (query: string) => Promise<string[]> {
    return async (query: string) => (await this.search(query, k)).map((h) => h.text);
  }

  get length(): number {
    return this.entries.length;
  }
}
