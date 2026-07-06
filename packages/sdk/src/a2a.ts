/**
 * A2A — the TS port of `cendor.sdk.a2a`. Expose a governed agent over the Agent-to-Agent protocol: a
 * minimal, dependency-free implementation of A2A's JSON-RPC `message/send` plus the agent card.
 * `A2AServer.handle(request)` runs the agent and returns an A2A message result (with governance
 * metadata: trace id, cost); `A2AClient` calls a server **in-process** (no socket) for tests and
 * embedding. `serve()` is an optional local HTTP server (node:http only — local-first, never required).
 * Because TS `run(...)` is async, `handle` / `send` / `sendFull` are async.
 */
import { type Server, createServer } from 'node:http';
import type { AuditLog } from '@cendor/acttrace';
import type { Agent } from './agent.js';
import { run, uuidHex } from './runner.js';

/** The A2A agent card advertising an agent's identity and skills. */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string }[];
}

/** An A2A message result (the JSON-RPC `result` for `message/send`). */
export interface A2AMessage {
  messageId: string;
  role: string;
  parts: { kind: string; text: string }[];
  kind: string;
  metadata: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response — either `result` (success) or `error` (failure). */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: A2AMessage;
  error?: { code: number; message: string };
}

function textOfMessage(message: Record<string, unknown>): string {
  const parts = (message.parts as Record<string, unknown>[] | undefined) ?? [];
  const texts = parts.filter((p) => (p.kind ?? 'text') === 'text').map((p) => String(p.text ?? ''));
  return texts.filter(Boolean).join('\n');
}

function messageResult(text: string, metadata: Record<string, unknown>): A2AMessage {
  return {
    messageId: uuidHex(),
    role: 'agent',
    parts: [{ kind: 'text', text }],
    kind: 'message',
    metadata,
  };
}

function sendRequest(text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: uuidHex(),
    method: 'message/send',
    params: { message: { role: 'user', parts: [{ kind: 'text', text }] } },
  };
}

/** Serve one agent over A2A. In-process via {@link A2AServer.handle}; over HTTP via {@link serve}. */
export class A2AServer {
  readonly agent: Agent;
  readonly audit: AuditLog | null;

  constructor(agent: Agent, opts: { audit?: AuditLog | null } = {}) {
    this.agent = agent;
    this.audit = opts.audit ?? null;
  }

  agentCard(): AgentCard {
    return {
      name: this.agent.name,
      description: this.agent.instructions || `The ${this.agent.name} agent.`,
      version: '1.0.0',
      protocolVersion: '0.2',
      capabilities: { streaming: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: this.agent.toolset.map((t) => ({
        id: t.name,
        name: t.name,
        description: t.description,
      })),
    };
  }

  /** Dispatch a JSON-RPC A2A request. Supports `message/send`. */
  async handle(request: Record<string, unknown>): Promise<JsonRpcResponse> {
    const rpcId = request.id ?? null;
    const method = request.method;
    if (method !== 'message/send') {
      return {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      };
    }
    const params = (request.params as Record<string, unknown>) ?? {};
    const message = (params.message as Record<string, unknown>) ?? {};
    const text = textOfMessage(message);
    const result = await run(this.agent, text, { audit: this.audit });
    const metadata = {
      trace_id: result.traceId,
      cost_usd: result.cost.amount.toString(),
      agents: result.agents,
    };
    return { jsonrpc: '2.0', id: rpcId, result: messageResult(String(result.output), metadata) };
  }
}

/** Call an {@link A2AServer} in-process (no network) — the offline/embedded path. */
export class A2AClient {
  constructor(readonly server: A2AServer) {}

  card(): AgentCard {
    return this.server.agentCard();
  }

  /** Send a user message and return the agent's text reply. */
  async send(text: string): Promise<string> {
    const response = await this.server.handle(sendRequest(text));
    if (response.error) throw new Error(`A2A error: ${JSON.stringify(response.error)}`);
    const parts = response.result?.parts ?? [];
    return parts
      .filter((p) => p.kind === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
  }

  /** Send a message and return the full A2A message result (incl. governance metadata). */
  async sendFull(text: string): Promise<A2AMessage> {
    const response = await this.server.handle(sendRequest(text));
    if (response.error) throw new Error(`A2A error: ${JSON.stringify(response.error)}`);
    return response.result as A2AMessage;
  }
}

/**
 * Start a local A2A HTTP server (node:http). Optional, opt-in; returns the listening server. The agent
 * card is served at `GET /.well-known/agent-card.json` (or `/`); JSON-RPC at `POST /`. Stop it with
 * `.close()`.
 */
export function serve(
  agent: Agent,
  opts: { host?: string; port?: number; audit?: AuditLog | null } = {},
): Server {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const a2a = new A2AServer(agent, { audit: opts.audit ?? null });

  const server = createServer((req, res) => {
    const sendJson = (code: number, payload: unknown): void => {
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      });
      res.end(body);
    };
    const path = req.url ?? '/';
    if (req.method === 'GET') {
      if (path.replace(/\/+$/, '').endsWith('agent-card.json') || path === '/') {
        sendJson(200, a2a.agentCard());
      } else {
        sendJson(404, { error: 'not found' });
      }
    } else if (req.method === 'POST') {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        void (async () => {
          let request: Record<string, unknown>;
          try {
            request = JSON.parse(data || '{}') as Record<string, unknown>;
          } catch {
            request = {};
          }
          sendJson(200, await a2a.handle(request));
        })();
      });
    } else {
      sendJson(404, { error: 'not found' });
    }
  });
  server.listen(port, host);
  return server;
}
