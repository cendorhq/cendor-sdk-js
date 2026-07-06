/**
 * Providers — the TS port of `cendor.sdk.providers`. The runner keeps history in ONE canonical shape
 * (OpenAI Chat messages) with the system prompt kept OUT of the list; each provider translates
 * canonical → its wire form. OpenAI (Chat + Responses) and Anthropic are shipped; the rest are
 * scaffolded behind the same `Provider` interface (throw a clear error until ported — pass `client=`
 * or use OpenAI/Anthropic). Provider clients are adopted + `instrument()`ed so calls ride the bus.
 */
import { createRequire } from 'node:module';
import { instrument } from '@cendor/core';
import type { JsonSchema, Tool } from './tools.js';
import type { Message, ParsedResponse, ToolInvocation } from './types.js';

const require = createRequire(import.meta.url);

// --------------------------------------------------------------------------- canonical builders

/** Canonical assistant message (tool call arguments are JSON-stringified in the canonical shape). */
export function assistantMessage(content: string | null, toolCalls: ToolInvocation[]): Message {
  const msg: Message = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return msg;
}

/** Canonical tool-result message. */
export function toolResultMessage(toolCallId: string, name: string, content: string): Message {
  return { role: 'tool', tool_call_id: toolCallId, name, content };
}

function loadsArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function get(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

// --------------------------------------------------------------------------- provider inference

const PREFIX_PROVIDERS: [string, string][] = [
  ['gpt-', 'openai'],
  ['chatgpt', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['claude', 'anthropic'],
  ['gemini', 'google'],
  ['bedrock/', 'bedrock'],
  ['anthropic.', 'bedrock'],
  ['amazon.', 'bedrock'],
  ['meta.', 'bedrock'],
  ['mistral.', 'bedrock'],
  ['cohere.', 'bedrock'],
  ['llama', 'ollama'],
  ['qwen', 'ollama'],
  ['mistral', 'ollama'],
  ['phi', 'ollama'],
  ['gemma', 'ollama'],
];

/** Infer a provider name from a model id (first prefix wins). Throws if none match. */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  for (const [prefix, provider] of PREFIX_PROVIDERS) {
    if (m.startsWith(prefix)) return provider;
  }
  throw new Error(`cannot infer provider from model id ${JSON.stringify(model)}; pass provider=`);
}

// --------------------------------------------------------------------------- base + registry

export interface BuildKwargsOptions {
  jsonMode?: boolean;
  temperature?: number | null;
  maxTokens?: number | null;
  outputSchema?: JsonSchema | null;
}
export interface ClientOptions {
  apiKey?: string | null;
  baseUrl?: string | null;
  client?: unknown;
}

/** The provider contract each backend implements. */
export interface Provider {
  readonly name: string;
  readonly supportsStream: boolean;
  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown>;
  parse(response: unknown): ParsedResponse;
  applyCache(kwargs: Record<string, unknown>): Record<string, unknown>;
  streamText(chunk: unknown): string;
  parseStream(chunks: unknown[]): ParsedResponse;
  client(opts: ClientOptions): unknown;
  createMethod(client: unknown): (kwargs: Record<string, unknown>) => Promise<unknown>;
}

abstract class BaseProvider implements Provider {
  abstract readonly name: string;
  readonly supportsStream: boolean = false;
  protected abstract readonly createPath: string[];
  private readonly cache = new Map<string, unknown>();

  abstract rawClient(opts: ClientOptions): unknown;
  abstract buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown>;
  abstract parse(response: unknown): ParsedResponse;

  applyCache(kwargs: Record<string, unknown>): Record<string, unknown> {
    return kwargs;
  }
  streamText(_chunk: unknown): string {
    return '';
  }
  parseStream(chunks: unknown[]): ParsedResponse {
    // Whole-response fallback: parse the single collected response.
    return this.parse(chunks[chunks.length - 1]);
  }

  client(opts: ClientOptions): unknown {
    if (opts.client) return instrument(opts.client);
    const key = `${this.name}:${opts.apiKey ?? ''}:${opts.baseUrl ?? ''}`;
    let c = this.cache.get(key);
    if (c === undefined) {
      c = instrument(this.rawClient(opts));
      this.cache.set(key, c);
    }
    return c;
  }

  createMethod(client: unknown): (kwargs: Record<string, unknown>) => Promise<unknown> {
    let owner: unknown = client;
    for (const p of this.createPath.slice(0, -1)) owner = get(owner, p);
    const attr = this.createPath[this.createPath.length - 1]!;
    const fn = get(owner, attr) as (kwargs: Record<string, unknown>) => Promise<unknown>;
    return (kwargs) => fn.call(owner, kwargs);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// --------------------------------------------------------------------------- OpenAI Chat (shipped)

function openaiSupportsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return !(m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4'));
}

class OpenAIChatProvider extends BaseProvider {
  readonly name = 'openai';
  override readonly supportsStream = true;
  protected readonly createPath = ['chat', 'completions', 'create'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('openai');
    const OpenAI = mod.OpenAI ?? mod.default ?? mod;
    return new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? 'sk-cendor-sdk-placeholder',
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    let sys = instructions;
    if (opts.jsonMode && !opts.outputSchema)
      sys = `${sys}\n\nRespond with a single JSON object.`.trim();
    const wire: Message[] = [];
    if (sys) wire.push({ role: 'system', content: sys });
    wire.push(...messages);
    const kwargs: Record<string, unknown> = { model, messages: wire };
    if (tools.length > 0) kwargs.tools = tools.map((t) => t.toOpenai());
    if (opts.jsonMode) {
      kwargs.response_format = opts.outputSchema
        ? {
            type: 'json_schema',
            json_schema: { name: 'output', schema: opts.outputSchema, strict: false },
          }
        : { type: 'json_object' };
    }
    if (opts.temperature != null && openaiSupportsTemperature(model))
      kwargs.temperature = opts.temperature;
    if (opts.maxTokens != null) kwargs.max_tokens = opts.maxTokens;
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    const choice =
      get(get(response, 'choices'), '0') ??
      (Array.isArray(get(response, 'choices'))
        ? (get(response, 'choices') as unknown[])[0]
        : undefined);
    const message = get(choice, 'message');
    const content = (get(message, 'content') as string | null) ?? null;
    const toolCalls: ToolInvocation[] = [];
    const rawCalls = get(message, 'tool_calls');
    if (Array.isArray(rawCalls)) {
      for (let i = 0; i < rawCalls.length; i++) {
        const tc = rawCalls[i];
        const fn = get(tc, 'function');
        toolCalls.push({
          id: (get(tc, 'id') as string) ?? `call_${i}`,
          name: (get(fn, 'name') as string) ?? '',
          arguments: loadsArgs(get(fn, 'arguments')),
        });
      }
    }
    return {
      content,
      toolCalls,
      finishReason: (get(choice, 'finish_reason') as string) ?? null,
      raw: response,
    };
  }

  override streamText(chunk: unknown): string {
    const choices = get(chunk, 'choices');
    if (!Array.isArray(choices)) return '';
    return choices.map((c) => (get(get(c, 'delta'), 'content') as string) ?? '').join('');
  }

  override parseStream(chunks: unknown[]): ParsedResponse {
    let content = '';
    const byIndex = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    for (const chunk of chunks) {
      const choices = get(chunk, 'choices');
      if (!Array.isArray(choices)) continue;
      for (const c of choices) {
        const delta = get(c, 'delta');
        content += (get(delta, 'content') as string) ?? '';
        const fr = get(c, 'finish_reason');
        if (fr) finishReason = fr as string;
        const tcs = get(delta, 'tool_calls');
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = (get(tc, 'index') as number) ?? 0;
            const acc = byIndex.get(idx) ?? { id: '', name: '', args: '' };
            if (get(tc, 'id')) acc.id = get(tc, 'id') as string;
            const fn = get(tc, 'function');
            if (get(fn, 'name')) acc.name = get(fn, 'name') as string;
            if (get(fn, 'arguments')) acc.args += get(fn, 'arguments') as string;
            byIndex.set(idx, acc);
          }
        }
      }
    }
    const toolCalls: ToolInvocation[] = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, acc]) => ({
        id: acc.id || `call_${i}`,
        name: acc.name,
        arguments: loadsArgs(acc.args),
      }));
    return { content: content || null, toolCalls, finishReason, raw: chunks };
  }
}

