/**
 * SDK domain telemetry — the TS port of `cendor.sdk._telemetry`. RAG / memory / orchestration /
 * checkpoints / tools / MCP signals, all **zero-core**:
 *
 * - **Run-scoped** signals ride `@cendor/core`'s type-agnostic bus as small event objects (the
 *   `ContextBudgetFallback` precedent); an active `liveSpans` subscriber turns each into a
 *   `cendor.sdk` child span correlated by `traceId`. Stock subscribers ignore unknown event types.
 * - **Setup-time** MCP lifecycle emits `cendor.sdk` spans directly via {@link mcpSpan}, a no-op
 *   without `@opentelemetry/api`.
 *
 * Content-free by design: only ids, labels, and counts — never message bodies (those follow the
 * existing content-capture opt-in). Emission is best-effort and never throws into a run.
 */
import { createRequire } from 'node:module';
import { bus } from '@cendor/core';

const require = createRequire(import.meta.url);

// --------------------------------------------------------------------------- run-scoped bus events
// Plain classes emitted on the core bus from run-path code; `liveSpans` renders each as a
// `cendor.sdk` child span. Unknown types are ignored by every other subscriber (bus-events spec).

/** A session load (run start) or save (write-back) → `memory.load` / `memory.save`. */
export class MemoryOp {
  constructor(
    readonly op: 'load' | 'save',
    readonly sessionId: string,
    readonly turns: number,
    readonly bytes: number,
    readonly traceId: string,
  ) {}
}

/** A checkpoint write or a resume decision → `checkpoint.save` / `checkpoint.resume`. */
export class CheckpointEvent {
  constructor(
    readonly op: 'save' | 'resume',
    readonly traceId: string,
    readonly done: boolean,
    readonly turns: number,
    readonly segment: number | null = null,
  ) {}
}

/** A multi-agent handoff (parent → child) → `orchestration.handoff`; the monitor reconstructs the
 * per-run agent DAG from these edges rather than parsing trace-id families. */
export class OrchestrationEdge {
  constructor(
    readonly fromAgent: string,
    readonly toAgent: string,
    readonly segment: number,
    readonly transferTool: string,
    readonly traceId: string,
  ) {}
}

/** A tool call the `tool_call` guardrail stage BLOCKED before execution — no `ToolCall` reaches the
 * bus (the tool never ran), so this is the only signal. Rendered as an `execute_tool {name}` span
 * with `cendor.tool.outcome="blocked"`. */
export class ToolGate {
  constructor(
    readonly name: string,
    readonly blockedBy: string, // the guardrail's name (never the reason text — may be sensitive)
    readonly traceId: string,
    readonly agent = '',
  ) {}
}

function emit(event: unknown): void {
  try {
    bus.emit(event as never);
  } catch {
    // telemetry never breaks a run
  }
}

/** Emit a `MemoryOp` for a session load/save (no-op when `session` is nullish). */
export function emitMemory(op: 'load' | 'save', session: unknown, traceId: string): void {
  if (!session) return;
  let messages: unknown[] = [];
  let sessionId = '';
  let bytes = 0;
  try {
    const s = session as { messages?: unknown[]; id?: unknown };
    messages = s.messages ?? [];
    sessionId = typeof s.id === 'string' ? s.id : '';
    bytes = JSON.stringify(messages).length;
  } catch {
    // best-effort inspection; fall back to zeros
  }
  emit(new MemoryOp(op, sessionId, messages.length, bytes, traceId || ''));
}

/** Emit a `CheckpointEvent` for a save/resume. */
export function emitCheckpoint(
  op: 'save' | 'resume',
  traceId: string,
  done: boolean,
  turns: number,
  segment: number | null = null,
): void {
  emit(new CheckpointEvent(op, traceId || '', Boolean(done), turns | 0, segment));
}

/** Emit an `OrchestrationEdge` for a parent → child agent handoff. */
export function emitHandoff(
  fromAgent: string,
  toAgent: string,
  segment: number,
  transferTool: string,
  traceId: string,
): void {
  emit(
    new OrchestrationEdge(
      fromAgent || '',
      toAgent || '',
      segment | 0,
      transferTool || '',
      traceId || '',
    ),
  );
}

/** Emit a `ToolGate` for a tool call blocked by a `tool_call` guardrail. */
export function emitToolBlocked(
  name: string,
  blockedBy: string,
  traceId: string,
  agent = '',
): void {
  emit(new ToolGate(name || 'tool', blockedBy || '', traceId || '', agent));
}

// --------------------------------------------------------------------------- tool source registry
// A tool span needs to know whether the tool is LOCAL or came from an MCP server — core's
// provider-agnostic `ToolCall` carries no such marker. Recorded SDK-side, keyed by tool name,
// populated when an MCP tool is wrapped. Unregistered names default to "local". Module-global (a
// dev-tool convenience); last-writer-wins on a name collision across servers (an honest limit).

export interface ToolSource {
  source: string;
  server?: string;
  transport?: string;
}

const toolSources = new Map<string, ToolSource>();

export function registerToolSource(
  name: string,
  source: string,
  server = '',
  transport = '',
): void {
  const info: ToolSource = { source };
  if (server) info.server = server;
  if (transport) info.transport = transport;
  toolSources.set(name, info);
}

export function toolSource(name: string): ToolSource | undefined {
  return toolSources.get(name);
}

/** @internal test-only: clear the registries between tests. */
export function _resetTelemetryRegistries(): void {
  toolSources.clear();
  mcpSeen.clear();
}

// --------------------------------------------------------------------------- setup-time MCP spans

interface OtelApi {
  trace: { getTracer(name: string): { startSpan(name: string): OtelSpan } };
}
interface OtelSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

function otelApi(): OtelApi | null {
  try {
    return require('@opentelemetry/api') as OtelApi;
  } catch {
    return null;
  }
}

const mcpSeen = new Set<string>();

/** Emit `mcp.connect` the first time the SDK lists a named server (the SDK doesn't own the
 * transport — this marks *SDK first contact*). No server name ⇒ no connect event (honest). */
export function mcpConnectOnce(server = '', transport = ''): void {
  if (!server || mcpSeen.has(server)) return;
  mcpSeen.add(server);
  mcpSpan('mcp.connect', { server, transport });
}

/** Emit a standalone `cendor.sdk` MCP-lifecycle span (`mcp.connect` / `mcp.list_tools`). Setup-time
 * server discovery happens before any run, so this is a top-level span. No-op without OTel. */
export function mcpSpan(
  kind: string,
  opts: { server?: string; transport?: string; toolCount?: number } = {},
): void {
  const api = otelApi();
  if (!api) return;
  const span = api.trace.getTracer('cendor.sdk').startSpan(kind);
  span.setAttribute('cendor.sdk.kind', kind);
  span.setAttribute('gen_ai.operation.name', kind);
  if (opts.server) span.setAttribute('cendor.mcp.server', opts.server);
  if (opts.transport) span.setAttribute('cendor.mcp.transport', opts.transport);
  if (opts.toolCount != null) span.setAttribute('cendor.mcp.tool_count', opts.toolCount | 0);
  span.end();
}
