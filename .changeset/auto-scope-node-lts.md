---
'@cendor/sdk': patch
---

**Fix: the automatic run scope is now correct on Node 20 / 22, not just Node 24.**

0.22.0–0.23.0 leaned on `@cendor/core`'s `AsyncLocalStorage.enterWith`-based latch, which only behaves
as intended on Node ≥ 24 (see `@cendor/core` 0.15.1). On Node 20 / 22 an automatic scope leaked out of
its run, so after `await run(...)` the caller's context stayed latched (later libs-only calls silently
lost their flat spans) and two concurrent `run()`s shared one scope — the second opened no root and its
steps could be parented under the first run's.

The automatic scope now raises the latch **and** its `liveSpans` registry entry inside
`AsyncLocalStorage.run()` (core's `_withLiveSpansDepth`), which is correctly scoped on every supported
Node; the streaming path keeps the counter for the stream's lifetime and releases it in a `finally` (so
abandoning a stream with `break` still releases it). Verified in docker on **node 20.20 / 22.23 /
24.18**: two concurrent zero-code runs each get their own root, each step is parented under its own run,
and the latch is clear afterwards on all three.

A manual `liveSpans()` handle is unchanged and remains process-wide while open — that is what a
hand-closed handle can honestly guarantee; the automatic path is the one with a scope to bind to.
Requires `@cendor/core` ≥ 0.15.1.
