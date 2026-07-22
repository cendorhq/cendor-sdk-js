/**
 * Providers — the TS port of `cendor.sdk.providers`. The runner keeps history in ONE canonical shape
 * (OpenAI Chat messages) with the system prompt kept OUT of the list; each provider translates
 * canonical → its wire form. OpenAI (Chat + Responses), Anthropic, Gemini, Bedrock, Ollama, Hugging
 * Face, Azure AI Foundry (Chat + Responses) and Foundry Local are all ported. Client construction for
 * the non-OpenAI/Anthropic backends is lazy (their SDK is `require`d only when a client is built).
 *
 * Usage/cost is captured by the installed `@cendor/core`'s `instrument()` → bus, not here. The
 * shipped `@cendor/core` detects openai / openai_responses / anthropic, so Azure (chat + responses)
 * and Foundry Local — which wrap the standard `openai` client — get full end-to-end usage now. Hugging
 * Face / Ollama / Gemini / Bedrock produce a correct `ParsedResponse` today, but their usage capture
 * depends on new `@cendor/core` detection that reaches this package at a coordinated release.
 */
import { createRequire } from 'node:module';
import { instrument } from '@cendor/core';
import { MissingAPIKeyError } from './errors.js';
import type { JsonSchema, Tool } from './tools.js';
import type { Message, ParsedResponse, ToolInvocation } from './types.js';

const require = createRequire(import.meta.url);

// Clients built with the keyless placeholder are recorded here → their create method is wrapped so a
// placeholder 401 becomes a clear, env-var-naming hint. A WeakMap keeps it tied to the client's life.
const placeholderHints = new WeakMap<object, string>();

/** Whether `err` is a provider authentication failure (a 401/403 or an `AuthenticationError` type). */
function isAuthError(err: unknown): boolean {
  const e = err as
    | { status?: unknown; statusCode?: unknown; name?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status === 401 || status === 403) return true;
  return e?.name === 'AuthenticationError' || e?.name === 'PermissionDeniedError';
}

// --------------------------------------------------------------------------- canonical builders

/** Canonical assistant message (tool call arguments are JSON-stringified in the canonical shape). */
export function assistantMessage(content: string | null, toolCalls: ToolInvocation[]): Message {
  const msg: Message = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      // provider-opaque token round-tripped verbatim (Gemini 3.x thought signatures); present only
      // when the provider returned one, ignored by every other adapter.
      ...(tc.thoughtSignature != null ? { thought_signature: tc.thoughtSignature } : {}),
    }));
  }
  return msg;
}

/** Canonical tool-result message. */
export function toolResultMessage(toolCallId: string, name: string, content: string): Message {
  return { role: 'tool', tool_call_id: toolCallId, name, content };
}

/**
 * Map a canonical message onto the Ollama wire shape: assistant `tool_calls` keep OpenAI's structure
 * except `function.arguments`, which Ollama wants as an object (the canonical form is a JSON string).
 * Every other message passes through unchanged.
 */
