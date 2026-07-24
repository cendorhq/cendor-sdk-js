---
"@cendor/sdk": minor
---

SDK telemetry wave — structural signals for RAG, memory, orchestration, checkpoints, tools, and MCP become first-class `cendor.sdk` spans, rendered as their own domains by any OTel backend (or Cendor Monitor). **Zero `@cendor/core` changes** — the new signals ride the core bus and the existing `liveSpans` scope; content rules unchanged (labels/ids/counts only, never message bodies).

- **RAG** (`rag.assemble` / `rag.compress`): `contextBudget` assembly (contextkit `AssemblyReport`) and squeeze compression (`CompressionEvent`) surface as `cendor.sdk` child spans in a `liveSpans` run — budget/used, blocks kept vs dropped, token deltas, technique.
- **Memory** (`memory.load` / `memory.save`): a run reading/writing a `Session` emits a span with the session id, turn count, and byte size.
- **Orchestration** (`orchestration.handoff`): each `transfer_to_<peer>` handoff emits an edge (from → to, segment, transfer tool) so a monitor builds the multi-agent graph from rows.
- **Checkpoints** (`checkpoint.save` / `checkpoint.resume`): a `Checkpointer` write + a resume decision emit spans (run id, done flag, turn count).
- **Tools**: every `execute_tool` span carries `cendor.tool.source` (`local` | `mcp`, + server/transport) and `cendor.tool.outcome` (`ok` | `error` | `blocked`). A `tool_call` guardrail block — which runs no tool — emits a dedicated `execute_tool {name}` span with `outcome="blocked"` + `cendor.tool.blocked_by`.
- **MCP server attribution**: `loadMcpTools(session, { server, transport })` tags each tool's spans and emits `mcp.connect` / `mcp.list_tools` lifecycle spans for per-server attribution. Labels are optional and non-secret.
