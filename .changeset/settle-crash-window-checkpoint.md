---
'@cendor/sdk': patch
---

Resuming an unfinished checkpoint whose transcript already ends with the final assistant answer no
longer re-invokes the model.

Every run path saves the answering turn with `done: false` *before* the `done: true` save lands, so
a crash in that window leaves an "unfinished" checkpoint that is finished in substance — and
re-asking a model to continue its own complete conversation invites it to re-do the task, completed
tool calls included. Measured live by the external suite: a resumed transcript ending in its own
answer re-ran a completed tool — the exact failure `checkpoint` exists to prevent, since a resumed
run is by definition one interrupted mid-side-effects.

A new `settleCheckpoint()` normalises that shape (`done: true`, output recovered from the stored
output — the streaming paths persist it — or the final answer) at every resume site: `run`,
`streamOne`, `runAgents`, and the team stream. The resume returns the stored answer with **zero**
model and **zero** tool invocations, done-resume parity included (same `traceId`, empty `steps`).
Conservative predicate: only a trailing assistant message with non-empty content and no
`tool_calls` settles — a transcript ending at a tool result still resumes through the loop, and an
empty-content tail keeps the previous behaviour.

Documented honestly (docs/hardening.md): on a genuinely mid-run resume the SDK replays the saved
messages — tool results included — and never re-executes a completed tool itself, but whether the
*model* re-issues the same call is its own sampling decision. Make tools used under `checkpoint`
idempotent.