// --------------------------------------------------------------------------- OpenAI Responses (shipped)

class OpenAIResponsesProvider extends BaseProvider {
  readonly name = 'openai_responses';
  protected readonly createPath = ['responses', 'create'];

  rawClient(opts: ClientOptions): unknown {
    return new OpenAIChatProvider().rawClient(opts);
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    let sys = instructions;
    if (opts.jsonMode) {
      sys = opts.outputSchema
        ? `${sys}\n\nRespond with ONLY a single JSON object matching this schema: ${JSON.stringify(opts.outputSchema)}`.trim()
        : `${sys}\n\nRespond with only a single JSON object.`.trim();
    }
    const kwargs: Record<string, unknown> = { model, input: messages };
    if (sys) kwargs.instructions = sys;
    if (tools.length > 0) kwargs.tools = tools.map((t) => t.toOpenaiResponses());
    if (opts.temperature != null && openaiSupportsTemperature(model))
      kwargs.temperature = opts.temperature;
    if (opts.maxTokens != null) kwargs.max_output_tokens = opts.maxTokens;
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    let content = (get(response, 'output_text') as string) ?? null;
    const toolCalls: ToolInvocation[] = [];
    const output = get(response, 'output');
    if (Array.isArray(output)) {
      const parts: string[] = [];
      for (const item of output) {
        const itype = get(item, 'type');
        if (itype === 'function_call') {
          toolCalls.push({
            id:
              (get(item, 'call_id') as string) ??
              (get(item, 'id') as string) ??
              `call_${toolCalls.length}`,
            name: (get(item, 'name') as string) ?? '',
            arguments: loadsArgs(get(item, 'arguments')),
          });
        } else if (itype === 'message') {
          const cparts = get(item, 'content');
          if (Array.isArray(cparts)) {
            for (const p of cparts) {
              const pt = get(p, 'type');
              if (pt === 'output_text' || pt === 'text')
                parts.push((get(p, 'text') as string) ?? '');
            }
          }
        }
      }
      if (content === null && parts.length > 0) content = parts.join('');
    }
    return {
      content,
      toolCalls,
      finishReason: (get(response, 'status') as string) ?? null,
      raw: response,
    };
  }
}

