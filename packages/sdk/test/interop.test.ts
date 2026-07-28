/**
 * Ecosystem & interop — the TS port of `test_interop.py` (MCP, A2A, Foundry) + `test_mcp_prompts.py`.
 * All offline: the MCP session is a duck-typed fake, A2A/Foundry run in-process via stub clients.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  A2AClient,
  A2AServer,
  Agent,
  FoundryAdapter,
  type ToolCall,
  getMcpPrompt,
  loadMcpPrompts,
  loadMcpResources,
  loadMcpTools,
  run,
  tool,
} from '../src/index.js';
import type { McpSession } from '../src/index.js';
import { isolate, openaiChat, stubOpenAI } from './_helpers.js';

isolate();

const getWeather = tool((args: { city: string }) => `Sunny in ${args.city}`, {
  name: 'get_weather',
  description: 'Current weather for a city.',
  parameters: z.object({ city: z.string() }),
});

// --------------------------------------------------------------------------- MCP

/** A duck-typed stand-in for an MCP client session. */
class FakeMcpSession implements McpSession {
  calls: [string, Record<string, unknown>][] = [];
  async listTools(): Promise<unknown> {
    return {
      tools: [
        {
          name: 'search_kb',
          description: 'Search the knowledge base.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    };
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push([name, args]);
    return { content: [{ type: 'text', text: `KB result for ${args.query}` }] };
  }
}

describe('@cendor/sdk — MCP client', () => {
  it('wraps MCP tools and runs them through the agent loop', async () => {
    const session = new FakeMcpSession();
    const tools = await loadMcpTools(session);
    expect(tools[0]!.name).toBe('search_kb');
    expect((tools[0]!.parameters as { required: string[] }).required).toEqual(['query']);

    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      tools,
      instructions: 'Use tools.',
      client: stubOpenAI([
        openaiChat({ toolCalls: [{ name: 'search_kb', args: { query: 'refunds' } }] }),
        openaiChat({ content: 'Refunds take 5 days.' }),
      ]),
    });
    const result = await run(agent, 'How do refunds work?');

    expect(result.output).toBe('Refunds take 5 days.');
    expect(session.calls).toEqual([['search_kb', { query: 'refunds' }]]);
    expect(result.toolSteps.map((s) => s.name)).toEqual(['search_kb']);
    expect((result.toolSteps[0]!.call as ToolCall).result).toBe('KB result for refunds');
  });

  it('lists MCP prompts and renders one to canonical messages', async () => {
    const session: McpSession = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {};
      },
      async listPrompts() {
        return { prompts: [{ name: 'greet', description: 'Greet someone', arguments: [] }] };
      },
      async getPrompt(_name, args) {
        const who = (args.who as string) ?? '';
        return { messages: [{ role: 'user', content: { type: 'text', text: `Hi ${who}` } }] };
      },
    };
    const prompts = await loadMcpPrompts(session);
    expect(prompts.greet).toBeDefined();
    expect(prompts.greet!.description).toBe('Greet someone');

    const messages = await getMcpPrompt(session, 'greet', { who: 'Al' });
    expect(messages[0]!.role).toBe('user');
    expect(String(messages[0]!.content)).toContain('Hi Al');
  });

  it('loads MCP resources best-effort (a bad resource does not abort the batch)', async () => {
    const session: McpSession = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {};
      },
      async listResources() {
        return { resources: [{ uri: 'file://a.txt' }, { uri: 'file://bad' }] };
      },
      async readResource(uri) {
        if (uri === 'file://bad') throw new Error('unreadable');
        return { content: [{ type: 'text', text: 'hello' }] };
      },
    };
    const resources = await loadMcpResources(session);
    expect(resources).toEqual({ 'file://a.txt': 'hello' });
  });

  it('extracts a resource body from the MCP `contents[]` read shape', async () => {
    // A resource *read* result is `{contents: [...]}` (MCP `ReadResourceResult`), NOT the
    // `{content: [...]}` of a tool-call result. Feeding it to the tool-result extractor fell all the
    // way through to `String(result)`, so every resource collapsed to "[object Object]".
    const session: McpSession = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {};
      },
      async listResources() {
        return {
          resources: [
            { uri: 'file://a.txt' },
            { uri: 'file://multi.txt' },
            { uri: 'file://logo.png' },
            { uri: 'file://empty' },
          ],
        };
      },
      async readResource(uri) {
        if (uri === 'file://a.txt')
          return { contents: [{ uri, mimeType: 'text/plain', text: 'hello from the resource' }] };
        if (uri === 'file://multi.txt')
          return {
            contents: [
              { uri, text: 'part one' },
              { uri, text: 'part two' },
            ],
          };
        if (uri === 'file://logo.png')
          return { contents: [{ uri, mimeType: 'image/png', blob: 'QUJD' }] };
        return { contents: [] };
      },
    };
    const resources = await loadMcpResources(session);
    expect(resources['file://a.txt']).toBe('hello from the resource');
    expect(resources['file://multi.txt']).toBe('part one\npart two'); // every entry, joined
    expect(resources['file://logo.png']).toBe(''); // a blob has no text — never base64 in a prompt
    expect(resources['file://empty']).toBe('');
    expect(JSON.stringify(resources)).not.toContain('[object Object]');
  });
});

// --------------------------------------------------------------------------- A2A

describe('@cendor/sdk — A2A', () => {
  it('serves and calls an agent in-process', async () => {
    const agent = new Agent({
      name: 'greeter',
      model: 'gpt-4o',
      tools: [getWeather],
      instructions: 'Greet.',
      client: stubOpenAI([openaiChat({ content: 'Hello from the agent.' })]),
    });
    const client = new A2AClient(new A2AServer(agent));

    const card = client.card();
    expect(card.name).toBe('greeter');
    expect(card.skills.some((s) => s.name === 'get_weather')).toBe(true);

    const reply = await client.send('hi');
    expect(reply).toBe('Hello from the agent.');

    const full = await client.sendFull('hi');
    expect(full.role).toBe('agent');
    expect(full.metadata.trace_id).toBeTruthy();
    expect(Number(full.metadata.cost_usd)).toBeGreaterThanOrEqual(0);
  });

  it('returns a JSON-RPC error for an unknown method', async () => {
    const agent = new Agent({
      name: 'a',
      model: 'gpt-4o',
      client: stubOpenAI([openaiChat({ content: 'x' })]),
    });
    const response = await new A2AServer(agent).handle({ jsonrpc: '2.0', id: 1, method: 'bogus' });
    expect(response.error?.code).toBe(-32601);
    expect(response.result).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- Foundry

describe('@cendor/sdk — Foundry adapter', () => {
  it('adapts a message activity and acks non-message activities with null', async () => {
    const agent = new Agent({
      name: 'assistant',
      model: 'gpt-4o',
      instructions: 'Help.',
      client: stubOpenAI([openaiChat({ content: 'Sure, I can help.' })]),
    });
    const adapter = new FoundryAdapter(agent);
    expect(adapter.manifest().type).toBe('custom-engine');

    const reply = await adapter.onActivity({
      type: 'message',
      text: 'help me',
      id: 'a1',
      from: { id: 'user' },
      conversation: { id: 'c1' },
    });
    expect(reply).not.toBeNull();
    expect(reply!.type).toBe('message');
    expect(reply!.text).toBe('Sure, I can help.');
    const channelData = reply!.channelData as { cendor: { trace_id: string } };
    expect(channelData.cendor.trace_id).toBeTruthy();

    // a non-message activity is acked with null
    expect(await adapter.onActivity({ type: 'conversationUpdate' })).toBeNull();
  });
});