export function ollamaMessage(m: Message): Message {
  const tcs = m.tool_calls;
  if (m.role !== 'assistant' || !Array.isArray(tcs)) return m;
  return {
    ...m,
    tool_calls: tcs.map((tc) => {
      const fn = get(tc, 'function');
      return {
        ...(tc as Record<string, unknown>),
        function: {
          name: (get(fn, 'name') as string) ?? '',
          arguments: loadsArgs(get(fn, 'arguments')),
        },
      };
    }),
  };
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

function first(seq: unknown): unknown {
  return Array.isArray(seq) ? seq[0] : undefined;
}

/** Mirror of Python `_stringify`: `null` → "", strings pass through, everything else JSON-encodes. */
function stringify(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/** A system-prompt nudge to emit JSON (carrying the schema when known). Mirror of `_json_instruction`. */
function jsonInstruction(schema: JsonSchema | null | undefined): string {
  return schema
    ? `\n\nRespond with ONLY a single JSON object matching this schema:\n${JSON.stringify(schema)}`
    : '\n\nRespond with only a single JSON object.';
}

// --------------------------------------------------------------------------- multimodal content
//
// The canonical multimodal content shape is OpenAI's content-parts list:
//   [{type:'text', text:'…'}, {type:'image_url', image_url:{url:'data:|https'}}]
// OpenAI/Azure/Foundry-Local/HF pass it through unchanged; the translators below map it onto
// Anthropic / Gemini blocks. (Bedrock keeps the text; image bytes are out of scope there for now.)

function partText(part: unknown): string | null {
  if (part && typeof part === 'object' && get(part, 'type') === 'text')
    return String(get(part, 'text') ?? '');
  return null;
}

function imageUrl(part: unknown): string | null {
  if (part && typeof part === 'object' && get(part, 'type') === 'image_url') {
    const u = get(part, 'image_url');
    if (u && typeof u === 'object') return (get(u, 'url') as string) ?? null;
    if (typeof u === 'string') return u;
  }
  return null;
}

/** `data:image/png;base64,XXXX` → `{ mediaType: 'image/png', data: 'XXXX' }` (best-effort). */
export function parseDataUrl(url: string): { mediaType: string; data: string } {
  const comma = url.indexOf(',');
  if (comma === -1) return { mediaType: 'image/png', data: '' };
  const header = url.slice(0, comma);
  const data = url.slice(comma + 1);
  const mediaType = header.slice('data:'.length).split(';')[0] || 'image/png';
  return { mediaType, data };
}

/** Join the text parts of a (possibly multimodal) content value; scalars pass through. */
export function textOfContent(content: unknown): string {
  if (Array.isArray(content)) {
    let out = '';
    for (const p of content) {
      const t = partText(p);
      if (t !== null) out += t;
    }
    return out;
  }
  return stringify(content);
}

/** Canonical content → Anthropic content (a string, or a list of text/image blocks). */
export function anthropicContent(content: unknown): string | unknown[] {
  if (!Array.isArray(content)) return stringify(content);
  const blocks: unknown[] = [];
  for (const p of content) {
    const text = partText(p);
    if (text !== null) {
      blocks.push({ type: 'text', text });
      continue;
    }
    const url = imageUrl(p);
    if (url?.startsWith('data:')) {
      const { mediaType, data } = parseDataUrl(url);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    } else if (url) {
      blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks.length > 0 ? blocks : '';
}

/** Canonical content → Gemini `parts` (text + inline_data/file_data for images). */
export function geminiParts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [{ text: stringify(content) }];
  const parts: unknown[] = [];
  for (const p of content) {
    const text = partText(p);
    if (text !== null) {
      parts.push({ text });
      continue;
    }
    const url = imageUrl(p);
    if (url?.startsWith('data:')) {
      const { mediaType, data } = parseDataUrl(url);
      parts.push({ inlineData: { mimeType: mediaType, data } });
    } else if (url) {
      parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts.length > 0 ? parts : [{ text: '' }];
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
  /** Azure keyless auth: a refreshing Entra-ID bearer-token provider, invoked per request. */
  azureADTokenProvider?: (() => Promise<string>) | null;
}

/** The provider contract each backend implements. */
export interface Provider {
  readonly name: string;
  readonly supportsStream: boolean;
  formatTools(tools: Tool[]): unknown;
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
  /** GLR-12: incremental reasoning/thinking text from a stream chunk, or `''` when the provider
   * doesn't stream thinking. Kept separate from {@link Provider.streamText} (the visible answer). */
  streamThinking(chunk: unknown): string;
  parseStream(chunks: unknown[]): ParsedResponse;
  client(opts: ClientOptions): unknown;
  createMethod(client: unknown): (kwargs: Record<string, unknown>) => Promise<unknown>;
}

abstract class BaseProvider implements Provider {
  abstract readonly name: string;
  readonly supportsStream: boolean = false;
  protected abstract readonly createPath: string[];
  /** The provider's standard key env var, named in the missing-key hint. `null` ⇒ no key concept
   * (Bedrock/Ollama/Gemini/Foundry Local) and the hint is never emitted. */
  protected readonly keyEnvVar: string | null = null;
  private readonly cache = new Map<string, unknown>();

  /** Env vars that count as "a real key is present" (overridden where a provider reads more). */
  protected credentialEnvVars(): string[] {
    return this.keyEnvVar ? [this.keyEnvVar] : [];
  }

  /** Whether client construction fell back to the keyless placeholder (⇒ hint a live 401). */
  protected usesPlaceholder(opts: ClientOptions): boolean {
    if (!this.keyEnvVar || opts.apiKey) return false;
    return !this.credentialEnvVars().some((v) => process.env[v]);
  }

  protected missingKeyMessage(): string {
    return `No API key was found for the '${this.name}' provider — set the ${this.keyEnvVar} environment variable (or pass apiKey / client to the Agent). Docs: https://cendor.ai/docs/sdk/providers#api-keys--credentials`;
  }

  abstract rawClient(opts: ClientOptions): unknown;
  abstract formatTools(tools: Tool[]): unknown;
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
  streamThinking(_chunk: unknown): string {
    return ''; // GLR-12: most providers don't stream thinking text — overridden where they do
  }
  parseStream(chunks: unknown[]): ParsedResponse {
    // Whole-response fallback: parse the single collected response.
    return this.parse(chunks[chunks.length - 1]);
  }

  client(opts: ClientOptions): unknown {
    if (opts.client) return instrument(opts.client);
    // A token-provider callback has no stable cache key, so build a fresh client each time.
    if (opts.azureADTokenProvider) return instrument(this.rawClient(opts));
    const key = `${this.name}:${opts.apiKey ?? ''}:${opts.baseUrl ?? ''}`;
    let c = this.cache.get(key);
    if (c === undefined) {
      c = instrument(this.rawClient(opts));
      this.cache.set(key, c);
      if (this.usesPlaceholder(opts) && c && typeof c === 'object')
        placeholderHints.set(c as object, this.missingKeyMessage());
    }
    return c;
  }

  createMethod(client: unknown): (kwargs: Record<string, unknown>) => Promise<unknown> {
    let owner: unknown = client;
    for (const p of this.createPath.slice(0, -1)) owner = get(owner, p);
    const attr = this.createPath[this.createPath.length - 1]!;
    const fn = get(owner, attr) as (kwargs: Record<string, unknown>) => Promise<unknown>;
    const call = (kwargs: Record<string, unknown>) => fn.call(owner, kwargs);
    // A placeholder-backed client turns a provider 401 into an actionable MissingAPIKeyError.
    const message =
      client && typeof client === 'object' ? placeholderHints.get(client as object) : undefined;
    if (message === undefined) return call;
    return async (kwargs) => {
      try {
        return await call(kwargs);
      } catch (err) {
        if (isAuthError(err)) throw new MissingAPIKeyError(message, { cause: err });
        throw err;
      }
    };
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

export class OpenAIChatProvider extends BaseProvider {
  readonly name: string = 'openai';
  override readonly supportsStream: boolean = true;
  protected override readonly keyEnvVar: string | null = 'OPENAI_API_KEY';
  protected readonly createPath: string[] = ['chat', 'completions', 'create'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('openai');
    const OpenAI = mod.OpenAI ?? mod.default ?? mod;
    return new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? 'cendor-sdk-placeholder-no-key',
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  formatTools(tools: Tool[]): unknown {
    return tools.length > 0 ? tools.map((t) => t.toOpenai()) : null;
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
    const formatted = this.formatTools(tools);
    if (formatted) kwargs.tools = formatted;
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
    const choice = first(get(response, 'choices'));
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

  override streamThinking(chunk: unknown): string {
    // GLR-12: OpenAI-compatible reasoning models (e.g. DeepSeek-R1 via the OpenAI SDK) stream
    // reasoning text on `delta.reasoning_content` — the streaming analog of the field core reads
    // from a whole response. Standard OpenAI chat completions carry none, so this stays ''.
    const choices = get(chunk, 'choices');
    if (!Array.isArray(choices)) return '';
    return choices.map((c) => (get(get(c, 'delta'), 'reasoning_content') as string) ?? '').join('');
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

export class OpenAIResponsesProvider extends BaseProvider {
  readonly name: string = 'openai_responses';
  protected override readonly keyEnvVar: string | null = 'OPENAI_API_KEY';
  protected readonly createPath: string[] = ['responses', 'create'];

  rawClient(opts: ClientOptions): unknown {
    return new OpenAIChatProvider().rawClient(opts);
  }

  formatTools(tools: Tool[]): unknown {
    return tools.length > 0 ? tools.map((t) => t.toOpenaiResponses()) : null;
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    let sys = instructions;
    if (opts.jsonMode) sys = `${sys}${jsonInstruction(opts.outputSchema)}`.trim();
    const kwargs: Record<string, unknown> = { model, input: messages };
    if (sys) kwargs.instructions = sys;
    const formatted = this.formatTools(tools);
    if (formatted) kwargs.tools = formatted;
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

/**
 * Translate canonical (OpenAI-shape) history to Anthropic message blocks. Assistant tool calls become
 * `tool_use` content blocks; tool results become `tool_result` blocks folded into a single following
 * user turn (consecutive tool results merge). User turns route through {@link anthropicContent} so
 * multimodal content-parts (text + images) map onto Anthropic text/image blocks.
 */
export function canonicalToAnthropic(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: unknown[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ role: 'user', content: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    const role = m.role;
    if (role === 'tool') {
      pending.push({
        type: 'tool_result',
        tool_use_id: (m.tool_call_id as string) ?? '',
        content: stringify(m.content),
      });
      continue;
    }
    flush();
    if (role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: stringify(m.content) });
      const tcs = m.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = get(tc, 'function');
          blocks.push({
            type: 'tool_use',
            id: (get(tc, 'id') as string) ?? '',
            name: (get(fn, 'name') as string) ?? '',
            input: loadsArgs(get(fn, 'arguments')),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' });
    } else {
      out.push({ role: 'user', content: anthropicContent(m.content) });
    }
  }
  flush();
  return out;
}

/**
 * Translate canonical (OpenAI-shape) history to Gemini `contents`. Assistant tool calls become
 * `function_call` parts; tool results become `function_response` parts folded into a following `user`
 * turn (Gemini has no dedicated tool role); the assistant role maps to `model`.
 */
export function canonicalToGemini(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: unknown[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ role: 'user', parts: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    const role = m.role;
    if (role === 'tool') {
      // camelCase `functionResponse` — the snake_case key is dropped by @google/genai.
      pending.push({
        functionResponse: {
          name: (m.name as string) ?? '',
          response: { result: stringify(m.content) },
        },
      });
      continue;
    }
    flush();
    if (role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: stringify(m.content) });
      const tcs = m.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = get(tc, 'function');
          const part: Record<string, unknown> = {
            functionCall: {
              name: (get(fn, 'name') as string) ?? '',
              args: loadsArgs(get(fn, 'arguments')),
            },
          };
          // Re-emit the Gemini 3.x thought signature as a sibling of functionCall (required to
          // replay a tool call — see ToolInvocation.thoughtSignature).
          const sig = get(tc, 'thought_signature');
          if (sig != null) part.thoughtSignature = sig;
          parts.push(part);
        }
      }
      out.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
    } else {
      out.push({ role: 'user', parts: geminiParts(m.content) });
    }
  }
  flush();
  return out;
}

/**
 * Translate canonical (OpenAI-shape) history to Bedrock Converse `messages`. Assistant tool calls
 * become `toolUse` blocks; tool results become `toolResult` blocks folded into a following `user` turn
 * (consecutive results merge). Multimodal user turns keep their text (image bytes out of scope here).
 */
export function canonicalToBedrock(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: unknown[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ role: 'user', content: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    const role = m.role;
    if (role === 'tool') {
      pending.push({
        toolResult: {
          toolUseId: (m.tool_call_id as string) ?? '',
          content: [{ text: stringify(m.content) }],
        },
      });
      continue;
    }
    flush();
    if (role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ text: stringify(m.content) });
      const tcs = m.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = get(tc, 'function');
          blocks.push({
            toolUse: {
              toolUseId: (get(tc, 'id') as string) ?? '',
              name: (get(fn, 'name') as string) ?? '',
              input: loadsArgs(get(fn, 'arguments')),
            },
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ text: '' }] });
    } else {
      out.push({ role: 'user', content: [{ text: textOfContent(m.content) }] });
    }
  }
  flush();
  return out;
}

export class AnthropicProvider extends BaseProvider {
  readonly name: string = 'anthropic';
  protected override readonly keyEnvVar: string | null = 'ANTHROPIC_API_KEY';
  protected readonly createPath: string[] = ['messages', 'create'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.Anthropic ?? mod.default ?? mod;
    return new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'cendor-sdk-placeholder-no-key',
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  formatTools(tools: Tool[]): unknown {
    return tools.length > 0 ? tools.map((t) => t.toAnthropic()) : null;
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    let sys = instructions;
    if (opts.jsonMode) sys = `${sys}${jsonInstruction(opts.outputSchema)}`.trim();
    const kwargs: Record<string, unknown> = {
      model,
      messages: canonicalToAnthropic(messages),
      max_tokens: opts.maxTokens ?? 1024,
    };
    if (sys) kwargs.system = sys;
    const formatted = this.formatTools(tools);
    if (formatted) kwargs.tools = formatted;
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

// --------------------------------------------------------------------------- Gemini

export class GeminiProvider extends BaseProvider {
  readonly name: string = 'google';
  // `@google/genai` uses camelCase: `client.models.generateContent(...)`.
  protected readonly createPath: string[] = ['models', 'generateContent'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('@google/genai');
    const GoogleGenAI = mod.GoogleGenAI ?? mod.default ?? mod;
    return new GoogleGenAI({ apiKey: opts.apiKey ?? process.env.GOOGLE_API_KEY });
  }

  formatTools(tools: Tool[]): unknown {
    // `@google/genai` is camelCase-only and drops unknown request keys silently, so the declarations
    // list key must be `functionDeclarations` (snake_case `function_declarations` is ignored → the
    // model never sees the tools). The SDK strips non-Gemini JSON-schema keys (e.g. additionalProperties)
    // client-side, so the schema itself needs no sanitizing here (unlike the Python google-genai path).
    return tools.length > 0 ? [{ functionDeclarations: tools.map((t) => t.toGemini()) }] : null;
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    const contents = canonicalToGemini(messages);
    // camelCase config keys — `@google/genai` ignores snake_case (`system_instruction`,
    // `max_output_tokens`, …), which silently dropped the system prompt, token cap and JSON mode.
    const config: Record<string, unknown> = {};
    if (instructions) config.systemInstruction = instructions;
    if (opts.temperature != null) config.temperature = opts.temperature;
    if (opts.maxTokens != null) config.maxOutputTokens = opts.maxTokens;
    const formatted = this.formatTools(tools);
    if (formatted) {
      config.tools = formatted;
    } else if (opts.jsonMode) {
      // Gemini can't combine function tools with a forced JSON schema.
      config.responseMimeType = 'application/json';
      if (opts.outputSchema) config.responseSchema = opts.outputSchema;
    }
    const kwargs: Record<string, unknown> = { model, contents };
    if (Object.keys(config).length > 0) kwargs.config = config;
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    const cand = first(get(response, 'candidates'));
    const parts = (get(get(cand, 'content'), 'parts') as unknown[]) ?? [];
    const textParts: string[] = [];
    const toolCalls: ToolInvocation[] = [];
    for (const p of parts) {
      const t = get(p, 'text');
      if (t) textParts.push(String(t));
      // @google/genai returns camelCase `functionCall`; keep the snake_case read as a fallback for
      // recorded/cassette fixtures shaped like the raw REST payload.
      const fc = get(p, 'functionCall') ?? get(p, 'function_call');
      if (fc) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: (get(fc, 'name') as string) ?? '',
          arguments: (get(fc, 'args') as Record<string, unknown>) ?? {},
          // Gemini 3.x returns a thoughtSignature sibling of functionCall that MUST be echoed back on
          // the replayed call, else the next turn 400s ("missing thought_signature").
          thoughtSignature: get(p, 'thoughtSignature') ?? get(p, 'thought_signature') ?? undefined,
        });
      }
    }
    let content = (get(response, 'text') as string) ?? null;
    if (content === null && textParts.length > 0) content = textParts.join('');
    return {
      content,
      toolCalls,
      finishReason: ((get(cand, 'finishReason') ?? get(cand, 'finish_reason')) as string) ?? null,
      raw: response,
    };
  }
}

// --------------------------------------------------------------------------- Bedrock

export class BedrockProvider extends BaseProvider {
  readonly name: string = 'bedrock';
  protected readonly createPath: string[] = ['converse'];

  rawClient(opts: ClientOptions): unknown {
    if (opts.apiKey) {
      throw new Error(
        'Bedrock does not take apiKey — it authenticates via the AWS credential chain ' +
          '(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, an AWS profile, or an IAM role) plus ' +
          'AWS_REGION. Set those in your environment, or hand Agent({ client }) a pre-built ' +
          'BedrockRuntimeClient. Docs: https://cendor.ai/docs/sdk/providers#api-keys--credentials',
      );
    }
    // aws-sdk-v3 drives Converse via `client.send(new ConverseCommand(input))`; wrap it in a
    // `converse(input)` method so the `createPath` seam (and core detection) has a stable surface.
    const mod = require('@aws-sdk/client-bedrock-runtime');
    const BedrockRuntimeClient = mod.BedrockRuntimeClient;
    const ConverseCommand = mod.ConverseCommand;
    const client = new BedrockRuntimeClient(opts.baseUrl ? { endpoint: opts.baseUrl } : {});
    return {
      converse: (input: Record<string, unknown>) => client.send(new ConverseCommand(input)),
    };
  }

  formatTools(tools: Tool[]): unknown {
    return tools.length > 0 ? { tools: tools.map((t) => t.toBedrock()) } : null;
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    const wire = canonicalToBedrock(messages);
    let systemText = instructions;
    if (opts.jsonMode) systemText = `${systemText}${jsonInstruction(opts.outputSchema)}`.trim();
    const kwargs: Record<string, unknown> = { modelId: model, messages: wire };
    if (systemText) kwargs.system = [{ text: systemText }];
    const formatted = this.formatTools(tools);
    if (formatted) kwargs.toolConfig = formatted;
    const inference: Record<string, unknown> = {};
    if (opts.temperature != null) inference.temperature = opts.temperature;
    if (opts.maxTokens != null) inference.maxTokens = opts.maxTokens;
    if (Object.keys(inference).length > 0) kwargs.inferenceConfig = inference;
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    const message = get(get(response, 'output'), 'message');
    const textParts: string[] = [];
    const toolCalls: ToolInvocation[] = [];
    const blocks = get(message, 'content');
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const t = get(b, 'text');
        if (t) textParts.push(String(t));
        const tu = get(b, 'toolUse');
        if (tu) {
          toolCalls.push({
            id: (get(tu, 'toolUseId') as string) ?? `call_${toolCalls.length}`,
            name: (get(tu, 'name') as string) ?? '',
            arguments: (get(tu, 'input') as Record<string, unknown>) ?? {},
          });
        }
      }
    }
    return {
      content: textParts.length > 0 ? textParts.join('') : null,
      toolCalls,
      finishReason: (get(response, 'stopReason') as string) ?? null,
      raw: response,
    };
  }
}

// --------------------------------------------------------------------------- Ollama

export class OllamaProvider extends BaseProvider {
  readonly name: string = 'ollama';
  override readonly supportsStream: boolean = true;
  protected readonly createPath: string[] = ['chat'];

  rawClient(opts: ClientOptions): unknown {
    const mod = require('ollama');
    const Ollama = mod.Ollama ?? mod.default ?? mod;
    return new Ollama(opts.baseUrl ? { host: opts.baseUrl } : {});
  }

  formatTools(tools: Tool[]): unknown {
    return tools.length > 0 ? tools.map((t) => t.toOpenai()) : null;
  }

  buildKwargs(
    model: string,
    messages: Message[],
    tools: Tool[],
    instructions: string,
    opts: BuildKwargsOptions,
  ): Record<string, unknown> {
    const wire: Message[] = [];
    if (instructions) wire.push({ role: 'system', content: instructions });
    // The canonical history stores tool-call `function.arguments` as a JSON *string* (OpenAI wire
    // shape). The ollama client requires an object there and 400s on a string ("Value looks like
    // object, but can't find closing '}' symbol"), which killed the tool loop on the replay turn.
    // Re-hydrate arguments to objects for the ollama wire.
    wire.push(...messages.map(ollamaMessage));
    const kwargs: Record<string, unknown> = { model, messages: wire };
    const formatted = this.formatTools(tools);
    if (formatted) kwargs.tools = formatted;
    // Ollama accepts a JSON schema (or "json") as the format constraint.
    if (opts.jsonMode) kwargs.format = opts.outputSchema ? opts.outputSchema : 'json';
    return kwargs;
  }

  parse(response: unknown): ParsedResponse {
    const message = get(response, 'message');
    const toolCalls: ToolInvocation[] = [];
    const tcs = get(message, 'tool_calls');
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const fn = get(tc, 'function');
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: (get(fn, 'name') as string) ?? '',
          arguments: loadsArgs(get(fn, 'arguments')),
        });
      }
    }
    const done = get(response, 'done');
    const finishReason = (get(response, 'done_reason') as string) ?? (done ? 'stop' : null);
    return {
      content: (get(message, 'content') as string) ?? null,
      toolCalls,
      finishReason,
      raw: response,
    };
  }

  override streamText(chunk: unknown): string {
    return String(get(get(chunk, 'message'), 'content') ?? '');
  }

  override streamThinking(chunk: unknown): string {
    // GLR-12: Ollama `think` models stream reasoning on `message.thinking`.
    return String(get(get(chunk, 'message'), 'thinking') ?? '');
  }

  override parseStream(chunks: unknown[]): ParsedResponse {
    const contentParts: string[] = [];
    const toolCalls: ToolInvocation[] = [];
    let finish: string | null = null;
    for (const ch of chunks) {
      const message = get(ch, 'message');
      const txt = get(message, 'content');
      if (txt) contentParts.push(String(txt));
      // Ollama tool calls arrive WHOLE on a chunk's message.tool_calls (usually the final one) —
      // not fragmented per-index like OpenAI, so we collect them directly.
      const tcs = get(message, 'tool_calls');
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const fn = get(tc, 'function');
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            name: (get(fn, 'name') as string) ?? '',
            arguments: loadsArgs(get(fn, 'arguments')),
          });
        }
      }
      if (get(ch, 'done_reason') || get(ch, 'done'))
        finish = (get(ch, 'done_reason') as string) ?? 'stop';
    }
    return {
      content: contentParts.length > 0 ? contentParts.join('') : null,
      toolCalls,
      finishReason: finish,
      raw: chunks,
    };
  }
}

