/**
 * Human-in-the-loop — the TS port of `cendor.sdk.hitl`. `requireApproval` wraps a tool so an approver
 * gates it before it runs; a rejection returns a `[denied]` string to the model instead of executing.
 */
import { type Tool, tool } from './tools.js';

/** `(toolName, args) => allow | [allow, note]`. */
export type Approver = (
  name: string,
  args: Record<string, unknown>,
) => boolean | [boolean, string] | Promise<boolean | [boolean, string]>;

export interface RequireApprovalOptions {
  approver: Approver;
  reviewer?: string;
}

/** Wrap a tool with an approval gate. On reject, the real tool is NOT run; a `[denied]` string is returned. */
export function requireApproval(target: Tool, opts: RequireApprovalOptions): Tool {
  return tool(
    async (args: Record<string, unknown>) => {
      const verdict = await opts.approver(target.name, args);
      const [ok, note] = Array.isArray(verdict) ? verdict : [verdict, ''];
      if (!ok)
        return `[denied] human oversight rejected '${target.name}'${note ? `: ${note}` : ''}`;
      return target.invoke(args);
    },
    {
      name: target.name,
      description: target.description,
      jsonSchema: target.parameters,
      instrument: false,
    },
  );
}

/** Auto-approve every request (testing). */
export const alwaysApprove: Approver = () => true;
/** Auto-reject every request (testing). */
export const alwaysReject: Approver = () => [false, 'auto-rejected'];
