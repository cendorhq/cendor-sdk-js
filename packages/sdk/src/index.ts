/**
 * `@cendor/sdk` — a governed agent in ~10 lines. The TS port of `cendor.sdk`. Hard-depends only on
 * `@cendor/core`; governance rides its bus/interceptor seams and the re-exported `@cendor/*` objects
 * are the real libraries. Imports stay flat (`import { Agent, run, tool } from '@cendor/sdk'`).
 */
export { Agent } from './agent.js';
export type { AgentOptions, HandoffTarget } from './agent.js';
export { Tool, tool, asTool } from './tools.js';
export type { ToolFn, ToolOptions, JsonSchema } from './tools.js';

export { run, Runner, uuidHex } from './runner.js';
export type { RunOptions } from './runner.js';

export {
  Result,
  Run,
  Step,
  TextDelta,
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
  guard,
  registerModelPrice,
  BudgetExceeded,
  Policy,
  AuditLog,
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
  // V04: curated injection starter + the policy JSON Schema (rules.intent / rules.customCategory
  // ride the `rules` namespace above; judge.intentPrompt via @cendor/guardrails' `judge`).
  presets,
  policySchema,
} from './governance.js';
export type { Guardrail, Context, Check, Stage, Action } from './governance.js';

export {
  resolveProvider,
  inferProvider,
  getProvider,
  resetProviderCache,
  assistantMessage,
  toolResultMessage,
} from './providers.js';
export type { Provider } from './providers.js';

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
