/**
 * Shared SDK types — the TS port of `cendor.sdk`'s result/provider vocabulary. Core value types
 * (`Usage`, `Money`, `LLMCall`, `ToolCall`) are re-exported from `@cendor/core`; the SDK adds the
 * normalized provider view (`ParsedResponse`, `ToolInvocation`), the run result model (`Step`,
 * `Result`/`Run`), and the streaming events.
 */
import { LLMCall, Money, ToolCall, type Usage, sumMoney, sumUsage } from '@cendor/core';
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
  /** Provider-opaque token (Gemini 3.x) echoed back on the replayed call; absent for other providers. */
  thoughtSignature?: unknown;
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

/**
 * The marker the loop puts in front of a failed tool's result before handing it to the model.
 * The string the MODEL sees is a deliberate contract (it is how the model learns to recover) and is
 * never changed — this constant just gives the one place that defines it a name.
 */
export const TOOL_ERROR_PREFIX = '[error] ';

/**
 * Whether a tool result is the loop's own failure marker.
 *
 * The single definition of "this tool failed", shared by {@link Result.toolErrors} and the
 * `cendor.tool.outcome` span attribute (`otel.toolOutcome`) so the two can never disagree.
 *
 * Honest limit: a tool whose *own* output begins with `"[error] "` is indistinguishable from a
 * failure. That is not new — the span attribute has classified on this prefix since it shipped — and
 * it is why the marker is a constant here rather than a literal in two files.
 *
 * @example
 * ```ts
 * import { isToolError } from '@cendor/sdk';
 * const toolResult: unknown = '[error] TypeError: boom';
 * if (isToolError(toolResult)) console.warn('that tool raised');
 * ```
 */
export function isToolError(result: unknown): boolean {
  return typeof result === 'string' && result.startsWith(TOOL_ERROR_PREFIX);
}

/**
 * One tool execution that raised, in structured form.
 *
 * `run()` keeps the loop alive when a tool throws: the error becomes a `"[error] <Name>: <message>"`
 * string, the model is shown it, and the conversation continues. That is the right behaviour — but it
 * left the *caller* with nothing to branch on except string matching. This is that failure, typed.
 *
 * @example
 * ```ts
 * import { run } from '@cendor/sdk';
 * const result = await run(agent, 'refund order 42');
 * if (result.toolFailed) for (const e of result.toolErrors) console.warn(e.tool, e.type, e.message);
 * ```
 */
export interface ToolError {
  /** The tool that threw — or the name the model asked for, when no such tool exists. */
  tool: string;
  /**
   * The error's constructor name (`"TypeError"`), or `"UnknownTool"` when the model named a tool the
   * agent does not have. Empty only when the message carried no recognizable `Name: message` split.
   */
  type: string;
  /** The error message, exactly as the model was shown it. */
  message: string;
  /** The provider's id for the call this failure answers, for correlation. Empty if omitted. */
  toolCallId: string;
}

const UNKNOWN_TOOL_MARKER = 'unknown tool: ';

/**
 * Split the loop's own marker string back into its parts. Safe because this parses a string *this
 * package wrote* (`runner.errString`), not provider text.
 */
function parseToolError(content: string, tool: string, toolCallId: string): ToolError {
  const body = content.slice(TOOL_ERROR_PREFIX.length);
  if (body.startsWith(UNKNOWN_TOOL_MARKER)) {
    return {
      tool: body.slice(UNKNOWN_TOOL_MARKER.length).trim() || tool,
      type: 'UnknownTool',
      message: body,
      toolCallId,
    };
  }
  const at = body.indexOf(': ');
  // No separator — keep the whole body as the message rather than inventing a type.
  if (at < 0) return { tool, type: '', message: body, toolCallId };
  return { tool, type: body.slice(0, at), message: body.slice(at + 2), toolCallId };
}

export interface ResultInit {
  output: unknown;
  steps?: Step[];
  traceId?: string;
  conversationId?: string;
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
  /** The conversation/session id this run belongs to, when run with a keyed session (G19).
   * `spanTree` stamps it as `gen_ai.conversation.id`. Empty when there was no keyed session. */
  conversationId: string;
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
    this.conversationId = init.conversationId ?? '';
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
  /**
   * Every tool execution that threw during this run, typed, in order.
   *
   * A throwing tool does not stop the run — the loop hands the model `"[error] <Name>: <message>"`
   * and keeps going — and it emits **no** `ToolCall` on the bus (core's tool wrapper does not catch),
   * so a failed tool appears in neither {@link steps} nor {@link toolSteps}. Before this getter the
   * only machine-readable trace of a tool failure was that string prefix inside {@link messages},
   * which callers had to match by hand.
   *
   * Derived from {@link messages} rather than recorded separately, deliberately: the messages are
   * what the model actually saw and what a checkpoint persists, so a **resumed** run reports its
   * earlier tool failures too, and there is no second copy of the truth to drift.
   *
   * See {@link isToolError} for the one honest limit.
   *
   * @example
   * ```ts
   * import { run } from '@cendor/sdk';
   * const result = await run(agent, 'refund order 42');
   * if (result.toolFailed) console.warn(result.toolErrors.map((e) => e.type).join(', '));
   * ```
   */
  get toolErrors(): ToolError[] {
    const out: ToolError[] = [];
    for (const m of this.messages) {
      if (m.role !== 'tool') continue;
      const content = m.content;
      if (!isToolError(content)) continue;
      out.push(
        parseToolError(content as string, String(m.name ?? ''), String(m.tool_call_id ?? '')),
      );
    }
    return out;
  }

  /**
   * True if any tool threw during the run. A guardrail *block* is not a failure — it is a decision,
   * and lands in {@link guardrailDecisions} instead.
   */
  get toolFailed(): boolean {
    return this.toolErrors.length > 0;
  }

  get finalMessage(): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === 'assistant') return m;
    }
    return null;
  }
  /**
   * Aggregate token usage over LLM steps (subset conventions preserved). Summed through core's
   * field-complete `sumUsage` — a future `Usage` field can never silently vanish from this
   * aggregate (it iterates the instances' own fields, not a hand list).
   */
  get usage(): Usage {
    return sumUsage(this.llmSteps.map((s) => s.usage).filter((u): u is Usage => u !== null));
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
/**
 * A streamed **thinking / reasoning** delta (GLR-12), yielded from `run.stream` only for providers
 * that stream reasoning text as it is produced (Ollama `think` models; OpenAI-compatible endpoints
 * that stream `reasoning_content`). Additive: providers that don't stream thinking emit none, and a
 * consumer switching on `ev.type` that doesn't handle `'thinking_delta'` is unaffected. Thinking is
 * kept separate from the visible answer (`TextDelta`) so a UI can render or hide it independently.
 *
 * @example
 * ```ts
 * import { run } from '@cendor/sdk';
 * for await (const ev of run.stream(agent, 'solve it')) {
 *   if (ev.type === 'thinking_delta') process.stderr.write(ev.text); // reasoning, shown separately
 *   else if (ev.type === 'text_delta') process.stdout.write(ev.text); // the answer
 * }
 * ```
 */
export class ThinkingDelta {
  readonly type = 'thinking_delta' as const;
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
export type StreamEvent = TextDelta | ThinkingDelta | ToolCallEvent | ToolResultEvent | RunComplete;
