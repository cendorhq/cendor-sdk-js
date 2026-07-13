## Cendor (cendor.* / @cendor/*)

Offline-first plumbing for LLM apps. Wrap the provider client **once** with `instrument()`; budgets,
gating, testing, and audit plug into one bus. Every symbol ships an inline `@example` — trust the
editor's hover over a guess.

Which library, and the one call that matters (Python; TS mirrors it in camelCase — see traps):
- Cap / attribute spend → **tokenguard**: `@budget(usd=0.5, on_exceed="raise")`, `track(...)`, `report()`
- Fit a prompt to a token budget → **contextkit**: `Context(budget_tokens=8000, model="gpt-4o").assemble()`
- Losslessly shrink a payload → **squeeze**: `small, handle = compress(x, kind="auto")`
- Block / redact unsafe input+output → **guardrails**: `rules.keyword_deny([...], action="block")`
- Record once, replay offline → **cassette**: `@cassette.use("tests/x.json")`
- PII/secret detection + tamper-evident audit → **acttrace**: `AuditLog(system="support", risk_tier="limited")`
- Token count / price / instrument → **core**: `instrument(OpenAI())`, `tokens.count(msgs, model="gpt-4o")`
- A governed agent loop → **cendor-sdk**: `Agent(name=…, model=…, guardrails=[…], max_usd=0.5)`; `run(agent, "hi")`

Traps: `instrument()` once, not per call. TS `budget` is curried — `budget(cfg)(fn)`, never
`budget(cfg, fn)`. `prices.estimate` is positional in Python, `{ outputTokens }` object in TS. Money
is `Decimal`/`decimal.js`, never `float`/`number`. `Context.assemble()` is sync in Python
(`aassemble()` async), `await` in TS. Guardrail actions `block | redact | flag` (no `warn`);
PII/secrets are acttrace detectors, not guardrail rules. Session store is in the SDK, casing differs
(`SQLiteSessionStore` / `SqliteSessionStore`). TS tokenguard sinks: `@cendor/tokenguard/sinks`.
Python is a PEP 420 namespace. Provider SDKs are optional. SDK provider keys: the provider's standard
env var (`OPENAI_API_KEY`) or `Agent(api_key=…)`, never a Cendor key config. Deterministic guardrails
don't stop novel attacks; acttrace is evidence, not a guarantee. Full reference:
https://cendor.ai/docs/for-ai-assistants
