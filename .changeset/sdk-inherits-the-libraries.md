---
'@cendor/sdk': minor
---

The SDK inherits the libraries — verified. `guard` is now the identical acttrace object, embeddings are governed pre-flight, `rules` reaches full Python parity, the pii bridge honors per-category actions, and a new parity/identity test suite pins every re-export so drift fails the build. Pins move to `@cendor/acttrace ^0.6.0` / `@cendor/core ^0.6.0` (+ the current shelf for the rest — one deduped core, one bus).

- **`guard` is the identical `@cendor/acttrace` object** (`Object.is(sdk.guard, acttrace.guard)`). acttrace 0.6.0's dual shape carries the scope form (`guard(opts, fn)` — the SDK's historical call shape, drop-in), so the SDK wrapper is deleted. `GuardOptions` is now acttrace's type, re-exported.
- **`rules` reaches full Python parity (D1):** `spotlight`, `language`, `classifier`, `openaiModeration`, `bedrockGuardrail`, `azureContentSafety`, `modelArmor`, `groundedness`, and `deniedTopics` now ride the SDK `rules` namespace. Only the helpers (`payloadText`, `NORMALIZATIONS`) stay library-only.
- **Behavior fix — `rules.pii`/`secrets`/`entropy` honor per-category policy actions** (via acttrace's new `resolveFindings`, the same resolution `guard()` applies). A `block`-tier category blocks and a `redact`-tier one is scrubbed **regardless of the `action` option**, which now applies only to flag-tier findings — `pii(Policy.gdpr(), { action: 'redact' })` blocks a `special_category` finding instead of merely scrubbing it. The bridges also accept **`timeout` / `onError` / `metadata`** (forwarded to `defineGuardrail` — closing the long-stale "0.2.0" wait; the lib has shipped them since 0.6.x).
- **`embed()` is governed pre-flight:** it rides `instrument()` so `@cendor/core` 0.6.0 captures the call — a keyless `withBudget({ usd, onExceed: 'block' }, …)` refuses an over-budget embed *before* it fires. The SDK's hand-built emit shim is deleted (no double emission).
- **New re-exports:** `loadPolicy` (config-as-data parity with Python), `downgrades`, `clamps`; `ContextBudgetFallback` (the new diagnostic bus event a failed `contextBudget` assembly emits — silent but observable).
- **`Result.usage` aggregates through core's field-complete `sumUsage`**; never-retry is `instanceof`-matched on the real `BudgetExceeded`/`PolicyViolation` classes; `EvalCase.normalizer` is forwarded to cassette's replay matching.
- **New `test/lib-parity.test.ts`:** `Object.is` pins for every documented re-export, a rules-catalogue diff against a reviewed exclusion allowlist, forwarded-shape pins, and the shim-expiry harness.