// --------------------------------------------------------------------------- Hugging Face

/**
 * Hugging Face Inference (`@huggingface/inference`). `InferenceClient.chatCompletion` returns an
 * OpenAI-shaped result (choices / message / tool_calls / usage), so this reuses
 * {@link OpenAIChatProvider}'s request formatting and response parsing verbatim — only the client and
 * the create path differ. The `model` is a Hub model id or an Inference Endpoint URL; route through a
 * dedicated endpoint / provider with `baseUrl=` and the `HF_PROVIDER` env var.
 */
export class HuggingFaceProvider extends OpenAIChatProvider {
  override readonly name: string = 'huggingface';
  protected override readonly keyEnvVar: string | null = 'HF_TOKEN';
  protected override readonly createPath: string[] = ['chatCompletion'];

  protected override credentialEnvVars(): string[] {
    return ['HF_TOKEN', 'HUGGINGFACEHUB_API_TOKEN'];
  }

  override rawClient(opts: ClientOptions): unknown {
    const mod = require('@huggingface/inference');
    const InferenceClient = mod.InferenceClient ?? mod.HfInference ?? mod.default ?? mod;
    const token = opts.apiKey ?? process.env.HF_TOKEN ?? process.env.HUGGINGFACEHUB_API_TOKEN;
    const defaults: Record<string, unknown> = {};
    if (opts.baseUrl) defaults.endpointUrl = opts.baseUrl;
    const provider = process.env.HF_PROVIDER;
    if (provider) defaults.provider = provider;
    return new InferenceClient(token, defaults);
  }
}

