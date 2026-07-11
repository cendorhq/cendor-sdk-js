---
"@cendor/init": patch
---

`doctor` now warns when the installed `@cendor/core`'s bundled price snapshot is more than 30 days
old (models released since then estimate at $0 until `prices.refresh()` or an upgrade — an offline
hint, never an error). The offline versions snapshot is refreshed to the 2026-07-11 patch shelf
(core 0.5.2 / 1.5.2, mcp 0.1.3, init 0.2.1).
