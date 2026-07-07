/**
 * `Agent` — the config object for a governed agent. The TS port of `cendor.sdk.agent.Agent`
 * (camelCase fields). Holds no state; the runner drives it.
 */
import { type Provider, resolveProvider } from './providers.js';
import { type Tool, type ToolFn, asTool } from './tools.js';

/** A declared handoff target (peer name / Agent / {target}). */
export type HandoffTarget = string | Agent | { target: string };

export interface AgentOptions {
  name: string;
  model: string;
  instructions?: string;
  tools?: (Tool | ToolFn)[];
  provider?: string | null;
  /** A zod schema OR a raw JSON-schema object; enables structured output. */
  outputType?: unknown;
  maxTurns?: number;
  contextBudget?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  /** v1.1: opt into provider prompt caching (Anthropic `cache_control`). */
  cache?: boolean;
  extra?: Record<string, unknown>;
  /** Always-on RAG: `(query) => chunks`. */
  retriever?: ((query: string) => string[] | Promise<string[]>) | null;
  handoffs?: HandoffTarget[];
  /** Per-agent USD spend cap (orchestrator-enforced). */
  maxUsd?: number | null;
  apiKey?: string | null;
  baseURL?: string | null;
  /** A pre-built provider SDK client (instrumented on adoption). */
  client?: unknown;
  /** Azure keyless auth: a refreshing Entra-ID bearer-token provider, invoked per request. */
  azureADTokenProvider?: (() => Promise<string>) | null;
}

export class Agent {
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: Tool[];
  readonly provider: string | null;
  readonly outputType: unknown;
  readonly maxTurns: number;
  readonly contextBudget: number | null;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly cache: boolean;
  readonly extra: Record<string, unknown>;
  readonly retriever: ((query: string) => string[] | Promise<string[]>) | null;
  readonly handoffs: HandoffTarget[];
  readonly maxUsd: number | null;
  readonly apiKey: string | null;
  readonly baseURL: string | null;
  readonly client: unknown;
  readonly azureADTokenProvider: (() => Promise<string>) | null;
  private readonly toolMap: Map<string, Tool>;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.instructions = opts.instructions ?? '';
    this.tools = (opts.tools ?? []).map(asTool);
    this.provider = opts.provider ?? null;
    this.outputType = opts.outputType ?? null;
    this.maxTurns = opts.maxTurns ?? 8;
    this.contextBudget = opts.contextBudget ?? null;
    this.temperature = opts.temperature ?? null;
    this.maxTokens = opts.maxTokens ?? null;
    this.cache = opts.cache ?? false;
    this.extra = opts.extra ?? {};
    this.retriever = opts.retriever ?? null;
    this.handoffs = opts.handoffs ?? [];
    this.maxUsd = opts.maxUsd ?? null;
    this.apiKey = opts.apiKey ?? null;
    this.baseURL = opts.baseURL ?? null;
    this.client = opts.client ?? null;
    this.azureADTokenProvider = opts.azureADTokenProvider ?? null;
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  get providerImpl(): Provider {
    return resolveProvider(this.model, this.provider);
  }
  get toolset(): Tool[] {
    return this.tools;
  }
  getTool(name: string): Tool | null {
    return this.toolMap.get(name) ?? null;
  }
  clientConfig(): {
    apiKey: string | null;
    baseUrl: string | null;
    client: unknown;
    azureADTokenProvider: (() => Promise<string>) | null;
  } {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseURL,
      client: this.client,
      azureADTokenProvider: this.azureADTokenProvider,
    };
  }
  addTool(t: Tool | ToolFn): void {
    const tool = asTool(t);
    this.tools.push(tool);
    this.toolMap.set(tool.name, tool);
  }
}
