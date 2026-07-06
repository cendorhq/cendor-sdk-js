/**
 * Foundry adapter — the TS port of `cendor.sdk.foundry`. A dependency-free adapter over the Bot
 * Framework **Activity** protocol (the messaging surface a custom-engine agent exposes to Copilot /
 * Teams / Azure AI Foundry). `onActivity` takes an inbound `message` Activity, runs the governed agent,
 * and returns an outbound Activity (carrying governance metadata: trace id + cost). Because TS
 * `run(...)` is async, `onActivity` is async. Wire it into your web endpoint of choice.
 */
import type { AuditLog } from '@cendor/acttrace';
import type { Agent } from './agent.js';
import { run } from './runner.js';

/** A Bot Framework Activity (loose shape — inbound and outbound). */
export type Activity = Record<string, unknown>;

/** A minimal custom-engine agent manifest for registration. */
export interface FoundryManifest {
  name: string;
  description: string;
  type: 'custom-engine';
  model: string;
}

/** Adapt a `@cendor/sdk` agent to the Bot Framework Activity protocol (custom-engine agent). */
export class FoundryAdapter {
  readonly agent: Agent;
  readonly audit: AuditLog | null;

  constructor(agent: Agent, opts: { audit?: AuditLog | null } = {}) {
    this.agent = agent;
    this.audit = opts.audit ?? null;
  }

  /**
   * Handle one inbound Activity, returning the outbound reply Activity (or `null`). Non-`message`
   * activities (e.g. `conversationUpdate`) return `null` — the endpoint simply acks them.
   */
  async onActivity(activity: Activity): Promise<Activity | null> {
    if (activity.type !== 'message') return null;
    const text = (activity.text as string) ?? '';
    const result = await run(this.agent, text, { audit: this.audit });
    return {
      type: 'message',
      text: String(result.output),
      from: { id: this.agent.name, name: this.agent.name },
      recipient: activity.from,
      conversation: activity.conversation,
      replyToId: activity.id,
      channelData: {
        cendor: {
          trace_id: result.traceId,
          cost_usd: result.cost.amount.toString(),
          agents: result.agents,
        },
      },
    };
  }

  manifest(): FoundryManifest {
    return {
      name: this.agent.name,
      description: this.agent.instructions || `The ${this.agent.name} agent.`,
      type: 'custom-engine',
      model: this.agent.model,
    };
  }
}