// --------------------------------------------------------------------------- Azure AI Foundry

/** Resolve (and normalize) the Azure AI Foundry OpenAI-v1 `base_url`. */
export function azureFoundryBaseUrl(opts: { baseUrl?: string | null }): string | null {
  let raw =
    opts.baseUrl ||
    process.env.AZURE_OPENAI_BASE_URL ||
    process.env.AZURE_OPENAI_ENDPOINT ||
    process.env.AZURE_AI_ENDPOINT;
  if (!raw) return null;
  raw = raw.replace(/\/+$/, '');
  if (raw.includes('/openai/v1') || raw.endsWith('/models')) return `${raw}/`;
  if (
    raw.endsWith('.openai.azure.com') ||
    raw.endsWith('.services.ai.azure.com') ||
    raw.includes('.cognitiveservices.azure.com')
  )
    return `${raw}/openai/v1/`;
  return `${raw}/`;
}

/**
 * Azure AI Foundry via the OpenAI-compatible `/openai/v1/` endpoint — {@link OpenAIChatProvider} with
 * Foundry-aware client construction. `model` is your Foundry deployment name; `baseUrl` the Foundry
 * endpoint (also read from `AZURE_OPENAI_ENDPOINT`); `apiKey` the resource key. Detected by
 * `@cendor/core` as OpenAI (it *is* the `openai` SDK), so governance rides the same seams.
 */
