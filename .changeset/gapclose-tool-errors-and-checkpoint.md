---
'@cendor/sdk': minor
---

feat: `result.toolErrors` — a tool failure you can branch on — plus `registerDeployment` and a real Windows checkpoint fix

### `result.toolErrors` / `result.toolFailed`

A tool that throws does not end a run: the loop turns the error into `"[error] <Name>: <message>"`,
hands that to the model, and continues — which is what lets a model apologise, retry with different
arguments, or route around the failure. That string is a contract with the model and is **unchanged**
(asserted byte-for-byte, because altering it would silently change how every model recovers from a tool
failure).

What it cost the *caller* was any way to notice. Measured: a throwing tool emits **zero** `ToolCall`
events on the bus (`@cendor/core` does not catch around the tool), so it appears in neither
`result.steps` nor `result.toolSteps`, **no `execute_tool` span is rendered for it**, and
`result.incomplete` stays `false` — the run "succeeded". The only machine-readable trace was the
`"[error] "` prefix inside `result.messages`, which callers had to string-match by hand.

```ts
const result = await run(agent, 'refund order 42');
if (result.toolFailed) {
  for (const err of result.toolErrors) {   // { tool, type, message, toolCallId }
    console.warn(err.tool, err.type, err.message);
  }
}
```

`type` is the error's constructor name, or `'UnknownTool'` when the model asked for a tool the agent
does not have. A guardrail **block** is not a tool failure — it is a decision, and stays in
`result.guardrailDecisions`. `ToolError`, `isToolError` and `TOOL_ERROR_PREFIX` are exported.

Derived from `messages` rather than recorded separately, deliberately: the messages are what the model
actually saw and what a checkpoint persists, so a **resumed** run reports its earlier tool failures too,
and there is no second copy of the truth to drift. `otel.toolOutcome` (the `cendor.tool.outcome` span
attribute) now classifies through the same shared `isToolError` predicate, so the span label and this
view cannot disagree about what a tool failure is. Honest limit: a tool whose *own* output begins with
`"[error] "` is indistinguishable from one that failed — already true of the span attribute, now stated.

### `registerDeployment`

`registerDeployment('prod-gpt4o-eastus', { like: 'gpt-4o' })`, a re-export of `@cendor/core` 3.2.0's
`prices.registerDeployment`. On Azure the id a call reports is the deployment name *you* chose, so it is
in no price table and its cost is `null`; this maps it onto a base model's rates explicitly.

### Fixed — `Checkpointer.save()` on Windows

`save()` could throw `EPERM` and lose the turn. It had been recorded as a test flake; it is a real
defect, and the mechanism is not the one the report assumed.

`rename` is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which needs exclusive access to the
**destination**. It overwrites correctly — the folk explanation "rename over an existing file is
non-atomic on Win32" is wrong — but it fails whenever any other process holds a handle on that path,
and a file just created is exactly what Defender and the Search indexer open. Measured on Windows 11 /
node 24: **11 of 500** renames over an existing file failed (~2%), deterministic while a handle is held.
The holder releases in microseconds, so `save()` now retries a transient sharing violation with a
bounded backoff (5 attempts, ≤62 ms total) and 500/500 succeed.

Deliberately **not** `unlink` then `rename`: that also clears the violation (measured) but opens a
window in which a crash leaves **no checkpoint at all**, destroying the previous good state — the very
failure the temp file exists to prevent. A permanent error (`ENOSPC`, `EROFS`, `ENOENT`) still throws on
the first attempt, the previous checkpoint survives a failed save intact, and no stale `.tmp` is left
behind. `cendor-sdk` 1.22.0 carries the identical fix — the same syscall is behind both, which the
analysis had missed in recording Python as unaffected.

Consumer pins move to `@cendor/core ^3.2.0`, `@cendor/tokenguard ^3.1.0`, `@cendor/guardrails ^3.1.0`,
with `check-one-core` proving exactly one installed core before this publishes.
