# Using Cendor (cendor.* / @cendor/*) correctly

Cendor is offline-first plumbing for LLM apps — Python `cendor.*` (PyPI), TypeScript `@cendor/*`
(npm), Apache-2.0. Wrap the provider client **once** with `instrument()`; budgets, gating, testing,
and audit all plug into one event bus. Every public symbol ships an inline `@example` + a
correct-shape type — trust the editor's hover/completion over a guess.

Which library, and the one call that matters (Python shown; TS mirrors it in camelCase — see traps):
- Cap / attribute spend → **tokenguard**: `@budget(usd=0.5, on_exceed="raise")`, `track(...)`, `report()`
- Fit a prompt to a token budget → **contextkit**: `Context(budget_tokens=8000, model="gpt-4o").assemble()`
- Losslessly shrink a payload → **squeeze**: `small, handle = compress(x, kind="auto")`
- Block / redact unsafe input+output → **guardrails**: `rules.keyword_deny([...], action="block")`
- Record once, replay offline in tests → **cassette**: `@cassette.use("tests/x.json")`
- PII/secret detection + tamper-evident audit → **acttrace**: `AuditLog(system="support", risk_tier="limited")`
- Token count / price / instrument → **core**: `instrument(OpenAI())`, `tokens.count(msgs, model="gpt-4o")`
- A whole governed agent loop → **cendor-sdk**: `Agent(name=…, model=…, guardrails=[…], max_usd=0.5)`; `run(agent, "hi")`

Call shapes that are easy to get wrong:
- `instrument()` wraps the client **once**, not per call.
- TS `budget` is **curried**: `budget(cfg)(fn)` — never `budget(cfg, fn)`. Python `budget(...)` takes keyword args and is both a decorator and a context-manager.
- `prices.estimate` — Python positional `prices.estimate(model, input_tokens, output_tokens=200)`; TS options object `prices.estimate(model, inputTokens, { outputTokens: 200 })`.
- Money is `Decimal` / `decimal.js`, never `float` / `number`.
- `Context.assemble()` is sync in Python (`aassemble()` for async), async in TS (`await`).
- Guardrail actions are `block | redact | flag` (no `warn`); PII/secrets are acttrace detectors, not guardrail rules.
- Session store lives in the SDK, casing differs: Python `SQLiteSessionStore`, TS `SqliteSessionStore`.
- TS tokenguard sinks live at the `@cendor/tokenguard/sinks` subpath.
- Python is a PEP 420 namespace — `from cendor.tokenguard import budget`; no top-level `cendor` module.
- Provider SDKs are optional (Python extras, TS peer deps) — install only what you call.
- SDK provider keys: the SDK builds the client, so use the provider's standard env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) or `Agent(api_key=…)` / a pre-built `client=`. There is no Cendor key config.
- Telemetry: **do not write any**. With OpenTelemetry installed and a provider configured in the app, Cendor emits `gen_ai.*` call spans, spend counters, an `agent.run` tree per SDK `run()`, and `governance.*` decisions on its own (core ≥ 1.13 / 0.15, sdk ≥ 1.19 / 0.22). Never add `use_span_emitter()` / `use_sink(OTelSink())` / `live_spans()` unless the user asks for explicit control — and never invent an endpoint, key or exporter: Cendor has none, it emits into the app's own provider.
- The off switch is the env var `CENDOR_TELEMETRY=off` (process-wide, no code change); `CENDOR_DEBUG_TELEMETRY=1` prints one line saying whether a provider was detected. With no provider (or no OTel installed) everything is a silent no-op — that is correct, not a bug.
- `AuditLog(system=…)` is the *governance* line; its OTel mirror auto-attaches (pass `mirror=False` to opt out). The mirror is an **operational copy** — `verify()` runs on the hash-chained file. The automatic `governance.*` spans are operational signals too, never "an audit trail".

Honest limits: deterministic guardrails don't stop novel adversarial attacks; acttrace produces
*evidence*, not a compliance guarantee. Full reference: https://cendor.ai/docs/for-ai-assistants
