---
"@cendor/sdk": minor
---

MCP client (tools/prompts/resources); checkpoint/resume durability; A2A server+client+serve; Foundry Bot-Framework adapter.

- `loadMcpTools` / `loadMcpPrompts` / `getMcpPrompt` / `loadMcpResources` consume a duck-typed MCP client session (the `@modelcontextprotocol/sdk` `Client` shape) — MCP tools become governed `Tool`s (server schema used verbatim) that flow through the same loop/bus/audit/budget. `@modelcontextprotocol/sdk` is an optional peer dependency (never imported at runtime; the session is caller-supplied).
- `Checkpointer` (+ `asCheckpointer`) persists a run's conversation to a local JSON file after each turn (atomic temp-file + rename); a crashed run resumes without re-doing completed work. Wired through `RunOptions.checkpoint` for both single-agent (`Runner`) and multi-agent (`runAgents`) paths via a new `onTurn` hook on the loop; multi-agent resume preserves the saved run_id and ignores new input.
- `A2AServer` / `A2AClient` expose a governed agent over the A2A JSON-RPC `message/send` protocol (in-process for tests/embedding), carrying governance metadata (trace id, cost); `serve()` is an optional local node:http server.
- `FoundryAdapter` adapts a governed agent to the Bot Framework Activity protocol (custom-engine agent), returning an outbound Activity with governance metadata in `channelData.cendor`.
