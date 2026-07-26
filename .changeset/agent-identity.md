---
'@cendor/sdk': minor
---

**An agent can have an identity, not just a name — and every governance row says which agent it was.**

### `new Agent({ id })`

A name is a label: two agents in two apps can share one, and renaming an agent loses its history. Pass
`id` and it is emitted as `gen_ai.agent.id` on every span of that agent's turns — the live tree, the
post-hoc `spanTree`, and the governance rows. Use your own registry key, or the id a framework already
owns (Azure AI Foundry's `agentId`, Bedrock's `agentId`, an OpenAI `assistant_id`).

**When you give no id the attribute is simply omitted** — never a hash of the name, never a placeholder.
Cendor does not invent identity.

### The actor on every governance row (needs `@cendor/core` 0.16 / `@cendor/acttrace` 0.14)

The SDK's ambient provider now stamps the acting agent's **id** beside its name, which is what lets a
`governance.*` span or an `audit.*` mirror entry name the agent — including on the entry types that carry
no agent field of their own, such as a budget block. Measured before this release: 13 of 386 governance
rows named their agent.

### Also

Note the **behaviour change** in `@cendor/core` 0.16.0: `trace()` now opens a real parent span, so a
libs-side `trace()` scope groups its calls into one trace. It opens no span inside an SDK run — your run
already owns its trace.
