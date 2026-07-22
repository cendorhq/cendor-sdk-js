/**
 * `@cendor/sdk` — a governed agent in ~10 lines. The TS port of `cendor.sdk`. Governance rides
 * `@cendor/core`'s bus/interceptor seams. The governance re-exports are the real `@cendor/*`
 * objects; `guard` is acttrace's enforcement in the SDK's scope form, `rules` is the SDK's
 * superset module, and the eval harness + session stores are SDK-owned. Imports stay flat
 * (`import { Agent, run, tool } from '@cendor/sdk'`).
 */
export { Agent } from './agent.js';
export type { AgentOptions, HandoffTarget } from './agent.js';
export { Tool, tool, asTool } from './tools.js';
export type { ToolFn, ToolOptions, JsonSchema } from './tools.js';

export { run, Runner, uuidHex, ContextBudgetFallback } from './runner.js';
export type { RunOptions } from './runner.js';

export {
  Result,
  Run,
  Step,
  TextDelta,
  ThinkingDelta,
  ToolCallEvent,
  ToolResultEvent,
  RunComplete,
  LLMCall,
  ToolCall,
  Money,
  sumMoney,
} from './types.js';
export type { Message, ParsedResponse, ToolInvocation, StreamEvent, Usage } from './types.js';

export {
  handoff,
  Handoff,
  sequential,
  parallel,
  parallelAsync,
  supervisor,
  runAgents,
  runAgentsAsync,
  streamAgents,
} from './orchestration.js';

export {
  Session,
  SummarizingSession,
  llmSummarizer,
  MemorySessionStore,
  SqliteSessionStore,
  // Deprecated alias for Python's `SQLiteSessionStore` casing (canonical: `SqliteSessionStore`).
  SQLiteSessionStore,
} from './memory.js';
export type { SessionStore, Summarizer } from './memory.js';

export { RetryPolicy, callWithRetry, defaultIsTransient } from './resilience.js';
export type { RetryPolicyOptions } from './resilience.js';

export {
  budget,
  withBudget,
  track,
  report,
  configure,
  // what a pre-flight on_exceed="downgrade" / token clamp rerouted (0.10.0)
  downgrades,
  clamps,
  // the IDENTICAL @cendor/acttrace guard (dual-shape since acttrace 0.6.0: raw interceptor or
  // `guard(opts, fn)` scope form) — Object.is(sdk.guard, acttrace.guard)
  guard,
  registerModelPrice,
  BudgetExceeded,
  BudgetEvent,
  Policy,
  AuditLog,
  OTelMirror,
  verify,
  PolicyViolation,
  trace,
  currentTraceId,
  // guardrails gate (the real @cendor/guardrails objects)
  defineGuardrail,
  GuardrailTripped,
  Verdict,
  GuardrailDecision,
  rules,
  // V04: curated injection starter + the policy JSON Schema + loadPolicy (config-as-data, 0.10.0).
  loadPolicy,
  presets,
  policySchema,
  // BYO LLM-judge helpers — one-import parity with Python's `cendor.sdk.judge` /
  // `cendor.sdk.task_adherence` (governance.ts defined these but index never forwarded them).
  judge,
  taskAdherence,
} from './governance.js';
export type { Guardrail, Context, Check, Stage, Action, GuardOptions } from './governance.js';

export {
  resolveProvider,
  inferProvider,
  getProvider,
  resetProviderCache,
  assistantMessage,
  toolResultMessage,
} from './providers.js';
export type { Provider } from './providers.js';
export { MissingAPIKeyError } from './errors.js';

// Retrieval & embeddings
export { embed, aembed, VectorIndex, Hit, formatContext } from './rag.js';
export type { Embedder } from './rag.js';

// Eval
export { evaluate, EvalResult, EvalReport } from './eval.js';
export type { EvalCase, Judge } from './eval.js';

// Human-in-the-loop
export { requireApproval, alwaysApprove, alwaysReject } from './hitl.js';
export type { Approver } from './hitl.js';

// OpenTelemetry (no-op without @opentelemetry/api)
export { spanTree, liveSpans } from './otel.js';

// Checkpoint / resume durability
export { Checkpointer, asCheckpointer } from './checkpoint.js';
export type { CheckpointState } from './checkpoint.js';

// MCP client (tools / prompts / resources)
export { loadMcpTools, loadMcpPrompts, getMcpPrompt, loadMcpResources } from './mcp.js';
export type { McpSession } from './mcp.js';

// A2A (Agent-to-Agent protocol)
export { A2AServer, A2AClient, serve } from './a2a.js';
export type { AgentCard, A2AMessage, JsonRpcResponse } from './a2a.js';

// Foundry / Bot Framework adapter
export { FoundryAdapter } from './foundry.js';
export type { Activity, FoundryManifest } from './foundry.js';