// --------------------------------------------------------------------------- Anthropic (shipped)

function canonicalToAnthropic(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pendingToolResults: unknown[] = [];
  const flush = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  for (const m of messages) {
    const role = m.role;
    if (role === 'assistant') {
      flush();
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      const tcs = m.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = get(tc, 'function');
          blocks.push({
            type: 'tool_use',
            id: get(tc, 'id'),
            name: get(fn, 'name'),
            input: loadsArgs(get(fn, 'arguments')),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      });
    } else {
      flush();
      out.push({ role: 'user', content: m.content });
    }
  }
  flush();
  return out;
}

class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  protected readonly createPath = ['messages', 'create'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.Anthropic ?? mod.default ?? mod;
    return new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'sk-ant-cendor-sdk-placeholder',
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    let sys = instructions;
    if (opts.jsonMode) {
      sys = opts.outputSchema
        ? `${sys}\n\nRespond with ONLY a single JSON object matching this schema: ${JSON.stringify(opts.outputSchema)}`.trim()
        : `${sys}\n\nRespond with only a single JSON object.`.trim();
    }
    const kwargs: Record<string, unknown> = {
      model,
      messages: canonicalToAnthropic(messages),
      max_tokens: opts.maxTokens ?? 1024,
    };
    if (sys) kwargs.system = sys;
    if (tools.length > 0) kwargs.tools = tools.map((t) => t.toAnthropic());
    if (opts.temperature != null) kwargs.temperature = opts.temperature;
    return kwargs;
  }

  override applyCache(kwargs: Record<string, unknown>): Record<string, unknown> {
    const cc = { type: 'ephemeral' };
    const sys = kwargs.system;
    if (typeof sys === 'string' && sys) {
      kwargs.system = [{ type: 'text', text: sys, cache_control: cc }];
    } else if (Array.isArray(sys) && sys.length > 0) {
      (sys[sys.length - 1] as Record<string, unknown>).cache_control = cc;
    }
    const tools = kwargs.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = cc;
    }
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    const blocks = get(response, 'content');
    const parts: string[] = [];
    const toolCalls: ToolInvocation[] = [];
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const bt = get(b, 'type');
        if (bt === 'text') parts.push((get(b, 'text') as string) ?? '');
        else if (bt === 'tool_use') {
          toolCalls.push({
            id: (get(b, 'id') as string) ?? `call_${toolCalls.length}`,
            name: (get(b, 'name') as string) ?? '',
            arguments: (get(b, 'input') as Record<string, unknown>) ?? {},
          });
        }
      }
    }
    return {
      content: parts.length > 0 ? parts.join('') : null,
      toolCalls,
      finishReason: (get(response, 'stop_reason') as string) ?? null,
      raw: response,
    };
  }
}

// --------------------------------------------------------------------------- scaffolded providers

class UnportedProvider extends BaseProvider {
  readonly name: string;
  protected readonly createPath: string[] = ['create'];
  constructor(name: string) {
    super();
    this.name = name;
  }
  private nope(): never {
    throw new Error(
      `provider ${JSON.stringify(this.name)} is not yet ported in @cendor/sdk (JS). Use an OpenAI or Anthropic model, or pass a pre-built client via Agent({ client }).`,
    );
  }
  rawClient(): unknown {
    return this.nope();
  }
  buildKwargs(): Record<string, unknown> {
    return this.nope();
  }
  parse(): ParsedResponse {
    return this.nope();
  }
}

const REGISTRY = new Map<string, Provider>();
function reg(p: Provider, ...aliases: string[]): void {
  REGISTRY.set(p.name, p);
  for (const a of aliases) REGISTRY.set(a, p);
}
reg(new OpenAIChatProvider());
reg(new OpenAIResponsesProvider());
reg(new AnthropicProvider());
reg(new UnportedProvider('google'), 'gemini');
reg(new UnportedProvider('bedrock'));
reg(new UnportedProvider('ollama'));
reg(new UnportedProvider('huggingface'), 'hf');
reg(new UnportedProvider('azure'), 'azure_openai', 'foundry');
reg(new UnportedProvider('foundry_local'), 'foundry-local');

/** Registry lookup by provider name. Throws on unknown. */
export function getProvider(name: string): Provider {
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`unknown provider ${JSON.stringify(name)}`);
  return p;
}

/** Explicit provider wins, else inferred from the model id. */
export function resolveProvider(model: string, provider?: string | null): Provider {
  return getProvider(provider ?? inferProvider(model));
}

/** Clear all provider client caches (test isolation). */
export function resetProviderCache(): void {
  for (const p of new Set(REGISTRY.values())) {
    (p as unknown as { clearCache?: () => void }).clearCache?.();
  }
}
