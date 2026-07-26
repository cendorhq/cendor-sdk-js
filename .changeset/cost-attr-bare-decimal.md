---
'@cendor/sdk': patch
---

fix(otel): `gen_ai.usage.cost` must be a bare decimal, not `Money.toString()`

`spanTree` and `liveSpans` wrote the cost span attribute as `Money.toString()`, which renders
`"0.0000045 USD"`. `@cendor/core` and both Python paths write the bare amount, so **the same run cost
parsed differently depending on which door emitted it** — and `Number("0.0000045 USD")` is `NaN`, so any
backend reading the attribute numerically silently lost TS-door cost.

Found by the new concurrency leg in `cendor-testsuits`, where it first showed up as the leg's own 1×
spend assertion quietly evaluating to `NaN > 0 === false` and skipping itself.

The suffixed form stays where it belongs: the acttrace **audit chain** payload carries
`"<amount> <currency>"` in both languages, and that is hashed evidence — unchanged here. Only the
semconv span attribute changed. `cendor.run.cost_usd` already used `.amount`. A named `costAttr()`
helper now marks the wire form so the next person reaches for the right one; precision is unchanged
(decimal.js, never a float).

Downstream: `cendor-monitor` 0.12.2 normalizes the column at ingest and makes the Postgres cost
`ORDER BY` safe for rows already stored with a suffix (its `cast(... as double precision)` **throws** on
one, which would 500 the runs list sorted by cost).
