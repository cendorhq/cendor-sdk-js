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
 */
import { type Context, type Guardrail, GuardrailTripped, evaluateAsync } from '@cendor/guardrails';
import type { Message } from './types.js';

/** The guardrails in force for a run: the per-run `override` if given, else the agent's own. */
export function effective(
  agent: { guardrails?: Guardrail[] },
  override?: Guardrail[] | null,
): Guardrail[] {
  if (override != null) return [...override];
  return [...(agent.guardrails ?? [])];
}

function has(guardrails: Guardrail[], stage: string): boolean {
  return guardrails.some((g) => g.stages.includes(stage));
}

function blockedMessage(exc: GuardrailTripped): string {
  const d = exc.decisions[exc.decisions.length - 1];
  const head = `[blocked by ${d?.guardrail ?? 'guardrail'}]`;
  return d?.reason ? `${head} ${d.reason}` : head;
}

/** Gate the outgoing messages before the first model call (pre-spend). Block throws; redact rewrites in place. */
export async function gateInput(
  guardrails: Guardrail[],
  agent: string,
  messages: Message[],
  traceId: string,
): Promise<void> {
  if (!has(guardrails, 'input')) return;
  const ctx: Context = { stage: 'input', agent, traceId };
  const { payload } = await evaluateAsync(guardrails, 'input', messages, ctx);
  if (payload !== messages && Array.isArray(payload)) {
    messages.length = 0;
    messages.push(...(payload as Message[]));
  }
}

/** Gate a tool call. Returns `{ blocked, args }` — `blocked` short-circuits the tool; `args` is the (redacted) args. */
export async function gateToolCall(
  guardrails: Guardrail[],
  agent: string,
  name: string,
  args: Record<string, unknown>,
  traceId: string,
): Promise<{ blocked: string | null; args: Record<string, unknown> }> {
  if (!has(guardrails, 'tool_call')) return { blocked: null, args };
  const ctx: Context = { stage: 'tool_call', agent, tool: name, toolArgs: args, traceId };
  try {
    const { payload } = await evaluateAsync(guardrails, 'tool_call', args, ctx);
    return { blocked: null, args: (payload as Record<string, unknown>) ?? args };
  } catch (err) {
    if (err instanceof GuardrailTripped) return { blocked: blockedMessage(err), args };
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
    const { payload } = await evaluateAsync(guardrails, 'tool_output', result, ctx);
    return typeof payload === 'string' ? payload : result;
  } catch (err) {
    if (err instanceof GuardrailTripped) return blockedMessage(err);
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
  const { payload } = await evaluateAsync(guardrails, 'output', output, ctx);
  return typeof payload === 'string' ? payload : output;
}
