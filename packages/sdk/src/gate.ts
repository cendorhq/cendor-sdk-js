/**
 * Guardrail wiring for the agent loop — the TS mirror of `cendor.sdk._guardrails`. Thin async
 * adapters over `@cendor/guardrails`: build the `Context`, `evaluateAsync`, and translate the
 * verdict into the loop's control flow.
 *
 * - **input** / **output**: a `block` throws `GuardrailTripped` (fail-closed); `redact` rewrites the
 *   payload; `flag` records.
 * - **tool_call** / **tool_output**: a `block` returns a `"[blocked by <name>] <reason>"` tool
 *   result so the loop continues without the side effect (mirrors `requireApproval`'s `"[denied]"`);
 *   `redact` rewrites the args / result.
 *
 * Every trip/flag emits a `GuardrailDecision` on the bus, so an attached `AuditLog` chains it —
 * correlated with the run's decision because gating runs inside the runner's audit-decision scope.
 * The same decisions are also **collected** (via {@link collecting}) so `Result.guardrailDecisions`
 * can surface them post-hoc without re-reading the audit file.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Context,
  type Guardrail,
  type GuardrailDecision,
  GuardrailTripped,
  evaluateAsync,
} from '@cendor/guardrails';
import type { Message } from './types.js';

/** The guardrail execution modes. `blocking` (default) runs input-stage guardrails before the first
 * model call (a block is pre-spend, `$0`). `parallel` overlaps them with the first model call for
 * lower latency on the pass path — only worth it for slow tier-3/4 checks. See {@link effectiveMode}. */
export const MODES = ['blocking', 'parallel'] as const;
export type GuardrailMode = (typeof MODES)[number];

/** The guardrails in force for a run: the per-run `override` if given, else the agent's own. */
export function effective(
  agent: { guardrails?: Guardrail[] },
  override?: Guardrail[] | null,
): Guardrail[] {
  if (override != null) return [...override];
  return [...(agent.guardrails ?? [])];
}

/**
 * The guardrail execution mode for a run: the per-run `override` if given, else the agent's
 * `guardrailMode` (default `"blocking"`). Validated against {@link MODES} (throws on an unknown mode
 * — parity with Python `effective_mode`).
 */
export function effectiveMode(
  agent: { guardrailMode?: string | null },
  override?: string | null,
): GuardrailMode {
  const mode = override ?? agent.guardrailMode ?? 'blocking';
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `unknown guardrailMode ${JSON.stringify(mode)}; must be one of ${MODES.join(', ')}`,
    );
  }
  return mode as GuardrailMode;
}

function has(guardrails: Guardrail[], stage: string): boolean {
  return guardrails.some((g) => g.stages.includes(stage));
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/**
 * The latest user turn's text in `messages` — the run's originating intent. Threaded into the
 * `tool_call` gate as `Context.instruction` so an alignment check (`taskAdherence`) can compare a
 * proposed call against what the user asked for. `''` when there is no user turn (the check then
 * sees an empty instruction and can fall back or pass). PY parity: `originating_instruction`.
 */
export function originatingInstruction(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m as { role?: unknown }).role === 'user')
      return messageText((m as { content?: unknown }).content);
  }
  return '';
}

function blockedMessage(exc: GuardrailTripped): string {
  const d = exc.decisions[exc.decisions.length - 1];
  const head = `[blocked by ${d?.guardrail ?? 'guardrail'}]`;
  return d?.reason ? `${head} ${d.reason}` : head;
}

// --------------------------------------------------------------------------- decision collection

/**
 * The list collecting this run's guardrail decisions (AsyncLocalStorage — concurrency-correct for
 * overlapping async runs), or `undefined` outside a {@link collecting} scope.
 */
const collector = new AsyncLocalStorage<GuardrailDecision[]>();

/**
 * Collect every guardrail decision recorded during `fn` — the source for `Result.guardrailDecisions`.
 * Nesting is safe (each `run` gets its own store). Returns `fn`'s result.
 */
export function collecting<T>(fn: () => Promise<T>): Promise<T> {
  return collector.run([], fn);
}

function record(decisions: GuardrailDecision[]): void {
  const box = collector.getStore();
  if (box && decisions.length > 0) box.push(...decisions);
}

