---
'@cendor/sdk': patch
---

`FoundryAdapter`'s JSDoc now states the boundary it is easy to cross by accident: it is for when
**cendor should BE the endpoint**, and it is **not** the Microsoft 365 Agents SDK path.

Measured 2026-07-27: calling `onActivity()` from inside an M365 Agents SDK handler returns a
valid-looking reply Activity, complete with a `channelData.cendor` envelope, and throws nothing — so
the mistake is silent. It leaves you with two Activity layers, two reply paths, and the envelope on
the wrong object. A custom engine agent's process already owns `AgentApplication` behind
`POST /api/messages` (with its own `TurnContext`/`TurnState`, streaming and auth) *and* holds the model
client, so governing it needs no SDK API at all — `instrument()` plus budgets, gates and evidence, with
the envelope attached in your own handler in ~3 lines.

Docstring only; no behaviour change, no API change. The point is reach: this surfaces in the editor
tooltip at the moment someone types the symbol, which is earlier than any docs page. The added
`@example` is extracted and typechecked by `check:docs`, so it cannot rot.