export class AzureFoundryProvider extends OpenAIChatProvider {
  override readonly name: string = 'azure';
  protected override readonly keyEnvVar: string | null = 'AZURE_OPENAI_API_KEY';

  protected override credentialEnvVars(): string[] {
    return ['AZURE_OPENAI_API_KEY', 'AZURE_INFERENCE_CREDENTIAL', 'AZURE_AI_API_KEY'];
  }

  override rawClient(opts: ClientOptions): unknown {
    const mod = require('openai');
    const baseUrl = azureFoundryBaseUrl(opts);
    // Keyless Entra-ID: openai's AzureOpenAI client refreshes the bearer token per request.
    if (opts.azureADTokenProvider) {
      const AzureOpenAI = mod.AzureOpenAI;
      if (!AzureOpenAI) {
        throw new Error(
          'azureADTokenProvider needs the AzureOpenAI client from openai>=4.53 — upgrade the `openai` peer dependency.',
        );
      }
      const apiVersion =
        process.env.OPENAI_API_VERSION ?? process.env.AZURE_OPENAI_API_VERSION ?? 'preview';
      return new AzureOpenAI({
        azureADTokenProvider: opts.azureADTokenProvider,
        apiVersion,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
    }
    const OpenAI = mod.OpenAI ?? mod.default ?? mod;
    const apiKey =
      opts.apiKey ??
      process.env.AZURE_OPENAI_API_KEY ??
      process.env.AZURE_INFERENCE_CREDENTIAL ??
      process.env.AZURE_AI_API_KEY ??
      'azure-cendor-sdk-placeholder';
    return new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }
}

/** Azure AI Foundry via the OpenAI **Responses** API — same client construction, Responses surface. */
export class AzureFoundryResponsesProvider extends OpenAIResponsesProvider {
  override readonly name: string = 'azure_responses';
  protected override readonly keyEnvVar: string | null = 'AZURE_OPENAI_API_KEY';

  protected override credentialEnvVars(): string[] {
    return ['AZURE_OPENAI_API_KEY', 'AZURE_INFERENCE_CREDENTIAL', 'AZURE_AI_API_KEY'];
  }

  override rawClient(opts: ClientOptions): unknown {
    return new AzureFoundryProvider().rawClient(opts);
  }
}

// --------------------------------------------------------------------------- Foundry Local

/** Resolve (and normalize to `/v1/`) the Foundry Local OpenAI-compatible endpoint. */
export function foundryLocalBaseUrl(opts: { baseUrl?: string | null }): string | null {
  let raw = opts.baseUrl || process.env.FOUNDRY_LOCAL_ENDPOINT;
  if (!raw) return null;
  raw = raw.replace(/\/+$/, '');
  return raw.endsWith('/v1') ? `${raw}/` : `${raw}/v1/`;
}

/**
 * Microsoft **Foundry Local** — on-device models over the local OpenAI-compatible REST server. The
 * local counterpart to Ollama: {@link OpenAIChatProvider} pointed at the local URL. No key needed
 * (`apiKey` defaults to `"none"`). Supply the endpoint via `baseUrl=` or `FOUNDRY_LOCAL_ENDPOINT`.
 */
export class FoundryLocalProvider extends OpenAIChatProvider {
  override readonly name: string = 'foundry_local';
  protected override readonly keyEnvVar: string | null = null; // local, keyless — never hint

  override rawClient(opts: ClientOptions): unknown {
    const mod = require('openai');
    const OpenAI = mod.OpenAI ?? mod.default ?? mod;
    const baseUrl = foundryLocalBaseUrl(opts);
    if (!baseUrl) {
      throw new Error(
        'Foundry Local needs an endpoint: pass baseUrl=... on the Agent or set ' +
          'FOUNDRY_LOCAL_ENDPOINT (e.g. foundry_local.FoundryLocalManager(alias).endpoint). ' +
          'See docs/sdk.md → Connecting to Hugging Face & Azure AI Foundry.',
      );
    }
    const apiKey = opts.apiKey ?? process.env.FOUNDRY_LOCAL_API_KEY ?? 'none';
    return new OpenAI({ apiKey, baseURL: baseUrl });
  }
}

// --------------------------------------------------------------------------- registry

const REGISTRY = new Map<string, Provider>();
function reg(p: Provider, ...aliases: string[]): void {
  REGISTRY.set(p.name, p);
  for (const a of aliases) REGISTRY.set(a, p);
}
reg(new OpenAIChatProvider());
reg(new OpenAIResponsesProvider());
reg(new AnthropicProvider());
reg(new GeminiProvider(), 'gemini');
reg(new BedrockProvider());
reg(new OllamaProvider());
reg(new HuggingFaceProvider(), 'hf');
reg(new AzureFoundryProvider(), 'azure_openai', 'foundry');
reg(new AzureFoundryResponsesProvider(), 'foundry_responses');
reg(new FoundryLocalProvider(), 'foundry-local');

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