/** A copy of the decisions collected so far in the active {@link collecting} scope (`[]` if none). */
export function snapshot(): GuardrailDecision[] {
  const box = collector.getStore();
  return box ? [...box] : [];
}

// --------------------------------------------------------------------------- input (pre-spend)

/** Gate the outgoing messages before the first model call (pre-spend). Block throws; redact rewrites in place. */
export async function gateInput(
  guardrails: Guardrail[],
  agent: string,
  messages: Message[],
  traceId: string,
): Promise<void> {
  if (!has(guardrails, 'input')) return;
  const ctx: Context = { stage: 'input', agent, traceId };
  const { payload, decisions } = await evaluateAsync(guardrails, 'input', messages, ctx); // throws on block
  record(decisions);
  if (payload !== messages && Array.isArray(payload)) {
    messages.length = 0;
    messages.push(...(payload as Message[]));
  }
}

/**
 * Parallel mode: start the input-stage evaluation so it runs **concurrently with the first model
 * call**, and return the promise (or `null` when there are no input guardrails).
 *
 * The caller `await`s it after issuing the first model call; a block surfaces as `GuardrailTripped`
 * there. Unlike blocking mode this does **not** rewrite `messages` before the call (the call is
 * already in flight), so parallel mode is for block/flag input checks, not redaction. On the pass
 * path the check's latency is hidden behind the model call; on a block the model call may already
 * have completed (and been billed), where blocking mode guarantees `$0`.
 */
export function startInputGate(
  guardrails: Guardrail[],
  agent: string,
  messages: Message[],
  traceId: string,
): Promise<void> | null {
  if (!has(guardrails, 'input')) return null;
  const ctx: Context = { stage: 'input', agent, traceId };
  const snap = [...messages]; // don't rewrite the live messages — the call is already in flight
  return (async () => {
    const { decisions } = await evaluateAsync(guardrails, 'input', snap, ctx);
    record(decisions);
  })();
}

/** Gate a tool call. Returns `{ blocked, args }` — `blocked` short-circuits the tool; `args` is the (redacted) args. */
export async function gateToolCall(
  guardrails: Guardrail[],
  agent: string,
  name: string,
  args: Record<string, unknown>,
  traceId: string,
  instruction = '',
): Promise<{ blocked: string | null; args: Record<string, unknown> }> {
  if (!has(guardrails, 'tool_call')) return { blocked: null, args };
  const ctx: Context = {
    stage: 'tool_call',
    agent,
    tool: name,
    toolArgs: args,
    traceId,
    instruction,
  };
  try {
    const { payload, decisions } = await evaluateAsync(guardrails, 'tool_call', args, ctx);
    record(decisions);
    return { blocked: null, args: (payload as Record<string, unknown>) ?? args };
  } catch (err) {
    if (err instanceof GuardrailTripped) {
      record(err.decisions);
      return { blocked: blockedMessage(err), args };
    }
    throw err;
  }
}

/** Gate a tool result before the model sees it. Block replaces it with a `[blocked …]` message; redact substitutes. */
export async function gateToolOutput(
  guardrails: Guardrail[],
  agent: string,
  name: string,
  result: string,
  traceId: string,
): Promise<string> {
  if (!has(guardrails, 'tool_output')) return result;
  const ctx: Context = { stage: 'tool_output', agent, tool: name, traceId };
  try {
    const { payload, decisions } = await evaluateAsync(guardrails, 'tool_output', result, ctx);
    record(decisions);
    return typeof payload === 'string' ? payload : result;
  } catch (err) {
    if (err instanceof GuardrailTripped) {
      record(err.decisions);
      return blockedMessage(err);
    }
    throw err;
  }
}

/** Gate the model's final answer. Block throws (post-generation); redact returns the cleaned text; flag records. */
export async function gateOutput(
  guardrails: Guardrail[],
  agent: string,
  output: string | null,
  traceId: string,
): Promise<string | null> {
  if (output === null || !has(guardrails, 'output')) return output;
  const ctx: Context = { stage: 'output', agent, traceId };
  const { payload, decisions } = await evaluateAsync(guardrails, 'output', output, ctx); // throws on block
  record(decisions);
  return typeof payload === 'string' ? payload : output;
}
