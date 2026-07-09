/**
 * Shared SDK types — the TS port of `cendor.sdk`'s result/provider vocabulary. Core value types
 * (`Usage`, `Money`, `LLMCall`, `ToolCall`) are re-exported from `@cendor/core`; the SDK adds the
 * normalized provider view (`ParsedResponse`, `ToolInvocation`), the run result model (`Step`,
 * `Result`/`Run`), and the streaming events.
 */
import { LLMCall, Money, ToolCall, type Usage, sumMoney } from '@cendor/core';
import type { GuardrailDecision } from '@cendor/guardrails';

export { LLMCall, Money, ToolCall, sumMoney };
export type { Usage };

/** A canonical (OpenAI Chat-shape) conversation message. The one shape carried across providers. */
export type Message = Record<string, unknown>;

/** A parsed tool call from a provider response (arguments already decoded to an object). */
export interface ToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The SDK-normalized view of a provider response. */
export interface ParsedResponse {
  content: string | null;
  toolCalls: ToolInvocation[];
  finishReason: string | null;
  raw?: unknown;
}

/** One step of a run — a model call or a tool call. */
export class Step {
  constructor(
    readonly agent: string,
    readonly kind: 'llm' | 'tool',
    readonly call: LLMCall | ToolCall,
  ) {}
  /** Model id (llm) or tool name (tool). */
  get name(): string {
    return this.call instanceof LLMCall ? this.call.model : (this.call as ToolCall).name;
  }
  get traceId(): string {
    return this.call.traceId;
  }
  get usage(): Usage | null {
    return this.call instanceof LLMCall ? this.call.usage : null;
  }
  get cost(): Money | null {
    return this.call instanceof LLMCall ? this.call.cost : null;
  }
}

export interface ResultInit {
  output: unknown;
  steps?: Step[];
  traceId?: string;
  agents?: string[];
  messages?: Message[];
  incomplete?: boolean;
  guardrailDecisions?: GuardrailDecision[];
}

/** The outcome of a run — final output plus the governed step trail. `Run` is an alias. */
export class Result {
  output: unknown;
  steps: Step[];
  traceId: string;
  agents: string[];
  messages: Message[];
  incomplete: boolean;
  /**
   * Every guardrail trip/flag recorded during the run (redact/flag on the four stages, and any
   * `tool_call`/`tool_output` block that returned a `"[blocked …]"` result to the model), in order —
   * for post-hoc inspection without re-reading the audit file. A run that ended in a fail-closed
   * `block` threw `GuardrailTripped` instead of returning a `Result`; read that exception's
   * `.decisions` for the blocking decision.
   */
  guardrailDecisions: GuardrailDecision[];

  constructor(init: ResultInit) {
    this.output = init.output;
    this.steps = init.steps ?? [];
    this.traceId = init.traceId ?? '';
    this.agents = init.agents ?? [];
    this.messages = init.messages ?? [];
    this.incomplete = init.incomplete ?? false;
    this.guardrailDecisions = init.guardrailDecisions ?? [];
  }

  get llmSteps(): Step[] {
    return this.steps.filter((s) => s.kind === 'llm');
  }
  get toolSteps(): Step[] {
    return this.steps.filter((s) => s.kind === 'tool');
  }
  get finalMessage(): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === 'assistant') return m;
    }
    return null;
  }
  /** Aggregate token usage over LLM steps (subset conventions preserved). */
  get usage(): {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    cacheWrite: number;
    totalTokens: number;
  } {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let reasoningTokens = 0;
    let cacheWrite = 0;
    for (const s of this.llmSteps) {
      const u = s.usage;
      if (!u) continue;
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      cachedTokens += u.cachedTokens;
      reasoningTokens += u.reasoningTokens;
      cacheWrite += u.cacheWrite;
    }
    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      cacheWrite,
      totalTokens: inputTokens + outputTokens,
    };
  }
  /** Aggregate cost over priced LLM steps (unpriced contribute nothing). */
  get cost(): Money {
    return sumMoney(this.llmSteps.map((s) => s.cost).filter((c): c is Money => c !== null));
  }
}

/** `Run` is an alias of `Result` (both names are exported for parity). */
export const Run = Result;
export type Run = Result;

// --------------------------------------------------------------------------- streaming events

export class TextDelta {
  readonly type = 'text_delta' as const;
  constructor(readonly text: string) {}
}
export class ToolCallEvent {
  readonly type = 'tool_call' as const;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly id: string;
  constructor(name: string, args: Record<string, unknown>, id: string) {
    this.name = name;
    this.arguments = args;
    this.id = id;
  }
}
export class ToolResultEvent {
  readonly type = 'tool_result' as const;
  constructor(
    readonly name: string,
    readonly result: string,
  ) {}
}
export class RunComplete {
  readonly type = 'run_complete' as const;
  constructor(readonly result: Result) {}
}
export type StreamEvent = TextDelta | ToolCallEvent | ToolResultEvent | RunComplete;
