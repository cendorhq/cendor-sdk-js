/**
 * MCP client — the TS port of `cendor.sdk.mcp`. Consume Model Context Protocol tools/prompts/resources
 * from a duck-typed *client session* (the shape of `@modelcontextprotocol/sdk`'s `Client`: camelCase
 * `listTools()` / `callTool(name, args)` and the optional `listPrompts` / `getPrompt` / `listResources`
 * / `readResource`). No runtime import of the MCP SDK — the session is caller-supplied, so `[mcp]` stays
 * an optional peer. Each MCP tool becomes a governed {@link Tool} (its schema comes from the server) so
 * it flows through the same loop, bus, audit, and budget as any other tool.
 *
 * ```ts
 * import { Client } from '@modelcontextprotocol/sdk/client/index.js';
 * const tools = await loadMcpTools(client);
 * const agent = new Agent({ name: 'a', model: 'gpt-4o', tools });
 * ```
 */
import { type JsonSchema, Tool } from './tools.js';
import type { Message } from './types.js';

/** Property access that tolerates null/undefined (mirror of Python's `providers._get`). */
const get = (o: unknown, k: string): unknown =>
  o == null ? undefined : (o as Record<string, unknown>)[k];

/**
 * A duck-typed MCP client session. Methods are camelCase to match the real `@modelcontextprotocol/sdk`
 * `Client`. Only `listTools` / `callTool` are required; the rest are optional (probed by `typeof`).
 */
export interface McpSession {
  listTools(): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listPrompts?(): Promise<unknown>;
  getPrompt?(name: string, args: Record<string, unknown>): Promise<unknown>;
  listResources?(): Promise<unknown>;
  readResource?(uri: string): Promise<unknown>;
}

/** Extract text from an MCP `CallToolResult` (`.content` is a list of content parts). */
function mcpResultText(result: unknown): string {
  const content = get(result, 'content');
  if (content == null) {
    const text = get(result, 'text');
    return text ? String(text) : String(result);
  }
  const items = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const item of items) {
    const text = get(item, 'text');
    if (text != null) parts.push(String(text));
    else if (typeof item === 'string') parts.push(item);
  }
  return parts.length > 0 ? parts.join('\n') : String(content);
}

/** Wrap one MCP tool spec as a governed async {@link Tool} (server schema used verbatim). */
function wrapMcpTool(session: McpSession, spec: unknown): Tool {
  const name = (get(spec, 'name') as string) || 'tool';
  const description = (get(spec, 'description') as string) || '';
  const schema = (get(spec, 'inputSchema') ??
    get(spec, 'input_schema') ?? { type: 'object', properties: {} }) as JsonSchema;

  const call = async (args: Record<string, unknown>): Promise<string> => {
    const result = await session.callTool(name, args);
    return mcpResultText(result);
  };

  // `jsonSchema:` bypasses the zod path so the server's schema is used as-is; `isAsync` auto-derives.
  return new Tool(call, { name, description, jsonSchema: schema });
}

/** List an MCP session's tools and return them as governed {@link Tool}s. */
export async function loadMcpTools(session: McpSession): Promise<Tool[]> {
  const listing = await session.listTools();
  let specs = get(listing, 'tools');
  if (specs == null) specs = Array.isArray(listing) ? listing : [];
  return (specs as unknown[]).map((spec) => wrapMcpTool(session, spec));
}

/** List an MCP session's prompt templates as `{name: {description, arguments}}` (empty if none). */
export async function loadMcpPrompts(
  session: McpSession,
): Promise<Record<string, { description: string; arguments: unknown[] }>> {
  if (typeof session.listPrompts !== 'function') return {};
  const listing = await session.listPrompts();
  const prompts = (get(listing, 'prompts') ?? (Array.isArray(listing) ? listing : [])) as unknown[];
  const out: Record<string, { description: string; arguments: unknown[] }> = {};
  for (const p of prompts) {
    const name = get(p, 'name');
    if (name == null) continue;
    out[String(name)] = {
      description: (get(p, 'description') as string) || '',
      arguments: (get(p, 'arguments') as unknown[]) || [],
    };
  }
  return out;
}

/**
 * Render an MCP prompt to canonical (OpenAI-shape) `{role, content}` messages you can pass straight to
 * `run`. Roles other than `assistant` become `user`. Returns `[]` if the server has no `getPrompt`.
 */
export async function getMcpPrompt(
  session: McpSession,
  name: string,
  args?: Record<string, unknown>,
): Promise<Message[]> {
  if (typeof session.getPrompt !== 'function') return [];
  const result = await session.getPrompt(name, args ?? {});
  const out: Message[] = [];
  for (const m of (get(result, 'messages') ?? []) as unknown[]) {
    const role = get(m, 'role') ?? 'user';
    out.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: mcpResultText(get(m, 'content')),
    });
  }
  return out;
}

/** Read an MCP session's resources into `{uri: contents}` (best-effort; empty if absent). */
export async function loadMcpResources(session: McpSession): Promise<Record<string, string>> {
  if (typeof session.listResources !== 'function') return {};
  const listing = await session.listResources();
  const resources = (get(listing, 'resources') ??
    (Array.isArray(listing) ? listing : [])) as unknown[];
  const out: Record<string, string> = {};
  for (const res of resources) {
    const uri = get(res, 'uri');
    if (uri == null || typeof session.readResource !== 'function') continue;
    try {
      const contents = await session.readResource(String(uri));
      out[String(uri)] = mcpResultText(contents);
    } catch {
      // a single unreadable resource must not abort the batch
    }
  }
  return out;
}
